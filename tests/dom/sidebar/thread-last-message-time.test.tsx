import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadLastMessageTime } from "@web/components/ui/thread-last-message-time";

/**
 * The row timestamp outside the runtime.
 *
 * `ThreadLastMessageTime` reads the canonical assistant-ui thread list, which
 * only exists under `AppShell`'s provider. The sidebar's own paged fetch is the
 * fallback, and a bare render (a test or a preview, no `AuiProvider`) must
 * degrade to it rather than throw — the same contract `ThreadRunningDot`
 * carries for the running dot.
 */
describe("ThreadLastMessageTime outside the runtime", () => {
  it("renders nothing when neither the runtime nor the fetched row has a timestamp", () => {
    expect(renderToStaticMarkup(<ThreadLastMessageTime remoteId="thread-1" />)).toBe("");
  });

  it("falls back to the timestamp the sidebar fetched", () => {
    const html = renderToStaticMarkup(
      <ThreadLastMessageTime remoteId="thread-1" fallback={new Date(Date.now() - 5 * 60_000)} />,
    );
    expect(html).toContain("5m ago");
  });
});
