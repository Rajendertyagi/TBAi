import { randomBytes } from "node:crypto";
import { OPENCODE_CONFIG, type OpenCodeConfig } from "../../config/opencode";
import { logger } from "../../lib/logger";

const OPENCODE_VERSION_PART_COUNT = 3;
const versionPattern = /(?:^|[\s v])(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$)/;

/** Thrown when no managed OpenCode binary candidate can be resolved. */
export class OpenCodeBinaryMissingError extends Error {
  constructor(message: string = OPENCODE_CONFIG.binaryMissingError, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenCodeBinaryMissingError";
  }
}

/** Why a reported version is refused. `supported` is never a refusal. */
export type OpenCodeVersionRefusal = "below_minimum" | "prerelease" | "malformed";

/** Thrown when a managed binary reports a version TBAi refuses to start. */
export class UnsupportedOpenCodeVersionError extends Error {
  constructor(
    readonly version: string,
    readonly minimumVersion: string,
    readonly reason: OpenCodeVersionRefusal,
  ) {
    super(
      reason === "prerelease"
        ? `Unsupported OpenCode version ${version}; only officially released stable builds are supported, and this one is a prerelease. Install a stable OpenCode ${minimumVersion} or newer.`
        : `Unsupported OpenCode version ${version}; managed OpenCode requires a stable build at or above ${minimumVersion}.`,
    );
    this.name = "UnsupportedOpenCodeVersionError";
  }
}

/** Returns the explicit binary override, when the environment supplies one. */
function configuredBinaryPath(config: OpenCodeConfig): string | null {
  const value = process.env[config.binaryEnvVar]?.trim();
  return value || null;
}

/** Resolves the managed binary without ever falling back after an explicit override. */
export function resolveManagedBinary(
  config: OpenCodeConfig = OPENCODE_CONFIG,
  which: (name: string) => string | null = Bun.which,
): { path: string; source: "environment" | "path" } {
  const configured = configuredBinaryPath(config);
  if (configured) return { path: configured, source: "environment" };
  const path = which(config.binaryName);
  if (!path) throw new OpenCodeBinaryMissingError(config.binaryMissingError);
  return { path, source: "path" };
}

/** Strips ANSI escape sequences from CLI output before parsing. */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");
}

/** Parses an OpenCode CLI version without accepting arbitrary output. */
export function parseOpenCodeVersion(output: string): string | null {
  const clean = stripAnsi(output).trim();
  const match = versionPattern.exec(clean);
  return match ? match[1] : null;
}

/** Compares stable numeric OpenCode versions without accepting malformed components. */
function compareOpenCodeVersions(left: string, right: string): number | null {
  const parseParts = (version: string): number[] | null => {
    const [core] = version.split(/[-+]/, 1);
    const parts = core.split(".").map(Number);
    return parts.length === OPENCODE_VERSION_PART_COUNT &&
      parts.every((part) => Number.isInteger(part) && part >= 0)
      ? parts
      : null;
  };
  const leftParts = parseParts(left);
  const rightParts = parseParts(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < OPENCODE_VERSION_PART_COUNT; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

/** Why a reported version is accepted or refused (B7 + D2). */
export type OpenCodeVersionSupport = "supported" | OpenCodeVersionRefusal;

/**
 * Classifies a reported version for the managed gate (B7).
 *
 * Accepting is a decision about **evidence**, not about recency:
 *
 *  - malformed output is never a version;
 *  - a prerelease build is refused (D2: stable releases only);
 *  - a build below {@link OpenCodeConfig.minimumVersion} is below the oldest
 *    surface TBAi has measured, so the routes are unknown rather than new;
 *  - everything else, including a stable release newer than any TBAi has
 *    seen, is admitted by name — the running build then has to serve the
 *    essential capability routes (`compatibility.ts`) before a managed start
 *    is handed out.
 *
 * There is deliberately no upper version bound here.
 */
export function classifyOpenCodeVersion(
  version: string,
  config: OpenCodeConfig = OPENCODE_CONFIG,
): OpenCodeVersionSupport {
  const parsed = parseOpenCodeVersion(version);
  if (parsed === null) return "malformed";
  if (!isStableReleaseVersion(parsed)) return "prerelease";
  const lowerBound = compareOpenCodeVersions(parsed, config.minimumVersion);
  return lowerBound !== null && lowerBound >= 0 ? "supported" : "below_minimum";
}

/** True when the reported version is a stable build at or above the floor. */
export function isSupportedOpenCodeVersion(
  version: string,
  config: OpenCodeConfig = OPENCODE_CONFIG,
): boolean {
  return classifyOpenCodeVersion(version, config) === "supported";
}

/**
 * True when a parsed version is at or above the configured minimum.
 *
 * This is the FLOOR half of the managed range and is used where the ceiling
 * does not apply: adoption (B7) admits any newer STABLE release and decides
 * compatibility from capability probes instead of the managed numeric gate.
 * The floor stays because it is the oldest build whose essential API TBAi has
 * checked; below it the essential endpoints are not merely new, they are
 * unknown.
 *
 * A malformed version is not "at least" anything, so it answers false.
 */
export function isOpenCodeVersionAtLeast(
  version: string,
  minimum: string = OPENCODE_CONFIG.minimumVersion,
): boolean {
  const parsed = parseOpenCodeVersion(version);
  if (!parsed) return false;
  const lowerBound = compareOpenCodeVersions(parsed, minimum);
  return lowerBound !== null && lowerBound >= 0;
}

/**
 * D2 (2026-10-31): adoption is restricted to officially released stable
 * builds. A prerelease suffix is evidence a build *is* unstable, so it is
 * refused; the same numeric version reported by a stable and a beta build
 * remains indistinguishable and is the documented limitation (BT12).
 *
 * Build metadata (`+sha`) is not a channel marker and is ignored.
 */
export function isStableReleaseVersion(version: string): boolean {
  const withoutBuildMetadata = version.split("+", 1)[0] ?? version;
  return !withoutBuildMetadata.includes("-");
}

/** Runs the CLI version preflight and returns its exact version. */
export function detectOpenCodeVersion(
  binaryPath: string,
  config: OpenCodeConfig = OPENCODE_CONFIG,
): string {
  // On Windows, .cmd launchers cannot be spawned directly; wrap with cmd /c.
  const isCmd = process.platform === "win32" && binaryPath.toLowerCase().endsWith(".cmd");
  const cmd = isCmd ? ["cmd", "/c", binaryPath, "--version"] : [binaryPath, "--version"];
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      timeout: config.versionProbeTimeoutMs,
    });
  } catch (error) {
    // A resolved binary that cannot be launched is a probe/startup failure,
    // not a missing binary. Do not misclassify it as OpenCodeBinaryMissingError.
    throw new Error(`OpenCode binary could not be started: ${binaryPath}`, {
      cause: error,
    });
  }
  if (result.exitedDueToTimeout) {
    // Name the phase, the bound and the binary: this used to be reported as a
    // configuration-read failure, which sent operators looking at config files
    // for what is a process-launch problem.
    throw new Error(
      `OpenCode version preflight timed out after ${config.versionProbeTimeoutMs}ms: ${binaryPath} did not answer --version. ` +
        `The binary may still be cold-starting or blocked by a scanner; run it manually to confirm.`,
    );
  }
  const output = new TextDecoder().decode(result.stdout);
  const version = parseOpenCodeVersion(output);
  if (!version) {
    throw new Error(`OpenCode binary did not report a valid version: ${binaryPath}`);
  }
  const support = classifyOpenCodeVersion(version, config);
  if (support !== "supported") {
    throw new UnsupportedOpenCodeVersionError(version, config.minimumVersion, support);
  }
  return version;
}

let authPassword: string | null = null;
let authSource: "environment" | "generated" | null = null;
let authInitialized = false;

/**
 * Returns the one process-local password used by the managed server and clients.
 *
 * Accepts the current name (`OPENCODE_PASSWORD`) and the legacy in-range one
 * (`OPENCODE_SERVER_PASSWORD`). The current name wins when both are set, so an
 * operator can override a stale legacy value without unsetting it.
 */
export function getOpenCodeAuthPassword(config: OpenCodeConfig = OPENCODE_CONFIG): string {
  if (!authInitialized) {
    const configured =
      process.env[config.authPasswordEnvVar]?.trim() ||
      process.env[config.authPasswordLegacyEnvVar]?.trim();
    if (configured) {
      authPassword = configured;
      authSource = "environment";
    } else {
      authPassword = randomBytes(32).toString("base64url");
      authSource = "generated";
    }
    authInitialized = true;
  }
  return authPassword ?? "";
}

/** Reports non-secret auth state for lifecycle diagnostics. */
export function getOpenCodeAuthMetadata(config: OpenCodeConfig = OPENCODE_CONFIG): {
  source: "environment" | "generated";
  configured: boolean;
} {
  getOpenCodeAuthPassword(config);
  return { source: authSource ?? "generated", configured: authSource === "environment" };
}

/**
 * Builds the one OpenCode HTTP Basic header value for a password.
 *
 * This is the ONLY constructor of the credential-bearing header in the
 * repository. Every path that sends an OpenCode credential — the bounded
 * transport, the discovery probe, the proxy, the client and adoption — calls
 * this helper, so no second base64 expression can drift (§1.4, TT6).
 *
 * @param password - Non-empty credential password.
 * @param config - Configuration supplying the HTTP Basic username.
 * @returns A single-entry header record.
 */
export function buildOpenCodeBasicAuthHeader(
  password: string,
  config: OpenCodeConfig = OPENCODE_CONFIG,
): Record<string, string> {
  const credentials = Buffer.from(`${config.authUsername}:${password}`).toString("base64");
  return { Authorization: `Basic ${credentials}` };
}

/** Builds the backend-only OpenCode HTTP Basic header for the managed password. */
export function getOpenCodeAuthHeaders(
  config: OpenCodeConfig = OPENCODE_CONFIG,
): Record<string, string> {
  return buildOpenCodeBasicAuthHeader(getOpenCodeAuthPassword(config), config);
}

/** The header the managed server reads a request's working directory from. */
export const OPENCODE_DIRECTORY_HEADER = "x-opencode-directory";

/** Builds a safe V2 directory header for official client calls. */
export function getOpenCodeDirectoryHeaders(directory?: string | null): Record<string, string> {
  return directory ? { [OPENCODE_DIRECTORY_HEADER]: encodeURIComponent(directory) } : {};
}

/** Logs only non-secret managed binary metadata. */
export function logOpenCodeBinary(
  binary: { path: string; source: "environment" | "path" },
  version: string,
): void {
  logger.info("opencode", "opencode.binary_resolved", {
    binaryPath: binary.path,
    binarySource: binary.source,
    detectedVersion: version,
  });
}

/** Resolves and validates the managed binary in one boundary. */
export function resolveAndValidateManagedBinary(
  config: OpenCodeConfig = OPENCODE_CONFIG,
  which: (name: string) => string | null = Bun.which,
): { path: string; source: "environment" | "path"; version: string } {
  const binary = resolveManagedBinary(config, which);
  const version = detectOpenCodeVersion(binary.path, config);
  logOpenCodeBinary(binary, version);
  return { ...binary, version };
}
