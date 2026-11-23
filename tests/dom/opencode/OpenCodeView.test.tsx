import { describe, it, expect, beforeAll } from "bun:test";
import { REPO_ROOT } from "../../helpers/repo-root";
import path from "node:path";

/**
 * OpenCode surface guards, split by ownership after the host extraction.
 *
 * `OpenCodeView` is now a THIN focus/open trigger: it reads the route param,
 * validates the tab and redirects a missing agent id. In Phase E it mounts no
 * host at all — `OpenCodeChatHost` lives in the persistent Dockview
 * `OpenCodePanel`, so a route-mounted host would create a duplicate runtime.
 * The loading/error/bootstrap and composer-extras invariants therefore belong
 * to the host's source, not the adapter's. Both files are guarded here so the
 * extraction cannot silently drop a behavior.
 *
 * Source-guard convention (same as `CodeShell.test.tsx`): `web/` has no DOM
 * runner, so these branches are pinned against the source rather than rendered.
 */

async function sourceOf(relativePath: string): Promise<string> {
  return Bun.file(path.join(REPO_ROOT, relativePath)).text();
}

describe("OpenCodeView thin route adapter", () => {
  let source = "";

  beforeAll(async () => {
    source = await sourceOf("web/src/features/opencode/OpenCodeView.tsx");
  });

  it("reads and validates the route param through the shared tab binding", () => {
    expect(source).toContain("useParams");
    expect(source).toContain('useConversationTab(agentId, "agent")');
  });

  it("redirects a missing agent id to the welcome draft", () => {
    expect(source).toContain("navigate(ROUTES.CHAT_NEW");
    expect(source).toContain("if (!agentId?.trim())");
  });

  it("owns no boot skeleton of its own — the host renders it in the Dockview panel", () => {
    // Phase E: the view is a thin focus trigger; the boot skeleton lives in
    // OpenCodeChatHost, mounted by the persistent OpenCodePanel.
    expect(source).not.toContain("ThreadBootSkeleton");
    expect(source).not.toContain("Loader2");
  });

  it("delegates the full lifecycle to the Dockview host, not a route-mounted one", () => {
    // No host in the route view: a second mount would create a duplicate
    // runtime for an already-open panel. The panel owns the host.
    expect(source).not.toContain("<OpenCodeChatHost");
    expect(source).toContain('useConversationTab(agentId, "agent")');
    // The adapter owns no runtime/bootstrap/composer internals of its own.
    expect(source).not.toContain("bootstrapOpenCodeSession");
    expect(source).not.toContain("composerExtras");
  });
});

describe("OpenCodeChatHost lifecycle and composer extras", () => {
  let source = "";

  beforeAll(async () => {
    source = await sourceOf("web/src/features/opencode/OpenCodeChatHost.tsx");
  });

  it("renders the message-shaped boot skeleton while sessionId is unavailable", () => {
    expect(source).toContain("ThreadBootSkeleton");
    expect(source).toContain("if (!sessionId)");
  });

  it("does not render the 'Starting OpenCode…' replacement text", () => {
    expect(source).not.toContain("Loader2");
  });

  it("keeps the normal OpenCode content path when sessionId is available", () => {
    expect(source).toContain("<AgentRuntime");
  });

  it("preserves the error/retry branch for session creation failure/timeout", () => {
    expect(source).toContain("error || timedOut");
    expect(source).toContain("Retry");
  });

  it("keeps the session creation/resume bootstrap path keyed by conversation id", () => {
    expect(source).toContain("bootstrapOpenCodeSession(conversationId)");
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

    // Interactive content: the question dock at natural height. The visible
    // queued-prompt strip was removed from the normal OpenCode chat interface
    // by user direction; underlying prompt tracking/cancellation remains.
    expect(source).not.toContain("<OpenCodeQueuedPrompts");
    expect(source).toContain("<OpenCodeQuestions />");

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
