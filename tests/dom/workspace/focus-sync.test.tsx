/**
 * Phase E focus/URL convergence (plan §6 tests 10, 15, 16).
 *
 * Mounts the REAL `useWorkspaceFocusSync` controller inside a MemoryRouter with
 * a fake Dockview handle. Verifies that `chatTabs.localActiveKey` is the single
 * URL-authoritative selection, that Dockview focus is driven from it, that a
 * user-origin Dockview focus writes back to the store and URL, and that an
 * 'api'-origin echo cannot create a feedback loop.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { MemoryRouter, useLocation } = await import("react-router");
const { useWorkspaceFocusSync } = await import(
  "@web/features/workspace/state/useWorkspaceFocusSync.ts"
);
const { useChatTabsStore } = await import("@web/features/chat/state/chatTabs.ts");

interface FakeHandle {
  focusOrOpen(tabKey: string): void;
}

let focusCalls: string[] = [];
let latestSync: ReturnType<typeof useWorkspaceFocusSync> | null = null;
const handleRef: { current: FakeHandle | null } = {
  current: { focusOrOpen: (tabKey) => focusCalls.push(tabKey) },
};

function Probe() {
  latestSync = useWorkspaceFocusSync(handleRef);
  const location = useLocation();
  return <div data-testid="path" data-path={location.pathname} />;
}

let container: HTMLElement;
let root: Root;

function mount(initialPath: string): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <Probe />
      </MemoryRouter>,
    );
  });
}

function path(): string | null {
  return (
    container.querySelector<HTMLElement>('[data-testid="path"]')?.getAttribute("data-path") ?? null
  );
}

beforeEach(() => {
  focusCalls = [];
  latestSync = null;
  handleRef.current = { focusOrOpen: (tabKey) => focusCalls.push(tabKey) };
  useChatTabsStore.setState({
    localActiveKey: undefined,
    hasLocalDraft: false,
    detachedRefs: {},
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("localActiveKey -> Dockview focus + URL (plan §6 tests 10, 15)", () => {
  it("focuses the chat panel and keeps the URL for a /chat/:id selection", () => {
    mount("/chat/a");
    act(() => useChatTabsStore.getState().selectLocal("chat:a"));
    expect(focusCalls).toEqual(["chat:a"]);
    expect(path()).toBe("/chat/a");
  });

  it("focuses the agent panel and navigates when the selection changes to /code/:id", () => {
    mount("/chat/a");
    act(() => useChatTabsStore.getState().selectLocal("chat:a"));
    act(() => useChatTabsStore.getState().presentAgent("agent-7"));
    expect(focusCalls).toEqual(["chat:a", "agent:agent-7"]);
    expect(path()).toBe("/code/agent-7");
  });

  it("focuses the single draft panel for chat:new", () => {
    mount("/chat/new");
    act(() => useChatTabsStore.getState().openNewDraft());
    expect(focusCalls).toEqual(["chat:new"]);
    expect(path()).toBe("/chat/new");
  });

  it("refocus re-drives the current key when the handle becomes ready late", () => {
    // A deep link sets localActiveKey before Dockview's onReady populates the
    // handle. The one-shot effect skips focus; refocus (fired on handle ready)
    // must re-drive it so the target panel becomes active and its content shows.
    handleRef.current = null; // simulate Dockview not ready yet
    mount("/chat/deep");
    act(() => useChatTabsStore.getState().selectLocal("chat:deep"));
    expect(focusCalls).toEqual([]); // skipped while handle was null

    handleRef.current = { focusOrOpen: (tabKey) => focusCalls.push(tabKey) };
    act(() => latestSync!.refocus());
    expect(focusCalls).toEqual(["chat:deep"]);
  });
});

describe("Dockview user focus -> localActiveKey + URL (plan §6 test 16)", () => {
  it("writes a user-origin focus into the store and URL", () => {
    mount("/chat/a");
    act(() => useChatTabsStore.getState().selectLocal("chat:a"));
    act(() => latestSync!.onDockviewActivePanelChange("agent:agent-9", "user"));
    expect(useChatTabsStore.getState().localActiveKey).toBe("agent:agent-9");
    expect(path()).toBe("/code/agent-9");
    // The store change echoes back into Dockview exactly once (origin 'api').
    expect(focusCalls).toEqual(["chat:a", "agent:agent-9"]);
  });

  it("ignores an api-origin echo — no feedback loop", () => {
    mount("/chat/a");
    act(() => useChatTabsStore.getState().selectLocal("chat:a"));
    const before = useChatTabsStore.getState().localActiveKey;
    act(() => latestSync!.onDockviewActivePanelChange("chat:other", "api"));
    expect(useChatTabsStore.getState().localActiveKey).toBe(before);
    expect(path()).toBe("/chat/a");
    expect(focusCalls).toEqual(["chat:a"]);
  });

  it("ignores a user-origin focus with no panel", () => {
    mount("/chat/a");
    act(() => useChatTabsStore.getState().selectLocal("chat:a"));
    act(() => latestSync!.onDockviewActivePanelChange(undefined, "user"));
    expect(useChatTabsStore.getState().localActiveKey).toBe("chat:a");
  });
});
