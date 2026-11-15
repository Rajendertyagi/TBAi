import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OPENCODE_CONFIG } from "@/config/opencode.ts";
import {
  readOpenCodeConfigDocument,
  type OpenCodeConfigReadTarget,
} from "@/services/opencode/configDocument.ts";
import {
  captureOpenCodeRequestContext,
  createBoundedTransport,
  installManagedTarget,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";
import {
  OpenCodeOriginMismatchError,
  OpenCodeRedirectRefusedError,
} from "@/services/opencode/http.ts";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";

const ORIGIN_A = "http://127.0.0.1:4201";
const ORIGIN_B = "http://127.0.0.1:4202";
const PASSWORD = "config-transport-password";

const realFetch = globalThis.fetch;

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function stubFetch(
  responder: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
): CapturedCall[] {
  const calls: CapturedCall[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return responder(input, init);
  };
  globalThis.fetch = Object.assign(stub, { preconnect: realFetch.preconnect });
  return calls;
}

type ReadTarget = Parameters<typeof readOpenCodeConfigDocument>[0];
type EmptyShape = Record<never, never>;
type TransportIsOptional = EmptyShape extends Pick<ReadTarget, "transport"> ? true : false;
const transportMustBeRequired: TransportIsOptional = false;

beforeEach(() => {
  resetConnectionStateForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetConnectionStateForTests();
});

describe("config read transport binding", () => {
  it("requires a transport at type and runtime level", async () => {
    expect(transportMustBeRequired).toBe(false);
    const calls = stubFetch(() => Response.json([]));
    const withoutTransport = { baseUrl: ORIGIN_A } as OpenCodeConfigReadTarget;
    await expect(readOpenCodeConfigDocument(withoutTransport)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("targets the captured origin and credential", async () => {
    const calls = stubFetch(() => Response.json([]));
    installManagedTarget({ baseUrl: ORIGIN_A, password: PASSWORD });
    const context = captureOpenCodeRequestContext();

    await expect(
      readOpenCodeConfigDocument({ baseUrl: context.baseUrl, transport: context.transport }),
    ).rejects.toThrow();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${ORIGIN_A}/api/config`);
    const authorization = new Headers(calls[0]?.init?.headers).get("authorization");
    const decoded = Buffer.from(authorization!.replace(/^Basic /, ""), "base64").toString("utf8");
    expect(decoded).toBe(`${OPENCODE_CONFIG.authUsername}:${PASSWORD}`);
  });

  it("refuses redirects and cancels the body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("redirect body"));
      },
      cancel() {
        cancelled = true;
      },
    });
    stubFetch(
      () => new Response(body, { status: 302, headers: { location: `${ORIGIN_B}/steal` } }),
    );

    const transport = createBoundedTransport({
      origin: ORIGIN_A,
      credential: Object.freeze({ kind: "managed" as const, password: PASSWORD }),
      shutdownEpoch: 0,
    });

    await expect(
      readOpenCodeConfigDocument({ baseUrl: ORIGIN_A, transport }),
    ).rejects.toBeInstanceOf(OpenCodeRedirectRefusedError);
    expect(cancelled).toBe(true);
  });

  it("rejects another origin before any request", async () => {
    const transport = createBoundedTransport({
      origin: ORIGIN_A,
      credential: Object.freeze({ kind: "managed" as const, password: PASSWORD }),
      shutdownEpoch: 0,
    });
    const calls = stubFetch(() => Response.json([]));

    await expect(
      readOpenCodeConfigDocument({ baseUrl: ORIGIN_B, transport }),
    ).rejects.toBeInstanceOf(OpenCodeOriginMismatchError);
    expect(calls).toHaveLength(0);
  });
});

interface Fixture {
  readonly baseUrl: string;
  readonly requests: { url: string; method: string; authorization: string | null }[];
  readonly stop: () => void;
}

const fixtures: Fixture[] = [];
const tempDirs: string[] = [];

function startFixture(handler: (request: Request) => Response | Promise<Response>): Fixture {
  const requests: Fixture["requests"] = [];
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

const originalEnsureBaseUrl = openCodeServerManager.ensureBaseUrl;
const { default: openCodeApp } = await import("@/routes/opencode.ts");

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.stop();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  (openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
    originalEnsureBaseUrl;
});

function makeConfigFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tbai-opencode-ct6-"));
  tempDirs.push(dir);
  const file = path.join(dir, "opencode.json");
  writeFileSync(
    file,
    `${JSON.stringify({ permissions: [{ action: "edit", resource: "*", effect: "ask" }] }, null, 2)}\n`,
    "utf8",
  );
  return file;
}

describe("managed config writes are refused before any request", () => {
  it("refuses before the read and leaves the file byte-identical", async () => {
    const configPath = makeConfigFile();
    const before = readFileSync(configPath, "utf8");
    const service = startFixture((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/config") {
        return Response.json([{ type: "document", path: configPath, info: { permissions: [] } }]);
      }
      return Response.json({});
    });
    (openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
      async () => service.baseUrl;

    const response = await openCodeApp.request("http://localhost/config/permissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "question", resource: "*", effect: "ask" }),
    });

    expect(response.status).toBe(409);
    expect(service.requests).toHaveLength(0);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });
});
