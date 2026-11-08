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
  installAdoptedTarget,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";
import {
  OpenCodeOriginMismatchError,
  OpenCodeRedirectRefusedError,
} from "@/services/opencode/http.ts";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";

/**
 * CT1–CT4, CT6 — the configuration path is bound to a REQUIRED transport.
 *
 * `readOpenCodeConfigDocument` used to read `globalThis.fetch` and build its own
 * `Authorization`. It now cannot be constructed without a captured transport,
 * and these cases prove each half of that contract:
 *
 * - CT1 / R12: without a transport it fails to COMPILE and, for an untyped
 *   caller, throws before any request.
 * - CT2: the request targets the captured origin with the captured credential.
 * - CT3: a 3xx is refused and its body is cancelled by the transport.
 * - CT4 / R7: another origin is rejected before a request is sent.
 * - CT6: the permission writer itself makes no request; it inherits CT1–CT4.
 */

const ORIGIN_A = "http://127.0.0.1:4201";
const ORIGIN_B = "http://127.0.0.1:4202";
const ADOPTED_PASSWORD = "config-transport-adopted-password";

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

/**
 * CT1 at COMPILE time.
 *
 * If `transport` ever becomes optional again, the empty shape below extends the
 * picked shape and the alias is `true`; assigning `false` then fails
 * `bun run typecheck`. `strictNullChecks` is off in this test project, so an
 * `undefined extends …` probe would be vacuously true — the empty shape tests
 * the REQUIRED-property property instead, which null checking does not affect.
 * No `@ts-expect-error` directive and no cast: the assertion is the type.
 */
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

describe("CT1 / R12 — the read cannot happen without a transport", () => {
  it("is typed as a required parameter", () => {
    // The value is derived from the signature; see the type comment above.
    expect(transportMustBeRequired).toBe(false);
  });

  it("throws before any request when an untyped caller omits it", async () => {
    const calls = stubFetch(() => Response.json([]));
    // Deliberately invalid at runtime. The assertion is legal because
    // `OpenCodeConfigReadTarget` is assignable to the object literal's type.
    const withoutTransport = { baseUrl: ORIGIN_A } as OpenCodeConfigReadTarget;

    await expect(readOpenCodeConfigDocument(withoutTransport)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe("CT2 — the read targets the captured origin and credential", () => {
  it("sends the captured Basic header to the captured origin's /api/config", async () => {
    const calls = stubFetch(() => Response.json([]));
    installAdoptedTarget({ origin: ORIGIN_A, password: ADOPTED_PASSWORD });
    const context = captureOpenCodeRequestContext();

    await expect(
      readOpenCodeConfigDocument({ baseUrl: context.baseUrl, transport: context.transport }),
    ).rejects.toThrow(); // no document in the empty listing; the REQUEST is what matters

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${ORIGIN_A}/api/config`);
    const authorization = new Headers(calls[0]?.init?.headers).get("authorization");
    const decoded = Buffer.from(authorization!.replace(/^Basic /, ""), "base64").toString("utf8");
    expect(decoded).toBe(`${OPENCODE_CONFIG.authUsername}:${ADOPTED_PASSWORD}`);
  });
});

describe("CT3 — a redirect on the read is refused and its body cancelled", () => {
  it("cancels the 3xx body before throwing and does not read its Location", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a redirect body that must not be read"));
      },
      cancel() {
        cancelled = true;
      },
    });
    stubFetch(
      () =>
        new Response(body, {
          status: 302,
          headers: { location: `${ORIGIN_B}/steal?p=${ADOPTED_PASSWORD}` },
        }),
    );

    const transport = createBoundedTransport({
      origin: ORIGIN_A,
      credential: Object.freeze({ kind: "managed" as const, password: ADOPTED_PASSWORD }),
      shutdownEpoch: 0,
    });

    let error: unknown;
    try {
      await readOpenCodeConfigDocument({ baseUrl: ORIGIN_A, transport });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(OpenCodeRedirectRefusedError);
    expect((error as OpenCodeRedirectRefusedError).status).toBe(302);
    expect((error as Error).message).not.toContain(ADOPTED_PASSWORD);
    expect(cancelled).toBe(true);
  });
});

describe("CT4 / R7 — another origin is rejected before any request", () => {
  it("throws the origin mismatch with zero fetches and without reading the credential", async () => {
    let credentialReads = 0;
    const credential = Object.freeze({
      kind: "adopted" as const,
      origin: ORIGIN_A,
      get password() {
        credentialReads += 1;
        return ADOPTED_PASSWORD;
      },
    });
    const transport = createBoundedTransport({ origin: ORIGIN_A, credential, shutdownEpoch: 0 });
    const calls = stubFetch(() => Response.json([]));

    await expect(
      readOpenCodeConfigDocument({ baseUrl: ORIGIN_B, transport }),
    ).rejects.toBeInstanceOf(OpenCodeOriginMismatchError);

    expect(calls).toHaveLength(0);
    // The password getter is never invoked: the origin check runs before the
    // header is derived, so a cross-origin attempt cannot even read the
    // credential. The read itself never builds a header at all.
    expect(credentialReads).toBe(0);
  });
});

// --- CT6: the permission writer inherits CT1–CT4 and makes no request itself ---

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

describe("CT6 — a refused permission write issues no request at all", () => {
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

    // The managed writer has no TBAi-owned root, so it refuses before it reads
    // the document at all. That is stronger than "the writer adds no request":
    // a refused write cannot expose the credential or the document either.
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("user's own");

    // No upstream request was made, so no configuration was read.
    expect(service.requests).toHaveLength(0);
    // And no file was touched.
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("is refused even when the installed service would redirect the read", async () => {
    const configPath = makeConfigFile();
    const before = readFileSync(configPath, "utf8");
    const redirectTarget = startFixture(() => Response.json({ stolen: true }));
    const service = startFixture(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: `${redirectTarget.baseUrl}/steal` },
        }),
    );
    (openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
      async () => service.baseUrl;

    const response = await openCodeApp.request("http://localhost/config/permissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "question", resource: "*", effect: "ask" }),
    });

    // The refusal happens first, so neither service is contacted. The redirect
    // refusal itself is covered on the read path by R3.
    expect(response.status).toBe(409);
    expect(service.requests).toHaveLength(0);
    expect(redirectTarget.requests).toHaveLength(0);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });
});
