import { useState } from "react";
import { useConversationsList } from "@/features/sidebar/hooks/useConversationsList";
import { SidebarThreadRow } from "@/features/sidebar/components/SidebarThreadRow";
import { SidebarSection } from "@/features/sidebar/components/SidebarSection";
import { useDesktopLayout } from "@/features/desktop/state/desktopLayout";
import { sidebarConfig } from "@/config/sidebar";

/**
 * Global conversation search, rendered in place of the Folders / Chats / Recent
 * sections while the search box holds a term.
 *
 * Deliberately UNSCOPED: no `workspaceMode`, no `folderId`. One query therefore
 * covers folder chats, non-folder chats, and both engines (Direct + OpenCode) at
 * once, and the sections keep their contract — a project chat never shows up in
 * "Chats" outside of an active search.
 *
 * Capped per page rather than truncated: `hasMore`/`loadMore` come from the
 * shared hook, so a term matching 200 chats pages through them instead of
 * silently showing the first `searchResultLimit` and implying there are no more.
 */
export function SearchResults({
  search,
  onOpenThread,
  onClearSearch,
}: {
  search: string;
  onOpenThread: (remoteId: string, engine?: string | null) => void;
  onClearSearch: () => void;
}) {
  const copy = sidebarConfig.copy;
  const sidebarSort = useDesktopLayout((s) => s.sidebarSort);
  const showCompleted = useDesktopLayout((s) => s.showCompleted);
  // Section collapse is per-render UI state, not a preference: a search session
  // is transient, so there is nothing worth persisting.
  const [expanded, setExpanded] = useState(true);

  const { items, isLoading, hasMore, loadMore, refetch } = useConversationsList({
    search,
    order: sidebarSort,
    status: showCompleted ? undefined : "regular",
    limit: sidebarConfig.searchResultLimit,
  });

  const showSkeleton = isLoading && items.length === 0;
  const showEmpty = !isLoading && items.length === 0;

  return (
    <SidebarSection
      id="search"
      label={copy.searchResults}
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      {showSkeleton &&
        [0, 1, 2].map((i) => (
          <div key={i} className="h-8 rounded-full bg-muted animate-pulse" />
        ))}

      {items.map((item) => (
        <SidebarThreadRow
          key={item.remoteId}
          item={item}
          onOpenThread={onOpenThread}
          onMutate={refetch}
        />
      ))}

      {showEmpty && (
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

      {hasMore && (
        <button
          type="button"
          onClick={loadMore}
          className="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {copy.loadMore}
        </button>
      )}
    </SidebarSection>
  );
}
