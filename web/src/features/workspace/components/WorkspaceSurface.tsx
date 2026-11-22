import { useMemo } from "react";
import { useWorkspacePanels } from "../state/workspacePanels";
import { DirectChatHost } from "./DirectChatHost";
import { NEW_DRAFT_TAB_ID, parseTabKey } from "../../chat/state/chatTabs";

/**
 * Renders optional workspace panels as STABLE, KEYED siblings under one parent.
 *
 * Each host is keyed by its panel id (stable identity). Visual position is CSS
 * `order`, driven by the panel's `order` field. Moving a panel changes only that
 * number — React never reparents or remounts the host, so its runtime/session
 * survives the move. Closing a panel unmounts only that host.
 */
export function WorkspaceSurface() {
  const panels = useWorkspacePanels((s) => s.panels);
  const sorted = useMemo(() => [...panels].sort((a, b) => a.order - b.order), [panels]);
  if (sorted.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-1 flex-row overflow-hidden" data-testid="workspace-surface">
      {sorted.map((panel) => {
        const parsed = parseTabKey(panel.tabKey);
        // Only BOUND Direct chat tabs are rendered by this host. Drafts are
        // excluded: materializing one must run through the primary runtime's
        // tab-store binding, which a panel host does not own. OpenCode content
        // keeps its own dedicated surface (separate runtime).
        if (parsed?.kind !== "chat" || parsed.ref === NEW_DRAFT_TAB_ID) return null;
        return (
          <div
            key={panel.id}
            data-testid={`workspace-panel-${panel.id}`}
            data-panel-id={panel.id}
            className="flex min-w-0 flex-1 flex-col overflow-hidden border-l border-border"
            style={{ order: panel.order }}
          >
            <DirectChatHost threadId={parsed.ref} />
          </div>
        );
      })}
    </div>
  );
}
