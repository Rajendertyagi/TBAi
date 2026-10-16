import { describe, it, expect, beforeEach } from "bun:test";
import { activeTab, urlForTab, useChatTabsStore } from "@web/features/chat/state/chatTabs.ts";
import { ROUTES } from "@web/config/navigation.ts";

/**
 * Helper-level unit tests for IndexRedirect's redirect decision.
 *
 * These execute the REAL tab store and the REAL helpers (`activeTab` +
 * `urlForTab`) that `IndexRedirect` evaluates to compute its `<Navigate
 * to={...}>` target, asserting the destination for all three cases.
 * They do NOT render `IndexRedirect` and do NOT execute React Router.
 *
 * Why not render `<Navigate>` itself: this repo has TWO copies of
 * react-router (`web/node_modules` for `@web` sources, root `node_modules`
 * for tests), so a test-side `MemoryRouter` cannot provide context to the
 * component's `Navigate`, and `mock.module("react-router")` cannot
 * intercept the web copy's import. Rendering is pinned separately by the
 * source-guard suite (`IndexRedirect.test.tsx`), which asserts the
 * component returns `<Navigate to={...} replace />`.
 *
 * What regressed before (Phase 5): the component always resolved to
 * `/chat/new`, ignoring the active tab. These tests fail against that
 * implementation and pass against the restored one.
 */

/** Mirrors the expression IndexRedirect renders as `<Navigate to={...}>`. */
function redirectTarget(): string {
  const tab = activeTab(useChatTabsStore.getState());
  return tab ? urlForTab(tab) : ROUTES.CHAT_NEW;
}

describe("IndexRedirect redirect decision", () => {
  beforeEach(() => {
    useChatTabsStore.setState({ tabs: [], activeKey: undefined, groupId: "main" });
  });

  it("Case A: active chat tab redirects to /chat/<id>", () => {
    useChatTabsStore.setState({
      tabs: [{ key: "chat:conv-123", kind: "chat", ref: "conv-123" }],
      activeKey: "chat:conv-123",
    });
    expect(redirectTarget()).toBe("/chat/conv-123");
  });

  it("Case B: active agent tab redirects to /code/<id>", () => {
    useChatTabsStore.setState({
      tabs: [{ key: "agent:conv-456", kind: "agent", ref: "conv-456" }],
      activeKey: "agent:conv-456",
    });
    expect(redirectTarget()).toBe("/code/conv-456");
  });

  it("Case C: no active tab redirects to /chat/new", () => {
    useChatTabsStore.setState({ tabs: [], activeKey: undefined });
    expect(redirectTarget()).toBe("/chat/new");
  });
});
