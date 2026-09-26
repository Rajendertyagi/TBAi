/**
 * Client-side chat transport failure classification (display layer only).
 *
 * When the browser's stream read dies (idle-timeout kill, proxy cut, reset),
 * the runtime stores the raw network error on the message and the UI would
 * render it verbatim ("network error", "terminated", ...). This maps those
 * transport signatures to a single accurate copy. Everything else renders
 * exactly as before — server copies (auth/rate-limit/generic), user cancel,
 * and unknown errors are never rewritten.
 *
 * Pure and dependency-free so it is trivially unit-tested. No recovery logic
 * lives here: there is deliberately no auto-retry (see docs/logging.md —
 * ai.recovery_* stays reserved for a future library-supported resume seam).
 */

export type ChatErrorKind = "transport" | "other";

/**
 * Copy for a transport kill.
 *
 * It states ONLY what this layer can actually observe — the connection dropped.
 * It deliberately does not claim what became of the run ("could not be resumed"):
 * that is a durable verdict the **server** owns, and it is surfaced separately by
 * the composer recovery strip, which is driven by the run's terminal kind. A
 * regex over transport signatures cannot know the difference between a run that
 * finished, one that was never resumable, and one that is resuming right now — so
 * claiming an outcome here was a guess dressed as a fact, and it made one event
 * read as two notices saying the same thing.
 */
export const TRANSPORT_ERROR_COPY = "Connection lost.";

// Raw browser/proxy transport signatures. Anchored or specific enough to never
// collide with our server-side sanitized copies ("Network error reaching the
// provider. Retry when online." etc. must keep rendering verbatim).
const TRANSPORT_RE =
  /(^|[\s:(])network error\.?\s*$|failed to fetch|terminated|incomplete|chunked|connection (reset|refused|closed)|load failed|socket|econn|net::err_|timed out|timeout/i;

const CANCEL_RE = /abort/i;

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  // DOMException and error-likes are not instanceof Error but still carry
  // name/message (String() on them is unreliable — often "[object ...]").
  if (typeof error === "object" && error !== null) {
    const rec = error as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name : "";
    const message = typeof rec.message === "string" ? rec.message : "";
    if (name || message) return `${name}: ${message}`;
  }
  return String(error ?? "");
}

export function classifyChatError(error: unknown): ChatErrorKind {
  const text = errorText(error);
  // User-cancel path (AbortError, aborted reads) stays on existing behavior.
  if (CANCEL_RE.test(text)) return "other";
  return TRANSPORT_RE.test(text) ? "transport" : "other";
}

/** User copy for transport kills, or null to render the original error. */
export function chatErrorCopy(kind: ChatErrorKind): string | null {
  return kind === "transport" ? TRANSPORT_ERROR_COPY : null;
}
