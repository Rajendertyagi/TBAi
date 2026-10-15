/**
 * MCP transport construction and endpoint diagnostics.
 *
 * Extracted verbatim from `manager.ts`. The transports are the official
 * `@modelcontextprotocol/sdk` clients; this module only decides WHICH one to
 * build and with what headers. It holds no connection state, so `manager.ts` can
 * call into it mid-connect without a cycle.
 *
 * ## Why header building lives here
 *
 * The auth token is the reason. It is decrypted in `store.ts`, used here to
 * build the header map, and must never reach a log line or a config object.
 * Keeping construction and its credential use in one module means there is
 * exactly one place in the codebase that can turn a token into a header.
 *
 * ## Why the probe exists
 *
 * An SSE endpoint that answers `200 text/html` is the single most common MCP
 * misconfiguration: a web UI sitting where the endpoint should be. The probe
 * fetches once and classifies the CONTENT TYPE, which is the only way to tell
 * that apart from a working stream. It never logs headers or the URL query.
 */
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/client";
import { logger } from "../../lib/logger";
import type { SseProbeOutcome } from "./classify";
import type { McpAuthType, McpFailureReason, McpServerConfig } from "./types";

/** The probe gives up after this long; a real connect has its own budget. */
const SSE_PROBE_TIMEOUT_MS = 3000;

/** Maximum bytes of stderr to buffer for diagnostics. */
const MAX_STDERR_BUFFER = 4096;

/**
 * Request headers for a server, including its authorization header.
 *
 * A token is only attached when the server actually declares an auth type: a
 * token stored against an `authType` of `none` must not be sent, or it would
 * leak a credential to a server that never asked for one.
 */
export function buildHeaders(config: McpServerConfig, authToken?: string): Record<string, string> {
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  if (authToken && config.authType !== "none") {
    if (config.authType === "bearer" || config.authType === "oauth") {
      headers.Authorization = `Bearer ${authToken}`;
    } else if (config.authType === "basic") {
      headers.Authorization = `Basic ${Buffer.from(authToken).toString("base64")}`;
    }
  }
  return headers;
}

/**
 * Build the SDK transport for a configured server.
 *
 * Throws when a required field is missing (stdio without a command, http/sse
 * without a URL). That is deliberate: a server that cannot be addressed is a
 * configuration error, and the caller turns it into a classified failure.
 *
 * ## Environment isolation (F2)
 *
 * The SDK's `getDefaultEnvironment()` provides a platform allowlist of safe
 * variables (PATH, HOME, etc.). We use it instead of `process.env` to prevent
 * leaking host credentials into child processes. Explicit `config.env` entries
 * are merged on top.
 *
 * ## Stderr diagnostics (F2)
 *
 * stderr is set to `"pipe"` and drained to prevent the child from blocking
 * on a full pipe. Output is logged as structured diagnostics, bounded and
 * filtered to avoid leaking secrets.
 */
export function buildTransport(config: McpServerConfig, authToken?: string): Transport {
  if (config.transport === "stdio") {
    if (!config.command) {
      throw new Error("STDIO transport requires a command");
    }
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
      cwd: process.cwd(),
      stderr: "pipe",
    }) as unknown as Transport;
    // Collect configured secret values for redaction
    const configuredSecrets: string[] = [];
    if (authToken) configuredSecrets.push(authToken);
    if (config.env) {
      for (const val of Object.values(config.env)) {
        if (typeof val === "string") configuredSecrets.push(val);
      }
    }
    // Drain stderr to prevent pipe-buffer blocking and surface diagnostics.
    attachStdioStderrDiagnostics(transport, config.name, configuredSecrets);
    return transport;
  }
  if (!config.url) {
    throw new Error(`${config.transport.toUpperCase()} transport requires a URL`);
  }
  const url = new URL(config.url);
  if (config.transport === "http") {
    return new StreamableHTTPClientTransport(url, {
      requestInit: { headers: buildHeaders(config, authToken) },
    }) as unknown as Transport;
  }
  // sse
  return new SSEClientTransport(url, {
    requestInit: { headers: buildHeaders(config, authToken) },
  }) as unknown as Transport;
}

const CREDENTIAL_PATTERNS: RegExp[] = [
  // Bearer tokens, JWTs, generic tokens
  /Bearer\s+[A-Za-z0-9_\-.~+/=]+/gi,
  // API keys / tokens in standard flag/kv assignments: key=..., token=..., secret=...
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
  // Common vendor key prefixes
  /\b(?:sk-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{30,}|gho_[a-zA-Z0-9]{30,}|xox[baprs]-[a-zA-Z0-9_-]+)\b/g,
];

/**
 * Redact sensitive strings and credential patterns from stderr text.
 */
export function redactStderr(text: string, configuredSecrets: string[] = []): string {
  let redacted = text;

  // 1. Redact configured explicit values (min length 4 to avoid over-matching short words)
  for (const secret of configuredSecrets) {
    if (typeof secret === "string" && secret.trim().length >= 4) {
      // Escape special regex characters in the secret string
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      redacted = redacted.replace(new RegExp(escaped, "g"), "[REDACTED]");
    }
  }

  // 2. Redact heuristic patterns (bearer tokens, key=value, common token prefixes)
  for (const pattern of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      const eqIdx = match.search(/[:=]/);
      if (eqIdx !== -1) {
        return `${match.slice(0, eqIdx + 1)}[REDACTED]`;
      }
      if (/^bearer\s+/i.test(match)) {
        return "Bearer [REDACTED]";
      }
      return "[REDACTED]";
    });
  }

  return redacted;
}

/**
 * Attach a stderr listener to a stdio transport for diagnostic output.
 *
 * The child process's stderr is drained to prevent it from blocking when the
 * OS pipe buffer fills. Output is logged as structured diagnostics, bounded
 * and filtered to avoid leaking credentials or arbitrary unredacted content.
 */
function attachStdioStderrDiagnostics(
  transport: Transport,
  serverName: string,
  configuredSecrets: string[] = [],
): void {
  const stdioTransport = transport as unknown as { stderr?: import("node:stream").Stream | null };
  const stderr = stdioTransport.stderr;
  if (!stderr || typeof stderr.on !== "function") return;

  let buffer = "";
  stderr.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    // Keep only the last MAX_STDERR_BUFFER bytes to bound memory.
    if (buffer.length > MAX_STDERR_BUFFER) {
      buffer = buffer.slice(-MAX_STDERR_BUFFER);
    }
  });
  stderr.on("end", () => {
    if (buffer.trim()) {
      const safeOutput = redactStderr(buffer.slice(0, MAX_STDERR_BUFFER), configuredSecrets);
      logger.warn("mcp", "mcp.stdio_stderr", {
        mcpServer: serverName,
        output: safeOutput,
      });
    }
  });
}

/**
 * Fetch an SSE endpoint once and classify what answered.
 *
 * Only the status and content type are kept — never headers, never the URL
 * query — so the outcome is safe to log. The response body is cancelled
 * immediately after reading headers to avoid blocking on a long-lived SSE
 * stream (F1).
 */
export async function probeSseEndpoint(
  url: string,
  headers: Record<string, string>,
): Promise<SseProbeOutcome> {
  try {
    const res = await fetch(url, {
      headers: { ...headers, Accept: "text/event-stream" },
      signal: AbortSignal.timeout(SSE_PROBE_TIMEOUT_MS),
    });
    const contentType = res.headers.get("content-type");
    // Cancel the body immediately — we have the headers we need.
    // A healthy SSE stream would otherwise block for the full timeout.
    try {
      await res.body?.cancel();
    } catch {
      /* body cancel is best-effort */
    }
    return { kind: "ok", status: res.status, contentType };
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return { kind: "timeout" };
    }
    const text = err instanceof Error ? err.message : String(err);
    if (/timed out|timeout|aborted/i.test(text)) return { kind: "timeout" };
    // DNS refusal / connection refused / no listener: the fetch layer
    // cannot establish the connection at all.
    return { kind: "unreachable" };
  }
}

/**
 * Validate and parse an IPv4 address string.
 * Returns the numeric value or null if invalid.
 */
function parseIPv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = parseInt(part, 10);
    if (num > 255) return null;
    result = result * 256 + num;
  }
  return result;
}

/**
 * Classify a server as local or remote based on its transport and URL.
 *
 * - STDIO servers are always local (they spawn a local process).
 * - HTTP/SSE servers are local when their URL host is localhost, a valid
 *   loopback address (127.0.0.0/8 or IPv6 loopback), or a *.localhost name;
 *   otherwise remote.
 */
export function classifyLocation(config: McpServerConfig): "local" | "remote" {
  if (config.transport === "stdio") return "local";
  if (!config.url) return "remote";
  try {
    const host = new URL(config.url).hostname.toLowerCase();
    // localhost and *.localhost
    if (host === "localhost" || host.endsWith(".localhost")) return "local";
    // IPv6 loopback — Bun's URL.hostname keeps the brackets: "[::1]".
    if (host === "::1" || host === "[::1]") return "local";
    // IPv4 loopback — validate it's actually an IP before checking range
    const ipv4 = parseIPv4(host);
    if (ipv4 !== null && ipv4 >= 0x7f000000 && ipv4 <= 0x7fffffff) return "local";
    return "remote";
  } catch {
    return "remote";
  }
}

/** Masked hint that an auth type is configured, for a settings screen. */
export function authHintFor(authType: McpAuthType, authConfigured: boolean): string | undefined {
  if (!authConfigured || authType === "none") return undefined;
  const label = authType === "bearer" ? "Bearer" : authType === "basic" ? "Basic" : "OAuth";
  return `${label} ••••••`;
}

/** The message of an unknown thrown value. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Human-readable, non-secret detail for a classified SSE failure. Carries
 * host/port/path only — never query strings, headers, or credentials.
 */
export function sseFailureMessage(
  reason: McpFailureReason,
  meta: { host: string; port: string; path: string },
  detail?: string,
): string {
  const where = meta.host ? `${meta.host}:${meta.port}${meta.path}` : "endpoint";
  switch (reason) {
    case "unreachable":
      return `Cannot reach ${where} — is the service running?`;
    case "auth_required":
      return `Authentication required for ${where} — no credential is stored`;
    case "auth_failed":
      return `Authentication failed for ${where} — check the stored credential`;
    case "incompatible_response":
      return `Endpoint ${where} did not return an SSE stream — confirm the URL points at an MCP SSE endpoint`;
    case "timeout":
      return `Connection to ${where} timed out`;
    case "protocol_error":
      return detail ? `MCP protocol error: ${detail}` : `MCP protocol error with ${where}`;
    default:
      return detail ? `Connection failed: ${detail}` : `Connection to ${where} failed`;
  }
}
