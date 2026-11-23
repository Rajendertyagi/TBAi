/**
 * OpenCode panel integration — permanent DOM versions of the Dockview POC findings.
 *
 * Covers plan §6 tests 4, 5, 7 and 13:
 *  - route-independent identity: the session row and all four composer chips read
 *    `conversationId` from `OpenCodeRuntimeContext`, never from route params;
 *  - session bootstrap, recovery-epoch reconnect, first-prompt handoff and the
 *    permissions/questions/terminal/diff composition inside the host;
 *  - Direct + OpenCode hosts mounted together with distinct runtimes, contexts
 *    and activity keys (no assistant-ui context leakage).
 *
 * The REAL `OpenCodeChatHost`, `OpenCodePanel`, `OpenCodeSessionRow`, the four
 * chips and the real activity publisher are mounted in happy-dom. Only heavy
 * leaves (the native runtime client, bootstrap HTTP, assistant-ui primitives and
 * `ChatWindow`) are replaced with deterministic markers. No router is mounted:
 * a component that still called `useParams()` would throw here, which is exactly
 * the regression test 13 pins. Distinct conversation ids prove identity flows
 * from the host prop/context rather than any URL.
 *
 * What remains for Playwright E2E (Phase 4 / final gates): driving real
 * concurrent sends with distinct reply markers through a live backend, and
 * verifying a real Dockview move does not remount a host. Those need credentials
 * and a running managed OpenCode server, which this deterministic suite does not
 * have; the isolation invariants that do not need them are asserted below.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "../../helpers/repo-root";

// --- Captured seams -------------------------------------------------------
const bootstrapCalls: string[] = [];
const hydrateCalls: Array<{ sessionId: string; enabled: boolean }> = [];
const firstPromptRenders: Array<{
  conversationId: string;
  sessionId: string;
  sendWithId: unknown;
}> = [];
const directRuntimeCalls: string[] = [];
let reconnectCalls = 0;
let runtimeCounter = 0;
// Set from the real context module after mocks are registered. The capabilities
// mock reads it so each chip's catalogue is keyed by the context conversation id.
let readOpenCodeContext: (() => { conversationId: string } | null) | undefined;
let capturedAuiConfig: { tools?: { options?: { toolkit?: Record<string, unknown> } } } | undefined;

// --- assistant-ui primitives -> observable markers ------------------------
import * as realAssistantUI from "@assistant-ui/react";
mock.module("@assistant-ui/react", () => ({
  ...realAssistantUI,
  defineToolkit: (definition: unknown) => definition,
  AuiConfig: (config: unknown) => config,
  Tools: (options: unknown) => ({ kind: "tools", options }),
  AuiProvider: ({ children }: { children?: ReactNode }) => (
    <div data-testid="aui-provider">{children}</div>
  ),
  AssistantRuntimeProvider: ({
    runtime,
    config,
    children,
  }: {
    runtime: { id?: string };
    config?: { tools?: { options?: { toolkit?: Record<string, unknown> } } };
    children?: ReactNode;
  }) => {
    capturedAuiConfig = config;
    return (
      <div data-testid="runtime-provider" data-runtime-id={String(runtime?.id ?? "unknown")}>
        {children}
      </div>
    );
  },
}));

// `ChatWindow` is the seam through which the real Composer renders the OpenCode
// chips in agent mode. The marker reproduces that one contract: agent mode mounts
// the real `OpenCodeChipsAndRing`, chat mode does not. `ChipsRenderer` is assigned
// after the dynamic imports below so the mock factory never pulls web sources in
// before the other mocks are registered.
let ChipsRenderer: (() => ReactNode) | undefined;
const chatWindowModule = () => ({
  ChatWindow: ({
    mode,
    composerExtras,
  }: {
    mode?: "chat" | "agent";
    composerExtras?: { interactive?: ReactNode; status?: ReactNode; below?: ReactNode };
  }) => (
    <div data-testid="chat-window" data-mode={mode ?? "chat"}>
      {mode === "agent" && ChipsRenderer ? <ChipsRenderer /> : null}
      {composerExtras?.interactive}
      {composerExtras?.status}
      {composerExtras?.below}
    </div>
  ),
});
mock.module("@web/components/ChatWindow", chatWindowModule);
mock.module(
  pathToFileURL(path.join(REPO_ROOT, "web/src/components/ChatWindow.tsx")).href,
  chatWindowModule,
);

// --- OpenCode host leaves -------------------------------------------------
const realBootstrap = await import("@web/features/opencode/sessionBootstrap");
mock.module("@web/features/opencode/sessionBootstrap", () => ({
  ...realBootstrap,
  bootstrapOpenCodeSession: (conversationId: string) => {
    bootstrapCalls.push(conversationId);
    return Promise.resolve({
      sessionId: `session-${conversationId}`,
      directory: `/work/${conversationId}`,
      reusedExistingSession: false,
    });
  },
}));

const realRuntime = await import("@web/features/opencode/useOpenCodeRuntime");
mock.module("@web/features/opencode/useOpenCodeRuntime", () => ({
  ...realRuntime,
  useOpenCodeRuntime: (_sessionId: string, conversationId: string) => {
    const controller = {
      compact: async () => {},
      setDesiredSelection: () => {},
      reconcileStagedRevert: async () => {},
      sendMessage: async () => {},
      reconcileAutoApprove: async () => 0,
    };
    return {
      runtime: { id: `oc-runtime-${conversationId}-${++runtimeCounter}` },
      reconnect: () => {
        reconnectCalls += 1;
      },
      reconcileAutoApprove: controller.reconcileAutoApprove,
      controller,
    };
  },
}));

// Replace only the live catalogue hook so the Thinking chip has variants and
// therefore renders. `buildOpenCodeThinkingOptions` is a two-line pure helper
// (Default + one entry per variant); it is mirrored here so the mock never
// re-enters the real module through a re-export cycle.
const realCapabilities = await import("@web/features/opencode/useOpenCodeCapabilities");
mock.module("@web/features/opencode/useOpenCodeCapabilities", () => ({
  ...realCapabilities,
  useOpenCodeCapabilities: () => {
    // Inside the chips this hook renders under the host's context provider, so
    // the catalogue is keyed by the conversation id read from context. The
    // host's own call sits outside the provider and falls back to "default".
    const conversationId = readOpenCodeContext?.()?.conversationId ?? "default";
    return {
      agents: [{ id: `agent-${conversationId}`, name: `Agent ${conversationId}` }],
      models: [
        {
          id: `model-${conversationId}`,
          name: `Model ${conversationId}`,
          providerID: "provider-x",
          variants: ["high", "low"],
        },
      ],
      defaultModel: { providerID: "provider-x", modelID: `model-${conversationId}` },
      isLoading: false,
      error: null,
    };
  },
  buildOpenCodeThinkingOptions: (
    model: { variants: string[] } | null | undefined,
  ): Array<{ id: string; label: string }> =>
    !model || model.variants.length === 0
      ? []
      : [{ id: "", label: "Default" }, ...model.variants.map((v) => ({ id: v, label: v }))],
}));

// Config is keyed by the id the component read from context, so a wrong identity
// would surface as a wrong chip label.
const realConfig = await import("@web/features/opencode/useOpenCodeConversationConfig");
mock.module("@web/features/opencode/useOpenCodeConversationConfig", () => ({
  ...realConfig,
  useOpenCodeConversationConfig: (conversationId: string | undefined) =>
    conversationId
      ? {
          opencodeAgent: `agent-${conversationId}`,
          opencodeModel: `provider-x/model-${conversationId}`,
          opencodeVariant: `chip-variant-${conversationId}`,
          // Distinct shield state per conversation proves the Shield chip also
          // reads the context id (on for A, off for B).
          opencodeAutoApprove: conversationId === "oc-conv-a",
        }
      : null,
}));

const realResolveModel = await import("@web/features/opencode/resolveOpenCodeModel");
mock.module("@web/features/opencode/resolveOpenCodeModel", () => ({
  ...realResolveModel,
  useResolvedOpenCodeModel: () => ({
    providerID: "provider-x",
    modelID: "model-x",
    variants: ["high", "low"],
  }),
}));

const realAutoPolicy = await import("@web/features/opencode/sessionAutoPolicy");
mock.module("@web/features/opencode/sessionAutoPolicy", () => ({
  ...realAutoPolicy,
  hydrateAutoPolicy: (sessionId: string, enabled: boolean) => {
    hydrateCalls.push({ sessionId, enabled });
  },
}));

// A running projection lets the REAL publisher publish under the host's
// conversation id, so the activity key is asserted against real code.
const realExtras = await import("@web/features/opencode/v2RuntimeExtras");
mock.module("@web/features/opencode/v2RuntimeExtras", () => ({
  ...realExtras,
  useOptionalV2RuntimeExtras: () => ({
    projection: {
      hasActiveSessionWork: true,
      pendingLifecycle: { cancellationPending: false },
      health: { degraded: false },
      lastOutcome: {
        outcome: "none",
        attribution: "unattributed",
        binding: { kind: "unbound" },
        evidence: {
          serverEventId: null,
          durableAggregateId: null,
          durableSeq: null,
          durableVersion: null,
        },
      },
    },
  }),
}));

// Session-row identity is keyed by the id the row read from context.
const realExistence = await import("@web/features/chat/state/conversationExistence");
mock.module("@web/features/chat/state/conversationExistence", () => ({
  ...realExistence,
  probeConversation: (id: string) =>
    Promise.resolve({
      status: "exists",
      data: {
        id,
        title: `Conversation ${id}`,
        status: "ready",
        engine: "opencode",
        workspaceMode: "simple",
        workspaceFolderId: null,
        opencodeAgent: `row-agent-${id}`,
        opencodeModel: `row-model-${id}`,
        opencodeVariant: null,
        opencodeAutoApprove: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    }),
}));

const realFolders = await import("@web/features/folders/state/foldersStore");
mock.module("@web/features/folders/state/foldersStore", () => ({
  ...realFolders,
  useFoldersStore: (
    selector: (state: { folders: unknown[]; loadFolders: () => void }) => unknown,
  ) => selector({ folders: [], loadFolders: () => {} }),
}));

// --- Presence markers for the agent-mode extras ---------------------------
mock.module("@web/components/DevToolsGate", () => ({
  DevToolsGate: () => <div data-testid="devtools-gate" />,
}));
mock.module("@web/features/opencode/OpenCodePermissions", () => ({
  OpenCodePermissions: () => <div data-testid="oc-permissions" />,
}));
mock.module("@web/features/opencode/OpenCodeQuestions", () => ({
  OpenCodeQuestions: () => <div data-testid="oc-questions" />,
}));
mock.module("@web/features/opencode/OpenCodeStatus", () => ({
  OpenCodeStatus: () => <div data-testid="oc-status" />,
}));
mock.module("@web/features/opencode/OpenCodeRecoveryNotice", () => ({
  OpenCodeRecoveryNotice: () => <div data-testid="oc-recovery-notice" />,
}));
mock.module("@web/features/opencode/OpenCodePrimaryStatus", () => ({
  OpenCodePrimaryStatus: () => <div data-testid="oc-primary-status" />,
}));
mock.module("@web/features/opencode/OpenCodeLifecycleNotice", () => ({
  OpenCodeLifecycleNotice: () => <div data-testid="oc-lifecycle-notice" />,
}));
// The context ring is not one of the four identity chips under test; it needs a
// richer native-state shape than this harness supplies, so it is a marker here.
mock.module("@web/features/opencode/OpenCodeContextRing", () => ({
  OpenCodeContextRing: () => <div data-testid="oc-context-ring" />,
}));

const realHandoff = await import("@web/features/opencode/FirstPromptHandoff");
mock.module("@web/features/opencode/FirstPromptHandoff", () => ({
  ...realHandoff,
  FirstPromptHandoff: ({
    conversationId,
    sessionId,
    sendWithId,
  }: {
    conversationId: string;
    sessionId: string;
    sendWithId: unknown;
  }) => {
    firstPromptRenders.push({ conversationId, sessionId, sendWithId });
    return (
      <div
        data-testid="oc-first-prompt"
        data-conversation-id={conversationId}
        data-session-id={sessionId}
      />
    );
  },
}));

// --- Direct host leaves (for the mixed-runtime isolation test) ------------
mock.module("@web/runtime", () => ({
  useAppChatRuntime: (_adapter: unknown, threadId: string | undefined) => {
    directRuntimeCalls.push(String(threadId));
    return { id: `direct-runtime-${threadId}-${++runtimeCounter}` };
  },
}));
mock.module("@web/app/adapter", () => ({
  threadListAdapter: { id: "thread-list-adapter" },
}));
mock.module("@web/features/chat/components/ChatHeader", () => ({
  ChatHeader: ({ threadId }: { threadId: string }) => (
    <div data-testid="chat-header" data-thread-id={threadId} />
  ),
}));
mock.module("@web/features/workspace/components/directHost", () => ({
  DirectHostProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DirectDataUIs: () => <div data-testid="direct-data-uis" />,
}));

// --- Real modules under test (imported only after every mock is registered) -
const realContext = await import("@web/features/opencode/opencodeRuntimeContext");
readOpenCodeContext = realContext.useOpenCodeRuntimeContext;

const { OpenCodeChatHost } = await import("@web/features/opencode/OpenCodeChatHost");
const { OpenCodeChipsAndRing } = await import("@web/features/opencode/OpenCodeChipsAndRing");
const { OpenCodePanel } = await import("@web/features/workspace/components/OpenCodePanel");
const { DirectChatHost } = await import("@web/features/workspace/components/DirectChatHost");
const { parsePanelParams } = await import("@web/features/workspace/dockviewParams");
const { useConversationActivityStore } = await import(
  "@web/features/chat/state/conversationActivity"
);
const { useAvailabilityStore } = await import("@web/features/availability/availabilityStore");
const { panelRegistry } = await import("@web/features/workspace/panelRegistry");

ChipsRenderer = OpenCodeChipsAndRing;

type PanelProps = import("react").ComponentProps<typeof OpenCodePanel>;

// --- Mount helpers --------------------------------------------------------
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

/** Mount a real OpenCodePanel with the minimal Dockview-owned prop bag it reads. */
async function mountPanel(tabKey: string, panelId: string): Promise<Mounted> {
  const params = parsePanelParams({ tabKey, contentType: "opencode" });
  if (!params) throw new Error(`invalid test tab key: ${tabKey}`);
  const props = Object.assign({} as PanelProps, {
    params,
    api: {
      id: panelId,
      isVisible: true,
      onDidVisibilityChange: () => ({ dispose: () => {} }),
    },
    containerApi: {},
  });
  const handle = mountElement(<OpenCodePanel {...props} />);
  await settle();
  return handle;
}

function query(host: Mounted, testId: string): HTMLElement | null {
  return host.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}
function queryAll(host: Mounted, testId: string): HTMLElement[] {
  return Array.from(host.container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`));
}
function chipByLabel(host: Mounted, label: string): HTMLElement | null {
  return host.container.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
}

const originalRecoveryEpoch = useAvailabilityStore.getState().recoveryEpoch;

beforeEach(() => {
  bootstrapCalls.length = 0;
  hydrateCalls.length = 0;
  firstPromptRenders.length = 0;
  directRuntimeCalls.length = 0;
  reconnectCalls = 0;
  runtimeCounter = 0;
  capturedAuiConfig = undefined;
  useAvailabilityStore.setState({ recoveryEpoch: originalRecoveryEpoch });
  for (const id of ["oc-conv-a", "oc-conv-b", "direct-conv"]) {
    useConversationActivityStore.getState().clear(id);
  }
});

afterEach(() => {
  for (const m of mounted) m.unmount();
  mounted.length = 0;
  for (const key of [...panelRegistry.claimed]) panelRegistry.release(key);
  useAvailabilityStore.setState({ recoveryEpoch: originalRecoveryEpoch });
});

// ---------------------------------------------------------------------------
describe("OpenCode panel — route-independent identity (plan §6 test 13)", () => {
  it("renders the session row and all four chips from context with no router mounted", async () => {
    const host = mountElement(<OpenCodeChatHost conversationId="oc-conv-a" />);
    await settle();

    // No router exists in this harness. A component still calling useParams()
    // would throw, so a successful render proves route independence.
    expect(query(host, "chat-window")?.getAttribute("data-mode")).toBe("agent");

    // Session row identity comes from probeConversation(context.conversationId).
    expect(host.container.textContent).toContain("row-agent-oc-conv-a");
    expect(host.container.textContent).toContain("row-model-oc-conv-a");

    // All four chips are present, and each shows data keyed by the context
    // conversation id (not a route param, not the other host's id).
    expect(chipByLabel(host, "Agent")?.textContent).toContain("Agent oc-conv-a");
    expect(chipByLabel(host, "Model")?.textContent).toContain("Model oc-conv-a");
    expect(chipByLabel(host, "Thinking level")).not.toBeNull();
    expect(chipByLabel(host, "Auto-approve permissions: on")).not.toBeNull();
  });

  it("uses distinct context identities for two hosts with distinct conversation ids", async () => {
    const a = mountElement(<OpenCodeChatHost conversationId="oc-conv-a" />);
    const b = mountElement(<OpenCodeChatHost conversationId="oc-conv-b" />);
    await settle();

    expect(a.container.textContent).toContain("row-agent-oc-conv-a");
    expect(a.container.textContent).not.toContain("row-agent-oc-conv-b");
    expect(chipByLabel(a, "Agent")?.textContent).toContain("Agent oc-conv-a");
    expect(chipByLabel(a, "Model")?.textContent).toContain("Model oc-conv-a");
    expect(chipByLabel(a, "Auto-approve permissions: on")).not.toBeNull();

    expect(b.container.textContent).toContain("row-agent-oc-conv-b");
    expect(b.container.textContent).not.toContain("row-agent-oc-conv-a");
    expect(chipByLabel(b, "Agent")?.textContent).toContain("Agent oc-conv-b");
    expect(chipByLabel(b, "Model")?.textContent).toContain("Model oc-conv-b");
    expect(chipByLabel(b, "Auto-approve permissions: off")).not.toBeNull();

    // Each host bootstrapped its own conversation and owns a distinct runtime.
    expect(bootstrapCalls).toContain("oc-conv-a");
    expect(bootstrapCalls).toContain("oc-conv-b");
    const aRuntime = query(a, "runtime-provider")?.getAttribute("data-runtime-id");
    const bRuntime = query(b, "runtime-provider")?.getAttribute("data-runtime-id");
    expect(aRuntime).not.toBe(bRuntime);
  });
});

// ---------------------------------------------------------------------------
describe("OpenCode panel — lifecycle preserved inside the host (plan §6 tests 4, 5, 7)", () => {
  it("bootstraps the session from the panel's canonical agent:<ref> id", async () => {
    const panel = await mountPanel("agent:oc-conv-a", "panel-oc-a");

    expect(bootstrapCalls).toEqual(["oc-conv-a"]);
    expect(query(panel, "dockview-opencode-panel")?.getAttribute("data-conversation-id")).toBe(
      "oc-conv-a",
    );
    expect(query(panel, "runtime-provider")).not.toBeNull();
  });

  it("reconnects exactly once per recovery-epoch change, never on mount or re-render", async () => {
    mountElement(<OpenCodeChatHost conversationId="oc-conv-a" />);
    await settle();

    // Mount with epoch 0 records the seen epoch but never reconnects.
    expect(reconnectCalls).toBe(0);

    act(() => useAvailabilityStore.setState({ recoveryEpoch: originalRecoveryEpoch + 1 }));
    await settle();
    expect(reconnectCalls).toBe(1);

    // An unchanged epoch on re-render must not reconnect again.
    act(() => useAvailabilityStore.setState({ recoveryEpoch: originalRecoveryEpoch + 1 }));
    await settle();
    expect(reconnectCalls).toBe(1);

    act(() => useAvailabilityStore.setState({ recoveryEpoch: originalRecoveryEpoch + 2 }));
    await settle();
    expect(reconnectCalls).toBe(2);
  });

  it("hands the first prompt the host's conversation and bootstrapped session id", async () => {
    const host = mountElement(<OpenCodeChatHost conversationId="oc-conv-a" />);
    await settle();

    expect(firstPromptRenders).toHaveLength(1);
    expect(firstPromptRenders[0]?.conversationId).toBe("oc-conv-a");
    expect(firstPromptRenders[0]?.sessionId).toBe("session-oc-conv-a");
    expect(query(host, "oc-first-prompt")?.getAttribute("data-session-id")).toBe(
      "session-oc-conv-a",
    );
  });

  it("hydrates the per-conversation auto-approval policy from the same session", async () => {
    mountElement(<OpenCodeChatHost conversationId="oc-conv-a" />);
    await settle();

    expect(hydrateCalls).toEqual([{ sessionId: "session-oc-conv-a", enabled: true }]);
  });

  it("keeps permissions, questions, status, DevTools and the terminal/diff toolkit", async () => {
    const host = mountElement(<OpenCodeChatHost conversationId="oc-conv-a" />);
    await settle();

    expect(query(host, "oc-permissions")).not.toBeNull();
    expect(query(host, "oc-questions")).not.toBeNull();
    expect(query(host, "oc-status")).not.toBeNull();
    expect(query(host, "oc-primary-status")).not.toBeNull();
    expect(query(host, "oc-recovery-notice")).not.toBeNull();
    expect(query(host, "oc-lifecycle-notice")).not.toBeNull();
    expect(query(host, "devtools-gate")).not.toBeNull();
    expect(query(host, "aui-provider")).not.toBeNull(); // OpenCodeIsolationBoundary

    // Terminal (`run_command`) and diff (`edit`/`patch`) renderers are registered
    // through the host's own AuiConfig — not inherited from a root provider.
    const toolkit = capturedAuiConfig?.tools?.options?.toolkit;
    expect(toolkit).toBeDefined();
    expect(Object.keys(toolkit ?? {})).toContain("run_command");
    expect(Object.keys(toolkit ?? {})).toContain("edit");
    expect(Object.keys(toolkit ?? {})).toContain("patch");
  });
});

// ---------------------------------------------------------------------------
describe("OpenCode isolation boundary (plan §1 / AGENTS.md)", () => {
  it("lets only OpenCodePanel reach the opencode feature, through the public host", async () => {
    const panelSource = await Bun.file(
      path.join(REPO_ROOT, "web/src/features/workspace/components/OpenCodePanel.tsx"),
    ).text();

    // The panel's single opencode import is the public host — no internals.
    expect(panelSource).toContain(
      'import { OpenCodeChatHost } from "../../opencode/OpenCodeChatHost";',
    );
    expect(panelSource).not.toContain("opencodeRuntimeContext");
    expect(panelSource).not.toContain("useOpenCodeRuntime");
    expect(panelSource).not.toContain("sessionBootstrap");
    expect(panelSource).not.toContain("@opencode/client");

    // Generic Dockview infrastructure never imports opencode code.
    const genericInfra = [
      "web/src/features/workspace/dockviewParams.ts",
      "web/src/features/workspace/panelRegistry.ts",
      "web/src/features/workspace/dockviewController.ts",
      "web/src/features/workspace/state/layoutPersistence.ts",
      "web/src/features/workspace/components/DockviewWorkspace.tsx",
      "web/src/features/workspace/components/usePanelVisibility.ts",
      "web/src/features/workspace/components/usePanelMountClaim.ts",
      "web/src/features/workspace/components/DirectPanel.tsx",
      "web/src/features/workspace/components/DirectChatHost.tsx",
      "web/src/features/workspace/components/directHost.tsx",
      "web/src/features/workspace/components/DraftChatHost.tsx",
    ];
    for (const relative of genericInfra) {
      const source = await Bun.file(path.join(REPO_ROOT, relative)).text();
      expect(source).not.toContain("features/opencode");
      expect(source).not.toContain("../opencode/");
      expect(source).not.toContain("@opencode/client");
    }
  });
});

describe("Mixed-runtime isolation (plan §6 tests 4, 7)", () => {
  it("mounts Direct and OpenCode hosts together with distinct runtimes, contexts and activity keys", async () => {
    const direct = mountElement(<DirectChatHost threadId="direct-conv" />);
    const openCode = mountElement(<OpenCodeChatHost conversationId="oc-conv-a" />);
    await settle();

    // Distinct assistant-ui runtime instances — no shared provider/context.
    const directRuntime = query(direct, "runtime-provider")?.getAttribute("data-runtime-id");
    const ocRuntime = query(openCode, "runtime-provider")?.getAttribute("data-runtime-id");
    expect(directRuntime).toBeDefined();
    expect(ocRuntime).toBeDefined();
    expect(directRuntime).not.toBe(ocRuntime);
    expect(queryAll(direct, "runtime-provider")).toHaveLength(1);
    expect(queryAll(openCode, "runtime-provider")).toHaveLength(1);

    // Each host keeps its own identity: Direct has no OpenCode chips, OpenCode
    // has no Direct header, and each composer renders in its own mode.
    expect(query(direct, "chat-window")?.getAttribute("data-mode")).toBe("chat");
    expect(query(openCode, "chat-window")?.getAttribute("data-mode")).toBe("agent");
    expect(query(direct, "chat-header")?.getAttribute("data-thread-id")).toBe("direct-conv");
    expect(query(openCode, "chat-header")).toBeNull();
    expect(chipByLabel(openCode, "Model")?.textContent).toContain("Model oc-conv-a");
    expect(chipByLabel(direct, "Model")).toBeNull();

    // The real OpenCode publisher keys activity by its own conversation id only.
    expect(useConversationActivityStore.getState().get("oc-conv-a")?.execution).toBe("running");
    expect(useConversationActivityStore.getState().get("direct-conv")).toBeUndefined();

    // Each host's first-prompt send seam is a distinct function bound to its own
    // session; a send on one cannot be routed through the other's controller.
    expect(firstPromptRenders).toHaveLength(1);
    expect(firstPromptRenders[0]?.conversationId).toBe("oc-conv-a");
    expect(directRuntimeCalls).toEqual(["direct-conv"]);
  });
});
