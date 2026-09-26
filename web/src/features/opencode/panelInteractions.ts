import type { V2PermissionView } from "./v2Permissions";

/** Selects native permissions that have no assistant-ui tool card. */
export function unlinkedPendingPermissions(
  pending: readonly V2PermissionView[],
  stale: ReadonlySet<string>,
): V2PermissionView[] {
  return pending.filter((request) => request.toolCallId === null && !stale.has(request.id));
}
