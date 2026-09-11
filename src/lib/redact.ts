// Redacts likely secret material from log output. Defense-in-depth: the app never
// places API keys or the master password into error messages, but this scrubs
// accidental leaks before they reach stdout/stderr.

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /AIza[0-9A-Za-z_-]{8,}/g,
  /xox[baprs]-[0-9A-Za-z-]{8,}/g,
  /(api[_-]?key|secret|token|password|passwd)["'\s:=]+[^\s"',}]{8,}/gi,
];

export function redact(value: unknown): string {
  let str: string;
  if (value instanceof Error) {
    str = `${value.name}: ${value.message}`;
    if (value.stack) str += `\n${value.stack}`;
  } else if (typeof value === "string") {
    str = value;
  } else {
    try {
      str = JSON.stringify(value);
    } catch {
      str = String(value);
    }
  }
  for (const re of SECRET_PATTERNS) {
    str = str.replace(re, (m) => `${m.slice(0, 6)}[REDACTED]`);
  }
  return str;
}

/**
 * User-facing stream error copy. Maps provider/auth/rate-limit/abort failures
 * to stable messages so the ErrorPrimitive UI never renders raw SDK text.
 * Secrets are still scrubbed via redact() before returning.
 */
export function sanitizeStreamError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  let mapped: string;
  if (lower.includes("abort") || lower.includes("aborted") || lower.includes("cancel")) {
    mapped = "Generation stopped.";
  } else if (/(401|403|unauthorized|forbidden|invalid api key|invalid_api_key|authentication)/i.test(raw)) {
    mapped = "Provider credentials invalid or missing. Check the provider API key.";
  } else if (/(429|rate limit|rate_limit|quota|too many requests)/i.test(raw)) {
    mapped = "Provider rate limit reached. Wait briefly and retry.";
  } else if (/(network|fetch failed|econn|enotfound|timeout|socket)/i.test(raw)) {
    mapped = "Network error reaching the provider. Retry when online.";
  } else if (/(tool|mcp)/i.test(raw) && lower.includes("error")) {
    mapped = "A tool call failed. See diagnostics and retry.";
  } else {
    mapped = "Generation failed. Retry or pick another provider/model.";
  }
  return redact(mapped);
}

import { logger, normalizeError } from "./logger";

/** Server-side diagnostic log for stream failures (no message content). */
export function logStreamDiagnostic(scope: string, error: unknown): void {
  // Central logger owns the output; this wrapper preserves the call sites.
  logger.error(scope, "stream_error", { ...normalizeError(error) });
}
