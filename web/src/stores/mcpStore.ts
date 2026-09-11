import { create } from "zustand";
import { logger } from "../lib/logger";
import type {
  McpStatus,
  McpServerDraft,
  McpTestResult,
  McpResourceReadResult,
  McpPromptGetResult,
} from "../types";

interface McpState {
  servers: McpStatus[];
  loading: boolean;
  /** Text queued to be inserted into the chat composer (from MCP resources/prompts). */
  pendingInsert: string | null;
  loadServers: () => Promise<void>;
  createServer: (data: McpServerDraft) => Promise<McpStatus | null>;
  updateServer: (id: string, data: Partial<McpServerDraft>) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  connect: (id: string) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
  refresh: (id: string) => Promise<void>;
  test: (data: McpServerDraft) => Promise<McpTestResult>;
  readResource: (id: string, uri: string) => Promise<McpResourceReadResult>;
  getPrompt: (id: string, name: string, args?: Record<string, string>) => Promise<McpPromptGetResult>;
  setPendingInsert: (text: string) => void;
  clearPendingInsert: () => void;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; requestId?: string };
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    // Correlate with the server record: "Error reference req_123".
    (err as Error & { requestId?: string }).requestId = data.requestId;
    logger.warn("mcp.ui", "api_failed", {
      message: `${init?.method ?? "GET"} ${path} → ${res.status}`,
      requestId: data.requestId,
    });
    throw err;
  }
  return data as T;
}

export const useMcpStore = create<McpState>((set) => ({
  servers: [],
  loading: false,
  pendingInsert: null,
  loadServers: async () => {
    set({ loading: true });
    try {
      const servers = await api<McpStatus[]>("/api/mcp/servers");
      set({ servers });
    } finally {
      set({ loading: false });
    }
  },
  createServer: async (data) => {
    const created = await api<McpStatus>("/api/mcp/servers", {
      method: "POST",
      body: JSON.stringify(data),
    });
    await useMcpStore.getState().loadServers();
    return created;
  },
  updateServer: async (id, data) => {
    await api(`/api/mcp/servers/${id}`, { method: "PUT", body: JSON.stringify(data) });
    await useMcpStore.getState().loadServers();
  },
  deleteServer: async (id) => {
    await api(`/api/mcp/servers/${id}`, { method: "DELETE" });
    await useMcpStore.getState().loadServers();
  },
  setEnabled: async (id, enabled) => {
    await api(`/api/mcp/servers/${id}/enable`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    });
    await useMcpStore.getState().loadServers();
  },
  connect: async (id) => {
    await api(`/api/mcp/servers/${id}/connect`, { method: "POST" });
    await useMcpStore.getState().loadServers();
  },
  disconnect: async (id) => {
    await api(`/api/mcp/servers/${id}/disconnect`, { method: "POST" });
    await useMcpStore.getState().loadServers();
  },
  refresh: async (id) => {
    await api(`/api/mcp/servers/${id}/refresh`, { method: "POST" });
    await useMcpStore.getState().loadServers();
  },
  test: async (data) => {
    return api<McpTestResult>("/api/mcp/servers/test", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  readResource: (id, uri) =>
    api<McpResourceReadResult>(`/api/mcp/servers/${id}/resource/read`, {
      method: "POST",
      body: JSON.stringify({ uri }),
    }),
  getPrompt: (id, name, args) =>
    api<McpPromptGetResult>(`/api/mcp/servers/${id}/prompt/get`, {
      method: "POST",
      body: JSON.stringify({ name, arguments: args }),
    }),
  setPendingInsert: (text) => set({ pendingInsert: text }),
  clearPendingInsert: () => set({ pendingInsert: null }),
}));
