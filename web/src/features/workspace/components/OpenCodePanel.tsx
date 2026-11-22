/**
 * Dockview panel for an OpenCode (Code mode) conversation.
 *
 * Only the public `OpenCodeChatHost` is imported — no OpenCode internals cross
 * into generic Dockview infrastructure. The host owns its own isolation
 * boundary, runtime and tool config; this panel only supplies identity,
 * visibility state and the duplicate-mount guard.
 */
import type { IDockviewPanelProps } from "dockview-react";
import { OpenCodeChatHost } from "../../opencode/OpenCodeChatHost";
import { parsePanelParams, type PanelParams } from "../dockviewParams";
import { usePanelVisibility } from "./usePanelVisibility";
import { usePanelMountClaim } from "./usePanelMountClaim";

/** Render an OpenCode conversation host inside its Dockview panel. */
export function OpenCodePanel(props: IDockviewPanelProps<PanelParams>) {
  const params = parsePanelParams(props.params);
  const visible = usePanelVisibility(props.api);

  if (!params || params.contentType !== "opencode") {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-destructive"
        data-testid="dockview-invalid-params"
        data-panel-id={props.api.id}
      >
        This panel has invalid or non-serializable parameters.
      </div>
    );
  }

  const ref = params.tabKey.slice("agent:".length);
  return (
    <BoundOpenCodePanel
      panelId={props.api.id}
      tabKey={params.tabKey}
      refId={ref}
      visible={visible}
    />
  );
}

function BoundOpenCodePanel({
  panelId,
  tabKey,
  refId,
  visible,
}: {
  panelId: string;
  tabKey: string;
  refId: string;
  visible: boolean;
}) {
  const owned = usePanelMountClaim(tabKey);
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
      data-testid="dockview-opencode-panel"
      data-panel-id={panelId}
      data-tab-key={tabKey}
      data-conversation-id={refId}
      data-engine="opencode"
      data-visible={visible}
    >
      {owned ? (
        <OpenCodeChatHost conversationId={refId} />
      ) : (
        <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
          This conversation is already open in another panel.
        </div>
      )}
    </div>
  );
}
