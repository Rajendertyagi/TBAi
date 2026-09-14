/**
 * Chat-route terminal wiring: proves the `run_command` live-output chain the
 * chat route depends on — `withThreadContext` injects `onTerminalOutput` into
 * the toolkit's `run_command` execute (capturing the AI SDK `toolCallId` from
 * the second arg), and `createTerminalBatcher` throttles those events into
 * `data-tbai-terminal` parts with a guaranteed final `done` part.
 *
 * These are the two seams `routes/chat.ts` stitches together; testing them in
 * isolation covers the wiring without a full HTTP request. `bun test`.
 */
import { describe, it, expect } from "bun:test";
import { withThreadContext } from "../../src/tools/index";
import {
  createTerminalBatcher,
  TERMINAL_DATA_TYPE,
  type TerminalDataPayload,
} from "../../src/lib/terminal-stream";

describe("chat terminal wiring", () => {
  it("withThreadContext forwards run_command output with the toolCallId", async () => {
    const events: Array<[string, unknown]> = [];
    // Placeholder execute: withThreadContext replaces it with one that calls
    // the real runBash and injects onOutput → onTerminalOutput(id, event).
    const tools = withThreadContext(
      { run_command: { execute: (() => {}) as never } },
      undefined,
      (id, ev) => events.push([id, ev]),
    );
    const res = await (tools.run_command.execute as (
      args: { command: string },
      opts: { toolCallId: string },
    ) => Promise<{ exitCode: number }>)({ command: "Write-Output hi" }, {
      toolCallId: "call-1",
    });
    expect(res.exitCode).toBe(0);
    expect(events.some(([id]) => id === "call-1")).toBe(true);
    expect(events.every(([id]) => id === "call-1")).toBe(true);
  });

  it("withThreadContext leaves run_command unwired when no callback given", async () => {
    let called = false;
    const tools = withThreadContext(
      {
        run_command: {
          execute: async () => {
            called = true;
            return { exitCode: 0 };
          },
        },
      },
      undefined,
    );
    await tools.run_command.execute({ command: "Write-Output hi" });
    expect(called).toBe(true);
  });

  it("terminalBatcher emits data-tbai-terminal parts and a final done part", () => {
    const written: Array<{ type: string; data: TerminalDataPayload }> = [];
    const batcher = createTerminalBatcher((part) => written.push(part));
    batcher.push("call-2", { stream: "stdout", chunk: "a\nb\n" });
    batcher.complete("call-2", 0, false);
    const terminalParts = written.filter((p) => p.type === TERMINAL_DATA_TYPE);
    expect(terminalParts.length).toBeGreaterThan(0);
    const donePart = terminalParts[terminalParts.length - 1];
    expect(donePart.data.done).toBe(true);
    expect(donePart.data.toolCallId).toBe("call-2");
  });

  it("terminalBatcher ignores unknown toolCallIds and no-ops complete", () => {
    const written: Array<{ type: string; data: TerminalDataPayload }> = [];
    const batcher = createTerminalBatcher((part) => written.push(part));
    batcher.complete("never-pushed", 1, true); // no pending state → no part
    expect(written).toEqual([]);
  });
});
