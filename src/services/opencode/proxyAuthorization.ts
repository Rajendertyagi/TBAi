/**
 * Workspace authorization for the OpenCode proxy.
 *
 * ## THE RULE
 *
 * The proxy forwards browser traffic to the managed OpenCode server. The
 * managed server resolves the *location* (working directory) of every request
 * from the `location[directory]` query parameter or the `x-opencode-directory`
 * header, and falls back to `process.cwd()` when neither is present. A
 * request that arrives with a caller-chosen location therefore reads and
 * writes in a directory the server did not choose.
 *
 * This module turns the **session id a request names** into the **one
 * directory that request may address**, through the local database:
 *
 * ```
 * OpenCode session id  →  conversation  →  folder  →  absolute directory
 * ```
 *
 * - `conversationService.findByOpenCodeSession` resolves the session id under
 *   the active service owner to the conversation that owns it.
 * - `resolveOpenCodeSessionDirectory` is **the** workspace authority: for imported
 *   conversations it returns the server-confirmed `opencodeDirectory`; for native
 *   TBAi conversations it resolves the registered folder.
 *
 * ## WHAT A SESSION ID IS, AND IS NOT
 *
 * A session id is a **selector** over workspaces this database already knows
 * about, not an authority over an arbitrary path. The directory always comes
 * from the server-authorized state; a session id can never name an arbitrary path.
 * In this single-user local application every conversation in the database belongs to
 * the user, so the boundary being enforced is the *server's* authority over
 * *which* directory, not a multi-tenant ACL.
 *
 * ## WHY A DISAGREEMENT IS REFUSED
 *
 * A session-scoped route carries its session id in the path, and the browser
 * also sends `x-tbai-session`. When the two disagree the request is refused
 * rather than resolved to either one: a request that names two sessions is
 * not a request the server can authorize.
 */

import { conversationService } from "../storage/conversations";
import { resolveOpenCodeSessionDirectory } from "./workspace";
import { OPENCODE_SESSION_HEADER, type OpenCodeProxyRoute } from "./proxyRoutes";

export { OPENCODE_SESSION_HEADER };

/**
 * A request that must not be forwarded.
 *
 * Carries the status the proxy answers with, so the route does not have to
 * re-derive it and the refusal reason stays attached to the decision.
 */
export class OpenCodeProxyRefusalError extends Error {
  constructor(
    readonly status: 400 | 403,
    message: string,
  ) {
    super(message);
    this.name = "OpenCodeProxyRefusalError";
  }
}

/** The authorization outcome for one proxied request. */
export interface OpenCodeProxyAuthorization {
  /**
   * The absolute directory the upstream must be scoped to, or `null` for a
   * globally scoped route (which reads no location).
   */
  readonly directory: string | null;
  /** The session id the request was authorized against, for diagnostics. */
  readonly sessionId: string | null;
}

/**
 * Resolves the workspace a proxied request may address.
 *
 * @param route - The matched allowlist route, which carries the scope class.
 * @param parameters - The path parameters the route matched.
 * @param sessionHeader - The `x-tbai-session` header the browser sent, if any.
 * @param serviceOwner - The canonical owner of the active OpenCode service.
 * @returns The directory to scope the upstream request to (`null` for a
 *   globally scoped route) and the session id it was authorized against.
 * @throws OpenCodeProxyRefusalError when the request cannot be authorized:
 *   a missing or disagreeing session id, an unknown session, or a workspace
 *   that cannot be resolved.
 */
export async function authorizeOpenCodeProxyRequest(input: {
  readonly route: OpenCodeProxyRoute;
  readonly parameters: Readonly<Record<string, string>>;
  readonly sessionHeader: string | null;
  readonly serviceOwner?: string | null;
}): Promise<OpenCodeProxyAuthorization> {
  const { route, parameters, sessionHeader, serviceOwner } = input;

  // Class A: upstream reads no location and returns no workspace-scoped data.
  // There is nothing to authorize, and no directory is sent — sending one
  // would scope a global route to a workspace it does not belong to.
  if (route.scope === "global") {
    return { directory: null, sessionId: null };
  }

  const pathSessionId = route.scope === "session" ? (parameters.sessionID ?? null) : null;
  const headerSessionId = sessionHeader && sessionHeader.length > 0 ? sessionHeader : null;

  if (pathSessionId && headerSessionId && pathSessionId !== headerSessionId) {
    throw new OpenCodeProxyRefusalError(
      400,
      "The session id in the request path does not match the session header",
    );
  }

  const sessionId = pathSessionId ?? headerSessionId;
  if (!sessionId) {
    throw new OpenCodeProxyRefusalError(403, "The request does not name an OpenCode session");
  }

  const normalizedOwner = serviceOwner || "managed";
  const conversation = await conversationService.findByOpenCodeSession(normalizedOwner, sessionId);
  if (!conversation) {
    throw new OpenCodeProxyRefusalError(403, "The OpenCode session is not known to this server");
  }

  let directory: string;
  try {
    directory = await resolveOpenCodeSessionDirectory(conversation);
  } catch (err) {
    // A conversation whose folder is gone, or whose workspace cannot be
    // resolved, has no directory to scope the request to. The request is
    // refused rather than forwarded unscoped, which would let upstream fall
    // back to its own working directory.
    throw new OpenCodeProxyRefusalError(
      403,
      err instanceof Error
        ? err.message
        : "The workspace for this OpenCode session could not be resolved",
    );
  }

  return { directory, sessionId };
}
