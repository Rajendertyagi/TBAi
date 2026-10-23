/**
 * G2 acceptance against a real OpenCode 2.1.2 server and an isolated database.
 *
 * Opt-in, exactly like the other runtime suites:
 *
 *   TBAI_OPENCODE_RUNTIME_TESTS=1 \
 *   OPENCODE_BINARY=D:\Coding\OpenCode\opencode.exe \
 *   bun test tests/integration/opencode/opencode-ownership-runtime.test.ts
 *
 * What it proves:
 *
 * 1. A foreign `opencode serve` that already holds the isolated database makes
 *    the managed sidecar refuse with `OpenCodeDatabaseBusyError`; the foreign
 *    process is left untouched.
 * 2. A managed server started on its own database is killed with the sidecar
 *    when the desktop shell is hard-killed (the named job), not merely when the
 *    sidecar exits gracefully.
 * 3. Restarting on the same database after that kill succeeds, with no orphan
 *    and no second server holding the file.
 *
 * Windows-only. The database is always a fresh path under this test's temp root;
 * every PID it kills came from a file it wrote and a path it asserted.
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { OPENCODE_CONFIG } from "@/config/opencode.ts";
import { allocateLoopbackPort } from "@/services/opencode/serverManager.ts";
import { existingDatabaseFiles } from "@/services/opencode/ownership.ts";
import { findProcessesUsingFiles } from "@/services/process-ownership.ts";
import { resolveManagedBinary } from "@/services/opencode/runtime.ts";
import { runtimeAuthHeaders, runtimeUnavailableReason } from "../../harness/opencodeRuntimeHarness";
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
  readonly holders: number[];
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

interface Isolation {
  readonly root: string;
  readonly dataHome: string;
  readonly dataDir: string;
  readonly configHome: string;
  readonly homeDir: string;
  readonly dbPath: string;
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

function createIsolation(label: string): Isolation {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tbai-g2-real-${label}-`));
  const dataHome = path.join(root, "xdg-data");
  const dataDir = path.join(root, "tbai-data");
  const configHome = path.join(root, "xdg-config");
  const homeDir = path.join(root, "home");
  const openCodeConfigDir = path.join(configHome, "opencode");
  for (const dir of [dataHome, dataDir, configHome, openCodeConfigDir, homeDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const dbPath = path.join(dataHome, "opencode", "opencode.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return {
    root,
    dataHome,
    dataDir,
    configHome,
    homeDir,
    dbPath,
  };
}

function isolatedEnv(isolation: Isolation, binary: string, runDir: string): Record<string, string> {
  return {
    ...process.env,
    OPENCODE_BINARY: binary,
    OPENCODE_DB: isolation.dbPath,
    XDG_DATA_HOME: isolation.dataHome,
    XDG_CONFIG_HOME: isolation.configHome,
    OPENCODE_CONFIG_DIR: path.join(isolation.configHome, "opencode"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    DATA_DIR: isolation.dataDir,
    TBAI_G2_DIR: runDir,
    TBAI_G2_SIDECAR: REAL_SIDECAR_FIXTURE,
  } as Record<string, string>;
}

function holdersOf(dbPath: string): number[] {
  if (!fs.existsSync(dbPath)) return [];
  try {
    return findProcessesUsingFiles(existingDatabaseFiles(dbPath));
  } catch {
    return [];
  }
}

async function waitForHolders(
  dbPath: string,
  predicate: (pids: number[]) => boolean,
  timeoutMs = 20000,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let pids: number[] = [];
  while (Date.now() < deadline) {
    pids = holdersOf(dbPath);
    if (predicate(pids)) return pids;
    await Bun.sleep(100);
  }
  return pids;
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
  isolation: Isolation,
  binary: string,
  runDir: string,
): Promise<RealRun> {
  fs.mkdirSync(runDir, { recursive: true });
  const child = Bun.spawn(["bun", SHELL_FIXTURE], {
    cwd: REPO_ROOT,
    env: isolatedEnv(isolation, binary, runDir),
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

describeG2("G2 real-server database ownership", () => {
  it("refuses when a foreign OpenCode already holds the database, and leaves it running", async () => {
    const binary = resolveManagedBinary(OPENCODE_CONFIG).path;
    const isolation = createIsolation("foreign");
    const foreignPort = allocateLoopbackPort();
    const foreign = Bun.spawn([binary, "serve", "--port", String(foreignPort)], {
      cwd: isolation.homeDir,
      env: {
        ...isolatedEnv(isolation, binary, path.join(isolation.root, "unused")),
        OPENCODE_PASSWORD: FOREIGN_PASSWORD,
        OPENCODE_SERVER_PASSWORD: FOREIGN_PASSWORD,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    const runDir = path.join(isolation.root, "managed");
    const foreignUrl = `http://127.0.0.1:${foreignPort}`;
    try {
      expect(await waitForPort(foreignUrl)).toBe(true);
      await fetch(`${foreignUrl}${OPENCODE_CONFIG.readinessProbePath}`, {
        headers: runtimeAuthHeaders(FOREIGN_PASSWORD),
        signal: AbortSignal.timeout(2000),
      }).catch(() => undefined);
      const foreignPids = await waitForHolders(
        isolation.dbPath,
        (pids) => pids.includes(foreign.pid),
        30000,
      );
      expect(foreignPids).toContain(foreign.pid);

      const run = await startRealShell(isolation, binary, runDir);
      try {
        expect(run.error?.name).toBe("OpenCodeDatabaseBusyError");
        expect(run.ready).toBeNull();
        expect(pidAlive(foreign.pid)).toBe(true);
        // The managed sidecar must be gone: refusal is not a second server.
        expect(await waitForDead(run.shell.sidecarPid, 10000)).toBe(true);
        const after = holdersOf(isolation.dbPath);
        expect(after).toContain(foreign.pid);
        expect(after).not.toContain(run.shell.sidecarPid);
      } finally {
        await cleanupRun(run);
      }
    } finally {
      hardKill(foreign.pid);
      await foreign.exited.catch(() => undefined);
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
      expect(path.resolve(first.ready.dbPath)).toBe(path.resolve(isolation.dbPath));
      const firstSidecarPid = first.shell.sidecarPid;

      const firstHolders = await waitForHolders(
        isolation.dbPath,
        (pids) => pids.some((pid) => pid !== firstSidecarPid && pid !== process.pid),
        20000,
      );
      const firstOpenCode = firstHolders.find(
        (pid) => pid !== firstSidecarPid && pid !== process.pid,
      );
      expect(firstOpenCode).toBeDefined();
      if (firstOpenCode === undefined) throw new Error("no OpenCode holder found");
      expect(await descendantAlive(first.ready.baseUrl)).toBe(true);

      // Crash path: only the shell's job can save this; no graceful stop runs.
      hardKill(first.shell.shellPid);
      await first.child.exited.catch(() => undefined);
      expect(await waitForDead(first.shell.sidecarPid)).toBe(true);
      expect(await waitForDead(firstOpenCode)).toBe(true);
      expect(await descendantAlive(first.ready.baseUrl)).toBe(false);
      expect(await waitForHolders(isolation.dbPath, (pids) => pids.length === 0, 15000)).toEqual(
        [],
      );

      second = await startRealShell(isolation, binary, secondDir);
      expect(second.error).toBeNull();
      expect(second.ready).not.toBeNull();
      if (!second.ready) throw new Error("second managed run did not become ready");
      expect(second.ready.backendJob.status).toBe("installed");
      expect(path.resolve(second.ready.dbPath)).toBe(path.resolve(isolation.dbPath));
      expect(second.ready.baseUrl).not.toBe(first.ready.baseUrl);
      expect(await descendantAlive(second.ready.baseUrl)).toBe(true);
      const secondSidecarPid = second.shell.sidecarPid;

      const secondHolders = await waitForHolders(
        isolation.dbPath,
        (pids) => pids.some((pid) => pid !== secondSidecarPid && pid !== process.pid),
        20000,
      );
      const secondOpenCode = secondHolders.find(
        (pid) => pid !== secondSidecarPid && pid !== process.pid,
      );
      expect(secondOpenCode).toBeDefined();
      if (secondOpenCode === undefined) throw new Error("no second OpenCode holder found");
      expect(secondOpenCode).not.toBe(firstOpenCode);
      // Exactly one managed server owns the database after the restart.
      expect(
        secondHolders.filter((pid) => pid !== secondSidecarPid && pid !== process.pid),
      ).toEqual([secondOpenCode]);
    } finally {
      if (second) await cleanupRun(second);
      if (first) await cleanupRun(first);
      await Bun.sleep(300);
      fs.rmSync(isolation.root, { recursive: true, force: true });
    }
  }, 180000);
});
