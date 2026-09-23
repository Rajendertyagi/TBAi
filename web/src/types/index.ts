export type CapabilitySupport = "supported" | "unsupported" | "unknown";

export interface ReasoningCapability {
  support: CapabilitySupport;
  levels?: string[];
}

export interface ModelCapabilities {
  reasoning: ReasoningCapability;
}

export interface ModelOption {
  id: string;
  label?: string;
  provider: string;
  contextWindow?: number;
  capabilities?: ModelCapabilities;
}

export type ApiProtocol = "responses" | "chat-completions";

/**
 * A reasoning ("thinking") level.
 *
 * `off` is a real level, not an absence: it means the provider is sent no
 * thinking option at all, so no reasoning part can ever come back. Kept as one
 * named union so the provider default, the composer picker and the scheduler
 * cannot drift into different spellings of the same four values.
 */
export type ReasoningLevel = "off" | "low" | "medium" | "high";

export interface ProviderConfig {
  id: string;
  name: string;
  type: "openai" | "anthropic" | "google" | "ollama" | "custom";
  // AI API wire protocol for OpenAI-compatible providers. Resolved server-side;
  // never sent per message. google/anthropic ignore it.
  apiProtocol?: ApiProtocol;
  endpoint?: string;
  model: string;
  models?: ModelOption[];
  thinking?: ReasoningLevel;
  credentialConfigured?: boolean;
  isActive?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type ConversationStatus = "regular" | "archived";

export interface Conversation {
  id: string;
  title: string;
  providerId: string | null;
  modelId?: string | null;
  reasoningLevel?: string | null;
  systemPrompt?: string | null;
  status: ConversationStatus;
  titleSource?: "auto" | "user";
  /** Workspace mode: 'simple' (disposable workspace) or 'project' (registered folder). */
  workspaceMode: WorkspaceMode;
  /** Registered folder ID for project chats; null for simple chats. */
  workspaceFolderId?: string | null;
  /** Engine that owns this conversation: Direct chat or OpenCode agent mode. */
  engine?: "direct" | "opencode";
  /** OpenCode agent id chosen at creation (OpenCode engine only). */
  opencodeAgent?: string | null;
  /** OpenCode model id chosen at creation (OpenCode engine only). */
  opencodeModel?: string | null;
  /** OpenCode thinking level (model variant); null = Default. */
  opencodeVariant?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: Date;
}

export interface Memory {
  id: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Workspace mode for a conversation (codeg-aligned two-mode model). */
export type WorkspaceMode = "simple" | "project";

/**
 * A registered project folder the user can attach a Project Chat to. The folder
 * ID is the canonical identity; `path` is resolved server-side. Mirrors codeg's
 * `folder` entity (subset justified by TBAi's UX).
 */
export interface Folder {
  id: string;
  name: string;
  path: string;
  alias?: string | null;
  color: string;
  groupId?: string | null;
  isOpen: boolean;
  sortOrder: number;
  kind: "regular" | "chat";
  lastOpenedAt?: number | null;
  createdAt: Date;
  updatedAt: Date;
  /** Count of conversations currently attached to this folder (UI hint). */
  conversationCount?: number;
}

/**
 * Authorization record for a linked/allowed path inside a registered folder.
 * Phase 1: record only (no real filesystem symlinks); extensible later.
 */
export interface FolderLink {
  id: string;
  folderId: string;
  name: string;
  targetPath: string;
  createdAt: Date;
  updatedAt: Date;
}

/** User-named container organising the Folders list (sidebar grouping). */
export interface FolderGroup {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

// ---- MCP (generic Model Context Protocol client) ----

export type McpTransport = "stdio" | "http" | "sse";
export type McpAuthType = "none" | "bearer" | "basic" | "oauth";
export type McpConnectionStatus = "disconnected" | "connecting" | "connected" | "error" | "auth_failed";

/**
 * Machine-readable MCP failure reason (backend-classified). The UI renders a
 * short sentence per reason above the raw error text.
 */
export type McpFailureReason =
  | "unreachable"
  | "incompatible_response"
  | "auth_required"
  | "auth_failed"
  | "timeout"
  | "protocol_error"
  | "unknown";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: unknown;
}

export interface McpElicitationField {
  name: string;
  type: string;
  title?: string;
  description?: string;
  enum?: string[];
  enumNames?: string[];
  default?: string;
}

export interface McpPendingElicitation {
  serverId: string;
  serverName: string;
  elicitationId: string;
  message: string;
  mode: "form" | "url";
  fields?: McpElicitationField[];
  url?: string;
}

export interface McpResourceReadResult {
  contents: { uri: string; mimeType?: string; text?: string; blob?: string }[];
}

export interface McpPromptGetResult {
  description?: string;
  messages: { role: "user" | "assistant"; content: { type: string; text?: string } }[];
}

export interface McpEvent {
  kind: string;
  message: string;
  at: number;
  data?: unknown;
}

export interface McpStatus {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  status: McpConnectionStatus;
  error?: string;
  failureReason?: McpFailureReason;
  serverCapabilities?: Record<string, unknown>;
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  lastConnectedAt?: number;
  lastErrorAt?: number;
  events: McpEvent[];
  // --- Connection configuration (echoed for editing; never includes secrets) ---
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  authType: McpAuthType;
  /** True when a credential is stored server-side. Presence only — never a value. */
  authConfigured?: boolean;
  /** Masked, non-secret hint (e.g. "Bearer ••••••"). */
  authHint?: string;
  autoConnect: boolean;
  notes?: string;
  roots?: string[];
  pendingElicitation?: McpPendingElicitation;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  authType: McpAuthType;
  enabled: boolean;
  autoConnect: boolean;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface McpTestResult {
  ok: boolean;
  transport: McpTransport;
  error?: string;
  failureReason?: McpFailureReason;
  serverCapabilities?: Record<string, unknown>;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
}

/** Payload accepted by the create/update endpoints (no id on create). */
export interface McpServerDraft {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  authType: McpAuthType;
  authToken?: string;
  enabled?: boolean;
  autoConnect?: boolean;
  notes?: string;
  roots?: string[];
}

// ---- Built-in scheduler (TBAi cron) ----

export type SchedulerScheduleType = "once" | "cron";
export type SchedulerJobStatus =
  | "active"
  | "paused"
  | "completed"
  | "missed"
  | "failed"
  | "cancelled";
export type SchedulerRunStatus =
  | "scheduled"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "interrupted"
  | "missed"
  | "cancelled";

export interface SchedulerJob {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  scheduleType: SchedulerScheduleType;
  cronExpression: string | null;
  execAt: number | null;
  timezone: string;
  providerId: string;
  modelId: string;
  thinkingLevel: "off" | "low" | "medium" | "high" | null;
  workspacePath: string;
  prompt: string;
  conversationPolicy: "dedicated_thread" | "existing_thread";
  conversationId: string | null;
  overlapPolicy: "skip_if_running";
  maxRetries: number;
  retryDelaySeconds: number;
  timeoutSeconds: number;
  missedGraceSeconds: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  status: SchedulerJobStatus;
  createdAt: number;
  updatedAt: number;
}

export interface SchedulerJobPublic extends Omit<SchedulerJob, "prompt"> {
  prompt?: string;
  promptPreview: string;
  promptLength: number;
}

export interface SchedulerRun {
  id: string;
  jobId: string;
  occurrenceId: string;
  requestId: string | null;
  startedAt: number;
  completedAt: number | null;
  status: SchedulerRunStatus;
  error: string | null;
  outputExcerpt: string | null;
  providerId: string;
  modelId: string;
  workspacePath: string;
  conversationId: string | null;
  attempt: number;
  durationMs: number | null;
  createdAt: number;
}

export interface SchedulerJobDraft {
  name: string;
  description: string;
  enabled: boolean;
  scheduleType: SchedulerScheduleType;
  cronExpression: string;
  execAtDate: string;
  execAtTime: string;
  timezone: string;
  providerId: string;
  modelId: string;
  thinkingLevel: "off" | "low" | "medium" | "high";
  workspacePath: string;
  prompt: string;
  conversationPolicy: "dedicated_thread" | "existing_thread";
  conversationId: string | null;
  maxRetries: number;
  retryDelaySeconds: number;
  timeoutSeconds: number;
  missedGraceSeconds: number;
}
