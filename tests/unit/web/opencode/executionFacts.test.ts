import { describe, expect, it } from "bun:test";
import { createExecutionFactsStore } from "@web/features/opencode/sync/executionFacts.ts";

const evidence = {
  serverEventId: "evt_1",
  durableAggregateId: "ses_1",
  durableSeq: 1,
  durableVersion: 1,
};

describe("executionFacts", () => {
  it("tracks session activity and active execution separately from outcomes", () => {
    const store = createExecutionFactsStore("ses_1");
    store.markSessionActive(evidence);
    store.setActiveExecution({
      phase: "executing",
      binding: { kind: "unbound" },
      evidence,
    });
    let snap = store.getSnapshot();
    expect(snap.activity).toBe("active");
    expect(snap.activeExecution?.phase).toBe("executing");
    expect(snap.lastOutcome.outcome).toBe("none");

    store.recordOutcome({
      outcome: "succeeded",
      attribution: "unattributed",
      binding: { kind: "unbound" },
      evidence: { ...evidence, serverEventId: "evt_2", durableSeq: 2 },
    });
    snap = store.getSnapshot();
    expect(snap.lastOutcome.outcome).toBe("succeeded");
    expect(snap.lastOutcome.attribution).toBe("unattributed");
  });

  it("can mark session idle without inventing success/failure/interruption", () => {
    const store = createExecutionFactsStore("ses_1");
    store.markSessionActive(evidence);
    store.markSessionIdle({ ...evidence, serverEventId: "evt_idle" });
    const snap = store.getSnapshot();
    expect(snap.activity).toBe("idle");
    expect(snap.activeExecution).toBeNull();
    expect(snap.lastOutcome.outcome).toBe("none");
  });
});
