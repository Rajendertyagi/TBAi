import { OpenCode } from "@opencode/client";
import { logger } from "../../lib/logger";

/**
 * The official OpenCode V2 client bound to one managed server base URL.
 * Every method is promise-based and **throws** on failure — use
 * `toOpenCodeError` (see `./errors`) to translate a thrown value into TBAi's
 * own error vocabulary before it reaches a caller.
 */
export type OpenCodeClient = ReturnType<typeof OpenCode.make>;

/** The V2 single-session route: `/api/session/<id>`, with no sub-path. */
const SESSION_ITEM_PATH = /^\/api\/session\/[^/]+$/;

/** The V2 interrupt route: `/api/session/<id>/interrupt`. */
const SESSION_INTERRUPT_PATH = /^\/api\/session\/[^/]+\/interrupt$/;

type FetchInput = Parameters<typeof globalThis.fetch>[0];

/** Normalizes every fetch input shape to a URL. */
function toUrl(input: FetchInput): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

/** Reads the HTTP method the caller asked for. */
function methodOf(input: FetchInput, init?: RequestInit): string {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  return method.toUpperCase();
}

/**
 * True when a response is the SPA fallback that OpenCode serves for a route it
 * has not registered: HTTP 200 carrying the single-page app's HTML. This is the
 * signature of "this endpoint does not exist on this server", and is how the
 * transport detects that a V2 route is missing.
 */
function isSpaFallback(response: Response): boolean {
  return (
    response.status === 200 &&
    (response.headers.get("content-type") ?? "").includes("text/html")
  );
}

/**
 * Transport bridge for the two V2 endpoints that OpenCode **1.18.29** does not
 * implement, so that TBAi can still call the official V2 API surface.
 *
 * `@opencode/client@2.0.4` targets an OpenCode 2.x server; the newest released
 * server is 1.18.31, so two V2 operations do not work as the client expects.
 * Both are corrected here, and both corrections are **adaptive** — they only
 * engage when the server actually misbehaves, so they become inert (and can be
 * deleted) once a server implements the real V2 contract.
 *
 * 1. `session.interrupt` — `POST /api/session/:id/interrupt` **does exist** on
 *    1.18.x, but declares `success: NoContent` (HTTP 204 with no body), while
 *    the client hard-codes `successStatus: 200` and then parses JSON. Result
 *    without this bridge: `ClientError("UnexpectedStatus", 204)`. The bridge
 *    passes the request through untouched and, only if the server answers 204,
 *    reports that success in the shape the client's contract asks for. A server
 *    that answers 200 + JSON is passed through unchanged.
 *
 * 2. `session.remove` — `DELETE /api/session/:id` **has no route at all** on
 *    1.18.x (verified against the binary's own route table: it registers no
 *    DELETE route for sessions). The request therefore falls through to the SPA
 *    fallback, while the client expects 204. The bridge issues the V2 request
 *    first and only if it comes back as the SPA fallback retries against the
 *    V1 route that does implement deletion, reporting success as the 204 the
 *    client expects. A server that implements the V2 route never reaches the
 *    fallback.
 *
 * The wire path for deletion is therefore V1 on 1.18.x only. That is the one
 * unavoidable legacy-looking request in the backend, it is confined to this
 * function, and it is the reason this file — and not a caller — owns the
 * transport.
 */
const compatFetch = async (
  input: FetchInput,
  init?: RequestInit,
): Promise<Response> => {
  const url = toUrl(input);
  const method = methodOf(input, init);

  if (method === "DELETE" && SESSION_ITEM_PATH.test(url.pathname)) {
    const response = await globalThis.fetch(input, init);
    if (!isSpaFallback(response)) {
      recordTransport(method, url.pathname, response.status, "v2");
      return response;
    }
    // The V2 route is absent on this server. Record the attempt before falling
    // back, so the log shows *why* the legacy path was used rather than
    // implying the backend preferred it.
    recordTransport(method, url.pathname, response.status, "v2-missing");
    await response.body?.cancel();
    const fallbackUrl = new URL(url);
    fallbackUrl.pathname = url.pathname.replace(/^\/api\/session\//, "/session/");
    const fallback = await globalThis.fetch(fallbackUrl, init);
    recordTransport("DELETE", fallbackUrl.pathname, fallback.status, "v1-fallback");
    // Hand a failure back intact — the client reads the body to decide whether
    // this is a declared status (e.g. 404 session-not-found) or a bare HTTP
    // error. Consuming it here would surface as a bogus transport failure.
    if (!fallback.ok) return fallback;
    await fallback.body?.cancel();
    return new Response(null, { status: 204 });
  }

  const response = await globalThis.fetch(input, init);

  if (
    method === "POST" &&
    SESSION_INTERRUPT_PATH.test(url.pathname) &&
    response.status === 204
  ) {
    recordTransport(method, url.pathname, response.status, "v2");
    await response.body?.cancel();
    return new Response(JSON.stringify({ interrupted: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  recordTransport(method, url.pathname, response.status, "v2");
  return response;
};

/**
 * Records one upstream SDK call. The OpenCode server logs no HTTP requests of
 * its own, so this line is the only runtime evidence of which wire paths TBAi's
 * SDK traffic actually takes — it is what makes the V2-only invariant (guarded
 * statically by `v2-only.test.ts`) observable outside unit tests. `via` is
 * `"v2-missing"` when a V2 route answered with the SPA fallback, and
 * `"v1-fallback"` for the documented OpenCode 1.18.29 delete bridge that
 * follows it. Method, path and status only: never query strings, bodies or
 * headers.
 */
function recordTransport(
  method: string,
  pathname: string,
  status: number,
  via: "v2" | "v2-missing" | "v1-fallback",
): void {
  logger.debug("opencode", "opencode.transport", { method, pathname, status, via });
}

/**
 * The transport handed to the official client. Bun's `fetch` carries a
 * `preconnect` extension and the client's `fetch` option is typed as exactly
 * `typeof globalThis.fetch`, so the real implementation's own properties are
 * carried over rather than reimplemented. Nothing in the OpenCode client calls
 * `preconnect`; forwarding it keeps the type honest and the capability intact.
 */
const compatTransport: typeof globalThis.fetch = Object.assign(
  compatFetch,
  globalThis.fetch,
);

/**
 * Creates the official OpenCode V2 client for a managed server base URL.
 * Returns a promise-API client; it throws nothing itself — failures surface
 * per call, so callers decide their own best-effort vs. fatal policy. The
 * client carries TBAi's transport configuration, which is a pass-through plus
 * the documented OpenCode 1.18.29 bridge described on `compatFetch`.
 *
 * @param baseUrl - Loopback origin of the managed `opencode serve` process
 *   (e.g. `http://127.0.0.1:62597`), as handed out by the server manager.
 */
export function createOpenCodeClient(baseUrl: string): OpenCodeClient {
  return OpenCode.make({ baseUrl, fetch: compatTransport });
}
