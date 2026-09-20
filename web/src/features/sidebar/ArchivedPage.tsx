import { useCallback } from "react";
import { useNavigate } from "react-router";
import { getNavItem } from "@/config/navigation";
import { sidebarConfig } from "@/config/sidebar";
import { useConversationsList } from "./hooks/useConversationsList";
import { SidebarArchivedRow } from "./components/SidebarThreadRow";
import { threadUrl } from "../chat/state/chatTabs";

/**
 * Archived conversations workbench surface (rail icon, `/archived`).
 *
 * The sidebar keeps Folders → Chats → Recent only; archived threads live
 * here instead, reusing the same list hook and archived row (with unarchive
 * actions) the sidebar section used to render. Opening a thread navigates
 * to its engine route exactly like the sidebar did.
 */
export function ArchivedPage() {
  const copy = sidebarConfig.copy;
  const navigate = useNavigate();
  const title = getNavItem("archived")?.label ?? copy.archived;

  const openThread = useCallback(
    (remoteId: string, engine?: string | null) =>
      navigate(threadUrl(remoteId, engine)),
    [navigate],
  );

  const { items, refetch } = useConversationsList({ status: "archived" });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <h1 className="text-sm font-semibold">{title}</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {items.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {copy.noConversations}
          </div>
        ) : (
          items.map((item) => (
            <SidebarArchivedRow
              key={item.remoteId}
              remoteId={item.remoteId}
              title={item.title}
              engine={item.engine}
              onOpenThread={openThread}
              onMutate={refetch}
            />
          ))
        )}
      </div>
    </div>
  );
}
