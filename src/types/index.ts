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

export interface Conversation {
  id: string;
  title: string;
  providerId: string | null;
  modelId?: string | null;
  reasoningLevel?: string | null;
  systemPrompt?: string | null;
  status: "regular" | "archived";
  titleSource?: "auto" | "user";
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
