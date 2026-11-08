/**
 * Stored memories as UI state.
 *
 * ## Why this lives with the memories feature
 *
 * This used to be the other half of the combined `web/src/stores/index.ts`. It
 * owns exactly one concern - the memory list and its draft field - so it belongs
 * to the memories feature next to the panel that edits it.
 *
 * ## What is NOT here
 *
 * Retrieval or injection into a prompt. Whether a stored memory is ever selected
 * is a backend decision behind `TBAI_MEMORY_ENABLED`; this store only reflects
 * what the API returns.
 */
import { create } from "zustand";
import type { Memory } from "../../../types";
import { apiFetch } from "../../../lib/platform";

interface MemoryState {
  memories: Memory[];
  newMemory: string;
  setNewMemory: (content: string) => void;
  loadMemories: () => Promise<void>;
  addMemory: (content: string) => Promise<void>;
  updateMemory: (id: string, content: string) => Promise<void>;
  deleteMemory: (id: string) => Promise<void>;
}
export const useMemoryStore = create<MemoryState>((set) => ({
  memories: [],
  newMemory: "",
  setNewMemory: (content) => set({ newMemory: content }),
  loadMemories: async () => {
    const response = await apiFetch("/api/memories");
    const memories = (await response.json()) as Memory[];
    set({ memories });
  },
  addMemory: async (content) => {
    if (!content.trim()) return;
    const response = await apiFetch("/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) return;
    const memory = await response.json();
    set((state) => ({
      memories: [memory, ...state.memories],
      newMemory: "",
    }));
  },
  /**
   * Edit a memory (Phase 5, D4).
   *
   * Replaces the row from the server's response rather than patching locally: the
   * response carries the recomputed derived safety status, so a correction that
   * clears a flag is reflected immediately instead of on the next reload.
   */
  updateMemory: async (id, content) => {
    if (!content.trim()) return;
    const response = await apiFetch(`/api/memories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) return;
    const updated = await response.json();
    set((state) => ({
      memories: state.memories.map((m) => (m.id === id ? { ...m, ...updated } : m)),
    }));
  },
  deleteMemory: async (id) => {
    await apiFetch(`/api/memories/${id}`, { method: "DELETE" });
    set((state) => ({
      memories: state.memories.filter((m) => m.id !== id),
    }));
  },
}));
