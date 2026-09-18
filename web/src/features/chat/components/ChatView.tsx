import { useParams } from "react-router";
import { ChatWindow } from "../../../components/ChatWindow";
import { ChatHeader } from "./ChatHeader";
import { NEW_DRAFT_TAB_ID } from "../state/chatTabs";
import { useConversationTab } from "../state/useConversationTab";

/**
 * Routed chat view (`/chat/:threadId?`). Binds the route to a chat tab with
 * existence validation (shared hook — stale ids close the tab and redirect
 * to a fresh draft) and renders the thread-bound ChatWindow. Tab switching
 * itself only changes the runtime's threadId — background thread runtimes
 * stay cached in the shared thread-list runtime, so streams continue.
 */
export function ChatView() {
  const { threadId } = useParams();

  const target = threadId ?? NEW_DRAFT_TAB_ID;
  useConversationTab(target, "chat");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatHeader threadId={target} />
      <div className="min-h-0 flex-1">
        <ChatWindow isDraft={target === NEW_DRAFT_TAB_ID} />
      </div>
    </div>
  );
}
