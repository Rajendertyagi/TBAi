/**
 * Chat-route terminal wiring: proves the `run_command` live-output chain the
 * chat route depends on — `withTerminalOutput` injects `onTerminalOutput` into
 * `run_command`'s execute (capturing the AI SDK `toolCallId` from the execute
 * options), and `createTerminalBatcher` throttles those events into
 * `data-tbai-terminal` parts with a guaranteed final `done` part.
 *
 * These are the two seams `routes/chat.ts` stitches together; testing them in
 * isolation covers the wiring without a full HTTP request. `bun test`.
 *
 * Rewritten against the current native-tools API. The per-request rewrapper this
 * file used to drive (`withThreadContext`) no longer exists: request data now
 * rides validated Zod tool context (`buildToolsContext`) plus one thin closure
 * for the terminal tap (`withTerminalOutput`). The behaviours under test are
 * unchanged, only the seam moved — and while the old `withThreadContext` import
 * was still here the whole file failed to load, so its two `terminalBatcher`
 * tests had not been running at all.
 */
import { describe, it, expect, mock } from "bun:test";
import type { TerminalDataPayload } from "../../src/lib/terminal-stream";

/**
 * The scheduler service is intercepted so the assertions can see the ARGS the
 * tool resolved. What is under test is the injection in `src/tools/index.ts`,
 * not the scheduler's own persistence.
 */
const schedulerCalls: Array<Record<string, unknown>> = [];
mock.module("../../src/services/scheduler/schedulerTools", () => ({
  runScheduler: (args: Record<string, unknown>) => {
    schedulerCalls.push(args);
    return { ok: true };
  },
}));

const { nativeTools, withTerminalOutput, buildToolsContext } = await import(
  "../../src/tools/index"
);
const { getWorkspaceDir } = await import("../../src/services/tools");
const {
  createTerminalBatcher,
  TERMINAL_DATA_TYPE,
} = await import("../../src/lib/terminal-stream");

type ExecuteWith = (
  args: unknown,
  opts: { context?: unknown; toolCallId?: string },
) => Promise<unknown>;

const CREATE_ARGS = {
  action: "create",
  name: "n",
  scheduleType: "once",
  execAt: 1,
  timezone: "UTC",
  prompt: "p",
};

/**
 * `buildToolsContext` returns a map KEYED BY TOOL NAME. AI SDK validates each
 * tool against its own `contextSchema` and hands `execute` only that entry as
 * `options.context` — so a test must index the tool it is calling. Passing the
 * whole map is a category error, and `requireWorkspace` rejects it, which is
 * precisely how that mistake announces itself.
 */
function chatContext(tool: "run_command" | "scheduler") {
  const context = buildToolsContext({
    workspaceDir: getWorkspaceDir(),
    threadId: "thread-1",
    providerId: "p-chat",
    modelId: "m-chat",
  });
  return context[tool];
}

describe("chat terminal wiring", () => {
  it("withTerminalOutput forwards run_command output with the toolCallId", async () => {
    const events: Array<[string, unknown]> = [];
    const runCommand = withTerminalOutput((id, event) => events.push([id, event]));

    const res = (await (runCommand.execute as unknown as ExecuteWith)(
      { command: "Write-Output hi" },
      { context: chatContext("run_command"), toolCallId: "call-1" },
    )) as { exitCode: number };

    expect(res.exitCode).toBe(0);
    // `some` first: `every` is vacuously true on an empty event list, which is
    // exactly how a silently-unwired tap would slip through.
    expect(events.some(([id]) => id === "call-1")).toBe(true);
    expect(events.every(([id]) => id === "call-1")).toBe(true);
  });

  it("the untapped run_command still executes (the static entry keeps working)", async () => {
    const res = (await (nativeTools.run_command.execute as unknown as ExecuteWith)(
      { command: "Write-Output hi" },
      { context: chatContext("run_command") },
    )) as { exitCode: number };
    expect(res.exitCode).toBe(0);
  });

  it("buildToolsContext fails closed without a workspace root", () => {
    // The guard the old withThreadContext owned: a missing root must fail
    // during tools assembly, never fall back to the process-wide workspace.
    expect(() => buildToolsContext({ workspaceDir: undefined })).toThrow();
  });

  it("injects the conversation's provider/model/workspace into scheduler creates", async () => {
    schedulerCalls.length = 0;

    await (nativeTools.scheduler.execute as unknown as ExecuteWith)(CREATE_ARGS, {
      context: chatContext("scheduler"),
    });

    expect(schedulerCalls).toHaveLength(1);
    expect(schedulerCalls[0]).toMatchObject({
      action: "create",
      providerId: "p-chat",
      modelId: "m-chat",
      workspacePath: getWorkspaceDir(),
    });
  });

  it("leaves explicit scheduler IDs alone", async () => {
    schedulerCalls.length = 0;

    await (nativeTools.scheduler.execute as unknown as ExecuteWith)(
      {
        ...CREATE_ARGS,
        providerId: "p-other",
        modelId: "m-other",
        workspacePath: "/elsewhere",
      },
      { context: chatContext("scheduler") },
    );

    expect(schedulerCalls[0]).toMatchObject({
      providerId: "p-other",
      modelId: "m-other",
      workspacePath: "/elsewhere",
    });
  });

  it("passes non-create actions through untouched", async () => {
    schedulerCalls.length = 0;

    // The create-only defaults must not leak onto other actions: the model
    // cannot be allowed to "inherit" a provider for a delete.
    await (nativeTools.scheduler.execute as unknown as ExecuteWith)(
      { action: "list" },
      { context: chatContext("scheduler") },
    );

    expect(schedulerCalls[0]).toEqual({ action: "list" });
  });

  it("carries the toolCallId through the instrumented execute options", async () => {
    // Regression: the framework's (args, callOptions) wrapper throws
    // "callOptions.toolCallId" when invoked without its second argument, so the
    // funnel wrapper must forward options rather than swallow them.
    schedulerCalls.length = 0;

    const res = await (nativeTools.scheduler.execute as unknown as ExecuteWith)(
      { action: "list" },
      { context: chatContext("scheduler"), toolCallId: "call-9" },
    );

    expect(res).toEqual({ ok: true });
    expect(schedulerCalls[0]).toEqual({ action: "list" });
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
