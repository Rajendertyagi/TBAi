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
 *   logger.info("chat", "stream_started", { requestId, provider, model });
 *
 * Conventions:
 * - `scope` namespaces the subsystem ("http", "chat", "ai.provider",
 *   "mcp", "tools", "storage", ...).
 * - `event` is a stable snake_case name, never prose ("stream_error", not
 *   "stream failed!"). Grep-able, dashboard-able.
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

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function isProd(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.NODE_ENV ?? "development") === "production";
}

export interface LoggerConfig {
  level: LogLevel;
  file: string | null;
  maxBytes: number;
  keepFiles: number;
}

export function resolveLoggerConfig(env: NodeJS.ProcessEnv = process.env): LoggerConfig {
  const prod = isProd(env);
  const level = (env.TBAI_LOG_LEVEL ?? (prod ? "info" : "debug")) as LogLevel;
  const maxMb = Number(env.TBAI_LOG_MAX_MB ?? 5);
  const keepFiles = Number(env.TBAI_LOG_KEEP ?? 3);
  let file: string | null;
  if (env.TBAI_LOG_FILE === "off") {
    file = null;
  } else if (env.TBAI_LOG_FILE) {
    file = env.TBAI_LOG_FILE;
  } else {
    file = isProd(env)
      ? path.join(env.DATA_DIR || path.join(process.cwd(), "data"), "tbai.log")
      : null;
  }
  return {
    level: LEVEL_ORDER[level] === undefined ? (isProd(env) ? "info" : "debug") : level,
    file,
    maxBytes: Number.isFinite(maxMb) && maxMb > 0 ? Math.floor(maxMb * 1024 * 1024) : 5 * 1024 * 1024,
    keepFiles: Number.isFinite(keepFiles) && keepFiles >= 1 ? Math.floor(keepFiles) : 3,
  };
}

export interface LogFields {
  event?: string;
  message?: string;
  requestId?: string;
  conversationId?: string;
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

export interface RequestContext {
  requestId: string;
  conversationId?: string;
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

class Logger {
  private config: LoggerConfig;

  // Live log buffer for the in-app Logs panel: bounded ring of post-redaction
  // entries with a monotonic sequence, plus SSE subscriber notification.
  private buffer: (LogEntry & { seq: number })[] = [];
  private bufferSeq = 0;
  private bufferListeners = new Set<(seq: number) => void>();

  constructor(config?: Partial<LoggerConfig>) {
    this.config = { ...resolveLoggerConfig(), ...config };
  }

  /** Override config at runtime (tests, boot). */
  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  get level(): LogLevel {
    return this.config.level;
  }

  isEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.config.level];
  }

  private write(entry: LogEntry): void {
    if (!this.isEnabled(entry.level)) return;
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
    const file = this.config.file;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      rotateIfNeeded(file, this.config.maxBytes, this.config.keepFiles);
      fs.appendFileSync(file, `${JSON.stringify({ ...safe, time: new Date().toISOString() })}\n`);
    } catch {
      /* file logging is best-effort; console already emitted */
    }
  }

  private emit(level: LogLevel, scope: string, event: string, fields: LogFields = {}): void {
    const ctx = getRequestContext();
    const merged: LogFields = {
      requestId: ctx?.requestId,
      conversationId: ctx?.conversationId,
      ...fields,
      event,
    };
    // Explicit fields win; drop undefined correlation ids.
    if (merged.requestId === undefined) delete merged.requestId;
    if (merged.conversationId === undefined) delete merged.conversationId;
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

const LOG_BUFFER_SIZE = 1000;

/** The canonical server logger. */
export const logger = new Logger();
