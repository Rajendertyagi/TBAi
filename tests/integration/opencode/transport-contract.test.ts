import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OPENCODE_CONFIG } from "@/config/opencode.ts";
import { createOpenCodeClient } from "@/services/opencode/client.ts";
import { readOpenCodeConfigDocument } from "@/services/opencode/configDocument.ts";
import {
  captureOpenCodeRequestContext,
  installAdoptedTarget,
  installManagedTarget,
  readConnectionState,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";
import { getOpenCodeAuthPassword } from "@/services/opencode/runtime.ts";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";

/**
 * R8, RC6 and RC7 — the captured context is what actually goes to the wire.
 *
 * Two properties are asserted and they pull in opposite directions:
 *
 * - **R8** an installed MANAGED target keeps working: the credential is the
 *   managed one and nothing about the transport work turned managed mode into a
 *   second, header-less path.
 * - **RC6 / RC7** a request that captured its context keeps that origin and
 *   credential even when the runtime state moves underneath it, and the native
 *   client and the configuration read obtain the SAME context shape.
 *
 * These run against real loopback servers because "the same origin and the same
 * credential" is only observable on the wire.
 */

const ADOPTED_PASSWORD = "contract-adopted-password";
const MANAGED_PASSWORD = getOpenCodeAuthPassword();
const ADOPTED_AUTHORIZATION = `Basic ${Buffer.from(
  `${OPENCODE_CONFIG.authUsername}:${ADOPTED_PASSWORD}`,
).toString("base64")}`;
const MANAGED_AUTHORIZATION = `Basic ${Buffer.from(
  `${OPENCODE_CONFIG.authUsername}:${MANAGED_PASSWORD}`,
).toString("base64")}`;

const SERVER_INFO = { version: "2.0.15", pid: 1, urls: [], paths: { tmp: "fixture" } } as const;

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
}

interface Fixture {
  readonly baseUrl: string;
  readonly requests: CapturedRequest[];
  readonly stop: () => void;
}

const fixtures: Fixture[] = [];
const tempDirs: string[] = [];

function startFixture(handler: (request: Request) => Response | Promise<Response>): Fixture {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
      });
      return handler(request);
    },
  });
  const fixture: Fixture = {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
  fixtures.push(fixture);
  return fixture;
}

/** A normal service: server info and a config document naming a temp file. */
function normalService(): Fixture {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tbai-opencode-contract-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "opencode.json");
  return startFixture((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/info") return Response.json(SERVER_INFO);
    if (url.pathname === "/api/config") {
      return Response.json([{ type: "document", path: configPath, info: { permissions: [] } }]);
    }
    return Response.json({ fixture: "contract" });
  });
}

const originalEnsureBaseUrl = openCodeServerManager.ensureBaseUrl;
const { default: openCodeApp } = await import("@/routes/opencode.ts");

beforeEach(() => {
  resetConnectionStateForTests();
});

afterEach(() => {
  resetConnectionStateForTests();
  for (const fixture of fixtures.splice(0)) fixture.stop();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  (openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
    originalEnsureBaseUrl;
});

describe("R8 — managed mode still works end to end", () => {
  it("serves the proxy, the config read and the native client with the managed credential", async () => {
    const service = normalService();
    installManagedTarget({ baseUrl: service.baseUrl, password: MANAGED_PASSWORD });
    const context = captureOpenCodeRequestContext();

    const proxy = await openCodeApp.request("http://localhost/api/opencode/info");
    expect(proxy.status).toBe(200);
    expect(await proxy.json()).toEqual(SERVER_INFO);

    const document = await readOpenCodeConfigDocument({
      baseUrl: context.baseUrl,
      transport: context.transport,
    });
    expect(document.path).toContain("opencode.json");

    const client = createOpenCodeClient(context.baseUrl, { transport: context.transport });
    const info = await client.server.info();
    expect(info).toMatchObject({ version: SERVER_INFO.version });

    // Every request that reached the managed service carried the managed
    // credential; no request was refused as an origin mismatch or a redirect.
    expect(service.requests).toHaveLength(3);
    expect(
      service.requests.every((request) => request.authorization === MANAGED_AUTHORIZATION),
    ).toBe(true);
    expect(service.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/info",
      "/api/config",
      "/api/info",
    ]);
    expect(context.mode).toBe("managed");
  });
});

describe("RC6 — a proxy request keeps the context it captured", () => {
  it("keeps sending to the captured origin and credential while the target changes mid-fetch", async () => {
    let received!: () => void;
    const receivedAt = new Promise<void>((resolve) => {
      received = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    const managed = startFixture(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/info") {
        received();
        await released;
      }
      return Response.json({ fixture: "managed" });
    });
    const adopted = normalService();

    installManagedTarget({ baseUrl: managed.baseUrl, password: MANAGED_PASSWORD });
    const request = openCodeApp.request("http://localhost/api/opencode/info");

    // The request is at the captured origin, inside its upstream fetch. Now the
    // runtime moves to a different service.
    await receivedAt;
    installAdoptedTarget({ origin: adopted.baseUrl, password: ADOPTED_PASSWORD });
    expect(readConnectionState().target.mode).toBe("adopted");

    release();
    const response = await request;

    expect(response.status).toBe(200);
    expect(managed.requests).toHaveLength(1);
    expect(managed.requests[0]?.authorization).toBe(MANAGED_AUTHORIZATION);
    expect(managed.requests[0]?.url).toBe(`${managed.baseUrl}/api/info`);
    // The installed-after-capture target received nothing: no cross-origin
    // request and no credential mixing.
    expect(adopted.requests).toHaveLength(0);
  });
});

describe("RC7 — the native client and the config read share one contract", () => {
  it("both target the captured origin with the captured credential", async () => {
    const service = normalService();
    installAdoptedTarget({ origin: service.baseUrl, password: ADOPTED_PASSWORD });
    const context = captureOpenCodeRequestContext();

    const client = createOpenCodeClient(context.baseUrl, { transport: context.transport });
    await client.server.info();
    const document = await readOpenCodeConfigDocument({
      baseUrl: context.baseUrl,
      transport: context.transport,
    });

    expect(context.mode).toBe("adopted");
    expect(context.baseUrl).toBe(service.baseUrl);
    expect(context.credential.password).toBe(ADOPTED_PASSWORD);
    expect(document.path).toContain("opencode.json");

    expect(service.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/info",
      "/api/config",
    ]);
    for (const request of service.requests) {
      expect(new URL(request.url).origin).toBe(service.baseUrl);
      expect(request.authorization).toBe(ADOPTED_AUTHORIZATION);
      expect(request.authorization).not.toBe(MANAGED_AUTHORIZATION);
    }
    // "The configuration read has no default transport" is CT1 in
    // `config-transport.test.ts`; here both callers were handed the same
    // captured instance and it is what reached the wire.
  });
});
