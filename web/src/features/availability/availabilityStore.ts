import { create } from "zustand";
import { computeBackoffDelay } from "../../lib/backoff";
import { logger } from "../../lib/logger";

/**
 * ONE frontend availability authority (Phase 3.1).
 *
 * Represents backend reachability as observed through the authoritative
 * `/readyz` probe — never derived from transport-error strings, and never
 * entered by ordinary application errors (400/404/409/422 prove the backend
 * is alive). States:
 * - unknown: no probe has completed yet (boot).
 * - online: `/readyz` answered ready.
 * - degraded: backend reachable but not ready (503 / ready:false), a single
 *   network failure, or an unexpected probe status. Sends may still be
 *   attempted; failures surface honestly per action.
 * - offline: sustained network failure (consecutive threshold). Sends are
 *   refused at the composer with the draft retained.
 *
 * The store also owns the SINGLE readiness poller (Phase 3.2): module-level
 * timer started once from AppShell, jittered backoff while unhealthy, steady
 * cadence while healthy. Recovery listeners run centrally with singleflight
 * (Phase 3.8); data owners subscribe via `recoveryEpoch`, engines via their
 * own existing reconnect boundaries.
 */

export type AvailabilityStatus = "unknown" | "online" | "degraded" | "offline";

interface AvailabilityState {
  status: AvailabilityStatus;
  /** Epoch ms of the last completed probe (success or failure). */
  checkedAt: number | null;
  /** Machine-readable reason for the current non-online state (diagnostics). */
  reason: string | null;
  consecutiveFailures: number;
  /** Bumps once per offline/degraded → online transition; drives refetch. */
  recoveryEpoch: number;
  start: () => void;
  stop: () => void;
  /** Immediate probe (tests, manual recovery affordances). */
  probeNow: () => Promise<void>;
  /** Central recovery subscription. Listener errors never break the loop. */
  onRecovered: (listener: () => void | Promise<void>) => () => void;
}

const READYZ_URL = "/readyz";
const PROBE_TIMEOUT_MS = 10_000;
const HEALTHY_POLL_MS = 15_000;
const OFFLINE_AFTER_FAILURES = 2;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let recoveryListeners = new Set<() => void | Promise<void>>();
let recoveryRunning: Promise<void> | null = null;

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

async function runRecoveryListeners(): Promise<void> {
  if (recoveryRunning) {
    await recoveryRunning;
    return;
  }
  const run = (async () => {
    for (const listener of Array.from(recoveryListeners)) {
      try {
        await listener();
      } catch (err) {
        logger.debug("availability", "recovery listener failed", {
          errorType: err instanceof Error ? err.name : typeof err,
        });
      }
    }
  })();
  recoveryRunning = run;
  try {
    await run;
  } finally {
    recoveryRunning = null;
  }
}

async function probeOnce(): Promise<void> {
  const state = useAvailabilityStore.getState();
  let status: AvailabilityStatus = state.status;
  let reason: string | null = state.reason;
  let failures = state.consecutiveFailures;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(READYZ_URL, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { ready?: unknown } | null;
      if (data?.ready === true) {
        status = "online";
        reason = null;
        failures = 0;
      } else {
        // Reachable but not ready (or unparseable): degraded, not offline.
        status = "degraded";
        reason = "readyz-not-ready";
        failures = 0;
      }
    } else if (res.status === 503) {
      // Reachable but explicitly not ready (DB down): degraded.
      status = "degraded";
      reason = "readyz-503";
      failures = 0;
    } else {
      // Any other status (400/404/409/422/5xx) proves the backend answered:
      // an application-level response, never an offline signal.
      status = "degraded";
      reason = `readyz-status-${res.status}`;
      failures = 0;
    }
  } catch {
    // Network throw / abort: the only path toward offline.
    failures += 1;
    if (failures >= OFFLINE_AFTER_FAILURES) {
      status = "offline";
      reason = "network-failure";
    } else {
      status = "degraded";
      reason = "network-failure-once";
    }
  }

  const wasOnline = useAvailabilityStore.getState().status === "online";
  useAvailabilityStore.setState({
    status,
    checkedAt: Date.now(),
    reason: status === "online" ? null : reason,
    consecutiveFailures: failures,
  });

  if (status === "online" && !wasOnline) {
    useAvailabilityStore.setState((s) => ({ recoveryEpoch: s.recoveryEpoch + 1 }));
    await runRecoveryListeners();
  }
}

function scheduleNext(): void {
  clearTimer();
  if (!started) return;
  const { status, consecutiveFailures } = useAvailabilityStore.getState();
  const delay =
    status === "online" || status === "unknown"
      ? HEALTHY_POLL_MS
      : computeBackoffDelay(consecutiveFailures, { baseMs: BACKOFF_BASE_MS, maxMs: BACKOFF_MAX_MS });
  timer = setTimeout(async () => {
    await probeOnce();
    scheduleNext();
  }, delay);
}

export const useAvailabilityStore = create<AvailabilityState>()(() => ({
  status: "unknown",
  checkedAt: null,
  reason: null,
  consecutiveFailures: 0,
  recoveryEpoch: 0,
  start: () => {
    if (started) return;
    started = true;
    void probeOnce().then(() => scheduleNext());
  },
  stop: () => {
    started = false;
    clearTimer();
  },
  probeNow: async () => {
    await probeOnce();
    scheduleNext();
  },
  onRecovered: (listener) => {
    recoveryListeners.add(listener);
    return () => {
      recoveryListeners.delete(listener);
    };
  },
}));

/** Test-only reset: stops the poller and restores boot state. */
export function resetAvailabilityForTests(): void {
  clearTimer();
  started = false;
  recoveryListeners = new Set();
  recoveryRunning = null;
  useAvailabilityStore.setState({
    status: "unknown",
    checkedAt: null,
    reason: null,
    consecutiveFailures: 0,
    recoveryEpoch: 0,
  });
}
