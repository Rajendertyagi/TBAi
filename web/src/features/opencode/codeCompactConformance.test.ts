/**
 * `/compact` conformance on the Code surface.
 *
 * ## What conformance means here
 *
 * OpenChamber intercepts `/compact` locally, calls OpenCode's compact endpoint,
 * and lets the resulting server-side summarization be the only thing that
 * rewrites history. TBAi must do the same, and must NOT wrap the command in a
 * model message - there is nothing for the model to say about a command the
 * client handles itself.
 *
 * These cases verify the full chain against the real source rather than
 * re-testing the helpers in isolation:
 *
 *   user types `/compact` -> local interception -> submit prevented
 *     -> OpenCode `operations.compact` -> compaction lifecycle event
 *     -> `occupancyStale` -> meter reports unknown
 *
 * A duplicate request is pinned because the interception runs on submit: if the
 * guard were removed, one keystroke of Enter would admit two compactions.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isCompactCommandText, runCompactSession } from "./compactSession";
import { logger } from "../../lib/logger";

const SRC = path.resolve(import.meta.dir);
const composer = fs.readFileSync(path.join(SRC, "..", "..", "components", "Composer.tsx"), "utf8");
const controller = fs.readFileSync(path.join(SRC, "v2ThreadController.ts"), "utf8");
const display = fs.readFileSync(
  path.join(SRC, "..", "..", "components", "assistant-ui", "elements", "context-display.tsx"),
  "utf8",
);

describe("/compact is intercepted locally and never reaches the model", () => {
  it("matches a whole-box /compact only", () => {
    expect(isCompactCommandText("/compact")).toBe(true);
    // A mention mid-sentence is ordinary text and must go to the model.
    expect(isCompactCommandText("run /compact for me")).toBe(false);
    expect(isCompactCommandText("/compaction")).toBe(false);
  });

  it("diverts the submit BEFORE the library's own handler", () => {
    // `onSubmit` is composed first, so preventing here means the normal send
    // never fires. This is the structural reason /compact is local.
    expect(composer).toContain("onSubmit={handleComposerSubmit}");
    expect(composer).toMatch(/if \(canCompact && isCompactCommandText\(composerText\)\)/);
  });

  it("guards against a duplicate compact request while one is in flight", () => {
    // Without this the guard, one Enter could admit two compactions.
    expect(composer).toMatch(/if \(!context\?\.compact \|\| compacting\) return;/);
    expect(composer).toContain("setCompacting(true)");
    expect(composer).toContain("setCompacting(false)");
  });

  it("offers the command only where a session exists to compact", () => {
    // A Direct surface has no OpenCode session, so /compact is absent there
    // rather than silently unavailable.
    expect(composer).toContain("shouldOfferCompact(isCodeSurface, openCodeRuntimeContext)");
  });

  it("reports a refused compaction instead of claiming success", () => {
    // Truthful failure: the error surfaces and no message was sent.
    expect(composer).toContain("Couldn&apos;t compact the session");
    expect(composer).toContain("Nothing was sent.");
  });

  it("the server's compaction lifecycle reaches the reducer", () => {
    // FOUND DURING CONFORMANCE - a real defect, not a test artifact.
    //
    // `compaction_settled` is handled in the reducer but DISPATCHED NOWHERE.
    // The only producer was `compaction_admitted`, dispatched from `compact()`.
    // So `running -> settled` never happens: the meter could never learn that a
    // compaction finished, and the pre-compaction number would persist.
    //
    // These are the events OpenCode publishes (see `PUBLIC_EVENT_TYPES` in
    // v2Events.ts, which already lists all four), so the bridge is what is
    // missing - not the vocabulary and not the reducer.
    expect(controller).toContain("function applyCompactionLifecycleEvent(event: V2Event): void");
    expect(controller).toContain('case "session.compaction.started"');
    expect(controller).toContain('dispatch({ type: "compaction_running" })');
    expect(controller).toContain('dispatch({ type: "compaction_settled" })');
    expect(controller).toContain('dispatch({ type: "compaction_failed"');
    // And it is actually reached from the event stream, not merely defined.
    expect(controller).toContain("applyCompactionLifecycleEvent(event);");
  });

  it("a settled compaction reaches the meter as unknown", () => {
    // The last link: the lifecycle event invalidates occupancy, and the ring
    // renders a placeholder rather than the pre-compaction figure. Without this
    // hop, `/compact` would run and the meter would keep showing the old number.
    expect(display).toContain('if (unknown) return <span className="font-mono tabular-nums">--</span>;');
    // And no fabricated estimate keeps the ring populated.
    expect(display).not.toContain("unknown ? Math.round(percent)");
  });
});

describe("/compact uses OpenCode's own compaction", () => {
  it("calls the OpenCode compact operation, not a local summarizer", () => {
    expect(controller).toContain("generation.operations.compact({ sessionID: client.sessionId, id, delivery: \"steer\" })");
  });

  it("admits the resulting inbox record as a compaction", () => {
    // The server's admission, not a locally invented one.
    expect(controller).toContain('type: "compaction_admitted"');
    expect(controller).toContain('type: "compaction", delivery: result.delivery');
  });

  it("reconstructs the run from logs alone", async () => {
    // A server-side summarization is invisible from the UI, so a run is only
    // reconstructable if both the admission and the outcome are recorded.
    const events: string[] = [];
    const realInfo = logger.info;
    logger.info = ((_scope: string, event: string) => {
      events.push(event);
    }) as typeof logger.info;
    try {
      await runCompactSession(async () => undefined, { sessionId: "ses_1" });
      expect(events).toEqual(["command.compact_started", "command.compact_completed"]);
    } finally {
      logger.info = realInfo;
    }
  });
});