/**
 * Direct Chat tool-UI registration — REAL assistant-ui provider/config.
 *
 * ## The regression this pins
 *
 * The shared Direct `AuiConfig` (tools + suggestions) was mounted on the OUTER
 * isolation boundary (`AuiProvider extends={null}`), while the inner
 * `AssistantRuntimeProvider` — the one that installs the client scope
 * `part.toolUI` reads — had NO `config`. Every native tool part therefore fell
 * through to `ToolFallback`; approval cards, code-payload renderers, progress /
 * compaction data UIs and suggestions were absent from the rendering scope.
 *
 * ## What is real here
 *
 * `@assistant-ui/react` is deliberately NOT mocked. The real
 * `AssistantRuntimeProvider` builds the real client from the real config
 * (`createDirectAuiConfig()` → `AuiConfig({ tools: Tools({ toolkit: appToolkit }),
 * suggestions: Suggestions([...]) })`). Only the runtime factory
 * (`useAppChatRuntime`), the adapter, and the heavy `ChatWindow`/`ChatHeader`
 * leaves are faked. The faked `ChatWindow` renders a `useAuiState` probe from
 * the REAL library, so every assertion reads the actual client scope created by
 * the real provider — not source text and not a mock of the behaviour under test.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "../../helpers/repo-root";

// REAL assistant-ui — do not mock this module.
import {
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";

// ── seeded tool parts ─────────────────────────────────────────────────────────

/**
 * One assistant message with two approval-gated native tool calls:
 * - `write_file` — its custom card is the approval UI (Approve / Deny).
 * - `edit_file` — its custom card shows the code payload (Find / Replace pair).
 * Both carry an OPEN approval (`approved` undefined), which is the state that
 * makes the custom renderer paint its interactive surface.
 */
const SEEDED_MESSAGES: ThreadMessageLike[] = [
  {
    id: "assistant_tools",
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call_write",
        toolName: "write_file",
        args: { path: "notes.txt", content: "hello" },
        argsText: JSON.stringify({ path: "notes.txt", content: "hello" }),
        approval: { id: "ap-write", prompt: "Allow write?" },
      },
      {
        type: "tool-call",
        toolCallId: "call_edit",
        toolName: "edit_file",
        // Empty oldText keeps EditPreviewBody from issuing a preview fetch; the
        // Find / Replace pair still renders on first paint.
        args: { path: "notes.txt", oldText: "", newText: "" },
        argsText: JSON.stringify({ path: "notes.txt", oldText: "", newText: "" }),
        approval: { id: "ap-edit", prompt: "Allow edit?" },
      },
    ],
  },
];

// ── faked runtime factory + adapter ───────────────────────────────────────────

/**
 * Returns a REAL runtime so the real provider builds a real client scope.
 * Called as a hook from inside `DirectChatInner`, so calling
 * `useExternalStoreRuntime` here keeps a stable hook order.
 */
function useAppChatRuntimeMock(
  _adapter: unknown,
  _threadId: string | undefined,
  _onThreadIdChange: (id: string | undefined) => void,
) {
  return useExternalStoreRuntime<ThreadMessageLike>({
    messages: SEEDED_MESSAGES,
    isRunning: false,
    convertMessage: (message) => message,
    onNew: async () => {},
  });
}

const runtimeModule = () => ({ useAppChatRuntime: useAppChatRuntimeMock });
mock.module("@web/runtime", runtimeModule);
mock.module(pathToFileURL(path.join(REPO_ROOT, "web/src/runtime.ts")).href, runtimeModule);

const adapterModule = () => ({ threadListAdapter: { id: "thread-list-adapter" } });
mock.module("@web/app/adapter", adapterModule);
mock.module(pathToFileURL(path.join(REPO_ROOT, "web/src/app/adapter.ts")).href, adapterModule);

// ── probe + heavy leaves ──────────────────────────────────────────────────────

/** One client + one toolUIs record per mounted host, for the isolation case. */
const seenClients = new Set<object>();
const seenToolUIs = new Set<object>();

/** Reads the REAL client scope created by the real provider. */
function ScopeProbe() {
  const aui = useAui();
  const toolUIs = useAuiState((s) => s.tools.toolUIs);
  const suggestions = useAuiState((s) => s.suggestions.suggestions);
  const dataRenderers = useAuiState((s) => s.dataRenderers.renderers);

  seenClients.add(aui);
  seenToolUIs.add(toolUIs);

  return (
    <div
      data-testid="scope-probe"
      data-tool-names={Object.keys(toolUIs).sort().join(",")}
      data-suggestions={suggestions.map((s) => s.prompt).join("|")}
      data-data-renderers={Object.keys(dataRenderers).sort().join(",")}
    />
  );
}

/** Renders a message's parts through the REAL primitives, so `part.toolUI` is resolved. */
function ToolRenderingMessage() {
  return (
    <MessagePrimitive.Root data-testid="tool-message">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

const chatWindowModule = () => ({
  ChatWindow: () => (
    <>
      <ScopeProbe />
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Messages components={{ Message: ToolRenderingMessage }} />
      </ThreadPrimitive.Root>
    </>
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

// The hosts are imported AFTER the mocks are registered.
const { DirectChatHost } = await import("@web/features/workspace/components/DirectChatHost");
const { DraftChatHost } = await import("@web/features/workspace/components/DraftChatHost");
const { DIRECT_COMPACT_DATA_NAME } = await import("@web/features/chat/compactCommand");

// ── mount helpers ─────────────────────────────────────────────────────────────

interface Mounted {
  readonly container: HTMLElement;
  unmount(): void;
}
const mounted: Mounted[] = [];

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

/** Let the runtime adapter effect and the tool-UI registration effects settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function mountDirect(threadId = "conv-A"): Promise<Mounted> {
  const handle = mountElement(<DirectChatHost threadId={threadId} />);
  await settle();
  return handle;
}

function probe(host: Mounted): HTMLElement {
  const el = host.container.querySelector<HTMLElement>('[data-testid="scope-probe"]');
  if (!el) throw new Error("scope probe did not render");
  return el;
}

beforeEach(() => {
  seenClients.clear();
  seenToolUIs.clear();
});

afterEach(() => {
  for (const entry of mounted.splice(0)) entry.unmount();
});

// ── criteria ──────────────────────────────────────────────────────────────────

describe("Direct Chat tool-UI registration (real provider)", () => {
  it("registers the native tool renderers in the runtime provider's client scope", async () => {
    const host = await mountDirect();
    const names = (probe(host).getAttribute("data-tool-names") ?? "").split(",");

    for (const tool of ["read_file", "write_file", "run_command"]) {
      expect(names, `missing renderer for ${tool}`).toContain(tool);
    }
  });

  it("renders the custom approval UI for an approval-gated tool, not ToolFallback", async () => {
    const host = await mountDirect();
    const text = host.container.textContent ?? "";

    // The custom write_file card paints its title and the Approve / Deny gate.
    expect(text).toContain("write_file · notes.txt");
    expect(text).toContain("Approve");
    expect(text).toContain("Deny");
    // The generic fallback never took over.
    expect(host.container.querySelector('[data-slot="tool-fallback-root"]')).toBeNull();
    expect(text).not.toContain("Used tool:");
  });

  it("renders the custom code-payload UI for edit_file, not raw JSON", async () => {
    const host = await mountDirect();
    const text = host.container.textContent ?? "";

    // EditFileToolUI's EditPreviewBody paints the Find / Replace pair.
    expect(text).toContain("Find:");
    expect(text).toContain("Replace with:");
    expect(host.container.querySelector('[data-slot="tool-fallback-root"]')).toBeNull();
    expect(host.container.querySelector('[data-slot="code-payload"]')).toBeNull();
  });

  it("registers the progress and compaction data UIs", async () => {
    const host = await mountDirect();
    const names = (probe(host).getAttribute("data-data-renderers") ?? "").split(",");

    expect(names).toContain("tbai-progress");
    expect(names).toContain(DIRECT_COMPACT_DATA_NAME);
  });

  it("makes the three Direct suggestions available", async () => {
    const host = await mountDirect();
    const values = (probe(host).getAttribute("data-suggestions") ?? "").split("|");

    expect(values).toEqual([
      "What can you help me with?",
      "Explain a concept",
      "Help me write code",
    ]);
  });

  it("gives Draft Chat the same configuration as Direct Chat", async () => {
    const host = mountElement(<DraftChatHost />);
    await settle();
    const el = probe(host);

    const names = (el.getAttribute("data-tool-names") ?? "").split(",");
    for (const tool of ["read_file", "write_file", "run_command"]) {
      expect(names, `draft missing renderer for ${tool}`).toContain(tool);
    }
    expect((el.getAttribute("data-suggestions") ?? "").split("|")).toEqual([
      "What can you help me with?",
      "Explain a concept",
      "Help me write code",
    ]);
    const dataNames = (el.getAttribute("data-data-renderers") ?? "").split(",");
    expect(dataNames).toContain("tbai-progress");
    expect(dataNames).toContain(DIRECT_COMPACT_DATA_NAME);
  });

  it("keeps multiple Direct hosts' runtime clients and tool registries separate", async () => {
    await mountDirect("conv-A");
    await mountDirect("conv-B");

    // One client and one toolUIs record per host — no shared runtime state.
    expect(seenClients.size).toBe(2);
    expect(seenToolUIs.size).toBeGreaterThanOrEqual(2);
  });
});
