import { useCallback, useEffect, useState } from "react";

/** How often liveness is re-checked (cheap same-origin read). */
export const SERVER_STATUS_POLL_INTERVAL_MS = 15000;

export interface ServerIdentity {
  activePort: number;
  configuredPort: number;
  persistedPort: number | null;
  envLocked: boolean;
}

/**
 * Shared live identity of the single TBAi web server: which port is active
 * and whether it answers. Consumed by the status bar (dot + port) and the
 * Desktop → Web server settings section — one fetch pattern, cheap pollers,
 * no new backend. `reachable === null` until the first check settles.
 */
export function useServerIdentity(poll = true): {
  identity: ServerIdentity | null;
  reachable: boolean | null;
  checkedAt: number | null;
  loadError: string | null;
  reload: () => Promise<void>;
} {
  const [identity, setIdentity] = useState<ServerIdentity | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/server", { cache: "no-store" });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const data = (await res.json()) as ServerIdentity;
      setIdentity(data);
      setReachable(true);
      setCheckedAt(Date.now());
      setLoadError(null);
    } catch (err: unknown) {
      setReachable(false);
      setCheckedAt(Date.now());
      setLoadError(
        err instanceof Error ? err.message : "Could not read server state.",
      );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void reload();
    if (!poll) return;
    const timer = setInterval(() => {
      if (!cancelled) void reload();
    }, SERVER_STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [poll, reload]);

  return { identity, reachable, checkedAt, loadError, reload };
}
