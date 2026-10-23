/**
 * Windows process ownership for the TBAi desktop lifecycle (G2).
 *
 * Two independent kernel jobs, both with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`:
 *
 * 1. **Shell job (named).** The Rust shell creates it before spawning the
 *    sidecar and keeps the only handle. The sidecar opens the job by name,
 *    assigns itself, and immediately closes its own handle. If the shell dies
 *    first the job no longer exists and the sidecar refuses to boot; if the
 *    shell dies later the last handle closes, the job is destroyed, and Windows
 *    terminates the sidecar. This is the shell -> sidecar guarantee that
 *    `tauri-plugin-shell`'s `set_process_group(true)` job does NOT provide: that
 *    job has no kill-on-close limit.
 *
 * 2. **Backend job (unnamed).** The sidecar creates it, assigns itself, and
 *    keeps the handle for its lifetime. Every child it spawns inherits the job,
 *    so a hard sidecar kill terminates OpenCode and MCP children with it. Bun
 *    already binds non-detached children to the parent's lifetime; this job
 *    pins the behaviour explicitly instead of relying on a runtime accident.
 *
 * The same module hosts the two Windows facilities used to keep two TBAi
 * backends off one OpenCode database: a named mutex keyed by the resolved
 * database path, and Restart Manager file-holder detection.
 *
 * Every function is a no-op or explicitly unsupported off Windows. G2 is a
 * Windows x64 gate; no POSIX claim is made here.
 */
import { dlopen, ptr, type Library, type Pointer, type Symbols } from "bun:ffi";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { logger, normalizeError } from "../lib/logger";

const IS_WINDOWS = process.platform === "win32";

/** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` from `winnt.h`. */
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
/** `JobObjectExtendedLimitInformation` from `winnt.h` / `JobObjects.h`. */
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
/**
 * `sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)` on x64.
 *
 * Verified two ways before use: the C# `JobObjectExtendedLimitInformation`
 * layout and a live probe. `LimitFlags` is the first `DWORD` of
 * `BasicLimitInformation`, at offset 16 (four `LARGE_INTEGER` fields precede
 * it), and the whole structure is 144 bytes. Passing a shorter buffer makes
 * `SetInformationJobObject` fail; passing the wrong class silently omits the
 * flags. Both were measured, not assumed.
 */
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_SIZE = 144;
const JOB_OBJECT_LIMIT_FLAGS_OFFSET = 16;

/** `JOB_OBJECT_ASSIGN_PROCESS` from `JobObjects.h`. */
const JOB_OBJECT_ASSIGN_PROCESS = 0x0001;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_MORE_DATA = 234;
/** `CCH_RM_SESSION_KEY` from `RestartManager.h` (UTF-16 code units). */
const RM_SESSION_KEY_LENGTH = 66;
/**
 * `sizeof(RM_PROCESS_INFO)` on x64, from `RestartManager.h`.
 *
 * The struct begins with the process id (`DWORD`), which is the only field read
 * here. The full layout is 668 bytes; `RmGetList` advances by this stride. The
 * process is x64-only, so the 32-bit layout is not supported and is rejected
 * below rather than misread.
 */
const RM_PROCESS_INFO_SIZE = 668;

const KERNEL32_SYMBOLS = {
  CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
  OpenJobObjectW: { args: ["u32", "i32", "ptr"], returns: "ptr" },
  SetInformationJobObject: { args: ["ptr", "u32", "ptr", "u32"], returns: "i32" },
  AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
  GetCurrentProcess: { args: [], returns: "ptr" },
  CloseHandle: { args: ["ptr"], returns: "i32" },
  CreateMutexW: { args: ["ptr", "i32", "ptr"], returns: "ptr" },
  GetLastError: { args: [], returns: "u32" },
} satisfies Symbols;

const RESTART_MANAGER_SYMBOLS = {
  RmStartSession: { args: ["ptr", "u32", "ptr"], returns: "u32" },
  RmRegisterResources: { args: ["u32", "u32", "ptr", "u32", "ptr", "u32", "ptr"], returns: "u32" },
  RmGetList: { args: ["u32", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
  RmEndSession: { args: ["u32"], returns: "u32" },
} satisfies Symbols;

type Kernel32 = Library<typeof KERNEL32_SYMBOLS>;
type RestartManager = Library<typeof RESTART_MANAGER_SYMBOLS>;

let kernel32: Kernel32 | null = null;
let restartManager: RestartManager | null = null;

function kernel(): Kernel32 {
  if (!IS_WINDOWS) throw new Error("Win32 process ownership is only available on Windows");
  kernel32 ??= dlopen("kernel32.dll", KERNEL32_SYMBOLS);
  return kernel32;
}

function rm(): RestartManager {
  if (!IS_WINDOWS) throw new Error("Restart Manager is only available on Windows");
  restartManager ??= dlopen("rstrtmgr.dll", RESTART_MANAGER_SYMBOLS);
  return restartManager;
}

/** A native handle kept for the process lifetime. Opaque to callers. */
export type NativeHandle = Pointer | bigint;

/** UTF-16, NUL-terminated, as every `...W` Win32 API expects. */
function wide(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf16le");
}

function pointerOrNull(value: Pointer | bigint | null): NativeHandle | null {
  return value === null ? null : value;
}

function close(handle: NativeHandle): void {
  kernel().symbols.CloseHandle(handle);
}

/**
 * One shell-owned kill-on-close job. The shell must keep this object alive for
 * as long as the sidecar should live; dropping it closes the handle and
 * terminates every process in the job.
 */
export interface ShellJob {
  /** Win32 object name passed to the sidecar as `TBAI_SHELL_JOB_NAME`. */
  readonly name: string;
  /** Closes the only handle. Idempotent. */
  close(): void;
  /** True after {@link close}. Exposed for assertions, not for control flow. */
  readonly closed: boolean;
}

/**
 * Creates a unique named job with `KILL_ON_JOB_CLOSE`.
 *
 * Used by the Rust shell (natively) and by the lifecycle fixture that stands in
 * for it. Throws when the job or its limit cannot be created: an unprotected
 * sidecar is not an acceptable fallback.
 */
export function createShellJob(): ShellJob {
  const name = `Local\\TBAiShellJob-${process.pid}-${randomUUID()}`;
  const handle = createKillOnCloseJob(name);
  let closed = false;
  return {
    name,
    get closed() {
      return closed;
    },
    close(): void {
      if (closed) return;
      closed = true;
      close(handle);
    },
  };
}

function createKillOnCloseJob(name: string | null): NativeHandle {
  const k = kernel();
  const nameBuffer = name === null ? null : wide(name);
  const job = pointerOrNull(
    k.symbols.CreateJobObjectW(null, nameBuffer === null ? null : ptr(nameBuffer)),
  );
  if (job === null) {
    throw new Error(`CreateJobObjectW failed (Win32 error ${k.symbols.GetLastError()})`);
  }
  const information = Buffer.alloc(JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_SIZE);
  information.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_FLAGS_OFFSET);
  const ok = k.symbols.SetInformationJobObject(
    job,
    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
    ptr(information),
    information.byteLength,
  );
  if (ok === 0) {
    const code = k.symbols.GetLastError();
    close(job);
    throw new Error(`SetInformationJobObject failed (Win32 error ${code})`);
  }
  return job;
}

export type BackendJobStatus =
  | { readonly status: "installed" }
  | { readonly status: "unsupported"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

let backendJob: BackendJobStatus | null = null;

/**
 * Creates the sidecar's own kill-on-close job and assigns the current process.
 *
 * Call once, before any child process is spawned. Idempotent. A failure is
 * recorded (and logged) rather than thrown: the backend can still serve Direct
 * Chat, but the explicit descendant guarantee is unavailable and G2 must not be
 * reported as passed for that launch.
 */
export function installBackendProcessJob(): BackendJobStatus {
  if (backendJob !== null) return backendJob;
  if (!IS_WINDOWS) {
    backendJob = {
      status: "unsupported",
      reason: "G2 process ownership is Windows-only; no POSIX claim is made",
    };
    return backendJob;
  }
  try {
    const job = createKillOnCloseJob(null);
    const k = kernel();
    if (k.symbols.AssignProcessToJobObject(job, k.symbols.GetCurrentProcess()) === 0) {
      const code = k.symbols.GetLastError();
      close(job);
      throw new Error(`AssignProcessToJobObject(self) failed (Win32 error ${code})`);
    }
    backendJob = { status: "installed" };
    logger.info("process", "backend_job_installed", { pid: process.pid });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    backendJob = { status: "failed", reason };
    logger.error("process", "backend_job_failed", { ...normalizeError(err) });
  }
  return backendJob;
}

/** The current launch's backend-job status. `null` before installation. */
export function backendJobStatus(): BackendJobStatus | null {
  return backendJob;
}

/** Thrown when the shell's named job cannot be opened or joined. */
export class ShellJobUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellJobUnavailableError";
  }
}

/**
 * Joins this process to the shell's named job and immediately closes the local
 * handle.
 *
 * Closing the local handle is the point: the shell must remain the only
 * reference, so its death destroys the job and terminates this process. If the
 * job is already gone the shell died first; the caller must exit before doing
 * any work. Throws {@link ShellJobUnavailableError} in both failure cases.
 */
export function joinShellJob(name: string): void {
  if (!IS_WINDOWS) return;
  const trimmed = name.trim();
  if (!trimmed) throw new ShellJobUnavailableError("TBAI_SHELL_JOB_NAME is empty");
  const k = kernel();
  const nameBuffer = wide(trimmed);
  const job = pointerOrNull(
    k.symbols.OpenJobObjectW(JOB_OBJECT_ASSIGN_PROCESS, 0, ptr(nameBuffer)),
  );
  if (job === null) {
    const code = k.symbols.GetLastError();
    throw new ShellJobUnavailableError(
      `Cannot open shell job "${trimmed}" (Win32 error ${code}); the shell may have exited`,
    );
  }
  try {
    if (k.symbols.AssignProcessToJobObject(job, k.symbols.GetCurrentProcess()) === 0) {
      const code = k.symbols.GetLastError();
      throw new ShellJobUnavailableError(
        `Cannot join shell job "${trimmed}" (Win32 error ${code})`,
      );
    }
  } finally {
    close(job);
  }
}

/** A held named mutex. Releasing it destroys the object when it is the last handle. */
export interface NamedMutexLease {
  readonly handle: NativeHandle;
}

/**
 * Creates or opens a named mutex and reports whether another holder already
 * existed. Returns `null` for the existing case; the caller must close the
 * returned handle it received by calling {@link releaseNamedMutex}.
 */
export function acquireNamedMutex(name: string): NamedMutexLease | null {
  const k = kernel();
  const nameBuffer = wide(name);
  const handle = pointerOrNull(k.symbols.CreateMutexW(null, 0, ptr(nameBuffer)));
  if (handle === null) {
    throw new Error(`CreateMutexW failed (Win32 error ${k.symbols.GetLastError()})`);
  }
  const existed = k.symbols.GetLastError() === ERROR_ALREADY_EXISTS;
  if (existed) {
    close(handle);
    return null;
  }
  return { handle };
}

/** Releases a mutex handle acquired by {@link acquireNamedMutex}. */
export function releaseNamedMutex(lease: NamedMutexLease): void {
  close(lease.handle);
}

/**
 * PIDs of processes currently holding any of the given files, via Windows
 * Restart Manager.
 *
 * The API copies the file names during registration, so the buffers and pointer
 * array only need to stay alive for the calls below. `RmGetList` can grow
 * between the capacity query and the read; `ERROR_MORE_DATA` is retried with the
 * reported count instead of silently truncating.
 *
 * @throws Error when the session cannot be opened, the files cannot be
 * registered, or the list cannot be read. Callers treat that as "unknown" and
 * refuse startup; it is never "no holder".
 */
export function findProcessesUsingFiles(filePaths: readonly string[]): number[] {
  if (filePaths.length === 0) return [];
  if (process.arch === "ia32") {
    throw new Error("Restart Manager RM_PROCESS_INFO layout is defined for 64-bit only");
  }
  const api = rm();
  const sessionBuffer = Buffer.alloc(4);
  const keyBuffer = Buffer.alloc(RM_SESSION_KEY_LENGTH * 2);
  const startCode = api.symbols.RmStartSession(ptr(sessionBuffer), 0, ptr(keyBuffer));
  if (startCode !== 0) {
    throw new Error(`RmStartSession failed (Win32 error ${startCode})`);
  }
  const session = sessionBuffer.readUInt32LE(0);
  try {
    const fileBuffers = filePaths.map((file) => wide(path.resolve(file)));
    const pointerArray = Buffer.alloc(8 * fileBuffers.length);
    for (const [index, buffer] of fileBuffers.entries()) {
      pointerArray.writeBigUInt64LE(BigInt(ptr(buffer)), index * 8);
    }
    const registerCode = api.symbols.RmRegisterResources(
      session,
      fileBuffers.length,
      ptr(pointerArray),
      0,
      null,
      0,
      null,
    );
    if (registerCode !== 0) {
      throw new Error(`RmRegisterResources failed (Win32 error ${registerCode})`);
    }

    const neededBuffer = Buffer.alloc(4);
    const countBuffer = Buffer.alloc(4);
    const reasonsBuffer = Buffer.alloc(4);
    let capacity = Math.max(64, fileBuffers.length);
    let code = ERROR_MORE_DATA;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const information = Buffer.alloc(capacity * RM_PROCESS_INFO_SIZE);
      countBuffer.writeUInt32LE(capacity, 0);
      neededBuffer.writeUInt32LE(0, 0);
      code = api.symbols.RmGetList(
        session,
        ptr(neededBuffer),
        ptr(countBuffer),
        ptr(information),
        ptr(reasonsBuffer),
      );
      if (code === 0) {
        const count = Math.min(countBuffer.readUInt32LE(0), capacity);
        const pids: number[] = [];
        for (let index = 0; index < count; index += 1) {
          pids.push(information.readUInt32LE(index * RM_PROCESS_INFO_SIZE));
        }
        return [...new Set(pids)].sort((a, b) => a - b);
      }
      if (code !== ERROR_MORE_DATA) break;
      const needed = neededBuffer.readUInt32LE(0);
      capacity = Math.max(needed, capacity + 1);
    }
    throw new Error(`RmGetList failed (Win32 error ${code})`);
  } finally {
    api.symbols.RmEndSession(session);
  }
}
