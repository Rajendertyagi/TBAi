import { randomBytes } from "node:crypto";
import { OPENCODE_CONFIG, type OpenCodeConfig } from "../../config/opencode";
import { logger } from "../../lib/logger";

const OPENCODE_VERSION_PART_COUNT = 3;
const versionPattern = /(?:^|[\s v])(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$)/;

/** Thrown when no managed OpenCode binary candidate can be resolved. */
export class OpenCodeBinaryMissingError extends Error {
  constructor(
    message: string = OPENCODE_CONFIG.binaryMissingError,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OpenCodeBinaryMissingError";
  }
}

/** Thrown when a managed binary reports an unsupported OpenCode version. */
export class UnsupportedOpenCodeVersionError extends Error {
  constructor(
    readonly version: string,
    readonly minimumVersion: string,
    readonly maximumVersionExclusive: string,
  ) {
    super(
      `Unsupported OpenCode version ${version}; managed OpenCode requires >=${minimumVersion} <${maximumVersionExclusive}`,
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

/** Parses an OpenCode CLI version without accepting arbitrary output. */
export function parseOpenCodeVersion(output: string): string | null {
  const match = versionPattern.exec(output.trim());
  return match ? match[1] : null;
}

/** Compares stable numeric OpenCode versions without accepting malformed components. */
function compareOpenCodeVersions(left: string, right: string): number | null {
  const parseParts = (version: string): number[] | null => {
    const [core] = version.split(/[-+]/, 1);
    const parts = core.split(".").map(Number);
    return parts.length === OPENCODE_VERSION_PART_COUNT && parts.every((part) => Number.isInteger(part) && part >= 0)
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

/** True when the parsed version is inside the configured managed range. */
export function isSupportedOpenCodeVersion(
  version: string,
  config: OpenCodeConfig = OPENCODE_CONFIG,
): boolean {
  const parsed = parseOpenCodeVersion(version);
  if (!parsed) return false;
  const lowerBound = compareOpenCodeVersions(parsed, config.minimumVersion);
  const upperBound = compareOpenCodeVersions(parsed, config.maximumVersionExclusive);
  return lowerBound !== null && upperBound !== null && lowerBound >= 0 && upperBound < 0;
}

/** Runs the CLI version preflight and returns its exact version. */
export function detectOpenCodeVersion(
  binaryPath: string,
  config: OpenCodeConfig = OPENCODE_CONFIG,
): string {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync([binaryPath, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new OpenCodeBinaryMissingError(
      `OpenCode binary could not be started: ${binaryPath}`,
      { cause: error },
    );
  }
  const output = new TextDecoder().decode(result.stdout);
  const version = parseOpenCodeVersion(output);
  if (!version) {
    throw new Error(`OpenCode binary did not report a valid version: ${binaryPath}`);
  }
  if (!isSupportedOpenCodeVersion(version, config)) {
    throw new UnsupportedOpenCodeVersionError(
      version,
      config.minimumVersion,
      config.maximumVersionExclusive,
    );
  }
  return version;
}

let authPassword: string | null = null;
let authSource: "environment" | "generated" | null = null;
let authInitialized = false;

/** Returns the one process-local password used by the managed server and clients. */
export function getOpenCodeAuthPassword(
  config: OpenCodeConfig = OPENCODE_CONFIG,
): string {
  if (!authInitialized) {
    const configured = process.env[config.authPasswordEnvVar]?.trim();
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
export function getOpenCodeAuthMetadata(
  config: OpenCodeConfig = OPENCODE_CONFIG,
): { source: "environment" | "generated"; configured: boolean } {
  getOpenCodeAuthPassword(config);
  return { source: authSource ?? "generated", configured: authSource === "environment" };
}

/** Builds the backend-only OpenCode HTTP Basic header. */
export function getOpenCodeAuthHeaders(
  config: OpenCodeConfig = OPENCODE_CONFIG,
): Record<string, string> {
  const password = getOpenCodeAuthPassword(config);
  const credentials = Buffer.from(`${config.authUsername}:${password}`).toString("base64");
  return { Authorization: `Basic ${credentials}` };
}

/** Builds a safe V2 directory header for official client calls. */
export function getOpenCodeDirectoryHeaders(directory?: string | null): Record<string, string> {
  return directory ? { "x-opencode-directory": encodeURIComponent(directory) } : {};
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
