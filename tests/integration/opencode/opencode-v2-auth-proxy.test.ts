import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getOpenCodeAuthHeaders } from "@/services/opencode/runtime.ts";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";
import { conversationService } from "@/services/storage/conversations.ts";
import { resolveConversationWorkspace } from "@/services/workspace.ts";

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
(openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
  async () => fixtureBaseUrl;

const { default: openCodeApp } = await import("@/routes/opencode.ts");

/** The directory the server resolves for the fixture session. */
let serverDirectory = "";

beforeAll(async () => {
  const conversation = await conversationService.create({
    title: "Proxy auth fixture",
    providerId: "",
    workspaceMode: "simple",
    opencodeSessionId: fixtureSessionId,
    engine: "opencode",
  });
  const workspace = await resolveConversationWorkspace(conversation.id);
  serverDirectory = workspace.dir;
});

afterAll(() => {
  fixtureServer.stop(true);
  (openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
    originalEnsureBaseUrl;
});

describe("OpenCode proxy authentication", () => {
  it("strips browser Authorization and injects backend auth for REST", async () => {
    capturedRequests.length = 0;

    const response = await openCodeApp.request(
      "http://localhost/api/opencode/api/info?probe=rest",
      { headers: { Authorization: browserAuthorization } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fixture: "opencode-proxy" });
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.authorization).toBe(backendAuthorization);
    expect(capturedRequests[0]?.authorization).not.toBe(browserAuthorization);
    expect(capturedRequests[0]?.url).toBe(`${fixtureBaseUrl}/api/info?probe=rest`);
  });

  it("proxies the V2 server info endpoint with backend auth", async () => {
    capturedRequests.length = 0;

    const response = await openCodeApp.request("http://localhost/api/opencode/info", {
      headers: { Authorization: browserAuthorization },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fixture: "opencode-proxy" });
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.authorization).toBe(backendAuthorization);
    expect(capturedRequests[0]?.url).toBe(`${fixtureBaseUrl}/api/info`);
  });

  it("preserves session paths while replacing browser auth", async () => {
    capturedRequests.length = 0;

    const response = await openCodeApp.request(
      `http://localhost/api/opencode/session/${fixtureSessionId}`,
      { headers: { Authorization: browserAuthorization } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fixture: "opencode-proxy" });
    expect(capturedRequests).toEqual([
      {
        authorization: backendAuthorization,
        directory: encodeURIComponent(serverDirectory),
        method: "GET",
        url: `${fixtureBaseUrl}/api/session/${fixtureSessionId}`,
      },
    ]);
  });

  it("proxies native V2 SSE requests while replacing browser auth", async () => {
    capturedRequests.length = 0;

    const response = await openCodeApp.request("http://localhost/api/opencode/event", {
      headers: {
        Accept: "text/event-stream",
        Authorization: browserAuthorization,
        "x-tbai-session": fixtureSessionId,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe('data: {"type":"server.connected"}\n\n');
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.authorization).toBe(backendAuthorization);
    expect(capturedRequests[0]?.authorization).not.toBe(browserAuthorization);
    expect(capturedRequests[0]?.directory).toBe(encodeURIComponent(serverDirectory));
    expect(capturedRequests[0]?.url).toBe(`${fixtureBaseUrl}/api/event`);
  });

  /**
   * DEFECT REGRESSION (M8) — promoted from the quarantine.
   *
   * The proxy used to forward the browser's `x-opencode-directory` verbatim,
   * so the CALLER chose the upstream's location. Upstream resolves the
   * location of every request from exactly that header (or the
   * `location[directory]` query parameter), so a caller could point the
   * managed server at a directory it does not own — and read the event
   * stream of a workspace that is not theirs.
   *
   * The correct contract: the proxy never forwards a caller-supplied
   * directory. It derives the location server-side and sets the header
   * itself, so the upstream's scope is the server's decision.
   */
  it("R-M8: a caller-supplied directory never reaches the upstream", async () => {
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
    expect(capturedRequests).toHaveLength(1);
    // CORRECT: the upstream is told the SERVER's directory, never the
    // caller's.
    expect(capturedRequests[0]?.directory).not.toBe(encodedFixtureDirectory);
    expect(capturedRequests[0]?.directory).toBe(encodeURIComponent(serverDirectory));
  });
});
