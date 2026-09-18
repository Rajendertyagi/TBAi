/** Centralized OpenCode frontend configuration. No magic paths inline. */
export const OPENCODE_PROXY_BASE_URL = "/api/opencode";
/** Bounded wait for session init before surfacing a retry affordance. */
export const OPENCODE_INIT_TIMEOUT_MS = 15_000;

/**
 * How often to re-check pending permissions while a card is outstanding.
 * Permissions are rare and short-lived, so this is a handful of requests per
 * card and stops the moment the set empties.
 */
export const OPENCODE_PERMISSION_RECONCILE_MS = 5_000;

/**
 * Same-origin path of the **directory-scoped** pending-permission list, as the
 * managed server exposes it (`GET /permission?directory=<dir>`).
 *
 * The location is mandatory in practice: OpenCode's pending-permission store is
 * directory-scoped, so the same route answers `[]` without it. Measured live on
 * 1.18.31 while a request was genuinely pending.
 */
export function openCodePermissionPath(directory: string): string {
  return `${OPENCODE_PROXY_BASE_URL}/permission?directory=${encodeURIComponent(directory)}`;
}
