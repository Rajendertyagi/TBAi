import { describe, it, expect, beforeEach } from "bun:test";
import { applyOpenCodeOrphanSchema } from "@/db/schema/opencode-session-orphans.ts";
import { opencodeOrphanService } from "@/services/storage/opencodeSessionOrphans.ts";

/**
 * The durable recovery journal for OpenCode sessions (RT-001).
 *
 * These tests pin the storage contract the service exposes:
 *  - idempotency on `(conversation_id, session_id)` — repeated attempts do not
 *    duplicate the record, and a concurrent burst cannot race a read-then-
 *    insert into a UNIQUE failure.
 *  - the two phases (`intent` before create, `orphan` after a failed persist)
 *    share a row, and a write never downgrades an orphan back to an intent.
 *  - the partial index only surfaces UNRESOLVED rows, oldest first.
 *  - `resolved_at` is terminal: a resolved pair never reopens.
 *  - a proven-unused intent is deleted; an orphan is resolved, not deleted.
 *
 * Database isolation comes from `tests/setup.ts`, which gives every test file
 * its own DATA_DIR; this file uses that file-backed `db` handle (not a
 * separate in-memory database).
 */

const db = (await import("@/db/index.ts")).db;

beforeEach(() => {
  applyOpenCodeOrphanSchema(db);
  db.run("DELETE FROM opencode_session_orphans");
});

describe("opencodeOrphanService.recordCreateIntent", () => {
  it("writes a pre-create intent row with its directory", async () => {
    const open = await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
      locationDirectory: "D:\\ws\\conv-1",
    });
    expect(open).toBe(true);
    const rows = db.query("SELECT * FROM opencode_session_orphans").all() as Array<
      Record<string, unknown>
    >;
    expect(rows.length).toBe(1);
    expect(rows[0].phase).toBe("intent");
    expect(rows[0].location_directory).toBe("D:\\ws\\conv-1");
    expect(rows[0].resolved_at).toBeNull();
  });

  it("is idempotent for the same pair", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    const again = await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    expect(again).toBe(true);
    const rows = db.query("SELECT * FROM opencode_session_orphans").all() as Array<
      Record<string, unknown>
    >;
    expect(rows.length).toBe(1);
  });

  it("does not reopen or downgrade a resolved orphan", async () => {
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      persistErrorCategory: "database",
    });
    await opencodeOrphanService.resolveOrphanedSession("conv-1", "ses_a");

    const open = await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    expect(open).toBe(false);
    const rows = db.query("SELECT * FROM opencode_session_orphans").all() as Array<
      Record<string, unknown>
    >;
    expect(rows.length).toBe(1);
    expect(rows[0].phase).toBe("orphan");
    expect(rows[0].resolved_at).not.toBeNull();
  });
});

describe("opencodeOrphanService.recordOrphanedSession", () => {
  it("B. writes a row on first record and returns open", async () => {
    const open = await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      persistErrorCategory: "database",
    });
    expect(open).toBe(true);
    const rows = db.query("SELECT * FROM opencode_session_orphans").all() as Array<
      Record<string, unknown>
    >;
    expect(rows.length).toBe(1);
    expect(rows[0].conversation_id).toBe("conv-1");
    expect(rows[0].session_id).toBe("ses_a");
    expect(rows[0].phase).toBe("orphan");
    expect(rows[0].persist_error_category).toBe("database");
    expect(rows[0].resolved_at).toBeNull();
  });

  it("C. is idempotent for the same (conversation, session) pair", async () => {
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      persistErrorCategory: "database",
    });
    const again = await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      cleanupErrorCategory: "network",
    });
    expect(again).toBe(true);
    const rows = db.query("SELECT * FROM opencode_session_orphans").all() as Array<
      Record<string, unknown>
    >;
    expect(rows.length).toBe(1);
    // First failure wins: the persist category is not overwritten.
    expect(rows[0].persist_error_category).toBe("database");
    // Later attempt fills the empty cleanup slot.
    expect(rows[0].cleanup_error_category).toBe("network");
  });

  it("promotes a pre-create intent to an orphan in place", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
      locationDirectory: "D:\\ws\\conv-1",
    });
    const open = await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      persistErrorCategory: "database",
    });
    expect(open).toBe(true);
    const rows = db.query("SELECT * FROM opencode_session_orphans").all() as Array<
      Record<string, unknown>
    >;
    expect(rows.length).toBe(1);
    expect(rows[0].phase).toBe("orphan");
    expect(rows[0].location_directory).toBe("D:\\ws\\conv-1");
    expect(rows[0].persist_error_category).toBe("database");
  });

  it("cannot race a concurrent burst into a duplicate or a UNIQUE failure", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        opencodeOrphanService.recordOrphanedSession({
          conversationId: "conv-1",
          sessionId: "ses_a",
          persistErrorCategory: "database",
        }),
      ),
    );
    expect(results.every((open) => open === true)).toBe(true);
    const count = (
      db.query("SELECT COUNT(*) AS c FROM opencode_session_orphans").get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it("D. keeps one row per distinct session id even for the same conversation", async () => {
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_b",
    });
    const rows = db.query("SELECT * FROM opencode_session_orphans").all() as Array<
      Record<string, unknown>
    >;
    expect(rows.length).toBe(2);
  });

  it("E. does NOT reopen a resolved record", async () => {
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    const stamped = await opencodeOrphanService.resolveOrphanedSession("conv-1", "ses_a");
    expect(stamped).toBe(true);
    const reopened = await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    expect(reopened).toBe(false);
    const rows = db
      .query("SELECT * FROM opencode_session_orphans WHERE resolved_at IS NULL")
      .all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(0);
  });
});

describe("opencodeOrphanService.deleteCreateIntent", () => {
  it("deletes a proven-unused intent", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    expect(await opencodeOrphanService.deleteCreateIntent("conv-1", "ses_a")).toBe(true);
    expect(await opencodeOrphanService.deleteCreateIntent("conv-1", "ses_a")).toBe(false);
    const count = (
      db.query("SELECT COUNT(*) AS c FROM opencode_session_orphans").get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it("never deletes an orphan, which carries a real recovery obligation", async () => {
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    expect(await opencodeOrphanService.deleteCreateIntent("conv-1", "ses_a")).toBe(false);
    const rows = db
      .query("SELECT * FROM opencode_session_orphans WHERE resolved_at IS NULL")
      .all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0].phase).toBe("orphan");
  });
});

describe("opencodeOrphanService.listUnresolvedOrphans", () => {
  it("F. lists only unresolved rows of both phases, oldest first", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_b",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-2",
      sessionId: "ses_c",
    });
    await opencodeOrphanService.resolveOrphanedSession("conv-1", "ses_b");

    const all = await opencodeOrphanService.listUnresolvedOrphans();
    expect(all.map((r) => r.sessionId)).toEqual(["ses_a", "ses_c"]);
    expect(all.map((r) => r.phase)).toEqual(["intent", "orphan"]);

    const limited = await opencodeOrphanService.listUnresolvedOrphans(1);
    expect(limited.length).toBe(1);
    expect(limited[0]?.sessionId).toBe("ses_a");
  });
});

describe("opencodeOrphanService.resolveOrphanedSession", () => {
  it("G. stamps resolved_at and reports whether a row was stamped", async () => {
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    const stamped = await opencodeOrphanService.resolveOrphanedSession("conv-1", "ses_a");
    expect(stamped).toBe(true);
    const repeat = await opencodeOrphanService.resolveOrphanedSession("conv-1", "ses_a");
    expect(repeat).toBe(false);
    const missing = await opencodeOrphanService.resolveOrphanedSession("conv-9", "ses_x");
    expect(missing).toBe(false);
  });
});

describe("opencodeOrphanService — late-create risk", () => {
  function rowFor(conversationId: string, sessionId: string): Record<string, unknown> {
    return db
      .query("SELECT * FROM opencode_session_orphans WHERE conversation_id = ? AND session_id = ?")
      .get(conversationId, sessionId) as Record<string, unknown>;
  }

  it("starts a create intent risk-bearing with no absence observation", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    const row = rowFor("conv-1", "ses_a");
    expect(row.late_create_risk).toBe(1);
    expect(row.first_absent_at).toBeNull();
  });

  it("records a risk-free orphan when the create path ruled out a duplicate", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      lateCreateRisk: false,
    });
    const row = rowFor("conv-1", "ses_a");
    expect(row.phase).toBe("orphan");
    expect(row.late_create_risk).toBe(0);
  });

  it("preserves an existing risk when promotion omits the flag", async () => {
    // Fail-safe default: a caller that cannot state the risk must not be able
    // to talk the journal out of an intent that was written risk-bearing.
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    const row = rowFor("conv-1", "ses_a");
    expect(row.phase).toBe("orphan");
    expect(row.late_create_risk).toBe(1);
  });

  it("re-arms the risk when a create request is issued again", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      lateCreateRisk: false,
    });
    expect(rowFor("conv-1", "ses_a").late_create_risk).toBe(0);

    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    const row = rowFor("conv-1", "ses_a");
    expect(row.late_create_risk).toBe(1);
    expect(row.first_absent_at).toBeNull();
  });

  it("absent stamps the FIRST 404 and keeps the risk; present ends that epoch", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    expect(
      await opencodeOrphanService.recordProbe({
        conversationId: "conv-1",
        sessionId: "ses_a",
        outcome: "absent",
        at: 1_000,
      }),
    ).toBe(true);
    await opencodeOrphanService.recordProbe({
      conversationId: "conv-1",
      sessionId: "ses_a",
      outcome: "absent",
      at: 2_000,
    });
    let row = rowFor("conv-1", "ses_a");
    expect(row.late_create_risk).toBe(1);
    expect(row.first_absent_at).toBe(1_000);
    expect(row.last_checked_at).toBe(2_000);

    // Presence proves existence at one instant. It ends the absence epoch but
    // cannot prove the create request that produced the id has finished.
    await opencodeOrphanService.recordProbe({
      conversationId: "conv-1",
      sessionId: "ses_a",
      outcome: "present",
      at: 3_000,
    });
    row = rowFor("conv-1", "ses_a");
    expect(row.late_create_risk).toBe(1);
    expect(row.first_absent_at).toBeNull();
    expect(row.last_checked_at).toBe(3_000);

    // The next 404 starts a NEW epoch rather than resuming the old timestamp.
    await opencodeOrphanService.recordProbe({
      conversationId: "conv-1",
      sessionId: "ses_a",
      outcome: "absent",
      at: 4_000,
    });
    row = rowFor("conv-1", "ses_a");
    expect(row.late_create_risk).toBe(1);
    expect(row.first_absent_at).toBe(4_000);
    expect(row.last_checked_at).toBe(4_000);
  });

  it("persists risk and absence across a fresh read of the row", async () => {
    // A restarted process has only the database: no in-memory state carries
    // the obligation, so these columns alone must be sufficient.
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.recordProbe({
      conversationId: "conv-1",
      sessionId: "ses_a",
      outcome: "absent",
      at: 7_000,
    });

    const restored = db
      .query(
        `SELECT phase, late_create_risk, first_absent_at, last_checked_at
           FROM opencode_session_orphans
          WHERE conversation_id = ? AND session_id = ? AND resolved_at IS NULL`,
      )
      .get("conv-1", "ses_a") as Record<string, unknown>;
    expect(restored).toEqual({
      phase: "intent",
      late_create_risk: 1,
      first_absent_at: 7_000,
      last_checked_at: 7_000,
    });
  });

  it("never rewrites a resolved row", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.resolveOrphanedSession("conv-1", "ses_a");
    const before = rowFor("conv-1", "ses_a");

    const recorded = await opencodeOrphanService.recordProbe({
      conversationId: "conv-1",
      sessionId: "ses_a",
      outcome: "present",
      at: 5_000,
    });
    expect(recorded).toBe(false);
    expect(rowFor("conv-1", "ses_a")).toEqual(before);
  });

  it("rotates an unsettleable row behind unexamined ones", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_b",
    });

    expect((await opencodeOrphanService.listUnresolvedOrphans()).map((r) => r.sessionId)).toEqual([
      "ses_a",
      "ses_b",
    ]);

    // A probe that cannot settle `ses_a` rotates it behind `ses_b`.
    await opencodeOrphanService.recordProbe({
      conversationId: "conv-1",
      sessionId: "ses_a",
      outcome: "absent",
      at: Date.now() + 60_000,
    });
    expect((await opencodeOrphanService.listUnresolvedOrphans()).map((r) => r.sessionId)).toEqual([
      "ses_b",
      "ses_a",
    ]);
  });
});

describe("opencodeOrphanService.touchOrphanedSession", () => {
  function rowFor(conversationId: string, sessionId: string): Record<string, unknown> {
    return db
      .query("SELECT * FROM opencode_session_orphans WHERE conversation_id = ? AND session_id = ?")
      .get(conversationId, sessionId) as Record<string, unknown>;
  }

  it("ends the absence epoch and advances rotation without resolving the row", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.recordProbe({
      conversationId: "conv-1",
      sessionId: "ses_a",
      outcome: "absent",
      at: 1_000,
    });

    expect(await opencodeOrphanService.touchOrphanedSession("conv-1", "ses_a", 5_000)).toBe(true);

    const row = rowFor("conv-1", "ses_a");
    expect(row.first_absent_at).toBeNull();
    expect(row.last_checked_at).toBe(5_000);
    expect(row.late_create_risk).toBe(1);
    expect(row.resolved_at).toBeNull();
  });

  it("rotates a bound risk-bearing row behind an unexamined one", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_b",
    });

    // Binding `ses_a` must not make it permanently first in every scan.
    await opencodeOrphanService.touchOrphanedSession("conv-1", "ses_a", Date.now() + 60_000);

    expect((await opencodeOrphanService.listUnresolvedOrphans()).map((r) => r.sessionId)).toEqual([
      "ses_b",
      "ses_a",
    ]);
  });

  it("does not touch a resolved row", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.resolveOrphanedSession("conv-1", "ses_a");
    const before = rowFor("conv-1", "ses_a");

    expect(await opencodeOrphanService.touchOrphanedSession("conv-1", "ses_a", 5_000)).toBe(false);
    expect(rowFor("conv-1", "ses_a")).toEqual(before);
  });

  it("reports false for a pair with no row", async () => {
    expect(await opencodeOrphanService.touchOrphanedSession("conv-9", "ses_x", 5_000)).toBe(false);
  });
});

describe("opencodeOrphanService.settleOwnedSession", () => {
  function rowFor(conversationId: string, sessionId: string): Record<string, unknown> {
    return db
      .query("SELECT * FROM opencode_session_orphans WHERE conversation_id = ? AND session_id = ?")
      .get(conversationId, sessionId) as Record<string, unknown>;
  }

  it("retains a risk-bearing orphan, ending its absence epoch and advancing rotation", async () => {
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      lateCreateRisk: true,
    });
    await opencodeOrphanService.recordProbe({
      conversationId: "conv-1",
      sessionId: "ses_a",
      outcome: "absent",
      at: 1_000,
    });

    expect(
      await opencodeOrphanService.settleOwnedSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe("retained");

    const row = rowFor("conv-1", "ses_a");
    expect(row.first_absent_at).toBeNull();
    expect(row.last_checked_at).toBe(5_000);
    expect(row.late_create_risk).toBe(1);
    expect(row.resolved_at).toBeNull();
  });

  it("retains a risk-bearing intent without deleting it", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });

    expect(
      await opencodeOrphanService.settleOwnedSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe("retained");

    const row = rowFor("conv-1", "ses_a");
    expect(row.phase).toBe("intent");
    expect(row.late_create_risk).toBe(1);
    expect(row.resolved_at).toBeNull();
  });

  it("resolves a risk-free orphan instead of deleting it", async () => {
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      lateCreateRisk: false,
    });

    expect(
      await opencodeOrphanService.settleOwnedSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe("cleared");

    const row = rowFor("conv-1", "ses_a");
    expect(row.resolved_at).toBe(5_000);
    expect(row.late_create_risk).toBe(0);
  });

  it("deletes a risk-free intent", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    db.run(
      "UPDATE opencode_session_orphans SET late_create_risk = 0 WHERE conversation_id = ? AND session_id = ?",
      ["conv-1", "ses_a"],
    );

    expect(
      await opencodeOrphanService.settleOwnedSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe("cleared");

    const count = (
      db.query("SELECT COUNT(*) AS c FROM opencode_session_orphans").get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it("decides from the CURRENT durable risk, not the caller's earlier view", async () => {
    // The reconciler listed this row as risk-free. Another writer re-arms it
    // before the bound settlement lands; that must win.
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      lateCreateRisk: false,
    });
    db.run(
      "UPDATE opencode_session_orphans SET late_create_risk = 1 WHERE conversation_id = ? AND session_id = ?",
      ["conv-1", "ses_a"],
    );

    expect(
      await opencodeOrphanService.settleOwnedSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe("retained");

    const row = rowFor("conv-1", "ses_a");
    expect(row.late_create_risk).toBe(1);
    expect(row.resolved_at).toBeNull();
  });

  it("retains a row whose stored risk is an unexpected nonzero value", async () => {
    // The column has no CHECK constraint and the read mapping treats anything
    // other than an explicit 0 as risk-bearing. Settlement must agree, or a
    // legacy value like 2 would fall through to "absent" and lose the
    // obligation (and the rotation touch).
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.recordProbe({
      conversationId: "conv-1",
      sessionId: "ses_a",
      outcome: "absent",
      at: 1_000,
    });
    db.run(
      "UPDATE opencode_session_orphans SET late_create_risk = 2 WHERE conversation_id = ? AND session_id = ?",
      ["conv-1", "ses_a"],
    );

    expect(
      await opencodeOrphanService.settleOwnedSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe("retained");

    const row = rowFor("conv-1", "ses_a");
    expect(row.late_create_risk).toBe(2);
    expect(row.first_absent_at).toBeNull();
    expect(row.last_checked_at).toBe(5_000);
    expect(row.resolved_at).toBeNull();
  });

  it("settles a risk-free row with a malformed phase as an orphan", async () => {
    // An unknown phase is read as an orphan (see `mapOrphanRow`); settlement
    // must resolve it rather than leave it open because `phase = 'orphan'`
    // does not match.
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      lateCreateRisk: false,
    });
    db.run(
      "UPDATE opencode_session_orphans SET phase = 'legacy' WHERE conversation_id = ? AND session_id = ?",
      ["conv-1", "ses_a"],
    );

    expect(
      await opencodeOrphanService.settleOwnedSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe("cleared");

    const row = rowFor("conv-1", "ses_a");
    expect(row.phase).toBe("legacy");
    expect(row.resolved_at).toBe(5_000);
  });

  it("reports absent for a resolved row and leaves it unchanged", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.resolveOrphanedSession("conv-1", "ses_a");
    const before = rowFor("conv-1", "ses_a");

    expect(
      await opencodeOrphanService.settleOwnedSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe("absent");
    expect(rowFor("conv-1", "ses_a")).toEqual(before);
  });

  it("reports absent for a pair with no row", async () => {
    expect(
      await opencodeOrphanService.settleOwnedSession({
        conversationId: "conv-9",
        sessionId: "ses_x",
        at: 5_000,
      }),
    ).toBe("absent");
  });
});

describe("opencodeOrphanService.settleAbsentSession", () => {
  function rowFor(conversationId: string, sessionId: string): Record<string, unknown> {
    return db
      .query("SELECT * FROM opencode_session_orphans WHERE conversation_id = ? AND session_id = ?")
      .get(conversationId, sessionId) as Record<string, unknown>;
  }

  async function riskFreeIntent(): Promise<void> {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    db.run(
      "UPDATE opencode_session_orphans SET late_create_risk = 0 WHERE conversation_id = ? AND session_id = ?",
      ["conv-1", "ses_a"],
    );
  }

  it("deletes a risk-free intent", async () => {
    await riskFreeIntent();

    expect(
      await opencodeOrphanService.settleAbsentSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
        absenceHorizonMs: 10_000,
      }),
    ).toBe("cleared");

    const count = (
      db.query("SELECT COUNT(*) AS c FROM opencode_session_orphans").get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it("resolves a risk-free orphan instead of deleting it", async () => {
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      lateCreateRisk: false,
    });

    expect(
      await opencodeOrphanService.settleAbsentSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
        absenceHorizonMs: 10_000,
      }),
    ).toBe("cleared");

    const row = rowFor("conv-1", "ses_a");
    expect(row.resolved_at).toBe(5_000);
  });

  it("retains a risk-bearing row inside the horizon for its own epoch", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.recordProbe({
      conversationId: "conv-1",
      sessionId: "ses_a",
      outcome: "absent",
      at: 1_000,
    });

    expect(
      await opencodeOrphanService.settleAbsentSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 2_000,
        absenceHorizonMs: 10_000,
      }),
    ).toBe("retained");

    const row = rowFor("conv-1", "ses_a");
    expect(row.first_absent_at).toBe(1_000);
    expect(row.resolved_at).toBeNull();
  });

  it("releases a risk-bearing row only after the horizon", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.recordProbe({
      conversationId: "conv-1",
      sessionId: "ses_a",
      outcome: "absent",
      at: 1_000,
    });

    expect(
      await opencodeOrphanService.settleAbsentSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 11_001,
        absenceHorizonMs: 10_000,
      }),
    ).toBe("expired");

    expect(
      (db.query("SELECT COUNT(*) AS c FROM opencode_session_orphans").get() as { c: number }).c,
    ).toBe(0);
  });

  it("starts the horizon at settlement when the epoch stamp was cleared", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });

    expect(
      await opencodeOrphanService.settleAbsentSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 20_000,
        absenceHorizonMs: 10_000,
      }),
    ).toBe("retained");
    expect(rowFor("conv-1", "ses_a").first_absent_at).toBeNull();
  });

  it("decides from the CURRENT durable risk, not the caller's earlier view", async () => {
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      lateCreateRisk: false,
    });
    db.run(
      "UPDATE opencode_session_orphans SET late_create_risk = 1 WHERE conversation_id = ? AND session_id = ?",
      ["conv-1", "ses_a"],
    );

    expect(
      await opencodeOrphanService.settleAbsentSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
        absenceHorizonMs: 10_000,
      }),
    ).toBe("retained");
    expect(rowFor("conv-1", "ses_a").late_create_risk).toBe(1);
  });

  it("settles a risk-free row with a malformed phase as an orphan", async () => {
    // Unknown phases are read as orphans, so the absence release must resolve
    // them; matching only `phase = 'orphan'` would settle nothing and report
    // "absent" for a row that is still open.
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      lateCreateRisk: false,
    });
    db.run(
      "UPDATE opencode_session_orphans SET phase = 'legacy' WHERE conversation_id = ? AND session_id = ?",
      ["conv-1", "ses_a"],
    );

    expect(
      await opencodeOrphanService.settleAbsentSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
        absenceHorizonMs: 10_000,
      }),
    ).toBe("cleared");

    const row = rowFor("conv-1", "ses_a");
    expect(row.phase).toBe("legacy");
    expect(row.resolved_at).toBe(5_000);
  });

  it("expires a malformed-phase row after the horizon", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.recordProbe({
      conversationId: "conv-1",
      sessionId: "ses_a",
      outcome: "absent",
      at: 1_000,
    });
    db.run(
      "UPDATE opencode_session_orphans SET phase = 'legacy' WHERE conversation_id = ? AND session_id = ?",
      ["conv-1", "ses_a"],
    );

    expect(
      await opencodeOrphanService.settleAbsentSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 11_001,
        absenceHorizonMs: 10_000,
      }),
    ).toBe("expired");

    const row = rowFor("conv-1", "ses_a");
    expect(row.resolved_at).toBe(11_001);
  });

  it("reports absent for a resolved row and leaves it unchanged", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.resolveOrphanedSession("conv-1", "ses_a");
    const before = rowFor("conv-1", "ses_a");

    expect(
      await opencodeOrphanService.settleAbsentSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
        absenceHorizonMs: 10_000,
      }),
    ).toBe("absent");
    expect(rowFor("conv-1", "ses_a")).toEqual(before);
  });

  it("reports absent for a pair with no row", async () => {
    expect(
      await opencodeOrphanService.settleAbsentSession({
        conversationId: "conv-9",
        sessionId: "ses_x",
        at: 5_000,
        absenceHorizonMs: 10_000,
      }),
    ).toBe("absent");
  });
});

describe("opencodeOrphanService.getOpenSessionRisk", () => {
  it("reports risk for a create intent", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    expect(await opencodeOrphanService.getOpenSessionRisk("conv-1", "ses_a")).toBe("risk");
  });

  it("reports safe for a risk-free orphan", async () => {
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      lateCreateRisk: false,
    });
    expect(await opencodeOrphanService.getOpenSessionRisk("conv-1", "ses_a")).toBe("safe");
  });

  it("reports risk for an unexpected nonzero stored value", async () => {
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      lateCreateRisk: false,
    });
    db.run(
      "UPDATE opencode_session_orphans SET late_create_risk = 2 WHERE conversation_id = ? AND session_id = ?",
      ["conv-1", "ses_a"],
    );
    expect(await opencodeOrphanService.getOpenSessionRisk("conv-1", "ses_a")).toBe("risk");
  });

  it("reflects a risk re-armed after the caller's earlier view", async () => {
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      lateCreateRisk: false,
    });
    db.run(
      "UPDATE opencode_session_orphans SET late_create_risk = 1 WHERE conversation_id = ? AND session_id = ?",
      ["conv-1", "ses_a"],
    );
    expect(await opencodeOrphanService.getOpenSessionRisk("conv-1", "ses_a")).toBe("risk");
  });

  it("reports absent for a resolved row", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.resolveOrphanedSession("conv-1", "ses_a");
    expect(await opencodeOrphanService.getOpenSessionRisk("conv-1", "ses_a")).toBe("absent");
  });

  it("reports absent for a pair with no row", async () => {
    expect(await opencodeOrphanService.getOpenSessionRisk("conv-9", "ses_x")).toBe("absent");
  });
});

describe("opencodeOrphanService.settleTerminatedSession", () => {
  function rowFor(conversationId: string, sessionId: string): Record<string, unknown> {
    return db
      .query("SELECT * FROM opencode_session_orphans WHERE conversation_id = ? AND session_id = ?")
      .get(conversationId, sessionId) as Record<string, unknown>;
  }

  it("releases a risk-free intent", async () => {
    // The create path that rules out a duplicate is the only producer of a
    // risk-free intent; the public writers do not emit one today, so this
    // pins the settlement contract for that shape.
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    db.run(
      "UPDATE opencode_session_orphans SET late_create_risk = 0 WHERE conversation_id = ? AND session_id = ?",
      ["conv-1", "ses_a"],
    );

    expect(
      await opencodeOrphanService.settleTerminatedSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe("released");
    const count = (
      db.query("SELECT COUNT(*) AS c FROM opencode_session_orphans").get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it("retains a risk-bearing intent and ends its absence epoch", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.recordProbe({
      conversationId: "conv-1",
      sessionId: "ses_a",
      outcome: "absent",
      at: 1_000,
    });

    expect(
      await opencodeOrphanService.settleTerminatedSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe("retained");

    const row = rowFor("conv-1", "ses_a");
    expect(row.late_create_risk).toBe(1);
    expect(row.phase).toBe("intent");
    expect(row.first_absent_at).toBeNull();
    expect(row.last_checked_at).toBe(5_000);
    expect(row.resolved_at).toBeNull();
  });

  it("retains a risk-bearing orphan", async () => {
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      lateCreateRisk: true,
    });

    expect(
      await opencodeOrphanService.settleTerminatedSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe("retained");
    expect(rowFor("conv-1", "ses_a").late_create_risk).toBe(1);
  });

  it("retains a row whose stored risk is an unexpected nonzero value", async () => {
    // Termination must apply the same conservative read as the mapper; an
    // `= 1` match would return "absent" and leave the obligation unrotated.
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.recordProbe({
      conversationId: "conv-1",
      sessionId: "ses_a",
      outcome: "absent",
      at: 1_000,
    });
    db.run(
      "UPDATE opencode_session_orphans SET late_create_risk = 2 WHERE conversation_id = ? AND session_id = ?",
      ["conv-1", "ses_a"],
    );

    expect(
      await opencodeOrphanService.settleTerminatedSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe("retained");

    const row = rowFor("conv-1", "ses_a");
    expect(row.late_create_risk).toBe(2);
    expect(row.first_absent_at).toBeNull();
    expect(row.last_checked_at).toBe(5_000);
    expect(row.resolved_at).toBeNull();
  });

  it("leaves a risk-free orphan untouched", async () => {
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      lateCreateRisk: false,
    });
    const before = rowFor("conv-1", "ses_a");

    expect(
      await opencodeOrphanService.settleTerminatedSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe("absent");
    // An orphan carries its own recovery obligation; termination settled the
    // remote session, not that obligation.
    expect(rowFor("conv-1", "ses_a")).toEqual(before);
  });

  it("does not reopen a resolved row", async () => {
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      lateCreateRisk: true,
    });
    await opencodeOrphanService.resolveOrphanedSession("conv-1", "ses_a");
    const before = rowFor("conv-1", "ses_a");

    expect(
      await opencodeOrphanService.settleTerminatedSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe("absent");
    expect(rowFor("conv-1", "ses_a")).toEqual(before);
  });

  it("is idempotent for a retained row and reports absent when none remains", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });

    const input = { conversationId: "conv-1", sessionId: "ses_a", at: 5_000 };
    expect(await opencodeOrphanService.settleTerminatedSession(input)).toBe("retained");
    expect(await opencodeOrphanService.settleTerminatedSession(input)).toBe("retained");

    await opencodeOrphanService.resolveOrphanedSession("conv-1", "ses_a");
    expect(await opencodeOrphanService.settleTerminatedSession(input)).toBe("absent");
  });

  it("reports absent for a pair with no row", async () => {
    expect(
      await opencodeOrphanService.settleTerminatedSession({
        conversationId: "conv-9",
        sessionId: "ses_x",
        at: 5_000,
      }),
    ).toBe("absent");
  });
});

/**
 * RT-011: a conversation deletion arms a durable `delete` marker before any
 * remote call. Its lifecycle differs from create recovery:
 *  - the phase is sticky and is never downgraded by a create/orphan write;
 *  - a nonzero risk is preserved EXACTLY, and a risk-free marker is raised
 *    (deleting a conversation is never proof that a create finished);
 *  - the generic ownership settlement may rotate it but never resolves it;
 *  - confirmed removal or the bounded absence horizon is what settles it, and
 *    the audit row is kept.
 */
describe("opencodeOrphanService — delete markers (RT-011)", () => {
  function rowFor(conversationId: string, sessionId: string): Record<string, unknown> {
    return db
      .query("SELECT * FROM opencode_session_orphans WHERE conversation_id = ? AND session_id = ?")
      .get(conversationId, sessionId) as Record<string, unknown>;
  }

  async function armDeletion(sessionId = "ses_a"): Promise<void> {
    await opencodeOrphanService.recordDeletionIntent({
      conversationId: "conv-1",
      sessionId,
      locationDirectory: "D:\\ws\\conv-1",
    });
  }

  it("arms a risk-bearing delete marker", async () => {
    await armDeletion();

    const row = rowFor("conv-1", "ses_a");
    expect(row.phase).toBe("delete");
    expect(row.late_create_risk).toBe(1);
    expect(row.location_directory).toBe("D:\\ws\\conv-1");
    expect(row.resolved_at).toBeNull();
  });

  it("is sticky: a create/orphan write neither downgrades the phase nor lowers the risk", async () => {
    await armDeletion();
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
      lateCreateRisk: false,
    });

    const row = rowFor("conv-1", "ses_a");
    expect(row.phase).toBe("delete");
    expect(row.late_create_risk).toBe(1);
    expect(row.resolved_at).toBeNull();
  });

  it("preserves an exact nonzero risk (a stored -1 stays -1) on every delete write", async () => {
    await armDeletion();
    db.run(
      "UPDATE opencode_session_orphans SET late_create_risk = -1 WHERE conversation_id = ? AND session_id = ?",
      ["conv-1", "ses_a"],
    );

    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    expect(rowFor("conv-1", "ses_a").late_create_risk).toBe(-1);

    await opencodeOrphanService.recordOrphanedSession({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    expect(rowFor("conv-1", "ses_a").late_create_risk).toBe(-1);

    await opencodeOrphanService.recordDeletionIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    expect(rowFor("conv-1", "ses_a").late_create_risk).toBe(-1);

    expect(
      await opencodeOrphanService.retainDeletionAfterFailedRemoval({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe(true);
    expect(rowFor("conv-1", "ses_a").late_create_risk).toBe(-1);
  });

  it("reopens a resolved row when a conversation still names the session", async () => {
    await armDeletion();
    await opencodeOrphanService.resolveOrphanedSession("conv-1", "ses_a");
    expect(rowFor("conv-1", "ses_a").resolved_at).not.toBeNull();

    expect(
      await opencodeOrphanService.recordDeletionIntent({
        conversationId: "conv-1",
        sessionId: "ses_a",
      }),
    ).toBe(true);

    const row = rowFor("conv-1", "ses_a");
    expect(row.phase).toBe("delete");
    expect(row.late_create_risk).toBe(1);
    expect(row.resolved_at).toBeNull();
  });

  it("raises a risk-free marker but keeps a nonzero one in the retention write", async () => {
    await armDeletion();
    db.run(
      "UPDATE opencode_session_orphans SET late_create_risk = 0 WHERE conversation_id = ? AND session_id = ?",
      ["conv-1", "ses_a"],
    );

    expect(
      await opencodeOrphanService.retainDeletionAfterFailedRemoval({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe(true);
    const row = rowFor("conv-1", "ses_a");
    expect(row.phase).toBe("delete");
    expect(row.late_create_risk).toBe(1);
    expect(row.first_absent_at).toBeNull();
    expect(row.last_checked_at).toBe(5_000);
  });

  it("retains a bound delete marker through the generic ownership settlement", async () => {
    await armDeletion();
    // Even a hand-edited risk-free marker is not settled while its
    // conversation still points at the session: the deletion did not finish.
    db.run(
      "UPDATE opencode_session_orphans SET late_create_risk = 0 WHERE conversation_id = ? AND session_id = ?",
      ["conv-1", "ses_a"],
    );

    expect(
      await opencodeOrphanService.settleOwnedSession({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe("retained");

    const row = rowFor("conv-1", "ses_a");
    expect(row.phase).toBe("delete");
    expect(row.late_create_risk).toBe(0);
    expect(row.resolved_at).toBeNull();
    expect(row.last_checked_at).toBe(5_000);
  });

  it("keeps a risk-bearing marker open after a confirmed removal", async () => {
    await armDeletion();
    await opencodeOrphanService.recordProbe({
      conversationId: "conv-1",
      sessionId: "ses_a",
      outcome: "absent",
      at: 1_000,
    });

    expect(
      await opencodeOrphanService.settleConfirmedDeletion({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe("retained");

    const row = rowFor("conv-1", "ses_a");
    expect(row.phase).toBe("delete");
    expect(row.late_create_risk).toBe(1);
    expect(row.resolved_at).toBeNull();
    expect(row.first_absent_at).toBeNull();
    expect(row.last_checked_at).toBe(5_000);
  });

  it("stamps a risk-free marker resolved after a confirmed removal and keeps the audit row", async () => {
    await armDeletion();
    db.run(
      "UPDATE opencode_session_orphans SET late_create_risk = 0 WHERE conversation_id = ? AND session_id = ?",
      ["conv-1", "ses_a"],
    );

    expect(
      await opencodeOrphanService.settleConfirmedDeletion({
        conversationId: "conv-1",
        sessionId: "ses_a",
        at: 5_000,
      }),
    ).toBe("released");

    const row = rowFor("conv-1", "ses_a");
    expect(row.phase).toBe("delete");
    expect(row.resolved_at).toBe(5_000);
    expect(row.late_create_risk).toBe(0);
  });

  it("settles a marker only after the bounded absence horizon, never deleting it", async () => {
    await armDeletion();
    await opencodeOrphanService.recordProbe({
      conversationId: "conv-1",
      sessionId: "ses_a",
      outcome: "absent",
      at: 1_000,
    });

    const input = {
      conversationId: "conv-1",
      sessionId: "ses_a",
      absenceHorizonMs: 10_000,
    };
    expect(await opencodeOrphanService.settleAbsentSession({ ...input, at: 2_000 })).toBe(
      "retained",
    );
    expect(rowFor("conv-1", "ses_a").resolved_at).toBeNull();

    expect(await opencodeOrphanService.settleAbsentSession({ ...input, at: 12_000 })).toBe(
      "expired",
    );
    const row = rowFor("conv-1", "ses_a");
    expect(row.phase).toBe("delete");
    expect(row.resolved_at).toBe(12_000);
  });

  it("never treats a delete marker as a proven-unused create intent", async () => {
    await armDeletion();
    expect(await opencodeOrphanService.deleteCreateIntent("conv-1", "ses_a")).toBe(false);
    expect(rowFor("conv-1", "ses_a").phase).toBe("delete");
  });
});
