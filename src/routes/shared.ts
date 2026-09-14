import type { Context } from "hono";
import { ZodError } from "zod";

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
 */
export function storageError(c: Context, e: unknown, status = 500) {
  // Validation failures are client errors (400), not server faults.
  const resolved = e instanceof ZodError ? 400 : status;
  const requestId = c.get("requestId") as string | undefined;
  return c.json(
    { error: e instanceof Error ? e.message : "Unknown error", requestId },
    resolved as 400 | 500,
  );
}
