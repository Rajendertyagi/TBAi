import { invalidateHistoryCache } from "../../adapters/threadHistoryAdapter";
import { invalidateThreadListCache } from "../../adapters/remoteThreadListAdapter";
import { useSettingsStore } from "../../stores";
import { logger } from "../../lib/logger";
import { useAvailabilityStore } from "./availabilityStore";

/**
 * ONE coordinated recovery synchronization (Phase 3.8).
 *
 * Runs centrally on offline/degraded → online transitions, registered once
 * from AppShell. Intentional order:
 *   1. conversation list cache invalidation (adapter last-good)
 *   2. current-conversation + history cache invalidation (runtime memory is
 *      already best-known; no forced reload exists in the SDK and none is
 *      added — invalidation keeps future mounts authoritative)
 *   3. providers/models reload (retains previous on failure)
 *   4+. epoch-driven refetches happen in components subscribed to
 *      `recoveryEpoch`: sidebar list, OpenCode capabilities + conversation
 *      config, and the OpenCode view's EXISTING reconnect boundary.
 *
 * Server responses are authoritative; cached state is replaced on the next
 * successful read. Unsent composer text is never touched here (retained by
 * the draft helpers; never auto-submitted). Direct sends are never replayed.
 * Singleflight is enforced by the store's recovery runner; this listener is
 * additionally idempotent (cache clears + conditional reloads).
 */

async function safeLoadProviders(): Promise<void> {
  try {
    await useSettingsStore.getState().loadProviders();
  } catch (err) {
    logger.debug("availability", "recovery providers reload failed", {
      errorType: err instanceof Error ? err.name : typeof err,
    });
  }
}

async function runRecoverySequence(): Promise<void> {
  invalidateThreadListCache();
  invalidateHistoryCache();
  await safeLoadProviders();
}

/**
 * Register the single recovery listener. Each call returns its own
 * unsubscribe; the AppShell effect cleanup releases it, so StrictMode
 * remounts re-register cleanly. AppShell is a singleton, so exactly one
 * listener is live at a time and recovery never fans out.
 */
export function registerAvailabilityRecovery(): () => void {
  return useAvailabilityStore.getState().onRecovered(() => runRecoverySequence());
}
