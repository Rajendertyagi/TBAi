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
  installManagedTarget,
  isAttemptActive,
  readConnectionState,
  readShutdownState,
  type OpenCodeTransport,
} from "./connectionState";
import { OpenCodeRedirectRefusedError } from "./http";
import { getOpenCodeAuthPassword } from "./runtime";
import { openCodeServerManager } from "./serverManager";

/**
 * Revalidation and the D3 managed fallback for an ADOPTED service.
 *
 * TBAi never owns the adopted process (§3.3): nothing here signals it, restarts
 * it, or calls `ensure()`/`stop()` on it. It only reads `/api/info` through the
 * captured, origin-bound transport.
 *
 * The decision follows §1.5.1:
 *
 *  - a service that ANSWERS anything is alive, even if it answers 401 or 500 —
 *    an unhealthy service is not a lost one, and switching modes would abandon
 *    a conversation's own history for no reason;
 *  - one unreachable probe is a transient network condition, so the target is
 *    PRESERVED;
 *  - when EVERY bounded attempt fails to reach it, the loss is confirmed: the
 *    target is cleared and the managed service is started automatically (D3).
 *
 * Duplicate managed processes are prevented in two layers: concurrent
 * revalidations share one in-flight fallback, and the only start path is
 * `openCodeServerManager.ensureBaseUrl()`, whose reservation is the single
 * owner of "start at most one child". If the managed start fails the state
 * stays `unresolved` (row 9) — no retry loop, and the just-cleared adopted
 * binding is not silently restored.
 */

/** What one revalidation concluded. */
export type AdoptedRecoveryOutcome =
  | Readonly<{ status: "not-adopted" }>
  | Readonly<{ status: "preserved"; lastStatus: number | null }>
  | Readonly<{ status: "fallback"; managedBaseUrl: string }>
  | Readonly<{
      status: "refused";
      reason: "shutdown" | "superseded" | "managed_start_failed";
    }>;

export interface AdoptedRevalidationOptions {
  readonly config?: OpenCodeConfig;
  /** Test seam; production uses the captured context's transport. */
  readonly probeTransport?: OpenCodeTransport;
  /** Test seam; production starts the managed child through the manager. */
  readonly startManaged?: () => Promise<string>;
}

let recoveryInFlight: Promise<AdoptedRecoveryOutcome> | null = null;

/**
 * Revalidates the currently installed adopted target once.
 *
 * Concurrent callers share one run: two ticks of a revalidation timer must not
 * both decide to fall back. The shared promise is released when it settles, so
 * a later tick starts a fresh revalidation.
 *
 * @returns The outcome. Never throws for expected lifecycle failures.
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
  if (installed.mode !== "adopted") return { status: "not-adopted" };
  const origin = installed.origin;

  let transport = options.probeTransport;
  if (transport === undefined) {
    try {
      transport = captureOpenCodeRequestContext().transport;
    } catch (error) {
      if (error instanceof OpenCodeNotReadyError) {
        // The target was cleared or shutdown started between the reads.
        return { status: "refused", reason: "shutdown" };
      }
      throw error;
    }
  }

  const probe = await probeUntilSettled(transport, origin, config);
  if (probe.reachable) return { status: "preserved", lastStatus: probe.lastStatus };

  // Confirmed loss. The attempt guards the clear and the install: a newer
  // adoption, a second fallback or shutdown all supersede it.
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

  try {
    clearTarget(attempt);
  } catch (error) {
    return {
      status: "refused",
      reason: error instanceof OpenCodeContextInvalidatedError ? "shutdown" : "superseded",
    };
  }

  logger.warn("opencode", "opencode.adopted_service_lost", {
    origin,
    attempts: config.adoptedLossConfirmAttempts,
  });

  const startManaged = options.startManaged ?? (() => openCodeServerManager.ensureBaseUrl());
  let managedBaseUrl: string;
  try {
    managedBaseUrl = await startManaged();
  } catch (error) {
    logger.error("opencode", "opencode.adopted_fallback_start_failed", {
      origin,
      ...classifyError(error),
    });
    return { status: "refused", reason: "managed_start_failed" };
  }

  if (!isAttemptActive(attempt)) return { status: "refused", reason: "superseded" };

  try {
    installManagedTarget({
      baseUrl: managedBaseUrl,
      password: getOpenCodeAuthPassword(),
      attempt,
    });
  } catch (error) {
    return {
      status: "refused",
      reason: error instanceof OpenCodeContextInvalidatedError ? "shutdown" : "superseded",
    };
  }

  logger.info("opencode", "opencode.adopted_fallback_ready", {
    origin,
    managedBaseUrl,
  });
  return { status: "fallback", managedBaseUrl };
}

type ProbeSettlement = Readonly<{ reachable: boolean; lastStatus: number | null }>;

/**
 * Runs the bounded confirmation probes.
 *
 * Any answer is proof of life. Only a transport failure counts towards the
 * loss, and the loss needs EVERY bounded attempt to fail — a single blip
 * preserves the target (§1.5.1 row 5).
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
        // A redirecting service is running; redirects are refused by policy,
        // not evidence that the process died.
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
