import { Hono } from "hono";
import { cors } from "hono/cors";
import fs from "fs";
import path from "path";
import { redact } from "../lib/redact";
import { db } from "../db";
import { accountingMiddleware, metricsText, logLossMetricsText } from "../services/http-metrics";
import { logger, runWithRequestContext, getRequestContext, resolveInboundCorrelation } from "../lib/logger";
import { classifyError } from "../lib/errors";
import mcpApp from "./mcp";
import logsApp from "./logs";
import schedulerApp from "./scheduler";
import chatApp from "./chat";
import toolsApp from "./tools";
import providersApp from "./providers";
import conversationsApp from "./conversations";
import memoriesApp from "./memories";
import quickMessagesApp from "./quick-messages";
import workspaceApp from "./workspace";
import foldersApp from "./folders";
import opencodeApp from "./opencode";
import serverApp from "./server";

/**
 * Application composition root: middleware + sub-app mounts.
 * Feature routes live in their own modules (chat/tools/providers/
 * conversations/memories/mcp/logs/scheduler); this file owns only
 * cross-cutting concerns (CORS, request correlation, error handling).
 */
const app = new Hono<{ Variables: { requestId: string } }>();

app.use("*", cors());

// High-frequency poll paths whose 200s are noise, not audit. They stay fully
// error-covered (status >= 400 always logs above); only the routine hits drop
// to debug. A pending elicitation itself is an info event at the MCP funnel.
const DEBUG_PATHS = ["/api/mcp/elicit/pending"];

// Paths whose request START is not worth an info line: static assets,
// health/readiness/metrics probes, high-frequency polls, and the log viewer's
// own stream (logging it would log the logger). These still get completion and
// error coverage — only the start line is suppressed. A start line exists at
// all because a request that hangs or never completes is otherwise invisible:
// its completion line simply never arrives.
const QUIET_START_PATHS = [
  "/assets/",
  "/favicon",
  "/healthz",
  "/readyz",
  "/metrics",
  "/api/logs/stream",
  "/api/logs/recent",
  "/api/mcp/elicit/pending",
];

// Request correlation: every inbound request gets a requestId carried in an
// AsyncLocalStorage context (no globals), so chat → provider → tool → MCP →
// storage logs can be followed with one id. Explicit fields always win.
//
// Two ids, two scopes:
//   requestId   — this HTTP request (minted here, or echoed from x-request-id).
//   operationId — the ONE user action this request is part of, minted by the
//                 frontend and sent on X-TBAI-Operation-ID. A single action
//                 (send a prompt, open a Code session) fans out into several
//                 requests; they all share the operationId while each keeps
//                 its own requestId. Absent when nothing user-initiated is
//                 behind the request (probes, scheduler runs).
app.use("*", async (c, next) => {
  const { requestId, operationId } = resolveInboundCorrelation(c.req.raw.headers);
  c.set("requestId", requestId);
  const started = Date.now();
  const method = c.req.method;
  const path = c.req.path;
  return runWithRequestContext({ requestId, operationId }, async () => {
    if (!QUIET_START_PATHS.some((p) => path.startsWith(p))) {
      logger.info("http", "http.request_start", { method, path });
    }
    await next();
    const status = c.res.status;
    const message = `${method} ${path}`;
    const durationMs = Date.now() - started;
    if (status >= 400) {
      // Central error coverage: every failed response is logged here, so
      // routes never need their own error lines (see docs/logging.md).
      // Thrown errors bypass this (next() rejects) and land in onError below.
      logger[status >= 500 ? "error" : "warn"]("http", "http.error", {
        message,
        statusCode: status,
        durationMs,
      });
      return;
    }
    if (DEBUG_PATHS.some((p) => path.startsWith(p))) {
      logger.debug("http", "http.request", { message, statusCode: status, durationMs });
      return;
    }
    logger.info("http", "http.request", { message, statusCode: status, durationMs });
  });
});

// Feature sub-apps (each owns its own path prefix internally).
app.route("/", chatApp);
app.route("/", toolsApp);
app.route("/", providersApp);
app.route("/", conversationsApp);
app.route("/", memoriesApp);
app.route("/", quickMessagesApp);
app.route("/", workspaceApp);
app.route("/api/folders", foldersApp);

// MCP client management API (generic MCP servers: STDIO / Streamable HTTP / SSE).
app.route("/api/mcp", mcpApp);

// Live application logs (in-memory ring buffer; post-redaction).
app.route("/api/logs", logsApp);

// Built-in scheduler / cron (SQLite-backed, Bun.cron + one-time timers).
app.route("/api/scheduler", schedulerApp);

// OpenCode agent mode: managed server proxy + session lifecycle seam.
app.route("/api/opencode", opencodeApp);

// Single application server identity + explicit port restart.
app.route("/api/server", serverApp);

// Error handler — classify once; logging and the safe response consume the
// same classification. Redact any accidental secret material before responding.
// The operationId (when the failing request was part of a user action) is
// echoed so the browser can attach the failure to that action.
app.onError((err, c) => {
  const ctx = getRequestContext();
  const requestId =
    (c.get("requestId") as string | undefined) ?? ctx?.requestId ?? "req_unknown";
  logger.error("http", "http.error", { ...classifyError(err) });
  return c.json(
    {
      error: redact(err instanceof Error ? err.message : "Unknown error"),
      requestId,
      ...(ctx?.operationId ? { operationId: ctx.operationId } : {}),
    },
    500,
  );
});

// Health check
app.get("/api/health", (c) => c.json({ status: "ok" }));

// ---- Operational composition (owned here, with everything else) ----
//
// Observability endpoints, request accounting, and the static SPA fallback
// live in the composition root — the ONLY module that registers on the
// shared app besides the feature mounts above. This placement is
// load-bearing: server.ts must never register routes, because any module
// imported after traffic has built Hono's matcher would throw
// ("matcher already built") instead of registering. Import order can never
// cause that here — composition runs once, before any request.

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

// Resolve a path inside DIST_DIR, refusing any traversal (../) that escapes
// the static root. Returns null when the decoded path resolves outside DIST_DIR
// — the SPA fallback then takes over.
function safeStaticPath(rel: string): string | null {
  const normalized = path.posix.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const resolved = path.resolve(DIST_DIR, "." + normalized);
  if (resolved !== DIST_DIR && !resolved.startsWith(DIST_DIR + path.sep)) {
    return null;
  }
  return resolved;
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
  return new Response(`${metricsText()}\n${logLossMetricsText()}`, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
});

// Request-accounting middleware (see services/http-metrics). Registered here,
// after the feature mounts, exactly as before — Hono runs it for every route
// including the catch-all below.
app.use(accountingMiddleware);

// Serve the built web app (web/dist) as a static fallback. API routes take
// precedence because they are registered first; this catch-all is added last.
// Used by the desktop build, where WEB_DIST_DIR points at the bundled
// resources/web folder. Files stream via Bun.file().stream() so a large asset
// is not fully buffered in memory; the path is traversal-checked.
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

export default app;
