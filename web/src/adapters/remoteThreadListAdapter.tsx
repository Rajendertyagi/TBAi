import {
  RuntimeAdapterProvider,
  useAui,
  type RemoteThreadListAdapter,
} from "@assistant-ui/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createAssistantStream } from "assistant-stream";
import { createThreadHistoryAdapter } from "./threadHistoryAdapter";
import { historyConfig } from "../config/history";

interface ConvDTO {
  id: string;
  title: string;
  status: string;
  providerId?: string | null;
  modelId?: string | null;
  reasoningLevel?: string | null;
  createdAt: string;
  updatedAt: string;
}

// Structurally compatible with assistant-ui's RemoteThreadMetadata.
type ThreadMetadata = {
  remoteId: string;
  status: "regular" | "archived";
  title?: string;
  lastMessageAt?: Date;
  // Conversation-owned AI config (SQLite source of truth, projected here).
  custom?: {
    providerId?: string | null;
    modelId?: string | null;
    reasoningLevel?: string | null;
  };
};

function toMetadata(c: ConvDTO): ThreadMetadata {
  return {
    remoteId: c.id,
    status: c.status === "archived" ? "archived" : "regular",
    title: c.title,
    lastMessageAt: c.updatedAt ? new Date(c.updatedAt) : undefined,
    custom: {
      providerId: c.providerId ?? null,
      modelId: c.modelId ?? null,
      reasoningLevel: c.reasoningLevel ?? null,
    },
  };
}

export interface RemoteThreadListAdapterOptions {
  pageSize?: number;
}

// Server-side search query shared with the Sidebar. Kept outside the runtime
// (no duplicate thread state): list() reads it when fetching pages.
let threadListSearchQuery = "";

export function setThreadListSearchQuery(q: string): void {
  threadListSearchQuery = q;
}

/**
 * RemoteThreadListAdapter backed by the TBAi SQLite backend (via HTTP).
 *
 * It implements the conversation-list level operations (list / initialize /
 * rename / archive / unarchive / delete / fetch). The per-thread message
 * history is provided through `unstable_useAdapters`, which returns a
 * `ThreadHistoryAdapter` wrapped in a `RuntimeAdapterProvider` — this is the
 * exact wiring the canonical localStorage adapter uses. assistant-ui reads the
 * history adapter from the ambient runtime context, so no Zustand store is
 * involved.
 */
export function createRemoteThreadListAdapter(
  options: RemoteThreadListAdapterOptions = {}
): RemoteThreadListAdapter {
  const pageSize = options.pageSize ?? historyConfig.pageSize;

  const useAdapters = () => {
    const aui = useAui();
    const auiRef = useRef(aui);
    useEffect(() => {
      auiRef.current = aui;
    });
    const [history] = useState(() =>
      createThreadHistoryAdapter(() => auiRef.current)
    );
    return useMemo(() => ({ history }), [history]);
  };

  const Provider = ({ children }: { children?: ReactNode }) => {
    const adapters = useAdapters();
    return (
      <RuntimeAdapterProvider adapters={adapters}>
        {children}
      </RuntimeAdapterProvider>
    );
  };

  return {
    unstable_Provider: Provider,
    unstable_useAdapters: useAdapters,

    async list(params) {
      const offset = params?.after ? (parseInt(params.after, 10) || 0) : 0;
      // Return ALL threads; the runtime splits them into regular / archived by
      // each thread's `status` field. Includes server-side ?search= when set.
      const q = threadListSearchQuery.trim();
      const url =
        `/api/conversations?status=all&limit=${pageSize}&offset=${offset}` +
        (q ? `&search=${encodeURIComponent(q)}` : "");
      const res = await fetch(url);
      if (!res.ok) return { threads: [] };
      const data = await res.json();
      return {
        threads: (data.threads as ConvDTO[]).map(toMetadata),
        nextCursor: data.nextCursor,
      };
    },

    async initialize() {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New Conversation" }),
      });
      const conv = await res.json();
      return { remoteId: conv.id };
    },

    // Persists a conversation's AI config back to SQLite. Called by the runtime
    // when the user picks a model/reasoning level in the composer — the browser
    // only sends providerId/modelId/reasoningLevel, never secrets or protocol.
    async updateCustom(remoteId: string, custom: Record<string, unknown>) {
      await fetch(`/api/conversations/${remoteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: custom.providerId ?? undefined,
          modelId: custom.modelId ?? undefined,
          reasoningLevel: custom.reasoningLevel ?? undefined,
        }),
      });
    },

    async rename(remoteId, newTitle) {
      await fetch(`/api/conversations/${remoteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle }),
      });
    },

    async archive(remoteId) {
      await fetch(`/api/conversations/${remoteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "archived" }),
      });
    },

    async unarchive(remoteId) {
      await fetch(`/api/conversations/${remoteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "regular" }),
      });
    },

    async delete(remoteId) {
      await fetch(`/api/conversations/${remoteId}`, { method: "DELETE" });
    },

    async fetch(threadId) {
      const res = await fetch(`/api/conversations/${threadId}`);
      if (!res.ok) throw new Error("Thread not found");
      const conv = await res.json();
      return toMetadata(conv);
    },

    // Server auto-titles from the first user message; return a no-op stream.
    async generateTitle() {
      return createAssistantStream(() => {});
    },
  };
}
