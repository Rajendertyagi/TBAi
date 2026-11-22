import { create } from "zustand";
import type { StreamStatus } from "./streamRecovery";

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

/** Fields a publisher may merge into a conversation's activity entry. */
export type ConversationActivityPatch = Partial<Omit<ConversationActivityEntry, "updatedAt">> & {
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

/**
 * Maps the server's authoritative terminal run status to a projection execution
 * state. Returns null when there is no terminal evidence (missing or streaming
 * status), so callers never fabricate an idle/terminal state from `isRunning`.
 */
export function directExecutionFromTerminalStatus(
  terminalKind: StreamStatus["terminalKind"],
): ConversationExecution | null {
  switch (terminalKind) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "cancelled";
    default:
      return null;
  }
}

/**
 * Decides whether a terminal verdict still belongs to the current run.
 *
 * "Same generation wins, newer generation loses": a verdict fetched for the run
 * that is currently published MUST be applied even while the projection shows
 * `running` — that is the normal completion path, and blocking it leaves the
 * projection stuck at `running` forever. Only a newer run that started while the
 * status read was in flight invalidates the verdict. The check is synchronous,
 * so no await can interleave between it and the publish that follows.
 */
export function shouldPublishTerminal(
  generationAtStart: number,
  currentGeneration: number,
): boolean {
  return generationAtStart === currentGeneration;
}
