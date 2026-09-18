"use client";

import { useEffect } from "react";
import { useOpenCodePermissions, useOpenCodeSession } from "@assistant-ui/react-opencode";
import { useStalePermissionsStore } from "@/stores/stalePermissionsStore";
import { OPENCODE_PERMISSION_RECONCILE_MS, openCodePermissionPath } from "@/config/opencode";

/**
 * Reconcile the adapter's pending permissions against the server's live list.
 *
 * The adapter's own reconcile (`handleStreamReconnect`) is **add-only** — it
 * never drops an entry the server has forgotten — so a permission that
 * disappeared (the server keeps them in memory only, so a restart orphans one)
 * would survive on screen offering buttons that can only 404. This asks the
 * same **directory-scoped** endpoint the compatibility layer's `permission.list`
 * uses and marks the difference.
 *
 * The directory is mandatory: OpenCode's pending-permission store is
 * directory-scoped, so an unscoped read answers `[]` for a request that exists
 * and would make this retire every live card. With no authoritative directory
 * the reconcile does nothing at all.
 *
 * Only ids pending at the moment of the check are judged, so a request arriving
 * mid-flight is never mislabelled. Best-effort by design: the reply-failure path
 * remains the backstop when this request cannot be made.
 *
 * @param directory - The session's directory, or `null` when unknown.
 * @param fetchImpl - `fetch`-compatible transport (injectable for tests).
 * @returns The ids the server still holds, or `null` when that cannot be known.
 */
export async function fetchLivePermissionIds(
  directory: string | null,
  fetchImpl: typeof fetch,
): Promise<ReadonlySet<string> | null> {
  if (!directory) return null;
  let response: Response;
  try {
    response = await fetchImpl(openCodePermissionPath(directory));
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!Array.isArray(body)) return null;
  const live = new Set<string>();
  for (const item of body) {
    if (item !== null && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
      live.add((item as { id: string }).id);
    }
  }
  return live;
}

/**
 * Retires permission cards the server no longer holds. Mounted by the OpenCode
 * permission surface; see {@link fetchLivePermissionIds} for the contract.
 */
export function useStalePermissionReconcile(): void {
  const { pending } = useOpenCodePermissions();
  const session = useOpenCodeSession();
  const directory = session?.directory ?? null;
  const markStale = useStalePermissionsStore((s) => s.markStale);

  // Stable across unrelated re-renders: only a change in the set of pending ids
  // is worth another round trip. Permission ids are `per_<alnum>`.
  const idsKey = pending
    .map((r) => r.id)
    .sort()
    .join(",");

  useEffect(() => {
    if (!idsKey || !directory) return;
    const checked = idsKey.split(",");
    let cancelled = false;
    const check = async () => {
      const live = await fetchLivePermissionIds(directory, fetch);
      if (cancelled || live === null) return;
      markStale(checked.filter((id) => !live.has(id)));
    };
    void check();
    // One check is not enough: a restart mid-request orphans a permission that
    // is ALREADY pending here, and nothing else would re-trigger a reconcile.
    const interval = setInterval(() => void check(), OPENCODE_PERMISSION_RECONCILE_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [idsKey, directory, markStale]);
}
