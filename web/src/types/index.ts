export interface ModelOption {
  id: string;
  label?: string;
  provider: string;
  contextWindow?: number;
}

export interface ProviderConfig {
  id: string;
  name: string;
  type: "openai" | "anthropic" | "google" | "ollama" | "custom";
  endpoint?: string;
  model: string;
  models?: ModelOption[];
  thinking?: "off" | "low" | "medium" | "high";
  credentialConfigured?: boolean;
  isActive?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Conversation {
  id: string;
  title: string;
  providerId: string;
  systemPrompt?: string;
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

// ---- MCP (generic Model Context Protocol client) ----

export type McpTransport = "stdio" | "http" | "sse";
export type McpAuthType = "none" | "bearer" | "basic" | "oauth";
export type McpConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

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
  | "expired"
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
  conversationPolicy: "dedicated_thread";
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
  maxRetries: number;
  retryDelaySeconds: number;
  timeoutSeconds: number;
  missedGraceSeconds: number;
}
