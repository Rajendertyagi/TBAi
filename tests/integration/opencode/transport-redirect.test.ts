import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "../../helpers/repo-root";
import { stripComments } from "../../helpers/web/source-scope";
import { OPENCODE_CONFIG } from "@/config/opencode.ts";
import { logger } from "@/lib/logger.ts";
import { attemptOpenCodeAdoption } from "@/services/opencode/adoption.ts";
import { readOpenCodeConfigDocument } from "@/services/opencode/configDocument.ts";
import {
  beginAttempt,
  captureOpenCodeRequestContext,
  createDiscoveryProbeTransport,
  installAdoptedTarget,
  installManagedTarget,
  readConnectionState,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";
import { OpenCodeRedirectRefusedError } from "@/services/opencode/http.ts";
import { getOpenCodeAuthPassword } from "@/services/opencode/runtime.ts";

/**
 * R1–R11 — every credential-bearing OpenCode request refuses a redirect.
 *
 * Each case drives a REAL loopback HTTP server, because the property under test
 * is the one that only appears on the wire: does the request reach the redirect
 * target? A stubbed `fetch` cannot answer that, and the earlier `redirect:
 * "manual"` policy was verified precisely by observing a second server stay
 * silent. So server A answers with a 3xx, server B records anything it receives,
 * and every case asserts B is empty.
 *
 * The secret in each `Location` is the credential A was sent. It is there to
 * prove the refusal never reads `Location` (R10): if any layer parsed the header
 * into an error, a log or a response body, the value would reappear.
 */

const ADOPTED_PASSWORD = "redirect-acceptance-adopted-password";
const ADOPTED_AUTHORIZATION = `Basic ${Buffer.from(
  `${OPENCODE_CONFIG.authUsername}:${ADOPTED_PASSWORD}`,
).toString("base64")}`;
const ADOPTED_BASE64 = Buffer.from(`${OPENCODE_CONFIG.authUsername}:${ADOPTED_PASSWORD}`).toString(
  "base64",
);
const MANAGED_PASSWORD = getOpenCodeAuthPassword();
/** An installed managed target's credential, chosen here so the wire is checkable. */
const R4_MANAGED_PASSWORD = "r4-managed-synthetic-password";
const R4_MANAGED_BASE64 = Buffer.from(
  `${OPENCODE_CONFIG.authUsername}:${R4_MANAGED_PASSWORD}`,
).toString("base64");

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

/** A redirect whose `Location` deliberately carries the credential it was sent. */
function redirectTo(target: string, status = 302): Response {
  const leak = `${target}/steal?password=${encodeURIComponent(
    ADOPTED_PASSWORD,
  )}&basic=${ADOPTED_BASE64}`;
  return new Response(null, { status, headers: { location: leak } });
}

function writeRegistration(record: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tbai-opencode-redirect-"));
  tempDirs.push(dir);
  const file = path.join(dir, "opencode.json");
  writeFileSync(file, JSON.stringify(record), "utf8");
  return file;
}

function passwordOf(request: CapturedRequest | undefined): string | null {
  const header = request?.authorization;
  if (header === null || header === undefined) return null;
  const decoded = Buffer.from(header.replace(/^Basic /, ""), "base64").toString("utf8");
  return decoded.replace(`${OPENCODE_CONFIG.authUsername}:`, "");
}

type LogArgs = Parameters<typeof logger.info>;

/** Records every structured log line emitted while the case runs. */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = {
    debug: logger.debug,
    info: logger.info,
    warn: logger.warn,
    error: logger.error,
  };
  const record = (...args: LogArgs): void => {
    lines.push(`${args[0]} ${args[1]} ${JSON.stringify(args[2] ?? {})}`);
  };
  logger.debug = record;
  logger.info = record;
  logger.warn = record;
  logger.error = record;
  return {
    lines,
    restore: () => {
      logger.debug = original.debug;
      logger.info = original.info;
      logger.warn = original.warn;
      logger.error = original.error;
    },
  };
}

/** Every text carrier a refusal could leak through. */
function secretsIn(text: string): string[] {
  return [ADOPTED_PASSWORD, ADOPTED_BASE64, ADOPTED_AUTHORIZATION].filter((secret) =>
    text.includes(secret),
  );
}

/**
 * The source text from one declaration to the next marker.
 *
 * An end marker that is absent means "to the end of the file", so a missing
 * boundary fails loudly instead of returning an empty slice.
 */
function sectionOf(source: string, start: string, end: string | number): string {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`marker not found: ${start}`);
  const to = typeof end === "number" ? end : source.indexOf(end, from + start.length);
  if (to <= from) throw new Error(`end marker not found after: ${start}`);
  return source.slice(from, to);
}

const { default: openCodeApp } = await import("@/routes/opencode.ts");

beforeEach(() => {
  resetConnectionStateForTests();
});

afterEach(() => {
  resetConnectionStateForTests();
  for (const fixture of fixtures.splice(0)) fixture.stop();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("R1 — the initial adoption probe refuses a redirect", () => {
  it("surfaces the typed refusal at the discovery transport and reaches neither target", async () => {
    const redirectTarget = startFixture(() => Response.json({ stolen: true }));
    const candidate = startFixture(() => redirectTo(redirectTarget.baseUrl));

    const attempt = beginAttempt("startup");
    const transport = createDiscoveryProbeTransport(attempt, {
      origin: candidate.baseUrl,
      password: ADOPTED_PASSWORD,
    });

    let error: unknown;
    try {
      await transport(`${candidate.baseUrl}/api/info`);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OpenCodeRedirectRefusedError);
    const refusal = error as OpenCodeRedirectRefusedError;
    expect(refusal.status).toBe(302);
    // The refusal carries a status and a stable code, nothing from `Location`.
    expect(secretsIn(`${refusal.name} ${refusal.message} ${refusal.code}`)).toEqual([]);
    expect(secretsIn(JSON.stringify(refusal, Object.getOwnPropertyNames(refusal)))).toEqual([]);

    // The candidate was asked exactly once (for `/api/info`); the Location was
    // never followed, so the redirect target received nothing at all.
    expect(candidate.requests.map((request) => request.url)).toEqual([
      `${candidate.baseUrl}/api/info`,
    ]);
    expect(redirectTarget.requests).toHaveLength(0);
  });

  it("returns redirect_refused through the real adoption path and leaks no credential", async () => {
    const redirectTarget = startFixture(() => Response.json({ stolen: true }));
    const candidate = startFixture(() => redirectTo(redirectTarget.baseUrl));
    const registration = writeRegistration({
      url: `${candidate.baseUrl}/`,
      pid: process.pid,
      password: ADOPTED_PASSWORD,
      version: "2.0.15",
    });

    const logs = captureLogs();
    let outcome: Awaited<ReturnType<typeof attemptOpenCodeAdoption>>;
    try {
      outcome = await attemptOpenCodeAdoption({ path: registration });
    } finally {
      logs.restore();
    }

    // R1: the adoption outcome names the refusal, and the attempt installed
    // nothing. A generic `probe_failed` would hide which decision was taken.
    expect(outcome).toEqual({ status: "refused", reason: "redirect_refused" });
    expect(readConnectionState().target.mode).toBe("unresolved");

    // The probe went to A once, with its credential; B was never contacted.
    expect(candidate.requests).toHaveLength(1);
    expect(candidate.requests[0]?.url).toBe(`${candidate.baseUrl}/api/info`);
    expect(candidate.requests[0]?.authorization).toBe(ADOPTED_AUTHORIZATION);
    expect(redirectTarget.requests).toHaveLength(0);

    // The negative claim is only meaningful if the capture saw the run.
    expect(logs.lines.length).toBeGreaterThan(0);
    expect(logs.lines.some((line) => line.includes("opencode.adoption_refused"))).toBe(true);
    expect(secretsIn(logs.lines.join("\n"))).toEqual([]);
    expect(logs.lines.join("\n")).not.toContain("/steal");
  });
});

describe("R2 — the native client refuses a redirect on an adopted server", () => {
  it("throws with the refusal as its cause and the redirect target receives nothing", async () => {
    const redirectTarget = startFixture(() => Response.json({ stolen: true }));
    const adopted = startFixture(() => redirectTo(redirectTarget.baseUrl));

    const clientModuleUrl = pathToFileURL(
      path.join(REPO_ROOT, "src/services/opencode/client.ts"),
    ).href;
    const connectionStateModuleUrl = pathToFileURL(
      path.join(REPO_ROOT, "src/services/opencode/connectionState.ts"),
    ).href;
    // A fresh process, so no module mock from another suite can replace the
    // real `@opencode/client` this case exists to exercise.
    const script = `
      const { createOpenCodeClient } = await import(${JSON.stringify(clientModuleUrl)});
      const state = await import(${JSON.stringify(connectionStateModuleUrl)});
      const origin = ${JSON.stringify(adopted.baseUrl)};
      const attempt = state.beginAttempt("startup");
      state.installAdoptedTarget({ origin, password: ${JSON.stringify(ADOPTED_PASSWORD)}, attempt });
      const context = state.captureOpenCodeRequestContext();
      const client = createOpenCodeClient(context.baseUrl, { transport: context.transport });
      try {
        await client.server.info();
        console.log("RESULT:" + JSON.stringify({ threw: false }));
      } catch (error) {
        const cause = error && typeof error === "object" ? error.cause : null;
        console.log("RESULT:" + JSON.stringify({
          threw: true,
          name: error && error.name ? error.name : null,
          causeCode: cause && cause.code ? cause.code : null,
          causeName: cause && cause.name ? cause.name : null,
          message: error && error.message ? String(error.message) : "",
        }));
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "ignore",
    });
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(exitCode).toBe(0);
    const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("RESULT:"));
    expect(line).toBeDefined();
    const result = JSON.parse(line!.slice("RESULT:".length)) as {
      threw: boolean;
      name: string | null;
      causeCode: string | null;
      causeName: string | null;
      message: string;
    };

    expect(result.threw).toBe(true);
    // The official client wraps any transport failure in its own `ClientError`,
    // exactly as the plan's p5 probe recorded; the refusal is retained as the
    // CAUSE, and it is the refusal — not a followed redirect — that ended it.
    expect(result.causeCode).toBe("OPENCODE_REDIRECT_REFUSED");
    expect(result.causeName).toBe("OpenCodeRedirectRefusedError");
    expect(result.message).not.toContain(ADOPTED_PASSWORD);
    expect(result.message).not.toContain(ADOPTED_BASE64);

    expect(adopted.requests).toHaveLength(1);
    expect(adopted.requests[0]?.url).toBe(`${adopted.baseUrl}/api/info`);
    expect(adopted.requests[0]?.authorization).toBe(ADOPTED_AUTHORIZATION);
    expect(redirectTarget.requests).toHaveLength(0);
  });
});

describe("R3 — the configuration read refuses a redirect", () => {
  it("targets the captured origin and credential, refuses the 3xx, and reaches nothing else", async () => {
    const redirectTarget = startFixture(() => Response.json({ stolen: true }));
    const candidate = startFixture(() => redirectTo(redirectTarget.baseUrl));

    installAdoptedTarget({ origin: candidate.baseUrl, password: ADOPTED_PASSWORD });
    const context = captureOpenCodeRequestContext();

    await expect(
      readOpenCodeConfigDocument({ baseUrl: context.baseUrl, transport: context.transport }),
    ).rejects.toBeInstanceOf(OpenCodeRedirectRefusedError);

    expect(candidate.requests).toHaveLength(1);
    expect(candidate.requests[0]?.url).toBe(`${candidate.baseUrl}/api/config`);
    expect(candidate.requests[0]?.authorization).toBe(ADOPTED_AUTHORIZATION);
    expect(redirectTarget.requests).toHaveLength(0);
  });
});

describe("R4 — the configuration write path owns no HTTP operation", () => {
  // R4 is often mistaken for "a config-write request must refuse a redirect".
  // There is no such request to test, and today there is no write at all: the
  // policy refuses every managed write before the read (§9.3(1)). These cases
  // pin the shape of the source — the writer has no HTTP primitive — and the
  // behaviour that the refusal precedes every request.
  const routeSource = stripComments(
    readFileSync(path.join(REPO_ROOT, "src/routes/opencode.ts"), "utf8"),
  );
  const documentSource = stripComments(
    readFileSync(path.join(REPO_ROOT, "src/services/opencode/configDocument.ts"), "utf8"),
  );

  it("reads through the inherited transport and writes to disk, never over HTTP", () => {
    // Sliced by declaration boundary rather than by brace matching: this
    // function's RETURN TYPE is an object literal, so a brace walk would stop
    // at the type and prove nothing about the body.
    const apply = sectionOf(
      routeSource,
      "async function applyPermissionChange(",
      'app.get("/config"',
    );
    // The gate precedes the read; the read precedes the write. The write path
    // is unreachable while the policy refuses, but its shape must stay honest
    // for the day a proven root makes it reachable.
    expect(apply.indexOf("assertOpenCodeConfigWriteAllowed(")).toBeLessThan(
      apply.indexOf("readOpenCodeConfigDocument("),
    );
    // Exactly one upstream request, and it is the read CT1–CT4 govern.
    expect(apply.split("readOpenCodeConfigDocument(").length - 1).toBe(1);
    expect(apply).toContain("writeOpenCodeConfigDocument(");
    expect(apply.indexOf("readOpenCodeConfigDocument(")).toBeLessThan(
      apply.indexOf("writeOpenCodeConfigDocument("),
    );
    // The write path builds no request of its own.
    expect(apply).not.toContain("fetch(");
    expect(apply).not.toContain(".transport(");
    expect(apply).not.toContain("new URL(");

    // The writer itself commits to disk and has no HTTP primitive at all.
    const writer = sectionOf(
      documentSource,
      "export async function writeOpenCodeConfigDocument(",
      documentSource.length,
    );
    expect(writer).toContain("Bun.write(");
    expect(writer).not.toContain("fetch(");
    expect(writer).not.toContain(".transport(");
    expect(writer).not.toContain("new URL(");
  });

  it("refuses before any request and commits no file", async () => {
    const redirectTarget = startFixture(() => Response.json({ stolen: true }));
    const service = startFixture(() => redirectTo(redirectTarget.baseUrl));
    // A real installed managed target: no manager double, and no managed child
    // is ever started because the resolver returns an installed target.
    installManagedTarget({ baseUrl: service.baseUrl, password: R4_MANAGED_PASSWORD });

    const originalWrite = Bun.write;
    let writeCount = 0;
    try {
      Bun.write = (async (destination, input, options) => {
        writeCount += 1;
        return originalWrite(destination, input, options);
      }) as typeof Bun.write;

      const response = await openCodeApp.request("http://localhost/config/permissions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer browser-controlled-secret",
        },
        body: JSON.stringify({ action: "question", resource: "*", effect: "ask" }),
      });

      expect(response.status).toBe(409);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({
        error: expect.stringContaining("user's own"),
      });
      expect(body).not.toContain(R4_MANAGED_PASSWORD);
      expect(body).not.toContain(R4_MANAGED_BASE64);
      // The Location names the redirect target; it must never be reported.
      expect(body).not.toContain("/steal");
    } finally {
      Bun.write = originalWrite;
    }

    // No file was written anywhere, because the policy refused before any
    // document path was discovered.
    expect(writeCount).toBe(0);

    // And no request was made at all: the refusal precedes target resolution,
    // so the credential never leaves the process on this path.
    expect(service.requests).toHaveLength(0);
    expect(redirectTarget.requests).toHaveLength(0);
  });
});

describe("R5 — the proxy returns a typed 502 and never forwards the redirect", () => {
  it("answers with no Location header, cancels upstream, and does not contact the redirect target", async () => {
    const redirectTarget = startFixture(() => Response.json({ stolen: true }));
    const adopted = startFixture(() => redirectTo(redirectTarget.baseUrl));
    installAdoptedTarget({ origin: adopted.baseUrl, password: ADOPTED_PASSWORD });

    const response = await openCodeApp.request("http://localhost/api/opencode/info", {
      headers: { Authorization: "Bearer browser-controlled-secret" },
    });

    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("OpenCode refused a redirect");
    expect(JSON.stringify(body)).not.toContain(ADOPTED_PASSWORD);
    expect(JSON.stringify(body)).not.toContain(ADOPTED_BASE64);

    expect(adopted.requests).toHaveLength(1);
    expect(adopted.requests[0]?.url).toBe(`${adopted.baseUrl}/api/info`);
    // The transport injects the target's credential; the browser's header never
    // reaches the upstream.
    expect(adopted.requests[0]?.authorization).toBe(ADOPTED_AUTHORIZATION);
    expect(redirectTarget.requests).toHaveLength(0);
  });
});

describe("R6 — a same-origin redirect is refused too", () => {
  it("refuses a 307 that would replay the credential and body to the same origin", async () => {
    const candidate = startFixture((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/config") {
        return new Response(null, {
          status: 307,
          headers: { location: `${candidate.baseUrl}/redirected` },
        });
      }
      return Response.json({ replayed: true });
    });
    installAdoptedTarget({ origin: candidate.baseUrl, password: ADOPTED_PASSWORD });
    const context = captureOpenCodeRequestContext();

    await expect(
      readOpenCodeConfigDocument({ baseUrl: context.baseUrl, transport: context.transport }),
    ).rejects.toBeInstanceOf(OpenCodeRedirectRefusedError);

    // Exactly one request, to the address that answered 307. The replay target
    // on the SAME origin was never contacted.
    expect(candidate.requests.map((request) => request.url)).toEqual([
      `${candidate.baseUrl}/api/config`,
    ]);
  });
});

describe("R9 / R10 — no credential and no raw Location escapes", () => {
  it("keeps the password, its Base64, and the Location out of errors, logs and responses", async () => {
    const redirectTarget = startFixture(() => Response.json({ stolen: true }));
    const adopted = startFixture(() => redirectTo(redirectTarget.baseUrl));
    const sinceSeq = logger.lastSeq;
    const messages: string[] = [];
    const bodies: string[] = [];

    installAdoptedTarget({ origin: adopted.baseUrl, password: ADOPTED_PASSWORD });
    const context = captureOpenCodeRequestContext();

    // R3 path.
    try {
      await readOpenCodeConfigDocument({ baseUrl: context.baseUrl, transport: context.transport });
    } catch (error) {
      messages.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
    // R5 path.
    const proxy = await openCodeApp.request("http://localhost/api/opencode/info");
    bodies.push(await proxy.text());

    expect(messages.length).toBeGreaterThan(0);
    const logText = JSON.stringify(logger.getRecentEntries(sinceSeq));
    const combined = [...messages, ...bodies, logText].join("\n");

    expect(combined).not.toContain(ADOPTED_PASSWORD);
    expect(combined).not.toContain(ADOPTED_BASE64);
    expect(combined).not.toContain(MANAGED_PASSWORD);
    expect(combined).not.toContain(
      Buffer.from(`${OPENCODE_CONFIG.authUsername}:${MANAGED_PASSWORD}`).toString("base64"),
    );
    // The Location's own path never becomes a URL we request or log.
    expect(combined).not.toContain("/steal");
    expect(redirectTarget.requests).toHaveLength(0);
  });
});

describe("R11 — the route uses the shared transport and owns no redirect policy", () => {
  const source = stripComments(
    readFileSync(path.join(REPO_ROOT, "src/routes/opencode.ts"), "utf8"),
  );

  it("contains no redirect: literal", () => {
    // Property-literal `redirect:` — prose and the `proxy.redirect_refused`
    // event name do not match this pattern.
    expect(source).not.toMatch(/\bredirect\s*:/);
  });

  it("has no raw fetch and forwards through the resolved target's transport", () => {
    expect(source).not.toContain("globalThis.fetch");
    expect(source).not.toContain("fetch(");
    expect(source).toContain("target.transport(");
    expect(source).toContain("resolveOpenCodeRuntimeTarget");
  });

  it("sends the upstream request through a transport that injects the credential", async () => {
    // The spy is the wire: server A receives exactly one request carrying the
    // target's Basic header and the browser's Authorization is absent. A route
    // that built its own headers or its own fetch could not produce this.
    const adopted = startFixture(() => Response.json({ fixture: "proxy" }));
    installAdoptedTarget({ origin: adopted.baseUrl, password: ADOPTED_PASSWORD });
    const response = await openCodeApp.request("http://localhost/api/opencode/info", {
      headers: { Authorization: "Bearer browser-controlled-secret" },
    });

    expect(response.status).toBe(200);
    expect(adopted.requests).toHaveLength(1);
    expect(adopted.requests[0]?.authorization).toBe(ADOPTED_AUTHORIZATION);
    expect(passwordOf(adopted.requests[0])).toBe(ADOPTED_PASSWORD);
  });
});
