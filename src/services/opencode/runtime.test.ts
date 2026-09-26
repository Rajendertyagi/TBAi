import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { OPENCODE_CONFIG } from "../../config/opencode";
import {
  isSupportedOpenCodeVersion,
  parseOpenCodeVersion,
  resolveAndValidateManagedBinary,
  resolveManagedBinary,
} from "./runtime";

const originalBinaryOverride = process.env[OPENCODE_CONFIG.binaryEnvVar];

/** Restores the process environment mutation made by an isolated binary case. */
function restoreEnvironment(): void {
  if (originalBinaryOverride === undefined) {
    delete process.env[OPENCODE_CONFIG.binaryEnvVar];
  } else {
    process.env[OPENCODE_CONFIG.binaryEnvVar] = originalBinaryOverride;
  }
}

afterEach(restoreEnvironment);

const RUNTIME_MODULE_URL = new URL("./runtime.ts", import.meta.url).href;
const AUTH_FIXTURE_PASSWORD = "opencode-runtime-auth-fixture-password";
const AUTH_REPLACEMENT_PASSWORD = "opencode-runtime-replacement-password";
const AUTH_REPLACEMENT_ENV_VAR = "TBai_OPENCODE_TEST_REPLACEMENT_PASSWORD";
const SUPPORTED_LOWER_BOUND_VERSION = "2.0.15";
const SUPPORTED_CLIENT_VERSION = "2.0.16";
const BELOW_LOWER_BOUND_VERSION = "2.0.14";
const UNSUPPORTED_VERSION = "2.0.14";
const UPPER_BOUND_VERSION = "2.1.0";

type AuthInvariantResult = {
  readonly basicHeaderMatches: boolean;
  readonly exposesOnlyAuthorization: boolean;
  readonly metadataOmitsPassword: boolean;
  readonly metadataReportsEnvironment: boolean;
  readonly selectedEnvironmentOverride: boolean;
  readonly stableAfterRemoval: boolean;
  readonly stableAfterReplacement: boolean;
};

/** Verifies one-time auth initialization in a fresh process and returns booleans only. */
async function runAuthInvariantSubprocess(): Promise<AuthInvariantResult> {
  const script = `
    const {
      getOpenCodeAuthHeaders,
      getOpenCodeAuthMetadata,
      getOpenCodeAuthPassword,
    } = await import(${JSON.stringify(RUNTIME_MODULE_URL)});
    const authEnvVar = ${JSON.stringify(OPENCODE_CONFIG.authPasswordEnvVar)};
    const replacementEnvVar = ${JSON.stringify(AUTH_REPLACEMENT_ENV_VAR)};
    const initialPassword = process.env[authEnvVar];
    const replacementPassword = process.env[replacementEnvVar];
    if (!initialPassword || !replacementPassword) {
      throw new Error("auth fixture environment is incomplete");
    }

    const firstPassword = getOpenCodeAuthPassword();
    process.env[authEnvVar] = replacementPassword;
    const afterReplacement = getOpenCodeAuthPassword();
    delete process.env[authEnvVar];
    const afterRemoval = getOpenCodeAuthPassword();
    const headers = getOpenCodeAuthHeaders();
    const expectedAuthorization = "Basic " + Buffer.from(
      ${JSON.stringify(OPENCODE_CONFIG.authUsername)} + ":" + firstPassword,
    ).toString("base64");
    const metadata = getOpenCodeAuthMetadata();

    process.stdout.write(JSON.stringify({
      basicHeaderMatches: headers.Authorization === expectedAuthorization,
      exposesOnlyAuthorization:
        Object.keys(headers).length === 1 && Object.hasOwn(headers, "Authorization"),
      metadataOmitsPassword:
        !Object.hasOwn(metadata, "password") &&
        !JSON.stringify(metadata).includes(firstPassword),
      metadataReportsEnvironment:
        metadata.source === "environment" && metadata.configured === true,
      selectedEnvironmentOverride: firstPassword === initialPassword,
      stableAfterRemoval: afterRemoval === firstPassword,
      stableAfterReplacement: afterReplacement === firstPassword,
    }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      [OPENCODE_CONFIG.authPasswordEnvVar]: AUTH_FIXTURE_PASSWORD,
      [AUTH_REPLACEMENT_ENV_VAR]: AUTH_REPLACEMENT_PASSWORD,
    },
    stdout: "pipe",
    stderr: "ignore",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`OpenCode auth fixture process exited with code ${exitCode}`);
  }
  return JSON.parse(stdout) as AuthInvariantResult;
}

describe("managed OpenCode binary resolution", () => {
  it("prefers OPENCODE_BINARY over PATH", () => {
    const explicitBinary = path.join(import.meta.dir, "explicit-opencode-v2");
    process.env[OPENCODE_CONFIG.binaryEnvVar] = explicitBinary;
    let pathWasQueried = false;

    const resolved = resolveManagedBinary(OPENCODE_CONFIG, () => {
      pathWasQueried = true;
      return path.join(import.meta.dir, "path-opencode-v2");
    });

    expect(resolved).toEqual({ path: explicitBinary, source: "environment" });
    expect(pathWasQueried).toBe(false);
  });

  it("falls back to the configured binary name on PATH", () => {
    delete process.env[OPENCODE_CONFIG.binaryEnvVar];
    const pathBinary = path.join(import.meta.dir, "path-opencode-v2");
    let queriedName = "";

    const resolved = resolveManagedBinary(OPENCODE_CONFIG, (name) => {
      queriedName = name;
      return pathBinary;
    });

    expect(resolved).toEqual({ path: pathBinary, source: "path" });
    expect(queriedName).toBe(OPENCODE_CONFIG.binaryName);
  });

  it("does not fall back to PATH when the explicit binary is invalid", () => {
    const missingExplicitBinary = path.join(
      import.meta.dir,
      "__missing_explicit_opencode_v2__",
    );
    expect(existsSync(missingExplicitBinary)).toBe(false);
    process.env[OPENCODE_CONFIG.binaryEnvVar] = missingExplicitBinary;
    let pathWasQueried = false;

    expect(() =>
      resolveAndValidateManagedBinary(OPENCODE_CONFIG, () => {
        pathWasQueried = true;
        return path.join(import.meta.dir, "path-opencode-v2");
      }),
    ).toThrow();
    expect(pathWasQueried).toBe(false);
  });
});

describe("OpenCode managed version range", () => {
  it("parses a semantic version from plain or decorated CLI output", () => {
    expect(parseOpenCodeVersion(`${SUPPORTED_LOWER_BOUND_VERSION}\n`)).toBe(
      SUPPORTED_LOWER_BOUND_VERSION,
    );
    expect(parseOpenCodeVersion(`opencode ${SUPPORTED_CLIENT_VERSION}`)).toBe(
      SUPPORTED_CLIENT_VERSION,
    );
    expect(parseOpenCodeVersion("not-a-version")).toBeNull();
  });

  it("accepts the audited lower bound and current client release", () => {
    expect(isSupportedOpenCodeVersion(SUPPORTED_LOWER_BOUND_VERSION)).toBe(true);
    expect(isSupportedOpenCodeVersion(SUPPORTED_CLIENT_VERSION)).toBe(true);
  });

  it("rejects the below-range fixture and the 2.1.0 upper bound", () => {
    expect(isSupportedOpenCodeVersion(BELOW_LOWER_BOUND_VERSION)).toBe(false);
    expect(isSupportedOpenCodeVersion(UNSUPPORTED_VERSION)).toBe(false);
    expect(isSupportedOpenCodeVersion(UPPER_BOUND_VERSION)).toBe(false);
  });
});

describe("OpenCode backend authentication", () => {
  it("selects the environment override once and then remains stable", async () => {
    expect(await runAuthInvariantSubprocess()).toEqual({
      basicHeaderMatches: true,
      exposesOnlyAuthorization: true,
      metadataOmitsPassword: true,
      metadataReportsEnvironment: true,
      selectedEnvironmentOverride: true,
      stableAfterRemoval: true,
      stableAfterReplacement: true,
    });
  });
});
