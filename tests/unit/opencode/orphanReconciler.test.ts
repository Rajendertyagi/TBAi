import { describe, it, expect, afterEach } from "bun:test";
import type { OpenCodeClient } from "@/services/opencode/client";

import type { OpenCodeTransport } from "@/services/opencode/http";
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
    defers: [] as Array<{ conversationId: string; sessionId: string; untilMs: number }>,
    clientTransports: [] as Array<OpenCodeTransport | undefined>,
    clientBaseUrls: [] as string[],
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
    defer: async (conversationId, sessionId, untilMs) => {
      state.defers.push({ conversationId, sessionId, untilMs });
      return true;
    },
    createClient: (baseUrl, _directory, transport) => {
      state.createClientCalls += 1;
      state.clientBaseUrls.push(baseUrl);
      state.clientTransports.push(transport);
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

describe("runOrphanReconciliationOnce â€” diagnostic-only", () => {
  it("retains a bound row without any remote mutation", async () => {
    const h = makeHarness({ rows: [record()] });
    h.state.conversations.set("conv-1", { opencodeSessionId: "ses_orphan0001" });
    h.state.remote.add("ses_orphan0001");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ bound: 1, removed: 0, observed: 0 });
    expect(h.state.removeCalls).toEqual([]);
    expect(h.state.getCalls).toEqual([]);
    // A risk-free bound row is settled from the journal; the session itself is untouched.
    expect(h.state.rows).toHaveLength(0);
    expect(h.state.remote.has("ses_orphan0001")).toBe(true);
  });

  it("observes an unbound present session without deleting it", async () => {
    const h = makeHarness({ rows: [record()] });
    h.state.remote.add("ses_orphan0001");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ scanned: 1, observed: 1, removed: 0, unresolved: 0 });
    expect(h.state.removeCalls).toEqual([]);
    expect(h.state.remote.has("ses_orphan0001")).toBe(true);
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.probes).toEqual([
      { conversationId: "conv-1", sessionId: "ses_orphan0001", outcome: "present", at: NOW },
    ]);
  });

  it("observes a session whose conversation points elsewhere without deleting it", async () => {
    const h = makeHarness({ rows: [record()] });
    h.state.conversations.set("conv-1", { opencodeSessionId: "ses_replacement1" });
    h.state.remote.add("ses_orphan0001");
    h.state.remote.add("ses_replacement1");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ observed: 1, removed: 0 });
    expect(h.state.removeCalls).toEqual([]);
    expect(h.state.remote.has("ses_orphan0001")).toBe(true);
    expect(h.state.remote.has("ses_replacement1")).toBe(true);
  });

  it("keeps a risk-bearing row after a present observation", async () => {
    const h = makeHarness({ rows: [record({ phase: "intent", lateCreateRisk: true })] });
    h.state.remote.add("ses_orphan0001");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ observed: 1, removed: 0, retainedAfterRemoval: 0 });
    expect(h.state.removeCalls).toEqual([]);
    expect(h.state.clears).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.lateCreateRisk).toBe(true);
  });

  it("never deletes on inconclusive evidence", async () => {
    const h = makeHarness({ rows: [record()] });
    h.state.remote.add("ses_orphan0001");
    h.state.probeError = new Error("probe failed");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ unresolved: 1, removed: 0, observed: 0 });
    expect(h.state.removeCalls).toEqual([]);
    expect(h.state.remote.has("ses_orphan0001")).toBe(true);
    expect(h.state.rows).toHaveLength(1);
  });

  it("releases a risk-free row on a positive 404 without any remote mutation", async () => {
    const h = makeHarness({ rows: [record({ phase: "intent", lateCreateRisk: false })] });
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ absent: 1, removed: 0, observed: 0 });
    expect(h.state.removeCalls).toEqual([]);
    expect(h.state.clears).toEqual([
      { kind: "intent", conversationId: "conv-1", sessionId: "ses_orphan0001" },
    ]);
    expect(h.state.rows).toHaveLength(0);
  });

  it("retains a risk-bearing row on a 404 until its absence horizon elapses", async () => {
    const h = makeHarness({
      rows: [record({ phase: "intent", lateCreateRisk: true })],
    });
    start(h.deps, { absenceHorizonMs: 50_000 });

    const first = await runOrphanReconciliationOnce();
    expect(first).toMatchObject({ lateRisk: 1, removed: 0 });
    expect(h.state.rows).toHaveLength(1);

    start(h.deps, { absenceHorizonMs: 50_000, now: () => NOW + 60_000 });
    const second = await runOrphanReconciliationOnce();
    expect(second).toMatchObject({ expiredAbsent: 1, removed: 0 });
    expect(h.state.removeCalls).toEqual([]);
  });

  it("skips rows whose create is still in flight in this process", async () => {
    const h = makeHarness({ rows: [record({ phase: "intent", lateCreateRisk: true })] });
    h.state.inFlightKeys.add("conv-1\u0000ses_orphan0001");
    start(h.deps, { graceMs: 0 });

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ scanned: 0, inflight: 1, removed: 0, observed: 0 });
    expect(h.state.removeCalls).toEqual([]);
    expect(h.state.getCalls).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
  });

  it("skips rows when no managed server is running", async () => {
    const h = makeHarness({ rows: [record()], runningUrl: null });
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ skippedNoServer: 1, removed: 0, observed: 0 });
    expect(h.state.removeCalls).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
  });

  it("never probes or removes a remote-owned session", async () => {
    const h = makeHarness({
      rows: [record({ serviceOwner: "remote:http://example.com:4096" })],
    });
    h.state.remote.add("ses_orphan0001");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ skippedOtherService: 1, removed: 0, observed: 0 });
    expect(h.state.getCalls).toEqual([]);
    expect(h.state.removeCalls).toEqual([]);
  });

  it("keeps an unresolved delete marker as an audit row without deleting", async () => {
    const h = makeHarness({ rows: [record({ phase: "delete" })] });
    h.state.remote.add("ses_orphan0001");
    start(h.deps);

    const report = await runOrphanReconciliationOnce();

    expect(report).toMatchObject({ observed: 1, removed: 0 });
    expect(h.state.removeCalls).toEqual([]);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0]?.phase).toBe("delete");
  });
});

describe("orphan reconciliation lifecycle", () => {
  it("starts, drains and stops without issuing remote deletion", async () => {
    const h = makeHarness({ rows: [record()] });
    h.state.remote.add("ses_orphan0001");
    stopOrphanReconciliation();
    startOrphanReconciliation({
      deps: h.deps,
      runImmediately: false,
      graceMs: 0,
      now: () => NOW,
    });
    expect(getOrphanReconciliationState().running).toBe(true);
    await drainOrphanReconciliation();
    expect(h.state.removeCalls).toEqual([]);
    stopOrphanReconciliation();
    expect(getOrphanReconciliationState().running).toBe(false);
  });
});
