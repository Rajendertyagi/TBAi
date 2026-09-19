import { create } from "zustand";
import type { ProviderConfig, Memory, ReasoningLevel } from "../types";

interface SettingsState {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  // One-shot session overrides for the NEXT outgoing message only (picker).
  // These layer ON TOP of the conversation's persisted default (threadListItem
  // custom) and the global provider default. The transport consumes (clears)
  // them on send, so one pick never leaks into later messages. A null value
  // means "fall back to the conversation default / global default".
  selectedProviderId: string | null;
  selectedModelId: string | null;
  selectedReasoningLevel: ReasoningLevel | null;
  setProviders: (providers: ProviderConfig[]) => void;
  setActiveProvider: (id: string) => void;
  setSelectedModel: (id: string | null) => void;
  setSelectedReasoningLevel: (level: ReasoningLevel | null) => void;
  /** Point the next message at another provider's model (session-only). */
  selectChatTarget: (providerId: string, modelId: string) => void;
  /** Revert a one-shot pick: back to saved defaults (transport calls this). */
  revertChatTarget: () => void;
  addProvider: (provider: ProviderConfig) => void;
  updateProvider: (id: string, updates: Partial<ProviderConfig>) => void;
  removeProvider: (id: string) => void;
  loadProviders: () => Promise<void>;
}

interface MemoryState {
  memories: Memory[];
  newMemory: string;
  setNewMemory: (content: string) => void;
  loadMemories: () => Promise<void>;
  addMemory: (content: string) => Promise<void>;
  deleteMemory: (id: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  providers: [],
  activeProviderId: null,
  selectedProviderId: null,
  selectedModelId: null,
  selectedReasoningLevel: null,
  setProviders: (providers) => {
    const active = providers.find((p) => p.isActive) || providers[0];
    set({
      providers,
      activeProviderId: active?.id || null,
      selectedProviderId: null,
      selectedModelId: null,
      selectedReasoningLevel: null,
    });
  },
  setActiveProvider: (id) =>
    set({ activeProviderId: id, selectedProviderId: null, selectedModelId: null }),
  addProvider: (provider) =>
    set((state) => ({
      providers: [...state.providers, provider],
      activeProviderId: state.activeProviderId || provider.id,
    })),
  updateProvider: (id, updates) =>
    set((state) => ({
      providers: state.providers.map((p) =>
        p.id === id ? { ...p, ...updates } : p
      ),
    })),
  removeProvider: (id) =>
    set((state) => {
      const nextProviders = state.providers.filter((p) => p.id !== id);
      const nextActive =
        state.activeProviderId === id
          ? nextProviders.find((p) => p.id !== id)?.id || null
          : state.activeProviderId;
      return {
        providers: nextProviders,
        activeProviderId: nextActive,
        selectedProviderId: null,
        selectedModelId: null,
      };
    }),
  setSelectedModel: (id) => set({ selectedModelId: id }),
  setSelectedReasoningLevel: (level) => set({ selectedReasoningLevel: level }),
  selectChatTarget: (providerId, modelId) =>
    set({ selectedProviderId: providerId, selectedModelId: modelId }),
  revertChatTarget: () =>
    set({
      selectedProviderId: null,
      selectedModelId: null,
      selectedReasoningLevel: null,
    }),
  loadProviders: async () => {
    // Phase 3.5: a failed load retains the previous provider list (stale
    // rather than empty). Only a confirmed response replaces it.
    let response: Response;
    try {
      response = await fetch("/api/providers");
    } catch {
      return;
    }
    if (!response.ok) return;
    const providers = (await response.json()) as ProviderConfig[];
    useSettingsStore.getState().setProviders(providers);
  },
}));

export const useMemoryStore = create<MemoryState>((set) => ({
  memories: [],
  newMemory: "",
  setNewMemory: (content) => set({ newMemory: content }),
  loadMemories: async () => {
    const response = await fetch("/api/memories");
    const memories = (await response.json()) as Memory[];
    set({ memories });
  },
  addMemory: async (content) => {
    if (!content.trim()) return;
    const response = await fetch("/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const memory = await response.json();
    set((state) => ({
      memories: [memory, ...state.memories],
      newMemory: "",
    }));
  },
  deleteMemory: async (id) => {
    await fetch(`/api/memories/${id}`, { method: "DELETE" });
    set((state) => ({
      memories: state.memories.filter((m) => m.id !== id),
    }));
  },
}));
