/**
 * P2 Direct History Window — the paging control.
 *
 * ## What this owns, and what it deliberately does not
 *
 * It owns exactly one thing: the Load earlier / Back to latest affordance, and
 * the calls that drive the TBAi history-page operation.
 *
 * It owns NO measurement and NO eviction. The earlier version of this file
 * reported a "measured active region" of message rows so the window core could
 * decide what to evict. That mechanism is retired: the logical history buffer is
 * append-only, and the performance boundary is DOM virtualization, which
 * measures rows itself through `virtualizer.measureElement`. Measuring rows in
 * order to decide what to keep was the invented part, so it is gone.
 *
 * Why a TBAi-owned control rather than `ThreadPrimitive.LoadEarlier`: the AI SDK
 * runtime does not forward the ExternalStore `hasEarlier` / `onLoadEarlier`
 * contract, so the upstream primitive is permanently inert on this path. The
 * data operation is genuinely product-specific (SQLite paging + branch
 * authority); the message-state update uses the public AI SDK chat API; and
 * scroll compensation is TanStack Virtual's.
 */

import { useCallback, useEffect, useState } from "react";
import { ArrowUp, RefreshCw } from "lucide-react";
import { useAui, useAuiState } from "@assistant-ui/react";
import { toast } from "sonner";
import { historyConfig } from "../../../config/history";
import { logger } from "../../../lib/logger";
import { TooltipIconButton } from "../../../components/assistant-ui/elements/tooltip-icon-button";
import {
  beginHistoryReload,
  beginHistoryVisit,
  clearHistoryRecoveryAttempted,
  hasAttemptedHistoryRecovery,
  markHistoryRecoveryAttempted,
  useDirectHistoryWindow,
} from "./useDirectHistoryWindow";

/**
 * The paging control for the Direct thread.
 *
 * Genuinely product-specific: it decides WHEN to ask SQLite for another page,
 * which is TBAi business policy (branch-aware paging, duplicate prevention,
 * historical mode). Everything downstream of that decision is a library's job —
 * the message-state update goes through the public AI SDK chat API, and the
 * scroll compensation that follows a prepend is TanStack Virtual's.
 */
export function DirectViewportBridge() {
  const conversationId = useAuiState(
    (s) => (s.threadListItem as { remoteId?: string | null }).remoteId ?? null,
  );
  const { hasEarlier, isHistorical, loadEarlier, restoreTip, loadFailed } =
    useDirectHistoryWindow(conversationId);

  const [busy, setBusy] = useState(false);

  // ── Failed-load recovery ────────────────────────────────────────────────
  //
  // `useExternalHistory` calls `load()` once per mount and latches it, so a
  // failed load is never retried for the life of that thread instance. The
  // documented way out is `aui.threads.reloadMainThread()`, which
  // re-runs `load()` — either in place when the runtime declares the refetch
  // capability, or by restarting the thread runtime otherwise.
  //
  // It is called on ENTERING a conversation that failed, because it operates on
  // the MAIN thread: calling it while another thread is visible would refresh
  // the wrong one.
  //
  // Three guards, all required:
  //
  //  - the attempted-record is module-scoped, not a ref. The refresh restarts
  //    the thread runtime, which REMOUNTS this component; a ref would reset and
  //    the remounted instance would immediately fire a second recovery, which is
  //    an unbounded loop. The module-scoped record survives the remount and is
  //    what terminates the attempt.
  //  - `isRunning` — the documented guard. Restarting the runtime under a live
  //    run would discard it.
  //  - a NEW VISIT re-arms the budget, and that is what `beginHistoryVisit` is
  //    for. Switching threads does not detach a started thread, so a conversation
  //    that failed stayed failed with its budget spent and re-entering it bought
  //    nothing: the transcript rendered empty with no way back short of a page
  //    reload.
  //
  // Arriving from another conversation is the signal, and it is read from the
  // MODULE rather than from this component's own lifecycle on purpose. The Direct
  // surface renders ONE window bound to the active thread, so leaving a
  // conversation unmounts this component: `isMain` never goes false in a live
  // instance, and a mount that is already main is indistinguishable from the
  // restart's own remount. Which conversation was here last separates the two:
  //
  //    new visit           a different conversation was showing before
  //    recovery remount    the SAME conversation remounts; no change, so the
  //                        module-scoped record still ends the attempt — no loop
  //    rerender/republish  no mount at all, so nothing is consulted or consumed
  //
  // The returned promise resolves when the replacement runtime ATTACHES, which
  // is BEFORE its `load()` has run, so it is deliberately not awaited for
  // freshness and a failed load cannot surface through it.
  const aui = useAui();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  /**
   * assistant-ui's canonical history-loading signal: true from this mount until
   * the history adapter's `load()` settles, on success OR failure. Read here so a
   * retry can never be issued while a load is already in flight.
   */
  const isHistoryLoading = useAuiState((s) => s.thread.isLoading);

  useEffect(() => {
    if (!conversationId) {
      logger.info("chat", "history.recovery_visit", {
        conversationId: undefined,
        loadFailed,
        skipped: "no-conversation",
      });
      return;
    }
    // Consulted and consumed in the SAME effect, so no render can slip between
    // re-arming an exhausted budget and spending it.
    const isNewVisit = beginHistoryVisit(conversationId);
    logger.info("chat", "history.recovery_visit", { conversationId, isNewVisit, loadFailed });

    if (!loadFailed) {
      // The thread loaded (or is empty), so a future failure is recoverable
      // again rather than permanently suppressed by an old attempt.
      clearHistoryRecoveryAttempted(conversationId);
      logger.info("chat", "history.recovery_skipped", { conversationId, reason: "no-failure" });
      return;
    }
    if (isNewVisit) {
      // Arriving here is a new user intent, so it earns a fresh — still bounded
      // — attempt.
      clearHistoryRecoveryAttempted(conversationId);
    }
    if (hasAttemptedHistoryRecovery(conversationId)) {
      logger.info("chat", "history.recovery_skipped", {
        conversationId,
        reason: "already-attempted",
        isNewVisit,
      });
      return;
    }
    if (isRunning) {
      logger.info("chat", "history.recovery_skipped", { conversationId, reason: "running" });
      return;
    }
    markHistoryRecoveryAttempted(conversationId);
    logger.info("chat", "history.recovery_started", { conversationId });
    void aui.threads.reloadMainThread().catch(() => {
      // The refresh itself failed; the failure signal stays set, and the next
      // visit into this conversation re-arms the budget and tries again.
    });
  }, [aui, conversationId, loadFailed, isRunning]);

  const onLoadEarlier = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await loadEarlier();
    } catch {
      // The controller is fail-closed, so the window still shows what it had —
      // which is exactly why this must not stay silent. Swallowing it made a
      // failed "Load earlier" look identical to a click that did nothing: no
      // message moved, no row appeared, no log line, and the only way back was
      // to guess. `loadFailed` is deliberately NOT set here; that flag means the
      // initial load never arrived, and its full-reload Retry row would claim the
      // whole history is unavailable while the transcript is plainly populated.
      // The failure is logged at the site (history.page_load_failed) and shown
      // here as a transient, non-destructive notice.
      toast.error(historyConfig.copy.loadEarlierFailed);
    } finally {
      setBusy(false);
    }
  }, [busy, loadEarlier]);

  const onRestoreTip = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await restoreTip();
    } catch {
      // Same contract as above: a refused restore keeps the window as it was.
    } finally {
      setBusy(false);
    }
  }, [busy, restoreTip]);

  /**
   * The user's explicit retry of a failed history load.
   *
   * Three guards, each for a distinct reason:
   *
   *  - `isRunning`: restarting the runtime under a live run would discard it.
   *  - `isLoading`: the canonical per-mount in-flight signal. A retry may only
   *    start when NO load is running, which is what makes releasing the
   *    single-flight latch on the next settle sound rather than a race.
   *  - `beginHistoryReload`: claimed SYNCHRONOUSLY, because two clicks in one
   *    tick both still observe `isLoading === false`.
   *
   * The budget is re-armed and then immediately re-spent, in that order and in
   * the same handler. Re-spending is what stops the automatic-recovery effect
   * from firing a second, competing refresh when the restart remounts this
   * component. The TWO-request automatic limit is untouched: this path only runs
   * because a person asked for it.
   */
  const onRetryHistory = useCallback(() => {
    if (!conversationId || isRunning || isHistoryLoading) return;
    if (!beginHistoryReload(conversationId)) return;
    clearHistoryRecoveryAttempted(conversationId);
    markHistoryRecoveryAttempted(conversationId);
    void aui.threads.reloadMainThread().catch(() => {
      // The refresh itself failed to start. The failure flag is still set, the
      // latch is still held, and both are released when the next load settles —
      // so Retry becomes available again rather than staying stuck.
    });
  }, [aui, conversationId, isRunning, isHistoryLoading]);

  // A failed load must not leave an unexplained empty transcript, and the failure
  // has to STAY visible: it is the only thing that tells the user their history
  // is missing rather than empty. `hasEarlier`/`isHistorical` are the PAGING
  // state and say nothing about load failure, so the early return has to account
  // for `loadFailed` or this row could never render.
  if (!hasEarlier && !isHistorical && !loadFailed) return null;

  return (
    <div className="flex items-center justify-center gap-2 pb-2">
      {hasEarlier ? (
        <TooltipIconButton
          tooltip="Load earlier messages"
          side="bottom"
          disabled={busy}
          onClick={() => void onLoadEarlier()}
          className="h-8 w-auto gap-1.5 rounded-full border-none px-3 py-1 text-xs glass-surface shadow-floating"
        >
          <ArrowUp className="size-3.5" />
          <span>Load earlier</span>
        </TooltipIconButton>
      ) : null}
      {isHistorical ? (
        <TooltipIconButton
          tooltip="Return to the latest message"
          side="bottom"
          disabled={busy}
          onClick={() => void onRestoreTip()}
          className="h-8 w-auto gap-1.5 rounded-full border-none px-3 py-1 text-xs glass-surface shadow-floating"
        >
          <span>Back to latest</span>
        </TooltipIconButton>
      ) : null}
      {/*
        The failed-load state. It lives in this same slot, which is OUTSIDE the
        virtualizer's coordinate container, so it stays visible when the buffer
        is empty (the exact state a failed load leaves behind) and it shifts no
        row offsets and no scroll position.
      */}
      {loadFailed ? (
        <div
          role="alert"
          data-testid="history-load-failed"
          className="flex flex-col items-center gap-2 py-2 text-center"
        >
          <p className="m-0 text-xs text-muted-foreground">
            This conversation&apos;s history could not be loaded.
          </p>
          <TooltipIconButton
            tooltip="Retry loading history"
            side="bottom"
            // `TooltipIconButton` appends an sr-only tooltip span, so the
            // accessible name is "Retry Retry loading history". A test id is what
            // a spec should target here; matching the composed name is brittle.
            data-testid="history-retry"
            // Disabled while a load is in flight, and while a run holds the
            // thread, so Retry can never start a second, competing load.
            disabled={isRunning || isHistoryLoading}
            onClick={onRetryHistory}
            className="h-8 w-auto gap-1.5 rounded-full border-none px-3 py-1 text-xs glass-surface shadow-floating"
          >
            <RefreshCw className="size-3.5" />
            <span>Retry</span>
          </TooltipIconButton>
        </div>
      ) : null}
    </div>
  );
}
