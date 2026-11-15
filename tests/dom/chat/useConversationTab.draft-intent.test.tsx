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

const { MemoryRouter, Route, Routes, useLocation, useNavigate } = await import("react-router");
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
  const state = (location.state ?? null) as Record<string, unknown> | null;
  return (
    <div
      data-testid="probe"
      data-engine={welcome.engine}
      data-agent={welcome.agent}
      data-model={welcome.model}
      data-variant={welcome.variant}
      data-auto={String(welcome.autoApprove)}
      data-path={location.pathname}
      data-has-fallback={String(Boolean(state?.tbaiDraftFallback))}
      data-consumed={String(state?.tbaiDraftFallbackConsumed ?? "")}
      data-other={String(state?.other ?? "")}
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

  it("preserves OpenCode fallback intent for the draft, consumes marker, and keeps autoApprove/unrelated state", async () => {
    useWelcomeEngineStore.setState({ autoApprove: true });
    const { container, unmount } = mount([
      {
        pathname: "/chat/new",
        state: { tbaiDraftFallback: { engine: "opencode" }, other: "keep" },
      },
    ]);
    await act(async () => {});
    await act(async () => {});
    const probe = container.querySelector('[data-testid="probe"]') as HTMLElement;
    expect(probe.dataset.engine).toBe("opencode");
    expect(probe.dataset.agent).toBe("");
    expect(probe.dataset.model).toBe("");
    expect(probe.dataset.variant).toBe("");
    expect(probe.dataset.auto).toBe("true");
    expect(probe.dataset.hasFallback).toBe("false");
    expect(probe.dataset.consumed).toBe("opencode");
    expect(probe.dataset.other).toBe("keep");
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

  it("does not reapply stale fallback intent after remount on the consumed draft entry", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root;
    let show = true;
    function Toggle() {
      return show ? <DraftProbe /> : <div data-testid="gone" />;
    }
    act(() => {
      root = createRoot(container);
      root.render(
        <MemoryRouter
          initialEntries={
            [{ pathname: "/chat/new", state: { tbaiDraftFallback: { engine: "opencode" } } }] as any
          }
        >
          <Routes>
            <Route path="/chat/new" element={<Toggle />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    await act(async () => {});
    await act(async () => {});
    let probe = container.querySelector('[data-testid="probe"]') as HTMLElement;
    expect(probe.dataset.engine).toBe("opencode");
    expect(probe.dataset.hasFallback).toBe("false");
    expect(probe.dataset.consumed).toBe("opencode");

    show = false;
    act(() => {
      root!.render(
        <MemoryRouter
          initialEntries={
            [{ pathname: "/chat/new", state: { tbaiDraftFallbackConsumed: "opencode" } }] as any
          }
        >
          <Routes>
            <Route path="/chat/new" element={<Toggle />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    await act(async () => {});
    // Remount probe on an already-consumed draft history entry: must preserve OpenCode, not reset to Direct.
    show = true;
    act(() => {
      root!.render(
        <MemoryRouter
          initialEntries={
            [{ pathname: "/chat/new", state: { tbaiDraftFallbackConsumed: "opencode" } }] as any
          }
        >
          <Routes>
            <Route path="/chat/new" element={<Toggle />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    await act(async () => {});
    probe = container.querySelector('[data-testid="probe"]') as HTMLElement;
    expect(probe.dataset.engine).toBe("opencode");
    expect(probe.dataset.hasFallback).toBe("false");
    expect(probe.dataset.consumed).toBe("opencode");

    act(() => root!.unmount());
    container.remove();
  });

  it("preserves consumed fallback draft across navigation history (back/forward)", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root;
    function Controls() {
      const navigate = useNavigate();
      return (
        <div>
          <button type="button" data-testid="to-chat" onClick={() => navigate("/chat/abc")}>
            chat
          </button>
          <button type="button" data-testid="back" onClick={() => navigate(-1 as any)}>
            back
          </button>
        </div>
      );
    }
    act(() => {
      root = createRoot(container);
      root.render(
        <MemoryRouter
          initialEntries={
            [
              { pathname: "/chat/new", state: { tbaiDraftFallback: { engine: "opencode" } } },
              "/chat/abc",
            ] as any
          }
          initialIndex={0}
        >
          <Routes>
            <Route
              path="/chat/new"
              element={
                <>
                  <DraftProbe />
                  <Controls />
                </>
              }
            />
            <Route
              path="/chat/:threadId"
              element={
                <>
                  <DraftProbe />
                  <Controls />
                </>
              }
            />
          </Routes>
        </MemoryRouter>,
      );
    });
    await act(async () => {});
    await act(async () => {});
    let probe = container.querySelector('[data-testid="probe"]') as HTMLElement;
    expect(probe.dataset.path).toBe("/chat/new");
    expect(probe.dataset.engine).toBe("opencode");
    expect(probe.dataset.hasFallback).toBe("false");
    expect(probe.dataset.consumed).toBe("opencode");

    const toChat = container.querySelector('[data-testid="to-chat"]') as HTMLButtonElement;
    act(() => {
      toChat.click();
    });
    await act(async () => {});
    probe = container.querySelector('[data-testid="probe"]') as HTMLElement;
    expect(probe.dataset.path).toBe("/chat/abc");

    const back = container.querySelector('[data-testid="back"]') as HTMLButtonElement;
    act(() => {
      back.click();
    });
    await act(async () => {});
    await act(async () => {});
    probe = container.querySelector('[data-testid="probe"]') as HTMLElement;
    expect(probe.dataset.path).toBe("/chat/new");
    expect(probe.dataset.engine).toBe("opencode");
    expect(probe.dataset.hasFallback).toBe("false");
    expect(probe.dataset.consumed).toBe("opencode");

    act(() => root!.unmount());
    container.remove();
  });
});
