import { describe, expect, it } from "bun:test";
import { projectLifecycle } from "@web/features/opencode/sync/lifecycleProjection.ts";
import { createInitialV2ThreadState } from "@web/features/opencode/v2Events.ts";

const sessionId = "ses_proj";

function capacityStub() {
  return {
    size: 0,
    softCap: 256,
    protectedCap: 512,
    hardCap: 1024,
    protectedCount: 0,
    evictableCount: 0,
    atSoftCap: false,
    atProtectedCap: false,
    atHardCap: false,
    backpressure: false,
  };
}

function baseInput() {
  return {
    thread: createInitialV2ThreadState(sessionId),
    prompts: { records: [] as any[], size: 0, protectedCount: 0, capacity: capacityStub() },
    execution: {
      sessionId,
      activity: "idle" as "idle" | "active" | "unknown",
      activeExecution: null as any,
      lastOutcome: {
        outcome: "none" as const,
        attribution: "unattributed" as const,
        binding: { kind: "unbound" as const },
        evidence: {
          serverEventId: null,
          durableAggregateId: null,
          durableSeq: null,
          durableVersion: null,
        },
      },
    },
    cancellation: { intentsById: {} as Record<string, any>, intentOrder: [] as string[] },
  };
}

describe("lifecycleProjection", () => {
  it("maps composer stop availability to active execution only", () => {
    const input = baseInput();
    input.execution = {
      ...input.execution,
      activity: "active",
      activeExecution: {
        phase: "executing",
        binding: { kind: "unbound" },
        evidence: {
          serverEventId: "e1",
          durableAggregateId: sessionId,
          durableSeq: 1,
          durableVersion: 1,
        },
      },
    };
    const projection = projectLifecycle(input);
    expect(projection.isRunning).toBe(true);
    expect(projection.composerStopAvailable).toBe(true);
    expect(projection.composerStopOperation.kind).toBe("stop-current-execution");
    expect(projection.hasActiveSessionWork).toBe(true);
  });

  it("keeps queued prompt actions independent from composer stop", () => {
    const input = baseInput();
    input.thread = {
      ...input.thread,
      inboxById: {
        inb_q: { id: "inb_q", sessionId, type: "user", delivery: "queue" },
      },
    };
    input.prompts = {
      size: 1,
      protectedCount: 0,
      capacity: { ...capacityStub(), size: 1 },
      records: [
        {
          promptId: "msg_q",
          sessionId,
          phase: "admitted",
          verdict: "admitted",
          terminal: "admitted",
          inboxId: { value: "inb_q", evidence: null, conflicted: false, history: [] },
          delivery: { value: "queue", evidence: null, conflicted: false, history: [] },
          serverMessageId: { value: null, evidence: null, conflicted: false, history: [] },
          admissionMode: { value: null, evidence: null, conflicted: false, history: [] },
          protectedOwners: [],
          touchedAt: 1,
        },
      ],
    };
    const projection = projectLifecycle(input);
    expect(projection.composerStopAvailable).toBe(false);
    expect(projection.queuedPromptActions).toHaveLength(1);
    expect(projection.queuedPromptActions[0]?.operation).toBe("cancel-queued-prompt");
    expect(projection.queuedPromptActions[0]?.state).toBe("available");
  });

  it("surfaces unresolved submission and cancellation as pending lifecycle", () => {
    const input = baseInput();
    input.prompts = {
      size: 1,
      protectedCount: 0,
      capacity: { ...capacityStub(), size: 1 },
      records: [
        {
          promptId: "msg_r",
          sessionId,
          phase: "reconciling",
          verdict: "ambiguous",
          terminal: "ambiguous",
          inboxId: { value: null, evidence: null, conflicted: false, history: [] },
          delivery: { value: null, evidence: null, conflicted: false, history: [] },
          serverMessageId: { value: null, evidence: null, conflicted: false, history: [] },
          admissionMode: { value: null, evidence: null, conflicted: false, history: [] },
          protectedOwners: [],
          touchedAt: 1,
        },
      ],
    };
    input.cancellation = {
      intentOrder: ["c1"],
      intentsById: {
        c1: {
          intentId: "c1",
          operation: "stop-current-execution",
          state: "pending-confirmation",
          target: {
            kind: "active-execution",
            sessionId,
            promptId: null,
            inboxId: null,
            assistantMessageId: null,
            scope: "session-wide",
          },
          requestedAt: 1,
          dispatchId: "d1",
          dispatchResponse: null,
          evidence: [],
          diagnostics: [],
        },
      },
    };
    const projection = projectLifecycle(input);
    expect(projection.pendingLifecycle.submissionPending).toBe(true);
    expect(projection.pendingLifecycle.cancellationPending).toBe(true);
  });
});
