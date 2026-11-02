import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { applyOpenCodeServiceOwnerSimplificationMigration } from "@/db/schema/opencode-service-owner-migration.ts";

function createFixtureDatabase(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'direct',
      opencode_session_id TEXT,
      opencode_service_owner TEXT,
      opencode_directory TEXT,
      opencode_imported INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return db;
}

describe("applyOpenCodeServiceOwnerSimplificationMigration", () => {
  it("normalizes legacy OpenCode records to local or remote while strictly preserving ordinary TBAi conversations", () => {
    const db = createFixtureDatabase();

    const insert = db.prepare(`
      INSERT INTO conversations (
        id, title, engine, opencode_session_id, opencode_service_owner, opencode_directory, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // 1. Ordinary TBAi conversations (engine = 'direct')
    insert.run("tbai-1", "Direct Chat 1", "direct", null, null, null, 1000, 1000);
    insert.run("tbai-2", "Direct Chat 2", "direct", null, "custom-unrelated", null, 1001, 1001);

    // 2. OpenCode conversations with legacy values
    insert.run("oc-1", "Managed Session", "opencode", "ses_1", "managed", "D:/Work", 2000, 2000);
    insert.run(
      "oc-2",
      "Legacy Loopback Adopted",
      "opencode",
      "ses_2",
      "adopted:http://127.0.0.1:28894",
      "D:/Work",
      2001,
      2001,
    );
    insert.run(
      "oc-3",
      "Legacy Localhost Adopted",
      "opencode",
      "ses_3",
      "adopted:http://localhost:51234",
      "D:/Work",
      2002,
      2002,
    );
    insert.run(
      "oc-4",
      "Default Profile",
      "opencode",
      "ses_4",
      "profile:default",
      "D:/Work",
      2003,
      2003,
    );
    insert.run("oc-5", "Empty string owner", "opencode", "ses_5", "", "D:/Work", 2004, 2004);
    insert.run("oc-6", "NULL owner", "opencode", "ses_6", null, "D:/Work", 2005, 2005);
    insert.run(
      "oc-7",
      "Remote Adopted",
      "opencode",
      "ses_7",
      "adopted:https://opencode.example.com:443/",
      "D:/Work",
      2006,
      2006,
    );
    insert.run(
      "oc-8",
      "Explicit Loopback Remote",
      "opencode",
      "ses_8",
      "remote:http://127.0.0.1:4000",
      "D:/Work",
      2007,
      2007,
    );
    insert.run(
      "oc-9",
      "Non-default custom profile",
      "opencode",
      "ses_9",
      "profile:custom-agent",
      "D:/Work",
      2008,
      2008,
    );

    // Run migration
    applyOpenCodeServiceOwnerSimplificationMigration(db);

    const get = (id: string) =>
      db.query<any, [string]>("SELECT * FROM conversations WHERE id = ?").get(id);

    // Ordinary conversations must be completely untouched
    expect(get("tbai-1").opencode_service_owner).toBeNull();
    expect(get("tbai-1").engine).toBe("direct");
    expect(get("tbai-2").opencode_service_owner).toBe("custom-unrelated");
    expect(get("tbai-2").engine).toBe("direct");

    // OpenCode conversations normalized
    expect(get("oc-1").opencode_service_owner).toBe("local");
    expect(get("oc-1").opencode_session_id).toBe("ses_1");
    expect(get("oc-1").title).toBe("Managed Session");
    expect(get("oc-1").created_at).toBe(2000);

    expect(get("oc-2").opencode_service_owner).toBe("local");
    expect(get("oc-3").opencode_service_owner).toBe("local");
    expect(get("oc-4").opencode_service_owner).toBe("local");
    expect(get("oc-5").opencode_service_owner).toBe("local");
    expect(get("oc-6").opencode_service_owner).toBe("local");

    expect(get("oc-7").opencode_service_owner).toBe("remote:https://opencode.example.com");
    expect(get("oc-8").opencode_service_owner).toBe("remote:http://127.0.0.1:4000");
    expect(get("oc-9").opencode_service_owner).toBe("profile:custom-agent");

    // Idempotence: running a second time makes zero changes
    applyOpenCodeServiceOwnerSimplificationMigration(db);
    expect(get("oc-1").opencode_service_owner).toBe("local");
    expect(get("oc-8").opencode_service_owner).toBe("remote:http://127.0.0.1:4000");
    expect(get("oc-9").opencode_service_owner).toBe("profile:custom-agent");
    expect(get("tbai-2").opencode_service_owner).toBe("custom-unrelated");
  });
});
