import type { V2ThreadState } from "../v2Types";
import type { PromptsInFlightSnapshot, V2PromptCapacitySnapshot } from "./promptsInFlight";
import type { V2ExecutionFactsSnapshot } from "./executionFacts";
import type { V2CancellationFactsSnapshot, V2CancellationIntent } from "./cancellationFacts";

export type V2ComposerStopOperation =
  | { readonly kind: "none" }
  | {
      readonly kind: "stop-current-execution";
      readonly intentId: string | null;
      readonly promptId: string | null;
      readonly inboxId: string | null;
      readonly assistantMessageId: string | null;
      readonly scope: "prompt-associated" | "session-wide";
    };

export interface V2QueuedPromptAction {
  readonly promptId: string;
  readonly inboxId: string | null;
  readonly operation: "cancel-queued-prompt";
  readonly intentId: string | null;
  readonly state:
    | "available"
    | "requested"
    | "dispatching"
    | "pending-confirmation"
    | "confirmed"
    | "failed"
    | "superseded"
    | "unknown"
    | "unavailable";
  readonly disabledReason: string | null;
}

export interface V2PendingLifecycle {
  readonly submissionPending: boolean;
  readonly cancellationPending: boolean;
  readonly reasons: readonly string[];
}

/**
 * Lifecycle consistency health.
 *
 * A lifecycle transition that faults is rolled back, so the facts stay
 * last-known-good — but they are then STALE relative to a server event this
 * client could not apply. `degraded` says exactly that until reconciliation
 * proves the snapshot again. It is recoverable, never a dead end.
 */
export interface V2LifecycleHealth {
  readonly degraded: boolean;
  readonly reason: string | null;
  readonly recoveryAttempts: number;
  readonly recovering: boolean;
}

export interface V2LifecycleProjection {
  readonly isLoading: boolean;
  /** Composer Stop compatibility: availability of Composer Stop only. */
  readonly isRunning: boolean;
  readonly composerStopAvailable: boolean;
  readonly composerStopOperation: V2ComposerStopOperation;
  /** Actual session execution activity. */
  readonly hasActiveSessionWork: boolean;
  /** Unresolved prompt submission/admission/reconciliation or cancellation. */
  readonly pendingLifecycle: V2PendingLifecycle;
  /** Independent queued prompt controls. */
  readonly queuedPromptActions: readonly V2QueuedPromptAction[];
  /** Measured admission capacity; `backpressure` is the send decision. */
  readonly capacity: V2PromptCapacitySnapshot;
  /** Whether the lifecycle snapshot is stale and being reconciled. */
  readonly health: V2LifecycleHealth;
  readonly isSendDisabled: boolean;
  readonly primaryStatus: string;
  readonly detail: string;
}

export interface V2LifecycleProjectionInput {
  readonly thread: V2ThreadState;
  readonly prompts: PromptsInFlightSnapshot;
  readonly execution: V2ExecutionFactsSnapshot;
  readonly cancellation: V2CancellationFactsSnapshot;
  readonly health?: V2LifecycleHealth;
}

function latestIntentForQueuedPrompt(
  cancellation: V2CancellationFactsSnapshot,
  promptId: string,
  inboxId: string | null,
): V2CancellationIntent | null {
  for (let i = cancellation.intentOrder.length - 1; i >= 0; i--) {
    const intent = cancellation.intentsById[cancellation.intentOrder[i]];
    if (intent?.operation !== "cancel-queued-prompt") continue;
    if (intent.target.kind !== "queued-prompt") continue;
    if (intent.target.promptId !== promptId) continue;
    if (inboxId !== null && intent.target.inboxId !== null && intent.target.inboxId !== inboxId)
      continue;
    return intent;
  }
  return null;
}

function isCancellationPendingState(state: V2CancellationIntent["state"]): boolean {
  return (
    state === "requested" ||
    state === "target-resolved" ||
    state === "dispatching" ||
    state === "pending-confirmation" ||
    state === "unknown"
  );
}

export function projectLifecycle(input: V2LifecycleProjectionInput): V2LifecycleProjection {
  const { thread, prompts, execution, cancellation } = input;
  const health: V2LifecycleHealth = input.health ?? {
    degraded: false,
    reason: null,
    recoveryAttempts: 0,
    recovering: false,
  };

  const submissionPending = prompts.records.some(
    (r) => r.phase === "submitting" || r.phase === "reconciling",
  );
  const cancellationPending = Object.values(cancellation.intentsById).some((intent) =>
    isCancellationPendingState(intent.state),
  );
  const reasons: string[] = [];
  if (submissionPending) reasons.push("submission-pending");
  if (cancellationPending) reasons.push("cancellation-pending");

  const hasActiveSessionWork =
    execution.activity === "active" || execution.activeExecution !== null;

  // Composer Stop is available only for a safely identified active execution with
  // an explicit stop-current-execution operation. It never cancels queued prompts.
  const active = execution.activeExecution;
  const composerStopAvailable = hasActiveSessionWork && active !== null;
  const composerStopOperation: V2ComposerStopOperation = composerStopAvailable
    ? {
        kind: "stop-current-execution",
        intentId: null,
        promptId: active.binding.kind === "prompt-correlated" ? active.binding.promptId : null,
        inboxId: active.binding.kind === "prompt-correlated" ? active.binding.inboxId : null,
        assistantMessageId:
          active.binding.kind === "prompt-correlated" ? active.binding.assistantMessageId : null,
        scope: active.binding.kind === "prompt-correlated" ? "prompt-associated" : "session-wide",
      }
    : { kind: "none" };

  const queuedPromptActions: V2QueuedPromptAction[] = prompts.records
    .filter((r) => {
      if (r.verdict !== "admitted") return false;
      const inboxId = r.inboxId.value;
      if (inboxId === null) return false;
      const inbox = thread.inboxById[inboxId];
      // Only prompts still present as queued user inbox items are independently cancellable.
      return inbox?.type === "user";
    })
    .map((r) => {
      const inboxId = r.inboxId.value;
      const intent = latestIntentForQueuedPrompt(cancellation, r.promptId, inboxId);
      if (!intent) {
        return {
          promptId: r.promptId,
          inboxId,
          operation: "cancel-queued-prompt" as const,
          intentId: null,
          state: "available" as const,
          disabledReason: null,
        };
      }
      const state = intent.state === "target-resolved" ? "requested" : intent.state;
      return {
        promptId: r.promptId,
        inboxId: inboxId ?? (intent.target.kind === "queued-prompt" ? intent.target.inboxId : null),
        operation: "cancel-queued-prompt" as const,
        intentId: intent.intentId,
        state,
        disabledReason: null,
      };
    });

  const isLoading = thread.load.type !== "ready";
  // Degraded and backpressured are recoverable, and both refuse a send rather
  // than dispatching one the registry or the facts cannot account for.
  const isSendDisabled =
    thread.revertRecovery.type !== "none" || health.degraded || prompts.capacity.backpressure;

  let primaryStatus = "idle";
  if (health.degraded) primaryStatus = "reconciling";
  else if (prompts.capacity.backpressure) primaryStatus = "capacity";
  else if (cancellationPending) primaryStatus = "cancelling";
  else if (submissionPending) primaryStatus = "submitting";
  else if (hasActiveSessionWork) primaryStatus = active?.phase ?? "executing";

  const detail = health.degraded ? "lifecycle-degraded" : reasons.join(", ");

  return {
    isLoading,
    isRunning: composerStopAvailable,
    composerStopAvailable,
    composerStopOperation,
    hasActiveSessionWork,
    pendingLifecycle: {
      submissionPending,
      cancellationPending,
      reasons,
    },
    queuedPromptActions,
    capacity: prompts.capacity,
    health,
    isSendDisabled,
    primaryStatus,
    detail,
  };
}
