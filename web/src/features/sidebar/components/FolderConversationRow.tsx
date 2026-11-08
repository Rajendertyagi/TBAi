import { memo } from "react";
import { ChevronDown } from "lucide-react";
import { sidebarConfig } from "@/config/sidebar";
import { useConversationsList } from "@/features/sidebar/hooks/useConversationsList";
import type { Folder } from "@/types";
import { SidebarThreadRow } from "./SidebarThreadRow";

/**
 * A folder's project chats, listed under its header.
 *
 * Reads via `useConversationsList`, scoped to THIS folder's project chats
 * only: `workspaceMode: "project"` pairs with `folderId` so the server pins
 * the membership test, and a hidden `kind='chat'` folder can never leak another
 * folder's chats into this list.
 *
 * Rows are the shared `SidebarThreadRow` — this component owns the list, the
 * loading state and the "show more" tail, nothing about a row's menu.
 */
export const FolderConversationRow = memo(function FolderConversationRow({
  folder,
  activeId,
  onOpenThread,
}: {
  folder: Folder;
  activeId: string | null;
  onOpenThread: (remoteId: string, engine?: string | null) => void;
}) {
  const copy = sidebarConfig.copy;
  const { items, isLoading, hasMore, loadMore, refetch } = useConversationsList({
    status: "regular",
    workspaceMode: "project",
    folderId: folder.id,
    limit: sidebarConfig.folderChatLimit,
  });

  // The folder row already carries the total, so the tail can say how many are
  // left without a second request. Clamped at 0 because the count comes from the
  // folder list and `items` from this list: a chat created between the two
  // requests makes `items` momentarily longer than the count.
  const remaining = Math.max(0, (folder.conversationCount ?? 0) - items.length);

  if (isLoading && items.length === 0) {
    return (
      <div className="space-y-1 py-1" role="status" aria-label="Loading conversations">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-[calc(var(--sidebar-row-height)-4px)] rounded-[var(--sidebar-row-radius)] bg-muted animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-[var(--sidebar-row-height)] items-center pl-2 text-xs text-left text-muted-foreground">
        {copy.noConversations}
      </div>
    );
  }

  return (
    <>
      {items.map((item) => (
        <SidebarThreadRow
          key={item.remoteId}
          item={item}
          onOpenThread={onOpenThread}
          onMutate={refetch}
          activeId={activeId}
        />
      ))}

      {(hasMore || remaining > 0) && (
        <button
          type="button"
          onClick={loadMore}
          className="flex h-[var(--sidebar-row-height)] w-full items-center gap-1.5 rounded-[var(--sidebar-row-radius)] pl-2 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-[var(--sidebar-row-hover-soft)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">
            {remaining > 0 ? copy.showMore(remaining) : copy.loadMore}
          </span>
        </button>
      )}
    </>
  );
});
