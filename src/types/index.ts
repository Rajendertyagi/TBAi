/**
 * Canonical per-model capability representation (Phase 1: model capabilities
 * foundation). Describes what a model supports as reported by a truthful
 * source — never inferred from model-name patterns and never hardcoded per
 * model. Three-state semantics are load-bearing:
 * - "supported": a source explicitly reported the capability.
 * - "unsupported": a source explicitly reported its absence.
 * - "unknown": no source has reported either way. Absence of metadata is NOT
 *   evidence of absence — consumers must never collapse unknown into false.
 */
export type CapabilitySupport = "supported" | "unsupported" | "unknown";

export interface ReasoningCapability {
  support: CapabilitySupport;
  /**
   * Opaque source-provided thinking mode identifiers (count-agnostic: a model
   * may expose none, one, or many). Present only when the source supplies
   * meaningful mode ids. Never mapped to TBAi's off/low/medium/high control
   * vocabulary here — that mapping is a later UI/configuration decision.
   */
  levels?: string[];
}

export interface ModelCapabilities {
  /** Reasoning support. Required when capabilities are present: a producer
   * must take an explicit stance (supported/unsupported/unknown). */
  reasoning: ReasoningCapability;
}

export interface ModelOption {
  id: string;
  label?: string;
  provider: string;
  contextWindow?: number;
  /**
   * Derived discovery metadata. Re-derived on each discovery pass and carried
   * inside the existing provider `models` JSON column — never an independently
   * persisted source of truth. Absent on legacy models (treated as unknown).
   */
  capabilities?: ModelCapabilities;
}

export type ApiProtocol = "responses" | "chat-completions";

export interface ProviderConfig {
  id: string;
  name: string;
  type: "openai" | "anthropic" | "google" | "ollama" | "custom";
  // AI API wire protocol for OpenAI-compatible providers. "responses" targets
  // the OpenAI Responses API (POST /responses); "chat-completions" targets the
  // Chat Completions API (POST /chat/completions). Resolved server-side from the
  // provider config — never sent per message. google/anthropic ignore it.
  apiProtocol?: ApiProtocol;
  apiKey?: string;
  endpoint?: string;
  model: string;
  // User-enabled models (explicitly selected after discovery or manual entry).
  // Discovered-but-not-selected models are never persisted.
  models?: ModelOption[];
  // Reasoning/thinking budget level (off | low | medium | high).
  thinking?: "off" | "low" | "medium" | "high";
  credentialConfigured?: boolean;
  isActive?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type WorkspaceMode = "simple" | "project";

/**
 * Persistent conversation status: binary only.
 * - regular: active conversation.
 * - archived: done/hidden conversation (sidebar Archived section, excluded
 *   from scheduler targeting).
 * Runtime activity (loading/streaming) lives in assistant-ui thread state,
 * never here; job execution lives in scheduler_runs.status.
 */
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
  /** OpenCode session id bound to this conversation for Code mode; null if unused. */
  opencodeSessionId?: string | null;
  /** Engine that owns this conversation: Direct chat or OpenCode agent mode. */
  engine?: "direct" | "opencode";
  /** OpenCode agent id chosen at creation (OpenCode engine only). */
  opencodeAgent?: string | null;
  /** OpenCode model id chosen at creation (OpenCode engine only). */
  opencodeModel?: string | null;
  /** OpenCode thinking level (model variant) chosen at creation; null = Default. */
  opencodeVariant?: string | null;
  /**
   * The Auto Approval shield for this conversation (Phase 6D-B). True = accept
   * permission requests once automatically; false/absent = manual (ask).
   */
  opencodeAutoApprove?: boolean;
  /**
   * Durable idempotency key for draft materialization (Task 3). Set at creation
   * from the client's `clientRequestId`; a replayed key after a restart
   * resolves to this existing row instead of minting a duplicate.
   */
  clientRequestId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

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
  conversationCount?: number;
}

export interface FolderLink {
  id: string;
  folderId: string;
  name: string;
  targetPath: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FolderGroup {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
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

/** User-saved reusable message snippet (managed on the Quick Messages page). */
export interface QuickMessage {
  id: string;
  title: string;
  content: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}
