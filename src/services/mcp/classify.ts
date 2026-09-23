// MCP-specific failure classification for SSE diagnostics.
//
// Maps SSE probe evidence (+ an optional SDK connect error) onto
// `McpFailureReason`. Deliberately LOCAL to MCP: the global `classifyError()`
// taxonomy in `src/lib/errors.ts` is untouched, so global retry semantics
// cannot move. Evidence order is fixed: unreachable first, then auth, then
// content-type, then timeout, then SDK-error shape, else unknown.

import type { McpFailureReason } from "./types";

/** Outcome of the read-only SSE endpoint probe (status + content-type only). */
export type SseProbeOutcome =
  | { kind: "ok"; status: number; contentType: string | null }
  | { kind: "unreachable" }
  | { kind: "timeout" }
  | { kind: "error" };

const AUTH_ERROR_RE = /401|403|unauthorized|forbidden|authentication|credential/i;
const TIMEOUT_ERROR_RE = /timeout|timed out|abort/i;

/**
 * Classify an SSE connection failure from probe evidence and the SDK error.
 * Pure: no I/O, no logging. `hasToken` distinguishes auth_required (no
 * credential stored) from auth_failed (credential stored but rejected).
 */
export function classifySseFailure(
  probe: SseProbeOutcome,
  connectError?: unknown,
  hasToken = false,
): McpFailureReason {
  if (probe.kind === "unreachable") return "unreachable";
  if (probe.kind === "timeout") return "timeout";
  if (probe.kind === "ok") {
    if (probe.status === 401 || probe.status === 403) {
      return hasToken ? "auth_failed" : "auth_required";
    }
    if (probe.status >= 200 && probe.status < 300) {
      const ct = (probe.contentType ?? "").toLowerCase();
      if (!ct.includes("text/event-stream")) return "incompatible_response";
    }
    // Probe inconclusive (e.g. odd status with SSE content-type): fall
    // through to the SDK error shape below.
  }
  if (connectError !== undefined) {
    const text = connectError instanceof Error ? connectError.message : String(connectError);
    if (AUTH_ERROR_RE.test(text)) return "auth_failed";
    if (TIMEOUT_ERROR_RE.test(text)) return "timeout";
    return "protocol_error";
  }
  return "unknown";
}

/**
 * Safe, non-secret endpoint metadata for logs: host, port, path only.
 * Query strings are dropped (they may carry secrets); the full URL is never logged.
 */
export function safeEndpointMeta(url: string): { host: string; port: string; path: string } {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || (u.protocol === "https:" ? "443" : "80"),
      path: u.pathname,
    };
  } catch {
    return { host: "(invalid-url)", port: "", path: "" };
  }
}
