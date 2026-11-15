import { describe, it, expect, beforeEach, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "../../helpers/repo-root";

// Prevent network probes during draft-only tests. Mock both alias and relative-resolved paths.
mock.module("@web/app/adapter.ts", () => ({
  threadListAdapter: {
    fetch: async () => {
      throw new Error("unexpected fetch in draft-intent test");
    },
  },
}));
mock.module(pathToFileURL(path.join(REPO_ROOT, "web/src/app/adapter.ts")).href, () => ({
  threadListAdapter: {
    fetch: async () => {
      throw new Error("unexpected fetch in draft-intent test");
    },
  },
}));

const { MemoryRouter, Route, Routes, useLocation } = await import("react-router");
const { useConversationTab } = await import("@web/features/chat/state/useConversationTab.ts");
const { useWelcomeEngineStore } = await import("@web/features/chat/state/welcomeEngine.ts");
const { useChatTabsStore } = await import("@web/features/chat/state/chatTabs.ts");
const { usePreferencesStore } = await import("@web/features/preferences/state/preferencesStore.ts");

function resetStores() {
  useWelcomeEngineStore.setState({
    engine: "direct",
    agent: "",
    model: "",
    variant: "",
    autoApprove: false,
  });
  useChatTabsStore.setState({
    tabs: [],
    activeKey: null,
    groupId: "main",
    detachedRefs: new Set<string>(),
  } as any);
  usePreferencesStore.setState({ snapshot: null } as any);
}

function DraftProbe() {
  useConversationTab(undefined, "chat");
  const location = useLocation();
  const welcome = useWelcomeEngineStore();
  return (
    <div
      data-testid="probe"
      data-engine={welcome.engine}
      data-agent={welcome.agent}
      data-model={welcome.model}
      data-variant={welcome.variant}
      data-auto={String(welcome.autoApprove)}
      data-path={location.pathname}
      data-state={location.state ? "1" : "0"}
    />
  );
}

function mount(initialEntries: Array<string | { pathname: string; state?: unknown }>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={initialEntries as any}>
        <Routes>
          <Route path="/chat/new" element={<DraftProbe />} />
          <Route path="/chat/:threadId" element={<DraftProbe />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return {
    container,
    unmount: () => {
      act(() => root!.unmount());
      container.remove();
    },
  };
}

describe("useConversationTab draft fallback intent", () => {
  beforeEach(() => {
    resetStores();
  });

  it("preserves OpenCode fallback intent for the draft and keeps autoApprove", async () => {
    useWelcomeEngineStore.setState({ autoApprove: true });
    const { container, unmount } = mount([
      {
        pathname: "/chat/new",
        state: { tbaiDraftFallback: { engine: "opencode" } },
      },
    ]);
    await act(async () => {});
    const probe = container.querySelector('[data-testid="probe"]') as HTMLElement;
    expect(probe.dataset.engine).toBe("opencode");
    expect(probe.dataset.agent).toBe("");
    expect(probe.dataset.model).toBe("");
    expect(probe.dataset.variant).toBe("");
    expect(probe.dataset.auto).toBe("true");
    unmount();
  });

  it("initializes a genuinely fresh draft with Direct defaults and preserves autoApprove", async () => {
    useWelcomeEngineStore.setState({
      engine: "opencode",
      agent: "a",
      model: "m",
      variant: "v",
      autoApprove: true,
    });
    const { container, unmount } = mount(["/chat/new"]);
    await act(async () => {});
    const probe = container.querySelector('[data-testid="probe"]') as HTMLElement;
    expect(probe.dataset.engine).toBe("direct");
    expect(probe.dataset.agent).toBe("");
    expect(probe.dataset.model).toBe("");
    expect(probe.dataset.variant).toBe("");
    expect(probe.dataset.auto).toBe("true");
    unmount();
  });
});
