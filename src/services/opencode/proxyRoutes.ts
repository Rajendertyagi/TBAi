/**
 * The OpenCode proxy's upstream route allowlist, and the scope classification
 * that tells the proxy where a route's workspace comes from.
 *
 * ## WHY AN ALLOWLIST
 *
 * The proxy used to forward **every** path under `/api/opencode/*` to the
 * managed OpenCode server. That server exposes far more than the browser
 * needs: a shell, a filesystem reader/writer, credential storage, config
 * writes, RPC, MCP registration, PTY, plugin updates and more. A caller that
 * could reach the proxy could reach all of it, with the server's own
 * credentials, from the browser's origin.
 *
 * An allowlist is the primary control here. It is **not** a blocklist: a
 * blocklist has to name every dangerous route in advance and silently allows
 * everything else, so a route added upstream later is reachable by default.
 * An allowlist refuses everything that is not named.
 *
 * ## WHY THIS TABLE IS NOT HAND-WRITTEN
 *
 * The table below *is* written by hand — but it is not trusted. Two tests
 * check it against the real client, from both directions:
 *
 * - `tests/integration/opencode/opencode-proxy-allowlist.test.ts` drives the
 *   **installed `@opencode/client`** through the proxy for every operation the
 *   browser performs, and fails when the client asks for a route this table
 *   does not allow. It also fails when this table allows a route no client
 *   operation produces, so the list cannot rot into a second blocklist.
 * - `tests/unit/web/opencode/v2ClientProxyRoutes.test.ts` drives the **real
 *   web client** (`createOpenCodeV2Client`) and fails when the routes it
 *   produces and this table disagree, in either direction.
 *
 * So the client's behaviour is the source of truth and this table is the
 * checked projection of it.
 *
 * ## SCOPE — WHY EACH ROUTE CARRIES ONE
 *
 * Upstream resolves a request's location from the `location[directory]` query
 * parameter or the `x-opencode-directory` header, and falls back to
 * `process.cwd()` when neither is present. A route that reads a location is
 * therefore **location-scoped** whether or not it carries a session id, and a
 * request that reaches it without a server-chosen location would silently
 * inherit the server's working directory.
 *
 * - `global`  — upstream does not read a location and returns no
 *   workspace-scoped data. Nothing to authorize; no directory is sent.
 * - `location` — upstream reads a location, but the request carries no session
 *   id in its path. The session id comes from the TBAi-owned `x-tbai-session`
 *   header, is used only as a **selector**, and the directory that is sent
 *   upstream is the server's own resolution of it.
 * - `session`  — the path carries the session id. That session is
 *   authoritative: the proxy resolves it to a conversation and a workspace,
 *   and refuses the request when it cannot.
 *
 * This module is deliberately **free of imports**. It is imported by the web
 * test project, where `@/*` resolves to the web tree; a module that reached
 * into the backend would resolve its imports against the wrong tree.
 */

/**
 * The header the browser uses to name the OpenCode session a request belongs
 * to.
 *
 * It is a **selector**, not an instruction: the backend resolves it to the
 * one workspace that session is rooted in and forwards that directory. The
 * proxy strips it, so the upstream never sees it.
 */
export const OPENCODE_SESSION_HEADER = "x-tbai-session";

/** How an allowed route obtains the workspace scope it is addressed in. */
export type OpenCodeProxyRouteScope = "global" | "location" | "session";

/** The HTTP methods an allowed route may be called with. */
export type OpenCodeProxyMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One allowed upstream route. */
export interface OpenCodeProxyRoute {
  /**
   * The client operation that needs this route, named as the installed
   * `@opencode/client` names it (`session.prompt`, `permission.reply`, …).
   *
   * It is what makes a stale entry detectable: the drift tests drive the
   * client per operation and compare, so an entry no client operation
   * produces is an entry the client does not need.
   */
  readonly operation: string;
  readonly method: OpenCodeProxyMethod;
  /**
   * The upstream path, with `:name` placeholders for the path parameters the
   * client substitutes.
   */
  readonly path: string;
  readonly scope: OpenCodeProxyRouteScope;
}

/**
 * Every upstream route the browser may reach, and nothing else.
 *
 * The set is exactly the routes `web/src/features/opencode/v2Client.ts`
 * produces. Two routes that the client *can* produce but does not
 * (`message.get` at `/api/session/{id}/message/{messageID}`, and every
 * catalogue route) are deliberately absent: the browser never calls them, and
 * the catalogue is called by the backend directly against the managed server.
 */
export const OPENCODE_PROXY_ROUTES: readonly OpenCodeProxyRoute[] = [
  { operation: "server.info", method: "GET", path: "/api/info", scope: "global" },
  { operation: "event.subscribe", method: "GET", path: "/api/event", scope: "location" },
  { operation: "session.get", method: "GET", path: "/api/session/:sessionID", scope: "session" },
  {
    operation: "session.switchAgent",
    method: "POST",
    path: "/api/session/:sessionID/agent",
    scope: "session",
  },
  {
    operation: "session.switchModel",
    method: "POST",
    path: "/api/session/:sessionID/model",
    scope: "session",
  },
  {
    operation: "session.prompt",
    method: "POST",
    path: "/api/session/:sessionID/prompt",
    scope: "session",
  },
  {
    operation: "session.compact",
    method: "POST",
    path: "/api/session/:sessionID/compact",
    scope: "session",
  },
  {
    operation: "session.interrupt",
    method: "POST",
    path: "/api/session/:sessionID/interrupt",
    scope: "session",
  },
  {
    operation: "session.inbox.list",
    method: "GET",
    path: "/api/session/:sessionID/inbox",
    scope: "session",
  },
  {
    operation: "session.inbox.cancel",
    method: "DELETE",
    path: "/api/session/:sessionID/inbox/:inboxID",
    scope: "session",
  },
  {
    operation: "session.revert.stage",
    method: "POST",
    path: "/api/session/:sessionID/revert/stage",
    scope: "session",
  },
  {
    operation: "session.revert.commit",
    method: "POST",
    path: "/api/session/:sessionID/revert/commit",
    scope: "session",
  },
  {
    operation: "session.revert.clear",
    method: "DELETE",
    path: "/api/session/:sessionID/revert",
    scope: "session",
  },
  {
    operation: "session.form.list",
    method: "GET",
    path: "/api/session/:sessionID/form",
    scope: "session",
  },
  {
    operation: "session.form.reply",
    method: "POST",
    path: "/api/session/:sessionID/form/:formID/reply",
    scope: "session",
  },
  {
    operation: "session.form.cancel",
    method: "DELETE",
    path: "/api/session/:sessionID/form/:formID",
    scope: "session",
  },
  {
    operation: "permission.list",
    method: "GET",
    path: "/api/session/:sessionID/permission",
    scope: "session",
  },
  {
    operation: "permission.reply",
    method: "POST",
    path: "/api/session/:sessionID/permission/:requestID/reply",
    scope: "session",
  },
  {
    operation: "message.list",
    method: "GET",
    path: "/api/session/:sessionID/message",
    scope: "session",
  },
];

/** A matched route together with the path parameters it captured. */
export interface OpenCodeProxyRouteMatch {
  readonly route: OpenCodeProxyRoute;
  /** Captured `:name` path parameters, decoded. */
  readonly parameters: Readonly<Record<string, string>>;
}

interface CompiledRoute {
  readonly route: OpenCodeProxyRoute;
  readonly segments: readonly string[];
}

/** Splits a path into its non-empty segments. */
function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

const COMPILED_ROUTES: readonly CompiledRoute[] = OPENCODE_PROXY_ROUTES.map((route) => ({
  route,
  segments: pathSegments(route.path),
}));

/**
 * Matches a request against the allowlist.
 *
 * @param method - The request method, compared case-insensitively.
 * @param pathname - The **upstream** path (the proxy prefix already removed),
 *   e.g. `/api/session/ses_1/prompt`.
 * @returns The matched route and its captured parameters, or `null` when the
 *   request names no allowed route — which the proxy must refuse.
 */
export function matchOpenCodeProxyRoute(
  method: string,
  pathname: string,
): OpenCodeProxyRouteMatch | null {
  const upperMethod = method.toUpperCase();
  const segments = pathSegments(pathname);
  for (const compiled of COMPILED_ROUTES) {
    if (compiled.route.method !== upperMethod) continue;
    if (compiled.segments.length !== segments.length) continue;
    const parameters: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < compiled.segments.length; index += 1) {
      const expected = compiled.segments[index] ?? "";
      const actual = segments[index] ?? "";
      if (expected.startsWith(":")) {
        let decoded: string;
        try {
          decoded = decodeURIComponent(actual);
        } catch {
          // A malformed escape cannot be a session id we recognize.
          matched = false;
          break;
        }
        parameters[expected.slice(1)] = decoded;
        continue;
      }
      if (expected !== actual) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    return { route: compiled.route, parameters };
  }
  return null;
}
