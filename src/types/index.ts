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

/**
 * Who said a numeric model limit is what it is. (R1, 2026-10-01.)
 *
 * STORED provenance only. Exactly two states are storable, because exactly two
 * kinds of writer exist:
 * - `provider_reported`: a provider's own listing/API stated the number.
 * - `configured`: a human typed the number for this installation.
 *
 * `conservative_default` and `unknown` are NOT storable. They are states the
 * RESOLVER produces when no stored figure exists (see `src/context/limits.ts`);
 * storing them per-model would assert a fact about a model that no source
 * supplied. The four-state resolved vocabulary is `LimitSource`.
 *
 * This mirrors `CapabilitySupport` deliberately: a producer must take an
 * explicit stance, and absence of a stance is never a licence to assume one.
 */
export const CONTEXT_WINDOW_SOURCES = ["provider_reported", "configured"] as const;
export type ContextWindowSource = (typeof CONTEXT_WINDOW_SOURCES)[number];

/** The numeric half of a limit, always carrying the stance that produced it. */
export interface SourcedNumber {
  readonly value: number;
  readonly source: ContextWindowSource;
}

/**
 * Build a `provider_reported` limit. Used by discovery, the only writer that has
 * read a number out of a provider response.
 *
 * Exists as a function rather than an inline literal so that "a user-entered
 * value cannot be labelled `provider_reported`" is enforced by the module
 * boundary and not by discipline. A user edit goes through
 * `configuredContextWindow`, which is the only other way to set the pair.
 */
export function providerReportedLimit(value: number): SourcedNumber {
  return { value, source: "provider_reported" };
}

/**
 * Build a `configured` limit. Used by the provider dialog — the only writer that
 * originates a number rather than reading one from a provider.
 *
 * @param value A positive token count, already validated by the caller.
 */
export function configuredLimit(value: number): SourcedNumber {
  return { value, source: "configured" };
}

export interface ModelOption {
  id: string;
  label?: string;
  provider: string;
  /**
   * Maximum input tokens for this model, or absent when no source stated one.
   *
   * ⚠️ The VALUE alone carries no authority. `contextWindowSource` says who said
   * so, and the two must always be written together via `providerReportedLimit` /
   * `configuredLimit`. A value with no source is a legacy row and is resolved as
   * `configured` (see `LEGACY_SOURCE` in `src/context/limits.ts`) — never as
   * `provider_reported`, which would be a number the provider never stated.
   */
  contextWindow?: number;
  /** Provenance of `contextWindow`. Absent only on rows written before R1. */
  contextWindowSource?: ContextWindowSource;
  /**
   * Maximum output tokens for this model, or absent when no source stated one.
   * Bounds `maxOutputTokens` on the request. Separate from the input budget's
   * output reservation (see `GenerationCap` in `src/context/types.ts`).
   */
  maxOutputTokens?: number;
  /** Provenance of `maxOutputTokens`. Same rules as `contextWindowSource`. */
  maxOutputTokensSource?: ContextWindowSource;
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
  /**
   * Derived safety state (Phase 5, D3).
   *
   * Recomputed by the server on every read and never stored, so these two fields
   * are absent whenever the memory screened clean. They are reported rather than
   * computed in the browser so the panel and the model-context decision can never
   * disagree about what was withheld.
   */
  safetyFlag?: true;
  /** Which screening class fired. Stable token, not the pattern source. */
  safetyReason?: string;
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
