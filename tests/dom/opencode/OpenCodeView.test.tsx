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

  it("supplies the composer extras split into status, interactive and below (S7a)", () => {
    const start = source.indexOf("composerExtras={{");
    expect(start).toBeGreaterThan(-1);

    // The mixed slot API is gone: status presentations, interactive content and
    // the heart are separate concerns, and only that split keeps a status pill
    // out of the interactive area's flow.
    expect(source).not.toContain("aboveComposerExtra");
    expect(source).not.toContain("belowComposerExtra");

    // Interactive content: the question dock, at its natural height.
    expect(source).toContain("interactive: <OpenCodeQuestions />");

    // Status region: exactly the primary and the restoration notice.
    const statusStart = source.indexOf("status: (", start);
    const statusEnd = source.indexOf("below:", statusStart);
    expect(statusStart).toBeGreaterThan(start);
    expect(statusEnd).toBeGreaterThan(statusStart);
    const statusBlock = source.slice(statusStart, statusEnd);
    expect(statusBlock).toContain("<OpenCodeRecoveryNotice");
    expect(statusBlock).toContain("<OpenCodePrimaryStatus />");
    // The primary renders first so it owns the top line when the row wraps.
    expect(statusBlock.indexOf("<OpenCodePrimaryStatus")).toBeLessThan(
      statusBlock.indexOf("<OpenCodeRecoveryNotice"),
    );
    // The notice is keyed by session and told whether this was a verified reuse.
    expect(statusBlock).toContain("key={sessionId}");
    expect(statusBlock).toContain("reusedExistingSession={reusedExistingSession}");

    // Below row: the connection heart, outside the reserved status row.
    expect(source).toContain("below: <OpenCodeStatus compact onReconnect={reconnect} />");

    // Rendered exactly once each, and the deleted banner is gone.
    expect(source.match(/<OpenCodePrimaryStatus/g)?.length).toBe(1);
    expect(source.match(/<OpenCodeRecoveryNotice/g)?.length).toBe(1);
    expect(source).not.toContain("OpenCodeRetryBanner");
    // No assistant-ui retry/status primitive was added for this: neither
    // surface is an assistant-ui element.
    expect(statusBlock).not.toContain("ErrorPrimitive");
  });
});
