// Shared types for the generic MCP client layer.
//
// TBAi acts as an MCP *client*. It can connect to any standards-compliant MCP
// server over STDIO, Streamable HTTP, or (legacy) SSE, using the official
// @modelcontextprotocol/client v2 packages. These types describe the persisted server
// configuration, the live connection state, and the discovered capabilities.

export type McpTransport = "stdio" | "http" | "sse";

export type McpAuthType = "none" | "bearer" | "basic" | "oauth";

export type McpConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "auth_failed";

/**
 * Machine-readable reason for a failed MCP connection/test. Derived from
 * SSE probe evidence + the SDK error shape by `classifySseFailure`
 * (`src/services/mcp/classify.ts`), never fabricated. The UI renders a short
 * sentence per reason above the raw error text.
 */
export type McpFailureReason =
  | "unreachable"
  | "incompatible_response"
  | "auth_required"
  | "auth_failed"
  | "timeout"
  | "protocol_error"
  | "unknown";

/** Persisted server configuration (one row in the `mcp_servers` table). */
export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  /** STDIO only: command to spawn (e.g. "npx", "bun", "node"). */
  command?: string;
  /** STDIO only: arguments passed to the command. */
  args?: string[];
  /** HTTP/SSE only: server URL. */
  url?: string;
  /** STDIO only: extra environment variables merged into the child process. */
  env?: Record<string, string>;
  /** HTTP/SSE only: extra request headers (e.g. custom auth). */
  headers?: Record<string, string>;
  authType: McpAuthType;
  /** Present only in create/update payloads or decrypted internally. Never returned to the client. */
  authToken?: string;
  /** Client roots advertised to the server (e.g. ["file:///C:/Users/me"]). */
  roots?: string[];
  enabled: boolean;
  autoConnect: boolean;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: unknown;
}

/** A field definition inside an elicitation form request. */
export interface McpElicitationField {
  name: string;
  type: string;
  title?: string;
  description?: string;
  enum?: string[];
  enumNames?: string[];
  default?: string;
}

/** A pending elicitation request from a server, surfaced to the UI for the user to answer. */
export interface McpPendingElicitation {
  serverId: string;
  serverName: string;
  elicitationId: string;
  message: string;
  mode: "form" | "url";
  /** Form mode: the fields the server wants filled in. */
  fields?: McpElicitationField[];
  /** URL mode: the URL the server wants the user to open/confirm. */
  url?: string;
}

/** Result of reading an MCP resource. */
export interface McpResourceReadResult {
  contents: { uri: string; mimeType?: string; text?: string; blob?: string }[];
}

/** Result of retrieving an MCP prompt. */
export interface McpPromptGetResult {
  description?: string;
  messages: { role: "user" | "assistant"; content: { type: string; text?: string } }[];
}

export type McpEventKind =
  | "progress"
  | "tool_list_changed"
  | "resource_list_changed"
  | "prompt_list_changed"
  | "resource_updated"
  | "log"
  | "connected"
  | "disconnected"
  | "error";

export interface McpEvent {
  kind: McpEventKind;
  message: string;
  at: number;
  data?: unknown;
}

/** Live status of a server, returned to the management GUI. */
export interface McpStatus {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  status: McpConnectionStatus;
  error?: string;
  /** Machine-readable failure reason, present when status is error|auth_failed. */
  failureReason?: McpFailureReason;
  serverCapabilities?: Record<string, unknown>;
  /** Negotiated protocol era (v2 SDK), e.g. "legacy" for 2025-era servers. */
  protocolEra?: string;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  lastConnectedAt?: number;
  lastErrorAt?: number;
  /** Recent server-originated notifications/events (most recent last). */
  events: McpEvent[];
  // --- Connection configuration (echoed for editing; never includes secrets) ---
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  authType: McpAuthType;
  /** True when an encrypted credential is stored. Presence only — never a value. */
  authConfigured: boolean;
  /** Masked, non-secret hint (e.g. "Bearer ••••••"). Never contains the credential. */
  authHint?: string;
  autoConnect: boolean;
  notes?: string;
  roots?: string[];
  /** A server-initiated elicitation request awaiting user input, if any. */
  pendingElicitation?: McpPendingElicitation;
}

/** Result of a (possibly unsaved) connection test. */
export interface McpTestResult {
  ok: boolean;
  transport: McpTransport;
  error?: string;
  /** Machine-readable failure reason, present when ok is false. */
  failureReason?: McpFailureReason;
  serverCapabilities?: Record<string, unknown>;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
}
