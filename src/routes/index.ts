import { Hono } from "hono";
import { cors } from "hono/cors";
import { redact } from "../lib/redact";
import { logger, newRequestId, runWithRequestContext } from "../lib/logger";
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

// Request correlation: every inbound request gets a requestId carried in an
// AsyncLocalStorage context (no globals), so chat → provider → tool → MCP →
// storage logs can be followed with one id. Explicit fields always win.
app.use("*", async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const requestId =
    incoming && /^[A-Za-z0-9_-]{1,64}$/.test(incoming) ? incoming : newRequestId();
  c.set("requestId", requestId);
  const started = Date.now();
  return runWithRequestContext({ requestId }, async () => {
    await next();
    const status = c.res.status;
    const message = `${c.req.method} ${c.req.path}`;
    if (status >= 400) {
      // Central error coverage: every failed response is logged here, so
      // routes never need their own error lines (see docs/logging.md).
      // Thrown errors bypass this (next() rejects) and land in onError below.
      logger[status >= 500 ? "error" : "warn"]("http", "http.error", {
        requestId,
        message,
        statusCode: status,
        durationMs: Date.now() - started,
      });
      return;
    }
    if (DEBUG_PATHS.some((p) => c.req.path.startsWith(p))) {
      logger.debug("http", "http.request", {
        requestId,
        message,
        statusCode: status,
        durationMs: Date.now() - started,
      });
      return;
    }
    logger.info("http", "http.request", {
      requestId,
      message,
      statusCode: status,
      durationMs: Date.now() - started,
    });
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
app.onError((err, c) => {
  const requestId = (c.get("requestId") as string | undefined) ?? "req_unknown";
  logger.error("http", "http.error", { requestId, ...classifyError(err) });
  return c.json({ error: redact(err instanceof Error ? err.message : "Unknown error"), requestId }, 500);
});

// Health check
app.get("/api/health", (c) => c.json({ status: "ok" }));

export default app;
