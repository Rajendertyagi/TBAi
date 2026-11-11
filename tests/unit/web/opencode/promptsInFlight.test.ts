import { describe, expect, it } from "bun:test";
import {
  createPromptsInFlight,
  type V2PromptCapacitySnapshot,
} from "@web/features/opencode/sync/promptsInFlight.ts";

const SESSION = "ses_test";

describe("promptsInFlight", () => {
  it("settles verdict once and allows monotonic metadata enrichment after admission", async () => {
    const prompts = createPromptsInFlight();
    prompts.create(SESSION, "msg_1");
    const admission = prompts.awaitAdmission("msg_1");

    prompts.settleVerdict("msg_1", "admitted", {
      sessionId: SESSION,
      promptId: "msg_1",
      source: "http-response",
      inboxId: "inb_1",
      delivery: "queue",
      establishedRequestCorrelation: true,
    });
    await expect(admission).resolves.toBe("admitted");

    // Enrichment must not regress verdict or notify admission waiters again.
    const enriched = prompts.enrich("msg_1", {
      sessionId: SESSION,
      promptId: "msg_1",
      source: "inbox-event",
      serverEventId: "evt_1",
      inboxId: "inb_1",
      delivery: "queue",
      exactCorrelation: true,
    });
    expect(enriched?.verdict).toBe("admitted");
    expect(enriched?.inboxId.value).toBe("inb_1");
    expect(enriched?.delivery.value).toBe("queue");
  });

  it("keeps admission waiters eligible across ambiguity and admits on later valid evidence", async () => {
    const prompts = createPromptsInFlight();
    prompts.create(SESSION, "msg_2");
    const waiter = prompts.awaitAdmission("msg_2");
    prompts.markAmbiguous("msg_2", {
      sessionId: SESSION,
      promptId: "msg_2",
      source: "reconciliation",
    });
    expect(prompts.getAdmissionResult("msg_2")).toBe("ambiguous");

    prompts.settleVerdict("msg_2", "admitted", {
      sessionId: SESSION,
      promptId: "msg_2",
      source: "history",
      serverMessageId: "msg_2",
    });
    await expect(waiter).resolves.toBe("admitted");
    expect(prompts.getAdmissionResult("msg_2")).toBe("admitted");
  });

  it("does not correlate inbox events without exact proof", () => {
    const prompts = createPromptsInFlight();
    prompts.create(SESSION, "msg_local");
    prompts.enrich("msg_local", {
      sessionId: SESSION,
      promptId: "msg_local",
      source: "inbox-event",
      serverEventId: "evt_x",
      inboxId: "inb_other",
      delivery: "queue",
      exactCorrelation: false,
    });
    const record = prompts.get("msg_local");
    expect(record?.inboxId.value).toBeNull();
    expect(record?.verdict).toBeNull();
  });

  it("applies backpressure at hard/protected capacity", () => {
    const prompts = createPromptsInFlight({
      softCap: 2,
      protectedCap: 2,
      hardCap: 2,
      ttlMs: 60_000,
    });
    expect(prompts.create(SESSION, "a").ok).toBe(true);
    expect(prompts.create(SESSION, "b").ok).toBe(true);
    const third = prompts.create(SESSION, "c");
    expect(third.ok).toBe(false);
    if (third.ok === false) expect(third.reason).toBe("capacity-backpressure");
  });
});

describe("promptsInFlight capacity policy", () => {
  it("refuses at the hard cap when nothing is evictable, then recovers once a prompt settles", () => {
    const prompts = createPromptsInFlight({
      softCap: 2,
      protectedCap: 2,
      hardCap: 2,
      ttlMs: 60_000,
    });
    expect(prompts.create(SESSION, "live_a").ok).toBe(true);
    expect(prompts.create(SESSION, "live_b").ok).toBe(true);

    // Both are submitting, so neither is evictable: the registry cannot make
    // room without dropping an unanswered prompt, which is exactly the state
    // that must refuse instead of silently exceeding the cap.
    const refused = prompts.create(SESSION, "live_c");
    expect(refused.ok).toBe(false);
    if (refused.ok === false) {
      expect(refused.reason).toBe("capacity-backpressure");
      expect(refused.capacity.backpressure).toBe(true);
      expect(refused.capacity.atHardCap).toBe(true);
      expect(refused.capacity.evictableCount).toBe(0);
    }
    expect(prompts.get("live_c")).toBeUndefined();

    // One prompt settles. It is now evictable, so a send can make room by
    // evicting it rather than waiting for the TTL sweep.
    prompts.settleVerdict("live_b", "admitted", {
      sessionId: SESSION,
      promptId: "live_b",
      source: "http-response",
      establishedRequestCorrelation: true,
    });
    const after = prompts.getSnapshot();
    expect(after.capacity.backpressure).toBe(false);
    expect(after.capacity.evictableCount).toBe(1);

    const admitted = prompts.create(SESSION, "live_c");
    expect(admitted.ok).toBe(true);
    // The settled prompt made room; the still-submitting one did not.
    expect(prompts.get("live_b")).toBeUndefined();
    expect(prompts.get("live_a")).toBeDefined();
    expect(prompts.get("live_c")).toBeDefined();
    expect(prompts.size).toBe(2);
    // Both remaining prompts are live, so the registry is truthfully at its cap
    // again: the send used the one slot that settling made available.
    expect(prompts.getSnapshot().capacity.backpressure).toBe(true);
    expect(prompts.getSnapshot().capacity.evictableCount).toBe(0);
  });

  it("refuses at the protected cap below the hard cap and never evicts a protected prompt", () => {
    const prompts = createPromptsInFlight({
      softCap: 10,
      protectedCap: 2,
      hardCap: 10,
      ttlMs: 60_000,
    });
    expect(prompts.create(SESSION, "kept_a").ok).toBe(true);
    expect(prompts.create(SESSION, "kept_b").ok).toBe(true);
    prompts.settleVerdict("kept_a", "admitted");
    prompts.settleVerdict("kept_b", "admitted");
    const tokenA = prompts.acquireProtection("kept_a", "controller-binding");
    const tokenB = prompts.acquireProtection("kept_b", "controller-binding");
    expect(tokenA).not.toBeNull();
    expect(tokenB).not.toBeNull();

    const refused = prompts.create(SESSION, "third");
    expect(refused.ok).toBe(false);
    if (refused.ok === false) {
      expect(refused.capacity.atProtectedCap).toBe(true);
      expect(refused.capacity.atHardCap).toBe(false);
      expect(refused.capacity.backpressure).toBe(true);
    }

    // Even a sweep past every TTL keeps both protected records.
    prompts.sweep(Date.now() + 86_400_000);
    expect(prompts.get("kept_a")).toBeDefined();
    expect(prompts.get("kept_b")).toBeDefined();
    expect(prompts.size).toBe(2);
  });

  it("releases only the caller's own protection token", () => {
    const prompts = createPromptsInFlight();
    prompts.create(SESSION, "msg_owned");
    prompts.settleVerdict("msg_owned", "admitted");
    const first = prompts.acquireProtection("msg_owned", "admission-waiter");
    const second = prompts.acquireProtection("msg_owned", "outcome-waiter");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(prompts.get("msg_owned")?.protectedOwners).toEqual([first, second]);
    expect(prompts.protectedCount).toBe(1);

    if (first === null) throw new Error("expected a protection token");
    prompts.releaseProtection("msg_owned", first);
    expect(prompts.get("msg_owned")?.protectedOwners).toEqual([second]);
    expect(prompts.protectedCount).toBe(1);

    if (second === null) throw new Error("expected a protection token");
    prompts.releaseProtection("msg_owned", second);
    expect(prompts.get("msg_owned")?.protectedOwners).toEqual([]);
    expect(prompts.protectedCount).toBe(0);
  });

  it("reports capacity that agrees with the measured records and the policy", () => {
    const policy = {
      softCap: 3,
      protectedCap: 5,
      hardCap: 9,
      ttlMs: 60_000,
    };
    const prompts = createPromptsInFlight(policy);
    expect(prompts.getSnapshot().capacity).toEqual({
      size: 0,
      softCap: 3,
      protectedCap: 5,
      hardCap: 9,
      protectedCount: 0,
      evictableCount: 0,
      atSoftCap: false,
      atProtectedCap: false,
      atHardCap: false,
      backpressure: false,
    } satisfies V2PromptCapacitySnapshot);

    prompts.create(SESSION, "a");
    prompts.create(SESSION, "b");
    prompts.create(SESSION, "c");
    prompts.settleVerdict("a", "admitted");
    prompts.acquireProtection("b", "cancellation-intent");
    const snapshot = prompts.getSnapshot();
    expect(snapshot.size).toBe(3);
    expect(snapshot.capacity.size).toBe(snapshot.size);
    expect(snapshot.capacity.size).toBe(snapshot.records.length);
    expect(snapshot.capacity.protectedCount).toBe(1);
    expect(snapshot.capacity.evictableCount).toBe(1);
    expect(snapshot.capacity.atSoftCap).toBe(true);
    expect(snapshot.capacity.atHardCap).toBe(false);
    expect(snapshot.capacity.backpressure).toBe(false);
  });

  it("never announces an admission that a rollback then discarded", async () => {
    const prompts = createPromptsInFlight();
    prompts.create(SESSION, "msg_deferred");
    const observed: string[] = [];
    void prompts.awaitAdmission("msg_deferred").then((result) => observed.push(result));
    const restorePoint = prompts.captureRestorePoint();

    prompts.beginNotificationDeferral();
    prompts.settleVerdict("msg_deferred", "admitted", {
      sessionId: SESSION,
      promptId: "msg_deferred",
      source: "http-response",
      establishedRequestCorrelation: true,
    });
    // The transition failed: facts roll back and the pending notification is
    // discarded, so the caller is never told the rolled-back verdict.
    prompts.restoreRestorePoint(restorePoint);
    prompts.discardNotificationDeferral();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed).toEqual([]);
    expect(prompts.get("msg_deferred")?.verdict).toBeNull();

    // The evidence arrives for real, commits, and then the caller is told.
    prompts.beginNotificationDeferral();
    prompts.settleVerdict("msg_deferred", "admitted", {
      sessionId: SESSION,
      promptId: "msg_deferred",
      source: "http-response",
      establishedRequestCorrelation: true,
    });
    prompts.flushNotificationDeferral();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed).toEqual(["admitted"]);
  });

  it("restores protection tokens with the recorded facts so a later release still works", () => {
    const prompts = createPromptsInFlight();
    prompts.create(SESSION, "msg_token");
    const token = prompts.acquireProtection("msg_token", "controller-binding");
    if (token === null) throw new Error("expected a protection token");
    const restorePoint = prompts.captureRestorePoint();

    prompts.settleVerdict("msg_token", "admitted");
    prompts.releaseProtection("msg_token", token);
    expect(prompts.get("msg_token")?.protectedOwners).toEqual([]);

    prompts.restoreRestorePoint(restorePoint);
    expect(prompts.get("msg_token")?.protectedOwners).toEqual([token]);
    expect(prompts.get("msg_token")?.verdict).toBeNull();

    prompts.releaseProtection("msg_token", token);
    expect(prompts.get("msg_token")?.protectedOwners).toEqual([]);
  });
});
