/**
 * Process-tree and port helpers for the CI drivers under `scripts/`.
 *
 * These exist because more than one driver has to stop a tree it did not
 * create: the G3 orchestrator stops a TBAi app with a managed OpenCode child,
 * and the origin-observation drivers stop `tauri-driver` and `tauri dev`, which
 * between them own a WebView2, a Rust build and a Bun dev server. Each of those
 * needs the same three things — a parent/child table, a confirmed stop, and a
 * free port to ask the OS for rather than guess.
 *
 * Windows is force-terminated with `taskkill /T /F` FIRST, while the root is
 * still alive, because that is the only way to walk the tree: a graceful signal
 * is not deliverable on Windows, and terminating the root first orphans the
 * children. POSIX gets SIGTERM, then SIGKILL for survivors.
 */
import { spawnSync } from "node:child_process";
import net from "node:net";

const PS_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 10_000;
const STOP_CONFIRM_TIMEOUT_MS = 15_000;

export interface ProcessEntry {
  readonly pid: number;
  readonly parentPid: number;
}

/** Parses the `Get-CimInstance ... | ConvertTo-Json -Compress` output. */
export function parseWindowsProcessTable(text: string): ProcessEntry[] {
  const parsed: unknown = JSON.parse(text);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const entries: ProcessEntry[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const pid = record.ProcessId;
    const parentPid = record.ParentProcessId;
    if (typeof pid === "number" && typeof parentPid === "number") {
      entries.push({ pid, parentPid });
    }
  }
  return entries;
}

/** Parses `ps -eo pid=,ppid=` output. */
export function parsePsProcessTable(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), parentPid: Number(match[2]) });
  }
  return entries;
}

/** Every descendant of `rootPid`, depth-first, cycle-safe, root excluded. */
export function descendantsOf(rootPid: number, table: readonly ProcessEntry[]): number[] {
  const children = new Map<number, number[]>();
  for (const entry of table) {
    const list = children.get(entry.parentPid);
    if (list) list.push(entry.pid);
    else children.set(entry.parentPid, [entry.pid]);
  }
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  const descendants: number[] = [];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function listProcessTable(): ProcessEntry[] {
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", windowsHide: true, timeout: PS_TIMEOUT_MS },
    );
    if (result.status !== 0) {
      throw new Error(
        `could not list processes (powershell exit ${result.status ?? "null"}): ${(result.stderr ?? "").trim()}`,
      );
    }
    return parseWindowsProcessTable(result.stdout);
  }
  const result = spawnSync("ps", ["-eo", "pid=,ppid="], {
    encoding: "utf8",
    timeout: PS_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(
      `could not list processes (ps exit ${result.status ?? "null"}): ${(result.stderr ?? "").trim()}`,
    );
  }
  return parsePsProcessTable(result.stdout);
}

export interface ProcessStopResult {
  readonly attempted: boolean;
  readonly method: string | null;
  readonly descendants: readonly number[];
  readonly survivors: readonly number[];
  readonly confirmed: boolean;
  readonly errors: readonly string[];
}

/**
 * Stops `pid` and every descendant recorded before the stop, then confirms each
 * pid is gone. Never throws: a failure to stop is returned, so a caller's
 * evidence records it instead of dying before it can be written.
 */
export function stopProcessTree(pid: number, graceMs: number = STOP_GRACE_MS): ProcessStopResult {
  const errors: string[] = [];
  let descendants: number[] = [];
  try {
    descendants = descendantsOf(pid, listProcessTable());
  } catch (error) {
    errors.push(`could not list the process tree before stopping: ${errorMessage(error)}`);
  }

  let method: string;
  if (process.platform === "win32") {
    method = "taskkill /T /F";
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });
    // 128 is "process not found", which is success when the app already exited.
    if (result.status !== 0 && result.status !== 128) {
      errors.push(`taskkill exited ${result.status ?? "null"}: ${(result.stderr ?? "").trim()}`);
    }
  } else {
    method = "SIGTERM then SIGKILL";
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (errnoOf(error) !== "ESRCH") errors.push(`SIGTERM failed: ${errorMessage(error)}`);
    }
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && [pid, ...descendants].some(isProcessAlive)) {
      sleepSync(100);
    }
    for (const target of [pid, ...descendants]) {
      if (!isProcessAlive(target)) continue;
      try {
        process.kill(target, "SIGKILL");
      } catch (error) {
        if (errnoOf(error) !== "ESRCH") {
          errors.push(`SIGKILL ${target} failed: ${errorMessage(error)}`);
        }
      }
    }
  }

  const deadline = Date.now() + STOP_CONFIRM_TIMEOUT_MS;
  let survivors = [pid, ...descendants].filter(isProcessAlive);
  while (survivors.length > 0 && Date.now() < deadline) {
    sleepSync(100);
    survivors = [pid, ...descendants].filter(isProcessAlive);
  }

  return {
    attempted: true,
    method,
    descendants,
    survivors,
    confirmed: survivors.length === 0,
    errors,
  };
}

/** A port the OS has just told us is free, bound to loopback only. */
export function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
