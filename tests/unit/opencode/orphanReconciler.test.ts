import { describe, it, expect, afterEach } from "bun:test";
import type { OpenCodeClient } from "@/services/opencode/client";
import { OpenCodeError } from "@/services/opencode/errors";
import type { OpenCodeOrphanRecord } from "@/services/storage/opencodeSessionOrphans";
import {
  DEFAULT_ORPHAN_RECONCILE_GRACE_MS,
  DEFAULT_ORPHAN_RECONCILE_INTERVAL_MS,
  DEFAULT_ORPHAN_RECONCILE_LIMIT,
  drainOrphanReconciliation,
  getOrphanReconciliationState,
  runOrphanReconciliationOnce,
  startOrphanReconciliation,
  stopOrphanReconciliation,
  type OpenCodeOrphanReconcilerDeps,
} from "@/services/opencode/orphanReconciler";

/**
 * The reconciler's decision rules, exercised with an injected journal and a
 * stubbed OpenCode client. The probe and removal helpers are the REAL ones
 * (`fetchOpenCodeSession` / `removeUnboundSession`), so "removal confirmed" is
 * tested rather than assumed: a resolved `remove()` that leaves the session in
 * place must not clear the row.
 *
 * Every write to the journal is recorded as a `clear`, which is what lets the
 * tests assert the *obligation* discharged (intent deleted vs orphan resolved)
 * and, more importantly, that no removal happens on inconclusive evidence.
 */

const NOW = 1_800_000_000_000;

/** The tagged 404 the real client surfaces for a missing session. */
const NOT_FOUND = new OpenCodeError("session_not_found", "OpenCode session not found", 404);

function record(overrides: Partial<OpenCodeOrphanRecord> = {}): OpenCodeOrphanRecord {
  return {
    conversationId: "conv-1",
    sessionId: "ses_orphan0001",
    phase: "orphan",
    firstSeenAt: new Date(NOW - 600_000),
    lastSeenAt: new Date(NOW - 600_000),
    resolvedAt: null,
    // The create path ruled out an outstanding duplicate for this row.
    lateCreateRisk: false,
    firstAbsentAt: null,
    lastCheckedAt: null,
    ...overrides,
  };
}

type ConversationRow = { opencodeSessionId: string | null };

interface HarnessOptions {
  /** Pass an existing array to share journal state across two harnesses. */
  rows?: OpenCodeOrphanRecord[];
  runningUrl?: string | null;
}

function makeHarness(options: HarnessOptions = {}) {
  const rows = options.rows ?? [];
  const conversations = new Map<string, ConversationRow>();
  const state = {
    rows,
    conversations,
    remote: new Set<string>(),
    runningUrl:
      options.runningUrl === undefined
        ? ("http://127.0.0.1:0" as string | null)
        : options.runningUrl,
    /** Thrown by every probe, before any existence check. */
    probeError: null as Error | null,
    /** The probe answers for a different id (identity mismatch). */
    probeMismatch: false,
    /** Thrown by probes made after a remove call. */
    probeErrorAfterRemove: null as Error | null,
    removeError: null as Error | null,
    /** A resolved remove that leaves the session present. */
    removeEffect: "remove" as "remove" | "keep",
    /** Thrown by every journal clear (settleOwned / settleAbsent). */
    clearError: null as Error | null,
    /** Thrown by every probe-outcome write. */
    probeRecordError: null as Error | null,
    /** Thrown by every owned-row settlement. */
    settleOwnedError: null as Error | null,
    /** Thrown by every absence settlement. */
    settleAbsentError: null as Error | null,
    /** Thrown by every delete-marker settlement. */
    settleDeletedError: null as Error | null,
    /** Delete-marker settlements, in call order. */
    deletedSettles: [] as Array<{
      conversationId: string;
      sessionId: string;
      risk: "risk" | "safe";
    }>,
    /** Thrown by every current-risk read. */
    riskReadError: null as Error | null,
    /** `(conversation, session)` pairs this process is still creating. */
    inFlightKeys: new Set<string>(),
    listError: null as Error | null,
    conversationError: null as Error | null,
    getConversationImpl: null as ((id: string) => Promise<ConversationRow | null>) | null,
    getCalls: [] as string[],
    removeCalls: [] as string[],
    createClientCalls: 0,
    clears: [] as Array<{
      kind: OpenCodeOrphanRecord["phase"];
      conversationId: string;
      sessionId: string;
    }>,
    probes: [] as Array<{
      conversationId: string;
      sessionId: string;
      outcome: "present" | "absent";
      at: number;
    }>,
    touches: [] as Array<{ conversationId: string; sessionId: string; at: number }>,
    listLimits: [] as number[],
    conversationReads: 0,
  };

  const client = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        state.getCalls.push(sessionID);
        if (state.probeError) throw state.probeError;
        if (state.removeCalls.length > 0 && state.probeErrorAfterRemove) {
          throw state.probeErrorAfterRemove;
        }
        if (!state.remote.has(sessionID)) throw NOT_FOUND;
        return {
          id: state.probeMismatch ? `${sessionID}-other` : sessionID,
          location: { directory: "D:\\ws\\conv" },
        };
      },
      remove: async ({ sessionID }: { sessionID: string }) => {
        state.removeCalls.push(sessionID);
        if (state.removeError) throw state.removeError;
        if (state.removeEffect === "remove") state.remote.delete(sessionID);
      },
    },
  } as unknown as OpenCodeClient;

  function removeRow(conversationId: string, sessionId: string): boolean {
    const index = rows.findIndex(
      (row) => row.conversationId === conversationId && row.sessionId === sessionId,
    );
    if (index < 0) return false;
    rows.splice(index, 1);
    return true;
  }

  const deps: OpenCodeOrphanReconcilerDeps = {
    listUnresolved: async (batchLimit) => {
      state.listLimits.push(batchLimit);
      if (state.listError) throw state.listError;
      // Mirrors the real store's fairness ordering: least-recently-examined
      // first, never-probed rows by first-seen. Without this the rotation
      // assertions below would pass on insertion order alone.
      const order = (row: OpenCodeOrphanRecord) => (row.lastCheckedAt ?? row.firstSeenAt).getTime();
      return (
        [...rows]
          .sort(
            (a, b) =>
              order(a) - order(b) ||
              a.firstSeenAt.getTime() - b.firstSeenAt.getTime() ||
              a.conversationId.localeCompare(b.conversationId) ||
              a.sessionId.localeCompare(b.sessionId),
          )
          .slice(0, batchLimit)
          // The real store maps rows to fresh objects. Returning the harness's
          // own row objects would let later durable writes mutate the record the
          // pass already listed, hiding exactly the stale-flag race these tests
          // exercise.
          .map((row) => ({ ...row }))
      );
    },
    getConversation: async (id) => {
      state.conversationReads += 1;
      if (state.getConversationImpl) return state.getConversationImpl(id);
      if (state.conversationError) throw state.conversationError;
      return conversations.get(id) ?? null;
    },
    // Mirrors the real store: a probe outcome is durable state, not a call
    // record. `present` ends the absence epoch but never settles the risk;
    // `absent` stamps the FIRST 404 of the current epoch only.
    recordProbe: async ({ conversationId, sessionId, outcome, at }) => {
      if (state.probeRecordError) throw state.probeRecordError;
      state.probes.push({ conversationId, sessionId, outcome, at });
      const row = rows.find(
        (r) => r.conversationId === conversationId && r.sessionId === sessionId,
      );
      if (!row) return false;
      row.lastCheckedAt = new Date(at);
      if (outcome === "present") {
        row.firstAbsentAt = null;
      } else {
        row.firstAbsentAt ??= new Date(at);
      }
      return true;
    },
    // Mirrors `settleOwnedSession`: decides from the CURRENT row, atomically.
    // A risk-bearing row is touched (epoch reset + rotation) and kept; a
    // risk-free row is cleared with the established phase-specific operation.
    settleOwned: async (conversationId, sessionId, at) => {
      if (state.settleOwnedError) throw state.settleOwnedError;
      const row = rows.find(
        (r) => r.conversationId === conversationId && r.sessionId === sessionId,
      );
      if (!row) return "absent";
      // Mirrors the delete-marker branch: bound markers are retained and
      // rotated, never settled by the generic ownership operation.
      if (row.phase === "delete") {
        state.touches.push({ conversationId, sessionId, at });
        row.firstAbsentAt = null;
        row.lastCheckedAt = new Date(at);
        return "retained";
      }
      if (row.lateCreateRisk) {
        state.touches.push({ conversationId, sessionId, at });
        row.firstAbsentAt = null;
        row.lastCheckedAt = new Date(at);
        return "retained";
      }
      if (state.clearError) throw state.clearError;
      state.clears.push({ kind: row.phase, conversationId, sessionId });
      return removeRow(conversationId, sessionId) ? "cleared" : "absent";
    },
    // Mirrors `settleConfirmedDeletion`: a nonzero risk reopens and retains the
    // audit row; a risk-free one is stamped resolved (kept, never deleted).
    settleDeleted: async (conversationId, sessionId, at) => {
      if (state.settleDeletedError) throw state.settleDeletedError;
      const row = rows.find(
        (r) => r.conversationId === conversationId && r.sessionId === sessionId,
      );
      if (!row) return "absent";
      state.deletedSettles.push({
        conversationId,
        sessionId,
        risk: row.lateCreateRisk ? "risk" : "safe",
      });
      if (row.lateCreateRisk) {
        state.touches.push({ conversationId, sessionId, at });
        row.resolvedAt = null;
        row.firstAbsentAt = null;
        row.lastCheckedAt = new Date(at);
        return "retained";
      }
      if (row.resolvedAt !== null) return "absent";
      row.resolvedAt = new Date(at);
      return "released";
    },
    // Mirrors `settleAbsentSession`: the recorded 404 releases a risk-free row
    // and retains a risk-bearing one until its own epoch horizon elapses.
    settleAbsent: async ({ conversationId, sessionId, at, absenceHorizonMs }) => {
      if (state.settleAbsentError) throw state.settleAbsentError;
      const row = rows.find(
        (r) => r.conversationId === conversationId && r.sessionId === sessionId,
      );
      if (!row) return "absent";
      const riskBearing = row.lateCreateRisk;
      if (riskBearing) {
        const firstAbsentAt = row.firstAbsentAt?.getTime() ?? at;
        if (at - firstAbsentAt < absenceHorizonMs) return "retained";
      }
      if (state.clearError) throw state.clearError;
      state.clears.push({ kind: row.phase, conversationId, sessionId });
      if (!removeRow(conversationId, sessionId)) return "absent";
      return riskBearing ? "expired" : "cleared";
    },
    // Mirrors `getOpenSessionRisk`: the durable row, not the listed snapshot.
    getOpenSessionRisk: async (conversationId, sessionId) => {
      if (state.riskReadError) throw state.riskReadError;
      const row = rows.find(
        (r) => r.conversationId === conversationId && r.sessionId === sessionId,
      );
      if (!row) return "absent";
      return row.lateCreateRisk ? "risk" : "safe";
    },
    isCreateInFlight: (conversationId, sessionId) =>
      state.inFlightKeys.has(`${conversationId}\u0000${sessionId}`),
    getRunningBaseUrl: async () => state.runningUrl,
    createClient: () => {
      state.createClientCalls += 1;
      return client;
    },
  };

  return { state, deps };
}

/** Starts with the immediate pass off so each test drives its own pass. */
function start(
  deps: OpenCodeOrphanReconcilerDeps,
  overrides: Partial<Parameters<typeof startOrphanReconciliation>[0]> = {},
) {
  stopOrphanReconciliation();
  return startOrphanReconciliation({
    deps,
    runImmediately: false,
    graceMs: 0,
    now: () => NOW,
    ...overrides,
  });
}

afterEach(() => {
  stopOrphanReconciliation();
});

describe("runOrphanReconciliationOnce — ownership", () => {
  it("clears a row whose conversation now points at the session, and never touches the remote", async () => {
    const h = makeHarness({ rows: [record()] });
    h.state.conversations.set("conv-1", { opencodeSessionId: "ses_orphan0001" });
    h.state.remote.add("ses_orphan0001");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ scanned: 1, bound: 1, removed: 0, unresolved: 0 });
    expect(h.state.clears).toEqual([
      { kind: "orphan", conversationId: "conv-1", sessionId: "ses_orphan0001" },
    ]);
    expect(h.state.getCalls).toHaveLength(0);
    expect(h.state.removeCalls).toHaveLength(0);
    expect(h.state.rows).toHaveLength(0);
  });

  it("clears an intent (not the orphan) when a crash happened after the pointer was written", async () => {
    const h = makeHarness({ rows: [record({ phase: "intent" })] });
    h.state.conversations.set("conv-1", { opencodeSessionId: "ses_orphan0001" });
    h.state.remote.add("ses_orphan0001");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ bound: 1, removed: 0 });
    expect(h.state.clears).toEqual([
      { kind: "intent", conversationId: "conv-1", sessionId: "ses_orphan0001" },
    ]);
    expect(h.state.removeCalls).toHaveLength(0);
  });

  it("re-checks ownership after the probe: a pointer written meanwhile prevents removal", async () => {
    const h = makeHarness({ rows: [record()] });
    h.state.remote.add("ses_orphan0001");
    let reads = 0;
    h.state.getConversationImpl = async () => {
      reads += 1;
      return reads === 1 ? { opencodeSessionId: null } : { opencodeSessionId: "ses_orphan0001" };
    };
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(reads).toBe(2);
    expect(report).toMatchObject({ bound: 1, removed: 0 });
    expect(h.state.removeCalls).toHaveLength(0);
    expect(h.state.rows).toHaveLength(0);
  });

  it("retains a risk-bearing orphan when the conversation is bound during the ownership recheck", async () => {
    const h = makeHarness({
      rows: [
        record({
          lateCreateRisk: true,
          // An absence epoch from before the binding; it must not survive.
          firstAbsentAt: new Date(NOW - 100_000),
        }),
      ],
    });
    h.state.remote.add("ses_orphan0001");
    let reads = 0;
    h.state.getConversationImpl = async () => {
      reads += 1;
      // The pass lists and checks the row as UNBOUND, so it probes the remote;
      // the pointer is written before the post-probe ownership recheck.
      return reads === 1 ? { opencodeSessionId: null } : { opencodeSessionId: "ses_orphan0001" };
    };
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(reads).toBe(2);
    // The probe ran and confirmed presence, so the bind was discovered at the
    // LATE recheck rather than at the pre-probe ownership read.
    expect(h.state.getCalls).toEqual(["ses_orphan0001"]);
    expect(report).toMatchObject({
      scanned: 1,
      bound: 0,
      retainedBound: 1,
      removed: 0,
      unresolved: 0,
    });
    expect(h.state.removeCalls).toHaveLength(0);
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.lateCreateRisk).toBe(true);
    expect(h.state.rows[0]?.firstAbsentAt).toBeNull();
    expect(h.state.rows[0]?.lastCheckedAt).toEqual(new Date(NOW));

    // The retained row is usable by the next pass: with the conversation
    // unbound and the session gone, the next 404 starts a FRESH epoch.
    h.state.getConversationImpl = null;
    h.state.conversations.delete("conv-1");
    h.state.remote.delete("ses_orphan0001");
    start(h.deps, { absenceHorizonMs: 50_000, now: () => NOW + 1_000 });
    const next = await runOrphanReconciliationOnce();

    expect(next).toMatchObject({ lateRisk: 1, expiredAbsent: 0, absent: 0 });
    expect(h.state.rows[0]?.firstAbsentAt).toEqual(new Date(NOW + 1_000));
    expect(h.state.rows).toHaveLength(1);
  });

  it("uses the current durable risk at the recheck, not the flag read before the probe", async () => {
    // The listed record is a snapshot, exactly as the real store returns one.
    // The durable row is RE-ARMED while the probe is in flight, which the
    // snapshot cannot reflect.
    const listed = record({ lateCreateRisk: false });
    const h = makeHarness({ rows: [listed] });
    h.state.remote.add("ses_orphan0001");
    let reads = 0;
    h.state.getConversationImpl = async () => {
      reads += 1;
      if (reads === 1) {
        listed.lateCreateRisk = true;
        return { opencodeSessionId: null };
      }
      return { opencodeSessionId: "ses_orphan0001" };
    };
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(reads).toBe(2);
    expect(report).toMatchObject({ bound: 0, retainedBound: 1, removed: 0, unresolved: 0 });
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.lateCreateRisk).toBe(true);
  });

  it("leaves the recheck row open when the bound settlement cannot be recorded", async () => {
    const h = makeHarness({ rows: [record({ lateCreateRisk: true })] });
    h.state.remote.add("ses_orphan0001");
    let reads = 0;
    h.state.getConversationImpl = async () => {
      reads += 1;
      return reads === 1 ? { opencodeSessionId: null } : { opencodeSessionId: "ses_orphan0001" };
    };
    h.state.settleOwnedError = new Error("database is closed");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(reads).toBe(2);
    expect(report).toMatchObject({
      bound: 0,
      retainedBound: 0,
      unresolved: 1,
      removed: 0,
    });
    expect(h.state.getCalls).toEqual(["ses_orphan0001"]);
    expect(h.state.removeCalls).toHaveLength(0);
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.lateCreateRisk).toBe(true);
  });
});

/**
 * The listed record is a snapshot taken before the remote probe. A create path
 * can re-arm its durable risk while the probe is in flight, so every decision
 * that follows must be made against the journal's CURRENT row. These tests
 * mutate the durable row after it has been listed to prove exactly that.
 */
describe("runOrphanReconciliationOnce — the listed record is a snapshot", () => {
  it("retains when a 404 arrives after the durable risk was re-armed mid-pass", async () => {
    const listed = record({ phase: "intent", lateCreateRisk: false });
    const h = makeHarness({ rows: [listed] });
    let reads = 0;
    h.state.getConversationImpl = async () => {
      reads += 1;
      // Re-armed AFTER the row was listed, BEFORE the 404 is settled.
      if (reads === 1) listed.lateCreateRisk = true;
      return { opencodeSessionId: null };
    };
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ absent: 0, lateRisk: 1, expiredAbsent: 0, unresolved: 0 });
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.lateCreateRisk).toBe(true);
  });

  it("retains after a confirmed removal when the durable risk was re-armed mid-pass", async () => {
    const listed = record({ phase: "intent", lateCreateRisk: false });
    const h = makeHarness({ rows: [listed] });
    h.state.remote.add("ses_orphan0001");
    let reads = 0;
    h.state.getConversationImpl = async () => {
      reads += 1;
      if (reads === 1) listed.lateCreateRisk = true;
      return { opencodeSessionId: null };
    };
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ removed: 0, retainedAfterRemoval: 1 });
    expect(h.state.removeCalls).toEqual(["ses_orphan0001"]);
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.lateCreateRisk).toBe(true);
    expect(h.state.rows[0]?.firstAbsentAt).toBeNull();
  });

  it("blocks removal on a re-armed row when the presence write was not recorded", async () => {
    const listed = record({ phase: "intent", lateCreateRisk: false });
    const h = makeHarness({ rows: [listed] });
    h.state.remote.add("ses_orphan0001");
    h.state.probeRecordError = new Error("database is closed");
    h.state.getConversationImpl = async () => {
      listed.lateCreateRisk = true;
      return { opencodeSessionId: null };
    };
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ unresolved: 1, removed: 0, retainedAfterRemoval: 0 });
    expect(h.state.removeCalls).toHaveLength(0);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.lateCreateRisk).toBe(true);
  });

  it("blocks removal when the current risk cannot be read after an unrecorded presence", async () => {
    const h = makeHarness({ rows: [record({ phase: "intent", lateCreateRisk: false })] });
    h.state.remote.add("ses_orphan0001");
    h.state.probeRecordError = new Error("database is closed");
    h.state.riskReadError = new Error("database is closed");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ unresolved: 1, removed: 0 });
    expect(h.state.removeCalls).toHaveLength(0);
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
  });

  it("leaves the row open when the absence settlement cannot be recorded", async () => {
    const h = makeHarness({ rows: [record({ phase: "intent", lateCreateRisk: true })] });
    h.state.settleAbsentError = new Error("database is closed");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ unresolved: 1, absent: 0, lateRisk: 0, expiredAbsent: 0 });
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.lateCreateRisk).toBe(true);
  });
});

describe("runOrphanReconciliationOnce — remote evidence", () => {
  it("removes an unbound session whose conversation is gone, after confirming removal", async () => {
    const h = makeHarness({ rows: [record()] });
    h.state.remote.add("ses_orphan0001");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ scanned: 1, removed: 1, unresolved: 0 });
    expect(h.state.removeCalls).toEqual(["ses_orphan0001"]);
    expect(h.state.remote.has("ses_orphan0001")).toBe(false);
    expect(h.state.clears).toEqual([
      { kind: "orphan", conversationId: "conv-1", sessionId: "ses_orphan0001" },
    ]);
    expect(h.state.rows).toHaveLength(0);
  });

  it("removes a session whose conversation now points at a different one", async () => {
    const h = makeHarness({ rows: [record()] });
    h.state.conversations.set("conv-1", { opencodeSessionId: "ses_replacement1" });
    h.state.remote.add("ses_orphan0001");
    h.state.remote.add("ses_replacement1");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ removed: 1 });
    expect(h.state.removeCalls).toEqual(["ses_orphan0001"]);
    expect(h.state.remote.has("ses_replacement1")).toBe(true);
  });

  it("deletes a risk-free intent when the remote session is absent (positive 404)", async () => {
    // A risk-free intent never carried an ambiguous create request, so absence
    // is terminal and the row can go.
    const h = makeHarness({ rows: [record({ phase: "intent", lateCreateRisk: false })] });
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ absent: 1, removed: 0 });
    expect(h.state.clears).toEqual([
      { kind: "intent", conversationId: "conv-1", sessionId: "ses_orphan0001" },
    ]);
    expect(h.state.removeCalls).toHaveLength(0);
    expect(h.state.rows).toHaveLength(0);
  });

  it("retains a risk-bearing intent after a 404: absence now is not terminality", async () => {
    const h = makeHarness({ rows: [record({ phase: "intent", lateCreateRisk: true })] });
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ absent: 0, lateRisk: 1, removed: 0, unresolved: 0 });
    expect(h.state.clears).toHaveLength(0);
    expect(h.state.removeCalls).toHaveLength(0);
    expect(h.state.probes).toEqual([
      { conversationId: "conv-1", sessionId: "ses_orphan0001", outcome: "absent", at: NOW },
    ]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.firstAbsentAt).toEqual(new Date(NOW));
    expect(h.state.rows[0]?.lateCreateRisk).toBe(true);
  });

  it("keeps the FIRST absence timestamp across repeated 404 passes", async () => {
    const h = makeHarness({ rows: [record({ phase: "intent", lateCreateRisk: true })] });
    start(h.deps, { absenceHorizonMs: 10_000 });

    expect(await runOrphanReconciliationOnce()).toMatchObject({ lateRisk: 1 });
    const firstAbsentAt = h.state.rows[0]?.firstAbsentAt;

    const later = makeHarness({ rows: h.state.rows });
    start(later.deps, { absenceHorizonMs: 10_000, now: () => NOW + 5_000 });
    expect(await runOrphanReconciliationOnce()).toMatchObject({ lateRisk: 1 });
    expect(later.state.rows[0]?.firstAbsentAt).toEqual(firstAbsentAt);
    expect(later.state.rows).toHaveLength(1);
  });

  it("releases a risk-bearing intent only once the absence horizon elapses", async () => {
    const h = makeHarness({
      rows: [
        record({ phase: "intent", lateCreateRisk: true, firstAbsentAt: new Date(NOW - 20_000) }),
      ],
    });
    start(h.deps, { absenceHorizonMs: 10_000, now: () => NOW + 10_000 });

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ absent: 0, lateRisk: 0, expiredAbsent: 1 });
    expect(h.state.clears).toEqual([
      { kind: "intent", conversationId: "conv-1", sessionId: "ses_orphan0001" },
    ]);
    expect(h.state.rows).toHaveLength(0);
  });

  it("leaves a risk-bearing intent when the absence itself cannot be recorded", async () => {
    const h = makeHarness({ rows: [record({ phase: "intent", lateCreateRisk: true })] });
    h.state.probeRecordError = new Error("database is closed");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ unresolved: 1, absent: 0, lateRisk: 0 });
    expect(h.state.clears).toHaveLength(0);
    expect(h.state.rows).toHaveLength(1);
  });

  it("records a present probe before the ownership re-check and removal", async () => {
    const h = makeHarness({ rows: [record()] });
    h.state.remote.add("ses_orphan0001");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ removed: 1 });
    expect(h.state.probes).toEqual([
      { conversationId: "conv-1", sessionId: "ses_orphan0001", outcome: "present", at: NOW },
    ]);
  });

  it("never touches a row whose create is still in flight in this process", async () => {
    const h = makeHarness({ rows: [record({ phase: "intent", lateCreateRisk: true })] });
    h.state.inFlightKeys.add("conv-1\u0000ses_orphan0001");
    start(h.deps, { graceMs: 0 });

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ scanned: 0, inflight: 1, removed: 0, lateRisk: 0 });
    expect(h.state.conversationReads).toBe(0);
    expect(h.state.getCalls).toHaveLength(0);
    expect(h.state.removeCalls).toHaveLength(0);
    expect(h.state.probes).toHaveLength(0);
    expect(h.state.rows).toHaveLength(1);
  });

  it("removes a session left by a dead process once a server is available", async () => {
    const shared: OpenCodeOrphanRecord[] = [record({ phase: "intent" })];
    const offline = makeHarness({ rows: shared, runningUrl: null });
    start(offline.deps);
    expect(await runOrphanReconciliationOnce()).toMatchObject({ skippedNoServer: 1 });
    expect(shared).toHaveLength(1);

    const online = makeHarness({ rows: shared });
    online.state.remote.add("ses_orphan0001");
    start(online.deps);
    expect(await runOrphanReconciliationOnce()).toMatchObject({ removed: 1 });
    expect(shared).toHaveLength(0);
  });
});

/**
 * The interleaving independent review identified:
 *
 *   risk-bearing intent → probe sees the session present → removal confirmed
 *   → journal row cleared → the outstanding create completes and recreates
 *   the id with no durable record left.
 *
 * Presence at one instant proves the session existed at that instant; it does
 * not prove that every create request TBAi submitted for the id has finished.
 */
describe("runOrphanReconciliationOnce — presence is not terminality", () => {
  it("retains a risk-bearing intent after a confirmed removal and never clears its risk", async () => {
    const h = makeHarness({ rows: [record({ phase: "intent", lateCreateRisk: true })] });
    h.state.remote.add("ses_orphan0001");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    // The removal itself is correct and confirmed...
    expect(h.state.removeCalls).toEqual(["ses_orphan0001"]);
    expect(h.state.remote.has("ses_orphan0001")).toBe(false);
    // ...but it is not a settlement: the row must survive, and the risk stays.
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.lateCreateRisk).toBe(true);
    expect(report).toMatchObject({ removed: 0, retainedAfterRemoval: 1 });
  });

  it("retains a risk-bearing ORPHAN after a confirmed removal", async () => {
    // An orphan can carry the flag when a retried create may still be in
    // flight; the phase decides how a settled row is cleared, not whether it
    // is safe to clear.
    const h = makeHarness({ rows: [record({ phase: "orphan", lateCreateRisk: true })] });
    h.state.remote.add("ses_orphan0001");
    start(h.deps);

    expect(await runOrphanReconciliationOnce()).toMatchObject({
      retainedAfterRemoval: 1,
      removed: 0,
    });
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.lateCreateRisk).toBe(true);
  });

  it("does not release on an absence timestamp taken BEFORE the removal", async () => {
    const h = makeHarness({
      rows: [
        record({
          phase: "intent",
          lateCreateRisk: true,
          // Long past the horizon, but from an epoch that ended at the removal.
          firstAbsentAt: new Date(NOW - 100_000),
        }),
      ],
    });
    h.state.remote.add("ses_orphan0001");
    start(h.deps, { absenceHorizonMs: 50_000 });

    // Present → confirmed removal: the stale epoch is ended, not carried over.
    expect(await runOrphanReconciliationOnce()).toMatchObject({ retainedAfterRemoval: 1 });
    expect(h.state.rows[0]?.firstAbsentAt).toBeNull();

    // The next 404 starts a NEW epoch at its own time. The old timestamp was
    // already older than the horizon, and must not release the row.
    start(h.deps, { absenceHorizonMs: 50_000, now: () => NOW + 1_000 });
    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ lateRisk: 1, expiredAbsent: 0, absent: 0 });
    expect(h.state.rows[0]?.firstAbsentAt).toEqual(new Date(NOW + 1_000));
    expect(h.state.rows).toHaveLength(1);
  });

  it("re-handles a session the outstanding create recreates, restarting the horizon each time", async () => {
    const h = makeHarness({ rows: [record({ phase: "intent", lateCreateRisk: true })] });
    h.state.remote.add("ses_orphan0001");
    start(h.deps, { absenceHorizonMs: 50_000 });

    // First pass: present → removed → retained.
    expect(await runOrphanReconciliationOnce()).toMatchObject({ retainedAfterRemoval: 1 });
    expect(h.state.removeCalls).toEqual(["ses_orphan0001"]);
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.firstAbsentAt).toBeNull();

    // The lost create commits: the id is back.
    h.state.remote.add("ses_orphan0001");
    expect(await runOrphanReconciliationOnce()).toMatchObject({ retainedAfterRemoval: 1 });
    expect(h.state.removeCalls).toEqual(["ses_orphan0001", "ses_orphan0001"]);
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    // The second removal restarts absence tracking too.
    expect(h.state.rows[0]?.firstAbsentAt).toBeNull();
  });

  it("never removes a risk-bearing session when the presence observation cannot be recorded", async () => {
    const h = makeHarness({ rows: [record({ phase: "intent", lateCreateRisk: true })] });
    h.state.remote.add("ses_orphan0001");
    h.state.probeRecordError = new Error("database is closed");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ unresolved: 1, retainedAfterRemoval: 0, removed: 0 });
    expect(h.state.removeCalls).toHaveLength(0);
    expect(h.state.rows).toHaveLength(1);
  });

  it("keeps a risk-bearing intent whose conversation is bound, without touching the remote", async () => {
    const h = makeHarness({ rows: [record({ phase: "intent", lateCreateRisk: true })] });
    h.state.conversations.set("conv-1", { opencodeSessionId: "ses_orphan0001" });
    h.state.remote.add("ses_orphan0001");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    // Binding is ownership, not settlement. The row must survive with its
    // risk, and the touch rotates it behind unexamined entries.
    expect(report).toMatchObject({ bound: 0, retainedBound: 1, removed: 0, unresolved: 0 });
    expect(h.state.removeCalls).toHaveLength(0);
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.lateCreateRisk).toBe(true);
    expect(h.state.touches).toEqual([
      { conversationId: "conv-1", sessionId: "ses_orphan0001", at: NOW },
    ]);
  });

  it("leaves a bound risk-bearing row when the settlement cannot be recorded", async () => {
    const h = makeHarness({ rows: [record({ phase: "intent", lateCreateRisk: true })] });
    h.state.conversations.set("conv-1", { opencodeSessionId: "ses_orphan0001" });
    h.state.remote.add("ses_orphan0001");
    h.state.settleOwnedError = new Error("database is closed");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ bound: 0, retainedBound: 0, unresolved: 1, removed: 0 });
    expect(h.state.removeCalls).toHaveLength(0);
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.lateCreateRisk).toBe(true);
  });

  it("ends a stale absence epoch when the risk-bearing session becomes bound", async () => {
    const h = makeHarness({
      rows: [
        record({
          phase: "intent",
          lateCreateRisk: true,
          // Older than the horizon, but from an epoch that ended at binding.
          firstAbsentAt: new Date(NOW - 100_000),
        }),
      ],
    });
    h.state.conversations.set("conv-1", { opencodeSessionId: "ses_orphan0001" });
    start(h.deps, { absenceHorizonMs: 50_000 });

    expect(await runOrphanReconciliationOnce()).toMatchObject({ retainedBound: 1 });
    expect(h.state.rows[0]?.firstAbsentAt).toBeNull();

    // The conversation is unbound, the session is gone, and the next 404 must
    // start a fresh horizon rather than release on the pre-binding stamp.
    h.state.conversations.delete("conv-1");
    start(h.deps, { absenceHorizonMs: 50_000, now: () => NOW + 1_000 });
    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ lateRisk: 1, expiredAbsent: 0, absent: 0 });
    expect(h.state.rows[0]?.firstAbsentAt).toEqual(new Date(NOW + 1_000));
    expect(h.state.rows).toHaveLength(1);
  });

  it("rotates a bound risk-bearing row so an unexamined row is not starved", async () => {
    const h = makeHarness({
      rows: [
        record({
          sessionId: "ses_bound0001",
          phase: "intent",
          lateCreateRisk: true,
          firstSeenAt: new Date(NOW - 700_000),
          lastSeenAt: new Date(NOW - 700_000),
        }),
        record({ sessionId: "ses_orphan0002" }),
      ],
    });
    h.state.conversations.set("conv-1", { opencodeSessionId: "ses_bound0001" });
    h.state.remote.add("ses_bound0001");
    start(h.deps, { limit: 1 });

    // Pass 1 picks the older bound risk row, keeps it, and touches it.
    expect(await runOrphanReconciliationOnce()).toMatchObject({
      scanned: 1,
      retainedBound: 1,
      deferred: 0,
    });
    expect(h.state.rows).toHaveLength(2);

    // Pass 2 must now examine the row nobody has looked at, not the bound row.
    const second = await runOrphanReconciliationOnce();
    expect(second).toMatchObject({ scanned: 1, absent: 1 });
    expect(h.state.rows.map((row) => row.sessionId)).toEqual(["ses_bound0001"]);
    expect(h.state.touches).toHaveLength(1);
  });

  it("keeps a bound risk across a restarted reconciler", async () => {
    const rows = [record({ phase: "intent", lateCreateRisk: true })];

    const first = makeHarness({ rows });
    first.state.conversations.set("conv-1", { opencodeSessionId: "ses_orphan0001" });
    start(first.deps);
    expect(await runOrphanReconciliationOnce()).toMatchObject({ retainedBound: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lateCreateRisk).toBe(true);

    // A restart keeps only the database and the conversation row.
    const restarted = makeHarness({ rows });
    restarted.state.conversations.set("conv-1", { opencodeSessionId: "ses_orphan0001" });
    start(restarted.deps);
    expect(await runOrphanReconciliationOnce()).toMatchObject({ retainedBound: 1 });
    expect(restarted.state.clears).toEqual([]);
    expect(restarted.state.removeCalls).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lateCreateRisk).toBe(true);
  });

  it("keeps the risk and the safe behavior across a restarted reconciler", async () => {
    const rows = [record({ phase: "intent", lateCreateRisk: true })];

    const first = makeHarness({ rows });
    first.state.remote.add("ses_orphan0001");
    start(first.deps);
    expect(await runOrphanReconciliationOnce()).toMatchObject({ retainedAfterRemoval: 1 });
    // What a restart can rely on is the persisted state, not process memory.
    expect(rows[0]?.lateCreateRisk).toBe(true);
    expect(rows[0]?.firstAbsentAt).toBeNull();

    const restarted = makeHarness({ rows });
    restarted.state.remote.add("ses_orphan0001");
    start(restarted.deps);
    expect(await runOrphanReconciliationOnce()).toMatchObject({ retainedAfterRemoval: 1 });
    expect(restarted.state.removeCalls).toEqual(["ses_orphan0001"]);
    expect(restarted.state.clears).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lateCreateRisk).toBe(true);
  });
});

describe("runOrphanReconciliationOnce — inconclusive evidence never deletes", () => {
  it("leaves the row when the probe fails", async () => {
    const h = makeHarness({ rows: [record()] });
    h.state.probeError = new OpenCodeError("connection", "offline");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ scanned: 1, unresolved: 1, removed: 0, absent: 0 });
    expect(h.state.removeCalls).toHaveLength(0);
    expect(h.state.rows).toHaveLength(1);
  });

  it("leaves the row when the probe answers for a different id", async () => {
    const h = makeHarness({ rows: [record()] });
    h.state.remote.add("ses_orphan0001");
    h.state.probeMismatch = true;
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ unresolved: 1, removed: 0 });
    expect(h.state.removeCalls).toHaveLength(0);
    expect(h.state.rows).toHaveLength(1);
  });

  it("leaves the row when the conversation cannot be read", async () => {
    const h = makeHarness({ rows: [record()] });
    h.state.conversationError = new Error("database is locked");
    h.state.remote.add("ses_orphan0001");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ unresolved: 1, removed: 0 });
    expect(h.state.getCalls).toHaveLength(0);
    expect(h.state.removeCalls).toHaveLength(0);
    expect(h.state.rows).toHaveLength(1);
  });

  it("leaves the row when the remove call fails", async () => {
    const h = makeHarness({ rows: [record()] });
    h.state.remote.add("ses_orphan0001");
    h.state.removeError = new OpenCodeError("connection", "offline");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ unresolved: 1, removed: 0 });
    expect(h.state.clears).toHaveLength(0);
    expect(h.state.rows).toHaveLength(1);
  });

  it("leaves the row when remove resolves but the session remains", async () => {
    const h = makeHarness({ rows: [record()] });
    h.state.remote.add("ses_orphan0001");
    h.state.removeEffect = "keep";
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ unresolved: 1, removed: 0 });
    expect(h.state.removeCalls).toEqual(["ses_orphan0001"]);
    expect(h.state.clears).toHaveLength(0);
    expect(h.state.rows).toHaveLength(1);
  });

  it("leaves the row when the confirmation lookup after removal is inconclusive", async () => {
    const h = makeHarness({ rows: [record()] });
    h.state.remote.add("ses_orphan0001");
    h.state.probeErrorAfterRemove = new OpenCodeError("connection", "offline");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ unresolved: 1, removed: 0 });
    expect(h.state.clears).toHaveLength(0);
    expect(h.state.rows).toHaveLength(1);
  });

  it("leaves the row when clearing it fails, even after a confirmed removal", async () => {
    const h = makeHarness({ rows: [record()] });
    h.state.remote.add("ses_orphan0001");
    h.state.clearError = new Error("database is closed");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ unresolved: 1, removed: 0 });
    expect(h.state.rows).toHaveLength(1);
  });
});

describe("runOrphanReconciliationOnce — scope and bounds", () => {
  it("defers rows younger than the grace window", async () => {
    const h = makeHarness({ rows: [record({ lastSeenAt: new Date(NOW - 1_000) })] });
    h.state.remote.add("ses_orphan0001");
    start(h.deps, { graceMs: DEFAULT_ORPHAN_RECONCILE_GRACE_MS });

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ scanned: 0, deferred: 1, removed: 0 });
    expect(h.state.conversationReads).toBe(0);
    expect(h.state.getCalls).toHaveLength(0);
    expect(h.state.rows).toHaveLength(1);
  });

  it("skips remote work when no managed server is running, without starting one", async () => {
    const h = makeHarness({ rows: [record()], runningUrl: null });
    h.state.remote.add("ses_orphan0001");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ scanned: 1, skippedNoServer: 1, removed: 0 });
    expect(h.state.createClientCalls).toBe(0);
    expect(h.state.getCalls).toHaveLength(0);
    expect(h.state.rows).toHaveLength(1);
  });

  it("passes the bounded limit to the journal and drains a backlog over passes", async () => {
    const h = makeHarness({
      rows: [
        record({ sessionId: "ses_orphan0001" }),
        record({ sessionId: "ses_orphan0002" }),
        record({ sessionId: "ses_orphan0003" }),
      ],
    });
    start(h.deps, { limit: 1 });

    const first = await runOrphanReconciliationOnce();
    expect(first).toMatchObject({ scanned: 1, absent: 1 });
    expect(h.state.listLimits).toEqual([1]);
    expect(h.state.rows).toHaveLength(2);

    await runOrphanReconciliationOnce();
    await runOrphanReconciliationOnce();
    expect(h.state.rows).toHaveLength(0);
  });

  it("is idempotent: a cleared row is not acted on again", async () => {
    const h = makeHarness({ rows: [record({ phase: "intent", lateCreateRisk: false })] });
    start(h.deps);

    expect(await runOrphanReconciliationOnce()).toMatchObject({ absent: 1 });
    expect(await runOrphanReconciliationOnce()).toMatchObject({ scanned: 0, absent: 0 });
    expect(h.state.clears).toHaveLength(1);
    expect(h.state.getCalls).toEqual(["ses_orphan0001"]);
  });

  it("refuses a second overlapping pass", async () => {
    const h = makeHarness();
    let release!: (rows: OpenCodeOrphanRecord[]) => void;
    h.deps.listUnresolved = () =>
      new Promise<OpenCodeOrphanRecord[]>((resolve) => {
        release = resolve;
      });
    start(h.deps);

    const first = runOrphanReconciliationOnce();
    expect(await runOrphanReconciliationOnce()).toBeNull();
    release([]);
    expect(await first).not.toBeNull();
  });

  it("does nothing before it is started", async () => {
    stopOrphanReconciliation();
    expect(await runOrphanReconciliationOnce()).toBeNull();
  });
});

describe("orphan reconciliation lifecycle", () => {
  it("starts once, runs an immediate tick, and stops idempotently", async () => {
    const h = makeHarness();
    stopOrphanReconciliation();

    const started = startOrphanReconciliation({
      deps: h.deps,
      runImmediately: true,
      intervalMs: 60_000,
      graceMs: 0,
      now: () => NOW,
    });
    expect(started).toEqual({ started: true, alreadyRunning: false });

    const again = startOrphanReconciliation({ deps: h.deps });
    expect(again).toEqual({ started: false, alreadyRunning: true });

    await Bun.sleep(10);
    expect(getOrphanReconciliationState().ticks).toBe(1);
    expect(getOrphanReconciliationState().running).toBe(true);

    expect(stopOrphanReconciliation()).toBe(true);
    expect(stopOrphanReconciliation()).toBe(false);
    expect(getOrphanReconciliationState().running).toBe(false);
  });

  it("drains an in-flight pass before shutdown can close the database", async () => {
    const h = makeHarness();
    let release!: (rows: OpenCodeOrphanRecord[]) => void;
    h.deps.listUnresolved = () =>
      new Promise<OpenCodeOrphanRecord[]>((resolve) => {
        release = resolve;
      });
    start(h.deps);

    const pass = runOrphanReconciliationOnce();
    let drained = false;
    const drain = drainOrphanReconciliation().then(() => {
      drained = true;
    });
    await Bun.sleep(5);
    expect(drained).toBe(false);

    release([]);
    await Promise.all([pass, drain]);
    expect(drained).toBe(true);
  });

  it("resolves the default interval, grace and batch bound", () => {
    expect(DEFAULT_ORPHAN_RECONCILE_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(DEFAULT_ORPHAN_RECONCILE_GRACE_MS).toBe(60 * 1000);
    expect(DEFAULT_ORPHAN_RECONCILE_LIMIT).toBe(20);
  });
});

/**
 * RT-011 delete markers. A conversation deletion leaves a durable `delete`
 * row when its remote session could not be removed. The reconciler must treat
 * it as an audit obligation, not as a create intent:
 *  - bound markers are rotated and retained, never settled by the generic
 *    ownership rule (which would delete a risk-free intent);
 *  - a confirmed removal goes through the delete-specific settlement, which
 *    keeps the row;
 *  - a 404 is still bounded by the absence horizon.
 */
describe("runOrphanReconciliationOnce — delete markers (RT-011)", () => {
  it("retains and rotates a bound delete marker instead of settling it", async () => {
    const h = makeHarness({ rows: [record({ phase: "delete", lateCreateRisk: true })] });
    h.state.conversations.set("conv-1", { opencodeSessionId: "ses_orphan0001" });
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ bound: 0, retainedBound: 1, removed: 0, unresolved: 0 });
    expect(h.state.getCalls).toHaveLength(0);
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.touches).toEqual([
      { conversationId: "conv-1", sessionId: "ses_orphan0001", at: NOW },
    ]);
  });

  it("retains a bound delete marker even when its stored risk is zero", async () => {
    // The conversation still names the session, so the deletion did not
    // complete. A risk-free marker must not be deleted as a stale intent.
    const h = makeHarness({ rows: [record({ phase: "delete", lateCreateRisk: false })] });
    h.state.conversations.set("conv-1", { opencodeSessionId: "ses_orphan0001" });
    start(h.deps);

    expect(await runOrphanReconciliationOnce()).toMatchObject({ retainedBound: 1, bound: 0 });
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.resolvedAt).toBeNull();
  });

  it("keeps an unbound delete marker through a 404 until its horizon elapses", async () => {
    const h = makeHarness({ rows: [record({ phase: "delete", lateCreateRisk: true })] });
    start(h.deps, { absenceHorizonMs: 10_000 });

    expect(await runOrphanReconciliationOnce()).toMatchObject({ lateRisk: 1, absent: 0 });
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.firstAbsentAt).toEqual(new Date(NOW));

    const later = makeHarness({ rows: h.state.rows });
    start(later.deps, { absenceHorizonMs: 10_000, now: () => NOW + 11_000 });
    expect(await runOrphanReconciliationOnce()).toMatchObject({ expiredAbsent: 1, absent: 0 });
    expect(later.state.rows).toHaveLength(0);
  });

  it("settles a delete marker through the delete-specific path after a confirmed removal", async () => {
    const h = makeHarness({ rows: [record({ phase: "delete", lateCreateRisk: true })] });
    h.state.remote.add("ses_orphan0001");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ removed: 0, retainedAfterRemoval: 1, absent: 0 });
    expect(h.state.removeCalls).toEqual(["ses_orphan0001"]);
    expect(h.state.deletedSettles).toEqual([
      { conversationId: "conv-1", sessionId: "ses_orphan0001", risk: "risk" },
    ]);
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.resolvedAt).toBeNull();
  });

  it("releases a risk-free delete marker after a confirmed removal without dropping the audit row", async () => {
    const h = makeHarness({ rows: [record({ phase: "delete", lateCreateRisk: false })] });
    h.state.remote.add("ses_orphan0001");
    start(h.deps);

    // The harness records the release by stamping the row; the real store
    // keeps it as an audit record (proven in the storage suite).
    expect(await runOrphanReconciliationOnce()).toMatchObject({ removed: 1 });
    expect(h.state.deletedSettles).toEqual([
      { conversationId: "conv-1", sessionId: "ses_orphan0001", risk: "safe" },
    ]);
    expect(h.state.rows[0]?.resolvedAt).not.toBeNull();
  });

  it("discovers a binding written while the absence probe was in flight", async () => {
    // The exact race the late ownership recheck exists to prevent: the row is
    // listed unbound, the probe answers 404, and a cross-process writer binds
    // this exact session before settlement. Without the recheck the row would
    // be settled as absent; with it, ownership wins and the absence epoch ends.
    const row = record({ phase: "intent", lateCreateRisk: true });
    const h = makeHarness({ rows: [row] });
    let reads = 0;
    h.state.getConversationImpl = async () => {
      reads += 1;
      if (reads === 1) return { opencodeSessionId: null };
      return { opencodeSessionId: "ses_orphan0001" };
    };
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(reads).toBe(2);
    expect(report).toMatchObject({
      retainedBound: 1,
      lateRisk: 0,
      absent: 0,
      expiredAbsent: 0,
      unresolved: 0,
    });
    expect(h.state.probes).toEqual([
      { conversationId: "conv-1", sessionId: "ses_orphan0001", outcome: "absent", at: NOW },
    ]);
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.firstAbsentAt).toBeNull();
    expect(h.state.rows[0]?.lateCreateRisk).toBe(true);
  });

  it("leaves the absence unsettled when the ownership recheck cannot be read", async () => {
    const h = makeHarness({ rows: [record({ phase: "orphan", lateCreateRisk: true })] });
    let reads = 0;
    h.state.getConversationImpl = async () => {
      reads += 1;
      if (reads === 1) return { opencodeSessionId: null };
      throw new Error("database is locked");
    };
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ unresolved: 1, absent: 0, lateRisk: 0 });
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
  });
});
