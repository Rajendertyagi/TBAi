import type { Context } from "hono";
import { logger, normalizeError } from "../lib/logger";

/** Storage/persistence route failure: structured log + safe response. */
export function storageError(c: Context, e: unknown, status = 500) {
  const requestId = c.get("requestId") as string | undefined;
  logger.warn("storage", "operation_failed", {
    requestId,
    message: `${c.req.method} ${c.req.path}`,
    ...normalizeError(e),
  });
  return c.json(
    { error: e instanceof Error ? e.message : "Unknown error", requestId },
    status as 500,
  );
}
