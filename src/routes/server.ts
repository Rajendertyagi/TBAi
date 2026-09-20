import { Hono } from "hono";
import { serverPortBodySchema, startupPrefsBodySchema } from "../lib/validation";
import {
  getPersistedPort,
  isPortEnvLocked,
  persistConfiguredPort,
  resolveConfiguredPort,
} from "../services/server-port";
import {
  getPersistedStartMinimized,
  persistStartMinimized,
} from "../services/startup-prefs";
import { getActivePort, getInstanceId, restartListener } from "../services/server-listener";
import { logger } from "../lib/logger";

const app = new Hono<{ Variables: { requestId: string } }>();

/** Probe timeout: a listener answers locally in ms; anything slower is treated as occupied. */
const CHECK_PORT_TIMEOUT_MS = 2000;

function isBindConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /port_bind_failed/i.test(msg) && /in use|EADDRINUSE|address.*use/i.test(msg);
}

// Server identity: which port is live vs which is configured. `pending` is a
// UI-side notion (input differs from active) and is NOT tracked here — the
// server only ever knows active (listening now) and configured (used next boot).
app.get("/", (c) => {
  const configured = resolveConfiguredPort();
  return c.json({
    activePort: getActivePort(),
    configuredPort: configured.port,
    // Persisted value (null = never saved); lets the UI prefill honestly.
    persistedPort: getPersistedPort(),
    envLocked: configured.envLocked,
  });
});

// Save a new configured port WITHOUT restarting: the live listener is
// untouched, so the current page keeps working until restart is applied.
app.put("/port", async (c) => {
  if (isPortEnvLocked()) {
    return c.json({ error: "Port is set by the PORT environment variable" }, 409);
  }
  const parsed = serverPortBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid port (1-65535)", issues: parsed.error.issues }, 400);
  }
  try {
    persistConfiguredPort(parsed.data.port);
  } catch {
    return c.json({ error: "Could not persist port" }, 500);
  }
  return c.json({ configuredPort: parsed.data.port });
});

// Explicit restart: validate → persist → rebind the SAME server on the new
// port. The response is served by the old listener (still open); the client
// then polls the new origin's /healthz and navigates. On bind failure the old
// listener is untouched and the error is reported — success is never claimed.
app.post("/restart", async (c) => {
  if (isPortEnvLocked()) {
    return c.json({ error: "Port is set by the PORT environment variable" }, 409);
  }
  const body = await c.req.json().catch(() => ({}));
  const port =
    body && body.port !== undefined
      ? body.port
      : (resolveConfiguredPort().port ?? getActivePort());
  const parsed = serverPortBodySchema.safeParse({ port });
  if (!parsed.success) {
    return c.json({ error: "Invalid port (1-65535)", issues: parsed.error.issues }, 400);
  }
  try {
    const result = await restartListener(parsed.data.port);
    return c.json({ activePort: result.port, restarted: result.restarted });
  } catch (err) {
    const requestId = (c.get("requestId") as string | undefined) ?? "req_unknown";
    logger.warn("server", "restart_failed", {
      requestId,
      message: err instanceof Error ? err.message : "restart failed",
    });
    if (isBindConflict(err)) {
      return c.json({ error: `Port ${parsed.data.port} is already in use` }, 409);
    }
    return c.json(
      { error: err instanceof Error ? err.message : "Restart failed" },
      500,
    );
  }
});

// Per-boot instance identity for the Tauri shell's ownership proof: the
// launcher generates a fresh UUID per boot and matches this value before
// navigating. Process memory only — a 404 here means "not a current TBAi
// server" (old build or foreign process) and must never be navigated to.
app.get("/instance", (c) => {
  return c.json({ instanceId: getInstanceId() });
});

// Pre-flight availability probe: is anything listening on this port? Any HTTP
// response (any status) or a stalled accept means occupied; only a refused
// connection means free. Advisory only — restart still re-validates at bind
// time, so a port taken between check and restart fails honestly there.
app.post("/check-port", async (c) => {
  const parsed = serverPortBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid port (1-65535)", issues: parsed.error.issues }, 400);
  }
  const port = parsed.data.port;
  if (port === getActivePort()) {
    return c.json({ port, available: false, reason: "active_port" });
  }
  try {
    await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(CHECK_PORT_TIMEOUT_MS),
    });
    // Any response at all proves a listener.
    return c.json({ port, available: false, reason: "in_use" });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // Accepted but never answered — something is there.
      return c.json({ port, available: false, reason: "in_use" });
    }
    return c.json({ port, available: true });
  }
});

// Startup preferences (start minimized to tray). Same persist+mirror shape
// as the port: the DB owns the value, the file lets the launcher read it.
app.get("/startup", (c) => {
  return c.json({ startMinimized: getPersistedStartMinimized() });
});

app.put("/startup", async (c) => {
  const parsed = startupPrefsBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid startup preferences", issues: parsed.error.issues }, 400);
  }
  try {
    persistStartMinimized(parsed.data.startMinimized);
  } catch {
    return c.json({ error: "Could not persist startup preferences" }, 500);
  }
  return c.json({ startMinimized: parsed.data.startMinimized });
});

export default app;
