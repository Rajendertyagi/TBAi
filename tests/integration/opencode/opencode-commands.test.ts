import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";

/**
 * The command feed's transport contract.
 *
 * The composer's `/` palette needs OpenCode's commands, and the command
 * catalogue is **location-scoped upstream** — so the proxy's allowlist
 * deliberately does not carry it. The backend reads the catalogue and serves
 * it from TBAi's own route, which keeps the proxy's forwarded surface
 * exactly the routes the browser's session client calls.
 *
 * What this suite pins is the **transport**: the endpoint delivers the
 * server's own payload, verbatim, with no reshaping. The payload's shape is
 * the upstream's contract (the installed client's `CommandListOutput` is
 * `{ location, data }`), and the browser's parser is a separate concern —
 * see the characterization case in
 * `tests/unit/web/opencode/slashCommands.test.ts`.
 */

const UPSTREAM_PAYLOAD = {
  location: { directory: "D:\\workspace\\project" },
  data: [
    { name: "init", description: "Start here", source: "command" },
    { name: "review", description: "Review the diff", source: "skill" },
  ],
};

const fixtureServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/command") {
      return Response.json(UPSTREAM_PAYLOAD);
    }
    return Response.json({ fixture: "opencode-commands" });
  },
});

const fixtureBaseUrl = `http://127.0.0.1:${fixtureServer.port}`;
const originalEnsureBaseUrl = openCodeServerManager.ensureBaseUrl;
(openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
  async () => fixtureBaseUrl;

const { default: openCodeApp } = await import("@/routes/opencode.ts");

beforeAll(() => {
  // The fixture is already listening; nothing to prepare beyond the patch.
});

afterAll(() => {
  fixtureServer.stop(true);
  (openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
    originalEnsureBaseUrl;
});

describe("GET /api/opencode/commands", () => {
  it("delivers the server's payload verbatim", async () => {
    const response = await openCodeApp.request("http://localhost/commands");

    expect(response.status).toBe(200);
    // Nothing is reshaped: the browser receives exactly what the server sent,
    // which is the shape the installed client declares for it.
    expect(await response.json()).toEqual(UPSTREAM_PAYLOAD);
  });

  it("is a TBAi route, so the proxy's allowlist does not carry the catalogue", async () => {
    // The catalogue is location-scoped upstream. Reaching it through the
    // proxy would put it on the proxy's forwarded surface, which the
    // allowlist does not allow.
    const throughProxy = await openCodeApp.request("http://localhost/api/command");
    expect(throughProxy.status).toBe(404);
  });
});
