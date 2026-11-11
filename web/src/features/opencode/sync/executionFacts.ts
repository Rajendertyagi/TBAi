/**
 * Actual session execution facts.
 *
 * This store owns only what the session is doing on the server: whether work is
 * active, what phase an evidenced active execution is in, how the last
 * correlated execution ended, and how (or whether) that execution is attributed.
 *
 * It does not own prompt admission/submission/reconciliation and it does not own
 * cancellation. Those are separate lifecycle facts with separate authorities.
 */

export type V2SessionActivity = "idle" | "active" | "unknown";

export type V2ExecutionOutcome = "succeeded" | "failed" | "interrupted" | "unknown" | "none";

export type V2OutcomeAttribution = "attributed" | "unattributed" | "ambiguous";

export type V2ActiveExecutionPhase = "executing" | "streaming";

export type V2ExecutionBinding =
  | { readonly kind: "unbound" }
  | {
      readonly kind: "prompt-correlated";
      readonly promptId: string;
      readonly inboxId: string | null;
      readonly assistantMessageId: string | null;
    }
  | {
      readonly kind: "ambiguous";
      readonly promptId: string | null;
      readonly inboxId: string | null;
      readonly assistantMessageId: string | null;
    };

export interface V2ExecutionEventIdentity {
  readonly serverEventId: string | null;
  readonly durableAggregateId: string | null;
  readonly durableSeq: number | null;
  readonly durableVersion: number | null;
}

export interface V2ActiveExecution {
  readonly phase: V2ActiveExecutionPhase;
  readonly binding: V2ExecutionBinding;
  readonly evidence: V2ExecutionEventIdentity;
}

export interface V2ExecutionOutcomeRecord {
  readonly outcome: V2ExecutionOutcome;
  readonly attribution: V2OutcomeAttribution;
  readonly binding: V2ExecutionBinding;
  readonly evidence: V2ExecutionEventIdentity;
}

export interface V2ExecutionFactsSnapshot {
  readonly sessionId: string;
  readonly activity: V2SessionActivity;
  readonly activeExecution: V2ActiveExecution | null;
  readonly lastOutcome: V2ExecutionOutcomeRecord;
}

export interface V2ExecutionFactsStore {
  getSnapshot(): V2ExecutionFactsSnapshot;
  /** Establishes session activity without establishing prompt attribution. */
  markSessionActive(evidence: V2ExecutionEventIdentity): V2ExecutionFactsSnapshot;
  /** Establishes inactivity. Does not establish success/failure/interruption. */
  markSessionIdle(evidence: V2ExecutionEventIdentity): V2ExecutionFactsSnapshot;
  /** Records that activity cannot be established from available evidence. */
  markSessionUnknown(evidence: V2ExecutionEventIdentity): V2ExecutionFactsSnapshot;
  /** Records evidenced active execution. */
  setActiveExecution(execution: V2ActiveExecution): V2ExecutionFactsSnapshot;
  /** Updates the active execution phase/binding when evidence supports it. */
  updateActiveExecution(
    update: Partial<Pick<V2ActiveExecution, "phase" | "binding" | "evidence">>,
  ): V2ExecutionFactsSnapshot;
  /** Clears active execution without inventing an outcome. */
  clearActiveExecution(): V2ExecutionFactsSnapshot;
  /** Records a correlated execution outcome. */
  recordOutcome(outcome: V2ExecutionOutcomeRecord): V2ExecutionFactsSnapshot;
  /** Replaces the snapshot only when the caller has validated ordering/evidence. */
  replace(next: V2ExecutionFactsSnapshot): V2ExecutionFactsSnapshot;
}

const EMPTY_EVIDENCE: V2ExecutionEventIdentity = {
  serverEventId: null,
  durableAggregateId: null,
  durableSeq: null,
  durableVersion: null,
};

function noneOutcome(): V2ExecutionOutcomeRecord {
  return {
    outcome: "none",
    attribution: "unattributed",
    binding: { kind: "unbound" },
    evidence: EMPTY_EVIDENCE,
  };
}

export function createExecutionFactsStore(sessionId: string): V2ExecutionFactsStore {
  let snapshot: V2ExecutionFactsSnapshot = {
    sessionId,
    activity: "unknown",
    activeExecution: null,
    lastOutcome: noneOutcome(),
  };

  function commit(next: V2ExecutionFactsSnapshot): V2ExecutionFactsSnapshot {
    snapshot = next;
    return snapshot;
  }

  return {
    getSnapshot: () => snapshot,
    markSessionActive: (evidence) =>
      commit({
        ...snapshot,
        activity: "active",
        activeExecution:
          snapshot.activeExecution ??
          ({
            phase: "executing",
            binding: { kind: "unbound" },
            evidence,
          } satisfies V2ActiveExecution),
      }),
    markSessionIdle: (_evidence) =>
      commit({
        ...snapshot,
        activity: "idle",
        activeExecution: null,
      }),
    markSessionUnknown: (_evidence) =>
      commit({
        ...snapshot,
        activity: "unknown",
      }),
    setActiveExecution: (execution) =>
      commit({
        ...snapshot,
        activity: "active",
        activeExecution: execution,
      }),
    updateActiveExecution: (update) => {
      if (!snapshot.activeExecution) return snapshot;
      return commit({
        ...snapshot,
        activeExecution: {
          ...snapshot.activeExecution,
          ...update,
        },
      });
    },
    clearActiveExecution: () =>
      commit({
        ...snapshot,
        activeExecution: null,
      }),
    recordOutcome: (outcome) =>
      commit({
        ...snapshot,
        lastOutcome: outcome,
      }),
    replace: (next) => commit(next),
  };
}
