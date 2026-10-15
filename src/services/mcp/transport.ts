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
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/client";
import type { SseProbeOutcome } from "./classify";
import type { McpAuthType, McpFailureReason, McpServerConfig } from "./types";

/** The probe gives up after this long; a real connect has its own budget. */
const SSE_PROBE_TIMEOUT_MS = 3000;

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
 */
export function buildTransport(config: McpServerConfig, authToken?: string): Transport {
  if (config.transport === "stdio") {
    if (!config.command) {
      throw new Error("STDIO transport requires a command");
    }
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      // `process.env` is typed `string | undefined` per entry, while the SDK wants
      // `string`. Values that are genuinely absent must not reach the child as the
      // string "undefined", so they are dropped — which is what the environment
      // already means by them.
      env: Object.fromEntries(
        Object.entries({ ...process.env, ...(config.env ?? {}) }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      cwd: process.cwd(),
      stderr: "ignore",
    }) as unknown as Transport;
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

/**
 * Fetch an SSE endpoint once and classify what answered.
 *
 * Only the status and content type are kept — never headers, never the URL
 * query — so the outcome is safe to log. A body read failure is swallowed: the
 * classification has already been decided by the time it would occur.
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
    try {
      await res.arrayBuffer();
    } catch {
      /* body discard is best-effort */
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
 * Classify a server as local or remote based on its transport and URL.
 *
 * - STDIO servers are always local (they spawn a local process).
 * - HTTP/SSE servers are local when their URL host is localhost, 127.0.0.1,
 *   or ::1; otherwise remote.
 */
export function classifyLocation(config: McpServerConfig): "local" | "remote" {
  if (config.transport === "stdio") return "local";
  if (!config.url) return "remote";
  try {
    const host = new URL(config.url).hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
      return "local";
    }
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
