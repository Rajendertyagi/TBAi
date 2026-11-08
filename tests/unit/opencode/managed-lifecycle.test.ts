import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Subprocess } from "bun";
import { OPENCODE_CONFIG, type OpenCodeConfig } from "@/config/opencode.ts";
import { logger } from "@/lib/logger.ts";
import {
  OpenCodeAttemptSupersededError,
  beginAttempt,
  beginShutdown,
  installManagedTarget,
  isAttemptActive,
  readConnectionState,
  registerManagedChildStopProvider,
  resetConnectionStateForTests,
  type OpenCodeShutdownResult,
} from "@/services/opencode/connectionState.ts";
import type { OpenCodeDatabaseLease } from "@/services/opencode/ownership.ts";
import {
  OpenCodeReadinessCancelledError,
  OpenCodeServerManager,
  type ManagedCleanupCause,
  type ManagedCleanupRequester,
  type ManagedStartHandle,
  type ManagedStartSnapshot,
} from "@/services/opencode/serverManager.ts";
import type {
  OpenCodeCompatibilityAssessment,
  OpenCodeServiceCapabilities,
} from "@/services/opencode/compatibility.ts";
import type {
  OpenCodeListeningDiscovery,
  OpenCodeListeningTarget,
} from "@/services/opencode/listening.ts";

/**
 * AT12–AT17 — the managed-child ownership protocol (§3.4, §3.4.1).
 *
 * Every case drives the real `OpenCodeServerManager` with three deterministic
 * seams: `createChild` returns a fake `Subprocess` whose exit is delivered by
 * the test, `awaitReadiness` is a gate the test settles, and
 * `runStopSequence` records the escalation instead of signalling a process.
 * No real OpenCode binary, service, registration file, database or credential
 * is touched, and no unrelated process is signalled.
 *
 * AT14's literal `release:A → release:B` pair is not reachable as written, and
 * the difference is an ordering consequence, not an exception to the test:
 *
 * - §1.9.3.3 step 5 (E4) aborts the previous attempt when a newer one is
 *   created, and §3.4.1 releases that attempt's waiter synchronously in the
 *   abort listener. Two *distinct* attempts therefore cannot both be
 *   unreleased when a shared start settles: A is released at E4, before the
 *   start fails. The two-attempt case asserts A's release precedes settlement
 *   (with B still counted and the start still pending), then asserts AT14's
 *   settlement tail for B exactly — state, release, detach, cleanup, stop,
 *   delivery — and that both records are released at `cleanup:entered`.
 * - The ordering AT14 encodes *for settlement* is asserted literally by the
 *   second case, where two waiter records are live at failure: rejected state
 *   first, then every waiter released, then identity-guarded detachment, then
 *   one cleanup request, then the shared rejection last.
 *
 * AT14 Control 2 ("a newer start and child are installed before the old one
 * rejects") is reproduced through the one path that produces it: the old child
 * exits unexpectedly, `onExit` reserves the restart start, and only then does
 * the old start's readiness gate reject.
 */

const TEST_CONFIG: OpenCodeConfig = {
  ...OPENCODE_CONFIG,
  startupTimeoutMs: 100,
  readyPollMs: 5,
  opencodeChildStopGraceMs: 10,
  opencodeChildStopKillMs: 10,
  maxRestartAttempts: 3,
};

const NO_DATABASE_LEASE: OpenCodeDatabaseLease = {
  acquire: async () => null,
  verifyChild: async () => undefined,
  release: () => undefined,
};

const REPLACEMENT_PASSWORD = "managed-lifecycle-replacement-password";

const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function until(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(1);
  }
}

/** A fake child whose exit the test delivers explicitly. */
class FakeChild {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly killCalls: string[] = [];
  private resolveExit!: (code: number) => void;

  constructor(serial: number) {
    this.pid = 7000 + serial;
    this.exited = new Promise<number>((resolve) => {
      this.resolveExit = resolve;
    });
    this.stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    this.stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  }

  exitWith(code = 0): void {
    this.resolveExit(code);
  }

  kill(signal: string): void {
    this.killCalls.push(signal);
  }
}

type StopPlan =
  | "terminate"
  | "leave-alive"
  | "unconfirmed"
  | "throw"
  | "reject-async"
  | "production-bound";

class HarnessManager extends OpenCodeServerManager {
  readonly children: Subprocess[] = [];
  readonly fakes: FakeChild[] = [];
  readonly events: string[] = [];
  readonly stopCalls: Subprocess[] = [];
  readonly stopPlans: StopPlan[] = [];
  readonly stopSnapshots: ManagedStartSnapshot[] = [];
  readonly spawnReturns: ManagedStartSnapshot[] = [];
  readonly cleanupSnapshots: ManagedStartSnapshot[] = [];
  onSpawn: ((manager: HarnessManager) => void) | null = null;
  onCleanupEntered: ((manager: HarnessManager) => void) | null = null;
  onEvent: ((event: string, snapshot: ManagedStartSnapshot) => void) | null = null;
  /** RC16 point (1): runs synchronously inside the scheduled stop initiation. */
  onStopInitiation: ((manager: HarnessManager, child: Subprocess) => void) | null = null;
  /** RC16 point (2): runs immediately before the escalation's first signal. */
  onBeforeFirstSignal: ((manager: HarnessManager, child: Subprocess) => void) | null = null;
  failBinary = false;
  createChildCalls = 0;
  readinessCalls = 0;
  listeningCalls = 0;
  private nextAnnouncedPort = 8000;
  private readonly readinessResolvers: Array<() => void> = [];
  private readonly readinessRejecters: Array<(error: unknown) => void> = [];

  constructor() {
    super(TEST_CONFIG, NO_DATABASE_LEASE);
  }

  protected resolveBinary(): string {
    if (this.failBinary) throw new Error("managed binary missing");
    return "/fake/opencode";
  }

  protected createChild(): Subprocess {
    this.onSpawn?.(this);
    this.createChildCalls += 1;
    const child = new FakeChild(this.createChildCalls);
    const asSubprocess = child as unknown as Subprocess;
    this.fakes.push(child);
    this.children.push(asSubprocess);
    queueMicrotask(() => {
      this.spawnReturns.push(this.startStateSnapshot(asSubprocess));
    });
    return asSubprocess;
  }

  /**
   * The listening discovery is stdin/stdout behaviour, covered by its own
   * tests; this harness hands out a deterministic loopback target so the
   * ownership protocol can be driven without a pipe.
   */
  protected awaitListening(
    _discovery: OpenCodeListeningDiscovery,
    _child: Subprocess,
  ): Promise<OpenCodeListeningTarget> {
    this.listeningCalls += 1;
    this.nextAnnouncedPort += 1;
    const port = this.nextAnnouncedPort;
    return Promise.resolve({ baseUrl: `http://127.0.0.1:${port}`, port });
  }

  /** Capability probing needs a listening server; the ownership cases need none. */
  protected awaitManagedCapabilities(): Promise<OpenCodeCompatibilityAssessment> {
    const supported = {
      session: true,
      events: true,
      config: true,
      agent: true,
      model: true,
      command: true,
    } as const satisfies OpenCodeServiceCapabilities["supported"];
    return Promise.resolve({
      status: "compatible",
      capabilities: { version: TEST_CONFIG.minimumVersion, supported },
    });
  }

  protected awaitReadiness(): Promise<void> {
    this.readinessCalls += 1;
    return new Promise<void>((resolve, reject) => {
      this.readinessResolvers.push(resolve);
      this.readinessRejecters.push(reject);
    });
  }

  protected lifecycleEvent(event: string): void {
    this.events.push(event);
    this.onEvent?.(event, this.startStateSnapshot());
    if (event === "cleanup:entered") {
      this.cleanupSnapshots.push(this.startStateSnapshot());
      this.onCleanupEntered?.(this);
    }
  }

  protected async runStopSequence(child: Subprocess): Promise<OpenCodeShutdownResult> {
    // Point (1) of RC16: this call runs inside the scheduled callback of
    // `stopChild()`, after the promise is published. A re-entrant caller here
    // must join, not start a second escalation.
    this.onStopInitiation?.(this, child);
    const fake = child as unknown as FakeChild;
    const plan = this.stopPlans.shift() ?? "terminate";
    if (plan === "production-bound") {
      // The real two-phase escalation against a child whose exit never arrives:
      // the bound itself produces `termination_unconfirmed` (RC15's second run).
      return super.runStopSequence(child);
    }
    // Point (2) of RC16: immediately before the escalation's first signal.
    this.onBeforeFirstSignal?.(this, child);
    this.stopCalls.push(child);
    this.stopSnapshots.push(this.startStateSnapshot(child));
    this.events.push(`signal:${child.pid}`);
    if (plan === "throw") throw new Error("stop invocation threw");
    if (plan === "reject-async") {
      return Promise.reject(new Error("stop rejected asynchronously"));
    }
    if (plan === "unconfirmed") {
      return { ok: false, reason: "termination_unconfirmed", pid: fake.pid };
    }
    if (plan === "leave-alive") return { ok: true };
    fake.exitWith(0);
    await flush();
    return { ok: true };
  }

  snapshot(child?: Subprocess): ManagedStartSnapshot {
    return this.startStateSnapshot(child);
  }

  requestCleanup(
    child: Subprocess | null,
    cause: ManagedCleanupCause,
    requester: ManagedCleanupRequester,
  ): Promise<OpenCodeShutdownResult> | null {
    return this.requestChildCleanup(child, { cause, requester });
  }

  resolveReadiness(index = this.readinessResolvers.length - 1): void {
    this.readinessResolvers[index]?.();
  }

  rejectReadiness(error: unknown, index = this.readinessRejecters.length - 1): void {
    this.readinessRejecters[index]?.(error);
  }

  childAt(index: number): Subprocess {
    const child = this.children[index];
    if (child === undefined) throw new Error(`no child at index ${index}`);
    return child;
  }

  /** The deterministic fake behind a spawned child. */
  fakeAt(index: number): FakeChild {
    const fake = this.fakes[index];
    if (fake === undefined) throw new Error(`no fake at index ${index}`);
    return fake;
  }

  /** Waits for the nth spawn to reach its readiness gate, then opens it. */
  async openReadiness(childCount: number): Promise<void> {
    await until(
      () => this.createChildCalls === childCount && this.readinessCalls === childCount,
      `spawn ${childCount} and readiness gate`,
    );
    this.resolveReadiness();
  }
}

/**
 * RC15's third variant: the stop operation throws while it is EVALUATED, before
 * it can return a promise. The method is deliberately not `async`, so the throw
 * is synchronous and lands inside `stopChild()`'s scheduled `try`.
 */
class PreReturnThrowManager extends HarnessManager {
  protected runStopSequence(_child: Subprocess): Promise<OpenCodeShutdownResult> {
    throw new Error("stop threw before returning a promise");
  }
}

let registered: Array<() => void> = [];

function newManager(manager: HarnessManager = new HarnessManager()): HarnessManager {
  registered.push(registerManagedChildStopProvider(manager));
  return manager;
}

beforeEach(() => {
  resetConnectionStateForTests();
});

afterEach(() => {
  for (const unregister of registered) unregister();
  registered = [];
  resetConnectionStateForTests();
});

describe("AT12(a) — a published managed child is stopped exactly once", () => {
  it("stops it once and makes every later shutdown or cleanup request join", async () => {
    const manager = newManager();

    const pending = manager.ensureBaseUrl();
    await until(
      () => manager.createChildCalls === 1 && manager.readinessCalls === 1,
      "spawn and readiness gate",
    );
    const child = manager.childAt(0);
    manager.resolveReadiness();
    const baseUrl = await pending;
    const published = manager.snapshot();
    expect(baseUrl).toBe(`http://127.0.0.1:${published.port}`);
    expect(readConnectionState().target.mode).toBe("managed");

    const first = beginShutdown();
    const second = beginShutdown();
    expect(second).toBe(first);
    // The stop is published — and the child still tracked — before anything is
    // signalled. Once the child exits, its record is reaped, so this is the only
    // moment the published stop is observable through the child's record.
    expect(manager.snapshot(child).childHasStop).toBe(true);
    expect(manager.snapshot(child).liveChildren).toContain(child);
    expect(await first).toEqual({ ok: true });
    expect(manager.stopCalls).toHaveLength(1);
    expect(manager.stopCalls[0]).toBe(child);
    expect(manager.snapshot(child).liveChildren).not.toContain(child);

    // A readiness completion rejected after the stop was published requests
    // cleanup, finds the published promise and joins it.
    const joined = manager.requestCleanup(child, "start-failure", "manager");
    const duplicate = manager.requestCleanup(child, "attempt", "manager");
    expect(joined).not.toBeNull();
    expect(duplicate).toBe(joined);
    await joined;
    expect(manager.stopCalls).toHaveLength(1);
    // Every stop acted on a child this manager spawned.
    expect(manager.stopCalls.every((stopped) => manager.children.includes(stopped))).toBe(true);
    expect(manager.fakes.every((spawned) => spawned.killCalls.length === 0)).toBe(true);
  });
});

describe("AT3 — the shared start promise, by identity", () => {
  it("publishes one promise object that the record, the handle and every joiner share", async () => {
    const manager = newManager();

    const first = manager.acquireManagedStart();
    const atReserve = manager.snapshot();
    expect(atReserve.currentStartId).toBe(first.startId);
    // The manager's published promise IS the record's deferred and the handle's.
    expect(atReserve.readyPromise).toBe(first.promise);
    expect(atReserve.startRecords).toHaveLength(1);
    expect(atReserve.startRecords[0]?.startId).toBe(first.startId);
    expect(atReserve.startRecords[0]?.promise).toBe(first.promise);

    // A duplicate request joins the published start; it is not a second record
    // and not a wrapper promise, and nothing is spawned before the reservation.
    const duplicate = manager.acquireManagedStart();
    expect(duplicate.startId).toBe(first.startId);
    expect(duplicate.promise).toBe(first.promise);
    expect(manager.createChildCalls).toBe(0);
    const atJoin = manager.snapshot();
    expect(atJoin.startRecords).toHaveLength(1);
    expect(atJoin.readyPromise).toBe(first.promise);

    await until(
      () => manager.createChildCalls === 1 && manager.readinessCalls === 1,
      "spawn and readiness gate",
    );
    manager.resolveReadiness();
    const baseUrl = await first.promise;
    expect(baseUrl).toBe(`http://127.0.0.1:${manager.snapshot().port}`);
    expect(await duplicate.promise).toBe(baseUrl);

    // Fulfilment keeps the same object: no settlement wrapper is introduced.
    const atFulfilled = manager.snapshot();
    expect(atFulfilled.readyPromise).toBe(first.promise);
    expect(atFulfilled.startRecords[0]?.promise).toBe(first.promise);
    expect(atFulfilled.startRecords[0]?.state).toBe("fulfilled");

    // A late caller joins the fulfilled, deliverable record through that promise.
    const late = manager.acquireManagedStart();
    expect(late.startId).toBe(first.startId);
    expect(late.promise).toBe(first.promise);
    expect(await late.promise).toBe(baseUrl);
    expect(manager.createChildCalls).toBe(1);
    late.release();
  });

  it("settling an older start retires neither a newer record nor its promise", async () => {
    const manager = newManager();

    const stale = manager.acquireManagedStart();
    await until(
      () => manager.createChildCalls === 1 && manager.readinessCalls === 1,
      "first spawn and readiness gate",
    );
    expect(manager.snapshot().readyPromise).toBe(stale.promise);

    // The old child exits; its own record is retired and recovery reserves a
    // NEW start, exactly as AT14 control 2 reaches this state.
    manager.fakeAt(0).exitWith(0);
    await until(
      () => manager.createChildCalls === 2 && manager.readinessCalls === 2,
      "restart spawn and readiness gate",
    );
    const fresh = manager.acquireManagedStart();
    expect(fresh.promise).not.toBe(stale.promise);
    const atRestart = manager.snapshot();
    expect(atRestart.currentStartId).toBe(fresh.startId);
    expect(atRestart.readyPromise).toBe(fresh.promise);
    expect(atRestart.startRecords.map((record) => record.startId)).toEqual([fresh.startId]);
    expect(atRestart.startRecords[0]?.promise).toBe(fresh.promise);

    // The OLD start now settles, while the newer one is the published record.
    manager.rejectReadiness(new Error("stale readiness failed"), 0);
    await expect(stale.promise).rejects.toThrow("stale readiness failed");
    await flush();

    // Settlement of the older record neither evicts nor replaces the newer
    // record's promise: the identity guard compares, it does not overwrite.
    const after = manager.snapshot();
    expect(after.currentStartId).toBe(fresh.startId);
    expect(after.readyPromise).toBe(fresh.promise);
    expect(after.startRecords.map((record) => record.startId)).toEqual([fresh.startId]);
    expect(after.startRecords[0]?.promise).toBe(fresh.promise);
    expect(after.startRecords[0]?.state).toBe("pending");

    // The newer start is still joinable through that identical promise, and it
    // still delivers its child.
    const joined = manager.acquireManagedStart();
    expect(joined.startId).toBe(fresh.startId);
    expect(joined.promise).toBe(fresh.promise);
    manager.resolveReadiness(1);
    await fresh.promise;
    expect(manager.snapshot().publishedChild).toBe(manager.childAt(1));
    joined.release();
  });

  it("a pre-spawn settlement retires exactly its own record and a fresh start is a new one", async () => {
    const manager = newManager();
    manager.failBinary = true;

    await expect(manager.ensureBaseUrl()).rejects.toThrow("managed binary missing");

    // The only record this failure could retire was its own; nothing replaces it.
    const afterFailure = manager.snapshot();
    expect(afterFailure.startRecords).toEqual([]);
    expect(afterFailure.currentStartId).toBeNull();
    expect(afterFailure.readyPromise).toBeNull();

    manager.failBinary = false;
    const fresh = manager.acquireManagedStart();
    const afterFresh = manager.snapshot();
    expect(afterFresh.startRecords.map((record) => record.startId)).toEqual([fresh.startId]);
    expect(afterFresh.readyPromise).toBe(fresh.promise);
    expect(afterFresh.startRecords[0]?.promise).toBe(fresh.promise);
    expect(manager.createChildCalls).toBe(0);

    await until(
      () => manager.createChildCalls === 1 && manager.readinessCalls === 1,
      "fresh spawn and readiness gate",
    );
    manager.resolveReadiness();
    await fresh.promise;
    fresh.release();
  });
});

describe("AT12(b) — a spawned, never-published child is stopped exactly once", () => {
  it("stops the child shutdown found even though no target names it", async () => {
    const manager = newManager();

    const pending = manager.ensureBaseUrl();
    await until(
      () => manager.createChildCalls === 1 && manager.readinessCalls === 1,
      "spawn and readiness gate",
    );
    const child = manager.childAt(0);
    expect(readConnectionState().target.mode).toBe("unresolved");

    expect(await beginShutdown()).toEqual({ ok: true });
    expect(manager.stopCalls).toHaveLength(1);
    expect(manager.stopCalls[0]).toBe(child);

    // The cancelled start's own completion requests cleanup afterwards; it
    // joins the published stop and adds no second signal.
    manager.resolveReadiness();
    await expect(pending).rejects.toBeInstanceOf(OpenCodeReadinessCancelledError);
    await flush();
    expect(manager.stopCalls).toHaveLength(1);
  });
});

describe("AT12(c) — a superseded attempt never hands out a child it is about to stop", () => {
  it("withdraws the still-handable start, stops only its child, and survives that child's late exit", async () => {
    const manager = newManager();
    const restarts: string[] = [];
    const originalInfo = logger.info.bind(logger);
    logger.info = (scope, event, fields) => {
      if (event === "opencode.restart") restarts.push(event);
      originalInfo(scope, event, fields);
    };

    try {
      const attemptA = beginAttempt("manual");
      const handleA = manager.acquireManagedStart(attemptA);
      await until(
        () => manager.createChildCalls === 1 && manager.readinessCalls === 1,
        "first spawn and readiness gate",
      );
      const startIdA = handleA.startId;
      const childA = manager.childAt(0);

      // B supersedes A and never joins the start.
      const attemptB = beginAttempt("manual");
      expect(isAttemptActive(attemptA)).toBe(false);
      expect(attemptB.attemptId).not.toBe(attemptA.attemptId);

      manager.resolveReadiness();
      const baseUrlA = await handleA.promise;

      // Establish the hazard: the start settled and its promise is still handable.
      const settled = manager.snapshot(childA);
      expect(settled.state).toBe("fulfilled");
      expect(settled.withdrawn).toBe(false);
      expect(manager.snapshot().currentStartId).toBe(startIdA);
      expect(settled.child).toBe(childA);
      expect(settled.unreleasedAttemptIds).toEqual([]);
      const cached = manager.acquireManagedStart();
      expect(cached.startId).toBe(startIdA);
      expect(await cached.promise).toBe(baseUrlA);
      expect(manager.createChildCalls).toBe(1);
      cached.release();

      // A's completion releases (already released by the abort) and requests cleanup.
      handleA.release();
      expect(manager.snapshot(childA).releasedAttemptIds).toContain(attemptA.attemptId);
      manager.stopPlans.push("leave-alive");
      const stop = manager.requestCleanup(childA, "attempt", attemptA);
      expect(stop).not.toBeNull();

      // Withdrawal is synchronous and precedes publication.
      const afterRequest = manager.snapshot(childA);
      expect(afterRequest.currentStartId).toBeNull();
      expect(afterRequest.withdrawn).toBe(true);
      expect(handleA.deliverable()).toBe(false);
      expect(afterRequest.childHasStop).toBe(true);

      await stop;
      expect(manager.stopCalls).toHaveLength(1);
      const atSignal = manager.stopSnapshots[0];
      expect(atSignal.childHasStop).toBe(true);
      expect(atSignal.managerChild).toBeNull();
      expect(atSignal.port).toBeNull();
      expect(atSignal.readyAtMs).toBeNull();

      // Duplicate and post-settlement requests join the identical promise.
      expect(manager.requestCleanup(childA, "attempt", attemptA)).toBe(stop);
      expect(manager.requestCleanup(childA, "manager", "manager")).toBe(stop);
      expect(manager.stopCalls).toHaveLength(1);

      // A fresh start must not reuse the doomed child.
      const handleB = manager.acquireManagedStart();
      expect(handleB.startId).not.toBe(startIdA);
      await until(
        () => manager.createChildCalls === 2 && manager.readinessCalls === 2,
        "second spawn and readiness gate",
      );
      const childB = manager.childAt(1);
      expect(childB).not.toBe(childA);
      manager.resolveReadiness();
      await handleB.promise;

      const publishedB = manager.snapshot();
      expect(publishedB.managerChild).toBe(childB);
      expect(publishedB.currentStartId).toBe(handleB.startId);
      expect(publishedB.readyAtMs).not.toBeNull();
      expect(publishedB.readyPromisePresent).toBe(true);
      expect(publishedB.liveChildren).toContain(childA);
      expect(publishedB.liveChildren).toContain(childB);

      // A's late exit reaps only A and must not disturb B's pointers or record.
      manager.fakeAt(0).exitWith(0);
      await flush();
      const afterExit = manager.snapshot();
      expect(afterExit.liveChildren).not.toContain(childA);
      expect(afterExit.liveChildren).toContain(childB);
      expect(manager.snapshot(childB).child).toBe(childB);
      expect(manager.snapshot(childB).startId).toBe(handleB.startId);
      expect(afterExit.managerChild).toBe(childB);
      expect(afterExit.currentStartId).toBe(handleB.startId);
      expect(afterExit.port).toBe(publishedB.port);
      expect(afterExit.readyAtMs).toBe(publishedB.readyAtMs);
      expect(afterExit.readyPromisePresent).toBe(true);
      expect(manager.createChildCalls).toBe(2);
      expect(restarts).toEqual([]);
      handleB.release();
    } finally {
      logger.info = originalInfo;
    }
  });
});

describe("AT12(d) — a fallback child racing shutdown", () => {
  it("registers the child before its first await and is joined by shutdown once", async () => {
    const manager = newManager();

    const pending = manager.ensureBaseUrl();
    await until(
      () => manager.createChildCalls === 1 && manager.readinessCalls === 1,
      "spawn and readiness gate",
    );
    const child = manager.childAt(0);
    await until(() => manager.spawnReturns.length === 1, "spawn attribution snapshot");
    const atReturn = manager.spawnReturns[0];
    expect(atReturn.liveChildren).toContain(child);
    expect(atReturn.child).toBe(child);
    expect(atReturn.childStartId).not.toBeNull();

    expect(await beginShutdown()).toEqual({ ok: true });
    expect(manager.stopCalls).toHaveLength(1);
    expect(manager.stopCalls[0]).toBe(child);

    manager.resolveReadiness();
    await expect(pending).rejects.toBeInstanceOf(OpenCodeReadinessCancelledError);
    await flush();
    expect(manager.createChildCalls).toBe(1);
    expect(manager.stopCalls).toHaveLength(1);
  });
});

describe("AT13 — two attempts share one in-flight managed start", () => {
  it("defers the stale attempt's cleanup by C1 and stops the child once at shutdown", async () => {
    const manager = newManager();

    const attemptA = beginAttempt("manual");
    const pendingA = manager.ensureManagedTarget(attemptA);
    await until(
      () => manager.createChildCalls === 1 && manager.readinessCalls === 1,
      "spawn and readiness gate",
    );
    const child = manager.childAt(0);

    // A is superseded while readiness is pending; B joins the same start.
    const attemptB = beginAttempt("manual");
    const pendingB = manager.ensureManagedTarget(attemptB);
    expect(manager.createChildCalls).toBe(1);
    expect(manager.snapshot(child).releasedAttemptIds).toContain(attemptA.attemptId);
    expect(manager.snapshot(child).unreleasedAttemptIds).toEqual([attemptB.attemptId]);

    manager.resolveReadiness();
    await expect(pendingA).rejects.toBeInstanceOf(OpenCodeAttemptSupersededError);

    // The request is deferred by C1, not C2: the start is fulfilled.
    const atRequest = manager.cleanupSnapshots[0];
    expect(atRequest.state).toBe("fulfilled");
    expect(atRequest.countedAttemptIds).toEqual([attemptB.attemptId]);
    expect(atRequest.withdrawn).toBe(false);
    expect(atRequest.currentStartId).toBe(manager.snapshot(child).startId);
    expect(manager.stopCalls).toHaveLength(0);
    expect(manager.snapshot(child).childHasStop).toBe(false);
    // The C1 deferral preserved the stale attempt's request under its own key.
    expect(manager.snapshot(child).pendingCleanup?.requestKeys).toEqual([
      JSON.stringify(["attempt", "attempt", attemptA.attemptId]),
    ]);

    await pendingB;
    // B installs once, carrying its own attempt; the stale attempt installs nothing.
    expect(readConnectionState().target.mode).toBe("managed");
    expect(readConnectionState().revision).toBe(1);
    expect(manager.snapshot().publishedChild).toBe(child);

    // B's release fires T1; the target now names the child, so C3 retains it.
    const retained = manager.snapshot(child).pendingCleanup;
    expect(retained).not.toBeNull();
    expect(retained?.state).toBe("target-owned");
    expect(retained?.triggers).toEqual(["T3"]);
    expect(manager.stopCalls).toHaveLength(0);

    const first = beginShutdown();
    expect(beginShutdown()).toBe(first);
    expect(await first).toEqual({ ok: true });
    expect(manager.stopCalls).toHaveLength(1);
    expect(manager.snapshot(child).pendingCleanup).toBeNull();

    expect(manager.requestCleanup(child, "attempt", attemptA)).toBe(
      manager.requestCleanup(child, "shutdown", "shutdown"),
    );
    expect(manager.stopCalls).toHaveLength(1);
  });

  it("control: with no counted waiter the same request initiates the stop", async () => {
    const manager = newManager();

    const attemptA = beginAttempt("manual");
    const pendingA = manager.ensureManagedTarget(attemptA);
    await until(
      () => manager.createChildCalls === 1 && manager.readinessCalls === 1,
      "spawn and readiness gate",
    );
    const child = manager.childAt(0);

    const attemptB = beginAttempt("manual");
    const pendingB = manager.ensureManagedTarget(attemptB);
    // Both callers refuse asynchronously after the shared start settles, so the
    // rejections are observed here rather than later to avoid an unhandled one.
    const outcomeA = pendingA.catch((error: unknown) => error);
    const outcomeB = pendingB.catch((error: unknown) => error);
    const attemptC = beginAttempt("manual");
    expect(isAttemptActive(attemptB)).toBe(false);
    expect(isAttemptActive(attemptC)).toBe(true);

    manager.resolveReadiness();
    expect(await outcomeA).toBeInstanceOf(OpenCodeAttemptSupersededError);
    expect(await outcomeB).toBeInstanceOf(OpenCodeAttemptSupersededError);

    const stop = manager.requestCleanup(child, "attempt", attemptA);
    expect(stop).not.toBeNull();
    expect(manager.requestCleanup(child, "attempt", attemptB)).toBe(stop);
    await stop;
    expect(manager.stopCalls).toHaveLength(1);
  });
});

describe("AT14 — start settlement order on failure", () => {
  it("releases waiters, detaches by identity, publishes one stop, then delivers", async () => {
    const manager = newManager();

    const attemptA = beginAttempt("manual");
    const pendingA = manager.ensureManagedTarget(attemptA);
    await until(
      () => manager.createChildCalls === 1 && manager.readinessCalls === 1,
      "spawn and readiness gate",
    );
    const child = manager.childAt(0);

    // Installed before B supersedes A: the supersession release is one of the
    // events under test.
    const observed: Array<{ event: string; snapshot: ManagedStartSnapshot }> = [];
    manager.onEvent = (event, snapshot) => observed.push({ event, snapshot });

    const attemptB = beginAttempt("manual");
    const pendingB = manager.ensureManagedTarget(attemptB);
    expect(manager.snapshot(child).unreleasedAttemptIds).toEqual([attemptB.attemptId]);

    let settledA = false;
    let settledB = false;
    pendingA.then(
      () => {
        settledA = true;
      },
      () => {
        settledA = true;
      },
    );
    pendingB.then(
      () => {
        settledB = true;
      },
      () => {
        settledB = true;
      },
    );

    let atCleanup: ManagedStartSnapshot | null = null;
    let settledAtCleanup = true;
    manager.onCleanupEntered = (self) => {
      // Only the settlement's own request is under test; the callers' own
      // catches join the published stop afterwards and enter the decision point
      // again, which is asserted separately below.
      if (atCleanup !== null) return;
      atCleanup = self.snapshot();
      settledAtCleanup = settledA || settledB;
    };
    manager.rejectReadiness(new Error("readiness failed"), 0);
    await expect(pendingA).rejects.toThrow("readiness failed");
    await expect(pendingB).rejects.toThrow("readiness failed");

    const lifecycle = manager.events.filter((event) => !event.startsWith("signal:"));
    // E4 releases A at supersession, before the failing start settles; the
    // settlement tail for the remaining waiter is AT14's exact sequence.
    expect(lifecycle.slice(0, 7)).toEqual([
      `release:${attemptA.attemptId}`,
      "settle:state=rejected",
      `release:${attemptB.attemptId}`,
      "detach-current-pointers-by-identity",
      "cleanup:entered",
      "stop:published",
      "reject:shared",
    ]);

    const snapshotAt = (event: string): ManagedStartSnapshot => {
      const entry = observed.find((candidate) => candidate.event === event);
      if (entry === undefined) throw new Error(`no snapshot was recorded at ${event}`);
      return entry.snapshot;
    };
    const releaseA = snapshotAt(`release:${attemptA.attemptId}`);
    const atRejected = snapshotAt("settle:state=rejected");
    // Equivalence, part 1: A's release is E4's supersession release — it runs
    // synchronously inside `beginAttempt`, while the start is still pending and
    // before B has joined. At settlement only B remains, so a single
    // `release:B` in the settlement tail is the whole live waiter set.
    expect(releaseA.state).toBe("pending");
    expect(releaseA.releasedAttemptIds).toEqual([attemptA.attemptId]);
    expect(releaseA.unreleasedAttemptIds).toEqual([]);
    // Equivalence, part 2: settlement marks the start rejected BEFORE it
    // releases any remaining waiter. That ordering is the invariant AT14
    // protects, and it holds here without a witness.
    expect(atRejected.state).toBe("rejected");
    expect(atRejected.unreleasedAttemptIds).toEqual([attemptB.attemptId]);
    // Each caller's catch then joins the identical published stop, which adds a
    // decision-point entry but no second process call.
    expect(lifecycle.slice(7)).toEqual(["cleanup:entered", "cleanup:entered"]);
    expect(manager.events.filter((event) => event.startsWith("signal:"))).toHaveLength(1);

    expect(atCleanup).not.toBeNull();
    const cleanupSnapshot = atCleanup;
    if (cleanupSnapshot === null) throw new Error("cleanup was never entered");
    expect(cleanupSnapshot.state).toBe("rejected");
    expect(cleanupSnapshot.unreleasedAttemptIds).toEqual([]);
    // Both waiter records are released by the time the decision point runs,
    // whichever event released them.
    expect(cleanupSnapshot.releasedAttemptIds).toEqual([attemptA.attemptId, attemptB.attemptId]);
    expect(cleanupSnapshot.managerChild).toBeNull();
    expect(cleanupSnapshot.port).toBeNull();
    expect(cleanupSnapshot.readyAtMs).toBeNull();
    expect(cleanupSnapshot.liveChildren).toContain(child);
    // The shared completion is delivered last, so neither caller had resumed.
    expect(settledAtCleanup).toBe(false);

    expect(manager.snapshot().currentStartId).toBeNull();
    expect(manager.snapshot().readyPromisePresent).toBe(false);
    expect(manager.stopCalls).toHaveLength(1);
    await until(() => !manager.snapshot().liveChildren.includes(child), "child exit reap");

    // Each caller's catch joins the identical stop with no second process call.
    const joined = manager.requestCleanup(child, "start-failure", "manager");
    expect(joined).not.toBeNull();
    expect(manager.requestCleanup(child, "attempt", attemptA)).toBe(joined);
    await joined;
    expect(manager.stopCalls).toHaveLength(1);
  });

  it("rejects the state, releases every live waiter, detaches, then delivers", async () => {
    const manager = newManager();
    const attemptA = beginAttempt("manual");
    const first = manager.acquireManagedStart(attemptA);
    const second = manager.acquireManagedStart(attemptA);
    expect(second.startId).toBe(first.startId);
    expect(second.promise).toBe(first.promise);

    await until(
      () => manager.createChildCalls === 1 && manager.readinessCalls === 1,
      "spawn and readiness gate",
    );
    const child = manager.childAt(0);

    const observed: Array<{ event: string; snapshot: ManagedStartSnapshot }> = [];
    let settled = false;
    let settledWhenDelivered = true;
    const markSettled = (): void => {
      settled = true;
    };
    first.promise.then(markSettled, markSettled);
    second.promise.then(markSettled, markSettled);
    manager.onEvent = (event, snapshot) => {
      observed.push({ event, snapshot });
      if (event === "reject:shared") settledWhenDelivered = settled;
    };

    manager.rejectReadiness(new Error("readiness failed"), 0);
    await expect(first.promise).rejects.toThrow("readiness failed");
    await expect(second.promise).rejects.toThrow("readiness failed");

    // The literal AT14 settlement order, with both waiter records still live
    // when the failure arrives.
    const lifecycle = manager.events.filter((event) => !event.startsWith("signal:"));
    expect(lifecycle).toEqual([
      "settle:state=rejected",
      `release:${attemptA.attemptId}`,
      `release:${attemptA.attemptId}`,
      "detach-current-pointers-by-identity",
      "cleanup:entered",
      "stop:published",
      "reject:shared",
    ]);
    // Delivery is last: the shared promise had not settled when its rejection
    // was published, so neither caller could have resumed before the stop.
    expect(settledWhenDelivered).toBe(false);
    expect(settled).toBe(true);

    const atRejected = observed[0];
    expect(atRejected?.event).toBe("settle:state=rejected");
    expect(atRejected?.snapshot.state).toBe("rejected");
    expect(atRejected?.snapshot.unreleasedAttemptIds).toEqual([
      attemptA.attemptId,
      attemptA.attemptId,
    ]);

    const atCleanup = observed.find((entry) => entry.event === "cleanup:entered");
    if (atCleanup === undefined) throw new Error("cleanup was never entered");
    expect(atCleanup.snapshot.unreleasedAttemptIds).toEqual([]);
    expect(atCleanup.snapshot.releasedAttemptIds).toEqual([attemptA.attemptId, attemptA.attemptId]);
    expect(atCleanup.snapshot.state).toBe("rejected");
    expect(atCleanup.snapshot.managerChild).toBeNull();
    expect(atCleanup.snapshot.port).toBeNull();
    expect(atCleanup.snapshot.readyAtMs).toBeNull();
    expect(atCleanup.snapshot.liveChildren).toContain(child);

    expect(manager.stopCalls).toHaveLength(1);
    expect(manager.stopCalls[0]).toBe(child);
    await until(() => !manager.snapshot().liveChildren.includes(child), "child exit reap");

    // A later request joins the published stop; it never signals again.
    const joined = manager.requestCleanup(child, "start-failure", "manager");
    expect(joined).not.toBeNull();
    await joined;
    expect(manager.stopCalls).toHaveLength(1);
  });

  it("settles the production attempt-free path in the same order", async () => {
    // The two-waiter shape above is not reachable from a production caller:
    // `ensureBaseUrl()` starts with no attempt, and `ensureManagedTarget()` is
    // the only attempt-bound entry point and has none yet. This case pins the
    // settlement order on the path boot, startup fallback and recovery
    // actually use, through the same `settleRejected` implementation.
    const manager = newManager();
    const pending = manager.ensureBaseUrl();
    await until(
      () => manager.createChildCalls === 1 && manager.readinessCalls === 1,
      "spawn and readiness gate",
    );
    const child = manager.childAt(0);
    expect(manager.snapshot(child).unreleasedAttemptIds).toEqual([]);

    let settled = false;
    let settledAtDelivery = true;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    manager.onEvent = (event) => {
      if (event === "reject:shared") settledAtDelivery = settled;
    };

    manager.rejectReadiness(new Error("readiness failed"), 0);
    await expect(pending).rejects.toThrow("readiness failed");

    const lifecycle = manager.events.filter((event) => !event.startsWith("signal:"));
    expect(lifecycle).toEqual([
      "settle:state=rejected",
      "detach-current-pointers-by-identity",
      "cleanup:entered",
      "stop:published",
      "reject:shared",
    ]);
    // Delivery last: the caller could not resume before the stop was published.
    expect(settledAtDelivery).toBe(false);
    expect(settled).toBe(true);
    expect(manager.stopCalls).toEqual([child]);
    await until(() => !manager.snapshot().liveChildren.includes(child), "child exit reap");
  });

  it("control 1: a pre-spawn failure signals nothing and clears only its own reservation", async () => {
    const manager = newManager();
    manager.failBinary = true;

    await expect(manager.ensureBaseUrl()).rejects.toThrow("managed binary missing");

    expect(manager.createChildCalls).toBe(0);
    expect(manager.stopCalls).toHaveLength(0);
    expect(manager.events).not.toContain("cleanup:entered");
    expect(manager.snapshot().currentStartId).toBeNull();
    expect(manager.snapshot().readyPromisePresent).toBe(false);
  });

  it("control 2: an old start's late rejection never clears a newer start's pointers", async () => {
    const manager = newManager();

    const stale = manager.acquireManagedStart();
    await until(
      () => manager.createChildCalls === 1 && manager.readinessCalls === 1,
      "first spawn and readiness gate",
    );

    // The old child exits unexpectedly; onExit reserves the restart start
    // before the old start's readiness gate is rejected.
    manager.fakeAt(0).exitWith(0);
    await until(
      () => manager.createChildCalls === 2 && manager.readinessCalls === 2,
      "restart spawn and readiness gate",
    );
    const childB = manager.childAt(1);
    const before = manager.snapshot();
    expect(before.managerChild).toBe(childB);

    manager.rejectReadiness(new Error("stale readiness failed"), 0);
    await expect(stale.promise).rejects.toThrow("stale readiness failed");
    await flush();

    const after = manager.snapshot();
    expect(after.managerChild).toBe(childB);
    expect(after.currentStartId).toBe(before.currentStartId);
    expect(after.port).toBe(before.port);
    expect(after.readyAtMs).toBe(before.readyAtMs);
    expect(after.readyPromisePresent).toBe(true);
    expect(after.liveChildren).toContain(childB);
    expect(manager.stopCalls).toHaveLength(0);
  });

  it("control 3: a manager-owned keep-alive start publishes one stop on failure", async () => {
    const manager = newManager();

    const pending = manager.ensureBaseUrl();
    await until(
      () => manager.createChildCalls === 1 && manager.readinessCalls === 1,
      "spawn and readiness gate",
    );
    const child = manager.childAt(0);

    manager.rejectReadiness(new Error("keep-alive failed"));
    await expect(pending).rejects.toThrow("keep-alive failed");

    expect(manager.events.filter((event) => event === "stop:published")).toHaveLength(1);
    expect(manager.stopCalls).toHaveLength(1);
    expect(manager.stopCalls[0]).toBe(child);
    const entry = manager.cleanupSnapshots[0];
    expect(entry.unreleasedAttemptIds).toEqual([]);
  });

  it("control 4: a non-settling stop reports termination_unconfirmed and keeps the child tracked", async () => {
    const manager = newManager();
    manager.stopPlans.push("unconfirmed");

    const handle = manager.acquireManagedStart();
    await until(
      () => manager.createChildCalls === 1 && manager.readinessCalls === 1,
      "spawn and readiness gate",
    );
    const child = manager.childAt(0);

    manager.rejectReadiness(new Error("failed start"));
    await expect(handle.promise).rejects.toThrow("failed start");

    const stop = manager.requestCleanup(child, "manager", "manager");
    expect(stop).not.toBeNull();
    expect(await stop).toEqual({
      ok: false,
      reason: "termination_unconfirmed",
      pid: child.pid,
    });
    expect(manager.snapshot(child).liveChildren).toContain(child);

    const fresh = manager.acquireManagedStart();
    expect(fresh.startId).not.toBe(handle.startId);
    await until(
      () => manager.createChildCalls === 2 && manager.readinessCalls === 2,
      "fresh spawn",
    );
    expect(manager.childAt(1)).not.toBe(child);
  });
});

describe("AT15 — acquisition and spawn attribution ordering", () => {
  it("reserves, publishes and registers the waiter before the spawn returns", async () => {
    const manager = newManager();
    const attemptA = beginAttempt("manual");
    let entry: ManagedStartSnapshot | null = null;
    let joined: ManagedStartHandle | null = null;
    manager.onSpawn = (self) => {
      entry = self.snapshot();
      const attemptB = beginAttempt("manual");
      joined = self.acquireManagedStart(attemptB);
    };

    const handleA = manager.acquireManagedStart(attemptA);
    await until(() => manager.createChildCalls === 1, "spawn");

    const atEntry = entry;
    if (atEntry === null) throw new Error("createChild was never entered");
    expect(atEntry.state).toBe("pending");
    expect(atEntry.currentStartId).toBe(handleA.startId);
    expect(atEntry.liveChildren).toEqual([]);
    expect(atEntry.childHasStop).toBe(false);
    expect(atEntry.unreleasedAttemptIds).toContain(attemptA.attemptId);
    expect(joined).not.toBeNull();
    const second = joined as ManagedStartHandle | null;
    if (second === null) throw new Error("second acquisition did not happen");
    expect(second.startId).toBe(handleA.startId);
    expect(second.promise).toBe(handleA.promise);

    await until(() => manager.spawnReturns.length === 1, "spawn return snapshot");
    const child = manager.childAt(0);
    const atReturn = manager.spawnReturns[0];
    expect(atReturn.liveChildren).toContain(child);
    expect(atReturn.childStartId).toBe(handleA.startId);
    expect(atReturn.child).toBe(child);
    expect(atReturn.managerChild).toBe(child);
    // The port is kernel-assigned and announced later, so at spawn-return there
    // is no port yet; the listening wait fills it in before readiness.
    expect(atReturn.port).toBeNull();
    expect(atReturn.readyAtMs).toBeNull();
    expect(atReturn.unreleasedAttemptIds).toHaveLength(1);
    expect(atReturn.releasedAttemptIds).toContain(attemptA.attemptId);

    manager.resolveReadiness();
    await handleA.promise;
    handleA.release();
  });

  it("keeps a spawn whose reservation was revoked in the seam manager-owned", async () => {
    const manager = newManager();
    const attemptA = beginAttempt("manual");
    manager.onSpawn = (self) => {
      // The stop this start's own settlement publishes must not settle the fake
      // child, so ownership is still observable after the rejection.
      self.stopPlans.push("leave-alive");
      self.stopAllChildrenForShutdown();
    };

    const handle = manager.acquireManagedStart(attemptA);
    const outcome = handle.promise.catch((error: unknown) => error);
    await until(() => manager.createChildCalls === 1, "spawn");
    expect(await outcome).toBeInstanceOf(OpenCodeAttemptSupersededError);
    await flush();

    const child = manager.childAt(0);
    const snapshot = manager.snapshot(child);
    // Never adopted through the current-child pointer, yet still owned: the
    // settlement's request published one stop for it.
    expect(snapshot.liveChildren).toContain(child);
    expect(snapshot.managerChild).toBeNull();
    expect(snapshot.port).toBeNull();
    expect(snapshot.readyAtMs).toBeNull();
    expect(snapshot.childHasStop).toBe(true);
    expect(manager.stopCalls).toEqual([child]);

    // Releasing the revoked caller's share adds no second stop.
    handle.release();
    await flush();
    expect(manager.stopCalls).toHaveLength(1);
  });

  it("never reports a fulfilled child with a published stop as deliverable", async () => {
    const manager = newManager();

    const pending = manager.ensureBaseUrl();
    await until(
      () => manager.createChildCalls === 1 && manager.readinessCalls === 1,
      "spawn and readiness gate",
    );
    const child = manager.childAt(0);
    manager.resolveReadiness();
    await pending;

    const handle = manager.acquireManagedStart();
    expect(handle.deliverable()).toBe(true);

    manager.clearPublishedTarget();
    manager.stopPlans.push("leave-alive");
    const stop = manager.requestCleanup(child, "manager", "manager");
    expect(stop).not.toBeNull();
    expect(handle.deliverable()).toBe(false);
    await stop;

    const fresh = manager.acquireManagedStart();
    expect(fresh.startId).not.toBe(handle.startId);
  });
});

describe("AT16 — target ownership defers cleanup until that exact target is cleared", () => {
  it("retains the obligation while the target is installed and reissues it on clear", async () => {
    const manager = newManager();
    const attemptA = beginAttempt("manual");
    const pendingA = manager.ensureManagedTarget(attemptA);
    await manager.openReadiness(1);
    await pendingA;
    const child = manager.childAt(0);
    expect(manager.snapshot().publishedChild).toBe(child);

    const attemptB = beginAttempt("manual");
    expect(isAttemptActive(attemptA)).toBe(false);
    expect(isAttemptActive(attemptB)).toBe(true);

    manager.stopPlans.push("leave-alive");
    const deferred = manager.requestCleanup(child, "attempt", attemptA);
    expect(deferred).toBeNull();
    const obligation = manager.snapshot(child).pendingCleanup;
    expect(obligation).not.toBeNull();
    expect(obligation?.state).toBe("target-owned");
    expect(obligation?.triggers).toEqual(["T3"]);
    expect(obligation?.requestKeys).toEqual([
      JSON.stringify(["attempt", "attempt", attemptA.attemptId]),
    ]);
    expect(manager.stopCalls).toHaveLength(0);

    // Replacing the connection state with an unrelated target must not delete
    // the obligation or signal anything.
    installManagedTarget({
      baseUrl: "http://127.0.0.1:4799",
      password: REPLACEMENT_PASSWORD,
    });
    expect(readConnectionState().target).toMatchObject({
      mode: "managed",
      origin: "http://127.0.0.1:4799",
    });
    expect(manager.snapshot(child).pendingCleanup).not.toBeNull();
    expect(manager.stopCalls).toHaveLength(0);

    // Clearing the exact installed target reissues the original request.
    manager.clearPublishedTarget();
    const reissued = manager.requestCleanup(child, "attempt", attemptA);
    expect(reissued).not.toBeNull();
    expect(manager.requestCleanup(child, "attempt", attemptA)).toBe(reissued);
    await reissued;
    expect(manager.stopCalls).toHaveLength(1);
    expect(manager.stopCalls[0]).toBe(child);
    expect(manager.snapshot(child).pendingCleanup).toBeNull();
  });

  it("never detaches or stops a newer child when an older child's cleanup is reissued", async () => {
    const manager = newManager();
    const attemptA = beginAttempt("manual");
    const pendingA = manager.ensureManagedTarget(attemptA);
    await manager.openReadiness(1);
    await pendingA;
    const childA = manager.childAt(0);

    // Deferred while the target still names A, then released by clearing it.
    manager.stopPlans.push("leave-alive");
    expect(manager.requestCleanup(childA, "manager", "manager")).toBeNull();
    expect(manager.snapshot(childA).pendingCleanup?.state).toBe("target-owned");
    manager.clearPublishedTarget();
    await flush();
    expect(manager.stopCalls).toEqual([childA]);
    expect(manager.snapshot().currentStartId).toBeNull();

    // A newer child becomes current afterwards.
    const handleB = manager.acquireManagedStart();
    await manager.openReadiness(2);
    await handleB.promise;
    const childB = manager.childAt(1);
    handleB.release();
    await manager.ensureBaseUrl();
    expect(manager.snapshot().publishedChild).toBe(childB);

    // Reissuing the older request joins A's published stop; it detaches and
    // signals neither the newer child nor its binding.
    const joined = manager.requestCleanup(childA, "manager", "manager");
    expect(joined).not.toBeNull();
    await joined;
    expect(manager.stopCalls).toEqual([childA]);
    expect(manager.snapshot(childB).childHasStop).toBe(false);
    expect(manager.snapshot(childB).liveChildren).toContain(childB);
    expect(manager.snapshot().publishedChild).toBe(childB);
    expect(manager.snapshot().managerChild).toBe(childB);
  });
});

describe("AT17 — multiple cleanup requests merge without losing ownership", () => {
  it("keeps one obligation, every request key and every trigger until each condition clears", async () => {
    const manager = newManager();
    const attemptA = beginAttempt("manual");
    const pendingA = manager.ensureManagedTarget(attemptA);
    await manager.openReadiness(1);
    await pendingA;
    const child = manager.childAt(0);

    // B holds a counted waiter on the fulfilled start while the target names
    // the child: C3 and C1 both fail.
    const attemptB = beginAttempt("manual");
    const handleB = manager.acquireManagedStart(attemptB);

    expect(manager.requestCleanup(child, "attempt", attemptA)).toBeNull();
    let obligation = manager.snapshot(child).pendingCleanup;
    expect(obligation).not.toBeNull();
    expect(obligation?.state).toBe("target-owned");
    expect([...(obligation?.triggers ?? [])].sort()).toEqual(["T1", "T3"]);
    expect(obligation?.requestKeys).toEqual([
      JSON.stringify(["attempt", "attempt", attemptA.attemptId]),
    ]);

    // A second requester merges; a duplicate key is idempotent.
    expect(manager.requestCleanup(child, "manager", "manager")).toBeNull();
    expect(manager.requestCleanup(child, "manager", "manager")).toBeNull();
    obligation = manager.snapshot(child).pendingCleanup;
    expect(obligation?.requestKeys).toEqual([
      JSON.stringify(["attempt", "attempt", attemptA.attemptId]),
      JSON.stringify(["manager", "manager", "manager"]),
    ]);
    expect(manager.stopCalls).toHaveLength(0);

    // Clearing T3 removes only that trigger.
    manager.clearPublishedTarget();
    obligation = manager.snapshot(child).pendingCleanup;
    expect(obligation?.state).toBe("pending");
    expect(obligation?.triggers).toEqual(["T1"]);
    expect(obligation?.requestKeys).toHaveLength(2);
    expect(manager.stopCalls).toHaveLength(0);

    // Releasing the last counted waiter fires T1 and publishes one stop.
    manager.stopPlans.push("leave-alive");
    handleB.release();
    await flush();
    expect(manager.stopCalls).toHaveLength(1);
    expect(manager.snapshot(child).pendingCleanup).toBeNull();

    const joined = manager.requestCleanup(child, "attempt", attemptA);
    expect(joined).not.toBeNull();
    expect(manager.requestCleanup(child, "shutdown", "shutdown")).toBe(joined);
    await joined;
    expect(manager.stopCalls).toHaveLength(1);
  });

  it("shutdown satisfies a pending obligation and records an unconfirmed stop", async () => {
    const manager = newManager();
    const attemptA = beginAttempt("manual");
    const pendingA = manager.ensureManagedTarget(attemptA);
    await manager.openReadiness(1);
    await pendingA;
    const child = manager.childAt(0);

    const attemptB = beginAttempt("manual");
    const handleB = manager.acquireManagedStart(attemptB);
    expect(manager.requestCleanup(child, "attempt", attemptA)).toBeNull();
    expect(manager.snapshot(child).pendingCleanup).not.toBeNull();

    manager.stopPlans.push("unconfirmed");
    const completion = beginShutdown();
    expect(beginShutdown()).toBe(completion);
    expect(await completion).toEqual({
      ok: false,
      reason: "termination_unconfirmed",
      pid: child.pid,
    });

    expect(manager.snapshot(child).childHasStop).toBe(true);
    expect(manager.snapshot(child).pendingCleanup).toBeNull();
    expect(manager.snapshot(child).liveChildren).toContain(child);
    expect(manager.stopCalls).toHaveLength(1);
    handleB.release();
  });
});

/** Starts the managed child through the real manager, publishes it, returns it. */
async function startPublished(manager: HarnessManager): Promise<Subprocess> {
  const pending = manager.ensureBaseUrl();
  await manager.openReadiness(1);
  await pending;
  return manager.childAt(0);
}

/** Every child-stop failure the logger buffered after `sinceSeq`. */
function stopFailures(sinceSeq: number) {
  return logger
    .getRecentEntries(sinceSeq)
    .filter((entry) => entry.event === "opencode.child_stop_failed");
}

describe("RC15 — asynchronous child-stop failure and the settlement bound", () => {
  it("(i) an asynchronously rejecting stop resolves {ok:false,error} for every caller, with no unhandled rejection", async () => {
    const manager = newManager();
    const child = await startPublished(manager);
    const attempt = beginAttempt("manual");
    let aborts = 0;
    attempt.controller.signal.addEventListener("abort", () => {
      aborts += 1;
    });
    const epochBefore = readConnectionState().shutdownEpoch;
    const sinceSeq = logger.lastSeq;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      manager.stopPlans.push("reject-async");
      const first = beginShutdown();
      const second = beginShutdown();
      expect(second).toBe(first);

      const [fromFirst, fromSecond] = await Promise.all([first, second]);
      expect(fromSecond).toEqual(fromFirst);
      expect(fromFirst.ok).toBe(false);
      if (!fromFirst.ok) {
        expect("error" in fromFirst && fromFirst.error instanceof Error).toBe(true);
      }

      await flush();
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    // A caller arriving after the failure is served the same settled promise.
    expect(beginShutdown()).toBe(beginShutdown());
    expect(readConnectionState().shutdownEpoch).toBe(epochBefore + 1);
    expect(aborts).toBe(1);

    const failures = stopFailures(sinceSeq);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.pid).toBe(child.pid);
  });

  it("(ii) a child whose exit never arrives is bounded to termination_unconfirmed by the real escalation", async () => {
    const manager = newManager();
    const child = await startPublished(manager);
    const attempt = beginAttempt("manual");
    let aborts = 0;
    attempt.controller.signal.addEventListener("abort", () => {
      aborts += 1;
    });
    const epochBefore = readConnectionState().shutdownEpoch;
    const sinceSeq = logger.lastSeq;

    manager.stopPlans.push("production-bound");
    const first = beginShutdown();
    const second = beginShutdown();
    expect(second).toBe(first);
    const result = await first;
    expect(await second).toEqual(result);
    // The escalation itself signals: SIGTERM, then SIGKILL after the first bound.
    expect(result).toEqual({
      ok: false,
      reason: "termination_unconfirmed",
      pid: child.pid,
    });
    expect(manager.fakeAt(0).killCalls).toEqual(["SIGTERM", "SIGKILL"]);
    expect(readConnectionState().shutdownEpoch).toBe(epochBefore + 1);
    expect(aborts).toBe(1);
    expect(manager.snapshot(child).liveChildren).toContain(child);

    const failures = stopFailures(sinceSeq);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.pid).toBe(child.pid);
    expect(failures[0]?.outcome).toBe("termination_unconfirmed");
  });

  it("(iii) a stop that throws before returning a promise still reaches the typed result asynchronously", async () => {
    const manager = newManager(new PreReturnThrowManager());
    const child = await startPublished(manager);
    const sinceSeq = logger.lastSeq;

    let stop: Promise<OpenCodeShutdownResult> | null = null;
    // `stopChild()` returns normally: the throw is observed in the scheduled
    // callback, not in the caller's synchronous body.
    expect(() => {
      stop = manager.requestCleanup(child, "shutdown", "shutdown");
    }).not.toThrow();
    expect(stop).not.toBeNull();

    const result = await stop;
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain("before returning a promise");
    }

    const failures = stopFailures(sinceSeq);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.pid).toBe(child.pid);
  });
});

describe("RC16 — re-entrant stopChild, one construction", () => {
  it("point (1): a caller re-entering inside the stop initiation joins the published promise with no process call", async () => {
    const manager = newManager();
    const child = await startPublished(manager);
    const attemptAfter = beginAttempt("manual");

    let inner: Promise<OpenCodeShutdownResult> | null = null;
    manager.onStopInitiation = (self, stopped) => {
      inner = self.requestCleanup(stopped, "manager", "manager");
    };

    const outer = manager.requestCleanup(child, "shutdown", "shutdown");
    expect(outer).not.toBeNull();
    await flush();
    expect(inner).not.toBeNull();
    expect(inner).toBe(outer);

    expect(await outer).toEqual({ ok: true });
    expect(manager.stopCalls).toHaveLength(1);
    expect(manager.events.filter((event) => event === `signal:${child.pid}`)).toHaveLength(1);

    // A caller arriving after settlement joins the same promise and signals nothing.
    expect(manager.requestCleanup(child, "attempt", attemptAfter)).toBe(outer);
    expect(manager.stopCalls).toHaveLength(1);
  });

  it("point (2): a caller re-entering immediately before the first signal joins with no second escalation", async () => {
    const manager = newManager();
    const child = await startPublished(manager);
    const attemptBefore = beginAttempt("manual");

    let inner: Promise<OpenCodeShutdownResult> | null = null;
    manager.onBeforeFirstSignal = (self, stopped) => {
      inner = self.requestCleanup(stopped, "attempt", attemptBefore);
    };

    const outer = manager.requestCleanup(child, "shutdown", "shutdown");
    expect(outer).not.toBeNull();
    await flush();
    expect(inner).toBe(outer);

    expect(await outer).toEqual({ ok: true });
    expect(manager.stopCalls).toHaveLength(1);
    expect(manager.events.filter((event) => event === `signal:${child.pid}`)).toHaveLength(1);
  });

  it("point (3): a caller arriving after shutdown published the stop joins before any eligibility test", async () => {
    const manager = newManager();
    const child = await startPublished(manager);
    const attemptLate = beginAttempt("manual");

    const completion = beginShutdown();
    // Shutdown's provider is synchronous, so the per-child stop is already
    // published when `beginShutdown()` returns.
    expect(manager.snapshot(child).childHasStop).toBe(true);

    const firstLate = manager.requestCleanup(child, "attempt", attemptLate);
    const secondLate = manager.requestCleanup(child, "manager", "manager");
    expect(firstLate).not.toBeNull();
    expect(secondLate).toBe(firstLate);

    expect(await completion).toEqual({ ok: true });
    await firstLate;
    expect(manager.stopCalls).toHaveLength(1);
    expect(manager.events.filter((event) => event === `signal:${child.pid}`)).toHaveLength(1);

    // The child is reaped, yet the published entry still joins after settlement.
    expect(manager.requestCleanup(child, "manager", "manager")).toBe(firstLate);
    expect(manager.stopCalls).toHaveLength(1);
  });

  it("shape guard: the removed executor construction starts a second escalation", async () => {
    const key = {};
    let correctInitiations = 0;
    let defectiveInitiations = 0;
    let correctInner: Promise<string> | null = null;

    const correctMap = new WeakMap<object, Promise<string>>();
    let correctReentered = false;
    const correct = (): Promise<string> => {
      const existing = correctMap.get(key);
      if (existing !== undefined) return existing;
      let settle!: (value: string) => void;
      const promise = new Promise<string>((resolve) => {
        settle = resolve;
      });
      // Publish BEFORE scheduling: this is the construction under test.
      correctMap.set(key, promise);
      queueMicrotask(() => {
        correctInitiations += 1;
        if (!correctReentered) {
          correctReentered = true;
          correctInner = correct();
        }
        settle("stopped");
      });
      return promise;
    };

    const defectiveMap = new WeakMap<object, Promise<string>>();
    let defectiveReentered = false;
    const defective = (): Promise<string> => {
      const existing = defectiveMap.get(key);
      if (existing !== undefined) return existing;
      // The removed shape: `new Promise((resolve) => resolve(invokeStopSafely()))`.
      const promise = new Promise<string>((resolve) => {
        defectiveInitiations += 1;
        if (!defectiveReentered) {
          defectiveReentered = true;
          // The executor runs inside the constructor, before the map entry
          // exists, so this re-entry finds nothing and escalates a second time.
          void defective();
        }
        resolve("stopped");
      });
      defectiveMap.set(key, promise);
      return promise;
    };

    const outer = correct();
    await outer;
    expect(correctInitiations).toBe(1);
    expect(correctInner).toBe(outer);

    await defective();
    // The guard FAILS against the removed shape, which is what makes it a guard.
    expect(defectiveInitiations).toBe(2);
  });
});
