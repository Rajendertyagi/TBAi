import {
  OpenCodeAuthScopeError,
  createGatedTransport,
  type OpenCodeTransport,
  type TransportCredential,
} from "./http";
import type { OpenCodeServiceCapabilities } from "./compatibility";
import { buildOpenCodeBasicAuthHeader, getOpenCodeAuthPassword } from "./runtime";

/**
 * The single owner of the OpenCode connection target, the two counters that
 * describe it, and the one shutdown latch (§1.9.3).
 *
 * Everything here is a module-private state value plus the operations that
 * replace it. No other module may read or write the state directly: a request
 * obtains a frozen {@link OpenCodeRequestContext} from
 * {@link captureOpenCodeRequestContext}, and a discovery or start cycle obtains
 * an identity from {@link beginAttempt}. That is the whole contract — a base URL
 * and a credential can never be captured from two different snapshots.
 */

/** A credential for the managed child TBAi starts and owns. */
export type OpenCodeManagedCredential = Readonly<{
  kind: "managed";
  /** Non-empty by construction. */
  password: string;
}>;

/** A credential for an adopted service, bound to the origin it was validated for. */
export type OpenCodeAdoptedCredential = Readonly<{
  kind: "adopted";
  /** Canonical, slash-free origin this credential belongs to. */
  origin: string;
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
    }>
  | Readonly<{
      mode: "adopted";
      targetId: number;
      baseUrl: string;
      origin: string;
      credential: OpenCodeAdoptedCredential;
      /**
       * What the adoption attempt proved about this service (B7). `null` means
       * "not assessed" — a legacy or test install — and every feature stays
       * enabled, because an absent snapshot is not evidence of absence.
       */
      capabilities: OpenCodeServiceCapabilities | null;
      profileId?: string;
      runtimeInstanceId?: string;
      runtimePid?: number;
      dataLocation?: string;
    }>;

/**
 * The one connection-state value. `revision` is diagnostics only, `shutdownEpoch`
 * is the initiation counter, and `shutdownStarted` is the terminal latch; the
 * three are deliberately not interchangeable (§1.9.2.1).
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
  readonly mode: "managed" | "adopted";
  readonly targetId: number;
  /** Canonical, slash-free origin. */
  readonly baseUrl: string;
  readonly origin: string;
  readonly credential: OpenCodeManagedCredential | OpenCodeAdoptedCredential;
  readonly authHeaders: Readonly<Record<string, string>>;
  /** Diagnostics only — never gates a request. */
  readonly revision: number;
  /** Revocation counter; the transport re-checks it with the latch. */
  readonly shutdownEpoch: number;
  readonly transport: OpenCodeTransport;
  readonly profileId?: string;
}>;

/** Where a discovery or start cycle came from. */
export type AttemptSource = "startup" | "manual" | "revalidate";

/**
 * One discovery or start cycle. Its fields are frozen; only the referenced
 * `AbortController` still changes, and only by supersede or shutdown (§3.1).
 */
export type AdoptionAttempt = Readonly<{
  readonly attemptId: number;
  readonly startedAt: number;
  /** The epoch read by `beginAttempt()` from its creation snapshot. */
  readonly shutdownEpochAtStart: number;
  readonly source: AttemptSource;
  readonly controller: AbortController;
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

/** Thrown when an attempt was superseded before it could finish or install. */
export class OpenCodeAttemptSupersededError extends Error {
  readonly code = "OPENCODE_ATTEMPT_SUPERSEDED";

  constructor(readonly attemptId: number) {
    super(`OpenCode attempt ${attemptId} was superseded by a newer attempt`);
    this.name = "OpenCodeAttemptSupersededError";
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
 * What `beginShutdown()` step 4 joins. The manager registers one of these; a
 * test may register a fake. Enumeration must be synchronous so no child can
 * join after the copy is taken (§1.9.3.2, §3.4).
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

/** A test-only reader for the shutdown pair (§1.9.5). */
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

/** The module-private current-attempt slot; no getter exposes the attempt itself. */
let currentAttempt: AdoptionAttempt | null = null;
let nextAttemptId = 1;

/** The published shutdown completion, stored before any external callback can run. */
let shutdownCompletion: Promise<OpenCodeShutdownResult> | null = null;
let shutdownStopProvider: ManagedChildStopProvider | null = null;

/** Test-only override of the shutdown pair (§1.9.5). Null in production. */
let shutdownStateReaderOverride: ShutdownStateReader | null = null;

/**
 * Normalizes an origin to `scheme://host:port`, lower-cased, with no trailing
 * slash, no path and no default port (§8.1).
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

/** Refuses a non-loopback origin (§8.3). */
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
    throw new OpenCodeTargetOriginError("OpenCode adopted service must be on a loopback host");
  }
}

function requirePassword(password: string): string {
  if (typeof password !== "string" || password.length === 0) {
    throw new OpenCodeCredentialMissingError();
  }
  return password;
}

/** Innermost-first freeze: credential → target → state (§1.9.3.1). */
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

function buildAdoptedTarget(
  originInput: string,
  password: string,
  capabilities: OpenCodeServiceCapabilities | null,
  targetId: number,
  profileId?: string,
  runtimeInstanceId?: string,
  runtimePid?: number,
  dataLocation?: string,
): OpenCodeTarget {
  const origin = canonicalizeOpenCodeOrigin(originInput);
  assertLoopbackOrigin(origin);
  const credential: OpenCodeAdoptedCredential = Object.freeze({
    kind: "adopted",
    origin,
    password: requirePassword(password),
  });
  return Object.freeze({
    mode: "adopted",
    targetId,
    baseUrl: origin,
    origin,
    credential,
    capabilities,
    profileId,
    runtimeInstanceId,
    runtimePid,
    dataLocation,
  });
}

/** One reference read of the current state. Every reader uses this. */
export function readConnectionState(): OpenCodeConnectionState {
  return connectionState;
}

/** The current attempt id, or null when none has been created. */
export function currentAttemptId(): number | null {
  return currentAttempt?.attemptId ?? null;
}

/**
 * Installs a managed target after readiness succeeds.
 * Returns the unique target identity assigned to this installed instance.
 *
 * Copies its inputs into owner-controlled objects, so a caller that keeps its
 * own object cannot mutate what is installed (§1.9.3.1).
 *
 * @throws {OpenCodeAttemptSupersededError} when an attempt is supplied and is no longer active.
 * @throws {OpenCodeContextInvalidatedError} when shutdown has begun.
 */
export function installManagedTarget(input: {
  readonly baseUrl: string;
  readonly password: string;
  readonly attempt?: AdoptionAttempt | null;
  readonly profileId?: string;
  readonly dataLocation?: string;
}): number {
  requireActiveAttempt(input.attempt);
  refuseAfterShutdown();
  const baseUrl = input.baseUrl;
  const password = input.password;
  const targetId = nextTargetId++;
  const target = buildManagedTarget(
    baseUrl,
    password,
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
 * Installs an adopted target after trust validation and a `ready` probe.
 * Returns the unique target identity assigned to this installed instance.
 *
 * @throws {OpenCodeAttemptSupersededError} when an attempt is supplied and is no longer active.
 * @throws {OpenCodeContextInvalidatedError} when shutdown has begun.
 */
export function installAdoptedTarget(input: {
  readonly origin: string;
  readonly password: string;
  readonly attempt?: AdoptionAttempt | null;
  /** B7 capability snapshot; omitted only by tests or a legacy install. */
  readonly capabilities?: OpenCodeServiceCapabilities | null;
  readonly profileId?: string;
  readonly runtimeInstanceId?: string;
  readonly runtimePid?: number;
  readonly dataLocation?: string;
}): number {
  requireActiveAttempt(input.attempt);
  refuseAfterShutdown();
  const origin = input.origin;
  const password = input.password;
  const targetId = nextTargetId++;
  const target = buildAdoptedTarget(
    origin,
    password,
    input.capabilities ?? null,
    targetId,
    input.profileId,
    input.runtimeInstanceId,
    input.runtimePid,
    input.dataLocation,
  );
  writeState(
    buildState(connectionState.revision + 1, connectionState.shutdownEpoch, false, target),
  );
  return targetId;
}

/**
 * Clears the target to `unresolved` for fallback or explicit rejection. Moves
 * `revision` only.
 */
export function clearTarget(attempt?: AdoptionAttempt | null): void {
  requireActiveAttempt(attempt);
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
 *
 * Guarantees:
 * - If shutdown has begun, returns false.
 * - If current target is NOT managed (e.g. adopted), returns false and changes nothing.
 * - If current target has a different targetId (e.g. a newer replacement child), returns false.
 * - Only if mode is 'managed' and targetId matches: transitions target to UNRESOLVED_TARGET,
 *   records targetId in invalidatedTargetIds so in-flight transports fail predictably,
 *   and increments revision.
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

function requireActiveAttempt(attempt: AdoptionAttempt | null | undefined): void {
  if (attempt === null || attempt === undefined) return;
  if (!isAttemptActive(attempt)) throw new OpenCodeAttemptSupersededError(attempt.attemptId);
}

function refuseAfterShutdown(): void {
  if (connectionState.shutdownStarted) throw new OpenCodeContextInvalidatedError();
}

function writeState(next: OpenCodeConnectionState): void {
  connectionState = next;
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
  readonly credential: OpenCodeManagedCredential | OpenCodeAdoptedCredential;
  /** The epoch captured with the target; the transport's initiation gate. */
  readonly shutdownEpoch: number;
  /** Unique target identity; if invalidated, transport refuses requests. */
  readonly targetId?: number;
}

/**
 * Binds one transport to one captured origin, credential and shutdown epoch.
 *
 * The origin is canonicalized and an adopted credential is checked against the
 * origin it claims, so a binding can never pair one mode's credential with the
 * other mode's origin. The credential instance is retained, not copied: the
 * context, the auth-header source and the transport all read the same object.
 *
 * @throws {OpenCodeAuthScopeError} when an adopted credential names a different origin.
 * @throws {OpenCodeOriginMismatchError} on a request for any other origin.
 * @throws {OpenCodeContextInvalidatedError} once shutdown has begun or target was invalidated.
 * @throws {OpenCodeRedirectRefusedError} for every 3xx.
 */
export function createBoundedTransport(binding: BoundedTransportBinding): OpenCodeTransport {
  const origin = canonicalizeOpenCodeOrigin(binding.origin);
  const credential = binding.credential;
  if (credential.kind === "adopted" && canonicalizeOpenCodeOrigin(credential.origin) !== origin) {
    throw new OpenCodeAuthScopeError(origin, credential.origin);
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
 * Binds a transport to the MANAGED origin for a start that resolved a URL but
 * published no target.
 *
 * The real manager publishes a target before `ensureBaseUrl()` resolves, so
 * this is the compatibility path for a manager double or a legacy test — the
 * one case where a caller legitimately has a base URL and no captured context.
 * It exists so that such a caller still gets an origin-bound, credential-owning
 * transport instead of a raw `fetch` plus a headers object: the transport
 * injects TBAi's managed credential, refuses every redirect and is invalidated
 * by the next shutdown epoch.
 *
 * @throws {OpenCodeNotReadyError} after shutdown, before any transport exists.
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
 * Builds the discovery-probe transport from one attempt and the candidate's own
 * validated data (§1.9.5). The credential is a candidate: nothing has been
 * installed, so it is deliberately not an adopted credential. The attempt — not
 * a caller-supplied epoch — is the initiation gate, so a stale or aborted
 * attempt is refused whatever its caller still holds.
 *
 * @throws {OpenCodeCredentialMissingError} when the candidate carries no password.
 * @throws {OpenCodeContextInvalidatedError} after shutdown or when the epoch has moved.
 * @throws {OpenCodeAttemptSupersededError} when the attempt is stale or aborted.
 */
export function createDiscoveryProbeTransport(
  attempt: AdoptionAttempt,
  candidate: Readonly<{ origin: string; password: string }>,
): OpenCodeTransport {
  const origin = canonicalizeOpenCodeOrigin(candidate.origin);
  const candidateCredential: TransportCredential = Object.freeze({
    password: requirePassword(candidate.password),
  });
  const attemptId = attempt.attemptId;
  const epochAtStart = attempt.shutdownEpochAtStart;
  const controller = attempt.controller;
  return createGatedTransport(Object.freeze({ origin, credential: candidateCredential }), () => {
    const snapshot = readShutdownState();
    // The latch is the authority even when the epoch still matches; that state
    // is only constructible through the test seam (§1.9.5, AT10(c)).
    if (snapshot.shutdownStarted) throw new OpenCodeContextInvalidatedError();
    if (snapshot.shutdownEpoch !== epochAtStart) throw new OpenCodeContextInvalidatedError();
    if (attemptId !== currentAttemptId()) throw new OpenCodeAttemptSupersededError(attemptId);
    if (controller.signal.aborted) throw new OpenCodeAttemptSupersededError(attemptId);
  });
}

/**
 * Captures one immutable request context from one state snapshot (§1.9.3).
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
    mode: target.mode,
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
 * Creates one discovery/start attempt and makes it current (§1.9.3.3).
 *
 * Synchronous. Reads the connection state twice: a creation snapshot whose
 * epoch the attempt carries, and a revalidation snapshot taken after any abort
 * listeners have run, which decides return-versus-throw.
 *
 * @throws {OpenCodeNotReadyError} after shutdown, before any I/O.
 * @throws {OpenCodeAttemptSupersededError} when a re-entrant attempt replaced this one.
 */
export function beginAttempt(source: AttemptSource): AdoptionAttempt {
  const creation = readConnectionState();
  if (creation.shutdownStarted) throw new OpenCodeNotReadyError();

  const attempt: AdoptionAttempt = Object.freeze({
    attemptId: nextAttemptId,
    startedAt: Date.now(),
    shutdownEpochAtStart: creation.shutdownEpoch,
    source,
    controller: new AbortController(),
  });
  nextAttemptId += 1;

  const previous = currentAttempt;
  currentAttempt = attempt;

  if (previous !== null && !previous.controller.signal.aborted) previous.controller.abort();

  if (currentAttempt !== attempt) {
    if (!attempt.controller.signal.aborted) attempt.controller.abort();
    throw new OpenCodeAttemptSupersededError(attempt.attemptId);
  }
  const revalidated = readConnectionState();
  if (revalidated.shutdownStarted) {
    if (!attempt.controller.signal.aborted) attempt.controller.abort();
    throw new OpenCodeNotReadyError();
  }
  return attempt;
}

/**
 * The one predicate that gates every completion (§3.2). True only while the
 * attempt is current, unreleased by shutdown or an epoch move, unlatched and
 * un-aborted — with the epoch and latch read from one snapshot.
 */
export function isAttemptActive(attempt: AdoptionAttempt): boolean {
  if (attempt.attemptId !== currentAttemptId()) return false;
  const snapshot = readShutdownState();
  if (snapshot.shutdownStarted) return false;
  if (snapshot.shutdownEpoch !== attempt.shutdownEpochAtStart) return false;
  return !attempt.controller.signal.aborted;
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
 * Begins shutdown exactly once and returns the shared completion (§1.9.3.2).
 *
 * The first call replaces the state, publishes the completion, aborts the active
 * attempt and joins every managed child stop, in that order. Every later or
 * re-entrant call returns the identical published promise and changes nothing.
 * The completion always resolves — a synchronous throw, an asynchronous
 * rejection and a non-settling stop all become a typed result; it never rejects.
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

  const active = currentAttempt;
  if (active !== null && !active.controller.signal.aborted) active.controller.abort();

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
 * Test-only seam that makes an otherwise-unreachable shutdown state
 * constructible (§1.9.5). Production code never calls this and always reads
 * `readShutdownState()`.
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
  currentAttempt = null;
  nextAttemptId = 1;
  shutdownCompletion = null;
  shutdownStopProvider = null;
  shutdownStateReaderOverride = null;
}
