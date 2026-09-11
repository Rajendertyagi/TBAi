import { useCallback, useEffect, useMemo } from "react";
import { RouterProvider } from "react-router/dom";
import { AssistantRuntimeProvider, AuiConfig, Tools, Suggestions, makeAssistantDataUI } from "@assistant-ui/react";
import { useAppChatRuntime } from "./runtime";
import { threadListAdapter } from "./app/adapter";
import { router } from "./app/router";
import { ElicitationModal } from "./components/ElicitationModal";
import { DevToolsModal } from "@assistant-ui/react-devtools";
import { useSettingsStore } from "./stores";
import { NEW_DRAFT_TAB_ID, activeTab, useChatTabsStore } from "./features/chat/state/chatTabs";
import { nativeToolkit } from "./tools/toolkit";
import { TodoList } from "./components/assistant-ui/elements/todo-list";

/**
 * Application root. Owns the ONE shared assistant-ui thread-list runtime
 * (message/streaming/tool state lives there — never duplicated, never in
 * Zustand) and renders the hash router inside it so the sidebar and every
 * route view share the ambient runtime.
 *
 * Ownership: router → page; chat-tab store → open/active tabs;
 * runtime → threads/messages; SQLite → persistence.
 */
export default function App() {
  const active = useChatTabsStore(activeTab);
  const runtimeThreadId =
    active?.kind === "chat" && active.ref !== NEW_DRAFT_TAB_ID
      ? active.ref
      : undefined;

  // Runtime-initiated thread changes (sidebar thread click, first send
  // creating a thread, adapter initialize) flow into the tab store; the URL
  // follows via TabUrlSync. Prop-driven tab switches are idempotent here.
  const handleThreadIdChange = useCallback((id: string | undefined) => {
    if (!id) return;
    const state = useChatTabsStore.getState();
    const current = activeTab(state);
    if (current?.kind === "chat" && current.ref === NEW_DRAFT_TAB_ID) {
      state.attachRealId(NEW_DRAFT_TAB_ID, id);
    } else if (
      !state.tabs.some((t) => t.kind === "chat" && t.ref === id)
    ) {
      state.openChat(id);
    }
  }, []);

  const runtime = useAppChatRuntime(
    threadListAdapter,
    runtimeThreadId,
    handleThreadIdChange,
  );

  const { loadProviders } = useSettingsStore();
  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  // Single authoritative native-tool registration (toolkit architecture).
  // Stable reference: the toolkit object is module-scope, registered once.
  const config = useMemo(() => AuiConfig({
    tools: Tools({ toolkit: nativeToolkit }),
    suggestions: Suggestions([
      "What can you help me with?",
      "Explain a concept",
      "Help me write code",
    ]),
  }), []);

  // Register the TBAi progress data-part renderer globally via AuiConfig.
  const TbaiProgressDataUI = makeAssistantDataUI({
    name: "tbai-progress",
    render: TodoList,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime} config={config}>
      <TbaiProgressDataUI />
      <RouterProvider router={router} />
      <ElicitationModal />
      {/* Dev-only inspector: mounted only under `vite dev`. The production
          bundle replaces import.meta.env.DEV with false and tree-shakes this
          branch away (the devtools package is side-effect-free), so no
          DevTools code, panel, or floating button ships to users. */}
      {import.meta.env.DEV && <DevToolsModal />}
    </AssistantRuntimeProvider>
  );
}
