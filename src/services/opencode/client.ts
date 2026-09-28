import { OpenCode } from "@opencode/client";
import { getOpenCodeAuthHeaders, getOpenCodeDirectoryHeaders } from "./runtime";

/**
 * The official OpenCode V2 client bound to one managed server base URL.
 * Every method is promise-based and throws on failure; callers translate the
 * thrown value into TBAi's own error vocabulary through `./errors`.
 */
export type OpenCodeClient = ReturnType<typeof OpenCode.make>;

const transport: typeof globalThis.fetch = globalThis.fetch;

/** One response the client received, kept only long enough to answer a question. */
interface ObservedResponse {
  /** Full request URL, used to attribute a status to the call that caused it. */
  readonly url: string;
  readonly status: number;
}

/**
 * Responses seen per client, most recent last. Bounded so a long-lived client
 * cannot accumulate history; only the tail is ever relevant, because a lookup
 * reads the status immediately after the call it cares about.
 */
const MAX_OBSERVED_RESPONSES = 8;
const observedResponses = new WeakMap<OpenCodeClient, ObservedResponse[]>();

/**
 * Wraps the real transport so every response is recorded before it is handed on.
 *
 * The response object itself is passed through untouched and unread: the official
 * client still parses bodies exactly as it always would. Only the status is
 * observed, which is the one thing the client provably cannot report.
 */
function createObservingTransport(
  record: ObservedResponse[],
): typeof globalThis.fetch {
  const observing = async (
    input: Parameters<typeof transport>[0],
    init?: Parameters<typeof transport>[1],
  ): Promise<Response> => {
    const response = await transport(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    record.push({ url, status: response.status });
    if (record.length > MAX_OBSERVED_RESPONSES) record.shift();
    return response;
  };
  // `fetch` also carries `preconnect`; the wrapper must remain a drop-in.
  return Object.assign(observing, { preconnect: transport.preconnect });
}

/** Creates an authenticated, optionally directory-scoped native V2 client. */
export function createOpenCodeClient(
  baseUrl: string,
  options: { directory?: string | null } = {},
): OpenCodeClient {
  const record: ObservedResponse[] = [];
  const client = OpenCode.make({
    baseUrl,
    headers: {
      ...getOpenCodeAuthHeaders(),
      ...getOpenCodeDirectoryHeaders(options.directory),
    },
    fetch: createObservingTransport(record),
  });
  observedResponses.set(client, record);
  return client;
}

/**
 * The HTTP status the client received for a specific session lookup, or `null`
 * when there is none to report.
 *
 * ## Why this exists
 *
 * OpenCode answers a request for a session that does not exist with a bare `404`
 * and an EMPTY body. The official client cannot parse that, so it throws
 * `ClientError { reason: "UnsupportedContentType" }` and discards the status —
 * the one fact that separates "this session is gone" from "this server is
 * broken". Verified against `@opencode/client` directly: that error carries no
 * status, no usable `cause`, and no `response`.
 *
 * Re-issuing the request by hand would be the wrong fix. Auth, directory
 * scoping, URL construction and encoding all belong to the official client, and a
 * hand-rolled copy would be a second, drifting implementation of a boundary this
 * codebase already delegates. So the request is still made by the client; this
 * reads a status off the response the client itself received.
 *
 * Attribution is by URL rather than "the last response", because a client is
 * shared across a lookup, a create and a model assignment. Only a response whose
 * URL addresses THIS session counts, so a status can never be attributed to the
 * wrong call.
 *
 * @param client - A client created by {@link createOpenCodeClient}.
 * @param sessionId - The session whose lookup should be inspected.
 * @returns The observed status, or null when the client made no such request.
 */
export function lastStatusForSessionLookup(
  client: OpenCodeClient,
  sessionId: string,
): number | null {
  const record = observedResponses.get(client);
  if (!record) return null;
  const encoded = encodeURIComponent(sessionId);
  for (let i = record.length - 1; i >= 0; i--) {
    const entry = record[i]!;
    if (entry.url.includes(encoded) && entry.url.includes("/session/")) {
      return entry.status;
    }
  }
  return null;
}
