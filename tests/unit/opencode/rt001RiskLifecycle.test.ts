import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { ClientError } from "@opencode/client";
import * as realOpenCodeClient from "@/services/opencode/client.ts";
import type { OpenCodeClient } from "@/services/opencode/client.ts";

/**
 * RT-001 — one risk-bearing create followed through EVERY seam.
 *
 * This drives the real `ensureOpenCodeSession`, the real durable journal
 * (`opencodeSessionOrphans` over the file-backed test database) and the real
 * `runOrphanReconciliationOnce`. Only the upstream server, the conversation
 * row store and the workspace resolver are faked, so the lifecycle assertions
 * are about TBAi's own code rather than a hand-built journal.
 *
 * The dangerous interleaving — the first create's response is lost and its
 * request commits AFTER the retry has been bound and later terminated — is
 * SIMULATED deterministically here: the test adds the id back to the fake
 * server, which stands in for the outstanding request. It is NOT reproduced
 * against a real OpenCode process; the real-server suite
 * (`opencode-session-idempotency-runtime.test.ts`, opt-in via
 * TBAI_OPENCODE_RUNTIME_TESTS=1) covers upstream idempotency only. Upstream
 * exposes no terminality signal, so the reconciler's horizon remains bounded
 * best effort by design.
 *
 * The sequence under test:
 *   1. create #1 fails ambiguously; the exact-id probe answers 404
 *   2. the SAME id is retried successfully and the pointer is written
 *   3. the risk-bearing intent survives the successful bind
 *   4. reconciling while bound keeps the row and removes nothing
 *   5. termination removes the session and keeps the risk, ending its epoch
 *   6. the outstanding create recreates the id; reconciliation removes it again
 *      and keeps the row
 *   7. the next 404 starts a fresh absence epoch
 *   8. a restarted reconciler still knows the risk from the database alone
 */

const SUBMITTED_DIRECTORY = "D:\\ws\\rt001-lifecycle";
const CONVERSATION_ID = "conv-lifecycle";
/** Future timestamps so the grace window never defers these rows. */
const NOW_BOUND = 1_900_000_000_000;
const NOW_RECREATED = NOW_BOUND + 60_000;
const NOW_ABSENT = NOW_BOUND + 120_000;

function sessionNotFound(sessionID: string): unknown {
  return { _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` };
}

let conversation: Record<string, unknown> | null = null;
let remote: Set<string>;
let getImpl: (args: { sessionID: string }) => Promise<unknown>;
let createImpl: (args: { id: string }) => Promise<unknown>;
let removeImpl: (args: { sessionID: string }) => Promise<unknown>;

mockLifecycleSeams();

/** The upstream server stand-in shared by the session and reconciler seams. */
function lifecycleClient(): OpenCodeClient {
  return {
    session: {
      get: (args: { sessionID: string }) => getImpl(args),
      create: (args: { id: string }) => createImpl(args),
      remove: (args: { sessionID: string }) => removeImpl(args),
      interrupt: async () => ({ interrupted: true }),
    },
    // The create path only reads these when it must resolve a model; the
    // conversation below stores none, so an empty catalogue is honest.
    agent: { list: async () => ({ data: [] }) },
    model: { list: async () => ({ data: [] }) },
  } as unknown as OpenCodeClient;
}

function mockLifecycleSeams(): void {
  // The conversation store is the only storage seam replaced. The journal is
  // deliberately REAL so its durability (not a mock's bookkeeping) is proven.
  mock.module("@/services/storage", () => ({
    conversationService: {
      get: async () => conversation,
      update: async (_id: string, patch: Record<string, unknown>) => {
        conversation = { ...(conversation ?? {}), ...patch };
      },
    },
  }));

  mock.module("@/services/workspace", () => ({
    resolveConversationWorkspace: async () => ({ dir: SUBMITTED_DIRECTORY }),
  }));

  // `sessionModel` is deliberately NOT mocked: the conversation stores no
  // model, so the real resolver yields none and the create stays unbound.
  mock.module("@/services/opencode/client", () => ({
    ...realOpenCodeClient,
    createOpenCodeClient: () => lifecycleClient(),
  }));
}

const { db } = await import("@/db/index.ts");
const { applyOpenCodeOrphanSchema } = await import("@/db/schema/opencode-session-orphans.ts");
const { opencodeOrphanService } = await import("@/services/storage/opencodeSessionOrphans.ts");
const { openCodeServerManager } = await import("@/services/opencode/serverManager.ts");
const { ensureOpenCodeSession, terminateOpenCodeSession, isOpenCodeSessionCreateInFlight } =
  await import("@/services/opencode/sessions.ts");
const { runOrphanReconciliationOnce, startOrphanReconciliation, stopOrphanReconciliation } =
  await import("@/services/opencode/orphanReconciler.ts");

(openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
  async () => "http://127.0.0.1:0";

/** The real journal over the file-backed test database. */
const reconcilerDeps = {
  listUnresolved: (limit: number) => opencodeOrphanService.listUnresolvedOrphans(limit),
  getConversation: async (): Promise<{ opencodeSessionId: string | null } | null> =>
    conversation
      ? { opencodeSessionId: (conversation.opencodeSessionId as string | null | undefined) ?? null }
      : null,
  recordProbe: (input: {
    conversationId: string;
    sessionId: string;
    outcome: "present" | "absent";
    at: number;
  }) => opencodeOrphanService.recordProbe(input),
  settleOwned: (conversationId: string, sessionId: string, at: number) =>
    opencodeOrphanService.settleOwnedSession({ conversationId, sessionId, at }),
  settleAbsent: (input: {
    conversationId: string;
    sessionId: string;
    at: number;
    absenceHorizonMs: number;
  }) => opencodeOrphanService.settleAbsentSession(input),
  getOpenSessionRisk: (conversationId: string, sessionId: string) =>
    opencodeOrphanService.getOpenSessionRisk(conversationId, sessionId),
  isCreateInFlight: isOpenCodeSessionCreateInFlight,
  getRunningBaseUrl: async () => "http://127.0.0.1:0",
  createClient: () => lifecycleClient(),
};

function startAt(now: number, absenceHorizonMs: number): void {
  stopOrphanReconciliation();
  startOrphanReconciliation({
    deps: reconcilerDeps,
    runImmediately: false,
    graceMs: 0,
    absenceHorizonMs,
    limit: 20,
    now: () => now,
  });
}

function journalRow(sessionId: string): Record<string, unknown> | null {
  return (
    (db
      .query(
        `SELECT * FROM opencode_session_orphans
          WHERE conversation_id = ? AND session_id = ?`,
      )
      .get(CONVERSATION_ID, sessionId) as Record<string, unknown> | null) ?? null
  );
}

beforeEach(() => {
  applyOpenCodeOrphanSchema(db);
  db.run("DELETE FROM opencode_session_orphans");
  stopOrphanReconciliation();

  conversation = {
    id: CONVERSATION_ID,
    engine: "opencode",
    opencodeSessionId: null,
    opencodeAgent: null,
    opencodeModel: null,
    opencodeVariant: null,
  };
  remote = new Set<string>();
  getImpl = async (args) => {
    if (!remote.has(args.sessionID)) throw sessionNotFound(args.sessionID);
    return { id: args.sessionID, location: { directory: SUBMITTED_DIRECTORY } };
  };
  createImpl = async (args) => {
    remote.add(args.id);
    return { id: args.id, location: { directory: SUBMITTED_DIRECTORY } };
  };
  removeImpl = async (args) => {
    remote.delete(args.sessionID);
  };
});

afterEach(() => {
  stopOrphanReconciliation();
});

describe("RT-001 risk lifecycle — create → bind → terminate → reconcile", () => {
  it("carries one risk from a successful bind through termination and a late recreation", async () => {
    // --- 1/2. ambiguous create, 404, same-id retry, successful bind ---------
    let attempts = 0;
    createImpl = async (args) => {
      attempts += 1;
      if (attempts === 1) {
        throw new ClientError("Transport", { cause: new Error("lost response") });
      }
      remote.add(args.id);
      return { id: args.id, location: { directory: SUBMITTED_DIRECTORY } };
    };

    const binding = await ensureOpenCodeSession(CONVERSATION_ID);
    const sessionId = binding.sessionId;

    expect(attempts).toBe(2);
    expect(conversation?.opencodeSessionId).toBe(sessionId);
    expect(remote.has(sessionId)).toBe(true);

    // --- 3. the risk survives the successful bind ---------------------------
    let row = journalRow(sessionId);
    expect(row).not.toBeNull();
    expect(row?.phase).toBe("intent");
    expect(row?.late_create_risk).toBe(1);
    expect(row?.first_absent_at).toBeNull();
    expect(row?.resolved_at).toBeNull();

    // --- 4. reconciling a BOUND risk-bearing row keeps it ------------------
    startAt(NOW_BOUND, 24 * 60 * 60 * 1000);
    const boundPass = await runOrphanReconciliationOnce();
    expect(boundPass).toMatchObject({ retainedBound: 1, bound: 0, removed: 0 });

    expect(remote.has(sessionId)).toBe(true);
    row = journalRow(sessionId);
    expect(row?.late_create_risk).toBe(1);
    expect(row?.first_absent_at).toBeNull();
    expect(row?.last_checked_at).toBe(NOW_BOUND);

    // --- 5. termination removes the session, keeps the risk ----------------
    const terminated = await terminateOpenCodeSession(CONVERSATION_ID);
    expect(terminated).toEqual({ terminated: true });
    expect(remote.has(sessionId)).toBe(false);
    expect(conversation?.opencodeSessionId).toBeNull();

    row = journalRow(sessionId);
    expect(row?.late_create_risk).toBe(1);
    expect(row?.first_absent_at).toBeNull();
    expect(row?.resolved_at).toBeNull();

    // --- 6. the outstanding create commits and recreates the id ------------
    remote.add(sessionId);

    startAt(NOW_RECREATED, 24 * 60 * 60 * 1000);
    const recreatePass = await runOrphanReconciliationOnce();
    expect(recreatePass).toMatchObject({ retainedAfterRemoval: 1, removed: 0 });

    expect(remote.has(sessionId)).toBe(false);
    row = journalRow(sessionId);
    expect(row?.late_create_risk).toBe(1);
    expect(row?.first_absent_at).toBeNull();
    expect(row?.resolved_at).toBeNull();

    // --- 7. the next 404 begins a FRESH absence epoch ----------------------
    startAt(NOW_ABSENT, 10_000);
    const absentPass = await runOrphanReconciliationOnce();
    expect(absentPass).toMatchObject({ lateRisk: 1, expiredAbsent: 0, absent: 0 });

    row = journalRow(sessionId);
    expect(row?.late_create_risk).toBe(1);
    expect(row?.first_absent_at).toBe(NOW_ABSENT);
    expect(row?.resolved_at).toBeNull();

    // --- 8. a restart re-derives the obligation from the database alone ----
    startAt(NOW_ABSENT + 5_000, 10_000);
    const restartedPass = await runOrphanReconciliationOnce();
    expect(restartedPass).toMatchObject({ lateRisk: 1, expiredAbsent: 0 });

    row = journalRow(sessionId);
    expect(row?.late_create_risk).toBe(1);
    // The epoch is the one stamped before the restart, not a new one.
    expect(row?.first_absent_at).toBe(NOW_ABSENT);

    // ...and only the bounded horizon releases it (best effort, not proof).
    startAt(NOW_ABSENT + 10_001, 10_000);
    const expiredPass = await runOrphanReconciliationOnce();
    expect(expiredPass).toMatchObject({ expiredAbsent: 1 });
    expect(journalRow(sessionId)).toBeNull();
  });
});
