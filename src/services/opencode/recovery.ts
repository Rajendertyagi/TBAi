import { OPENCODE_CONFIG, type OpenCodeConfig } from "../../config/opencode";
import { logger } from "../../lib/logger";
import { classifyError } from "../../lib/errors";
import {
  OpenCodeAttemptSupersededError,
  OpenCodeContextInvalidatedError,
  OpenCodeNotReadyError,
  beginAttempt,
  captureOpenCodeRequestContext,
  clearTarget,
  createDiscoveryProbeTransport,
  installAdoptedTarget,
  isAttemptActive,
  readConnectionState,
  readShutdownState,
  type OpenCodeTransport,
} from "./connectionState";
import { OpenCodeRedirectRefusedError } from "./http";
import {
  assessOpenCodeCompatibility,
  classifyAdoptionVersion,
  lazyCapabilityRegistry,
  probeOpenCodeCapabilities,
  type OpenCodeServiceCapabilities,
} from "./compatibility";
import {
  historyOwnerFromTarget,
  isCompatibleServiceOwner,
  serializeHistoryOwner,
  type OpenCodeHistoryOwner,
} from "./historyBoundary";
import {
  OpenCodeRegistrationRefusalError,
  hasExplicitServerConfig,
  readOpenCodeRegistration,
  resolveExplicitServerConfig,
  type OpenCodeRegistrationRecord,
} from "./registration";
import { createOpenCodeClient } from "./client";
import { conversationService } from "../storage";

/**
 * Adopted-service revalidation and affinity-safe recovery (P3-A).
 *
 * TBAi never owns an adopted process: nothing here signals, restarts, or calls
 * lifecycle-controlling operations (`Service.ensure`/`Service.stop`) on it. It
 * only probes/reads through origin-bound transports and re-adopts by installing
 * a target when the original service is safely rediscovered.
 *
 * On confirmed loss of an installed adopted target, TBAi preserves session
 * affinity: it records the lost adopted service, clears the dead installed
 * target, and performs bounded passive rediscovery/revalidation of the SAME
 * service. It does not install a managed fallback globally as part of this
 * recovery (no unsafe global runtime switch). Conversations bound to the lost
 * adopted service remain refused as unavailable until the original service is
 * safely restored; other conversations may obtain managed fallback through the
 * normal per-conversation resolution path.
 */

/** What one revalidation/recovery pass concluded. */
export type AdoptedRecoveryOutcome =
  | Readonly<{ status: "not-adopted" }>
  | Readonly<{ status: "preserved"; lastStatus: number | null }>
  | Readonly<{ status: "restored"; origin: string }>
  | Readonly<{
      status: "unavailable";
      origin: string;
      reason: "cannot_rediscover" | "incompatible";
    }>
  | Readonly<{
      status: "refused";
      reason: "shutdown" | "superseded";
    }>;

export interface AdoptedRevalidationOptions {
  readonly config?: OpenCodeConfig;
  /** Test seam; production uses the captured context's transport for liveness probes. */
  readonly probeTransport?: OpenCodeTransport;
  /** Test seam; production performs bounded passive rediscovery. */
  readonly rediscover?: (lost: LostAdoptedTarget) => Promise<RediscoveryCandidate | null>;
  /** Test seam; production verifies bound sessions against the candidate service. */
  readonly verifySessionAvailability?: (
    candidate: RediscoveryCandidate,
    lost: LostAdoptedTarget,
  ) => Promise<boolean>;
}

export type LostAdoptedTarget = Readonly<{
  readonly origin: string;
  readonly password: string;
  readonly capabilities: OpenCodeServiceCapabilities | null;
  readonly profileId?: string;
  readonly runtimeInstanceId?: string;
  readonly runtimePid?: number;
  readonly dataLocation?: string;
  readonly owner: OpenCodeHistoryOwner;
  readonly ownerKey: string;
}>;

export type RediscoveryCandidate = Readonly<{
  readonly origin: string;
  readonly password: string;
  readonly capabilities: OpenCodeServiceCapabilities;
  readonly profileId?: string;
  readonly runtimeInstanceId?: string;
  readonly runtimePid?: number;
  readonly dataLocation?: string;
  readonly registration: OpenCodeRegistrationRecord;
}>;

type LostAdoptedRecoveryState = Readonly<{
  readonly lost: LostAdoptedTarget;
  readonly failed: boolean;
}>;

let recoveryInFlight: Promise<AdoptedRecoveryOutcome> | null = null;
let lostAdoptedRecovery: LostAdoptedRecoveryState | null = null;

/** The lost adopted service awaiting affinity-safe recovery, if any. */
export function getLostAdoptedRecovery(): LostAdoptedRecoveryState | null {
  return lostAdoptedRecovery;
}

/** True when the conversation is bound to the currently lost adopted service. */
export function isConversationBoundToLostAdopted(conversation: {
  opencodeServiceOwner?: string | null;
}): boolean {
  const state = lostAdoptedRecovery;
  if (!state) return false;
  return isCompatibleServiceOwner(conversation.opencodeServiceOwner, state.lost.ownerKey);
}

/** Clears lost-adopted recovery state. Test isolation and explicit reset paths only. */
export function resetLostAdoptedRecoveryForTests(): void {
  lostAdoptedRecovery = null;
  recoveryInFlight = null;
}

/**
 * Revalidates the currently installed adopted target once, or attempts bounded
 * passive rediscovery/re-adopt for a previously lost adopted target.
 *
 * Concurrent callers share one in-flight run.
 */
export function revalidateAdoptedTarget(
  options: AdoptedRevalidationOptions = {},
): Promise<AdoptedRecoveryOutcome> {
  if (recoveryInFlight !== null) return recoveryInFlight;
  const run = runRevalidation(options).finally(() => {
    recoveryInFlight = null;
  });
  recoveryInFlight = run;
  return run;
}

async function runRevalidation(
  options: AdoptedRevalidationOptions,
): Promise<AdoptedRecoveryOutcome> {
  const config = options.config ?? OPENCODE_CONFIG;
  if (readShutdownState().shutdownStarted) return { status: "refused", reason: "shutdown" };

  const installed = readConnectionState().target;
  if (installed.mode === "adopted") {
    return revalidateInstalledAdopted(installed, options, config);
  }

  // No adopted target installed: if we have a lost adopted service, attempt
  // bounded passive rediscovery/re-adopt without unsafe global switching.
  if (lostAdoptedRecovery) {
    return attemptLostAdoptedRecovery(lostAdoptedRecovery.lost, options, config);
  }

  return { status: "not-adopted" };
}

async function revalidateInstalledAdopted(
  installed: Extract<ReturnType<typeof readConnectionState>["target"], { mode: "adopted" }>,
  options: AdoptedRevalidationOptions,
  config: OpenCodeConfig,
): Promise<AdoptedRecoveryOutcome> {
  const origin = installed.origin;

  let transport = options.probeTransport;
  if (transport === undefined) {
    try {
      transport = captureOpenCodeRequestContext().transport;
    } catch (error) {
      if (error instanceof OpenCodeNotReadyError) {
        return { status: "refused", reason: "shutdown" };
      }
      throw error;
    }
  }

  const probe = await probeUntilSettled(transport, origin, config);
  if (probe.reachable) return { status: "preserved", lastStatus: probe.lastStatus };

  // Confirmed loss. Preserve affinity: record the lost adopted service and clear
  // the dead installed target, but do not install a managed fallback globally.
  let attempt: ReturnType<typeof beginAttempt>;
  try {
    attempt = beginAttempt("revalidate");
  } catch (error) {
    if (error instanceof OpenCodeNotReadyError) return { status: "refused", reason: "shutdown" };
    if (error instanceof OpenCodeAttemptSupersededError) {
      return { status: "refused", reason: "superseded" };
    }
    throw error;
  }

  const current = readConnectionState().target;
  if (current.mode !== "adopted" || current.origin !== origin) {
    return { status: "refused", reason: "superseded" };
  }

  const owner = historyOwnerFromTarget(current);
  if (!owner) return { status: "refused", reason: "superseded" };
  const lost: LostAdoptedTarget = Object.freeze({
    origin: current.origin,
    password: current.credential.password,
    capabilities: current.capabilities,
    profileId: current.profileId,
    runtimeInstanceId: current.runtimeInstanceId,
    runtimePid: current.runtimePid,
    dataLocation: current.dataLocation,
    owner,
    ownerKey: serializeHistoryOwner(owner),
  });

  try {
    clearTarget(attempt);
  } catch (error) {
    return {
      status: "refused",
      reason: error instanceof OpenCodeContextInvalidatedError ? "shutdown" : "superseded",
    };
  }

  lostAdoptedRecovery = Object.freeze({ lost, failed: false });
  logger.warn("opencode", "opencode.adopted_service_lost", {
    origin,
    attempts: config.adoptedLossConfirmAttempts,
  });

  // Attempt bounded passive rediscovery/re-adopt immediately; if it cannot be
  // restored now, remain unavailable (fail safe, affinity preserved).
  return attemptLostAdoptedRecovery(lost, options, config);
}

async function attemptLostAdoptedRecovery(
  lost: LostAdoptedTarget,
  options: AdoptedRevalidationOptions,
  config: OpenCodeConfig,
): Promise<AdoptedRecoveryOutcome> {
  if (readShutdownState().shutdownStarted) return { status: "refused", reason: "shutdown" };

  // If another target was installed meanwhile, do not interfere.
  const installed = readConnectionState().target;
  if (installed.mode !== "unresolved") {
    // If the original service was already restored, clear recovery state.
    if (installed.mode === "adopted" && installed.origin === lost.origin) {
      lostAdoptedRecovery = null;
      return { status: "restored", origin: lost.origin };
    }
    return { status: "refused", reason: "superseded" };
  }

  const rediscover = options.rediscover ?? ((target) => defaultRediscover(target, config));
  let candidate: RediscoveryCandidate | null = null;
  try {
    candidate = await rediscover(lost);
  } catch (error) {
    logger.debug("opencode", "opencode.adopted_rediscovery_failed", {
      origin: lost.origin,
      ...classifyError(error),
    });
    candidate = null;
  }

  if (!candidate) {
    lostAdoptedRecovery = Object.freeze({ lost, failed: true });
    return { status: "unavailable", origin: lost.origin, reason: "cannot_rediscover" };
  }

  // Must be the same service/origin; never silently switch to another server.
  if (candidate.origin !== lost.origin) {
    lostAdoptedRecovery = Object.freeze({ lost, failed: true });
    return { status: "unavailable", origin: lost.origin, reason: "incompatible" };
  }

  const verify =
    options.verifySessionAvailability ?? ((c, l) => defaultVerifySessionAvailability(c, l, config));
  let sessionsOk = false;
  try {
    sessionsOk = await verify(candidate, lost);
  } catch (error) {
    logger.debug("opencode", "opencode.adopted_session_verify_failed", {
      origin: lost.origin,
      ...classifyError(error),
    });
    sessionsOk = false;
  }
  if (!sessionsOk) {
    lostAdoptedRecovery = Object.freeze({ lost, failed: true });
    return { status: "unavailable", origin: lost.origin, reason: "incompatible" };
  }

  // Re-adopt only if still safe: target unresolved and recovery state still matches.
  if (readShutdownState().shutdownStarted) return { status: "refused", reason: "shutdown" };
  if (readConnectionState().target.mode !== "unresolved") {
    return { status: "refused", reason: "superseded" };
  }
  if (!lostAdoptedRecovery || lostAdoptedRecovery.lost.origin !== lost.origin) {
    return { status: "refused", reason: "superseded" };
  }

  let attempt: ReturnType<typeof beginAttempt>;
  try {
    attempt = beginAttempt("revalidate");
  } catch (error) {
    if (error instanceof OpenCodeNotReadyError) return { status: "refused", reason: "shutdown" };
    if (error instanceof OpenCodeAttemptSupersededError) {
      return { status: "refused", reason: "superseded" };
    }
    throw error;
  }

  if (!isAttemptActive(attempt)) return { status: "refused", reason: "superseded" };
  if (readConnectionState().target.mode !== "unresolved") {
    return { status: "refused", reason: "superseded" };
  }

  try {
    installAdoptedTarget({
      origin: candidate.origin,
      password: candidate.password,
      attempt,
      capabilities: candidate.capabilities,
      profileId: candidate.profileId ?? lost.profileId,
      runtimeInstanceId: candidate.runtimeInstanceId ?? lost.runtimeInstanceId,
      runtimePid: candidate.runtimePid ?? lost.runtimePid,
      dataLocation: candidate.dataLocation ?? lost.dataLocation,
    });
    lazyCapabilityRegistry.bindToService(candidate.origin);
  } catch (error) {
    if (error instanceof OpenCodeAttemptSupersededError) {
      return { status: "refused", reason: "superseded" };
    }
    if (
      error instanceof OpenCodeContextInvalidatedError ||
      error instanceof OpenCodeNotReadyError
    ) {
      return { status: "refused", reason: "shutdown" };
    }
    throw error;
  }

  lostAdoptedRecovery = null;
  logger.info("opencode", "opencode.adopted_service_restored", {
    origin: candidate.origin,
  });
  return { status: "restored", origin: candidate.origin };
}

async function defaultRediscover(
  lost: LostAdoptedTarget,
  config: OpenCodeConfig,
): Promise<RediscoveryCandidate | null> {
  // Passive rediscovery: re-read explicit config or registration hint, but only
  // accept a candidate that represents the SAME original service/origin.
  const env = process.env;
  let registration: OpenCodeRegistrationRecord | null = null;

  try {
    if (hasExplicitServerConfig(env, config)) {
      const explicit = resolveExplicitServerConfig(env, config);
      if (explicit) {
        registration = Object.freeze({
          path: "config",
          origin: explicit.origin,
          pid: 0,
          password: explicit.password,
          version: "2.2.0",
        });
      }
    } else {
      registration = await readOpenCodeRegistration({ config });
    }
  } catch (error) {
    if (!(error instanceof OpenCodeRegistrationRefusalError)) {
      logger.debug("opencode", "opencode.adopted_rediscovery_read_failed", {
        origin: lost.origin,
        ...classifyError(error),
      });
    }
    registration = null;
  }

  // If registration/config points elsewhere, do not switch; try probing the
  // original origin directly as a bounded passive check (same service identity).
  const candidates: OpenCodeRegistrationRecord[] = [];
  if (registration && registration.origin === lost.origin) candidates.push(registration);
  if (!candidates.some((c) => c.origin === lost.origin)) {
    candidates.push(
      Object.freeze({
        path: "rediscovery",
        origin: lost.origin,
        pid: lost.runtimePid ?? 0,
        password: lost.password,
        version: "2.2.0",
      }),
    );
  }

  for (const candidateReg of candidates) {
    if (candidateReg.origin !== lost.origin) continue;
    const validated = await validateRediscoveryCandidate(candidateReg, lost, config);
    if (validated) return validated;
  }
  return null;
}

async function validateRediscoveryCandidate(
  registration: OpenCodeRegistrationRecord,
  lost: LostAdoptedTarget,
  config: OpenCodeConfig,
): Promise<RediscoveryCandidate | null> {
  let attempt: ReturnType<typeof beginAttempt>;
  try {
    attempt = beginAttempt("revalidate");
  } catch {
    return null;
  }

  let transport: OpenCodeTransport;
  try {
    transport = createDiscoveryProbeTransport(attempt, {
      origin: registration.origin,
      password: registration.password,
    });
  } catch {
    return null;
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (!attempt.controller.signal.aborted) attempt.controller.abort();
  }, config.discoveryProbeTimeoutMs);

  try {
    const response = await transport(`${registration.origin}${config.readinessProbePath}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: attempt.controller.signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const info = readServerInfo(await response.json().catch(() => undefined));
    if (info === null) return null;
    if (classifyAdoptionVersion(info.version, config).status !== "adoptable") return null;

    const probes = await probeOpenCodeCapabilities({
      origin: registration.origin,
      transport,
      signal: attempt.controller.signal,
    });
    const assessment = assessOpenCodeCompatibility({ version: info.version, probes });
    if (assessment.status !== "compatible") return null;

    // Same service identity: origin must match; if we knew a runtime instance id,
    // require it to match when the server reports one (best-effort).
    const runtimeInstanceId = readRuntimeInstanceId(info.raw);
    if (
      lost.runtimeInstanceId &&
      runtimeInstanceId &&
      lost.runtimeInstanceId !== runtimeInstanceId
    ) {
      return null;
    }

    return Object.freeze({
      origin: registration.origin,
      password: registration.password,
      capabilities: assessment.capabilities,
      profileId: lost.profileId,
      runtimeInstanceId: runtimeInstanceId ?? lost.runtimeInstanceId,
      runtimePid: info.pid || lost.runtimePid,
      dataLocation: lost.dataLocation,
      registration: Object.freeze({
        ...registration,
        pid: info.pid || registration.pid,
        version: info.version,
      }),
    });
  } catch {
    if (timedOut) return null;
    return null;
  } finally {
    clearTimeout(timer);
    if (!attempt.controller.signal.aborted) attempt.controller.abort();
  }
}

function readServerInfo(
  input: unknown,
): Readonly<{ pid: number; version: string; raw: unknown }> | null {
  if (input === null || typeof input !== "object") return null;
  const version = Reflect.get(input, "version");
  const pid = Reflect.get(input, "pid");
  if (typeof version !== "string") return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 0) return null;
  return { pid, version, raw: input };
}

function readRuntimeInstanceId(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  for (const key of ["id", "instanceId", "instance_id", "serverId", "server_id"]) {
    const value = Reflect.get(raw, key);
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

async function defaultVerifySessionAvailability(
  candidate: RediscoveryCandidate,
  lost: LostAdoptedTarget,
  _config: OpenCodeConfig,
): Promise<boolean> {
  // Verify the rediscovered service can serve sessions bound to the lost owner.
  // If no bound sessions exist, compatibility is sufficient.
  let bound: Array<{ opencodeSessionId?: string | null; opencodeServiceOwner?: string | null }> =
    [];
  try {
    const all = await conversationService.list({ limit: 1000 });
    bound = all.threads.filter(
      (c) =>
        !!c.opencodeSessionId && isCompatibleServiceOwner(c.opencodeServiceOwner, lost.ownerKey),
    );
  } catch {
    // If we cannot read bindings, fail safe (do not claim restore).
    return false;
  }

  if (bound.length === 0) return true;

  let attempt: ReturnType<typeof beginAttempt>;
  try {
    attempt = beginAttempt("revalidate");
  } catch {
    return false;
  }
  try {
    const transport = createDiscoveryProbeTransport(attempt, {
      origin: candidate.origin,
      password: candidate.password,
    });

    const client = createOpenCodeClient(candidate.origin, { transport });

    // Check a bounded sample of bound sessions exist on this service.
    const sample = bound.slice(0, 5);
    for (const conv of sample) {
      const sessionId = conv.opencodeSessionId;
      if (!sessionId) continue;
      try {
        const result = await client.session.get({ sessionID: sessionId } as any);
        if (!result || (result as { error?: unknown }).error) return false;
      } catch {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    if (!attempt.controller.signal.aborted) attempt.controller.abort();
  }
}

type ProbeSettlement = Readonly<{ reachable: boolean; lastStatus: number | null }>;

/**
 * Runs the bounded confirmation probes.
 *
 * Any answer is proof of life. Only a transport failure counts towards the
 * loss, and the loss needs EVERY bounded attempt to fail.
 */
async function probeUntilSettled(
  transport: OpenCodeTransport,
  origin: string,
  config: OpenCodeConfig,
): Promise<ProbeSettlement> {
  let lastStatus: number | null = null;
  const attempts = Math.max(1, config.adoptedLossConfirmAttempts);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await delay(config.adoptedLossRetryDelayMs);
    try {
      const response = await transport(`${origin}${config.readinessProbePath}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(config.discoveryProbeTimeoutMs),
      });
      lastStatus = response.status;
      await response.body?.cancel().catch(() => undefined);
      return { reachable: true, lastStatus };
    } catch (error) {
      if (error instanceof OpenCodeRedirectRefusedError) {
        return { reachable: true, lastStatus };
      }
      logger.debug("opencode", "opencode.adopted_probe_unreachable", {
        origin,
        attempt: attempt + 1,
        ...classifyError(error),
      });
    }
  }
  return { reachable: false, lastStatus };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
