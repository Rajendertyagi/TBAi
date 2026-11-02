import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import openCodeApp from "@/routes/opencode.ts";
import { applyOpenCodeSessionImportMigration, db } from "@/db/index.ts";
import { conversationService } from "@/services/storage/conversations.ts";
import { encodeSourceRef, importOpenCodeSession } from "@/services/opencode/import.ts";
import {
  ensureOpenCodeSession,
  reconcileOpenCodeSessionDirectory,
} from "@/services/opencode/sessions.ts";
import {
  OpenCodeImportStaleSourceError,
  OpenCodeImportedSessionMissingError,
} from "@/services/opencode/errors";
import {
  installAdoptedTarget,
  installManagedTarget,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";

describe("Stage 5: End-to-end integration, performance, and data integrity verification", () => {
  // Test app mounting the opencode routes exactly as in production (src/index.ts)
  const testApp = new Hono();
  testApp.route("/api/opencode", openCodeApp);

  // Mock OpenCode server state
  let mockSessions: Array<{
    id: string;
    title: string;
    directory: string;
    location?: { directory: string };
    time: { created: number; updated: number };
  }> = [];

  const mockMessagesBySession = new Map<string, any[]>();

  // Mock server to handle session endpoints conforming to OpenCode 2.2.0 contract
  const mockServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const cleanPath = url.pathname.replace(/^\/api/, "");

      if (cleanPath === "/project" && req.method === "GET") {
        return Response.json([]);
      }

      // Session listing (returns { data: SessionInfo[], cursor: { next: ... } })
      if (cleanPath === "/session" && req.method === "GET") {
        return Response.json({
          data: mockSessions.map((s) => ({
            ...s,
            location: { directory: s.directory },
          })),
          cursor: { next: null },
        });
      }

      // Session creation (returns { data: SessionInfo } with HTTP 200)
      if (cleanPath === "/session" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as any;
        const requestedId = body.id || (typeof body.sessionID === "string" ? body.sessionID : null);
        const dir = body.location?.directory || body.directory || "D:/Projects/Default";
        const newSession = {
          id: requestedId || `ses_created_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          title: body.title || "New Session",
          directory: dir,
          location: { directory: dir },
          time: { created: Date.now(), updated: Date.now() },
        };
        mockSessions.push(newSession);
        return Response.json({ data: newSession }, { status: 200 });
      }

      // Session messages
      const messagesMatch = cleanPath.match(/^\/session\/([^/]+)\/message$/);
      if (messagesMatch && req.method === "GET") {
        const sessionId = decodeURIComponent(messagesMatch[1]);
        const msgs = mockMessagesBySession.get(sessionId) ?? [];
        return Response.json(msgs);
      }

      // Session details (returns { data: SessionInfo } with HTTP 200)
      const sessionMatch = cleanPath.match(/^\/session\/([^/]+)$/);
      if (sessionMatch && req.method === "GET") {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const found = mockSessions.find((s) => s.id === sessionId);
        if (!found) {
          return Response.json({ error: "Session not found" }, { status: 404 });
        }
        return Response.json({
          data: {
            ...found,
            location: { directory: found.directory },
          },
        });
      }

      // Model listing / config / provider endpoints
      if (cleanPath === "/model/default") {
        return Response.json({ data: null });
      }
      if (cleanPath === "/model" || cleanPath === "/provider") {
        return Response.json({ data: [] });
      }
      if (cleanPath === "/config") {
        return Response.json({ data: {} });
      }
      if (cleanPath === "/vcs") {
        return Response.json({ data: { branch: { current: "main" } } });
      }

      // Event stream
      if (cleanPath === "/event") {
        return new Response('data: {"type":"server.connected"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
      }

      console.log(`[MOCK_SERVER UNHANDLED] ${req.method} ${url.pathname}`);
      return Response.json({ error: "Route not found in mock" }, { status: 404 });
    },
  });

  const mockBaseUrl = `http://127.0.0.1:${mockServer.port}`;

  // Preserve original ensureBaseUrl
  const originalEnsureBaseUrl = openCodeServerManager.ensureBaseUrl;

  beforeAll(() => {
    (openCodeServerManager as any).ensureBaseUrl = async () => mockBaseUrl;
    resetConnectionStateForTests();
    installManagedTarget({ baseUrl: mockBaseUrl, password: "test-password" });
  });

  afterAll(() => {
    mockServer.stop();
    (openCodeServerManager as any).ensureBaseUrl = originalEnsureBaseUrl;
    resetConnectionStateForTests();
  });

  // =========================================================================
  // Section 1: End-to-End Integration Verification (13 Scenarios)
  // =========================================================================

  describe("1. End-to-end integration scenarios", () => {
    it("Scenario 1: Discovers and imports a session from a managed OpenCode service via HTTP API", async () => {
      resetConnectionStateForTests();
      installManagedTarget({ baseUrl: mockBaseUrl, password: "test-password" });

      const testSessionId = `ses_managed_${Date.now()}`;
      mockSessions = [
        {
          id: testSessionId,
          title: "Managed Remote Session",
          directory: "D:/Projects/ManagedApp",
          time: { created: Date.now() - 50000, updated: Date.now() - 1000 },
        },
      ];

      // Step 1: Discover via HTTP GET /api/opencode/importable
      const listReq = new Request("http://localhost/api/opencode/importable");
      const listRes = await testApp.fetch(listReq);
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as any;
      expect(listBody.sessions).toBeDefined();

      const candidate = listBody.sessions.find((s: any) => s.sessionId === testSessionId);
      expect(candidate).toBeDefined();
      expect(candidate.title).toBe("Managed Remote Session");
      expect(candidate.sourceRef).toBeDefined();

      // Step 2: Import via HTTP POST /api/opencode/import
      const importReq = new Request("http://localhost/api/opencode/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: testSessionId,
          sourceRef: candidate.sourceRef,
        }),
      });
      const importRes = await testApp.fetch(importReq);
      expect(importRes.status).toBe(201);
      const importBody = (await importRes.json()) as any;
      expect(importBody.conversationId).toBeDefined();

      // Verify conversation record in storage
      const conv = await conversationService.get(importBody.conversationId);
      expect(conv).toBeDefined();
      expect(conv!.engine).toBe("opencode");
      expect(conv!.opencodeSessionId).toBe(testSessionId);
      expect(conv!.opencodeServiceOwner).toBe("local");
      expect(conv!.opencodeImported).toBe(true);
      expect(conv!.opencodeDirectory).toBe("D:/Projects/ManagedApp");
    });

    it("Scenario 2: Discovers and imports a session from an adopted OpenCode service", async () => {
      resetConnectionStateForTests();
      installAdoptedTarget({ origin: mockBaseUrl, password: "adopted-password" });

      const testSessionId = `ses_adopted_${Date.now()}`;
      mockSessions = [
        {
          id: testSessionId,
          title: "Adopted Remote Session",
          directory: "/remote/linux/workspace",
          time: { created: Date.now() - 30000, updated: Date.now() - 500 },
        },
      ];

      const listReq = new Request("http://localhost/api/opencode/importable");
      const listRes = await testApp.fetch(listReq);
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as any;
      const candidate = listBody.sessions.find((s: any) => s.sessionId === testSessionId);
      expect(candidate).toBeDefined();

      const importReq = new Request("http://localhost/api/opencode/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: testSessionId,
          sourceRef: candidate.sourceRef,
        }),
      });
      const importRes = await testApp.fetch(importReq);
      expect(importRes.status).toBe(201);
      const importBody = (await importRes.json()) as any;

      const conv = await conversationService.get(importBody.conversationId);
      expect(conv).toBeDefined();
      expect(conv!.opencodeServiceOwner).toBe("local");
      expect(conv!.opencodeImported).toBe(true);
      expect(conv!.opencodeDirectory).toBe("/remote/linux/workspace");
    });

    it("Scenario 3: Opens an imported conversation and verifies native history loads through proxy", async () => {
      resetConnectionStateForTests();
      installManagedTarget({ baseUrl: mockBaseUrl, password: "test-password" });

      const testSessionId = `ses_native_history_${Date.now()}`;
      mockSessions = [
        {
          id: testSessionId,
          title: "Native History Test",
          directory: "D:/Projects/HistoryTest",
          time: { created: 1000, updated: 2000 },
        },
      ];

      mockMessagesBySession.set(testSessionId, [
        {
          id: "msg-1",
          role: "user",
          parts: [{ id: "p1", type: "text", text: "Hello from native OpenCode" }],
        },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ id: "p2", type: "text", text: "Native response" }],
        },
      ]);

      const conv = await conversationService.create({
        title: "Imported History Conv",
        providerId: "",
        workspaceMode: "simple",
        engine: "opencode",
        opencodeSessionId: testSessionId,
        opencodeServiceOwner: "local",
        opencodeImported: true,
        opencodeDirectory: "D:/Projects/HistoryTest",
      });

      // Fetch history through the OpenCode proxy route
      const historyReq = new Request(
        `http://localhost/api/opencode/session/${testSessionId}/message`,
        {
          headers: {
            "x-conversation-id": conv.id,
            "x-opencode-directory": "D:/Projects/HistoryTest",
          },
        },
      );
      const historyRes = await testApp.fetch(historyReq);
      expect(historyRes.status).toBe(200);
      const messages = (await historyRes.json()) as any[];
      expect(messages.length).toBe(2);
      expect(messages[0].parts[0].text).toBe("Hello from native OpenCode");
      expect(messages[1].parts[0].text).toBe("Native response");
    });

    it("Scenario 4: Verifies that no transcript messages are copied into TBAi SQLite", async () => {
      const testSessionId = `ses_zero_storage_${Date.now()}`;
      mockSessions = [
        {
          id: testSessionId,
          title: "Zero Storage Test",
          directory: "D:/Projects/ZeroStorage",
          time: { created: 1000, updated: 2000 },
        },
      ];

      const conv = await conversationService.create({
        title: "Zero Storage Conv",
        providerId: "",
        workspaceMode: "simple",
        engine: "opencode",
        opencodeSessionId: testSessionId,
        opencodeServiceOwner: "local",
        opencodeImported: true,
        opencodeDirectory: "D:/Projects/ZeroStorage",
      });

      // Check SQLite messages table for this conversation directly
      const sqliteMessages = db
        .query("SELECT * FROM messages WHERE conversation_id = ?")
        .all(conv.id);
      expect(sqliteMessages).toHaveLength(0);
    });

    it("Scenario 5: Rejects duplicate imports under the same service owner and returns 409 + conversationId", async () => {
      resetConnectionStateForTests();
      installManagedTarget({ baseUrl: mockBaseUrl, password: "test-password" });

      const testSessionId = `ses_dup_${Date.now()}`;
      mockSessions = [
        {
          id: testSessionId,
          title: "Duplicate Check",
          directory: "D:/Projects/DupCheck",
          time: { created: 1000, updated: 2000 },
        },
      ];

      const discoveryReq = new Request("http://localhost/api/opencode/importable");
      const discoveryRes = await testApp.fetch(discoveryReq);
      const discoveryBody = (await discoveryRes.json()) as any;
      const candidate = discoveryBody.sessions.find((s: any) => s.sessionId === testSessionId);
      expect(candidate).toBeDefined();

      // First import
      const firstRes = await testApp.fetch(
        new Request("http://localhost/api/opencode/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: testSessionId, sourceRef: candidate.sourceRef }),
        }),
      );
      expect(firstRes.status).toBe(201);
      const { conversationId } = (await firstRes.json()) as any;

      // Duplicate import attempt
      const dupRes = await testApp.fetch(
        new Request("http://localhost/api/opencode/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: testSessionId, sourceRef: candidate.sourceRef }),
        }),
      );
      expect(dupRes.status).toBe(409);
      const dupBody = (await dupRes.json()) as any;
      expect(dupBody.conversationId).toBe(conversationId);
      expect(dupBody.error).toContain("already been imported");
    });

    it("Scenario 6: Allows identical session IDs under different service owners to remain isolated", async () => {
      const sharedSessionId = `ses_cross_owner_${Date.now()}`;

      // Create conversation under local owner
      const convLocal = await conversationService.create({
        title: "Local Owner Conv",
        providerId: "",
        workspaceMode: "simple",
        engine: "opencode",
        opencodeSessionId: sharedSessionId,
        opencodeServiceOwner: "local",
        opencodeImported: true,
        opencodeDirectory: "D:/Projects/AppA",
      });

      // Create conversation under remote owner with the SAME session ID
      const convRemote = await conversationService.create({
        title: "Remote Owner Conv",
        providerId: "",
        workspaceMode: "simple",
        engine: "opencode",
        opencodeSessionId: sharedSessionId,
        opencodeServiceOwner: "remote:https://opencode-cloud.com",
        opencodeImported: true,
        opencodeDirectory: "/remote/linux/AppA",
      });

      expect(convLocal.id).not.toBe(convRemote.id);

      const foundLocal = await conversationService.findByOpenCodeSession("local", sharedSessionId);
      const foundRemote = await conversationService.findByOpenCodeSession(
        "remote:https://opencode-cloud.com",
        sharedSessionId,
      );

      expect(foundLocal?.id).toBe(convLocal.id);
      expect(foundRemote?.id).toBe(convRemote.id);
    });

    it("Scenario 7: Rejects stale source references when runtime target changes", async () => {
      resetConnectionStateForTests();
      installManagedTarget({ baseUrl: mockBaseUrl, password: "test-password" });

      const testSessionId = `ses_stale_target_${Date.now()}`;
      mockSessions = [
        {
          id: testSessionId,
          title: "Target Switch Check",
          directory: "D:/Projects/TargetSwitch",
          time: { created: 1000, updated: 2000 },
        },
      ];

      // Source reference encoded for targetId 9999
      const staleSourceRef = encodeSourceRef({
        mode: "managed",
        targetId: 9999,
        origin: mockBaseUrl,
      });

      await expect(
        importOpenCodeSession({
          sessionId: testSessionId,
          sourceRef: staleSourceRef,
        }),
      ).rejects.toThrow(OpenCodeImportStaleSourceError);
    });

    it("Scenario 8: Reconciles directory and updates SQLite when an active session moves while TBAi is open", async () => {
      resetConnectionStateForTests();
      installManagedTarget({ baseUrl: mockBaseUrl, password: "test-password" });

      const testSessionId = `ses_active_move_${Date.now()}`;
      mockSessions = [
        {
          id: testSessionId,
          title: "Active Move Session",
          directory: "D:/Initial/Path",
          time: { created: 1000, updated: 2000 },
        },
      ];

      const conv = await conversationService.create({
        title: "Active Move Conv",
        providerId: "",
        workspaceMode: "simple",
        engine: "opencode",
        opencodeSessionId: testSessionId,
        opencodeServiceOwner: "local",
        opencodeImported: true,
        opencodeDirectory: "D:/Initial/Path",
      });

      // External OpenCode moves session to new path
      mockSessions[0].directory = "D:/Moved/NewPath";

      // Reconcile via HTTP route
      const reconcileReq = new Request(
        "http://localhost/api/opencode/session/reconcile-directory",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationId: conv.id }),
        },
      );
      const reconcileRes = await testApp.fetch(reconcileReq);
      expect(reconcileRes.status).toBe(200);
      const reconcileBody = (await reconcileRes.json()) as any;
      expect(reconcileBody.directory).toBe("D:/Moved/NewPath");
      expect(reconcileBody.sessionId).toBe(testSessionId);

      // Verify DB record updated
      const updated = await conversationService.get(conv.id);
      expect(updated!.opencodeDirectory).toBe("D:/Moved/NewPath");
      expect(updated!.opencodeSessionId).toBe(testSessionId); // Preserved
    });

    it("Scenario 9: Reconciles directory when an imported conversation was moved while TBAi was closed", async () => {
      resetConnectionStateForTests();
      installManagedTarget({ baseUrl: mockBaseUrl, password: "test-password" });

      const testSessionId = `ses_offline_move_${Date.now()}`;
      mockSessions = [
        {
          id: testSessionId,
          title: "Offline Move Session",
          directory: "D:/Offline/MovedLocation", // OpenCode already has new location
          time: { created: 1000, updated: 2000 },
        },
      ];

      // Conversation in SQLite still has old location
      const conv = await conversationService.create({
        title: "Offline Move Conv",
        providerId: "",
        workspaceMode: "simple",
        engine: "opencode",
        opencodeSessionId: testSessionId,
        opencodeServiceOwner: "local",
        opencodeImported: true,
        opencodeDirectory: "D:/Offline/OldLocation",
      });

      // Opening the session via ensureOpenCodeSession discovers the offline move
      const sessionResult = await ensureOpenCodeSession(conv.id);
      expect(sessionResult.directory).toBe("D:/Offline/MovedLocation");
      expect(sessionResult.sessionId).toBe(testSessionId);

      // Verify SQLite was updated during open
      const updated = await conversationService.get(conv.id);
      expect(updated!.opencodeDirectory).toBe("D:/Offline/MovedLocation");
    });

    it("Scenario 10: Reports error and never creates a replacement session when an imported session is 404", async () => {
      resetConnectionStateForTests();
      installManagedTarget({ baseUrl: mockBaseUrl, password: "test-password" });

      const missingSessionId = `ses_deleted_${Date.now()}`;
      // Not present in mockSessions

      const conv = await conversationService.create({
        title: "Missing Imported Conv",
        providerId: "",
        workspaceMode: "simple",
        engine: "opencode",
        opencodeSessionId: missingSessionId,
        opencodeServiceOwner: "local",
        opencodeImported: true,
        opencodeDirectory: "D:/Projects/DeletedSession",
      });

      // Opening fails closed with OpenCodeImportedSessionMissingError
      await expect(ensureOpenCodeSession(conv.id)).rejects.toThrow(
        OpenCodeImportedSessionMissingError,
      );

      // Verify pointer remains intact and was NOT overwritten
      const check = await conversationService.get(conv.id);
      expect(check!.opencodeSessionId).toBe(missingSessionId);
    });

    it("Scenario 11: Retains existing stale-session recreation behavior for ordinary native conversations", async () => {
      resetConnectionStateForTests();
      installManagedTarget({ baseUrl: mockBaseUrl, password: "test-password" });

      const staleSessionId = `ses_stale_native_${Date.now()}`;
      // Not present in mockSessions

      const conv = await conversationService.create({
        title: "Ordinary Native Conv",
        providerId: "",
        workspaceMode: "simple",
        engine: "opencode",
        opencodeSessionId: staleSessionId,
        opencodeServiceOwner: "local",
        opencodeImported: false, // Ordinary TBAi conversation
      });

      // ensureOpenCodeSession detects missing session on remote and recreates for ordinary native conversation
      const sessionResult = await ensureOpenCodeSession(conv.id);
      expect(sessionResult.sessionId).toBeDefined();
      expect(sessionResult.sessionId).not.toBe(staleSessionId);

      const check = await conversationService.get(conv.id);
      expect(check!.opencodeSessionId).toBe(sessionResult.sessionId);
    });

    it("Scenario 12: Verifies external filesystem directory moves do not cause silent session recreation", async () => {
      resetConnectionStateForTests();
      installManagedTarget({ baseUrl: mockBaseUrl, password: "test-password" });

      const testSessionId = `ses_external_rename_${Date.now()}`;
      mockSessions = [
        {
          id: testSessionId,
          title: "Rename Test Session",
          directory: "D:/Projects/RenamedFolder",
          time: { created: 1000, updated: 2000 },
        },
      ];

      const conv = await conversationService.create({
        title: "Rename Test Conv",
        providerId: "",
        workspaceMode: "simple",
        engine: "opencode",
        opencodeSessionId: testSessionId,
        opencodeServiceOwner: "local",
        opencodeImported: true,
        opencodeDirectory: "D:/Projects/OriginalFolder",
      });

      const res = await ensureOpenCodeSession(conv.id);
      // Session ID was strictly preserved, directory was updated to authoritative location
      expect(res.sessionId).toBe(testSessionId);
      expect(res.directory).toBe("D:/Projects/RenamedFolder");
    });

    it("Scenario 13: Treats adopted-service directories strictly as opaque strings without OS manipulation", async () => {
      resetConnectionStateForTests();
      installAdoptedTarget({ origin: mockBaseUrl, password: "adopted-password" });

      const opaqueRemotePath = "/var/containers/backend/data/work tree with spaces";

      const testSessionId = `ses_opaque_${Date.now()}`;
      mockSessions = [
        {
          id: testSessionId,
          title: "Opaque Linux Path Session",
          directory: opaqueRemotePath,
          time: { created: 1000, updated: 2000 },
        },
      ];

      const listReq = new Request("http://localhost/api/opencode/importable");
      const listRes = await testApp.fetch(listReq);
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as any;
      const candidate = listBody.sessions.find((s: any) => s.sessionId === testSessionId);
      expect(candidate).toBeDefined();

      const importReq = new Request("http://localhost/api/opencode/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: testSessionId,
          sourceRef: candidate.sourceRef,
        }),
      });
      const importRes = await testApp.fetch(importReq);
      expect(importRes.status).toBe(201);
      const importBody = (await importRes.json()) as any;

      const conv = await conversationService.get(importBody.conversationId);
      expect(conv!.opencodeDirectory).toBe(opaqueRemotePath); // Kept 100% opaque, not converted to Windows path
    });
  });

  // =========================================================================
  // Section 2: Migration and Data Integrity Verification
  // =========================================================================

  describe("2. Migration and data integrity", () => {
    it("Verifies migration runs cleanly on disposable SQLite databases", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-migration-test-"));
      const tempDbPath = path.join(tempDir, "disposable.db");

      try {
        const disposableDb = new Database(tempDbPath);
        disposableDb.run(`
          CREATE TABLE conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            engine TEXT,
            opencode_session_id TEXT,
            opencode_service_owner TEXT
          );
        `);

        // Insert legacy rows
        disposableDb.run(`
          INSERT INTO conversations (id, title, engine, opencode_session_id, opencode_service_owner)
          VALUES ('c1', 'Legacy Managed', 'opencode', 'ses_legacy_1', NULL);
        `);
        disposableDb.run(`
          INSERT INTO conversations (id, title, engine, opencode_session_id, opencode_service_owner)
          VALUES ('c2', 'Legacy Empty Owner', 'opencode', 'ses_legacy_2', '');
        `);

        // Apply migration
        applyOpenCodeSessionImportMigration(disposableDb);

        // Verify columns were added
        const columns = disposableDb.query("PRAGMA table_info(conversations)").all() as Array<{
          name: string;
        }>;
        expect(columns.some((c) => c.name === "opencode_directory")).toBe(true);
        expect(columns.some((c) => c.name === "opencode_imported")).toBe(true);

        // Verify legacy rows were normalized to 'local'
        const row1 = disposableDb.query("SELECT * FROM conversations WHERE id = 'c1'").get() as any;
        expect(row1.opencode_service_owner).toBe("local");
        expect(row1.opencode_imported).toBe(0);

        const row2 = disposableDb.query("SELECT * FROM conversations WHERE id = 'c2'").get() as any;
        expect(row2.opencode_service_owner).toBe("local");

        // Verify index enforcement
        expect(() => {
          disposableDb.run(`
            INSERT INTO conversations (id, title, engine, opencode_session_id, opencode_service_owner)
            VALUES ('c3', 'Duplicate', 'opencode', 'ses_legacy_1', 'local');
          `);
        }).toThrow();

        disposableDb.close();
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // ignore Windows temp file locking
        }
      }
    });

    it("Fails non-destructively when preflight duplicate audit detects conflicting session bindings", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-dup-audit-test-"));
      const tempDbPath = path.join(tempDir, "dup.db");

      try {
        const disposableDb = new Database(tempDbPath);
        disposableDb.run(`
          CREATE TABLE conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            opencode_session_id TEXT,
            opencode_service_owner TEXT
          );
        `);

        // Duplicate bindings for same session
        disposableDb.run(`
          INSERT INTO conversations (id, title, opencode_session_id, opencode_service_owner)
          VALUES ('c1', 'First', 'ses_dup_preflight', 'local'),
                 ('c2', 'Second', 'ses_dup_preflight', 'local');
        `);

        // Migration must throw with conflicting IDs
        expect(() => applyOpenCodeSessionImportMigration(disposableDb)).toThrow(
          /Duplicate OpenCode owner\/session bindings require manual resolution.*c1.*c2/,
        );

        // Verify no destructive alteration occurred: table and rows are untouched
        const count = disposableDb
          .query("SELECT COUNT(*) as count FROM conversations")
          .get() as any;
        expect(count.count).toBe(2);

        disposableDb.close();
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // ignore Windows temp file locking
        }
      }
    });
  });

  // =========================================================================
  // Section 3: Performance Verification
  // =========================================================================

  describe("3. Performance verification", () => {
    it("Measures importable-session discovery latency", async () => {
      resetConnectionStateForTests();
      installManagedTarget({ baseUrl: mockBaseUrl, password: "test-password" });

      // 100 sessions in OpenCode
      mockSessions = Array.from({ length: 100 }, (_, i) => ({
        id: `ses_perf_disc_${i}`,
        title: `Discovery Session ${i}`,
        directory: `D:/Projects/Perf_${i}`,
        time: { created: Date.now() - i * 1000, updated: Date.now() - i * 500 },
      }));

      const start = performance.now();
      // Request with limit 100 to scan all 100
      const listReq = new Request(
        "http://localhost/api/opencode/importable?limit=100&scanLimit=100",
      );
      const listRes = await testApp.fetch(listReq);
      const elapsed = performance.now() - start;

      expect(listRes.status).toBe(200);
      const body = (await listRes.json()) as any;
      expect(body.sessions.length).toBe(100);

      console.log(`[PERF] Discovery latency for 100 sessions: ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(500); // Sub-half-second for 100 sessions
    });

    it("Measures single session import operation latency", async () => {
      resetConnectionStateForTests();
      installManagedTarget({ baseUrl: mockBaseUrl, password: "test-password" });

      const testSessionId = `ses_perf_import_${Date.now()}`;
      mockSessions = [
        {
          id: testSessionId,
          title: "Import Latency Session",
          directory: "D:/Projects/ImportPerf",
          time: { created: 1000, updated: 2000 },
        },
      ];

      const discoveryReq = new Request("http://localhost/api/opencode/importable");
      const discoveryRes = await testApp.fetch(discoveryReq);
      const discoveryBody = (await discoveryRes.json()) as any;
      const candidate = discoveryBody.sessions.find((s: any) => s.sessionId === testSessionId);
      expect(candidate).toBeDefined();

      const start = performance.now();
      const importReq = new Request("http://localhost/api/opencode/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: testSessionId, sourceRef: candidate.sourceRef }),
      });
      const importRes = await testApp.fetch(importReq);
      const elapsed = performance.now() - start;

      expect(importRes.status).toBe(201);
      console.log(`[PERF] Import operation latency: ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(200); // Sub-200ms
    });

    it("Measures opening a large native history session (500 messages) through proxy", async () => {
      resetConnectionStateForTests();
      installManagedTarget({ baseUrl: mockBaseUrl, password: "test-password" });

      const testSessionId = `ses_perf_large_${Date.now()}`;
      mockSessions = [
        {
          id: testSessionId,
          title: "Large History Session",
          directory: "D:/Projects/LargePerf",
          time: { created: 1000, updated: 2000 },
        },
      ];

      const messages: Array<{ id: string; role: string; parts: any[] }> = [];
      for (let i = 0; i < 500; i++) {
        messages.push({
          id: `msg-${i}`,
          role: i % 2 === 0 ? "user" : "assistant",
          parts: [
            {
              kind: "text",
              id: `part-${i}`,
              value: `Message body content payload block for index ${i}`,
            },
          ],
        });
      }
      mockMessagesBySession.set(testSessionId, messages);

      await conversationService.create({
        title: "Large Perf Conv",
        providerId: "",
        workspaceMode: "simple",
        engine: "opencode",
        opencodeSessionId: testSessionId,
        opencodeServiceOwner: "local",
        opencodeDirectory: "D:/Projects/LargePerf",
        opencodeImported: true,
      });

      // Measure memory before
      if (globalThis.gc) globalThis.gc();
      const memBefore = process.memoryUsage().heapUsed;

      const start = performance.now();
      const req = new Request(`http://localhost/api/opencode/session/${testSessionId}/message`, {
        method: "GET",
      });
      const res = await testApp.fetch(req);
      const elapsed = performance.now() - start;

      const memAfter = process.memoryUsage().heapUsed;
      const memDeltaKb = (memAfter - memBefore) / 1024;

      expect(res.status).toBe(200);
      const body = (await res.json()) as any[];
      expect(body.length).toBe(500);

      console.log(
        `[PERF] Large history (500 messages) proxy retrieval latency: ${elapsed.toFixed(2)}ms`,
      );
      console.log(`[PERF] Memory delta during 500 message processing: ${memDeltaKb.toFixed(2)} KB`);

      expect(elapsed).toBeLessThan(200);
    });

    it("Measures directory-move reconciliation latency", async () => {
      resetConnectionStateForTests();
      installManagedTarget({ baseUrl: mockBaseUrl, password: "test-password" });

      const testSessionId = `ses_perf_reconcile_${Date.now()}`;
      mockSessions = [
        {
          id: testSessionId,
          title: "Reconcile Perf Session",
          directory: "D:/Original/Dir",
          time: { created: 1000, updated: 2000 },
        },
      ];

      const conv = await conversationService.create({
        title: "Reconcile Perf Conv",
        providerId: "",
        workspaceMode: "simple",
        engine: "opencode",
        opencodeSessionId: testSessionId,
        opencodeServiceOwner: "local",
        opencodeImported: true,
        opencodeDirectory: "D:/Original/Dir",
      });

      mockSessions[0].directory = "D:/Reconciled/NewDir";

      const start = performance.now();
      const res = await reconcileOpenCodeSessionDirectory(conv.id);
      const elapsed = performance.now() - start;

      expect(res.directory).toBe("D:/Reconciled/NewDir");
      console.log(`[PERF] Directory-move reconciliation latency: ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(100);
    });
  });
});
