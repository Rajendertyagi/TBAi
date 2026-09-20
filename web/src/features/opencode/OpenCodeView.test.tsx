import { describe, it, expect, beforeAll } from "bun:test";

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
      new URL("./OpenCodeView.tsx", import.meta.url),
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
  });
});