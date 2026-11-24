/**
 * Phase F — conversation config distribution through OpenCodeRuntimeContext.
 *
 * The activated host fetches the conversation config ONCE; the AgentRuntime,
 * the three composer chips, the Shield chip and the session row all read that
 * one value from context. This suite drives the REAL `OpenCodeChatHost` and the
 * REAL `useOpenCodeConversationConfig` hook in happy-dom, with only heavy leaves
 * (native runtime, bootstrap, assistant-ui primitives, catalogue) replaced by
 * deterministic seams. It proves:
 *  - one conversation read per activated host even with chips + Shield + row
 *    mounted (the regression this phase removes);
 *  - a confirmed chip write (`updateConversationConfig`) reaches every consumer
 *    through the host's override subscription;
 *  - a backend-recovery epoch change re-reads authoritative config;
 *  - `opencodeAutoApprove` reaches both the Shield chip and auto-policy hydration.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "../../helpers/repo-root";

const fileUrl = (relative: string): string => pathToFileURL(path.join(REPO_ROOT, relative)).href;

// --- Captured seams -------------------------------------------------------
const probeCalls: string[] = [];
const hydrateCalls: Array<{ sessionId: string; enabled: boolean }> = [];
let probeAutoApprove = false;
let probeAgent = "agent-from-server";
let probeModel = "p/model-from-server";

function probeRow(id: string) {
  return {
    id,
    title: `Conversation ${id}`,
    status: "ready",
    engine: "opencode" as const,
    workspaceMode: "simple" as const,
    workspaceFolderId: null,
    opencodeAgent: probeAgent,
    opencodeModel: probeModel,
    opencodeVariant: "low",
    opencodeAutoApprove: probeAutoApprove,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

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

// ChatWindow is the seam through which the real Composer mounts the OpenCode
// chip row in agent mode. `ChipsRenderer` is assigned after the imports below.
let ChipsRenderer: (() => ReactNode) | undefined;
const chatWindowModule = () => ({
  ChatWindow: ({ mode }: { mode?: string }) => (
    <div data-testid="oc-chat-window" data-mode={mode ?? "chat"}>
      {mode === "agent" && ChipsRenderer ? <ChipsRenderer /> : null}
    </div>
  ),
});
mock.module("@web/components/ChatWindow", chatWindowModule);
mock.module(fileUrl("web/src/components/ChatWindow.tsx"), chatWindowModule);

const devToolsModule = () => ({ DevToolsGate: () => <div data-testid="oc-devtools" /> });
mock.module("@web/components/DevToolsGate", devToolsModule);
mock.module(fileUrl("web/src/components/DevToolsGate.tsx"), devToolsModule);

// --- Heavy leaves ---------------------------------------------------------
const realBootstrap = await import("@web/features/opencode/sessionBootstrap");
mock.module("@web/features/opencode/sessionBootstrap", () => ({
  ...realBootstrap,
  bootstrapOpenCodeSession: (conversationId: string) =>
    Promise.resolve({
      sessionId: `session-${conversationId}`,
      directory: `/work/${conversationId}`,
      reusedExistingSession: false,
    }),
}));

// Stable controller so `reconcileAutoApprove` does not change identity on every
// render — the auto-policy effect then fires only when config actually changes.
const controller = {
  compact: async () => {},
  setDesiredSelection: () => {},
  reconcileStagedRevert: async () => {},
  sendMessage: async () => {},
  reconcileAutoApprove: async () => 0,
};
const realRuntime = await import("@web/features/opencode/useOpenCodeRuntime");
mock.module("@web/features/opencode/useOpenCodeRuntime", () => ({
  ...realRuntime,
  useOpenCodeRuntime: (_sessionId: string, conversationId: string) => ({
    runtime: { id: `oc-runtime-${conversationId}` },
    reconnect: () => {},
    reconcileAutoApprove: controller.reconcileAutoApprove,
    controller,
  }),
}));

const realCapabilities = await import("@web/features/opencode/useOpenCodeCapabilities");
mock.module("@web/features/opencode/useOpenCodeCapabilities", () => ({
  ...realCapabilities,
  useOpenCodeCapabilities: () => ({
    agents: [
      { id: "agent-from-server", name: "Server Agent" },
      { id: "agent-after-write", name: "Written Agent" },
    ],
    models: [
      { id: "model-from-server", name: "Server Model", providerID: "p", variants: ["high", "low"] },
      {
        id: "model-after-write",
        name: "Written Model",
        providerID: "p",
        variants: ["high", "low"],
      },
    ],
    defaultModel: { providerID: "p", modelID: "model-from-server" },
    isLoading: false,
    error: null,
  }),
}));

const realResolve = await import("@web/features/opencode/resolveOpenCodeModel");
mock.module("@web/features/opencode/resolveOpenCodeModel", () => ({
  ...realResolve,
  useResolvedOpenCodeModel: () => ({ providerID: "p", modelID: "model-from-server" }),
}));

const realAutoPolicy = await import("@web/features/opencode/sessionAutoPolicy");
mock.module("@web/features/opencode/sessionAutoPolicy", () => ({
  ...realAutoPolicy,
  hydrateAutoPolicy: (sessionId: string, enabled: boolean) => {
    hydrateCalls.push({ sessionId, enabled });
  },
}));

const realExtras = await import("@web/features/opencode/v2RuntimeExtras");
mock.module("@web/features/opencode/v2RuntimeExtras", () => ({
  ...realExtras,
  useOptionalV2RuntimeExtras: () => null,
}));

// The REAL config hook imports probeConversation through this module. Counting
// its calls is how the "one fetch per host" invariant is proven.
const realExistence = await import("@web/features/chat/state/conversationExistence");
mock.module("@web/features/chat/state/conversationExistence", () => ({
  ...realExistence,
  probeConversation: (id: string) => {
    probeCalls.push(id);
    return Promise.resolve({ status: "exists" as const, data: probeRow(id) });
  },
}));

const realFolders = await import("@web/features/folders/state/foldersStore");
mock.module("@web/features/folders/state/foldersStore", () => ({
  ...realFolders,
  useFoldersStore: (
    selector: (state: { folders: unknown[]; ensureFoldersLoaded: () => void }) => unknown,
  ) => selector({ folders: [], ensureFoldersLoaded: () => {} }),
}));

// --- Presence markers -----------------------------------------------------
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
mock.module("@web/features/opencode/OpenCodeContextRing", () => ({
  OpenCodeContextRing: () => <div data-testid="oc-context-ring" />,
}));

// --- Real modules under test ----------------------------------------------
const { OpenCodeChatHost } = await import("@web/features/opencode/OpenCodeChatHost");
const { OpenCodeChipsAndRing } = await import("@web/features/opencode/OpenCodeChipsAndRing");
const { updateConversationConfig } = await import(
  "@web/features/opencode/useOpenCodeConversationConfig"
);
const { useAvailabilityStore } = await import("@web/features/availability/availabilityStore");

ChipsRenderer = OpenCodeChipsAndRing;

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

function mountHost(conversationId: string): Mounted {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  act(() => root.render(<OpenCodeChatHost conversationId={conversationId} />));
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

function chipByLabel(host: Mounted, label: string): HTMLElement | null {
  return host.container.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
}
function shield(host: Mounted): HTMLElement | null {
  return host.container.querySelector<HTMLElement>(
    'button[aria-label^="Auto-approve permissions:"]',
  );
}

const originalEpoch = useAvailabilityStore.getState().recoveryEpoch;

beforeEach(() => {
  probeCalls.length = 0;
  hydrateCalls.length = 0;
  probeAutoApprove = false;
  probeAgent = "agent-from-server";
  probeModel = "p/model-from-server";
  useAvailabilityStore.setState({ recoveryEpoch: originalEpoch });
});

afterEach(() => {
  for (const m of mounted) m.unmount();
  mounted.length = 0;
  useAvailabilityStore.setState({ recoveryEpoch: originalEpoch });
});

describe("Phase F — one config fetch distributed through the runtime context", () => {
  it("fetches the conversation config once even with chips, Shield and session row mounted", async () => {
    const host = mountHost("cfg-count");
    await settle();

    // All consumers are present in the DOM.
    expect(chipByLabel(host, "Agent")).not.toBeNull();
    expect(chipByLabel(host, "Model")).not.toBeNull();
    expect(chipByLabel(host, "Thinking level")).not.toBeNull();
    expect(shield(host)).not.toBeNull();
    expect(host.container.textContent).toContain("agent-from-server"); // session row

    // Exactly ONE conversation read for the whole activated panel.
    expect(probeCalls).toEqual(["cfg-count"]);
  });

  it("propagates a confirmed chip write to every consumer via the host's override subscription", async () => {
    const host = mountHost("cfg-propagate");
    await settle();
    expect(probeCalls).toEqual(["cfg-propagate"]);
    expect(chipByLabel(host, "Agent")?.textContent).toContain("Server Agent");
    expect(chipByLabel(host, "Model")?.textContent).toContain("Server Model");
    expect(shield(host)?.getAttribute("aria-pressed")).toBe("false");

    // This is the exact seam the three chips call after a successful PATCH.
    act(() => {
      updateConversationConfig("cfg-propagate", {
        opencodeAgent: "agent-after-write",
        opencodeModel: "p/model-after-write",
        opencodeVariant: "high",
        opencodeAutoApprove: true,
      });
    });
    await settle();

    // No second conversation read — the override is merged into the one config.
    expect(probeCalls).toEqual(["cfg-propagate"]);

    // Chips, session row and Shield all reflect the shared value.
    expect(chipByLabel(host, "Agent")?.textContent).toContain("Written Agent");
    expect(chipByLabel(host, "Model")?.textContent).toContain("Written Model");
    expect(host.container.textContent).toContain("agent-after-write");
    expect(host.container.textContent).toContain("Thinking: high");
    expect(shield(host)?.getAttribute("aria-pressed")).toBe("true");

    // Auto-policy hydration re-ran with the shared autoApprove value.
    expect(hydrateCalls.at(-1)).toEqual({
      sessionId: "session-cfg-propagate",
      enabled: true,
    });
  });

  it("re-reads authoritative config when the backend recovery epoch changes", async () => {
    const host = mountHost("cfg-recovery");
    await settle();
    expect(probeCalls).toEqual(["cfg-recovery"]);
    expect(shield(host)?.getAttribute("aria-pressed")).toBe("false");

    // Backend comes back with Auto enabled; the epoch change must re-read it.
    probeAutoApprove = true;
    act(() => useAvailabilityStore.setState({ recoveryEpoch: originalEpoch + 1 }));
    await settle();

    expect(probeCalls).toEqual(["cfg-recovery", "cfg-recovery"]);
    expect(shield(host)?.getAttribute("aria-pressed")).toBe("true");
    expect(hydrateCalls.at(-1)).toEqual({
      sessionId: "session-cfg-recovery",
      enabled: true,
    });
  });

  it("delivers opencodeAutoApprove from the shared config to the Shield chip and auto-policy", async () => {
    probeAutoApprove = true;
    const host = mountHost("cfg-auto");
    await settle();

    expect(probeCalls).toEqual(["cfg-auto"]);
    expect(shield(host)?.getAttribute("aria-pressed")).toBe("true");
    expect(hydrateCalls).toContainEqual({
      sessionId: "session-cfg-auto",
      enabled: true,
    });
  });
});
