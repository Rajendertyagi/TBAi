import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyChatStreamsSchema } from "./schema";
import {
  createSqliteResumableStreamStore,
  type SqliteResumableStreamStore,
} from "./sqliteResumableStore";
import {
  getHistoryReconciliationState,
  runHistoryReconciliationOnce,
  startHistoryReconciliation,
  stopHistoryReconciliation,
  type HistoryReconcilerDeps,
} from "./historyReconciler";
import type { FinalUIMessage } from "./historyFinalizer";

/**
 * Contract tests for durable reconciliation of completed runs with outstanding
 * history.
 *
 * The store is a real SQLite store on a private temp file, so the guarded
 * transitions under test (`pending` → `claimed` → `done`/`skipped`, the
 * `terminal_kind='completed'` claim guard, the grace bound) are the production
 * ones rather than a fake's approximation. Message persistence is a Map, because
 * what matters here is how many writes happen and what they contain.
 *
 * The application `db` singleton is never opened, and no real conversation is
 * read or written.
 */

const enc = new TextEncoder();
const CONVERSATION_ID = "conv_reconcile_1";
const USER_MESSAGE_ID = "msg_user_1";
const ANSWER = "the reconciled answer";
const ASSISTANT_MESSAGE_ID = "msg_assistant_1";

const open: Array<{ db: Database; store: SqliteResumableStreamStore; dir: string }> = [];

interface Harness {
  db: Database;
  store: SqliteResumableStreamStore;
  clock: { now: number };
  /** Every write the finalizer attempted, in order. */
  writes: Array<{ conversationId: string; entry: Record<string, unknown> }>;
  /** Ids the client already has in history, i.e. `messageExists` answers from. */
  persisted: Set<string>;
  /** Optional gate held open to force two passes to overlap. */
  gate: { promise: Promise<void>; open: () => void } | null;
  deps: HistoryReconcilerDeps;
}

function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-reconcile-"));
  const db = new Database(path.join(dir, "streams.db"));
  db.run("PRAGMA foreign_keys=ON");
  applyChatStreamsSchema(db);

  const h = {
    db,
    dir,
    clock: { now: 1_700_000_000_000 },
    store: undefined as unknown as SqliteResumableStreamStore,
    writes: [] as Harness["writes"],
    persisted: new Set<string>(),
    gate: null as Harness["gate"],
    deps: undefined as unknown as HistoryReconcilerDeps,
  };

  h.store = createSqliteResumableStreamStore({
    db,
    now: () => h.clock.now,
    pollIntervalMs: 10,
    bootId: "boot_reconcile_test",
    generateLeaseToken: (() => {
      let n = 0;
      return () => `lease_${(n += 1)}`;
    })(),
  });

  h.deps = {
    store: h.store,
    upsertStored: async (conversationId, entry) => {
      if (h.gate) await h.gate.promise;
      h.writes.push({ conversationId, entry: entry as unknown as Record<string, unknown> });
    },
    messageExists: (_conversationId, messageId) => h.persisted.has(messageId),
  };

  open.push(h);
  return h;
}

afterEach(() => {
  stopHistoryReconciliation();
  while (open.length > 0) {
    const h = open.pop()!;
    try {
      h.store.dispose();
    } catch {
      /* already torn down */
    }
    try {
      h.db.close();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(h.dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* best effort on Windows */
    }
  }
});

/** The message shape the route captures at settlement. */
function answerMessage(id = ASSISTANT_MESSAGE_ID): FinalUIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text: ANSWER }] };
}

/**
 * Drive a row to a settled terminal state the way the route does: the row is
 * created by the producer lease, bound to a conversation, settled, and — unless
 * told otherwise — has its final message captured.
 */
async function settledRun(
  h: Harness,
  options: {
    id: string;
    terminalKind: "completed" | "failed" | "cancelled" | "interrupted";
    capture?: FinalUIMessage | null;
    bind?: boolean;
    ageMs?: number;
  },
): Promise<string> {
  const acquisition = await h.store.acquireLease(options.id);
  if (acquisition.role !== "producer") throw new Error("expected producer role");
  const { lease } = acquisition;

  const status = options.terminalKind === "completed" ? "done" : "error";
  if (status === "done") {
    await h.store.append(options.id, enc.encode('{"type":"text"}'), lease);
  } else {
    await h.store.append(options.id, enc.encode('{"type":"error"}'), lease);
  }
  if (options.bind !== false) {
    h.store.bindRunContext(options.id, { conversationId: CONVERSATION_ID });
  }
  await h.store.settleDurable(options.id, { status, terminalKind: options.terminalKind });

  const capture = options.capture === undefined ? answerMessage() : options.capture;
  if (capture) {
    h.store.recordFinalMessage(options.id, { message: capture, parentId: USER_MESSAGE_ID });
  }

  // Age the row past the reconciler's grace window by default: a run that just
  // settled is deliberately not a candidate yet.
  h.clock.now += options.ageMs ?? 10 * 60 * 1000;
  return options.id;
}

function historyStateOf(h: Harness, id: string): string {
  return h.store.getRunContext(id)?.historyState ?? "absent";
}

/**
 * Start a pass with this harness's own deps.
 *
 * The timer is a process singleton, and `tests/integration/shutdown-lifecycle`
 * starts the real server (hence the production deps) in the same `bun test`
 * process. Taking ownership explicitly makes this suite independent of file
 * ordering, instead of relying on no earlier suite having left a timer running.
 */
function startPass(h: Harness, overrides: { graceMs?: number; limit?: number } = {}): void {
  stopHistoryReconciliation();
  const started = startHistoryReconciliation({
    deps: h.deps,
    runImmediately: false,
    graceMs: overrides.graceMs ?? 60 * 1000,
    limit: overrides.limit ?? 50,
    now: () => h.clock.now,
  });
  expect(started).toEqual({ started: true, alreadyRunning: false });
}

// ── 1. The core repair: completed + pending becomes one written message ──────
describe("history reconciliation — outstanding completed run", () => {
  it("writes the captured assistant message exactly once and closes the obligation", async () => {
    const h = harness();
    const id = await settledRun(h, { id: "run_a", terminalKind: "completed" });
    expect(historyStateOf(h, id)).toBe("pending");
    startPass(h);

    const report = await runHistoryReconciliationOnce();

    expect(report).toMatchObject({ scanned: 1, written: 1, failed: 0 });
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].conversationId).toBe(CONVERSATION_ID);
    expect(h.writes[0].entry.id).toBe(ASSISTANT_MESSAGE_ID);
    expect(h.writes[0].entry.parent_id).toBe(USER_MESSAGE_ID);
    expect(historyStateOf(h, id)).toBe("done");
  });

  it("stores the adapter's shape: the id in the row, never inside content", async () => {
    const h = harness();
    await settledRun(h, { id: "run_shape", terminalKind: "completed" });
    startPass(h);
    await runHistoryReconciliationOnce();

    const content = h.writes[0].entry.content as Record<string, unknown>;
    expect(content.id).toBeUndefined();
    expect(content.role).toBe("assistant");
    expect(h.writes[0].entry.format).toBe("ai-sdk/v6");
  });

  it("leaves a run inside the grace window alone, so a live client is never raced", async () => {
    const h = harness();
    // ageMs 0: the run settled this instant, and its client may still be writing.
    const id = await settledRun(h, { id: "run_fresh", terminalKind: "completed", ageMs: 0 });
    startPass(h);

    const report = await runHistoryReconciliationOnce();

    expect(report).toMatchObject({ scanned: 0 });
    expect(h.writes).toHaveLength(0);
    expect(historyStateOf(h, id)).toBe("pending");
  });

  it("is idempotent: a second pass finds nothing and writes nothing more", async () => {
    const h = harness();
    await settledRun(h, { id: "run_idem", terminalKind: "completed" });
    startPass(h);

    const first = await runHistoryReconciliationOnce();
    const second = await runHistoryReconciliationOnce();

    expect(first).toMatchObject({ written: 1 });
    expect(second).toMatchObject({ scanned: 0, written: 0 });
    expect(h.writes).toHaveLength(1);
  });

  it("skips an already-finalized row without touching it", async () => {
    const h = harness();
    const id = await settledRun(h, { id: "run_done", terminalKind: "completed" });
    h.store.claimHistory(id, ASSISTANT_MESSAGE_ID);
    h.store.completeHistory(id);
    startPass(h);

    const report = await runHistoryReconciliationOnce();

    expect(report).toMatchObject({ scanned: 0, written: 0 });
    expect(h.writes).toHaveLength(0);
    expect(historyStateOf(h, id)).toBe("done");
  });
});

// ── 2. Only completed runs are ever reconciled ────────────────────────────────
describe("history reconciliation — non-completed outcomes", () => {
  for (const kind of ["failed", "cancelled", "interrupted"] as const) {
    it(`never finalizes a ${kind} run, even with a captured message`, async () => {
      const h = harness();
      // The message is written directly, bypassing the route's guard, so this
      // asserts the store's guard rather than the route's cooperation.
      const id = `run_${kind}`;
      const acquisition = await h.store.acquireLease(id);
      if (acquisition.role !== "producer") throw new Error("expected producer role");
      h.store.bindRunContext(id, { conversationId: CONVERSATION_ID });
      await h.store.settleDurable(id, { status: "error", terminalKind: kind });
      h.db
        .query("UPDATE chat_streams SET final_message_json = ? WHERE stream_id = ?")
        .run(JSON.stringify(answerMessage()), id);
      h.clock.now += 10 * 60 * 1000;
      startPass(h);

      const report = await runHistoryReconciliationOnce();

      expect(report).toMatchObject({ scanned: 0, written: 0 });
      expect(h.writes).toHaveLength(0);
      // Untouched: still pending, because a non-completed run has no reply to
      // write and must not be closed as if it did.
      expect(historyStateOf(h, id)).toBe("pending");
    });
  }

  it("never considers a still-streaming row", async () => {
    const h = harness();
    const acquisition = await h.store.acquireLease("run_live");
    if (acquisition.role !== "producer") throw new Error("expected producer role");
    h.store.bindRunContext("run_live", { conversationId: CONVERSATION_ID });
    h.db
      .query("UPDATE chat_streams SET final_message_json = ? WHERE stream_id = ?")
      .run(JSON.stringify(answerMessage()), "run_live");
    h.clock.now += 10 * 60 * 1000;
    startPass(h);

    const report = await runHistoryReconciliationOnce();

    expect(report).toMatchObject({ scanned: 0 });
    expect(h.writes).toHaveLength(0);
    expect(await h.store.status("run_live")).toBe("streaming");
  });
});

// ── 3. Nothing is ever invented ───────────────────────────────────────────────
describe("history reconciliation — no fabrication", () => {
  it("reports a row with no captured message and closes it as skipped", async () => {
    const h = harness();
    // No `capture`: the run produced nothing persistable (or predates capture).
    const id = await settledRun(h, { id: "run_nocap", terminalKind: "completed", capture: null });
    startPass(h);

    const report = await runHistoryReconciliationOnce();

    expect(report).toMatchObject({ scanned: 1, unrecoverable: 1, written: 0 });
    expect(h.writes).toHaveLength(0);
    expect(historyStateOf(h, id)).toBe("skipped");
  });

  it("refuses to write a corrupt capture instead of guessing at its content", async () => {
    const h = harness();
    const id = "run_corrupt";
    const acquisition = await h.store.acquireLease(id);
    if (acquisition.role !== "producer") throw new Error("expected producer role");
    h.store.bindRunContext(id, { conversationId: CONVERSATION_ID });
    await h.store.settleDurable(id, { status: "done", terminalKind: "completed" });
    h.db
      .query("UPDATE chat_streams SET final_message_json = ? WHERE stream_id = ?")
      .run("{not json", id);
    h.clock.now += 10 * 60 * 1000;
    startPass(h);

    const report = await runHistoryReconciliationOnce();

    expect(report).toMatchObject({ scanned: 1, unrecoverable: 1, written: 0 });
    expect(h.writes).toHaveLength(0);
    expect(historyStateOf(h, id)).toBe("skipped");
  });

  it("rejects a capture that is not a usable assistant message", async () => {
    const h = harness();
    const id = "run_partial";
    const acquisition = await h.store.acquireLease(id);
    if (acquisition.role !== "producer") throw new Error("expected producer role");
    h.store.bindRunContext(id, { conversationId: CONVERSATION_ID });
    await h.store.settleDurable(id, { status: "done", terminalKind: "completed" });
    // An empty `parts` array is the signature of partial output, which must
    // never become a message.
    h.db
      .query("UPDATE chat_streams SET final_message_json = ? WHERE stream_id = ?")
      .run(JSON.stringify({ id: "m", role: "assistant", parts: [] }), id);
    h.clock.now += 10 * 60 * 1000;
    startPass(h);

    const report = await runHistoryReconciliationOnce();

    expect(report).toMatchObject({ written: 0, skipped: 1 });
    expect(h.writes).toHaveLength(0);
    expect(historyStateOf(h, id)).toBe("skipped");
  });

  it("skips a run with no conversation rather than writing an orphan message", async () => {
    const h = harness();
    const id = await settledRun(h, {
      id: "run_noconv",
      terminalKind: "completed",
      bind: false,
    });
    startPass(h);

    const report = await runHistoryReconciliationOnce();

    expect(report).toMatchObject({ written: 0, skipped: 1 });
    expect(h.writes).toHaveLength(0);
    expect(historyStateOf(h, id)).toBe("skipped");
  });
});

// ── 4. The client race, in both orders ────────────────────────────────────────
describe("history reconciliation — racing the client", () => {
  it("client persisted first: closes the obligation without writing or overwriting", async () => {
    const h = harness();
    const id = await settledRun(h, { id: "run_clientfirst", terminalKind: "completed" });
    // The browser got there first, through the assistant-ui history adapter.
    h.persisted.add(ASSISTANT_MESSAGE_ID);
    startPass(h);

    const report = await runHistoryReconciliationOnce();

    expect(report).toMatchObject({ scanned: 1, alreadyPersisted: 1, written: 0 });
    expect(h.writes).toHaveLength(0);
    expect(historyStateOf(h, id)).toBe("done");
  });

  it("reconciliation first: the client's later write converges on the same row", async () => {
    const h = harness();
    const id = await settledRun(h, { id: "run_serverfirst", terminalKind: "completed" });
    startPass(h);
    await runHistoryReconciliationOnce();
    expect(h.writes).toHaveLength(1);

    // The client now persists the same message id, as the adapter would.
    h.persisted.add(ASSISTANT_MESSAGE_ID);

    // A second pass can only be a no-op, which is the convergence guarantee.
    const second = await runHistoryReconciliationOnce();
    expect(second).toMatchObject({ scanned: 0, written: 0 });
    expect(h.writes).toHaveLength(1);
    expect(historyStateOf(h, id)).toBe("done");
  });

  it("a claim lost to a concurrent finalizer is not an error and writes nothing", async () => {
    const h = harness();
    const id = await settledRun(h, { id: "run_race", terminalKind: "completed" });

    // A row whose history is already `claimed` is not even a candidate — the
    // scan selects `pending` only. So the race to defend against is one that
    // lands *between* the scan and the claim, which is what this proxy simulates:
    // the scan returns the row, and a competing finalizer claims it first.
    const realStore = h.store;
    h.deps = {
      ...h.deps,
      store: {
        ...realStore,
        listPendingCompletedHistory: (options: { before: number; limit: number }) => {
          const rows = realStore.listPendingCompletedHistory(options);
          for (const row of rows) realStore.claimHistory(row.streamId, ASSISTANT_MESSAGE_ID);
          return rows;
        },
      } as unknown as HistoryReconcilerDeps["store"],
    };
    startPass(h);

    const report = await runHistoryReconciliationOnce();

    expect(report).toMatchObject({ scanned: 1, notClaimed: 1, written: 0 });
    expect(h.writes).toHaveLength(0);
    expect(historyStateOf(h, id)).toBe("claimed");
  });

  it("never even looks at a row another finalizer has already claimed", async () => {
    const h = harness();
    const id = await settledRun(h, { id: "run_claimed", terminalKind: "completed" });
    h.store.claimHistory(id, ASSISTANT_MESSAGE_ID);
    startPass(h);

    const report = await runHistoryReconciliationOnce();

    expect(report).toMatchObject({ scanned: 0 });
    expect(h.writes).toHaveLength(0);
  });
});

// ── 5. Bounded, non-overlapping, stoppable ────────────────────────────────────
describe("history reconciliation — pass bounds and lifecycle", () => {
  it("drains a backlog in bounded batches, oldest first", async () => {
    const h = harness();
    // Each run settles a full grace window apart, so all three are candidates and
    // their `updated_at` order is the drain order.
    for (let i = 0; i < 3; i += 1) {
      await settledRun(h, {
        id: `run_b${i}`,
        terminalKind: "completed",
        capture: answerMessage(`msg_assistant_b${i}`),
        ageMs: (i + 1) * 10 * 60 * 1000,
      });
    }
    startPass(h, { limit: 2 });

    const first = await runHistoryReconciliationOnce();
    expect(first).toMatchObject({ scanned: 2, written: 2 });
    expect(h.writes.map((w) => w.entry.id)).toEqual(["msg_assistant_b0", "msg_assistant_b1"]);

    const second = await runHistoryReconciliationOnce();
    expect(second).toMatchObject({ scanned: 1, written: 1 });
    expect(h.writes.map((w) => w.entry.id)).toEqual([
      "msg_assistant_b0",
      "msg_assistant_b1",
      "msg_assistant_b2",
    ]);
  });

  it("refuses to start a second overlapping pass", async () => {
    const h = harness();
    await settledRun(h, { id: "run_slow", terminalKind: "completed" });
    let open = (): void => {};
    h.gate = { promise: new Promise<void>((r) => (open = r)), open: () => {} };
    startPass(h);

    const first = runHistoryReconciliationOnce();
    // Let the pass reach the gated write before the second is attempted.
    await new Promise((r) => setTimeout(r, 5));
    expect(getHistoryReconciliationState().inFlight).toBe(true);

    const second = await runHistoryReconciliationOnce();
    expect(second).toBeNull();

    open();
    expect(await first).toMatchObject({ written: 1 });
  });

  it("returns null and writes nothing when reconciliation was never started", async () => {
    const h = harness();
    stopHistoryReconciliation();
    expect(await runHistoryReconciliationOnce()).toBeNull();
  });

  it("start is idempotent, ticks, and stop clears the timer", async () => {
    const h = harness();
    await settledRun(h, { id: "run_life", terminalKind: "completed" });

    stopHistoryReconciliation();
    const first = startHistoryReconciliation({
      deps: h.deps,
      intervalMs: 5,
      graceMs: 0,
      runImmediately: false,
      now: () => h.clock.now,
    });
    expect(first).toEqual({ started: true, alreadyRunning: false });

    const second = startHistoryReconciliation({ deps: h.deps, runImmediately: false });
    expect(second).toEqual({ started: false, alreadyRunning: true });
    expect(getHistoryReconciliationState().running).toBe(true);

    // The timer really fires, and the boot-bounded row is picked up.
    await new Promise((r) => setTimeout(r, 30));
    expect(getHistoryReconciliationState().ticks).toBeGreaterThan(0);
    expect(h.writes).toHaveLength(1);

    expect(stopHistoryReconciliation()).toBe(true);
    expect(getHistoryReconciliationState().running).toBe(false);
    expect(stopHistoryReconciliation()).toBe(false);
  });

  it("a write that throws leaves a truthful skipped state, never a bare claim", async () => {
    const h = harness();
    const id = await settledRun(h, { id: "run_throw", terminalKind: "completed" });
    h.deps.upsertStored = async () => {
      throw new Error("disk gone");
    };
    startPass(h);

    const report = await runHistoryReconciliationOnce();

    expect(report).toMatchObject({ failed: 1 });
    expect(historyStateOf(h, id)).toBe("skipped");
  });
});
