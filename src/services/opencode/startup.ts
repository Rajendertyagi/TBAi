import { OPENCODE_CONFIG, type OpenCodeConfig } from "../../config/opencode";
import { classifyError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import {
  attemptOpenCodeAdoption,
  type AdoptionAttemptOutcome,
  type AdoptionRefusalReason,
} from "./adoption";
import {
  isEssentialCapability,
  opencodeCapabilityIds,
  type OpenCodeServiceCapabilities,
} from "./compatibility";
import { readConnectionState, readShutdownState } from "./connectionState";
import { revalidateAdoptedTarget, type AdoptedRecoveryOutcome } from "./recovery";
import { hasExplicitServerConfig } from "./registration";
import { openCodeServerManager } from "./serverManager";

/**
 * Adopt-first startup and the adopted-service revalidation loop (H5/B2, D3).
 *
 * ## Startup order
 *
 * Adoption is attempted ONCE, before any managed child can exist. If a
 * compatible stable service is found it is adopted and that is the runtime.
 * Otherwise the runtime owns one, so the managed child starts NOW — not at the
 * first Code request. H5/B2 makes the service available at boot: a managed
 * start deferred to the first use leaves the app without a runtime for an
 * arbitrary time, and the user has no way to tell that state from a broken
 * install. A failed managed start is reported, and a later Code request still
 * retries through `ensureBaseUrl()`.
 *
 * A refused attempt caused by supersession or shutdown starts nothing: another
 * attempt owns the outcome, or the process is going away.
 *
 * ## Why the loop is separate
 *
 * An adopted service is somebody else's process. TBAi never signals it
 * (`recovery.ts` re-probes only), and the revalidation loop is the only thing
 * that notices when it goes away. The loop is started here rather than inside
 * the state module so the timer's lifetime has one owner, and it stops itself
 * the moment the target is no longer adopted — a fallback makes the target
 * managed, and shutdown clears it.
 *
 * ## The one exclusion, and why it is explicit
 *
 * An automated test run must never read the developer's real registration
 * file or probe the service it names; that would make a test an actor on a
 * machine it does not own. `NODE_ENV === "test"` (set by `bun test`, and
 * inherited by every child it spawns) therefore disables adoption and the
 * loop. Nothing else does.
 */

/** Why the managed service, rather than an adopted one, is the runtime. */
export type OpenCodeStartupFallbackReason = AdoptionRefusalReason | "adoption_failed";

/** How one startup attempt concluded. */
export type OpenCodeStartupOutcome =
  | Readonly<{
      status: "skipped";
      reason: "test_environment" | "shutdown" | "already_installed" | "superseded";
    }>
  | Readonly<{
      status: "adopted";
      capabilities: OpenCodeServiceCapabilities;
      optionalMissing: readonly string[];
    }>
  | Readonly<{ status: "managed"; reason: OpenCodeStartupFallbackReason; baseUrl: string }>
  | Readonly<{
      status: "refused";
      reason: "managed_start_failed";
      adoptionReason: OpenCodeStartupFallbackReason;
    }>;

export interface OpenCodeStartupOptions {
  readonly config?: OpenCodeConfig;
  /** Test seam; production reads `NODE_ENV`. */
  readonly disabled?: boolean;
  /** Test seam; production runs the real attempt. */
  readonly adopt?: () => Promise<AdoptionAttemptOutcome>;
  /** Forwarded to the default attempt: a disposable registration for a test. */
  readonly registrationPath?: string;
  readonly channel?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  /** Test seam; production starts the managed child through the manager. */
  readonly startManaged?: () => Promise<string>;
}

let startupRun: Promise<OpenCodeStartupOutcome> | null = null;
let revalidationTimer: ReturnType<typeof setInterval> | null = null;
let activeConfig: OpenCodeConfig = OPENCODE_CONFIG;
let revalidate: () => Promise<AdoptedRecoveryOutcome> = () =>
  revalidateAdoptedTarget({ config: activeConfig });

/** True in an automated test run, where adoption must not touch the host. */
function isAutomatedTestEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test";
}

/**
 * Runs the adopt-first startup attempt once per process.
 *
 * Repeated calls share the first run, so a re-entrant boot (or a second caller)
 * cannot probe the candidate twice or adopt over an already-installed target.
 *
 * @returns The outcome. Expected refusals are data; unexpected defects throw.
 */
export function startOpenCodeRuntime(
  options: OpenCodeStartupOptions = {},
): Promise<OpenCodeStartupOutcome> {
  if (startupRun !== null) return startupRun;
  startupRun = runStartup(options);
  return startupRun;
}

async function runStartup(options: OpenCodeStartupOptions): Promise<OpenCodeStartupOutcome> {
  const config = options.config ?? OPENCODE_CONFIG;
  activeConfig = config;

  if (options.disabled ?? isAutomatedTestEnvironment()) {
    logger.debug("opencode", "opencode.adoption_skipped", { reason: "test_environment" });
    return { status: "skipped", reason: "test_environment" };
  }
  if (readShutdownState().shutdownStarted) return { status: "skipped", reason: "shutdown" };
  if (readConnectionState().target.mode !== "unresolved") {
    // Another attempt already installed a service; only an adopted one needs
    // the loop.
    if (readConnectionState().target.mode === "adopted") startOpenCodeRevalidation(config);
    return { status: "skipped", reason: "already_installed" };
  }

  const env = options.env ?? process.env;
  const explicitConfigured = hasExplicitServerConfig(env, config);

  const adopt =
    options.adopt ??
    (() =>
      attemptOpenCodeAdoption({
        source: "startup",
        path: options.registrationPath,
        channel: options.channel,
        env: options.env,
        homeDir: options.homeDir,
        config,
      }));

  let outcome: AdoptionAttemptOutcome;
  try {
    outcome = await adopt();
  } catch (error) {
    // A defect in the attempt must not leave the app without a runtime: the
    // managed path is what a user would get if adoption did not exist at all.
    if (readShutdownState().shutdownStarted) return { status: "skipped", reason: "shutdown" };
    logger.error("opencode", "opencode.startup_adoption_failed", { ...classifyError(error) });
    if (explicitConfigured) {
      return {
        status: "refused",
        reason: "managed_start_failed",
        adoptionReason: "adoption_failed",
      };
    }
    return startManagedFallback(options, "adoption_failed");
  }

  if (outcome.status === "adopted") {
    const optionalMissing = opencodeCapabilityIds().filter(
      (id) => !outcome.capabilities.supported[id] && !isEssentialCapability(id),
    );
    logger.info("opencode", "opencode.startup_adopted", {
      detectedVersion: outcome.capabilities.version,
      optionalMissing,
    });
    startOpenCodeRevalidation(config);
    return { status: "adopted", capabilities: outcome.capabilities, optionalMissing };
  }

  if (outcome.reason === "shutdown" || readShutdownState().shutdownStarted) {
    return { status: "skipped", reason: "shutdown" };
  }
  // Superseded means another attempt is current; that attempt owns the target.
  if (outcome.reason === "attempt_superseded") return { status: "skipped", reason: "superseded" };
  const installed = readConnectionState().target;
  if (installed.mode !== "unresolved") {
    if (installed.mode === "adopted") startOpenCodeRevalidation(config);
    return { status: "skipped", reason: "already_installed" };
  }

  if (explicitConfigured) {
    logger.warn("opencode", "opencode.startup_explicit_adoption_refused", {
      reason: outcome.reason,
    });
    return {
      status: "refused",
      reason: "managed_start_failed",
      adoptionReason: outcome.reason,
    };
  }

  return startManagedFallback(options, outcome.reason);
}

/**
 * Starts the managed child after adoption could not supply a service (H5/B2).
 *
 * `ensureBaseUrl()` publishes the managed target before it resolves, so the
 * base URL returned here is already the connection state's target. A shutdown
 * that lands mid-start is not a failure to report as a refusal.
 */
async function startManagedFallback(
  options: OpenCodeStartupOptions,
  adoptionReason: OpenCodeStartupFallbackReason,
): Promise<OpenCodeStartupOutcome> {
  logger.info("opencode", "opencode.startup_managed_fallback", { reason: adoptionReason });

  const startManaged = options.startManaged ?? (() => openCodeServerManager.ensureBaseUrl());
  let baseUrl: string;
  try {
    baseUrl = await startManaged();
  } catch (error) {
    if (readShutdownState().shutdownStarted) return { status: "skipped", reason: "shutdown" };
    logger.error("opencode", "opencode.startup_managed_failed", {
      reason: adoptionReason,
      ...classifyError(error),
    });
    return { status: "refused", reason: "managed_start_failed", adoptionReason };
  }

  if (readShutdownState().shutdownStarted) return { status: "skipped", reason: "shutdown" };
  logger.info("opencode", "opencode.startup_managed_ready", { reason: adoptionReason });
  return { status: "managed", reason: adoptionReason, baseUrl };
}

export interface OpenCodeRevalidationOptions {
  /** Test seam; production re-probes the installed adopted target. */
  readonly revalidate?: () => Promise<AdoptedRecoveryOutcome>;
}

/**
 * Starts the periodic revalidation of an ADOPTED target.
 *
 * Idempotent, and a no-op for a managed or unresolved target: there is nothing
 * to notice about a service TBAi itself owns, because its own exit is observed
 * by the manager.
 */
export function startOpenCodeRevalidation(
  config: OpenCodeConfig = activeConfig,
  options: OpenCodeRevalidationOptions = {},
): void {
  if (revalidationTimer !== null) return;
  if (readShutdownState().shutdownStarted) return;
  if (readConnectionState().target.mode !== "adopted") return;
  activeConfig = config;
  revalidate = options.revalidate ?? (() => revalidateAdoptedTarget({ config: activeConfig }));
  revalidationTimer = setInterval(() => {
    void revalidateTick();
  }, config.adoptionRevalidateIntervalMs);
  // The loop must never be the reason a process stays alive.
  revalidationTimer.unref?.();
}

/** Stops the revalidation loop. @returns True when a timer was cleared. */
export function stopOpenCodeRevalidation(): boolean {
  if (revalidationTimer === null) return false;
  clearInterval(revalidationTimer);
  revalidationTimer = null;
  return true;
}

/** Whether the loop is currently scheduled. Diagnostics and tests only. */
export function isOpenCodeRevalidationRunning(): boolean {
  return revalidationTimer !== null;
}

async function revalidateTick(): Promise<void> {
  const state = readConnectionState();
  if (state.shutdownStarted || state.target.mode !== "adopted") {
    stopOpenCodeRevalidation();
    return;
  }
  try {
    const outcome = await revalidate();
    if (outcome.status === "fallback") {
      // The target is managed now; the managed process's own exit is the
      // manager's business, so the loop has nothing left to watch.
      stopOpenCodeRevalidation();
      logger.info("opencode", "opencode.revalidation_stopped", { reason: "fallback" });
    } else if (outcome.status === "refused" && outcome.reason === "shutdown") {
      stopOpenCodeRevalidation();
    }
  } catch (err) {
    // A defect in one tick must not kill the loop: the next tick re-probes.
    logger.warn("opencode", "opencode.revalidation_tick_failed", {
      errorType: err instanceof Error ? err.name : typeof err,
    });
  }
}

/**
 * Clears the timer and the one-shot startup guard.
 *
 * Distributed startup runs once; a test that exercises it repeatedly (and a
 * restart of the listener in the same process) needs both to be reset.
 */
export function resetOpenCodeRuntimeStartupForTests(): void {
  stopOpenCodeRevalidation();
  startupRun = null;
  activeConfig = OPENCODE_CONFIG;
  revalidate = () => revalidateAdoptedTarget({ config: activeConfig });
}
