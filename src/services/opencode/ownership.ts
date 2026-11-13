/**
 * OpenCode database path resolution (Phase 1: kernel watchdog decommissioned).
 *
 * The OpenCode startup/ownership path no longer acquires named mutexes, queries
 * Windows Restart Manager, enumerates processes, or inspects file holders/locks.
 * SQLite WAL provides concurrency for the canonical shared database; TBAi must not
 * police foreign processes. This module retains only pure/diagnostic helpers for
 * resolving the database path and a compatibility no-op lease API for callers.
 */
import { spawn } from "bun";
import fs from "node:fs";
import path from "node:path";

import { OPENCODE_CONFIG } from "../../config/opencode";

/** Thrown when the managed child's database path cannot be determined. */
export class OpenCodeDatabasePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeDatabasePathError";
  }
}

/**
 * @deprecated Phase 1 decommission: database busy/holder refusal removed from the
 * OpenCode startup path. Kept for compatibility; never thrown by this module.
 */
export class OpenCodeDatabaseBusyError extends Error {
  constructor(
    readonly details: {
      readonly dbPath: string;
      readonly pids: readonly number[];
      readonly reason: string;
    },
  ) {
    const holders = details.pids.length > 0 ? `; processes: ${details.pids.join(", ")}` : "";
    super(
      `OpenCode database is already in use (${details.reason}): ${details.dbPath}${holders}. ` +
        "TBAi will not start a second server against it. Close the other process, or point " +
        "TBAI at a separate OPENCODE_DB/XDG_DATA_HOME.",
    );
    this.name = "OpenCodeDatabaseBusyError";
  }
}

/**
 * @deprecated Phase 1 decommission: lease contention/mutex removed from the
 * OpenCode startup path. Kept for compatibility; never thrown by this module.
 */
export class OpenCodeDatabaseLeaseContendedError extends Error {
  constructor(
    readonly details: {
      readonly dbPath: string;
      readonly mutexName: string;
    },
  ) {
    super(
      `Another TBAi backend holds the OpenCode database lease for ${details.dbPath}. ` +
        "TBAi will wait for the existing shared service instead of starting a second server.",
    );
    this.name = "OpenCodeDatabaseLeaseContendedError";
  }
}

/**
 * @deprecated Phase 1 decommission: ownership verification/check refusal removed
 * from the OpenCode startup path. Kept for compatibility; never thrown by this module.
 */
export class OpenCodeDatabaseCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeDatabaseCheckError";
  }
}

/** The database files a live OpenCode server may hold (pure helper). */
export function existingDatabaseFiles(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((file) => fs.existsSync(file));
}

/** Extracts the path from `opencode debug paths db`, which prints one line. */
export function parseOpenCodeDatabasePath(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const candidate = lines.at(-1);
  if (!candidate) {
    throw new OpenCodeDatabasePathError("`opencode debug paths db` printed no path");
  }
  return candidate;
}

/**
 * Resolves the database path the managed child will use by running
 * `opencode debug paths db` with the same cwd and environment.
 *
 * `:memory:` is returned verbatim: it has no shared file and therefore no
 * ownership question. Every other path is resolved against `cwd` (OpenCode's
 * own relative-path anchor). This is a diagnostic/path-resolution helper and
 * never inspects file locks or foreign holders.
 *
 * @throws {OpenCodeDatabasePathError} on timeout, non-zero exit, or empty output.
 */
export async function resolveOpenCodeDatabasePath(
  binary: string,
  cwd: string,
  timeoutMs: number = OPENCODE_CONFIG.databasePathTimeoutMs,
): Promise<string> {
  const args =
    process.platform === "win32" && binary.toLowerCase().endsWith(".cmd")
      ? ["cmd", "/c", binary, "debug", "paths", "db"]
      : [binary, "debug", "paths", "db"];
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
  } catch (err) {
    throw new OpenCodeDatabasePathError(
      `Cannot run \`opencode debug paths db\`: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      child.exited,
    ]);
    if (timedOut) {
      throw new OpenCodeDatabasePathError(
        `\`opencode debug paths db\` did not finish within ${timeoutMs}ms`,
      );
    }
    if (exitCode !== 0) {
      const tail = stderr.trim().slice(-500);
      throw new OpenCodeDatabasePathError(
        `\`opencode debug paths db\` exited with code ${exitCode}${tail ? `: ${tail}` : ""}`,
      );
    }
    const printed = parseOpenCodeDatabasePath(stdout);
    if (printed === ":memory:") return printed;
    return path.resolve(cwd, printed);
  } finally {
    clearTimeout(timer);
  }
}

async function readStream(
  stream: ReadableStream<Uint8Array> | number | undefined,
): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  return new Response(stream).text();
}

/**
 * Compatibility lease interface (Phase 1 decommission).
 *
 * Implementations must not acquire mutexes, query Restart Manager, enumerate
 * processes, or inspect file holders. `acquire` may resolve the database path
 * for diagnostics; `verifyChild` and `release` are no-ops.
 */
export interface OpenCodeDatabaseLease {
  acquire(binary: string, cwd: string): Promise<string | null>;
  verifyChild(childPid: number, dbPath: string): Promise<void>;
  release(): void;
}

export interface OpenCodeDatabaseOwnershipDeps {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  resolveDatabasePath(binary: string, cwd: string, timeoutMs: number): Promise<string>;
  findProcessesUsingFiles(files: readonly string[]): number[];
  isOpenCodeCoTenant?(pid: number, dbPath: string): boolean;
  acquireMutex(name: string): unknown;
  releaseMutex(lease: unknown): void;
}

export interface OpenCodeDatabaseOwnershipOptions {
  readonly databasePathTimeoutMs?: number;
  readonly deps?: Partial<OpenCodeDatabaseOwnershipDeps>;
}

/**
 * Compatibility no-op ownership/lease (Phase 1 decommission).
 *
 * Resolves the database path without taking locks or querying OS file holders.
 * Never blocks, never refuses, never polices foreign processes.
 */
export class OpenCodeDatabaseOwnership implements OpenCodeDatabaseLease {
  private readonly deps: Pick<OpenCodeDatabaseOwnershipDeps, "platform" | "resolveDatabasePath">;
  private readonly timeoutMs: number;

  constructor(options: OpenCodeDatabaseOwnershipOptions = {}) {
    this.deps = {
      platform: options.deps?.platform ?? process.platform,
      resolveDatabasePath: options.deps?.resolveDatabasePath ?? resolveOpenCodeDatabasePath,
    };
    this.timeoutMs = options.databasePathTimeoutMs ?? OPENCODE_CONFIG.databasePathTimeoutMs;
  }

  async acquire(binary: string, cwd: string): Promise<string | null> {
    if (this.deps.platform !== "win32") return null;
    const dbPath = await this.deps.resolveDatabasePath(binary, cwd, this.timeoutMs);
    if (dbPath === ":memory:") return null;
    return dbPath;
  }

  async verifyChild(_childPid: number, _dbPath: string): Promise<void> {
    // Decommissioned: no file-holder inspection, no foreign-process policing.
  }

  release(): void {
    // Decommissioned: no mutex/lease to release.
  }
}
