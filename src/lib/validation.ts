import { z } from "zod";

// The chat message format is owned by @assistant-ui/react + AI SDK v7
// (UIMessage with `parts`). We validate the request structure only — presence
// of a non-empty messages array and an optional providerId — and let the AI SDK
// parse the message internals via `convertToModelMessages`.
const uiMessageSchema = z
  .object({ role: z.string() })
  .passthrough();

export const modelOptionSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().max(200).optional(),
  provider: z.string().min(1).max(40),
  contextWindow: z.number().int().positive().optional(),
});

export const chatRequestSchema = z
  .object({
    providerId: z.string().optional(),
    model: z.string().optional(),
    messages: z.array(uiMessageSchema).min(1, "messages are required"),
  })
  .passthrough();

export const providerCreateSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(["openai", "anthropic", "google", "ollama", "custom"]),
  endpoint: z.string().url().optional().or(z.literal("")).nullable(),
  apiKey: z.string().max(2000).optional().nullable(),
  model: z.string().min(1).max(200),
  models: z.array(modelOptionSchema).optional(),
  thinking: z.enum(["off", "low", "medium", "high"]).optional(),
});

export const providerUpdateSchema = providerCreateSchema.partial();

// The test endpoint accepts the same shape as a create, plus an optional `id`
// to reference an already-configured provider whose stored credential should be
// reused for the connection check. `model` is optional: when omitted the route
// resolves one via discovery so a key can be validated before a model is chosen.
export const providerTestSchema = providerCreateSchema.extend({
  id: z.string().optional(),
  model: z.string().max(200).optional(),
});

// Model discovery accepts connection details (reusing a saved credential via
// `id` when no inline apiKey is supplied). The `model` field is not required
// for discovery.
export const providerDiscoverSchema = z.object({
  id: z.string().optional(),
  type: z.enum(["openai", "anthropic", "google", "ollama", "custom"]),
  endpoint: z.string().url().optional().or(z.literal("")).nullable(),
  apiKey: z.string().max(2000).optional().nullable(),
});

export type ProviderTest = z.infer<typeof providerTestSchema>;

// Conversation persistence (assistant-ui RemoteThreadListAdapter)
export const conversationCreateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  providerId: z.string().optional(),
  systemPrompt: z.string().optional(),
});

export const conversationUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  status: z.enum(["regular", "archived"]).optional(),
  systemPrompt: z.string().optional(),
});

// A persisted message entry in the runtime's storage format (produced by the
// ThreadHistoryAdapter's `withFormat` adapter). The `content` field is an opaque
// serialized object we store verbatim; we validate only the envelope.
export const storedMessageSchema = z
  .object({
    id: z.string().min(1),
    parent_id: z.string().nullable().optional(),
    format: z.string().min(1),
    content: z.any(),
  })
  .passthrough();

export const messageUpsertSchema = z.object({
  message: storedMessageSchema,
});

// Agentic tool request bodies (server-executed in the workspace sandbox)
export const toolReadSchema = z.object({
  path: z.string().min(1).max(4096),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100000).optional(),
});

export const toolWriteSchema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().max(5_000_000),
});

export const toolEditSchema = z.object({
  path: z.string().min(1).max(4096),
  oldText: z.string().min(1).max(10000),
  newText: z.string().max(10000),
  replaceAll: z.boolean().optional(),
});

export const toolBashSchema = z.object({
  command: z.string().min(1).max(10000),
  cwd: z.string().max(4096).optional(),
});

export const toolListSchema = z.object({
  path: z.string().min(1).max(4096).optional(),
});

export const toolSearchSchema = z.object({
  query: z.string().min(1).max(500),
  path: z.string().min(1).max(4096).optional(),
  maxResults: z.number().int().min(1).max(200).optional(),
});

export const toolStatSchema = z.object({
  path: z.string().min(1).max(4096),
});

export const toolDeleteSchema = z.object({
  path: z.string().min(1).max(4096),
});

export const toolKillSchema = z.object({
  pid: z.number().int().min(1),
});

export type ToolRead = z.infer<typeof toolReadSchema>;
export type ToolWrite = z.infer<typeof toolWriteSchema>;
export type ToolEdit = z.infer<typeof toolEditSchema>;
export type ToolBash = z.infer<typeof toolBashSchema>;
export type ToolList = z.infer<typeof toolListSchema>;
export type ToolSearch = z.infer<typeof toolSearchSchema>;
export type ToolStat = z.infer<typeof toolStatSchema>;
export type ToolDelete = z.infer<typeof toolDeleteSchema>;
export type ToolKill = z.infer<typeof toolKillSchema>;

// ---- MCP server configuration (generic MCP client) ----
export const mcpServerCreateSchema = z.object({
  name: z.string().min(1).max(120),
  transport: z.enum(["stdio", "http", "sse"]),
  command: z.string().min(1).max(2000).optional().nullable(),
  args: z.array(z.string().max(2000)).max(100).optional().nullable(),
  url: z.string().min(1).max(2000).optional().nullable(),
  env: z.record(z.string(), z.string()).optional().nullable(),
  headers: z.record(z.string(), z.string()).optional().nullable(),
  authType: z.enum(["none", "bearer", "basic", "oauth"]).default("none"),
  authToken: z.string().max(5000).optional().nullable(),
  roots: z.array(z.string().max(2000)).max(50).optional().nullable(),
  enabled: z.boolean().optional(),
  autoConnect: z.boolean().optional(),
  notes: z.string().max(2000).optional().nullable(),
});

// Update allows any subset; transport/name still validated when present.
export const mcpServerUpdateSchema = mcpServerCreateSchema.partial();

// Test accepts the same connection shape as create (no id required).
export const mcpServerTestSchema = mcpServerCreateSchema;

// McpServerCreate/Test describe *input* payloads (defaults like authType apply
// at parse time), so direct object literals without authType typecheck.
export type McpServerCreate = z.input<typeof mcpServerCreateSchema>;
export type McpServerUpdate = z.input<typeof mcpServerUpdateSchema>;
export type McpServerTest = z.input<typeof mcpServerTestSchema>;

// Read a resource / get a prompt from a connected server.
export const mcpResourceReadSchema = z.object({
  uri: z.string().min(1).max(4000),
});
export const mcpPromptGetSchema = z.object({
  name: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.string()).optional().nullable(),
});
export const mcpElicitResolveSchema = z.object({
  serverId: z.string().min(1),
  elicitationId: z.string().min(1),
  action: z.enum(["accept", "decline", "cancel"]),
  content: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(),
});

export type McpResourceRead = z.infer<typeof mcpResourceReadSchema>;
export type McpPromptGet = z.infer<typeof mcpPromptGetSchema>;
export type McpElicitResolve = z.infer<typeof mcpElicitResolveSchema>;

// ---- Built-in scheduler (TBAi cron) ----
export const schedulerJobCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
  enabled: z.boolean().optional(),
  scheduleType: z.enum(["once", "cron"]),
  cronExpression: z.string().min(1).max(200).optional().nullable(),
  execAt: z.number().int().positive().optional().nullable(),
  timezone: z.string().min(1).max(80),
  providerId: z.string().min(1),
  modelId: z.string().min(1).max(200),
  thinkingLevel: z.enum(["off", "low", "medium", "high"]).optional().nullable(),
  workspacePath: z.string().min(1).max(4096),
  prompt: z.string().min(1).max(100000),
  conversationPolicy: z.enum(["dedicated_thread"]).optional(),
  overlapPolicy: z.enum(["skip_if_running"]).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  retryDelaySeconds: z.number().int().min(0).max(3600).optional(),
  timeoutSeconds: z.number().int().min(10).max(7200).optional(),
  missedGraceSeconds: z.number().int().min(0).max(86400).optional(),
});

export const schedulerJobUpdateSchema = schedulerJobCreateSchema.partial();

export const schedulerPreviewSchema = z.object({
  scheduleType: z.enum(["once", "cron"]),
  cronExpression: z.string().min(1).max(200).optional().nullable(),
  execAt: z.number().int().positive().optional().nullable(),
  timezone: z.string().min(1).max(80),
  count: z.number().int().min(1).max(10).optional(),
});

export type SchedulerJobCreate = z.infer<typeof schedulerJobCreateSchema>;
export type SchedulerJobUpdate = z.infer<typeof schedulerJobUpdateSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ProviderCreate = z.infer<typeof providerCreateSchema>;
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>;
export type ConversationCreate = z.infer<typeof conversationCreateSchema>;
export type ConversationUpdate = z.infer<typeof conversationUpdateSchema>;
export type MessageUpsert = z.infer<typeof messageUpsertSchema>;
