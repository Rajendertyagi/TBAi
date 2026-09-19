import type { ThreadHistoryAdapter, ExportedMessageRepositoryItem } from "@assistant-ui/react";
import { peekMaterializedEngine } from "../features/chat/state/materializeDraft";

/**
 * Last-good history projection per conversation (Phase 3.5: stale-state
 * retention). A failed load() returns the previous successful messages
 * instead of empty so an outage renders stale messages rather than a blank
 * thread. Only a CONFIRMED server response replaces the entry. Bounded and
 * cleared by invalidateHistoryCache() during coordinated recovery so the
 * next load is authoritative. Message content only — never credentials.
 */
type BaseHistoryMessage = { message: any; parentId: string | null };
const lastGoodHistory = new Map<string, unknown[]>();
const HISTORY_CACHE_LIMIT = 20;

function rememberHistory(remoteId: string, messages: unknown[]): void {
  if (lastGoodHistory.size >= HISTORY_CACHE_LIMIT && !lastGoodHistory.has(remoteId)) {
    const oldest = lastGoodHistory.keys().next().value;
    if (oldest !== undefined) lastGoodHistory.delete(oldest);
  }
  lastGoodHistory.set(remoteId, messages);
}

function retainedHistory<T>(remoteId: string): T[] {
  return (lastGoodHistory.get(remoteId) ?? []) as T[];
}

/** Drop retained history projections (recovery forces fresh reads). */
export function invalidateHistoryCache(remoteId?: string): void {
  if (remoteId) lastGoodHistory.delete(remoteId);
  else lastGoodHistory.clear();
}

/**
 * HTTP-backed ThreadHistoryAdapter for assistant-ui's RemoteThreadListRuntime.
 *
 * The AI SDK runtime (`useChatRuntime`) requires the adapter to expose
 * `withFormat(formatAdapter)`. The runtime passes its `storageFormatAdapter`
 * which knows how to encode/decode between the runtime's in-memory message type
 * and an opaque storage format. We persist exactly what the format adapter
 * produces (`{ id, parent_id, format, content }`) and hand it back verbatim on
 * load — we never interpret the message internals.
 *
 * The base `load`/`append`/`update`/`delete` methods (without a format adapter)
 * are kept for type-completeness; the runtime only ever uses the `withFormat`
 * result, so all real persistence flows through it.
 */
export function createThreadHistoryAdapter(
  getAui: () => { threadListItem: { getState: () => { remoteId?: string }; initialize: () => Promise<{ remoteId: string }> } }
): ThreadHistoryAdapter {
  const getRemoteId = (): string | null => {
    try {
      const aui = getAui();
      return (aui?.threadListItem?.getState?.()?.remoteId as string | undefined) ?? null;
    } catch {
      return null;
    }
  };

  const ensureRemoteId = async (): Promise<string> => {
    const aui = getAui();
    const { remoteId } = await aui.threadListItem.initialize();
    return remoteId;
  };

  const appendStored = async (entry: {
    id: string;
    parent_id: string | null;
    format: string;
    content: unknown;
  }) => {
    const remoteId = await ensureRemoteId();
    // Phase 4: opencode rows are session-history owned (OpenCode server is
    // the authority; the runtime projects it). The SQLite adapter must never
    // store their messages — the first prompt lives in the session. Skip
    // silently: the write is redirected to its correct authority, not lost.
    if (peekMaterializedEngine(remoteId) === "opencode") return;
    // Phase 3.11: the write is only successful when the server confirms it.
    // A failed persist throws so the runtime surfaces the failure instead of
    // diverging silently from SQLite.
    const res = await fetch(`/api/conversations/${remoteId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: entry }),
    });
    if (!res.ok) {
      throw new Error(`Failed to persist message (${res.status})`);
    }
  };

  const baseAdapter: ThreadHistoryAdapter = {
    async load() {
      const remoteId = getRemoteId();
      if (!remoteId) return { messages: [] };
      try {
        const res = await fetch(`/api/conversations/${remoteId}/messages`);
        // Non-ok carries no authoritative history: retain the previous
        // projection. A confirmed ok (even []) replaces the cache — "could
        // not be reached" never becomes "no messages".
        if (!res.ok) return { headId: null, messages: retainedHistory<BaseHistoryMessage>(remoteId) };
        const data = (await res.json()) as { messages: Array<{ content: unknown; parent_id: string | null }> };
        const messages: BaseHistoryMessage[] = (data.messages ?? []).map((m) => ({
          message: m.content as any,
          parentId: m.parent_id ?? null,
        }));
        rememberHistory(remoteId, messages);
        return {
          headId: null,
          messages,
        };
      } catch {
        return { headId: null, messages: retainedHistory<BaseHistoryMessage>(remoteId) };
      }
    },

    async append(item: ExportedMessageRepositoryItem) {
      await appendStored({
        id: item.message.id,
        parent_id: item.parentId ?? null,
        format: "raw",
        content: item.message,
      });
    },

    async update(item: ExportedMessageRepositoryItem) {
      await this.append?.(item);
    },

    async delete(items: ExportedMessageRepositoryItem[]) {
      const remoteId = await ensureRemoteId();
      // Phase 4: opencode rows are session-history owned — nothing of theirs
      // was ever appended here, so there is nothing to delete.
      if (peekMaterializedEngine(remoteId) === "opencode") return;
      for (const it of items) {
        // Phase 3.11: deletion must be server-confirmed like appends.
        const res = await fetch(`/api/conversations/${remoteId}/messages/${it.message.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          throw new Error(`Failed to delete message (${res.status})`);
        }
      }
      invalidateHistoryCache(remoteId);
    },
  };

  return {
    ...baseAdapter,
    withFormat(formatAdapter) {
      const encode = (item: { message: any; parentId: string | null }) => ({
        id: formatAdapter.getId(item.message),
        parent_id: item.parentId ?? null,
        format: formatAdapter.format,
        content: formatAdapter.encode(item),
      });

      return {
        pin() {},

        async append(item) {
          await appendStored(encode(item));
        },

        async update(item) {
          await appendStored(encode(item));
        },

        async delete(items) {
          const remoteId = await ensureRemoteId();
          // Phase 4: opencode rows are session-history owned (see append).
          if (peekMaterializedEngine(remoteId) === "opencode") return;
          for (const it of items) {
            // Phase 3.11: deletion must be server-confirmed like appends.
            const res = await fetch(`/api/conversations/${remoteId}/messages/${formatAdapter.getId(it.message)}`, {
              method: "DELETE",
            });
            if (!res.ok) {
              throw new Error(`Failed to delete message (${res.status})`);
            }
          }
          invalidateHistoryCache(remoteId);
        },

        reportTelemetry() {},

        async load() {
          const remoteId = getRemoteId();
          if (!remoteId) return { messages: [] };
          try {
            const res = await fetch(`/api/conversations/${remoteId}/messages`);
            // Same retention rule as the base load: only a confirmed ok
            // replaces the cache; failure retains the previous projection.
        if (!res.ok) return { messages: retainedHistory(remoteId) };
            const data = (await res.json()) as {
              messages: Array<{ id: string; parent_id: string | null; format: string; content: unknown }>;
            };
            const messages = (data.messages ?? [])
              .filter((e) => e.content != null)
              .map((e) =>
                formatAdapter.decode({
                  id: e.id,
                  parent_id: e.parent_id ?? null,
                  format: e.format,
                  content: e.content as any,
                })
              );
            rememberHistory(remoteId, messages);
            return { messages };
          } catch {
            return { messages: retainedHistory(remoteId) };
          }
        },
      };
    },
  };
}
