/**
 * Bounded browser → backend event transport.
 *
 * The frontend logger keeps writing to the console, and ADDITIONALLY batches
 * its entries here so they land in the same backend ring/file/UI pipeline as
 * backend lines. One timeline, one correlation model — no second logging
 * system, no second store.
 *
 * Invariants (all enforced here, all tested):
 * - never blocks the UI: enqueue is synchronous and returns immediately;
 *   the network flush is fire-and-forget.
 * - never throws: every failure is caught, counted, and dropped. A failing
 *   transport must not be able to generate more events than it delivers, so it
 *   never logs its own failures through the logger (that would be a loop).
 * - bounded: queue length, batch size, field count, and value length all have
 *   caps; overflow is counted, never unbounded.
 * - backpressure: after a failure the next flush is delayed progressively
 *   instead of retrying hot.
 *
 * Redaction happens BEFORE enqueue (the logger redacts, as it does for the
 * console), and `toScalarFields` additionally drops anything that is not a flat
 * scalar, so a nested object can never be used to smuggle a payload.
 */

export type ClientLogLevel = "debug" | "info" | "warn" | "error";

export interface ClientLogEvent {
  level: ClientLogLevel;
  scope: string;
  event: string;
  ts: number;
  message?: string;
  operationId?: string;
  threadId?: string;
  conversationId?: string;
  /**
   * Raw (already-redacted) structured fields. Kept wide here and narrowed by
   * `toScalarFields` at the wire boundary — the transport owns its own
   * payload contract, so a call site cannot bypass it by passing an object.
   */
  fields?: Record<string, unknown>;
}

/** Endpoint owned by the existing logs module (`POST /api/logs/client`). */
export const CLIENT_LOG_ENDPOINT = "/api/logs/client";

/** Max events held before the oldest are shed. */
export const MAX_QUEUE = 200;
/** Events per request (matches the ingest schema's cap of 200). */
export const BATCH_SIZE = 20;
/** Steady flush cadence. */
export const FLUSH_MS = 2000;
/** Backoff ceiling after repeated transport failures. */
export const MAX_BACKOFF_MS = 30_000;
const MAX_FIELD_KEYS = 24;
const MAX_STRING_LEN = 500;
const MAX_KEY_LEN = 64;

const RESERVED_FIELD_KEYS = new Set([
  "event",
  "message",
  "operationId",
  "threadId",
  "conversationId",
  "level",
  "scope",
  "ts",
  "time",
  "seq",
]);

/**
 * Keep only flat scalars, drop reserved/oversized entries, and cap the count.
 * Pure and exported so the boundary can be unit-tested without a network.
 */
export function toScalarFields(
  input: Record<string, unknown>,
): Record<string, string | number | boolean | null> | undefined {
  const out: Record<string, string | number | boolean | null> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(input)) {
    if (kept >= MAX_FIELD_KEYS) break;
    if (value === undefined) continue;
    if (RESERVED_FIELD_KEYS.has(key)) continue;
    const safeKey = key.length > MAX_KEY_LEN ? key.slice(0, MAX_KEY_LEN) : key;
    if (value === null || typeof value === "boolean") {
      out[safeKey] = value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      out[safeKey] = value;
    } else if (typeof value === "string") {
      out[safeKey] = value.length > MAX_STRING_LEN ? value.slice(0, MAX_STRING_LEN) : value;
    } else {
      // Nested objects/arrays are deliberately dropped (ingest schema is flat).
      continue;
    }
    kept += 1;
  }
  return kept > 0 ? out : undefined;
}

export interface ClientTransportStats {
  queued: number;
  sent: number;
  dropped: number;
  failures: number;
}

let queue: ClientLogEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let failures = 0;
let pagehideInstalled = false;
const stats: ClientTransportStats = { queued: 0, sent: 0, dropped: 0, failures: 0 };

/**
 * Delivery function. Overridable so tests never replace the global `fetch`:
 * test files share one process, so a global stub races every other file.
 */
let transportFetch: typeof fetch | null = null;

/** Test-only: inject the delivery function (null restores the global fetch). */
export function setTransportFetchForTests(fn: typeof fetch | null): void {
  transportFetch = fn;
}

function resolveFetch(): typeof fetch | null {
  if (transportFetch) return transportFetch;
  return typeof fetch === "function" ? fetch : null;
}

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function backoffMs(): number {
  if (failures === 0) return FLUSH_MS;
  return Math.min(FLUSH_MS * 2 ** Math.min(failures, 4), MAX_BACKOFF_MS);
}

function scheduleFlush(): void {
  if (timer !== null || queue.length === 0) return;
  timer = setTimeout(() => {
    timer = null;
    void flushClientEvents();
  }, backoffMs());
}

function installPagehideFlush(): void {
  if (pagehideInstalled || typeof window === "undefined") return;
  pagehideInstalled = true;
  // Best-effort final delivery on navigation/close. `keepalive` lets the
  // request outlive the page; failures are still swallowed.
  window.addEventListener("pagehide", () => {
    void flushClientEvents({ keepalive: true });
  });
}

/** Queue one already-redacted event. Synchronous, never throws, never blocks. */
export function enqueueClientEvent(event: ClientLogEvent): void {
  installPagehideFlush();
  if (queue.length >= MAX_QUEUE) {
    const overflow = queue.length - MAX_QUEUE + 1;
    queue.splice(0, overflow);
    stats.dropped += overflow;
  }
  queue.push(event);
  stats.queued += 1;
  if (queue.length >= BATCH_SIZE) {
    clearTimer();
    void flushClientEvents();
    return;
  }
  scheduleFlush();
}

/**
 * Send the current batch. Never rejects; on failure the batch is DROPPED (and
 * counted) rather than retried, so a down backend cannot create a retry loop.
 */
export async function flushClientEvents(
  opts: { keepalive?: boolean } = {},
): Promise<void> {
  if (inFlight || queue.length === 0) return;
  const doFetch = resolveFetch();
  if (!doFetch) return;
  inFlight = true;
  clearTimer();
  const batch = queue.splice(0, BATCH_SIZE);
  // Flatten at the boundary: whatever a call site passed, only flat scalars
  // reach the wire (the ingest schema rejects anything else).
  const payload = batch.map((e) => ({
    ...e,
    fields: e.fields ? toScalarFields(e.fields) : undefined,
  }));
  try {
    const res = await doFetch(CLIENT_LOG_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: payload }),
      ...(opts.keepalive ? { keepalive: true } : {}),
    });
    if (res.ok) {
      stats.sent += batch.length;
      failures = 0;
    } else {
      stats.failures += 1;
      stats.dropped += batch.length;
      failures += 1;
    }
  } catch {
    stats.failures += 1;
    stats.dropped += batch.length;
    failures += 1;
  } finally {
    inFlight = false;
    if (queue.length >= BATCH_SIZE) void flushClientEvents();
    else scheduleFlush();
  }
}

/** Current transport counters (tests, diagnostics). */
export function clientTransportStats(): ClientTransportStats & { inFlight: boolean } {
  return { ...stats, inFlight };
}

/** Test-only reset: clears the queue, timer, counters, and failure backoff. */
export function resetClientTransportForTests(): void {
  clearTimer();
  queue = [];
  inFlight = false;
  failures = 0;
  pagehideInstalled = false;
  transportFetch = null;
  stats.queued = 0;
  stats.sent = 0;
  stats.dropped = 0;
  stats.failures = 0;
}
