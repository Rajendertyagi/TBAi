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
    reasoningLevel: z.enum(["off", "low", "medium", "high"]).optional(),
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
  apiProtocol: z.enum(["responses", "chat-completions"]).optional(),
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
  modelId: z.string().max(200).optional().nullable(),
  reasoningLevel: z.enum(["off", "low", "medium", "high"]).optional().nullable(),
  systemPrompt: z.string().optional(),
  // Two-mode workspace model (codeg-aligned). Simple Chat = disposable per-
  // conversation workspace; Project Chat = attached to a registered folder.
  workspaceMode: z.enum(["simple", "project"]).optional().default("simple"),
  workspaceFolderId: z.string().min(1).max(200).optional().nullable(),
}).superRefine((value, ctx) => {
  if (value.workspaceMode === "project" && !value.workspaceFolderId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "workspaceFolderId is required for project chats",
    });
  }
});

export const conversationUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  providerId: z.string().optional(),
  modelId: z.string().max(200).optional().nullable(),
  reasoningLevel: z.enum(["off", "low", "medium", "high"]).optional().nullable(),
  status: z.enum(["regular", "archived"]).optional(),
  systemPrompt: z.string().optional(),
  titleSource: z.enum(["auto", "user"]).optional(),
  workspaceMode: z.enum(["simple", "project"]).optional(),
  workspaceFolderId: z.string().min(1).max(200).optional().nullable(),
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

// One-shot outside-workspace authorization (chat approval flow). Both bodies
// name the conversation, tool, and requested path; the server resolves and
// canonicalizes everything itself — the client never supplies a resolved path.
export const outsideCheckSchema = z.object({
  conversationId: z.string().min(1).max(200),
  tool: z.string().min(1).max(64),
  path: z.string().min(1).max(4096),
});

export const outsideGrantSchema = z.object({
  conversationId: z.string().min(1).max(200),
  tool: z.string().min(1).max(64),
  path: z.string().min(1).max(4096),
});

// One-shot granted execution for ungated read tools: full args travel so the
// server can re-validate (per-tool schema) and execute exactly once inline.
// Only the read tools below are admitted; destructive tools keep the gate flow.
export const outsideRunGrantedSchema = z.object({
  conversationId: z.string().min(1).max(200),
  tool: z.enum(["read_file", "list_dir", "search_files", "file_info"]),
  args: z.unknown(),
});

// ---- Todo tool (per-conversation durable notepad) ----
export const todoActionSchema = z.enum(["add", "list", "update", "toggle", "remove", "clear"]);
export const todoFilterSchema = z.enum(["all", "active", "done"]);

export const todoSchema = z
  .object({
    action: todoActionSchema,
    id: z.string().min(1).max(200).optional(),
    text: z.string().min(1).max(2000).optional(),
    done: z.boolean().optional(),
    filter: todoFilterSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const require = (condition: unknown, message: string) => {
      if (!condition) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    };
    switch (value.action) {
      case "add":
        require(value.text, "text is required for add");
        break;
      case "update":
      case "toggle":
      case "remove":
        require(value.id, "id is required for this action");
        break;
      case "list":
      case "clear":
        break;
    }
  });

// ---- Browser tools (native agent-browser CLI, no MCP) ----
// Read/navigation operations run without approval.
export const browserReadActionSchema = z.enum(["open", "snapshot", "get", "screenshot", "extract"]);

export const browserReadSchema = z
  .object({
    action: browserReadActionSchema,
    url: z.string().min(1).max(4096).optional(),
    prompt: z.string().min(1).max(5000).optional(),
  })
  .superRefine((value, ctx) => {
    const require = (condition: unknown, message: string) => {
      if (!condition) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    };
    if (value.action === "open") require(value.url, "url is required for open");
    if (value.action === "extract") require(value.prompt, "prompt is required for extract");
  });

// Interactive operations require user approval (toolApproval gate).
export const browserActionSchema = z.enum(["click", "fill", "press", "act"]);

export const browserActionSchemaFull = z
  .object({
    action: browserActionSchema,
    ref: z.string().min(1).max(200).optional(),
    text: z.string().max(10000).optional(),
    key: z.string().min(1).max(50).optional(),
    prompt: z.string().min(1).max(5000).optional(),
  })
  .superRefine((value, ctx) => {
    const require = (condition: unknown, message: string) => {
      if (!condition) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    };
    switch (value.action) {
      case "click":
        require(value.ref, "ref is required for click");
        break;
      case "fill":
        require(value.ref, "ref is required for fill");
        require(value.text, "text is required for fill");
        break;
      case "press":
        require(value.key, "key is required for press");
        break;
      case "act":
        require(value.prompt, "prompt is required for act");
        break;
    }
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
  conversationPolicy: z.enum(["dedicated_thread", "existing_thread"]).optional(),
  conversationId: z.string().min(1).max(200).optional().nullable(),
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
export type TodoArgs = z.infer<typeof todoSchema>;
export type BrowserReadArgs = z.infer<typeof browserReadSchema>;
export type BrowserActionArgs = z.infer<typeof browserActionSchemaFull>;
export type ProviderCreate = z.infer<typeof providerCreateSchema>;
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>;
export type ConversationCreate = z.infer<typeof conversationCreateSchema>;
export type ConversationUpdate = z.infer<typeof conversationUpdateSchema>;
export type MessageUpsert = z.infer<typeof messageUpsertSchema>;

// ---- Scheduler AI tool: one native tool, action-dispatched (CLI-style) ----
// A single `scheduler` tool whose `action` selects the operation, mirroring a
// command with subcommands. Read operations use `.strict()` so stray write
// fields (e.g. `list` with `name`) are rejected rather than silently ignored.
// Conditional schedule rules (cron needs cronExpression, once needs execAt) are
// enforced at the union level because `discriminatedUnion` requires raw object
// members.
const schedulerCreateSchema = z.object({
  action: z.literal("create"),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
  enabled: z.boolean().optional(),
  scheduleType: z.enum(["once", "cron"]),
  cronExpression: z.string().min(1).max(200).optional().nullable(),
  execAt: z.number().int().positive().optional().nullable(),
  timezone: z.string().min(1).max(80),
  prompt: z.string().min(1).max(100000),
  providerId: z.string().min(1).max(200).optional(),
  modelId: z.string().min(1).max(200).optional(),
  reasoningLevel: z.enum(["off", "low", "medium", "high"]).optional().nullable(),
  workspacePath: z.string().min(1).max(4096).optional(),
  conversationPolicy: z.enum(["dedicated_thread", "existing_thread"]).optional(),
  conversationId: z.string().min(1).max(200).optional().nullable(),
  overlapPolicy: z.enum(["skip_if_running"]).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  retryDelaySeconds: z.number().int().min(0).max(3600).optional(),
  timeoutSeconds: z.number().int().min(10).max(7200).optional(),
  missedGraceSeconds: z.number().int().min(0).max(86400).optional(),
});

const schedulerListSchema = z
  .object({
    action: z.literal("list"),
    status: z.enum(["active", "paused", "failed", "all"]).optional(),
  })
  .strict();

const schedulerGetSchema = z
  .object({
    action: z.literal("get"),
    jobId: z.string().min(1).max(200),
  })
  .strict();

const schedulerUpdateSchema = z.object({
  action: z.literal("update"),
  jobId: z.string().min(1).max(200),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional().nullable(),
  enabled: z.boolean().optional(),
  scheduleType: z.enum(["once", "cron"]).optional(),
  cronExpression: z.string().min(1).max(200).optional().nullable(),
  execAt: z.number().int().positive().optional().nullable(),
  timezone: z.string().min(1).max(80).optional(),
  prompt: z.string().min(1).max(100000).optional(),
  providerId: z.string().min(1).max(200).optional(),
  modelId: z.string().min(1).max(200).optional(),
  reasoningLevel: z.enum(["off", "low", "medium", "high"]).optional().nullable(),
  workspacePath: z.string().min(1).max(4096).optional(),
  conversationPolicy: z.enum(["dedicated_thread", "existing_thread"]).optional(),
  conversationId: z.string().min(1).max(200).optional().nullable(),
  overlapPolicy: z.enum(["skip_if_running"]).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  retryDelaySeconds: z.number().int().min(0).max(3600).optional(),
  timeoutSeconds: z.number().int().min(10).max(7200).optional(),
  missedGraceSeconds: z.number().int().min(0).max(86400).optional(),
});

const schedulerDeleteSchema = z
  .object({
    action: z.literal("delete"),
    jobId: z.string().min(1).max(200),
  })
  .strict();

const schedulerRunNowSchema = z
  .object({
    action: z.literal("run_now"),
    jobId: z.string().min(1).max(200),
  })
  .strict();

export const schedulerSchema = z
  .discriminatedUnion("action", [
    schedulerCreateSchema,
    schedulerListSchema,
    schedulerGetSchema,
    schedulerUpdateSchema,
    schedulerDeleteSchema,
    schedulerRunNowSchema,
  ])
  .superRefine((value, ctx) => {
    if (value.action === "create" || value.action === "update") {
      if (value.scheduleType === "cron" && !value.cronExpression) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "cronExpression is required for cron schedules",
        });
      }
      if (value.scheduleType === "once" && !value.execAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "execAt is required for one-time schedules",
        });
      }
    }
  });

export type SchedulerArgs = z.infer<typeof schedulerSchema>;

// ---- Folders / workspace registry (codeg-aligned two-mode model) ----
// Registered project folders, their linked/allowed paths, and groups.
export const folderCreateSchema = z.object({
  // A path the user picked via the directory browser (absolute, server-scoped).
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(200).optional(),
  alias: z.string().min(1).max(200).optional().nullable(),
  color: z.string().max(40).optional(),
  groupId: z.string().min(1).max(200).optional().nullable(),
});

export const folderUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  alias: z.string().min(1).max(200).optional().nullable(),
  color: z.string().max(40).optional(),
  groupId: z.string().min(1).max(200).optional().nullable(),
  sortOrder: z.number().int().optional(),
  isOpen: z.boolean().optional(),
});

export const folderLinkCreateSchema = z.object({
  // Name of the link inside the folder root, and the absolute target path.
  name: z.string().min(1).max(200),
  targetPath: z.string().min(1).max(4096),
});

export const folderLinkUpdateSchema = z.object({
  name: z.string().min(1).max(200),
});

export const folderGroupCreateSchema = z.object({
  name: z.string().min(1).max(200),
  color: z.string().max(40).optional(),
});

export const folderGroupUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  color: z.string().max(40).optional(),
  sortOrder: z.number().int().optional(),
});

export type FolderCreate = z.infer<typeof folderCreateSchema>;
export type FolderUpdate = z.infer<typeof folderUpdateSchema>;
export type FolderLinkCreate = z.infer<typeof folderLinkCreateSchema>;
export type FolderLinkUpdate = z.infer<typeof folderLinkUpdateSchema>;
export type FolderGroupCreate = z.infer<typeof folderGroupCreateSchema>;
export type FolderGroupUpdate = z.infer<typeof folderGroupUpdateSchema>;

// Directory-browser query (server-scoped, registers arbitrary local dirs).
export const folderBrowseSchema = z.object({
  path: z.string().min(1).max(4096).optional(),
});

// ---- Quick messages (user-saved reusable snippets) ----
export const quickMessageCreateSchema = z.object({
  title: z.string().max(200).optional().nullable(),
  content: z.string().max(20000).optional().nullable(),
});

export const quickMessageUpdateSchema = z.object({
  title: z.string().max(200).optional().nullable(),
  content: z.string().max(20000).optional().nullable(),
});

export const quickMessageReorderSchema = z.object({
  ids: z.array(z.string().min(1).max(200)).max(500),
});

export type QuickMessageCreate = z.infer<typeof quickMessageCreateSchema>;
export type QuickMessageUpdate = z.infer<typeof quickMessageUpdateSchema>;
export type QuickMessageReorder = z.infer<typeof quickMessageReorderSchema>;

// ---- Runtime log settings (capture level + per-scope overrides) ----
export const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export const logLevelFilterSchema = z.enum(["off", "debug", "info", "warn", "error"]);
// Scope paths are dot-separated idents (`ai.provider`, `mcp`); an override
// matches its scope and everything below it.
export const logScopeSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "Invalid scope")
  .max(128);
export const logTargetSchema = z.object({
  scope: logScopeSchema,
  level: logLevelFilterSchema,
});
export const logFileSchema = z.object({
  enabled: z.boolean(),
  maxMb: z.number().positive().max(1024).default(5),
  keepFiles: z.number().int().min(1).max(100).default(20),
  maxTotalMb: z.number().positive().max(4096).default(100),
  retentionHours: z.number().positive().max(24 * 30).default(24),
});
export const logSettingsSchema = z.object({
  level: logLevelFilterSchema,
  targets: z.array(logTargetSchema).max(64).default([]),
  file: logFileSchema.optional(),
});
export const logRecentQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
  minLevel: logLevelSchema.optional(),
  search: z.string().max(256).optional(),
  from: z.coerce.number().int().positive().optional(),
  until: z.coerce.number().int().positive().optional(),
});
export const logFileNameSchema = z.string().regex(/^tbai\.log(\.\d+)?$/);

export type LogLevelFilter = z.infer<typeof logLevelFilterSchema>;
export type LogTarget = z.infer<typeof logTargetSchema>;
export type LogFileSettings = z.infer<typeof logFileSchema>;
export type LogSettings = z.infer<typeof logSettingsSchema>;
