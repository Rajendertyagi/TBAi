import { describe, it, expect, beforeAll } from "bun:test";
import { REPO_ROOT } from "../../helpers/repo-root";
import path from "node:path";

/**
 * OpenCodeView loading-surface guard (Phase 2 Step 1).
 *
 * The `!sessionId` branch must render the shared message-shaped boot skeleton
 * inside the normal content surface — never a full-viewport "Starting
 * OpenCode…" replacement. The error/retry branch and the session
 * creation/resume request path must stay untouched.
 *
 * Source-guard convention (same as `CodeShell.test.tsx`): `web/` has no DOM
 * runner, so the loading/error branches are pinned against the source rather
 * than rendered.
 */
describe("OpenCodeView loading surface", () => {
  let source = "";

  beforeAll(async () => {
    source = await Bun.file(
      path.join(REPO_ROOT, "web/src/features/opencode/OpenCodeView.tsx"),
    ).text();
  });

  it("renders the message-shaped boot skeleton while sessionId is unavailable", () => {
    expect(source).toContain("ThreadBootSkeleton");
    expect(source).toContain("if (!sessionId)");
  });

  it("does not render the 'Starting OpenCode…' replacement text", () => {
    // The old centered spinner is gone: `Loader2` is no longer imported, so
    // the loading branch can only render the skeleton. (Doc comments may
    // still mention the old copy; they are not rendered.)
    expect(source).not.toContain("Loader2");
  });

  it("keeps the normal OpenCode content path when sessionId is available", () => {
    expect(source).toContain("<AgentRuntime");
  });

  it("preserves the error/retry branch for session creation failure/timeout", () => {
    expect(source).toContain("error || timedOut");
    expect(source).toContain("Retry");
  });

  it("keeps the session creation/resume bootstrap path", () => {
    expect(source).toContain("bootstrapOpenCodeSession(agentId)");
    // The reuse flag is taken from the SAME bootstrap result as the session id,
    // because it describes that exact session.
    expect(source).toContain("setReusedExistingSession(data.reusedExistingSession)");
  });

  it("renders the retry banner and restoration notice in aboveComposerExtra only", () => {
    const start = source.indexOf("aboveComposerExtra={");
    const end = source.indexOf("belowComposerExtra", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);

    // Both new surfaces are composed in the existing slot - no new page, route,
    // dialog, or ChatWindow slot.
    expect(block).toContain("<OpenCodeRecoveryNotice");
    expect(block).toContain("<OpenCodeRetryBanner />");
    // The banner is closest to the composer, so it comes last.
    expect(block.indexOf("<OpenCodeRecoveryNotice")).toBeLessThan(
      block.indexOf("<OpenCodeRetryBanner"),
    );
    // The notice is keyed by session and told whether this was a verified reuse.
    expect(block).toContain("key={sessionId}");
    expect(block).toContain("reusedExistingSession={reusedExistingSession}");

    // Rendered exactly once, in that slot.
    expect(source.match(/<OpenCodeRetryBanner/g)?.length).toBe(1);
    expect(source.match(/<OpenCodeRecoveryNotice/g)?.length).toBe(1);
    // No assistant-ui retry/status primitive was added for this: neither surface
    // is an assistant-ui element.
    expect(block).not.toContain("ErrorPrimitive");
  });
});
