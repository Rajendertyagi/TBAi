/**
 * Pure durable classifier for managed OpenCode restart recovery.
 *
 * Given the newest-first history scan (reconstructed into chronological order),
 * the typed pending inbox, and a flag for whether the scan was truncated, it
 * returns one conservative recovery action. No I/O, no clock, no randomness —
 * every branch is unit-testable. The service owns scanning, grace, and acting.
 */

import { RECOVERY_NOTICE } from "../../config/opencode-recovery";

export type RecoveryMessageType =
  | "user"
  | "synthetic"
  | "assistant"
  | "idle"
  | "compaction"
  | "other";

/** One projected message, reduced to the fields the decision table reads. */
export interface TimelineMessage {
  readonly id: string;
  readonly type: RecoveryMessageType;
  readonly timeCreated: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** assistant: `time.completed` present. */
  readonly completed?: boolean;
  /** assistant: a publicly visible continuation marker, if any. */
  readonly needsContinuation?: boolean;
  /** compaction: `status` value. */
  readonly compactionStatus?: string;
  /** synthetic: top-level text/description (preserved on same-ID re-post). */
  readonly text?: string;
  readonly description?: string;
}

/** One pending inbox item, reduced to the fields the decision table reads. */
export interface InboxEntry {
  readonly id: string;
  readonly type: "user" | "synthetic" | "compaction" | "move";
  readonly delivery: "steer" | "queue";
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly timeCreated: number;
}

/**
 * Durable session-projection presence flags from `session.get`. These are
 * presence checks (is the marker set?), NOT timestamp comparisons — shutdown
 * is never inferred from `busy > idle`.
 */
export interface SessionSignal {
  readonly busy: boolean;
  readonly idle: boolean;
}

/** Shared marker on actionable results: an execution was started but never completed. */
interface ShutdownInterruption {
  /**
   * True when a durable execution start exists with no durable completion
   * (`busy` present, `idle` absent). This is a presence-based signal, not a
   * timestamp comparison, and it is the only condition that justifies the
   * longer shutdown-interruption grace.
   */
  readonly shutdownInterruption: boolean;
}

export type RecoveryAction =
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "indeterminate"; readonly reason: string }
  | ({
      readonly kind: "resubmit-user";
      readonly id: string;
      readonly delivery: "steer" | "queue";
    } & ShutdownInterruption)
  | ({
      readonly kind: "repost-synthetic";
      /** Present when reusing an existing synthetic id; absent means mint a new one. */
      readonly id?: string;
      readonly reuseFromHistory: boolean;
      readonly native: boolean;
      readonly text?: string;
      readonly description?: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    } & ShutdownInterruption)
  | ({
      readonly kind: "cancel-and-resubmit-user";
      readonly cancelId: string;
      readonly userId: string;
      readonly delivery: "steer" | "queue";
    } & ShutdownInterruption);

export interface ClassifyInput {
  /** Projected messages in chronological order (oldest first). */
  readonly messages: readonly TimelineMessage[];
  /** Pending inbox items in enqueue order. */
  readonly inbox: readonly InboxEntry[];
  /** True when the history scan hit its budget before the boundary was proven. */
  readonly truncated: boolean;
  /** Optional durable session-projection presence flags. */
  readonly sessionSignal?: SessionSignal;
}

/** Presence-based shutdown-interruption signal; never a timestamp comparison. */
function isShutdownInterruption(signal: SessionSignal | undefined): boolean {
  return signal?.busy === true && signal?.idle === false;
}

function isRecoverySynthetic(item: {
  readonly metadata?: Readonly<Record<string, unknown>>;
}): boolean {
  return item.metadata?.notice === RECOVERY_NOTICE;
}

function lastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i]!)) return i;
  }
  return -1;
}

/**
 * Ordering of a user item vs a synthetic item from a single inbox snapshot.
 *
 * OpenCode promotes all `steer` items before the single earliest `queue` item;
 * within a mode, enqueue order applies. Control items and compaction reordering
 * make the order race-dependent → `"ambiguous"`. Only `"synthetic-first"` is
 * deterministic enough to prefer the synthetic; every other case uses the
 * conservative user-wins fallback. This never claims a global total order.
 */
function comparePromotion(
  user: InboxEntry,
  synthetic: InboxEntry,
  inbox: readonly InboxEntry[],
): "user-first" | "synthetic-first" | "ambiguous" {
  // A control item anywhere in the steer set can reorder/barrier promotion.
  if (
    inbox.some(
      (item) => item.delivery === "steer" && (item.type === "compaction" || item.type === "move"),
    )
  ) {
    return "ambiguous";
  }
  if (user.delivery !== synthetic.delivery) {
    return user.delivery === "steer" ? "user-first" : "synthetic-first";
  }
  // Same mode: enqueue order is the array order. Later enqueue = promoted later
  // = newer intent.
  return inbox.indexOf(user) > inbox.indexOf(synthetic) ? "user-first" : "synthetic-first";
}

/** True only when the synthetic is deterministically promoted before the user. */
function syntheticWins(
  user: InboxEntry,
  synthetic: InboxEntry,
  inbox: readonly InboxEntry[],
): boolean {
  return comparePromotion(user, synthetic, inbox) === "synthetic-first";
}

/**
 * Classify one session's durable state into a single recovery action.
 */
export function classifyRecovery(input: ClassifyInput): RecoveryAction {
  if (input.truncated) {
    return { kind: "indeterminate", reason: "history_scan_truncated" };
  }

  const { messages, inbox } = input;
  const shutdownInterruption = isShutdownInterruption(input.sessionSignal);
  const pendingUser = inbox.find((i) => i.type === "user");
  const pendingRecoverySyn = inbox.find((i) => i.type === "synthetic" && isRecoverySynthetic(i));
  const pendingNativeSyn = inbox.find((i) => i.type === "synthetic" && !isRecoverySynthetic(i));
  const pendingSynthetic = pendingRecoverySyn ?? pendingNativeSyn;

  const lastIdle = lastIndex(messages, (m) => m.type === "idle");
  const window = lastIdle >= 0 ? messages.slice(lastIdle + 1) : messages;
  const lastInputIdx = lastIndex(window, (m) => m.type === "user" || m.type === "synthetic");

  // No projected input after the latest idle (or empty history): the typed
  // inbox is still authoritative. A pending user prompt must never be skipped
  // just because history has no work-bearing input after the idle boundary.
  if (lastInputIdx < 0) {
    if (pendingUser) {
      // A pending synthetic that is deterministically promoted before the user
      // is the newer intent; otherwise user-wins and the synthetic is cancelled
      // (only if it is still pending — never a projected one).
      if (pendingSynthetic && syntheticWins(pendingUser, pendingSynthetic, inbox)) {
        return {
          kind: "repost-synthetic",
          id: pendingSynthetic.id,
          reuseFromHistory: false,
          native: pendingSynthetic === pendingNativeSyn,
          metadata: pendingSynthetic.metadata,
          shutdownInterruption,
        };
      }
      return pendingSynthetic
        ? {
            kind: "cancel-and-resubmit-user",
            cancelId: pendingSynthetic.id,
            userId: pendingUser.id,
            delivery: pendingUser.delivery,
            shutdownInterruption,
          }
        : {
            kind: "resubmit-user",
            id: pendingUser.id,
            delivery: pendingUser.delivery,
            shutdownInterruption,
          };
    }
    if (pendingSynthetic) {
      return {
        kind: "repost-synthetic",
        id: pendingSynthetic.id,
        reuseFromHistory: false,
        native: pendingSynthetic === pendingNativeSyn,
        metadata: pendingSynthetic.metadata,
        shutdownInterruption,
      };
    }
    return { kind: "none", reason: "no_work_bearing_input_after_idle" };
  }

  const lastInput = window[lastInputIdx]!;
  const after = window.slice(lastInputIdx + 1);

  // Defensive: an idle after the "latest" input means the window cut was wrong.
  if (after.some((m) => m.type === "idle")) {
    return { kind: "none", reason: "idle_after_latest_input" };
  }

  const hasIncompleteAssistant = after.some((m) => m.type === "assistant" && m.completed !== true);
  const hasCompletedAssistant = after.some((m) => m.type === "assistant" && m.completed === true);
  const hasContinuationEvidence = after.some(
    (m) => m.type === "synthetic" || (m.type === "assistant" && m.needsContinuation === true),
  );

  if (lastInput.type === "user") {
    // A pending user with the same id is re-submitted by id (no duplicate).
    if (pendingUser && pendingUser.id === lastInput.id) {
      if (pendingSynthetic && !syntheticWins(pendingUser, pendingSynthetic, inbox)) {
        return {
          kind: "cancel-and-resubmit-user",
          cancelId: pendingSynthetic.id,
          userId: pendingUser.id,
          delivery: pendingUser.delivery,
          shutdownInterruption,
        };
      }
      return {
        kind: "resubmit-user",
        id: pendingUser.id,
        delivery: pendingUser.delivery,
        shutdownInterruption,
      };
    }

    // A pending user with a DIFFERENT id is newer intent than the projected
    // user (it is still in the inbox, so it has not been delivered yet).
    // Conservative rule: re-submit THAT user by its own id and delivery mode —
    // never wake the older projected request, and never borrow the new user's
    // delivery mode for the old id.
    if (pendingUser && pendingUser.id !== lastInput.id) {
      if (pendingSynthetic && !syntheticWins(pendingUser, pendingSynthetic, inbox)) {
        return {
          kind: "cancel-and-resubmit-user",
          cancelId: pendingSynthetic.id,
          userId: pendingUser.id,
          delivery: pendingUser.delivery,
          shutdownInterruption,
        };
      }
      return {
        kind: "resubmit-user",
        id: pendingUser.id,
        delivery: pendingUser.delivery,
        shutdownInterruption,
      };
    }

    // A pending synthetic with a newer projected user: conservative user-wins.
    if (pendingSynthetic) {
      return {
        kind: "cancel-and-resubmit-user",
        cancelId: pendingSynthetic.id,
        userId: lastInput.id,
        delivery: pendingUser?.delivery ?? "steer",
        shutdownInterruption,
      };
    }

    // Incomplete assistant after the user: current turn unfinished → synthetic.
    if (hasIncompleteAssistant || hasContinuationEvidence) {
      return {
        kind: "repost-synthetic",
        reuseFromHistory: true,
        native: false,
        shutdownInterruption,
      };
    }

    // Completed assistant with no idle and no stronger evidence: ambiguous.
    if (hasCompletedAssistant) {
      return { kind: "indeterminate", reason: "completed_assistant_no_idle" };
    }

    // No assistant after the user: crash before assistant creation. No pending
    // user exists here (same-id and different-id cases were handled above), so
    // the projected user's own delivery defaults to steer.
    return {
      kind: "resubmit-user",
      id: lastInput.id,
      delivery: "steer",
      shutdownInterruption,
    };
  }

  // lastInput is a PROJECTED synthetic (TBAi recovery or native continuation).
  // A projected synthetic can never be cancelled through inbox.cancel. If a
  // pending user is newer or unorderable relative to it, user-wins: re-submit
  // the user by id and do NOT repost the synthetic (never bypass pending input).
  const native = !isRecoverySynthetic(lastInput);
  if (pendingUser) {
    const pendingSynIsProjected = pendingSynthetic?.id === lastInput.id;
    const userWins =
      !pendingSynIsProjected || !syntheticWins(pendingUser, pendingSynthetic!, inbox);
    if (userWins) {
      // Only cancel a pending (inbox) synthetic — never the projected one.
      const cancelId = pendingSynIsProjected || !pendingSynthetic ? undefined : pendingSynthetic.id;
      return cancelId
        ? {
            kind: "cancel-and-resubmit-user",
            cancelId,
            userId: pendingUser.id,
            delivery: pendingUser.delivery,
            shutdownInterruption,
          }
        : {
            kind: "resubmit-user",
            id: pendingUser.id,
            delivery: pendingUser.delivery,
            shutdownInterruption,
          };
    }
  }
  return {
    kind: "repost-synthetic",
    id: lastInput.id,
    reuseFromHistory: false,
    native,
    text: lastInput.text,
    description: lastInput.description,
    metadata: lastInput.metadata,
    shutdownInterruption,
  };
}
