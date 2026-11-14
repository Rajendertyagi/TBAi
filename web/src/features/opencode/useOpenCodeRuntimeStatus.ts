import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/platform";
import { useAvailabilityStore } from "../availability/availabilityStore";
import {
  publishRuntimeStatus,
  readOpenCodeRuntimeStatus,
  useRuntimeTargetStore,
  type OpenCodeRuntimeStatus,
} from "./runtimeStatus";
import { acquireRuntimeTargetEvents, releaseRuntimeTargetEvents } from "./runtimeTargetEvents";

/**
 * Reads which OpenCode service the backend is bound to.
 *
 * The status is a snapshot of an install, not a stream: the backend changes it
 * only by adopting a service at startup or by falling back to a managed one,
 * and both already make the transport reconnect. So the read happens on mount
 * and again when the backend becomes reachable, never on a timer — a poll here
 * would report the same mode forever while costing a request per interval.
 *
 * A failed read KEEPS the previous status. The last mode the backend reported
 * is still the best available fact, and erasing it would make every surface
 * fall back to "unknown" during a transient blip after the reader's Code mode
 * reconnected successfully.
 *
 * @param enabled - False skips the request entirely (and clears the status).
 * @param refreshKey - A value whose CHANGE re-reads the status. The chip passes
 *   the runtime's connection type: a connection that just became `connected`
 *   proves the backend installed a target (the lazily-started managed service),
 *   so the mode read at mount is stale by then. Mode changes happen only at
 *   startup and on fallback, which are not events a timer could observe
 *   cheaply.
 */
export function useOpenCodeRuntimeStatus(
  enabled = true,
  refreshKey: string | number = 0,
): {
  readonly status: OpenCodeRuntimeStatus | null;
  readonly error: string | null;
} {
  const [status, setStatus] = useState<OpenCodeRuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The backend returning is the one event that can change the mode without the
  // browser having caused it (a fallback after a confirmed loss).
  const recoveryEpoch = useAvailabilityStore((s) => s.recoveryEpoch);
  const observedTarget = useRuntimeTargetStore((s) => s.status);
  const [targetRefreshNonce, setTargetRefreshNonce] = useState(0);
  const lastFetchedTargetRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    acquireRuntimeTargetEvents();
    return () => {
      releaseRuntimeTargetEvents();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !observedTarget) return;
    const key = `${observedTarget.targetRevision}:${observedTarget.targetId ?? "null"}:${observedTarget.mode}`;
    if (lastFetchedTargetRef.current === key) return;
    // A runtime target lifecycle notification arrived (or was published) with a
    // target identity this hook has not fetched yet; refetch authoritative status.
    setTargetRefreshNonce((n) => n + 1);
  }, [enabled, observedTarget]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `recoveryEpoch` and `targetRefreshNonce` are refetch triggers. Availability recovery and runtime target lifecycle events change no prop this effect observes, but a stale status must be re-read when they occur.
  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      setError(null);
      lastFetchedTargetRef.current = null;
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    apiFetch("/api/opencode/status", { signal: controller.signal })
      .then(readOpenCodeRuntimeStatus)
      .then((next) => {
        if (cancelled) return;
        lastFetchedTargetRef.current = `${next.targetRevision}:${next.targetId ?? "null"}:${next.mode}`;
        setStatus(next);
        setError(null);
        publishRuntimeStatus(next);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // Deliberate aborts are owner teardown, not failures: stay silent so
        // no error flashes for a navigation the user already left.
        if (cause instanceof Error && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, recoveryEpoch, refreshKey, targetRefreshNonce]);

  return { status, error };
}
