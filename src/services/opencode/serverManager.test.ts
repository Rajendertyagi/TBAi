import { describe, it, expect } from "bun:test";
import type { Subprocess } from "bun";
import {
  buildOpenCodeServeArgs,
  stripOpenCodeProxyPrefix,
  allocateLoopbackPort,
  probeOnce,
  waitForHttpReady,
  appendTail,
  OpenCodeProcessExitedError,
  OpenCodeReadinessTimeoutError,
  OpenCodeReadinessCancelledError,
  OpenCodeServerManager,
} from "./serverManager";
import { OPENCODE_CONFIG } from "../../config/opencode";

describe("buildOpenCodeServeArgs", () => {
  it("builds the argv for a given port", () => {
    expect(buildOpenCodeServeArgs(4173)).toEqual([
      OPENCODE_CONFIG.binaryName,
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

/** Starts a trivial HTTP server on the given port; returns a stop function. */
function listenOn(port: number): () => void {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: () => new Response("ok"),
  });
  return () => server.stop(true);
}

/** A port that is allocated then released, so nothing is listening on it. */
function freePort(): number {
  return allocateLoopbackPort();
}

describe("probeOnce", () => {
  it("reports listening when the server responds with any status", async () => {
    const port = allocateLoopbackPort();
    const stop = listenOn(port);
    try {
      const outcome = await probeOnce(
        `http://127.0.0.1:${port}`,
        OPENCODE_CONFIG.readinessProbePath,
        OPENCODE_CONFIG.readyPollMs * 4,
      );
      expect(outcome).toBe("listening");
    } finally {
      stop();
    }
  });

  it("reports not_listening when nothing is on the port", async () => {
    const port = freePort();
    const outcome = await probeOnce(
      `http://127.0.0.1:${port}`,
      OPENCODE_CONFIG.readinessProbePath,
      OPENCODE_CONFIG.readyPollMs * 4,
    );
    expect(outcome).toBe("not_listening");
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
      fetch: async () => {
        if (first) {
          first = false;
          await new Promise((r) => setTimeout(r, OPENCODE_CONFIG.readyPollMs + 50));
        }
        return new Response("ok");
      },
    });
    try {
      const startedMs = Date.now();
      await expect(
        waitForHttpReady({
          baseUrl: `http://127.0.0.1:${port}`,
          port,
          probePath: OPENCODE_CONFIG.readinessProbePath,
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
  ) {
    this.pid = 4000 + serial;
    if (mode === "ready") {
      this.server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch: () => new Response("ok"),
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
  public lastDiagnostics: { stdout: string; stderr: string } | undefined;

  protected resolveBinary(): string | null {
    return "/fake/opencode";
  }

  protected createChild(port: number): Subprocess {
    this.createChildCalls += 1;
    const child = new FakeChild(
      port,
      this.serveMode,
      this.stdoutChunks,
      this.stderrChunks,
      this.createChildCalls,
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
    const results = await Promise.all([
      mgr.ensureBaseUrl(),
      mgr.ensureBaseUrl(),
      mgr.ensureBaseUrl(),
    ]);
    expect(new Set(results).size).toBe(1);
    expect(mgr.createChildCalls).toBe(1);
    mgr.stopFake();
  });

  it("returns a ready base URL that actually responds", async () => {
    const mgr = new FakeOpenCodeServerManager();
    const baseUrl = await mgr.ensureBaseUrl();
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${baseUrl}${OPENCODE_CONFIG.readinessProbePath}`, {
      method: "GET",
    });
    expect(res.status).toBeGreaterThan(0);
    mgr.stopFake();
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
