/**
 * A real managed OpenCode server, for tests that must exercise the genuine
 * process boundary rather than a stub of it.
 *
 * ## Why this exists
 *
 * Every existing test injected a FAKE_MANAGED_BINARY, so nothing ever asserted
 * that TBAi's spawn environment actually authenticates against a real OpenCode.
 * That is how the `OPENCODE_SERVER_PASSWORD` vs `OPENCODE_PASSWORD` mismatch
 * shipped: the whole suite was green, every fixture agreed with the production
 * constant, and the managed server still could not become ready against a real
 * build.
 *
 * ## Gating
 *
 * These tests are SKIPPED unless all of the following hold:
 *  - `TBAI_OPENCODE_RUNTIME_TESTS=1` (opt-in, so `bun run test` never depends on
 *    a 194 MB binary being installed)
 *  - a resolvable `opencode` binary
 *  - a version inside the managed range
 *
 * So the default gate stays hermetic, and CI can turn runtime coverage on
 * wherever a real OpenCode exists.
 *
 * @see opencode-runtime-harness.test.ts for the assertions themselves.
 */

import { spawn, type Subprocess } from "bun";
import path from "node:path";
import fs from "node:fs";
import { OPENCODE_CONFIG, type OpenCodeConfig } from "../../src/config/opencode";
import {
  detectOpenCodeVersion,
  isSupportedOpenCodeVersion,
  OpenCodeBinaryMissingError,
  resolveManagedBinary,
} from "../../src/services/opencode/runtime";

/** Opt-in switch; absent means the real-server tests are skipped. */
const RUNTIME_ENV_FLAG = "TBAI_OPENCODE_RUNTIME_TESTS";

/** Password for the real server. Never a production secret; test-local only. */
const RUNTIME_PASSWORD = "tbai-opencode-runtime-fixture";

/** Why the runtime tests are unavailable, or `undefined` when they can run. */
export type RuntimeUnavailableReason =
  | "not_opted_in"
  | "binary_missing"
  | "unsupported_version";

export interface RuntimeOpenCodeServer {
  readonly baseUrl: string;
  readonly port: number;
  readonly password: string;
  /** Auth headers for every subsequent request. */
  readonly headers: Record<string, string>;
  /** Fetch a server path, authenticated. Throws on a non-2xx response. */
  json<T = unknown>(pathname: string, init?: RequestInit): Promise<T>;
  /** Stop the child process. Safe to call more than once. */
  stop(): Promise<void>;
}

/** True when this run is allowed to talk to a real OpenCode process. */
export function runtimeTestsRequested(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[RUNTIME_ENV_FLAG] === "1";
}

/**
 * Report whether the real-server tests can run here, and why not when they
 * cannot. Callers use the reason as the skip message so an unavailable
 * environment is never mistaken for a passing test.
 */
export function runtimeUnavailableReason(
  env: Record<string, string | undefined> = process.env,
): RuntimeUnavailableReason | undefined {
  if (!runtimeTestsRequested(env)) return "not_opted_in";
  let binaryPath: string;
  try {
    binaryPath = resolveManagedBinary(OPENCODE_CONFIG).path;
  } catch (error) {
    if (error instanceof OpenCodeBinaryMissingError) return "binary_missing";
    throw error;
  }
  let version: string;
  try {
    version = detectOpenCodeVersion(binaryPath, OPENCODE_CONFIG);
  } catch {
    return "unsupported_version";
  }
  return isSupportedOpenCodeVersion(version, OPENCODE_CONFIG) ? undefined : "unsupported_version";
}

/** The auth header OpenCode 2.0.22 actually accepts. */
export function runtimeAuthHeaders(password: string = RUNTIME_PASSWORD): Record<string, string> {
  const credentials = Buffer.from(`${OPENCODE_CONFIG.authUsername}:${password}`).toString("base64");
  return { Authorization: `Basic ${credentials}` };
}

/** The exact child environment TBAi's serverManager sends. */
export function runtimeChildEnv(
  password: string = RUNTIME_PASSWORD,
  config: OpenCodeConfig = OPENCODE_CONFIG,
): Record<string, string> {
  return Object.fromEntries(config.authPasswordChildEnvVars.map((name) => [name, password]));
}

/**
 * Extra child environment for a test that needs a provider OpenCode can call.
 *
 * `OPENCODE_CONFIG_CONTENT` is OpenCode's own config channel, so a stub provider
 * declared this way is genuinely OPENCODE's provider: the turn still crosses real
 * authenticated HTTP through OpenCode's real session path. Nothing about the
 * auth or session boundary is bypassed - only the upstream model is replaced.
 */
export function runtimeChildEnvExtras(
  extras: Record<string, string> = {},
  password: string = RUNTIME_PASSWORD,
  config: OpenCodeConfig = OPENCODE_CONFIG,
): Record<string, string> {
  return { ...runtimeChildEnv(password, config), ...extras };
}

/**
 * Spawn a real `opencode serve`, wait for its readiness probe, and return a
 * handle for authenticated requests.
 *
 * @param config Overridable so a test gets an isolated home directory.
 * @param extras Extra child environment, applied AFTER the auth vars.
 * @param options.requireAuthenticated When false, readiness only requires the
 *   server to be LISTENING, so a test can assert that a credential is rejected.
 *   Defaults to true, which is the production contract.
 * @returns The running server, or throws when it never becomes ready.
 * @throws Error when the server does not answer its readiness probe in time.
 */
export async function startRuntimeOpenCodeServer(
  config: OpenCodeConfig = OPENCODE_CONFIG,
  extras: Record<string, string> = {},
  options: { requireAuthenticated?: boolean } = {},
): Promise<RuntimeOpenCodeServer> {
  const binary = resolveManagedBinary(config).path;
  const version = detectOpenCodeVersion(binary, config);
  if (!isSupportedOpenCodeVersion(version, config)) {
    throw new Error(`Unsupported OpenCode version for runtime tests: ${version}`);
  }
  fs.mkdirSync(config.serverHomeDir, { recursive: true });

  const port = await allocateRuntimePort();
  const password = RUNTIME_PASSWORD;
  const child = spawn([binary, "serve", "--port", String(port)], {
    cwd: config.serverHomeDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...runtimeChildEnvExtras(extras, password, config) },
    detached: process.platform !== "win32",
  });

  // Drain both pipes so a verbose server can never block on a full buffer and
  // wedge the child mid-test.
  void drain(child.stdout as ReadableStream<Uint8Array>);
  void drain(child.stderr as ReadableStream<Uint8Array>);

  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = runtimeAuthHeaders(password);
  await waitForRuntimeReady({
    baseUrl,
    headers,
    config,
    child,
    requireAuthenticated: options.requireAuthenticated ?? true,
  });

  let stopped = false;
  return {
    baseUrl,
    port,
    password,
    headers,
    async json<T>(pathname: string, init: RequestInit = {}): Promise<T> {
      const res = await fetch(`${baseUrl}${pathname}`, {
        ...init,
        headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`OpenCode ${pathname} -> ${res.status}: ${text.slice(0, 200)}`);
      }
      return (text ? JSON.parse(text) : undefined) as T;
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      await child.exited.catch(() => undefined);
    },
  };
}

/** Bounded readiness wait, mirroring `waitForHttpReady`. Fails loudly. */
async function waitForRuntimeReady(input: {
  baseUrl: string;
  headers: Record<string, string>;
  config: OpenCodeConfig;
  child: Subprocess;
  requireAuthenticated: boolean;
}): Promise<void> {
  const deadline = Date.now() + input.config.startupTimeoutMs;
  let lastStatus = "no-probe";
  while (Date.now() < deadline) {
    if (input.child.exitCode !== null) {
      throw new Error(`OpenCode exited early with code ${input.child.exitCode}`);
    }
    try {
      const res = await fetch(`${input.baseUrl}${input.config.readinessProbePath}`, {
        headers: input.headers,
        signal: AbortSignal.timeout(2000),
      });
      lastStatus = String(res.status);
      // A negative test spawns the server with a deliberately wrong credential,
      // so it asks for LISTENING rather than AUTHENTICATED and asserts the 401
      // itself. Production readiness always requires the authenticated path.
      if (!input.requireAuthenticated && res.status === 401) return;
      // 401 here is the exact failure this harness exists to catch, so it is
      // reported with the credential context rather than as a bare timeout.
      if (res.status === 401) {
        throw new Error(
          "OpenCode returned 401 to its own readiness probe: the spawned credential was not accepted. " +
            `Child env names: ${input.config.authPasswordChildEnvVars.join(", ")}.`,
        );
      }
      if (res.ok) return;
    } catch (error) {
      if (error instanceof Error && error.message.includes("401")) throw error;
    }
    await Bun.sleep(input.config.readyPollMs);
  }
  throw new Error(`OpenCode never became ready (last status ${lastStatus})`);
}

/** Bind :0 to learn a free loopback port, then release it. */
function allocateRuntimePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  const port = server.port;
  server.stop(true);
  if (!port) throw new Error("Failed to allocate a loopback port for the runtime test");
  return Promise.resolve(port);
}

/** Consume a stream so the child never blocks writing to it. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  for await (const _chunk of stream) {
    /* discard */
  }
}

/** An isolated config for one runtime test, so homes never collide. */
export function runtimeTestConfig(
  overrides: Partial<OpenCodeConfig> = {},
  suffix = "runtime",
): OpenCodeConfig {
  const home = path.join(
    process.env.TEMP ?? process.cwd(),
    "tbai-opencode-runtime",
    suffix,
  );
  return { ...OPENCODE_CONFIG, serverHomeDir: home, ...overrides };
}