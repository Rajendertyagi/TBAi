/**
 * Direct host / panel composition parity — behaviorally asserted.
 *
 * Phase B claimed that a Direct panel renders the same composition as the
 * routed ChatView: ChatHeader + ChatWindow inside ONE per-host assistant-ui
 * provider, with the shared Direct config (tools + suggestions) and the
 * progress/compaction data UIs. These tests mount the real panel/host tree in
 * happy-dom with only the heavy leaf components and the runtime factory faked,
 * then assert the rendered composition. They also pin the two invariants that
 * keep Direct hosts independent: distinct runtimes per host, and a single host
 * per canonical conversation (the panelRegistry claim). Finally they drive the
 * draft-aware host's thread-id-change callback to prove the materialized id is
 * bound exactly once with the engine the single owner recorded.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "../../helpers/repo-root";

// --- Observable state captured from the faked modules -----------------------
let runtimeCounter = 0;
let capturedOnThreadIdChange: ((id: string | undefined) => void) | undefined;
let fakeMaterializedEngine: "direct" | "opencode" | null = null;

import * as realAssistantUI from "@assistant-ui/react";

/** The assistant-ui surface the Direct host tree uses, replaced with markers. */
mock.module("@assistant-ui/react", () => ({
  ...realAssistantUI,
  defineToolkit: (definition: unknown) => definition,
  AuiConfig: (config: unknown) => config,
  AuiProvider: ({
    config,
    children,
  }: {
    config: { tools?: unknown; suggestions?: { values?: string[] } };
    children?: ReactNode;
  }) => (
    <div
      data-testid="aui-provider"
      data-has-tools={String(Boolean(config?.tools))}
      data-suggestions={String(config?.suggestions?.values?.length ?? 0)}
    >
      {children}
    </div>
  ),
  AssistantRuntimeProvider: ({
    runtime,
    config,
    children,
  }: {
    runtime: { id?: string };
    config: { tools?: unknown; suggestions?: { values?: string[] } };
    children?: ReactNode;
  }) => (
    <div
      data-testid="runtime-provider"
      data-runtime-id={String(runtime?.id ?? "unknown")}
      data-has-tools={String(Boolean(config?.tools))}
      data-suggestions={String(config?.suggestions?.values?.length ?? 0)}
    >
      {children}
    </div>
  ),
  Tools: (options: unknown) => ({ kind: "tools", options }),
  Suggestions: (values: string[]) => ({ kind: "suggestions", values }),
  makeAssistantDataUI: ({ name }: { name: string }) => {
    const DataUI = () => <div data-testid="data-ui" data-name={name} />;
    return DataUI;
  },
  useAui: () => ({}),
  useAuiState: () => false,
}));

// The runtime factory: a fresh runtime per host, and the draft host's callback
// is captured so a test can drive the materialization binding deterministically.
const useAppChatRuntimeMock = mock(
  (
    _adapter: unknown,
    _threadId: string | undefined,
    onThreadIdChange: (id: string | undefined) => void,
  ) => {
    capturedOnThreadIdChange = onThreadIdChange;
    return { id: `runtime-${++runtimeCounter}` };
  },
);
const runtimeModule = () => ({ useAppChatRuntime: useAppChatRuntimeMock });
mock.module("@web/runtime", runtimeModule);
mock.module(pathToFileURL(path.join(REPO_ROOT, "web/src/runtime.ts")).href, runtimeModule);

// The adapter is a plain identity token here; no HTTP is ever issued.
const adapterModule = () => ({ threadListAdapter: { id: "thread-list-adapter" } });
mock.module("@web/app/adapter", adapterModule);
mock.module(pathToFileURL(path.join(REPO_ROOT, "web/src/app/adapter.ts")).href, adapterModule);

// Heavy leaf components become markers that expose the props the host passes.
const chatWindowModule = () => ({
  ChatWindow: ({ isDraft }: { isDraft?: boolean }) => (
    <div data-testid="chat-window" data-draft={String(Boolean(isDraft))} />
  ),
});
mock.module("@web/components/ChatWindow", chatWindowModule);
mock.module(
  pathToFileURL(path.join(REPO_ROOT, "web/src/components/ChatWindow.tsx")).href,
  chatWindowModule,
);

const chatHeaderModule = () => ({
  ChatHeader: ({ threadId }: { threadId: string }) => (
    <div data-testid="chat-header" data-thread-id={threadId} />
  ),
});
mock.module("@web/features/chat/components/ChatHeader", chatHeaderModule);
mock.module(
  pathToFileURL(path.join(REPO_ROOT, "web/src/features/chat/components/ChatHeader.tsx")).href,
  chatHeaderModule,
);

// The engine record is owned by materializeDraft; fake only the non-destructive
// peek so the draft host's engine choice is deterministic.
import * as realMaterializeDraft from "@web/features/chat/state/materializeDraft";
const materializeDraftModule = () => ({
  ...realMaterializeDraft,
  peekMaterializedEngine: () => fakeMaterializedEngine,
});
mock.module("@web/features/chat/state/materializeDraft", materializeDraftModule);
mock.module(
  pathToFileURL(path.join(REPO_ROOT, "web/src/features/chat/state/materializeDraft.ts")).href,
  materializeDraftModule,
);

const { DirectPanel } = await import("@web/features/workspace/components/DirectPanel");
const { DirectChatHost } = await import("@web/features/workspace/components/DirectChatHost");
const { DraftChatHost } = await import("@web/features/workspace/components/DraftChatHost");
const { panelRegistry } = await import("@web/features/workspace/panelRegistry");
const { useChatTabsStore } = await import("@web/features/chat/state/chatTabs");
const { useWelcomeEngineStore } = await import("@web/features/chat/state/welcomeEngine");
const { DIRECT_COMPACT_DATA_NAME } = await import("@web/features/chat/compactCommand");
const { parsePanelParams } = await import("@web/features/workspace/dockviewParams");
// Derive the panel prop type from the component so the test never imports
// dockview-react directly (it lives in web/node_modules, outside this project).
type PanelProps = import("react").ComponentProps<typeof DirectPanel>;

interface Mounted {
  container: HTMLElement;
  unmount(): void;
}
const mounted: Mounted[] = [];

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function mountElement(element: ReactNode): Mounted {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  act(() => root.render(element));
  const handle: Mounted = {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
  mounted.push(handle);
  return handle;
}

/** Mount a real DirectPanel with the minimal Dockview-owned prop bag it reads. */
async function mountPanel(tabKey: string, panelId: string): Promise<Mounted> {
  const params = parsePanelParams({ tabKey, contentType: "direct" });
  if (!params) throw new Error(`invalid test tab key: ${tabKey}`);
  // DirectPanel reads only `api.id`, `api.isVisible` and
  // `api.onDidVisibilityChange`; the rest of DockviewPanelApi/DockviewApi is
  // owned by Dockview and irrelevant to this component's behavior.
  const props = Object.assign({} as PanelProps, {
    params,
    api: {
      id: panelId,
      isVisible: true,
      onDidVisibilityChange: () => ({ dispose: () => {} }),
    },
    containerApi: {},
  });
  const handle = mountElement(<DirectPanel {...props} />);
  await settle();
  return handle;
}

function query(host: Mounted, testId: string): HTMLElement | null {
  return host.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function queryAll(host: Mounted, testId: string): HTMLElement[] {
  return Array.from(host.container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`));
}

const originalResolveDraftId = useChatTabsStore.getState().resolveDraftId;
const originalPresentChat = useChatTabsStore.getState().presentChat;

beforeEach(() => {
  capturedOnThreadIdChange = undefined;
  fakeMaterializedEngine = null;
  useChatTabsStore.setState({
    hasLocalDraft: false,
    localActiveKey: undefined,
    resolveDraftId: originalResolveDraftId,
    presentChat: originalPresentChat,
  });
  useWelcomeEngineStore.setState({ engine: "direct" });
});

afterEach(() => {
  for (const m of mounted) m.unmount();
  mounted.length = 0;
  for (const key of [...panelRegistry.claimed]) panelRegistry.release(key);
  useChatTabsStore.setState({
    hasLocalDraft: false,
    localActiveKey: undefined,
    resolveDraftId: originalResolveDraftId,
    presentChat: originalPresentChat,
  });
});

describe("Direct panel composition parity", () => {
  it("renders ChatHeader and ChatWindow inside one provider with tools, suggestions and data UIs", async () => {
    const panel = await mountPanel("chat:conv-A", "panel-A");

    const providers = queryAll(panel, "aui-provider");
    expect(providers).toHaveLength(1);
    // The outer boundary is isolation-only: an empty config, no scopes.
    expect(providers[0]?.getAttribute("data-has-tools")).toBe("false");
    expect(providers[0]?.getAttribute("data-suggestions")).toBe("0");

    const runtime = query(panel, "runtime-provider");
    expect(runtime).not.toBeNull();
    expect(providers[0]?.contains(runtime ?? null)).toBe(true);
    // The shared tools + suggestions config now lives on the runtime provider —
    // the one that installs the client scope `part.toolUI` reads.
    expect(runtime?.getAttribute("data-has-tools")).toBe("true");
    expect(runtime?.getAttribute("data-suggestions")).toBe("3");

    expect(query(panel, "chat-header")?.getAttribute("data-thread-id")).toBe("conv-A");
    expect(query(panel, "chat-window")?.getAttribute("data-draft")).toBe("false");

    const dataUiNames = queryAll(panel, "data-ui").map((n) => n.getAttribute("data-name"));
    expect(dataUiNames).toContain("tbai-progress");
    expect(dataUiNames).toContain(DIRECT_COMPACT_DATA_NAME);
  });

  it("gives two Direct hosts distinct runtimes and keeps their conversations separate", async () => {
    const a = mountElement(<DirectChatHost threadId="conv-A" />);
    const b = mountElement(<DirectChatHost threadId="conv-B" />);
    await settle();

    const aRuntime = query(a, "runtime-provider")?.getAttribute("data-runtime-id");
    const bRuntime = query(b, "runtime-provider")?.getAttribute("data-runtime-id");
    expect(aRuntime).toBeDefined();
    expect(bRuntime).toBeDefined();
    expect(aRuntime).not.toBe(bRuntime);

    expect(query(a, "chat-header")?.getAttribute("data-thread-id")).toBe("conv-A");
    expect(query(b, "chat-header")?.getAttribute("data-thread-id")).toBe("conv-B");
    // Each host owns exactly one provider subtree — no shared provider state.
    expect(queryAll(a, "aui-provider")).toHaveLength(1);
    expect(queryAll(b, "aui-provider")).toHaveLength(1);
  });

  it("refuses a second host for the same conversation", async () => {
    const first = await mountPanel("chat:conv-A", "panel-A");
    const second = await mountPanel("chat:conv-A", "panel-B");

    expect(queryAll(first, "runtime-provider")).toHaveLength(1);
    expect(queryAll(second, "runtime-provider")).toHaveLength(0);
    expect(second.container.textContent).toContain("already open in another panel");
  });
});

describe("Draft-aware Direct host", () => {
  it("binds the materialized id exactly once with the engine the owner recorded", async () => {
    useChatTabsStore.setState({ hasLocalDraft: true, localActiveKey: "chat:new" });
    fakeMaterializedEngine = "direct";
    const resolveSpy = mock((_id: string, _engine?: string) => {});
    useChatTabsStore.setState({ resolveDraftId: resolveSpy });

    const host = mountElement(<DraftChatHost />);
    await settle();
    expect(capturedOnThreadIdChange).toBeDefined();

    act(() => capturedOnThreadIdChange?.("new-conv-1"));

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith("new-conv-1", "direct");
    expect(query(host, "chat-window")?.getAttribute("data-draft")).toBe("true");
    expect(query(host, "chat-header")?.getAttribute("data-thread-id")).toBe("new");
  });

  it("falls back to the welcome engine when no materialized engine was recorded", async () => {
    useChatTabsStore.setState({ hasLocalDraft: true, localActiveKey: "chat:new" });
    fakeMaterializedEngine = null;
    useWelcomeEngineStore.setState({ engine: "opencode" });
    const resolveSpy = mock((_id: string, _engine?: string) => {});
    useChatTabsStore.setState({ resolveDraftId: resolveSpy });

    mountElement(<DraftChatHost />);
    await settle();
    act(() => capturedOnThreadIdChange?.("new-conv-2"));

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith("new-conv-2", "opencode");
  });

  it("presents the id as a normal chat when the active tab is not the draft", async () => {
    useChatTabsStore.setState({ hasLocalDraft: false, localActiveKey: "chat:conv-A" });
    const presentSpy = mock((_id: string) => {});
    const resolveSpy = mock((_id: string, _engine?: string) => {});
    useChatTabsStore.setState({ presentChat: presentSpy, resolveDraftId: resolveSpy });

    mountElement(<DraftChatHost />);
    await settle();
    act(() => capturedOnThreadIdChange?.("new-conv-3"));

    expect(presentSpy).toHaveBeenCalledTimes(1);
    expect(presentSpy).toHaveBeenCalledWith("new-conv-3");
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});
