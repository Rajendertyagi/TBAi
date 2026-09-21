import { useCallback, useEffect, useMemo } from "react";
import { AssistantRuntimeProvider, AuiConfig, Tools, Suggestions, makeAssistantDataUI } from "@assistant-ui/react";
import { useAppChatRuntime } from "../../runtime";
import { threadListAdapter } from "../adapter";
import { DevToolsModal } from "@assistant-ui/react-devtools";
import { useSettingsStore } from "../../stores";
import { NEW_DRAFT_TAB_ID, activeTab, useChatTabsStore } from "../../features/chat/state/chatTabs";
import { getWelcomeEngineSnapshot } from "../../features/chat/state/welcomeEngine";
import { peekMaterializedEngine } from "../../features/chat/state/materializeDraft";
import { appToolkit } from "../../tools/toolkit";
import { logger } from "../../lib/logger";
import { TodoList } from "../../components/assistant-ui/elements/todo-list";
import { AppShell } from "./AppShell";

/**
 * Normal-chat branch shell. Owns the ONE shared assistant-ui thread-list
 * runtime (message/streaming/tool state lives there — never duplicated, never
 * in Zustand) and provides it to the chat chrome (sidebar, tabs, views).
 *
 * This shell must never enclose the Code route: a `useRemoteThreadListRuntime`
 * created under another RemoteThreadListRuntime degrades to a no-op that
 * reads the PARENT thread identity, so the OpenCode adapter lives in its own
 * top-level `CodeShell` instead. Moved verbatim from the former App root —
 * behavior and wiring are unchanged, only the placement is branch-scoped.
 *
 * Ownership: router → page; chat-tab store → open/active tabs;
 * runtime → threads/messages; SQLite → persistence.
 */
export function ChatShell() {
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
    // Runtime/thread liveness only: the runtime reports which thread it
    // bound, and the tab store follows. Never the reverse — a runtime report
    // must not invent a conversation, only resolve the draft or reveal an
    // already-persisted row.
    logger.info("app", "runtime.bind", { threadId: id });
    if (current?.kind === "chat" && current.ref === NEW_DRAFT_TAB_ID) {
      // First send: bind with the engine the single materialization owner
      // used for this conversation — never a fresh mutable read that could
      // observe a different engine than the row was created with. Peek (not
      // take): the send-interception guard in prepareSendMessagesRequest reads
      // the same record afterwards. Falls back to the live snapshot only for
      // rows the owner did not create.
      state.resolveDraftId(id, peekMaterializedEngine(id) ?? getWelcomeEngineSnapshot().engine);
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

  // Runtime lifecycle: which shell owns a live runtime, and when.
  useEffect(() => {
    logger.info("app", "runtime.mount", { shell: "chat" });
    return () => logger.info("app", "runtime.unmount", { shell: "chat" });
  }, []);

  // Single authoritative tool-renderer registration (toolkit architecture).
  // Stable reference: the toolkit object is module-scope, registered once.
  // `appToolkit` is the native registry plus the OpenCode-name renderers; the
  // MODEL-facing contract stays server-side (src/tools/index.ts), so this only
  // decides which component draws a tool part.
  const config = useMemo(() => AuiConfig({
    tools: Tools({ toolkit: appToolkit }),
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
      <AppShell />
      <DevToolsModal />
    </AssistantRuntimeProvider>
  );
}
