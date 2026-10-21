import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import app from "@/routes/index.ts";
import { isAllowedCorsOrigin } from "@/config/cors.ts";
import { conversationService } from "@/services/storage/conversations.ts";
import {
  bindBootPort,
  getActivePort,
  getActiveServer,
  getReplacedPort,
  initListenerFetch,
  restartListener,
} from "@/services/server-listener.ts";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";
import { resolveConversationWorkspace } from "@/services/workspace.ts";

/**
 * A3 — the CORS origin policy.
 *
 * These tests drive the **real** middleware on the **real** app. The allowed
 * origins are exercised as HTTP requests and judged by the header the browser
 * actually reads (`Access-Control-Allow-Origin`); the refused origins are
 * judged by its **absence**. The one place the list itself is asserted is a
 * dedicated case, so that changing the policy is a deliberate act here rather
 * than a silent edit elsewhere.
 *
 * ## What "refused" means here, precisely
 *
 * A refused origin still gets its request executed — CORS is a browser
 * control, not a server-side one. What it does NOT get is
 * `Access-Control-Allow-Origin`, and without that header the browser refuses
 * to hand the response to the page. A test that only asserted an error
 * status would prove nothing: a 200 with no CORS header is exactly the case
 * that matters, and a 403 would prove nothing about CORS at all.
 *
 * The server-side controls are asserted separately, and deliberately: the
 * OpenCode proxy's route allowlist and its workspace authorization must
 * refuse a request **even from an allowed origin**.
 */

const PACKAGED_ORIGIN = "http://app.localhost";

/** The port this file's real listener binds. */
const TEST_PORT = 45310;

/** A path that answers with a real response and needs no external service. */
const READABLE_PATH = "/api/conversations";

/** The methods the web app actually calls. */
const APP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** The headers the web app actually sends. */
const APP_HEADERS = [
  "Content-Type",
  "Accept",
  "X-TBAI-Operation-ID",
  "x-tbai-session",
  "x-request-id",
] as const;

async function get(origin: string | null, path = READABLE_PATH): Promise<Response> {
  return app.request(`http://localhost${path}`, {
    headers: origin === null ? {} : { Origin: origin },
  });
}

async function preflight(options: {
  readonly origin: string;
  readonly method: string;
  readonly requestHeaders?: string;
  readonly path?: string;
}): Promise<Response> {
  return app.request(`http://localhost${options.path ?? READABLE_PATH}`, {
    method: "OPTIONS",
    headers: {
      Origin: options.origin,
      "Access-Control-Request-Method": options.method,
      ...(options.requestHeaders === undefined
        ? {}
        : { "Access-Control-Request-Headers": options.requestHeaders }),
    },
  });
}

beforeAll(() => {
  // The policy's loopback origins are DERIVED from the live listener, so the
  // suite binds a real one instead of asserting against a constant. The
  // listener serves the real app, so the requests below are the real ones.
  initListenerFetch((request) => app.fetch(request));
  bindBootPort(TEST_PORT);
});

afterAll(() => {
  getActiveServer()?.stop();
});

describe("CORS: the origins TBAi serves", () => {
  it("trusts the packaged app's origin, and TBAi's own pages on the port it serves", () => {
    // The packaged origin is fixed by the platform (Windows WebView2's origin
    // for the custom `app` protocol). The loopback origins are DERIVED from
    // the live listener — the port is the user's choice, so a policy that named
    // a fixed port would break the first time the user moved off it.
    const live = getActivePort();
    expect(isAllowedCorsOrigin(PACKAGED_ORIGIN, [])).toBe(true);
    expect(isAllowedCorsOrigin(`http://localhost:${live}`, [live])).toBe(true);
    expect(isAllowedCorsOrigin(`http://127.0.0.1:${live}`, [live])).toBe(true);
    // A port TBAi does not serve is not trusted.
    expect(isAllowedCorsOrigin("http://localhost:3001", [live])).toBe(false);
  });

  it.each([PACKAGED_ORIGIN])("lets %s read the response", async (origin) => {
    const response = await get(origin);

    expect(response.status).toBe(200);
    // The exact origin is echoed, never a wildcard: a wildcard would let
    // any origin read the response.
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("lets TBAi's own pages on the live port read the response", async () => {
    // The port is read inside the test, not at collection time: the listener
    // is bound in `beforeAll`, and it may have healed upward.
    for (const origin of [
      `http://localhost:${getActivePort()}`,
      `http://127.0.0.1:${getActivePort()}`,
    ]) {
      const response = await get(origin);

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("vary")).toContain("Origin");
    }
  });

  it.each([
    ["a different loopback port", "http://localhost:3001"],
    ["the loopback host itself", "http://127.0.0.1:3000"],
    ["the Vite dev server's port", "http://localhost:5173"],
    ["a public origin", "https://evil.example"],
    ["an opaque origin", "null"],
    ["the packaged origin over https", "https://app.localhost"],
    ["the packaged origin with a path", "http://app.localhost/evil"],
    ["a lookalike host", "http://app.localhost.evil.example"],
    ["the packaged origin with an explicit default port", "http://app.localhost:80"],
    ["a value that is not an origin at all", "not-a-url"],
    ["a scheme-less host", "app.localhost"],
  ])("does not let %s read the response", async (_label, origin) => {
    const response = await get(origin);

    // The request still ran: CORS is not authorization. What the browser
    // cannot do is READ the response, and that is what the missing header
    // means. The body is present, and the browser would refuse to hand it
    // over.
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect((await response.text()).length).toBeGreaterThan(0);
  });

  it("answers a request with no Origin header without any CORS header", async () => {
    // A same-origin or non-browser request. It needs no CORS headers, and
    // the wildcard the old policy returned here is gone.
    const response = await get(null);

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("CORS: across a port change", () => {
  it("keeps trusting the page the new listener replaced", async () => {
    // The browser-mode restart works like this: the page is still on the OLD
    // origin, it asks the NEW origin whether it is up, and only then navigates.
    // That probe is a cross-origin request, so the new listener has to trust
    // the origin it replaced — otherwise a port change is reported as a failed
    // restart even though the server moved.
    const oldPort = getActivePort();
    const newPort = TEST_PORT + 91;
    const result = await restartListener(newPort);
    expect(result.restarted).toBe(true);
    expect(getActivePort()).toBe(newPort);
    expect(getReplacedPort()).toBe(oldPort);

    // The probe from the old page is readable.
    const probe = await get(`http://localhost:${oldPort}`);
    expect(probe.status).toBe(200);
    expect(probe.headers.get("access-control-allow-origin")).toBe(`http://localhost:${oldPort}`);

    // And so is the new origin the page navigates to.
    const next = await get(`http://localhost:${newPort}`);
    expect(next.status).toBe(200);
    expect(next.headers.get("access-control-allow-origin")).toBe(`http://localhost:${newPort}`);

    // A port TBAi never served is still refused.
    const stranger = await get("http://localhost:45678");
    expect(stranger.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("CORS: preflight", () => {
  it("answers TBAi's own pages' preflight for the methods and headers the app uses", async () => {
    const origins = [
      PACKAGED_ORIGIN,
      `http://localhost:${getActivePort()}`,
      `http://127.0.0.1:${getActivePort()}`,
    ];
    for (const origin of origins) {
      for (const method of APP_METHODS) {
        const response = await preflight({
          origin,
          method,
          requestHeaders: APP_HEADERS.join(","),
        });

        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-origin")).toBe(origin);
        const allowedMethods = response.headers.get("access-control-allow-methods") ?? "";
        // A preflight that omits the requested method FAILS, and the browser
        // then never sends the request. `PATCH` is in this list because the
        // app calls it in fifteen places.
        expect(allowedMethods.split(",")).toContain(method);
      }
    }
  });

  it("answers TBAi's own pages' preflight with the headers the app sends", async () => {
    for (const origin of [
      PACKAGED_ORIGIN,
      `http://localhost:${getActivePort()}`,
      `http://127.0.0.1:${getActivePort()}`,
    ]) {
      const response = await preflight({
        origin,
        method: "POST",
        requestHeaders: APP_HEADERS.join(","),
      });

      const allowedHeaders = (response.headers.get("access-control-allow-headers") ?? "")
        .split(",")
        .map((header) => header.trim());
      for (const header of APP_HEADERS) {
        expect(allowedHeaders).toContain(header);
      }
    }
  });

  it("does not let a hostile origin preflight the app's headers", async () => {
    const response = await preflight({
      origin: "https://evil.example",
      method: "POST",
      requestHeaders: APP_HEADERS.join(","),
    });

    // No `Access-Control-Allow-Origin` means the preflight fails, so the
    // browser never sends the request it was asking about.
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not let a browser send the removed workspace header", async () => {
    const response = await preflight({
      origin: PACKAGED_ORIGIN,
      method: "POST",
      requestHeaders: "content-type,x-opencode-directory",
      path: "/api/opencode/api/session/ses_x",
    });

    const allowedHeaders = (response.headers.get("access-control-allow-headers") ?? "")
      .split(",")
      .map((header) => header.trim());
    // The header is not offered, so a browser refuses to send it. And even
    // if one did, the proxy strips it and derives the workspace itself.
    expect(allowedHeaders).not.toContain("x-opencode-directory");
    expect(allowedHeaders).toContain("x-tbai-session");
  });
});

describe("CORS: the server-side controls are independent of it", () => {
  it("refuses an unknown OpenCode session even from an allowed origin", async () => {
    const response = await app.request(
      "http://localhost/api/opencode/api/session/ses_not_a_known_session",
      { headers: { Origin: PACKAGED_ORIGIN } },
    );

    // The origin is trusted, so the browser would happily read this — which
    // is exactly why the refusal has to come from the server and not from
    // CORS.
    expect(response.headers.get("access-control-allow-origin")).toBe(PACKAGED_ORIGIN);
    expect(response.status).toBe(403);
  });

  it("refuses a route outside the proxy's allowlist even from an allowed origin", async () => {
    const response = await app.request("http://localhost/api/opencode/api/fs/read/etc/passwd", {
      headers: { Origin: PACKAGED_ORIGIN },
    });

    expect(response.headers.get("access-control-allow-origin")).toBe(PACKAGED_ORIGIN);
    expect(response.status).toBe(404);
  });
});

describe("CORS: the OpenCode scope headers", () => {
  const SESSION_ID = "ses_cors_policy_fixture";
  const FOREIGN_DIRECTORY = encodeURIComponent("/workspace/somebody-elses-project");

  const captured: { readonly directory: string | null }[] = [];
  const fixtureServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      captured.push({ directory: request.headers.get("x-opencode-directory") });
      return Response.json({ fixture: "opencode" });
    },
  });
  const fixtureBaseUrl = `http://127.0.0.1:${fixtureServer.port}`;
  const originalEnsureBaseUrl = openCodeServerManager.ensureBaseUrl;
  (openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
    async () => fixtureBaseUrl;

  let conversationId = "";
  let serverDirectory = "";

  beforeAll(async () => {
    const conversation = await conversationService.create({
      title: "CORS policy fixture",
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

  it("reads a session-scoped request from an allowed origin, and ignores the caller's directory", async () => {
    captured.length = 0;
    const response = await app.request(`http://localhost/api/opencode/api/session/${SESSION_ID}`, {
      headers: {
        Origin: PACKAGED_ORIGIN,
        // The browser's own scope input: which session the request is about.
        "x-tbai-session": SESSION_ID,
        // The removed one: a caller-chosen working directory. It is not in
        // the CORS allow-list, so a browser would not send it — and if one
        // did, the proxy strips it and derives the workspace itself.
        "x-opencode-directory": FOREIGN_DIRECTORY,
      },
    });

    // The response is readable: the origin is trusted.
    expect(response.headers.get("access-control-allow-origin")).toBe(PACKAGED_ORIGIN);
    expect(response.status).toBe(200);

    // And the workspace is the SERVER's, never the caller's.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.directory).toBe(encodeURIComponent(serverDirectory));
    expect(captured[0]?.directory).not.toBe(FOREIGN_DIRECTORY);
    expect(conversationId).not.toBe("");
  });
});
