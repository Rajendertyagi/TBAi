import { describe, it, expect, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import {
  buildOpenCodeServeArgs,
  stripOpenCodeProxyPrefix,
  probeOpenCodeInfo,
  waitForHttpReady,
  appendTail,
  OpenCodeProcessExitedError,
  OpenCodeReadinessTimeoutError,
  OpenCodeReadinessCancelledError,
  OpenCodeListeningTimeoutError,
  OpenCodeServerManager,
} from "@/services/opencode/serverManager.ts";
import { OPENCODE_CONFIG, type OpenCodeConfig } from "@/config/opencode.ts";
import { getOpenCodeAuthHeaders, isSupportedOpenCodeVersion } from "@/services/opencode/runtime.ts";
import {
  OpenCodeCapabilityRefusedError,
  OPENCODE_CAPABILITY_PROBES,
} from "@/services/opencode/compatibility.ts";
import {
  OpenCodeDatabaseBusyError,
  type OpenCodeDatabaseLease,
} from "@/services/opencode/ownership.ts";
import { OpenCodeListeningMissingError } from "@/services/opencode/listening.ts";
import { allocateTestLoopbackPort } from "../../harness/opencodeRuntimeHarness";

const SUPPORTED_VERSION = "2.0.15";
const CURRENT_SUPPORTED_VERSION = "2.2.0";
const UNSUPPORTED_VERSION = "2.0.14";
/** A stable release newer than the old ceiling; B7 admits it. */
const NEWER_STABLE_VERSION = "2.2.1";
/** D2: a prerelease is refused even inside the numeric range. */
const PRERELEASE_VERSION = "2.2.1-beta.1";
const FIXTURE_PASSWORD = "opencode-readiness-fixture-password";
const FIXTURE_AUTHORIZATION = `Basic ${Buffer.from(
  `${OPENCODE_CONFIG.authUsername}:${FIXTURE_PASSWORD}`,
).toString("base64")}`;
const AUTHENTICATED_READINESS = {
  authHeaders: { Authorization: FIXTURE_AUTHORIZATION },
  isSupportedVersion: isSupportedOpenCodeVersion,
} as const;
const FAKE_MANAGED_BINARY = "/fake/opencode-v2";

/** No database ownership in the fake-child suite; the real policy is tested separately. */
const NO_DATABASE_LEASE: OpenCodeDatabaseLease = {
  acquire: async () => null,
  verifyChild: async () => undefined,
  release: () => undefined,
};

describe("buildOpenCodeServeArgs", () => {
  it("asks the kernel for a port and binds loopback only", () => {
    // `--port 0` removes the allocate-then-release race: the child binds the
    // port and announces it. `--hostname 127.0.0.1` keeps the server off every
    // non-loopback interface.
    expect(buildOpenCodeServeArgs()).toEqual([
      OPENCODE_CONFIG.binaryName,
      "serve",
      "--port",
      "0",
      "--hostname",
      "127.0.0.1",
    ]);
  });

  it("uses an explicit managed binary when provided", () => {
    expect(buildOpenCodeServeArgs(FAKE_MANAGED_BINARY)).toEqual([
      FAKE_MANAGED_BINARY,
      "serve",
      "--port",
      "0",
      "--hostname",
      "127.0.0.1",
    ]);
  });

  it("wraps .cmd launchers with cmd /c on Windows", () => {
    if (process.platform !== "win32") return;
    expect(buildOpenCodeServeArgs("opencode.cmd")).toEqual([
      "cmd",
      "/c",
      "opencode.cmd",
      "serve",
      "--port",
      "0",
      "--hostname",
      "127.0.0.1",
    ]);
    // Paths with spaces are preserved as a single argument.
    expect(buildOpenCodeServeArgs("C:\\path with spaces\\opencode.cmd")).toEqual([
      "cmd",
      "/c",
      "C:\\path with spaces\\opencode.cmd",
      "serve",
      "--port",
      "0",
      "--hostname",
      "127.0.0.1",
    ]);
    // Non-.cmd binaries are not wrapped.
    expect(buildOpenCodeServeArgs("opencode.exe")).toEqual([
      "opencode.exe",
      "serve",
      "--port",
      "0",
      "--hostname",
      "127.0.0.1",
    ]);
  });

  it("derives both values from the injected config", () => {
    const config = {
      ...OPENCODE_CONFIG,
      kernelAssignedPort: "0",
      managedBindHostname: "127.0.0.1",
    };
    expect(buildOpenCodeServeArgs(FAKE_MANAGED_BINARY, config)).toEqual([
      FAKE_MANAGED_BINARY,
      "serve",
      "--port",
      "0",
      "--hostname",
      "127.0.0.1",
    ]);
  });
});

describe("stripOpenCodeProxyPrefix", () => {
  it("strips the prefix and normalizes the root to /", () => {
    expect(stripOpenCodeProxyPrefix("/api/opencode")).toBe("/");
    expect(stripOpenCodeProxyPrefix("/api/opencode/session")).toBe("/session");
  });

  it("leaves non-prefixed paths untouched", () => {
    expect(stripOpenCodeProxyPrefix("/session")).toBe("/session");
    expect(stripOpenCodeProxyPrefix("/api/other/x")).toBe("/api/other/x");
  });
});

type InfoFixture = {
  readonly baseUrl: string;
  readonly requests: Array<{ authorization: string | null; method: string; pathname: string }>;
  readonly stop: () => void;
};

/** Starts a deterministic OpenCode `/api/info` fixture and captures its requests. */
function startInfoFixture(
  respond: (request: Request) => Response | Promise<Response>,
  port = 0,
): InfoFixture {
  const requests: InfoFixture["requests"] = [];
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request) {
      requests.push({
        authorization: request.headers.get("authorization"),
        method: request.method,
        pathname: new URL(request.url).pathname,
      });
      return respond(request);
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

/** Starts a valid authenticated V2 readiness fixture on the requested port. */
function listenOn(port: number): () => void {
  const fixture = startInfoFixture((request) => {
    if (new URL(request.url).pathname !== OPENCODE_CONFIG.readinessProbePath) {
      return new Response("not found", { status: 404 });
    }
    if (request.headers.get("authorization") !== FIXTURE_AUTHORIZATION) {
      return new Response("unauthorized", { status: 401 });
    }
    return Response.json({ version: SUPPORTED_VERSION });
  }, port);
  return fixture.stop;
}

/** A port that is allocated then released, so nothing is listening on it. */
function freePort(): number {
  return allocateTestLoopbackPort();
}

describe("probeOpenCodeInfo", () => {
  it("reports ready only for an authenticated supported `/api/info` response", async () => {
    const fixture = startInfoFixture((request) => {
      if (request.headers.get("authorization") !== FIXTURE_AUTHORIZATION) {
        return new Response("unauthorized", { status: 401 });
      }
      return Response.json({ version: SUPPORTED_VERSION });
    });

    try {
      const outcome = await probeOpenCodeInfo(
        fixture.baseUrl,
        OPENCODE_CONFIG.readinessProbePath,
        1_000,
        AUTHENTICATED_READINESS.authHeaders,
        AUTHENTICATED_READINESS.isSupportedVersion,
      );

      expect(outcome).toBe("ready");
      expect(fixture.requests).toEqual([
        {
          authorization: FIXTURE_AUTHORIZATION,
          method: "GET",
          pathname: "/api/info",
        },
      ]);
    } finally {
      fixture.stop();
    }
  });

  it("accepts a 2.2.0 server info response within the approved range", async () => {
    const fixture = startInfoFixture(() => Response.json({ version: CURRENT_SUPPORTED_VERSION }));

    try {
      const outcome = await probeOpenCodeInfo(
        fixture.baseUrl,
        OPENCODE_CONFIG.readinessProbePath,
        1_000,
        AUTHENTICATED_READINESS.authHeaders,
        AUTHENTICATED_READINESS.isSupportedVersion,
      );

      expect(outcome).toBe("ready");
      expect(fixture.requests).toEqual([
        {
          authorization: FIXTURE_AUTHORIZATION,
          method: "GET",
          pathname: "/api/info",
        },
      ]);
    } finally {
      fixture.stop();
    }
  });

  it("reports not ready on HTTP 401", async () => {
    const fixture = startInfoFixture(() => new Response("unauthorized", { status: 401 }));

    try {
      const outcome = await probeOpenCodeInfo(
        fixture.baseUrl,
        OPENCODE_CONFIG.readinessProbePath,
        1_000,
        AUTHENTICATED_READINESS.authHeaders,
        AUTHENTICATED_READINESS.isSupportedVersion,
      );
      expect(outcome).toBe("not_ready");
    } finally {
      fixture.stop();
    }
  });

  it("reports not ready when the supplied Basic credentials are wrong", async () => {
    const fixture = startInfoFixture((request) =>
      request.headers.get("authorization") === FIXTURE_AUTHORIZATION
        ? Response.json({ version: SUPPORTED_VERSION })
        : new Response("unauthorized", { status: 401 }),
    );

    try {
      const outcome = await probeOpenCodeInfo(
        fixture.baseUrl,
        OPENCODE_CONFIG.readinessProbePath,
        1_000,
        { Authorization: "Basic deliberately-wrong" },
        AUTHENTICATED_READINESS.isSupportedVersion,
      );
      expect(outcome).toBe("not_ready");
    } finally {
      fixture.stop();
    }
  });

  it("reports not ready for malformed JSON", async () => {
    const fixture = startInfoFixture(
      () =>
        new Response("{not-json", {
          headers: { "content-type": "application/json" },
        }),
    );

    try {
      const outcome = await probeOpenCodeInfo(
        fixture.baseUrl,
        OPENCODE_CONFIG.readinessProbePath,
        1_000,
        AUTHENTICATED_READINESS.authHeaders,
        AUTHENTICATED_READINESS.isSupportedVersion,
      );
      expect(outcome).toBe("not_ready");
    } finally {
      fixture.stop();
    }
  });

  it("reports not ready for an HTML 200 (the web app, not the API)", async () => {
    // Measured on a real 2.1.4 server: `/global/health`, `/doc`, `/config` and
    // `/readyz` all answer "200 text/html" with the SPA shell, even without the
    // Basic credential. A status-only readiness check would therefore accept a
    // server that will never answer an API call. Readiness requires the JSON
    // `/api/info` shape, so an HTML 200 must classify as not_ready.
    const fixture = startInfoFixture(
      () =>
        new Response("<!doctype html><html><title>OpenCode</title></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );

    try {
      const outcome = await probeOpenCodeInfo(
        fixture.baseUrl,
        OPENCODE_CONFIG.readinessProbePath,
        1_000,
        AUTHENTICATED_READINESS.authHeaders,
        AUTHENTICATED_READINESS.isSupportedVersion,
      );
      expect(outcome).toBe("not_ready");
    } finally {
      fixture.stop();
    }
  });

  it("reports not ready for an unsupported version", async () => {
    const fixture = startInfoFixture(() => Response.json({ version: UNSUPPORTED_VERSION }));

    try {
      const outcome = await probeOpenCodeInfo(
        fixture.baseUrl,
        OPENCODE_CONFIG.readinessProbePath,
        1_000,
        AUTHENTICATED_READINESS.authHeaders,
        AUTHENTICATED_READINESS.isSupportedVersion,
      );
      expect(outcome).toBe("not_ready");
    } finally {
      fixture.stop();
    }
  });

  it("reports ready for a stable release newer than any measured build (B7: no ceiling)", async () => {
    // There is no upper bound: a newer stable build is admitted by version and
    // must then prove its essential routes on the live service (`compatibility.ts`).
    const fixture = startInfoFixture(() => Response.json({ version: NEWER_STABLE_VERSION }));

    try {
      const outcome = await probeOpenCodeInfo(
        fixture.baseUrl,
        OPENCODE_CONFIG.readinessProbePath,
        1_000,
        AUTHENTICATED_READINESS.authHeaders,
        AUTHENTICATED_READINESS.isSupportedVersion,
      );
      expect(outcome).toBe("ready");
    } finally {
      fixture.stop();
    }
  });

  it("reports not ready for a prerelease build (D2: stable releases only)", async () => {
    const fixture = startInfoFixture(() => Response.json({ version: PRERELEASE_VERSION }));

    try {
      const outcome = await probeOpenCodeInfo(
        fixture.baseUrl,
        OPENCODE_CONFIG.readinessProbePath,
        1_000,
        AUTHENTICATED_READINESS.authHeaders,
        AUTHENTICATED_READINESS.isSupportedVersion,
      );
      expect(outcome).toBe("not_ready");
    } finally {
      fixture.stop();
    }
  });
});

describe("waitForHttpReady", () => {
  const neverExits = new Promise<number>(() => {});

  it("resolves once the server is reachable", async () => {
    const port = allocateTestLoopbackPort();
    const stop = listenOn(port);
    try {
      await expect(
        waitForHttpReady({
          baseUrl: `http://127.0.0.1:${port}`,
          port,
          probePath: OPENCODE_CONFIG.readinessProbePath,
          ...AUTHENTICATED_READINESS,
          timeoutMs: 2000,
          pollMs: 5,
          getStopping: () => false,
          exited: neverExits,
        }),
      ).resolves.toBeUndefined();
    } finally {
      stop();
    }
  });

  it("throws OpenCodeReadinessTimeoutError when never listening", async () => {
    const port = freePort();
    await expect(
      waitForHttpReady({
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        probePath: OPENCODE_CONFIG.readinessProbePath,
        ...AUTHENTICATED_READINESS,
        timeoutMs: 120,
        pollMs: 5,
        getStopping: () => false,
        exited: neverExits,
      }),
    ).rejects.toBeInstanceOf(OpenCodeReadinessTimeoutError);
  });

  it("throws OpenCodeProcessExitedError when the process exits first", async () => {
    const port = freePort();
    await expect(
      waitForHttpReady({
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        probePath: OPENCODE_CONFIG.readinessProbePath,
        ...AUTHENTICATED_READINESS,
        timeoutMs: 5000,
        pollMs: 5,
        getStopping: () => false,
        exited: Promise.resolve(1),
      }),
    ).rejects.toBeInstanceOf(OpenCodeProcessExitedError);
  });

  it("throws OpenCodeReadinessCancelledError when shutting down", async () => {
    const port = freePort();
    await expect(
      waitForHttpReady({
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        probePath: OPENCODE_CONFIG.readinessProbePath,
        ...AUTHENTICATED_READINESS,
        timeoutMs: 5000,
        pollMs: 5,
        getStopping: () => true,
        exited: neverExits,
      }),
    ).rejects.toBeInstanceOf(OpenCodeReadinessCancelledError);
  });

  it("resolves after the server comes up mid-wait", async () => {
    const port = allocateTestLoopbackPort();
    let stop: () => void = () => {};
    const timer = setTimeout(() => {
      stop = listenOn(port);
    }, 40);
    try {
      await expect(
        waitForHttpReady({
          baseUrl: `http://127.0.0.1:${port}`,
          port,
          probePath: OPENCODE_CONFIG.readinessProbePath,
          ...AUTHENTICATED_READINESS,
          timeoutMs: 2000,
          pollMs: 5,
          getStopping: () => false,
          exited: neverExits,
        }),
      ).resolves.toBeUndefined();
    } finally {
      clearTimeout(timer);
      stop();
    }
  });

  it("resolves when a probe is slower than the poll interval", async () => {
    // During cold start a probe can take longer than `pollMs` to answer. The
    // loop must pace itself with the poll interval yet never *add* that delay
    // on top of a slow probe — otherwise readiness would lag behind the server
    // by one interval per attempt. Here the first probe is deliberately slower
    // than `pollMs`; readiness must still resolve as soon as it answers.
    const port = allocateTestLoopbackPort();
    let first = true;
    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        if (request.headers.get("authorization") !== FIXTURE_AUTHORIZATION) {
          return new Response("unauthorized", { status: 401 });
        }
        if (first) {
          first = false;
          await new Promise((r) => setTimeout(r, OPENCODE_CONFIG.readyPollMs + 50));
        }
        return Response.json({ version: SUPPORTED_VERSION });
      },
    });
    try {
      const startedMs = Date.now();
      await expect(
        waitForHttpReady({
          baseUrl: `http://127.0.0.1:${port}`,
          port,
          probePath: OPENCODE_CONFIG.readinessProbePath,
          ...AUTHENTICATED_READINESS,
          timeoutMs: 2000,
          pollMs: OPENCODE_CONFIG.readyPollMs,
          getStopping: () => false,
          exited: neverExits,
        }),
      ).resolves.toBeUndefined();
      // Bounded by the slow probe itself, not by probe + a second interval.
      expect(Date.now() - startedMs).toBeLessThan(OPENCODE_CONFIG.readyPollMs * 2);
    } finally {
      server.stop(true);
    }
  });

  it("paces the loop: a fast negative probe does not spin", async () => {
    // A refused connection answers in well under a millisecond. Without pacing
    // the loop re-probes immediately and fires thousands of attempts per
    // second, which burns CPU and exhausts the logger's per-scope budget (so
    // the readiness outcome itself never reaches the log). Each attempt must
    // therefore cost at least `pollMs`.
    const port = freePort();
    const pollMs = 20;
    const startedMs = Date.now();
    await expect(
      waitForHttpReady({
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        probePath: OPENCODE_CONFIG.readinessProbePath,
        ...AUTHENTICATED_READINESS,
        timeoutMs: 200,
        pollMs,
        getStopping: () => false,
        exited: neverExits,
      }),
    ).rejects.toBeInstanceOf(OpenCodeReadinessTimeoutError);
    // ~10 attempts fit in 200ms at 20ms each; a spinning loop would finish in
    // a couple of milliseconds.
    expect(Date.now() - startedMs).toBeGreaterThanOrEqual(pollMs * 5);
  });
});

/** A pipe the fake child controls; `stalled` starts keep it open on purpose. */
class StringStream {
  readonly stream: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private readonly encoder = new TextEncoder();
  private closed = false;

  constructor() {
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
  }

  push(text: string): void {
    if (this.closed) return;
    this.controller.enqueue(this.encoder.encode(text));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * How one fake child behaves during startup.
 *
 * - `ready`       binds a loopback server, announces its kernel-assigned port,
 *                 and answers readiness plus the capability routes;
 * - `not-ready`   announces and binds, but `/api/info` never becomes ready;
 * - `stalled`     stays alive without announcing anything (listening timeout);
 * - `missing`     its output ends without an announcement.
 */
type FakeStartupMode = "ready" | "not-ready" | "stalled" | "missing";

/** Which capability routes the `ready` fake actually serves. */
type FakeCapabilityMode = "all" | "missing-session" | "missing-command";

const SESSION_ROUTE = "/api/session";
const COMMAND_ROUTE = "/api/command";
const CAPABILITY_ROUTES = new Set(OPENCODE_CAPABILITY_PROBES.map((probe) => probe.path));
const EVENT_ROUTE =
  OPENCODE_CAPABILITY_PROBES.find((probe) => probe.expectsEventStream)?.path ?? "/api/event";

interface FakeChildOptions {
  readonly mode: FakeStartupMode;
  readonly capabilities: FakeCapabilityMode;
  readonly readinessVersion: string;
  readonly stdoutChunks: readonly string[];
  readonly stderrChunks: readonly string[];
  readonly serial: number;
  readonly expectedAuthorization: string;
}

/**
 * A controllable fake child.
 *
 * A `ready`/`not-ready` child binds its own ephemeral port and announces it on
 * stdout exactly as the real binary does, which is what the manager now reads.
 * The announcement is built after the bind, so the fake proves the production
 * path follows the child's address instead of a pre-allocated one.
 */
class FakeChild {
  public readonly pid: number;
  public readonly exited: Promise<number>;
  public readonly stdout: ReadableStream<Uint8Array>;
  public readonly stderr: ReadableStream<Uint8Array>;
  /** Every pathname requested of this child, in order. */
  public readonly requests: string[] = [];
  public readonly killCalls: string[] = [];
  /** The port the child bound, or null when it has no server. */
  public readonly port: number | null;
  private readonly outflux = new StringStream();
  private readonly errflux = new StringStream();
  private resolveExit!: (code: number) => void;
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(options: FakeChildOptions) {
    this.pid = 4000 + options.serial;
    if (options.mode === "ready" || options.mode === "not-ready") {
      this.server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => this.handle(request, options),
      });
      this.port = this.server.port ?? null;
    } else {
      this.port = null;
    }

    for (const chunk of options.stdoutChunks) this.outflux.push(chunk);
    if (this.port !== null) {
      this.outflux.push(`server listening on http://127.0.0.1:${this.port}\n`);
    }
    for (const chunk of options.stderrChunks) this.errflux.push(chunk);
    // `stalled` keeps stdout open so the start fails on the timeout rather than
    // on an end-of-output that would be a different defect.
    if (options.mode !== "stalled") {
      this.outflux.close();
      this.errflux.close();
    }

    this.stdout = this.outflux.stream;
    this.stderr = this.errflux.stream;
    this.exited = new Promise<number>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  exitWith(code: number): void {
    this.resolveExit(code);
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
    this.outflux.close();
    this.errflux.close();
  }

  kill(signal: string): void {
    this.killCalls.push(signal);
    // A real SIGKILL terminates the child, which resolves `exited`. The fake
    // must do the same or production code that waits for the exit after a kill
    // would hang for the whole shutdown budget.
    if (signal === "SIGKILL") {
      this.stop();
      this.exitWith(1);
    }
  }

  private handle(request: Request, options: FakeChildOptions): Response {
    const pathname = new URL(request.url).pathname;
    this.requests.push(pathname);
    if (request.headers.get("authorization") !== options.expectedAuthorization) {
      return new Response("unauthorized", { status: 401 });
    }
    if (pathname === OPENCODE_CONFIG.readinessProbePath) {
      return options.mode === "not-ready"
        ? new Response("starting", { status: 503 })
        : Response.json({ version: options.readinessVersion });
    }
    if (pathname === SESSION_ROUTE && options.capabilities === "missing-session") {
      return new Response("not found", { status: 404 });
    }
    if (pathname === COMMAND_ROUTE && options.capabilities === "missing-command") {
      return new Response("not found", { status: 404 });
    }
    if (pathname === EVENT_ROUTE) {
      return new Response("event: ping\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (CAPABILITY_ROUTES.has(pathname)) return Response.json({});
    return new Response("not found", { status: 404 });
  }
}

/** Test double: spawns a controllable fake child instead of the opencode binary. */
class FakeOpenCodeServerManager extends OpenCodeServerManager {
  public createChildCalls = 0;
  public children: FakeChild[] = [];
  public mode: FakeStartupMode = "ready";
  public capabilities: FakeCapabilityMode = "all";
  public readinessVersion = SUPPORTED_VERSION;
  public stdoutChunks: string[] = [];
  public stderrChunks: string[] = [];
  public lastBinaryPath: string | null = null;
  public lastDiagnostics: { stdout: string; stderr: string } | undefined;
  private readonly testConfig: OpenCodeConfig;

  constructor(
    config: OpenCodeConfig = OPENCODE_CONFIG,
    lease: OpenCodeDatabaseLease = NO_DATABASE_LEASE,
  ) {
    super(config, lease);
    this.testConfig = config;
  }

  protected resolveBinary(): string {
    return FAKE_MANAGED_BINARY;
  }

  protected createChild(binaryPath: string = FAKE_MANAGED_BINARY): Subprocess {
    this.createChildCalls += 1;
    this.lastBinaryPath = binaryPath;
    const child = new FakeChild({
      mode: this.mode,
      capabilities: this.capabilities,
      readinessVersion: this.readinessVersion,
      stdoutChunks: this.stdoutChunks,
      stderrChunks: this.stderrChunks,
      serial: this.createChildCalls,
      expectedAuthorization: getOpenCodeAuthHeaders(this.testConfig).Authorization,
    });
    this.children.push(child);
    return child as unknown as Subprocess;
  }

  protected diagnosticsFor(child: Subprocess): { stdout: string; stderr: string } | undefined {
    const d = super.diagnosticsFor(child);
    this.lastDiagnostics = d;
    return d;
  }

  get lastChild(): FakeChild {
    const child = this.children[this.children.length - 1];
    if (!child) throw new Error("no child spawned");
    return child;
  }

  /** The bounded tails the manager retained for the newest child. */
  readDiagnostics(): { stdout: string; stderr: string } | undefined {
    const child = this.children[this.children.length - 1];
    return child === undefined ? undefined : this.diagnosticsFor(child as unknown as Subprocess);
  }

  exitLastChild(code: number): void {
    this.lastChild.exitWith(code);
  }

  stopFake(): void {
    for (const child of this.children) child.stop();
  }
}

/**
 * Every fake manager built by a test, torn down unconditionally afterwards.
 *
 * These managers run a REAL readiness loop: `waitForHttpReady` polls
 * `probeOpenCodeInfo` over the genuine `globalThis.fetch` until
 * `startupTimeoutMs` elapses (5s at `readyPollMs: 5` in the never-serves
 * cases — up to a thousand live fetches). Cleanup used to be `stopFake()` as
 * the last line of each test body, so a FAILING assertion skipped it and the
 * loop kept polling for the rest of the process. Because this file sorts before
 * `web/src/features/opencode/sessionBootstrap.test.ts`, that leaked poll landed
 * on an unrelated test's `fetch` stub and made it look like a product race.
 *
 * Registering the manager makes teardown independent of the assertions passing.
 * The explicit `stopFake()` calls are left in place: they are idempotent, and
 * they keep each test readable on its own.
 */
const liveManagers = new Set<FakeOpenCodeServerManager>();

function newFakeManager(
  config?: OpenCodeConfig,
  lease?: OpenCodeDatabaseLease,
): FakeOpenCodeServerManager {
  const manager = new FakeOpenCodeServerManager(config, lease);
  liveManagers.add(manager);
  return manager;
}

afterEach(() => {
  for (const manager of liveManagers) manager.stopFake();
  liveManagers.clear();
});

/** Polls until `condition` holds or the timeout elapses. */
async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

describe("OpenCodeServerManager.ensureBaseUrl", () => {
  it("deduplicates concurrent startups into a single server", async () => {
    const mgr = newFakeManager();
    try {
      const results = await Promise.all([
        mgr.ensureBaseUrl(),
        mgr.ensureBaseUrl(),
        mgr.ensureBaseUrl(),
      ]);
      expect(new Set(results).size).toBe(1);
      expect(mgr.createChildCalls).toBe(1);
      expect(mgr.lastBinaryPath).toBe(FAKE_MANAGED_BINARY);
    } finally {
      mgr.stopFake();
    }
  });

  it("returns a base URL only after authenticated `/api/info` reports V2", async () => {
    const mgr = newFakeManager();
    try {
      const baseUrl = await mgr.ensureBaseUrl();
      expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const response = await fetch(`${baseUrl}${OPENCODE_CONFIG.readinessProbePath}`, {
        headers: getOpenCodeAuthHeaders(),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ version: SUPPORTED_VERSION });
    } finally {
      mgr.stopFake();
    }
  });

  it("does not cache a database-lease refusal: the next attempt retries", async () => {
    let attempts = 0;
    const lease: OpenCodeDatabaseLease = {
      acquire: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new OpenCodeDatabaseBusyError({
            dbPath: "C:\\tmp\\opencode.db",
            pids: [4242],
            reason: "a process already holds the database",
          });
        }
        return null;
      },
      verifyChild: async () => undefined,
      release: () => undefined,
    };
    const mgr = newFakeManager(OPENCODE_CONFIG, lease);
    try {
      await expect(mgr.ensureBaseUrl()).rejects.toBeInstanceOf(OpenCodeDatabaseBusyError);
      const baseUrl = await mgr.ensureBaseUrl();
      expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(attempts).toBe(2);
      expect(mgr.createChildCalls).toBe(1);
    } finally {
      mgr.stopFake();
    }
  });
});

describe("appendTail", () => {
  it("keeps the last maxBytes of accumulated output", () => {
    expect(appendTail("", "abcdef", 4)).toBe("cdef");
  });

  it("keeps everything when under the budget", () => {
    expect(appendTail("ab", "cd", 10)).toBe("abcd");
  });

  it("handles a chunk larger than the budget", () => {
    expect(appendTail("ab", "cdefghij", 4)).toBe("ghij");
  });
});

describe("OpenCodeServerManager managed startup", () => {
  it("uses the kernel-assigned port the child itself announced", async () => {
    // `--port 0` plus the child's own announcement is the fix for the
    // allocate-then-release race: the manager must use this child's address,
    // never a number it picked before the spawn.
    const mgr = newFakeManager();
    try {
      const baseUrl = await mgr.ensureBaseUrl();
      expect(mgr.lastChild.port).not.toBeNull();
      expect(baseUrl).toBe(`http://127.0.0.1:${mgr.lastChild.port}`);
    } finally {
      mgr.stopFake();
    }
  });

  it("redacts a server-generated password from retained diagnostics", async () => {
    const secret = "tbai-secret-that-must-not-be-retained";
    const mgr = newFakeManager();
    mgr.stdoutChunks = [`server password ${secret}\n`];
    try {
      await mgr.ensureBaseUrl();
      await until(
        () => mgr.readDiagnostics()?.stdout.includes("server password [redacted]") ?? false,
      );
      const stdout = mgr.readDiagnostics()?.stdout ?? "";
      expect(stdout).toContain("server password [redacted]");
      expect(stdout).not.toContain(secret);
    } finally {
      mgr.stopFake();
    }
  });

  it("refuses a build that does not serve an essential capability", async () => {
    const mgr = newFakeManager({
      ...OPENCODE_CONFIG,
      opencodeChildStopGraceMs: 10,
      opencodeChildStopKillMs: 10,
    });
    mgr.capabilities = "missing-session";
    try {
      let failure: unknown;
      try {
        await mgr.ensureBaseUrl();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(OpenCodeCapabilityRefusedError);
      expect((failure as OpenCodeCapabilityRefusedError).missingEssential).toEqual(["session"]);
      await until(() => mgr.lastChild.killCalls.includes("SIGKILL"));
    } finally {
      mgr.stopFake();
    }
  });

  it("starts when only an optional capability route is absent", async () => {
    const mgr = newFakeManager();
    mgr.capabilities = "missing-command";
    try {
      const baseUrl = await mgr.ensureBaseUrl();
      expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // The routes were actually probed on the child, not inferred from a number.
      expect(mgr.lastChild.requests).toContain("/api/session");
      expect(mgr.lastChild.requests).toContain("/api/event");
      expect(mgr.lastChild.requests).toContain("/api/command");
    } finally {
      mgr.stopFake();
    }
  });
});

describe("OpenCodeServerManager lifecycle", () => {
  it("kills the child on readiness timeout (no orphan)", async () => {
    const mgr = newFakeManager({
      ...OPENCODE_CONFIG,
      startupTimeoutMs: 100,
      readyPollMs: 5,
      opencodeChildStopGraceMs: 10,
      opencodeChildStopKillMs: 10,
    });
    // The child announces and binds but never answers readiness.
    mgr.mode = "not-ready";
    await expect(mgr.ensureBaseUrl()).rejects.toBeInstanceOf(OpenCodeReadinessTimeoutError);
    await until(() => mgr.lastChild.killCalls.includes("SIGKILL"));
    expect(mgr.lastChild.killCalls).toContain("SIGKILL");
    expect(mgr.createChildCalls).toBe(1);
    mgr.stopFake();
  });

  it("kills the child when it never announces a listening URL", async () => {
    const mgr = newFakeManager({
      ...OPENCODE_CONFIG,
      startupTimeoutMs: 120,
      readyPollMs: 5,
      opencodeChildStopGraceMs: 10,
      opencodeChildStopKillMs: 10,
    });
    mgr.mode = "stalled";
    await expect(mgr.ensureBaseUrl()).rejects.toBeInstanceOf(OpenCodeListeningTimeoutError);
    await until(() => mgr.lastChild.killCalls.includes("SIGKILL"));
    expect(mgr.createChildCalls).toBe(1);
    mgr.stopFake();
  });

  it("fails when the child's output ends without an announcement", async () => {
    const mgr = newFakeManager({
      ...OPENCODE_CONFIG,
      startupTimeoutMs: 5_000,
      readyPollMs: 5,
      opencodeChildStopGraceMs: 10,
      opencodeChildStopKillMs: 10,
    });
    mgr.mode = "missing";
    await expect(mgr.ensureBaseUrl()).rejects.toBeInstanceOf(OpenCodeListeningMissingError);
    await until(() => mgr.lastChild.killCalls.includes("SIGKILL"));
    expect(mgr.createChildCalls).toBe(1);
    mgr.stopFake();
  });

  it("restarts exactly once when the child exits during readiness (no duplicate children)", async () => {
    const mgr = newFakeManager({
      ...OPENCODE_CONFIG,
      maxRestartAttempts: 3,
      startupTimeoutMs: 5000,
      readyPollMs: 5,
      opencodeChildStopGraceMs: 10,
      opencodeChildStopKillMs: 10,
    });
    mgr.mode = "stalled";
    const p = mgr.ensureBaseUrl();
    await Bun.sleep(20);
    mgr.exitLastChild(58);
    await expect(p).rejects.toBeInstanceOf(OpenCodeProcessExitedError);
    await until(() => mgr.createChildCalls === 2);
    expect(mgr.createChildCalls).toBe(2);
    mgr.exitLastChild(58);
    await until(() => mgr.createChildCalls === 3);
    expect(mgr.createChildCalls).toBe(3);
    mgr.stopFake();
  });

  it("stops restarting after maxRestartAttempts consecutive failures", async () => {
    const mgr = newFakeManager({
      ...OPENCODE_CONFIG,
      maxRestartAttempts: 2,
      startupTimeoutMs: 5000,
      readyPollMs: 5,
      opencodeChildStopGraceMs: 10,
      opencodeChildStopKillMs: 10,
    });
    mgr.mode = "stalled";
    const p = mgr.ensureBaseUrl();
    await Bun.sleep(20);
    mgr.exitLastChild(58);
    await expect(p).rejects.toBeInstanceOf(OpenCodeProcessExitedError);
    await until(() => mgr.createChildCalls === 2);
    mgr.exitLastChild(58);
    await until(() => mgr.createChildCalls === 3);
    mgr.exitLastChild(58);
    await until(() => mgr.createChildCalls === 3);
    await Bun.sleep(30);
    expect(mgr.createChildCalls).toBe(3);
    mgr.stopFake();
  });

  it("resets the restart budget after a successful restart", async () => {
    const mgr = newFakeManager({
      ...OPENCODE_CONFIG,
      maxRestartAttempts: 1,
    });
    await mgr.ensureBaseUrl();
    expect(mgr.createChildCalls).toBe(1);
    mgr.exitLastChild(58);
    await until(() => mgr.createChildCalls === 2);
    await mgr.ensureBaseUrl();
    mgr.exitLastChild(58);
    await until(() => mgr.createChildCalls === 3);
    await mgr.ensureBaseUrl();
    expect(mgr.createChildCalls).toBe(3);
    mgr.stopFake();
  });

  it("shutdown sends SIGTERM then SIGKILL and suppresses restart", async () => {
    const mgr = newFakeManager({
      ...OPENCODE_CONFIG,
      opencodeChildStopGraceMs: 30,
      opencodeChildStopKillMs: 30,
    });
    await mgr.ensureBaseUrl();
    await mgr.shutdown();
    expect(mgr.lastChild.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
    mgr.exitLastChild(58);
    await Bun.sleep(20);
    expect(mgr.createChildCalls).toBe(1);
    await expect(mgr.ensureBaseUrl()).rejects.toThrow("shutting down");
    mgr.stopFake();
  });

  it("retains a bounded stdout/stderr tail for exit diagnostics", async () => {
    const mgr = newFakeManager({
      ...OPENCODE_CONFIG,
      maxRestartAttempts: 1,
    });
    mgr.stdoutChunks = ["boot: starting\n", "boot: ready\n"];
    mgr.stderrChunks = ["warn: config fallback\n"];
    await mgr.ensureBaseUrl();
    mgr.exitLastChild(58);
    await until(() => mgr.createChildCalls === 2);
    expect(mgr.lastDiagnostics?.stdout).toContain("boot: ready");
    expect(mgr.lastDiagnostics?.stderr).toContain("warn: config fallback");
    mgr.stopFake();
  });
});
