import type { ThreadHistoryAdapter, ExportedMessageRepositoryItem } from "@assistant-ui/react";
import type {
  MessageFormatAdapter,
  MessageFormatItem,
  MessageFormatRepository,
} from "@assistant-ui/react";
import { peekMaterializedEngine } from "../features/chat/state/materializeDraft";
import {
  clearAllWindowControllers,
  clearHistoryLoadFailed,
  dropWindowController,
  ensureWindowController,
  HistoryWindowTimeoutError,
  markHistoryLoadFailed,
  publishWindowUiFor,
  windowControllerFor,
  windowControllerStanding,
} from "../features/chat/history/useDirectHistoryWindow";
import type { WindowController } from "../features/chat/history/windowController";
import { apiFetch } from "../lib/platform";
import { logger } from "../lib/logger";

/**
 * A storage row as the window route returns it, before the format adapter sees it.
 */
type StoredFormatRow = {
  id: string;
  parent_id: string | null;
  format: string;
  content: unknown;
};

/**
 * Plain full-history load, used ONLY for session-history-owned conversations.
 *
 * Direct conversations never reach this: they load a bounded window through the
 * controller instead, so no thread can end up with a bounded seed overwritten by
 * a full history.
 */
async function loadFullHistory<TMessage, TStorageFormat extends Record<string, unknown>>(
  remoteId: string,
  formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>,
): Promise<MessageFormatRepository<TMessage>> {
  try {
    const res = await apiFetch(`/api/conversations/${remoteId}/messages`);
    // Only a confirmed ok replaces the cache; failure retains the last projection.
    if (!res.ok) return { messages: retainedHistory<MessageFormatItem<TMessage>>(remoteId) };
    const data = (await res.json()) as { messages: StoredFormatRow[] };
    const messages = (data.messages ?? [])
      .filter((e) => e.content != null)
      .map((e) =>
        formatAdapter.decode({
          id: e.id,
          parent_id: e.parent_id ?? null,
          format: e.format,
          content: e.content as TStorageFormat,
        }),
      );
    rememberHistory(remoteId, messages);
    return { messages };
  } catch {
    return { messages: retainedHistory<MessageFormatItem<TMessage>>(remoteId) };
  }
}

/**
 * Last-good history projection per conversation (Phase 3.5: stale-state
 * retention). Only a CONFIRMED server response replaces the entry. Bounded and
 * cleared by invalidateHistoryCache() during coordinated recovery so the next
 * load is authoritative. Message content only — never credentials.
 *
 * Scope: this retention serves the BASE (unformatted) adapter's `load()` only.
 * It deliberately does NOT serve the windowed `withFormat().load()` path, whose
 * committed window is already the retention mechanism — a conversation that
 * holds rows skips its fetch, and a conversation holding a retained projection
 * necessarily holds rows, so a fallback there could only ever return empty.
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
  // The bounded window is a retained projection too: coordinated recovery must
  // force a fresh read, so a stale window cannot outlive the cache it replaced.
  logger.info("chat", "history.cache_invalidated", {
    remoteId: remoteId ?? null,
    scope: remoteId ? "single" : "all",
  });
  if (remoteId) {
    lastGoodHistory.delete(remoteId);
    dropWindowController(remoteId);
  } else {
    lastGoodHistory.clear();
    clearAllWindowControllers();
  }
}

/**
 * The window a late or superseded load may safely report: the one the
 * conversation currently owns, never the caller's dropped controller.
 *
 * Returning the owner's rows is what makes a superseded completion harmless:
 * re-importing the same window is idempotent, whereas returning the caller's own
 * rows would overwrite newer data and returning `[]` would blank the transcript.
 */
function reportCurrentWindow<TMessage>(remoteId: string): {
  headId: string | null;
  messages: Array<{ parentId: string | null; message: TMessage }>;
} {
  const current = windowControllerFor(remoteId);
  const rows = current ? current.rows() : [];
  return {
    headId: rows.at(-1)?.id ?? null,
    messages: rows.map((row, index) => ({
      parentId: index === 0 ? null : row.parentId,
      message: row.message as never,
    })),
  };
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
  getAui: () => {
    threadListItem: {
      getState: () => { remoteId?: string };
      initialize: () => Promise<{ remoteId: string }>;
    };
  },
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
    const res = await apiFetch(`/api/conversations/${remoteId}/messages`, {
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
        const res = await apiFetch(`/api/conversations/${remoteId}/messages`);
        // Non-ok carries no authoritative history: retain the previous
        // projection. A confirmed ok (even []) replaces the cache — "could
        // not be reached" never becomes "no messages".
        if (!res.ok)
          return { headId: null, messages: retainedHistory<BaseHistoryMessage>(remoteId) };
        const data = (await res.json()) as {
          messages: Array<{ content: unknown; parent_id: string | null }>;
        };
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
        const res = await apiFetch(`/api/conversations/${remoteId}/messages/${it.message.id}`, {
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
      const encode = (item: { message: any; parentId: string | null }) => {
        // D1 enforcement: the durable compaction divider is server-owned.
        // The browser must not persist it again. Strip data-tbai-compact
        // parts from the content before encoding.
        const message = item.message;
        if (message && Array.isArray(message.parts)) {
          const filteredParts = message.parts.filter((p: any) => p?.type !== "data-tbai-compact");
          if (filteredParts.length !== message.parts.length) {
            return {
              id: formatAdapter.getId(message),
              parent_id: item.parentId ?? null,
              format: formatAdapter.format,
              content: formatAdapter.encode({
                ...item,
                message: { ...message, parts: filteredParts },
              }),
            };
          }
        }
        return {
          id: formatAdapter.getId(message),
          parent_id: item.parentId ?? null,
          format: formatAdapter.format,
          content: formatAdapter.encode(item),
        };
      };

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
            const res = await apiFetch(
              `/api/conversations/${remoteId}/messages/${formatAdapter.getId(it.message)}`,
              {
                method: "DELETE",
              },
            );
            if (!res.ok) {
              throw new Error(`Failed to delete message (${res.status})`);
            }
          }
          invalidateHistoryCache(remoteId);
        },

        reportTelemetry() {},

        /**
         * THE single history writer for a Direct conversation.
         *
         * Upstream (`useExternalHistory`) calls this once per mount, converts the
         * result through its own converter — which installs the write-back
         * binding — imports it as a branch-aware tree, resolves the selected
         * branch to a visible path, and hands it to `chatHelpers.setMessages`.
         *
         * So this returns the BOUNDED window rather than the whole conversation.
         * `parentId` stays PERSISTED for every interior row, because that is the
         * branch authority; only the window root is clipped to `null`, since its
         * real parent lies outside the window.
         */
        async load() {
          const remoteId = getRemoteId();
          if (!remoteId) return { messages: [] };

          // Phase 4: opencode conversations are session-history owned (the
          // OpenCode server is the authority and the runtime projects it). Their
          // messages are not Direct SQLite history, so they keep the plain load
          // path. One writer per engine, never two for the same thread.
          if (peekMaterializedEngine(remoteId) === "opencode") {
            return loadFullHistory(remoteId, formatAdapter);
          }

          let controller: WindowController | null = null;
          try {
            controller = ensureWindowController(remoteId, (stored) =>
              formatAdapter.decode(stored as never),
            );
            // Initial load only: a re-mount reuses the committed window rather
            // than re-walking and discarding what the user already navigated.
            // This guard is also what makes recovery safe: a conversation that
            // already holds rows skips the fetch entirely, so re-entering a
            // healthy thread costs ZERO requests.
            if (controller.rows().length === 0) {
              await controller.loadTip();
            }
            const rows = controller.rows();
            const messages = rows.map((row, index) => ({
              parentId: index === 0 ? null : row.parentId,
              message: row.message as never,
            }));

            // Currency is decided BEFORE any shared state is written. A superseded
            // controller still holds committed rows and a successful server answer,
            // so returning them here would hand the runtime an older window than
            // the one that replaced it - and whichever load settles last wins.
            if (windowControllerStanding(remoteId, controller) === "superseded") {
              logger.warn("chat", "history.load_superseded", { conversationId: remoteId });
              // Report the window that actually owns the conversation instead, so a
              // late completion cannot overwrite newer data and cannot blank the
              // transcript either.
              return reportCurrentWindow(remoteId);
            }

            // Reached only when the server answered (or genuinely answered with
            // nothing), so any previous failure is now stale.
            clearHistoryLoadFailed(remoteId);
            publishWindowUiFor(remoteId, controller);
            rememberHistory(remoteId, messages);
            return { headId: rows.at(-1)?.id ?? null, messages };
          } catch (error) {
            // Which failure this is matters twice over. A bounded request that hit
            // its deadline is not a transport error - it was abandoned rather than
            // refused, and both still settle the load so both arm recovery. But a
            // SUPERSEDED load reports neither: the conversation now belongs to a
            // different, healthy controller, and this log is what an operator reads
            // to decide whether history is broken.
            const superseded =
              controller !== null &&
              windowControllerStanding(remoteId, controller) === "superseded";
            if (superseded) {
              logger.warn("chat", "history.load_superseded", { conversationId: remoteId });
            } else if (error instanceof HistoryWindowTimeoutError) {
              logger.warn("chat", "history.load_timeout", {
                conversationId: remoteId,
                timeoutMs: error.timeoutMs,
              });
            } else {
              logger.warn("chat", "history.load_failed", {
                conversationId: remoteId,
                errorType: error instanceof Error ? error.name : typeof error,
              });
            }
            // This is the ONLY place a load is known to have failed: an empty
            // conversation never reaches here, because a zero-row slice is a
            // successful answer. Recording it here is what lets recovery tell
            // "nothing to load" apart from "the load never arrived".
            //
            // A superseded controller must not record it: the conversation has a
            // different owner now, and marking THIS load failed would drive the
            // Retry row for a thread whose replacement is healthy. The order below
            // is load-bearing - the failure flag is set before publishing, so the
            // snapshot this call builds already carries it. The publish is the GUARDED one on purpose:
            // an ORPHANED controller is not superseded, so it reaches this branch, and
            // publishing it unguarded would put UI state on screen for a controller
            // that is not registered. Guarding re-adopts it, so the failure state and
            // the controller that owns it stay consistent and Retry still resolves one.
            if (controller && !superseded) {
              markHistoryLoadFailed(remoteId);
              publishWindowUiFor(remoteId, controller);
            }
            // A superseded load must not report emptiness: the conversation owns a
            // window now, and returning [] here would blank a populated transcript.
            if (superseded) return reportCurrentWindow(remoteId);
            // Empty, not a retained projection. The retention cache and the
            // window controller are populated and dropped TOGETHER
            // (invalidateHistoryCache clears both, and dropWindowController is
            // reachable from nowhere else), and a conversation holding a
            // retained projection also holds committed rows — so the fetch above
            // would have been skipped entirely and this catch unreachable. The
            // old `retainedHistory(remoteId)` fallback could therefore only ever
            // return [], so this is behaviour-preserving.
            return { messages: [] };
          }
        },
      };
    },
  };
}
