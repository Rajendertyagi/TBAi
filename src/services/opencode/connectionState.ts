import { randomUUID } from "node:crypto";
import {
  OpenCodeAuthScopeError,
  createGatedTransport,
  type OpenCodeTransport,
  type TransportCredential,
} from "./http";
import { buildOpenCodeBasicAuthHeader, getOpenCodeAuthPassword } from "./runtime";

/**
 * The single owner of the OpenCode connection target, the counters that
 * describe it, and the one shutdown latch.
 *
 * Managed-only runtime: TBAi owns exactly one managed `opencode serve` target.
 * External/adopted targets and adoption attempts are not supported.
 */

/** A credential for the managed child TBAi starts and owns. */
export type OpenCodeManagedCredential = Readonly<{
  kind: "managed";
  /** Non-empty by construction. */
  password: string;
}>;

/** What the runtime is currently bound to. */
export type OpenCodeTarget =
  | Readonly<{ mode: "unresolved" }>
  | Readonly<{
      mode: "managed";
      targetId: number;
      baseUrl: string;
      origin: string;
      credential: OpenCodeManagedCredential;
      profileId?: string;
      dataLocation?: string;
    }>;

/**
 * The one connection-state value. `revision` is diagnostics only, `shutdownEpoch`
 * is the initiation counter, and `shutdownStarted` is the terminal latch.
 */
export type OpenCodeConnectionState = Readonly<{
  readonly revision: number;
  readonly shutdownEpoch: number;
  readonly shutdownStarted: boolean;
  readonly target: OpenCodeTarget;
}>;

export type { OpenCodeTransport };

/** One logical request bound to one snapshot. Immutable. */
export type OpenCodeRequestContext = Readonly<{
  readonly mode: "managed";
  readonly targetId: number;
  /** Canonical, slash-free origin. */
  readonly baseUrl: string;
  readonly origin: string;
  readonly credential: OpenCodeManagedCredential;
  readonly authHeaders: Readonly<Record<string, string>>;
  /** Diagnostics only — never gates a request. */
  readonly revision: number;
  /** Revocation counter; the transport re-checks it with the latch. */
  readonly shutdownEpoch: number;
  readonly transport: OpenCodeTransport;
  readonly profileId?: string;
}>;

/** Thrown when no usable target exists, or when shutdown has begun. */
export class OpenCodeNotReadyError extends Error {
  readonly code = "OPENCODE_NOT_READY";

  constructor(message = "OpenCode is not ready: no target is installed or shutdown has begun") {
    super(message);
    this.name = "OpenCodeNotReadyError";
  }
}

/** Thrown when shutdown has invalidated an operation or a captured context. */
export class OpenCodeContextInvalidatedError extends Error {
  readonly code = "OPENCODE_CONTEXT_INVALIDATED";

  constructor(
    message = "OpenCode request context was invalidated by shutdown or target invalidation",
  ) {
    super(message);
    this.name = "OpenCodeContextInvalidatedError";
  }
}

/** Thrown when an install is asked to accept an unusable credential. */
export class OpenCodeCredentialMissingError extends Error {
  readonly code = "OPENCODE_CREDENTIAL_MISSING";

  constructor(message = "OpenCode target requires a non-empty credential password") {
    super(message);
    this.name = "OpenCodeCredentialMissingError";
  }
}

/** Thrown when a target is not a loopback HTTP(S) origin. */
export class OpenCodeTargetOriginError extends Error {
  readonly code = "OPENCODE_TARGET_ORIGIN";

  constructor(message: string) {
    super(message);
    this.name = "OpenCodeTargetOriginError";
  }
}

/** The documented result of one shutdown completion. It resolves, never rejects. */
export type OpenCodeShutdownResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: "termination_unconfirmed"; pid: number }>
  | Readonly<{ ok: false; error: unknown }>;

/**
 * What `beginShutdown()` step 4 joins. The manager registers one of these.
 */
export interface ManagedChildStopProvider {
  /** Returns one already-published stop promise per managed child still owned. */
  stopAllChildrenForShutdown(): readonly Promise<OpenCodeShutdownResult>[];
}

/** The two shutdown fields, read from one snapshot by the transport gate. */
export type OpenCodeShutdownState = Readonly<{
  readonly shutdownEpoch: number;
  readonly shutdownStarted: boolean;
}>;

/** A test-only reader for the shutdown pair. */
export type ShutdownStateReader = () => OpenCodeShutdownState;

const LOOPBACK_HOSTNAMES: readonly string[] = ["127.0.0.1", "::1", "localhost"];

/** The unresolved target is created once and shared; it is immutable. */
const UNRESOLVED_TARGET: OpenCodeTarget = Object.freeze({ mode: "unresolved" });

/** One state value, replaced (never mutated) by every transition. */
let connectionState: OpenCodeConnectionState = Object.freeze({
  revision: 0,
  shutdownEpoch: 0,
  shutdownStarted: false,
  target: UNRESOLVED_TARGET,
});

/** Monotonically increasing target identity counter. */
let nextTargetId = 1;
/** Set of target IDs that were explicitly invalidated after process exit. */
const invalidatedTargetIds = new Set<number>();

/** The published shutdown completion, stored before any external callback can run. */
let shutdownCompletion: Promise<OpenCodeShutdownResult> | null = null;
let shutdownStopProvider: ManagedChildStopProvider | null = null;

/** Test-only override of the shutdown pair. Null in production. */
let shutdownStateReaderOverride: ShutdownStateReader | null = null;

/**
 * Opaque identity of this backend process instance. Generated once per process
 * lifetime so frontend consumers can distinguish a legitimate post-restart
 * target-revision reset from a stale/out-of-order publication.
 */
let backendInstanceId = randomUUID();

/** Returns the current backend process instance identity. */
export function readBackendInstanceId(): string {
  return backendInstanceId;
}

/**
 * Normalizes an origin to `scheme://host:port`, lower-cased, with no trailing
 * slash, no path and no default port.
 *
 * @throws {OpenCodeTargetOriginError} when the value is not an absolute HTTP(S) URL.
 */
export function canonicalizeOpenCodeOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new OpenCodeTargetOriginError("OpenCode target origin is not an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OpenCodeTargetOriginError("OpenCode target origin must use http or https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new OpenCodeTargetOriginError("OpenCode target origin must not carry user information");
  }
  return parsed.origin.toLowerCase();
}

/** Refuses a non-loopback origin. */
export function assertLoopbackOrigin(origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new OpenCodeTargetOriginError("OpenCode target origin is not an absolute URL");
  }
  const hostname = parsed.hostname.toLowerCase();
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (!LOOPBACK_HOSTNAMES.includes(bare)) {
    throw new OpenCodeTargetOriginError("OpenCode managed service must be on a loopback host");
  }
}

function requirePassword(password: string): string {
  if (typeof password !== "string" || password.length === 0) {
    throw new OpenCodeCredentialMissingError();
  }
  return password;
}

/** Innermost-first freeze: credential → target → state. */
function buildState(
  revision: number,
  shutdownEpoch: number,
  shutdownStarted: boolean,
  target: OpenCodeTarget,
): OpenCodeConnectionState {
  return Object.freeze({ revision, shutdownEpoch, shutdownStarted, target });
}

function buildManagedTarget(
  baseUrl: string,
  password: string,
  targetId: number,
  profileId?: string,
  dataLocation?: string,
): OpenCodeTarget {
  const origin = canonicalizeOpenCodeOrigin(baseUrl);
  assertLoopbackOrigin(origin);
  const credential: OpenCodeManagedCredential = Object.freeze({
    kind: "managed",
    password: requirePassword(password),
  });
  return Object.freeze({
    mode: "managed",
    targetId,
    baseUrl: origin,
    origin,
    credential,
    profileId,
    dataLocation,
  });
}

/** One reference read of the current state. Every reader uses this. */
export function readConnectionState(): OpenCodeConnectionState {
  return connectionState;
}

/** Minimal runtime target identity carried by lifecycle notifications. */
export interface OpenCodeRuntimeTargetChange {
  readonly backendInstanceId: string;
  readonly targetRevision: number;
  readonly targetId: number | null;
  readonly mode: "unresolved" | "managed";
}

type RuntimeTargetChangeListener = (change: OpenCodeRuntimeTargetChange) => void;

const runtimeTargetChangeListeners = new Set<RuntimeTargetChangeListener>();

/** Current runtime target identity snapshot for notifications and late subscribers. */
export function readRuntimeTargetChange(): OpenCodeRuntimeTargetChange {
  const state = readConnectionState();
  const target = state.target;
  return Object.freeze({
    backendInstanceId,
    targetRevision: state.revision,
    targetId: target.mode === "unresolved" ? null : target.targetId,
    mode: target.mode,
  });
}

/**
 * Subscribes to runtime target identity changes published after connection-state
 * writes that affect the installed target/revision. Returns an unsubscribe function.
 */
export function subscribeRuntimeTargetChanges(listener: RuntimeTargetChangeListener): () => void {
  runtimeTargetChangeListeners.add(listener);
  return () => {
    runtimeTargetChangeListeners.delete(listener);
  };
}

function publishRuntimeTargetChange(): void {
  if (runtimeTargetChangeListeners.size === 0) return;
  const change = readRuntimeTargetChange();
  for (const listener of Array.from(runtimeTargetChangeListeners)) {
    try {
      listener(change);
    } catch {
      // A subscriber failure must not break state publication or other subscribers.
    }
  }
}

function refuseAfterShutdown(): void {
  if (connectionState.shutdownStarted) throw new OpenCodeContextInvalidatedError();
}

function writeState(next: OpenCodeConnectionState): void {
  connectionState = next;
  publishRuntimeTargetChange();
}

/**
 * Installs a managed target after readiness succeeds.
 * Returns the unique target identity assigned to this installed instance.
 */
export function installManagedTarget(input: {
  readonly baseUrl: string;
  readonly password: string;
  readonly profileId?: string;
  readonly dataLocation?: string;
}): number {
  refuseAfterShutdown();
  const targetId = nextTargetId++;
  const target = buildManagedTarget(
    input.baseUrl,
    input.password,
    targetId,
    input.profileId,
    input.dataLocation,
  );
  writeState(
    buildState(connectionState.revision + 1, connectionState.shutdownEpoch, false, target),
  );
  return targetId;
}

/**
 * Clears the target to `unresolved`. Moves `revision` only.
 * Kept for compatibility with existing callers; managed-only runtime has no attempts.
 */
export function clearTarget(): void {
  refuseAfterShutdown();
  const current = connectionState.target;
  if (current.mode !== "unresolved") {
    invalidatedTargetIds.add(current.targetId);
  }
  writeState(
    buildState(
      connectionState.revision + 1,
      connectionState.shutdownEpoch,
      false,
      UNRESOLVED_TARGET,
    ),
  );
}

/**
 * Invalidates and clears a managed target by target identity.
 */
export function clearManagedTarget(targetId: number): boolean {
  if (connectionState.shutdownStarted) return false;
  const current = connectionState.target;
  if (current.mode !== "managed") return false;
  if (current.targetId !== targetId) return false;

  invalidatedTargetIds.add(targetId);
  writeState(
    buildState(
      connectionState.revision + 1,
      connectionState.shutdownEpoch,
      false,
      UNRESOLVED_TARGET,
    ),
  );
  return true;
}

/** Check whether a target identity has been invalidated. */
export function isTargetInvalidated(targetId: number): boolean {
  return invalidatedTargetIds.has(targetId);
}

/** Reads the shutdown pair from ONE state snapshot. The only production reader. */
export function readShutdownState(): OpenCodeShutdownState {
  const override = shutdownStateReaderOverride;
  if (override) return Object.freeze(override());
  const state = connectionState;
  return Object.freeze({
    shutdownEpoch: state.shutdownEpoch,
    shutdownStarted: state.shutdownStarted,
  });
}

/** What {@link createBoundedTransport} binds one transport to. */
export interface BoundedTransportBinding {
  /** Canonical origin of the installed target. */
  readonly origin: string;
  /** The frozen credential instance the connection state holds. */
  readonly credential: OpenCodeManagedCredential;
  /** The epoch captured with the target; the transport's initiation gate. */
  readonly shutdownEpoch: number;
  /** Unique target identity; if invalidated, transport refuses requests. */
  readonly targetId?: number;
}

/**
 * Binds one transport to one captured origin, credential and shutdown epoch.
 */
export function createBoundedTransport(binding: BoundedTransportBinding): OpenCodeTransport {
  const origin = canonicalizeOpenCodeOrigin(binding.origin);
  const credential = binding.credential;
  if (credential.kind !== "managed") {
    throw new OpenCodeAuthScopeError(origin, origin);
  }
  const shutdownEpoch = binding.shutdownEpoch;
  const targetId = binding.targetId;
  const transportCredential: TransportCredential = credential;
  return createGatedTransport(Object.freeze({ origin, credential: transportCredential }), () => {
    const snapshot = readShutdownState();
    if (snapshot.shutdownStarted || snapshot.shutdownEpoch !== shutdownEpoch) {
      throw new OpenCodeContextInvalidatedError();
    }
    if (targetId !== undefined && invalidatedTargetIds.has(targetId)) {
      throw new OpenCodeContextInvalidatedError(
        "OpenCode target was invalidated after process exit",
      );
    }
  });
}

/**
 * Binds a transport to the managed origin for a start that resolved a URL but
 * published no target.
 */
export function createManagedFallbackTransport(baseUrl: string): OpenCodeTransport {
  const origin = canonicalizeOpenCodeOrigin(baseUrl);
  if (connectionState.shutdownStarted) throw new OpenCodeNotReadyError();
  const credential: OpenCodeManagedCredential = Object.freeze({
    kind: "managed",
    password: requirePassword(getOpenCodeAuthPassword()),
  });
  return createBoundedTransport({
    origin,
    credential,
    shutdownEpoch: connectionState.shutdownEpoch,
  });
}

/**
 * Captures one immutable request context from one state snapshot.
 *
 * @throws {OpenCodeNotReadyError} when the target is unresolved or shutdown has begun.
 */
export function captureOpenCodeRequestContext(): OpenCodeRequestContext {
  const state = connectionState;
  if (state.shutdownStarted) throw new OpenCodeNotReadyError();
  const target = state.target;
  if (target.mode === "unresolved") throw new OpenCodeNotReadyError();
  const credential = target.credential;
  const authHeaders = Object.freeze(buildOpenCodeBasicAuthHeader(credential.password));
  const requestContext: OpenCodeRequestContext = {
    mode: "managed",
    targetId: target.targetId,
    baseUrl: target.baseUrl,
    origin: target.origin,
    credential,
    authHeaders,
    revision: state.revision,
    shutdownEpoch: state.shutdownEpoch,
    transport: createBoundedTransport({
      origin: target.origin,
      credential,
      shutdownEpoch: state.shutdownEpoch,
      targetId: target.targetId,
    }),
    profileId: target.profileId,
  };
  return Object.freeze(requestContext);
}

/**
 * Registers the manager that owns managed children. Returns an unregister
 * function so a test can restore the previous provider.
 */
export function registerManagedChildStopProvider(
  provider: ManagedChildStopProvider | null,
): () => void {
  const previous = shutdownStopProvider;
  shutdownStopProvider = provider;
  return () => {
    shutdownStopProvider = previous;
  };
}

/**
 * Begins shutdown exactly once and returns the shared completion.
 */
export function beginShutdown(): Promise<OpenCodeShutdownResult> {
  if (connectionState.shutdownStarted) {
    return shutdownCompletion ?? Promise.resolve({ ok: true } as const);
  }

  writeState(
    buildState(
      connectionState.revision + 1,
      connectionState.shutdownEpoch + 1,
      true,
      UNRESOLVED_TARGET,
    ),
  );

  let resolve!: (result: OpenCodeShutdownResult) => void;
  const completion = new Promise<OpenCodeShutdownResult>((settle) => {
    resolve = settle;
  });
  shutdownCompletion = completion;

  let stops: readonly Promise<OpenCodeShutdownResult>[];
  try {
    const provider = shutdownStopProvider;
    stops = provider === null ? [] : provider.stopAllChildrenForShutdown();
  } catch (error) {
    resolve({ ok: false, error });
    return completion;
  }

  if (stops.length === 0) {
    resolve({ ok: true });
    return completion;
  }

  void Promise.allSettled(stops).then((settled) => {
    resolve(aggregateStopResults(settled));
  });
  return completion;
}

function aggregateStopResults(
  settled: readonly PromiseSettledResult<OpenCodeShutdownResult>[],
): OpenCodeShutdownResult {
  for (const entry of settled) {
    if (entry.status === "rejected") return { ok: false, error: entry.reason };
    if (entry.value.ok === false) return entry.value;
  }
  return { ok: true };
}

/**
 * Test-only seam that makes an otherwise-unreachable shutdown state constructible.
 */
export function setShutdownStateReaderForTests(reader: ShutdownStateReader | null): void {
  shutdownStateReaderOverride = reader;
}

/** Restores the module to its initial state. Test isolation only. */
export function resetConnectionStateForTests(): void {
  connectionState = Object.freeze({
    revision: 0,
    shutdownEpoch: 0,
    shutdownStarted: false,
    target: UNRESOLVED_TARGET,
  });
  invalidatedTargetIds.clear();
  nextTargetId = 1;
  shutdownCompletion = null;
  shutdownStopProvider = null;
  shutdownStateReaderOverride = null;
  runtimeTargetChangeListeners.clear();
  backendInstanceId = randomUUID();
}

/** Test-only: simulates a backend process restart by rotating the instance identity. */
export function rotateBackendInstanceIdForTests(): string {
  backendInstanceId = randomUUID();
  return backendInstanceId;
}
