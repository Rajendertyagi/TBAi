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
 *     row is cleared and the session is NEVER deleted.
 *  3. A row younger than the grace window is left alone.
 *  4. Absence must be positive (a 404). A lookup that fails for any other
 *     reason leaves the row unresolved for a later pass.
 *  5. **A bare 404 never clears a risk-bearing intent.** A create whose
 *     response was lost may still commit after the lookup. Such a row is
 *     retained, rotated behind unexamined rows, and only released after the
 *     absence horizon — a bounded best effort, because upstream exposes no
 *     terminality signal (documented in the ADR).
 *  6. Ownership is re-checked immediately before removal, so a pointer that
 *     appeared while the probe was in flight still wins.
 *  7. Removal is confirmed by a follow-up lookup, exactly as the create path
 *     does. "The call returned" is never treated as "the session is gone".
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
  /** Stamps a confirmed orphan resolved (audit-retained, terminal). */
  resolve(conversationId: string, sessionId: string): Promise<boolean>;
  /** Deletes a proven-unused create intent. */
  deleteIntent(conversationId: string, sessionId: string): Promise<boolean>;
  /**
   * Records what one probe established. `present` clears the late-create risk;
   * `absent` stamps the first 404 and never clears it.
   */
  recordProbe(input: {
    conversationId: string;
    sessionId: string;
    outcome: "present" | "absent";
    at: number;
  }): Promise<boolean>;
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
  /** Rows cleared because the conversation now points at the session. */
  bound: number;
  /** Rows cleared because the remote session is positively absent. */
  absent: number;
  /** Remote sessions removed AND confirmed gone. */
  removed: number;
  /**
   * Risk-bearing intents retained after a 404: a lost create response may
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

/** Clears one row according to the obligation it actually carries. */
async function clearRow(
  record: OpenCodeOrphanRecord,
  reconcilerDeps: OpenCodeOrphanReconcilerDeps,
): Promise<boolean> {
  return record.phase === "intent"
    ? reconcilerDeps.deleteIntent(record.conversationId, record.sessionId)
    : reconcilerDeps.resolve(record.conversationId, record.sessionId);
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
    absent: 0,
    removed: 0,
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
        try {
          await clearRow(record, reconcilerDeps);
          report.bound += 1;
        } catch (error) {
          report.unresolved += 1;
          logger.warn("opencode", "opencode.orphan_reconcile_clear_failed", {
            conversationId: record.conversationId,
            phase: record.phase,
            ...classifyError(error),
          });
        }
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
        // Positive 404 — but only "absent at lookup time". For a risk-bearing
        // intent that is not terminal: the request whose response was lost may
        // still commit. Record the observation (which also rotates the row
        // behind unexamined ones) and keep the obligation until the bounded
        // absence horizon (rule 5).
        if (record.phase === "intent" && record.lateCreateRisk) {
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
          const firstAbsentAt = record.firstAbsentAt?.getTime() ?? observedAt;
          if (observedAt - firstAbsentAt < absenceHorizonMs) {
            report.lateRisk += 1;
            continue;
          }
          // The horizon elapsed: a bounded best effort, not proof (ADR).
          try {
            await clearRow(record, reconcilerDeps);
            report.expiredAbsent += 1;
          } catch (error) {
            report.unresolved += 1;
            logger.warn("opencode", "opencode.orphan_reconcile_clear_failed", {
              conversationId: record.conversationId,
              phase: record.phase,
              ...classifyError(error),
            });
          }
          continue;
        }

        // Every other 404 is terminal: an orphan was observed to exist, or a
        // risk-free intent never became one, so absence closes the obligation.
        try {
          await clearRow(record, reconcilerDeps);
          report.absent += 1;
        } catch (error) {
          report.unresolved += 1;
          logger.warn("opencode", "opencode.orphan_reconcile_clear_failed", {
            conversationId: record.conversationId,
            phase: record.phase,
            ...classifyError(error),
          });
        }
        continue;
      }

      // The exact id is present, so a duplicate create can only resolve to it:
      // record that observation (clearing the late-create risk) before acting.
      // Best-effort: the row survives if this write fails, which can only make
      // a later 404 retain it longer.
      try {
        await reconcilerDeps.recordProbe({
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
        try {
          await clearRow(record, reconcilerDeps);
          report.bound += 1;
        } catch (error) {
          report.unresolved += 1;
          logger.warn("opencode", "opencode.orphan_reconcile_clear_failed", {
            conversationId: record.conversationId,
            phase: record.phase,
            ...classifyError(error),
          });
        }
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
      try {
        await clearRow(record, reconcilerDeps);
        report.removed += 1;
      } catch (error) {
        report.unresolved += 1;
        logger.warn("opencode", "opencode.orphan_reconcile_clear_failed", {
          conversationId: record.conversationId,
          phase: record.phase,
          ...classifyError(error),
        });
      }
    }

    ticks += 1;
    if (
      report.scanned > 0 ||
      report.deferred > 0 ||
      report.inflight > 0 ||
      report.removed > 0 ||
      report.unresolved > 0
    ) {
      logger.info("opencode", "opencode.orphan_reconciled", {
        signal: "interval",
        scanned: report.scanned,
        deferred: report.deferred,
        inflight: report.inflight,
        bound: report.bound,
        absent: report.absent,
        removed: report.removed,
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
  resolve: (conversationId, sessionId) =>
    opencodeOrphanService.resolveOrphanedSession(conversationId, sessionId),
  deleteIntent: (conversationId, sessionId) =>
    opencodeOrphanService.deleteCreateIntent(conversationId, sessionId),
  recordProbe: (input) => opencodeOrphanService.recordProbe(input),
  isCreateInFlight: isOpenCodeSessionCreateInFlight,
  getRunningBaseUrl: async () =>
    openCodeServerManager.isRunning() ? openCodeServerManager.ensureBaseUrl() : null,
  createClient: (baseUrl, directory) => createOpenCodeClient(baseUrl, { directory }),
};
