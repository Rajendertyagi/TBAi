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
      readonly status: "pending" | "running" | "complete" | "error";
      readonly permissionId: string | null;
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
    }
  | { readonly type: "inbox_recorded"; readonly record: V2InboxRecord }
  | {
      readonly type: "permissions_hydrated";
      readonly requests: readonly PermissionRequest[];
      readonly requestOrdinal: number;
    }
  | { readonly type: "forms_hydrated"; readonly forms: readonly FormInfo[] }
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
