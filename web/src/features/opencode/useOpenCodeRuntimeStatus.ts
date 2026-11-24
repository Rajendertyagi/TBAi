import { useEffect, useRef } from "react";
import { useRuntimeTargetStore, type OpenCodeRuntimeStatus } from "./runtimeStatus";
import {
  acquireRuntimeStatus,
  isConnectedRefreshKey,
  releaseRuntimeStatus,
  updateRuntimeStatusConnection,
} from "./statusResource";

/**
 * Reads which OpenCode service the backend is bound to.
 *
 * This is now a thin selector over the single app-level status resource: the
 * one `GET /api/opencode/status` read is owned by `statusResource.ts`, and every
 * consumer shares its result and error through `useRuntimeTargetStore`. The
 * hook only registers/unregisters the consumer and reports its connection state
 * for the resource's coalesced "first connected consumer" trigger.
 *
 * A failed read KEEPS the previous status (the last mode the backend reported
 * is still the best available fact); the error is surfaced separately.
 *
 * @param enabled - False skips registration entirely and returns empty state.
 * @param refreshKey - The runtime's connection type. Only the aggregate
 *   no-connected → connected transition triggers a shared refresh; individual
 *   connection changes do not.
 */
export function useOpenCodeRuntimeStatus(
  enabled = true,
  refreshKey: string | number = 0,
): {
  readonly status: OpenCodeRuntimeStatus | null;
  readonly error: string | null;
} {
  const status = useRuntimeTargetStore((s) => s.status);
  const error = useRuntimeTargetStore((s) => s.error);

  // Stable identity for this consumer in the resource's connected set.
  const tokenRef = useRef<object | null>(null);
  if (tokenRef.current === null) tokenRef.current = {};
  const token = tokenRef.current;

  const connected = isConnectedRefreshKey(refreshKey);
  const connectedRef = useRef(connected);
  const registeredRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    acquireRuntimeStatus(token, connectedRef.current);
    registeredRef.current = true;
    return () => {
      if (!registeredRef.current) return;
      releaseRuntimeStatus(token, connectedRef.current);
      registeredRef.current = false;
    };
  }, [enabled, token]);

  useEffect(() => {
    if (!enabled || !registeredRef.current) return;
    if (connectedRef.current === connected) return;
    connectedRef.current = connected;
    updateRuntimeStatusConnection(token, connected);
  }, [enabled, connected, token]);

  if (!enabled) return { status: null, error: null };
  return { status, error };
}
