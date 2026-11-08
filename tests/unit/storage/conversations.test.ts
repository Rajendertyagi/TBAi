import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { applyOpenCodeSessionImportMigration, db } from "../../../src/db";
import { conversationService } from "../../../src/services/storage/conversations";

describe("OpenCode session import database migration safety", () => {
  it("preflight detects duplicate owner/session bindings and throws naming conflicting IDs", () => {
    const testDb = new Database(":memory:");
    testDb.run(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        opencode_session_id TEXT,
        opencode_service_owner TEXT
      );
    `);

    // Insert two conversations with identical session ID and null/managed owner
    testDb.run(
      "INSERT INTO conversations (id, title, opencode_session_id, opencode_service_owner) VALUES ('c1', 'T1', 'ses_duplicate', NULL)",
    );
    testDb.run(
      "INSERT INTO conversations (id, title, opencode_session_id, opencode_service_owner) VALUES ('c2', 'T2', 'ses_duplicate', 'managed')",
    );

    expect(() => applyOpenCodeSessionImportMigration(testDb)).toThrow(
      /Duplicate OpenCode owner\/session bindings require manual resolution/,
    );

    // Verify it listed the IDs
    try {
      applyOpenCodeSessionImportMigration(testDb);
    } catch (err: any) {
      expect(err.message).toContain("c1");
      expect(err.message).toContain("c2");
    }

    testDb.close();
  });

  it("normalizes legacy rows and enforces partial unique index on (owner, session_id)", () => {
    const testDb = new Database(":memory:");
    testDb.run(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        opencode_session_id TEXT,
        opencode_service_owner TEXT
      );
    `);

    // Valid data without duplicates across owners
    testDb.run(
      "INSERT INTO conversations (id, title, opencode_session_id, opencode_service_owner) VALUES ('c1', 'T1', 'ses_1', NULL)",
    );
    testDb.run(
      "INSERT INTO conversations (id, title, opencode_session_id, opencode_service_owner) VALUES ('c2', 'T2', 'ses_1', 'remote:https://opencode.remote.server')",
    );
    testDb.run(
      "INSERT INTO conversations (id, title, opencode_session_id, opencode_service_owner) VALUES ('c3', 'T3', NULL, NULL)",
    );
    testDb.run(
      "INSERT INTO conversations (id, title, opencode_session_id, opencode_service_owner) VALUES ('c4', 'T4', NULL, NULL)",
    );

    // Apply migration
    applyOpenCodeSessionImportMigration(testDb);

    // Verify columns were added
    const tableInfo = testDb.query<{ name: string }, []>("PRAGMA table_info(conversations)").all();
    const columnNames = tableInfo.map((c) => c.name);
    expect(columnNames).toContain("opencode_directory");
    expect(columnNames).toContain("opencode_imported");

    // Verify legacy row c1 was normalized to 'managed'
    const c1 = testDb
      .query<{ opencode_service_owner: string }, []>(
        "SELECT opencode_service_owner FROM conversations WHERE id = 'c1'",
      )
      .get();
    expect(c1?.opencode_service_owner).toBe("local");

    // Verify multiple null session IDs are allowed (partial index)
    testDb.run(
      "INSERT INTO conversations (id, title, opencode_session_id, opencode_service_owner) VALUES ('c5', 'T5', NULL, 'local')",
    );

    // Verify duplicate (owner, session_id) is blocked by partial unique index
    expect(() => {
      testDb.run(
        "INSERT INTO conversations (id, title, opencode_session_id, opencode_service_owner) VALUES ('c6', 'T6', 'ses_1', 'local')",
      );
    }).toThrow();

    testDb.close();
  });
});

describe("conversationService owner-aware session identity and provenance", () => {
  it("stores and maps opencodeDirectory and opencodeImported on create", async () => {
    const created = await conversationService.create({
      title: "Imported Conversation",
      providerId: null,
      workspaceMode: "simple",
      opencodeSessionId: "ses_imp_1",
      opencodeServiceOwner: "managed",
      opencodeDirectory: "/workspace/external/project",
      opencodeImported: true,
      engine: "opencode",
    });

    expect(created.opencodeSessionId).toBe("ses_imp_1");
    expect(created.opencodeServiceOwner).toBe("managed");
    expect(created.opencodeDirectory).toBe("/workspace/external/project");
    expect(created.opencodeImported).toBe(true);

    const reloaded = await conversationService.get(created.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.opencodeDirectory).toBe("/workspace/external/project");
    expect(reloaded?.opencodeImported).toBe(true);
  });

  it("findByOpenCodeSession isolates across distinct service owners", async () => {
    const managedConv = await conversationService.create({
      title: "Managed Session",
      providerId: null,
      workspaceMode: "simple",
      opencodeSessionId: "ses_shared_123",
      opencodeServiceOwner: "managed",
      engine: "opencode",
    });

    const adoptedConv = await conversationService.create({
      title: "Adopted Session",
      providerId: null,
      workspaceMode: "simple",
      opencodeSessionId: "ses_shared_123",
      opencodeServiceOwner: "adopted:http://192.168.1.50:4096",
      engine: "opencode",
    });

    const foundManaged = await conversationService.findByOpenCodeSession(
      "managed",
      "ses_shared_123",
    );
    expect(foundManaged?.id).toBe(managedConv.id);

    const foundAdopted = await conversationService.findByOpenCodeSession(
      "adopted:http://192.168.1.50:4096",
      "ses_shared_123",
    );
    expect(foundAdopted?.id).toBe(adoptedConv.id);

    const notFound = await conversationService.findByOpenCodeSession(
      "adopted:http://other-host:4096",
      "ses_shared_123",
    );
    expect(notFound).toBeNull();
  });

  it("findByOpenCodeSession resolves legacy rows with empty/null owner as managed", async () => {
    const conv = await conversationService.create({
      title: "Legacy Binding",
      providerId: null,
      workspaceMode: "simple",
      engine: "opencode",
    });

    db.run(
      "UPDATE conversations SET opencode_session_id = 'ses_legacy_99', opencode_service_owner = NULL WHERE id = ?",
      [conv.id],
    );

    const foundManaged = await conversationService.findByOpenCodeSession(
      "managed",
      "ses_legacy_99",
    );
    expect(foundManaged?.id).toBe(conv.id);

    const foundDefault = await conversationService.findByOpenCodeSession("", "ses_legacy_99");
    expect(foundDefault?.id).toBe(conv.id);
  });

  it("listImportedOpenCodeSessionIds returns all bound session IDs for given owner", async () => {
    await conversationService.create({
      title: "Managed 1",
      providerId: null,
      workspaceMode: "simple",
      opencodeSessionId: "ses_m_1",
      opencodeServiceOwner: "managed",
      engine: "opencode",
    });
    await conversationService.create({
      title: "Managed 2",
      providerId: null,
      workspaceMode: "simple",
      opencodeSessionId: "ses_m_2",
      opencodeServiceOwner: "managed",
      engine: "opencode",
    });
    await conversationService.create({
      title: "Adopted 1",
      providerId: null,
      workspaceMode: "simple",
      opencodeSessionId: "ses_a_1",
      opencodeServiceOwner: "adopted:http://remote:4096",
      engine: "opencode",
    });

    const managedIds = await conversationService.listImportedOpenCodeSessionIds("managed");
    expect(managedIds.has("ses_m_1")).toBe(true);
    expect(managedIds.has("ses_m_2")).toBe(true);
    expect(managedIds.has("ses_a_1")).toBe(false);

    const adoptedIds = await conversationService.listImportedOpenCodeSessionIds(
      "adopted:http://remote:4096",
    );
    expect(adoptedIds.has("ses_a_1")).toBe(true);
    expect(adoptedIds.has("ses_m_1")).toBe(false);
  });

  it("update modifies opencodeDirectory and opencodeImported", async () => {
    const conv = await conversationService.create({
      title: "Initial Conv",
      providerId: null,
      workspaceMode: "simple",
      engine: "opencode",
    });

    const updated = await conversationService.update(conv.id, {
      opencodeSessionId: "ses_updated",
      opencodeDirectory: "/new/directory",
      opencodeImported: true,
    });

    expect(updated.opencodeSessionId).toBe("ses_updated");
    expect(updated.opencodeDirectory).toBe("/new/directory");
    expect(updated.opencodeImported).toBe(true);
  });

  it("clearOpenCodeSessionPointer clears session pointer, directory, and imported status", async () => {
    const conv = await conversationService.create({
      title: "To Be Cleared",
      providerId: null,
      workspaceMode: "simple",
      opencodeSessionId: "ses_to_clear",
      opencodeServiceOwner: "managed",
      opencodeDirectory: "/dir/to/clear",
      opencodeImported: true,
      engine: "opencode",
    });

    const cleared = await conversationService.clearOpenCodeSessionPointer(conv.id, "ses_to_clear");
    expect(cleared).toBe(true);

    const reloaded = await conversationService.get(conv.id);
    expect(reloaded?.opencodeSessionId).toBeNull();
    expect(reloaded?.opencodeServiceOwner).toBeNull();
    expect(reloaded?.opencodeDirectory).toBeNull();
    expect(reloaded?.opencodeImported).toBe(false);
  });
});
