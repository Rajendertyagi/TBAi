/**
 * K-I6 — `loadFailed` must participate in the published snapshot's identity and
 * notification, or history recovery is silently dead.
 *
 * `publishWindowUi()` builds a `DirectHistoryWindowUi` snapshot and is the only
 * writer of the object `useDirectHistoryWindowUi()` hands to
 * `useSyncExternalStore`. Its identity guard exists so an unchanged window does
 * not re-render. `loadFailed` is one of the guarded fields precisely because a
 * load failure changes NOTHING ELSE in the snapshot: if it were dropped from the
 * guard, the failed republish would keep the previous object (with the stale
 * `loadFailed: false`) and subscribers would never observe the failure.
 *
 * The observable public surface is the HOOK, so this mounts the real hook and
 * reads the snapshot React actually receives. `subscribeUi`/`uiSnapshots` are
 * intentionally private.
 *
 * ## Scope — read before citing this as the empty-conversation contract
 *
 * These cases pin `publishWindowUi`'s IDENTITY and NOTIFICATION contract. They
 * do NOT exercise the adapter path that decides whether a load failed at all, so
 * the case below named "an empty conversation is never reported as failed" is
 * narrower than its name suggests: it proves that repeated PUBLISHING never sets
 * the flag, not that loading an empty conversation avoids it.
 *
 * The case that actually decides it is in
 * `web/src/adapters/threadHistoryAdapter.phase3.test.ts` ("empty conversation is
 * a successful load, not a failed one"), which drives the real
 * `withFormat(...).load()`. That is where the empty-history defect actually lived,
 * and where its regression is pinned.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { WindowController } from "@web/features/chat/history/windowController.ts";
import {
  beginHistoryReload,
  beginHistoryVisit,
  clearHistoryLoadFailed,
  clearHistoryRecoveryAttempted,
  dropWindowController,
  hasAttemptedHistoryRecovery,
  isHistoryLoadFailed,
  isHistoryReloadInFlight,
  markHistoryLoadFailed,
  markHistoryRecoveryAttempted,
  publishWindowUi,
  resetHistoryVisit,
  useDirectHistoryWindowUi,
  type DirectHistoryWindowUi,
} from "@web/features/chat/history/useDirectHistoryWindow.ts";

/**
 * `publishWindowUi` only reads `historical`/`hasMoreBefore`/`hasMoreAfter` from
 * the controller; a fresh controller answers all three with `false`. The
 * fetcher is never called by this contract.
 */
const stubController = (): WindowController =>
  new WindowController({
    limit: 10,
    overscan: 2,
    fetchWindow: async () => {
      throw new Error("window fetch is not part of the K-I6 contract");
    },
  });

type UiProbe = {
  /** Distinct snapshot objects React has observed, in order. */
  readonly snapshots: DirectHistoryWindowUi[];
  /** How many times the subscribed component has rendered. */
  readonly renders: () => number;
  readonly unmount: () => void;
};

/** Mount the real hook and record every distinct snapshot identity it returns. */
function mountUi(conversationId: string): UiProbe {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const snapshots: DirectHistoryWindowUi[] = [];
  let renders = 0;

  const Probe = () => {
    const ui = useDirectHistoryWindowUi(conversationId);
    renders += 1;
    if (snapshots.length === 0 || snapshots[snapshots.length - 1] !== ui) {
      snapshots.push(ui);
    }
    return null;
  };

  act(() => {
    root.render(createElement(Probe));
  });

  return {
    snapshots,
    renders: () => renders,
    unmount: () => act(() => root.unmount()),
  };
}

const freshId = (): string => `k-i6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe("K-I6 — loadFailed is part of the snapshot contract", () => {
  const probes: UiProbe[] = [];

  afterEach(() => {
    for (const probe of probes.splice(0)) probe.unmount();
  });

  it("changing ONLY loadFailed changes the snapshot identity and notifies subscribers", () => {
    const id = freshId();
    const controller = stubController();
    const probe = mountUi(id);
    probes.push(probe);

    // 1. A healthy publish reports no failure.
    const initial = probe.snapshots.at(-1)!;
    expect(initial.loadFailed).toBe(false);

    act(() => publishWindowUi(id, controller));
    const healthy = probe.snapshots.at(-1)!;
    expect(healthy.loadFailed).toBe(false);

    const rendersBeforeFailure = probe.renders();

    // 2. ONLY the failure flag changes: mark, then republish.
    act(() => {
      markHistoryLoadFailed(id);
      publishWindowUi(id, controller);
    });

    const failed = probe.snapshots.at(-1)!;
    expect(failed.loadFailed).toBe(true);
    expect(failed).not.toBe(healthy);
    expect(probe.renders()).toBeGreaterThan(rendersBeforeFailure);
  });

  it("an empty conversation is never reported as failed, however often it publishes", () => {
    const id = freshId();
    const controller = stubController();
    const probe = mountUi(id);
    probes.push(probe);

    for (let i = 0; i < 5; i += 1) {
      act(() => publishWindowUi(id, controller));
      expect(probe.snapshots.at(-1)!.loadFailed).toBe(false);
    }
    expect(isHistoryLoadFailed(id)).toBe(false);
  });

  it("clearHistoryLoadFailed returns to loadFailed=false and changes identity again", () => {
    const id = freshId();
    const controller = stubController();
    const probe = mountUi(id);
    probes.push(probe);

    act(() => {
      markHistoryLoadFailed(id);
      publishWindowUi(id, controller);
    });
    const failed = probe.snapshots.at(-1)!;
    expect(failed.loadFailed).toBe(true);

    act(() => {
      clearHistoryLoadFailed(id);
      publishWindowUi(id, controller);
    });
    const cleared = probe.snapshots.at(-1)!;
    expect(cleared.loadFailed).toBe(false);
    expect(cleared).not.toBe(failed);
  });

  it("dropWindowController clears the failure flag", () => {
    const id = freshId();
    markHistoryLoadFailed(id);
    expect(isHistoryLoadFailed(id)).toBe(true);

    dropWindowController(id);
    expect(isHistoryLoadFailed(id)).toBe(false);
  });
});

/**
 * K-I1 — an exhausted recovery budget must be re-armed by a NEW VISIT, and by
 * nothing else.
 *
 * The budget is module-scoped so the recovery's own runtime restart — which
 * REMOUNTS the Direct surface — cannot fire a second attempt. That is the loop
 * guarantee, and it is also why a conversation whose history failed stayed
 * failed: the budget was spent and nothing ever cleared it, so coming back to
 * the conversation bought nothing and the transcript rendered empty.
 *
 * Clearing on anything weaker than a real arrival would reintroduce the loop.
 * `beginHistoryVisit` is the discriminator, and the cases below pin both halves:
 * a remount of the same conversation is NOT a visit, and arriving from a
 * different one IS.
 *
 * The module keeps this state at module scope, so each case resets the visit
 * record and uses fresh conversation ids rather than relying on test order.
 */
describe("K-I1 — a new visit re-arms an exhausted recovery budget", () => {
  beforeEach(() => {
    resetHistoryVisit();
  });

  it("the first arrival at a conversation is a new visit", () => {
    expect(beginHistoryVisit(freshId())).toBe(true);
  });

  it("the recovery's own remount of the SAME conversation is not a new visit", () => {
    const id = freshId();
    expect(beginHistoryVisit(id)).toBe(true);
    // The restart remounts this same conversation. If this reported a visit, the
    // budget would re-arm straight back into the retry loop it exists to stop.
    expect(beginHistoryVisit(id)).toBe(false);
    expect(beginHistoryVisit(id)).toBe(false);
  });

  it("arriving from a different conversation is a new visit", () => {
    const a = freshId();
    const b = freshId();
    expect(beginHistoryVisit(a)).toBe(true);
    expect(beginHistoryVisit(b)).toBe(true);
    expect(beginHistoryVisit(a)).toBe(true);
  });

  it("resetHistoryVisit makes the next arrival a new visit again", () => {
    const id = freshId();
    expect(beginHistoryVisit(id)).toBe(true);
    expect(beginHistoryVisit(id)).toBe(false);

    // Coordinated recovery / full reset must not leave the surface permanently
    // indistinguishable from a restart remount.
    resetHistoryVisit();
    expect(beginHistoryVisit(id)).toBe(true);
  });

  it("the budget is spent by marking and restored only by clearing", () => {
    const id = freshId();
    expect(hasAttemptedHistoryRecovery(id)).toBe(false);

    markHistoryRecoveryAttempted(id);
    expect(hasAttemptedHistoryRecovery(id)).toBe(true);
    // Marking twice is still one spent budget — a repeated publication cannot
    // grant itself extra attempts.
    markHistoryRecoveryAttempted(id);
    expect(hasAttemptedHistoryRecovery(id)).toBe(true);

    clearHistoryRecoveryAttempted(id);
    expect(hasAttemptedHistoryRecovery(id)).toBe(false);
  });

  // ── Retry single-flight ────────────────────────────────────────────────────
  //
  // `useExternalHistory` calls `load()` with no abort signal and no effect
  // cleanup, and a completed load writes straight into the live runtime
  // (`thread.import(...)`). Two concurrent loads therefore do not merely waste
  // requests: the last one to finish overwrites the other's messages, and a slow
  // older SUCCESS can even erase a failure a newer load just recorded. These
  // cases pin the guard that keeps exactly one load running.
  it("the reload slot admits one caller and refuses the rest", () => {
    const id = freshId();
    expect(isHistoryReloadInFlight(id)).toBe(false);

    // First caller wins.
    expect(beginHistoryReload(id)).toBe(true);
    expect(isHistoryReloadInFlight(id)).toBe(true);

    // Two clicks in the same tick both observe `thread.isLoading === false`, so
    // the latch is the only thing that can stop the second one.
    expect(beginHistoryReload(id)).toBe(false);
    expect(beginHistoryReload(id)).toBe(false);
    expect(isHistoryReloadInFlight(id)).toBe(true);
  });

  it("a FAILED load settles the reload, so Retry becomes available again", () => {
    const id = freshId();
    beginHistoryReload(id);
    expect(beginHistoryReload(id)).toBe(false);

    // The adapter's catch path.
    markHistoryLoadFailed(id);
    expect(isHistoryReloadInFlight(id)).toBe(false);
    expect(beginHistoryReload(id)).toBe(true);
  });

  it("a SUCCEEDED load settles the reload even when it cleared no failure", () => {
    const id = freshId();
    beginHistoryReload(id);

    // `clearHistoryLoadFailed` returns early when there was no failure to clear.
    // The latch must still be released, or Retry would be disabled for good.
    clearHistoryLoadFailed(id);
    expect(isHistoryReloadInFlight(id)).toBe(false);
    expect(beginHistoryReload(id)).toBe(true);
  });

  it("the slot is per conversation", () => {
    const a = freshId();
    const b = freshId();
    expect(beginHistoryReload(a)).toBe(true);
    expect(beginHistoryReload(b)).toBe(true);
    expect(isHistoryReloadInFlight(a)).toBe(true);
    expect(isHistoryReloadInFlight(b)).toBe(true);
  });

  it("deleting a conversation releases the slot, so it can never stick", () => {
    const id = freshId();
    beginHistoryReload(id);
    expect(isHistoryReloadInFlight(id)).toBe(true);

    // Nothing will settle for a deleted conversation, so the reset has to happen
    // here or Retry would be permanently disabled for that id.
    dropWindowController(id);
    expect(isHistoryReloadInFlight(id)).toBe(false);
  });

  it("a stale completion cannot clear the guard of an unrelated conversation", () => {
    const retrying = freshId();
    const other = freshId();
    beginHistoryReload(retrying);

    // An overlapping load belonging to a DIFFERENT conversation settles.
    markHistoryLoadFailed(other);

    expect(isHistoryReloadInFlight(other)).toBe(false);
    // The in-flight retry keeps its guard — a settle that is not its own must
    // not release it, or a second overlapping load could start.
    expect(isHistoryReloadInFlight(retrying)).toBe(true);
    expect(beginHistoryReload(retrying)).toBe(false);
  });

  it("a new visit does not restore the budget by itself — the caller must clear it", () => {
    const id = freshId();
    const other = freshId();

    markHistoryRecoveryAttempted(id);
    // Arriving somewhere else and coming back IS a new visit...
    expect(beginHistoryVisit(other)).toBe(true);
    expect(beginHistoryVisit(id)).toBe(true);
    // ...but detecting it is not the same as acting on it. The caller clears the
    // budget in the same effect that spends it, so that no render can slip
    // between re-arming and consuming. Pinned here so the two responsibilities
    // cannot be silently merged or silently dropped.
    expect(hasAttemptedHistoryRecovery(id)).toBe(true);

    clearHistoryRecoveryAttempted(id);
    expect(hasAttemptedHistoryRecovery(id)).toBe(false);
  });

  it("the budget is per conversation, so one conversation cannot spend another's", () => {
    const a = freshId();
    const b = freshId();
    markHistoryRecoveryAttempted(a);

    expect(hasAttemptedHistoryRecovery(a)).toBe(true);
    expect(hasAttemptedHistoryRecovery(b)).toBe(false);

    dropWindowController(b);
    expect(hasAttemptedHistoryRecovery(a)).toBe(true);
    dropWindowController(a);
    expect(hasAttemptedHistoryRecovery(a)).toBe(false);
  });
});
