import { create } from "zustand";
import { logger } from "../lib/logger";

export interface QuickMessage {
  id: string;
  title: string;
  content: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface MutationResult {
  ok: boolean;
  error?: string;
}

interface QuickMessagesState {
  messages: QuickMessage[];
  loading: boolean;
  error: string | null;
  /** Reload the list. `silent` skips the page error banner (menu refreshes). */
  load: (opts?: { silent?: boolean }) => Promise<void>;
  create: () => Promise<{ message: QuickMessage | null } & MutationResult>;
  update: (
    id: string,
    data: { title?: string; content?: string },
  ) => Promise<MutationResult>;
  remove: (id: string) => Promise<MutationResult>;
  reorder: (ids: string[]) => Promise<MutationResult>;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Quick-message list state (Zustand holds UI state only; SQLite is the
 * source of truth via /api/quick-messages). Follows the foldersStore shape.
 * Mutations report `{ok, error}` so callers can toast the server message;
 * only `load()` drives the page-level error banner.
 */
export const useQuickMessagesStore = create<QuickMessagesState>((set, get) => ({
  messages: [],
  loading: false,
  error: null,

  load: async (opts) => {
    set({ loading: true, error: opts?.silent ? get().error : null });
    try {
      const messages = await api<QuickMessage[]>("/api/quick-messages");
      set({ messages });
    } catch (e) {
      const message = toMessage(e);
      logger.warn("quick-messages.ui", "load_failed", { message });
      if (!opts?.silent) set({ error: message });
    } finally {
      set({ loading: false });
    }
  },

  create: async () => {
    try {
      const message = await api<QuickMessage>("/api/quick-messages", {
        method: "POST",
        body: JSON.stringify({ title: "", content: "" }),
      });
      await get().load();
      return { ok: true as const, message };
    } catch (e) {
      const message = toMessage(e);
      logger.warn("quick-messages.ui", "create_failed", { message });
      return { ok: false as const, message: null, error: message };
    }
  },

  update: async (id, data) => {
    try {
      await api(`/api/quick-messages/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
      await get().load();
      return { ok: true as const };
    } catch (e) {
      const message = toMessage(e);
      logger.warn("quick-messages.ui", "save_failed", { message });
      return { ok: false as const, error: message };
    }
  },

  remove: async (id) => {
    try {
      await api(`/api/quick-messages/${id}`, { method: "DELETE" });
      await get().load();
      return { ok: true as const };
    } catch (e) {
      const message = toMessage(e);
      logger.warn("quick-messages.ui", "delete_failed", { message });
      return { ok: false as const, error: message };
    }
  },

  reorder: async (ids) => {
    // Optimistic: reorder locally first so the list never jumps.
    // The baseline is captured synchronously so overlapping calls and
    // rollbacks each restore the exact pre-call order.
    const baseline = get().messages;
    const byId = new Map(baseline.map((m) => [m.id, m]));
    const next: QuickMessage[] = [];
    for (const id of ids) {
      const m = byId.get(id);
      if (m) next.push(m);
    }
    // Preserve any rows the id list didn't mention (defensive: never shrink).
    for (const m of baseline) {
      if (!ids.includes(m.id)) next.push(m);
    }
    set({ messages: next });
    try {
      await api("/api/quick-messages/reorder", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      return { ok: true as const };
    } catch (e) {
      const message = toMessage(e);
      logger.warn("quick-messages.ui", "reorder_failed", { message });
      set({ messages: baseline });
      return { ok: false as const, error: message };
    }
  },
}));
