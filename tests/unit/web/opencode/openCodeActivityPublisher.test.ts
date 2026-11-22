/**
 * OpenCode activity projection — publisher behavior.
 *
 * Pins the honest transitions for the Code engine: live session work is
 * `running`, a pending cancellation is `stopping`, and a terminal state is
 * published only from a server-evidenced outcome. An idle projection never
 * fabricates `idle`, never downgrades a confirmed terminal, and never leaves a
 * stale `running` after a new run ends without fresh terminal evidence.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { useConversationActivityStore } from "@web/features/chat/state/conversationActivity";
import type { V2ExecutionOutcome, V2ExecutionOutcomeRecord } from "@web/features/opencode/sync/executionFacts";
import {
  decideOpenCodeActivity,
  INITIAL_OPEN_CODE_ACTIVITY_LATCH,
  openCodeExecutionFromOutcome,
  openCodeTerminalKey,
  type OpenCodeActivityInput,
  type OpenCodeActivityLatch,
} from "@web/features/opencode/openCodeActivityPublisher";

const CONVERSATION = "conv-opencode-1";

function noOutcome(): V2ExecutionOutcomeRecord {
  return {
    outcome: "none",
    attribution: "unattributed",
    binding: { kind: "unbound" },
    evidence: {
      serverEventId: null,
      durableAggregateId: null,
      durableSeq: null,
      durableVersion: null,
    },
  };
}

function evidencedOutcome(
  outcome: V2ExecutionOutcome,
  serverEventId: string,
): V2ExecutionOutcomeRecord {
  return {
    outcome,
    attribution: "unattributed",
    binding: { kind: "unbound" },
    evidence: {
      serverEventId,
      durableAggregateId: "ses_test",
      durableSeq: 1,
      durableVersion: 1,
    },
  };
}

function idleInput(overrides: Partial<OpenCodeActivityInput> = {}): OpenCodeActivityInput {
  return {
    hasActiveSessionWork: false,
    cancellationPending: false,
    healthDegraded: false,
    terminalOutcome: noOutcome(),
    ...overrides,
  };
}

/** Applies a decision to the real store the way the mounted publisher does. */
function applyDecision(
  input: OpenCodeActivityInput,
  latch: OpenCodeActivityLatch,
): OpenCodeActivityLatch {
  const decision = decideOpenCodeActivity(input, latch);
  useConversationActivityStore.getState().publish(CONVERSATION, decision.patch);
  return decision.latch;
}

function execution(): string | undefined {
  return useConversationActivityStore.getState().get(CONVERSATION)?.execution;
}

describe("OpenCode activity projection", () => {
  beforeEach(() => {
    useConversationActivityStore.getState().clear(CONVERSATION);
  });

  it("has no execution state until a publisher reports one", () => {
    expect(useConversationActivityStore.getState().get(CONVERSATION)).toBeUndefined();
  });

  it("reports running from active session work", () => {
    const decision = decideOpenCodeActivity(
      idleInput({ hasActiveSessionWork: true }),
      INITIAL_OPEN_CODE_ACTIVITY_LATCH,
    );
    expect(decision.patch.execution).toBe("running");
  });

  it("reports stopping while a cancellation is pending", () => {
    const decision = decideOpenCodeActivity(
      idleInput({ cancellationPending: true }),
      INITIAL_OPEN_CODE_ACTIVITY_LATCH,
    );
    expect(decision.patch.execution).toBe("stopping");
  });

  it("prioritizes stopping over running when both facts are true", () => {
    // A stop request is the more specific fact while work is still winding down.
    const decision = decideOpenCodeActivity(
      idleInput({ hasActiveSessionWork: true, cancellationPending: true }),
      INITIAL_OPEN_CODE_ACTIVITY_LATCH,
    );
    expect(decision.patch.execution).toBe("stopping");
  });

  it("maps server-evidenced outcomes to terminal states", () => {
    expect(openCodeExecutionFromOutcome("succeeded")).toBe("completed");
    expect(openCodeExecutionFromOutcome("failed")).toBe("failed");
    expect(openCodeExecutionFromOutcome("interrupted")).toBe("cancelled");
    expect(openCodeExecutionFromOutcome("unknown")).toBeNull();
    expect(openCodeExecutionFromOutcome("none")).toBeNull();
  });

  it("publishes completed, failed and cancelled only from evidenced outcomes", () => {
    for (const [outcome, expected] of [
      ["succeeded", "completed"],
      ["failed", "failed"],
      ["interrupted", "cancelled"],
    ] as const) {
      const decision = decideOpenCodeActivity(
        idleInput({ terminalOutcome: evidencedOutcome(outcome, `event-${outcome}`) }),
        INITIAL_OPEN_CODE_ACTIVITY_LATCH,
      );
      expect(decision.patch.execution).toBe(expected);
      expect(decision.latch.terminalKey).not.toBeNull();
    }
  });

  it("does not publish a terminal state from an idle projection alone", () => {
    const decision = decideOpenCodeActivity(idleInput(), INITIAL_OPEN_CODE_ACTIVITY_LATCH);
    expect(decision.patch.execution).toBe("unknown");
    expect(decision.latch.terminalKey).toBeNull();
  });

  it("reports degraded health independently of execution", () => {
    const decision = decideOpenCodeActivity(
      idleInput({ hasActiveSessionWork: true, healthDegraded: true }),
      INITIAL_OPEN_CODE_ACTIVITY_LATCH,
    );
    expect(decision.patch.execution).toBe("running");
    expect(decision.patch.health).toBe("degraded");
  });

  it("holds a confirmed terminal state when a later idle projection arrives", () => {
    let latch = applyDecision(
      idleInput({ terminalOutcome: evidencedOutcome("succeeded", "event-done") }),
      INITIAL_OPEN_CODE_ACTIVITY_LATCH,
    );
    expect(execution()).toBe("completed");

    latch = applyDecision(idleInput(), latch);
    // No execution in the patch: the stored terminal state is preserved by merge.
    expect(execution()).toBe("completed");
    expect(latch.runStartedAfterTerminal).toBe(false);
  });

  it("reports unknown, not running, when a new run ends with a stale outcome key", () => {
    // Run 1 completes with outcome K.
    let latch = applyDecision(
      idleInput({ terminalOutcome: evidencedOutcome("succeeded", "event-K") }),
      INITIAL_OPEN_CODE_ACTIVITY_LATCH,
    );
    expect(execution()).toBe("completed");

    // Run 2 starts: running is published and the latch records the supersession.
    latch = applyDecision(idleInput({ hasActiveSessionWork: true }), latch);
    expect(execution()).toBe("running");
    expect(latch.runStartedAfterTerminal).toBe(true);

    // Run 2 ends but the projection still exposes the SAME outcome K. The store
    // must not stay at running, and the stale terminal must not be republished.
    latch = applyDecision(
      idleInput({ terminalOutcome: evidencedOutcome("succeeded", "event-K") }),
      latch,
    );
    expect(execution()).toBe("unknown");
    expect(latch.terminalKey).toBe("succeeded:event-K");
  });

  it("publishes a different terminal outcome after a new run", () => {
    let latch = applyDecision(
      idleInput({ terminalOutcome: evidencedOutcome("succeeded", "event-one") }),
      INITIAL_OPEN_CODE_ACTIVITY_LATCH,
    );
    latch = applyDecision(idleInput({ hasActiveSessionWork: true }), latch);
    latch = applyDecision(
      idleInput({ terminalOutcome: evidencedOutcome("failed", "event-two") }),
      latch,
    );
    expect(execution()).toBe("failed");
    expect(latch.terminalKey).toBe("failed:event-two");
  });

  it("never fabricates idle in any projection state", () => {
    const inputs = [
      idleInput(),
      idleInput({ hasActiveSessionWork: true }),
      idleInput({ cancellationPending: true }),
      idleInput({ hasActiveSessionWork: true, cancellationPending: true }),
      idleInput({ healthDegraded: true }),
      idleInput({ terminalOutcome: evidencedOutcome("succeeded", "event-x") }),
    ];
    for (const input of inputs) {
      const decision = decideOpenCodeActivity(input, INITIAL_OPEN_CODE_ACTIVITY_LATCH);
      expect(decision.patch.execution).not.toBe("idle");
    }
  });

  it("stores the published patch without inventing idle on teardown", () => {
    applyDecision(
      idleInput({ terminalOutcome: evidencedOutcome("interrupted", "event-stop") }),
      INITIAL_OPEN_CODE_ACTIVITY_LATCH,
    );
    expect(execution()).toBe("cancelled");

    useConversationActivityStore.getState().clear(CONVERSATION);
    expect(useConversationActivityStore.getState().get(CONVERSATION)).toBeUndefined();
  });

  it("gives each evidenced outcome a distinct identity", () => {
    const first = openCodeTerminalKey(evidencedOutcome("succeeded", "event-a"));
    const second = openCodeTerminalKey(evidencedOutcome("succeeded", "event-b"));
    expect(first).not.toBe(second);
  });

  it("returns no identity for the evidence-free none outcome", () => {
    // Every real outcome is recorded with a server event id; the only
    // evidence-free record is `none`, which maps to no terminal execution.
    expect(openCodeTerminalKey(noOutcome())).toBeNull();
    expect(openCodeExecutionFromOutcome("none")).toBeNull();
  });
});
