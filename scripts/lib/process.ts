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
 * ## Parent ids are not identities
 *
 * MEASURED 2026-10-26: a G3 cleanup reported `pid 18848` as a survivor of a
 * tree it did not belong to. 18848 was `MicrosoftEdgeUpdate`, created the
 * previous day, whose *creator's* pid had since been reused by the TBAi app the
 * driver had just started. Windows keeps the numeric `ParentProcessId` forever,
 * so a stale edge points into a live tree. Two consequences, both real:
 *
 * - the pid was reported as an unstopped child, failing a run whose server had
 *   in fact stopped cleanly;
 * - `taskkill /T` walks the same parent links, so it would have terminated an
 *   unrelated process.
 *
 * So an edge is only believed when the child was created **at or after** its
 * parent — impossible to be false for a real child, and false for every
 * recycled id — and the tree is terminated pid by pid instead of by `/T`, which
 * cannot distinguish the two cases. See `descendantsOf` and `stopProcessTree`.
 *
 * Where creation times are unavailable (POSIX `ps` without `etimes`) the guard
 * is inert and the old parent-id-only behaviour remains; the drivers currently
 * run on Windows and Linux, and both supply times.
 *
 * Windows force-terminates; a graceful signal is not deliverable there.
 * POSIX gets SIGTERM, then SIGKILL for survivors.
 */
import { spawnSync } from "node:child_process";
import net from "node:net";

const PS_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 10_000;
const STOP_CONFIRM_TIMEOUT_MS = 15_000;
/**
 * Slack when judging a creation instant derived from `ps etimes`: one-second
 * granularity plus a per-listing `now` can move it by up to a second.
 */
const CREATION_TIME_SLACK_MS = 2_000;

export interface ProcessEntry {
  readonly pid: number;
  readonly parentPid: number;
  /**
   * When the process was created, in epoch milliseconds.
   *
   * Absent when the platform could not supply it; every consumer must treat
   * "unknown" as "cannot judge", never as zero.
   */
  readonly createdAtMs?: number;
}

/**
 * Parses a Windows `CreationDate` in either form PowerShell emits.
 *
 * PowerShell 5.1 serializes `DateTime` as `\/Date(1761384561000)\/`; PowerShell 7
 * emits ISO 8601. Both are accepted, and anything else yields `undefined` rather
 * than a wrong instant.
 */
export function parseWindowsCreationDate(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const msForm = /\/Date\((\d+)\)\//.exec(value);
  if (msForm) return Number(msForm[1]);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
      const createdAtMs = parseWindowsCreationDate(record.CreationDate);
      entries.push(
        createdAtMs === undefined ? { pid, parentPid } : { pid, parentPid, createdAtMs },
      );
    }
  }
  return entries;
}

/**
 * Parses `ps -eo pid=,ppid=,etimes=` output.
 *
 * `etimes` is seconds since the process started, so the creation instant is
 * derived from `nowMs`. Entries that do not carry the third column are kept
 * without a creation time, which leaves the recycled-id guard inert rather than
 * guessing one.
 */
export function parsePsProcessTable(text: string, nowMs: number = Date.now()): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)(?:\s+(\d+))?\s*$/.exec(line);
    if (!match) continue;
    const entry: ProcessEntry = { pid: Number(match[1]), parentPid: Number(match[2]) };
    if (match[3] !== undefined) {
      entries.push({ ...entry, createdAtMs: nowMs - Number(match[3]) * 1000 });
    } else {
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * Every descendant of `rootPid`, depth-first, cycle-safe, root excluded.
 *
 * An edge is only followed when the child's creation time does not precede its
 * parent's. A real child cannot exist before its parent was created, so an
 * inverted edge can only mean the parent id was recycled — following it would
 * hand the caller an unrelated process to terminate. When either timestamp is
 * unknown the edge is kept: the rule removes provably impossible children, it
 * does not claim more than it can prove.
 */
export function descendantsOf(rootPid: number, table: readonly ProcessEntry[]): number[] {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of table) {
    const list = children.get(entry.parentPid);
    if (list) list.push(entry);
    else children.set(entry.parentPid, [entry]);
  }
  const createdById = new Map<number, number>();
  for (const entry of table) {
    if (entry.createdAtMs !== undefined) createdById.set(entry.pid, entry.createdAtMs);
  }
  const isPossibleChild = (parentPid: number, child: ProcessEntry): boolean => {
    const parentCreated = createdById.get(parentPid);
    return (
      parentCreated === undefined ||
      child.createdAtMs === undefined ||
      child.createdAtMs >= parentCreated
    );
  };
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  const descendants: number[] = [];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of children.get(current) ?? []) {
      if (seen.has(child.pid)) continue;
      if (!isPossibleChild(current, child)) continue;
      seen.add(child.pid);
      descendants.push(child.pid);
      queue.push(child.pid);
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

/**
 * A snapshot of every process the platform will report, with creation times
 * where it can supply them (see `parseWindowsCreationDate` and `parsePsProcessTable`).
 */
export function listProcessTable(): ProcessEntry[] {
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress",
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
  const withElapsed = spawnSync("ps", ["-eo", "pid=,ppid=,etimes="], {
    encoding: "utf8",
    timeout: PS_TIMEOUT_MS,
  });
  if (withElapsed.status === 0) return parsePsProcessTable(withElapsed.stdout);
  // BusyBox ps and some minimal images have no `etimes`. The table is still
  // useful for parent links, so fall back instead of failing the whole stop; the
  // recycled-id guard then simply has nothing to judge, which `survivorsOf`
  // treats as "cannot tell" rather than as an identity match.
  const withoutElapsed = spawnSync("ps", ["-eo", "pid=,ppid="], {
    encoding: "utf8",
    timeout: PS_TIMEOUT_MS,
  });
  if (withoutElapsed.status !== 0) {
    throw new Error(
      `could not list processes (ps exit ${withoutElapsed.status ?? "null"}): ${(withoutElapsed.stderr ?? "").trim()}`,
    );
  }
  return parsePsProcessTable(withoutElapsed.stdout);
}

/**
 * The recorded pids that are still running the SAME process.
 *
 * This is deliberately not a bare `isProcessAlive` loop. A pid that is alive
 * after a stop can be a **recycled** pid, and treating it as a survivor fails a
 * run that stopped cleanly — MEASURED 2026-10-26, when `pid 18848`
 * (`MicrosoftEdgeUpdate`, created the day before) was reported as a surviving
 * TBAi child. A live pid counts only when it also passes:
 *
 * - it appears in the current table (a pid that is alive but absent from a
 *   successful snapshot started after that snapshot, i.e. it was recycled); and
 * - its creation instant is unknown, or it is not later than the moment the stop
 *   began (`CREATION_TIME_SLACK_MS` covers the `ps etimes` derivation error).
 *
 * `current` is null when the table could not be fetched: the caller has no
 * identity evidence, so plain liveness is all that is left.
 */
export function survivorsOf(
  recordedPids: readonly number[],
  current: readonly ProcessEntry[] | null,
  stopStartedAtMs: number,
  isAlive: (pid: number) => boolean = isProcessAlive,
): number[] {
  const createdAtById = new Map<number, number | undefined>();
  for (const entry of current ?? []) createdAtById.set(entry.pid, entry.createdAtMs);
  const survivors: number[] = [];
  for (const pid of recordedPids) {
    if (!isAlive(pid)) continue;
    if (current === null) {
      survivors.push(pid);
      continue;
    }
    if (!createdAtById.has(pid)) continue;
    const createdAtMs = createdAtById.get(pid);
    if (createdAtMs === undefined || createdAtMs <= stopStartedAtMs + CREATION_TIME_SLACK_MS) {
      survivors.push(pid);
    }
  }
  return survivors;
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
 * Whether a failed `taskkill` means the pid was already gone.
 *
 * Windows answers 128 ("process not found") when the pid is not in the table,
 * and exit 1 with `ERROR: The process with PID <n> could not be terminated.` /
 * `Reason: There is no running instance of the task.` when the pid exited
 * between the snapshot and the kill — measured on the windows-2025 runner, run
 * 40869474036, where recording that as a cleanup failure failed a run whose
 * observation had succeeded.
 *
 * Tolerating the text form cannot hide a survivor: `stopProcessTree` confirms
 * the stop against a fresh process table, so a pid that really survived is
 * reported from `survivors`, not from taskkill's complaint. The text is matched
 * for reporting only, never as the confirmation.
 */
export function isTaskkillAlreadyGone(status: number | null, stderr: string): boolean {
  if (status === 128) return true;
  if (status !== 1) return false;
  return stderr.toLowerCase().includes("no running instance of the task");
}

/**
 * Stops `pid` and every descendant recorded before the stop, then confirms each
 * pid is gone. Never throws: a failure to stop is returned, so a caller's
 * evidence records it instead of dying before it can be written.
 *
 * Windows terminates pid by pid instead of `taskkill /T`. `/T` re-walks the
 * parent links at kill time, so a stale edge (see the header) would hand an
 * unrelated process to the kill; the pids here were already resolved from a
 * snapshot, with provably-possible edges only, so the tree does not need to be
 * live to be terminated. The root goes first so it cannot spawn anything new,
 * and killing a child after its parent is gone is exactly what `/T` could not
 * do.
 */
export function stopProcessTree(pid: number, graceMs: number = STOP_GRACE_MS): ProcessStopResult {
  const errors: string[] = [];
  const stopStartedAtMs = Date.now();
  let descendants: number[] = [];
  try {
    descendants = descendantsOf(pid, listProcessTable());
  } catch (error) {
    errors.push(`could not list the process tree before stopping: ${errorMessage(error)}`);
  }
  const recordedPids = [pid, ...descendants];

  let method: string;
  if (process.platform === "win32") {
    method = "taskkill /F per recorded pid";
    for (const target of recordedPids) {
      const result = spawnSync("taskkill", ["/PID", String(target), "/F"], {
        encoding: "utf8",
        windowsHide: true,
      });
      // A pid that already exited is success: Windows reports that as 128
      // ("not found") or, on newer builds, 1 with "no running instance".
      if (result.status !== 0 && !isTaskkillAlreadyGone(result.status, result.stderr ?? "")) {
        errors.push(
          `taskkill /F /PID ${target} exited ${result.status ?? "null"}: ${(result.stderr ?? "").trim()}`,
        );
      }
    }
  } else {
    method = "SIGTERM then SIGKILL";
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (errnoOf(error) !== "ESRCH") errors.push(`SIGTERM failed: ${errorMessage(error)}`);
    }
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && recordedPids.some(isProcessAlive)) {
      sleepSync(100);
    }
    for (const target of recordedPids) {
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

  // Confirmation needs a fresh table each poll: without one, a recycled pid is
  // indistinguishable from a survivor. Transient listing failures are not
  // recorded as errors - `assessG3Evidence` fails a run on every cleanup error,
  // and a failed listing is not evidence that a process survived.
  const deadline = Date.now() + STOP_CONFIRM_TIMEOUT_MS;
  let current = refreshedTable();
  let survivors = survivorsOf(recordedPids, current, stopStartedAtMs);
  while (survivors.length > 0 && Date.now() < deadline) {
    sleepSync(100);
    current = refreshedTable();
    survivors = survivorsOf(recordedPids, current, stopStartedAtMs);
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

/** A process table, or null when the platform would not supply one. */
function refreshedTable(): ProcessEntry[] | null {
  try {
    return listProcessTable();
  } catch {
    return null;
  }
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
