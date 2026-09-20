import crypto from "crypto";
import { logger, normalizeError } from "../lib/logger";
import { isPortEnvLocked, persistConfiguredPort } from "./server-port";

export type BunServer = ReturnType<typeof Bun.serve>;
export type FetchHandler = (req: Request) => Response | Promise<Response>;

/**
 * Single-listener ownership for the one application web server.
 *
 * This module deliberately does NOT import the Hono app (`../routes`) or
 * `../server`: route modules import FROM here, so importing them back would
 * close an evaluation cycle (`routes/index` → `routes/server` → `server` →
 * `routes/index`) that leaves `app` in TDZ whenever the routes are loaded
 * without going through the server entry first (e.g. isolated route tests).
 * The fetch handler is injected once at boot via `initListenerFetch`.
 */

// Single application server invariant: exactly one listener at a time.
// `activeServer`/`activePort` are the only ownership record — restart swaps
// them, never duplicates them.
let fetchHandler: FetchHandler | null = null;
let activeServer: BunServer | null = null;
let activePort = 0;

/** Transport backstop (see server.ts): Bun's max is 255; 240 covers stalls. */
const LISTENER_IDLE_TIMEOUT_S = 240;

// Delay before the replaced listener stops, so the in-flight restart response
// already on the wire has time to flush. NOT a timing fix: correctness never
// depends on it — worst case the old origin serves a few extra requests until
// the client navigates to the new one.
const OLD_LISTENER_CLOSE_DELAY_MS = 500;

/** How far above the configured port the boot heal scan may go. */
const HEAL_SCAN_LIMIT = 100;

/** Register the Hono fetch handler once at boot, before any bind. */
export function initListenerFetch(fetch: FetchHandler): void {
  fetchHandler = fetch;
}

function requireFetch(): FetchHandler {
  if (!fetchHandler) throw new Error("listener_not_initialized");
  return fetchHandler;
}

/** The currently owned listener, if any (signal handlers resolve lazily). */
export function getActiveServer(): BunServer | null {
  return activeServer;
}

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
  return Bun.serve({ fetch: requireFetch(), port, idleTimeout: LISTENER_IDLE_TIMEOUT_S });
}

function setActive(server: BunServer, port: number): void {
  activeServer = server;
  activePort = port;
}

/**
 * Boot bind with self-heal: an explicitly configured port (PORT env) that is
 * occupied is an operator conflict and fails honestly; anything else scans
 * upward and persists the winner so the mirror file, the next boot, and the
 * Tauri shell all agree on where this instance actually lives.
 */
export function bindBootPort(port: number): { server: BunServer; port: number } {
  try {
    const server = bindListener(port);
    setActive(server, port);
    return { server, port };
  } catch (err) {
    if (!isAddrInUse(err) || isPortEnvLocked()) throw err;
    for (let next = port + 1; next <= port + HEAL_SCAN_LIMIT; next++) {
      try {
        persistConfiguredPort(next);
        logger.info("server", "port_healed", {
          message: `port ${port} occupied, bound ${next}`,
        });
        const server = bindListener(next);
        setActive(server, next);
        return { server, port: next };
      } catch (healErr) {
        if (!isAddrInUse(healErr)) throw healErr;
      }
    }
    throw err;
  }
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
  setActive(next, port);
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
