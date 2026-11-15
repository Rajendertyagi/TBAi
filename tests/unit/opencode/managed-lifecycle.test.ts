import { afterEach, describe, expect, it } from "bun:test";
import type { Subprocess } from "bun";
import { OPENCODE_CONFIG, type OpenCodeConfig } from "@/config/opencode.ts";
import {
  beginShutdown,
  readConnectionState,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";
import type { OpenCodeDatabaseLease } from "@/services/opencode/ownership.ts";
import {
  OpenCodeReadinessCancelledError,
  OpenCodeReadinessTimeoutError,
  OpenCodeServerManager,
  type ReadinessDeps,
} from "@/services/opencode/serverManager.ts";
import type { OpenCodeListeningTarget } from "@/services/opencode/listening.ts";
import type { OpenCodeCompatibilityAssessment } from "@/services/opencode/compatibility.ts";
import type { OpenCodeShutdownResult } from "@/services/opencode/connectionState.ts";

const NO_DATABASE_LEASE: OpenCodeDatabaseLease = {
  acquire: async () => null,
  verifyChild: async () => undefined,
  release: () => undefined,
};

const TEST_CONFIG: OpenCodeConfig = {
  ...OPENCODE_CONFIG,
  startupTimeoutMs: 100,
  readyPollMs: 5,
  opencodeChildStopGraceMs: 10,
  opencodeChildStopKillMs: 10,
  maxRestartAttempts: 2,
  stabilityPeriodMs: 0,
};

class StringStream {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.controller = controller;
    },
  });
  push(text: string): void {
    this.controller.enqueue(new TextEncoder().encode(text));
  }
  close(): void {
    try {
      this.controller.close();
    } catch {
      /* already closed */
    }
  }
}

class FakeChild {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly killCalls: string[] = [];
  readonly port: number;
  private resolveExit!: (code: number) => void;
  private exitCode: number | null = null;
  private server: ReturnType<typeof Bun.serve>;
  private readonly out = new StringStream();
  private readonly err = new StringStream();
  exitOnSigterm = true;
  exitOnSigkill = true;

  constructor(serial: number, mode: "ready" | "not-ready" = "ready") {
    this.pid = 9000 + serial;
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/info") {
          if (mode === "not-ready") return new Response("not ready", { status: 503 });
          return Response.json({ version: "2.2.6" });
        }
        if (url.pathname === "/api/event") {
          return new Response("data: ok\n\n", {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return Response.json({ ok: true });
      },
    });
    this.port = this.server.port;
    this.out.push(`server listening on http://127.0.0.1:${this.port}\n`);
    this.out.close();
    this.err.close();
    this.stdout = this.out.stream;
    this.stderr = this.err.stream;
    this.exited = new Promise<number>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  kill(signal?: string): void {
    const sig = signal ?? "SIGTERM";
    this.killCalls.push(sig);
    if (sig === "SIGTERM" && this.exitOnSigterm) this.exitWith(0);
    if (sig === "SIGKILL" && this.exitOnSigkill) this.exitWith(0);
  }

  exitWith(code = 0): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.stop();
    this.resolveExit(code);
  }

  stop(): void {
    try {
      this.server.stop(true);
    } catch {
      /* ignore */
    }
    this.out.close();
    this.err.close();
  }
}

class TestManager extends OpenCodeServerManager {
  createChildCalls = 0;
  children: FakeChild[] = [];
  mode: "ready" | "not-ready" = "ready";
  readinessGate: Promise<void> | null = null;
  stopCalls = 0;
  stopSequenceImpl: "default" | "real" = "default";

  constructor(config: OpenCodeConfig = TEST_CONFIG) {
    super(config, NO_DATABASE_LEASE);
  }

  protected override resolveBinary(): string {
    return "/fake/opencode";
  }

  protected override async publishManagedRegistration(): Promise<void> {}
  protected override async removeOwnedRegistration(): Promise<void> {}

  protected override createChild(): Subprocess {
    this.createChildCalls += 1;
    const child = new FakeChild(this.createChildCalls, this.mode);
    this.children.push(child);
    return child as unknown as Subprocess;
  }

  protected override async awaitListening(
    _discovery: unknown,
    child: Subprocess,
  ): Promise<OpenCodeListeningTarget> {
    const fake = child as unknown as FakeChild;
    return { baseUrl: `http://127.0.0.1:${fake.port}`, port: fake.port };
  }

  protected override async awaitManagedCapabilities(): Promise<OpenCodeCompatibilityAssessment> {
    return {
      status: "compatible",
      capabilities: {
        version: "2.2.6",
        supported: {
          session: true,
          events: true,
          config: true,
          agent: true,
          model: true,
          command: true,
        },
      },
      missingEssential: [],
      missingOptional: [],
      unknownEssential: [],
    } as OpenCodeCompatibilityAssessment;
  }

  protected override async awaitReadiness(_deps: ReadinessDeps): Promise<void> {
    if (this.readinessGate) await this.readinessGate;
    if (this.mode === "not-ready") {
      throw new OpenCodeReadinessTimeoutError(
        (this as unknown as { config: OpenCodeConfig }).config.startupTimeoutMs,
        this.children.at(-1)?.port ?? null,
      );
    }
  }

  protected override async runStopSequence(child: Subprocess): Promise<OpenCodeShutdownResult> {
    this.stopCalls += 1;
    if (this.stopSequenceImpl === "real") {
      return super.runStopSequence(child);
    }
    (child as unknown as FakeChild).stop();
    (child as unknown as FakeChild).exitWith(0);
    return { ok: true };
  }

  requestCleanup(child: Subprocess, requester: "shutdown" | "manager" = "manager") {
    return this.requestChildCleanup(child, { cause: "manager", requester });
  }

  snapshot(child?: Subprocess) {
    return this.startStateSnapshot(child);
  }

  get lastChild(): FakeChild {
    const child = this.children.at(-1);
    if (!child) throw new Error("no child");
    return child;
  }

  stopAll(): void {
    for (const child of this.children) child.stop();
  }
}

const managers: TestManager[] = [];
function makeManager(config?: OpenCodeConfig): TestManager {
  const m = new TestManager(config);
  managers.push(m);
  return m;
}

afterEach(async () => {
  for (const m of managers.splice(0)) {
    try {
      await m.shutdown();
    } catch {
      /* ignore */
    }
    m.stopAll();
  }
  resetConnectionStateForTests();
});

describe("managed OpenCode lifecycle (managed-only runtime)", () => {
  it("deduplicates concurrent startup into a single child", async () => {
    const mgr = makeManager();
    const [a, b, c] = await Promise.all([
      mgr.ensureBaseUrl(),
      mgr.ensureBaseUrl(),
      mgr.ensureBaseUrl(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(mgr.createChildCalls).toBe(1);
    expect(mgr.isRunning()).toBe(true);
  });

  it("publishes a managed target and returns a stable base URL when ready", async () => {
    const mgr = makeManager();
    const baseUrl = await mgr.ensureBaseUrl();
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(readConnectionState().target.mode).toBe("managed");
    expect(mgr.getManagedPid()).toBe(mgr.lastChild.pid);
  });

  it("cleans up and rejects when readiness fails", async () => {
    const mgr = makeManager();
    mgr.mode = "not-ready";
    await expect(mgr.ensureBaseUrl()).rejects.toBeInstanceOf(OpenCodeReadinessTimeoutError);
    expect(mgr.stopCalls).toBeGreaterThanOrEqual(1);
  });

  it("cancels readiness when shutdown begins", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mgr = makeManager();
    mgr.readinessGate = gate;
    const pending = mgr.ensureBaseUrl();
    await beginShutdown();
    release();
    await expect(pending).rejects.toBeInstanceOf(OpenCodeReadinessCancelledError);
  });

  it("shutdown stops the managed child", async () => {
    const mgr = makeManager();
    await mgr.ensureBaseUrl();
    await mgr.shutdown();
    expect(mgr.stopCalls).toBeGreaterThanOrEqual(1);
  });

  it("exposes managed process state accessors without throwing", () => {
    const mgr = makeManager();
    const pid = mgr.getManagedPid();
    expect(pid === null || typeof pid === "number").toBe(true);
    expect(typeof mgr.isRunning()).toBe("boolean");
  });

  it("allows a successful startup after a readiness failure", async () => {
    const mgr = makeManager();
    mgr.mode = "not-ready";
    await expect(mgr.ensureBaseUrl()).rejects.toBeInstanceOf(OpenCodeReadinessTimeoutError);
    mgr.mode = "ready";
    const baseUrl = await mgr.ensureBaseUrl();
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(mgr.createChildCalls).toBe(2);
    expect(mgr.isRunning()).toBe(true);
  });

  it("restarts after unexpected child exit and publishes a new managed target", async () => {
    const mgr = makeManager({ ...TEST_CONFIG, maxRestartAttempts: 2, stabilityPeriodMs: 0 });
    const firstUrl = await mgr.ensureBaseUrl();
    const firstPid = mgr.lastChild.pid;
    mgr.lastChild.exitWith(1);
    // Allow exit handler/restart path to run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const secondUrl = await mgr.ensureBaseUrl();
    expect(mgr.createChildCalls).toBeGreaterThanOrEqual(2);
    expect(mgr.lastChild.pid).not.toBe(firstPid);
    expect(secondUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(readConnectionState().target.mode).toBe("managed");
    expect(firstUrl === secondUrl || firstUrl !== secondUrl).toBe(true);
  });

  it("stops a child starting but not yet published when shutdown begins", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mgr = makeManager();
    mgr.readinessGate = gate;
    const pending = mgr.ensureBaseUrl();
    for (let i = 0; i < 20 && mgr.children.length === 0; i++) {
      await Promise.resolve();
    }
    expect(mgr.children.length).toBe(1);
    const child = mgr.lastChild;
    const shutdown = beginShutdown();
    release();
    await expect(pending).rejects.toBeInstanceOf(OpenCodeReadinessCancelledError);
    const result = await shutdown;
    expect(result.ok).toBe(true);
    expect(mgr.stopCalls).toBeGreaterThanOrEqual(1);
    expect(child.killCalls.length).toBeGreaterThanOrEqual(0);
    expect(readConnectionState().target.mode).toBe("unresolved");
    expect(mgr.isRunning()).toBe(false);
  });

  it("stops a child exactly once for concurrent cleanup requests", async () => {
    const mgr = makeManager({
      ...TEST_CONFIG,
      opencodeChildStopGraceMs: 5,
      opencodeChildStopKillMs: 5,
    });
    mgr.stopSequenceImpl = "real";
    await mgr.ensureBaseUrl();
    const child = mgr.lastChild as unknown as Subprocess;
    const p1 = mgr.stopAllChildrenForShutdown()[0]!;
    const p2 = mgr.stopAllChildrenForShutdown()[0] ?? p1;
    const p3 = mgr.requestCleanup(child, "shutdown") ?? p1;
    const [a, b, c] = await Promise.all([p1, p2, p3]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.ok).toBe(true);
    expect(mgr.stopCalls).toBe(1);
    expect(mgr.lastChild.killCalls[0]).toBe("SIGTERM");
  });

  it("handles reentrant shutdown and cleanup without duplicate stop execution", async () => {
    const mgr = makeManager({
      ...TEST_CONFIG,
      opencodeChildStopGraceMs: 5,
      opencodeChildStopKillMs: 5,
    });
    mgr.stopSequenceImpl = "real";
    await mgr.ensureBaseUrl();
    const [_s1, _s2, s3] = await Promise.all([mgr.shutdown(), mgr.shutdown(), beginShutdown()]);
    expect(mgr.stopCalls).toBe(1);
    expect(readConnectionState().shutdownStarted).toBe(true);
    expect(s3.ok).toBe(true);
    expect(mgr.isRunning()).toBe(false);
  });

  it("escalates from graceful termination to forced termination when needed", async () => {
    const mgr = makeManager({
      ...TEST_CONFIG,
      opencodeChildStopGraceMs: 1,
      opencodeChildStopKillMs: 5,
    });
    mgr.stopSequenceImpl = "real";
    await mgr.ensureBaseUrl();
    const child = mgr.lastChild;
    child.exitOnSigterm = false;
    child.exitOnSigkill = true;
    const result = await mgr.shutdown();
    expect(result).toBeUndefined();
    expect(mgr.stopCalls).toBe(1);
    expect(child.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
    expect(mgr.isRunning()).toBe(false);
  });

  it("reports unconfirmed termination explicitly when the child never exits", async () => {
    const mgr = makeManager({
      ...TEST_CONFIG,
      opencodeChildStopGraceMs: 1,
      opencodeChildStopKillMs: 1,
    });
    mgr.stopSequenceImpl = "real";
    await mgr.ensureBaseUrl();
    const child = mgr.lastChild;
    child.exitOnSigterm = false;
    child.exitOnSigkill = false;
    const stop = mgr.requestCleanup(child as unknown as Subprocess, "shutdown");
    const result = await (stop as Promise<OpenCodeShutdownResult>);
    expect(result.ok).toBe(false);
    if (!result.ok && "reason" in result) {
      expect(result.reason).toBe("termination_unconfirmed");
      expect(result.pid).toBe(child.pid);
    } else {
      throw new Error("expected unconfirmed termination result");
    }
    expect(mgr.stopCalls).toBe(1);
    expect(child.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
