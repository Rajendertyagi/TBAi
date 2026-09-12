import { useState, useRef, useEffect, Fragment, useCallback, type MutableRefObject } from "react";
import { useNavigate } from "react-router";
import {
  ThreadListPrimitive,
  ThreadListItemPrimitive,
  ThreadListItemMorePrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  FolderPlus,
  Search,
  MoreVertical,
  Pencil,
  Archive,
  ArchiveRestore,
  Trash2,
  ChevronDown,
} from "lucide-react";
import { cn } from "../lib/utils";
import { appConfig } from "../config/navigation";
import { historyConfig } from "../config/history";
import { setThreadListSearchQuery } from "../adapters/remoteThreadListAdapter";

type ThreadItem = {
  remoteId: string;
  title?: string;
  status?: string;
  lastMessageAt?: Date;
};

function dateGroupLabel(date?: Date): string {
  if (!date) return "Older";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = startOfToday - new Date(date).getTime();
  const day = 86400000;
  if (diff < 0) return "Today";
  if (diff < day) return "Yesterday";
  if (diff < 7 * day) return "Previous 7 days";
  return "Older";
}

export function Sidebar() {
  const navigate = useNavigate();
  // Thread switching itself is done by the ThreadListItemPrimitive.Trigger;
  // this only moves the URL (ChatView opens the matching tab, the runtime
  // switches threads, onThreadIdChange confirms the tab store).
  const openThread = useCallback(
    (remoteId: string) => navigate(`/chat/${remoteId}`),
    [navigate],
  );
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const aui = useAui();

  // Debounced server-side search: pushes the query into the adapter and asks
  // the runtime to reload page 1. Client title filter below stays as fallback.
  useEffect(() => {
    const t = setTimeout(() => {
      setThreadListSearchQuery(search);
      try {
        const client = aui as unknown as Record<
          string,
          { getState?: () => { reload?: () => unknown } } | undefined
        >;
        client.threads?.getState?.()?.reload?.();
      } catch {
        /* runtime reload unavailable; client filter still applies */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [search, aui]);

  // Used to insert date-group headers while iterating the list (reset each render).
  const lastGroup = useRef<string | null>(null);

  return (
    <div className="w-56 flex flex-col border-r border-border bg-muted/30">
      {/* New Chat */}
      <div className="px-2 pt-2">
        <ThreadListPrimitive.New asChild>
          <button
            onClick={() => navigate("/chat/new")}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm hover:bg-muted transition-colors"
          >
            <FolderPlus className="w-4 h-4" />
            {appConfig.branding.newWorkspaceLabel}
          </button>
        </ThreadListPrimitive.New>
      </div>

      {/* Search */}
      {historyConfig.searchEnabled && (
        <div className="px-2 pb-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conversations…"
              className="w-full rounded-md border border-border bg-transparent pl-8 pr-2 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        </div>
      )}

      {/* Conversations */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        <div className="text-xs font-medium text-muted-foreground px-3 py-2">
          {appConfig.branding.historyLabel}
        </div>

        <ThreadListPrimitive.Root className="space-y-0.5">
          <ConversationList
            search={search}
            dateGrouping={historyConfig.dateGrouping}
            lastGroup={lastGroup}
            onOpenThread={openThread}
            onOpenArchive={() => setShowArchived(true)}
          />
        </ThreadListPrimitive.Root>

        {/* Archived section */}
        {historyConfig.archiveEnabled && (
          <div className="mt-4">
            <button
              onClick={() => setShowArchived((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              <span>Archived</span>
              <ChevronDown
                className={cn("w-3.5 h-3.5 transition-transform", showArchived && "rotate-180")}
              />
            </button>
            {showArchived && (
              <ThreadListPrimitive.Items archived>
                {({ threadListItem }) =>
                  threadListItem.remoteId ? (
                    <ArchivedItem
                      key={threadListItem.remoteId}
                      remoteId={threadListItem.remoteId}
                      onOpenThread={openThread}
                    />
                  ) : null
                }
              </ThreadListPrimitive.Items>
            )}
          </div>
        )}
      </div>

    </div>
  );
}

function ConversationList({
  search,
  dateGrouping,
  lastGroup,
  onOpenThread,
  onOpenArchive,
}: {
  search: string;
  dateGrouping: boolean;
  lastGroup: MutableRefObject<string | null>;
  onOpenThread: (remoteId: string) => void;
  onOpenArchive: () => void;
}) {
  const isLoading = useAuiState((s) => s.threads.isLoading);
  const count = useAuiState((s) => s.threads.threadIds.length);
  lastGroup.current = null;
  // Anti-flood: only the first N regular threads render; "Show more" reveals
  // the next page. Old chats stay discoverable through search (server-side)
  // instead of an enormous permanent list. Session-only (resets on reload).
  const [recentLimit, setRecentLimit] = useState(5);
  const shownCount = useRef(0);
  shownCount.current = 0;
  // Reset the page when the filter changes so matches aren't hidden.
  const [lastQuery, setLastQuery] = useState(search);
  if (lastQuery !== search) {
    setLastQuery(search);
    setRecentLimit(5);
  }

  return (
    <>
      <ThreadListPrimitive.Items>
        {({ threadListItem }) => {
          const item = threadListItem as unknown as ThreadItem;
          if (
            search.trim() &&
            !((item.title ?? "").toLowerCase().includes(search.toLowerCase()))
          ) {
            return null;
          }
          if (shownCount.current >= recentLimit) return null;
          shownCount.current += 1;
          return (
            <ConversationItem
              key={item.remoteId}
              item={item}
              dateGrouping={dateGrouping}
              lastGroup={lastGroup}
              onOpenThread={onOpenThread}
            />
          );
        }}
      </ThreadListPrimitive.Items>

      {count > recentLimit && (
        <button
          onClick={() => setRecentLimit((n) => n + 5)}
          className="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          Show more ({count - recentLimit} more)
        </button>
      )}

      {isLoading && count === 0 && (
        <div className="space-y-2 px-1 py-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 rounded-md bg-muted animate-pulse" />
          ))}
        </div>
      )}

      {!isLoading && count === 0 && (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          No conversations yet.
          <button
            onClick={onOpenArchive}
            className="block mx-auto mt-1 text-foreground underline"
          >
            Browse archived
          </button>
        </div>
      )}

      {/* Official pagination: renders only when another page exists. */}
      <ThreadListPrimitive.LoadMore asChild>
        <button className="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
          Load more
        </button>
      </ThreadListPrimitive.LoadMore>
    </>
  );
}

function ConversationItem({
  item,
  dateGrouping,
  lastGroup,
  onOpenThread,
}: {
  item: ThreadItem;
  dateGrouping: boolean;
  lastGroup: MutableRefObject<string | null>;
  onOpenThread: (remoteId: string) => void;
}) {
  const group = dateGrouping ? dateGroupLabel(item.lastMessageAt) : null;
  const showHeader = group && group !== lastGroup.current;
  if (showHeader) lastGroup.current = group;

  return (
    <Fragment key={item.remoteId}>
      {showHeader && (
        <div className="px-3 pt-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {group}
        </div>
      )}
      <ThreadListItem item={item} onOpenThread={onOpenThread} />
    </Fragment>
  );
}

function ThreadListItem({
  item,
  onOpenThread,
}: {
  item: ThreadItem;
  onOpenThread: (remoteId: string) => void;
}) {
  const aui = useAui();
  const title = item.title ?? "Untitled";
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const submittedRef = useRef(false);

  const startRename = () => {
    submittedRef.current = false;
    setDraft(title);
    setRenaming(true);
  };

  const cancelRename = () => {
    submittedRef.current = true;
    setRenaming(false);
  };

  const commitRename = async () => {
    if (submittedRef.current || !renaming) return;
    submittedRef.current = true;
    const next = draft.trim();
    if (!next || next === title) {
      setRenaming(false);
      return;
    }
    // Through the runtime (never a raw fetch): the adapter persists AND the
    // store updates, so <ThreadListItemPrimitive.Title /> re-renders instantly.
    // The store id is resolved from state (never assumed === remoteId).
    setSaving(true);
    try {
      const items = aui.threads.getState().threadItems;
      const match =
        items.find((t) => t.remoteId === item.remoteId) ??
        items.find((t) => t.id === item.remoteId);
      await aui.threads.item({ id: match?.id ?? item.remoteId }).rename(next);
    } finally {
      setSaving(false);
      setRenaming(false);
    }
  };

  return (
    <ThreadListItemPrimitive.Root className="group relative flex items-center gap-1 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted data-[active]:bg-muted before:absolute before:left-1 before:top-1/2 before:h-4 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-transparent before:content-[''] data-[active]:before:bg-foreground">
      {renaming ? (
        <input
          autoFocus
          value={draft}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commitRename();
            if (e.key === "Escape") cancelRename();
          }}
          onBlur={() => void commitRename()}
          onFocus={(e) => e.target.select()}
          aria-label="Rename conversation"
          className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-0.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      ) : (
        <ThreadListItemPrimitive.Trigger
          className="flex-1 min-w-0 truncate text-left"
          onClick={() => onOpenThread(item.remoteId)}
        >
          <ThreadListItemPrimitive.Title />
        </ThreadListItemPrimitive.Trigger>
      )}

      <ThreadListItemMorePrimitive.Root>
        <ThreadListItemMorePrimitive.Trigger
          className="shrink-0 rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-background transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreVertical className="w-4 h-4" />
        </ThreadListItemMorePrimitive.Trigger>
        <ThreadListItemMorePrimitive.Content className="z-50 min-w-[160px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          {historyConfig.renameEnabled && (
            <ThreadListItemMorePrimitive.Item
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none hover:bg-muted"
              onSelect={() => startRename()}
            >
              <Pencil className="w-4 h-4" /> Rename
            </ThreadListItemMorePrimitive.Item>
          )}
          {historyConfig.archiveEnabled && item.status === "regular" && (
            <ThreadListItemPrimitive.Archive asChild>
              <ThreadListItemMorePrimitive.Item className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none hover:bg-muted">
                <Archive className="w-4 h-4" /> Archive
              </ThreadListItemMorePrimitive.Item>
            </ThreadListItemPrimitive.Archive>
          )}
          {historyConfig.deleteEnabled && (
            <ThreadListItemPrimitive.Delete asChild>
              <ThreadListItemMorePrimitive.Item className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-destructive outline-none hover:bg-muted">
                <Trash2 className="w-4 h-4" /> Delete
              </ThreadListItemMorePrimitive.Item>
            </ThreadListItemPrimitive.Delete>
          )}
        </ThreadListItemMorePrimitive.Content>
      </ThreadListItemMorePrimitive.Root>
    </ThreadListItemPrimitive.Root>
  );
}

function ArchivedItem({
  remoteId,
  onOpenThread,
}: {
  remoteId: string;
  onOpenThread: (remoteId: string) => void;
}) {
  return (
    <ThreadListItemPrimitive.Root className="group relative flex items-center gap-1 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted data-[active]:bg-muted">
      <ThreadListItemPrimitive.Trigger
        className="flex-1 min-w-0 truncate text-left"
        onClick={() => onOpenThread(remoteId)}
      >
        <ThreadListItemPrimitive.Title />
      </ThreadListItemPrimitive.Trigger>
      <ThreadListItemMorePrimitive.Root>
        <ThreadListItemMorePrimitive.Trigger
          className="shrink-0 rounded p-1 opacity-0 group-hover:opacity-100 hover:bg-background transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreVertical className="w-4 h-4" />
        </ThreadListItemMorePrimitive.Trigger>
        <ThreadListItemMorePrimitive.Content className="z-50 min-w-[160px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          {historyConfig.archiveEnabled && (
            <ThreadListItemPrimitive.Unarchive asChild>
              <ThreadListItemMorePrimitive.Item className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none hover:bg-muted">
                <ArchiveRestore className="w-4 h-4" /> Unarchive
              </ThreadListItemMorePrimitive.Item>
            </ThreadListItemPrimitive.Unarchive>
          )}
          {historyConfig.deleteEnabled && (
            <ThreadListItemPrimitive.Delete asChild>
              <ThreadListItemMorePrimitive.Item className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-destructive outline-none hover:bg-muted">
                <Trash2 className="w-4 h-4" /> Delete
              </ThreadListItemMorePrimitive.Item>
            </ThreadListItemPrimitive.Delete>
          )}
        </ThreadListItemMorePrimitive.Content>
      </ThreadListItemMorePrimitive.Root>
    </ThreadListItemPrimitive.Root>
  );
}
