import type { Context, Next } from "hono";
import { logger } from "../lib/logger";

/**
 * In-memory HTTP operational counters (Prometheus-style exposition). The
 * server's own liveness/throughput signal — the source of truth for "is it
 * still up, how many inflight, is it stalling". Read only by the /metrics
 * endpoint and the shutdown drain below. No external dependency; a small flat
 * object is the minimum-custom-code choice over a metrics lib.
 *
 * The one import is the logger, for `logLossMetricsText()` below: logging loss
 * must be visible from the same scrape as everything else. The logger imports
 * nothing from here, so there is no cycle and any load order stays safe.
 */
export const metrics = {
  http_requests_total: 0,
  http_requests_inflight: 0,
  http_requests_duration_ms_sum: 0,
  http_requests_duration_ms_count: 0,
};

export function metricsText(): string {
  return [
    "# HELP http_requests_total Total HTTP requests received",
    "# TYPE http_requests_total counter",
    `http_requests_total ${metrics.http_requests_total}`,
    "# HELP http_requests_inflight Inflight HTTP requests",
    "# TYPE http_requests_inflight gauge",
    `http_requests_inflight ${metrics.http_requests_inflight}`,
    "# HELP http_requests_duration_ms_sum Sum of request durations in ms",
    "# TYPE http_requests_duration_ms_sum counter",
    `http_requests_duration_ms_sum ${metrics.http_requests_duration_ms_sum.toFixed(0)}`,
    "# HELP http_requests_duration_ms_count Count of requests recorded",
    "# TYPE http_requests_duration_ms_count counter",
    `http_requests_duration_ms_count ${metrics.http_requests_duration_ms_count}`,
  ].join("\n");
}

/**
 * Logging-loss exposition. Answers "could evidence have disappeared?" from a
 * scrape instead of by inference: every path that can discard a log entry has
 * a counter here. Monotonic per process (they reset with the process, exactly
 * like the ring they describe).
 */
export function logLossMetricsText(): string {
  const { loss } = logger.getWriteStats();
  return [
    "# HELP tbai_log_entries_level_filtered Entries discarded by the level filter",
    "# TYPE tbai_log_entries_level_filtered counter",
    `tbai_log_entries_level_filtered ${loss.levelFiltered}`,
    "# HELP tbai_log_entries_ring_spliced Entries dropped from the live-tail ring",
    "# TYPE tbai_log_entries_ring_spliced counter",
    `tbai_log_entries_ring_spliced ${loss.ringSpliced}`,
    "# HELP tbai_log_entries_file_queue_dropped Entries dropped from the file-sink backlog",
    "# TYPE tbai_log_entries_file_queue_dropped counter",
    `tbai_log_entries_file_queue_dropped ${loss.fileQueueDropped}`,
    "# HELP tbai_log_file_io_failures File sink write/rotate/prune failures",
    "# TYPE tbai_log_file_io_failures counter",
    `tbai_log_file_io_failures ${loss.ioFailures}`,
  ].join("\n");
}

/**
 * Request-accounting middleware: increments the in-flight gauge for the
 * duration of every request and records total + duration on completion.
 * The requestId correlation itself is owned by the logger's
 * AsyncLocalStorage — this middleware only measures, it does not mint ids.
 * The hono import is type-only (erased at runtime), so this module stays
 * free of runtime cycles with the route tree.
 */
export async function accountingMiddleware(c: Context, next: Next): Promise<void> {
  const start = performance.now();
  metrics.http_requests_total++;
  metrics.http_requests_inflight++;
  try {
    await next();
  } finally {
    const durMs = performance.now() - start;
    metrics.http_requests_duration_ms_sum += durMs;
    metrics.http_requests_duration_ms_count++;
    metrics.http_requests_inflight--;
  }
}

// Wait for inflight requests to drain before the listener fully stops, so an
// in-progress stream or response is not cut mid-flight on SIGINT/SIGTERM.
// Bounded: after the timeout we proceed regardless (the process is exiting).
export async function drainInflightRequests(timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (metrics.http_requests_inflight > 0 && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
