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
 * User-facing stream error copy. Consumes the shared classification so the
 * ErrorPrimitive UI never renders raw SDK text and never diverges from the
 * retry/logging policy. Secrets are still scrubbed via redact() before
 * returning.
 */
export function sanitizeStreamError(error: unknown): string {
  switch (classifyError(error).category) {
    case "cancelled":
      return redact("Generation stopped.");
    case "auth":
      return redact("Provider credentials invalid or missing. Check the provider API key.");
    case "rate_limit":
      return redact("Provider rate limit reached. Wait briefly and retry.");
    case "network":
    case "timeout":
      return redact("Network error reaching the provider. Retry when online.");
    case "tool":
      return redact("A tool call failed. See diagnostics and retry.");
    default:
      return redact("Generation failed. Retry or pick another provider/model.");
  }
}

import { classifyError } from "./errors";
