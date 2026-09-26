import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useLocation, useNavigate } from "react-router";
import { FolderOpenDot, MessageSquarePlus, SquarePen } from "lucide-react";
import {
  sidebarConfig,
  SIDEBAR_SECTION_IDS,
  type SidebarSectionId,
} from "../config/sidebar";
import { useDesktopLayout } from "../features/desktop/state/desktopLayout";
import { useThreadListQuerySync } from "../features/sidebar/hooks/useThreadListQuerySync";
import { useConversationsList } from "../features/sidebar/hooks/useConversationsList";
import { SidebarHeader } from "../features/sidebar/components/SidebarHeader";
import { SidebarNavButton } from "../features/sidebar/components/SidebarNavButton";
import { SidebarSection } from "../features/sidebar/components/SidebarSection";
import {
  SidebarThreadRow,
} from "../features/sidebar/components/SidebarThreadRow";
import { FoldersSection } from "../features/sidebar/components/FoldersSection";
import { SearchResults } from "../features/sidebar/components/SearchResults";
import { NewProjectChatDialog } from "./NewProjectChatDialog";
import { WorkspaceFolderDialog } from "../features/folders/WorkspaceFolderDialog";
import { shouldNavigateToThread, threadUrl } from "../features/chat/state/chatTabs";

/**
 * Conversation sidebar (codeg `layout/sidebar` parity): fixed `h-10` header
 * (locate / expand-all / view-options), one fixed `New Chat` pill, then the
 * persisted `Folders / Chats / Recent` sections. Search lives in the
 * top-left chrome overlay (`LeftEdgeChrome`), never here — the sidebar
 * unmounts on collapse. Data is loaded via `useConversationsList`.
 *
 * Each section is SCOPED server-side and they do not overlap:
 *   Folders -> that folder's project chats
 *   Chats   -> non-folder chats (`workspaceMode: "simple"`)
 *   Recent  -> newest N of everything (no scope)
 * An active search term replaces all three with one global result list.
 */
export function Sidebar() {
  const copy = sidebarConfig.copy;
  const navigate = useNavigate();
  const location = useLocation();
  const [addFolderOpen, setAddFolderOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  // Clicking the already-shown conversation must not push an identical
  // history entry; every other open navigates (the route view owns tab
  // opening — the sidebar never creates rows).
  const openThread = useCallback(
    (remoteId: string, engine?: string | null) => {
      if (shouldNavigateToThread(location.pathname, remoteId, engine)) {
        navigate(threadUrl(remoteId, engine));
      }
    },
    [navigate, location.pathname],
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
  const searchQuery = useDesktopLayout((s) => s.searchQuery);
  const setSearchQuery = useDesktopLayout((s) => s.setSearchQuery);
  const listRef = useRef<HTMLDivElement | null>(null);

  const isVisible = (id: SidebarSectionId): boolean => {
    if (id === "folders") return true;
    if (id === "recent") return showRecent;
    return true;
  };
  const isExpanded = (id: SidebarSectionId): boolean => {
    return !sectionCollapsed[id];
  };
  // Drop ids retired after a user persisted their order (e.g. the former
  // `archived` section, now a rail surface) so a stale entry can never
  // render an empty unknown section.
  const visibleSections = order
    .filter((id): id is SidebarSectionId =>
      (SIDEBAR_SECTION_IDS as readonly string[]).includes(id),
    )
    .filter(isVisible);
  const allExpanded = visibleSections.every(isExpanded);
  // `searchQuery` is already debounced in the store, so the sections stay put
  // for the settle window instead of collapsing out from under the user
  // mid-keystroke. Searching swaps the whole section area for one global list.
  const isSearching =
    searchQuery.trim().length >= sidebarConfig.searchMinLength;

  return (
    <div className="relative flex w-[var(--sidebar-width,224px)] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground select-none">
      <SidebarHeader
        listRef={listRef}
        allExpanded={allExpanded}
        onToggleExpandAll={() => setAllSectionsCollapsed(allExpanded)}
      />

      {/* Fixed actions above the scrollable list — never scroll away. */}
      <div className="flex shrink-0 flex-col gap-0.5 px-1.5 pt-1.5">
        <SidebarNavButton onClick={() => navigate("/chat/new")}>
          <SquarePen
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="truncate">{copy.newChat}</span>
        </SidebarNavButton>
      </div>

      <WorkspaceFolderDialog open={addFolderOpen} onOpenChange={setAddFolderOpen} />
      <NewProjectChatDialog open={newProjectOpen} onOpenChange={setNewProjectOpen} />

      <div ref={listRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 pt-1.5 pb-2">
        <div className="flex flex-col gap-2">
          {isSearching ? (
            <SearchResults
              search={searchQuery}
              onOpenThread={openThread}
              onClearSearch={() => setSearchQuery("")}
            />
          ) : (
            order.map((id) => {
              if (!isVisible(id)) return null;
              const expanded = isExpanded(id);
              const setExpanded = (v: boolean) => {
                setSectionCollapsed(id, !v);
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
                        : copy.recent
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
                      showCompleted={showCompleted}
                      onOpenThread={openThread}
                    />
                  )}
                  {id === "recent" && (
                    <RecentItems showCompleted={showCompleted} onOpenThread={openThread} />
                  )}
                </SidebarSection>
              );
            })
          )}
        </div>
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

/**
 * Non-folder ("simple") threads with session paging + empty state.
 *
 * Scoped server-side to `workspaceMode: "simple"` so a project chat can never
 * appear here — folder chats belong to their folder, and Recent covers both.
 */
function ChatsItems({
  showCompleted,
  onOpenThread,
}: {
  showCompleted: boolean;
  onOpenThread: (remoteId: string, engine?: string | null) => void;
}) {
  const copy = sidebarConfig.copy;
  const sidebarSort = useDesktopLayout((s) => s.sidebarSort);

  const { items, isLoading, hasMore, loadMore, refetch } = useConversationsList({
    // `sidebarSort` is already "updated" | "created" — the same values the
    // server accepts — so it passes straight through with no translation.
    order: sidebarSort,
    status: showCompleted ? undefined : "regular",
    workspaceMode: "simple",
  });

  return (
    <>
      {items.map((item) => (
        <SidebarThreadRow
          key={item.remoteId}
          item={item}
          onOpenThread={onOpenThread}
          onMutate={refetch}
        />
      ))}

      {hasMore && (
        <button
          type="button"
          onClick={loadMore}
          className="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {copy.loadMore}
        </button>
      )}

      {isLoading && items.length === 0 && (
        <div className="space-y-2 px-1 py-2" aria-label="Loading conversations">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 rounded-full bg-muted animate-pulse" />
          ))}
        </div>
      )}

      {!isLoading && items.length === 0 && (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          {copy.noNonFolderChats}
        </div>
      )}
    </>
  );
}

/**
 * Newest N threads of ALL kinds — folder and non-folder, both engines — capped
 * at `recentSectionLimit`. Unscoped on purpose: this is the one section that
 * answers "what did I touch lately", regardless of where it lives.
 */
function RecentItems({
  showCompleted,
  onOpenThread,
}: {
  showCompleted: boolean;
  onOpenThread: (remoteId: string, engine?: string | null) => void;
}) {
  const sidebarSort = useDesktopLayout((s) => s.sidebarSort);
  const { items, refetch } = useConversationsList({
    order: sidebarSort,
    status: showCompleted ? undefined : "regular",
    limit: sidebarConfig.recentSectionLimit,
  });

  return (
    <>
      {items.slice(0, sidebarConfig.recentSectionLimit).map((item) => (
        <SidebarThreadRow
          key={item.remoteId}
          item={item}
          onOpenThread={onOpenThread}
          onMutate={refetch}
        />
      ))}
    </>
  );
}


