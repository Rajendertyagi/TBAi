import fs from "fs";
import path from "path";
import { AsyncLocalStorage } from "node:async_hooks";
import { generateId } from "./utils";

/**
 * Central structured logger for the TBAi server (Bun).
 *
 * One API for every subsystem (HTTP, chat, provider, MCP, tools, storage):
 *
 *   import { logger } from "../lib/logger";
 *   logger.info("ai", "ai.request", { requestId, provider, model });
 *
 * Conventions:
 * - `scope` namespaces the subsystem ("http", "chat", "ai.provider",
 *   "mcp", "tools", "storage", ...).
 * - `event` follows the taxonomy in docs/logging.md (e.g. "ai.error", never
 *   prose like "stream failed!"). Grep-able, dashboard-able.
 * - Fields carry correlation IDs (requestId, conversationId, ...) plus
 *   small scalars (provider, model, tool, durationMs, statusCode, ...).
 *   Never put secrets, raw user text, or huge objects in fields — everything
 *   is defensively redacted, but keep entries small anyway.
 * - Levels: debug/info/warn/error. Default from NODE_ENV (dev → debug,
 *   production → info), overridable with TBAI_LOG_LEVEL.
 * - Destinations: human-readable console always; JSON-lines file when
 *   TBAI_LOG_FILE is set (default: on in production → data/tbai.log, off in
 *   development). Bounded rotation (default 5 MB × 3 files).
 * - Request correlation WITHOUT global mutable state: an AsyncLocalStorage
 *   context carries { requestId, ... } across the async chain (Hono →
 *   streamText → tool execute → MCP/storage). Explicit fields always win
 *   over context values. Everything works with no context (fields omitted).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Capture filter: a real level, or `off` to silence entirely. */
export type LogLevelFilter = LogLevel | "off";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_RANK: Record<LogLevelFilter, number> = { ...LEVEL_ORDER, off: 4 };

/** Per-scope capture override: matches the scope and everything below it
 * (`mcp` covers `mcp.client`). Longest scope wins. */
export interface LogTargetDirective {
  scope: string;
  level: LogLevelFilter;
}

function isProd(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.NODE_ENV ?? "development") === "production";
}

export interface LoggerConfig {
  level: LogLevelFilter;
  targets: LogTargetDirective[];
  /** Sink path (null = no file sink). Independent from `fileEnabled` so a
   *  runtime toggle can pause/resume without losing the path. */
  file: string | null;
  fileEnabled: boolean;
  maxBytes: number;
  keepFiles: number;
  maxTotalBytes: number;
  retentionMs: number;
}

/** Default sink path for a data dir (production default; dev default is off). */
export function defaultLogFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.DATA_DIR || path.join(process.cwd(), "data"), "tbai.log");
}

function numEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const n = Number(env[key] ?? fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveLoggerConfig(env: NodeJS.ProcessEnv = process.env): LoggerConfig {
  const prod = isProd(env);
  const level = (env.TBAI_LOG_LEVEL ?? (prod ? "info" : "debug")) as LogLevel;
  let file: string | null;
  if (env.TBAI_LOG_FILE === "off") {
    file = null;
  } else if (env.TBAI_LOG_FILE) {
    file = env.TBAI_LOG_FILE;
  } else {
    file = isProd(env) ? defaultLogFilePath(env) : null;
  }
  return {
    level: LEVEL_ORDER[level] === undefined ? (isProd(env) ? "info" : "debug") : level,
    targets: [],
    file,
    fileEnabled: file !== null,
    maxBytes: Math.floor(numEnv(env, "TBAI_LOG_MAX_MB", 5) * 1024 * 1024),
    keepFiles: Math.max(1, Math.floor(numEnv(env, "TBAI_LOG_KEEP", 20))),
    maxTotalBytes: Math.floor(numEnv(env, "TBAI_LOG_MAX_TOTAL_MB", 100) * 1024 * 1024),
    retentionMs: Math.floor(numEnv(env, "TBAI_LOG_RETENTION_HOURS", 24) * 3600 * 1000),
  };
}

export interface LogFields {
  event?: string;
  message?: string;
  requestId?: string;
  conversationId?: string;
  toolCallId?: string;
  jobId?: string;
  providerId?: string;
  modelId?: string;
  threadId?: string;
  provider?: string;
  model?: string;
  tool?: string;
  mcpServer?: string;
  transport?: string;
  durationMs?: number;
  errorType?: string;
  statusCode?: number;
  status?: number | string;
  [key: string]: unknown;
}

export interface LogEntry extends LogFields {
  time: string;
  level: LogLevel;
  scope: string;
}

// ---------------------------------------------------------------------------
// Redaction (structured, defense-in-depth on top of careful call sites)
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_RE =
  /api[_-]?key|authorization|^.*token$|.*token.*|secret|password|passwd|cookie|credential|dek|key_hex|auth|session[_-]?id|set-cookie/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /AIza[0-9A-Za-z_-]{8,}/g,
  /xox[baprs]-[0-9A-Za-z-]{8,}/g,
  /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/g,
];

function redactString(value: string): string {
  let out = value;
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, (m) => `${m.slice(0, 6)}[REDACTED]`);
  }
  return out;
}

function redactValue(value: unknown, seen: Set<unknown>, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object" || depth > 6) return typeof value === "object" ? "[object]" : value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((v) => redactValue(v, seen, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? "[REDACTED]" : redactValue(val, seen, depth + 1);
  }
  return out;
}

/** Redact an arbitrary fields object for safe logging. Exported for tests. */
export function redactFields(fields: LogFields): LogFields {
  return redactValue(fields, new Set(), 0) as LogFields;
}

// ---------------------------------------------------------------------------
// Request correlation context (Bun-safe: AsyncLocalStorage, never globals)
// ---------------------------------------------------------------------------

/**
 * Minimal correlation/execution identity carried across the async chain.
 * Correlation only — never a dumping ground. New fields require a
 * demonstrated funnel need (see docs/logging.md). Funnels bind what they own
 * (fireJob binds jobId, the tool wrapper binds toolCallId); routes bind
 * requestId/conversationId; the AI funnel binds providerId/modelId.
 */
export interface RequestContext {
  requestId: string;
  conversationId?: string;
  toolCallId?: string;
  jobId?: string;
  providerId?: string;
  modelId?: string;
}

const requestStore = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with a request context visible to all nested logging. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestStore.run(ctx, fn);
}

/** Current request context, if any (undefined outside a request). */
export function getRequestContext(): RequestContext | undefined {
  return requestStore.getStore();
}

/**
 * Run `fn` with the current context extended by `patch`. Undefined values
 * never wipe existing bindings (a nested tool call without an id keeps the
 * outer one). Funnels use this to bind what they own (toolCallId, jobId,
 * providerId, modelId) without touching anything else.
 */
export function extendRequestContext<T>(patch: Partial<RequestContext>, fn: () => T): T {
  const current = requestStore.getStore();
  const merged: RequestContext = {
    requestId: current?.requestId ?? newRequestId(),
    ...current,
  };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key as keyof RequestContext] = value as never;
  }
  return requestStore.run(merged, fn);
}

/** Generate a correlation ID: req_ + compact unique suffix. */
export function newRequestId(): string {
  return `req_${generateId()}`;
}

// ---------------------------------------------------------------------------
// Error normalization (safe: no stacks to users, stacks locally in dev)
// ---------------------------------------------------------------------------

export interface NormalizedError {
  errorType: string;
  message: string;
  causeType?: string;
  status?: number;
  code?: string | number;
  stack?: string;
}

function errorStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const candidates = [
    (err as { statusCode?: unknown }).statusCode,
    (err as { status?: unknown }).status,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return undefined;
}

/**
 * Extract a stable, log-safe error shape. Stack traces are included only
 * when explicitly requested (local development), never for user responses.
 */
export function normalizeError(err: unknown, includeStack = !isProd()): NormalizedError {
  const errorType = err instanceof Error ? err.name || "Error" : typeof err;
  let message: string;
  if (err instanceof Error) message = err.message || String(err);
  else if (typeof err === "string") message = err;
  else {
    try {
      message = JSON.stringify(err);
    } catch {
      message = String(err);
    }
  }
  const out: NormalizedError = {
    errorType,
    message: redactString(message).slice(0, 2000),
  };
  if (err instanceof Error && err.cause !== undefined) {
    out.causeType =
      err.cause instanceof Error ? err.cause.name || "Error" : typeof err.cause;
  }
  const status = errorStatus(err);
  if (status !== undefined) out.status = status;
  const code =
    err !== null && typeof err === "object"
      ? (err as { code?: unknown }).code
      : undefined;
  if (typeof code === "string" || typeof code === "number") out.code = code;
  if (includeStack && err instanceof Error && err.stack) {
    out.stack = redactString(err.stack).slice(0, 4000);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core logger
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

function formatHuman(entry: LogEntry): string {
  const bits: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (["time", "level", "scope", "event", "message"].includes(key)) continue;
    if (value === undefined) continue;
    bits.push(`${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }
  const head = `${entry.time} ${entry.level.toUpperCase().padEnd(5)} [${entry.scope}]`;
  const event = entry.event ?? "";
  const message = entry.message ? ` ${entry.message}` : "";
  const rest = bits.length ? ` ${bits.join(" ")}` : "";
  return `${head} ${event}${message}${rest}`;
}

function rotateIfNeeded(file: string, maxBytes: number, keepFiles: number): void {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;
  try {
    fs.rmSync(`${file}.${keepFiles}`, { force: true });
    for (let i = keepFiles - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      } catch {
        /* missing generation — skip */
      }
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* rotation is best-effort; never break the request path */
  }
}

// ---------------------------------------------------------------------------
// File-sink inventory: naming policy lives here and ONLY here. Consumers
// (routes, UI, tests) list/download opaque bytes via these helpers and never
// parse log content or construct file names themselves.
// ---------------------------------------------------------------------------

/** Rotated sink generations: tbai.log, tbai.log.1, ... (no trailing spaces). */
export const LOG_FILE_RE = /^tbai\.log(\.\d+)?$/;

export interface LogFileInfo {
  name: string;
  size_bytes: number;
  mtimeMs: number;
}

/** List sink generations in a data dir, base file first. Missing dir → []. */
export function listLogFiles(dir: string): LogFileInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => LOG_FILE_RE.test(n)).sort();
  } catch {
    return [];
  }
  const out: LogFileInfo[] = [];
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(dir, name));
      out.push({ name, size_bytes: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* raced deletion — skip */
    }
  }
  return out;
}

export interface RetentionInfo {
  retentionHours: number;
  maxTotalMb: number;
  totalBytes: number;
  fileCount: number;
  oldestMs: number | null;
  newestMs: number | null;
}

/**
 * Enforce the retention policy: drop rotated generations (never the live base
 * file) oldest-first until total size fits the cap and nothing kept is older
 * than the retention window. Best-effort; returns what remains.
 */
export function pruneLogFiles(
  dir: string,
  opts: { maxTotalBytes: number; retentionMs: number },
): LogFileInfo[] {
  const now = Date.now();
  const files = listLogFiles(dir).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep: LogFileInfo[] = [];
  let total = 0;
  for (const f of files) {
    const isBase = f.name === "tbai.log";
    const tooOld = now - f.mtimeMs > opts.retentionMs;
    const overCap = total + f.size_bytes > opts.maxTotalBytes;
    if (!isBase && (tooOld || overCap)) {
      try {
        fs.rmSync(path.join(dir, f.name), { force: true });
      } catch {
        /* raced deletion — treat as pruned */
      }
      continue;
    }
    total += f.size_bytes;
    keep.push(f);
  }
  return keep;
}

export function retentionInfo(
  dir: string,
  opts: { retentionHours: number; maxTotalMb: number },
): RetentionInfo {
  const files = listLogFiles(dir);
  const totalBytes = files.reduce((n, f) => n + f.size_bytes, 0);
  const mtimes = files.map((f) => f.mtimeMs);
  return {
    retentionHours: opts.retentionHours,
    maxTotalMb: opts.maxTotalMb,
    totalBytes,
    fileCount: files.length,
    oldestMs: mtimes.length ? Math.min(...mtimes) : null,
    newestMs: mtimes.length ? Math.max(...mtimes) : null,
  };
}

// ---------------------------------------------------------------------------
// Scope rate governance (token bucket). info/debug entries above budget are
// shed with a counter; warn/error always pass; the `http` audit scope is
// exempt (audit lines stay complete by design). Engage/disengage announce
// themselves in-stream so throttling is visible, never silent.
// ---------------------------------------------------------------------------

const THROTTLE_BUDGET_PER_SEC = 1;
// Burst allowance: absorbs boot bursts and dev debug runs (dozens of lines)
// while sustained spam (hundreds/sec for minutes) still engages quickly.
const THROTTLE_BUCKET_SIZE = 100;

interface ThrottleState {
  tokens: number;
  lastMs: number;
  throttled: boolean;
  dropped: number;
}

const sampleCounters = new Map<string, number>();

export function shouldSample(key: string, ratio: number): boolean {
  if (!Number.isFinite(ratio) || ratio <= 1) return true;
  const n = (sampleCounters.get(key) ?? 0) + 1;
  sampleCounters.set(key, n);
  return n % Math.floor(ratio) === 1;
}

/** Clear sampling counters (tests). */
export function resetSampleCounters(): void {
  sampleCounters.clear();
}

const FILE_FLUSH_MS = 10;
const FILE_FLUSH_BYTES = 64 * 1024;
const FILE_QUEUE_LIMIT = 5000;
const ROTATION_CHECK_MS = 60 * 1000;
const PRUNE_CHECK_MS = 60 * 60 * 1000;

class Logger {
  private config: LoggerConfig;

  // Live log buffer for the in-app Logs panel: bounded ring of post-redaction
  // entries with a monotonic sequence, plus SSE subscriber notification.
  private buffer: (LogEntry & { seq: number })[] = [];
  private bufferSeq = 0;
  private bufferListeners = new Set<(seq: number) => void>();
  // Unique per process boot. Seq restarts at 0 on every boot, so entries are
  // only unique within a boot — consumers key on bootId+seq and must discard
  // state when the boot changes, or React keys collide and leak DOM nodes.
  private readonly bootIdValue: string = generateId();

  // Async file-sink batching: the ring + console stay synchronous (live tail
  // and crash visibility), but disk I/O is one append per batch, never per
  // entry. Overflow sheds load with a counter instead of blocking.
  private fileQueue: string[] = [];
  private fileQueueBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private fileDropped = 0;
  private estBytesSinceRotate = 0;
  private lastRotationCheck = 0;
  private lastPruneCheck = 0;
  private mkdirFor: string | null = null;

  private throttleStates = new Map<string, ThrottleState>();

  constructor(config?: Partial<LoggerConfig>) {
    this.config = { ...resolveLoggerConfig(), ...config };
  }

  /** Override config at runtime (tests, boot, settings API). */
  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  get level(): LogLevelFilter {
    return this.config.level;
  }

  /** Current file-sink shape for settings/UI (copy, not live). */
  get fileSink(): {
    enabled: boolean;
    file: string | null;
    maxMb: number;
    keepFiles: number;
    maxTotalMb: number;
    retentionHours: number;
  } {
    return {
      enabled: this.config.fileEnabled && this.config.file !== null,
      file: this.config.file,
      maxMb: this.config.maxBytes / 1024 / 1024,
      keepFiles: this.config.keepFiles,
      maxTotalMb: this.config.maxTotalBytes / 1024 / 1024,
      retentionHours: this.config.retentionMs / 3600 / 1000,
    };
  }

  /** Writer health for tests and the throttle UI. */
  getWriteStats(): {
    queued: number;
    queuedBytes: number;
    dropped: number;
    throttled: Array<{ scope: string; dropped: number }>;
  } {
    return {
      queued: this.fileQueue.length,
      queuedBytes: this.fileQueueBytes,
      dropped: this.fileDropped,
      throttled: [...this.throttleStates.entries()]
        .filter(([, st]) => st.throttled || st.dropped > 0)
        .map(([scope, st]) => ({ scope, dropped: st.dropped })),
    };
  }

  /** Clear throttle buckets (tests). */
  resetThrottleStates(): void {
    this.throttleStates.clear();
  }

  /**
   * Token-bucket gate for info/debug volume. Returns true when the entry may
   * proceed. Audit (`http`) and important (warn/error) traffic never throttles.
   */
  private throttleCheck(scope: string, level: LogLevel): boolean {
    if (level !== "debug" && level !== "info") return true;
    if (scope === "http") return true;
    const now = Date.now();
    let st = this.throttleStates.get(scope);
    if (!st) {
      st = { tokens: THROTTLE_BUCKET_SIZE, lastMs: now, throttled: false, dropped: 0 };
      this.throttleStates.set(scope, st);
    }
    st.tokens = Math.min(
      THROTTLE_BUCKET_SIZE,
      st.tokens + ((now - st.lastMs) / 1000) * THROTTLE_BUDGET_PER_SEC,
    );
    st.lastMs = now;
    if (st.tokens >= 1) {
      st.tokens -= 1;
      if (st.throttled && st.tokens >= THROTTLE_BUCKET_SIZE) {
        st.throttled = false;
        this.warn(scope, "scope.throttled", {
          engaged: false,
          dropped: st.dropped,
          budgetPerSec: THROTTLE_BUDGET_PER_SEC,
        });
      }
      return true;
    }
    st.dropped += 1;
    if (!st.throttled) {
      st.throttled = true;
      this.warn(scope, "scope.throttled", {
        engaged: true,
        dropped: st.dropped,
        budgetPerSec: THROTTLE_BUDGET_PER_SEC,
      });
    }
    return false;
  }

  /** Active per-scope overrides (longest-prefix wins). A copy, not live. */
  get targets(): LogTargetDirective[] {
    return [...(this.config.targets ?? [])];
  }

  /** Effective capture level for a scope: longest matching override, else global. */
  levelForScope(scope: string): LogLevelFilter {
    let best: LogTargetDirective | null = null;
    for (const t of this.config.targets ?? []) {
      if (scope !== t.scope && !scope.startsWith(`${t.scope}.`)) continue;
      if (!best || t.scope.length > best.scope.length) best = t;
    }
    return best?.level ?? this.config.level;
  }

  isEnabled(level: LogLevel, scope?: string): boolean {
    const effective = scope === undefined ? this.config.level : this.levelForScope(scope);
    return LEVEL_RANK[level] >= LEVEL_RANK[effective];
  }

  private write(entry: LogEntry): void {
    if (!this.isEnabled(entry.level, entry.scope)) return;
    if (!this.throttleCheck(entry.scope, entry.level)) return;
    const safe = redactFields(entry) as LogEntry;
    // Ring buffer for the live Logs panel (bounded; redacted; cheap scalars).
    const buffered = { ...safe, seq: ++this.bufferSeq };
    this.buffer.push(buffered);
    if (this.buffer.length > LOG_BUFFER_SIZE) {
      this.buffer.splice(0, this.buffer.length - LOG_BUFFER_SIZE);
    }
    for (const listener of this.bufferListeners) {
      try {
        listener(buffered.seq);
      } catch {
        /* listener errors never break logging */
      }
    }
    const line = formatHuman(safe);
    if (entry.level === "error" || entry.level === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
    if (this.config.fileEnabled && this.config.file) {
      this.enqueueFileLine(
        `${JSON.stringify({ ...safe, time: new Date().toISOString() })}\n`,
      );
    }
  }

  private enqueueFileLine(line: string): void {
    if (this.fileQueue.length >= FILE_QUEUE_LIMIT) {
      this.fileDropped += 1;
      return;
    }
    this.fileQueue.push(line);
    this.fileQueueBytes += line.length;
    if (this.fileQueueBytes >= FILE_FLUSH_BYTES) {
      this.flushFileLines();
      return;
    }
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flushFileLines(), FILE_FLUSH_MS);
      // Never keep the process alive for a pending flush.
      (this.flushTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  /** Drain the file queue now (timer path, tests, process exit). */
  flushFileLines(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.fileQueue.length === 0) return;
    const batch = this.fileQueue;
    this.fileQueue = [];
    this.fileQueueBytes = 0;
    const file = this.config.fileEnabled ? this.config.file : null;
    if (!file) {
      this.fileDropped += batch.length;
      return;
    }
    try {
      if (this.mkdirFor !== file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.mkdirFor = file;
      }
      this.estBytesSinceRotate += batch.reduce((n, l) => n + l.length, 0);
      const now = Date.now();
      if (
        this.estBytesSinceRotate >= this.config.maxBytes ||
        now - this.lastRotationCheck >= ROTATION_CHECK_MS
      ) {
        rotateIfNeeded(file, this.config.maxBytes, this.config.keepFiles);
        this.estBytesSinceRotate = 0;
        this.lastRotationCheck = now;
      }
      fs.appendFileSync(file, batch.join(""));
      if (now - this.lastPruneCheck >= PRUNE_CHECK_MS) {
        this.lastPruneCheck = now;
        pruneLogFiles(path.dirname(file), {
          maxTotalBytes: this.config.maxTotalBytes,
          retentionMs: this.config.retentionMs,
        });
      }
    } catch {
      /* file logging is best-effort; console already emitted */
    }
  }

  private emit(level: LogLevel, scope: string, event: string, fields: LogFields = {}): void {
    const ctx = getRequestContext();
    const merged: LogFields = {
      requestId: ctx?.requestId,
      conversationId: ctx?.conversationId,
      toolCallId: ctx?.toolCallId,
      jobId: ctx?.jobId,
      providerId: ctx?.providerId,
      modelId: ctx?.modelId,
      ...fields,
      event,
    };
    // Explicit fields win; drop undefined correlation ids.
    if (merged.requestId === undefined) delete merged.requestId;
    if (merged.conversationId === undefined) delete merged.conversationId;
    if (merged.toolCallId === undefined) delete merged.toolCallId;
    if (merged.jobId === undefined) delete merged.jobId;
    if (merged.providerId === undefined) delete merged.providerId;
    if (merged.modelId === undefined) delete merged.modelId;
    this.write({
      ...merged,
      time: formatTime(new Date()),
      level,
      scope,
    });
  }

  debug(scope: string, event: string, fields: LogFields = {}): void {
    this.emit("debug", scope, event, fields);
  }

  info(scope: string, event: string, fields: LogFields = {}): void {
    this.emit("info", scope, event, fields);
  }

  warn(scope: string, event: string, fields: LogFields = {}): void {
    this.emit("warn", scope, event, fields);
  }

  error(scope: string, event: string, fields: LogFields = {}): void {
    this.emit("error", scope, event, fields);
  }

  /** Scoped child carrying fixed bindings (e.g. a requestId) explicitly. */
  child(bindings: LogFields): Pick<Logger, "debug" | "info" | "warn" | "error" | "isEnabled"> {
    const parent = this;
    const merge = (fields: LogFields): LogFields => ({ ...bindings, ...fields });
    return {
      debug: (scope, event, fields = {}) => parent.debug(scope, event, merge(fields)),
      info: (scope, event, fields = {}) => parent.info(scope, event, merge(fields)),
      warn: (scope, event, fields = {}) => parent.warn(scope, event, merge(fields)),
      error: (scope, event, fields = {}) => parent.error(scope, event, merge(fields)),
      isEnabled: (level) => parent.isEnabled(level),
    };
  }

  // ---- Live Logs panel support (in-memory, post-redaction) ----

  /** Entries buffered after `sinceSeq` (0 = all), oldest first. */
  getRecentEntries(sinceSeq = 0): (LogEntry & { seq: number })[] {
    return this.buffer.filter((e) => e.seq > sinceSeq);
  }

  /** Boot id for keying entries (see bootIdValue). */
  get bootId(): string {
    return this.bootIdValue;
  }

  /** Newest buffered sequence number (0 when empty). */
  get lastSeq(): number {
    return this.buffer.length ? this.buffer[this.buffer.length - 1].seq : 0;
  }

  /**
   * Subscribe to new entries. Returns an unsubscribe function. The listener
   * receives the newest seq; callers then drain via getRecentEntries.
   */
  subscribe(listener: (seq: number) => void): () => void {
    this.bufferListeners.add(listener);
    return () => this.bufferListeners.delete(listener);
  }
}

// Live-tail ring: sized for post-governance volume (viewer virtualizes;
// ~1MB at typical entry sizes). Matches the client cap below.
const LOG_BUFFER_SIZE = 5000;

/** The canonical server logger. */
export const logger = new Logger();

// Best-effort crash/shutdown durability: drain the file batch synchronously.
// Sync-only work is allowed here; nothing async, nothing that can throw out.
if (typeof process !== "undefined" && typeof process.once === "function") {
  process.once("exit", () => {
    try {
      logger.flushFileLines();
    } catch {
      /* exiting anyway */
    }
  });
}
