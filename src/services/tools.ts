import fs from "fs";
import path from "path";
import { consumeGrant } from "./grants";

/**
 * Agentic file/shell tools, executed on the server.
 *
 * Path arguments are confined to a per-conversation workspace root
 * (see resolveSafe): path-traversal and symlink-escape are rejected before
 * any IO. This confinement applies ONLY to path arguments. `runBash` confines
 * just its starting directory — the command body is unsandboxed PowerShell
 * running with the server's own privileges (see run_command's tool
 * description). Do not describe shell execution as sandboxed.
 */

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * Structured outside-workspace refusal. Message strings stay identical to the
 * historic `ToolError` texts (log classifier + existing tests match on them);
 * the fields carry what the message cannot: which operation, which canonical
 * target, which root. `code` lets funnel/UI match without string-parsing.
 */
export class OutsideWorkspaceError extends ToolError {
  code = "OUTSIDE_WORKSPACE" as const;
  operation?: string;
  requestedPath: string;
  resolvedTarget?: string;
  root: string;
  constructor(opts: {
    message: string;
    requestedPath: string;
    root: string;
    operation?: string;
    resolvedTarget?: string;
  }) {
    super(opts.message);
    this.name = "OutsideWorkspaceError";
    this.requestedPath = opts.requestedPath;
    this.root = opts.root;
    this.operation = opts.operation;
    this.resolvedTarget = opts.resolvedTarget;
  }
}

/**
 * One-shot outside-workspace authorization (minted + consumed in Phase 2).
 * Narrow by construction: one operation, one canonical target, one
 * conversation. Single-use (`consumed`) with an expiry; never widens the root.
 */
export interface WorkspaceGrant {
  id: string;
  conversationId: string;
  tool: string;
  resolvedTarget: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

/** Grant lookup scope for one tool execution: conversation + tool name. */
export interface GrantScope {
  conversationId: string;
  tool: string;
}

export const WORKSPACE_DIR = path.resolve(process.env.WORKSPACE_DIR || path.join(process.cwd(), "workspace"));

// Ensure the sandbox root exists so relative paths resolve predictably.
fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

export function getWorkspaceDir(): string {
  return WORKSPACE_DIR;
}

/**
 * Canonicalize a workspace root: absolute, normalized, symlinks/junctions
 * resolved. Roots that do not exist yet (fresh chat dirs are created by the
 * caller) resolve lexically. Always compare canonical-to-canonical so a
 * symlinked project folder can neither wrongly reject inside-paths nor admit
 * outside ones.
 */
export function canonicalizeRoot(dir: string): string {
  const abs = path.resolve(dir);
  try {
    if (fs.existsSync(abs)) return fs.realpathSync(abs);
  } catch {
    /* fall through to the lexical form */
  }
  return abs;
}

const insideRoot = (real: string, root: string): boolean => {
  if (process.platform === "win32") {
    const r = real.toLowerCase();
    const b = root.toLowerCase();
    return r === b || r.startsWith(b + path.sep);
  }
  return real === root || real.startsWith(root + path.sep);
};

/**
 * Shared target inspection: lexical resolve + nearest-existing-ancestor
 * canonicalization, compared in canonical space (case-insensitive on
 * Windows). Single implementation so the check endpoint, grant minting, and
 * execution all derive the same target identity — approving one path and
 * executing a different resolved path is structurally impossible.
 */
export function inspectTarget(
  target: string,
  base: string,
): { abs: string; real: string; root: string; inside: boolean } {
  if (!base) throw new ToolError("No workspace root for this operation");
  const root = canonicalizeRoot(base);
  const abs = path.resolve(root, target);
  let real = abs;
  let probe = abs;
  while (true) {
    if (fs.existsSync(probe)) {
      real = fs.realpathSync(probe) + abs.slice(probe.length);
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return { abs, real, root, inside: insideRoot(real, root) };
}

/**
 * Resolve `target` (absolute or relative to the workspace) to an absolute path
 * provably inside `base` (the conversation's resolved workspace dir),
 * defending against `..` traversal and symlink escapes. `base` is REQUIRED —
 * no conversation-bound call may silently fall back to the global process
 * workspace; callers without a conversation root (manual /api/tools surface,
 * unattended scheduler root) pass their explicit root. Both sides compare in
 * canonical space (case-insensitive on Windows).
 *
 * `grantScope` admits exactly one outside target per conversation+tool: a live
 * grant whose canonical target equals the freshly re-resolved target is
 * consumed (single-use) and the path admitted. The walk above IS the
 * revalidation — a symlink swapped between approval and execution resolves
 * differently and fails closed. Anything else outside throws
 * `OutsideWorkspaceError` before any IO.
 */
export function resolveSafe(
  target: string,
  base: string,
  grantScope?: GrantScope,
): string {
  const { abs, real, root, inside } = inspectTarget(target, base);
  if (inside) return abs;
  if (grantScope) {
    if (consumeGrant(grantScope.conversationId, grantScope.tool, real)) {
      return abs;
    }
  }
  if (!insideRoot(abs, root)) {
    throw new OutsideWorkspaceError({
      message: `Path "${target}" is outside the workspace`,
      requestedPath: target,
      root,
      operation: grantScope?.tool,
      resolvedTarget: abs,
    });
  }
  throw new OutsideWorkspaceError({
    message: `Symlink target for "${target}" escapes the workspace`,
    requestedPath: target,
    root,
    operation: grantScope?.tool,
    resolvedTarget: real,
  });
}

const MAX_READ_BYTES = 200_000;
const BASH_TIMEOUT_MS = 120_000;

export type ReadArgs = { path: string; offset?: number; limit?: number };
export type WriteArgs = { path: string; content: string };
export type EditArgs = { path: string; oldText: string; newText: string; replaceAll?: boolean };
export type BashArgs = { command: string; cwd?: string };

/**
 * Incremental terminal output event. Emitted per stream read while the
 * process runs; `chunk` is raw text (ANSI/newlines intact — normalization
 * is the presenter's job). Optional: without a listener, `runBash` behaves
 * exactly as before (same return shape, same limits).
 */
export type BashOutputEvent = {
  stream: "stdout" | "stderr";
  chunk: string;
};
export type ListArgs = { path?: string };
export type SearchArgs = { query: string; path?: string; maxResults?: number };
export type StatArgs = { path: string };
export type DeleteArgs = { path: string };
export type KillArgs = { pid: number };

export function runRead({ path: p, offset = 0, limit }: ReadArgs, workspaceDir: string, grantScope?: GrantScope) {
  const abs = resolveSafe(p, workspaceDir, grantScope);
  if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${p}`);
  if (!fs.statSync(abs).isFile()) throw new ToolError(`Not a file: ${p}`);

  const raw = fs.readFileSync(abs, "utf8");
  const lines = raw.split("\n");
  const sliced = lines.slice(offset, limit != null ? offset + limit : undefined);
  let content = sliced.join("\n");
  let truncated = false;
  if (Buffer.byteLength(content, "utf8") > MAX_READ_BYTES) {
    content = content.slice(0, MAX_READ_BYTES);
    truncated = true;
  }
  return {
    path: p,
    offset,
    totalLines: lines.length,
    truncated,
    content,
  };
}

export function runWrite({ path: p, content }: WriteArgs, workspaceDir: string, grantScope?: GrantScope) {
  const abs = resolveSafe(p, workspaceDir, grantScope);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return { path: p, bytes: Buffer.byteLength(content, "utf8"), created: !fs.existsSync(abs) };
}

export function runEdit({ path: p, oldText, newText, replaceAll = true }: EditArgs, workspaceDir: string, grantScope?: GrantScope) {
  const abs = resolveSafe(p, workspaceDir, grantScope);
  if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${p}`);
  const original = fs.readFileSync(abs, "utf8");

  const count = original.split(oldText).length - 1;
  if (count === 0) throw new ToolError(`oldText not found in ${p}`);

  const updated = replaceAll ? original.split(oldText).join(newText) : original.replace(oldText, newText);
  fs.writeFileSync(abs, updated, "utf8");

  const idx = original.indexOf(oldText);
  const start = Math.max(0, original.lastIndexOf("\n", idx) + 1);
  const end = original.indexOf("\n", idx + oldText.length);
  const contextBefore = original.slice(start, idx);
  const contextAfter = original.slice(idx + oldText.length, end === -1 ? undefined : end);
  const diff = `${contextBefore}${oldText}${contextAfter}  =>  ${contextBefore}${newText}${contextAfter}`;

  return { path: p, occurrences: count, diff };
}

export async function runBash(
  { command, cwd, onOutput }: BashArgs & {
    onOutput?: (event: BashOutputEvent) => void;
  },
  workspaceDir: string,
  grantScope?: GrantScope,
) {
  const workdir = cwd ? resolveSafe(cwd, workspaceDir, grantScope) : workspaceDir;
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", command], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    proc.kill("SIGKILL");
  }, BASH_TIMEOUT_MS);

  // Incremental readers: emit raw chunks as they arrive (arrival order per
  // stream; cross-stream order is OS delivery order) while accumulating the
  // complete output for the durable result. Without onOutput nothing changes.
  const pump = async (
    stream: ReadableStream<Uint8Array> | null,
    label: "stdout" | "stderr",
    append: (text: string) => void,
  ): Promise<void> => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (!text) continue;
        append(text);
        try {
          onOutput?.({ stream: label, chunk: text });
        } catch {
          /* listener errors must never break execution */
        }
      }
      const tail = decoder.decode();
      if (tail) {
        append(tail);
        try {
          onOutput?.({ stream: label, chunk: tail });
        } catch {
          /* listener errors must never break execution */
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already closed */
      }
    }
  };

  let stdout = "";
  let stderr = "";
  try {
    await Promise.all([
      pump(proc.stdout, "stdout", (t) => {
        stdout += t;
      }),
      pump(proc.stderr, "stderr", (t) => {
        stderr += t;
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const exitCode = await proc.exited;

  return {
    command,
    cwd: workdir,
    exitCode,
    timedOut: killed,
    stdout: stdout.slice(0, MAX_READ_BYTES),
    stderr: stderr.slice(0, MAX_READ_BYTES),
  };
}

// ---- Coding tools (workspace-sandboxed, read-only unless noted) ----

export function runList({ path: dir = "." }: ListArgs, workspaceDir: string, grantScope?: GrantScope) {
  const abs = resolveSafe(dir, workspaceDir, grantScope);
  if (!fs.existsSync(abs)) throw new ToolError(`Not found: ${dir}`);
  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) throw new ToolError(`Not a directory: ${dir}`);
  const entries = fs.readdirSync(abs, { withFileTypes: true }).map((e) => {
    const full = path.join(abs, e.name);
    let size: number | null = null;
    try {
      const s = fs.statSync(full);
      size = s.isFile() ? s.size : null;
    } catch {
      size = null;
    }
    return {
      name: e.name,
      type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other",
      size,
    };
  });
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
  );
  return { path: dir, entries };
}

export function runStat({ path: p }: StatArgs, workspaceDir: string, grantScope?: GrantScope) {
  const abs = resolveSafe(p, workspaceDir, grantScope);
  if (!fs.existsSync(abs)) throw new ToolError(`Not found: ${p}`);
  const s = fs.statSync(abs);
  return {
    path: p,
    type: s.isDirectory() ? "dir" : s.isFile() ? "file" : "other",
    size: s.size,
    modifiedAt: s.mtime.toISOString(),
    createdAt: s.birthtime.toISOString(),
  };
}

const SEARCH_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".hutch",
  ".cottontail-tmp",
  "__pycache__",
  ".venv",
]);
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_BYTES = 1_000_000;

export function runSearch({ query, path: target = ".", maxResults = 50 }: SearchArgs, workspaceDir: string, grantScope?: GrantScope) {
  if (!query) throw new ToolError("Search query is required");
  const abs = resolveSafe(target, workspaceDir, grantScope);
  if (!fs.existsSync(abs)) throw new ToolError(`Not found: ${target}`);
  const needle = query.toLowerCase();
  const matches: { path: string; line: number; snippet: string }[] = [];
  let filesScanned = 0;
  let totalHits = 0;
  const limit = Math.min(Math.max(maxResults, 1), 200);

  const push = (match: { path: string; line: number; snippet: string }) => {
    totalHits += 1;
    if (matches.length < limit) matches.push(match);
  };

  const walk = (dir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      // Stop once we know the result is truncated (one hit beyond the limit).
      if (totalHits > limit) return false;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(e.name)) continue;
        if (!walk(full)) return false;
      } else if (e.isFile()) {
        if (filesScanned >= MAX_SEARCH_FILES) return false;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.size > MAX_SEARCH_BYTES) continue;
        filesScanned += 1;
        let raw: string;
        try {
          raw = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (raw.includes("\0")) continue; // binary
        const lines = raw.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            push({
              path: path.relative(workspaceDir, full),
              line: i + 1,
              snippet: lines[i].slice(0, 300),
            });
            if (totalHits > limit) return false;
          }
        }
      }
    }
    return true;
  };

  if (fs.statSync(abs).isFile()) {
    const raw = fs.readFileSync(abs, "utf8");
    if (!raw.includes("\0")) {
      raw.split("\n").forEach((line, i) => {
        if (line.toLowerCase().includes(needle)) {
          push({ path: target, line: i + 1, snippet: line.slice(0, 300) });
        }
      });
    }
    filesScanned = 1;
  } else {
    walk(abs);
  }
  return { query, path: target, matches, filesScanned, truncated: totalHits > matches.length };
}

export function runDelete({ path: p }: DeleteArgs, workspaceDir: string, grantScope?: GrantScope) {
  const abs = resolveSafe(p, workspaceDir, grantScope);
  if (abs === workspaceDir) throw new ToolError("Refusing to delete the workspace root");
  if (!fs.existsSync(abs)) throw new ToolError(`Not found: ${p}`);
  const wasDir = fs.statSync(abs).isDirectory();
  fs.rmSync(abs, { recursive: true, force: true });
  return { path: p, deleted: true, wasDir };
}

// ---- Computer tools ----

function runPowershellJson(command: string): unknown {
  const proc = Bun.spawnSync(
    ["powershell.exe", "-NoProfile", "-Command", command],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = new TextDecoder().decode(proc.stdout);
  if (proc.exitCode !== 0) {
    const err = new TextDecoder().decode(proc.stderr);
    throw new ToolError(`Command failed: ${err.slice(0, 500) || `exit ${proc.exitCode}`}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new ToolError("Could not parse command output");
  }
}

export function runProcesses() {
  const raw = runPowershellJson(
    "Get-Process | Select-Object Id, ProcessName, @{N='CPU';E={$_.CPU}}, @{N='MemoryMB';E={[math]::Round($_.WorkingSet64 / 1MB, 1)}} | Sort-Object CPU -Descending | Select-Object -First 100 | ConvertTo-Json",
  ) as { Id: number; ProcessName: string; CPU?: number | null; MemoryMB?: number }[];
  const list = (Array.isArray(raw) ? raw : [raw]).map((p) => ({
    pid: p.Id,
    name: p.ProcessName,
    cpuSeconds: p.CPU ?? null,
    memoryMB: p.MemoryMB ?? null,
  }));
  return { count: list.length, processes: list };
}

export function runKill({ pid }: KillArgs) {
  if (!Number.isInteger(pid) || pid <= 0) throw new ToolError(`Invalid pid: ${pid}`);
  if (pid <= 4) throw new ToolError(`Refusing to kill system process ${pid}`);
  if (pid === process.pid) throw new ToolError("Refusing to kill the TBAi server itself");
  const proc = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const err = new TextDecoder().decode(proc.stderr);
    throw new ToolError(`Could not kill ${pid}: ${err.slice(0, 500) || `exit ${proc.exitCode}`}`);
  }
  return { pid, killed: true };
}

export async function runSysinfo() {
  const os = await import("os");
  return {
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    hostname: os.hostname(),
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    totalMemoryMB: Math.round(os.totalmem() / 1048576),
    freeMemoryMB: Math.round(os.freemem() / 1048576),
    uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
  };
}
