/**
 * Runtime-level draft-host coverage (audit M4).
 *
 * Mounts the REAL `DirectPanel` and `DraftChatHost` with a minimal Dockview
 * panel prop bag (the same pattern as `OpenCodePanel.integration.test.tsx`).
 * Heavy leaves (assistant-ui provider, runtime, ChatWindow, ChatHeader, data
 * UIs) are deterministic markers.
 *
 * SCOPE (kept honest per audit M4): this DOM suite proves the draft host mounts
 * exactly once, the duplicate-mount claim refuses a second host for the same
 * canonical key, and a bound panel gets a distinct runtime. It does NOT drive
 * the full DockviewWorkspace/controller path. The alias state-machine behaviors
 * (materialization mapping, close canonicalization, clear-on-close, fresh-draft
 * replacement, StrictMode idempotence) are covered behaviorally in
 * `tests/unit/web/workspace/draftAlias.test.ts`, and `replacePanel` (fresh-draft
 * host replacement without close semantics) in
 * `tests/unit/web/workspace/dockview-controller.test.ts`. Full live-backend
 * first-send materialization remains a Playwright E2E concern.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "../../helpers/repo-root";

// --- captured seams -------------------------------------------------------
let runtimeCounter = 0;
let runtimeIds: string[] = [];
let draftHostMounts = 0;

// --- assistant-ui provider marker -----------------------------------------
const realAui = await import("@assistant-ui/react");
mock.module("@assistant-ui/react", () => ({
  ...realAui,
  AssistantRuntimeProvider: ({ children }: { children?: ReactNode }) => (
    <div data-testid="runtime-provider">{children}</div>
  ),
}));

// --- runtime / adapter / heavy leaves -------------------------------------
const runtimeModule = () => ({
  useAppChatRuntime: () => {
    const id = `runtime-${++runtimeCounter}`;
    runtimeIds.push(id);
    return { id };
  },
});
mock.module("@web/runtime", runtimeModule);
mock.module(pathToFileURL(nodePath.join(REPO_ROOT, "web/src/runtime.ts")).href, runtimeModule);

const adapterModule = () => ({ threadListAdapter: { id: "thread-list-adapter" } });
mock.module("@web/app/adapter", adapterModule);
mock.module(pathToFileURL(nodePath.join(REPO_ROOT, "web/src/app/adapter.ts")).href, adapterModule);

const chatWindowModule = () => ({
  ChatWindow: () => <div data-testid="chat-window" />,
});
mock.module("@web/components/ChatWindow", chatWindowModule);
mock.module(
  pathToFileURL(nodePath.join(REPO_ROOT, "web/src/components/ChatWindow.tsx")).href,
  chatWindowModule,
);

mock.module("@web/features/chat/components/ChatHeader", () => ({
  ChatHeader: () => <div data-testid="chat-header" />,
}));

const directHostModule = () => ({
  DirectHostProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DirectDataUIs: () => <div data-testid="direct-data-uis" />,
});
mock.module("@web/features/workspace/components/directHost", directHostModule);
mock.module(
  pathToFileURL(nodePath.join(REPO_ROOT, "web/src/features/workspace/components/directHost.tsx"))
    .href,
  directHostModule,
);

// Draft host wrapper counts mounts/unmounts around the REAL host. Registered
// BEFORE importing DirectPanel so it resolves the mock.
//
// Capture the real component's function reference BEFORE calling mock.module.
// Bun mutates the imported namespace object when a module is mocked, so reading
// `realDraftHost.DraftChatHost` inside the wrapper would resolve to the mock
// itself and recurse infinitely (heap exhaustion). The captured reference stays
// the real function (verified: before !== after after mock.module).
const RealDraftChatHost = (await import("@web/features/workspace/components/DraftChatHost.tsx"))
  .DraftChatHost;
const draftHostModule = () => ({
  DraftChatHost: () => {
    draftHostMounts += 1;
    return <RealDraftChatHost />;
  },
});
mock.module("@web/features/workspace/components/DraftChatHost", draftHostModule);
mock.module(
  pathToFileURL(nodePath.join(REPO_ROOT, "web/src/features/workspace/components/DraftChatHost.tsx"))
    .href,
  draftHostModule,
);

// --- real modules under test ----------------------------------------------
const { DirectPanel } = await import("@web/features/workspace/components/DirectPanel.tsx");
const { parsePanelParams } = await import("@web/features/workspace/dockviewParams.ts");
const { panelRegistry } = await import("@web/features/workspace/panelRegistry.ts");

type PanelProps = import("react").ComponentProps<typeof DirectPanel>;

function panelProps(tabKey: string, panelId: string): PanelProps {
  const params = parsePanelParams({ tabKey, contentType: "direct" });
  if (!params) throw new Error(`invalid test tab key: ${tabKey}`);
  // Same minimal-prop pattern as OpenCodePanel.integration.test.tsx: the panel
  // reads only params, api.id/isVisible/onDidVisibilityChange and containerApi.
  return Object.assign({} as PanelProps, {
    params,
    api: {
      id: panelId,
      isVisible: true,
      onDidVisibilityChange: () => ({ dispose: () => {} }),
    },
    containerApi: {},
  });
}

let container: HTMLElement;
let root: Root;

function mount(element: ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(element);
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function queryAll(testId: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`));
}

beforeEach(() => {
  runtimeCounter = 0;
  runtimeIds = [];
  draftHostMounts = 0;
  for (const key of [...panelRegistry.claimed]) panelRegistry.release(key);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  for (const key of [...panelRegistry.claimed]) panelRegistry.release(key);
});

describe("draft host runtime (audit M4)", () => {
  it("mounts exactly one draft host with its own runtime", async () => {
    mount(<DirectPanel {...panelProps("chat:new", "chat:new")} />);
    await settle();

    expect(queryAll("draft-chat-host")).toHaveLength(1);
    expect(queryAll("runtime-provider")).toHaveLength(1);
    expect(runtimeIds).toHaveLength(1);
    expect(draftHostMounts).toBe(1);
    expect(queryAll("dockview-direct-panel")[0]?.getAttribute("data-panel-id")).toBe("chat:new");
  });

  it("refuses a second host for the same canonical draft key", async () => {
    mount(
      <div>
        <DirectPanel {...panelProps("chat:new", "chat:new")} />
        <DirectPanel {...panelProps("chat:new", "chat:new-2")} />
      </div>,
    );
    await settle();

    // The claim guard allows only one live host; the other renders a placeholder.
    expect(queryAll("draft-chat-host")).toHaveLength(1);
    expect(runtimeIds).toHaveLength(1);
    expect(container.textContent).toContain("already open in another panel");
  });

  it("a bound Direct panel mounts a distinct runtime from the draft", async () => {
    mount(
      <div>
        <DirectPanel {...panelProps("chat:new", "chat:new")} />
        <DirectPanel {...panelProps("chat:bound", "chat:bound")} />
      </div>,
    );
    await settle();

    expect(queryAll("draft-chat-host")).toHaveLength(1);
    expect(runtimeIds).toHaveLength(2);
    expect(new Set(runtimeIds).size).toBe(2);
  });
});
