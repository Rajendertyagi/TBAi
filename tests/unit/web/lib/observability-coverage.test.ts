/**
 * Reconstruction coverage guards.
 *
 * The point of this work is not "more logs" but the ability to reconstruct one
 * user operation from evidence. These guards pin the specific lifecycle events
 * that make the two canonical operations reconstructable — Direct Chat and the
 * OpenCode first send — plus the recovery / permission / cancellation paths.
 *
 * Assertions are made against COMMENT-STRIPPED source and use unique event-name
 * literals, so a doc comment describing an event can never satisfy a test for
 * the event itself. `web/` has no DOM, so this is the only available check for
 * "this boundary emits this event".
 */
import { describe, it, expect } from "bun:test";
import path from "node:path";
import { stripComments } from "@web/testing/source-scope";
import { REPO_ROOT } from "../../../helpers/repo-root";

async function sourceOf(relative: string): Promise<string> {
  return stripComments(await Bun.file(path.join(REPO_ROOT, relative)).text());
}

/** Every event name the reconstruction contract depends on, by owning file. */
const LIFECYCLE_EVENTS: Array<[file: string, events: string[]]> = [
  // ---- Direct Chat: one send = one operation ----
  ["web/src/lib/send-operation.ts", [
    "send.start",                 // the operation opens
    "send.stream_end",            // terminal: marker, failure, or body settle
  ]],
  ["web/src/runtime.ts", [
    "send.failed",                // run error
    "send.redirected_to_opencode",// first send routed to the Code surface
    "request_sent",               // browser half of the request pair
    "request_completed",
    "request_failed",
  ]],
  ["web/src/features/chat/state/materializeDraft.ts", [
    "draft.snapshot",             // engine decision
    "draft.materialize_start",
    "draft.materialized",         // conversationId + engine
    "draft.materialize_failed",
  ]],
  ["web/src/features/chat/state/deleteConversation.ts", [
    "run.cancel_requested",
    "run.cancel_rejected",
  ]],
  // ---- OpenCode first send ----
  ["web/src/features/opencode/FirstPromptHandoff.tsx", [
    "handoff.start",
    "handoff.accepted",
    "handoff.failed",
    "handoff.not_bound",          // the previously invisible half
  ]],
  // ---- Routing / runtime / boundaries ----
  ["web/src/app/RouteObserver.tsx", ["route.change"]],
  ["web/src/app/RouteError.tsx", ["boundary_error"]],
  ["web/src/lib/logger.ts", [
    "window_error",               // genuine uncaught browser error
    "unhandled_rejection",
    "browser_layout_diagnostic",  // narrow: the ResizeObserver delivery notice
  ]],
  ["web/src/app/layout/ChatShell.tsx", ["runtime.mount", "runtime.unmount"]],
  ["web/src/features/opencode/CodeShell.tsx", ["runtime.mount", "runtime.unmount"]],
  ["web/src/features/opencode/commandsStore.ts", [
    "command.feed_loaded",   // the OpenCode command feed arrived
    "command.feed_failed",   // …or did not (the previous list is retained)
  ]],
  ["web/src/features/opencode/compactSession.ts", [
    "command.compact_started",   // built-in /compact summarize began
    "command.compact_completed", // the server confirmed compaction
    "command.compact_failed",    // …or did not (truthful error, nothing sent)
  ]],
  // ---- Recovery / availability ----
  ["web/src/features/availability/availabilityStore.ts", ["state.change", "recovery"]],
  // ---- Permissions / questions ----
  ["web/src/tools/filesystem/ui.tsx", [
    "decision.submitted",
    "decision.accepted",
    "decision.failed",
  ]],
  ["web/src/components/assistant-ui/elements/tool-fallback.tsx", [
    "decision.submitted",
    "decision.accepted",
    "decision.failed",
  ]],
  ["web/src/features/opencode/V2FormCard.tsx", [
    "question.submitted",
    "question.accepted",
    "question.failed",
    "question.dismissed",
  ]],
];

describe("lifecycle events required for reconstruction", () => {
  for (const [file, events] of LIFECYCLE_EVENTS) {
    it(`${file} emits its lifecycle events`, async () => {
      const source = await sourceOf(file);
      const missing = events.filter((e) => !source.includes(`"${e}"`));
      expect(missing).toEqual([]);
    });
  }
});

describe("frontend correlation wiring", () => {
  it("installs both the global hooks and the operation-header fetch", async () => {
    const main = await sourceOf("web/src/main.tsx");
    expect(main).toContain("installGlobalLogHooks()");
    expect(main).toContain("installOperationHeaderFetch()");
  });

  it("forwards every logged event to the backend transport", async () => {
    const logger = await sourceOf("web/src/lib/logger.ts");
    expect(logger).toContain("enqueueClientEvent(");
    // The transport level is separate from the console level: console stays
    // quiet in production while lifecycle `info` events still reach the backend.
    expect(logger).toContain("transportLevel");
  });

  it("does not log message text or model output in lifecycle events", async () => {
    const runtime = await sourceOf("web/src/runtime.ts");
    // `lastUserText` exists for the handoff stash (not for logging), so assert
    // the log call sites carry no prompt text.
    expect(runtime).not.toContain("logger.info(\"chat\", \"send.start\", { text");
    expect(runtime).not.toMatch(/logger\.\w+\([^)]*lastUserText/);
  });
});
