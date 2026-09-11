import fs from "fs";
import path from "path";
import app from "./routes";
import { db } from "./db";
import { registry } from "./config/providers";
import { credentialStore } from "./services/credentials";
import { mcpManager } from "./services/mcp/manager";
import { initScheduler } from "./services/scheduler/scheduler";
import { logger } from "./lib/logger";

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

// Serve the built web app (web/dist) as a static fallback. API routes registered
// in ./routes take precedence because they are registered first; this catch-all
// is added last. Used by the ElectroBun desktop build, where WEB_DIST_DIR points
// at the bundled resources/web folder.
app.get("*", (c) => {
  const url = new URL(c.req.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";

  const filePath = path.join(DIST_DIR, rel);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    return new Response(fs.readFileSync(filePath), {
      headers: { "Content-Type": MIME[ext] || "application/octet-stream" },
    });
  }

  // SPA fallback to index.html
  const index = path.join(DIST_DIR, "index.html");
  if (fs.existsSync(index)) {
    return new Response(fs.readFileSync(index), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return c.notFound();
});

export async function startServer(port = 3000) {
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

  const server = Bun.serve({ fetch: app.fetch, port });
  logger.info("server", "started", {
    message: `http://localhost:${port} data=${process.env.DATA_DIR || path.join(process.cwd(), "data")}`,
  });
  return server;
}
