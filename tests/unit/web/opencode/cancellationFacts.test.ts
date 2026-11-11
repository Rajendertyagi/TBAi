import { describe, expect, it } from "bun:test";
import { createCancellationFactsStore } from "@web/features/opencode/sync/cancellationFacts.ts";

describe("cancellationFacts", () => {
  it("confirms queued-prompt cancellation only from matching session.inbox.cancelled evidence", () => {
    const store = createCancellationFactsStore();
    store.requestIntent({
      intentId: "c1",
      operation: "cancel-queued-prompt",
      requestedAt: 1,
      target: { kind: "queued-prompt", sessionId: "ses_1", promptId: "msg_1", inboxId: "inb_1" },
      state: "target-resolved",
    });
    store.markDispatching("c1", "d1");
    store.recordDispatchResponse("c1", {
      at: 2,
      ok: true,
      status: null,
      interrupted: null,
      errorKind: null,
    });
    expect(store.getIntent("c1")?.state).toBe("pending-confirmation");

    store.recordEvidence("c1", {
      kind: "session.inbox.cancelled",
      serverEventId: "evt_cancel",
      durableAggregateId: "ses_1",
      durableSeq: 10,
      sessionId: "ses_1",
      inboxId: "inb_1",
      promptId: null,
      assistantMessageId: null,
      at: 3,
    });
    expect(store.getIntent("c1")?.state).toBe("confirmed");
  });

  it("does not confirm from dispatch response alone and does not reopen confirmed intents", () => {
    const store = createCancellationFactsStore();
    store.requestIntent({
      intentId: "c2",
      operation: "cancel-queued-prompt",
      requestedAt: 1,
      target: { kind: "queued-prompt", sessionId: "ses_1", promptId: "msg_1", inboxId: "inb_1" },
      state: "target-resolved",
    });
    store.markDispatching("c2", "d1");
    store.recordDispatchResponse("c2", {
      at: 2,
      ok: true,
      status: null,
      interrupted: null,
      errorKind: null,
    });
    expect(store.getIntent("c2")?.state).not.toBe("confirmed");

    store.recordEvidence("c2", {
      kind: "session.inbox.cancelled",
      serverEventId: "evt_cancel",
      durableAggregateId: "ses_1",
      durableSeq: 10,
      sessionId: "ses_1",
      inboxId: "inb_1",
      promptId: null,
      assistantMessageId: null,
      at: 3,
    });
    store.resolveNonConfirmed("c2", "failed", "late");
    expect(store.getIntent("c2")?.state).toBe("confirmed");
  });

  it("keeps execution stop conservative without qualifying confirmation evidence", () => {
    const store = createCancellationFactsStore();
    store.requestIntent({
      intentId: "c3",
      operation: "stop-current-execution",
      requestedAt: 1,
      target: {
        kind: "active-execution",
        sessionId: "ses_1",
        promptId: null,
        inboxId: null,
        assistantMessageId: null,
        scope: "session-wide",
      },
      state: "target-resolved",
    });
    store.markDispatching("c3", "d1");
    store.recordDispatchResponse("c3", {
      at: 2,
      ok: true,
      status: null,
      interrupted: true,
      errorKind: null,
    });
    expect(store.getIntent("c3")?.state).toBe("pending-confirmation");
    store.resolveNonConfirmed("c3", "unknown", "interrupt-unconfirmed");
    expect(store.getIntent("c3")?.state).toBe("unknown");
  });
});
