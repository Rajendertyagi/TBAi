import type { LogFields } from "./logger";

/**
 * Sanitized AI-request diagnostics (see docs: AI_DEBUG_REQUESTS).
 *
 * Purpose: make provider rejections like Gemini INVALID_ARGUMENT diagnosable
 * from structure alone, WITHOUT ever logging raw user text, file contents,
 * credentials, or replay tokens.
 *
 * Sanitization contract (default, always on when diagnostics are captured):
 * - text content → `[text:N chars]` (length only)
 * - tool arguments → `{ [key]: "[N chars]" }` (keys kept, values redacted)
 * - thoughtSignature / replay tokens → `{ present: true, length: N }`
 * - tool schemas → full structure (names, required, property keys + scalar
 *   types). Schemas contain no user data, so structure is kept verbatim.
 * - approval ids / toolCallIds → kept verbatim (random ids needed to match
 *   calls to responses)
 * - user approval decisions (approved/denied) → kept (needed for lifecycle)
 *
 * Nothing here touches credentials: provider keys, DEKs, and auth headers
 * never enter ModelMessages and are additionally scrubbed by the logger's
 * field redaction.
 */

function textMarker(text: unknown): string {
  return `[text:${String(text ?? "").length} chars]`;
}

function argSkeleton(args: unknown): unknown {
  if (args === null || args === undefined) return args;
  if (typeof args === "string") return `[${args.length} chars]`;
  if (typeof args !== "object") return typeof args;
  if (Array.isArray(args)) {
    return args.slice(0, 20).map((v) => argSkeleton(v));
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = `[${value.length} chars]`;
    else if (value !== null && typeof value === "object") out[key] = argSkeleton(value);
    else out[key] = value;
  }
  return out;
}

function signatureMarker(value: unknown): { present: boolean; length?: number } {
  if (typeof value !== "string") return { present: value !== undefined && value !== null };
  return { present: true, length: value.length };
}

function sanitizePart(part: unknown): unknown {
  if (part === null || typeof part !== "object") return typeof part;
  const p = part as Record<string, unknown>;
  const type = typeof p.type === "string" ? p.type : "unknown";
  switch (type) {
    case "text":
      return { type, text: textMarker(p.text) };
    case "tool-call": {
      const providerOptions = (p.providerOptions ?? {}) as Record<string, unknown>;
      const google = (providerOptions.google ?? {}) as Record<string, unknown>;
      return {
        type,
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        input: argSkeleton(p.input),
        providerExecuted: p.providerExecuted,
        thoughtSignature: signatureMarker(google.thoughtSignature),
      };
    }
    case "tool-result": {
      const providerOptions = (p.providerOptions ?? {}) as Record<string, unknown>;
      const google = (providerOptions.google ?? {}) as Record<string, unknown>;
      return {
        type,
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        output: argSkeleton(p.output),
        thoughtSignature: signatureMarker(google.thoughtSignature),
      };
    }
    case "tool-approval-request":
      return {
        type,
        approvalId: p.approvalId,
        toolCallId: (p.toolCall as { toolCallId?: unknown } | undefined)?.toolCallId,
        toolName: (p.toolCall as { toolName?: unknown } | undefined)?.toolName,
      };
    case "tool-approval-response":
      return { type, approvalId: p.approvalId, approved: p.approved };
    case "file":
    case "image":
      return { type, mediaType: (p as { mediaType?: unknown }).mediaType ?? null };
    default:
      // Thought signatures and other provider metadata: presence only.
      if (type === "reasoning") return { type, text: textMarker(p.text) };
      if ("thoughtSignature" in p) {
        return {
          type,
          thoughtSignature: signatureMarker((p as Record<string, unknown>).thoughtSignature),
        };
      }
      return { type };
  }
}

export interface SanitizedMessage {
  role: unknown;
  nParts: number;
  parts: unknown[];
}

export function sanitizeMessages(messages: unknown): SanitizedMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.slice(0, 500).map((m) => {
    if (m === null || typeof m !== "object") return { role: null, nParts: 0, parts: [] };
    const msg = m as { role?: unknown; content?: unknown };
    const content = Array.isArray(msg.content) ? msg.content : [];
    return {
      role: msg.role ?? null,
      nParts: content.length,
      parts: content.map(sanitizePart),
    };
  });
}

function schemaSkeleton(schema: unknown, depth = 0): unknown {
  if (schema === null || typeof schema !== "object" || depth > 5) {
    return typeof schema === "string" && schema.length > 200 ? "[schema string]" : schema;
  }
  if (Array.isArray(schema)) return schema.slice(0, 20).map((v) => schemaSkeleton(v, depth + 1));
  const s = schema as Record<string, unknown>;
  // JSON Schema structure is safe (no user data): keep keys + scalar types.
  if (s.type === "string" || s.type === "number" || s.type === "integer" || s.type === "boolean") {
    const keep: Record<string, unknown> = { type: s.type };
    for (const k of ["enum", "format", "minLength", "maxLength", "minimum", "maximum", "required"]) {
      if (s[k] !== undefined) keep[k] = s[k];
    }
    return keep;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(s)) {
    if (key === "description" && typeof value === "string" && value.length > 300) {
      out[key] = `${value.slice(0, 300)}…`;
      continue;
    }
    out[key] = schemaSkeleton(value, depth + 1);
  }
  return out;
}

export interface SanitizedToolDef {
  name: string;
  required?: unknown;
  parameters?: unknown;
}

export function sanitizeTools(tools: unknown): SanitizedToolDef[] {
  if (tools === null || typeof tools !== "object" || Array.isArray(tools)) return [];
  return Object.entries(tools as Record<string, unknown>).map(([name, def]) => {
    const d = (def ?? {}) as Record<string, unknown>;
    const params = (d.parameters ?? d.inputSchema ?? null) as Record<string, unknown> | null;
    let required: unknown;
    let parameters: unknown;
    if (params && typeof params === "object") {
      required = (params as { required?: unknown }).required;
      parameters = schemaSkeleton(params);
    }
    return { name, required, parameters };
  });
}

export interface SanitizedAiRequest extends LogFields {
  event: "ai_request";
  provider?: string;
  model?: string;
  nMessages?: number;
  nTools?: number;
  messages?: SanitizedMessage[];
  tools?: SanitizedToolDef[];
}

/** Build the sanitized diagnostic record for an outbound model request. */
export function sanitizeAiRequest(input: {
  provider?: string;
  model?: string;
  messages?: unknown;
  tools?: unknown;
}): SanitizedAiRequest {
  const messages = sanitizeMessages(input.messages);
  const tools = sanitizeTools(input.tools);
  return {
    event: "ai_request",
    provider: input.provider,
    model: input.model,
    nMessages: messages.length,
    nTools: tools.length,
    messages,
    tools,
  };
}

/** Debug diagnostics switch: AI_DEBUG_REQUESTS=true. Off by default. */
export function aiDebugRequestsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AI_DEBUG_REQUESTS === "true";
}
