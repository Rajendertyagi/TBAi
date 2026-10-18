import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { db } from "@/db";
import { DB_PATH } from "@/config/data-dir.ts";
import { DEFAULT_UNRESOLVED_HISTORY_HOLD_MS } from "@/db/schema/chat-streams.ts";
import {
  ASSISTANT_UI_STORAGE_FORMAT,
  type FinalUIMessage,
  type HistoryPersistStore,
} from "@/services/chat-streams/historyFinalizer.ts";
import {
  drainHistoryReconciliation,
  getHistoryReconciliationState,
  runHistoryReconciliationOnce,
  startHistoryReconciliation,
  stopHistoryReconciliation,
  type HistoryReconcilerDeps,
} from "@/services/chat-streams/historyReconciler.ts";
import { recoverOrphanedChatStreams } from "@/services/chat-streams/boot.ts";
import {
  DEFAULT_CLAIMED_RECOVERY_PAGE_SIZE,
  DEFAULT_STALE_HISTORY_CLAIM_MS,
  type ClaimedHistoryRecoveryDeps,
  type ClaimedRecoveryReport,
  type RecoverStaleClaimedHistoryOptions,
  drainClaimedHistoryRecovery,
  getClaimedHistoryRecoveryState,
  recoverStaleClaimedHistory,
  runClaimedHistoryRecoveryOnce,
  startClaimedHistoryRecovery,
  stopClaimedHistoryRecovery,
} from "@/services/chat-streams/claimedHistoryRecovery.ts";
import {
  createSqliteResumableStreamStore,
  type StaleClaimedHistoryRow,
  type SqliteResumableStreamStore,
} from "@/services/chat-streams/sqliteResumableStore.ts";
import {
  getStoredMessageSync,
  resolveMessageForHistorySync,
  upsertStoredSync,
} from "@/services/storage/messages.ts";
import { messageService } from "@/services/storage";
import {
  drainChatStreamCleanup,
  getChatStreamCleanupState,
  runChatStreamCleanupOnce,
  startChatStreamCleanup,
  stopChatStreamCleanup,
} from "@/services/chat-streams/cleanup.ts";

/**
 * Contract tests for boot recovery of abandoned history claims (the C-3 crash
 * window) and for the retention policy that protects what it cannot resolve.
 *
 * ## Why these tests use the real database and the real resolver
 *
 * The property under test is TRANSACTIONAL: the `claimed -> done` transition and
 * the message write must commit together or not at all, and a refused write must
 * leave no trace. That is a claim about SQLite, not about control flow. A fake
 * message layer plus a Map of "writes" can only assert what the implementation
 * says it did; it cannot observe a rolled-back row, a foreign row left intact, or
 * a lock that surfaced as SQLITE_BUSY.
 *
 * So the store is the production `createSqliteResumableStreamStore` (real guarded
 * SQL) and the verifier is the real `resolveMessageForHistorySync` (real ownership
 * check, real repair rule, real read-back). The harness supplies only a clock and a
 * private store instance. `messages` and `chat_streams` are the real tables in the
 * application database, which `tests/setup.ts` isolates per test file, so nothing
 * here can see another file's rows and the developer's `data/chat.db` is never
 * opened.
 *
 * Assertions are therefore about observable database state: which row exists, what
 * `history_state` holds, and what the stored message body is.
 */

const enc = new TextEncoder();
const USER_MESSAGE_ID = "msg_user_1";
const ANSWER = "the recovered answer";
const ASSISTANT_MESSAGE_ID = "msg_assistant_1";
const STALE_MS = DEFAULT_STALE_HISTORY_CLAIM_MS;
const HOLD_MS = DEFAULT_UNRESOLVED_HISTORY_HOLD_MS;
const TEST_NOW = 1_700_000_000_000;

interface Harness {
  store: SqliteResumableStreamStore;
  clock: { now: number };
  /** The conversation the run was bound to. */
  conversationId: string;
  recovery: ClaimedHistoryRecoveryDeps;
  reconcile: HistoryReconcilerDeps;
}

const openStores: SqliteResumableStreamStore[] = [];
/** Conversations this suite created, deleted in `afterEach`. */
const createdConversations: string[] = [];

/**
 * A private store over the application database with a controllable clock.
 *
 * The store is per-test rather than the process singleton because the staleness
 * bound and the retention hold are measured against THIS test's clock.
 */
function harness(): Harness {
  const clock = { now: TEST_NOW };
  const store = createSqliteResumableStreamStore({
    db,
    now: () => clock.now,
    pollIntervalMs: 10,
    bootId: "boot_claim_recovery_test",
    generateLeaseToken: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `lease_${n}`;
      };
    })(),
  });
  openStores.push(store);

  // The FK target for every message this suite writes. Inserted directly rather
  // than through `conversationService.create`: the guard only needs the row to
  // exist, and the service also provisions a workspace folder and reads the row
  // back, which is unrelated work in a store test.
  const conversationId = `conv_claim_recovery_${openStores.length}`;
  db.run("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [
    conversationId,
    "Claim recovery test",
    clock.now,
    clock.now,
  ]);
  createdConversations.push(conversationId);

  // The row a real browser has written before a run starts: it persists the user
  // message it sent through the messages API (`threadHistoryAdapter` ->
  // `POST /api/conversations/:id/messages`), and that row is the capture's parent.
  // Seeding it keeps every default-parent case below production-shaped; the
  // contradiction cases override `parentId` to build the anomaly they assert.
  upsertStoredSync(conversationId, {
    id: USER_MESSAGE_ID,
    parent_id: null,
    format: ASSISTANT_UI_STORAGE_FORMAT,
    content: { role: "user", parts: [{ type: "text", text: "the question" }] },
  });

  const messages = { resolveMessageForHistorySync };
  return {
    store,
    clock,
    conversationId,
    recovery: { store, messages },
    reconcile: { store, messages },
  };
}

/** A second conversation, for cross-conversation ownership and parent cases. */
function otherConversation(): string {
  const id = `conv_claim_recovery_other_${createdConversations.length}`;
  db.run("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [
    id,
    "Other",
    TEST_NOW,
    TEST_NOW,
  ]);
  createdConversations.push(id);
  return id;
}

beforeEach(() => {
  db.run("DELETE FROM chat_streams");
  db.run("DELETE FROM messages");
});

afterEach(() => {
  stopHistoryReconciliation();
  stopChatStreamCleanup();
  stopClaimedHistoryRecovery();
  for (const conversationId of createdConversations.splice(0)) {
    // Cascades to the conversation's messages.
    db.run("DELETE FROM conversations WHERE id = ?", [conversationId]);
  }
  db.run("DELETE FROM chat_streams");
  db.run("DELETE FROM messages");
  for (const store of openStores.splice(0)) {
    try {
      store.dispose();
    } catch {
      /* already torn down */
    }
  }
});

/** The message shape the route captures at settlement. */
function answerMessage(id = ASSISTANT_MESSAGE_ID): FinalUIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text: ANSWER }] };
}

/** The stored `content` for a captured message: `toStoredMessageContent`'s shape. */
function storedContentFor(message: FinalUIMessage): Record<string, unknown> {
  const { id: _id, ...content } = message;
  return content as Record<string, unknown>;
}

function historyStateOf(streamId: string): string {
  return (
    db
      .query<{ history_state: string }, string[]>(
        "SELECT history_state FROM chat_streams WHERE stream_id = ?",
      )
      .get(streamId)?.history_state ?? "absent"
  );
}

/** The three columns that decide whether a row is a sweep candidate. */
function streamRowOf(
  streamId: string,
): { status: string; terminal_kind: string | null; history_state: string } | null {
  return (
    db
      .query<{ status: string; terminal_kind: string | null; history_state: string }, string[]>(
        "SELECT status, terminal_kind, history_state FROM chat_streams WHERE stream_id = ?",
      )
      .get(streamId) ?? null
  );
}

function updatedAtOf(conversationId: string, messageId: string): number {
  return db
    .query<{ updated_at: number }, string[]>(
      "SELECT updated_at FROM messages WHERE conversation_id = ? AND id = ?",
    )
    .get(conversationId, messageId)!.updated_at;
}

/**
 * Drive a row to a settled `completed` state the way the route does, capturing the
 * final message unless told otherwise. Does NOT age the row: claim age is measured
 * from the claim itself, which the callers below control.
 */
async function settledCompletedRun(
  h: Harness,
  options: {
    id: string;
    capture?: FinalUIMessage | null;
    bind?: boolean;
    parentId?: string | null;
  },
): Promise<string> {
  const acquisition = await h.store.acquireLease(options.id);
  if (acquisition.role !== "producer") throw new Error("expected producer role");
  const { lease } = acquisition;

  await h.store.append(options.id, enc.encode('{"type":"text"}'), lease);
  if (options.bind !== false) {
    h.store.bindRunContext(options.id, { conversationId: h.conversationId });
  }
  await h.store.settleDurable(options.id, { status: "done", terminalKind: "completed" });

  const capture = options.capture === undefined ? answerMessage() : options.capture;
  if (capture) {
    h.store.recordFinalMessage(options.id, {
      message: capture,
      parentId: options.parentId === undefined ? USER_MESSAGE_ID : options.parentId,
    });
  }
  return options.id;
}

/**
 * A run whose history claim a process took and then abandoned: settled, captured,
 * claimed, and then left. `claimAgeMs` moves the clock past the claim so the sweep
 * sees it; `messageId` defaults to the captured message's own id.
 */
async function abandonedClaim(
  h: Harness,
  options: {
    id: string;
    capture?: FinalUIMessage | null;
    bind?: boolean;
    messageId?: string;
    parentId?: string | null;
    claimAgeMs?: number;
  },
): Promise<string> {
  await settledCompletedRun(h, {
    id: options.id,
    capture: options.capture,
    bind: options.bind,
    parentId: options.parentId,
  });
  const messageId = options.messageId ?? options.capture?.id ?? ASSISTANT_MESSAGE_ID;
  const claimed = h.store.claimHistory(options.id, messageId);
  if (!claimed) throw new Error("expected the claim to be taken");
  h.clock.now += options.claimAgeMs ?? STALE_MS + 1_000;
  return options.id;
}

function recover(
  deps: ClaimedHistoryRecoveryDeps,
  clock: { now: number },
  options: RecoverStaleClaimedHistoryOptions = {},
): Promise<ClaimedRecoveryReport> {
  return recoverStaleClaimedHistory(deps, { now: () => clock.now, ...options });
}

/**
 * The narrowed store surface recovery uses, taken from a real store so an override
 * replaces one real seam rather than reimplementing the guard.
 */
function recoveryStoreOf(
  h: Harness,
  overrides: Partial<
    Pick<HistoryPersistStore, "completeHistoryWithVerifiedMessage" | "skipHistory">
  > & {
    listStaleClaimedHistory?: (options: {
      before: number;
      limit: number;
      afterStreamId?: string;
    }) => StaleClaimedHistoryRow[];
  } = {},
): ClaimedHistoryRecoveryDeps["store"] {
  return {
    getRunContext: (streamId) => h.store.getRunContext(streamId),
    skipHistory: (streamId) => h.store.skipHistory(streamId),
    completeHistoryWithVerifiedMessage: (streamId, verify) =>
      h.store.completeHistoryWithVerifiedMessage(streamId, verify),
    listStaleClaimedHistory: (options) => h.store.listStaleClaimedHistory(options),
    ...overrides,
  };
}

/** Insert a row directly, for read-surface and retention assertions. */
function insertStreamRow(
  clock: { now: number },
  id: string,
  overrides: Partial<{
    status: string;
    terminal_kind: string | null;
    history_state: string;
    history_message_id: string | null;
    history_claimed_at: number | null;
    final_message_json: string | null;
    expires_at: number;
  }> = {},
): void {
  db.run(
    `INSERT INTO chat_streams
       (stream_id, status, terminal_kind, boot_id, history_state,
        history_message_id, history_claimed_at, conversation_id,
        final_message_json, final_parent_id, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, 'boot_test', ?, ?, ?, NULL, ?, NULL, ?, ?, ?)`,
    [
      id,
      overrides.status ?? "done",
      overrides.terminal_kind === undefined ? "completed" : overrides.terminal_kind,
      overrides.history_state ?? "claimed",
      overrides.history_message_id ?? null,
      overrides.history_claimed_at === undefined ? clock.now : overrides.history_claimed_at,
      overrides.final_message_json === undefined
        ? JSON.stringify(answerMessage())
        : overrides.final_message_json,
      clock.now,
      clock.now,
      overrides.expires_at ?? clock.now + 10_000_000,
    ],
  );
}

// ── 1. The core repair, verified against the stored row ─────────────────────

describe("claimed history recovery — abandoned claim", () => {
  it("writes the captured message once, verifies it, and closes the claim", async () => {
    const h = harness();
    const id = await abandonedClaim(h, { id: "run_a" });
    expect(historyStateOf(id)).toBe("claimed");

    const report = await recover(h.recovery, h.clock);

    expect(report).toMatchObject({
      scanned: 1,
      pages: 1,
      written: 1,
      conflicted: 0,
      failed: 0,
      stopReason: "drained",
    });
    expect(historyStateOf(id)).toBe("done");

    // The verified row itself, not a call log.
    const stored = getStoredMessageSync(h.conversationId, ASSISTANT_MESSAGE_ID);
    expect(stored).not.toBeNull();
    expect(stored!.parentId).toBe(USER_MESSAGE_ID);
    expect(stored!.format).toBe(ASSISTANT_UI_STORAGE_FORMAT);
    expect(stored!.content).toEqual(storedContentFor(answerMessage()));
  });

  it("writes the reply into a chain the readers can still prove", async () => {
    const h = harness();
    // Before the reply exists, the user row alone is a legitimate root.
    expect(await messageService.getHeadChain(h.conversationId)).toMatchObject({
      complete: true,
    });

    const id = await abandonedClaim(h, { id: "run_chain" });
    await recover(h.recovery, h.clock);

    // What the parent rule protects: the recovered reply must JOIN the conversation's
    // walked history. A dangling parent would leave `complete: false` with nothing
    // above the break reachable, which is exactly the state the guard refuses to
    // create. `getHeadChain` is the reader the chat request assembles from.
    const chain = await messageService.getHeadChain(h.conversationId);
    expect(chain.complete).toBe(true);
    expect(chain.messages.map((m) => m.id)).toEqual([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID]);
    expect(historyStateOf(id)).toBe("done");
  });

  it("closes without writing when the stored row already holds the same message", async () => {
    const h = harness();
    // The client persisted the reply; the process then died before closing the claim.
    await messageService.upsertStored(h.conversationId, {
      id: ASSISTANT_MESSAGE_ID,
      parent_id: USER_MESSAGE_ID,
      format: ASSISTANT_UI_STORAGE_FORMAT,
      content: storedContentFor(answerMessage()),
    });
    // A sentinel no writer would produce: proves the row was not touched.
    db.run("UPDATE messages SET updated_at = 111 WHERE id = ?", [ASSISTANT_MESSAGE_ID]);
    const id = await abandonedClaim(h, { id: "run_matched" });

    const report = await recover(h.recovery, h.clock);

    expect(report).toMatchObject({ scanned: 1, matched: 1, written: 0, repaired: 0 });
    expect(historyStateOf(id)).toBe("done");
    expect(updatedAtOf(h.conversationId, ASSISTANT_MESSAGE_ID)).toBe(111);
  });

  it("ignores a compact part and metadata when deciding a row already matches", async () => {
    const h = harness();
    // The browser's row carries provider bookkeeping plus a spliced-in compact
    // part; the capture carries neither. That is still the same message.
    await messageService.upsertStored(h.conversationId, {
      id: ASSISTANT_MESSAGE_ID,
      parent_id: USER_MESSAGE_ID,
      format: ASSISTANT_UI_STORAGE_FORMAT,
      content: {
        role: "assistant",
        parts: [
          { type: "text", text: ANSWER },
          { type: "data-tbai-compact", data: { divider: true } },
        ],
        metadata: { provider: "test", usage: 1 },
      },
    });
    const id = await abandonedClaim(h, { id: "run_compact" });

    const report = await recover(h.recovery, h.clock);

    expect(report).toMatchObject({ matched: 1, repaired: 0, written: 0 });
    expect(historyStateOf(id)).toBe("done");
  });

  it("repairs a stored row that does not match, because the capture wins", async () => {
    const h = harness();
    await messageService.upsertStored(h.conversationId, {
      id: ASSISTANT_MESSAGE_ID,
      parent_id: USER_MESSAGE_ID,
      format: ASSISTANT_UI_STORAGE_FORMAT,
      content: { role: "assistant", parts: [{ type: "text", text: "an older partial" }] },
    });
    const id = await abandonedClaim(h, { id: "run_repaired" });

    const report = await recover(h.recovery, h.clock);

    expect(report).toMatchObject({ repaired: 1, written: 0, matched: 0 });
    expect(historyStateOf(id)).toBe("done");
    expect(getStoredMessageSync(h.conversationId, ASSISTANT_MESSAGE_ID)!.content).toEqual(
      storedContentFor(answerMessage()),
    );
  });

  it("closes as abandoned when the run has no conversation to write into", async () => {
    const h = harness();
    const id = await abandonedClaim(h, { id: "run_no_conv", bind: false });

    const report = await recover(h.recovery, h.clock);

    expect(report).toMatchObject({ scanned: 1, written: 0, abandoned: 1 });
    expect(historyStateOf(id)).toBe("skipped");
    expect(getStoredMessageSync(h.conversationId, ASSISTANT_MESSAGE_ID)).toBeNull();
  });

  it("closes a claim whose captured message is missing or unreadable", async () => {
    const h = harness();
    const missing = await abandonedClaim(h, {
      id: "run_missing_capture",
      capture: null,
      messageId: "msg_x",
    });
    const unreadable = await abandonedClaim(h, { id: "run_bad_capture" });
    db.run("UPDATE chat_streams SET final_message_json='{not json' WHERE stream_id=?", [
      unreadable,
    ]);

    const report = await recover(h.recovery, h.clock);

    expect(report).toMatchObject({ scanned: 2, written: 0, abandoned: 2 });
    expect(historyStateOf(missing)).toBe("skipped");
    expect(historyStateOf(unreadable)).toBe("skipped");
    expect(getStoredMessageSync(h.conversationId, ASSISTANT_MESSAGE_ID)).toBeNull();
  });

  it("leaves no message row behind when the write itself cannot land", async () => {
    const h = harness();
    const id = await abandonedClaim(h, { id: "run_write_fails" });
    // The write is refused while the parent still resolves, so the refusal is a
    // genuine storage failure rather than a contradiction. A trigger is how one
    // statement is made to fail in place: the realistic causes (a full disk, an
    // I/O error) are not reachable from a test, and deleting the conversation
    // would take the parent row with it and turn this into a `conflicted`.
    db.run(
      `CREATE TRIGGER refuse_reply_insert BEFORE INSERT ON messages
         WHEN NEW.id = '${ASSISTANT_MESSAGE_ID}'
         BEGIN SELECT RAISE(ABORT, 'insert refused'); END`,
    );

    let report: ClaimedRecoveryReport;
    try {
      report = await recover(h.recovery, h.clock);
    } finally {
      db.run("DROP TRIGGER IF EXISTS refuse_reply_insert");
    }

    // A failure is reported as a failure, not as a closure, and the row stays
    // claimed so a later sweep (or the retention window) can still account for it.
    expect(report).toMatchObject({ scanned: 1, written: 0, failed: 1, stopReason: "drained" });
    expect(historyStateOf(id)).toBe("claimed");
    expect(getStoredMessageSync(h.conversationId, ASSISTANT_MESSAGE_ID)).toBeNull();
  });

  it("reports a deleted conversation as an unresolvable claim, not a retryable failure", async () => {
    const h = harness();
    const id = await abandonedClaim(h, { id: "run_conv_deleted" });
    // The conversation is deleted mid-run, which cascades its messages away. The
    // captured parent therefore has no row, and the strict parent rule classifies
    // this as a contradiction rather than a storage failure. The row is still
    // neither written nor closed, and the retention hold still runs out on it —
    // what changes is the diagnostic (`conflicted`, not `failed`).
    db.run("DELETE FROM conversations WHERE id = ?", [h.conversationId]);

    const report = await recover(h.recovery, h.clock);

    expect(report).toMatchObject({ scanned: 1, written: 0, conflicted: 1, failed: 0 });
    expect(historyStateOf(id)).toBe("claimed");
  });
});

// ── 2. Contradictions: nothing written, nothing closed, no guessing ─────────

describe("claimed history recovery — contradictions are left unresolved", () => {
  it("refuses a capture whose id disagrees with the id the claim recorded", async () => {
    const h = harness();
    const id = await abandonedClaim(h, {
      id: "run_mismatch",
      capture: answerMessage("msg_captured"),
      messageId: "msg_claimed",
    });

    const report = await recover(h.recovery, h.clock);

    expect(report).toMatchObject({ scanned: 1, conflicted: 1, written: 0, failed: 0 });
    // Rolled back: neither the transition nor any message write survives.
    expect(historyStateOf(id)).toBe("claimed");
    expect(getStoredMessageSync(h.conversationId, "msg_captured")).toBeNull();
    expect(getStoredMessageSync(h.conversationId, "msg_claimed")).toBeNull();
  });

  it("refuses a self-referential parent", async () => {
    const h = harness();
    const id = await abandonedClaim(h, { id: "run_self_parent", parentId: ASSISTANT_MESSAGE_ID });

    const report = await recover(h.recovery, h.clock);

    expect(report).toMatchObject({ conflicted: 1, written: 0 });
    expect(historyStateOf(id)).toBe("claimed");
    expect(getStoredMessageSync(h.conversationId, ASSISTANT_MESSAGE_ID)).toBeNull();
  });

  it("refuses a parent in another conversation, and leaves that row alone", async () => {
    const h = harness();
    const other = otherConversation();
    await messageService.upsertStored(other, {
      id: "msg_foreign_parent",
      parent_id: null,
      format: ASSISTANT_UI_STORAGE_FORMAT,
      content: { role: "user", parts: [{ type: "text", text: "other thread" }] },
    });
    db.run("UPDATE messages SET updated_at = 222 WHERE id = ?", ["msg_foreign_parent"]);
    const id = await abandonedClaim(h, { id: "run_cross_parent", parentId: "msg_foreign_parent" });

    const report = await recover(h.recovery, h.clock);

    expect(report).toMatchObject({ conflicted: 1, written: 0 });
    expect(historyStateOf(id)).toBe("claimed");
    expect(getStoredMessageSync(h.conversationId, ASSISTANT_MESSAGE_ID)).toBeNull();
    expect(updatedAtOf(other, "msg_foreign_parent")).toBe(222);
  });

  it("refuses a reply whose id is already owned by another conversation", async () => {
    const h = harness();
    const other = otherConversation();
    await messageService.upsertStored(other, {
      id: ASSISTANT_MESSAGE_ID,
      parent_id: null,
      format: ASSISTANT_UI_STORAGE_FORMAT,
      content: { role: "assistant", parts: [{ type: "text", text: "someone else's reply" }] },
    });
    const id = await abandonedClaim(h, { id: "run_owned_elsewhere" });

    const report = await recover(h.recovery, h.clock);

    expect(report).toMatchObject({ conflicted: 1, written: 0, repaired: 0 });
    expect(historyStateOf(id)).toBe("claimed");
    // The other conversation's row is not repointed, overwritten or deleted.
    const foreign = getStoredMessageSync(other, ASSISTANT_MESSAGE_ID)!;
    expect(foreign.conversationId).toBe(other);
    expect(foreign.content).toEqual({
      role: "assistant",
      parts: [{ type: "text", text: "someone else's reply" }],
    });
  });

  it("refuses a parent that is not a row of this conversation", async () => {
    const h = harness();
    // The parent link is how the conversation is READ back: `getHeadChain` treats a
    // dangling link as incomplete ("a missing parent is NOT a legitimate root"), so
    // a reply written under one would leave the whole chain unprovable rather than
    // just its own row unreachable. The claim stays open and the sweep reports it;
    // only the 7-day hold (`cleanupExpired`) ever retires it.
    const id = await abandonedClaim(h, {
      id: "run_absent_parent",
      parentId: "msg_user_never_saved",
    });

    const report = await recover(h.recovery, h.clock);

    expect(report).toMatchObject({ scanned: 1, written: 0, conflicted: 1, failed: 0 });
    expect(historyStateOf(id)).toBe("claimed");
    expect(getStoredMessageSync(h.conversationId, ASSISTANT_MESSAGE_ID)).toBeNull();
    // The row really is absent, and the conversation is otherwise intact.
    expect(getStoredMessageSync(h.conversationId, USER_MESSAGE_ID)).not.toBeNull();
  });
});

// ── 3. Lost compare-and-set: the row state is the authority ─────────────────

describe("claimed history recovery — a claim someone else already closed", () => {
  /**
   * A competing worker, expressed as a real SQL action taken immediately before the
   * guard runs. The guard then genuinely misses, and the classification must report
   * what the row actually says.
   */
  async function withCompetingAction(
    h: Harness,
    action: (streamId: string) => void,
  ): Promise<ClaimedRecoveryReport> {
    const deps: ClaimedHistoryRecoveryDeps = {
      messages: h.recovery.messages,
      store: recoveryStoreOf(h, {
        completeHistoryWithVerifiedMessage: (streamId, verify) => {
          action(streamId);
          return h.store.completeHistoryWithVerifiedMessage(streamId, verify);
        },
      }),
    };
    return recover(deps, h.clock);
  }

  it("reports a row already closed as done, never as a second write", async () => {
    const h = harness();
    const id = await abandonedClaim(h, { id: "run_done_first" });

    const report = await withCompetingAction(h, (streamId) => {
      h.store.completeHistory(streamId);
    });

    expect(report).toMatchObject({ alreadyResolved: 1, written: 0, conflicted: 0, failed: 0 });
    expect(historyStateOf(id)).toBe("done");
    expect(getStoredMessageSync(h.conversationId, ASSISTANT_MESSAGE_ID)).toBeNull();
  });

  it("reports a row already abandoned as skipped", async () => {
    const h = harness();
    const id = await abandonedClaim(h, { id: "run_skipped_first" });

    const report = await withCompetingAction(h, (streamId) => {
      h.store.skipHistory(streamId);
    });

    expect(report).toMatchObject({ alreadyResolvedSkipped: 1, written: 0 });
    expect(historyStateOf(id)).toBe("skipped");
  });

  it("reports a row that vanished instead of claiming a success", async () => {
    const h = harness();
    const id = await abandonedClaim(h, { id: "run_vanished" });

    const report = await withCompetingAction(h, (streamId) => {
      db.run("DELETE FROM chat_streams WHERE stream_id = ?", [streamId]);
    });

    expect(report).toMatchObject({ rowGone: 1, written: 0, matched: 0 });
    expect(historyStateOf(id)).toBe("absent");
  });
});

// ── 4. NULL claim timestamps ────────────────────────────────────────────────

describe("claimed history recovery — a corrupt claim timestamp", () => {
  it("sweeps and counts a claim with no recorded claim time", async () => {
    const h = harness();
    const id = await abandonedClaim(h, { id: "run_null_ts" });
    // `claimHistory` always records a timestamp, so a NULL is corruption. It cannot
    // be shown to be recent, so it is swept rather than stranded.
    db.run("UPDATE chat_streams SET history_claimed_at = NULL WHERE stream_id = ?", [id]);

    const report = await recover(h.recovery, h.clock);

    expect(report).toMatchObject({ scanned: 1, nullTimestamp: 1, written: 1 });
    expect(historyStateOf(id)).toBe("done");
  });
});

// ── 5. Contention: busy is neither a guard miss nor a lost reply ────────────

describe("claimed history recovery — lock contention", () => {
  it("defers a contended write and recovers it on the next sweep", async () => {
    const h = harness();
    const id = await abandonedClaim(h, { id: "run_busy" });

    const other = new Database(DB_PATH);
    other.run("PRAGMA busy_timeout=0");
    other.run("BEGIN IMMEDIATE");
    // Fail fast rather than waiting out the production 5 s busy timeout: the point
    // is the CLASSIFICATION of contention, not how long SQLite waits.
    db.run("PRAGMA busy_timeout=0");
    let first: ClaimedRecoveryReport;
    try {
      first = await recover(h.recovery, h.clock);
    } finally {
      db.run("PRAGMA busy_timeout=5000");
      other.run("ROLLBACK");
      other.close();
    }

    expect(first).toMatchObject({
      failed: 1,
      written: 0,
      conflicted: 0,
      alreadyResolved: 0,
      rowGone: 0,
      stopReason: "drained",
    });
    // Deferred, not resolved and not stolen: the claim is still there to retry.
    expect(historyStateOf(id)).toBe("claimed");

    const second = await recover(h.recovery, h.clock);
    expect(second).toMatchObject({ written: 1, failed: 0 });
    expect(historyStateOf(id)).toBe("done");
  });
});

// ── 6. Pagination: a row that cannot be closed must not stall the sweep ─────

describe("claimed history recovery — pagination", () => {
  it("drains every page and reports the page count", async () => {
    const h = harness();
    await abandonedClaim(h, { id: "run_p1", capture: answerMessage("msg_p1") });
    await abandonedClaim(h, { id: "run_p2", capture: answerMessage("msg_p2") });
    await abandonedClaim(h, { id: "run_p3", capture: answerMessage("msg_p3") });

    const report = await recover(h.recovery, h.clock, { pageSize: 2 });

    expect(report).toMatchObject({ scanned: 3, pages: 2, written: 3, stopReason: "drained" });
  });

  it("advances past a row it cannot close instead of returning to it forever", async () => {
    const h = harness();
    // `run_a_*` sorts first, so the unresolvable row heads the scan: an
    // offset- or bound-only scan would return it on every page and never finish.
    await abandonedClaim(h, {
      id: "run_a_conflict",
      capture: answerMessage("msg_captured"),
      messageId: "msg_claimed",
    });
    await abandonedClaim(h, { id: "run_b_ok", capture: answerMessage("msg_b") });
    await abandonedClaim(h, { id: "run_c_ok", capture: answerMessage("msg_c") });

    const report = await recover(h.recovery, h.clock, { pageSize: 2 });

    expect(report).toMatchObject({
      scanned: 3,
      conflicted: 1,
      written: 2,
      pages: 2,
      stopReason: "drained",
    });
    expect(historyStateOf("run_a_conflict")).toBe("claimed");
    expect(historyStateOf("run_b_ok")).toBe("done");
    expect(historyStateOf("run_c_ok")).toBe("done");

    // The next sweep re-examines the unresolved row and nothing else.
    const second = await recover(h.recovery, h.clock, { pageSize: 2 });
    expect(second).toMatchObject({ scanned: 1, conflicted: 1, written: 0 });
  });
});

// ── 7. A failed page read is not a drained sweep ───────────────────────────

describe("claimed history recovery — an incomplete scan", () => {
  it("stops with scan_failed instead of pretending the rest does not exist", async () => {
    const h = harness();
    await abandonedClaim(h, { id: "run_page_read_fails" });

    const deps: ClaimedHistoryRecoveryDeps = {
      messages: h.recovery.messages,
      store: recoveryStoreOf(h, {
        listStaleClaimedHistory: () => {
          throw new Error("database is locked");
        },
      }),
    };

    // Never rejects: a scan failure is a reported outcome, not a crash.
    const report = await recover(deps, h.clock);

    expect(report).toMatchObject({ scanned: 0, pages: 0, stopReason: "scan_failed" });
    expect(historyStateOf("run_page_read_fails")).toBe("claimed");
  });

  it("keeps what it already closed and names the failure on the later page", async () => {
    const h = harness();
    await abandonedClaim(h, { id: "run_ok_first", capture: answerMessage("msg_first") });
    await abandonedClaim(h, { id: "run_second_page", capture: answerMessage("msg_second") });

    let calls = 0;
    const deps: ClaimedHistoryRecoveryDeps = {
      messages: h.recovery.messages,
      store: recoveryStoreOf(h, {
        listStaleClaimedHistory: (options) => {
          calls += 1;
          if (calls > 1) throw new Error("database is locked");
          return h.store.listStaleClaimedHistory(options);
        },
      }),
    };

    const report = await recover(deps, h.clock, { pageSize: 1 });

    expect(report).toMatchObject({ scanned: 1, pages: 1, written: 1, stopReason: "scan_failed" });
    expect(historyStateOf("run_ok_first")).toBe("done");
    expect(historyStateOf("run_second_page")).toBe("claimed");
  });
});

// ── 8. Boot ordering: the sweep is what closes a claim nobody owns ─────────

describe("claimed history recovery — boot ordering", () => {
  it("is the only path that can recover an abandoned claim", async () => {
    const h = harness();
    const id = await abandonedClaim(h, { id: "run_only_sweep" });
    stopHistoryReconciliation();
    startHistoryReconciliation({
      deps: h.reconcile,
      runImmediately: false,
      graceMs: 0,
      now: () => h.clock.now,
    });

    // Reconciliation selects `pending` only, so an abandoned `claimed` row is
    // invisible to it: without the sweep the reply would be lost silently.
    const reconcileReport = await runHistoryReconciliationOnce();

    expect(reconcileReport).toMatchObject({ scanned: 0, written: 0 });
    expect(historyStateOf(id)).toBe("claimed");

    const recovery = await recover(h.recovery, h.clock);
    expect(recovery).toMatchObject({ scanned: 1, written: 1 });
    expect(historyStateOf(id)).toBe("done");
  });

  it("recovers a claim taken while the byte stream was still open, after boot recovery relabels it", async () => {
    const h = harness();

    // The live finalizer's sequence, in the order the route runs it
    // (`execute-direct-stream.ts` `onEnd`): the run is settled — which records only
    // `terminal_kind`, because `status` belongs to the official `finalize` — the
    // reply is captured, and only then is the history claim taken. The byte stream is
    // therefore still open, so a crash in that window always leaves `status='streaming'`.
    const acquisition = await h.store.acquireLease("run_crash_mid_finalize");
    if (acquisition.role !== "producer") throw new Error("expected the producer role");
    h.store.bindRunContext("run_crash_mid_finalize", { conversationId: h.conversationId });
    h.store.recordRunVerdict("run_crash_mid_finalize", "completed", {});
    h.store.recordFinalMessage("run_crash_mid_finalize", {
      message: answerMessage(),
      parentId: USER_MESSAGE_ID,
    });
    expect(h.store.claimHistory("run_crash_mid_finalize", ASSISTANT_MESSAGE_ID)).toBe(true);
    expect(streamRowOf("run_crash_mid_finalize")).toMatchObject({
      status: "streaming",
      terminal_kind: "completed",
      history_state: "claimed",
    });

    // The process dies here. On the next boot the orphan sweep runs FIRST
    // (`server.ts`) and settles the byte stream, keeping the recorded completion.
    const orphans = recoverOrphanedChatStreams(db, {
      bootId: "boot_after_crash",
      now: () => h.clock.now,
    });
    expect(orphans).toMatchObject({ scanned: 1, interrupted: 0, preservedVerdicts: 1 });
    expect(streamRowOf("run_crash_mid_finalize")).toMatchObject({
      status: "error",
      terminal_kind: "completed",
      history_state: "claimed",
    });
    // Boot recovery closes the byte stream and nothing else: the reply is still
    // only inside the stream row at this point.
    expect(getStoredMessageSync(h.conversationId, ASSISTANT_MESSAGE_ID)).toBeNull();

    // The history sweep is what must repair it. Before this candidate set included
    // `error`, this was the shape that reached no recovery path at all.
    h.clock.now += STALE_MS + 1_000;
    const recovery = await recover(h.recovery, h.clock);

    expect(recovery).toMatchObject({
      scanned: 1,
      written: 1,
      conflicted: 0,
      failed: 0,
      stopReason: "drained",
    });
    expect(historyStateOf("run_crash_mid_finalize")).toBe("done");

    const stored = getStoredMessageSync(h.conversationId, ASSISTANT_MESSAGE_ID);
    expect(stored).not.toBeNull();
    expect(stored!.parentId).toBe(USER_MESSAGE_ID);
    expect(stored!.content).toEqual(storedContentFor(answerMessage()));
  });

  it("does not let reconciliation scan until the sweep has settled", async () => {
    const h = harness();
    // A pending obligation that reconciliation would happily write, if it ran.
    const pending = await settledCompletedRun(h, { id: "run_pending" });
    // A sweep the test holds open, standing in for boot recovery.
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    stopHistoryReconciliation();
    startHistoryReconciliation({
      deps: h.reconcile,
      runImmediately: true,
      graceMs: 0,
      now: () => h.clock.now,
      gate,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Gated: the first pass is parked, nothing scanned, nothing written.
    expect(getHistoryReconciliationState().ticks).toBe(0);
    expect(getStoredMessageSync(h.conversationId, "msg_pending")).toBeNull();
    expect(historyStateOf(pending)).toBe("pending");

    openGate();
    await drainHistoryReconciliation();

    expect(getHistoryReconciliationState().ticks).toBe(1);
    expect(historyStateOf(pending)).toBe("done");
  });

  it("derives the cleanup gate from the sweep's own stop reason", async () => {
    const h = harness();
    await abandonedClaim(h, { id: "run_gate_source" });

    const drained = await recover(h.recovery, h.clock);
    expect(drained.stopReason).toBe("drained");
    // What `server.ts` consumes: only a proven-complete scan may gate cleanup in.
    expect(drained.stopReason === "drained").toBe(true);

    const failedScan = await recover(
      {
        messages: h.recovery.messages,
        store: recoveryStoreOf(h, {
          listStaleClaimedHistory: () => {
            throw new Error("database is locked");
          },
        }),
      },
      h.clock,
    );
    expect(failedScan.stopReason === "drained").toBe(false);
  });
});

// ── 9. Retention: an unresolved reply is held, not scavenged ────────────────

describe("chat stream cleanup — unresolved claims are held", () => {
  it("holds an expired claimed row that still carries a captured reply", async () => {
    const h = harness();
    insertStreamRow(h.clock, "run_held", { expires_at: h.clock.now - 1 });

    const report = await h.store.cleanupExpired();

    expect(report).toMatchObject({ deleted: 0, heldUnresolved: 1, expiredUnresolved: 0 });
    expect(historyStateOf("run_held")).toBe("claimed");
  });

  it("deletes the held row once its extra window has elapsed, and says so", async () => {
    const h = harness();
    insertStreamRow(h.clock, "run_held_expired", { expires_at: h.clock.now - 1 });

    h.clock.now += HOLD_MS + 1;
    const report = await h.store.cleanupExpired();

    expect(report).toMatchObject({ deleted: 1, expiredUnresolved: 1, heldUnresolved: 0 });
    expect(historyStateOf("run_held_expired")).toBe("absent");
  });

  it("expires a claimed row with nothing to protect, and one with an unreadable capture", async () => {
    const h = harness();
    insertStreamRow(h.clock, "run_no_capture", {
      final_message_json: null,
      expires_at: h.clock.now - 1,
    });
    insertStreamRow(h.clock, "run_bad_json", {
      final_message_json: "{not json",
      expires_at: h.clock.now - 1,
    });

    const report = await h.store.cleanupExpired();

    expect(report).toMatchObject({ deleted: 2, heldUnresolved: 0, expiredUnresolved: 0 });
    expect(historyStateOf("run_no_capture")).toBe("absent");
    expect(historyStateOf("run_bad_json")).toBe("absent");
  });

  it("does not hold a pending row, only a claimed one", async () => {
    const h = harness();
    insertStreamRow(h.clock, "run_pending_row", {
      history_state: "pending",
      expires_at: h.clock.now - 1,
    });

    const report = await h.store.cleanupExpired();

    expect(report).toMatchObject({ deleted: 1, heldUnresolved: 0, expiredUnresolved: 0 });
    expect(historyStateOf("run_pending_row")).toBe("absent");
  });

  it("honours an explicit hold, so the window is a policy and not a constant", async () => {
    const h = harness();
    insertStreamRow(h.clock, "run_short_hold", { expires_at: h.clock.now - 1 });

    h.clock.now += 5_000;
    const held = await h.store.cleanupExpired({ unresolvedHoldMs: 60_000 });
    expect(held).toMatchObject({ deleted: 0, heldUnresolved: 1 });

    h.clock.now += 60_000;
    const expired = await h.store.cleanupExpired({ unresolvedHoldMs: 60_000 });
    expect(expired).toMatchObject({ deleted: 1, expiredUnresolved: 1 });
  });
});

// ── 10. The cleanup timer's first tick is gated, once ──────────────────────

describe("chat stream cleanup — the boot gate", () => {
  it("reclaims nothing on a gated-out first tick, then reclaims normally", async () => {
    const h = harness();
    insertStreamRow(h.clock, "run_gated", {
      final_message_json: null,
      expires_at: h.clock.now - 1,
    });

    startChatStreamCleanup(db, { runImmediately: false, gate: Promise.resolve(false) });
    await drainChatStreamCleanup();

    const gated = await runChatStreamCleanupOnce();
    expect(gated).toBeNull();
    // A suppressed tick reclaimed nothing, so it is not a completed tick.
    expect(getChatStreamCleanupState().ticks).toBe(0);
    expect(historyStateOf("run_gated")).toBe("claimed");

    // Only the FIRST tick is gated: a single incomplete scan must not disable
    // retention for the process lifetime.
    const second = await runChatStreamCleanupOnce();
    expect(second).toMatchObject({ deleted: 1 });
    expect(getChatStreamCleanupState().ticks).toBe(1);
    expect(historyStateOf("run_gated")).toBe("absent");
  });

  it("reclaims on the first tick when the sweep drained", async () => {
    const h = harness();
    insertStreamRow(h.clock, "run_ungated", {
      final_message_json: null,
      expires_at: h.clock.now - 1,
    });

    const sweep = await recover(h.recovery, h.clock);
    startChatStreamCleanup(db, {
      runImmediately: false,
      gate: Promise.resolve(sweep.stopReason === "drained"),
    });
    const report = await runChatStreamCleanupOnce();

    expect(report).toMatchObject({ deleted: 1 });
    expect(getChatStreamCleanupState().ticks).toBe(1);
  });
});

// ── 11. The read surface itself ────────────────────────────────────────────

describe("listStaleClaimedHistory", () => {
  it("returns only completed claimed rows past the bound, ordered by stream id", () => {
    const h = harness();
    insertStreamRow(h.clock, "run_old", {
      history_claimed_at: h.clock.now - STALE_MS - 2_000,
      history_message_id: "m1",
      final_message_json: '{"id":"m1"}',
    });
    insertStreamRow(h.clock, "run_new", {
      history_claimed_at: h.clock.now - STALE_MS - 1_000,
      history_message_id: "m2",
      final_message_json: '{"id":"m2"}',
    });
    insertStreamRow(h.clock, "run_fresh", { history_claimed_at: h.clock.now });
    insertStreamRow(h.clock, "run_pending", { history_state: "pending" });
    insertStreamRow(h.clock, "run_done", { history_state: "done" });
    insertStreamRow(h.clock, "run_failed", { terminal_kind: "failed", status: "error" });
    insertStreamRow(h.clock, "run_null", { history_claimed_at: null });

    const rows = h.store.listStaleClaimedHistory({ before: h.clock.now - STALE_MS, limit: 50 });

    expect(rows.map((r) => r.streamId)).toEqual(["run_new", "run_null", "run_old"]);
    const old = rows.find((r) => r.streamId === "run_old")!;
    expect(old.historyMessageId).toBe("m1");
    expect(old.historyClaimedAt).toBe(h.clock.now - STALE_MS - 2_000);
  });

  it("also returns the claim boot recovery relabelled to error, and no other terminal row", () => {
    const h = harness();
    const stale = h.clock.now - STALE_MS - 1_000;

    // The crash shape: claimed while the byte stream was open, then settled to
    // `error` by boot recovery with the recorded completion preserved.
    insertStreamRow(h.clock, "run_crash_shape", {
      status: "error",
      terminal_kind: "completed",
      history_message_id: "m_crash",
      final_message_json: '{"id":"m_crash"}',
      history_claimed_at: stale,
    });
    // Terminal rows that are NOT an abandoned claim of a completed run stay out:
    // a run whose stream died without a completion verdict, one whose verdict was a
    // failure, and a completed row in any other history state.
    insertStreamRow(h.clock, "run_interrupted", {
      status: "error",
      terminal_kind: "interrupted",
      history_claimed_at: stale,
    });
    insertStreamRow(h.clock, "run_cancelled", {
      status: "error",
      terminal_kind: "cancelled",
      history_claimed_at: stale,
    });
    insertStreamRow(h.clock, "run_failed_claim", {
      status: "error",
      terminal_kind: "failed",
      history_claimed_at: stale,
    });
    insertStreamRow(h.clock, "run_error_pending", {
      status: "error",
      terminal_kind: "completed",
      history_state: "pending",
      history_claimed_at: stale,
    });
    insertStreamRow(h.clock, "run_error_done", {
      status: "error",
      terminal_kind: "completed",
      history_state: "done",
      history_claimed_at: stale,
    });

    const rows = h.store.listStaleClaimedHistory({ before: h.clock.now - STALE_MS, limit: 50 });

    expect(rows.map((r) => r.streamId)).toEqual(["run_crash_shape"]);
  });

  it("advances strictly past the cursor and respects the limit", () => {
    const h = harness();
    for (const id of ["run_a", "run_b", "run_c"]) {
      insertStreamRow(h.clock, id, {
        history_claimed_at: h.clock.now - STALE_MS - 1_000,
        history_message_id: `m_${id}`,
        final_message_json: JSON.stringify({ id: `m_${id}` }),
      });
    }
    const before = h.clock.now - STALE_MS;

    const first = h.store.listStaleClaimedHistory({ before, limit: 2 });
    const second = h.store.listStaleClaimedHistory({
      before,
      limit: 2,
      afterStreamId: first[first.length - 1].streamId,
    });

    expect(first.map((r) => r.streamId)).toEqual(["run_a", "run_b"]);
    expect(second.map((r) => r.streamId)).toEqual(["run_c"]);
  });

  it("defaults to a bounded page size the sweep cannot exceed in one query", () => {
    expect(DEFAULT_CLAIMED_RECOVERY_PAGE_SIZE).toBeGreaterThan(0);
    expect(DEFAULT_CLAIMED_RECOVERY_PAGE_SIZE).toBeLessThanOrEqual(200);
  });
});

// ── 12. The schema the guard writes to ────────────────────────────────────

// ── 14. Invalid captured messages ────────────────────────────────────────────

describe("claimed history recovery — invalid captures", () => {
  it("abandons a claim whose capture has an empty parts array", async () => {
    const h = harness();
    await abandonedClaim(h, {
      id: "run_empty_parts",
      capture: { id: ASSISTANT_MESSAGE_ID, role: "assistant", parts: [] } as FinalUIMessage,
    });

    const report = await recover(h.recovery, h.clock);

    expect(report).toMatchObject({ scanned: 1, written: 0, abandoned: 1, stopReason: "drained" });
    expect(historyStateOf("run_empty_parts")).toBe("skipped");
    expect(getStoredMessageSync(h.conversationId, ASSISTANT_MESSAGE_ID)).toBeNull();
  });

  it("abandons a claim whose capture has an invalid role", async () => {
    const h = harness();
    await abandonedClaim(h, {
      id: "run_bad_role",
      capture: {
        id: ASSISTANT_MESSAGE_ID,
        role: "user",
        parts: [{ type: "text", text: ANSWER }],
      } as FinalUIMessage,
    });

    const report = await recover(h.recovery, h.clock);

    expect(report).toMatchObject({ scanned: 1, written: 0, abandoned: 1, stopReason: "drained" });
    expect(historyStateOf("run_bad_role")).toBe("skipped");
    expect(getStoredMessageSync(h.conversationId, ASSISTANT_MESSAGE_ID)).toBeNull();
  });

  it("abandons a claim whose capture has an empty id", async () => {
    const h = harness();
    await abandonedClaim(h, {
      id: "run_empty_id",
      capture: {
        id: "",
        role: "assistant",
        parts: [{ type: "text", text: ANSWER }],
      } as FinalUIMessage,
    });

    const report = await recover(h.recovery, h.clock);

    expect(report).toMatchObject({ scanned: 1, written: 0, abandoned: 1, stopReason: "drained" });
    expect(historyStateOf("run_empty_id")).toBe("skipped");
    expect(getStoredMessageSync(h.conversationId, ASSISTANT_MESSAGE_ID)).toBeNull();
  });
});

describe("the messages table the guard writes to", () => {
  it("is the effective schema, with a nullable role and a format column", () => {
    // The guard reads `format` and writes `role = NULL` (the runtime's storage
    // format carries the role inside `content`). Both must hold in the database the
    // application actually opens, not only in the bootstrap DDL.
    const columns = db.query("PRAGMA table_info(messages)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get("role")?.notnull).toBe(0);
    expect(byName.has("format")).toBe(true);
    expect(byName.has("parent_id")).toBe(true);
  });
});
// -- 13. Recurring recovery (scheduled) ---------------------------------------

describe("claimed history recovery � recurring sweep", () => {
  it("does not recover a claim younger than the staleness window", async () => {
    const h = harness();
    await abandonedClaim(h, { id: "run_fresh", claimAgeMs: 100 });

    startClaimedHistoryRecovery(h.recovery, {
      intervalMs: 20,
      staleMs: 1_000,
      now: () => h.clock.now,
      runImmediately: false,
    });

    await Bun.sleep(80);
    expect(getClaimedHistoryRecoveryState().ticks).toBeGreaterThanOrEqual(1);
    expect(historyStateOf("run_fresh")).toBe("claimed");
  });

  it("recovers a stale claim on a later scheduled sweep without a restart", async () => {
    const h = harness();
    await abandonedClaim(h, { id: "run_later", claimAgeMs: 100 });

    startClaimedHistoryRecovery(h.recovery, {
      intervalMs: 20,
      staleMs: 1_000,
      now: () => h.clock.now,
      runImmediately: false,
    });

    await Bun.sleep(60);
    expect(historyStateOf("run_later")).toBe("claimed");

    h.clock.now += 2_000;
    await Bun.sleep(60);

    expect(historyStateOf("run_later")).toBe("done");
    const stored = getStoredMessageSync(h.conversationId, ASSISTANT_MESSAGE_ID);
    expect(stored).not.toBeNull();
  });

  it("a second overlapping tick is a no-op and does not duplicate the reply", async () => {
    const h = harness();
    await abandonedClaim(h, { id: "run_overlap" });

    startClaimedHistoryRecovery(h.recovery, {
      intervalMs: 10_000,
      staleMs: 1_000,
      now: () => h.clock.now,
      runImmediately: false,
    });

    const first = runClaimedHistoryRecoveryOnce();
    expect(getClaimedHistoryRecoveryState().inFlight).toBe(true);
    expect(await runClaimedHistoryRecoveryOnce()).toBeNull();

    const report = await first;
    expect(report?.written).toBe(1);
    expect(getClaimedHistoryRecoveryState().ticks).toBe(1);

    const rows = db
      .query<{ n: number }, string[]>("SELECT COUNT(*) AS n FROM messages WHERE id = ?")
      .get(ASSISTANT_MESSAGE_ID)!;
    expect(rows.n).toBe(1);
  });

  it("a failed sweep does not permanently prevent subsequent sweeps", async () => {
    const h = harness();
    await abandonedClaim(h, { id: "run_flaky" });

    let throwOnce = true;
    const flakyStore = new Proxy(h.store, {
      get(target, prop) {
        if (prop === "listStaleClaimedHistory") {
          return (...args: unknown[]) => {
            if (throwOnce) {
              throwOnce = false;
              throw new Error("boom");
            }
            return (
              target as { listStaleClaimedHistory: (...a: unknown[]) => unknown }
            ).listStaleClaimedHistory(...args);
          };
        }
        const value = (target as unknown as Record<string, unknown>)[prop as string];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as SqliteResumableStreamStore;
    const flakyDeps: ClaimedHistoryRecoveryDeps = {
      store: flakyStore,
      messages: h.recovery.messages,
    };

    startClaimedHistoryRecovery(flakyDeps, {
      intervalMs: 10_000,
      staleMs: 1_000,
      now: () => h.clock.now,
      runImmediately: false,
    });

    expect(await runClaimedHistoryRecoveryOnce()).toMatchObject({ stopReason: "scan_failed" });
    const report = await runClaimedHistoryRecoveryOnce();
    expect(report?.written).toBe(1);
    expect(historyStateOf("run_flaky")).toBe("done");
  });

  it("stops and drains before the database closes", async () => {
    const h = harness();
    await abandonedClaim(h, { id: "run_drain" });

    startClaimedHistoryRecovery(h.recovery, {
      intervalMs: 10_000,
      staleMs: 1_000,
      now: () => h.clock.now,
      runImmediately: true,
    });
    expect(getClaimedHistoryRecoveryState().inFlight).toBe(true);

    expect(stopClaimedHistoryRecovery()).toBe(true);

    let drained = false;
    const drain = drainClaimedHistoryRecovery().then(() => {
      drained = true;
    });
    expect(drained).toBe(false);

    await drain;
    expect(drained).toBe(true);
    expect(getClaimedHistoryRecoveryState().inFlight).toBe(false);

    expect(await runClaimedHistoryRecoveryOnce()).toBeNull();
    await drainClaimedHistoryRecovery();
  });
});
