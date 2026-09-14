import {
  RuntimeAdapterProvider,
  useAui,
  type RemoteThreadListAdapter,
} from "@assistant-ui/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createAssistantStream } from "assistant-stream";
import { createThreadHistoryAdapter } from "./threadHistoryAdapter";
import { historyConfig } from "../config/history";
import { getWelcomeScopeSnapshot } from "../features/chat/state/welcomeScope";

interface ConvDTO {
  id: string;
  title: string;
  status: string;
  providerId?: string | null;
  modelId?: string | null;
  reasoningLevel?: string | null;
  workspaceMode?: "simple" | "project";
  workspaceFolderId?: string | null;
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
    /** Two-mode workspace model (codeg-aligned). */
    workspaceMode?: "simple" | "project";
    workspaceFolderId?: string | null;
    /** Creation ISO passthrough for client-side created-sort (never a secret). */
    createdAt?: string;
  };
};

function toMetadata(c: ConvDTO): ThreadMetadata {
  return {
    remoteId: c.id,
    // Persistent status is binary (regular/archived) and passes through
    // untouched — no mapping layer. Anything else is a backend bug.
    status: c.status === "archived" ? "archived" : "regular",
    title: c.title,
    lastMessageAt: c.updatedAt ? new Date(c.updatedAt) : undefined,
    custom: {
      providerId: c.providerId ?? null,
      modelId: c.modelId ?? null,
      reasoningLevel: c.reasoningLevel ?? null,
      workspaceMode: c.workspaceMode ?? "simple",
      workspaceFolderId: c.workspaceFolderId ?? null,
      // Creation time passthrough for client-side created-sort. Kept in
      // `custom` (the adapter contract's open bag) — never a secret.
      createdAt: c.createdAt,
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

// Server-side newest-first key shared with the Sidebar's sort control.
// Same module-var pattern as the search query; list() appends it as ?order=.
let threadListSortOrder: "updated" | "created" = "updated";

export function setThreadListSortOrder(order: "updated" | "created"): void {
  threadListSortOrder = order;
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
        `/api/conversations?status=all&limit=${pageSize}&offset=${offset}&order=${threadListSortOrder}` +
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
      let workspaceMode: "simple" | "project" = "simple";
      let workspaceFolderId: string | null = null;
      try {
        const scope = getWelcomeScopeSnapshot();
        if (scope.mode === "project" && scope.folderId) {
          workspaceMode = "project";
          workspaceFolderId = scope.folderId;
        }
      } catch {
        /* welcome scope unavailable — fall back to a disposable workspace */
      }
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "New Conversation",
          workspaceMode,
          workspaceFolderId,
        }),
      });
      if (!res.ok) {
        // Edge: stale project folder rejected by validation — retry once as
        // a simple chat so the user never sits on a dead draft.
        if (workspaceMode === "project") {
          const fallback = await fetch("/api/conversations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: "New Conversation",
              workspaceMode: "simple",
              workspaceFolderId: null,
            }),
          });
          if (!fallback.ok) {
            const detail = await fallback
              .json()
              .catch(() => ({}));
            throw new Error(
              `Failed to create conversation (${fallback.status}): ${(detail as { error?: string }).error ?? "unknown error"}`,
            );
          }
          const conv = (await fallback.json()) as { id?: string };
          if (!conv.id) throw new Error("Conversation creation returned no id");
          return { remoteId: conv.id };
        }
        // Contract: never resolve with an undefined remoteId — that masks
        // the failure and turns it into a misleading downstream
        // `conversation_missing` chat error. Throw so the original backend
        // error stays visible.
        const detail = await res.json().catch(() => ({}));
        throw new Error(
          `Failed to create conversation (${res.status}): ${(detail as { error?: string }).error ?? "unknown error"}`,
        );
      }
      const conv = (await res.json()) as { id?: string };
      if (!conv.id) throw new Error("Conversation creation returned no id");
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

/**
 * Explicit conversation creation with workspace mode/folder. Used by "New Project
 * Chat" (mode='project' + folderId) and any flow that needs a conversation
 * before the runtime's automatic `initialize()` would. The folder ID is the
 * canonical project identity; the path is resolved server-side.
 */
export async function createConversation(input: {
  workspaceMode?: "simple" | "project";
  workspaceFolderId?: string | null;
  title?: string;
}): Promise<{ id: string }> {
  const res = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: input.title ?? "New Conversation",
      workspaceMode: input.workspaceMode ?? "simple",
      workspaceFolderId: input.workspaceFolderId ?? null,
    }),
  });
  if (!res.ok) throw new Error("Failed to create conversation");
  return res.json();
}
