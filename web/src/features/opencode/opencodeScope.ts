/**
 * The one place that knows how an OpenCode request is addressed to the right
 * instance.
 *
 * OpenCode's permission and question stores are **directory-scoped**: the same
 * routes answer `[]` / 404 when asked without a location and return the real
 * pending request when asked with the session's directory. Measured live on the
 * managed 1.18.31 server:
 *
 *   GET  /permission                          -> []
 *   GET  /permission?directory=<sessionDir>   -> [ <the pending request> ]
 *   POST /permission/<id>/reply?directory=<dir> {reply:"once"} -> 200 true
 *
 * `@assistant-ui/react-opencode@0.2.23` calls these routes **unscoped** (the
 * same omission the event subscription had), so both compatibility patches must
 * supply the authoritative directory. This module owns that rule once so the
 * permission and question patches cannot drift apart.
 */

/**
 * The location scope of the runtime's OpenCode session.
 *
 * `directory` is the value the OpenCode server records on the session (delivered
 * to the browser by the backend seam that mints the session id) — never derived
 * from a conversation, route, tab or thread id.
 */
export interface OpenCodeScope {
  /** The OpenCode session id; used only by the legacy compatibility fallback. */
  readonly sessionId: string | undefined;
  /** The session's directory as the server records it, or `null` when unknown. */
  readonly directory: string | null;
}

/**
 * Adds the authoritative directory to a params object, but only when it is
 * known. A missing directory is left absent rather than guessed, which
 * reproduces the previous (unscoped) behaviour instead of inventing a location.
 *
 * @param params - The SDK params for the call.
 * @param directory - The session directory, or `null`.
 * @returns The params, with `directory` added when it is known.
 */
export function withDirectory<T extends object>(
  params: T,
  directory: string | null,
): T & { directory?: string } {
  return directory ? { ...params, directory } : params;
}

/** Reads the HTTP status the SDK attached to a thrown client error. */
export function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return undefined;
  const status = (cause as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/** The message a throwable carries, whatever shape it is. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * True only when the server reports that the requested route is not
 * implemented — the one condition the legacy compatibility fallback exists for.
 *
 * The installed client throws this exact wording when a route falls through to
 * OpenCode's SPA handler (`HTTP 200 text/html`), which is how a missing route
 * presents on this server; `405`/`501` cover an explicit method rejection.
 * Deliberately narrow: a `404` (permission not found) or any network/transient
 * failure must NOT trigger a fallback — those are real outcomes, not
 * compatibility gaps.
 *
 * @param error - The value thrown by the SDK.
 * @returns True when the route itself is unsupported by this server build.
 */
export function isRouteUnsupported(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 405 || status === 501) return true;
  return /not supported by this version of opencode server/i.test(messageOf(error));
}
