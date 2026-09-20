/**
 * Authoritative frontend log-scope registry.
 *
 * Mirror of `CLIENT_LOG_SCOPES` in `src/lib/log-scopes.ts` — the backend's
 * `POST /api/logs/client` boundary validates every incoming event against that
 * list, so the two must agree. `web/` is a separate package with its own
 * tsconfig, so the list is duplicated deliberately rather than shared; the
 * ingest validator is what stops the copies from drifting silently.
 *
 * `chat` and `opencode` are shared with the backend on purpose: one scope name
 * for a subsystem means a single scope query returns both planes in time
 * order, and the `plane: "client"` field marks the origin when that matters.
 */
export const CLIENT_LOG_SCOPES = [
  /** App-wide: global errors, boundary errors, route transitions, runtimes. */
  "app",
  /** Chat lifecycle: send, materialization, cancellation. */
  "chat",
  /** Composer interactions. */
  "composer",
  /** Backend availability / recovery state machine. */
  "availability",
  /** OpenCode adapter + session lifecycle. */
  "opencode",
  /** Approval decisions + question answers (permission flows). */
  "approval",
  "quick-messages.ui",
  "mcp.ui",
  "folders.ui",
] as const;

export type ClientLogScope = (typeof CLIENT_LOG_SCOPES)[number];

const KNOWN_SCOPE_ROOTS: readonly string[] = [...CLIENT_LOG_SCOPES];

/**
 * True when `scope` is a registered frontend scope or a child of one. Used by
 * the logger to reject an unregistered scope at the call site in development,
 * so the vocabulary cannot fragment by accident.
 */
export function isKnownClientScope(scope: string): boolean {
  for (const known of KNOWN_SCOPE_ROOTS) {
    if (scope === known || scope.startsWith(`${known}.`)) return true;
  }
  return false;
}
