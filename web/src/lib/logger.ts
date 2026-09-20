/**
 * Frontend logger: same contract as the server logger (src/lib/logger.ts) —
 * levels, scope/event, correlation fields, redaction.
 *
 * Two sinks:
 * - console (unchanged behavior: `debug` in dev, `warn` in production);
 * - the backend logging pipeline, via the bounded batching transport, so
 *   browser lifecycle evidence lands in the SAME ring/file/UI as backend
 *   lines and can be reconstructed with one operationId.
 *
 * The two sinks have deliberately different levels. Console stays quiet in
 * production (an operator does not want browser chatter in devtools), while the
 * transport keeps `info` so the lifecycle events that make an operation
 * reconstructable actually arrive. `debug` never leaves the browser in
 * production — this is intentional production logging, not "log everything".
 */

import { enqueueClientEvent, type ClientLogLevel } from "./log-transport";
import { isKnownClientScope } from "./log-scopes";
import { currentOperationId } from "./operation";
import { boundedStack, classifyBrowserError } from "./browser-errors";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogFields {
  event?: string;
  message?: string;
  requestId?: string;
  operationId?: string;
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

/** Console filter (unchanged): dev shows everything, production only warn+. */
let level: LogLevel = import.meta.env.DEV ? "debug" : "warn";
/** Transport filter: dev shows everything, production keeps lifecycle info. */
let transportLevel: LogLevel = import.meta.env.DEV ? "debug" : "info";
let transportEnabled = true;

export function setLogLevel(next: LogLevel): void {
  level = next;
}

/** Override the transport's capture level (tests, diagnostics). */
export function setTransportLevel(next: LogLevel): void {
  transportLevel = next;
}

/** Turn the backend transport off entirely (tests, opt-out). */
export function setClientTransportEnabled(enabled: boolean): void {
  transportEnabled = enabled;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function emitLog(logLevel: LogLevel, scope: string, event: string, fields: LogFields = {}): void {
  if (import.meta.env.DEV && !isKnownClientScope(scope)) {
    // Dev-only guard: an unregistered scope would fragment the vocabulary and
    // is rejected by the backend ingest boundary anyway.
    // eslint-disable-next-line no-console
    console.warn(`[tbai] unregistered log scope "${scope}" (see lib/log-scopes.ts)`);
  }
  const safe = redactValue({ ...fields, event }) as Record<string, unknown>;
  const line = `[tbai:${scope}] ${event}` + (safe.message ? ` ${safe.message}` : "");

  if (ORDER[logLevel] >= ORDER[level]) {
    // eslint-disable-next-line no-console
    if (logLevel === "error") console.error(line, safe);
    // eslint-disable-next-line no-console
    else if (logLevel === "warn") console.warn(line, safe);
    // eslint-disable-next-line no-console
    else console.log(line, safe);
  }

  if (transportEnabled && ORDER[logLevel] >= ORDER[transportLevel]) {
    enqueueClientEvent({
      level: logLevel as ClientLogLevel,
      scope,
      event,
      ts: Date.now(),
      // The event's own operationId wins; otherwise the active operation is
      // attached, so a call site never has to thread the id through.
      operationId: asString(safe.operationId) ?? currentOperationId(),
      threadId: asString(safe.threadId),
      conversationId: asString(safe.conversationId),
      message: asString(safe.message),
      fields: safe,
    });
  }
}

export const logger = {
  debug: (scope: string, event: string, fields: LogFields = {}) => emitLog("debug", scope, event, fields),
  info: (scope: string, event: string, fields: LogFields = {}) => emitLog("info", scope, event, fields),
  warn: (scope: string, event: string, fields: LogFields = {}) => emitLog("warn", scope, event, fields),
  error: (scope: string, event: string, fields: LogFields = {}) => emitLog("error", scope, event, fields),
};

let hooksInstalled = false;

/** Current route, for error context. Hash routing, so the hash IS the route. */
function currentRoute(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const hash = window.location.hash;
  return hash.length > 0 ? hash.slice(0, 200) : undefined;
}

/**
 * The ONE place that decides whether a browser error is an application failure
 * or a browser layout notice, so `window.error` and `unhandledrejection` cannot
 * drift apart. Both channels keep their own event name for genuine failures;
 * the exact ResizeObserver delivery notice is recorded as a layout diagnostic
 * instead of an uncaught exception (see `lib/browser-errors.ts` for why the
 * match is exact rather than a blanket ResizeObserver filter).
 *
 * The operationId is attached by `emitLog` from the operation that is genuinely
 * active at this moment — never a stale one, and never one minted for the error.
 */
function emitBrowserError(
  event: "window_error" | "unhandled_rejection",
  input: {
    message: string;
    errorType: string;
    stack?: string;
    source?: string;
    line?: number;
    column?: number;
  },
): void {
  const fields = { ...input, route: currentRoute() };
  if (
    classifyBrowserError({ message: input.message, errorName: input.errorType }) ===
    "layout_diagnostic"
  ) {
    // Visible (warn reaches the backend in production) but not an error, and
    // the metadata is preserved so an unexpected layout problem stays
    // diagnosable.
    logger.warn("app", "browser_layout_diagnostic", fields);
    return;
  }
  logger.error("app", event, fields);
}

/**
 * Minimal event target the global hooks install into. Injectable so a test can
 * install them against a fake instead of replacing `globalThis.window` — test
 * files share one process, so a global stub leaks into every other file.
 */
export interface LogHookTarget {
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

/**
 * Capture otherwise-silent failures: unhandled rejections, window errors,
 * and React/runtime errors that escape to the global handlers.
 */
export function installGlobalLogHooks(target?: LogHookTarget): void {
  const host =
    target ??
    (typeof window === "undefined" ? undefined : (window as unknown as LogHookTarget));
  if (hooksInstalled || !host) return;
  hooksInstalled = true;
  host.addEventListener("unhandledrejection", (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    emitBrowserError("unhandled_rejection", {
      message: reason instanceof Error ? reason.message : String(reason),
      errorType: reason instanceof Error ? reason.name : typeof reason,
      stack: boundedStack(reason),
    });
  });
  host.addEventListener("error", (e) => {
    const event = e as ErrorEvent;
    const err = event.error;
    emitBrowserError("window_error", {
      message: event.message || (err instanceof Error ? err.message : String(err)),
      errorType: err instanceof Error ? err.name : typeof err,
      stack: boundedStack(err),
      source: event.filename || undefined,
      line: event.lineno || undefined,
      column: event.colno || undefined,
    });
  });
}
