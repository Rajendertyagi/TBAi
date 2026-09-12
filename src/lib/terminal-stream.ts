import type { BashOutputEvent } from "../services/tools";

/**
 * Batched `data-tbai-terminal` emission for live command output.
 *
 * `runBash` invokes its `onOutput` callback per stream read (potentially very
 * chatty); emitting one UI stream part per read would flood message history.
 * This batcher accumulates raw chunks and flushes throttled parts through the
 * existing AI SDK `writer` — the same mechanism as `data-tbai-progress`.
 *
 * Final tool results stay the durable history source; these parts are
 * presentation-only (bounded count per call, client merges by toolCallId).
 */

export interface TerminalDataPayload {
  toolCallId: string;
  /** Raw text chunks since the previous flush (client normalizes). */
  chunks: string[];
  done: boolean;
  exitCode?: number;
  timedOut?: boolean;
}

export const TERMINAL_DATA_TYPE = "data-tbai-terminal";

/** Flush at most this often per tool call while output flows. */
const FLUSH_INTERVAL_MS = 150;
/** Flush immediately once this much is buffered (bursty commands). */
const FLUSH_BYTES = 4096;
/** Hard cap of live parts per tool call; the final result completes the view. */
const MAX_PARTS_PER_CALL = 400;

interface CallState {
  pending: string;
  pendingBytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  partsSent: number;
  capped: boolean;
}

export interface TerminalPartWriter {
  write: (part: {
    type: string;
    id: string;
    data: TerminalDataPayload;
  }) => void;
}

export function createTerminalBatcher(
  write: TerminalPartWriter["write"],
  opts?: { flushMs?: number; maxPartsPerCall?: number },
) {
  const calls = new Map<string, CallState>();
  let seq = 0;
  const flushMs = opts?.flushMs ?? FLUSH_INTERVAL_MS;
  const maxParts = opts?.maxPartsPerCall ?? MAX_PARTS_PER_CALL;

  const stateFor = (toolCallId: string): CallState => {
    let state = calls.get(toolCallId);
    if (!state) {
      state = { pending: "", pendingBytes: 0, timer: null, partsSent: 0, capped: false };
      calls.set(toolCallId, state);
    }
    return state;
  };

  const writePart = (
    toolCallId: string,
    chunks: string[],
    done: boolean,
    exitCode?: number,
    timedOut?: boolean,
  ): void => {
    seq += 1;
    write({
      type: TERMINAL_DATA_TYPE,
      id: `terminal-${toolCallId}-${seq}`,
      data: { toolCallId, chunks, done, exitCode, timedOut },
    });
  };

  const flush = (toolCallId: string): void => {
    const state = calls.get(toolCallId);
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (!state.pending || state.partsSent >= maxParts) {
      if (state.partsSent >= maxParts) state.capped = true;
      state.pending = "";
      state.pendingBytes = 0;
      return;
    }
    state.partsSent += 1;
    const chunks = [state.pending];
    state.pending = "";
    state.pendingBytes = 0;
    writePart(toolCallId, chunks, false);
  };

  const schedule = (toolCallId: string) => {
    const state = stateFor(toolCallId);
    if (state.timer || state.capped) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (calls.get(toolCallId)?.pending) flush(toolCallId);
    }, flushMs);
  };

  return {
    /** Feed one raw `runBash` output event (call per stream read). */
    push(toolCallId: string, event: BashOutputEvent): void {
      if (!toolCallId) return;
      const state = stateFor(toolCallId);
      if (state.capped) return;
      state.pending += event.chunk;
      state.pendingBytes += event.chunk.length;
      if (state.pendingBytes >= FLUSH_BYTES) {
        flush(toolCallId);
      } else {
        schedule(toolCallId);
      }
    },
    /** Emit completion (called from onToolExecutionEnd with the result). */
    complete(toolCallId: string, exitCode?: number, timedOut?: boolean): void {
      if (!toolCallId || !calls.has(toolCallId)) return;
      // Flush leftovers first so the done part never precedes buffered lines.
      flush(toolCallId);
      const state = stateFor(toolCallId);
      // The done part always lands (even when capped): completion state must
      // never go missing while the spinner would otherwise run forever.
      writePart(toolCallId, [], true, exitCode, timedOut);
      if (state.timer) clearTimeout(state.timer);
      calls.delete(toolCallId);
    },
    /** Test introspection. */
    pendingFor(toolCallId: string): string {
      return calls.get(toolCallId)?.pending ?? "";
    },
  };
}

export type TerminalBatcher = ReturnType<typeof createTerminalBatcher>;
