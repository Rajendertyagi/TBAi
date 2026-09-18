import {
  RuntimeAdapterProvider,
  useAui,
  type RemoteThreadListAdapter,
} from "@assistant-ui/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createAssistantStream } from "assistant-stream";
import { createThreadHistoryAdapter } from "./threadHistoryAdapter";
import { historyConfig } from "../config/history";
import { logger } from "../lib/logger";
import { getWelcomeScopeSnapshot } from "../features/chat/state/welcomeScope";
import { getWelcomeEngineSnapshot } from "../features/chat/state/welcomeEngine";

interface ConvDTO {
  id: string;
  title: string;
  status: string;
  providerId?: string | null;
  modelId?: string | null;
  reasoningLevel?: string | null;
  workspaceMode?: "simple" | "project";
  workspaceFolderId?: string | null;
  engine?: "direct" | "opencode";
  opencodeAgent?: string | null;
  opencodeModel?: string | null;
  opencodeVariant?: string | null;
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
    /** Engine + OpenCode agent/model/variant chosen at creation (P1 unified picker). */
    engine?: "direct" | "opencode";
    opencodeAgent?: string | null;
    opencodeModel?: string | null;
    opencodeVariant?: string | null;
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
      engine: c.engine ?? "direct",
      opencodeAgent: c.opencodeAgent ?? null,
      opencodeModel: c.opencodeModel ?? null,
      opencodeVariant: c.opencodeVariant ?? null,
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
      const startMs = Date.now();
      logger.debug("opencode", "conversations.list.request", { url });
      try {
        const res = await fetch(url);
        if (!res.ok) {
          logger.debug("opencode", "conversations.list.error", {
            status: res.status,
            errorType: "upstream_http_error",
          });
          return { threads: [] };
        }
        const data = await res.json();
        const threads = (data.threads as ConvDTO[]).map(toMetadata);
        logger.debug("opencode", "conversations.list.success", {
          status: res.status,
          count: threads.length,
          elapsedMs: Date.now() - startMs,
        });
        return { threads, nextCursor: data.nextCursor };
      } catch (err) {
        logger.debug("opencode", "conversations.list.error", {
          errorType: err instanceof Error ? err.name : typeof err,
          message: err instanceof Error ? err.message : String(err),
        });
        return { threads: [] };
      }
    },

    async initialize() {
      let workspaceMode: "simple" | "project" = "simple";
      let workspaceFolderId: string | null = null;
      let engine = "direct";
      let opencodeAgent: string | null = null;
      let opencodeModel: string | null = null;
      let opencodeVariant: string | null = null;
      try {
        const scope = getWelcomeScopeSnapshot();
        if (scope.mode === "project" && scope.folderId) {
          workspaceMode = "project";
          workspaceFolderId = scope.folderId;
        }
        const draft = getWelcomeEngineSnapshot();
        engine = draft.engine;
        if (draft.engine === "opencode") {
          opencodeAgent = draft.agent || null;
          opencodeModel = draft.model || null;
          opencodeVariant = draft.variant || null;
        }
      } catch {
        /* welcome scope/engine unavailable — fall back to a disposable direct chat */
      }
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "New Conversation",
          workspaceMode,
          workspaceFolderId,
          engine,
          opencodeAgent,
          opencodeModel,
          opencodeVariant,
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
              engine,
              opencodeAgent,
              opencodeModel,
              opencodeVariant,
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
    // Best-effort by contract: every send re-transmits the effective config in
    // the request body, so a dropped PATCH self-heals on the next message.
    // Failures are logged, never thrown (the composer pick must not break).
    async updateCustom(remoteId: string, custom: Record<string, unknown>) {
      try {
        const res = await fetch(`/api/conversations/${remoteId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerId: custom.providerId ?? undefined,
            modelId: custom.modelId ?? undefined,
            reasoningLevel: custom.reasoningLevel ?? undefined,
          }),
        });
        if (!res.ok) {
          logger.debug("chat", "config_sync_failed", {
            threadId: remoteId,
            status: res.status,
          });
        }
      } catch (err) {
        logger.debug("chat", "config_sync_failed", {
          threadId: remoteId,
          errorType: err instanceof Error ? err.name : typeof err,
        });
      }
    },

    // Destructive mutations MUST reject when the server rejects: the runtime
    // applies them optimistically and only rolls the row back when the adapter
    // throws. Resolving on failure would commit a lie to local state.
    async rename(remoteId, newTitle) {
      const res = await fetch(`/api/conversations/${remoteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle }),
      });
      if (!res.ok) {
        throw new Error(`Failed to rename conversation (${res.status})`);
      }
    },

    async archive(remoteId) {
      const res = await fetch(`/api/conversations/${remoteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "archived" }),
      });
      if (!res.ok) {
        throw new Error(`Failed to archive conversation (${res.status})`);
      }
    },

    async unarchive(remoteId) {
      const res = await fetch(`/api/conversations/${remoteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "regular" }),
      });
      if (!res.ok) {
        throw new Error(`Failed to unarchive conversation (${res.status})`);
      }
    },

    async delete(remoteId) {
      const res = await fetch(`/api/conversations/${remoteId}`, {
        method: "DELETE",
      });
      // Idempotent by HTTP semantics: 404 means already gone (e.g. the
      // deletion coordinator ran first) — the desired end state holds, so
      // resolve. Any other non-2xx is a real failure: throw so the runtime's
      // optimistic update rolls the row back instead of dropping it locally
      // while the server row survives.
      if (!res.ok && res.status !== 404) {
        throw new Error(`Failed to delete conversation (${res.status})`);
      }
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
 * Row engine from thread metadata. The conversation row is authoritative:
 * unknown or absent engine reads as Direct (legacy conversations predate
 * the engine column). Single home for row→engine reads so surfaces never
 * re-derive it ad hoc.
 */
export function threadEngine(meta: {
  custom?: { engine?: unknown } | undefined;
}): "direct" | "opencode" {
  return meta.custom?.engine === "opencode" ? "opencode" : "direct";
}

/**
 * Explicit conversation creation with workspace mode/folder. Used by "New Project
 * Chat" (mode='project' + folderId) and any flow that needs a conversation
 * before the runtime's automatic `initialize()` would. The folder ID is the
 * canonical project identity; the path is resolved server-side.
 */
export async function createConversation(input: {  workspaceMode?: "simple" | "project";
  workspaceFolderId?: string | null;
  engine?: "direct" | "opencode";
  opencodeAgent?: string | null;
  opencodeModel?: string | null;
  opencodeVariant?: string | null;
  title?: string;
}): Promise<{ id: string }> {
  const res = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: input.title ?? "New Conversation",
      workspaceMode: input.workspaceMode ?? "simple",
      workspaceFolderId: input.workspaceFolderId ?? null,
      engine: input.engine ?? "direct",
      opencodeAgent: input.opencodeAgent ?? null,
      opencodeModel: input.opencodeModel ?? null,
      opencodeVariant: input.opencodeVariant ?? null,
    }),
  });
  if (!res.ok) throw new Error("Failed to create conversation");
  return res.json();
}

/**
 * Partial conversation update (PATCH). The row is authoritative: callers
 * changing engine/scope must await success before navigating, so the route
 * never disagrees with the row.
 */
export async function updateConversation(
  id: string,
  patch: {
    engine?: "direct" | "opencode";
    workspaceMode?: "simple" | "project";
    workspaceFolderId?: string | null;
    title?: string;
  },
): Promise<void> {
  const res = await fetch(`/api/conversations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update conversation");
}
