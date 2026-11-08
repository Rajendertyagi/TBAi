import { describe, expect, it } from "bun:test";
import { createOpenCodeV2Client } from "@web/features/opencode/v2Client.ts";
import { OPENCODE_SESSION_HEADER as WEB_SESSION_HEADER } from "@web/features/opencode/config.ts";
import {
  matchOpenCodeProxyRoute,
  OPENCODE_PROXY_ROUTES,
  OPENCODE_SESSION_HEADER,
} from "@backend/services/opencode/proxyRoutes.ts";

/**
 * A1 — the browser's client and the proxy's allowlist must agree.
 *
 * The backend enforces the allowlist, and the browser is the only thing that
 * decides which upstream routes are needed. This suite drives the **real web
 * client** (`createOpenCodeV2Client`) against a recording fetch and compares
 * the routes it produces with the allowlist the proxy enforces, in both
 * directions:
 *
 * - a route the client calls that the allowlist does not name would be
 *   **refused by the proxy** at runtime, so the feature breaks;
 * - a route the allowlist names that the client never calls is a **dead
 *   entry**, and the allowlist would be rotting into a second blocklist.
 *
 * The backend suite (`tests/integration/opencode/opencode-proxy-allowlist.test.ts`)
 * proves the same property against the installed `@opencode/client`, so the
 * guarantee does not depend on either side alone.
 */

const SESSION_ID = "ses_web_fixture";
const ORIGIN = "http://proxy.local";

type Recorded = {
  readonly method: string;
  /** The upstream path, with the proxy prefix removed. */
  readonly pathname: string;
  readonly sessionHeader: string | null;
  readonly directoryHeader: string | null;
};

const recorded: Recorded[] = [];

const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw =
    typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const url = new URL(raw);
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  recorded.push({
    method: (init?.method ?? "GET").toUpperCase(),
    pathname: url.pathname.replace(/^\/api\/opencode/, ""),
    sessionHeader: headers.get(OPENCODE_SESSION_HEADER),
    directoryHeader: headers.get("x-opencode-directory"),
  });
  if (url.pathname.endsWith("/event")) {
    return new Response('data: {"type":"server.connected"}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  }
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

describe("OpenCode web client and the proxy allowlist", () => {
  it("uses the same session header name as the backend", () => {
    expect(WEB_SESSION_HEADER).toBe(OPENCODE_SESSION_HEADER);
  });

  it("produces exactly the routes the proxy allows", async () => {
    recorded.length = 0;
    const client = createOpenCodeV2Client(
      { sessionId: SESSION_ID, directory: "/workspace/some-project" },
      ORIGIN,
      { fetch: recordingFetch },
    );
    const abort = new AbortController();
    const generation = await client.connect({
      connectionSignal: abort.signal,
      lifecycleSignal: abort.signal,
      onActivity: () => undefined,
    });

    const session = SESSION_ID;
    const calls: (() => Promise<unknown>)[] = [
      () => generation.operations.serverInfo(),
      () => generation.operations.sessionGet({ sessionID: session }),
      () => generation.operations.switchAgent({ sessionID: session, agent: "build" }),
      () =>
        generation.operations.switchModel({
          sessionID: session,
          model: { id: "model-id", providerID: "provider-id" },
        }),
      () => generation.operations.prompt({ sessionID: session, id: "msg_1", text: "hello" }),
      () => generation.operations.compact({ sessionID: session, id: "msg_1" }),
      () => generation.operations.interrupt({ sessionID: session }),
      () => generation.operations.inboxList({ sessionID: session }),
      () => generation.operations.inboxCancel({ sessionID: session, inboxID: "ibx_1" }),
      () =>
        generation.operations.revertStage({ sessionID: session, messageID: "msg_1", files: true }),
      () => generation.operations.revertCommit({ sessionID: session }),
      () => generation.operations.revertClear({ sessionID: session }),
      () => generation.operations.formList({ sessionID: session }),
      () => generation.operations.formReply({ sessionID: session, formID: "frm_1", answer: {} }),
      () => generation.operations.formCancel({ sessionID: session, formID: "frm_1" }),
      () => generation.operations.permissionList({ sessionID: session }),
      () =>
        generation.operations.permissionReply({
          sessionID: session,
          requestID: "prm_1",
          decision: "once",
        }),
      () => generation.history.list({ sessionID: session }),
    ];

    for (const call of calls) {
      // The recording fetch answers with a generic body, which the client
      // validates. A rejected RESPONSE is irrelevant here: what is compared
      // is the REQUEST the client made.
      await call().catch(() => undefined);
    }
    await generation.events.close();
    abort.abort();

    expect(recorded.length).toBe(OPENCODE_PROXY_ROUTES.length);

    const exercised = new Set<string>();
    for (const capture of recorded) {
      const match = matchOpenCodeProxyRoute(capture.method, capture.pathname);
      expect(
        match,
        `the web client calls a route the proxy does not allow: ${capture.method} ${capture.pathname}`,
      ).not.toBeNull();
      exercised.add(match?.route.operation ?? "");
    }

    expect([...exercised].sort()).toEqual(
      OPENCODE_PROXY_ROUTES.map((route) => route.operation).sort(),
    );
  });

  it("names the session and never a directory of its own", async () => {
    recorded.length = 0;
    const client = createOpenCodeV2Client(
      { sessionId: SESSION_ID, directory: "/workspace/some-project" },
      ORIGIN,
      { fetch: recordingFetch },
    );
    const abort = new AbortController();
    const generation = await client.connect({
      connectionSignal: abort.signal,
      lifecycleSignal: abort.signal,
      onActivity: () => undefined,
    });
    await generation.operations.sessionGet({ sessionID: SESSION_ID }).catch(() => undefined);
    await generation.events.close();
    abort.abort();

    expect(recorded.length).toBeGreaterThan(0);
    for (const capture of recorded) {
      expect(capture.sessionHeader).toBe(SESSION_ID);
      // The browser's copy of the directory is display-only. It must not
      // reach the upstream: the server chooses the workspace.
      expect(capture.directoryHeader).toBeNull();
    }
  });
});
