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
import { DraftChatHost } from "./DraftChatHost";
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
        // Phase E: the routed draft view and AppShell's root runtime binding
        // are gone, so this panel is the ONE place a draft runtime is mounted.
        // `DraftChatHost` wires the runtime's thread-id-change callback to
        // `resolveDraftId`; the panel id stays `chat:new` across materialization
        // (see DockviewWorkspace's draft alias), so the live runtime is never
        // disposed mid-send. The duplicate-mount claim below still guards
        // against a second host for the same canonical key.
        owned ? (
          <DraftChatHost />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
            This draft is already open in another panel.
          </div>
        )
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
