import { useNavigate } from "react-router";
import { useAuiState } from "@assistant-ui/react";
import { Plus, X } from "lucide-react";
import { cn } from "../../../lib/utils";
import {
  NEW_DRAFT_TAB_ID,
  urlForTab,
  useChatTabsStore,
} from "../state/chatTabs";

interface StripThreadItem {
  remoteId?: string;
  title?: string;
}

/**
 * Unified tab strip (browser-tab model): open chats AND open settings pages
 * side by side. Switching never touches message state — chat tabs only
 * change the shared runtime's threadId, so background chats keep streaming.
 * Closing a chat tab hides it (the thread persists; delete stays in the
 * sidebar). URL follow-up is handled by TabUrlSync.
 */
export function TabStrip() {
  const tabs = useChatTabsStore((s) => s.tabs);
  const activeKey = useChatTabsStore((s) => s.activeKey);
  const close = useChatTabsStore((s) => s.close);
  const navigate = useNavigate();

  const items = useAuiState(
    (s) =>
      (
        s.threads as unknown as { threadItems?: StripThreadItem[] }
      ).threadItems ?? [],
  );

  const titleOf = (ref: string): string | null => {
    if (ref === NEW_DRAFT_TAB_ID) return "New chat";
    const match = items.find((item) => item.remoteId === ref);
    return match ? (match.title ?? "Untitled") : null;
  };
  // Unknown chat ids (deleted threads) are hidden; opening one redirects to
  // a fresh draft via ChatView validation.
  const visible = tabs.filter(
    (tab) => tab.kind === "chat" && titleOf(tab.ref) !== null,
  );

  const closeTab = (key: string): void => {
    const remaining = tabs.filter((t) => t.key !== key);
    close(key);
    if (key === activeKey) {
      const next = remaining[remaining.length - 1];
      navigate(next ? urlForTab(next) : "/chat/new");
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-muted/30 px-2 py-1">
      {visible.map((tab) => {
        const isActive = tab.key === activeKey;
        const title = titleOf(tab.ref) ?? tab.ref;
        return (
          <div
            key={tab.key}
            role="tab"
            aria-selected={isActive}
            onClick={() => navigate(urlForTab(tab))}
            className={cn(
              "group flex max-w-48 cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
              isActive
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            title={title}
          >
            <span className="min-w-0 flex-1 truncate">{title}</span>
            <button
              aria-label={`Close ${title}`}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.key);
              }}
              className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-background"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <button
        aria-label="New chat tab"
        onClick={() => navigate("/chat/new")}
        className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
