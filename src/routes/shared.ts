import type { Context } from "hono";
import { ZodError } from "zod";
import { sanitizeStreamError } from "../lib/redact";

/**
 * Disable Bun's idle timeout for the current streaming response.
 *
 * Bun.serve closes connections idle for `idleTimeout` seconds (global 240s
 * backstop, Bun maximum 255). A quiet stream — thinking model, long tool run,
 * paused SSE — counts as idle and would be killed mid-response, which the
 * browser reports as ERR_INCOMPLETE_CHUNKED_ENCODING.
 *
 * Bun passes its Server as Hono's `env`, so this reaches `server.timeout`
 * with no plumbing; the guard makes it a no-op anywhere else (tests, other
 * runtimes), where the global timeout remains the backstop. Apply ONLY to
 * long-lived streaming endpoints — never to regular request/response routes.
 */
export function disableIdleTimeout(c: {
  req: { raw: Request };
  env: unknown;
}): void {
  const server = (c.env ?? {}) as {
    timeout?: (req: Request, seconds: number) => void;
  };
  if (typeof server.timeout !== "function") return;
  try {
    server.timeout(c.req.raw, 0);
  } catch {
    /* best-effort; the global idleTimeout remains as backstop */
  }
}

/**
 * Storage/persistence route failure: safe response only. The edge middleware
 * logs every 4xx/5xx response centrally (see docs/logging.md), so this helper
 * stays a pure response mapper — no log call here by design.
 *
 * Validation failures are client errors (400), not server faults, and their
 * issues are returned STRUCTURALLY — the same `{ error, issues }` shape every
 * other route uses (chat, logs, mcp). Stringifying the issue array into `error`
 * made a 400 unreadable as copy and unusable as data.
 */
export function storageError(c: Context, e: unknown, status = 500) {
  const requestId = c.get("requestId") as string | undefined;
  if (e instanceof ZodError) {
    return c.json({ error: "Invalid request", issues: e.issues, requestId }, 400);
  }
  return c.json(
    { error: sanitizeStreamError(e), requestId },
    status as 500,
  );
}
