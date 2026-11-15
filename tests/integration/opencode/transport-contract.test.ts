import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OPENCODE_CONFIG } from "@/config/opencode.ts";
import { createOpenCodeClient } from "@/services/opencode/client.ts";
import { readOpenCodeConfigDocument } from "@/services/opencode/configDocument.ts";
import {
  captureOpenCodeRequestContext,
  installManagedTarget,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";
import { getOpenCodeAuthPassword } from "@/services/opencode/runtime.ts";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";

/**
 * Managed-only transport contract: captured context is what reaches the wire.
 */

const MANAGED_PASSWORD = getOpenCodeAuthPassword();
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

describe("managed transport contract", () => {
  it("serves proxy, config read and native client with the managed credential", async () => {
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

  it("keeps a captured request on its captured managed origin while target changes mid-fetch", async () => {
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
    const other = normalService();

    installManagedTarget({ baseUrl: managed.baseUrl, password: MANAGED_PASSWORD });
    const request = openCodeApp.request("http://localhost/api/opencode/info");

    await receivedAt;
    installManagedTarget({ baseUrl: other.baseUrl, password: MANAGED_PASSWORD });
    release();
    const response = await request;

    expect(response.status).toBe(200);
    expect(managed.requests).toHaveLength(1);
    expect(managed.requests[0]?.authorization).toBe(MANAGED_AUTHORIZATION);
    expect(managed.requests[0]?.url).toBe(`${managed.baseUrl}/api/info`);
    expect(other.requests).toHaveLength(0);
  });
});
