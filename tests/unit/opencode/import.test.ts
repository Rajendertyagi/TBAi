import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as realOpenCodeClient from "../../../src/services/opencode/client";
import * as realRuntimeTarget from "../../../src/services/opencode/runtimeTarget";
import {
  decodeSourceRef,
  encodeSourceRef,
  importOpenCodeSession,
  listImportableOpenCodeSessions,
} from "../../../src/services/opencode/import";
import {
  OpenCodeError,
  OpenCodeImportStaleSourceError,
  OpenCodeSessionAlreadyImportedError,
  OpenCodeImportSessionEligibilityError,
  OpenCodeImportedSessionMissingError,
} from "../../../src/services/opencode/errors";
import { conversationService } from "../../../src/services/storage/conversations";
import { messageService } from "../../../src/services/storage/messages";

// Test target state
let currentTarget = {
  mode: "managed" as const,
  targetId: 42,
  baseUrl: "http://127.0.0.1:4096",
  transport: (async () => new Response()) as any,
  capabilities: null,
};

let fakeSessions: any[] = [];
let fakeProjects: any[] = [];
let fakeMessages: Map<string, any[]> = new Map();
let fakeBranches: Map<string, string> = new Map();
let vcsGetCalls: string[] = [];
let sessionGetError: any = null;

mock.module("@/services/opencode/runtimeTarget", () => ({
  ...realRuntimeTarget,
  resolveOpenCodeRuntimeTarget: async () => currentTarget,
}));

mock.module("@/services/opencode/client", () => ({
  ...realOpenCodeClient,
  createOpenCodeClient: (_baseUrl: string, opts?: any) => ({
    project: {
      list: async () => fakeProjects,
    },
    vcs: {
      get: async () => {
        const dir = opts?.directory;
        if (dir) vcsGetCalls.push(dir);
        const branchName = dir ? fakeBranches.get(dir) : undefined;
        return {
          data: {
            provider: "git",
            branch: branchName ? { current: branchName, default: "main" } : {},
          },
        };
      },
    },
    message: {
      list: async (opts: any) => {
        const msgs = fakeMessages.get(opts.sessionID) ?? [];
        return { data: msgs };
      },
    },
    session: {
      list: async (opts: any) => {
        const pageSize = opts.limit ?? 50;
        const start = opts.cursor ? Number.parseInt(opts.cursor, 10) : 0;
        const slice = fakeSessions.slice(start, start + pageSize);
        const nextIndex = start + pageSize;
        return {
          data: slice,
          cursor: nextIndex < fakeSessions.length ? { next: String(nextIndex) } : null,
        };
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        if (sessionGetError) {
          throw sessionGetError;
        }
        const found = fakeSessions.find((s) => s.id === sessionID);
        if (!found) {
          throw new OpenCodeError("session_not_found", "Session not found", 404);
        }
        return found;
      },
    },
  }),
}));

describe("OpenCode session import service", () => {
  beforeEach(() => {
    currentTarget = {
      mode: "managed",
      targetId: 42,
      baseUrl: "http://127.0.0.1:4096",
      transport: (async () => new Response()) as any,
      capabilities: null,
    };
    fakeSessions = [];
    fakeProjects = [];
    fakeMessages = new Map();
    fakeBranches = new Map();
    vcsGetCalls = [];
    sessionGetError = null;
  });

  describe("sourceRef serialization & validation", () => {
    it("encodes and decodes valid sourceRef payload", () => {
      const payload = {
        mode: "managed" as const,
        targetId: 101,
        origin: "http://127.0.0.1:4096",
      };
      const encoded = encodeSourceRef(payload);
      expect(typeof encoded).toBe("string");

      const decoded = decodeSourceRef(encoded);
      expect(decoded).toEqual(payload);
    });

    it("returns null for malformed or tampered sourceRef", () => {
      expect(decodeSourceRef("not-base64!")).toBeNull();
      expect(decodeSourceRef(Buffer.from("invalid json", "utf8").toString("base64url"))).toBeNull();
      expect(
        decodeSourceRef(
          Buffer.from(JSON.stringify({ mode: "invalid", origin: "http://x" }), "utf8").toString(
            "base64url",
          ),
        ),
      ).toBeNull();
    });
  });

  describe("listImportableOpenCodeSessions", () => {
    it("excludes archived sessions and already imported sessions, includes child sessions by default", async () => {
      // Create an already-imported conversation in DB
      await conversationService.create({
        title: "Already Imported",
        providerId: null,
        workspaceMode: "simple",
        opencodeSessionId: "ses_already_imported",
        opencodeServiceOwner: "managed",
        opencodeImported: true,
        engine: "opencode",
      });

      fakeSessions = [
        {
          id: "ses_valid_1",
          title: "Session 1",
          location: { directory: "/workspace/proj1" },
          time: { updated: 1000 },
        },
        {
          id: "ses_child",
          title: "Child Session",
          parentID: "ses_valid_1",
          location: { directory: "/workspace/proj1" },
          time: { updated: 1001 },
        },
        {
          id: "ses_archived",
          title: "Archived Session",
          location: { directory: "/workspace/proj1" },
          time: { updated: 1002, archived: 1003 },
        },
        {
          id: "ses_already_imported",
          title: "Already in TBAi",
          location: { directory: "/workspace/proj1" },
          time: { updated: 1004 },
        },
        {
          id: "ses_valid_2",
          title: "Session 2",
          location: { directory: "/workspace/proj2" },
          time: { updated: 1005 },
        },
      ];

      const result = await listImportableOpenCodeSessions();
      expect(result.sessions.length).toBe(3);
      expect(result.sessions.map((s) => s.sessionId)).toEqual([
        "ses_valid_1",
        "ses_child",
        "ses_valid_2",
      ]);
      expect(result.sessions[0].directory).toBe("/workspace/proj1");
      expect(result.sessions[0].sourceRef).toBeDefined();
      expect(result.sessions[1].isChild).toBe(true);
      expect(result.sessions[1].parentID).toBe("ses_valid_1");

      const decoded = decodeSourceRef(result.sessions[0].sourceRef);
      expect(decoded?.origin).toBe("http://127.0.0.1:4096");
    });

    it("excludes child sessions when includeChildren is false", async () => {
      fakeSessions = [
        {
          id: "ses_root",
          title: "Root Session",
          location: { directory: "/workspace/proj1" },
          time: { updated: 1000 },
        },
        {
          id: "ses_child",
          title: "Child Session",
          parentID: "ses_root",
          location: { directory: "/workspace/proj1" },
          time: { updated: 1001 },
        },
      ];

      const result = await listImportableOpenCodeSessions({ includeChildren: false });
      expect(result.sessions.length).toBe(1);
      expect(result.sessions[0].sessionId).toBe("ses_root");
    });

    it("enriches sessions with project metadata and message preview", async () => {
      fakeProjects = [
        {
          id: "proj_alpha",
          name: "Project Alpha",
          canonical: "/workspace/proj1",
          vcs: "feat/phase2",
        },
      ];

      fakeSessions = [
        {
          id: "ses_alpha",
          title: "OK",
          projectID: "proj_alpha",
          location: { directory: "/workspace/proj1" },
          time: { updated: 2000 },
        },
      ];

      fakeMessages.set("ses_alpha", [
        {
          id: "msg_1",
          type: "user",
          text: "Can you implement cursor pagination for the import modal?",
        },
      ]);

      fakeBranches.set("/workspace/proj1", "main");

      const result = await listImportableOpenCodeSessions();
      expect(result.sessions.length).toBe(1);
      const s = result.sessions[0];
      expect(s.projectName).toBe("Project Alpha");
      expect(s.gitBranch).toBe("main");
      expect(s.firstPromptPreview).toBe(
        "Can you implement cursor pagination for the import modal?",
      );
    });

    it("sources gitBranch authoritatively from vcs.get rather than inferring from project.vcs", async () => {
      fakeProjects = [
        {
          id: "proj_meta",
          name: "Meta Project",
          canonical: "/workspace/repo",
          vcs: "stale-metadata-branch", // should NOT be used as the git branch
        },
      ];

      fakeSessions = [
        {
          id: "ses_repo_1",
          title: "Session 1",
          projectID: "proj_meta",
          location: { directory: "/workspace/repo" },
          time: { updated: 3000 },
        },
        {
          id: "ses_repo_2",
          title: "Session 2",
          projectID: "proj_meta",
          location: { directory: "/workspace/repo" },
          time: { updated: 3001 },
        },
        {
          id: "ses_non_git",
          title: "Session Non-Git",
          location: { directory: "/workspace/plain-folder" },
          time: { updated: 3002 },
        },
      ];

      // Authoritative VCS response for /workspace/repo
      fakeBranches.set("/workspace/repo", "feature/authoritative-vcs");
      // /workspace/plain-folder has no git branch

      const result = await listImportableOpenCodeSessions();
      expect(result.sessions.length).toBe(3);

      const s1 = result.sessions.find((s) => s.sessionId === "ses_repo_1")!;
      const s2 = result.sessions.find((s) => s.sessionId === "ses_repo_2")!;
      const sNonGit = result.sessions.find((s) => s.sessionId === "ses_non_git")!;

      // Proves branch is from vcs.get, not project.vcs
      expect(s1.gitBranch).toBe("feature/authoritative-vcs");
      expect(s2.gitBranch).toBe("feature/authoritative-vcs");
      expect(sNonGit.gitBranch).toBeNull();

      // Proves deduplication: /workspace/repo was queried only once despite multiple sessions
      const repoVcsCalls = vcsGetCalls.filter((d) => d === "/workspace/repo");
      expect(repoVcsCalls.length).toBe(1);
    });

    it("supports cursor-based pagination and reports hasMore", async () => {
      fakeSessions = Array.from({ length: 5 }, (_, i) => ({
        id: `ses_page_${i}`,
        title: `Session ${i}`,
        location: { directory: "/workspace" },
        time: { updated: 1000 + i },
      }));

      const page1 = await listImportableOpenCodeSessions({ limit: 2 });
      expect(page1.sessions.length).toBe(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBe("2");

      const page2 = await listImportableOpenCodeSessions({ limit: 2, cursor: page1.nextCursor! });
      expect(page2.sessions.length).toBe(2);
      expect(page2.sessions[0].sessionId).toBe("ses_page_2");
      expect(page2.hasMore).toBe(true);
      expect(page2.nextCursor).toBe("4");
    });
  });

  describe("fixture-backed behavioral proof (external sessions, never opened in TBAi)", () => {
    it("discovers an external OpenCode session created outside TBAi when never opened/started through TBAi, imports it, preserves identity/metadata, and does not duplicate message history", async () => {
      const externalSessionId = "ses_external_fixture_never_in_tbai";
      const externalDir = "/external/project/created-outside-tbai";
      const validRef = encodeSourceRef({
        mode: "managed",
        targetId: 42,
        origin: "http://127.0.0.1:4096",
      });

      // Fixture: session exists in OpenCode (external source), with representative metadata.
      // No TBAi conversation is created for it before discovery/import.
      fakeSessions = [
        {
          id: externalSessionId,
          title: "External Session (never opened in TBAi)",
          agent: "build",
          model: { id: "anthropic/claude-sonnet-4" },
          location: { directory: externalDir },
          time: { created: 1700000000000, updated: 1700000005000 },
        },
      ];
      fakeMessages.set(externalSessionId, [
        { id: "oc_msg_1", type: "user", text: "This history lives in OpenCode, not TBAi." },
        { id: "oc_msg_2", type: "assistant", text: "External reply" },
      ]);

      // (1)(2) Discoverable: external session created outside TBAi, never opened/started through TBAi.
      const discovered = await listImportableOpenCodeSessions();
      const hit = discovered.sessions.find((s) => s.sessionId === externalSessionId);
      expect(hit).toBeDefined();
      expect(hit?.directory).toBe(externalDir);
      expect(hit?.title).toBe("External Session (never opened in TBAi)");
      expect(hit?.sourceRef).toBe(validRef);
      expect(hit?.firstPromptPreview).toBe("This history lives in OpenCode, not TBAi.");

      // (3) Import/open successfully.
      const imported = await importOpenCodeSession({
        sessionId: externalSessionId,
        sourceRef: validRef,
      });
      expect(imported.conversationId).toBeDefined();
      expect(typeof imported.conversationId).toBe("string");

      // (4) Preserves identity/messages/metadata without duplicating history.
      const conv = await conversationService.get(imported.conversationId);
      expect(conv).not.toBeNull();
      expect(conv?.engine).toBe("opencode");
      expect(conv?.opencodeSessionId).toBe(externalSessionId);
      expect(conv?.opencodeServiceOwner).toBe("local");
      expect(conv?.opencodeDirectory).toBe(externalDir);
      expect(conv?.opencodeImported).toBe(true);
      expect(conv?.opencodeAgent).toBe("build");
      expect(conv?.opencodeModel).toBe("anthropic/claude-sonnet-4");
      expect(conv?.title).toBe("External Session (never opened in TBAi)");

      // No message-history copy into TBAi storage: OpenCode remains the history owner.
      const storedMessages = await messageService.listThreadMessages(imported.conversationId);
      expect(storedMessages).toEqual([]);

      // After import, the same external session is no longer offered as importable (already imported).
      const after = await listImportableOpenCodeSessions();
      expect(after.sessions.some((s) => s.sessionId === externalSessionId)).toBe(false);
    });
  });

  describe("importOpenCodeSession", () => {
    it("rejects invalid or stale sourceRef", async () => {
      await expect(
        importOpenCodeSession({ sessionId: "ses_1", sourceRef: "invalid-token" }),
      ).rejects.toThrow(OpenCodeImportStaleSourceError);

      const mismatchedOriginRef = encodeSourceRef({
        mode: "managed",
        targetId: 42,
        origin: "http://other-host:4096",
      });
      await expect(
        importOpenCodeSession({ sessionId: "ses_1", sourceRef: mismatchedOriginRef }),
      ).rejects.toThrow(OpenCodeImportStaleSourceError);

      const mismatchedModeRef = encodeSourceRef({
        mode: "adopted",
        targetId: 42,
        origin: "http://127.0.0.1:4096",
      });
      await expect(
        importOpenCodeSession({ sessionId: "ses_1", sourceRef: mismatchedModeRef }),
      ).rejects.toThrow(OpenCodeImportStaleSourceError);

      const mismatchedTargetIdRef = encodeSourceRef({
        mode: "managed",
        targetId: 999,
        origin: "http://127.0.0.1:4096",
      });
      await expect(
        importOpenCodeSession({ sessionId: "ses_1", sourceRef: mismatchedTargetIdRef }),
      ).rejects.toThrow(OpenCodeImportStaleSourceError);
    });

    it("rejects duplicate import with 409 and existing conversation ID", async () => {
      const existing = await conversationService.create({
        title: "Existing Imported",
        providerId: null,
        workspaceMode: "simple",
        opencodeSessionId: "ses_dup_test",
        opencodeServiceOwner: "managed",
        opencodeImported: true,
        engine: "opencode",
      });

      const validRef = encodeSourceRef({
        mode: "managed",
        targetId: 42,
        origin: "http://127.0.0.1:4096",
      });

      try {
        await importOpenCodeSession({ sessionId: "ses_dup_test", sourceRef: validRef });
        expect.unreachable("Should have thrown OpenCodeSessionAlreadyImportedError");
      } catch (err) {
        expect(err).toBeInstanceOf(OpenCodeSessionAlreadyImportedError);
        expect((err as OpenCodeSessionAlreadyImportedError).conversationId).toBe(existing.id);
      }
    });

    it("allows child sessions to be imported, but rejects archived sessions", async () => {
      const validRef = encodeSourceRef({
        mode: "managed",
        targetId: 42,
        origin: "http://127.0.0.1:4096",
      });

      fakeSessions = [
        {
          id: "ses_child_allowed",
          title: "Subagent Child",
          parentID: "parent_123",
          location: { directory: "/dir" },
        },
        {
          id: "ses_archived_ineligible",
          title: "Archived Session",
          time: { archived: 12345 },
          location: { directory: "/dir" },
        },
      ];

      // Child session import succeeds
      const childImport = await importOpenCodeSession({
        sessionId: "ses_child_allowed",
        sourceRef: validRef,
      });
      expect(childImport.conversationId).toBeDefined();

      // Archived session import fails
      await expect(
        importOpenCodeSession({ sessionId: "ses_archived_ineligible", sourceRef: validRef }),
      ).rejects.toThrow(OpenCodeImportSessionEligibilityError);
    });

    it("throws OpenCodeImportedSessionMissingError when session not found", async () => {
      const validRef = encodeSourceRef({
        mode: "managed",
        targetId: 42,
        origin: "http://127.0.0.1:4096",
      });

      fakeSessions = [];

      await expect(
        importOpenCodeSession({ sessionId: "ses_nonexistent", sourceRef: validRef }),
      ).rejects.toThrow(OpenCodeImportedSessionMissingError);
    });

    it("successfully imports an eligible OpenCode session with live history attachment", async () => {
      const validRef = encodeSourceRef({
        mode: "managed",
        targetId: 42,
        origin: "http://127.0.0.1:4096",
      });

      fakeSessions = [
        {
          id: "ses_import_success",
          title: "Live External Session",
          agent: "build",
          model: { id: "anthropic/claude-3-7-sonnet" },
          location: { directory: "/remote/project/repo" },
          time: { created: 100, updated: 200 },
        },
      ];

      const result = await importOpenCodeSession({
        sessionId: "ses_import_success",
        sourceRef: validRef,
      });

      expect(result.conversationId).toBeDefined();

      const conv = await conversationService.get(result.conversationId);
      expect(conv).not.toBeNull();
      expect(conv?.title).toBe("Live External Session");
      expect(conv?.engine).toBe("opencode");
      expect(conv?.opencodeSessionId).toBe("ses_import_success");
      expect(conv?.opencodeServiceOwner).toBe("local");
      expect(conv?.opencodeDirectory).toBe("/remote/project/repo");
      expect(conv?.opencodeImported).toBe(true);
      expect(conv?.opencodeAgent).toBe("build");
      expect(conv?.opencodeModel).toBe("anthropic/claude-3-7-sonnet");
    });
  });

  describe("route precedence and registration before proxy catch-all", () => {
    it("GET /api/opencode/importable is handled by the route, returning paginated sessions", async () => {
      const { default: app } = await import("@/routes");
      fakeSessions = [
        {
          id: "ses_route_check",
          title: "Route Precedence Check",
          location: { directory: "/tmp/precedence" },
          time: { updated: 500 },
        },
      ];

      const res = await app.request("http://localhost/api/opencode/importable");
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(Array.isArray(data.sessions)).toBe(true);
      expect(data.sessions.some((s: any) => s.sessionId === "ses_route_check")).toBe(true);
      expect(data.hasMore).toBeDefined();
    });

    it("POST /api/opencode/import rejects invalid body with 400 from route handler", async () => {
      const { default: app } = await import("@/routes");
      const res = await app.request("http://localhost/api/opencode/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toContain("sessionId and sourceRef are required");
    });

    it("route-level: discovers external fixture session and imports via HTTP with identity/metadata and no duplicated history", async () => {
      const { default: app } = await import("@/routes");
      const externalSessionId = "ses_route_external_fixture";
      const externalDir = "/external/route-fixture";
      fakeSessions = [
        {
          id: externalSessionId,
          title: "Route External Fixture",
          agent: "build",
          model: { id: "anthropic/claude-sonnet-4" },
          location: { directory: externalDir },
          time: { created: 1700000000000, updated: 1700000005000 },
        },
      ];
      fakeMessages.set(externalSessionId, [
        { id: "oc_msg_route_1", type: "user", text: "External history stays in OpenCode." },
      ]);

      const listRes = await app.request("http://localhost/api/opencode/importable");
      expect(listRes.status).toBe(200);
      const listData = (await listRes.json()) as any;
      const hit = listData.sessions.find((s: any) => s.sessionId === externalSessionId);
      expect(hit).toBeDefined();
      expect(hit.directory).toBe(externalDir);
      expect(hit.sourceRef).toBeDefined();

      const importRes = await app.request("http://localhost/api/opencode/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: externalSessionId, sourceRef: hit.sourceRef }),
      });
      expect(importRes.status).toBe(201);
      const importData = (await importRes.json()) as any;
      expect(importData.conversationId).toBeDefined();

      const conv = await conversationService.get(importData.conversationId);
      expect(conv?.engine).toBe("opencode");
      expect(conv?.opencodeSessionId).toBe(externalSessionId);
      expect(conv?.opencodeDirectory).toBe(externalDir);
      expect(conv?.opencodeImported).toBe(true);
      expect(conv?.opencodeAgent).toBe("build");
      expect(conv?.opencodeModel).toBe("anthropic/claude-sonnet-4");
      expect(conv?.title).toBe("Route External Fixture");

      const storedMessages = await messageService.listThreadMessages(importData.conversationId);
      expect(storedMessages).toEqual([]);
    });
  });
});
