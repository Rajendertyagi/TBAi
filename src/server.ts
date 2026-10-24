import app from "./routes";
import { db } from "./db";
import { DATA_DIR } from "./config/data-dir";
import { registry } from "./config/providers";
import { credentialStore } from "./services/credentials";
import { mcpManager } from "./services/mcp/manager";
import { openCodeServerManager } from "./services/opencode/serverManager";
import { chatRuns } from "./services/chat-runs";
import {
  recoverEssential,
  recoverOverdue,
  setSchedulerReady,
  beginSchedulerShutdown,
  abortAllRuns,
  hasPendingRuns as hasSchedulerPendingRuns,
} from "./services/scheduler/scheduler";
import { gcOrphanChatDirs } from "./services/workspace";
import { applyPersistedLogSettings } from "./services/log-settings";
import { recoverOrphanedChatStreams } from "./services/chat-streams/boot";
import {
  startChatStreamCleanup,
  stopChatStreamCleanup,
  drainChatStreamCleanup,
} from "./services/chat-streams/cleanup";
import {
  chatClaimedHistoryRecoveryDeps,
  drainClaimedHistoryRecovery,
  recoverStaleClaimedHistory,
  startClaimedHistoryRecovery,
  stopClaimedHistoryRecovery,
} from "./services/chat-streams/claimedHistoryRecovery";
import {
  chatHistoryReconcilerDeps,
  drainHistoryReconciliation,
  startHistoryReconciliation,
  stopHistoryReconciliation,
} from "./services/chat-streams/historyReconciler";
import {
  drainOrphanReconciliation,
  openCodeOrphanReconcilerDeps,
  startOrphanReconciliation,
  stopOrphanReconciliation,
} from "./services/opencode/orphanReconciler";
import { resolveConfiguredPort, writePortFile } from "./services/server-port";
import {
  bindBootPort,
  getActiveServer,
  initListenerFetch,
  type BunServer,
} from "./services/server-listener";
import { logger, normalizeError } from "./lib/logger";
import { drainInflightRequests } from "./services/http-metrics";

let signalsRegistered = false;
/** True while startServer is running; signals arriving in this window defer. */
let startingUp = false;
/** A signal that arrived during startup, handled once startup settles. */
let pendingSignal: string | null = null;
let signalCount = 0;
let processExitHandled = false;

/**
 * Coordinate process-level shutdown and exit.
 * Safe against concurrent triggers (signals, stdin, deferred startup signals).
 */
export async function handleProcessShutdown(
  server: BunServer | null,
  signal: string,
): Promise<ShutdownResult> {
  const active = server ?? getActiveServer();
  if (!active) {
    if (!processExitHandled) {
      processExitHandled = true;
      process.exit(0);
    }
    return { outcome: "complete", exitCode: 0 };
  }

  const result = await shutdownServer(active, signal);
  if (!processExitHandled) {
    processExitHandled = true;
    process.exit(result.exitCode);
  }
  return result;
}

function ensureSignalHandlers(): void {
  if (signalsRegistered) return;
  signalsRegistered = true;

  const onSignal = (signal: "SIGINT" | "SIGTERM") => {
    signalCount++;
    if (startingUp) {
      pendingSignal = signal;
      return;
    }
    if (shutdownPromise) {
      logger.warn("server", "shutdown_signal_repeated", { signal, count: signalCount });
      return;
    }
    void handleProcessShutdown(getActiveServer(), signal);
  };

  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}

export async function startServer(port = resolveConfiguredPort().port) {
  startingUp = true;
  pendingSignal = null;
  try {
    // Stored log capture settings win over env defaults (unless TBAI_LOG_LEVEL
    // is set, which owns the level). Applied before serving so early requests
    // are captured under the configured filter.
    applyPersistedLogSettings();

    // Provider/credential state must be ready before scheduler recovery can
    // execute an overdue job. Independent cleanup work can still run in
    // parallel, but recovery is deliberately sequenced after the registry and
    // credential boundary are loaded.
    await registry.loadFromDb(db);
    credentialStore.initialize();

    // Durable Direct-chat stream recovery: any row still marked `streaming`
    // belonged to a process that no longer exists, so it becomes
    // error/interrupted before anything else can read it. Runs before MCP and the
    // scheduler so a reconciliation failure aborts the boot loudly rather than
    // serving stale stream records.
    const streamRecovery = recoverOrphanedChatStreams(db);
    if (streamRecovery.interrupted > 0) {
      logger.warn("ai", "ai.stream_recovered", {
        signal: "boot",
        interrupted: streamRecovery.interrupted,
        scanned: streamRecovery.scanned,
        // Ids only — never chunk contents or provider text.
        streamIds: streamRecovery.streamIds,
      });
    }
    if (streamRecovery.preservedVerdicts > 0) {
      // The run had already settled (its reply may be in history) and only its byte
      // stream was cut. Logged separately so an operator reading `interrupted` is
      // never told a finished reply was lost.
      logger.warn("ai", "ai.stream_verdict_preserved", {
        signal: "boot",
        preserved: streamRecovery.preservedVerdicts,
        scanned: streamRecovery.scanned,
        streamIds: streamRecovery.preservedStreamIds,
      });
    }

    await Promise.all([mcpManager.init(), gcOrphanChatDirs()]);

    // Boot recovery of abandoned history claims: a process that died between the
    // guarded history claim and its closing write leaves a `claimed` row that no
    // component scans (reconciliation reads `pending` only). The sweep closes those
    // rows before cleanup and reconciliation run, and both are gated on it so neither
    // starts until it has had its chance. Started here, after exclusive instance
    // ownership exists, and not awaited: it is bounded bookkeeping and the gates keep
    // dependent work behind it.
    const claimedRecovery = recoverStaleClaimedHistory(chatClaimedHistoryRecoveryDeps);
    // The sweep reports its own failures and never rejects. Catching here keeps that
    // guarantee local, so a gate torn down before it settles (a shutdown during boot)
    // cannot surface as an unhandled rejection.
    const swept = claimedRecovery.catch(() => null);
    // Cleanup may only reclaim expired rows once the sweep has PROVEN it examined the
    // whole candidate set. A failed sweep reads as `null`, which is not `drained`.
    const recoveryGate = swept.then((report) => report?.stopReason === "drained");
    // Recurring recovery: the boot sweep above is one-shot, so claims that were too
    // fresh at startup (younger than the staleness window) would otherwise wait for
    // the next process. This timer re-runs the SAME sweep periodically; it is gated
    // on the boot sweep and does not fire immediately, since the boot sweep already
    // handled everything it could.
    startClaimedHistoryRecovery(chatClaimedHistoryRecoveryDeps, {
      gate: recoveryGate,
      runImmediately: false,
    });

    // Periodic reclamation of expired terminal resumable streams. Starts after
    // boot recovery (which owns orphaned `streaming` rows) and is idempotent, so a
    // repeated startServer never accumulates timers. Only its first tick is gated,
    // and the store's own hold on unresolved claims protects those rows regardless.
    startChatStreamCleanup(db, { gate: recoveryGate });

    // Reconciliation of completed runs whose client never persisted the reply.
    // Separate from cleanup on purpose: cleanup owns expiry, this owns an
    // unfinished history obligation. Both are unref'd and idempotent. Gated on the
    // claim sweep above so it cannot begin until abandoned claims are settled.
    startHistoryReconciliation({ deps: chatHistoryReconcilerDeps, gate: swept });

    // OpenCode session journal reconciliation (RT-001): drains create intents
    // and confirmed orphans left by a failed or crashed create. Fire-and-forget
    // and unref'd, and it never starts the managed server — the boot pass only
    // clears rows that are provably bound, and remote probes wait for a pass
    // that runs while Code mode already has the server up.
    startOrphanReconciliation({ deps: openCodeOrphanReconcilerDeps });

    // Transport backstop: Bun kills connections idle for 10s by default, which
    // murders quiet streams (a thinking model, a long tool run). 240s covers
    // normal stalls for this local single-user app (Bun's maximum is 255).
    // Long-lived streaming responses additionally disable the timeout
    // per-request via disableIdleTimeout() — the global value is only the
    // backstop, never the mechanism that keeps streams alive. Ownership
    // (active server/port) lives in services/server-listener, which route
    // modules can import without closing an evaluation cycle back here.
    //
    // The listener binds BEFORE scheduler recovery: overdue one-time jobs can
    // each take up to `timeoutSeconds` of provider time, and that must not
    // delay the bind the Tauri handshake waits on.
    initListenerFetch(app.fetch);
    const bound = bindBootPort(port);
    const server: BunServer = bound.server;
    port = bound.port;
    logger.info("server", "started", {
      message: `http://localhost:${port} data=${DATA_DIR}`,
    });

    // Mirror for the Tauri shell (reads the port file before spawning us).
    writePortFile(port);
    ensureSignalHandlers();

    // Scheduler recovery, split: essential state + timer rebuild first (fast),
    // overdue one-time execution after (slow). Scheduler-dependent routes 503
    // until the essential half completes.
    await recoverEssential();
    setSchedulerReady(true);
    await recoverOverdue();

    const deferred = pendingSignal;
    pendingSignal = null;
    if (deferred) {
      // A signal arrived mid-startup and was deferred; the server is fully up,
      // so honor it now through the normal spine and process exit.
      void handleProcessShutdown(server, deferred);
    }

    return server;
  } finally {
    startingUp = false;
  }
}

export interface StartupRollbackResult {
  /** True when every acquired resource was released and the DB was closed. */
  ok: boolean;
  /** True when db.close() ran. False on the terminal-failure path. */
  dbClosed: boolean;
  /** True when a bounded wait expired with work still unsettled. */
  timedOut: boolean;
}

/**
 * Best-effort rollback for a failed startServer attempt.
 *
 * A failed startup bypasses the normal shutdown spine, so without this every
 * resource the attempt already acquired — MCP stdio children, reconnect
 * timers, scheduler timers, background workers, the bound listener — would
 * have no cleanup path. Each step is individually try/catch'd so one failure
 * cannot block the others.
 *
 * Two outcomes: when every tracked operation settles, the database closes and
 * the result is ok. When an operation remains unsettled past its bound and can
 * still write, the database is deliberately left open and the result is not
 * ok — the caller must terminate the process explicitly rather than claim a
 * successful rollback.
 */
export async function rollbackPartialStartup(): Promise<StartupRollbackResult> {
  let timedOut = false;

  // 1. Stop new initialization: gate the scheduler first so no fire/schedule
  // can start while teardown runs.
  try {
    beginSchedulerShutdown();
  } catch (err) {
    logger.warn("scheduler", "shutdown_timers_failed", { ...normalizeError(err) });
  }

  // 2+3. MCP: disconnectAll invalidates in-flight attempts before awaiting
  // them (bounded), then disconnects every registered connection.
  try {
    await mcpManager.disconnectAll();
  } catch (err) {
    logger.warn("mcp", "shutdown_disconnect_failed", { ...normalizeError(err) });
  }

  // Chat runs cannot exist before serving, but abort defensively: create()
  // after abortAll returns a terminal record, so this is a no-op gate.
  try {
    chatRuns.abortAll();
    const chatSettled = await chatRuns.awaitSettled();
    timedOut = timedOut || chatSettled.timedOut > 0;
  } catch (err) {
    logger.warn("chat", "shutdown_chat_settle_failed", { ...normalizeError(err) });
  }

  // Scheduler recovery may have fired overdue jobs before failing.
  try {
    const schedulerSettled = await abortAllRuns();
    timedOut = timedOut || schedulerSettled.timedOut > 0;
  } catch (err) {
    logger.warn("scheduler", "shutdown_runs_failed", { ...normalizeError(err) });
  }

  // Background timers started before the failure.
  try {
    stopOrphanReconciliation();
    await drainOrphanReconciliation();
  } catch (err) {
    logger.warn("opencode", "shutdown_orphan_reconcile_failed", { ...normalizeError(err) });
    timedOut = true;
  }
  try {
    stopChatStreamCleanup();
  } catch (err) {
    logger.warn("ai", "shutdown_stream_cleanup_failed", { ...normalizeError(err) });
  }
  // A tick already reclaiming rows must finish before the database closes:
  // stopping the timer only prevents FUTURE ticks.
  try {
    await drainChatStreamCleanup();
  } catch (err) {
    logger.warn("ai", "shutdown_stream_cleanup_drain_failed", { ...normalizeError(err) });
    timedOut = true;
  }
  try {
    await drainHistoryReconciliation();
    if (stopHistoryReconciliation()) {
      logger.info("chat", "chat_history_reconcile_stopped", { signal: "rollback" });
    }
  } catch (err) {
    logger.warn("chat", "shutdown_history_reconcile_failed", { ...normalizeError(err) });
    timedOut = true;
  }
  try {
    if (stopClaimedHistoryRecovery()) {
      logger.info("chat", "chat_history_claimed_recovery_stopped", { signal: "rollback" });
    }
  } catch (err) {
    logger.warn("chat", "shutdown_claimed_history_recovery_failed", { ...normalizeError(err) });
    timedOut = true;
  }
  try {
    await drainClaimedHistoryRecovery();
  } catch (err) {
    logger.warn("chat", "shutdown_claimed_history_recovery_drain_failed", {
      ...normalizeError(err),
    });
    timedOut = true;
  }

  // OpenCode child: shutdown() returns early when never started.
  try {
    await openCodeServerManager.shutdown();
  } catch (err) {
    logger.warn("opencode", "shutdown_opencode_failed", { ...normalizeError(err) });
  }

  // Listener, if bound.
  const server = getActiveServer();
  if (server) {
    try {
      await server.stop(true);
    } catch (err) {
      logger.warn("server", "shutdown_stop_failed", { ...normalizeError(err) });
    }
  }

  // 4. Terminal-failure check: any DB-capable work still unsettled?
  //
  // MCP residual in-flight attempts are deliberately NOT terminal here. Every
  // mutation in connect() is generation-gated (ownsAttempt/ownsConnection at
  // each await boundary), connect() performs no SQLite writes, and
  // disconnectAll() already invalidated every tracked attempt and closed every
  // registered transport. An attempt that never settles afterwards is inert:
  // if it ever resumes it abandons without shared-state writes. What CAN still
  // write is a timed-out chat/scheduler run, and that fails the rollback.
  if (mcpManager.hasInflightConnects()) {
    logger.warn("server", "startup_rollback_inflight_remaining", {});
  }
  if (timedOut) {
    logger.error("server", "startup_rollback_failed", { timedOut });
    return { ok: false, dbClosed: false, timedOut: true };
  }

  // 5. Dispose dependencies last: the database closes only on the success path.
  try {
    db.close(true);
  } catch (err) {
    logger.warn("db", "shutdown_close_failed", { ...normalizeError(err) });
    return { ok: false, dbClosed: false, timedOut };
  }
  logger.info("server", "startup_rollback_complete", {});
  return { ok: true, dbClosed: true, timedOut };
}

export type ShutdownOutcome = "complete" | "deadline_expired" | "failed";

export interface ShutdownResult {
  outcome: ShutdownOutcome;
  exitCode: 0 | 1;
}

/**
 * Canonical shutdown promise. Repeated triggers observe the same completion
 * (shared completion semantics): every caller gets this promise, so no caller
 * can mistake a still-pending teardown for a finished one.
 */
let shutdownPromise: Promise<ShutdownResult> | null = null;

/**
 * Graceful shutdown: stop accepting new work immediately, cancel and settle
 * owned work, then close the SQLite database last. Each step is best-effort —
 * a failure in one teardown never blocks the others, and the process exits
 * regardless. The scheduler is gated first (no new fire/schedule, timers
 * cleared). server.stop(true) then force-closes client connections so shutdown
 * cannot wait on a browser SSE reader; the stop promise is awaited after
 * chat/scheduler runs have settled.
 *
 * Idempotent: the first call starts the single teardown and every later call
 * returns the same promise. Deliberately non-async so the stored promise is
 * returned directly rather than wrapped per call.
 *
 * Reusable and safe for in-process tests: never calls process.exit().
 */
export function shutdownServer(
  server: ReturnType<typeof Bun.serve>,
  signal = "manual",
): Promise<ShutdownResult> {
  if (!shutdownPromise) {
    shutdownPromise = runShutdown(server, signal);
  }
  return shutdownPromise;
}

/**
 * Classify a shutdown from what the drains observed. Pure function so the
 * contract is unit-testable without a live server:
 * - a failed cleanup step or still-active write-capable work → "failed"
 *   (database stays open, process exits non-zero);
 * - a fired deadline whose work subsequently stopped → "deadline_expired"
 *   (database closes, reported as such, never as complete);
 * - otherwise → "complete".
 *
 * `cleanupFailed` means a teardown step THREW, never that a bounded wait
 * expired. A bound expiring is what `deadlineHit` records, and whether it was
 * safe is what `writeCapableActive` answers at the re-check — the two are
 * deliberately separate inputs so late-settling work can still close safely.
 */
export function classifyShutdownCompletion(input: {
  deadlineHit: boolean;
  writeCapableActive: boolean;
  cleanupFailed: boolean;
}): ShutdownOutcome {
  if (input.cleanupFailed || input.writeCapableActive) return "failed";
  if (input.deadlineHit) return "deadline_expired";
  return "complete";
}

async function runShutdown(
  server: ReturnType<typeof Bun.serve>,
  signal: string,
): Promise<ShutdownResult> {
  logger.info("server", "shutdown_initiated", { signal });

  // Gate the scheduler before anything else: no new fire/schedule can start,
  // and all cached timers are cleared.
  //
  // Two separate facts, deliberately: `deadlineExpired` records that a settle
  // bound FIRED (reported, never fatal on its own), `shutdownFailed` records that
  // a teardown step THREW. Outcome is decided by the re-check below, not by
  // either of these alone.
  let deadlineExpired = false;
  let shutdownFailed = false;

  try {
    beginSchedulerShutdown();
  } catch (err) {
    logger.warn("scheduler", "shutdown_timers_failed", { ...normalizeError(err) });
  }

  let stopPromise: Promise<void> | undefined;
  try {
    stopPromise = server.stop(true);
  } catch (err) {
    logger.warn("server", "shutdown_stop_failed", { ...normalizeError(err) });
  }

  // Stop journal reconciliation BEFORE the OpenCode server goes away: a pass
  // already probing would otherwise race the child's teardown, and the drain
  // guarantees no journal write can land after the database closes.
  try {
    if (stopOrphanReconciliation()) {
      logger.info("opencode", "opencode.orphan_reconcile_stopped", { signal: "shutdown" });
    }
    await drainOrphanReconciliation();
  } catch (err) {
    logger.warn("opencode", "shutdown_orphan_reconcile_failed", { ...normalizeError(err) });
    shutdownFailed = true;
  }

  try {
    await openCodeServerManager.shutdown();
  } catch (err) {
    logger.warn("opencode", "shutdown_opencode_failed", { ...normalizeError(err) });
  }

  try {
    await mcpManager.disconnectAll();
  } catch (err) {
    logger.warn("mcp", "shutdown_disconnect_failed", { ...normalizeError(err) });
  }

  try {
    chatRuns.abortAll();
  } catch (err) {
    logger.warn("chat", "shutdown_chat_abort_failed", { ...normalizeError(err) });
  }

  try {
    const chatSettled = await chatRuns.awaitSettled();
    logger.info("chat", "shutdown_chat_settled", { ...chatSettled });
    // A fired bound is RECORDED, never failed: the re-check below (after every
    // drain) decides whether the work was still active when the bound expired.
    // Marking a timeout as a cleanup failure here would make that re-check
    // unable to upgrade a late-settling run to a safe close.
    if (chatSettled.deadlineHit) deadlineExpired = true;
  } catch (err) {
    logger.warn("chat", "shutdown_chat_settle_failed", { ...normalizeError(err) });
    shutdownFailed = true;
  }

  try {
    const schedulerSettled = await abortAllRuns();
    logger.info("scheduler", "shutdown_runs_settled", { ...schedulerSettled });
    // Same policy as the chat bound above.
    if (schedulerSettled.deadlineHit) deadlineExpired = true;
  } catch (err) {
    logger.warn("scheduler", "shutdown_runs_failed", { ...normalizeError(err) });
    shutdownFailed = true;
  }

  try {
    await drainInflightRequests();
  } catch (err) {
    logger.warn("server", "shutdown_drain_failed", { ...normalizeError(err) });
    shutdownFailed = true;
  }

  if (stopPromise) {
    try {
      await stopPromise;
    } catch (err) {
      logger.warn("server", "shutdown_stop_await_failed", { ...normalizeError(err) });
      shutdownFailed = true;
    }
  }

  try {
    if (stopChatStreamCleanup()) {
      logger.info("ai", "ai.stream_cleanup_stopped", { signal: "shutdown" });
    }
  } catch (err) {
    logger.warn("ai", "shutdown_stream_cleanup_failed", { ...normalizeError(err) });
    shutdownFailed = true;
  }

  // A tick already reclaiming rows must finish before the database closes:
  // clearing the timer only prevents FUTURE ticks.
  try {
    await drainChatStreamCleanup();
  } catch (err) {
    logger.warn("ai", "shutdown_stream_cleanup_drain_failed", { ...normalizeError(err) });
    shutdownFailed = true;
  }

  try {
    await drainHistoryReconciliation();
    if (stopHistoryReconciliation()) {
      logger.info("chat", "chat_history_reconcile_stopped", { signal: "shutdown" });
    }
  } catch (err) {
    logger.warn("chat", "shutdown_history_reconcile_failed", { ...normalizeError(err) });
    shutdownFailed = true;
  }

  try {
    if (stopClaimedHistoryRecovery()) {
      logger.info("chat", "chat_history_claimed_recovery_stopped", { signal: "shutdown" });
    }
  } catch (err) {
    logger.warn("chat", "shutdown_claimed_history_recovery_failed", { ...normalizeError(err) });
    shutdownFailed = true;
  }
  try {
    await drainClaimedHistoryRecovery();
  } catch (err) {
    logger.warn("chat", "shutdown_claimed_history_recovery_drain_failed", {
      ...normalizeError(err),
    });
    shutdownFailed = true;
  }

  // V1 re-check: a fired deadline records that the bound expired, but only
  // still-active write-capable work fails the shutdown. Work that settled
  // after the deadline but before this point is deadline-expired but safe.
  // Every gate and every drain ran before this point, so no new DB-writing
  // work can begin after it; settled work cannot un-settle.
  const writeCapableActive = chatRuns.hasUnsettledWork() || hasSchedulerPendingRuns();
  const outcome = classifyShutdownCompletion({
    deadlineHit: deadlineExpired,
    writeCapableActive,
    cleanupFailed: shutdownFailed,
  });
  if (outcome === "deadline_expired") {
    logger.warn("server", "shutdown_deadline_expired", { deadlineExpired });
  }

  // db.close(true) — the verified contract (bun 1.4.3, pinned by
  // tests/unit/persistence/sqlite-close-contract.test.ts): it does NOT throw for
  // statements that merely exist — a cached .query() handle, or an outstanding
  // .prepare() — it invalidates them, so any later use throws "Database has
  // closed" instead of writing. Without the flag that same .prepare() stays live
  // and its write lands after close, which is why every production close site
  // passes true. A close error SQLite does report is still fatal.
  let dbCloseFailed = false;
  if (outcome !== "failed") {
    try {
      db.close(true);
    } catch (err) {
      logger.warn("db", "shutdown_close_failed", { ...normalizeError(err) });
      dbCloseFailed = true;
    }
  } else {
    // Required cleanup failed or write-capable work may remain: do not close
    // the database. Return failure outcome with exitCode 1 so the database remains protected.
    logger.error("server", "shutdown_failed", { reason: "required_cleanup_failed" });
    process.exitCode = 1;
    return { outcome: "failed", exitCode: 1 };
  }

  if (dbCloseFailed) {
    logger.error("server", "shutdown_failed", { dbCloseFailed });
    process.exitCode = 1;
    return { outcome: "failed", exitCode: 1 };
  }

  if (outcome === "deadline_expired") {
    logger.info("server", "shutdown_deadline_expired", { deadlineExpired });
  } else {
    logger.info("server", "shutdown_complete", {});
  }

  // All owned resources are closed above. Set exit code 0.
  process.exitCode = 0;
  return { outcome, exitCode: 0 };
}
