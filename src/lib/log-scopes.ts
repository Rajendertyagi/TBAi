/**
 * Authoritative backend log-scope registry.
 *
 * One list, no dead entries. The registry is descriptive, not restrictive:
 * `logger.<level>(scope, …)` still accepts any string (tests and one-off
 * probes use throwaway scopes), but every scope the application actually
 * emits from production code MUST appear here, and `docs/logging.md` §8 must
 * match this file. Adding a scope means adding it here first.
 *
 * Hierarchy: scopes are dot-separated and a per-scope capture override matches
 * a scope plus everything below it (`mcp` covers `mcp.client`). Keep the tree
 * shallow — a child scope is only justified when it needs its own capture
 * level or its own volume budget.
 *
 * Frontend scopes are intentionally a SEPARATE registry (`web/src/lib/
 * log-scopes.ts`): the two planes share the scope *grammar* but not a module,
 * because `web/` is a separate package with its own tsconfig.
 */

/** Scopes emitted by TBAi backend production code. */
export const BACKEND_LOG_SCOPES = [
  /** HTTP edge: request audit + failed responses (throttle-exempt). */
  "http",
  /** Direct-chat AI funnel: stream lifecycle + provider errors. */
  "ai",
  /** Direct-chat request/stream diagnostics + chat-run shutdown lines. */
  "chat",
  /** Tool funnel: every model-invoked tool call. */
  "tool",
  /** MCP client: connect/disconnect/resources/prompts/elicitation. */
  "mcp",
  /** Scheduler: run lifecycle, admin actions, boot maintenance. */
  "scheduler",
  /** Credential store: decrypt/store failures (never key material). */
  "credential",
  /** OpenCode: managed process, sessions, proxy, SSE, SDK transport. */
  "opencode",
  /** Server lifecycle: boot, port, restart, shutdown. */
  "server",
  /** SQLite: schema migrations + close failures. */
  "db",
  /** Conversation workspace: GC + migration. */
  "workspace",
  /** Conversation lifecycle: materialize / open / update / delete. */
  "conversations",
] as const;

export type BackendLogScope = (typeof BACKEND_LOG_SCOPES)[number];

/**
 * Scopes the BROWSER plane emits, mirrored here so the ingest boundary can
 * validate them. `web/src/lib/log-scopes.ts` is the frontend-side owner of the
 * same list; a scope that is not in one of these two lists is rejected by
 * `POST /api/logs/client`, so the vocabulary cannot drift silently.
 *
 * Note `chat` and `opencode` appear in BOTH lists on purpose: a chat send or an
 * OpenCode session produces lines from both planes, and keeping one scope name
 * means a single scope query returns the whole story in time order. The
 * `plane: "client"` field distinguishes the origin when that matters.
 */
export const CLIENT_LOG_SCOPES = [
  /** Frontend app-wide: global errors, boundary errors, route transitions. */
  "app",
  /** Frontend chat lifecycle (send, materialization, cancellation). */
  "chat",
  /** Frontend composer interactions. */
  "composer",
  /** Frontend backend-availability / recovery state machine. */
  "availability",
  /** Frontend OpenCode V2 projection + session lifecycle. */
  "opencode",
  /** Frontend approval decisions + question answers (permission flows). */
  "approval",
  "quick-messages.ui",
  "mcp.ui",
  "folders.ui",
] as const;

export type ClientLogScope = (typeof CLIENT_LOG_SCOPES)[number];

const KNOWN_SCOPE_ROOTS: readonly string[] = [
  ...BACKEND_LOG_SCOPES,
  ...CLIENT_LOG_SCOPES,
];

const CLIENT_SCOPE_ROOTS: readonly string[] = [...CLIENT_LOG_SCOPES];

function matchesRoot(scope: string, roots: readonly string[]): boolean {
  for (const known of roots) {
    if (scope === known || scope.startsWith(`${known}.`)) return true;
  }
  return false;
}

/**
 * True when `scope` is a registered scope on either plane, or a child of one
 * (`opencode.transport` → true, `openocde` → false).
 */
export function isKnownLogScope(scope: string): boolean {
  return matchesRoot(scope, KNOWN_SCOPE_ROOTS);
}

/**
 * True when the BROWSER plane may emit `scope`. Deliberately narrower than
 * `isKnownLogScope`: the client may only use scopes the frontend actually owns,
 * so it cannot inject lines into a backend-only subsystem (e.g. `scheduler`)
 * and make a scope query lie about where a line came from.
 */
export function isKnownClientScope(scope: string): boolean {
  return matchesRoot(scope, CLIENT_SCOPE_ROOTS);
}

/** Backend-only variant (kept for callers that must not accept client scopes). */
export function isKnownBackendScope(scope: string): boolean {
  return matchesRoot(scope, BACKEND_LOG_SCOPES);
}
