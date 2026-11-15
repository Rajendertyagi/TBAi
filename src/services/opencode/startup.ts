import { OPENCODE_CONFIG, type OpenCodeConfig } from "../../config/opencode";
import { classifyError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { readConnectionState, readShutdownState } from "./connectionState";
import { openCodeServerManager } from "./serverManager";

/**
 * Managed-only OpenCode runtime startup.
 *
 * TBAi owns exactly one managed `opencode serve` process. Startup never
 * discovers, adopts, revalidates, or reconnects to an independently running
 * external OpenCode server. Obsolete external runtime-selection settings
 * (`OPENCODE_URL` / `OPENCODE_HOST` / `OPENCODE_PORT`) are ignored for runtime
 * selection and reported once as a warning so managed startup can proceed.
 */

/** Compatibility reason type retained for existing callers/tests. */
export type OpenCodeStartupFallbackReason = "managed_only" | "adoption_failed";

/** How one startup attempt concluded. */
export type OpenCodeStartupOutcome =
  | Readonly<{
      status: "skipped";
      reason: "test_environment" | "shutdown" | "already_installed" | "superseded";
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
  /** Ignored in managed-only runtime (kept for compatibility). */
  readonly adopt?: () => Promise<unknown>;
  /** Ignored in managed-only runtime (kept for compatibility). */
  readonly registrationPath?: string;
  /** Ignored in managed-only runtime (kept for compatibility). */
  readonly channel?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Ignored in managed-only runtime (kept for compatibility). */
  readonly homeDir?: string;
  /** Test seam; production starts the managed child through the manager. */
  readonly startManaged?: () => Promise<string>;
}

export interface OpenCodeRevalidationOptions {
  /** Ignored in managed-only runtime (kept for compatibility). */
  readonly revalidate?: () => Promise<unknown>;
}

let startupRun: Promise<OpenCodeStartupOutcome> | null = null;
let warnedObsoleteExternalConfig = false;

function isAutomatedTestEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test";
}

function hasObsoleteExternalRuntimeConfig(
  env: NodeJS.ProcessEnv,
  config: OpenCodeConfig = OPENCODE_CONFIG,
): boolean {
  return Boolean(
    env[config.serverUrlEnvVar]?.trim() ||
      env[config.serverHostEnvVar]?.trim() ||
      env[config.serverPortEnvVar]?.trim(),
  );
}

function warnObsoleteExternalRuntimeConfigOnce(
  env: NodeJS.ProcessEnv,
  config: OpenCodeConfig = OPENCODE_CONFIG,
): void {
  if (warnedObsoleteExternalConfig) return;
  if (!hasObsoleteExternalRuntimeConfig(env, config)) return;
  warnedObsoleteExternalConfig = true;
  logger.warn("opencode", "opencode.obsolete_external_runtime_config_ignored", {
    variables: [config.serverUrlEnvVar, config.serverHostEnvVar, config.serverPortEnvVar].filter(
      (name) => Boolean(env[name]?.trim()),
    ),
  });
}

/**
 * Ensures the managed OpenCode runtime is started once per process.
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
  const env = options.env ?? process.env;
  warnObsoleteExternalRuntimeConfigOnce(env, config);

  if (options.disabled ?? isAutomatedTestEnvironment()) {
    logger.debug("opencode", "opencode.startup_skipped", { reason: "test_environment" });
    return { status: "skipped", reason: "test_environment" };
  }
  if (readShutdownState().shutdownStarted) return { status: "skipped", reason: "shutdown" };

  const installed = readConnectionState().target;
  if (installed.mode === "managed") {
    return {
      status: "managed",
      reason: "managed_only",
      baseUrl: installed.baseUrl,
    };
  }

  const startManaged = options.startManaged ?? (() => openCodeServerManager.ensureBaseUrl());
  try {
    const baseUrl = await startManaged();
    if (readShutdownState().shutdownStarted) return { status: "skipped", reason: "shutdown" };
    logger.info("opencode", "opencode.runtime_managed", {});
    return { status: "managed", reason: "managed_only", baseUrl };
  } catch (error) {
    if (readShutdownState().shutdownStarted) return { status: "skipped", reason: "shutdown" };
    logger.error("opencode", "opencode.runtime_managed_start_failed", {
      ...classifyError(error),
    });
    return {
      status: "refused",
      reason: "managed_start_failed",
      adoptionReason: "managed_only",
    };
  }
}

/** Compatibility no-op: managed-only runtime has no adopted revalidation loop. */
export function startOpenCodeRevalidation(
  _config: OpenCodeConfig = OPENCODE_CONFIG,
  _options: OpenCodeRevalidationOptions = {},
): void {
  // No-op: external/adopted runtime revalidation removed.
}

/** Compatibility no-op: managed-only runtime has no adopted revalidation loop. */
export function stopOpenCodeRevalidation(): boolean {
  return false;
}

/** Compatibility no-op: managed-only runtime has no adopted revalidation loop. */
export function isOpenCodeRevalidationRunning(): boolean {
  return false;
}

/**
 * Clears the one-shot startup guard and warning state.
 */
export function resetOpenCodeRuntimeStartupForTests(): void {
  startupRun = null;
  warnedObsoleteExternalConfig = false;
}
