import {
  MessageIdentityError,
  MessageOwnershipError,
  resolveMessageForHistorySync,
  type HistoryMessageResolutionInput,
  type HistoryResolution,
} from "../storage/messages";
import { logger } from "../../lib/logger";
import { chatStreamStore } from "../../lib/resumable";
import type { ChatStreamRunContext, SqliteResumableStreamStore } from "./sqliteResumableStore";

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
 * Scope of the obligation (ADR decision 3, 2026-09-25): persistability is decided
 * once, here, by `validateFinalMessage`, and the route stores that verdict with
 * the run. So the only thing that can be left unwritten is a run that never
 * reached this function at all — it died between the durable `completed` verdict
 * and the capture. That process-death window remains documented and unrepaired.
 * A run that *did* settle normally but whose client failed to write is not in
 * that window: its message is durable, and `historyReconciler` re-offers it here.
 */

/**
 * The store surface needed to CLOSE a history obligation whose claim is already
 * held. Narrower than the finalizer's, because boot recovery starts from a row
 * that a dead process already claimed: it must be able to finish or abandon the
 * claim, but it must never take a new one.
 */
export type HistoryPersistStore = Pick<
  SqliteResumableStreamStore,
  "getRunContext" | "completeHistoryWithVerifiedMessage" | "skipHistory"
>;

/** The full store surface this module needs; narrowed so tests can supply a fake. */
export type HistoryFinalizerStore = HistoryPersistStore &
  Pick<SqliteResumableStreamStore, "claimHistory">;

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
export type HistorySkipReason = "aborted" | "no_message" | "invalid_message" | "no_conversation";

/** What the finalizer did. `not_claimed` means another finalizer already owned it. */
export type HistoryFinalizeOutcome =
  | "written"
  /** A stored row already held this exact reply, so nothing was written. */
  | "already_persisted"
  /** A stored row existed but did not match the capture, so it was replaced. */
  | "repaired"
  | "not_claimed"
  | "skipped"
  /**
   * The stored message contradicts the obligation (identity, ownership, or
   * parent). Nothing was written and the row is left `claimed` for a later sweep,
   * so this is deliberately NOT routed through the live skip policy: closing it
   * would silently convert an unresolved reply into a permanently discarded one.
   */
  | "conflicted"
  | "failed";

/**
 * What one attempt to close a held claim actually did.
 *
 * Richer than `HistoryFinalizeOutcome` on purpose: boot recovery reports each of
 * these separately, so "nothing was recovered" is never the whole story. A lost
 * compare-and-set, a live holder, an identity conflict, and a lock timeout have
 * four different follow-ups, and the counters must not merge them.
 */
export type ClaimedHistoryOutcome =
  | { status: "matched" }
  | { status: "written" }
  | { status: "repaired" }
  /** Deliberately closed with something to write that cannot legitimately be written. */
  | { status: "abandoned"; reason: "no_conversation" | "unreadable_capture" }
  /** Someone else already marked it `done`. */
  | { status: "already_resolved" }
  /** Someone else already marked it `skipped`. */
  | { status: "already_resolved_skipped" }
  /** The row no longer exists. Never reported as a success. */
  | { status: "row_gone" }
  /** Still held by a live worker; deferred, not stolen. */
  | { status: "contended" }
  /** Identity, ownership, or parent contradicts the capture. Left unresolved. */
  | { status: "conflicted"; reason: "identity" | "parent" | "ownership" }
  /** The row state could not be read or was not a state this code can act on. */
  | { status: "state_read_failed" }
  /** The transaction failed (including lock contention). Retryable, deferred. */
  | { status: "write_failed" };

/** The logging surface used here; `logger` and `logger.child()` both satisfy it. */
type FinalizerLog = Pick<ReturnType<typeof logger.child>, "info" | "warn" | "error">;

/**
 * The message-side surface the guard's verification step needs.
 *
 * Deliberately NOT the whole `messageService`: the only call the guard is allowed
 * to make is the transactional resolve, so a fake is a one-method object and no
 * caller can reach around the transaction.
 */
export interface HistoryMessageWriter {
  /**
   * Reconcile the captured message with its stored row inside the caller's
   * transaction. Returns `matched` (nothing written), `written`, or `repaired`;
   * throws `MessageIdentityError`/`MessageOwnershipError` when the row
   * contradicts the capture and `MessageVerificationError` when the write did not
   * land as asked. Must be synchronous — see `completeHistoryWithVerifiedMessage`.
   */
  resolveMessageForHistorySync(input: HistoryMessageResolutionInput): HistoryResolution;
}

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
  messages: HistoryMessageWriter;
}

/** `HistoryFinalizerDeps` minus the claim: what `persistClaimedHistory` needs. */
export type HistoryPersistDeps = Omit<HistoryFinalizerDeps, "store"> & {
  store: HistoryPersistStore;
};

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
 *
 * Exported because persistability is decided once, at settlement, and the answer
 * is stored with the run: a later finalizer must not reach a different verdict
 * about the same message, and must never be asked to guess whether a run was
 * aborted.
 */
export function validateFinalMessage(
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
 * Recover a captured final message from its stored text.
 *
 * Returns null — never a guess — for anything that is not a JSON object carrying
 * a persistable assistant message. Structural validation is delegated to
 * `validateFinalMessage` (with `isAborted: false`, the captured fact), so a
 * recovered capture satisfies the exact same contract it was checked against at
 * settlement and cannot acquire a second, looser verdict here.
 *
 * Exported because both recovery paths — `historyReconciler` (a `pending` row) and
 * `claimedHistoryRecovery` (an abandoned `claimed` row) — read the same captured
 * text and must reach the same verdict about it.
 */
export function parseCapturedFinalMessage(json: string | null): FinalUIMessage | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  // Reuse the finalizer's own validator so a recovered capture satisfies the
  // exact same contract it was checked against at settlement. Malformed or
  // structurally invalid captures yield null and follow the existing
  // unusable-capture recovery policy.
  const { message } = validateFinalMessage(parsed as FinalUIMessage, false);
  return message;
}

/**
 * Close a history obligation whose claim is already held, and verify the message
 * in the SAME transaction.
 *
 * This is the one implementation both the live finalizer (which claimed the row
 * immediately above) and boot recovery (whose row was claimed by a process that
 * then died) run. Recovery is not a second writer with its own rules; it is the
 * same transition resumed, which is why it is not duplicated.
 *
 * The store's guard performs the `claimed -> done` transition FIRST and then calls
 * `resolveMessageForHistorySync`, so the message read, the write or repair, and the
 * `done` mark commit together or not at all. There is no window in which the
 * obligation is closed but the reply is missing, and none in which the reply is
 * written but the claim is still open.
 *
 * Never throws. Returning a typed outcome rather than a boolean is deliberate: a
 * lost compare-and-set, a live holder, an identity conflict, and a lock timeout are
 * four different facts with four different follow-ups, and collapsing them (e.g. to
 * "not recovered") is how a contention timeout gets silently retried forever or an
 * unresolved reply gets reported as closed. Counts and ids only in logs — never
 * message text.
 */
export async function closeClaimedHistory(
  deps: HistoryPersistDeps,
  input: { streamId: string; message: FinalUIMessage; parentId: string | null },
  log: FinalizerLog = logger,
): Promise<ClaimedHistoryOutcome> {
  const { streamId, message, parentId } = input;

  const completion = deps.store.completeHistoryWithVerifiedMessage(streamId, (context) =>
    deps.messages.resolveMessageForHistorySync({
      conversationId: context.conversationId,
      historyMessageId: context.historyMessageId,
      messageId: message.id,
      content: toStoredMessageContent(message),
      parentId,
      format: ASSISTANT_UI_STORAGE_FORMAT,
    }),
  );

  switch (completion.status) {
    case "committed": {
      const resolution = completion.resolution;
      if (resolution === "matched") {
        // The client (or an earlier finalizer) already persisted this message. The
        // obligation is satisfied and nothing was overwritten.
        log.info("chat", "chat_history_already_persisted", {
          streamId,
          messageId: message.id,
        });
      } else {
        log.info(
          "chat",
          resolution === "repaired" ? "chat_history_repaired" : "chat_history_finalized",
          {
            streamId,
            messageId: message.id,
            partCount: message.parts.length,
            parentId,
          },
        );
      }
      return { status: resolution };
    }

    case "guard_missed":
      // The transition matched no row. Which of the several possible worlds this
      // is decides what happens next, and the row itself is the only authority.
      return classifyGuardMiss(deps, streamId, log);

    case "failed": {
      if (completion.error instanceof MessageIdentityError) {
        log.warn("chat", "chat_history_conflicted", {
          streamId,
          messageId: message.id,
          reason: completion.error.reason,
        });
        return { status: "conflicted", reason: completion.error.reason };
      }
      if (completion.error instanceof MessageOwnershipError) {
        // A row with this id exists in ANOTHER conversation. `upsertStoredSync`
        // refused to repoint it, and the transaction rolled back.
        log.warn("chat", "chat_history_conflicted", {
          streamId,
          messageId: message.id,
          reason: "ownership",
        });
        return { status: "conflicted", reason: "ownership" };
      }
      // A genuine write failure (including lock contention, which SQLite already
      // waited `busy_timeout` for). `busy` is reported so contention is never
      // mistaken for a lost compare-and-set.
      log.error("chat", "chat_history_finalize_failed", {
        streamId,
        messageId: message.id,
        errorType:
          completion.error instanceof Error ? completion.error.name : typeof completion.error,
        busy: completion.busy,
      });
      return { status: "write_failed" };
    }
  }
}

/**
 * Classify a lost `claimed -> done` transition by reading the row again.
 *
 * The state observed here is the authority, not the boolean the transition
 * returned. Each branch reports what it actually saw, and only `skipped` is
 * reported as a successful closure:
 *
 *  - row absent — reported as `row_gone`, never as success;
 *  - `done` — another writer closed it. Under the transactional guard a `done` row
 *    has had its message verified in the same transaction, so this is a genuine
 *    `already_resolved` rather than a guess;
 *  - `skipped` — the obligation was deliberately abandoned by someone else;
 *  - `claimed` with no conversation — the established missing-conversation policy:
 *    attempt `skipHistory`, then VERIFY the observed state and report that. A
 *    failed skip is not reported as a successful closure;
 *  - `claimed` with a conversation — a live finalizer holds it. Contention is
 *    deferred to the next sweep; the claim is not stolen;
 *  - anything else, or a failed read — `state_read_failed`, never silently
 *    treated as closed.
 */
function classifyGuardMiss(
  deps: HistoryPersistDeps,
  streamId: string,
  log: FinalizerLog,
): ClaimedHistoryOutcome {
  const before = readRunContext(deps, streamId, log);
  if (before.status === "unreadable") return { status: "state_read_failed" };
  if (before.context === null) {
    log.warn("chat", "chat_history_row_gone", { streamId });
    return { status: "row_gone" };
  }
  const { context } = before;

  if (context.historyState === "done") {
    log.info("chat", "chat_history_already_resolved", { streamId });
    return { status: "already_resolved" };
  }
  if (context.historyState === "skipped") {
    log.info("chat", "chat_history_already_resolved", { streamId, observed: "skipped" });
    return { status: "already_resolved_skipped" };
  }
  if (context.historyState !== "claimed") {
    log.warn("chat", "chat_history_unexpected_state", {
      streamId,
      historyState: context.historyState,
    });
    return { status: "state_read_failed" };
  }
  if (context.conversationId === null) {
    return closeWithMissingConversation(deps, streamId, log);
  }

  // Still claimed, with a usable conversation: another worker holds it, or the
  // compare-and-set raced. Deferred, never stolen.
  log.info("chat", "chat_history_contended", { streamId });
  return { status: "contended" };
}

/**
 * The established "nothing legitimate to write" policy: abandon the obligation,
 * then read the row back and report what is actually there.
 *
 * The re-read is the point. `skipHistory` returning false, throwing, and succeeding
 * are three different things, and only an observed `skipped` state is a closure.
 * A failed skip is never reported as one.
 *
 * Exported so boot recovery can use the same verified abandon for a claim whose
 * capture is missing or unreadable, instead of a second, unverified copy.
 */
export function abandonClaimedHistory(
  deps: HistoryPersistDeps,
  streamId: string,
  reason: "no_conversation" | "unreadable_capture",
  log: FinalizerLog = logger,
): ClaimedHistoryOutcome {
  try {
    deps.store.skipHistory(streamId);
  } catch {
    /* the observed state below is the report; a throw here proves nothing */
  }
  const after = readRunContext(deps, streamId, log);
  if (after.status === "unreadable") return { status: "state_read_failed" };
  if (after.context === null) {
    log.warn("chat", "chat_history_row_gone", { streamId });
    return { status: "row_gone" };
  }
  if (after.context.historyState === "skipped") {
    log.warn("chat", "chat_history_skipped", { streamId, reason });
    return { status: "abandoned", reason };
  }
  if (after.context.historyState === "done") return { status: "already_resolved" };
  log.warn("chat", "chat_history_unexpected_state", {
    streamId,
    historyState: after.context.historyState,
  });
  return { status: "state_read_failed" };
}

/** The missing-conversation branch of `classifyGuardMiss`. */
function closeWithMissingConversation(
  deps: HistoryPersistDeps,
  streamId: string,
  log: FinalizerLog,
): ClaimedHistoryOutcome {
  return abandonClaimedHistory(deps, streamId, "no_conversation", log);
}

/** Read the run context as a result, so a throw is never mistaken for absence. */
function readRunContext(
  deps: HistoryPersistDeps,
  streamId: string,
  log: FinalizerLog,
): { status: "ok"; context: ChatStreamRunContext | null } | { status: "unreadable" } {
  try {
    return { status: "ok", context: deps.store.getRunContext(streamId) };
  } catch (error) {
    log.error("chat", "chat_history_state_read_failed", {
      streamId,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return { status: "unreadable" };
  }
}

/**
 * Live-finalizer view of `closeClaimedHistory`: the reconciler's contract counts
 * five outcomes, so the richer result is mapped here rather than reported upward.
 *
 * The live failure policy is applied to write failures only, and only after the
 * transaction has rolled back: the row is then still `claimed`, and a bare `claimed`
 * is a tombstone with no recovery, so it is marked `skipped` and the resulting state
 * is verified. A `conflicted` outcome is NOT closed — the reply is unresolved, not
 * abandoned, and closing it would silently destroy it.
 */
export async function persistClaimedHistory(
  deps: HistoryPersistDeps,
  input: { streamId: string; message: FinalUIMessage; parentId: string | null },
  log: FinalizerLog = logger,
): Promise<HistoryFinalizeOutcome> {
  const outcome = await closeClaimedHistory(deps, input, log);
  switch (outcome.status) {
    case "matched":
      return "already_persisted";
    case "written":
      return "written";
    case "repaired":
      return "repaired";
    case "already_resolved":
      return "already_persisted";
    case "already_resolved_skipped":
    case "abandoned":
      return "skipped";
    case "contended":
      return "not_claimed";
    case "conflicted":
      return "conflicted";
    case "row_gone":
    case "state_read_failed":
    case "write_failed": {
      applyLiveSkipOnFailure(deps, input.streamId, log);
      return "failed";
    }
  }
}

/**
 * The live-finalizer failure policy: close the row so the write failure cannot
 * become a tombstone, then log the state that actually resulted.
 *
 * Reading it back is what keeps "I called skipHistory" and "the row is skipped"
 * from being conflated when the row was concurrently deleted or locked.
 */
function applyLiveSkipOnFailure(
  deps: HistoryPersistDeps,
  streamId: string,
  log: FinalizerLog,
): void {
  try {
    deps.store.skipHistory(streamId);
  } catch {
    /* the re-read below is the record; a throw here is not itself the outcome */
  }
  const after = readRunContext(deps, streamId, log);
  const observed =
    after.status === "unreadable" ? "unreadable" : (after.context?.historyState ?? "absent");
  log.warn("chat", "chat_history_write_failed_closed", { streamId, observed });
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
 *
 * The post-claim work lives in `persistClaimedHistory`, so this function proves
 * only that it won the claim before delegating.
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
      return await persistClaimedHistory(
        deps,
        { streamId, message, parentId: input.parentId },
        log,
      );
    }

    deps.store.skipHistory(streamId);
    log.warn("chat", "chat_history_skipped", { streamId, reason: skipReason });
    return "skipped";
  } catch (error) {
    // A throw outside `persistClaimedHistory`: the claim or the skip itself. Never
    // leave a bare `claimed`, and never log message content.
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
  messages: { resolveMessageForHistorySync },
};
