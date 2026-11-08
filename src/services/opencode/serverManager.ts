import { spawn, type Subprocess } from "bun";
import fs from "node:fs";
import { OPENCODE_CONFIG, type OpenCodeConfig } from "../../config/opencode";
import {
  getOpenCodeAuthHeaders,
  getOpenCodeAuthMetadata,
  getOpenCodeAuthPassword,
  isSupportedOpenCodeVersion,
  resolveAndValidateManagedBinary,
} from "./runtime";
export { OpenCodeBinaryMissingError } from "./runtime";
import { logger } from "../../lib/logger";
import { OpenCodeDatabaseOwnership, type OpenCodeDatabaseLease } from "./ownership";
import {
  OpenCodeLauncherUnsupportedError,
  OpenCodeProcessOwnershipError,
  resolveManagedLauncher,
  resolveManagedServicePid,
  spawnSuspendedIntoJob,
  terminateProcessById,
  type ManagedProcessJob,
} from "../process-ownership";
import {
  createOpenCodeListeningDiscovery,
  redactServerAnnouncementLine,
  splitCompleteLines,
  type OpenCodeListeningDiscovery,
  type OpenCodeListeningTarget,
} from "./listening";
import {
  OpenCodeCapabilityRefusedError,
  lazyCapabilityRegistry,
  readManagedCapabilities,
  type OpenCodeCompatibilityAssessment,
} from "./compatibility";
import {
  OpenCodeAttemptSupersededError,
  OpenCodeNotReadyError,
  clearManagedTarget,
  installManagedTarget,
  isAttemptActive,
  readShutdownState,
  registerManagedChildStopProvider,
  type AdoptionAttempt,
  type ManagedChildStopProvider,
  type OpenCodeShutdownResult,
} from "./connectionState";

/** Appends a chunk to a bounded tail buffer, keeping only the last `maxBytes`. Pure. */
export function appendTail(tail: string, chunk: string, maxBytes: number): string {
  const next = tail + chunk;
  return next.length <= maxBytes ? next : next.slice(next.length - maxBytes);
}

/** Waits for a child to exit, bounded, without throwing on an already-closed pipe. */
async function waitForExit(child: Subprocess, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([child.exited.then(() => undefined).catch(() => undefined), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Builds the argv for `opencode serve`. Pure.
 *
 * The child is told to bind loopback only, and to ask the kernel for a free
 * port (`--port 0`) instead of accepting a port this process allocated and
 * released. The port the server actually bound is read back from the child's
 * own announcement (see `listening.ts`), so no other process can win the port
 * between selection and bind.
 */
export function buildOpenCodeServeArgs(
  binary: string = OPENCODE_CONFIG.binaryName,
  config: OpenCodeConfig = OPENCODE_CONFIG,
): string[] {
  const args = [
    binary,
    "serve",
    "--port",
    config.kernelAssignedPort,
    "--hostname",
    config.managedBindHostname,
  ];
  // On Windows, .cmd launchers cannot be spawned directly; wrap with cmd /c.
  if (process.platform === "win32" && binary.toLowerCase().endsWith(".cmd")) {
    return ["cmd", "/c", ...args];
  }
  return args;
}

/** Strips the proxy prefix from an inbound path, normalizing to "/". Pure. */
export function stripOpenCodeProxyPrefix(pathname: string): string {
  const prefix = OPENCODE_CONFIG.proxyPathPrefix;
  if (!pathname.startsWith(prefix)) return pathname;
  const rest = pathname.slice(prefix.length);
  return rest === "" ? "/" : rest;
}

/** Thrown when the managed process exits before the server becomes ready. */
export class OpenCodeProcessExitedError extends Error {
  constructor(public readonly exitCode: number) {
    super(`OpenCode server process exited before becoming ready (code ${exitCode})`);
    this.name = "OpenCodeProcessExitedError";
  }
}

/** Thrown when the server does not become reachable within the budget. */
export class OpenCodeReadinessTimeoutError extends Error {
  constructor(timeoutMs: number, port: number | null) {
    super(`OpenCode server did not become ready within ${timeoutMs}ms (port ${port ?? "unknown"})`);
    this.name = "OpenCodeReadinessTimeoutError";
  }
}

/** Thrown when readiness is cancelled during shutdown. */
export class OpenCodeReadinessCancelledError extends Error {
  constructor() {
    super("OpenCode server readiness cancelled during shutdown");
    this.name = "OpenCodeReadinessCancelledError";
  }
}

/** Thrown when the child never announces the loopback address it bound. */
export class OpenCodeListeningTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`OpenCode did not announce a listening URL within ${timeoutMs}ms`);
    this.name = "OpenCodeListeningTimeoutError";
  }
}

/** Inputs for {@link waitForListening}. */
export interface ListeningDeps {
  readonly discovery: OpenCodeListeningDiscovery;
  readonly timeoutMs: number;
  readonly getStopping: () => boolean;
  /** Resolves with the process exit code when the child exits first. */
  readonly exited: Promise<number>;
}

/**
 * Waits for the spawned child to announce its listening URL, bounded.
 *
 * The announcement is the only source of the address; nothing here guesses a
 * port. The wait races three outcomes: the validated announcement, early
 * process exit, and the startup budget. Shutdown during the wait is reported
 * as cancellation rather than as a missing announcement, because the manager,
 * not the child, ended the attempt.
 *
 * @throws {OpenCodeProcessExitedError} when the child exits before announcing.
 * @throws {OpenCodeListeningTimeoutError} when the budget elapses first.
 * @throws {OpenCodeReadinessCancelledError} when shutdown begins.
 * @throws {OpenCodeListeningUrlError | OpenCodeListeningConflictError |
 *   OpenCodeListeningMissingError} from the discovery itself.
 */
export async function waitForListening(deps: ListeningDeps): Promise<OpenCodeListeningTarget> {
  const exitRejection = deps.exited.then((code) => {
    throw new OpenCodeProcessExitedError(code ?? -1);
  });
  // The announcement usually wins the race; the exit promise still settles
  // later, so its rejection is marked handled here.
  void exitRejection.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new OpenCodeListeningTimeoutError(deps.timeoutMs)),
      deps.timeoutMs,
    );
  });
  try {
    const target = await Promise.race([deps.discovery.promise, exitRejection, timeout]);
    if (deps.getStopping()) throw new OpenCodeReadinessCancelledError();
    return target;
  } catch (error) {
    if (deps.getStopping()) throw new OpenCodeReadinessCancelledError();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Resolves the `opencode` binary via PATH. Null when not installed.
 * The resolver is injectable so tests can supply fakes; production always
 * uses the default (`Bun.which`). Pure query otherwise.
 */
export function findOpenCodeBinary(
  which: (name: string) => string | null = Bun.which,
): string | null {
  return which(OPENCODE_CONFIG.binaryName);
}

/** One authenticated OpenCode V2 readiness probe. */
export async function probeOpenCodeInfo(
  baseUrl: string,
  path: string,
  timeoutMs: number,
  authHeaders: Record<string, string>,
  isSupportedVersion: (version: string) => boolean,
): Promise<"ready" | "not_ready"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "GET",
      headers: { Accept: "application/json", ...authHeaders },
      signal: controller.signal,
      redirect: "manual",
    });
    if (response.status !== 200) return "not_ready";
    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== "object") return "not_ready";
    const version = Reflect.get(payload, "version");
    return typeof version === "string" && isSupportedVersion(version) ? "ready" : "not_ready";
  } catch {
    return "not_ready";
  } finally {
    clearTimeout(timer);
  }
}

export interface ReadinessDeps {
  baseUrl: string;
  port: number | null;
  probePath: string;
  authHeaders: Record<string, string>;
  isSupportedVersion: (version: string) => boolean;
  timeoutMs: number;
  pollMs: number;
  getStopping: () => boolean;
  /** Resolves with the process exit code, or rejects with OpenCodeProcessExitedError. */
  exited: Promise<number>;
}

/**
 * Polls the managed server until it is actually reachable over HTTP. This is
 * the authoritative readiness gate: a spawned process is NOT assumed ready.
 * Races the probe loop against process exit and shutdown cancellation, and
 * fails clearly (distinct error types) on each failure mode. Bounded by
 * `timeoutMs` with short `pollMs` intervals.
 */
export async function waitForHttpReady(deps: ReadinessDeps): Promise<void> {
  const {
    baseUrl,
    port,
    probePath,
    authHeaders,
    isSupportedVersion,
    timeoutMs,
    pollMs,
    getStopping,
    exited,
  } = deps;
  const startMs = Date.now();
  const probeTimeout = Math.min(pollMs * 4, timeoutMs);
  let attempt = 0;

  // Process exit must fail readiness immediately, not leave a dangling loop.
  const exitRejection = exited.then((code) => {
    throw new OpenCodeProcessExitedError(code ?? -1);
  });

  while (true) {
    const elapsed = Date.now() - startMs;
    if (getStopping()) {
      logger.error("opencode", "readiness.cancelled", {
        elapsedMs: elapsed,
        attempts: attempt,
      });
      throw new OpenCodeReadinessCancelledError();
    }
    if (elapsed >= timeoutMs) {
      logger.error("opencode", "readiness.timeout", {
        elapsedMs: elapsed,
        attempts: attempt,
        port,
      });
      throw new OpenCodeReadinessTimeoutError(timeoutMs, port);
    }

    attempt++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interval = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, pollMs);
    });

    const outcome = await Promise.race([
      probeOpenCodeInfo(baseUrl, probePath, probeTimeout, authHeaders, isSupportedVersion).then(
        (r) => ({ kind: "probe" as const, r }),
      ),
      exitRejection,
    ]).catch((err: unknown) => {
      // A process exit must fail readiness immediately — never wait out the
      // interval before surfacing it.
      clearTimeout(timer);
      throw err;
    });

    if (outcome.r === "ready") {
      clearTimeout(timer);
      logger.info("opencode", "readiness.ready", {
        elapsedMs: elapsed,
        attempts: attempt,
        port,
      });
      return;
    }
    if (attempt === 1 || attempt % 10 === 0) {
      logger.debug("opencode", "readiness.probe", {
        attempt,
        elapsedMs: elapsed,
        outcome: "not_listening",
        port,
      });
    }

    // Pace the loop. A probe that fails fast (connection refused) resolves
    // immediately, and re-probing at once spins thousands of times per second:
    // that burns CPU and exhausts the logger's per-scope budget, which then
    // hides the readiness outcome itself. Awaiting the interval the probe raced
    // against guarantees at least `pollMs` between attempts; when the interval
    // already elapsed this resolves immediately, so a slow probe is never
    // delayed twice.
    await interval;
  }
}

/** One start reservation's lifecycle state. */
export type ManagedStartState = "pending" | "fulfilled" | "rejected";

/** Why a child is being asked to stop. */
export type ManagedCleanupCause = "shutdown" | "start-failure" | "fallback" | "attempt" | "manager";

/** Who asked for a child to stop: an attempt id, or a fixed manager/shutdown role. */
export type ManagedCleanupRequester = AdoptionAttempt | "shutdown" | "manager";

/** A deferred retry trigger for a cleanup request that could not initiate (§3.4). */
export type ManagedCleanupTrigger = "T1" | "T2" | "T3" | "T4";

/**
 * One acquisition of the shared managed start (§3.4.1). The handle keeps its
 * own waiter so the caller can release its share exactly once.
 */
export interface ManagedStartHandle {
  readonly startId: number;
  readonly promise: Promise<string>;
  child(): Subprocess | null;
  deliverable(): boolean;
  release(): void;
}

/** A read-only view of the manager's start/cleanup state, for the test seams. */
export interface ManagedStartSnapshot {
  readonly startId: number | null;
  readonly state: ManagedStartState | null;
  readonly withdrawn: boolean;
  readonly child: Subprocess | null;
  readonly currentStartId: number | null;
  readonly managerChild: Subprocess | null;
  readonly port: number | null;
  readonly readyAtMs: number | null;
  readonly readyPromisePresent: boolean;
  /**
   * The promise the manager published for its current start, by identity.
   *
   * `readyPromisePresent` answers "is one published?"; AT3 asks the stronger
   * question — is it the SAME object the record and every caller hold? — so the
   * seam has to expose the promise itself. Test-only, like the rest of this view.
   */
  readonly readyPromise: Promise<string> | null;
  /**
   * Every live start record, by identity, so retirement can be asserted rather
   * than inferred from pointer nullness (AT3).
   */
  readonly startRecords: readonly Readonly<{
    startId: number;
    promise: Promise<string>;
    state: ManagedStartState;
    withdrawn: boolean;
  }>[];
  readonly liveChildren: readonly Subprocess[];
  readonly childStartId: number | null;
  readonly childHasStop: boolean;
  readonly publishedChild: Subprocess | null;
  readonly stopping: boolean;
  readonly unreleasedAttemptIds: readonly number[];
  readonly releasedAttemptIds: readonly number[];
  readonly countedAttemptIds: readonly number[];
  readonly pendingCleanup: Readonly<{
    child: Subprocess;
    state: "pending" | "target-owned";
    triggers: readonly ManagedCleanupTrigger[];
    requestKeys: readonly string[];
  }> | null;
}

interface StartDeferred {
  readonly promise: Promise<string>;
  readonly resolve: (baseUrl: string) => void;
  readonly reject: (error: unknown) => void;
}

interface WaiterRecord {
  readonly attempt: AdoptionAttempt;
  readonly startId: number;
  released: boolean;
  listener: (() => void) | null;
}

interface StartRecord {
  readonly startId: number;
  readonly deferred: StartDeferred;
  readonly owner: AdoptionAttempt | null;
  readonly waiters: Set<WaiterRecord>;
  child: Subprocess | null;
  state: ManagedStartState;
  withdrawn: boolean;
  baseUrl: string | null;
  outcome: unknown;
}

interface CleanupRequest {
  readonly cause: ManagedCleanupCause;
  readonly requester: ManagedCleanupRequester;
}

interface PendingCleanup {
  readonly child: Subprocess;
  readonly requests: Map<string, CleanupRequest>;
  state: "pending" | "target-owned";
  readonly waitingFor: Set<ManagedCleanupTrigger>;
}

function cleanupRequestKey(request: CleanupRequest): string {
  const requester = request.requester;
  if (typeof requester === "string") return JSON.stringify([request.cause, requester, requester]);
  return JSON.stringify([request.cause, "attempt", requester.attemptId]);
}

/**
 * Owns the single managed `opencode serve` child process. Starts lazily on
 * first request, supervises it (auto-restart on unexpected exit, bounded),
 * and stops it gracefully on shutdown.
 *
 * Readiness is gated on an actual HTTP probe (see `waitForHttpReady`), so the
 * base URL is only ever returned once the server is reachable — never merely
 * spawned.
 *
 * Child ownership (§3.4): every child the manager spawns is registered in
 * `liveChildren` synchronously at `spawn()`; a start is a reservation in
 * `startRecords`; an attempt is a waiter on that start, never an owner of the
 * child. Every stop is published once per child in `childStops`, and a
 * cleanup request that cannot initiate records a durable obligation with a
 * named retry trigger instead of being silently dropped.
 */
export class OpenCodeServerManager implements ManagedChildStopProvider {
  private child: Subprocess | null = null;
  private port: number | null = null;
  private readyPromise: Promise<string> | null = null;
  /**
   * When the readiness gate last resolved for the current process, or null when
   * no process is ready. Exposed as {@link msSinceReady} rather than a raw
   * timestamp so a consumer cannot accidentally treat 0 as "just ready".
   */
  private readyAtMs: number | null = null;
  private stopping = false;
  private restartAttempts = 0;
  /** Bounded stdout/stderr tails per child, retained for exit diagnostics. */
  private childDiagnostics = new WeakMap<Subprocess, { stdout: string; stderr: string }>();
  /** Database ownership lease for this manager's lifetime (G2). */
  private readonly databaseLease: OpenCodeDatabaseLease;

  /** All starts this manager has allocated, keyed by start id. */
  private readonly startRecords = new Map<number, StartRecord>();
  /** The reservation a caller may join, or null when none is joinable. */
  private currentStartId: number | null = null;
  /** Waiter records per start id; a start with no entry has no waiters. */
  private readonly startWaiters = new Map<number, Set<WaiterRecord>>();
  /** The start id a spawned child was attributed to, written at `spawn()`. */
  private readonly childStartId = new WeakMap<Subprocess, number>();
  /** Every child this manager owns until its exit is observed. */
  private readonly liveChildren = new Set<Subprocess>();
  private readonly managedJobs = new Map<Subprocess, ManagedProcessJob>();
  private readonly servicePids = new Map<Subprocess, number>();
  /** One durable obligation per child whose cleanup could not initiate. */
  private readonly pendingCleanup = new Map<Subprocess, PendingCleanup>();
  /** One published stop promise per child, stored before anything is signalled. */
  private readonly childStops = new WeakMap<Subprocess, Promise<OpenCodeShutdownResult>>();
  /** The child an installed managed target names, or null when none is installed. */
  private publishedChild: Subprocess | null = null;
  private publishedTargetId: number | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private inRestart = false;
  private nextStartId = 1;

  constructor(
    private readonly config: OpenCodeConfig = OPENCODE_CONFIG,
    databaseLease?: OpenCodeDatabaseLease,
  ) {
    this.databaseLease =
      databaseLease ??
      new OpenCodeDatabaseOwnership({
        databasePathTimeoutMs: config.databasePathTimeoutMs,
      });
  }

  /**
   * Milliseconds since the managed server became reachable, or null when no
   * process is ready.
   *
   * The catalogue window: a server that answered `/api/info` is listening, but
   * OpenCode loads its provider catalogue asynchronously, so for a short while
   * after this clock starts there is legitimately nothing to list. Callers that
   * must not mistake that for "this install has no models" bound their wait on
   * this rather than inventing their own startup heuristic.
   *
   * @returns Milliseconds since readiness, or null when not ready.
   */
  /** Resets the consecutive restart counter to allow fresh start attempts. */
  resetRestartBudget(): void {
    this.restartAttempts = 0;
  }

  /** Explicitly recovers the managed server after restart exhaustion. */
  async recoverManagedServer(): Promise<string> {
    this.resetRestartBudget();
    return this.ensureBaseUrl();
  }

  msSinceReady(): number | null {
    return this.readyAtMs === null ? null : Date.now() - this.readyAtMs;
  }

  /**
   * Whether a managed child currently exists.
   *
   * Deliberately reads the process, not the readiness clock: `msSinceReady`
   * is a catalogue-window timer that is never cleared, so it cannot answer
   * "is there a server to talk to right now". Background work that must never
   * spawn a server on its own (orphan reconciliation) checks this first.
   */
  isRunning(): boolean {
    return this.child !== null && this.port !== null;
  }

  /**
   * Returns the base URL of a running, ready server, starting one if needed.
   *
   * The started child is published as the connection state's managed target
   * after readiness succeeds and before this resolves (§1.9.3). This is the
   * manager-owned path: it has no attempt, holds no waiter, and is the only
   * caller allowed to publish without an attempt guard.
   *
   * @throws {Error} after shutdown has begun.
   * @throws {OpenCodeReadinessCanceledError} when readiness is cancelled.
   */
  async ensureBaseUrl(): Promise<string> {
    if (this.stopping) throw new Error("OpenCode server is shutting down");
    const handle = this.acquireManagedStart(null);
    const baseUrl = await handle.promise;
    // `installManagedTarget` refuses after shutdown. Publishing before this
    // caller returns is what makes the address it receives a usable binding.
    if (handle.deliverable() && this.publishedChild !== handle.child()) {
      this.publishedTargetId = installManagedTarget({
        baseUrl,
        password: getOpenCodeAuthPassword(this.config),
      });
      lazyCapabilityRegistry.bindToService(baseUrl);
      this.publishedChild = handle.child();
    }
    return baseUrl;
  }

  /**
   * Starts (or joins) the managed server for one attempt and publishes it as
   * the connection state's managed target.
   *
   * The guard and the install share one synchronous block after the start
   * resolves: a superseded attempt installs nothing and may only request
   * cleanup of the child it awaited (§3.2).
   *
   * @throws {OpenCodeNotReadyError} when the attempt is refused after shutdown.
   * @throws {OpenCodeAttemptSupersededError} when the attempt is no longer current.
   */
  async ensureManagedTarget(attempt: AdoptionAttempt): Promise<string> {
    const handle = this.acquireManagedStart(attempt);
    let baseUrl: string;
    try {
      baseUrl = await handle.promise;
    } catch (error) {
      handle.release();
      this.requestChildCleanup(handle.child(), { cause: "attempt", requester: attempt });
      throw error;
    }
    if (!isAttemptActive(attempt) || !handle.deliverable()) {
      handle.release();
      this.requestChildCleanup(handle.child(), { cause: "attempt", requester: attempt });
      throw this.attemptRefusal(attempt);
    }
    this.publishedTargetId = installManagedTarget({
      baseUrl,
      password: getOpenCodeAuthPassword(this.config),
      attempt,
    });
    lazyCapabilityRegistry.bindToService(baseUrl);
    this.publishedChild = handle.child();
    handle.release();
    return baseUrl;
  }

  /**
   * Acquires the shared managed start synchronously (§3.4.1).
   *
   * A deliverable start is joined, an in-flight start is joined, and only
   * otherwise is a new start reserved. The reservation, its deferred, the
   * current-start slot and the caller's waiter all exist before the start is
   * scheduled, so a spawn can never precede its own reservation.
   *
   * @throws {OpenCodeNotReadyError} after shutdown.
   * @throws {OpenCodeAttemptSupersededError} when the supplied attempt is stale.
   */
  acquireManagedStart(attempt: AdoptionAttempt | null = null): ManagedStartHandle {
    if (this.stopping) throw new Error("OpenCode server is shutting down");
    if (attempt !== null && !isAttemptActive(attempt)) throw this.attemptRefusal(attempt);
    if (attempt !== null) {
      this.restartAttempts = 0;
    } else if (
      !this.inRestart &&
      this.child === null &&
      this.currentStartId === null &&
      this.restartAttempts >= this.config.maxRestartAttempts
    ) {
      throw new OpenCodeNotReadyError(
        `OpenCode restart retry limit (${this.config.maxRestartAttempts}) exhausted; explicit recovery required`,
      );
    }

    const current =
      this.currentStartId === null ? undefined : this.startRecords.get(this.currentStartId);
    if (current !== undefined) {
      const joinable =
        current.state === "pending" ||
        (current.state === "fulfilled" && this.isDeliverable(current));
      if (joinable) return this.handleFor(current, this.registerWaiter(current, attempt));
    }

    const startId = this.nextStartId;
    this.nextStartId += 1;
    let resolve!: (baseUrl: string) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<string>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    const record: StartRecord = {
      startId,
      deferred: { promise, resolve, reject },
      owner: attempt,
      waiters: new Set(),
      child: null,
      state: "pending",
      withdrawn: false,
      baseUrl: null,
      outcome: undefined,
    };
    this.startRecords.set(startId, record);
    this.currentStartId = startId;
    this.readyPromise = promise;
    const waiter = this.registerWaiter(record, attempt);
    queueMicrotask(() => {
      void this.runManagedStart(record).catch((error: unknown) => {
        this.settleRejected(record, error);
      });
    });
    return this.handleFor(record, waiter);
  }

  private handleFor(record: StartRecord, waiter: WaiterRecord | null): ManagedStartHandle {
    return Object.freeze({
      startId: record.startId,
      promise: record.deferred.promise,
      child: () => record.child,
      deliverable: () => this.isDeliverable(record),
      release: () => {
        if (waiter !== null) this.release(waiter);
      },
    });
  }

  /** The one synchronous "may this child be handed out" predicate (§3.4.1). */
  private isDeliverable(record: StartRecord): boolean {
    return (
      record.state === "fulfilled" &&
      !record.withdrawn &&
      record.child !== null &&
      this.liveChildren.has(record.child) &&
      this.child === record.child &&
      this.port !== null &&
      !this.childStops.has(record.child)
    );
  }

  /** Registers one attempt as a waiter, or returns null for the manager itself. */
  private registerWaiter(
    record: StartRecord,
    attempt: AdoptionAttempt | null,
  ): WaiterRecord | null {
    if (attempt === null) return null;
    const waiter: WaiterRecord = {
      attempt,
      startId: record.startId,
      released: false,
      listener: null,
    };
    record.waiters.add(waiter);
    let waiters = this.startWaiters.get(record.startId);
    if (waiters === undefined) {
      waiters = new Set();
      this.startWaiters.set(record.startId, waiters);
    }
    waiters.add(waiter);
    if (attempt.controller.signal.aborted) {
      // The attempt never waits, so it never holds the child.
      waiter.released = true;
      return waiter;
    }
    const listener = (): void => {
      this.release(waiter);
    };
    waiter.listener = listener;
    attempt.controller.signal.addEventListener("abort", listener, { once: true });
    return waiter;
  }

  /** Releases one waiter once and fires T1 when no counted waiter remains. */
  private release(waiter: WaiterRecord): void {
    if (waiter.released) return;
    waiter.released = true;
    if (waiter.listener !== null) {
      waiter.attempt.controller.signal.removeEventListener("abort", waiter.listener);
      waiter.listener = null;
    }
    this.lifecycleEvent(`release:${waiter.attempt.attemptId}`);
    const record = this.startRecords.get(waiter.startId);
    const remaining = record === undefined ? [] : [...record.waiters].filter((w) => !w.released);
    if (remaining.length === 0) {
      this.startWaiters.delete(waiter.startId);
      this.retryPendingFor(record?.child ?? null);
    }
  }

  private attemptRefusal(attempt: AdoptionAttempt): Error {
    if (readShutdownState().shutdownStarted) return new OpenCodeNotReadyError();
    return new OpenCodeAttemptSupersededError(attempt.attemptId);
  }

  /** Resolves and validates the managed V2 binary; overridable in tests. */
  protected resolveBinary(): string {
    return resolveAndValidateManagedBinary(this.config).path;
  }

  /** Spawns the child process for the managed binary. Extracted for test seams. */
  protected createChild(binaryPath: string = OPENCODE_CONFIG.binaryName): Subprocess {
    const launcher = resolveManagedLauncher(binaryPath);
    if (launcher.kind === "unsupported") {
      throw new OpenCodeLauncherUnsupportedError(launcher.reason);
    }
    const resolvedBinary = launcher.path;
    const password = getOpenCodeAuthPassword(this.config);
    const authEnv = Object.fromEntries(
      this.config.authPasswordChildEnvVars.map((name) => [name, password]),
    );
    const argv = buildOpenCodeServeArgs(resolvedBinary, this.config);
    const commandLine = argv.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");

    if (process.platform !== "win32") {
      // POSIX: Bun.spawn is fine; children inherit the process group.
      const child = spawn(argv, {
        cwd: this.config.serverHomeDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...authEnv },
        detached: true,
      });
      return child;
    }

    const result = spawnSuspendedIntoJob({
      commandLine,
      cwd: this.config.serverHomeDir,
      env: { ...process.env, ...authEnv } as Record<string, string>,
    });

    // Adapt to Subprocess-like shape.
    const child = {
      pid: result.pid,
      stdout: result.stdout,
      stderr: result.stderr,
      exited: result.exited,
      kill: (_signal?: string) => {
        try {
          terminateProcessById(result.pid);
        } catch {
          /* ignore */
        }
      },
    } as unknown as Subprocess;

    this.managedJobs.set(child, result.job);
    // store handles for cleanup
    (child as any).__procHandle = result.processHandle;
    (child as any).__threadHandle = result.threadHandle;
    return child;
  }

  /** Resolves the child's announced loopback target. Extracted for test seams. */
  protected awaitListening(
    discovery: OpenCodeListeningDiscovery,
    child: Subprocess,
  ): Promise<OpenCodeListeningTarget> {
    return waitForListening({
      discovery,
      timeoutMs: this.config.startupTimeoutMs,
      getStopping: () => this.shutdownBegun(),
      exited: child.exited,
    });
  }

  /** Runs the essential-capability gate. Extracted for deterministic test seams. */
  protected awaitManagedCapabilities(
    baseUrl: string,
    port: number,
  ): Promise<OpenCodeCompatibilityAssessment> {
    return readManagedCapabilities({
      origin: baseUrl,
      password: getOpenCodeAuthPassword(this.config),
      timeoutMs: this.config.discoveryProbeTimeoutMs,
    }).then((assessment) => {
      if (assessment.status === "degraded") {
        logger.warn("opencode", "opencode.capabilities_degraded", {
          port,
          version: assessment.capabilities.version,
          missing: assessment.missingOptional,
        });
      } else if (assessment.status === "indeterminate") {
        // A body-read failure after readiness is not proof of absence. The
        // managed child carries on; the feature's own request reports the truth.
        logger.warn("opencode", "opencode.capabilities_indeterminate", {
          port,
          version: assessment.capabilities.version,
          unknown: assessment.unknownEssential,
        });
      } else {
        logger.info("opencode", "opencode.capabilities", {
          port,
          status: assessment.status,
          version: assessment.capabilities.version,
        });
      }
      return assessment;
    });
  }

  /** Runs the readiness gate. Extracted for deterministic test seams. */
  protected awaitReadiness(deps: ReadinessDeps): Promise<void> {
    return waitForHttpReady(deps);
  }

  /** Test-only observation hook; production performs no work here. */
  protected lifecycleEvent(_event: string): void {}

  /** Whether shutdown has begun, by either the manager or the connection state. */
  private shutdownBegun(): boolean {
    return this.stopping || readShutdownState().shutdownStarted;
  }

  private async runManagedStart(record: StartRecord): Promise<void> {
    if (this.shutdownBegun()) throw new OpenCodeReadinessCancelledError();
    // Preflight before spawning: a missing or unsupported binary must surface
    // as an actionable error, never as a spawn failure deep in startup.
    const binary = this.resolveBinary();
    fs.mkdirSync(this.config.serverHomeDir, { recursive: true });
    // Resolve the database the child will use and take the per-path lease
    // BEFORE spawning. A foreign holder or another TBAi backend is a refusal,
    // not a second server.
    const dbPath = await this.databaseLease.acquire(binary, this.config.serverHomeDir);
    if (this.shutdownBegun()) {
      this.databaseLease.release();
      throw new OpenCodeReadinessCancelledError();
    }
    const discovery = createOpenCodeListeningDiscovery(this.config);
    const child = this.createChild(binary);

    // Spawn attribution: one synchronous block, before the first await, before
    // drainStreams and before the exit hook. Manager ownership begins here even
    // if the reservation has meanwhile been superseded. The port is unknown
    // until the child announces it, so it stays null until then.
    this.liveChildren.add(child);
    this.childStartId.set(child, record.startId);
    record.child = child;
    const reservationCurrent =
      this.currentStartId === record.startId && !record.withdrawn && !this.shutdownBegun();
    if (reservationCurrent) {
      this.child = child;
      this.port = null;
      this.readyAtMs = null;
    }

    // Drain the child's pipes so a verbose server can never block on a full
    // stdout/stderr buffer. The same reader feeds the listening discovery, so
    // the announcement is captured from this child's own pipe only.
    this.drainStreams(child, discovery);
    child.exited
      .then((code) => this.onExit(child, record.startId, code ?? -1))
      .catch(() => undefined);

    if (!reservationCurrent) {
      // Never adopted through the current-child pointer; still owned until exit.
      if (this.shutdownBegun()) throw new OpenCodeReadinessCancelledError();
      throw new OpenCodeAttemptSupersededError(record.owner?.attemptId ?? -1);
    }

    const startMs = Date.now();
    const target = await this.awaitListening(discovery, child);
    if (this.currentStartId !== record.startId || record.withdrawn) {
      throw new OpenCodeReadinessCancelledError();
    }
    if (this.shutdownBegun()) throw new OpenCodeReadinessCancelledError();
    // Only the current child may publish a port. A child whose reservation lost
    // the slot may still announce; that address is not handed out.
    if (this.child !== child) {
      throw new OpenCodeAttemptSupersededError(record.owner?.attemptId ?? -1);
    }
    this.port = target.port;
    const baseUrl = target.baseUrl;
    logger.info("opencode", "readiness.start", {
      port: target.port,
      pid: child.pid,
      reused: false,
      baseUrl,
      managedMode: getOpenCodeAuthMetadata(this.config).source,
    });

    // Readiness shares the startup budget with the announcement wait, so the
    // whole start remains bounded by one `startupTimeoutMs`.
    const readinessBudgetMs = Math.max(1, this.config.startupTimeoutMs - (Date.now() - startMs));
    await this.awaitReadiness({
      baseUrl,
      port: target.port,
      probePath: this.config.readinessProbePath,
      authHeaders: getOpenCodeAuthHeaders(this.config),
      isSupportedVersion: (version) => isSupportedOpenCodeVersion(version, this.config),
      timeoutMs: readinessBudgetMs,
      pollMs: this.config.readyPollMs,
      getStopping: () => this.shutdownBegun(),
      exited: child.exited,
    });
    // Readiness proves the child LISTENS. It does not prove the child is the
    // only process holding the database. The pre-spawn check can be raced by a
    // foreign process that opens the file while this child boots, so verify
    // again now and exclude only this child.
    const servicePid = await resolveManagedServicePid(child.pid, dbPath);
    this.servicePids.set(child, servicePid);
    if (process.platform === "win32" && servicePid !== child.pid) {
      const job = this.managedJobs.get(child);
      if (job !== undefined && !job.isInJob(servicePid)) {
        // The service escaped the per-instance job: fail closed.
        try {
          job.terminate();
        } catch {
          /* ignore */
        }
        job.close();
        this.managedJobs.delete(child);
        try {
          terminateProcessById(servicePid);
        } catch {
          /* ignore */
        }
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
        throw new OpenCodeProcessOwnershipError(
          `managed OpenCode service (pid ${servicePid}) escaped its process job`,
        );
      }
    }
    if (dbPath !== null) await this.databaseLease.verifyChild(servicePid, dbPath);
    if (this.currentStartId !== record.startId || record.withdrawn) {
      throw new OpenCodeReadinessCancelledError();
    }
    if (this.shutdownBegun()) throw new OpenCodeReadinessCancelledError();
    // B7: the numeric gate says the build is a plausible stable release; this
    // proves it serves the API TBAi calls. An essential route answering 404/405
    // refuses the start instead of handing out a URL that cannot work.
    const capabilities = await this.awaitManagedCapabilities(baseUrl, target.port);
    if (this.currentStartId !== record.startId || record.withdrawn || this.shutdownBegun()) {
      throw new OpenCodeReadinessCancelledError();
    }
    if (capabilities.status === "incompatible") {
      throw new OpenCodeCapabilityRefusedError(
        capabilities.capabilities.version,
        capabilities.missingEssential,
      );
    }
    // The moment this process became reachable. `waitForHttpReady` proves the
    // server is LISTENING — not that its provider catalogue has finished
    // loading — and the two are seconds apart. Consumers that need the
    // catalogue (rather than just a URL) use this to tell "still starting"
    // from "genuinely empty", instead of guessing with their own heuristic.
    if (this.child === child) this.readyAtMs = Date.now();
    if (this.stabilityTimer !== null) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    const stabilityMs = this.config.stabilityPeriodMs ?? 5_000;
    if (stabilityMs <= 0) {
      this.restartAttempts = 0;
    } else {
      this.stabilityTimer = setTimeout(() => {
        this.stabilityTimer = null;
        if (this.child === child && !this.stopping) {
          logger.info("opencode", "opencode.stable", { port: target.port, pid: child.pid });
          this.restartAttempts = 0;
        }
      }, stabilityMs);
    }
    logger.info("opencode", "opencode.spawn", { port: target.port, pid: child.pid });
    this.settleFulfilled(record, baseUrl);
  }

  /**
   * Settles one start as fulfilled, exactly once (§3.4).
   *
   * Separate from {@link settleRejected} rather than one branch on a union: the
   * tests project compiles this file with `strictNullChecks: false`, where
   * TypeScript does not narrow a discriminated union at all, so a single
   * `if (outcome.ok)` body cannot read `outcome.error` there.
   */
  private settleFulfilled(record: StartRecord, baseUrl: string): void {
    if (record.state !== "pending") return;
    record.state = "fulfilled";
    record.baseUrl = baseUrl;
    record.outcome = undefined;
    record.deferred.resolve(baseUrl);
    // T2: the start settled. Obligations for its child are retried once, after
    // delivery is complete.
    if (record.child !== null) this.retryPendingFor(record.child);
  }

  /**
   * Settles one start as failed, exactly once (§3.4). The order is fixed:
   * state, releases, pointer detachment by identity, one cleanup request,
   * identity-guarded binding eviction, then delivery of the outcome.
   */
  private settleRejected(record: StartRecord, error: unknown): void {
    if (record.state !== "pending") return;
    record.state = "rejected";
    record.baseUrl = null;
    record.outcome = error;
    this.lifecycleEvent("settle:state=rejected");
    for (const waiter of [...record.waiters]) this.releaseForSettlement(waiter);
    if (record.child !== null && this.child === record.child) {
      this.child = null;
      this.port = null;
      this.readyAtMs = null;
      this.lifecycleEvent("detach-current-pointers-by-identity");
    }
    if (record.child !== null && this.liveChildren.has(record.child)) {
      this.requestChildCleanup(record.child, {
        cause: "start-failure",
        requester: record.owner ?? "manager",
      });
    }
    if (this.readyPromise === record.deferred.promise) this.readyPromise = null;
    if (this.currentStartId === record.startId) this.currentStartId = null;
    if (record.child === null) this.startRecords.delete(record.startId);
    this.lifecycleEvent("reject:shared");
    record.deferred.reject(error);
    // T2: the start settled, after the settlement's own cleanup request and
    // delivery are complete.
    if (record.child !== null) this.retryPendingFor(record.child);
  }

  /** Releases a waiter during settlement without firing its trigger. */
  private releaseForSettlement(waiter: WaiterRecord): void {
    if (waiter.released) return;
    waiter.released = true;
    if (waiter.listener !== null) {
      waiter.attempt.controller.signal.removeEventListener("abort", waiter.listener);
      waiter.listener = null;
    }
    this.startWaiters.delete(waiter.startId);
    this.lifecycleEvent(`release:${waiter.attempt.attemptId}`);
  }

  /**
   * Reads child stdout/stderr into a bounded tail buffer (never blocks the pipe)
   * and feeds stdout to the listening discovery.
   *
   * Lines are assembled before the tail is retained so `server password <token>`
   * is redacted as a whole; a line longer than `listeningLineMaxBytes` is
   * dropped up to its newline rather than truncated, so neither a URL nor a
   * secret can be matched or retained as a fragment. The discovery sees the raw
   * chunks and applies its own bound; it never stores text.
   */
  private drainStreams(child: Subprocess, discovery: OpenCodeListeningDiscovery): void {
    const record = { stdout: "", stderr: "" };
    this.childDiagnostics.set(child, record);

    const drain = (
      stream: unknown,
      append: (line: string) => void,
      onEnd: () => void,
      feedDiscovery: ((text: string) => void) | null,
    ): void => {
      if (!stream || typeof stream === "number") {
        onEnd();
        return;
      }
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let discarding = false;
      const emit = (line: string): void => {
        if (discarding) {
          discarding = false;
          return;
        }
        append(redactServerAnnouncementLine(line));
      };
      void (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            if (!text) continue;
            feedDiscovery?.(text);
            pending += text;
            const split = splitCompleteLines(pending);
            pending = split.rest;
            for (const line of split.lines) emit(line);
            if (pending.length > this.config.listeningLineMaxBytes) {
              pending = "";
              discarding = true;
            }
          }
        } catch {
          /* stream closed */
        } finally {
          if (pending && !discarding) append(redactServerAnnouncementLine(pending));
          onEnd();
        }
      })();
    };

    const appendLine = (key: "stdout" | "stderr", line: string): void => {
      record[key] = appendTail(record[key], `${line}\n`, this.config.diagnosticTailBytes);
    };
    drain(
      child.stdout,
      (line) => appendLine("stdout", line),
      () => discovery.end(),
      (text) => discovery.push(text),
    );
    drain(
      child.stderr,
      (line) => appendLine("stderr", line),
      () => undefined,
      null,
    );
  }

  /** Bounded stdout/stderr tail captured for a child (diagnostics seam). */
  protected diagnosticsFor(child: Subprocess): { stdout: string; stderr: string } | undefined {
    return this.childDiagnostics.get(child);
  }

  /**
   * Exit is per-child and identity-guarded (§3.4.1). Pointer nullness is never
   * used as a proxy for child identity: a stale child's late exit may reap only
   * itself and must not disturb a newer child's pointers, binding or recovery.
   */
  private onExit(child: Subprocess, startId: number, code: number): void {
    const record = this.startRecords.get(startId);
    this.liveChildren.delete(child);
    // Reap the per-instance job if the child exited on its own.
    const job = this.managedJobs.get(child);
    if (job !== undefined) {
      try {
        job.close();
      } catch {
        /* ignore */
      }
      this.managedJobs.delete(child);
    }
    this.servicePids.delete(child);
    // A confirmed exit satisfies every obligation for that child.
    this.pendingCleanup.delete(child);
    if (record !== undefined && record.child === child) this.startRecords.delete(startId);
    if (this.child !== child) return;

    const port = this.port;
    const intentionallyStopped = this.childStops.has(child);
    if (!this.stopping && !intentionallyStopped) {
      const tails = this.diagnosticsFor(child);
      logger.warn("opencode", "opencode.unexpected_exit", {
        code,
        pid: child.pid,
        port,
        attempt: this.restartAttempts + 1,
        maxAttempts: this.config.maxRestartAttempts,
        stderrTail: tails?.stderr ?? "",
        stdoutTail: tails?.stdout ?? "",
      });
    }

    if (this.child === child) {
      if (this.stabilityTimer !== null) {
        clearTimeout(this.stabilityTimer);
        this.stabilityTimer = null;
      }
      this.child = null;
      this.port = null;
      this.readyAtMs = null;
    }
    if (this.currentStartId === startId) this.currentStartId = null;
    if (record !== undefined && this.readyPromise === record.deferred.promise) {
      this.readyPromise = null;
    }
    if (this.publishedChild === child) {
      if (this.publishedTargetId !== null) {
        clearManagedTarget(this.publishedTargetId);
        this.publishedTargetId = null;
      }
      this.publishedChild = null;
    }

    if (this.shutdownBegun() || intentionallyStopped) return;
    // A newer reservation already owns recovery; do not create a competing start.
    if (this.currentStartId !== null) return;
    if (this.restartAttempts >= this.config.maxRestartAttempts) return;

    this.restartAttempts += 1;
    this.inRestart = true;
    logger.info("opencode", "opencode.restart", {
      attempt: this.restartAttempts,
      maxAttempts: this.config.maxRestartAttempts,
      port,
    });
    void this.ensureBaseUrl()
      .catch((err: unknown) => {
        // Shutdown may have intervened mid-restart; that is not a restart failure.
        if (this.shutdownBegun()) return;
        logger.error("opencode", "opencode.restart_failed", {
          message: err instanceof Error ? err.message : String(err),
          attempt: this.restartAttempts,
          maxAttempts: this.config.maxRestartAttempts,
          port,
        });
      })
      .finally(() => {
        this.inRestart = false;
      });
  }

  /** Waiters that count against C1: unreleased and belonging to a live attempt. */
  private countedWaiters(child: Subprocess): WaiterRecord[] {
    const startId = this.childStartId.get(child);
    if (startId === undefined) return [];
    const record = this.startRecords.get(startId);
    if (record === undefined) return [];
    return [...record.waiters].filter(
      (waiter) => !waiter.released && isAttemptActive(waiter.attempt),
    );
  }

  private recordForChild(child: Subprocess): StartRecord | null {
    const startId = this.childStartId.get(child);
    if (startId === undefined) return null;
    return this.startRecords.get(startId) ?? null;
  }

  /**
   * The one decision point for whether a child may be stopped (§3.4).
   *
   * Joining a published stop happens first and is unconditional. Otherwise the
   * three conditions are evaluated; a request that cannot initiate is recorded
   * with its failing trigger, never silently refused.
   */
  protected requestChildCleanup(
    child: Subprocess | null,
    request: CleanupRequest,
  ): Promise<OpenCodeShutdownResult> | null {
    this.lifecycleEvent("cleanup:entered");
    if (child === null) return null;
    const published = this.childStops.get(child);
    if (published !== undefined) return published;

    const record = this.recordForChild(child);
    const failing: ManagedCleanupTrigger[] = [];
    if (request.requester !== "shutdown") {
      if (this.publishedChild === child) failing.push("T3");
      if (record !== null && record.state === "pending") failing.push("T2");
      if (this.countedWaiters(child).length > 0) failing.push("T1");
    }

    if (failing.length > 0) {
      let obligation = this.pendingCleanup.get(child);
      if (obligation === undefined) {
        obligation = {
          child,
          requests: new Map(),
          state: "pending",
          waitingFor: new Set(),
        };
        this.pendingCleanup.set(child, obligation);
      }
      const key = cleanupRequestKey(request);
      if (!obligation.requests.has(key)) obligation.requests.set(key, request);
      obligation.state = failing.includes("T3") ? "target-owned" : "pending";
      obligation.waitingFor.clear();
      for (const trigger of failing) obligation.waitingFor.add(trigger);
      logger.debug("opencode", "opencode.cleanup_deferred", {
        pid: child.pid,
        condition: failing.includes("T3") ? "C3" : failing.includes("T2") ? "C2" : "C1",
        triggers: failing,
        cause: request.cause,
        requester: typeof request.requester === "string" ? request.requester : "attempt",
      });
      return null;
    }

    // A settled, still-handable start is withdrawn in one synchronous block
    // before the stop is published, so no later caller can receive a doomed URL.
    if (record !== null && record.state === "fulfilled") this.withdrawReservation(record);
    this.pendingCleanup.delete(child);
    return this.stopChild(child);
  }

  /**
   * Marks a reservation withdrawn and detaches only the pointers that still
   * identify it. A newer reservation or newer child is never touched.
   */
  private withdrawReservation(record: StartRecord): void {
    record.withdrawn = true;
    if (this.currentStartId === record.startId) this.currentStartId = null;
    if (this.readyPromise === record.deferred.promise) this.readyPromise = null;
    if (record.child !== null && this.child === record.child) {
      this.child = null;
      this.port = null;
      this.readyAtMs = null;
    }
  }

  /**
   * Publishes the one stop promise for a child, before anything is signalled.
   *
   * Steps 1–3 are synchronous and invoke no process API; re-entrant callers
   * therefore find the published promise and join it (§3.4, RC16).
   */
  private stopChild(child: Subprocess): Promise<OpenCodeShutdownResult> {
    const existing = this.childStops.get(child);
    if (existing !== undefined) return existing;
    let settle!: (result: OpenCodeShutdownResult) => void;
    const promise = new Promise<OpenCodeShutdownResult>((resolve) => {
      settle = resolve;
    });
    this.childStops.set(child, promise);
    this.pendingCleanup.delete(child);
    this.lifecycleEvent("stop:published");
    // One settlement path for every outcome. A failed stop is reported exactly
    // once with the child's pid, and the published promise always RESOLVES:
    // a throw and a returned rejection both arrive here as `{ok:false}` (§1.9.3.2).
    let settled = false;
    const finish = (result: OpenCodeShutdownResult): void => {
      if (settled) return;
      settled = true;
      if (!result.ok) {
        const failure = "error" in result ? result.error : null;
        logger.warn("opencode", "opencode.child_stop_failed", {
          pid: child.pid,
          outcome: "reason" in result ? result.reason : "error",
          errorType: failure instanceof Error ? failure.name : undefined,
        });
      }
      settle(result);
    };
    queueMicrotask(() => {
      let operation: Promise<OpenCodeShutdownResult>;
      try {
        operation = this.runStopSequence(child);
      } catch (error) {
        finish({ ok: false, error });
        return;
      }
      operation.then(finish, (error: unknown) => finish({ ok: false, error }));
    });
    return promise;
  }

  /**
   * SIGTERM, a bounded wait, SIGKILL, and a second bounded wait. A stop that
   * cannot confirm termination is reported as such; it never claims the
   * process is gone (§6.5).
   */
  protected async runStopSequence(child: Subprocess): Promise<OpenCodeShutdownResult> {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already exited */
    }
    await waitForExit(child, this.config.opencodeChildStopGraceMs);
    if (this.hasExited(child)) {
      await this.cleanupManagedJob(child);
      return { ok: true };
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
    await waitForExit(child, this.config.opencodeChildStopKillMs);
    if (this.hasExited(child)) {
      await this.cleanupManagedJob(child);
      return { ok: true };
    }
    await this.cleanupManagedJob(child);
    return { ok: false, reason: "termination_unconfirmed", pid: child.pid };
  }

  private async cleanupManagedJob(child: Subprocess): Promise<void> {
    const job = this.managedJobs.get(child);
    if (job === undefined) return;
    try {
      job.terminate();
    } catch {
      /* ignore */
    }
    job.close();
    this.managedJobs.delete(child);
    // Best-effort: terminate any tracked service pid that survived.
    const servicePid = this.servicePids.get(child);
    if (servicePid !== undefined && servicePid !== child.pid) {
      try {
        terminateProcessById(servicePid);
      } catch {
        /* ignore */
      }
    }
    this.servicePids.delete(child);
  }

  /** Whether the child's exit has been observed, without awaiting it again. */
  private hasExited(child: Subprocess): boolean {
    return !this.liveChildren.has(child);
  }

  /** Reissues every preserved request for a child whose trigger just fired. */
  private retryPendingFor(child: Subprocess | null): void {
    if (child === null) return;
    const obligation = this.pendingCleanup.get(child);
    if (obligation === undefined) return;
    if (obligation.state === "target-owned") return;
    for (const request of [...obligation.requests.values()]) {
      const stop = this.requestChildCleanup(child, request);
      if (stop !== null) return;
      const current = this.pendingCleanup.get(child);
      if (current === undefined || current.state === "target-owned") return;
    }
  }

  /**
   * T3: the exact installed target that named this child was cleared. The
   * obligation becomes pending again and its preserved requests are reissued.
   */
  clearPublishedTarget(): void {
    const child = this.publishedChild;
    if (this.publishedTargetId !== null) {
      clearManagedTarget(this.publishedTargetId);
      this.publishedTargetId = null;
    }
    this.publishedChild = null;
    if (child === null) return;
    const obligation = this.pendingCleanup.get(child);
    if (obligation !== undefined && obligation.state === "target-owned") {
      obligation.state = "pending";
      this.retryPendingFor(child);
    }
  }

  /**
   * Shutdown step 4's synchronous half: clear the cached binding and copy the
   * live-child registry before any per-child decision is collected (§1.9.3.2).
   */
  private clearBindingForShutdown(): void {
    if (this.currentStartId !== null) {
      const record = this.startRecords.get(this.currentStartId);
      if (record !== undefined) record.withdrawn = true;
    }
    this.currentStartId = null;
    this.readyPromise = null;
    if (this.stabilityTimer !== null) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    this.publishedTargetId = null;
    this.publishedChild = null;
  }

  /** Returns one already-published stop promise per managed child still owned. */
  stopAllChildrenForShutdown(): readonly Promise<OpenCodeShutdownResult>[] {
    const children = [...this.liveChildren];
    this.clearBindingForShutdown();
    return children.map(
      (child) =>
        this.requestChildCleanup(child, { cause: "shutdown", requester: "shutdown" }) ??
        Promise.resolve({ ok: true } as const),
    );
  }

  /** Stops every managed child gracefully, joining any stop already running. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const stops = this.stopAllChildrenForShutdown();
    await Promise.allSettled(stops);
    this.child = null;
    this.port = null;
    this.readyAtMs = null;
    this.readyPromise = null;
    this.currentStartId = null;
    this.databaseLease.release();
  }

  /**
   * Read-only snapshot of the start/cleanup state (§3.4.1). Test-only: no
   * production call site exists, and it exposes no mutator.
   */
  protected startStateSnapshot(child?: Subprocess): ManagedStartSnapshot {
    const startId =
      child !== undefined ? (this.childStartId.get(child) ?? null) : this.currentStartId;
    const record = startId === null ? undefined : this.startRecords.get(startId);
    const recordChild = record?.child ?? null;
    const obligation = child === undefined ? undefined : this.pendingCleanup.get(child);
    return Object.freeze({
      startId,
      state: record?.state ?? null,
      withdrawn: record?.withdrawn ?? false,
      child: recordChild,
      currentStartId: this.currentStartId,
      managerChild: this.child,
      port: this.port,
      readyAtMs: this.readyAtMs,
      readyPromisePresent: this.readyPromise !== null,
      readyPromise: this.readyPromise,
      startRecords: Object.freeze(
        [...this.startRecords.values()].map((live) =>
          Object.freeze({
            startId: live.startId,
            promise: live.deferred.promise,
            state: live.state,
            withdrawn: live.withdrawn,
          }),
        ),
      ),
      liveChildren: Object.freeze([...this.liveChildren]),
      childStartId: recordChild === null ? null : (this.childStartId.get(recordChild) ?? null),
      childHasStop: recordChild !== null && this.childStops.has(recordChild),
      publishedChild: this.publishedChild,
      stopping: this.stopping,
      unreleasedAttemptIds: Object.freeze(
        record === undefined
          ? []
          : [...record.waiters]
              .filter((waiter) => !waiter.released)
              .map((w) => w.attempt.attemptId),
      ),
      releasedAttemptIds: Object.freeze(
        record === undefined
          ? []
          : [...record.waiters].filter((waiter) => waiter.released).map((w) => w.attempt.attemptId),
      ),
      countedAttemptIds: Object.freeze(
        record === undefined
          ? []
          : [...record.waiters]
              .filter((waiter) => !waiter.released && isAttemptActive(waiter.attempt))
              .map((w) => w.attempt.attemptId),
      ),
      pendingCleanup:
        obligation === undefined
          ? null
          : Object.freeze({
              child: obligation.child,
              state: obligation.state,
              triggers: Object.freeze([...obligation.waitingFor]),
              requestKeys: Object.freeze([...obligation.requests.keys()]),
            }),
    });
  }
}

/** Shared singleton used by the route layer and session service. */
export const openCodeServerManager = new OpenCodeServerManager();

/** Route the connection state's shutdown join at the manager that owns children. */
registerManagedChildStopProvider(openCodeServerManager);
