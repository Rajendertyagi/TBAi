import { logger } from "@/lib/logger";

/**
 * Result of bootstrapping an OpenCode session for a conversation.
 */
export interface OpenCodeSessionBootstrapResult {
  sessionId: string;
  directory: string | null;
}

/**
 * Conversation-keyed in-flight bootstrap registry.
 *
 * OpenCode session bootstrap is a CONVERSATION-IDENTITY operation.
 * Transient React component mount/unmount/remount churn must NOT abort or
 * duplicate an in-flight bootstrap request for the same conversation ID.
 *
 * Contract:
 * - Same conversation ID shares one in-flight promise.
 * - Different conversation IDs never share.
 * - Settlement cleans up the in-flight map (matching promise identity only),
 *   leaving the backend authoritative for future visits / revalidations.
 * - Failures clean up the registry entry so manual Retries re-attempt truthfully.
 * - Invalidate does NOT delete active in-flight promises to prevent duplicate fetches.
 */
const inFlightBootstraps = new Map<string, Promise<OpenCodeSessionBootstrapResult>>();

/**
 * Checks whether an in-flight bootstrap is currently executing for this conversation.
 */
export function hasInFlightBootstrap(conversationId: string | undefined): boolean {
  if (!conversationId) return false;
  return inFlightBootstraps.has(conversationId.trim());
}

/**
 * Ensures OpenCode session bootstrap executes at most once concurrently per conversation ID.
 * Concurrent callers for the same conversation share the single in-flight operation.
 *
 * @param conversationId - The TBAi conversation ID.
 */
export async function bootstrapOpenCodeSession(
  conversationId: string,
): Promise<OpenCodeSessionBootstrapResult> {
  const convId = typeof conversationId === "string" ? conversationId.trim() : "";
  if (!convId) {
    throw new Error("conversationId is required");
  }

  const existing = inFlightBootstraps.get(convId);
  if (existing) {
    return existing;
  }

  let promiseRef: { current: Promise<OpenCodeSessionBootstrapResult> | null } = { current: null };
  const promise = (async () => {
    const histStart = Date.now();
    logger.debug("opencode", "history.load_start", {
      ocSession: convId,
      conversationId: convId,
    });

    try {
      const res = await fetch("/api/opencode/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: convId }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        sessionId?: string;
        directory?: string | null;
        error?: string;
      };

      if (!res.ok) {
        logger.debug("opencode", "history.load_error", {
          ocSession: convId,
          status: res.status,
          errorType: "upstream_http_error",
          message: data.error ?? "Could not start OpenCode session",
        });
        throw new Error(data.error ?? "Could not start OpenCode session");
      }

      if (!data.sessionId) {
        throw new Error("Could not start OpenCode session");
      }

      logger.debug("opencode", "history.load_success", {
        ocSession: convId,
        status: res.status,
        elapsedMs: Date.now() - histStart,
        hasSession: Boolean(data.sessionId),
        hasDirectory: Boolean(data.directory),
      });

      return {
        sessionId: data.sessionId,
        directory: data.directory ?? null,
      };
    } finally {
      // Race protection: only delete if the map entry still holds THIS exact promise.
      if (inFlightBootstraps.get(convId) === promiseRef.current) {
        inFlightBootstraps.delete(convId);
      }
    }
  })();

  promiseRef.current = promise;
  inFlightBootstraps.set(convId, promise);
  return promise;
}

/**
 * Conservative invalidation: if an in-flight operation is active, leave it alone
 * so manual Retry does not spawn concurrent requests. Genuine failures already
 * self-clean upon rejection.
 */
export function invalidateBootstrap(_conversationId: string): void {
  // Conservative by contract: an active in-flight bootstrap is NOT cancelled or dropped.
  // When a bootstrap settles or fails, the map entry is automatically cleaned up.
}

/**
 * Reset all bootstrap entries. Strictly for test fixtures.
 */
export function clearAllBootstraps(): void {
  inFlightBootstraps.clear();
}
