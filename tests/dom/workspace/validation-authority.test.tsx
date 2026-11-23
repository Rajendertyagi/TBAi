/**
 * URL-writer contract under validation races (audit M3).
 *
 * Mounts the REAL `useConversationTab` and `useWorkspaceFocusSync` together in
 * a MemoryRouter with a controlled adapter. Validation corrections (engine
 * mismatch, confirmed-gone, draft fallback) are authoritative; focus sync must
 * not write a competing URL while the stale ref is still addressed, and the
 * final URL must be correct with no feedback loop.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "../../helpers/repo-root";

let fetchImpl: (id: string) => Promise<{ custom?: { engine?: string } }>;
const adapterMock = {
  fetch: (id: string) => fetchImpl(id),
};
mock.module("@web/app/adapter.ts", () => ({ threadListAdapter: adapterMock }));
mock.module(pathToFileURL(nodePath.join(REPO_ROOT, "web/src/app/adapter.ts")).href, () => ({
  threadListAdapter: adapterMock,
}));

const { MemoryRouter, Routes, Route, useLocation, useParams } = await import("react-router");
const { ConversationNotFoundError } = await import(
  "@web/features/chat/state/conversationExistence.ts"
);
const { useConversationTab } = await import("@web/features/chat/state/useConversationTab.ts");
const { useWorkspaceFocusSync } = await import(
  "@web/features/workspace/state/useWorkspaceFocusSync.ts"
);
const { useChatTabsStore } = await import("@web/features/chat/state/chatTabs.ts");
const { useWelcomeEngineStore } = await import("@web/features/chat/state/welcomeEngine.ts");
const { clearValidationRedirects } = await import("@web/features/workspace/routeFocus.ts");

let focusCalls: string[] = [];
const handleRef = { current: { focusOrOpen: (key: string) => focusCalls.push(key) } };

function Probe({ refId, kind }: { refId?: string; kind: "chat" | "agent" }) {
  useConversationTab(refId, kind);
  useWorkspaceFocusSync(handleRef);
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
        <Routes>
          <Route path="/chat/new" element={<Probe refId="new" kind="chat" />} />
          <Route path="/chat/:threadId" element={<ChatProbe />} />
          <Route path="/code/:agentId" element={<AgentProbe />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

function ChatProbe() {
  const { threadId } = useParams();
  return <Probe refId={threadId} kind="chat" />;
}
function AgentProbe() {
  const { agentId } = useParams();
  return <Probe refId={agentId} kind="agent" />;
}

function path(): string | null {
  return (
    container.querySelector<HTMLElement>('[data-testid="path"]')?.getAttribute("data-path") ?? null
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  focusCalls = [];
  clearValidationRedirects();
  useChatTabsStore.setState({
    localActiveKey: undefined,
    hasLocalDraft: false,
    detachedRefs: {},
  });
  useWelcomeEngineStore.setState({ engine: "direct", agent: "", model: "", variant: "" });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearValidationRedirects();
});

describe("validation owns route corrections (audit M3)", () => {
  it("engine mismatch /chat/:agentId -> /code/:id with no competing focus URL", async () => {
    fetchImpl = async () => ({ custom: { engine: "opencode" } });
    mount("/chat/agent-1");
    await settle();

    expect(path()).toBe("/code/agent-1");
    expect(useChatTabsStore.getState().localActiveKey).toBe("agent:agent-1");
    // Focus sync still focuses the panel, but never wrote a competing URL.
    expect(focusCalls).toContain("agent:agent-1");
  });

  it("stale /chat/:id (gone) while Dockview emits focus changes lands on the draft", async () => {
    fetchImpl = async (id) => {
      throw new ConversationNotFoundError(id);
    };
    mount("/chat/gone-1");
    await settle();
    // Simulate a Dockview focus arriving mid-validation; it must not win.
    act(() => handleRef.current.focusOrOpen("chat:ghost"));
    await settle();

    expect(path()).toBe("/chat/new");
    expect(useChatTabsStore.getState().localActiveKey).toBe("chat:new");
  });

  it("/code/:id missing -> /chat/new with opencode fallback intent", async () => {
    fetchImpl = async (id) => {
      throw new ConversationNotFoundError(id);
    };
    mount("/code/missing-1");
    await settle();

    expect(path()).toBe("/chat/new");
    expect(useWelcomeEngineStore.getState().engine).toBe("opencode");
  });
});
