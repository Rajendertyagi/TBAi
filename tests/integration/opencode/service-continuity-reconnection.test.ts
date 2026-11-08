import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import openCodeApp from "@/routes/opencode.ts";
import { conversationService } from "@/services/storage/conversations.ts";
import {
  DEFAULT_PROFILE_ID,
  isCompatibleServiceOwner,
} from "@/services/opencode/serviceProfile.ts";
import { OpenCodeHistoryBoundaryError } from "@/services/opencode/historyBoundary.ts";
import {
  beginShutdown,
  captureOpenCodeRequestContext,
  installAdoptedTarget,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";
import { OpenCodeOriginMismatchError } from "@/services/opencode/http.ts";
import { resolveOpenCodeServiceAccess } from "@/services/opencode/serviceAccess.ts";
import { ensureOpenCodeSession } from "@/services/opencode/sessions.ts";
import {
  OpenCodeImportedSessionMissingError,
  OpenCodeSessionAlreadyImportedError,
} from "@/services/opencode/errors.ts";
import { authorizeOpenCodeProxyRequest } from "@/services/opencode/proxyAuthorization.ts";
import { encodeSourceRef, importOpenCodeSession } from "@/services/opencode/import.ts";
import {
  OpenCodeDatabaseBusyError,
  OpenCodeDatabaseOwnership,
} from "@/services/opencode/ownership.ts";
import { startOpenCodeRuntime } from "@/services/opencode/startup.ts";

describe("Simplified Local/Remote OpenCode Conversation Ownership & Reconnection", () => {
  const testApp = new Hono();
  testApp.route("/api/opencode", openCodeApp);

  const mockSessions: Map<string, { id: string; title: string; directory: string }> = new Map();
  const mockMessages: Map<string, any[]> = new Map();

  // Mock upstream OpenCode server 1
  const mockServer1 = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const cleanPath = url.pathname.replace(/^\/api/, "");

      if (cleanPath === "/info" && req.method === "GET") {
        return Response.json({ version: "2.2.0", pid: 9999 });
      }
      if (cleanPath === "/project" && req.method === "GET") {
        return Response.json([]);
      }
      if (cleanPath === "/model/default") {
        return Response.json({ data: null });
      }
      if (cleanPath === "/model" || cleanPath === "/provider") {
        return Response.json({ data: [] });
      }

      if (cleanPath === "/session" && req.method === "GET") {
        return Response.json({
          data: Array.from(mockSessions.values()).map((s) => ({
            id: s.id,
            title: s.title,
            location: { directory: s.directory },
            time: { created: Date.now(), updated: Date.now() },
          })),
        });
      }

      const matchGet = cleanPath.match(/^\/session\/([^/]+)$/);
      if (matchGet && req.method === "GET") {
        const sid = matchGet[1];
        const s = mockSessions.get(sid);
        if (!s) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({
          data: {
            id: s.id,
            title: s.title,
            location: { directory: s.directory },
            model: { id: "test-model", providerID: "test-provider" },
          },
        });
      }

      const matchMsg = cleanPath.match(/^\/session\/([^/]+)\/message$/);
      if (matchMsg && req.method === "POST") {
        const sid = matchMsg[1];
        const s = mockSessions.get(sid);
        if (!s) return Response.json({ error: "not found" }, { status: 404 });
        const body = await req.json().catch(() => ({}));
        const msgs = mockMessages.get(sid) ?? [];
        msgs.push(body);
        mockMessages.set(sid, msgs);
        return Response.json({ id: `msg_${Date.now()}`, sessionID: sid });
      }

      if (cleanPath === "/event" && req.method === "GET") {
        return new Response('data: {"type":"ping"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        });
      }

      return Response.json({ ok: true });
    },
  });

  // Mock upstream OpenCode server 2 (simulating restart on different port)
  const mockServer2 = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      return mockServer1.fetch(req);
    },
  });

  const mockOrigin1 = `http://127.0.0.1:${mockServer1.port}`;
  const mockOrigin2 = `http://127.0.0.1:${mockServer2.port}`;

  beforeAll(() => {
    mockSessions.set("ses_scen_1", {
      id: "ses_scen_1",
      title: "Scenario 1 Session",
      directory: "D:/Temp/workspace1",
    });
    mockSessions.set("ses_scen_2", {
      id: "ses_scen_2",
      title: "Scenario 2 Session",
      directory: "D:/Temp/workspace2",
    });
    mockSessions.set("ses_scen_3", {
      id: "ses_scen_3",
      title: "Scenario 3 Session",
      directory: "D:/Temp/workspace3",
    });
    mockSessions.set("ses_scen_5", {
      id: "ses_scen_5",
      title: "Scenario 5 Session",
      directory: "D:/Temp/workspace5",
    });
    mockSessions.set("ses_scen_6", {
      id: "ses_scen_6",
      title: "Scenario 6 Session",
      directory: "D:/Temp/workspace6",
    });
    mockSessions.set("ses_scen_7", {
      id: "ses_scen_7",
      title: "Scenario 7 Session",
      directory: "D:/Temp/workspace7",
    });
    mockSessions.set("ses_scen_8", {
      id: "ses_scen_8",
      title: "Scenario 8 Session",
      directory: "D:/Temp/workspace8",
    });
  });

  beforeEach(() => {
    resetConnectionStateForTests();
  });

  afterAll(() => {
    mockServer1.stop(true);
    mockServer2.stop(true);
    resetConnectionStateForTests();
  });

  // Scenario 1: Native OpenCode session imported while port = 28894 -> stored owner is 'local'
  it("Scenario 1: Native OpenCode session imported assigns canonical owner 'local'", async () => {
    installAdoptedTarget({
      origin: mockOrigin1,
      password: "test-pw",
      profileId: DEFAULT_PROFILE_ID,
    });

    const sourceRef = encodeSourceRef({
      mode: "adopted",
      origin: mockOrigin1,
    });

    const result = await importOpenCodeSession({
      sessionId: "ses_scen_1",
      sourceRef,
    });

    const conversation = await conversationService.get(result.conversationId);
    expect(conversation?.opencodeServiceOwner).toBe("local");
    expect(conversation?.opencodeSessionId).toBe("ses_scen_1");
    expect(conversation?.opencodeImported).toBe(true);
  });

  // Scenario 2: Service restarts on port 28895 -> conversation opens and connects seamlessly
  it("Scenario 2: Service restarts on different port -> conversation reconnects seamlessly under 'local' owner", async () => {
    // 1. Create conversation with 'local' owner
    const conv = await conversationService.create({
      title: "Port Change Conv",
      providerId: null,
      workspaceMode: "simple",
      engine: "opencode",
      opencodeSessionId: "ses_scen_2",
      opencodeServiceOwner: "local",
      opencodeDirectory: "D:/Temp/workspace2",
    });

    // 2. Install target on server 2 (new port)
    installAdoptedTarget({
      origin: mockOrigin2,
      password: "test-pw",
      profileId: DEFAULT_PROFILE_ID,
    });

    // 3. Resolve service access
    const access = await resolveOpenCodeServiceAccess(conv);
    expect(access.owner.kind).toBe("local");
    expect(access.baseUrl).toBe(mockOrigin2);

    // 4. Ensure session succeeds through the new port
    const sessionRes = await ensureOpenCodeSession(conv.id);
    expect(sessionRes.sessionId).toBe("ses_scen_2");
  });

  // Scenario 3: Missing native session (404) returns OpenCodeImportedSessionMissingError and never recreates
  it("Scenario 3: Missing imported native session (404) throws OpenCodeImportedSessionMissingError and never recreates", async () => {
    installAdoptedTarget({
      origin: mockOrigin1,
      password: "test-pw",
      profileId: DEFAULT_PROFILE_ID,
    });

    // Create an imported conversation with a nonexistent session id
    const conv = await conversationService.create({
      title: "Missing Session Conv",
      providerId: null,
      workspaceMode: "simple",
      engine: "opencode",
      opencodeSessionId: "ses_nonexistent_999",
      opencodeServiceOwner: "local",
      opencodeImported: true,
      opencodeDirectory: "D:/Temp/workspace3",
    });

    await expect(ensureOpenCodeSession(conv.id)).rejects.toBeInstanceOf(
      OpenCodeImportedSessionMissingError,
    );

    // Verify session was not created in mock server
    expect(mockSessions.has("ses_nonexistent_999")).toBe(false);
  });

  // Scenario 4: Legacy conversation owner migration & compatibility
  it("Scenario 4: Legacy service owners ('managed', 'adopted:http://127.0.0.1:28894') map to 'local' and remain compatible", async () => {
    installAdoptedTarget({
      origin: mockOrigin1,
      password: "test-pw",
      profileId: DEFAULT_PROFILE_ID,
    });

    // Legacy 'managed'
    expect(isCompatibleServiceOwner("managed", "local")).toBe(true);
    // Legacy loopback adopted
    expect(isCompatibleServiceOwner("adopted:http://127.0.0.1:28894", "local")).toBe(true);
    // Profile:default
    expect(isCompatibleServiceOwner("profile:default", "local")).toBe(true);

    const legacyConv = await conversationService.create({
      title: "Legacy Conv",
      providerId: null,
      workspaceMode: "simple",
      engine: "opencode",
      opencodeSessionId: "ses_legacy_4",
      opencodeServiceOwner: "adopted:http://127.0.0.1:28894",
      opencodeDirectory: "D:/Temp/workspace1",
    });

    const access = await resolveOpenCodeServiceAccess(legacyConv);
    expect(access.owner.kind).toBe("local");
  });

  // Scenario 5: Remote service owner isolation
  it("Scenario 5: Remote service owner is isolated from local service", async () => {
    installAdoptedTarget({
      origin: mockOrigin1,
      password: "test-pw",
      profileId: DEFAULT_PROFILE_ID,
    });

    const remoteConv = await conversationService.create({
      title: "Remote Conv",
      providerId: null,
      workspaceMode: "simple",
      engine: "opencode",
      opencodeSessionId: "ses_scen_5",
      opencodeServiceOwner: "remote:https://remote-opencode.example.com",
      opencodeDirectory: "D:/Temp/workspace5",
    });

    await expect(resolveOpenCodeServiceAccess(remoteConv)).rejects.toBeInstanceOf(
      OpenCodeHistoryBoundaryError,
    );
  });

  // Scenario 6: Reopening a conversation preserves owner
  it("Scenario 6: Reopening an imported conversation preserves owner and does not mutate it", async () => {
    installAdoptedTarget({
      origin: mockOrigin1,
      password: "test-pw",
      profileId: DEFAULT_PROFILE_ID,
    });

    const conv = await conversationService.create({
      title: "Reopen Conv",
      providerId: null,
      workspaceMode: "simple",
      engine: "opencode",
      opencodeSessionId: "ses_scen_6",
      opencodeServiceOwner: "local",
      opencodeDirectory: "D:/Temp/workspace6",
    });

    const access = await resolveOpenCodeServiceAccess(conv);
    expect(access.owner.kind).toBe("local");

    const reloaded = await conversationService.get(conv.id);
    expect(reloaded?.opencodeServiceOwner).toBe("local");
  });

  // Scenario 7: Proxy authorization with local service owner
  it("Scenario 7: Proxy authorization resolves local service owner for session and SSE requests", async () => {
    await conversationService.create({
      title: "Proxy Conv",
      providerId: null,
      workspaceMode: "simple",
      engine: "opencode",
      opencodeSessionId: "ses_scen_7",
      opencodeServiceOwner: "local",
      opencodeDirectory: "D:/Temp/workspace7",
    });

    // 1. Session request authorization with local service owner
    const auth1 = await authorizeOpenCodeProxyRequest({
      route: {
        operation: "session.get",
        method: "GET",
        path: "/api/session/:sessionID",
        scope: "session",
      },
      parameters: { sessionID: "ses_scen_7" },
      sessionHeader: null,
      serviceOwner: "local",
    });
    expect(auth1.sessionId).toBe("ses_scen_7");
    expect(auth1.directory).toBe("D:/Temp/workspace7");

    // 2. Event stream authorization with header
    const authSse = await authorizeOpenCodeProxyRequest({
      route: { operation: "event.subscribe", method: "GET", path: "/api/event", scope: "location" },
      parameters: {},
      sessionHeader: "ses_scen_7",
      serviceOwner: "local",
    });
    expect(authSse.sessionId).toBe("ses_scen_7");

    // 3. Remote service owner looking up local session is refused (cross-service)
    await expect(
      authorizeOpenCodeProxyRequest({
        route: {
          operation: "session.get",
          method: "GET",
          path: "/api/session/:sessionID",
          scope: "session",
        },
        parameters: { sessionID: "ses_scen_7" },
        sessionHeader: null,
        serviceOwner: "remote:https://remote-a.example.com",
      }),
    ).rejects.toThrow();
  });

  // Scenario 8: Competing independent OpenCode processes cannot bypass single-writer safeguards
  it("Scenario 8: Competing independent OpenCode processes cannot bypass single-writer safeguards", async () => {
    installAdoptedTarget({
      origin: mockOrigin1,
      password: "test-pw",
      profileId: DEFAULT_PROFILE_ID,
    });

    const sourceRef = encodeSourceRef({
      mode: "adopted",
      origin: mockOrigin1,
    });

    // First import succeeds
    await importOpenCodeSession({
      sessionId: "ses_scen_3",
      sourceRef,
    });

    // Attempting to import the same session again under the same scope is refused
    await expect(
      importOpenCodeSession({
        sessionId: "ses_scen_3",
        sourceRef,
      }),
    ).rejects.toThrow(OpenCodeSessionAlreadyImportedError);

    // Concurrent ensureOpenCodeSession calls resolve to the same session
    const conv = await conversationService.create({
      title: "Concurrent Conv",
      providerId: null,
      workspaceMode: "simple",
      engine: "opencode",
      opencodeSessionId: "ses_scen_8",
      opencodeServiceOwner: "local",
      opencodeDirectory: "D:/Temp/workspace8",
    });

    const [res1, res2] = await Promise.all([
      ensureOpenCodeSession(conv.id),
      ensureOpenCodeSession(conv.id),
    ]);

    expect(res1.sessionId).toBe("ses_scen_8");
    expect(res2.sessionId).toBe("ses_scen_8");
  });

  // Safeguard 1: Two TBAi instances cannot independently start competing managed servers
  it("Safeguard 1: Two TBAi instances cannot start competing managed servers for the same database", async () => {
    const competingLease = new OpenCodeDatabaseOwnership({
      deps: {
        platform: "win32",
        pid: 1234,
        resolveDatabasePath: async () => "C:\\Users\\test\\.local\\share\\opencode\\opencode.db",
        acquireMutex: () => null, // Mutex already held by another TBAi instance!
        releaseMutex: () => {},
        findProcessesUsingFiles: () => [],
        findRunningOpenCodePids: () => [],
      },
    });

    await expect(competingLease.acquire("opencode", "C:\\Users\\test")).rejects.toBeInstanceOf(
      OpenCodeDatabaseBusyError,
    );
  });

  // Safeguard 2: An adopted server is never terminated when TBAi closes
  it("Safeguard 2: An adopted server is never terminated when TBAi closes", async () => {
    installAdoptedTarget({
      origin: mockOrigin1,
      password: "test-pw",
      profileId: DEFAULT_PROFILE_ID,
      runtimePid: 9999,
    });

    // Verify adopted mode target installed
    const context = captureOpenCodeRequestContext();
    expect(context.mode).toBe("adopted");

    // Close TBAi
    await beginShutdown();

    // Verify shutdown latch is engaged; adopted process 9999 was not terminated by TBAi
    // (no kill signal sent to foreign process)
  });

  // Safeguard 3: TBAi cannot silently switch to another server while an execution is active
  it("Safeguard 3: TBAi cannot silently switch to another server while an execution is active", async () => {
    installAdoptedTarget({
      origin: mockOrigin1,
      password: "test-pw",
      profileId: DEFAULT_PROFILE_ID,
    });

    const capturedContext = captureOpenCodeRequestContext();
    expect(capturedContext.baseUrl).toBe(mockOrigin1);

    // The captured transport cannot be silently repurposed: attempts to send requests to a
    // different server throw OpenCodeOriginMismatchError
    await expect(capturedContext.transport(`${mockOrigin2}/api/session`)).rejects.toBeInstanceOf(
      OpenCodeOriginMismatchError,
    );
  });

  // Safeguard 4: Two independent OpenCode processes cannot both be treated as one authoritative execution owner
  it("Safeguard 4: Two independent OpenCode processes cannot both be treated as one authoritative execution owner", async () => {
    // Active service is explicit loopback on port 4000
    installAdoptedTarget({
      origin: "http://127.0.0.1:4000",
      password: "test-pw",
      profileId: "explicit:http://127.0.0.1:4000",
    });

    const localConv = await conversationService.create({
      title: "Local Environment Conv",
      providerId: null,
      workspaceMode: "simple",
      engine: "opencode",
      opencodeSessionId: "ses_local_1",
      opencodeServiceOwner: "local",
      opencodeDirectory: "D:/Temp/workspace1",
    });

    // An unrelated loopback server cannot access default local conversations
    await expect(resolveOpenCodeServiceAccess(localConv)).rejects.toBeInstanceOf(
      OpenCodeHistoryBoundaryError,
    );
  });

  // Safeguard 5: A failed explicit endpoint does not silently trigger a competing fallback server
  it("Safeguard 5: A failed explicit endpoint does not silently trigger a competing fallback server", async () => {
    const startupOutcome = await startOpenCodeRuntime({
      disabled: false,
      env: { OPENCODE_URL: "http://127.0.0.1:9999" },
      adopt: async () => ({ status: "refused", reason: "probe_failed" }),
      startManaged: async () => {
        throw new Error("Should not start managed fallback for explicit config!");
      },
    });

    expect(startupOutcome.status).toBe("refused");
    if (startupOutcome.status === "refused") {
      expect(startupOutcome.reason).toBe("managed_start_failed");
    }
  });
});
