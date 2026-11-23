import { useParams } from "react-router";
import { NEW_DRAFT_TAB_ID } from "../state/chatTabs";
import { useConversationTab } from "../state/useConversationTab";

/**
 * Routed chat surface (`/chat/:threadId?`) — Phase E thin focus/open trigger.
 *
 * The conversation is rendered by the persistent Dockview workspace's
 * `DirectPanel` (or the single draft panel), each with its own per-host
 * assistant-ui provider. This view owns NO `ChatWindow` of its own: mounting
 * one here would create a second runtime for an already-open panel. Its only
 * job is the shared route→tab binding with existence validation (stale ids
 * close their tabs and redirect to a fresh draft); the focus controller then
 * converges `localActiveKey` with the Dockview panel.
 */
export function ChatView() {
  const { threadId } = useParams();
  useConversationTab(threadId ?? NEW_DRAFT_TAB_ID, "chat");
  return null;
}
