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

  it("records an orphan as risk-free: the session was observed to exist", async () => {
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
    expect(row.late_create_risk).toBe(0);
  });

  it("re-arms the risk when a create request is issued again", async () => {
    await opencodeOrphanService.recordCreateIntent({
      conversationId: "conv-1",
      sessionId: "ses_a",
    });
    await opencodeOrphanService.recordProbe({
      conversationId: "conv-1",
      sessionId: "ses_a",
      outcome: "present",
      at: 1_000,
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

  it("present clears the risk; absent stamps the FIRST 404 and never clears it", async () => {
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

    await opencodeOrphanService.recordProbe({
      conversationId: "conv-1",
      sessionId: "ses_a",
      outcome: "present",
      at: 3_000,
    });
    row = rowFor("conv-1", "ses_a");
    expect(row.late_create_risk).toBe(0);
    expect(row.first_absent_at).toBeNull();
    expect(row.last_checked_at).toBe(3_000);
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
