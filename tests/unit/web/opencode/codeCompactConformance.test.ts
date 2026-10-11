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
import path from "node:path";
import * as fs from "node:fs";
import { isCompactCommandText, runCompactSession } from "@web/features/opencode/compactSession.ts";
import { logger } from "@web/lib/logger.ts";
import { REPO_ROOT } from "../../../helpers/repo-root";

const SRC = path.join(REPO_ROOT, "web/src/features/opencode");
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
    //
    // This copy used to be inlined in `Composer.tsx`. It now lives in
    // `ComposerAlerts`, which `Composer` renders, so asserting against the
    // Composer source was a STALE guard: it failed while the behaviour it claims
    // to protect was intact and only the file ownership had moved. Read the file
    // that now owns the string rather than deleting the check.
    const alerts = fs.readFileSync(
      path.join(SRC, "..", "..", "components", "composer", "ComposerAlerts.tsx"),
      "utf8",
    );
    expect(alerts).toContain("Couldn&apos;t compact the session");
    expect(alerts).toContain("Nothing was sent.");
    // The Composer must still render that alert component, or the copy is
    // present but unreachable.
    expect(composer).toContain("ComposerAlerts");
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
    expect(display).toContain(
      'if (unknown) return <span className="font-mono tabular-nums">--</span>;',
    );
    // And no fabricated estimate keeps the ring populated.
    expect(display).not.toContain("unknown ? Math.round(percent)");
  });
});

describe("/compact uses OpenCode's own compaction", () => {
  it("calls the OpenCode compact operation, not a local summarizer", () => {
    // Layout-independent: the argument list is spread over several lines, and a
    // single-line `toContain` of the whole call pinned the assertion to a
    // wrapping style rather than to the fields the call is made with.
    expect(controller).toMatch(
      /generation\.operations\.compact\(\{[\s\S]*?sessionID: client\.sessionId,[\s\S]*?id,[\s\S]*?delivery: "steer",?[\s\S]*?\}\)/,
    );
  });

  it("admits the resulting inbox record as a compaction", () => {
    // The server's admission, not a locally invented one. The inbox fields are
    // on separate lines, so the pairing is asserted across them rather than by
    // a contiguous substring.
    expect(controller).toContain('type: "compaction_admitted"');
    expect(controller).toMatch(/type: "compaction",[\s\S]*?delivery: result\.delivery,/);
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
