import { messageService } from "../storage";
import { logger } from "../../lib/logger";
import { chatStreamStore } from "../../lib/resumable";
import type { SqliteResumableStreamStore } from "./sqliteResumableStore";

/**
 * Server-side finalization of a completed Direct run whose browser never
 * persisted the final assistant message.
 *
 * Why this exists: the connected client persists through the assistant-ui
 * `ThreadHistoryAdapter` (`web/src/adapters/threadHistoryAdapter.ts`), which is
 * still the normal path and is NOT reimplemented here. But a run that completes
 * after the browser detached has nobody to write the reply, and the bytes alone
 * are not history. This is the durable fallback, and it converges with the
 * browser on one row because the assistant message id is the idempotency key and
 * `upsertStored` is `ON CONFLICT(id) DO UPDATE` (design §8/§9, ADR "Direct Chat
 * durable resumable streams").
 *
 * Boundaries this module does not cross:
 *  - message persistence stays in `messageService`; this only calls it;
 *  - the byte-stream `status` stays owned by the official resumable finalization;
 *  - `terminal_kind` stays the route's verdict, and the claim below re-checks it;
 *  - no partial output is ever turned into a message.
 *
 * ADR decision 3 (2026-09-25): no structured final message is persisted and no
 * boot path reconstructs one, so a process that dies between the durable
 * `completed` verdict and this write leaves the reply in the replayable bytes
 * only. That window is documented, not repaired, in this phase.
 */

/** The store surface this module needs; narrowed so tests can supply a fake. */
export type HistoryFinalizerStore = Pick<
  SqliteResumableStreamStore,
  "getRunContext" | "claimHistory" | "completeHistory" | "skipHistory"
>;

/**
 * The `responseMessage` shape the AI SDK hands `onEnd`. Structurally compatible
 * with `ai`'s `UIMessage`, so the route passes it through with no cast.
 */
export interface FinalUIMessage {
  id: string;
  role: string;
  parts: unknown[];
  metadata?: unknown;
}

/** Why a completed run was not written to history. Never carries content. */
export type HistorySkipReason =
  | "aborted"
  | "no_message"
  | "invalid_message"
  | "no_conversation";

/** What the finalizer did. `not_claimed` means another finalizer already owned it. */
export type HistoryFinalizeOutcome =
  | "written"
  | "not_claimed"
  | "skipped"
  | "failed";

/** The logging surface used here; `logger` and `logger.child()` both satisfy it. */
type FinalizerLog = Pick<ReturnType<typeof logger.child>, "info" | "warn" | "error">;

export interface HistoryFinalizerInput {
  streamId: string;
  /** The exact message the AI SDK completed, or null when there is none. */
  responseMessage: FinalUIMessage | null;
  /** The AI SDK's abort flag; an aborted run is never a completed reply. */
  isAborted: boolean;
  /**
   * Parent for the reply: the previous message in the branch the run continued.
   * Null when the run opened a thread, which renders by order rather than by a
   * false parent.
   */
  parentId: string | null;
  log?: FinalizerLog;
}

export interface HistoryFinalizerDeps {
  store: HistoryFinalizerStore;
  upsertStored: typeof messageService.upsertStored;
}

/**
 * The persisted `content` for the `ai-sdk/v6` format.
 *
 * Mirrors `aiSDKV6FormatAdapter.encode` exactly: the id is hoisted into the
 * `messages.id` column and stripped from the payload. Writing it back inside
 * `content` would diverge from every row the browser has already stored, and
 * `decode` (`{ id: stored.id, ...stored.content }`) would then read the id out of
 * the payload instead of the row key.
 *
 * This is a structural copy, not a reinterpretation: whatever the AI SDK
 * produced — text, reasoning, tool calls, provider metadata — is stored verbatim.
 */
export function toStoredMessageContent(message: FinalUIMessage): unknown {
  const { id: _id, ...content } = message;
  return content;
}

/** The format string the installed assistant-ui adapter writes. */
export const ASSISTANT_UI_STORAGE_FORMAT = "ai-sdk/v6";

/**
 * A completed run is only persistable if it carries a real, complete assistant
 * message. Anything else is reported, never invented: the alternative would be
 * writing partial output as if it were the answer.
 *
 * Returns the message when it is usable, otherwise a `skipReason`. Modelled as
 * two nullable fields rather than a discriminated union so the call site reads as
 * a plain null check.
 */
function validateFinalMessage(
  responseMessage: FinalUIMessage | null,
  isAborted: boolean,
): { message: FinalUIMessage | null; skipReason: HistorySkipReason | null } {
  if (isAborted) return { message: null, skipReason: "aborted" };
  if (!responseMessage) return { message: null, skipReason: "no_message" };
  if (
    typeof responseMessage.id !== "string" ||
    responseMessage.id.length === 0 ||
    responseMessage.role !== "assistant" ||
    !Array.isArray(responseMessage.parts) ||
    responseMessage.parts.length === 0
  ) {
    return { message: null, skipReason: "invalid_message" };
  }
  return { message: responseMessage, skipReason: null };
}

/**
 * Finalize one detached completed run. Never throws: every failure resolves to a
 * typed outcome so a bookkeeping problem cannot turn a successful run into a
 * reported stream error.
 *
 * Ordering is deliberate. The durable verdict is already recorded by the caller,
 * so the claim is the single-winner gate; the message write happens next; the row
 * is marked `done` last. A failure in the middle marks the row `skipped` rather
 * than leaving a bare `claimed`, which would be a tombstone with no recovery.
 */
export async function finalizeDetachedRunHistory(
  deps: HistoryFinalizerDeps,
  input: HistoryFinalizerInput,
): Promise<HistoryFinalizeOutcome> {
  const log = input.log ?? logger;
  const { streamId } = input;

  try {
    const { message, skipReason } = validateFinalMessage(input.responseMessage, input.isAborted);
    if (message) {
      if (!deps.store.claimHistory(streamId, message.id)) {
        // Another finalizer won, or the run is not `completed`. The claim guard is
        // the authority on "may this be finalized", so this is not an error.
        return "not_claimed";
      }

      const conversationId = deps.store.getRunContext(streamId)?.conversationId ?? null;
      if (!conversationId) {
        deps.store.skipHistory(streamId);
        log.warn("chat", "chat_history_skipped", { streamId, reason: "no_conversation" });
        return "skipped";
      }

      // `upsertStored` is declared async but performs only synchronous SQLite
      // writes, so the row is durable by the time this resolves. No timers, no
      // network, no genuine async work: this runs on the response-close path.
      await deps.upsertStored(conversationId, {
        id: message.id,
        parent_id: input.parentId,
        format: ASSISTANT_UI_STORAGE_FORMAT,
        content: toStoredMessageContent(message),
      });
      deps.store.completeHistory(streamId);

      log.info("chat", "chat_history_finalized", {
        streamId,
        conversationId,
        messageId: message.id,
        partCount: message.parts.length,
        parentId: input.parentId,
      });
      return "written";
    }

    deps.store.skipHistory(streamId);
    log.warn("chat", "chat_history_skipped", { streamId, reason: skipReason });
    return "skipped";
  } catch (error) {
    // Most likely a foreign-key failure because the conversation was deleted
    // mid-run. Never leave a bare `claimed`, and never log message content.
    try {
      deps.store.skipHistory(streamId);
    } catch {
      /* the row is already gone or locked; the log line below is the record */
    }
    log.error("chat", "chat_history_finalize_failed", {
      streamId,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return "failed";
  }
}

/** Production wiring: the process singleton store and the real message service. */
export const chatHistoryFinalizerDeps: HistoryFinalizerDeps = {
  store: chatStreamStore,
  upsertStored: messageService.upsertStored,
};
