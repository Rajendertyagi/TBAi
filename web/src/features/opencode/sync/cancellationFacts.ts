/**
 * Cancellation intent, target, dispatch and evidence-based resolution.
 *
 * This store is the sole mutable owner of cancellation facts. Only
 * `recordEvidence` may transition an intent to `confirmed`, and it does so only
 * when internal, target-specific predicates are satisfied by validated evidence.
 */

export type V2CancellationOperation = "cancel-queued-prompt" | "stop-current-execution";

export type V2CancellationState =
  | "requested"
  | "target-resolved"
  | "dispatching"
  | "pending-confirmation"
  | "confirmed"
  | "failed"
  | "superseded"
  | "unknown";

export type V2CancellationTarget =
  | {
      readonly kind: "queued-prompt";
      readonly sessionId: string;
      readonly promptId: string;
      readonly inboxId: string | null;
    }
  | {
      readonly kind: "active-execution";
      readonly sessionId: string;
      readonly promptId: string | null;
      readonly inboxId: string | null;
      readonly assistantMessageId: string | null;
      readonly scope: "prompt-associated" | "session-wide";
    };

export interface V2CancellationDispatchResponse {
  readonly at: number;
  readonly ok: boolean;
  readonly status: number | null;
  readonly interrupted: boolean | null;
  readonly errorKind: string | null;
}

export interface V2CancellationEvidence {
  readonly kind: string;
  readonly serverEventId: string | null;
  readonly durableAggregateId: string | null;
  readonly durableSeq: number | null;
  readonly sessionId: string | null;
  readonly inboxId: string | null;
  readonly promptId: string | null;
  readonly assistantMessageId: string | null;
  readonly at: number;
  readonly payload?: unknown;
}

export interface V2CancellationIntent {
  readonly intentId: string;
  readonly operation: V2CancellationOperation;
  readonly state: V2CancellationState;
  readonly target: V2CancellationTarget;
  readonly requestedAt: number;
  readonly dispatchId: string | null;
  readonly dispatchResponse: V2CancellationDispatchResponse | null;
  readonly evidence: readonly V2CancellationEvidence[];
  readonly diagnostics: readonly string[];
}

export interface V2CancellationFactsSnapshot {
  readonly intentsById: Readonly<Record<string, V2CancellationIntent>>;
  readonly intentOrder: readonly string[];
}

export type V2CancellationNonConfirmingResolution = "failed" | "superseded" | "unknown";

export interface V2CancellationFactsStore {
  getSnapshot(): V2CancellationFactsSnapshot;
  /**
   * Restores an earlier snapshot after a failed lifecycle transition.
   *
   * Snapshots are immutable by construction: every update replaces the intent
   * object and the snapshot, so the captured reference is a safe restore point.
   */
  restore(snapshot: V2CancellationFactsSnapshot): V2CancellationFactsSnapshot;
  getIntent(intentId: string): V2CancellationIntent | undefined;
  requestIntent(
    intent: Omit<
      V2CancellationIntent,
      "state" | "dispatchId" | "dispatchResponse" | "evidence" | "diagnostics"
    > & {
      readonly state?: "requested" | "target-resolved";
    },
  ): V2CancellationIntent;
  upgradeTarget(intentId: string, target: V2CancellationTarget): V2CancellationIntent | null;
  markDispatching(intentId: string, dispatchId: string): V2CancellationIntent | null;
  recordDispatchResponse(
    intentId: string,
    response: V2CancellationDispatchResponse,
  ): V2CancellationIntent | null;
  /** The only path that may transition an intent to confirmed. */
  recordEvidence(intentId: string, evidence: V2CancellationEvidence): V2CancellationIntent | null;
  resolveNonConfirmed(
    intentId: string,
    resolution: V2CancellationNonConfirmingResolution,
    diagnostic?: string,
  ): V2CancellationIntent | null;
}

function canTransition(from: V2CancellationState, to: V2CancellationState): boolean {
  if (from === to) return true;
  if (from === "confirmed") return false;
  switch (from) {
    case "requested":
      return (
        to === "target-resolved" ||
        to === "dispatching" ||
        to === "failed" ||
        to === "superseded" ||
        to === "unknown"
      );
    case "target-resolved":
      return to === "dispatching" || to === "failed" || to === "superseded" || to === "unknown";
    case "dispatching":
      return (
        to === "pending-confirmation" ||
        to === "confirmed" ||
        to === "failed" ||
        to === "superseded" ||
        to === "unknown"
      );
    case "pending-confirmation":
      return to === "confirmed" || to === "failed" || to === "superseded" || to === "unknown";
    case "unknown":
      return (
        to === "confirmed" ||
        to === "failed" ||
        to === "superseded" ||
        to === "pending-confirmation"
      );
    case "failed":
    case "superseded":
      // Definitive outcomes must not silently become confirmed; contradictory late
      // evidence is recorded diagnostically by callers instead of reopening.
      return false;
    default:
      return false;
  }
}

function sameTargetIdentity(a: V2CancellationTarget, b: V2CancellationTarget): boolean {
  if (a.kind !== b.kind || a.sessionId !== b.sessionId) return false;
  if (a.kind === "queued-prompt" && b.kind === "queued-prompt") {
    return (
      a.promptId === b.promptId &&
      (a.inboxId === null || b.inboxId === null || a.inboxId === b.inboxId)
    );
  }
  if (a.kind === "active-execution" && b.kind === "active-execution") {
    return a.scope === b.scope;
  }
  return false;
}

function isQueuedCancellationConfirmed(
  intent: V2CancellationIntent,
  evidence: V2CancellationEvidence,
): boolean {
  if (intent.operation !== "cancel-queued-prompt" || intent.target.kind !== "queued-prompt")
    return false;
  if (evidence.kind !== "session.inbox.cancelled") return false;
  if (evidence.sessionId !== intent.target.sessionId) return false;
  const inboxId = intent.target.inboxId;
  return inboxId !== null && evidence.inboxId === inboxId;
}

function isExecutionCancellationConfirmed(
  _intent: V2CancellationIntent,
  _evidence: V2CancellationEvidence,
): boolean {
  // Execution cancellation requires qualifying correlation evidence to the same
  // evidenced execution and intent. Without verified execution identity/correlation
  // in the installed SDK/runtime, this remains conservative and does not confirm.
  return false;
}

function confirmsIntent(intent: V2CancellationIntent, evidence: V2CancellationEvidence): boolean {
  return (
    isQueuedCancellationConfirmed(intent, evidence) ||
    isExecutionCancellationConfirmed(intent, evidence)
  );
}

export function createCancellationFactsStore(): V2CancellationFactsStore {
  let snapshot: V2CancellationFactsSnapshot = { intentsById: {}, intentOrder: [] };

  function commit(next: V2CancellationFactsSnapshot): V2CancellationFactsSnapshot {
    snapshot = next;
    return snapshot;
  }

  function updateIntent(
    intentId: string,
    updater: (intent: V2CancellationIntent) => V2CancellationIntent,
  ): V2CancellationIntent | null {
    const current = snapshot.intentsById[intentId];
    if (!current) return null;
    const nextIntent = updater(current);
    if (nextIntent === current) return current;
    commit({
      ...snapshot,
      intentsById: { ...snapshot.intentsById, [intentId]: nextIntent },
    });
    return nextIntent;
  }

  function transition(intent: V2CancellationIntent, to: V2CancellationState): V2CancellationIntent {
    if (!canTransition(intent.state, to)) return intent;
    return intent.state === to ? intent : { ...intent, state: to };
  }

  return {
    getSnapshot: () => snapshot,
    restore: (next) => commit(next),
    getIntent: (intentId) => snapshot.intentsById[intentId],
    requestIntent: (intent) => {
      const existing = snapshot.intentsById[intent.intentId];
      if (existing) return existing;
      const created: V2CancellationIntent = {
        ...intent,
        state:
          intent.state ??
          (intent.target.kind === "queued-prompt" && intent.target.inboxId
            ? "target-resolved"
            : "requested"),
        dispatchId: null,
        dispatchResponse: null,
        evidence: [],
        diagnostics: [],
      };
      commit({
        intentsById: { ...snapshot.intentsById, [created.intentId]: created },
        intentOrder: [...snapshot.intentOrder, created.intentId],
      });
      return created;
    },
    upgradeTarget: (intentId, target) =>
      updateIntent(intentId, (intent) => {
        if (
          intent.state === "confirmed" ||
          intent.state === "dispatching" ||
          intent.state === "pending-confirmation"
        ) {
          return intent;
        }
        if (!sameTargetIdentity(intent.target, target)) {
          return { ...intent, diagnostics: [...intent.diagnostics, "target-upgrade-rejected"] };
        }
        const nextTarget =
          intent.target.kind === "queued-prompt" && target.kind === "queued-prompt"
            ? { ...intent.target, inboxId: intent.target.inboxId ?? target.inboxId }
            : intent.target;
        const resolved = nextTarget.kind === "queued-prompt" ? nextTarget.inboxId !== null : true;
        return transition(
          { ...intent, target: nextTarget },
          resolved ? "target-resolved" : intent.state,
        );
      }),
    markDispatching: (intentId, dispatchId) =>
      updateIntent(intentId, (intent) => {
        if (intent.dispatchId !== null) return intent; // prevent duplicate dispatch
        if (
          intent.state === "confirmed" ||
          intent.state === "failed" ||
          intent.state === "superseded"
        )
          return intent;
        return transition({ ...intent, dispatchId }, "dispatching");
      }),
    recordDispatchResponse: (intentId, response) =>
      updateIntent(intentId, (intent) => {
        if (intent.state === "confirmed") return intent;
        const next = { ...intent, dispatchResponse: response };
        // Dispatch response is evidence only, never confirmation.
        if (intent.state === "dispatching") return transition(next, "pending-confirmation");
        return next;
      }),
    recordEvidence: (intentId, evidence) =>
      updateIntent(intentId, (intent) => {
        const deduped = intent.evidence.some(
          (e) =>
            e.serverEventId !== null &&
            evidence.serverEventId !== null &&
            e.serverEventId === evidence.serverEventId &&
            e.kind === evidence.kind,
        );
        const withEvidence = deduped
          ? intent
          : { ...intent, evidence: [...intent.evidence, evidence] };
        if (confirmsIntent(withEvidence, evidence)) {
          return transition(withEvidence, "confirmed");
        }
        // Late contradictory evidence against definitive outcomes is recorded only.
        if (intent.state === "failed" || intent.state === "superseded") {
          return deduped
            ? intent
            : {
                ...intent,
                evidence: [...intent.evidence, evidence],
                diagnostics: [...intent.diagnostics, "late-contradictory-evidence"],
              };
        }
        if (intent.state === "dispatching") return transition(withEvidence, "pending-confirmation");
        return withEvidence;
      }),
    resolveNonConfirmed: (intentId, resolution, diagnostic) =>
      updateIntent(intentId, (intent) => {
        if (intent.state === "confirmed") return intent;
        const next = diagnostic
          ? { ...intent, diagnostics: [...intent.diagnostics, diagnostic] }
          : intent;
        return transition(next, resolution);
      }),
  };
}
