import { Hono } from "hono";
import { cors } from "hono/cors";
import { redact } from "../lib/redact";
import { logger, newRequestId, runWithRequestContext, normalizeError } from "../lib/logger";
import mcpApp from "./mcp";
import logsApp from "./logs";
import schedulerApp from "./scheduler";
import chatApp from "./chat";
import toolsApp from "./tools";
import providersApp from "./providers";
import conversationsApp from "./conversations";
import memoriesApp from "./memories";

/**
 * Application composition root: middleware + sub-app mounts.
 * Feature routes live in their own modules (chat/tools/providers/
 * conversations/memories/mcp/logs/scheduler); this file owns only
 * cross-cutting concerns (CORS, request correlation, error handling).
 */
const app = new Hono<{ Variables: { requestId: string } }>();

app.use("*", cors());

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
    logger.info("http", "request_completed", {
      requestId,
      message: `${c.req.method} ${c.req.path}`,
      statusCode: c.res.status,
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

// MCP client management API (generic MCP servers: STDIO / Streamable HTTP / SSE).
app.route("/api/mcp", mcpApp);

// Live application logs (in-memory ring buffer; post-redaction).
app.route("/api/logs", logsApp);

// Built-in scheduler / cron (SQLite-backed, Bun.cron + one-time timers).
app.route("/api/scheduler", schedulerApp);

// Error handler — redact any accidental secret material before logging/responding.
app.onError((err, c) => {
  const requestId = (c.get("requestId") as string | undefined) ?? "req_unknown";
  const norm = normalizeError(err);
  logger.error("http", "unhandled_error", { requestId, ...norm });
  return c.json({ error: redact(err instanceof Error ? err.message : "Unknown error"), requestId }, 500);
});

// Health check
app.get("/api/health", (c) => c.json({ status: "ok" }));

export default app;
