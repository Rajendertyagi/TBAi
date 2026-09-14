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
