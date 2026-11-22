/**
 * Dockview panel for a bound Direct conversation.
 *
 * The panel id is the canonical tab key (`chat:<ref>`) and params carry only
 * `{ tabKey, contentType }`. `renderer:"always"` is set where the panel is
 * added (see DockviewWorkspace), so hidden panels keep their runtime alive.
 */
import type { IDockviewPanelProps } from "dockview-react";
import { NEW_DRAFT_TAB_ID } from "../../chat/state/chatTabs";
import { parsePanelParams, type PanelParams } from "../dockviewParams";
import { DirectChatHost } from "./DirectChatHost";
import { usePanelVisibility } from "./usePanelVisibility";
import { usePanelMountClaim } from "./usePanelMountClaim";

/** Render a Direct conversation host inside its Dockview panel. */
export function DirectPanel(props: IDockviewPanelProps<PanelParams>) {
  const params = parsePanelParams(props.params);
  const visible = usePanelVisibility(props.api);

  if (params?.contentType !== "direct") {
    return <InvalidPanelParams panelId={props.api.id} />;
  }

  const ref = params.tabKey.slice("chat:".length);
  return (
    <BoundDirectPanel
      panelId={props.api.id}
      tabKey={params.tabKey}
      refId={ref}
      isDraft={ref === NEW_DRAFT_TAB_ID}
      visible={visible}
    />
  );
}

function BoundDirectPanel({
  panelId,
  tabKey,
  refId,
  isDraft,
  visible,
}: {
  panelId: string;
  tabKey: string;
  refId: string;
  isDraft: boolean;
  visible: boolean;
}) {
  const owned = usePanelMountClaim(tabKey);
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
      data-testid="dockview-direct-panel"
      data-panel-id={panelId}
      data-tab-key={tabKey}
      data-conversation-id={refId}
      data-engine="direct"
      data-visible={visible}
    >
      {isDraft ? (
        // Draft materialization is owned by `DraftChatHost`, which wires the
        // runtime's thread-id-change callback to `resolveDraftId`. We do NOT
        // mount it here: the `chat:new` panel is excluded from canonical panel
        // keys, and during the staged migration (plan §5a decision 5) AppShell
        // still renders the routed ChatView with its own new-thread runtime for
        // `/chat/new`. Mounting a second draft runtime here would make both call
        // `adapter.initialize()` on first send and both bind the same id — two
        // runtimes for one draft, breaking the one-shot lifecycle. Phase E's
        // route controller must mount the single `DraftChatHost` only after it
        // removes the routed draft view / root runtime binding.
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
          <span data-testid="draft-panel-notice">New chat draft</span>
          <span>First-send materialization is provided by the draft-aware host in Phase E.</span>
        </div>
      ) : owned ? (
        <DirectChatHost threadId={refId} isDraft={false} />
      ) : (
        <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
          This conversation is already open in another panel.
        </div>
      )}
    </div>
  );
}

function InvalidPanelParams({ panelId }: { panelId: string }) {
  return (
    <div
      className="flex h-full items-center justify-center p-6 text-sm text-destructive"
      data-testid="dockview-invalid-params"
      data-panel-id={panelId}
    >
      This panel has invalid or non-serializable parameters.
    </div>
  );
}
