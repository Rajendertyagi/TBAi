import { useLocation } from "react-router";
import { useAuiState } from "@assistant-ui/react";
import { conversationIdFromPath } from "@/features/chat/state/chatTabs";
import { cn } from "@/lib/utils";
import { sidebarConfig } from "@/config/sidebar";

/**
 * Live generation indicator and unread state for a sidebar conversation row.
 *
 * Derived from assistant-ui runtime state and unread indicators.
 * Permanently reserves a 6px slot (size-1.5) so that switching states
 * (running -> unread -> seen/idle) never reflows or jumps row titles.
 */
export function useThreadListItemRunning(remoteId: string): boolean {
  const { pathname } = useLocation();
  const isOpenConversation = conversationIdFromPath(pathname) === remoteId;

  // The open row reads the thread list item's running state from official API.
  const openThreadRunning = useAuiState((state) => {
    try {
      return state.threadListItem.isRunning;
    } catch {
      return false;
    }
  });

  // Any row: the thread list's own view.
  const listItemRunning = useAuiState((state) => {
    try {
      const items = state.threads?.threadItems ?? [];
      const match =
        items.find((t) => t.remoteId === remoteId) ?? items.find((t) => t.id === remoteId);
      return match?.isRunning === true;
    } catch {
      return false;
    }
  });

  return isOpenConversation ? openThreadRunning : listItemRunning;
}

export function ThreadRunningDot({
  remoteId,
  size = "sm",
  isUnread = false,
  className,
}: {
  remoteId: string;
  size?: "xs" | "sm";
  isUnread?: boolean;
  className?: string;
}) {
  const running = useThreadListItemRunning(remoteId);
  const dotSizeClass = size === "xs" ? "size-1" : "size-1.5";

  // Fixed container ensures the 6px slot is permanently reserved.
  // Titles never shift when generation begins, ends, or transitions to unread/seen.
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center", dotSizeClass, className)}
    >
      {running ? (
        <span
          role="status"
          aria-label={sidebarConfig.copy.threadRunning}
          title={sidebarConfig.copy.threadRunning}
          className={cn(
            "thread-running-dot inline-block shrink-0 animate-pulse rounded-full",
            dotSizeClass,
          )}
        />
      ) : isUnread ? (
        <span
          role="status"
          aria-label="Unread reply"
          title="Unread reply"
          className={cn("inline-block shrink-0 rounded-full bg-primary", dotSizeClass)}
        />
      ) : null}
    </span>
  );
}
