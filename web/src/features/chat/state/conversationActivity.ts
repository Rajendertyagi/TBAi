import { create } from "zustand";

/** Execution status derived from authoritative runtime/server evidence. */
export type ConversationExecution =
  | "unknown"
  | "idle"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled";

/** Transport/reconciliation health, separate from execution status. */
export type ConversationHealth = "unknown" | "ok" | "degraded";

/** Engine that owns the conversation runtime publishing this entry. */
export type ConversationEngine = "direct" | "opencode";

/** Derived UI activity for one conversation; no message content or timestamps. */
export interface ConversationActivityEntry {
  execution: ConversationExecution;
  health: ConversationHealth;
  updatedAt: number;
  engine: ConversationEngine;
}

type ConversationActivityPatch = Partial<Omit<ConversationActivityEntry, "updatedAt">> & {
  updatedAt?: number;
};

interface ConversationActivityState {
  entries: Record<string, ConversationActivityEntry>;
  /** Merge activity for a conversation; creates an entry when missing. */
  publish: (conversationId: string, patch: ConversationActivityPatch) => void;
  /** Remove activity for a conversation. */
  clear: (conversationId: string) => void;
  /** Read current activity for a conversation. */
  get: (conversationId: string) => ConversationActivityEntry | undefined;
}

const DEFAULT_ENTRY: ConversationActivityEntry = {
  execution: "unknown",
  health: "unknown",
  updatedAt: 0,
  engine: "direct",
};

export const useConversationActivityStore = create<ConversationActivityState>((set, get) => ({
  entries: {},
  publish: (conversationId, patch) => {
    set((state) => {
      const current = state.entries[conversationId] ?? DEFAULT_ENTRY;
      return {
        entries: {
          ...state.entries,
          [conversationId]: {
            ...current,
            ...patch,
            updatedAt: patch.updatedAt ?? Date.now(),
          },
        },
      };
    });
  },
  clear: (conversationId) => {
    set((state) => {
      if (!(conversationId in state.entries)) return state;
      const entries = { ...state.entries };
      delete entries[conversationId];
      return { entries };
    });
  },
  get: (conversationId) => get().entries[conversationId],
}));

/** Select execution status for a conversation from the activity projection. */
export function useConversationExecution(
  conversationId: string,
): ConversationExecution | undefined {
  return useConversationActivityStore((state) => state.entries[conversationId]?.execution);
}
