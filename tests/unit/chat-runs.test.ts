import { describe, it, expect } from "bun:test";
import { createChatRunStore } from "../../src/services/chat-runs";

describe("chat run registry", () => {
  it("creates running records with unique ids and an own controller", () => {
    const store = createChatRunStore();
    const a = store.create({ requestId: "req-1" });
    const b = store.create({ requestId: "req-2" });
    expect(a.status).toBe("running");
    expect(a.streamId).not.toBe(b.streamId);
    expect(a.controller).toBeInstanceOf(AbortController);
    expect(a.controller).not.toBe(b.controller);
    expect(store.get(a.streamId)).toBe(a);
    expect(store.get("missing")).toBeUndefined();
  });

  it("settles terminal states exactly once (concurrent completions race safe)", () => {
    const store = createChatRunStore();
    const rec = store.create({});
    expect(store.markCompleted(rec.streamId)).toBe(true);
    expect(store.markCompleted(rec.streamId)).toBe(false);
    expect(store.markFailed(rec.streamId)).toBe(false);
    expect(store.markCancelled(rec.streamId)).toBe(false);
    expect(rec.status).toBe("completed");
  });

  it("tracks detach/attach as orthogonal flags", () => {
    const store = createChatRunStore();
    const rec = store.create({});
    expect(store.markDetached(rec.streamId)).toBe(true);
    expect(rec.detachedAt).not.toBeNull();
    expect(store.markDetached(rec.streamId)).toBe(false);
    expect(store.attach(rec.streamId)).toBe(true);
    expect(rec.detachedAt).toBeNull();
    expect(store.attach(rec.streamId)).toBe(false);
    store.markCompleted(rec.streamId);
    expect(store.markDetached(rec.streamId)).toBe(false);
  });

  it("sweeps only old terminal records, never running ones", () => {
    let now = 1_000_000;
    const store = createChatRunStore({ now: () => now, recordTtlMs: 1000 });
    const old = store.create({});
    store.markFailed(old.streamId);
    now += 10_000;
    // Explicit sweep (no intervening create): prunes exactly the old terminal.
    expect(store.sweep().pruned).toBe(1);
    expect(store.get(old.streamId)).toBeUndefined();
    // create() sweeps implicitly too; fresh terminal + running survive.
    const fresh = store.create({});
    store.markFailed(fresh.streamId);
    const running = store.create({});
    expect(store.get(fresh.streamId)).toBeDefined();
    expect(store.get(running.streamId)).toBeDefined();
  });

  it("caps total records oldest-terminal-first", () => {
    let now = 1_000_000;
    const store = createChatRunStore({ now: () => now, recordTtlMs: 60_000, maxRecords: 3 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      now += 10;
      const rec = store.create({});
      store.markCompleted(rec.streamId);
      ids.push(rec.streamId);
    }
    const live = store.create({});
    expect(store.get(ids[0])).toBeUndefined();
    expect(store.get(ids[3])).toBeDefined();
    expect(store.get(live.streamId)).toBeDefined();
    expect(store.counts()).toEqual({ running: 1, completed: 3, failed: 0, cancelled: 0 });
  });

  it("wall clock aborts hung runs and flags timedOut (route owns the transition)", async () => {
    const store = createChatRunStore({ wallTimeoutMs: 40 });
    const rec = store.create({});
    let aborted = false;
    rec.controller.signal.addEventListener("abort", () => {
      aborted = true;
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(aborted).toBe(true);
    expect(rec.timedOut).toBe(true);
    // Status stays running until the route's onAbort observes the flag and
    // records failed — the registry never logs, the funnel does.
    expect(rec.status).toBe("running");
    expect(store.markFailed(rec.streamId)).toBe(true);
  });

  it("unknown ids are safe no-ops", () => {
    const store = createChatRunStore();
    expect(store.markCompleted("nope")).toBe(false);
    expect(store.markFailed("nope")).toBe(false);
    expect(store.markCancelled("nope")).toBe(false);
    expect(store.markDetached("nope")).toBe(false);
    expect(store.attach("nope")).toBe(false);
    expect(store.sweep().pruned).toBe(0);
  });
});

describe("abortAll (shutdown spine)", () => {
  it("aborts every running controller, leaves terminal records untouched, status unchanged", () => {
    const store = createChatRunStore();
    const a = store.create({});
    const b = store.create({});
    const c = store.create({});
    store.markCompleted(c.streamId);

    expect(a.status).toBe("running");
    expect(b.status).toBe("running");
    expect(c.status).toBe("completed");

    const aborted = store.abortAll();
    expect(aborted).toBe(2);
    expect(a.controller.signal.aborted).toBe(true);
    expect(b.controller.signal.aborted).toBe(true);
    expect(c.controller.signal.aborted).toBe(false);

    // abortAll does NOT change status — the chat route's onAbort owns
    // the running → failed/cancelled transition.
    expect(a.status).toBe("running");
    expect(b.status).toBe("running");
    expect(c.status).toBe("completed");
  });

  it("idempotent: calling abortAll repeatedly is safe and never throws", () => {
    const store = createChatRunStore();
    const a = store.create({});
    const b = store.create({});
    store.markCompleted(store.create({}).streamId);
    expect(store.abortAll()).toBe(2);
    // Second call: nothing is terminal-changed, the two running records are
    // still "running" (the route owns the transition) and their controllers
    // are already aborted, so the records are still counted as running.
    expect(store.abortAll()).toBe(2);
    // Settling one running record excludes it from the next call.
    store.markCancelled(a.streamId);
    // After abortAll the store is gated: create() returns a terminal cancelled
    // record (never a fresh running one), so it is not counted as running.
    const rec = store.create({});
    expect(rec.status).toBe("cancelled");
    expect(rec.controller.signal.aborted).toBe(true);
    // b is the only remaining running-status record.
    expect(store.abortAll()).toBe(1);
    expect(b.controller.signal.aborted).toBe(true);
    expect(a.controller.signal.aborted).toBe(true);
  });

  it("empty store returns 0 and does not throw", () => {
    const store = createChatRunStore();
    expect(store.abortAll()).toBe(0);
    // Safe to call multiple times.
    expect(store.abortAll()).toBe(0);
  });

  it("clears the wall-clock timer so it no longer fires", () => {
    const store = createChatRunStore({ wallTimeoutMs: 50 });
    const rec = store.create({});
    expect(rec.timeoutHandle !== undefined).toBe(true);
    const aborted = store.abortAll();
    expect(aborted).toBe(1);
    // Timer was cleared by abortAll; the record is still running but its
    // controller is already aborted.
    expect(rec.controller.signal.aborted).toBe(true);
    // After settling, the record is terminal.
    store.markCancelled(rec.streamId);
    expect(rec.status).toBe("cancelled");
  });
});

describe("abortAll vs completion race (Phase 3)", () => {
  it("abortAll before completion: run is cancelled, not completed", () => {
    const store = createChatRunStore();
    const rec = store.create({});
    expect(rec.status).toBe("running");
    // Shutdown aborts first — the route's onAbort will mark it cancelled.
    expect(store.abortAll()).toBe(1);
    expect(store.markCancelled(rec.streamId)).toBe(true);
    expect(rec.status).toBe("cancelled");
    // A late completion attempt is a no-op (terminal state already set).
    expect(store.markCompleted(rec.streamId)).toBe(false);
    expect(rec.status).toBe("cancelled");
  });

  it("abortAll after completion: terminal completed record is untouched", () => {
    const store = createChatRunStore();
    const rec = store.create({});
    // Run completes normally before shutdown begins.
    expect(store.markCompleted(rec.streamId)).toBe(true);
    expect(rec.status).toBe("completed");
    // abortAll must not count or touch already-terminal records.
    expect(store.abortAll()).toBe(0);
    expect(rec.status).toBe("completed");
    expect(rec.controller.signal.aborted).toBe(false);
  });

  it("client abort (detach) vs shutdown abort: both safe, settlement consistent", () => {
    const store = createChatRunStore();
    const a = store.create({});
    const b = store.create({});
    // Client connection drops for a (detach only — run continues).
    expect(store.markDetached(a.streamId)).toBe(true);
    // Shutdown aborts both running controllers.
    expect(store.abortAll()).toBe(2);
    expect(a.controller.signal.aborted).toBe(true);
    expect(b.controller.signal.aborted).toBe(true);
    // Route settles a as cancelled (client-initiated cancel observed later),
    // b as cancelled (shutdown-initiated). Both terminal.
    expect(store.markCancelled(a.streamId)).toBe(true);
    expect(store.markCancelled(b.streamId)).toBe(true);
    // Counts reflect the terminal outcomes, not the detach flag.
    expect(store.counts()).toEqual({ running: 0, completed: 0, failed: 0, cancelled: 2 });
  });

  it("repeated abortAll: second call is a no-op on already-aborted controllers", () => {
    const store = createChatRunStore();
    store.create({});
    store.create({});
    expect(store.abortAll()).toBe(2);
    // Gate is now set; create() returns terminal cancelled records.
    const late = store.create({});
    expect(late.status).toBe("cancelled");
    expect(late.controller.signal.aborted).toBe(true);
    // Second abortAll: only still-running-status records are counted.
    // The two original records remain running-status (route owns the
    // transition), so they are still aborted.
    expect(store.abortAll()).toBe(2);
  });

  it("abortAll after every run completed: returns 0, no side effects", () => {
    const store = createChatRunStore();
    const a = store.create({});
    const b = store.create({});
    store.markCompleted(a.streamId);
    store.markFailed(b.streamId);
    expect(store.abortAll()).toBe(0);
    expect(a.status).toBe("completed");
    expect(b.status).toBe("failed");
    // No records were aborted, so no timer cleared as a side effect.
    expect(store.counts()).toEqual({ running: 0, completed: 1, failed: 1, cancelled: 0 });
  });
});

describe("chat run settlement + shutdown gate", () => {
  it("create() after abortAll returns a terminal cancelled record", () => {
    const store = createChatRunStore();
    const a = store.create({});
    expect(store.abortAll()).toBe(1);
    const rec = store.create({ requestId: "late" });
    expect(rec.status).toBe("cancelled");
    expect(rec.controller.signal.aborted).toBe(true);
    // a is still running-status (the route owns the transition); rec is terminal.
    expect(store.counts()).toEqual({ running: 1, completed: 0, failed: 0, cancelled: 1 });
    // Terminal transitions on the gated record are safe no-ops.
    expect(store.markCancelled(rec.streamId)).toBe(false);
  });

  it("settled resolves on every terminal transition", async () => {
    const store = createChatRunStore();
    const completed = store.create({});
    const failed = store.create({});
    const cancelled = store.create({});
    let completedSettled = false;
    let failedSettled = false;
    let cancelledSettled = false;
    void completed.settled.then(() => {
      completedSettled = true;
    });
    void failed.settled.then(() => {
      failedSettled = true;
    });
    void cancelled.settled.then(() => {
      cancelledSettled = true;
    });
    store.markCompleted(completed.streamId);
    store.markFailed(failed.streamId);
    store.markCancelled(cancelled.streamId);
    await new Promise((r) => setTimeout(r, 0));
    expect(completedSettled).toBe(true);
    expect(failedSettled).toBe(true);
    expect(cancelledSettled).toBe(true);
  });

  it("awaitSettled resolves immediately when nothing is running", async () => {
    const store = createChatRunStore();
    const rec = store.create({});
    store.markCompleted(rec.streamId);
    const result = await store.awaitSettled(100);
    expect(result).toEqual({ settled: 0, timedOut: 0 });
  });

  it("awaitSettled waits for in-flight runs and reports timedOut on bound", async () => {
    const store = createChatRunStore();
    const a = store.create({});
    const b = store.create({});
    // a settles quickly; b stays running past the bound.
    setTimeout(() => store.markCancelled(a.streamId), 20);
    const result = await store.awaitSettled(100);
    expect(result.settled).toBe(1);
    expect(result.timedOut).toBe(1);
    // b is still running (the route owns the transition).
    expect(b.status).toBe("running");
    store.markCancelled(b.streamId);
  });
});
