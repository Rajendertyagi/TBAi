/**
 * Phase E — OpenCodeChatHost activation gate.
 *
 * A Dockview panel mounts the host as soon as it is created, but its expensive
 * runtime (session bootstrap, capabilities/config/model reads, native runtime)
 * must not start until the panel is first activated. This suite drives the
 * REAL `OpenCodeChatHost` in happy-dom with deterministic leaf seams so it can
 * assert both halves of the contract:
 *  - a dormant host runs NO OpenCode hooks/effects and exposes a DOM-identifiable
 *    placeholder (the seam E2E uses to prove no runtime requests are issued);
 *  - an activated host mounts the full runtime exactly as before;
 *  - the gate is one-way — a true value latches for the life of the panel.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "../../helpers/repo-root";

const fileUrl = (relative: string): string => pathToFileURL(path.join(REPO_ROOT, relative)).href;

// --- Captured seams -------------------------------------------------------
const bootstrapCalls: string[] = [];
const configCalls: string[] = [];
const capabilityCalls: number[] = [];
const modelCalls: number[] = [];
const runtimeCalls: string[] = [];
let hydrateCalls = 0;

// --- assistant-ui primitives -> observable markers ------------------------
import * as realAssistantUI from "@assistant-ui/react";
mock.module("@assistant-ui/react", () => ({
  ...realAssistantUI,
  AuiConfig: (config: unknown) => config,
  Tools: (options: unknown) => ({ kind: "tools", options }),
  AssistantRuntimeProvider: ({ children }: { children?: ReactNode }) => (
    <div data-testid="oc-runtime-provider">{children}</div>
  ),
}));

// `ChatWindow` and `DevToolsGate` are imported through the `@/` alias, which
// bun resolves to the file path. Mock both the `@web/` specifier and the file
// URL so the factory never pulls the real (context-dependent) modules in.
const chatWindowModule = () => ({
  ChatWindow: ({ mode }: { mode?: string }) => (
    <div data-testid="oc-chat-window" data-mode={mode ?? "chat"} />
  ),
});
mock.module("@web/components/ChatWindow", chatWindowModule);
mock.module(fileUrl("web/src/components/ChatWindow.tsx"), chatWindowModule);

const devToolsModule = () => ({ DevToolsGate: () => <div data-testid="oc-devtools" /> });
mock.module("@web/components/DevToolsGate", devToolsModule);
mock.module(fileUrl("web/src/components/DevToolsGate.tsx"), devToolsModule);

// --- Expensive hooks / bootstrap ------------------------------------------
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

const realConfig = await import("@web/features/opencode/useOpenCodeConversationConfig");
mock.module("@web/features/opencode/useOpenCodeConversationConfig", () => ({
  ...realConfig,
  useOpenCodeConversationConfig: (conversationId: string | undefined) => {
    configCalls.push(String(conversationId));
    return conversationId
      ? {
          // Complete config shape (Phase F): identity fields are neutral here —
          // this suite asserts activation, not config values.
          engine: "opencode" as const,
          workspaceMode: "simple" as const,
          workspaceFolderId: null,
          opencodeAgent: `agent-${conversationId}`,
          opencodeModel: `provider/model-${conversationId}`,
          opencodeVariant: null,
          opencodeAutoApprove: false,
        }
      : null;
  },
}));

const realCapabilities = await import("@web/features/opencode/useOpenCodeCapabilities");
mock.module("@web/features/opencode/useOpenCodeCapabilities", () => ({
  ...realCapabilities,
  useOpenCodeCapabilities: () => {
    capabilityCalls.push(1);
    return { models: [], defaultModel: undefined, isLoading: false, error: null };
  },
}));

const realResolve = await import("@web/features/opencode/resolveOpenCodeModel");
mock.module("@web/features/opencode/resolveOpenCodeModel", () => ({
  ...realResolve,
  useResolvedOpenCodeModel: () => {
    modelCalls.push(1);
    return undefined;
  },
}));

const realRuntime = await import("@web/features/opencode/useOpenCodeRuntime");
mock.module("@web/features/opencode/useOpenCodeRuntime", () => ({
  ...realRuntime,
  useOpenCodeRuntime: (_sessionId: string, conversationId: string) => {
    runtimeCalls.push(conversationId);
    const controller = {
      compact: async () => {},
      setDesiredSelection: () => {},
      reconcileStagedRevert: async () => {},
      sendMessage: async () => {},
      reconcileAutoApprove: async () => 0,
    };
    return {
      runtime: { id: `oc-runtime-${conversationId}` },
      reconnect: () => {},
      reconcileAutoApprove: controller.reconcileAutoApprove,
      controller,
    };
  },
}));

const realAutoPolicy = await import("@web/features/opencode/sessionAutoPolicy");
mock.module("@web/features/opencode/sessionAutoPolicy", () => ({
  ...realAutoPolicy,
  hydrateAutoPolicy: () => {
    hydrateCalls += 1;
  },
}));

// --- Presence markers for the activated subtree ---------------------------
mock.module("@web/features/opencode/OpenCodeIsolationBoundary", () => ({
  OpenCodeIsolationBoundary: ({ children }: { children?: ReactNode }) => (
    <div data-testid="oc-isolation">{children}</div>
  ),
}));
mock.module("@web/features/opencode/OpenCodeActivityPublisher", () => ({
  OpenCodeActivityPublisher: () => <div data-testid="oc-activity" />,
}));
mock.module("@web/features/opencode/FirstPromptHandoff", () => ({
  FirstPromptHandoff: () => <div data-testid="oc-first-prompt" />,
}));
mock.module("@web/features/opencode/OpenCodeSessionRow", () => ({
  OpenCodeSessionRow: () => <div data-testid="oc-session-row" />,
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
  OpenCodeRecoveryNotice: () => <div data-testid="oc-recovery" />,
}));
mock.module("@web/features/opencode/OpenCodePrimaryStatus", () => ({
  OpenCodePrimaryStatus: () => <div data-testid="oc-primary" />,
}));
mock.module("@web/features/opencode/OpenCodeLifecycleNotice", () => ({
  OpenCodeLifecycleNotice: () => <div data-testid="oc-lifecycle" />,
}));

// --- Real module under test (imported only after every mock is registered) -
const { OpenCodeChatHost } = await import("@web/features/opencode/OpenCodeChatHost");

// --- Mount helpers --------------------------------------------------------
interface Mounted {
  container: HTMLElement;
  render(element: ReactNode): void;
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
    render(next) {
      act(() => root.render(next));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
  mounted.push(handle);
  return handle;
}

function query(host: Mounted, testId: string): HTMLElement | null {
  return host.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

beforeEach(() => {
  bootstrapCalls.length = 0;
  configCalls.length = 0;
  capabilityCalls.length = 0;
  modelCalls.length = 0;
  runtimeCalls.length = 0;
  hydrateCalls = 0;
});

afterEach(() => {
  for (const m of mounted) m.unmount();
  mounted.length = 0;
});

describe("OpenCodeChatHost activation gate (Phase E)", () => {
  it("renders a dormant placeholder and runs no OpenCode hooks when activated=false", async () => {
    const host = mountElement(<OpenCodeChatHost conversationId="oc-dormant" activated={false} />);
    await settle();

    const placeholder = query(host, "opencode-dormant-panel");
    expect(placeholder).not.toBeNull();
    expect(placeholder?.getAttribute("data-conversation-id")).toBe("oc-dormant");

    // No expensive hooks/effects ran — the placeholder is genuinely inert.
    expect(bootstrapCalls).toEqual([]);
    expect(configCalls).toEqual([]);
    expect(capabilityCalls).toEqual([]);
    expect(modelCalls).toEqual([]);
    expect(runtimeCalls).toEqual([]);
    expect(hydrateCalls).toBe(0);

    // No runtime markers in the DOM.
    expect(query(host, "oc-runtime-provider")).toBeNull();
    expect(query(host, "oc-chat-window")).toBeNull();
    expect(query(host, "oc-isolation")).toBeNull();
  });

  it("mounts the full host when activated=true", async () => {
    const host = mountElement(<OpenCodeChatHost conversationId="oc-active" activated={true} />);
    await settle();

    expect(query(host, "opencode-dormant-panel")).toBeNull();
    expect(bootstrapCalls).toEqual(["oc-active"]);
    expect(runtimeCalls).toEqual(["oc-active"]);
    expect(query(host, "oc-runtime-provider")).not.toBeNull();
    expect(query(host, "oc-chat-window")?.getAttribute("data-mode")).toBe("agent");
    expect(query(host, "oc-isolation")).not.toBeNull();
  });

  it("mounts the full host by default (direct mounts stay activated)", async () => {
    const host = mountElement(<OpenCodeChatHost conversationId="oc-default" />);
    await settle();

    expect(query(host, "opencode-dormant-panel")).toBeNull();
    expect(bootstrapCalls).toEqual(["oc-default"]);
    expect(query(host, "oc-runtime-provider")).not.toBeNull();
  });

  it("latches activation: false→true mounts the subtree and a later false keeps it mounted", async () => {
    const host = mountElement(<OpenCodeChatHost conversationId="oc-latch" activated={false} />);
    await settle();

    expect(query(host, "opencode-dormant-panel")).not.toBeNull();
    expect(bootstrapCalls).toEqual([]);

    host.render(<OpenCodeChatHost conversationId="oc-latch" activated={true} />);
    await settle();

    expect(query(host, "opencode-dormant-panel")).toBeNull();
    expect(bootstrapCalls).toEqual(["oc-latch"]);
    expect(query(host, "oc-runtime-provider")).not.toBeNull();

    // One-way gate: flipping back to false must NOT unmount the runtime.
    host.render(<OpenCodeChatHost conversationId="oc-latch" activated={false} />);
    await settle();

    expect(query(host, "opencode-dormant-panel")).toBeNull();
    expect(query(host, "oc-runtime-provider")).not.toBeNull();
    // No second bootstrap across the re-renders.
    expect(bootstrapCalls).toEqual(["oc-latch"]);
  });
});
