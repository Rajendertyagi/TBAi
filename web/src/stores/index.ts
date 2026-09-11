import { create } from "zustand";
import type { ProviderConfig, Memory } from "../types";

interface SettingsState {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  // Session chat-model choice; null means "use the provider's saved default".
  selectedModelId: string | null;
  setProviders: (providers: ProviderConfig[]) => void;
  setActiveProvider: (id: string) => void;
  setSelectedModel: (id: string | null) => void;
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
  selectedModelId: null,
  setProviders: (providers) => {
    const active = providers.find((p) => p.isActive) || providers[0];
    set({ providers, activeProviderId: active?.id || null, selectedModelId: active?.model || null });
  },
  setActiveProvider: (id) =>
    set((state) => {
      const provider = state.providers.find((p) => p.id === id);
      return { activeProviderId: id, selectedModelId: provider?.model || null };
    }),
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
      const nextProvider = nextProviders.find((p) => p.id === nextActive);
      return {
        providers: nextProviders,
        activeProviderId: nextActive,
        selectedModelId: nextProvider?.model || null,
      };
    }),
  setSelectedModel: (id) => set({ selectedModelId: id }),
  loadProviders: async () => {
    const response = await fetch("/api/providers");
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
