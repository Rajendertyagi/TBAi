/**
 * Minimal frontend logger following the same contract as the server logger
 * (src/lib/logger.ts): levels, scope/event, correlation fields, redaction.
 *
 * Local only: console backend, no network transport, no secrets. Debug logs
 * are compiled out of production builds via import.meta.env.DEV checks at the
 * call sites that care; this module itself just filters by level.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogFields {
  event?: string;
  message?: string;
  requestId?: string;
  conversationId?: string;
  threadId?: string;
  provider?: string;
  model?: string;
  tool?: string;
  [key: string]: unknown;
}

const SENSITIVE_KEY_RE =
  /api[_-]?key|authorization|token|secret|password|passwd|cookie|credential|auth/i;

function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, (m) => `${m.slice(0, 6)}[REDACTED]`)
      .replace(/AIza[0-9A-Za-z_-]{8,}/g, (m) => `${m.slice(0, 6)}[REDACTED]`);
  }
  if (typeof value !== "object" || depth > 5) return typeof value === "object" ? "[object]" : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? "[REDACTED]" : redactValue(v, depth + 1);
  }
  return out;
}

let level: LogLevel = import.meta.env.DEV ? "debug" : "warn";

export function setLogLevel(next: LogLevel): void {
  level = next;
}

function emitLog(logLevel: LogLevel, scope: string, event: string, fields: LogFields = {}): void {
  if (ORDER[logLevel] < ORDER[level]) return;
  const safe = redactValue({ ...fields, event }) as Record<string, unknown>;
  const line = `[tbai:${scope}] ${event}` + (safe.message ? ` ${safe.message}` : "");
  // eslint-disable-next-line no-console
  if (logLevel === "error") console.error(line, safe);
  // eslint-disable-next-line no-console
  else if (logLevel === "warn") console.warn(line, safe);
  // eslint-disable-next-line no-console
  else console.log(line, safe);
}

export const logger = {
  debug: (scope: string, event: string, fields: LogFields = {}) => emitLog("debug", scope, event, fields),
  info: (scope: string, event: string, fields: LogFields = {}) => emitLog("info", scope, event, fields),
  warn: (scope: string, event: string, fields: LogFields = {}) => emitLog("warn", scope, event, fields),
  error: (scope: string, event: string, fields: LogFields = {}) => emitLog("error", scope, event, fields),
};

let hooksInstalled = false;

/**
 * Capture otherwise-silent failures: unhandled rejections, window errors,
 * and React/runtime errors that escape to the global handlers.
 */
export function installGlobalLogHooks(): void {
  if (hooksInstalled || typeof window === "undefined") return;
  hooksInstalled = true;
  window.addEventListener("unhandledrejection", (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    logger.error("app", "unhandled_rejection", {
      message: reason instanceof Error ? reason.message : String(reason),
      errorType: reason instanceof Error ? reason.name : typeof reason,
    });
  });
  window.addEventListener("error", (e) => {
    const err = (e as ErrorEvent).error;
    logger.error("app", "window_error", {
      message: (e as ErrorEvent).message || (err instanceof Error ? err.message : String(err)),
      errorType: err instanceof Error ? err.name : typeof err,
    });
  });
}
