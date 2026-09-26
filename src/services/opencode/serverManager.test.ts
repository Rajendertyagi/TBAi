import { describe, it, expect } from "bun:test";
import type { Subprocess } from "bun";
import {
  buildOpenCodeServeArgs,
  stripOpenCodeProxyPrefix,
  allocateLoopbackPort,
  probeOpenCodeInfo,
  waitForHttpReady,
  appendTail,
  OpenCodeProcessExitedError,
  OpenCodeReadinessTimeoutError,
  OpenCodeReadinessCancelledError,
  OpenCodeServerManager,
} from "./serverManager";
import { OPENCODE_CONFIG, type OpenCodeConfig } from "../../config/opencode";
import { getOpenCodeAuthHeaders, isSupportedOpenCodeVersion } from "./runtime";

const SUPPORTED_VERSION = "2.0.15";
const CURRENT_SUPPORTED_VERSION = "2.0.16";
const UNSUPPORTED_VERSION = "2.0.14";
const UPPER_BOUND_VERSION = "2.1.0";
const FIXTURE_PASSWORD = "opencode-readiness-fixture-password";
const FIXTURE_AUTHORIZATION = `Basic ${Buffer.from(
  `${OPENCODE_CONFIG.authUsername}:${FIXTURE_PASSWORD}`,
).toString("base64")}`;
const AUTHENTICATED_READINESS = {
  authHeaders: { Authorization: FIXTURE_AUTHORIZATION },
  isSupportedVersion: isSupportedOpenCodeVersion,
} as const;
const FAKE_MANAGED_BINARY = "/fake/opencode-v2";

describe("buildOpenCodeServeArgs", () => {
  it("builds the argv for a given port", () => {
    expect(buildOpenCodeServeArgs(4173)).toEqual([
      OPENCODE_CONFIG.binaryName,
      "serve",
      "--port",
      "4173",
    ]);
  });

  it("uses an explicit managed binary when provided", () => {
    expect(buildOpenCodeServeArgs(4173, FAKE_MANAGED_BINARY)).toEqual([
      FAKE_MANAGED_BINARY,
      "serve",
      "--port",
      "4173",
    ]);
  });

  it("handles edge ports (0 and max)", () => {
    expect(buildOpenCodeServeArgs(0)).toEqual([
      OPENCODE_CONFIG.binaryName,
      "serve",
      "--port",
      "0",
    ]);
    expect(buildOpenCodeServeArgs(65535)[3]).toBe("65535");
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

describe("allocateLoopbackPort", () => {
  it("returns a valid TCP port number", () => {
    const port = allocateLoopbackPort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
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
  return allocateLoopbackPort();
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

  it("accepts a 2.0.16 server info response within the approved range", async () => {
    const fixture = startInfoFixture(() =>
      Response.json({ version: CURRENT_SUPPORTED_VERSION }),
    );

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
    const fixture = startInfoFixture(
      () => new Response("unauthorized", { status: 401 }),
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

  it("reports not ready for an unsupported version", async () => {
    const fixture = startInfoFixture(
      () => Response.json({ version: UNSUPPORTED_VERSION }),
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

  it("reports not ready at the 2.1.0 upper bound", async () => {
    const fixture = startInfoFixture(
      () => Response.json({ version: UPPER_BOUND_VERSION }),
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
});

describe("waitForHttpReady", () => {
  const neverExits = new Promise<number>(() => {});

  it("resolves once the server is reachable", async () => {
    const port = allocateLoopbackPort();
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
    const port = allocateLoopbackPort();
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
    const port = allocateLoopbackPort();
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

/** A ReadableStream that delivers the given chunks then closes. */
function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** A controllable fake child: real HTTP server (ready) or none (never ready). */
class FakeChild {
  public readonly pid: number;
  public readonly exited: Promise<number>;
  public readonly stdout: ReadableStream<Uint8Array>;
  public readonly stderr: ReadableStream<Uint8Array>;
  public readonly killCalls: string[] = [];
  private resolveExit!: (code: number) => void;
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(
    port: number,
    mode: "ready" | "never",
    stdoutChunks: string[],
    stderrChunks: string[],
    serial: number,
    expectedAuthorization: string,
  ) {
    this.pid = 4000 + serial;
    if (mode === "ready") {
      this.server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch(request) {
          if (new URL(request.url).pathname !== OPENCODE_CONFIG.readinessProbePath) {
            return new Response("not found", { status: 404 });
          }
          if (request.headers.get("authorization") !== expectedAuthorization) {
            return new Response("unauthorized", { status: 401 });
          }
          return Response.json({ version: SUPPORTED_VERSION });
        },
      });
    }
    this.exited = new Promise<number>((resolve) => {
      this.resolveExit = resolve;
    });
    this.stdout = streamFrom(stdoutChunks);
    this.stderr = streamFrom(stderrChunks);
  }

  exitWith(code: number): void {
    this.resolveExit(code);
  }

  stop(): void {
    this.server?.stop(true);
  }

  kill(signal: string): void {
    this.killCalls.push(signal);
  }
}

/** Test double: spawns a controllable fake child instead of the opencode binary. */
class FakeOpenCodeServerManager extends OpenCodeServerManager {
  public createChildCalls = 0;
  public children: FakeChild[] = [];
  public serveMode: "ready" | "never" = "ready";
  public stdoutChunks: string[] = [];
  public stderrChunks: string[] = [];
  public lastBinaryPath: string | null = null;
  public lastDiagnostics: { stdout: string; stderr: string } | undefined;
  private readonly testConfig: OpenCodeConfig;

  constructor(config: OpenCodeConfig = OPENCODE_CONFIG) {
    super(config);
    this.testConfig = config;
  }

  protected resolveBinary(): string {
    return FAKE_MANAGED_BINARY;
  }

  protected createChild(
    port: number,
    binaryPath: string = FAKE_MANAGED_BINARY,
  ): Subprocess {
    this.createChildCalls += 1;
    this.lastBinaryPath = binaryPath;
    const child = new FakeChild(
      port,
      this.serveMode,
      this.stdoutChunks,
      this.stderrChunks,
      this.createChildCalls,
      getOpenCodeAuthHeaders(this.testConfig).Authorization,
    );
    this.children.push(child);
    return child as unknown as Subprocess;
  }

  protected diagnosticsFor(
    child: Subprocess,
  ): { stdout: string; stderr: string } | undefined {
    const d = super.diagnosticsFor(child);
    this.lastDiagnostics = d;
    return d;
  }

  get lastChild(): FakeChild {
    const child = this.children[this.children.length - 1];
    if (!child) throw new Error("no child spawned");
    return child;
  }

  exitLastChild(code: number): void {
    this.lastChild.exitWith(code);
  }

  stopFake(): void {
    for (const child of this.children) child.stop();
  }
}

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
    const mgr = new FakeOpenCodeServerManager();
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
    const mgr = new FakeOpenCodeServerManager();
    try {
      const baseUrl = await mgr.ensureBaseUrl();
      expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const response = await fetch(
        `${baseUrl}${OPENCODE_CONFIG.readinessProbePath}`,
        { headers: getOpenCodeAuthHeaders() },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ version: SUPPORTED_VERSION });
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

describe("OpenCodeServerManager lifecycle", () => {
  it("kills the child on readiness timeout (no orphan)", async () => {
    const mgr = new FakeOpenCodeServerManager({
      ...OPENCODE_CONFIG,
      startupTimeoutMs: 100,
      readyPollMs: 5,
    });
    mgr.serveMode = "never";
    await expect(mgr.ensureBaseUrl()).rejects.toBeInstanceOf(
      OpenCodeReadinessTimeoutError,
    );
    expect(mgr.lastChild.killCalls).toContain("SIGKILL");
    expect(mgr.createChildCalls).toBe(1);
    mgr.stopFake();
  });

  it("restarts exactly once when the child exits during readiness (no duplicate children)", async () => {
    const mgr = new FakeOpenCodeServerManager({
      ...OPENCODE_CONFIG,
      maxRestartAttempts: 3,
      startupTimeoutMs: 5000,
      readyPollMs: 5,
    });
    mgr.serveMode = "never";
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
    const mgr = new FakeOpenCodeServerManager({
      ...OPENCODE_CONFIG,
      maxRestartAttempts: 2,
      startupTimeoutMs: 5000,
      readyPollMs: 5,
    });
    mgr.serveMode = "never";
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
    const mgr = new FakeOpenCodeServerManager({
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
    const mgr = new FakeOpenCodeServerManager({
      ...OPENCODE_CONFIG,
      shutdownTimeoutMs: 30,
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
    const mgr = new FakeOpenCodeServerManager({
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
