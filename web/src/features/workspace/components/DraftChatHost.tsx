/**
 * Draft-aware Direct host for the single unsent `chat:new` conversation.
 *
 * Unlike `DirectChatHost` (which deliberately uses `noopThreadIdChange`), this
 * host wires the runtime's thread-id-change callback to the same draft binding
 * AppShell owns today: when the active tab is the draft, the id produced by
 * `adapter.initialize()` is resolved via `resolveDraftId` with the engine the
 * single materialization owner recorded; otherwise it is presented as a normal
 * chat. Materialization itself stays owned by `adapter.initialize()` (one shared
 * idempotency key), so this host never materializes a draft itself. Exactly one
 * instance must be mounted for the draft — Phase E's route controller owns that
 * guarantee — otherwise two runtimes would both call `initialize()` and bind the
 * same id twice.
 */
import { useCallback } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { threadListAdapter } from "../../../app/adapter";
import { useAppChatRuntime } from "../../../runtime";
import { ChatWindow } from "../../../components/ChatWindow";
import { ChatHeader } from "../../chat/components/ChatHeader";
import { NEW_DRAFT_TAB_ID, activeTab, useChatTabsStore } from "../../chat/state/chatTabs";
import { getWelcomeEngineSnapshot } from "../../chat/state/welcomeEngine";
import { peekMaterializedEngine } from "../../chat/state/materializeDraft";
import { logger } from "../../../lib/logger";
import { DirectDataUIs, DirectHostProvider } from "./directHost";

/** Mount exactly one of these for the `chat:new` draft panel. */
export function DraftChatHost() {
  return (
    <DirectHostProvider>
      <DraftChatInner />
    </DirectHostProvider>
  );
}

function DraftChatInner() {
  // Mirrors AppShell's handleThreadIdChange exactly. The callback fires once
  // when the new-thread runtime reports the id returned by `initialize()`.
  const onThreadIdChange = useCallback((id: string | undefined) => {
    if (!id) return;
    const state = useChatTabsStore.getState();
    const current = activeTab(state);
    logger.info("app", "runtime.bind", { threadId: id });
    if (current?.kind === "chat" && current.ref === NEW_DRAFT_TAB_ID) {
      state.resolveDraftId(id, peekMaterializedEngine(id) ?? getWelcomeEngineSnapshot().engine);
    } else {
      // Presentation-only runtime binding; never mutates shared membership.
      state.presentChat(id);
    }
  }, []);

  // `undefined` makes this a new-thread runtime: the first send runs
  // `adapter.initialize()`, the single materialization owner, which reports the
  // new id through the callback above. No draft is materialized here directly.
  const runtime = useAppChatRuntime(threadListAdapter, undefined, onThreadIdChange);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <DirectDataUIs />
      <div
        className="flex h-full min-h-0 flex-col"
        data-testid="draft-chat-host"
        data-thread-id={NEW_DRAFT_TAB_ID}
        data-is-draft="true"
      >
        <div data-testid="direct-conversation-header" data-conversation-id={NEW_DRAFT_TAB_ID}>
          <ChatHeader threadId={NEW_DRAFT_TAB_ID} />
        </div>
        <div className="min-h-0 flex-1">
          <ChatWindow isDraft />
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
