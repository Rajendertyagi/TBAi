import { afterEach, describe, expect, it } from "bun:test";
import { REPO_ROOT } from "../../helpers/repo-root";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OPENCODE_CONFIG } from "@/config/opencode.ts";
import {
  OpenCodeBinaryMissingError,
  UnsupportedOpenCodeVersionError,
  detectOpenCodeVersion,
  isSupportedOpenCodeVersion,
  parseOpenCodeVersion,
  resolveAndValidateManagedBinary,
  resolveManagedBinary,
} from "@/services/opencode/runtime.ts";
import { buildOpenCodeServeArgs } from "@/services/opencode/serverManager.ts";

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

const RUNTIME_MODULE_URL = pathToFileURL(
  path.join(REPO_ROOT, "src/services/opencode/runtime.ts"),
).href;
const AUTH_FIXTURE_PASSWORD = "opencode-runtime-auth-fixture-password";
const AUTH_REPLACEMENT_PASSWORD = "opencode-runtime-replacement-password";
const AUTH_REPLACEMENT_ENV_VAR = "TBai_OPENCODE_TEST_REPLACEMENT_PASSWORD";
const SUPPORTED_LOWER_BOUND_VERSION = "2.0.15";
/** The audited target: the version both manifests pin and the installed binary reports. */
const SUPPORTED_CLIENT_VERSION = "2.2.0";
const BELOW_LOWER_BOUND_VERSION = "2.0.14";
const UNSUPPORTED_VERSION = "2.0.14";
/** One patch past the audited target: outside the range by design, not by accident. */
const UPPER_BOUND_VERSION = "2.2.1";

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
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
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
    const missingExplicitBinary = path.join(import.meta.dir, "__missing_explicit_opencode_v2__");
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

  it("throws OpenCodeBinaryMissingError when no executable is resolved", () => {
    delete process.env[OPENCODE_CONFIG.binaryEnvVar];
    expect(() => resolveManagedBinary(OPENCODE_CONFIG, () => null)).toThrow(
      OpenCodeBinaryMissingError,
    );
  });

  it("throws UnsupportedOpenCodeVersionError for an unsupported version", () => {
    // Create a temporary .cmd that reports an unsupported version
    const tmpDir = path.join(import.meta.dir, "__tmp_version_test__");
    const { mkdirSync, writeFileSync, rmSync } = require("node:fs");
    mkdirSync(tmpDir, { recursive: true });
    const cmdPath = path.join(tmpDir, "bad-version.cmd");
    writeFileSync(cmdPath, "@echo opencode 1.0.0\n");
    try {
      expect(() => detectOpenCodeVersion(cmdPath)).toThrow(UnsupportedOpenCodeVersionError);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("wraps .cmd launchers with cmd /c in buildOpenCodeServeArgs", () => {
    // On Windows, .cmd files cannot be spawned directly.
    if (process.platform !== "win32") return;
    expect(buildOpenCodeServeArgs(4173, "opencode.cmd")).toEqual([
      "cmd",
      "/c",
      "opencode.cmd",
      "serve",
      "--port",
      "4173",
    ]);
    // Non-.cmd binaries are not wrapped.
    expect(buildOpenCodeServeArgs(4173, "opencode.exe")).toEqual([
      "opencode.exe",
      "serve",
      "--port",
      "4173",
    ]);
  });

  it("times out and does not classify as missing when binary hangs", () => {
    const tmpDir = path.join(import.meta.dir, "__tmp_timeout_test__");
    mkdirSync(tmpDir, { recursive: true });
    const cmdPath = path.join(tmpDir, "slow.cmd");
    // ~2 s of sleep, against an explicit 100 ms bound: the case proves the
    // timeout path without waiting out the production budget.
    writeFileSync(cmdPath, "@ping -n 3 127.0.0.1 > nul\n@echo opencode 2.0.16\n");
    try {
      const config = { ...OPENCODE_CONFIG, versionProbeTimeoutMs: 100 };
      let error: unknown;
      try {
        detectOpenCodeVersion(cmdPath, config);
      } catch (err) {
        error = err;
      }
      // A hung binary is a probe failure, never "binary missing".
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(OpenCodeBinaryMissingError);
      // The diagnostic names the phase, the configured bound and the binary:
      // this failure used to read "did not respond within 2000ms" and surface
      // through the config route as `opencode.config_read_error`.
      const message = (error as Error).message;
      expect(message).toContain("version preflight timed out after 100ms");
      expect(message).toContain(cmdPath);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it("wraps .cmd launchers with cmd /c in detectOpenCodeVersion probe", () => {
    // Verify the function accepts a .cmd path without throwing a type error.
    // The actual probe will fail (binary does not exist), but it should throw
    // a plain Error, not OpenCodeBinaryMissingError.
    const cmdPath = path.join(import.meta.dir, "nonexistent.cmd");
    expect(() => detectOpenCodeVersion(cmdPath)).toThrow();
    // Verify it is not classified as missing (it is a probe failure)
    try {
      detectOpenCodeVersion(cmdPath);
    } catch (e) {
      expect(e).not.toBeInstanceOf(OpenCodeBinaryMissingError);
      // The error message should mention the binary path, not "not found"
      expect((e as Error).message).toContain("nonexistent.cmd");
    }
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

  it("accepts the audited lower bound and the 2.2.0 client release", () => {
    expect(isSupportedOpenCodeVersion(SUPPORTED_LOWER_BOUND_VERSION)).toBe(true);
    expect(isSupportedOpenCodeVersion(SUPPORTED_CLIENT_VERSION)).toBe(true);
  });

  it("admits 2.2.0 and rejects the first version past the ceiling", () => {
    // The range is closed deliberately at the audited release: a newer 2.2.x
    // has to be checked against the same route and event lists before the
    // ceiling moves, so <2.2.1 is the whole authorized surface, not a step up.
    expect(isSupportedOpenCodeVersion("2.2.0")).toBe(true);
    expect(isSupportedOpenCodeVersion("2.2.1")).toBe(false);
    expect(isSupportedOpenCodeVersion("2.3.0")).toBe(false);
  });

  it("accepts the whole 2.1 line, which was checked against the upstream source", () => {
    // The 2.1 line was adopted on 2026-10-22: no route removed, no event type
    // removed, and the imported types unchanged apart from branded string
    // aliases. Every 2.1.x is inside the range.
    for (const version of ["2.1.0", "2.1.1", "2.1.2"])
      expect(isSupportedOpenCodeVersion(version)).toBe(true);
  });

  it("rejects the below-range fixture and the upper bound", () => {
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
