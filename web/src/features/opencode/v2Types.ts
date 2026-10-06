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
      readonly permissionId: string | null;
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

export interface V2EventIdentityState {
  readonly nextOrdinal: number;
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
  | { readonly type: "closed" };

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
  readonly sessionId: string;
  readonly connection: V2ConnectionState;
  readonly load: V2LoadState;
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
      readonly ordinal: number;
      readonly mode: "observe-only" | "observe-and-apply";
    }
  | { readonly type: "connection_changed"; readonly connection: V2ConnectionState }
  | { readonly type: "load_started" }
  | { readonly type: "load_reconciling"; readonly reason: "history-convergence-cap" }
  | { readonly type: "load_reconciled" }
  | { readonly type: "load_completed" }
  | { readonly type: "load_failed"; readonly error: V2SafeError }
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
    }
  | {
      readonly type: "inbox_hydrated";
      readonly records: readonly V2InboxRecord[];
      readonly requestOrdinal: number;
    }
  | { readonly type: "inbox_recorded"; readonly record: V2InboxRecord }
  | {
      readonly type: "permissions_hydrated";
      readonly requests: readonly PermissionRequest[];
      readonly requestOrdinal: number;
    }
  | {
      readonly type: "forms_hydrated";
      readonly forms: readonly FormInfo[];
      readonly requestOrdinal: number;
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
