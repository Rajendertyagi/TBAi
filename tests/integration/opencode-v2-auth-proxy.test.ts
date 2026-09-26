import { afterAll, describe, expect, it } from "bun:test";
import { getOpenCodeAuthHeaders } from "../../src/services/opencode/runtime";
import { openCodeServerManager } from "../../src/services/opencode/serverManager";

const browserAuthorization = "Bearer browser-controlled-secret";
const backendAuthorization = getOpenCodeAuthHeaders().Authorization;
const fixtureSessionId = "ses_fixture_session";
const fixtureDirectory = "/workspace/project one";
const encodedFixtureDirectory = encodeURIComponent(fixtureDirectory);

type CapturedProxyRequest = {
  readonly authorization: string | null;
  readonly directory: string | null;
  readonly method: string;
  readonly url: string;
};

const capturedRequests: CapturedProxyRequest[] = [];
const fixtureServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    capturedRequests.push({
      authorization: request.headers.get("authorization"),
      directory: request.headers.get("x-opencode-directory"),
      method: request.method,
      url: request.url,
    });

    if (request.headers.get("authorization") !== backendAuthorization) {
      return new Response("unauthorized", { status: 401 });
    }
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
(
  openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }
).ensureBaseUrl = async () => fixtureBaseUrl;

const { default: openCodeApp } = await import("../../src/routes/opencode");

afterAll(() => {
  fixtureServer.stop(true);
  (
    openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }
  ).ensureBaseUrl = originalEnsureBaseUrl;
});

describe("OpenCode proxy authentication", () => {
  it("strips browser Authorization and injects backend auth for REST", async () => {
    capturedRequests.length = 0;

    const response = await openCodeApp.request(
      "http://localhost/api/opencode/api/config?probe=rest",
      { headers: { Authorization: browserAuthorization } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fixture: "opencode-proxy" });
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.authorization).toBe(backendAuthorization);
    expect(capturedRequests[0]?.authorization).not.toBe(browserAuthorization);
    expect(capturedRequests[0]?.url).toBe(`${fixtureBaseUrl}/api/config?probe=rest`);
  });

  it("proxies the V2 server info endpoint with backend auth", async () => {
    capturedRequests.length = 0;

    const response = await openCodeApp.request(
      "http://localhost/api/opencode/info",
      { headers: { Authorization: browserAuthorization } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fixture: "opencode-proxy" });
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.authorization).toBe(backendAuthorization);
    expect(capturedRequests[0]?.url).toBe(`${fixtureBaseUrl}/api/info`);
  });

  it("preserves session paths and directory headers while replacing browser auth", async () => {
    capturedRequests.length = 0;

    const response = await openCodeApp.request(
      `http://localhost/api/opencode/session/${fixtureSessionId}`,
      {
        headers: {
          Authorization: browserAuthorization,
          "x-opencode-directory": encodedFixtureDirectory,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fixture: "opencode-proxy" });
    expect(capturedRequests).toEqual([
      {
        authorization: backendAuthorization,
        directory: encodedFixtureDirectory,
        method: "GET",
        url: `${fixtureBaseUrl}/api/session/${fixtureSessionId}`,
      },
    ]);
  });

  it("proxies native V2 SSE requests while replacing browser auth", async () => {
    capturedRequests.length = 0;

    const response = await openCodeApp.request(
      "http://localhost/api/opencode/event?directory=%2Fworkspace%2Fproject-one",
      {
        headers: {
          Accept: "text/event-stream",
          Authorization: browserAuthorization,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe('data: {"type":"server.connected"}\n\n');
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.authorization).toBe(backendAuthorization);
    expect(capturedRequests[0]?.authorization).not.toBe(browserAuthorization);
    expect(capturedRequests[0]?.directory).toBeNull();
    expect(capturedRequests[0]?.url).toBe(
      `${fixtureBaseUrl}/api/event?directory=%2Fworkspace%2Fproject-one`,
    );
  });
});
