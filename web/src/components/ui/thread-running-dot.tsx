import { useLocation } from "react-router";
import { useAuiState } from "@assistant-ui/react";
import { conversationIdFromPath } from "@/features/chat/state/chatTabs";
import { cn } from "@/lib/utils";
import { sidebarConfig } from "@/config/sidebar";

/**
 * Live generation indicator for a sidebar conversation row.
 *
 * Derived from assistant-ui runtime state — never persisted. A conversation's
 * persistent status is binary (regular/archived); whether it is generating right
 * now is runtime activity and must not touch the database.
 *
 * Which row counts as "the open one" is answered by the ROUTE, through the same
 * `conversationIdFromPath` the folder section already uses for its highlight.
 * There used to be a second, independent notion of "active" here (the tabs
 * store's `activeKey`), and the two disagreed: the open conversation's row read
 * as inactive, so it never consulted the thread it belonged to and the indicator
 * could not appear at all. One rule, taken from the URL, removes the class of bug
 * rather than one instance of it.
 *
 * The open row reads the ACTIVE THREAD's state — the same value the composer's
 * Stop control renders from, and public API. The thread LIST's per-item
 * `isRunning` does not track a run happening in the open thread, so it is used
 * only as the fallback for rows that are not open.
 */
export function useThreadListItemRunning(remoteId: string): boolean {
  const { pathname } = useLocation();
  const isOpenConversation = conversationIdFromPath(pathname) === remoteId;

  // Both selectors are guarded because `useAuiState` runs them DURING render, and
  // a component rendered without a real client (the OpenCode view mounts its own
  // provider) receives a default client whose scope accessors THROW on use. An
  // unguarded selector therefore took down the whole surface with an
  // AuiProvider boundary error instead of just reading "not running".
  const openThreadRunning = useAuiState((state) => {
    try {
      return state.thread?.isRunning === true;
    } catch {
      return false;
    }
  });

  // Any row: the thread list's own view. `threadItems` are plain state objects in
  // the snapshot, so this reads `isRunning` directly.
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
  className,
}: {
  remoteId: string;
  size?: "xs" | "sm";
  className?: string;
}) {
  const running = useThreadListItemRunning(remoteId);
  if (!running) return null;
  return (
    <span
      role="status"
      aria-label={sidebarConfig.copy.threadRunning}
      title={sidebarConfig.copy.threadRunning}
      className={cn(
        "inline-block shrink-0 animate-pulse rounded-full bg-green-500",
        size === "xs" ? "size-1" : "size-1.5",
        className,
      )}
    />
  );
}
