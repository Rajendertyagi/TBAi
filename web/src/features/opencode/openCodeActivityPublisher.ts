import { useEffect, useRef } from "react";
import {
  useConversationActivityStore,
  type ConversationActivityEntry,
  type ConversationActivityPatch,
  type ConversationExecution,
  type ConversationHealth,
} from "@/features/chat/state/conversationActivity";
import type { V2ExecutionOutcome, V2ExecutionOutcomeRecord } from "./sync/executionFacts";
import { useOptionalV2RuntimeExtras } from "./v2RuntimeExtras";

/** Authoritative projection inputs used to derive OpenCode activity. */
export interface OpenCodeActivityInput {
  readonly hasActiveSessionWork: boolean;
  readonly cancellationPending: boolean;
  readonly healthDegraded: boolean;
  /** The last server-evidenced execution outcome, or null when none is known. */
  readonly terminalOutcome: V2ExecutionOutcomeRecord | null;
}

/**
 * Tracks the last confirmed terminal outcome and whether a newer run superseded it.
 *
 * Both facts are needed: the key prevents republishing the same outcome, while
 * the run flag distinguishes "hold a confirmed terminal" from "a new run ended
 * without fresh terminal evidence" (which must report `unknown`, not keep
 * `running`).
 */
export interface OpenCodeActivityLatch {
  /** Key of the last terminal outcome published, or null when none was confirmed. */
  readonly terminalKey: string | null;
  /** True once a new run started after that terminal was published. */
  readonly runStartedAfterTerminal: boolean;
}

/** The initial latch: no terminal confirmed and no run observed yet. */
export const INITIAL_OPEN_CODE_ACTIVITY_LATCH: OpenCodeActivityLatch = {
  terminalKey: null,
  runStartedAfterTerminal: false,
};

/** The patch to publish plus the latch the caller must carry forward. */
export interface OpenCodeActivityDecision {
  readonly patch: ConversationActivityPatch;
  readonly latch: OpenCodeActivityLatch;
}

/** Maps a server-evidenced OpenCode outcome to a terminal execution state. */
export function openCodeExecutionFromOutcome(
  outcome: V2ExecutionOutcome,
): ConversationExecution | null {
  switch (outcome) {
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "cancelled";
    default:
      return null;
  }
}

/**
 * Stable identity for one terminal outcome, so it is published exactly once.
 *
 * Every real outcome is recorded by `v2ThreadController.applyExecutionEvidence`
 * with `serverEventId: event.id`, so an evidenced terminal outcome always has an
 * identity. The only evidence-free record is `noneOutcome()` (`outcome: "none"`),
 * which maps to no terminal execution at all — returning null for it is correct
 * and cannot suppress a real terminal state.
 */
export function openCodeTerminalKey(outcome: V2ExecutionOutcomeRecord | null): string | null {
  if (outcome === null) return null;
  const evidence =
    outcome.evidence.serverEventId ??
    (outcome.evidence.durableSeq !== null
      ? `${outcome.evidence.durableAggregateId ?? ""}:${outcome.evidence.durableSeq}`
      : null);
  return evidence === null ? null : `${outcome.outcome}:${evidence}`;
}

/**
 * Decides the activity patch for one OpenCode projection snapshot.
 *
 * Precedence: a pending cancellation (`stopping`) outranks active session work
 * (`running`), because a stop request is the more specific and more urgent fact
 * when both are true. A terminal state is published only from a server-evidenced
 * outcome, once per outcome. An idle projection never fabricates `idle`: it holds
 * a confirmed terminal only while no newer run has superseded it, and otherwise
 * reports `unknown`.
 */
export function decideOpenCodeActivity(
  input: OpenCodeActivityInput,
  latch: OpenCodeActivityLatch,
): OpenCodeActivityDecision {
  const health: ConversationHealth = input.healthDegraded ? "degraded" : "ok";
  const base = { health, engine: "opencode" as const };
  const terminalKey = openCodeTerminalKey(input.terminalOutcome);
  const terminalExecution = openCodeExecutionFromOutcome(input.terminalOutcome?.outcome ?? "none");
  const hasFreshTerminal =
    terminalExecution !== null && terminalKey !== null && terminalKey !== latch.terminalKey;

  // A stop request is in flight: stopping, never terminal until confirmed.
  // Mark the run flag so a later idle without fresh evidence cannot keep `running`.
  if (input.cancellationPending) {
    return {
      patch: { ...base, execution: "stopping" },
      latch: { terminalKey: latch.terminalKey, runStartedAfterTerminal: true },
    };
  }
  // Live session work. Keep the old terminal key so a fresh outcome arriving
  // while work is still active is not lost when the projection goes idle.
  if (input.hasActiveSessionWork) {
    return {
      patch: { ...base, execution: "running" },
      latch: { terminalKey: latch.terminalKey, runStartedAfterTerminal: true },
    };
  }
  if (hasFreshTerminal) {
    return {
      patch: { ...base, execution: terminalExecution },
      latch: { terminalKey, runStartedAfterTerminal: false },
    };
  }
  // Idle with no fresh terminal: hold a confirmed terminal only while no new run
  // superseded it. A new run that ended without fresh evidence yields `unknown`,
  // never a fabricated `idle` and never a stale `running`.
  if (latch.terminalKey !== null && !latch.runStartedAfterTerminal) {
    return { patch: base, latch };
  }
  return { patch: { ...base, execution: "unknown" }, latch };
}

/** True when every field present in a patch already matches the stored entry. */
function patchMatchesCurrent(
  patch: ConversationActivityPatch,
  current: ConversationActivityEntry | undefined,
): boolean {
  if (current === undefined) return false;
  if (patch.execution !== undefined && patch.execution !== current.execution) return false;
  if (patch.health !== undefined && patch.health !== current.health) return false;
  if (patch.engine !== undefined && patch.engine !== current.engine) return false;
  return true;
}

/**
 * Publishes the OpenCode lifecycle projection into the shared activity store.
 * Mount inside the per-host assistant-ui provider so native extras are present.
 */
export function OpenCodeActivityPublisher({ conversationId }: { conversationId: string }) {
  const extras = useOptionalV2RuntimeExtras();
  const projection = extras?.projection ?? null;
  const latchRef = useRef<OpenCodeActivityLatch>(INITIAL_OPEN_CODE_ACTIVITY_LATCH);

  useEffect(() => {
    if (!conversationId || projection === null) return;
    const decision = decideOpenCodeActivity(
      {
        hasActiveSessionWork: projection.hasActiveSessionWork,
        cancellationPending: projection.pendingLifecycle.cancellationPending,
        healthDegraded: projection.health.degraded,
        terminalOutcome: projection.lastOutcome,
      },
      latchRef.current,
    );
    latchRef.current = decision.latch;
    const current = useConversationActivityStore.getState().get(conversationId);
    if (patchMatchesCurrent(decision.patch, current)) return;
    useConversationActivityStore.getState().publish(conversationId, decision.patch);
  }, [conversationId, projection]);

  return null;
}
