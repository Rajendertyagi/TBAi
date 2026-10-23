/**
 * G2 lifecycle: the named shell -> sidecar kill chain, and the two Win32
 * facilities the database-ownership policy stands on.
 *
 * The Rust shell is replaced by `tests/fixtures/g2-shell.ts`, which creates the
 * SAME named kill-on-close job through the production helper. The sidecar
 * fixture joins it through the production `joinShellJob` and then spawns a
 * deliberately detached grandchild, so Bun's implicit parent-lifetime binding
 * cannot make the test pass on its own.
 *
 * The negative case is the load-bearing one: with `TBAI_SKIP_SHELL_JOB=1` the
 * sidecar and grandchild survive a hard shell kill. That is what fails if the
 * named job is removed or its handle is closed too early.
 *
 * Windows-only, like the mechanism. CI runs this suite on windows-latest.
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  acquireNamedMutex,
  backendJobStatus,
  findProcessesUsingFiles,
  installBackendProcessJob,
  joinShellJob,
  releaseNamedMutex,
  ShellJobUnavailableError,
} from "@/services/process-ownership.ts";
import { REPO_ROOT } from "../../helpers/repo-root";

const SHELL_FIXTURE = path.join(REPO_ROOT, "tests/fixtures/g2-shell.ts");
const HOLD_SCRIPT = `
import { openSync } from "node:fs";
const file = process.env.TBAI_HELD_FILE;
if (!file) throw new Error("TBAI_HELD_FILE is required");
openSync(file, "r+");
process.stdout.write("held\\n");
setInterval(() => {}, 1000);
`;

interface ShellRecord {
  readonly shellPid: number;
  readonly sidecarPid: number;
  readonly jobName: string;
}

interface SidecarRecord {
  readonly sidecarPid: number;
  readonly grandchildPid: number;
  readonly shellJobName: string;
  readonly backendJob: { readonly status: string };
}

interface LifecycleRun {
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly dir: string;
  readonly shell: ShellRecord;
  readonly sidecar: SidecarRecord;
  readonly grandchildPid: number;
  readonly port: string;
}

async function waitForFile(file: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await Bun.sleep(20);
  }
  return false;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

async function descendantAlive(port: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok && (await response.text()) === "alive";
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

async function waitForDead(pid: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await Bun.sleep(50);
  }
  return !pidAlive(pid);
}

function hardKill(pid: number): void {
  Bun.spawnSync(["taskkill", "/F", "/PID", String(pid)], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

/** Starts the shell stand-in and waits for the sidecar, grandchild, and port. */
async function startLifecycle(skipShellJob: boolean): Promise<LifecycleRun> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-g2-lifecycle-"));
  const child = Bun.spawn(["bun", SHELL_FIXTURE], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TBAI_G2_DIR: dir,
      TBAI_SKIP_SHELL_JOB: skipShellJob ? "1" : "0",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const shellFile = path.join(dir, "shell.json");
  const sidecarFile = path.join(dir, "sidecar.json");
  const markerFile = path.join(dir, "grandchild");
  const spawned = await waitForFile(shellFile);
  const announced = await waitForFile(sidecarFile);
  const probed = await waitForFile(markerFile);
  if (!spawned || !announced || !probed) {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `G2 lifecycle did not start (shell=${spawned}, sidecar=${announced}, grandchild=${probed})`,
    );
  }
  const shell = readJson<ShellRecord>(shellFile);
  const sidecar = readJson<SidecarRecord>(sidecarFile);
  const [grandchildPid, port] = fs.readFileSync(markerFile, "utf8").trim().split(":");
  return {
    child,
    dir,
    shell,
    sidecar,
    grandchildPid: Number(grandchildPid),
    port,
  };
}

async function cleanup(run: LifecycleRun): Promise<void> {
  hardKill(run.sidecar.sidecarPid);
  hardKill(run.grandchildPid);
  hardKill(run.shell.shellPid);
  if (run.child.exitCode === null) run.child.kill();
  await run.child.exited.catch(() => undefined);
  fs.rmSync(run.dir, { recursive: true, force: true });
}

describe("G2 Windows process ownership", () => {
  it.skipIf(process.platform !== "win32")("installs the backend job and reports it", () => {
    const status = installBackendProcessJob();
    expect(status.status).toBe("installed");
    expect(backendJobStatus()).toEqual(status);
  });

  it.skipIf(process.platform !== "win32")(
    "a named mutex is exclusive until its holder releases it",
    () => {
      const name = `Local\\TBAiG2Mutex-${process.pid}-${Date.now()}`;
      const first = acquireNamedMutex(name);
      expect(first).not.toBeNull();
      expect(acquireNamedMutex(name)).toBeNull();
      if (first === null) throw new Error("expected the first mutex acquisition to succeed");
      releaseNamedMutex(first);
      const again = acquireNamedMutex(name);
      expect(again).not.toBeNull();
      if (again === null) throw new Error("expected the mutex to be acquirable after release");
      releaseNamedMutex(again);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "refuses to join a shell job that no longer exists",
    () => {
      expect(() => joinShellJob(`Local\\TBAiG2Missing-${process.pid}-${Date.now()}`)).toThrow(
        ShellJobUnavailableError,
      );
    },
  );

  it.skipIf(process.platform !== "win32")(
    "Restart Manager names the process holding a registered file",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-g2-rm-"));
      const file = path.join(dir, "held.db");
      fs.writeFileSync(file, "held");
      const holder = Bun.spawn(["bun", "-e", HOLD_SCRIPT], {
        env: { ...process.env, TBAI_HELD_FILE: file },
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const deadline = Date.now() + 10000;
        let pids: number[] = [];
        while (Date.now() < deadline) {
          pids = findProcessesUsingFiles([file]);
          if (pids.includes(holder.pid)) break;
          await Bun.sleep(50);
        }
        expect(pids).toContain(holder.pid);
      } finally {
        holder.kill();
        await holder.exited;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    20000,
  );

  it.skipIf(process.platform !== "win32")(
    "hard-killing the shell kills the sidecar and its detached descendant",
    async () => {
      const run = await startLifecycle(false);
      try {
        expect(run.sidecar.backendJob.status).toBe("installed");
        expect(await descendantAlive(run.port)).toBe(true);

        // Exactly the crash path: no graceful sidecar stop, no cleanup hook.
        hardKill(run.shell.shellPid);
        await run.child.exited.catch(() => undefined);

        expect(await waitForDead(run.sidecar.sidecarPid)).toBe(true);
        expect(await waitForDead(run.grandchildPid)).toBe(true);
        expect(await descendantAlive(run.port)).toBe(false);
      } finally {
        await cleanup(run);
      }
    },
    30000,
  );

  it.skipIf(process.platform !== "win32")(
    "without the shell-job join, the sidecar and descendant survive the shell kill",
    async () => {
      const run = await startLifecycle(true);
      try {
        expect(await descendantAlive(run.port)).toBe(true);
        hardKill(run.shell.shellPid);
        await run.child.exited.catch(() => undefined);
        await Bun.sleep(500);

        // The counterfactual: Bun's implicit binding is not in play because the
        // shell spawned the sidecar detached, and the sidecar did not join the
        // named shell job. Both processes must still be alive.
        expect(pidAlive(run.sidecar.sidecarPid)).toBe(true);
        expect(await descendantAlive(run.port)).toBe(true);
      } finally {
        await cleanup(run);
      }
    },
    30000,
  );
});
