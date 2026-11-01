import { OPENCODE_CONFIG, type OpenCodeConfig } from "../../config/opencode";
import { logger } from "../../lib/logger";
import {
  OpenCodeAttemptSupersededError,
  OpenCodeContextInvalidatedError,
  OpenCodeNotReadyError,
  beginAttempt,
  createDiscoveryProbeTransport,
  installAdoptedTarget,
  isAttemptActive,
  readShutdownState,
  type AdoptionAttempt,
  type AttemptSource,
  type OpenCodeTransport,
} from "./connectionState";
import {
  OpenCodeRegistrationRefusalError,
  readOpenCodeRegistration,
  type OpenCodeRegistrationRecord,
  type OpenCodeRegistrationRefusalCode,
} from "./registration";
import { OpenCodeRedirectRefusedError } from "./http";
import {
  assessOpenCodeCompatibility,
  classifyAdoptionVersion,
  isEssentialCapability,
  lazyCapabilityRegistry,
  opencodeCapabilityIds,
  probeOpenCodeCapabilities,
  type OpenCodeServiceCapabilities,
} from "./compatibility";

/**
 * One adoption attempt: read → validate → probe → install (§2.3, §3.1).
 *
 * The attempt is the authority. Its `AbortController` is the resource control
 * — aborted on supersede, by the first `beginShutdown()`, and by the two
 * deadlines below — and {@link isAttemptActive} is checked **after every await
 * and synchronously before the one install assignment** (§3.2). A late, timed
 * out or superseded completion therefore returns a typed refusal and leaves the
 * previous target untouched; nothing here signals, stops or restarts the
 * candidate, because TBAi does not own it (§3.3).
 *
 * The probe uses the official HTTP surface only for `/api/info`; sessions,
 * messages, tools, permissions and configuration remain the generated SDK's
 * job (B1, §2.10).
 */

/** Additional refusal reasons this orchestrator produces beyond the reader's. */
export type AdoptionRefusalReason =
  | OpenCodeRegistrationRefusalCode
  | "probe_failed"
  | "probe_timeout"
  | "probe_identity_mismatch"
  | "probe_version_unsupported"
  | "probe_capability_missing"
  | "redirect_refused"
  | "attempt_superseded"
  | "shutdown";

/** The outcome of one attempt. Refusals are data, not exceptions. */
export type AdoptionAttemptOutcome =
  | Readonly<{
      status: "adopted";
      registration: OpenCodeRegistrationRecord;
      /** What the service proved about itself (B7); absent routes may degrade a feature. */
      capabilities: OpenCodeServiceCapabilities;
    }>
  | Readonly<{ status: "refused"; reason: AdoptionRefusalReason }>;

export interface OpenCodeAdoptionOptions {
  readonly source?: AttemptSource;
  readonly path?: string;
  readonly channel?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly config?: OpenCodeConfig;
}

/**
 * Runs one full adoption attempt.
 *
 * `beginAttempt()` failures (shutdown, or superseded before hand-over) are
 * returned as refusals; they are not thrown at the caller. Unexpected errors
 * propagate, because they are defects rather than outcomes.
 *
 * @returns `adopted` only after the target is installed; otherwise a typed refusal.
 */
export async function attemptOpenCodeAdoption(
  options: OpenCodeAdoptionOptions = {},
): Promise<AdoptionAttemptOutcome> {
  const config = options.config ?? OPENCODE_CONFIG;

  let attempt: AdoptionAttempt;
  try {
    attempt = beginAttempt(options.source ?? "startup");
  } catch (error) {
    if (error instanceof OpenCodeNotReadyError) return refused("shutdown");
    if (error instanceof OpenCodeAttemptSupersededError) return refused("attempt_superseded");
    throw error;
  }

  let readTimedOut = false;
  const readTimer = setTimeout(() => {
    readTimedOut = true;
    if (!attempt.controller.signal.aborted) attempt.controller.abort();
  }, config.registrationReadTimeoutMs);

  let registration: OpenCodeRegistrationRecord;
  try {
    registration = await readOpenCodeRegistration({
      path: options.path,
      channel: options.channel,
      env: options.env,
      homeDir: options.homeDir,
      signal: attempt.controller.signal,
      config,
    });
  } catch (error) {
    if (error instanceof OpenCodeRegistrationRefusalError) {
      if (error.refusal === "registration_read_failed") {
        if (readTimedOut) return refused("registration_read_timeout");
        if (!isAttemptActive(attempt)) return refuseInactive();
      }
      return refused(error.refusal);
    }
    if (isAbortError(error)) {
      return readTimedOut ? refused("registration_read_timeout") : refuseInactive();
    }
    throw error;
  } finally {
    clearTimeout(readTimer);
  }

  // Guard after the read: a completion that arrives late may not probe.
  if (!isAttemptActive(attempt)) return refuseInactive();

  const probe = await probeCandidate(attempt, registration, config);
  if (probe.status !== "ready") {
    // A timeout already aborted this attempt; every other non-ready outcome is
    // only reported when the attempt is still the current, unlatched one.
    if (probe.status !== "probe_timeout" && !isAttemptActive(attempt)) return refuseInactive();
    return refused(probe.status);
  }

  // Guard position: synchronous, immediately before the single install call.
  if (!isAttemptActive(attempt)) return refuseInactive();

  const capabilities = probe.capabilities;
  try {
    installAdoptedTarget({
      origin: registration.origin,
      password: registration.password,
      attempt,
      capabilities,
    });
    lazyCapabilityRegistry.bindToService(registration.origin);
  } catch (error) {
    if (error instanceof OpenCodeAttemptSupersededError) return refused("attempt_superseded");
    if (
      error instanceof OpenCodeContextInvalidatedError ||
      error instanceof OpenCodeNotReadyError
    ) {
      return refused("shutdown");
    }
    throw error;
  }

  logger.info("opencode", "opencode.adoption_ready", {
    origin: registration.origin,
    attemptId: attempt.attemptId,
    source: attempt.source,
    detectedVersion: capabilities.version,
    optionalMissing: opencodeCapabilityIds().filter(
      (id) => !capabilities.supported[id] && !isEssentialCapability(id),
    ),
  });
  return { status: "adopted", registration, capabilities };
}

/** Probe outcomes, mapped 1:1 to the orchestrator's reasons (plus `ready`). */
type ProbeOutcome =
  | "probe_failed"
  | "probe_timeout"
  | "probe_identity_mismatch"
  | "probe_version_unsupported"
  | "probe_capability_missing"
  | "redirect_refused"
  | "attempt_superseded"
  | "shutdown";

type ProbeResult =
  | Readonly<{ status: "ready"; capabilities: OpenCodeServiceCapabilities }>
  | Readonly<{ status: ProbeOutcome }>;

/**
 * One authenticated `/api/info` probe against the candidate (§2.3 item 7),
 * followed by the B7 capability read.
 *
 * A 200 is not enough: the response must decode to a `{pid, version}`, name the
 * registered pid, and report a parseable stable build. Neither managed bound
 * refuses a build (B7): the `minimumVersion` floor is an evidence boundary, so
 * an older stable build is judged by what it can actually do, exactly like a
 * newer one. The essential routes must answer and the optional ones may be
 * absent. Every probe runs on the same attempt-bound transport, so a superseded
 * or shutdown attempt stops at the next request.
 *
 * The bound is the attempt's own second deadline; a timeout aborts the attempt,
 * so its completion can neither install nor start new work. A 3xx is reported as
 * `redirect_refused` (R1): the transport refuses it, so the redirect target is
 * never contacted and no `Location` value is surfaced.
 */
async function probeCandidate(
  attempt: AdoptionAttempt,
  registration: OpenCodeRegistrationRecord,
  config: OpenCodeConfig,
): Promise<ProbeResult> {
  let transport: OpenCodeTransport;
  try {
    transport = createDiscoveryProbeTransport(attempt, {
      origin: registration.origin,
      password: registration.password,
    });
  } catch (error) {
    if (isAttemptRefusal(error)) return { status: inactiveOutcome() };
    throw error;
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
      return { status: "probe_failed" };
    }
    const info = readServerInfo(await response.json().catch(() => undefined));
    if (info === null) return { status: "probe_failed" };
    if (info.pid !== registration.pid) return { status: "probe_identity_mismatch" };
    // The live build decides, not the record: an edited registration cannot
    // smuggle a malformed or prerelease build past the stable-only check.
    if (classifyAdoptionVersion(info.version, config).status !== "adoptable") {
      return { status: "probe_version_unsupported" };
    }

    // B7: any STABLE build is judged by what it can actually do, whatever its
    // version. The request/response shapes stay the generated client's job;
    // this reads only presence of the routes TBAi calls, and never mutates the
    // service.
    const probes = await probeOpenCodeCapabilities({
      origin: registration.origin,
      transport,
      signal: attempt.controller.signal,
    });
    const assessment = assessOpenCodeCompatibility({ version: info.version, probes });
    if (assessment.status === "incompatible") {
      logger.info("opencode", "opencode.adoption_capability_missing", {
        origin: registration.origin,
        detectedVersion: info.version,
        missingEssential: assessment.missingEssential,
      });
      return { status: "probe_capability_missing" };
    }
    // An essential route that could not be READ is not an absent capability;
    // it is a probe that proved nothing, so this attempt fails like any other.
    if (assessment.status === "indeterminate") return { status: "probe_failed" };

    return { status: "ready", capabilities: assessment.capabilities };
  } catch (error) {
    if (timedOut) return { status: "probe_timeout" };
    // A 3xx is a refusal (R1), not a generic failure: the transport cancelled
    // the body and threw before reading `Location`, and the attempt installs
    // nothing. The reason names that decision without carrying the header.
    if (error instanceof OpenCodeRedirectRefusedError) return { status: "redirect_refused" };
    if (isAttemptRefusal(error) || isAbortError(error)) return { status: inactiveOutcome() };
    return { status: "probe_failed" };
  } finally {
    clearTimeout(timer);
  }
}

/** The `/api/info` fields the client's own `decodeInfo` requires. */
function readServerInfo(input: unknown): Readonly<{ pid: number; version: string }> | null {
  if (input === null || typeof input !== "object") return null;
  const version = Reflect.get(input, "version");
  const pid = Reflect.get(input, "pid");
  if (typeof version !== "string") return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 0) return null;
  return { pid, version };
}

/**
 * Whether an attempt is still current. The epoch and latch are read from one
 * snapshot; an ordinary transition does not make an attempt stale (§3.2).
 */
function inactiveOutcome(): "shutdown" | "attempt_superseded" {
  return readShutdownState().shutdownStarted ? "shutdown" : "attempt_superseded";
}

function refuseInactive(): AdoptionAttemptOutcome {
  return refused(inactiveOutcome());
}

function refused(reason: AdoptionRefusalReason): AdoptionAttemptOutcome {
  logger.debug("opencode", "opencode.adoption_refused", { reason });
  return Object.freeze({ status: "refused", reason });
}

function isAttemptRefusal(error: unknown): boolean {
  return (
    error instanceof OpenCodeAttemptSupersededError ||
    error instanceof OpenCodeContextInvalidatedError ||
    error instanceof OpenCodeNotReadyError
  );
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && Reflect.get(error, "name") === "AbortError")
  );
}
