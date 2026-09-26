import path from "path";
import app from "./routes";
import { db } from "./db";
import { registry } from "./config/providers";
import { credentialStore } from "./services/credentials";
import { mcpManager } from "./services/mcp/manager";
import { openCodeServerManager } from "./services/opencode/serverManager";
import { chatRuns } from "./services/chat-runs";
import { initScheduler, beginSchedulerShutdown, abortAllRuns } from "./services/scheduler/scheduler";
import { gcOrphanChatDirs } from "./services/workspace";
import { applyPersistedLogSettings } from "./services/log-settings";
import { recoverOrphanedChatStreams } from "./services/chat-streams/boot";
import { startChatStreamCleanup, stopChatStreamCleanup } from "./services/chat-streams/cleanup";
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

function ensureSignalHandlers(): void {
  if (signalsRegistered) return;
  signalsRegistered = true;
  // Resolve the server lazily: a port restart swaps the owned listener, and
  // a signal arriving afterwards must shut down the CURRENT one.
  process.on("SIGINT", () => {
    const server = getActiveServer();
    if (server) void shutdownServer(server, "SIGINT");
  });
  process.on("SIGTERM", () => {
    const server = getActiveServer();
    if (server) void shutdownServer(server, "SIGTERM");
  });
}

export async function startServer(port = resolveConfiguredPort().port) {
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
  await initScheduler();

  // Periodic reclamation of expired terminal resumable streams. Starts after
  // boot recovery (which owns orphaned `streaming` rows) and is idempotent, so a
  // repeated startServer never accumulates timers.
  startChatStreamCleanup(db);

  // Transport backstop: Bun kills connections idle for 10s by default, which
  // murders quiet streams (a thinking model, a long tool run). 240s covers
  // normal stalls for this local single-user app (Bun's maximum is 255).
  // Long-lived streaming responses additionally disable the timeout
  // per-request via disableIdleTimeout() — the global value is only the
  // backstop, never the mechanism that keeps streams alive. Ownership
  // (active server/port) lives in services/server-listener, which route
  // modules can import without closing an evaluation cycle back here.
  initListenerFetch(app.fetch);
  const bound = bindBootPort(port);
  const server: BunServer = bound.server;
  port = bound.port;
  logger.info("server", "started", {
    message: `http://localhost:${port} data=${process.env.DATA_DIR || path.join(process.cwd(), "data")}`,
  });

  // Mirror for the Tauri shell (reads the port file before spawning us).
  writePortFile(port);
  ensureSignalHandlers();

  return server;
}

let shuttingDown = false;

/**
 * Graceful shutdown: stop accepting new work immediately, cancel and settle
 * owned work, then close the SQLite database last. Each step is best-effort —
 * a failure in one teardown never blocks the others, and the process exits
 * regardless. The scheduler is gated first (no new fire/schedule, timers
 * cleared). server.stop(true) then force-closes client connections so shutdown
 * cannot wait on a browser SSE reader; the stop promise is awaited after
 * chat/scheduler runs have settled.
 */
export async function shutdownServer(
  server: ReturnType<typeof Bun.serve>,
  signal = "manual",
): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("server", "shutdown_initiated", { signal });

  // Gate the scheduler before anything else: no new fire/schedule can start,
  // and all cached timers are cleared.
  try {
    beginSchedulerShutdown();
  } catch (err) {
    logger.warn("scheduler", "shutdown_timers_failed", { ...normalizeError(err) });
  }

  let stopPromise: Promise<void> | undefined;
  try {
    // true = force-close active connections (browser SSE, logs, etc.) so the
    // process doesn't hang waiting for external clients to disconnect on their
    // own. Internal owned work (chat/scheduler runs) will be aborted explicitly below.
    stopPromise = server.stop(true);
  } catch (err) {
    logger.warn("server", "shutdown_stop_failed", { ...normalizeError(err) });
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
    // Chat runs settle via the route's onAbort/onError (markCancelled/Failed);
    // await that settlement so tool-call DB writes finish before db.close().
    const chatSettled = await chatRuns.awaitSettled();
    logger.info("chat", "shutdown_chat_settled", { ...chatSettled });
  } catch (err) {
    logger.warn("chat", "shutdown_chat_settle_failed", { ...normalizeError(err) });
  }

  try {
    const schedulerSettled = await abortAllRuns();
    logger.info("scheduler", "shutdown_runs_settled", { ...schedulerSettled });
  } catch (err) {
    logger.warn("scheduler", "shutdown_runs_failed", { ...normalizeError(err) });
  }

  try {
    await drainInflightRequests();
  } catch (err) {
    logger.warn("server", "shutdown_drain_failed", { ...normalizeError(err) });
  }

  if (stopPromise) {
    try {
      await stopPromise;
    } catch (err) {
      logger.warn("server", "shutdown_stop_await_failed", { ...normalizeError(err) });
    }
  }

  try {
    // Clear the retention timer before the database closes, so a tick can never
    // race a closed handle.
    if (stopChatStreamCleanup()) {
      logger.info("ai", "ai.stream_cleanup_stopped", { signal: "shutdown" });
    }
  } catch (err) {
    logger.warn("ai", "shutdown_stream_cleanup_failed", { ...normalizeError(err) });
  }

  try {
    // Bun's native sqlite is synchronous and fast. Explicitly closing ensures
    // all outstanding statements are finalized and the connection is released.
    db.close();
  } catch (err) {
    logger.warn("db", "shutdown_close_failed", { ...normalizeError(err) });
  }

  logger.info("server", "stopped");

  // All owned resources are closed above. Let the event loop drain naturally
  // so Bun/Node can flush stdout/file logging; forcing process.exit() here can
  // truncate the final shutdown evidence when stdout is piped.
  process.exitCode = 0;
}
