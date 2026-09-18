import fs from "fs";
import path from "path";
import crypto from "crypto";
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
import {
  isPortEnvLocked,
  persistConfiguredPort,
  resolveConfiguredPort,
  writePortFile,
} from "./services/server-port";
import { logger, normalizeError } from "./lib/logger";

const DIST_DIR =
  process.env.WEB_DIST_DIR || path.join(process.cwd(), "web", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

// Cache policy for the static SPA shell (the single place browsers or the
// desktop webview can go stale). index.html is the mutable entry point and
// must revalidate every load; Vite content-hashes every other asset
// (`name-<hash>.ext`), so those are immutable for a year. Anything else
// keeps the previous behavior (no directives).
function cacheControlFor(rel: string): string | null {
  const base = path.basename(rel);
  if (base === "index.html") return "no-cache";
  if (/-[0-9A-Za-z_-]{6,}\.[a-z0-9]+$/.test(base)) {
    return "public, max-age=31536000, immutable";
  }
  return null;
}

// Minimal in-memory operational counters (Prometheus-style exposition). These
// are the server's own liveness/throughput signal — the source of truth for
// "is it still up, how many inflight, is it stalling" — and the /metrics
// endpoint below is the only place they are read. No external dependency;
// a small flat object is the minimum-custom-code choice over a metrics lib.
const metrics = {
  http_requests_total: 0,
  http_requests_inflight: 0,
  http_request_duration_ms_sum: 0,
  http_request_duration_ms_count: 0,
};

function metricsText(): string {
  return [
    "# HELP http_requests_total Total HTTP requests received",
    "# TYPE http_requests_total counter",
    `http_requests_total ${metrics.http_requests_total}`,
    "# HELP http_requests_inflight Inflight HTTP requests",
    "# TYPE http_requests_inflight gauge",
    `http_requests_inflight ${metrics.http_requests_inflight}`,
    "# HELP http_request_duration_ms_sum Sum of request durations in ms",
    "# TYPE http_request_duration_ms_sum counter",
    `http_request_duration_ms_sum ${metrics.http_request_duration_ms_sum.toFixed(0)}`,
    "# HELP http_request_duration_ms_count Count of requests recorded",
    "# TYPE http_request_duration_ms_count counter",
    `http_request_duration_ms_count ${metrics.http_request_duration_ms_count}`,
  ].join("\n");
}

// Observability endpoints. Registered before the SPA catch-all so they win
// precedence; they do no I/O beyond a DB ping (readyz) and the in-memory
// counters (metrics), so they are safe to poll from a watchdog / soak test.
app.get("/healthz", (c) => {
  void c;
  return new Response("ok", { status: 200 });
});

app.get("/readyz", async (c) => {
  void c;
  try {
    // Cheap DB liveness probe: if SQLite is healthy the query succeeds.
    db.query("SELECT 1 AS ok").get();
  } catch {
    return Response.json({ ready: false, error: "db_unavailable" }, {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  return Response.json({ ready: true }, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
});

app.get("/metrics", (c) => {
  void c;
  return new Response(metricsText(), {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
});

// Resolve a path inside DIST_DIR, refusing any traversal (../) that escapes
// the static root. Returns null when the decoded path resolves outside DIST_DIR
// — the SPA fallback then takes over. Keeps static serving safe without a
// custom router; the check is a single normalized-prefix guard.
function safeStaticPath(rel: string): string | null {
  const normalized = path.posix.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const resolved = path.resolve(DIST_DIR, "." + normalized);
  if (resolved !== DIST_DIR && !resolved.startsWith(DIST_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

// Request-accounting middleware: increments the in-flight gauge for the
// duration of every request and records total + duration on completion.
// Runs for every route (API + static) because Hono applies `use` handlers in
// registration order, and this is registered before the SPA catch-all. The
// requestId correlation itself is owned by the logger's AsyncLocalStorage
// (src/lib/logger.ts) — this middleware only measures, it does not mint ids,
// so it never overlaps the logger's contract.
app.use(async (c, next) => {
  const start = performance.now();
  metrics.http_requests_total++;
  metrics.http_requests_inflight++;
  try {
    await next();
  } finally {
    const durMs = performance.now() - start;
    metrics.http_request_duration_ms_sum += durMs;
    metrics.http_request_duration_ms_count++;
    metrics.http_requests_inflight--;
  }
});

// Serve the built web app (web/dist) as a static fallback. API routes registered
// in ./routes take precedence because they are registered first; this catch-all
// is added last. Used by the ElectroBun desktop build, where WEB_DIST_DIR points
// at the bundled resources/web folder. Files stream via Bun.file().stream() so a
// large asset is not fully buffered in memory; the path is traversal-checked.
app.get("*", (c) => {
  const url = new URL(c.req.url);
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (rel === "/") rel = "/index.html";

  const filePath = safeStaticPath(rel);
  if (filePath) {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (stat?.isFile()) {
      const ext = path.extname(filePath);
      const headers: Record<string, string> = {
        "Content-Type": MIME[ext] || "application/octet-stream",
      };
      const cache = cacheControlFor(rel);
      if (cache) headers["Cache-Control"] = cache;
      return new Response(Bun.file(filePath).stream(), { headers });
    }
  }

  // SPA fallback to index.html
  const index = path.join(DIST_DIR, "index.html");
  if (fs.existsSync(index)) {
    return new Response(Bun.file(index).stream(), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  }
  return c.notFound();
});

// Wait for inflight requests to drain before the listener fully stops, so an
// in-progress stream or response is not cut mid-flight on SIGINT/SIGTERM.
// Bounded: after the timeout we proceed regardless (the process is exiting).
async function drainInflightRequests(timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (metrics.http_requests_inflight > 0 && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

type BunServer = ReturnType<typeof Bun.serve>;

// Single application server invariant: exactly one listener at a time.
// `activeServer`/`activePort` are the only ownership record — restart swaps
// them, never duplicates them.
let activeServer: BunServer | null = null;
let activePort = 0;
let signalsRegistered = false;

// Delay before the replaced listener stops, so the in-flight restart response
// already on the wire has time to flush. NOT a timing fix: correctness never
// depends on it — worst case the old origin serves a few extra requests until
// the client navigates to the new one.
const OLD_LISTENER_CLOSE_DELAY_MS = 500;

/** The port the single server is currently listening on (0 before boot). */
export function getActivePort(): number {
  return activePort;
}

// Per-boot instance identity for the Tauri shell's ownership proof. The
// launcher passes TBAI_INSTANCE_ID (a fresh UUID per boot); a direct
// `bun run dev` boot mints its own. Process memory only — never persisted,
// never machine-derived — so a match proves THIS launch's server answered.
const INSTANCE_ID =
  process.env.TBAI_INSTANCE_ID?.trim() || crypto.randomUUID();

/** This boot's instance ID, served at GET /api/server/instance. */
export function getInstanceId(): string {
  return INSTANCE_ID;
}

function isAddrInUse(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /in use|EADDRINUSE|address.*use/i.test(msg);
}

function bindListener(port: number): BunServer {
  // Bun.serve binds synchronously and throws (EADDRINUSE) when the port is
  // occupied — the caller keeps the old listener untouched in that case.
  return Bun.serve({ fetch: app.fetch, port, idleTimeout: 240 });
}

// Self-healing boot bind: an explicitly configured port (PORT env) that is
// occupied is an operator conflict and fails honestly; anything else scans
// upward and persists the winner so the mirror file, the next boot, and the
// Tauri shell all agree on where this instance actually lives.
const HEAL_SCAN_LIMIT = 100;

function bindBootPort(port: number): { server: BunServer; port: number } {
  try {
    return { server: bindListener(port), port };
  } catch (err) {
    if (!isAddrInUse(err) || isPortEnvLocked()) throw err;
    for (let next = port + 1; next <= port + HEAL_SCAN_LIMIT; next++) {
      try {
        persistConfiguredPort(next);
        logger.info("server", "port_healed", {
          message: `port ${port} occupied, bound ${next}`,
        });
        return { server: bindListener(next), port: next };
      } catch (healErr) {
        if (!isAddrInUse(healErr)) throw healErr;
      }
    }
    throw err;
  }
}

function ensureSignalHandlers(): void {
  if (signalsRegistered) return;
  signalsRegistered = true;
  // Resolve the server lazily: a port restart swaps activeServer, and a
  // signal arriving afterwards must shut down the CURRENT listener.
  process.on("SIGINT", () => {
    if (activeServer) void shutdownServer(activeServer, "SIGINT");
  });
  process.on("SIGTERM", () => {
    if (activeServer) void shutdownServer(activeServer, "SIGTERM");
  });
}

export async function startServer(port = resolveConfiguredPort().port) {
  // Stored log capture settings win over env defaults (unless TBAI_LOG_LEVEL
  // is set, which owns the level). Applied before serving so early requests
  // are captured under the configured filter.
  applyPersistedLogSettings();
  await registry.loadFromDb(db);
  // Explicit startup initialization of the credential store (never an import
  // side effect). Reads whether a master password has been created.
  credentialStore.initialize();
  // Connect to enabled, auto-connect MCP servers (failures are recorded as
  // connection errors, not startup failures).
  await mcpManager.init();
  // Rebuild scheduler timers from SQLite (recurring + pending one-time),
  // reconcile interrupted runs, apply the missed-run policy.
  await initScheduler();
  // Reclaim orphaned chat scratch dirs (codeg parity: GC stale dirs not bound
  // to a live conversation). Non-fatal; runs once at startup.
  gcOrphanChatDirs();

  // Transport backstop: Bun kills connections idle for 10s by default, which
  // murders quiet streams (a thinking model, a long tool run). 240s covers
  // normal stalls for this local single-user app (Bun's maximum is 255).
  // Long-lived streaming responses additionally disable the timeout
  // per-request via disableIdleTimeout() — the global value is only the
  // backstop, never the mechanism that keeps streams alive.
  const bound = bindBootPort(port);
  const server = bound.server;
  port = bound.port;
  logger.info("server", "started", {
    message: `http://localhost:${port} data=${process.env.DATA_DIR || path.join(process.cwd(), "data")}`,
  });

  activeServer = server;
  activePort = port;
  // Mirror for the Tauri shell (reads the port file before spawning us).
  writePortFile(port);
  ensureSignalHandlers();

  return server;
}

/**
 * Rebind the single application server to a new port WITHOUT re-running
 * subsystem init and WITHOUT full shutdown (the DB stays open, scheduler
 * timers and MCP connections survive — only the HTTP listener moves).
 *
 * Order is the safety: bind the new listener first (throws on conflict, old
 * untouched), persist second (rollback: close the new listener, keep the
 * old), and only then swap active + close the old listener after the
 * in-flight restart response flushes. Returns restarted:false when the port
 * is already active — no work, no disruption.
 */
export async function restartListener(port: number): Promise<{ port: number; restarted: boolean }> {
  if (!activeServer) throw new Error("server_not_running");
  if (port === activePort) return { port: activePort, restarted: false };
  const previous = activeServer;
  let next: BunServer;
  try {
    next = bindListener(port);
  } catch (err) {
    throw new Error(`port_bind_failed: ${(err as Error)?.message ?? err}`, { cause: err });
  }
  try {
    persistConfiguredPort(port);
  } catch (err) {
    try {
      next.stop();
    } catch {
      /* rollback best-effort; old listener still owns the port */
    }
    throw new Error(`port_persist_failed: ${(err as Error)?.message ?? err}`, { cause: err });
  }
  activeServer = next;
  activePort = port;
  logger.info("server", "restarted", { message: `http://localhost:${port}` });
  setTimeout(() => {
    try {
      previous.stop();
    } catch (err) {
      logger.warn("server", "restart_old_stop_failed", { ...normalizeError(err) });
    }
  }, OLD_LISTENER_CLOSE_DELAY_MS);
  return { port, restarted: true };
}

let shuttingDown = false;

/**
 * Graceful shutdown: stop accepting new work immediately, cancel and settle
 * owned work, then close the SQLite database last. Each step is best-effort —
 * a failure in one teardown never blocks the others, and the process exits
 * regardless. The scheduler is gated first (no new fire/schedule, timers
 * cleared). server.stop() is then initiated WITHOUT awaiting so open streaming
 * connections keep draining while owned work is cancelled; the stop promise is
 * awaited only after chat/scheduler runs have settled.
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
    // own. Owned work (chat/scheduler runs) was already cancelled above.
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
    db.close();
  } catch (err) {
    logger.warn("db", "shutdown_close_failed", { ...normalizeError(err) });
  }
  logger.info("server", "stopped");
}
