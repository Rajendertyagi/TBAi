import type { ProviderConfig, Conversation, Message, Memory } from "../types";

// Helper to convert DB rows to our types
export function mapProviderConfig(row: any): ProviderConfig {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    endpoint: row.endpoint,
    model: row.model,
    isActive: row.is_active === 1,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function mapConversation(row: any): Conversation {
  return {
    id: row.id,
    title: row.title,
    providerId: row.provider_id,
    modelId: row.model_id ?? null,
    reasoningLevel: row.reasoning_level ?? null,
    systemPrompt: row.system_prompt,
    status: (row.status as "regular" | "archived") ?? "regular",
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function mapMessage(row: any): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: new Date(row.created_at),
  };
}

export function mapMemory(row: any): Memory {
  return {
    id: row.id,
    content: row.content,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}
