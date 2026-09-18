import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useNavigate } from "react-router";
import {
  ThreadListPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { FolderOpenDot, MessageSquarePlus, SquarePen } from "lucide-react";
import { sidebarConfig, type SidebarSectionId } from "../config/sidebar";
import { historyConfig } from "../config/history";
import { dateGroupLabel } from "../lib/sidebar-sections";
import { useDesktopLayout } from "../features/desktop/state/desktopLayout";
import { useThreadListQuerySync } from "../features/sidebar/hooks/useThreadListQuerySync";
import { SidebarHeader } from "../features/sidebar/components/SidebarHeader";
import { SidebarNavButton } from "../features/sidebar/components/SidebarNavButton";
import { SidebarSection } from "../features/sidebar/components/SidebarSection";
import {
  SidebarArchivedRow,
  SidebarThreadRow,
} from "../features/sidebar/components/SidebarThreadRow";
import { FoldersSection } from "../features/sidebar/components/FoldersSection";
import { NewProjectChatDialog } from "./NewProjectChatDialog";
import { WorkspaceFolderDialog } from "../features/folders/WorkspaceFolderDialog";
import { threadUrl } from "../features/chat/state/chatTabs";

interface RowData {
  remoteId: string;
  title?: string;
  status?: string;
  lastMessageAt?: Date;
  /** Engine for route selection (chat vs code surface). Null = legacy Direct. */
  engine?: string | null;
}

/**
 * Conversation sidebar (codeg `layout/sidebar` parity): fixed `h-10` header
 * (locate / expand-all / view-options), one fixed `New Chat` pill, then the
 * persisted `Chats / Recent / Archived` sections. Search lives in the
 * top-left chrome overlay (`LeftEdgeChrome`), never here — the sidebar
 * unmounts on collapse. Thread data stays runtime-owned (`Items` render
 * props); the store owns only view preferences (sort/order/collapse/query).
 */
export function Sidebar() {
  const copy = sidebarConfig.copy;
  const navigate = useNavigate();
  const [addFolderOpen, setAddFolderOpen] = useState(false);
  // "New Project Chat" dialog (folder picker + engine switch). Trigger lives
  // in the Folders section header actions, next to "Open folder" — the dialog
  // existed unwired since its creation, which locked folder chats to Direct.
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  // Thread switching itself is done by the row trigger; this only moves the
  // URL (ChatView/OpenCodeView opens the matching tab, the runtime switches
  // threads, onThreadIdChange confirms the tab store). The route follows the
  // conversation engine so Code threads open on the Code surface.
  const openThread = useCallback(
    (remoteId: string, engine?: string | null) =>
      navigate(threadUrl(remoteId, engine)),
    [navigate],
  );
  useThreadListQuerySync();

  const order = useDesktopLayout((s) => s.sectionOrder);
  const sectionCollapsed = useDesktopLayout((s) => s.sectionCollapsed);
  const setSectionCollapsed = useDesktopLayout((s) => s.setSectionCollapsed);
  const setAllSectionsCollapsed = useDesktopLayout(
    (s) => s.setAllSectionsCollapsed,
  );
  const showRecent = useDesktopLayout((s) => s.showRecent);
  const showCompleted = useDesktopLayout((s) => s.showCompleted);
  const archivedExpanded = useDesktopLayout((s) => s.archivedExpanded);
  const setArchivedExpanded = useDesktopLayout((s) => s.setArchivedExpanded);
  const searchQuery = useDesktopLayout((s) => s.searchQuery);
  const setSearchQuery = useDesktopLayout((s) => s.setSearchQuery);
  const listRef = useRef<HTMLDivElement | null>(null);

  const isVisible = (id: SidebarSectionId): boolean => {
    if (id === "folders") return true; // Always visible (empty hint when no folders)
    if (id === "recent") return showRecent;
    if (id === "archived") return historyConfig.archiveEnabled;
    return true;
  };
  const isExpanded = (id: SidebarSectionId): boolean => {
    if (id === "archived") return archivedExpanded;
    return !sectionCollapsed[id];
  };
  const visibleSections = order.filter(isVisible);
  const allExpanded = visibleSections.every(isExpanded);

  return (
    <div className="relative flex w-[var(--sidebar-width,224px)] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground select-none">
      <SidebarHeader
        listRef={listRef}
        allExpanded={allExpanded}
        onToggleExpandAll={() => setAllSectionsCollapsed(allExpanded)}
      />

      {/* Fixed actions above the scrollable list — never scroll away. */}
      <div className="flex shrink-0 flex-col gap-0.5 px-1.5 pt-1.5">
        <ThreadListPrimitive.New asChild>
          <SidebarNavButton onClick={() => navigate("/chat/new")}>
            <SquarePen
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="truncate">{copy.newChat}</span>
          </SidebarNavButton>
        </ThreadListPrimitive.New>
      </div>

      <WorkspaceFolderDialog open={addFolderOpen} onOpenChange={setAddFolderOpen} />
      <NewProjectChatDialog open={newProjectOpen} onOpenChange={setNewProjectOpen} />

      <div ref={listRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 pt-1.5 pb-2">
        <ThreadListPrimitive.Root className="flex flex-col gap-2">
          {order.map((id) => {
            if (!isVisible(id)) return null;
            const expanded = isExpanded(id);
            const setExpanded = (v: boolean) => {
              if (id === "archived") setArchivedExpanded(v);
              else setSectionCollapsed(id, !v);
            };
            return (
              <SidebarSection
                key={id}
                id={id}
                label={
                  id === "folders"
                    ? copy.folders
                    : id === "chats"
                      ? copy.chats
                      : id === "recent"
                        ? copy.recent
                        : copy.archived
                }
                expanded={expanded}
                onExpandedChange={setExpanded}
                actions={
                  id === "folders" ? (
                    <div className="flex items-center">
                      <button
                        type="button"
                        onClick={() => setNewProjectOpen(true)}
                        title={copy.newProjectChat}
                        aria-label={copy.newProjectChat}
                        className="flex size-6 items-center justify-end rounded-[0.375rem] cursor-pointer text-muted-foreground/90 outline-none transition-[color] duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      >
                        <MessageSquarePlus className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setAddFolderOpen(true)}
                        title="Open folder"
                        aria-label="Open folder"
                        className="flex size-6 items-center justify-end rounded-[0.375rem] cursor-pointer text-muted-foreground/90 outline-none transition-[color] duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      >
                        <FolderOpenDot className="size-3.5" />
                      </button>
                    </div>
                  ) : undefined
                }
              >
                {id === "folders" && <FoldersSection />}
                {id === "chats" && (
                  <ChatsItems
                    search={searchQuery}
                    showCompleted={showCompleted}
                    onOpenThread={openThread}
                    onOpenArchive={() => setArchivedExpanded(true)}
                    onClearSearch={() => setSearchQuery("")}
                  />
                )}
                {id === "recent" && (
                  <RecentItems search={searchQuery} showCompleted={showCompleted} onOpenThread={openThread} />
                )}
                {id === "archived" && expanded && (
                  <ArchivedItems onOpenThread={openThread} />
                )}
              </SidebarSection>
            );
          })}
        </ThreadListPrimitive.Root>
      </div>

      <SidebarResizeHandle />
    </div>
  );
}

function SidebarResizeHandle() {
  const setSidebarWidth = useDesktopLayout((s) => s.setSidebarWidth);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = useDesktopLayout.getState().sidebarWidth;
    const onMove = (ev: PointerEvent) => {
      setSidebarWidth(startW + (ev.clientX - startX));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      onPointerDown={onPointerDown}
      className="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize select-none hover:bg-primary/30"
    />
  );
}

function toRowData(value: {
  remoteId?: string;
  title?: string;
  status?: string;
  lastMessageAt?: Date;
  custom?: { engine?: string | null };
}): RowData | null {
  if (!value.remoteId) return null;
  return {
    remoteId: value.remoteId,
    title: value.title,
    status: value.status,
    lastMessageAt: value.lastMessageAt,
    engine: value.custom?.engine ?? null,
  };
}

/** Date-grouped regular threads with session paging + empty/error states. */
function ChatsItems({
  search,
  showCompleted,
  onOpenThread,
  onOpenArchive,
  onClearSearch,
}: {
  search: string;
  showCompleted: boolean;
  onOpenThread: (remoteId: string, engine?: string | null) => void;
  onOpenArchive: () => void;
  onClearSearch: () => void;
}) {
  const copy = sidebarConfig.copy;
  const isLoading = useAuiState((s) => s.threads.isLoading);
  const count = useAuiState((s) => s.threads.threadIds.length);
  // Store-level match count for the no-matches state (exact on every render;
  // the render-prop counter below only limits output, it can't drive UI).
  // Anti-flood: only the first pages render; old chats stay discoverable
  // through search (server-side) instead of an enormous permanent list.
  // Session-only (resets on reload).
  const [page, setPage] = useState(0);
  const shownCount = useRef(0);
  shownCount.current = 0;
  const lastGroup = useRef<string | null>(null);
  lastGroup.current = null;
  // Reset the page when the filter changes so matches aren't hidden.
  const [lastQuery, setLastQuery] = useState(search);
  if (lastQuery !== search) {
    setLastQuery(search);
    setPage(0);
  }
  const limit = (page + 1) * sidebarConfig.chatsPageSize;
  const query = search.trim().toLowerCase();
  const matchCount = useAuiState((s) =>
    query
      ? s.threads.threadItems.filter(
          (t) =>
            (showCompleted || t.status === "regular") &&
            t.custom?.workspaceMode !== "project" &&
            (t.title ?? "").toLowerCase().includes(query),
        ).length
      : -1,
  );

  return (
    <>
      <ThreadListPrimitive.Items>
        {({ threadListItem }) => {
          const item = toRowData(threadListItem);
          if (!item) return null;
          // Project conversations render under their folder header in the
          // Folders section, not here. Only show simple-chat (folderless) items.
          if (threadListItem.custom?.workspaceMode === "project") return null;
          // Hide archived conversations when "show completed" is off.
          if (
            !showCompleted &&
            (threadListItem.status === "archived")
          )
            return null;
          if (query && !(item.title ?? "").toLowerCase().includes(query)) {
            return null;
          }
          if (shownCount.current >= limit) return null;
          shownCount.current += 1;
          const group = historyConfig.dateGrouping
            ? dateGroupLabel(item.lastMessageAt)
            : null;
          const showHeader = group !== null && group !== lastGroup.current;
          if (showHeader) lastGroup.current = group;
          return (
            <div key={item.remoteId}>
              {showHeader && (
                <div className="px-3 pt-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {group}
                </div>
              )}
              <SidebarThreadRow item={item} onOpenThread={onOpenThread} />
            </div>
          );
        }}
      </ThreadListPrimitive.Items>

      {count > limit && (
        <button
          type="button"
          onClick={() => setPage((n) => n + 1)}
          className="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {copy.showMore(count - limit)}
        </button>
      )}

      {isLoading && count === 0 && (
        <div className="space-y-2 px-1 py-2" aria-label="Loading conversations">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 rounded-full bg-muted animate-pulse" />
          ))}
        </div>
      )}

      {!isLoading && count === 0 && !query && (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          {copy.noConversations}
          {historyConfig.archiveEnabled && (
            <button
              type="button"
              onClick={onOpenArchive}
              className="mx-auto mt-1 block text-foreground underline"
            >
              {copy.browseArchived}
            </button>
          )}
        </div>
      )}

      {!isLoading && query && matchCount === 0 && (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          {copy.noMatches}
          <button
            type="button"
            onClick={onClearSearch}
            className="mx-auto mt-1 block text-foreground underline"
          >
            {copy.clearSearch}
          </button>
        </div>
      )}

      {/* Official pagination: renders only when another page exists. */}
      <ThreadListPrimitive.LoadMore asChild>
        <button
          type="button"
          className="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {copy.loadMore}
        </button>
      </ThreadListPrimitive.LoadMore>
    </>
  );
}

/**
 * Flat newest-first regular threads, capped at `recentSectionLimit`. The
 * runtime serves newest-first (server `?order=`), so the first N items are
 * the recent ones — no client reorder needed.
 */
function RecentItems({
  search,
  showCompleted,
  onOpenThread,
}: {
  search: string;
  showCompleted: boolean;
  onOpenThread: (remoteId: string, engine?: string | null) => void;
}) {
  const shownCount = useRef(0);
  shownCount.current = 0;
  const query = search.trim().toLowerCase();

  return (
    <ThreadListPrimitive.Items>
      {({ threadListItem }) => {
        const item = toRowData(threadListItem);
        if (!item) return null;
        // Project conversations render under their folder header.
        if (threadListItem.custom?.workspaceMode === "project") return null;
        // Hide archived conversations when "show completed" is off.
        if (!showCompleted && threadListItem.status === "archived") return null;
        if (query && !(item.title ?? "").toLowerCase().includes(query)) {
          return null;
        }
        if (shownCount.current >= sidebarConfig.recentSectionLimit) return null;
        shownCount.current += 1;
        return (
          <SidebarThreadRow
            key={item.remoteId}
            item={item}
            onOpenThread={onOpenThread}
          />
        );
      }}
    </ThreadListPrimitive.Items>
  );
}

function ArchivedItems({
  onOpenThread,
}: {
  onOpenThread: (remoteId: string, engine?: string | null) => void;
}) {
  return (
    <ThreadListPrimitive.Items archived>
      {({ threadListItem }) =>
        threadListItem.remoteId ? (
          <SidebarArchivedRow
            key={threadListItem.remoteId}
            remoteId={threadListItem.remoteId}
            engine={
              (threadListItem.custom as { engine?: string | null } | undefined)
                ?.engine ?? null
            }
            onOpenThread={onOpenThread}
          />
        ) : null
      }
    </ThreadListPrimitive.Items>
  );
}

