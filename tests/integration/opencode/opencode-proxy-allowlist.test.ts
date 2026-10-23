import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { conversationService } from "@/services/storage/conversations.ts";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";
import { matchOpenCodeProxyRoute, OPENCODE_PROXY_ROUTES } from "@/services/opencode/proxyRoutes.ts";
import { OPENCODE_SESSION_HEADER } from "@/services/opencode/proxyAuthorization.ts";
import { resolveConversationWorkspace } from "@/services/workspace.ts";
import { REPO_ROOT } from "../../helpers/repo-root";
import { stripComments } from "../../helpers/web/source-scope";

/**
 * A1 + A2 — the proxy's route allowlist and its server-side workspace
 * authorization.
 *
 * ## WHAT IS PROVEN HERE
 *
 * 1. **The allowlist covers the client.** The real installed
 *    `@opencode/client` is driven through the real proxy, and every request
 *    it makes is checked against the allowlist. A route the client starts
 *    calling that the allowlist does not name fails the test; a route the
 *    allowlist names that no client operation produces fails it too, so the
 *    list cannot rot into a second blocklist.
 *
 * 2. **The allowlist refuses the rest.** The routes the managed server
 *    exposes beyond the browser's needs — shell, filesystem, credentials,
 *    config writes, RPC, MCP, the location-scoped catalogue — are refused
 *    before any upstream request is made.
 *
 * 3. **The caller never chooses the directory.** A caller-supplied
 *    `x-opencode-directory` header and a caller-supplied `location[directory]`
 *    query parameter are both stripped, and the upstream receives the
 *    server's own resolution of the session's workspace.
 */

const SESSION_ID = "ses_proxy_fixture";
const OTHER_SESSION_ID = "ses_proxy_other";
const PROXY_BASE_URL = "http://proxy.local/api/opencode";

type CapturedRequest = {
  readonly method: string;
  readonly pathname: string;
  readonly directory: string | null;
  readonly sessionHeader: string | null;
  readonly query: string;
};

const captured: CapturedRequest[] = [];

const fixtureServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    captured.push({
      method: request.method,
      pathname: url.pathname,
      directory: request.headers.get("x-opencode-directory"),
      sessionHeader: request.headers.get("x-tbai-session"),
      query: url.search,
    });
    if (url.pathname === "/api/event") {
      return new Response('data: {"type":"server.connected"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({ fixture: "opencode-proxy" });
  },
});

const fixtureBaseUrl = `http://127.0.0.1:${fixtureServer.port}`;
const originalEnsureBaseUrl = openCodeServerManager.ensureBaseUrl;
(openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
  async () => fixtureBaseUrl;

const { default: openCodeApp } = await import("@/routes/opencode.ts");

/**
 * A fetch that sends the request into the proxy in-process, so the REAL
 * installed client exercises the REAL proxy.
 */
const proxyFetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init as RequestInit);
    return openCodeApp.request(request);
  },
  { preconnect: globalThis.fetch.preconnect },
);

/** The upstream path the proxy computed for a captured request. */
function upstreamPathOf(capture: CapturedRequest): string {
  return capture.pathname;
}

let conversationId = "";
let serverDirectory = "";

beforeAll(async () => {
  const conversation = await conversationService.create({
    title: "Proxy authorization fixture",
    providerId: "",
    workspaceMode: "simple",
    opencodeSessionId: SESSION_ID,
    engine: "opencode",
  });
  conversationId = conversation.id;
  const workspace = await resolveConversationWorkspace(conversation.id);
  serverDirectory = workspace.dir;
});

afterAll(() => {
  fixtureServer.stop(true);
  (openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
    originalEnsureBaseUrl;
});

describe("OpenCode proxy route allowlist (A1)", () => {
  it("allows every route the browser's client actually calls", async () => {
    captured.length = 0;
    const client = OpenCode.make({
      baseUrl: PROXY_BASE_URL,
      fetch: proxyFetch,
      headers: { [OPENCODE_SESSION_HEADER]: SESSION_ID },
    });

    const session = SESSION_ID;
    const calls: (() => Promise<unknown>)[] = [
      () => client.server.info(),
      () => client.session.get({ sessionID: session }),
      () => client.session.switchAgent({ sessionID: session, agent: "build" }),
      () =>
        client.session.switchModel({
          sessionID: session,
          model: { id: "model-id", providerID: "provider-id" },
        }),
      () => client.session.prompt({ sessionID: session, id: "msg_1", text: "hello" }),
      () => client.session.compact({ sessionID: session, id: "msg_1" }),
      () => client.session.interrupt({ sessionID: session }),
      () => client.session.inbox.list({ sessionID: session }),
      () => client.session.inbox.cancel({ sessionID: session, inboxID: "ibx_1" }),
      () => client.session.revert.stage({ sessionID: session, messageID: "msg_1", files: true }),
      () => client.session.revert.commit({ sessionID: session }),
      () => client.session.revert.clear({ sessionID: session }),
      () => client.session.form.list({ sessionID: session }),
      () => client.session.form.reply({ sessionID: session, formID: "frm_1", answer: {} }),
      () => client.session.form.cancel({ sessionID: session, formID: "frm_1" }),
      () => client.permission.list({ sessionID: session }),
      () =>
        client.permission.reply({
          sessionID: session,
          requestID: "prm_1",
          decision: "once",
        }),
      () => client.message.list({ sessionID: session }),
    ];

    for (const call of calls) {
      // The client validates the upstream's response shape, and the fixture
      // answers every route with a generic body. A rejected RESPONSE does not
      // matter here: what is under test is the REQUEST the client made.
      await call().catch(() => undefined);
    }

    // The event stream is a separate shape: it is consumed, not awaited.
    const stream = client.event.subscribe({ signal: new AbortController().signal });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next().catch(() => undefined);
    await iterator.return?.().catch(() => undefined);

    expect(captured.length).toBe(OPENCODE_PROXY_ROUTES.length);

    const exercised = new Set<string>();
    for (const capture of captured) {
      const match = matchOpenCodeProxyRoute(capture.method, upstreamPathOf(capture));
      expect(
        match,
        `client called a route outside the allowlist: ${capture.method} ${capture.pathname}`,
      ).not.toBeNull();
      exercised.add(match?.route.operation ?? "");
    }

    // No dead entries: every allowed route is a route the client calls.
    expect([...exercised].sort()).toEqual(
      OPENCODE_PROXY_ROUTES.map((route) => route.operation).sort(),
    );
  });

  it("refuses the routes the managed server exposes but the browser does not use", async () => {
    const refused: { readonly method: string; readonly path: string }[] = [
      { method: "POST", path: `/api/session/${SESSION_ID}/shell` },
      { method: "GET", path: "/api/fs/read/etc/passwd" },
      { method: "PUT", path: "/api/credential/x" },
      { method: "POST", path: "/api/credential" },
      { method: "PATCH", path: "/api/config" },
      { method: "PUT", path: "/api/config" },
      { method: "POST", path: "/api/rpc/x/y" },
      { method: "POST", path: "/api/mcp" },
      { method: "POST", path: "/api/vcs/init" },
      { method: "POST", path: "/api/pty/session" },
      { method: "POST", path: "/api/experimental/persistent-pty/x" },
      { method: "POST", path: "/api/experimental/fs/write" },
      { method: "POST", path: `/api/experimental/session/${SESSION_ID}/export` },
      { method: "GET", path: "/api/debug/log" },
      { method: "POST", path: "/api/plugin/update" },
      { method: "POST", path: "/api/integration/github" },
      // The method is part of the allowlist: the client only READS the
      // message history, so a write to the same path is refused.
      { method: "POST", path: `/api/session/${SESSION_ID}/message` },
      // The location-scoped catalogue: the BACKEND calls these directly
      // against the managed server, so they are not browser-reachable.
      { method: "GET", path: "/api/model" },
      { method: "GET", path: "/api/model/default" },
      { method: "GET", path: "/api/provider" },
      { method: "GET", path: "/api/agent" },
      { method: "GET", path: "/api/command" },
    ];

    for (const route of refused) {
      captured.length = 0;
      const response = await openCodeApp.request(`http://localhost/api/opencode${route.path}`, {
        method: route.method,
      });
      expect(response.status, `${route.method} ${route.path} must be refused`).toBe(404);
      expect(captured.length, `${route.method} ${route.path} must not reach the upstream`).toBe(0);
    }
  });

  it("serves the command feed from TBAi's own route, never through the proxy", async () => {
    // The composer's `/` palette needs OpenCode's command catalogue. The
    // catalogue is location-scoped upstream, so it is read by the BACKEND and
    // served from TBAi's own route — the proxy carries only the routes the
    // browser's session client calls.
    const response = await openCodeApp.request("http://localhost/commands");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fixture: "opencode-proxy" });
  });

  it("carries no direct proxy call the app makes outside TBAi's own routes", () => {
    // The client-driven test above covers the routes the OFFICIAL CLIENT
    // calls. The app also calls `/api/opencode/*` DIRECTLY, with its own
    // `apiFetch`, and those calls do not go through the client at all — so
    // they are invisible to it.
    //
    // A direct call that is not a TBAi route reaches the proxy, and the proxy
    // refuses everything the allowlist does not name. That is the correct
    // behaviour, and it is also how the composer's command palette broke the
    // first time this allowlist landed: the palette fetched OpenCode's
    // location-scoped command catalogue through the proxy.
    //
    // So every direct call must be one of TBAi's own routes. The catalogue is
    // read by the backend and served from `/api/opencode/commands`.
    const tbaiRoutes = new Set(
      openCodeApp.routes
        .filter((route) => route.path !== "*")
        .map((route) => `/api/opencode${route.path}`),
    );
    // The mount point itself: the official client builds its URLs from it.
    const mountPoint = "/api/opencode";

    for (const path of directAppProxyPaths()) {
      if (path === mountPoint) continue;
      expect(
        tbaiRoutes.has(path),
        `the app calls ${path}, which is not one of TBAi's own OpenCode routes — it would be refused by the proxy`,
      ).toBe(true);
    }
  });
});

/**
 * Every `/api/opencode/...` path the web app names in its own source.
 *
 * A source read, because a direct `apiFetch` call has no other observable
 * trace: it is not the official client, so no request-recording harness sees
 * it. Comments are stripped first, so prose about a route can never satisfy
 * the check.
 */
function directAppProxyPaths(): string[] {
  const found = new Set<string>();
  for (const file of webSourceFiles(join(REPO_ROOT, "web", "src"))) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(/["'`](\/api\/opencode[^"'`]*)["'`]/g)) {
      const path = match[1];
      if (path) found.add(path);
    }
  }
  return [...found].sort();
}

/** Every `.ts`/`.tsx` file under a directory, recursively. */
function webSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...webSourceFiles(full));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
}

describe("OpenCode proxy workspace authorization (A2)", () => {
  it("forwards the server's directory and never the caller's", async () => {
    captured.length = 0;
    const foreignDirectory = encodeURIComponent("/workspace/somebody-elses-project");

    const response = await openCodeApp.request(
      `http://localhost/api/opencode/api/session/${SESSION_ID}`,
      { headers: { "x-opencode-directory": foreignDirectory } },
    );

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.directory).toBe(encodeURIComponent(serverDirectory));
    expect(captured[0]?.directory).not.toBe(foreignDirectory);
  });

  it("strips a caller-supplied location[directory] query parameter", async () => {
    captured.length = 0;
    const foreign = encodeURIComponent("/workspace/somebody-elses-project");

    const response = await openCodeApp.request(
      `http://localhost/api/opencode/api/session/${SESSION_ID}?location%5Bdirectory%5D=${foreign}`,
    );

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.query).not.toContain("location");
    expect(captured[0]?.directory).toBe(encodeURIComponent(serverDirectory));
  });

  it("never forwards the TBAi-internal session header upstream", async () => {
    captured.length = 0;
    const response = await openCodeApp.request(
      `http://localhost/api/opencode/api/session/${SESSION_ID}`,
      { headers: { [OPENCODE_SESSION_HEADER]: SESSION_ID } },
    );

    expect(response.status).toBe(200);
    expect(captured[0]?.sessionHeader).toBeNull();
  });

  it("refuses a request whose path session id and session header disagree", async () => {
    captured.length = 0;
    const response = await openCodeApp.request(
      `http://localhost/api/opencode/api/session/${SESSION_ID}`,
      { headers: { [OPENCODE_SESSION_HEADER]: OTHER_SESSION_ID } },
    );

    expect(response.status).toBe(400);
    expect(captured.length).toBe(0);
  });

  it("refuses an unknown session id", async () => {
    captured.length = 0;
    const response = await openCodeApp.request(
      "http://localhost/api/opencode/api/session/ses_not_a_known_session",
    );

    expect(response.status).toBe(403);
    expect(captured.length).toBe(0);
  });

  it("refuses a session-scoped sub-route whose session is unknown", async () => {
    captured.length = 0;
    const response = await openCodeApp.request(
      "http://localhost/api/opencode/api/session/ses_not_a_known_session/prompt",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );

    expect(response.status).toBe(403);
    expect(captured.length).toBe(0);
  });

  it("authorizes the event stream like any other location-scoped route", async () => {
    captured.length = 0;
    const authorized = await openCodeApp.request("http://localhost/api/opencode/api/event", {
      headers: { [OPENCODE_SESSION_HEADER]: SESSION_ID },
    });
    expect(authorized.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.directory).toBe(encodeURIComponent(serverDirectory));

    captured.length = 0;
    const unauthorized = await openCodeApp.request("http://localhost/api/opencode/api/event", {
      headers: { [OPENCODE_SESSION_HEADER]: "ses_not_a_known_session" },
    });
    expect(unauthorized.status).toBe(403);
    expect(captured.length).toBe(0);

    captured.length = 0;
    const unscoped = await openCodeApp.request("http://localhost/api/opencode/api/event");
    expect(unscoped.status).toBe(403);
    expect(captured.length).toBe(0);
  });

  it("forwards the global route without any directory", async () => {
    captured.length = 0;
    const response = await openCodeApp.request("http://localhost/api/opencode/api/info", {
      headers: { [OPENCODE_SESSION_HEADER]: SESSION_ID },
    });

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.pathname).toBe("/api/info");
    // A global route is not scoped to a workspace, so it carries no directory.
    expect(captured[0]?.directory).toBeNull();
  });

  it("never forwards a request that has no server-resolved directory", async () => {
    captured.length = 0;
    const response = await openCodeApp.request(
      `http://localhost/api/opencode/api/session/${SESSION_ID}/message`,
    );

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.directory).toBe(encodeURIComponent(serverDirectory));
    expect(captured[0]?.directory).not.toBeNull();
  });

  it("resolves the conversation that owns a session id", async () => {
    const found = await conversationService.findByOpenCodeSessionId(SESSION_ID);
    expect(found?.id).toBe(conversationId);
    expect(await conversationService.findByOpenCodeSessionId("ses_not_a_known_session")).toBeNull();
  });

  it("does not expose the global session.active map through the parameterized session route", async () => {
    // `session.active` answers with the managed process's GLOBAL active-session
    // map, which is why the browser's only path to it is TBAi's filtered
    // `POST /api/opencode/session/activity`. There is deliberately no allowlist
    // entry for the upstream path: `/api/session/active` can only match the
    // parameterized `session.get` route, with `active` read as a session id.
    const matched = matchOpenCodeProxyRoute("GET", "/api/session/active");
    expect(matched?.route.operation).toBe("session.get");
    expect(matched?.parameters.sessionID).toBe("active");
    expect(OPENCODE_PROXY_ROUTES.some((route) => route.path === "/api/session/active")).toBe(false);

    // Driven through the real proxy: the literal is authorized as a session id,
    // no conversation owns one named `active`, so the request is refused and
    // never reaches the upstream. The map cannot leave the backend this way.
    captured.length = 0;
    const response = await openCodeApp.request("http://localhost/api/opencode/api/session/active");
    expect(response.status).toBe(403);
    expect(captured.length).toBe(0);
  });
});
