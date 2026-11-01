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
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { logger, normalizeError } from "../lib/logger";

const IS_WINDOWS = process.platform === "win32";

/** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` from `winnt.h`. */
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x00000800;
const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x00001000;
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
/** Process access rights used for ownership inspection. */
const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_VM_READ = 0x0010;
const PROCESS_SET_QUOTA = 0x0100;
const HANDLE_FLAG_INHERIT = 0x00000001;
const GENERIC_READ = 0x80000000;
const FILE_SHARE_READ = 0x00000001;
const FILE_SHARE_WRITE = 0x00000002;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x00000080;
const STARTUPINFOEX_SIZE = 112; // STARTUPINFOW(104) + lpAttributeList(8)

const TH32CS_SNAPPROCESS = 0x00000002;
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002; // STARTUPINFOW(104) + lpAttributeList(8)
const STARTF_USESTDHANDLES = 0x00000100;
const CREATE_SUSPENDED = 0x00000004;
/** `sizeof(PROCESSENTRY32W)` on x64. */
const PROCESSENTRY32W_SIZE = 568;
/** Offset of `th32ProcessID` / `th32ParentProcessID` inside `PROCESSENTRY32W`. */
const PE32_PID_OFFSET = 8;
const PE32_PARENT_PID_OFFSET = 24;
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
  TerminateJobObject: { args: ["ptr", "u32"], returns: "i32" },
  IsProcessInJob: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
  TerminateProcess: { args: ["ptr", "u32"], returns: "i32" },
  GetProcessId: { args: ["ptr"], returns: "u32" },
  QueryFullProcessImageNameW: { args: ["ptr", "u32", "ptr", "ptr"], returns: "i32" },
  GetProcessTimes: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  CreateToolhelp32Snapshot: { args: ["u32", "u32"], returns: "ptr" },
  Process32FirstW: { args: ["ptr", "ptr"], returns: "i32" },
  Process32NextW: { args: ["ptr", "ptr"], returns: "i32" },
  CreateProcessW: {
    args: ["ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr"],
    returns: "i32",
  },
  CreatePipe: { args: ["ptr", "ptr", "ptr", "u32"], returns: "i32" },
  SetHandleInformation: { args: ["ptr", "u32", "u32"], returns: "i32" },
  ResumeThread: { args: ["ptr"], returns: "u32" },
  WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
  GetExitCodeProcess: { args: ["ptr", "ptr"], returns: "i32" },
  GetCurrentProcess: { args: [], returns: "ptr" },
  CloseHandle: { args: ["ptr"], returns: "i32" },
  CreateMutexW: { args: ["ptr", "i32", "ptr"], returns: "ptr" },
  InitializeProcThreadAttributeList: { args: ["ptr", "u32", "u32", "ptr"], returns: "i32" },
  UpdateProcThreadAttribute: {
    args: ["ptr", "u32", "usize", "ptr", "usize", "ptr", "ptr"],
    returns: "i32",
  },
  DeleteProcThreadAttributeList: { args: ["ptr"], returns: "void" },
  GetLastError: { args: [], returns: "u32" },
  CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"], returns: "ptr" },
  ReadFile: { args: ["ptr", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
  PeekNamedPipe: { args: ["ptr", "ptr", "u32", "ptr", "ptr", "ptr"], returns: "i32" },
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

function createKillOnCloseJob(name: string | null, allowBreakaway: boolean = false): NativeHandle {
  const k = kernel();
  const nameBuffer = name === null ? null : wide(name);
  const job = pointerOrNull(
    k.symbols.CreateJobObjectW(null, nameBuffer === null ? null : ptr(nameBuffer)),
  );
  if (job === null) {
    throw new Error(`CreateJobObjectW failed (Win32 error ${k.symbols.GetLastError()})`);
  }
  const flags =
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
    (allowBreakaway ? JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK : 0);
  const information = Buffer.alloc(JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_SIZE);
  information.writeUInt32LE(flags, JOB_OBJECT_LIMIT_FLAGS_OFFSET);
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
    const job = createKillOnCloseJob(null, true);
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

/**
 * A per-managed-service Windows job with `KILL_ON_JOB_CLOSE`.
 *
 * Unlike the backend's global job, this one is owned by the manager for a
 * single OpenCode child: closing or terminating it reaps that child's whole
 * process tree and nothing else. Adopted services never receive one.
 */
export interface ManagedProcessJob {
  readonly handle: NativeHandle;
  assign(pid: number): void;
  isInJob(pid: number): boolean;
  terminate(): void;
  close(): void;
  readonly closed: boolean;
}

export function createManagedProcessJob(): ManagedProcessJob {
  if (!IS_WINDOWS) {
    throw new Error("Managed process jobs are Windows-only");
  }
  const handle = createKillOnCloseJob(null);
  let closed = false;
  return {
    handle,
    assign(pid: number): void {
      if (closed) throw new Error("Managed process job is closed");
      const k = kernel();
      const proc = k.symbols.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
      if (proc === null || proc === 0n) {
        throw new Error(
          `OpenProcess failed for pid ${pid} (Win32 error ${k.symbols.GetLastError()})`,
        );
      }
      try {
        if (k.symbols.AssignProcessToJobObject(handle, proc) === 0) {
          const code = k.symbols.GetLastError();
          throw new Error(`AssignProcessToJobObject failed for pid ${pid} (Win32 error ${code})`);
        }
      } finally {
        k.symbols.CloseHandle(proc);
      }
    },
    isInJob(pid: number): boolean {
      if (closed) return false;
      const k = kernel();
      const proc = k.symbols.OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid);
      if (proc === null || proc === 0n) return false;
      const result = Buffer.alloc(4);
      let ok = false;
      try {
        if (k.symbols.IsProcessInJob(proc, handle, ptr(result)) !== 0) {
          ok = result.readUInt32LE(0) !== 0;
        }
      } finally {
        k.symbols.CloseHandle(proc);
      }
      return ok;
    },
    terminate(): void {
      if (closed) return;
      const k = kernel();
      k.symbols.TerminateJobObject(handle, 1);
    },
    close(): void {
      if (closed) return;
      closed = true;
      close(handle);
    },
    get closed() {
      return closed;
    },
  };
}

export function getProcessImage(pid: number): string | null {
  if (!IS_WINDOWS) return null;
  const k = kernel();
  const h = k.symbols.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
  if (h === null || h === 0n) return null;
  try {
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32LE(1024, 0);
    const nameBuf = Buffer.alloc(1024 * 2);
    if (k.symbols.QueryFullProcessImageNameW(h, 0, ptr(nameBuf), ptr(sizeBuf)) === 0) return null;
    const len = sizeBuf.readUInt32LE(0);
    return nameBuf.toString("utf16le", 0, len * 2);
  } finally {
    k.symbols.CloseHandle(h);
  }
}

export function getProcessStartTime(pid: number): bigint | null {
  if (!IS_WINDOWS) return null;
  const k = kernel();
  const h = k.symbols.OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid);
  if (h === null || h === 0n) return null;
  try {
    const creation = Buffer.alloc(8);
    const exit = Buffer.alloc(8);
    const kernelTime = Buffer.alloc(8);
    const userTime = Buffer.alloc(8);
    if (
      k.symbols.GetProcessTimes(h, ptr(creation), ptr(exit), ptr(kernelTime), ptr(userTime)) === 0
    )
      return null;
    return creation.readBigUInt64LE(0);
  } finally {
    k.symbols.CloseHandle(h);
  }
}

export function getParentPid(pid: number): number | null {
  if (!IS_WINDOWS) return null;
  const k = kernel();
  const snap = k.symbols.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap === null || snap === 0n) return null;
  try {
    const entry = Buffer.alloc(PROCESSENTRY32W_SIZE);
    entry.writeUInt32LE(PROCESSENTRY32W_SIZE, 0);
    let ok = k.symbols.Process32FirstW(snap, ptr(entry));
    while (ok !== 0) {
      const entryPid = entry.readUInt32LE(PE32_PID_OFFSET);
      if (entryPid === pid) {
        return entry.readUInt32LE(PE32_PARENT_PID_OFFSET);
      }
      ok = k.symbols.Process32NextW(snap, ptr(entry));
    }
    return null;
  } finally {
    k.symbols.CloseHandle(snap);
  }
}

export function findDescendantPids(rootPid: number): number[] {
  if (!IS_WINDOWS) return [];
  const k = kernel();
  const snap = k.symbols.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap === null || snap === 0n) return [];
  const result: number[] = [];
  try {
    const entry = Buffer.alloc(PROCESSENTRY32W_SIZE);
    entry.writeUInt32LE(PROCESSENTRY32W_SIZE, 0);
    const parentOf = new Map<number, number>();
    let ok = k.symbols.Process32FirstW(snap, ptr(entry));
    while (ok !== 0) {
      const pid = entry.readUInt32LE(PE32_PID_OFFSET);
      const ppid = entry.readUInt32LE(PE32_PARENT_PID_OFFSET);
      parentOf.set(pid, ppid);
      ok = k.symbols.Process32NextW(snap, ptr(entry));
    }
    for (const pid of parentOf.keys()) {
      let cur: number | undefined = pid;
      const seen = new Set<number>();
      while (cur !== undefined && !seen.has(cur)) {
        if (cur === rootPid) {
          result.push(pid);
          break;
        }
        seen.add(cur);
        cur = parentOf.get(cur);
      }
    }
    return result;
  } finally {
    k.symbols.CloseHandle(snap);
  }
}

export function terminateProcessById(pid: number): boolean {
  if (!IS_WINDOWS) return false;
  const k = kernel();
  const h = k.symbols.OpenProcess(PROCESS_TERMINATE, 0, pid);
  if (h === null || h === 0n) return false;
  try {
    return k.symbols.TerminateProcess(h, 1) !== 0;
  } finally {
    k.symbols.CloseHandle(h);
  }
}

export class OpenCodeProcessOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeProcessOwnershipError";
  }
}

export async function resolveManagedServicePid(
  wrapperPid: number,
  dbPath: string | null,
): Promise<number> {
  if (dbPath === null) return wrapperPid;
  let holders: number[];
  try {
    holders = findProcessesUsingFiles([dbPath]);
  } catch {
    return wrapperPid;
  }
  const descendants = new Set(findDescendantPids(wrapperPid));
  descendants.add(wrapperPid);
  const candidates = holders.filter((pid) => descendants.has(pid));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    // Prefer the one whose image is not the wrapper's (the actual service).
    for (const pid of candidates) {
      if (pid !== wrapperPid) return pid;
    }
  }
  return wrapperPid;
}

export interface SuspendedSpawnResult {
  pid: number;
  processHandle: NativeHandle;
  threadHandle: NativeHandle;
  job: ManagedProcessJob;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}

export function spawnSuspendedIntoJob(options: {
  commandLine: string;
  cwd: string;
  env: Record<string, string>;
}): SuspendedSpawnResult {
  if (!IS_WINDOWS) throw new Error("suspended spawn is Windows-only");
  const k = kernel();
  // 1. per-instance job
  const job = createManagedProcessJob();
  // 2. pipes + NUL stdin
  // Open NUL for stdin (valid, inheritable)
  const nulName = Buffer.from("NUL\0", "utf16le");
  const nulSa = Buffer.alloc(24);
  nulSa.writeUInt32LE(24, 0);
  nulSa.writeUInt32LE(1, 16); // bInheritHandle
  const nulHandle = k.symbols.CreateFileW(
    ptr(nulName),
    GENERIC_READ,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    ptr(nulSa),
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL,
    0,
  );
  if (nulHandle === null || nulHandle === 0n || nulHandle === BigInt("0xFFFFFFFFFFFFFFFF")) {
    job.close();
    throw new Error(`CreateFileW(NUL) failed (${k.symbols.GetLastError()})`);
  }

  const outR = Buffer.alloc(8);
  const outW = Buffer.alloc(8);
  const errR = Buffer.alloc(8);
  const errW = Buffer.alloc(8);
  // SECURITY_ATTRIBUTES with bInheritHandle=TRUE
  const sa = Buffer.alloc(24);
  sa.writeUInt32LE(24, 0);
  // lpSecurityDescriptor = null (offset 8)
  sa.writeUInt32LE(1, 16); // bInheritHandle at offset 16
  if (k.symbols.CreatePipe(ptr(outR), ptr(outW), ptr(sa), 0) === 0) {
    job.close();
    throw new Error(`CreatePipe stdout failed (${k.symbols.GetLastError()})`);
  }
  if (k.symbols.CreatePipe(ptr(errR), ptr(errW), ptr(sa), 0) === 0) {
    job.close();
    throw new Error(`CreatePipe stderr failed (${k.symbols.GetLastError()})`);
  }
  const outRHandle = outR.readBigUInt64LE(0);
  const outWHandle = outW.readBigUInt64LE(0);
  const errRHandle = errR.readBigUInt64LE(0);
  const errWHandle = errW.readBigUInt64LE(0);
  // make read ends non-inheritable
  k.symbols.SetHandleInformation(outRHandle as unknown as NativeHandle, HANDLE_FLAG_INHERIT, 0);
  k.symbols.SetHandleInformation(errRHandle as unknown as NativeHandle, HANDLE_FLAG_INHERIT, 0);

  // 3. env block
  // env is passed via CreateProcessW environment block (inherited if empty)
  const envEntries = `${Object.entries(options.env)
    .map(([a, b]) => `${a}=${b}\0`)
    .join("")}\0`;
  const envBuf = Buffer.from(envEntries, "utf16le");
  const cwdBuf = Buffer.from(`${options.cwd}\0`, "utf16le");
  // STARTUPINFOEXW: STARTUPINFOW(104) + lpAttributeList(8) = 112 bytes
  const si = Buffer.alloc(STARTUPINFOEX_SIZE);
  si.writeUInt32LE(112, 0); // cb = sizeof(STARTUPINFOEXW)
  si.writeUInt32LE(STARTF_USESTDHANDLES, 60); // dwFlags
  const writeHandle = (buf: Buffer, off: number, h: NativeHandle) =>
    buf.writeBigUInt64LE(BigInt(h as unknown as number | bigint), off);
  writeHandle(si, 80, nulHandle as unknown as bigint); // hStdInput = NUL
  writeHandle(si, 88, outWHandle); // hStdOutput
  writeHandle(si, 96, errWHandle); // hStdError

  // Restricted handle inheritance: NUL stdin + stdout/stderr write ends.
  const handleList = Buffer.alloc(24); // 3 handles * 8 bytes
  handleList.writeBigUInt64LE(BigInt(nulHandle as unknown as number | bigint), 0);
  handleList.writeBigUInt64LE(BigInt(outWHandle as unknown as number | bigint), 8);
  handleList.writeBigUInt64LE(BigInt(errWHandle as unknown as number | bigint), 16);

  const sizeBuf = Buffer.alloc(8);
  k.symbols.InitializeProcThreadAttributeList(0, 1, 0, ptr(sizeBuf));
  const attrSize = Number(sizeBuf.readBigUInt64LE(0));
  const attrList = Buffer.alloc(attrSize);
  if (k.symbols.InitializeProcThreadAttributeList(ptr(attrList), 1, 0, ptr(sizeBuf)) === 0) {
    k.symbols.CloseHandle(nulHandle as unknown as NativeHandle);
    throw new Error(`InitializeProcThreadAttributeList failed (${k.symbols.GetLastError()})`);
  }
  if (
    k.symbols.UpdateProcThreadAttribute(
      ptr(attrList),
      0,
      PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
      ptr(handleList),
      handleList.length,
      0,
      0,
    ) === 0
  ) {
    k.symbols.DeleteProcThreadAttributeList(ptr(attrList));
    k.symbols.CloseHandle(nulHandle as unknown as NativeHandle);
    throw new Error(`UpdateProcThreadAttribute failed (${k.symbols.GetLastError()})`);
  }
  si.writeBigUInt64LE(BigInt(ptr(attrList) as unknown as number), 104);

  const pi = Buffer.alloc(24);
  const cmdBuf = Buffer.from(`${options.commandLine}\0`, "utf16le");

  const ok = k.symbols.CreateProcessW(
    0,
    ptr(cmdBuf),
    0,
    0,
    1, // bInheritHandles=TRUE (restricted by handle list)
    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
    ptr(envBuf),
    ptr(cwdBuf),
    ptr(si),
    ptr(pi),
  );

  k.symbols.DeleteProcThreadAttributeList(ptr(attrList));

  if (ok === 0) {
    k.symbols.DeleteProcThreadAttributeList(ptr(attrList));
    k.symbols.CloseHandle(nulHandle as unknown as NativeHandle);
    throw new Error(`CreateProcessW failed (${k.symbols.GetLastError()})`);
  }
  k.symbols.CloseHandle(nulHandle as unknown as NativeHandle); // child inherited it

  const hProcess = pi.readBigUInt64LE(0);
  const hThread = pi.readBigUInt64LE(8);
  const pid = pi.readUInt32LE(16);

  // 5. assign to job
  const procHandle = hProcess as unknown as NativeHandle;
  try {
    job.assign(pid);
  } catch (e) {
    // terminate, cleanup
    k.symbols.TerminateProcess(procHandle, 1);
    k.symbols.CloseHandle(hThread as unknown as NativeHandle);
    k.symbols.CloseHandle(procHandle);
    k.symbols.CloseHandle(outRHandle as unknown as NativeHandle);
    k.symbols.CloseHandle(errRHandle as unknown as NativeHandle);
    k.symbols.CloseHandle(nulHandle as unknown as NativeHandle);
    job.close();
    throw e;
  }
  // verify membership
  if (!job.isInJob(pid)) {
    k.symbols.TerminateProcess(procHandle, 1);
    k.symbols.CloseHandle(hThread as unknown as NativeHandle);
    k.symbols.CloseHandle(procHandle);
    k.symbols.CloseHandle(outRHandle as unknown as NativeHandle);
    k.symbols.CloseHandle(errRHandle as unknown as NativeHandle);
    k.symbols.CloseHandle(nulHandle as unknown as NativeHandle);
    job.close();
    throw new OpenCodeProcessOwnershipError(`service pid ${pid} not in job after assignment`);
  }

  // close write ends in parent
  k.symbols.CloseHandle(outWHandle as unknown as NativeHandle);
  k.symbols.CloseHandle(errWHandle as unknown as NativeHandle);

  // 6. resume
  k.symbols.ResumeThread(hThread as unknown as NativeHandle);

  // 7. wrap pipes in ReadableStreams
  const stdout = pipeToReadableStream(outRHandle as unknown as NativeHandle);
  const stderr = pipeToReadableStream(errRHandle as unknown as NativeHandle);

  // exited promise
  const exited = new Promise<number>((resolve) => {
    const poll = () => {
      const r = k.symbols.WaitForSingleObject(procHandle, 0);
      if (r === 0) {
        const codeBuf = Buffer.alloc(4);
        k.symbols.GetExitCodeProcess(procHandle, ptr(codeBuf));
        resolve(codeBuf.readUInt32LE(0));
      } else {
        setTimeout(poll, 50);
      }
    };
    setTimeout(poll, 50);
  });

  return {
    pid,
    processHandle: procHandle,
    threadHandle: hThread as unknown as NativeHandle,
    job,
    stdout,
    stderr,
    exited,
  };
}

export class OpenCodeLauncherUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeLauncherUnsupportedError";
  }
}

function pipeToReadableStream(handle: NativeHandle): ReadableStream<Uint8Array> {
  const k = kernel();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Poll for available data to avoid blocking the event loop.
      for (let i = 0; i < 200; i++) {
        const availBuf = Buffer.alloc(4);
        const ok = k.symbols.PeekNamedPipe(handle, 0, 0, 0, ptr(availBuf), 0);
        if (ok === 0) {
          const err = k.symbols.GetLastError();
          if (err === 109) {
            controller.close();
            return;
          }
          // transient; retry
          await new Promise((r) => setTimeout(r, 10));
          continue;
        }
        const avail = availBuf.readUInt32LE(0);
        if (avail === 0) {
          // no data yet; check if pipe closed by trying a 0-byte read? Just wait.
          await new Promise((r) => setTimeout(r, 10));
          continue;
        }
        const buf = Buffer.alloc(Math.min(avail, 4096));
        const bytesRead = Buffer.alloc(4);
        const rok = k.symbols.ReadFile(handle, ptr(buf), buf.length, ptr(bytesRead), 0);
        if (rok === 0) {
          const err = k.symbols.GetLastError();
          if (err === 109) {
            controller.close();
            return;
          }
          controller.error(new Error(`ReadFile failed (${err})`));
          return;
        }
        const n = bytesRead.readUInt32LE(0);
        if (n === 0) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(buf.subarray(0, n)));
        return;
      }
      // too many empty polls; close
      controller.close();
    },
    cancel() {},
  });
}

export function resolveManagedLauncher(
  binaryPath: string,
): { kind: "direct"; path: string } | { kind: "unsupported"; reason: string } {
  if (process.platform !== "win32" || !binaryPath.toLowerCase().endsWith(".cmd")) {
    return { kind: "direct", path: binaryPath };
  }
  let content: string;
  try {
    content = readFileSync(binaryPath, "utf8");
  } catch (error) {
    return {
      kind: "unsupported",
      reason: `cannot read launcher: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (content.length > 65536) {
    return { kind: "unsupported", reason: "launcher is too large to verify safely" };
  }
  const exeMatches = [...content.matchAll(/"([^"]+\.exe)"/gi)].map((m) => m[1]);
  const existing = exeMatches.filter((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (existing.length === 1) {
    return { kind: "direct", path: existing[0] };
  }
  return {
    kind: "unsupported",
    reason: `launcher does not resolve to a single verifiable executable (found ${existing.length} candidate(s))`,
  };
}
