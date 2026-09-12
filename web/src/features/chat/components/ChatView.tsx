import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { ChatWindow } from "../../../components/ChatWindow";
import {
  NEW_DRAFT_TAB_ID,
  useChatTabsStore,
} from "../state/chatTabs";
import { threadListAdapter } from "../../../app/adapter";

/**
 * Routed chat view (`/chat/:threadId?`). Syncs URL → tab store (open the
 * thread as a chat tab), validates the thread exists (stale ids close the
 * tab and redirect to a fresh draft), and renders the thread-bound
 * ChatWindow. Tab switching itself only changes the runtime's threadId —
 * background thread runtimes stay cached in the shared thread-list
 * runtime, so streams continue.
 */
export function ChatView() {
  const { threadId } = useParams();
  const navigate = useNavigate();
  const openChat = useChatTabsStore((s) => s.openChat);
  const close = useChatTabsStore((s) => s.close);

  const target = threadId ?? NEW_DRAFT_TAB_ID;

  useEffect(() => {
    openChat(target);
    if (target !== NEW_DRAFT_TAB_ID) {
      let cancelled = false;
      threadListAdapter
        .fetch(target)
        .catch(() => {
          if (cancelled) return;
          useChatTabsStore.getState().close(`chat:${target}`);
          navigate("/chat/new", { replace: true });
        });
      return () => {
        cancelled = true;
      };
    }
  }, [target, openChat, close, navigate]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <ChatWindow />
      </div>
    </div>
  );
}
