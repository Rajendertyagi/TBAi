/**
 * OpenCode database ownership (G2).
 *
 * Two TBAi backends must never run two `opencode serve` processes against one
 * database. This module resolves the database path the managed child will use,
 * serializes TBAi starts with a Windows named mutex keyed by that path, and asks
 * Windows Restart Manager whether any process already holds the database (or its
 * WAL/SHM sidecars).
 *
 * The checks are fail-closed:
 *
 * - a path that cannot be resolved refuses startup;
 * - a mutex held by another TBAi backend refuses startup;
 * - a foreign process holding the database refuses startup;
 * - a Restart Manager query that cannot be answered refuses startup;
 * - after readiness, any holder other than the managed child refuses startup
 *   and terminates the child.
 *
 * A foreign process that opens the database *after* the post-readiness check is
 * outside this enforceable boundary. That limit is stated in the ADR and in the
 * plan rather than papered over.
 */
import { spawn } from "bun";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { OPENCODE_CONFIG } from "../../config/opencode";
import { logger } from "../../lib/logger";
import {
  acquireNamedMutex,
  findProcessesUsingFiles,
  type NamedMutexLease,
  releaseNamedMutex,
} from "../process-ownership";

/** Thrown when the managed child's database path cannot be determined. */
export class OpenCodeDatabasePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeDatabasePathError";
  }
}

/** Thrown when the database is already owned by another process. */
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
        "TBAi at a separate OPENCODE_DB/XDG_DATA_HOME.",
    );
    this.name = "OpenCodeDatabaseBusyError";
  }
}

/** Thrown when ownership cannot be verified. Treated as a refusal, never as OK. */
export class OpenCodeDatabaseCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeDatabaseCheckError";
  }
}

/** The database files a live OpenCode server may hold. */
export function existingDatabaseFiles(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((file) => fs.existsSync(file));
}

/**
 * Keeps only PIDs that are not the caller or the managed child.
 *
 * Pure, so the refusal policy is testable without the Win32 API.
 */
export function foreignProcessIds(pids: readonly number[], ignored: readonly number[]): number[] {
  const ignoredSet = new Set(ignored);
  return [...new Set(pids)].filter((pid) => pid > 0 && !ignoredSet.has(pid)).sort((a, b) => a - b);
}

/**
 * Stable mutex name for one database path.
 *
 * Windows paths are case-insensitive, so the hash input is lower-cased and
 * resolved. The `Local\` namespace is per-session: two TBAi processes in one
 * desktop session serialize here; the Restart Manager check is the second line
 * for a process in another session.
 */
export function openCodeDatabaseMutexName(dbPath: string): string {
  const normalized = path.resolve(dbPath).toLowerCase();
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return `Local\\TBAi.OpenCode.Database.${digest}`;
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
 * own relative-path anchor).
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
 * The database-ownership policy, with injectable OS dependencies so the
 * decision table is unit-testable without touching a real database.
 */
export interface OpenCodeDatabaseLease {
  /**
   * Resolves the database path and takes the per-path mutex. Returns the path
   * to verify after readiness, or `null` when no file ownership applies
   * (`:memory:` or a non-Windows platform).
   */
  acquire(binary: string, cwd: string): Promise<string | null>;
  /** Refuses when any process other than `childPid` holds the database files. */
  verifyChild(childPid: number, dbPath: string): Promise<void>;
  /** Releases the mutex. Idempotent. */
  release(): void;
}

export interface OpenCodeDatabaseOwnershipDeps {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  resolveDatabasePath(binary: string, cwd: string, timeoutMs: number): Promise<string>;
  findProcessesUsingFiles(files: readonly string[]): number[];
  acquireMutex(name: string): NamedMutexLease | null;
  releaseMutex(lease: NamedMutexLease): void;
}

const defaultDeps: OpenCodeDatabaseOwnershipDeps = {
  platform: process.platform,
  pid: process.pid,
  resolveDatabasePath: resolveOpenCodeDatabasePath,
  findProcessesUsingFiles,
  acquireMutex: acquireNamedMutex,
  releaseMutex: releaseNamedMutex,
};

export interface OpenCodeDatabaseOwnershipOptions {
  readonly databasePathTimeoutMs?: number;
  readonly deps?: Partial<OpenCodeDatabaseOwnershipDeps>;
}

/** The production lease. One instance belongs to one `OpenCodeServerManager`. */
export class OpenCodeDatabaseOwnership implements OpenCodeDatabaseLease {
  private readonly deps: OpenCodeDatabaseOwnershipDeps;
  private readonly timeoutMs: number;
  private lease: { readonly mutex: NamedMutexLease; readonly dbPath: string } | null = null;

  constructor(options: OpenCodeDatabaseOwnershipOptions = {}) {
    this.deps = { ...defaultDeps, ...options.deps };
    this.timeoutMs = options.databasePathTimeoutMs ?? OPENCODE_CONFIG.databasePathTimeoutMs;
  }

  async acquire(binary: string, cwd: string): Promise<string | null> {
    if (this.deps.platform !== "win32") return null;
    if (this.lease) return this.lease.dbPath;

    let dbPath: string;
    try {
      dbPath = await this.deps.resolveDatabasePath(binary, cwd, this.timeoutMs);
    } catch (err) {
      if (err instanceof OpenCodeDatabasePathError) throw err;
      throw new OpenCodeDatabasePathError(
        `Cannot resolve the managed OpenCode database path: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (dbPath === ":memory:") {
      logger.info("opencode", "opencode.database_memory_mode", { pid: this.deps.pid });
      return null;
    }

    const mutexName = openCodeDatabaseMutexName(dbPath);
    let mutex: NamedMutexLease | null;
    try {
      mutex = this.deps.acquireMutex(mutexName);
    } catch (err) {
      throw new OpenCodeDatabaseCheckError(
        `Cannot take the OpenCode database lease: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (mutex === null) {
      throw new OpenCodeDatabaseBusyError({
        dbPath,
        pids: [],
        reason: "another TBAi backend holds the database lease",
      });
    }

    try {
      const pids = this.foreignHolders(dbPath);
      if (pids.length > 0) {
        throw new OpenCodeDatabaseBusyError({
          dbPath,
          pids,
          reason: "a process already holds the database",
        });
      }
      this.lease = { mutex, dbPath };
      logger.info("opencode", "opencode.database_lease_acquired", { dbPath });
      return dbPath;
    } catch (err) {
      this.deps.releaseMutex(mutex);
      throw err;
    }
  }

  async verifyChild(childPid: number, dbPath: string): Promise<void> {
    if (this.deps.platform !== "win32") return;
    if (!this.lease || this.lease.dbPath !== dbPath) {
      throw new OpenCodeDatabaseCheckError(
        `Cannot verify OpenCode database ownership for ${dbPath}: no matching lease`,
      );
    }
    const files = existingDatabaseFiles(dbPath);
    if (files.length === 0) {
      throw new OpenCodeDatabaseCheckError(
        `OpenCode did not create or open its database at ${dbPath}; ownership cannot be verified`,
      );
    }
    let pids: number[];
    try {
      pids = this.deps.findProcessesUsingFiles(files);
    } catch (err) {
      throw new OpenCodeDatabaseCheckError(
        `Cannot query OpenCode database holders: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const foreign = foreignProcessIds(pids, [this.deps.pid, childPid]);
    if (foreign.length > 0) {
      throw new OpenCodeDatabaseBusyError({
        dbPath,
        pids: foreign,
        reason: "another process opened the database during startup",
      });
    }
    logger.info("opencode", "opencode.database_owner_verified", { dbPath, pid: childPid });
  }

  release(): void {
    if (!this.lease) return;
    const { mutex, dbPath } = this.lease;
    this.lease = null;
    this.deps.releaseMutex(mutex);
    logger.info("opencode", "opencode.database_lease_released", { dbPath });
  }

  private foreignHolders(dbPath: string): number[] {
    const files = existingDatabaseFiles(dbPath);
    if (files.length === 0) return [];
    let pids: number[];
    try {
      pids = this.deps.findProcessesUsingFiles(files);
    } catch (err) {
      throw new OpenCodeDatabaseCheckError(
        `Cannot query OpenCode database holders: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return foreignProcessIds(pids, [this.deps.pid]);
  }
}
