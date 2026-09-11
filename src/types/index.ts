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
  systemPrompt?: string | null;
  status: "regular" | "archived";
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
