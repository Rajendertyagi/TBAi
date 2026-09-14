"use client";

import { useMemo } from "react";
import {
  useAuiState,
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { TerminalBlock } from "@/components/assistant-ui/elements/terminal-block";
import { mergeTerminalParts, resultToLines } from "@/lib/terminal-lines";
import { BackendToolView } from "../filesystem/ui";

type AnyArgs = Record<string, unknown>;
type AnyResult = unknown;
type AnyProps = ToolCallMessagePartProps<AnyArgs, AnyResult>;

const EMPTY_PARTS: unknown[] = [];
const EMPTY_LINES: string[] = [];

/**
 * Live terminal lines for this tool call, merged from `data-tbai-terminal`
 * message parts in stream order. Returns [] when the runtime cannot surface
 * them (history revisit, reload, MCP replay) — callers fall back to the
 * final tool result, which stays the durable source.
 *
 * The selector returns the message's `parts` array by reference (stable across
 * renders); merging happens in `useMemo` below. Filtering inside the selector
 * would hand `useSyncExternalStore` a fresh array on every snapshot — an
 * infinite re-render loop (React error #185).
 */
function useLiveTerminalLines(ownId: string | undefined): string[] {
  const allParts = useAuiState((s) => {
    const message = s.message as { parts?: unknown } | undefined;
    const all = message?.parts;
    return Array.isArray(all) ? all : EMPTY_PARTS;
  });
  return useMemo(
    () =>
      ownId ? mergeTerminalParts(allParts as unknown[], ownId) : EMPTY_LINES,
    [allParts, ownId],
  );
}

type RunResult = {
  stdout?: unknown;
  stderr?: unknown;
  exitCode?: unknown;
  timedOut?: unknown;
  error?: unknown;
};

/**
 * `run_command` renderer: the official assistant-ui Terminal Block for live
 * and completed output, wrapped in TBAi chrome for gates and exit states.
 *
 * State coverage mirrors `BackendToolView` exactly (approval gate, closed
 * gate, denial, incomplete, approved-pending, spinner); only the two
 * terminal states (running with/without live lines, completed result) render
 * the block standalone instead of a titled card. The official component is
 * never forked — non-zero exits surface in the footer below it and the header
 * switches to a red "failed" badge via the `status` prop.
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
  const lines = result !== undefined ? resultToLines(result) : liveLines;
  const done = !running;

  const exitCode =
    typeof result?.exitCode === "number" ? result.exitCode : undefined;
  const timedOut = result?.timedOut === true;
  const failed = exitCode !== undefined && exitCode !== 0;
  const errored = timedOut || failed;

  return (
    <div className="my-1 w-full">
      <TerminalBlock
        command={command}
        lines={lines}
        visibleCount={lines.length}
        done={done}
        variant="ink"
        status={errored ? "error" : "success"}
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
};
