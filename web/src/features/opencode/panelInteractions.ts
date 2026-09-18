import type { OpenCodePermissionRequest } from "@assistant-ui/react-opencode";

/**
 * Which pending permissions the Code-mode panel must surface.
 *
 * The panel is a **fallback**, never a history. A request linked to a tool call
 * already renders its approval on that tool's card inside the message — the same
 * place direct chat renders approvals — so listing it above the chat as well
 * would show one decision twice. A request the server no longer holds can never
 * be answered, so it is retired rather than offered.
 *
 * Resolved requests are deliberately absent from this selector: the panel must
 * never accumulate answered rows. A decided request belongs to its tool card.
 *
 * Kept as a pure function (not inline JSX) so the fate table above is
 * assertable without rendering the runtime-bound component.
 *
 * @param pending - Every pending permission request the adapter holds.
 * @param stale - Ids the server no longer holds (see `stalePermissionsStore`).
 * @returns The pending requests that have no tool card, in their original order.
 */
export function unlinkedPendingPermissions(
  pending: readonly OpenCodePermissionRequest[],
  stale: ReadonlySet<string>,
): OpenCodePermissionRequest[] {
  return pending.filter(
    (request) => !request.tool?.callID && !stale.has(request.id),
  );
}
