import { logger } from "../../lib/logger";
import { classifyError } from "../../lib/errors";
import { conversationService } from "../storage";
import {
  opencodeOrphanService,
  type OpenCodeOrphanRecord,
} from "../storage/opencodeSessionOrphans";
import { createOpenCodeClient, type OpenCodeClient } from "./client";
import { openCodeServerManager } from "./serverManager";
import {
  fetchOpenCodeSession,
  isOpenCodeSessionCreateInFlight,
  removeUnboundSession,
} from "./sessions";

/**
 * Bounded, restart-safe reconciliation of the OpenCode session journal
 * (RT-001).
 *
 * The journal holds two kinds of unresolved row:
 *  - `intent` — written before `session.create`. It is not a claim that the
 *    remote session exists; it is the durable handle that survives a crash in
 *    the create/persist window. The reconciler probes the id and either clears
 *    the intent (never created / already gone / now bound) or removes the
 *    unbound session.
 *  - `orphan` — a created session whose pointer could not be confirmed and
 *    whose removal could not be confirmed. The reconciler removes it only
 *    after proving the conversation does not point at it and the remote
 *    session is present.
 *
 * Safety rules, in order:
 *  1. **A create still in flight in this process is untouchable.** The create
 *     path registers `(conversation, session)` from its intent write through
 *     the pointer commit, and this pass skips those rows outright. The grace
 *     window below is defense in depth, not the guarantee: a slow create can
 *     outlive any fixed window.
 *  2. **A conversation that now points at the session is authoritative.** The
 *     session is NEVER deleted. The journal's CURRENT row decides the rest,
 *     atomically: a risk-bearing row is preserved and touched, because binding
 *     proves ownership, not that an earlier create request has finished; a
 *     risk-free row keeps the established settlement. The listed record's risk
 *     flag is not trusted, because a create path can re-arm it mid-pass.
 *  3. A row younger than the grace window is left alone.
 *  4. Absence must be positive (a 404). A lookup that fails for any other
 *     reason leaves the row unresolved for a later pass.
 *  5. **A bare 404 never clears a risk-bearing row.** A create whose response
 *     was lost may still commit after the lookup. Such a row is retained,
 *     rotated behind unexamined rows, and only released after the absence
 *     horizon — a bounded best effort, because upstream exposes no terminality
 *     signal (documented in the ADR). The release decision is made against the
 *     journal's CURRENT row in one transaction, so a risk re-armed after this
 *     record was listed cannot be cleared by the stale snapshot.
 *  6. **Presence is not terminality.** Seeing the id present proves only that
 *     it existed at that instant; it does not prove every create request for it
 *     has finished. A confirmed removal of a risk-bearing session is therefore
 *     NOT a settlement: the row survives, and the removal ends the current
 *     absence epoch so the next 404 starts a NEW post-removal horizon. If the
 *     outstanding request recreates the id, the next pass detects it, re-checks
 *     ownership, and removes it again under these same rules. The post-removal
 *     retain/clear decision is made against the CURRENT row, not the listed
 *     snapshot.
 *  7. Ownership is re-checked immediately before removal, so a pointer that
 *     appeared while the probe was in flight still wins. That late discovery
 *     applies the SAME durable retain/clear rule as rule 2: a concurrent bind
 *     must not discard a risk-bearing obligation.
 *  8. Removal is confirmed by a follow-up lookup, exactly as the create path
 *     does. "The call returned" is never treated as "the session is gone". When
 *     the presence observation could not be recorded, the CURRENT durable risk
 *     decides whether removal may proceed; a risk-bearing row is left for a
 *     later pass.
 *
 * It never starts the managed server. If no server is running it still clears
 * rows that are provably bound, and leaves the rest for a pass that runs while
 * Code mode is active. That is what keeps boot from depending on OpenCode.
 *
 * Lifecycle mirrors `chat-streams/historyReconciler.ts`: idempotent start,
 * `unref`'d timer, boot tick plus interval, a single in-flight pass, and an
 * explicit drain so shutdown cannot close the database under a write.
 *
 * ADR: docs/decisions.md "RT-001: caller-supplied session ids, a durable
 * create-intent journal and a bounded orphan reconciler".
 */

/** How often unresolved journal rows are reconsidered. */
export const DEFAULT_ORPHAN_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How long a row must exist before it is actionable. Protects a live
 * create/persist window (milliseconds) from a concurrent pass.
 */
export const DEFAULT_ORPHAN_RECONCILE_GRACE_MS = 60 * 1000;

/**
 * How long a risk-bearing intent may keep answering 404 before it is treated
 * as terminally absent.
 *
 * This is a BOUNDED BEST EFFORT, not proof. OpenCode exposes no signal that a
 * request whose response was lost can no longer commit, so a 404 is never
 * sufficient on its own. The horizon exists only so a pathological row cannot
 * accumulate forever; it is long enough that any real request has finished,
 * timed out, or been killed. Rows that become present are settled immediately
 * and never reach it.
 */
export const DEFAULT_ORPHAN_ABSENCE_HORIZON_MS = 24 * 60 * 60 * 1000;

/** Rows examined per pass, so a backlog is drained over several passes. */
export const DEFAULT_ORPHAN_RECONCILE_LIMIT = 20;

/** The journal + server seams, injected so the pass is testable without I/O. */
export interface OpenCodeOrphanReconcilerDeps {
  listUnresolved(limit: number): Promise<OpenCodeOrphanRecord[]>;
  /** The conversation row, or null when it no longer exists. */
  getConversation(conversationId: string): Promise<{ opencodeSessionId: string | null } | null>;
  /**
   * Records what one probe established. `present` ends the current absence
   * epoch but deliberately does NOT clear the late-create risk; `absent`
   * stamps the first 404 of the current epoch and never clears the risk.
   */
  recordProbe(input: {
    conversationId: string;
    sessionId: string;
    outcome: "present" | "absent";
    at: number;
  }): Promise<boolean>;
  /**
   * Settles the journal because this pass will not remove the session: the
   * conversation now points at it (bound), or the pass already confirmed its
   * removal.
   *
   * The decision must be made against the CURRENT durable row, not the
   * `lateCreateRisk` of the record listed before the remote probe: a create
   * path may have re-armed that flag while the probe was in flight. A
   * risk-bearing row is retained and touched for rotation; a risk-free row
   * keeps the established settlement; `absent` means it was already settled.
   */
  settleOwned(
    conversationId: string,
    sessionId: string,
    at: number,
  ): Promise<"retained" | "cleared" | "absent">;
  /**
   * Settles a positive-404 observation against the CURRENT durable row, in one
   * transaction. `recordProbe` has already stamped the epoch; this decides
   * whether the absence releases the row. A risk-bearing row is retained until
   * the absence horizon elapses; a risk-free row is released.
   */
  settleAbsent(input: {
    conversationId: string;
    sessionId: string;
    at: number;
    absenceHorizonMs: number;
  }): Promise<"retained" | "expired" | "cleared" | "absent">;
  /**
   * The CURRENT durable risk of an open row. Used before removal when the
   * presence observation could not be recorded: the listed risk flag may be
   * stale, and an unrecorded epoch reset on a risk-bearing row must block
   * removal. `absent` means another writer settled the row.
   */
  getOpenSessionRisk(
    conversationId: string,
    sessionId: string,
  ): Promise<"risk" | "safe" | "absent">;
  /**
   * True while this process is creating/binding the exact session. Such a row
   * must never be acted on by a background pass.
   */
  isCreateInFlight(conversationId: string, sessionId: string): boolean;
  /**
   * Base URL of an ALREADY RUNNING managed server, or null. Must never be
   * implemented by starting one.
   */
  getRunningBaseUrl(): Promise<string | null>;
  createClient(baseUrl: string, directory: string | null): OpenCodeClient;
}

/** What one pass did. Counts only — never session ids or message text. */
export interface OpenCodeOrphanReconcileReport {
  /** Rows examined after the grace filter. */
  scanned: number;
  /** Rows skipped because they are younger than the grace window. */
  deferred: number;
  /** Rows skipped because this process is still creating/binding them. */
  inflight: number;
  /** Risk-free rows cleared because the conversation points at the session. */
  bound: number;
  /**
   * Risk-bearing rows kept because the conversation is bound — either before
   * the probe or discovered at the ownership recheck. Binding proves
   * ownership, not that an earlier create request has finished. The row was
   * touched so it rotates behind unexamined entries.
   */
  retainedBound: number;
  /** Rows cleared because the remote session is positively absent. */
  absent: number;
  /** Rows cleared because their remote session was removed and confirmed gone. */
  removed: number;
  /**
   * Risk-bearing sessions removed and confirmed gone, whose journal row was
   * deliberately KEPT: a create request may still be outstanding and recreate
   * the id, so removal is not settlement. The row's absence epoch restarts.
   */
  retainedAfterRemoval: number;
  /**
   * Risk-bearing rows retained after a 404: a lost create response may
   * still commit, so absence at lookup time is not terminal.
   */
  lateRisk: number;
  /** Risk-bearing intents released after the absence horizon elapsed. */
  expiredAbsent: number;
  /** Rows that could not be settled; they stay for a later pass. */
  unresolved: number;
  /** Rows left because no managed server was running to probe against. */
  skippedNoServer: number;
}

export interface StartOrphanReconciliationOptions {
  deps: OpenCodeOrphanReconcilerDeps;
  intervalMs?: number;
  graceMs?: number;
  absenceHorizonMs?: number;
  limit?: number;
  now?: () => number;
  /** Skip the immediate first tick (used to isolate timer behaviour in tests). */
  runImmediately?: boolean;
}

let timer: ReturnType<typeof setInterval> | null = null;
let intervalMs = DEFAULT_ORPHAN_RECONCILE_INTERVAL_MS;
let graceMs = DEFAULT_ORPHAN_RECONCILE_GRACE_MS;
let absenceHorizonMs = DEFAULT_ORPHAN_ABSENCE_HORIZON_MS;
let limit = DEFAULT_ORPHAN_RECONCILE_LIMIT;
let now: () => number = Date.now;
let ticks = 0;
let inFlight = false;
let inflightTick: Promise<unknown> | null = null;
let deps: OpenCodeOrphanReconcilerDeps | null = null;

/** Observable lifecycle state, so timer behaviour is testable without fake timers. */
export function getOrphanReconciliationState(): {
  running: boolean;
  intervalMs: number;
  graceMs: number;
  limit: number;
  ticks: number;
  inFlight: boolean;
} {
  return { running: timer !== null, intervalMs, graceMs, limit, ticks, inFlight };
}

/**
 * Applies the ownership rule against the current durable row.
 *
 * The record was listed before the remote probe, so its `lateCreateRisk` may
 * be stale by now: a create path can re-arm the durable flag while the probe
 * is in flight. The journal operation therefore makes the retain-versus-clear
 * decision itself, atomically. A failure leaves the row untouched, and the
 * pass reports it unresolved rather than clearing an obligation it could not
 * confirm.
 */
async function settleOwnedRow(
  record: OpenCodeOrphanRecord,
  reconcilerDeps: OpenCodeOrphanReconcilerDeps,
  report: OpenCodeOrphanReconcileReport,
): Promise<void> {
  try {
    const outcome = await reconcilerDeps.settleOwned(
      record.conversationId,
      record.sessionId,
      now(),
    );
    if (outcome === "retained") {
      report.retainedBound += 1;
      return;
    }
    if (outcome === "cleared") {
      report.bound += 1;
      return;
    }
    // Another writer settled the row while this pass was probing. There is no
    // obligation left to discharge, and nothing was retained by this pass.
    logger.debug("opencode", "opencode.orphan_reconcile_bound_row_settled_concurrently", {
      conversationId: record.conversationId,
      phase: record.phase,
    });
  } catch (error) {
    report.unresolved += 1;
    logger.warn("opencode", "opencode.orphan_reconcile_bound_settle_failed", {
      conversationId: record.conversationId,
      phase: record.phase,
      ...classifyError(error),
    });
  }
}

/**
 * Settles the journal after this pass confirmed the remote removal.
 *
 * The same current-row rule decides the outcome: a risk-bearing row is kept
 * (removal frees the id, and an outstanding create may recreate it), a
 * risk-free row is cleared. Deciding from the listed record instead would let
 * a freshly re-armed obligation be cleared right after its session was
 * removed.
 */
async function settleRemovedRow(
  record: OpenCodeOrphanRecord,
  reconcilerDeps: OpenCodeOrphanReconcilerDeps,
  report: OpenCodeOrphanReconcileReport,
): Promise<void> {
  try {
    const outcome = await reconcilerDeps.settleOwned(
      record.conversationId,
      record.sessionId,
      now(),
    );
    if (outcome === "retained") {
      report.retainedAfterRemoval += 1;
      logger.info("opencode", "opencode.orphan_removed_retained", {
        conversationId: record.conversationId,
        phase: record.phase,
      });
      return;
    }
    // `cleared` and `absent` both leave no obligation this pass must carry:
    // the removal was confirmed, and the row is settled.
    if (outcome === "absent") {
      logger.debug("opencode", "opencode.orphan_reconcile_removed_row_settled_concurrently", {
        conversationId: record.conversationId,
        phase: record.phase,
      });
    }
    report.removed += 1;
  } catch (error) {
    report.unresolved += 1;
    logger.warn("opencode", "opencode.orphan_reconcile_removed_settle_failed", {
      conversationId: record.conversationId,
      phase: record.phase,
      ...classifyError(error),
    });
  }
}

/**
 * Runs one reconciliation pass. Never throws: this is background bookkeeping,
 * and a failure must not take the server down.
 *
 * Returns null when the reconciler was never started or a pass is already in
 * flight (a second overlapping pass could only contend with itself).
 */
export async function runOrphanReconciliationOnce(): Promise<OpenCodeOrphanReconcileReport | null> {
  const reconcilerDeps = deps;
  if (!reconcilerDeps) return null;
  if (inFlight) {
    logger.debug("opencode", "opencode.orphan_reconcile_overlapped", { signal: "interval" });
    return null;
  }

  inFlight = true;
  let resolveTick!: () => void;
  inflightTick = new Promise<void>((resolve) => {
    resolveTick = resolve;
  });

  const report: OpenCodeOrphanReconcileReport = {
    scanned: 0,
    deferred: 0,
    inflight: 0,
    bound: 0,
    retainedBound: 0,
    absent: 0,
    removed: 0,
    retainedAfterRemoval: 0,
    lateRisk: 0,
    expiredAbsent: 0,
    unresolved: 0,
    skippedNoServer: 0,
  };

  // Resolved once per pass, and only when a row actually needs a remote
  // answer. `undefined` = not asked yet; `null` = no server is running.
  let baseUrl: string | null | undefined;
  const runningBaseUrl = async (): Promise<string | null> => {
    if (baseUrl !== undefined) return baseUrl;
    try {
      baseUrl = await reconcilerDeps.getRunningBaseUrl();
    } catch (error) {
      logger.warn("opencode", "opencode.orphan_reconcile_server_unavailable", {
        ...classifyError(error),
      });
      baseUrl = null;
    }
    return baseUrl;
  };

  try {
    const rows = await reconcilerDeps.listUnresolved(limit);
    const cutoff = now() - graceMs;

    for (const record of rows) {
      // Rule 3: a row younger than the window may belong to a live request.
      if (record.lastSeenAt.getTime() > cutoff) {
        report.deferred += 1;
        continue;
      }
      // Rule 1: an in-process create owns this row until it finishes. The
      // grace window is only defense in depth — a create can outlive it.
      if (reconcilerDeps.isCreateInFlight(record.conversationId, record.sessionId)) {
        report.inflight += 1;
        continue;
      }
      report.scanned += 1;

      // Rule 2: ownership first, and it needs no server. A conversation that
      // points at this session makes it TBAi's, whatever the journal says.
      let conversation: { opencodeSessionId: string | null } | null;
      try {
        conversation = await reconcilerDeps.getConversation(record.conversationId);
      } catch (error) {
        report.unresolved += 1;
        logger.warn("opencode", "opencode.orphan_reconcile_conversation_unreadable", {
          conversationId: record.conversationId,
          phase: record.phase,
          ...classifyError(error),
        });
        continue;
      }
      if (conversation?.opencodeSessionId === record.sessionId) {
        await settleOwnedRow(record, reconcilerDeps, report);
        continue;
      }

      // A remote answer is required from here on. Without a running server,
      // leave the row untouched rather than starting one from a background
      // task (boot must not depend on OpenCode).
      const url = await runningBaseUrl();
      if (url === null) {
        report.skippedNoServer += 1;
        continue;
      }
      const client = reconcilerDeps.createClient(url, record.locationDirectory ?? null);

      let remote: Awaited<ReturnType<typeof fetchOpenCodeSession>>;
      try {
        remote = await fetchOpenCodeSession(client, record.sessionId);
      } catch (error) {
        report.unresolved += 1;
        logger.warn("opencode", "opencode.orphan_reconcile_probe_inconclusive", {
          conversationId: record.conversationId,
          phase: record.phase,
          ...classifyError(error),
        });
        continue;
      }

      if (remote === null) {
        // Positive 404 — but only "absent at lookup time". Record the
        // observation first (it stamps the epoch's first 404 and rotates the row
        // behind unexamined ones), then let the journal decide what it means
        // against its CURRENT row. A risk re-armed after this record was listed
        // must retain; a risk-free row is released; a risk-bearing row is kept
        // until the bounded absence horizon (rule 5).
        const observedAt = now();
        let recorded: boolean;
        try {
          recorded = await reconcilerDeps.recordProbe({
            conversationId: record.conversationId,
            sessionId: record.sessionId,
            outcome: "absent",
            at: observedAt,
          });
        } catch (error) {
          report.unresolved += 1;
          logger.warn("opencode", "opencode.orphan_reconcile_probe_record_failed", {
            conversationId: record.conversationId,
            phase: record.phase,
            outcome: "absent",
            ...classifyError(error),
          });
          continue;
        }
        if (!recorded) {
          // Settled concurrently; there is no obligation left to act on.
          logger.debug("opencode", "opencode.orphan_reconcile_probe_row_closed", {
            conversationId: record.conversationId,
            phase: record.phase,
          });
          continue;
        }

        try {
          const settled = await reconcilerDeps.settleAbsent({
            conversationId: record.conversationId,
            sessionId: record.sessionId,
            at: observedAt,
            absenceHorizonMs,
          });
          if (settled === "retained") {
            report.lateRisk += 1;
          } else if (settled === "expired") {
            report.expiredAbsent += 1;
          } else if (settled === "cleared") {
            report.absent += 1;
          } else {
            logger.debug("opencode", "opencode.orphan_reconcile_absent_row_closed", {
              conversationId: record.conversationId,
              phase: record.phase,
            });
          }
        } catch (error) {
          report.unresolved += 1;
          logger.warn("opencode", "opencode.orphan_reconcile_absent_settle_failed", {
            conversationId: record.conversationId,
            phase: record.phase,
            ...classifyError(error),
          });
        }
        continue;
      }

      // The id is present RIGHT NOW. Record that observation first: it ends the
      // current absence epoch, so any later 404 starts a fresh horizon. It does
      // not settle a risk-bearing row — existence at this instant says nothing
      // about whether an earlier create request has finished.
      let observationRecorded: boolean;
      try {
        observationRecorded = await reconcilerDeps.recordProbe({
          conversationId: record.conversationId,
          sessionId: record.sessionId,
          outcome: "present",
          at: now(),
        });
      } catch (error) {
        logger.warn("opencode", "opencode.orphan_reconcile_probe_record_failed", {
          conversationId: record.conversationId,
          phase: record.phase,
          outcome: "present",
          ...classifyError(error),
        });
        observationRecorded = false;
      }
      if (!observationRecorded) {
        // The listed risk flag may be stale in either direction, so ask the
        // journal for the CURRENT risk before acting. A risk-bearing row whose
        // epoch reset could not be written must not be removed: a later 404
        // would then be measured from a timestamp taken before this
        // observation. A risk-free or already-settled row can proceed; the
        // post-removal settlement makes the same current-row decision.
        let currentRisk: "risk" | "safe" | "absent";
        try {
          currentRisk = await reconcilerDeps.getOpenSessionRisk(
            record.conversationId,
            record.sessionId,
          );
        } catch (error) {
          report.unresolved += 1;
          logger.warn("opencode", "opencode.orphan_reconcile_risk_read_failed", {
            conversationId: record.conversationId,
            phase: record.phase,
            ...classifyError(error),
          });
          continue;
        }
        if (currentRisk === "risk") {
          report.unresolved += 1;
          logger.warn("opencode", "opencode.orphan_reconcile_probe_not_recorded", {
            conversationId: record.conversationId,
            phase: record.phase,
            outcome: "present",
          });
          continue;
        }
      }

      // Rule 4: re-check ownership as late as possible. A pointer written
      // while the probe was in flight still wins.
      let stillUnbound: boolean;
      try {
        const latest = await reconcilerDeps.getConversation(record.conversationId);
        stillUnbound = latest?.opencodeSessionId !== record.sessionId;
      } catch (error) {
        report.unresolved += 1;
        logger.warn("opencode", "opencode.orphan_reconcile_recheck_failed", {
          conversationId: record.conversationId,
          phase: record.phase,
          ...classifyError(error),
        });
        continue;
      }
      if (!stillUnbound) {
        // The pointer was written while the probe was in flight. That makes the
        // session TBAi's, but it does not settle the journal: the record listed
        // before the probe may also have been re-armed meanwhile. Let the
        // journal decide against its CURRENT row — retain risk-bearing rows,
        // clear risk-free ones — and never remove the bound session.
        await settleOwnedRow(record, reconcilerDeps, report);
        continue;
      }

      // Rule 5: removal must be confirmed, not merely issued.
      const { outcome } = await removeUnboundSession(client, record.sessionId);
      if (outcome !== "removed") {
        report.unresolved += 1;
        logger.warn("opencode", "opencode.orphan_reconcile_remove_unconfirmed", {
          conversationId: record.conversationId,
          phase: record.phase,
          outcome,
        });
        continue;
      }
      // Rule 6: the session is gone, but removal is not settlement. A create
      // whose response was lost may still commit and recreate this exact id, so
      // the journal decides against its CURRENT row: a risk-bearing obligation
      // is kept (the present probe above already ended the absence epoch, so
      // the next 404 starts a NEW post-removal horizon), while a risk-free row
      // is released. If the id reappears, the next pass sees it and removes it
      // again under the same rules.
      await settleRemovedRow(record, reconcilerDeps, report);
    }

    ticks += 1;
    if (
      report.scanned > 0 ||
      report.deferred > 0 ||
      report.inflight > 0 ||
      report.retainedBound > 0 ||
      report.removed > 0 ||
      report.retainedAfterRemoval > 0 ||
      report.unresolved > 0
    ) {
      logger.info("opencode", "opencode.orphan_reconciled", {
        signal: "interval",
        scanned: report.scanned,
        deferred: report.deferred,
        inflight: report.inflight,
        bound: report.bound,
        retainedBound: report.retainedBound,
        absent: report.absent,
        removed: report.removed,
        retainedAfterRemoval: report.retainedAfterRemoval,
        lateRisk: report.lateRisk,
        expiredAbsent: report.expiredAbsent,
        unresolved: report.unresolved,
        skippedNoServer: report.skippedNoServer,
      });
    }
    return report;
  } catch (error) {
    logger.error("opencode", "opencode.orphan_reconcile_failed", {
      signal: "interval",
      ...classifyError(error),
    });
    return null;
  } finally {
    inFlight = false;
    inflightTick = null;
    resolveTick();
  }
}

/**
 * Starts the reconciler. Idempotent: a second call while running is a no-op.
 *
 * The immediate pass is fire-and-forget — boot must never wait on recovery —
 * and does nothing remote unless the managed server is already running.
 */
export function startOrphanReconciliation(options: StartOrphanReconciliationOptions): {
  started: boolean;
  alreadyRunning: boolean;
} {
  if (timer !== null) return { started: false, alreadyRunning: true };

  deps = options.deps;
  intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_ORPHAN_RECONCILE_INTERVAL_MS);
  graceMs = Math.max(0, options.graceMs ?? DEFAULT_ORPHAN_RECONCILE_GRACE_MS);
  absenceHorizonMs = Math.max(0, options.absenceHorizonMs ?? DEFAULT_ORPHAN_ABSENCE_HORIZON_MS);
  limit = Math.max(1, options.limit ?? DEFAULT_ORPHAN_RECONCILE_LIMIT);
  now = options.now ?? Date.now;
  ticks = 0;

  if (options.runImmediately !== false) {
    void runOrphanReconciliationOnce().catch(() => {
      /* runOrphanReconciliationOnce swallows and logs */
    });
  }

  timer = setInterval(() => {
    void runOrphanReconciliationOnce().catch(() => {
      /* already logged inside */
    });
  }, intervalMs);
  // Background bookkeeping must never keep the process alive.
  (timer as unknown as { unref?: () => void }).unref?.();
  return { started: true, alreadyRunning: false };
}

/** Clears the timer. Safe to call when not running. */
export function stopOrphanReconciliation(): boolean {
  if (timer === null) return false;
  clearInterval(timer);
  timer = null;
  deps = null;
  return true;
}

/**
 * Await the currently running pass, if any. Stopping the timer prevents future
 * passes; draining proves no pass is still writing when the database closes.
 */
export function drainOrphanReconciliation(): Promise<void> {
  return inflightTick ? inflightTick.then(() => undefined) : Promise.resolve();
}

/** Production wiring: the real journal, conversation rows and managed server. */
export const openCodeOrphanReconcilerDeps: OpenCodeOrphanReconcilerDeps = {
  listUnresolved: (batchLimit) => opencodeOrphanService.listUnresolvedOrphans(batchLimit),
  getConversation: async (conversationId) => {
    const conversation = await conversationService.get(conversationId);
    return conversation ? { opencodeSessionId: conversation.opencodeSessionId ?? null } : null;
  },
  settleOwned: (conversationId, sessionId, at) =>
    opencodeOrphanService.settleOwnedSession({ conversationId, sessionId, at }),
  settleAbsent: (input) => opencodeOrphanService.settleAbsentSession(input),
  getOpenSessionRisk: (conversationId, sessionId) =>
    opencodeOrphanService.getOpenSessionRisk(conversationId, sessionId),
  recordProbe: (input) => opencodeOrphanService.recordProbe(input),
  isCreateInFlight: isOpenCodeSessionCreateInFlight,
  getRunningBaseUrl: async () =>
    openCodeServerManager.isRunning() ? openCodeServerManager.ensureBaseUrl() : null,
  createClient: (baseUrl, directory) => createOpenCodeClient(baseUrl, { directory }),
};
