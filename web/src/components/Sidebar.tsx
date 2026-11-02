import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useLocation, useNavigate } from "react-router";
import { Download, FolderOpenDot, MessageSquarePlus, Plus } from "lucide-react";
import {
  sidebarConfig,
  sectionLabel,
  SIDEBAR_SECTION_IDS,
  type SidebarSectionId,
} from "../config/sidebar";
import { ROUTES } from "../config/navigation";
import { useDesktopLayout } from "../features/desktop/state/desktopLayout";
import { useThreadListQuerySync } from "../features/sidebar/hooks/useThreadListQuerySync";
import { useConversationsList } from "../features/sidebar/hooks/useConversationsList";
import type { UseConversationsListResult } from "../features/sidebar/hooks/useConversationsList";
import { useFoldersStore } from "../features/folders/state/foldersStore";
import { SidebarHeader } from "../features/sidebar/components/SidebarHeader";
import { SidebarNavButton } from "../features/sidebar/components/SidebarNavButton";
import { SidebarSection } from "../features/sidebar/components/SidebarSection";
import { SidebarThreadRow } from "../features/sidebar/components/SidebarThreadRow";
import { FoldersSection } from "../features/sidebar/components/FoldersSection";
import { SearchResults } from "../features/sidebar/components/SearchResults";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { NewProjectChatDialog } from "./NewProjectChatDialog";
import { OpenCodeImportDialog } from "../features/opencode/OpenCodeImportDialog";
import { WorkspaceFolderDialog } from "../features/folders/WorkspaceFolderDialog";
import { shouldNavigateToThread, threadUrl } from "../features/chat/state/chatTabs";

/**
 * Conversation sidebar (codeg `layout/sidebar` parity): fixed `h-10` header
 * (locate / expand-all / view-options), one fixed `New Chat` pill, then the
 * persisted `Folders / Chats` sections. Search lives in the top-left chrome
 * overlay (`LeftEdgeChrome`), never here — the sidebar unmounts on collapse.
 * Data is loaded via `useConversationsList`.
 *
 * Each section is SCOPED server-side and they do not overlap:
 *   Folders -> that folder's project chats
 *   Chats   -> non-folder chats (`workspaceMode: "simple"`)
 * There is no unscoped section, so every conversation appears exactly once.
 * An active search term replaces both with one global result list.
 */
export function Sidebar() {
  const copy = sidebarConfig.copy;
  const navigate = useNavigate();
  const location = useLocation();
  const [addFolderOpen, setAddFolderOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [importOpenCodeOpen, setImportOpenCodeOpen] = useState(false);

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
  const setAllSectionsCollapsed = useDesktopLayout((s) => s.setAllSectionsCollapsed);
  const showCompleted = useDesktopLayout((s) => s.showCompleted);
  const searchQuery = useDesktopLayout((s) => s.searchQuery);
  const setSearchQuery = useDesktopLayout((s) => s.setSearchQuery);
  const sidebarSort = useDesktopLayout((s) => s.sidebarSort);
  const loadFolders = useFoldersStore((s) => s.loadFolders);
  const folderCount = useFoldersStore((s) => s.folders.length);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Folders load here rather than inside `FoldersSection`: the section's count
  // badge must be right even while the section is collapsed and its content is
  // unmounted.
  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  const isExpanded = (id: SidebarSectionId): boolean => {
    return !sectionCollapsed[id];
  };
  // Drop ids retired after a user persisted their order (e.g. the former
  // `archived` section, now a rail surface, and the former `recent` section,
  // dropped when every list became scoped) so a stale entry can never render
  // an empty unknown section.
  const visibleSections = order.filter((id): id is SidebarSectionId =>
    (SIDEBAR_SECTION_IDS as readonly string[]).includes(id),
  );
  const allExpanded = visibleSections.every(isExpanded);

  // `searchQuery` is already debounced in the store, so the sections stay put
  // for the settle window instead of collapsing out from under the user
  // mid-keystroke. Searching swaps the whole section area for one global list.
  const isSearching = searchQuery.trim().length >= sidebarConfig.searchMinLength;
  // The Chats list is owned HERE, not inside `ChatsItems`, because the section
  // header's badge needs the filtered TOTAL even while a search replaces the
  // rows. `enabled` silences the request during a search and re-runs the fetch
  // (effect dependency) when the search ends, so the list is never stale.
  const chats = useConversationsList({
    order: sidebarSort,
    status: showCompleted ? undefined : "regular",
    workspaceMode: "simple",
    enabled: !isSearching,
  });

  return (
    <div className="relative flex w-[var(--sidebar-width,224px)] flex-col border-r border-sidebar-border glass-surface text-sidebar-foreground select-none">
      <SidebarHeader
        listRef={listRef}
        allExpanded={allExpanded}
        onToggleExpandAll={() => setAllSectionsCollapsed(allExpanded)}
      />

      {/* Fixed actions above the scrollable list — never scroll away. */}
      <div className="flex shrink-0 flex-col gap-0.5 px-1.5 pt-1.5">
        <SidebarNavButton
          onClick={() => navigate(ROUTES.CHAT_NEW)}
          aria-keyshortcuts="Control+T Meta+T"
        >
          <Plus aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-left">{copy.newChat}</span>
          {/* Hover-revealed hint, like the search box and the page menu. The key
              is actually bound (ChromeShortcuts → Ctrl/Cmd+T), so it is claimed
              to assistive tech as well as shown. */}
          <span
            aria-hidden="true"
            className="shrink-0 text-2xs tabular-nums text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          >
            {copy.shortcuts.newChat}
          </span>
        </SidebarNavButton>

        <SidebarNavButton
          onClick={() => setImportOpenCodeOpen(true)}
          title="Import an existing OpenCode session"
        >
          <Download aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-left">Import from OpenCode</span>
        </SidebarNavButton>
      </div>

      <WorkspaceFolderDialog open={addFolderOpen} onOpenChange={setAddFolderOpen} />
      <NewProjectChatDialog open={newProjectOpen} onOpenChange={setNewProjectOpen} />
      <OpenCodeImportDialog open={importOpenCodeOpen} onOpenChange={setImportOpenCodeOpen} />

      <div
        ref={listRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 pt-1.5 pb-2"
      >
        <div className="flex flex-col gap-2">
          {isSearching ? (
            <SearchResults
              search={searchQuery}
              onOpenThread={openThread}
              onClearSearch={() => setSearchQuery("")}
            />
          ) : (
            order.map((id) => {
              if (!(SIDEBAR_SECTION_IDS as readonly string[]).includes(id)) return null;
              const expanded = isExpanded(id);
              const setExpanded = (v: boolean) => {
                setSectionCollapsed(id, !v);
              };
              return (
                <SidebarSection
                  key={id}
                  id={id}
                  label={sectionLabel(id)}
                  count={id === "folders" ? folderCount : chats.total}
                  expanded={expanded}
                  onExpandedChange={setExpanded}
                  actions={
                    id === "folders" ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            title={copy.addToSection}
                            aria-label={copy.addToSection}
                            className="flex size-5 items-center justify-center rounded-md text-muted-foreground/90 outline-none transition-colors duration-150 hover:bg-background hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            <Plus className="size-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-44">
                          <DropdownMenuItem onSelect={() => setNewProjectOpen(true)}>
                            <MessageSquarePlus className="size-4" />
                            {copy.newProjectChat}
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setAddFolderOpen(true)}>
                            <FolderOpenDot className="size-4" />
                            {copy.openFolder}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            title={copy.addToSection}
                            aria-label={copy.addToSection}
                            className="flex size-5 items-center justify-center rounded-md text-muted-foreground/90 outline-none transition-colors duration-150 hover:bg-background hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            <Plus className="size-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-44">
                          <DropdownMenuItem onSelect={() => navigate(ROUTES.CHAT_NEW)}>
                            <Plus className="size-4" />
                            {copy.newChat}
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setImportOpenCodeOpen(true)}>
                            <Download className="size-4" />
                            Import from OpenCode
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )
                  }
                >
                  {id === "folders" && <FoldersSection onOpenThread={openThread} />}
                  {id === "chats" && <ChatsItems list={chats} onOpenThread={openThread} />}
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
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = useDesktopLayout.getState().sidebarWidth;
    const onMove = (ev: PointerEvent) => {
      setSidebarWidth(startW + (ev.clientX - startX));
    };
    const onUp = (ev: PointerEvent) => {
      try {
        handle.releasePointerCapture(ev.pointerId);
      } catch {
        // pointer may have already been released
      }
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
 * appear here — folder chats belong to their folder, and nothing else lists
 * them. The list itself is owned by `Sidebar` (its total feeds the section
 * badge); this component only renders it.
 */
function ChatsItems({
  list,
  onOpenThread,
}: {
  list: UseConversationsListResult;
  onOpenThread: (remoteId: string, engine?: string | null) => void;
}) {
  const copy = sidebarConfig.copy;
  const { items, isLoading, hasMore, loadMore, refetch } = list;

  return (
    <div className="relative flex flex-col gap-0.5 pl-3">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1.5 top-0 bottom-2 w-px bg-muted-foreground/20"
      />
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
        <div className="space-y-2 px-1 py-2" role="status" aria-label="Loading conversations">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[var(--sidebar-row-height)] rounded-[var(--sidebar-row-radius)] bg-muted animate-pulse"
            />
          ))}
        </div>
      )}

      {!isLoading && items.length === 0 && (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          {copy.noNonFolderChats}
        </div>
      )}
    </div>
  );
}
