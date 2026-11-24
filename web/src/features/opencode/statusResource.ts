/**
 * The single app-level owner of the `GET /api/opencode/status` read.
 *
 * Every OpenCode panel mounts an `OpenCodeStatus` chip, and the config page
 * mounts one more. The endpoint reports install-wide runtime status, so reading
 * it per chip repeats the same app-wide request a dozen times. This module owns
 * that one request and publishes the result (and any read error) to the shared
 * `useRuntimeTargetStore`; consumers only subscribe.
 *
 * Refetch triggers are coalesced: recovery-epoch changes, runtime-target
 * identity changes, and the aggregate "no connected consumer → at least one
 * connected consumer" transition each request one refresh, and several triggers
 * in the same tick share a single request. A generation counter keeps an older
 * in-flight response from overwriting a newer target notification.
 */

import { apiFetch } from "../../lib/platform";
import { useAvailabilityStore } from "../availability/availabilityStore";
import {
  publishRuntimeStatus,
  readOpenCodeRuntimeStatus,
  useRuntimeTargetStore,
  type OpenCodeRuntimeStatus,
} from "./runtimeStatus";
import { acquireRuntimeTargetEvents, releaseRuntimeTargetEvents } from "./runtimeTargetEvents";

/** The one connection type that means an active OpenCode runtime connection. */
const CONNECTED_REFRESH_KEY = "connected";

let activeSubscribers = 0;
/** Tokens of the currently-connected consumers (identity, not a per-runtime string). */
const connectedConsumers = new Set<object>();
let requestGeneration = 0;
let currentController: AbortController | null = null;
let refreshScheduled = false;
/** Target identity already reflected in the store; guards self-triggered refetches. */
let lastObservedTargetKey: string | null = null;
/** True only while this module applies its own fetch result to the store. */
let applyingFetchResult = false;

function isConnected(refreshKey: string | number): boolean {
  return refreshKey === CONNECTED_REFRESH_KEY;
}

function targetKey(status: OpenCodeRuntimeStatus | null): string | null {
  if (!status) return null;
  return `${status.backendInstanceId}:${status.targetRevision}:${status.targetId ?? "null"}:${status.mode}`;
}

function currentRecoveryEpoch(): number {
  return useAvailabilityStore.getState().recoveryEpoch;
}

/** Runs the authoritative status read, superseding any older in-flight read. */
function startFetch(): void {
  if (activeSubscribers <= 0) return;

  currentController?.abort();
  const controller = new AbortController();
  currentController = controller;
  requestGeneration += 1;
  const generation = requestGeneration;
  const requestEpoch = currentRecoveryEpoch();

  apiFetch("/api/opencode/status", { signal: controller.signal })
    .then(readOpenCodeRuntimeStatus)
    .then((next) => {
      if (generation !== requestGeneration) return;
      // The store subscription fires synchronously on publish. Suppress it while
      // applying our own result, then adopt the key the store ACTUALLY accepted:
      // publishRuntimeStatus may reject this status in favour of a newer one, and
      // leaving our older key here would make the error write below look like a
      // target change and schedule a redundant refresh.
      applyingFetchResult = true;
      try {
        publishRuntimeStatus(next, requestEpoch);
      } finally {
        applyingFetchResult = false;
      }
      lastObservedTargetKey = targetKey(useRuntimeTargetStore.getState().status);
      useRuntimeTargetStore.setState({ error: null });
    })
    .catch((cause: unknown) => {
      if (generation !== requestGeneration) return;
      // Deliberate aborts are supersession, not failures: stay silent.
      if (cause instanceof Error && cause.name === "AbortError") return;
      // A failed read keeps the last status; only the error is published.
      useRuntimeTargetStore.setState({
        error: cause instanceof Error ? cause.message : String(cause),
      });
    })
    .finally(() => {
      if (generation === requestGeneration) currentController = null;
    });
}

/** Coalesces every trigger raised in one tick into a single authoritative read. */
function scheduleRefresh(): void {
  if (activeSubscribers <= 0 || refreshScheduled) return;
  refreshScheduled = true;
  queueMicrotask(() => {
    refreshScheduled = false;
    if (activeSubscribers <= 0) return;
    startFetch();
  });
}

// Backend recovery is an independent refresh trigger: the mode can change
// without the browser causing it (a fallback after a confirmed loss).
useAvailabilityStore.subscribe((state, prev) => {
  if (state.recoveryEpoch === prev.recoveryEpoch) return;
  scheduleRefresh();
});

// Runtime-target lifecycle events publish a new identity into this store. A
// changed identity means the mount-time read is stale and must be re-read.
useRuntimeTargetStore.subscribe((state) => {
  if (applyingFetchResult) return;
  const next = state.status;
  if (!next) return;
  const key = targetKey(next);
  if (key === lastObservedTargetKey) return;
  lastObservedTargetKey = key;
  scheduleRefresh();
});

/**
 * Registers an enabled consumer. The first subscriber acquires the shared
 * runtime-target event source and triggers the mount read; a later subscriber
 * triggers a read only when it is the first connected consumer.
 */
export function acquireRuntimeStatus(token: object, connected: boolean): void {
  const wasConnected = connectedConsumers.size > 0;
  if (connected) connectedConsumers.add(token);
  const isFirst = activeSubscribers === 0;
  activeSubscribers += 1;
  if (isFirst) acquireRuntimeTargetEvents();
  if (isFirst || (!wasConnected && connectedConsumers.size > 0)) scheduleRefresh();
}

/** Updates one consumer's reported connection state; only false→true refreshes. */
export function updateRuntimeStatusConnection(token: object, connected: boolean): void {
  const wasConnected = connectedConsumers.size > 0;
  if (connected) connectedConsumers.add(token);
  else connectedConsumers.delete(token);
  if (!wasConnected && connectedConsumers.size > 0) scheduleRefresh();
}

/** Unregisters a consumer. Never clears the shared status or error. */
export function releaseRuntimeStatus(token: object, connected: boolean): void {
  if (connected) connectedConsumers.delete(token);
  if (activeSubscribers > 0) {
    activeSubscribers -= 1;
    if (activeSubscribers === 0) releaseRuntimeTargetEvents();
  }
}

/** Test-only reset of subscriber, connection, and request tracking. */
export function resetStatusResourceForTests(): void {
  // Release exactly the event leases this resource acquired. releaseRuntimeTargetEvents
  // clamps its refcount at zero, so a following resetRuntimeTargetEventsForTests()
  // in the test's afterEach is harmless (disconnect is idempotent).
  for (let i = 0; i < activeSubscribers; i += 1) {
    releaseRuntimeTargetEvents();
  }
  activeSubscribers = 0;
  connectedConsumers.clear();
  refreshScheduled = false;
  requestGeneration += 1;
  currentController = null;
  lastObservedTargetKey = null;
  applyingFetchResult = false;
}

/** Test helper: whether a refresh key denotes an active connection. */
export function isConnectedRefreshKey(refreshKey: string | number): boolean {
  return isConnected(refreshKey);
}
