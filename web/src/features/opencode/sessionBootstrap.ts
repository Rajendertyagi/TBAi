import { logger } from "@/lib/logger";
import { apiFetch } from "@/lib/platform";
import type { V2ActivityState } from "./v2Types";

/**
 * Result of bootstrapping an OpenCode session for a conversation.
 */
export interface OpenCodeSessionBootstrapResult {
  sessionId: string;
  directory: string | null;
  /**
   * True only when the backend verified and adopted an existing live session.
   * A reuse fact, not a restart fact.
   */
  reusedExistingSession: boolean;
}

/**
 * The endpoint that mints/resumes an OpenCode session for a conversation.
 *
 * Exported so anything that has to recognise this request — notably tests that
 * count bootstrap traffic — matches the one canonical value instead of a second
 * copy of the literal.
 */
export const OPENCODE_BOOTSTRAP_PATH = "/api/opencode/session";

/**
 * The backend-filtered activity read for one conversation/session pair.
 *
 * `session.active` returns the managed process's GLOBAL active map, so the
 * browser never calls it. This TBAi route returns only the requested session's
 * activity and verifies the pair first.
 */
export const OPENCODE_SESSION_ACTIVITY_PATH = "/api/opencode/session/activity";

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

  const promiseRef: { current: Promise<OpenCodeSessionBootstrapResult> | null } = { current: null };
  const promise = (async () => {
    const histStart = Date.now();
    logger.debug("opencode", "history.load_start", {
      ocSession: convId,
      conversationId: convId,
    });

    try {
      const res = await apiFetch(OPENCODE_BOOTSTRAP_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: convId }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        sessionId?: string;
        directory?: string | null;
        reusedExistingSession?: unknown;
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
        // Strict: a malformed or absent value is NOT evidence of reuse.
        reusedExistingSession: data.reusedExistingSession === true,
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
 * Reads the backend-filtered activity for one session.
 *
 * This is a STATUS read, never a resume control, and it must never make a
 * conversation load fail: every failure — non-OK, malformed body, abort,
 * network — resolves to `unknown`. `unknown` is not idle, and a caller must
 * never render it as "not running".
 *
 * @param input - The conversation/session pair and the caller's abort signal.
 * @returns The confirmed activity, or `unknown` when none could be established.
 */
export async function fetchOpenCodeSessionActivity(input: {
  conversationId: string;
  sessionId: string;
  signal: AbortSignal;
}): Promise<V2ActivityState> {
  try {
    const res = await apiFetch(OPENCODE_SESSION_ACTIVITY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: input.conversationId,
        sessionId: input.sessionId,
      }),
      signal: input.signal,
    });
    const data = (await res.json().catch(() => ({}))) as { activity?: unknown };
    if (!res.ok) {
      logger.debug("opencode", "session.activity_read_failed", {
        status: res.status,
      });
      return "unknown";
    }
    // Only the two authoritative answers are accepted; anything else is a
    // malformed response, not a third state.
    return data.activity === "running" || data.activity === "not-running"
      ? data.activity
      : "unknown";
  } catch (error) {
    if (input.signal.aborted) return "unknown";
    logger.warn("opencode", "session.activity_read_error", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return "unknown";
  }
}

/**
 * Reset all bootstrap entries. Strictly for test fixtures.
 */
export function clearAllBootstraps(): void {
  inFlightBootstraps.clear();
}
