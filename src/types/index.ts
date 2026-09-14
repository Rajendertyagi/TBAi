export interface ModelOption {
  id: string;
  label?: string;
  provider: string;
  contextWindow?: number;
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
