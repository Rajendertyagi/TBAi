"use client";

import { useMemo } from "react";
import {
  useAuiState,
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { TerminalBlock } from "@/components/assistant-ui/elements/terminal-block";
import {
  TERMINAL_MAX_LINES,
  TerminalBuffer,
  splitTerminalLines,
} from "@/lib/terminal-lines";
import { BackendToolView } from "../filesystem/ui";

type AnyArgs = Record<string, unknown>;
type AnyResult = unknown;
type AnyProps = ToolCallMessagePartProps<AnyArgs, AnyResult>;

/**
 * Converted part shape in message scope. The wire format is
 * `{type: "data-tbai-terminal", id, data}` (AI SDK `DataUIPart`), but the
 * assistant-ui converter normalizes it to `{type: "data",
 * name: "tbai-terminal", data}` (verified in
 * @assistant-ui/ai-sdk convertMessage.js: `part.type.startsWith("data-")` →
 * `{type: "data", name: part.type.substring(5), data: part.data}`).
 */
const TERMINAL_DATA_NAME = "tbai-terminal";

const EMPTY_PARTS: unknown[] = [];
const EMPTY_LINES: string[] = [];

interface TerminalData {
  toolCallId?: unknown;
  chunks?: unknown;
  done?: unknown;
}

function isTerminalPart(part: unknown, ownId: string): part is { data: TerminalData } {
  if (typeof part !== "object" || part === null) return false;
  const t = part as { type?: unknown; name?: unknown; data?: unknown };
  if (t.type !== "data" || t.name !== TERMINAL_DATA_NAME) return false;
  const data = t.data as TerminalData | undefined;
  return !!data && data.toolCallId === ownId;
}

/**
 * Live terminal lines for this tool call, merged from `data-tbai-terminal`
 * message parts in stream order. Returns [] when the runtime cannot surface
 * them (history revisit, reload, MCP replay) — callers fall back to the
 * final tool result, which stays the durable source.
 *
 * The selector returns the store's parts array by reference (stable across
 * renders); filtering happens in `useMemo` below. Filtering inside the
 * selector would hand `useSyncExternalStore` a fresh array on every
 * snapshot — an infinite re-render loop (React error #185).
 */
function useLiveTerminalLines(ownId: string | undefined): string[] {
  const allParts = useAuiState((s) => {
    const message = s.message as { parts?: unknown } | undefined;
    const all = message?.parts;
    return Array.isArray(all) ? all : EMPTY_PARTS;
  });
  return useMemo(() => {
    if (typeof ownId !== "string" || allParts.length === 0) return EMPTY_LINES;
    const buf = new TerminalBuffer(TERMINAL_MAX_LINES);
    for (const part of allParts) {
      if (!isTerminalPart(part, ownId)) continue;
      const data = (part as { data?: TerminalData }).data;
      const chunks = Array.isArray(data?.chunks) ? data.chunks : [];
      for (const chunk of chunks) buf.push(String(chunk ?? ""));
    }
    const lines = buf.lines;
    return lines.length > 0 ? lines : EMPTY_LINES;
  }, [allParts, ownId]);
}

type RunResult = {
  stdout?: unknown;
  stderr?: unknown;
  exitCode?: unknown;
  timedOut?: unknown;
  error?: unknown;
};

/** Final-result lines: stdout followed by stderr (matches legacy display). */
function resultLines(result: RunResult): string[] {
  const out =
    typeof result.stdout === "string" && result.stdout
      ? splitTerminalLines(result.stdout)
      : [];
  const err =
    typeof result.stderr === "string" && result.stderr
      ? splitTerminalLines(result.stderr)
      : [];
  return [...out, ...err];
}

/**
 * `run_command` renderer: the official assistant-ui Terminal Block for live
 * and completed output, wrapped in TBAi chrome for gates and exit states.
 *
 * State coverage mirrors `BackendToolView` exactly (approval gate, closed
 * gate, denial, incomplete, approved-pending, spinner); only the two
 * terminal states (running with/without live lines, completed result) render
 * the block standalone instead of a titled card. The official component is
 * never forked — non-zero exits surface in the footer below it.
 */
export const RunCommandTerminalUI: ToolCallMessagePartComponent = (
  p: AnyProps,
) => {
  const { approval } = p;
  // Stable invocation id (typed on the part) for live data-part matching.
  const ownId = p.toolCallId;
  const liveLines = useLiveTerminalLines(
    typeof ownId === "string" ? ownId : undefined,
  );

  const running = p.status?.type === "running";
  const result =
    p.result !== undefined && p.result !== null
      ? (p.result as RunResult)
      : undefined;

  // Non-terminal states keep the shared dispatcher byte-identically.
  const denied =
    result && typeof result === "object" && typeof result.error === "string"
      ? result.error
      : null;
  if (
    (approval && approval.approved === undefined) ||
    denied !== null ||
    p.status?.type === "incomplete" ||
    (approval?.approved === true && result === undefined && !running) ||
    (result === undefined && !running && liveLines.length === 0)
  ) {
    return (
      <BackendToolView
        title="run_command"
        args={p.args}
        result={p.result}
        status={p.status}
        approval={p.approval}
        respondToApproval={p.respondToApproval}
        runningLabel="Running…"
        summarize={() => null}
      />
    );
  }

  const command = String(
    (p.args as { command?: unknown } | undefined)?.command ?? "",
  );
  const lines = result !== undefined ? resultLines(result) : liveLines;
  const done = !running;

  const exitCode =
    typeof result?.exitCode === "number" ? result.exitCode : undefined;
  const timedOut = result?.timedOut === true;
  const failed = exitCode !== undefined && exitCode !== 0;

  return (
    <div className="my-1 w-full">
      <TerminalBlock
        command={command}
        lines={lines}
        visibleCount={lines.length}
        done={done}
        variant="ink"
      />
      {timedOut && (
        <div
          role="alert"
          className="mt-1 font-mono text-xs text-destructive"
        >
          timed out — process killed
        </div>
      )}
      {!timedOut && failed && (
        <div className="mt-1 font-mono text-xs text-destructive">
          exit {exitCode}
        </div>
      )}
    </div>
  );
}
