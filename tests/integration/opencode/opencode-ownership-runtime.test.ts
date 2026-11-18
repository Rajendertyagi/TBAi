/**
 * G2 acceptance against a real OpenCode server (the resolved binary) and an
 * isolated database under the approved Client-Daemon Architecture.
 *
 * Opt-in, exactly like the other runtime suites:
 *
 *   TBAI_OPENCODE_RUNTIME_TESTS=1 \
 *   OPENCODE_BINARY=C:\path\to\opencode.exe \
 *   bun test tests/integration/opencode/opencode-ownership-runtime.test.ts
 *
 * What it proves:
 *
 * 1. Foreign `opencode serve` co-tenancy: a foreign OpenCode process holding or
 *    using the isolated database does NOT cause TBAi to refuse startup. SQLite WAL
 *    provides safe concurrency; both services remain running and neither process
 *    is killed or interfered with.
 * 2. Managed-only runtime: a registered external OpenCode service is not adopted;
 *    TBAi starts its own managed server, publishes managed registration, and does
 *    not terminate the external service.
 * 3. Managed process lifecycle: a managed server started on its database is killed
 *    with the sidecar when the desktop shell is hard-killed (via the Windows Job
 *    Object contract), its registration is updated on clean restart, and no orphan
 *    remains.
 *
 * Windows-only. The database is always a fresh path under this test's temp root;
 * every PID it kills came from a file it wrote and a path it asserted.
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { OPENCODE_CONFIG } from "@/config/opencode.ts";
import { resolveManagedBinary } from "@/services/opencode/runtime.ts";
import {
  allocateTestLoopbackPort,
  assertRuntimeIsolationPaths,
  buildIsolatedDrillEnv,
  createRuntimeIsolation,
  runtimeAuthHeaders,
  runtimeUnavailableReason,
  writeIsolatedOpenCodeConfig,
  type RuntimeIsolation,
} from "../../harness/opencodeRuntimeHarness";
import { REPO_ROOT } from "../../helpers/repo-root";

const describeG2 =
  runtimeUnavailableReason() === undefined && process.platform === "win32"
    ? describe
    : describe.skip;

const SHELL_FIXTURE = path.join(REPO_ROOT, "tests/fixtures/g2-shell.ts");
const REAL_SIDECAR_FIXTURE = path.join(REPO_ROOT, "tests/fixtures/g2-opencode-sidecar.ts");
const FOREIGN_PASSWORD = "tbai-g2-foreign-only";

interface ShellRecord {
  readonly shellPid: number;
  readonly sidecarPid: number;
  readonly jobName: string;
}

interface ReadyRecord {
  readonly sidecarPid: number;
  readonly baseUrl: string;
  readonly dbPath: string;
  readonly managedPid: number | null;
  readonly adoptedPid: number | null;
  readonly mode: "managed" | "adopted";
  readonly backendJob: { readonly status: string };
}

interface ErrorRecord {
  readonly name: string;
  readonly message: string;
}

interface RealRun {
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly dir: string;
  readonly shell: ShellRecord;
  readonly ready: ReadyRecord | null;
  readonly error: ErrorRecord | null;
}

async function waitForFile(file: string, timeoutMs = 60000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await Bun.sleep(50);
  }
  return false;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

async function descendantAlive(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1000) });
    return response.status > 0;
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  const out = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return out.stdout.toString().includes(`"${pid}"`);
}

async function waitForDead(pid: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await Bun.sleep(100);
  }
  return !pidAlive(pid);
}

function hardKill(pid: number): void {
  Bun.spawnSync(["taskkill", "/F", "/PID", String(pid)], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

function createIsolation(label: string): RuntimeIsolation {
  const isolation = createRuntimeIsolation(
    `g2-real-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  writeIsolatedOpenCodeConfig(isolation, {});
  assertRuntimeIsolationPaths(isolation);
  return isolation;
}

function isolatedEnv(
  isolation: RuntimeIsolation,
  binary: string,
  runDir: string,
  extraEnv: Record<string, string | undefined> = {},
): Record<string, string> {
  return buildIsolatedDrillEnv(isolation, {
    OPENCODE_BINARY: binary,
    TBAI_G2_DIR: runDir,
    TBAI_G2_SIDECAR: REAL_SIDECAR_FIXTURE,
    ...extraEnv,
  });
}

async function waitForPort(baseUrl: string, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await descendantAlive(baseUrl)) return true;
    await Bun.sleep(100);
  }
  return false;
}

async function startRealShell(
  isolation: RuntimeIsolation,
  binary: string,
  runDir: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<RealRun> {
  fs.mkdirSync(runDir, { recursive: true });
  const child = Bun.spawn(["bun", SHELL_FIXTURE], {
    cwd: REPO_ROOT,
    env: isolatedEnv(isolation, binary, runDir, extraEnv),
    stdout: "ignore",
    stderr: "ignore",
  });
  const shellFile = path.join(runDir, "shell.json");
  const readyFile = path.join(runDir, "ready.json");
  const errorFile = path.join(runDir, "error.json");
  const shellSpawned = await waitForFile(shellFile, 15000);
  if (!shellSpawned) {
    child.kill();
    throw new Error("G2 shell did not write shell.json");
  }
  const shell = readJson<ShellRecord>(shellFile);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyFile)) {
      return { child, dir: runDir, shell, ready: readJson<ReadyRecord>(readyFile), error: null };
    }
    if (fs.existsSync(errorFile)) {
      return { child, dir: runDir, shell, ready: null, error: readJson<ErrorRecord>(errorFile) };
    }
    if (child.exitCode !== null) break;
    await Bun.sleep(100);
  }
  child.kill();
  throw new Error("G2 sidecar neither reported ready nor wrote an error");
}

async function cleanupRun(run: RealRun): Promise<void> {
  hardKill(run.shell.shellPid);
  hardKill(run.shell.sidecarPid);
  if (run.child.exitCode === null) run.child.kill();
  await run.child.exited.catch(() => undefined);
  fs.rmSync(run.dir, { recursive: true, force: true });
}

describeG2("G2 real-server client-daemon runtime acceptance", () => {
  it("allows concurrent database access under SQLite WAL co-tenancy without foreign-holder refusal", async () => {
    const binary = resolveManagedBinary(OPENCODE_CONFIG).path;
    const isolation = createIsolation("wal-cotenancy");
    const foreignPort = allocateTestLoopbackPort();
    const foreign = Bun.spawn(
      [binary, "serve", "--port", String(foreignPort), "--hostname", "127.0.0.1"],
      {
        cwd: isolation.homeDir,
        env: {
          ...isolatedEnv(isolation, binary, path.join(isolation.root, "foreign-run")),
          OPENCODE_PASSWORD: FOREIGN_PASSWORD,
          OPENCODE_SERVER_PASSWORD: FOREIGN_PASSWORD,
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    const runDir = path.join(isolation.root, "managed");
    const foreignUrl = `http://127.0.0.1:${foreignPort}`;
    let run: RealRun | null = null;
    try {
      expect(await waitForPort(foreignUrl)).toBe(true);
      await fetch(`${foreignUrl}${OPENCODE_CONFIG.readinessProbePath}`, {
        headers: runtimeAuthHeaders(FOREIGN_PASSWORD),
        signal: AbortSignal.timeout(2000),
      }).catch(() => undefined);
      expect(pidAlive(foreign.pid)).toBe(true);

      // Start TBAi managed sidecar on the same database
      run = await startRealShell(isolation, binary, runDir);
      expect(run.error).toBeNull();
      expect(run.ready).not.toBeNull();
      if (!run.ready) throw new Error("managed run did not become ready");
      expect(run.ready.backendJob.status).toBe("installed");
      expect(path.resolve(run.ready.dbPath)).toBe(path.resolve(isolation.opencodeDbPath));

      // Both foreign OpenCode and managed OpenCode must be alive concurrently
      expect(pidAlive(foreign.pid)).toBe(true);
      const managedPid = run.ready.managedPid;
      expect(managedPid).toBeDefined();
      if (managedPid) {
        expect(pidAlive(managedPid)).toBe(true);
        expect(managedPid).not.toBe(foreign.pid);
      }
      expect(await descendantAlive(foreignUrl)).toBe(true);
      expect(await descendantAlive(run.ready.baseUrl)).toBe(true);

      // Verify WAL co-tenancy: shutting down managed sidecar leaves foreign OpenCode alive and untouched
      await cleanupRun(run);
      run = null;
      expect(pidAlive(foreign.pid)).toBe(true);
      expect(await descendantAlive(foreignUrl)).toBe(true);
    } finally {
      if (run) await cleanupRun(run);
      hardKill(foreign.pid);
      await foreign.exited.catch(() => undefined);
      fs.rmSync(isolation.root, { recursive: true, force: true });
    }
  }, 120000);

  it("ignores a registered external OpenCode service and starts its own managed server", async () => {
    const binary = resolveManagedBinary(OPENCODE_CONFIG).path;
    const isolation = createIsolation("managed-only-ignores-external");
    const servicePort = allocateTestLoopbackPort();
    const serviceUrl = `http://127.0.0.1:${servicePort}`;
    const service = Bun.spawn(
      [binary, "serve", "--port", String(servicePort), "--hostname", "127.0.0.1"],
      {
        cwd: isolation.homeDir,
        env: {
          ...isolatedEnv(isolation, binary, path.join(isolation.root, "service-run")),
          OPENCODE_PASSWORD: FOREIGN_PASSWORD,
          OPENCODE_SERVER_PASSWORD: FOREIGN_PASSWORD,
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    let run: RealRun | null = null;
    try {
      expect(await waitForPort(serviceUrl)).toBe(true);
      await fetch(`${serviceUrl}${OPENCODE_CONFIG.readinessProbePath}`, {
        headers: runtimeAuthHeaders(FOREIGN_PASSWORD),
        signal: AbortSignal.timeout(2000),
      }).catch(() => undefined);
      expect(pidAlive(service.pid)).toBe(true);

      // Write a service.json registration pointing to the running external service.
      // Managed-only runtime must not adopt or attach to it.
      const regDir = path.join(isolation.xdgStateHome, "opencode");
      fs.mkdirSync(regDir, { recursive: true });
      const regPath = path.join(regDir, "service.json");
      fs.writeFileSync(
        regPath,
        JSON.stringify({
          url: serviceUrl,
          pid: service.pid,
          password: FOREIGN_PASSWORD,
          version: "2.2.6",
        }),
      );

      const runDir = path.join(isolation.root, "sidecar-run");
      run = await startRealShell(isolation, binary, runDir);
      expect(run.error).toBeNull();
      expect(run.ready).not.toBeNull();
      if (!run.ready) throw new Error("sidecar did not become ready");

      expect(run.ready.mode).toBe("managed");
      expect(run.ready.adoptedPid).toBeNull();
      expect(run.ready.managedPid).not.toBeNull();
      if (run.ready.managedPid === null) throw new Error("no managed OpenCode PID found");
      expect(run.ready.managedPid).not.toBe(service.pid);
      expect(run.ready.baseUrl).not.toBe(serviceUrl);
      expect(pidAlive(run.ready.managedPid)).toBe(true);
      expect(await descendantAlive(run.ready.baseUrl)).toBe(true);

      // External service remains running and untouched by managed startup.
      expect(pidAlive(service.pid)).toBe(true);
      expect(await descendantAlive(serviceUrl)).toBe(true);

      // Registration is published for the managed child, not the external service.
      expect(fs.existsSync(regPath)).toBe(true);
      const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
      expect(reg.pid).toBe(run.ready.managedPid);

      // Cleaning up the managed sidecar does NOT terminate the external service.
      await cleanupRun(run);
      run = null;
      expect(pidAlive(service.pid)).toBe(true);
      expect(await descendantAlive(serviceUrl)).toBe(true);
    } finally {
      if (run) await cleanupRun(run);
      hardKill(service.pid);
      await service.exited.catch(() => undefined);
      fs.rmSync(isolation.root, { recursive: true, force: true });
    }
  }, 120000);

  it("kills the managed OpenCode with the shell and restarts on the same database", async () => {
    const binary = resolveManagedBinary(OPENCODE_CONFIG).path;
    const isolation = createIsolation("restart");
    const firstDir = path.join(isolation.root, "run-1");
    const secondDir = path.join(isolation.root, "run-2");
    let first: RealRun | null = null;
    let second: RealRun | null = null;
    try {
      first = await startRealShell(isolation, binary, firstDir);
      expect(first.error).toBeNull();
      expect(first.ready).not.toBeNull();
      if (!first.ready) throw new Error("first managed run did not become ready");
      expect(first.ready.backendJob.status).toBe("installed");
      expect(path.resolve(first.ready.dbPath)).toBe(path.resolve(isolation.opencodeDbPath));
      const firstSidecarPid = first.shell.sidecarPid;
      const firstOpenCode = first.ready.managedPid;
      expect(firstOpenCode).toBeDefined();
      if (firstOpenCode === null || firstOpenCode === undefined) {
        throw new Error("no managed OpenCode PID found");
      }
      expect(pidAlive(firstOpenCode)).toBe(true);
      expect(await descendantAlive(first.ready.baseUrl)).toBe(true);

      // Verify service registration was published for firstOpenCode
      const regPath = path.join(isolation.xdgStateHome, "opencode", "service.json");
      expect(fs.existsSync(regPath)).toBe(true);
      const reg1 = JSON.parse(fs.readFileSync(regPath, "utf8"));
      expect(reg1.pid).toBe(firstOpenCode);

      // Crash path: only the shell's job can save this; no graceful stop runs.
      hardKill(first.shell.shellPid);
      await first.child.exited.catch(() => undefined);
      expect(await waitForDead(firstSidecarPid)).toBe(true);
      expect(await waitForDead(firstOpenCode)).toBe(true);
      expect(await descendantAlive(first.ready.baseUrl)).toBe(false);

      second = await startRealShell(isolation, binary, secondDir);
      expect(second.error).toBeNull();
      expect(second.ready).not.toBeNull();
      if (!second.ready) throw new Error("second managed run did not become ready");
      expect(second.ready.backendJob.status).toBe("installed");
      expect(path.resolve(second.ready.dbPath)).toBe(path.resolve(isolation.opencodeDbPath));
      expect(second.ready.baseUrl).not.toBe(first.ready.baseUrl);
      expect(await descendantAlive(second.ready.baseUrl)).toBe(true);
      const secondSidecarPid = second.shell.sidecarPid;
      expect(secondSidecarPid).not.toBe(firstSidecarPid);
      const secondOpenCode = second.ready.managedPid;
      expect(secondOpenCode).toBeDefined();
      if (secondOpenCode === null || secondOpenCode === undefined) {
        throw new Error("no second OpenCode PID found");
      }
      expect(secondOpenCode).not.toBe(firstOpenCode);
      expect(pidAlive(secondOpenCode)).toBe(true);

      // Verify registration was updated for secondOpenCode
      const reg2 = JSON.parse(fs.readFileSync(regPath, "utf8"));
      expect(reg2.pid).toBe(secondOpenCode);
    } finally {
      if (second) await cleanupRun(second);
      if (first) await cleanupRun(first);
      await Bun.sleep(300);
      fs.rmSync(isolation.root, { recursive: true, force: true });
    }
  }, 180000);
});
