import type {
  FormInfo,
  ModelRef,
  PermissionRequest,
  SessionInfo,
  SessionMessageInfo,
  TokenUsageInfo,
  V2Event,
} from "@opencode/client";

export interface V2ModelSelection {
  readonly providerID: string;
  readonly modelID: string;
  readonly variant?: string;
}

export interface V2DesiredSelection {
  readonly model: V2ModelSelection | null;
  readonly agent: string | null;
}

export interface V2SafeError {
  readonly kind:
    | "aborted"
    | "incompatible-server"
    | "invalid-response"
    | "network"
    | "not-found"
    | "recovery-required"
    | "server"
    | "unknown";
  readonly message: string;
  readonly status?: number;
}

export interface V2UsageSnapshot {
  readonly cost: number;
  readonly tokens: TokenUsageInfo;
}

/**
 * A tool part's lifecycle, as the server reports it.
 *
 * Named so the projection's mapping has one place to read the vocabulary from.
 * Note there is NO cancelled state: a question the reader dismisses arrives as
 * `error`, indistinguishable from one that genuinely failed. See
 * `projectV2ToolStatus`, which maps this without inventing a distinction the
 * server does not make.
 */
export type V2ToolStatus = "pending" | "running" | "complete" | "error";

/**
 * When a tool part started, and when it finished, in epoch milliseconds.
 *
 * This is the one piece of per-part timing in the projection, and it exists so
 * assistant-ui's own `useToolCallElapsed` has something to read. The field names
 * are the library's (`startedAt` / `completedAt`), not OpenCode's — OpenCode
 * calls them `time.created` / `time.completed` — because the value is handed
 * straight to the library and renaming it at the boundary would be a
 * translation with no reader.
 *
 * `completedAt` is absent while the call is still in flight, which is what makes
 * the library tick rather than show a frozen number.
 */
export interface V2ToolTiming {
  readonly startedAt: number;
  readonly completedAt?: number;
}

export type V2MessagePartState =
  | {
      readonly kind: "text";
      readonly id: string;
      readonly order: number;
      readonly value: string;
      readonly status: "streaming" | "complete";
    }
  | {
      readonly kind: "reasoning";
      readonly id: string;
      readonly order: number;
      readonly value: string;
      readonly status: "streaming" | "complete";
    }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly order: number;
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
      readonly output: unknown;
      readonly metadata?: Readonly<Record<string, unknown>>;
      readonly status: V2ToolStatus;
      /**
       * Absent when the server never reported a time for this part. The
       * duration badge renders nothing in that case rather than showing a
       * fabricated zero.
       */
      readonly timing?: V2ToolTiming;
    }
  | {
      readonly kind: "retry";
      readonly id: string;
      readonly order: number;
      readonly value: string;
    }
  | {
      readonly kind: "step";
      readonly id: string;
      readonly order: number;
      readonly status: "started" | "finished" | "error";
    };

export interface V2MessageState {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: "user" | "assistant" | "system" | "record";
  readonly createdAt: number;
  readonly parts: readonly V2MessagePartState[];
  readonly source: SessionMessageInfo | null;
}

export interface V2InboxRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly type: "user" | "compaction" | "synthetic" | "move";
  readonly delivery: "steer" | "queue";
}

export interface V2HistorySnapshot {
  readonly messages: readonly SessionMessageInfo[];
  readonly pages: number;
}

/**
 * The ids a history commit reconciles against.
 *
 * A snapshot is read page by page, so the transcript keeps moving while it is
 * being read: a message may be created, and an assistant message already in the
 * snapshot may keep streaming. The two facts are different and are tracked
 * separately:
 *
 * - `held` is the transcript at the instant the read STARTED. A held message the
 *   snapshot no longer contains was deleted server-side, so it is removed — the
 *   one deletion this merge is allowed to perform.
 * - `touched` is the messages a live event CHANGED while the read was in
 *   flight. Those keep their live version, because the snapshot's copy of them
 *   was taken before the change.
 *
 * A message in neither is taken from the snapshot, which is what makes a
 * refresh repair a transcript that drifted. A first load passes an empty
 * `held`, which is exactly a replace.
 */
export interface V2HistoryMerge {
  readonly held: readonly string[];
  readonly touched: readonly string[];
}

/**
 * Whether a pending set reflects the server's current answer.
 *
 * `unavailable` means the last read FAILED. The entries already held stay as
 * they are, because a failed read says nothing about them — it is not a
 * successful empty list.
 */
export type V2AuxiliaryAvailability = "current" | "unavailable";

/** The availability of each pending set, tracked per kind. */
export interface V2AuxiliaryState {
  readonly inbox: V2AuxiliaryAvailability;
  readonly permissions: V2AuxiliaryAvailability;
  readonly forms: V2AuxiliaryAvailability;
}

export interface V2EventIdentityState {
  readonly recentObservedEventIds: readonly string[];
  readonly recentAppliedEventIds: readonly string[];
  readonly durableSequenceByAggregate: Readonly<Record<string, number>>;
}

export type V2LoadState =
  | { readonly type: "idle" }
  | { readonly type: "loading" }
  | { readonly type: "ready" }
  | { readonly type: "reconciling" }
  | { readonly type: "error"; readonly error: V2SafeError };

export type V2ConnectionState =
  | { readonly type: "waiting-for-server" }
  | { readonly type: "connected"; readonly serverVersion: string | null }
  | { readonly type: "reconnecting"; readonly attempt: number }
  | { readonly type: "failed"; readonly attempt: number }
  | { readonly type: "closed" };

/**
 * The single LIVE retry representation. The historical retry message part is
 * unchanged and is never read as live state: a durable record proves an attempt
 * happened, not that a scheduled wait is still counting down.
 */
export interface V2RetryInfo {
  readonly attempt: number;
  /** Absolute epoch-ms deadline, or null when the server gave no trustworthy value. */
  readonly next: number | null;
  readonly error: V2SafeError;
}

/**
 * Process-local activity of the session, as the backend reads it.
 *
 * `not-running` is not an all-clear: a durable execution claim, a queued inbox
 * row, or an orphaned server can coexist with it. `unknown` is never idle.
 */
export type V2ActivityState = "running" | "not-running" | "unknown";

export type V2ExecutionState =
  | { readonly type: "idle" }
  | {
      readonly type: "submitting";
      readonly userMessageId: string;
      readonly cancelRequested: boolean;
    }
  | {
      readonly type: "admitted";
      readonly userMessageId: string;
      readonly inboxId: string;
      readonly delivery: "steer" | "queue";
      readonly cancelRequested: boolean;
    }
  | {
      readonly type: "reconciling";
      readonly userMessageId: string;
      readonly cancelRequested: boolean;
    }
  | {
      readonly type: "executing";
      readonly userMessageId: string | null;
      readonly inboxId: string | null;
      readonly assistantMessageId: null;
      readonly cancelRequested: boolean;
    }
  | {
      readonly type: "streaming";
      readonly userMessageId: string | null;
      readonly inboxId: string | null;
      readonly assistantMessageId: string;
      readonly cancelRequested: boolean;
    }
  | {
      readonly type: "cancelling";
      readonly phase: "prompt-request" | "queued" | "execution";
      readonly userMessageId: string | null;
      readonly inboxId: string | null;
      readonly assistantMessageId: string | null;
      /**
       * Whether a cancel is still owed.
       *
       * The `cancelling` state IS a pending cancel, so this is what the state
       * is ABOUT - and it is the only way the reader can tell a cancel that has
       * been honoured from one that is still waiting for the prompt to be
       * admitted. It is `true` from the moment the cancel is requested, and it
       * is cleared when the cancel has been issued against the admitted inbox
       * id (M7).
       */
      readonly cancelRequested: boolean;
    }
  | { readonly type: "reverting"; readonly userMessageId: string | null }
  | {
      readonly type: "error";
      readonly userMessageId: string | null;
      readonly assistantMessageId: string | null;
      readonly error: V2SafeError;
    };

export type V2CompactionState =
  | { readonly type: "idle" }
  | { readonly type: "admitted"; readonly inboxId: string }
  | { readonly type: "running" }
  | { readonly type: "error"; readonly error: V2SafeError };

export type V2RevertRecoveryState =
  | { readonly type: "none" }
  | { readonly type: "staging" }
  | { readonly type: "clearing" }
  | { readonly type: "blocked"; readonly error: V2SafeError };

export interface V2ThreadState {
  /**
   * How many events the hydration buffer LOST.
   *
   * Distinct from `diagnosticCount`, which counts events the runtime ignored
   * for other reasons (out of scope, replay-only, a stale durable sequence).
   * This one counts a LOSS: events the client held and then dropped, so the
   * transcript it committed is short by exactly this much.
   */
  readonly droppedEventCount: number;
  readonly sessionId: string;
  /**
   * The workspace this view is subscribed to.
   *
   * `null` when the server did not report a scope. It is the basis of the
   * event-scope check: an event that names a different directory is not this
   * view's event and is not applied. The directory is display-and-scope data
   * the backend resolved; the browser never chooses one.
   */
  readonly directory: string | null;
  readonly connection: V2ConnectionState;
  readonly load: V2LoadState;
  /**
   * The live retry the engine is currently waiting on, or null.
   *
   * Only live events/status establish this. It is not rebuilt from history or
   * from a replayed durable record, so a reconnect does not fabricate a
   * countdown that no process is counting.
   */
  readonly retry: V2RetryInfo | null;
  /** Confirmed process-local activity, or `unknown` when it was not established. */
  readonly activity: V2ActivityState;
  /**
   * Ordering marker for activity reads. Incremented by every authoritative
   * activity/retry/connection/load event; an activity response captured at an
   * older revision is discarded rather than applied over newer evidence.
   */
  readonly activityRevision: number;
  readonly execution: V2ExecutionState;
  readonly compaction: V2CompactionState;
  readonly revertRecovery: V2RevertRecoveryState;
  readonly eventIdentity: V2EventIdentityState;
  readonly session: SessionInfo | null;
  readonly model: V2ModelSelection | null;
  readonly agent: string | null;
  readonly desiredModel: V2ModelSelection | null;
  readonly desiredAgent: string | null;
  readonly selectionGeneration: number;
  readonly messages: Readonly<Record<string, V2MessageState>>;
  readonly messageOrder: readonly string[];
  readonly permissions: readonly PermissionRequest[];
  readonly forms: readonly FormInfo[];
  readonly inboxById: Readonly<Record<string, V2InboxRecord>>;
  /**
   * Whether each pending set is the server's current answer.
   *
   * A failed read is NOT an authoritative empty list: it leaves the last known
   * entries in place and marks that kind unavailable, so a surface can say the
   * shown set is stale instead of quietly emptying it.
   */
  readonly auxiliary: V2AuxiliaryState;
  readonly usage: V2UsageSnapshot | null;
  /**
   * Tokens of the NEWEST assistant response - the current model-visible context.
   *
   * Deliberately NOT `usage.tokens`: that is the session's cumulative ledger, so
   * it grows with every round trip and reports traffic as occupancy. Measured
   * live against opencode 2.0.22, three trivial turns gave session totals of
   * 12,451 -> 24,005 -> 35,571 while this stayed flat at 11,524. See
   * `codeOccupancy.ts`.
   *
   * `null` until a response reports tokens, and not consulted while
   * `occupancyStale` is true.
   */
  readonly occupancyTokens: TokenUsageInfo | null;
  /**
   * True when a compaction has settled and `usage` therefore describes the
   * PRE-compaction prompt.
   *
   * A compaction rewrites what the model can see, so the usage the server was
   * holding when it settled no longer describes the conversation. The spend
   * breakdown stays valid and is deliberately NOT cleared - only the context
   * NUMERATOR is invalidated, and it stays unknown until the next usage report.
   *
   * This is the client half of OpenChamber's rule that a finished compaction
   * makes the fill unknown until the next response reports tokens. TBAi has no
   * compaction message in its projection to read that from - OpenCode reports a
   * compaction as a lifecycle transition - so the invalidation is tracked here
   * instead of re-derived from message order.
   */
  readonly occupancyStale: boolean;
  readonly optimisticMessageIds: readonly string[];
  readonly answeredPermissionIds: readonly string[];
  readonly diagnosticCount: number;
}

export type V2ThreadAction =
  | {
      readonly type: "v2_event";
      readonly event: V2Event;
      readonly mode: "observe-only" | "observe-and-apply";
      /**
       * True when the event is being replayed from the hydration buffer.
       * A replayed durable `session.retry.scheduled` updates only the
       * transcript part: it never establishes a live retry, activity, or a
       * revision bump. Only live observation may do that.
       */
      readonly replayed?: boolean;
    }
  | { readonly type: "connection_changed"; readonly connection: V2ConnectionState }
  /**
   * `connection` is a fresh connection attempt (retry is invalidated and
   * activity becomes unknown); `refresh` is ordinary history repair and
   * preserves both.
   */
  | { readonly type: "load_started"; readonly reason: "connection" | "refresh" }
  | { readonly type: "load_completed" }
  | { readonly type: "load_failed"; readonly error: V2SafeError }
  | {
      readonly type: "activity_resolved";
      readonly activity: V2ActivityState;
      /** The activity revision captured when the read started. */
      readonly revision: number;
    }
  | { readonly type: "session_hydrated"; readonly session: SessionInfo }
  | {
      readonly type: "desired_selection_changed";
      readonly selection: V2DesiredSelection;
      readonly generation: number;
    }
  | {
      readonly type: "history_loaded";
      readonly messages: readonly V2MessageState[];
      readonly messageOrder: readonly string[];
      readonly pages: number;
      /** The ids the snapshot reconciles against. */
      readonly merge: V2HistoryMerge;
    }
  | {
      readonly type: "inbox_hydrated";
      /** The server's answer, or null when the read failed. */
      readonly records: readonly V2InboxRecord[] | null;
      /** The inbox ids the client held when the read started. */
      readonly held: readonly string[];
    }
  | { readonly type: "inbox_recorded"; readonly record: V2InboxRecord }
  | {
      readonly type: "permissions_hydrated";
      /** The server's answer, or null when the read failed. */
      readonly requests: readonly PermissionRequest[] | null;
      /** The permission ids the client held when the read started. */
      readonly held: readonly string[];
    }
  | {
      readonly type: "forms_hydrated";
      /** The server's answer, or null when the read failed. */
      readonly forms: readonly FormInfo[] | null;
      /** The form ids the client held when the read started. */
      readonly held: readonly string[];
    }
  | { readonly type: "prompt_submitting"; readonly message: V2MessageState }
  | {
      readonly type: "prompt_admitted";
      readonly userMessageId: string;
      readonly inbox: V2InboxRecord;
    }
  | { readonly type: "prompt_removed"; readonly messageId: string }
  | {
      readonly type: "prompt_reconciling";
      readonly userMessageId: string;
      readonly cancelRequested: boolean;
    }
  | {
      readonly type: "cancel_requested";
      readonly phase: "prompt-request" | "queued" | "execution";
      readonly userMessageId: string | null;
      readonly inboxId: string | null;
      readonly assistantMessageId: string | null;
    }
  | { readonly type: "execution_started" }
  | { readonly type: "execution_streaming"; readonly assistantMessageId: string }
  | { readonly type: "execution_settled" }
  | {
      /**
       * Events were dropped because the hydration buffer overflowed.
       *
       * The transcript is INCOMPLETE after this, and the count says by how
       * much. It is a diagnostic, not a verdict: the attempt's readiness is
       * failed as well, so the runtime re-reads rather than claiming a
       * successful reconciliation (M5's outstanding hold).
       */
      readonly type: "events_dropped";
      readonly count: number;
    }
  | {
      readonly type: "execution_failed";
      readonly userMessageId: string | null;
      readonly assistantMessageId: string | null;
      readonly error: V2SafeError;
    }
  | {
      readonly type: "revert_recovery_staging";
      readonly userMessageId: string | null;
    }
  | {
      readonly type: "revert_recovery_clearing";
      readonly userMessageId: string | null;
    }
  | { readonly type: "revert_recovery_cleared" }
  | {
      readonly type: "revert_recovery_failed";
      readonly userMessageId: string | null;
      readonly error: V2SafeError;
    }
  | { readonly type: "compaction_admitted"; readonly inbox: V2InboxRecord }
  | { readonly type: "compaction_running" }
  | { readonly type: "compaction_settled" }
  | { readonly type: "compaction_failed"; readonly error: V2SafeError }
  | { readonly type: "permission_answered"; readonly requestId: string }
  | { readonly type: "permission_retired"; readonly requestId: string }
  | { readonly type: "form_retired"; readonly formId: string }
  | {
      readonly type: "runtime_messages_reconciled";
      readonly messageIds: readonly string[];
    };

export function modelRefToV2Selection(
  model:
    | ModelRef
    | {
        readonly providerID: string;
        readonly id?: string;
        readonly modelID?: string;
        readonly variant?: string;
      }
    | undefined,
): V2ModelSelection | null {
  if (!model) return null;
  const modelID = "modelID" in model ? model.modelID : model.id;
  return {
    providerID: model.providerID,
    modelID: modelID ?? "",
    ...(model.variant ? { variant: model.variant } : {}),
  };
}
