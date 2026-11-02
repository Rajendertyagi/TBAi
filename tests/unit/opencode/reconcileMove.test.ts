import { describe, it, expect, mock, beforeEach } from "bun:test";
import {
  ensureOpenCodeSession,
  reconcileOpenCodeSessionDirectory,
} from "../../../src/services/opencode/sessions";
import { OpenCodeImportedSessionMissingError } from "../../../src/services/opencode/errors";

let conversationRow: Record<string, any> | null = null;
let updatedPatches: Array<{ id: string; patch: Record<string, any> }> = [];
let sessionGetResult: any = null;
let sessionCreateCalls: any[] = [];
let resolveWorkspaceCalled = false;

mock.module("@/services/storage", () => ({
  conversationService: {
    get: async (id: string) => {
      if (conversationRow && conversationRow.id === id) return conversationRow;
      return null;
    },
    update: async (id: string, patch: Record<string, any>) => {
      updatedPatches.push({ id, patch });
      if (conversationRow && conversationRow.id === id) {
        conversationRow = { ...conversationRow, ...patch };
      }
    },
  },
}));

mock.module("@/services/workspace", () => ({
  resolveConversationWorkspace: async (_id: string) => {
    resolveWorkspaceCalled = true;
    return { dir: "D:\\local\\hidden\\chat\\workspace" };
  },
}));

mock.module("@/services/opencode/serviceAccess", () => ({
  resolveOpenCodeServiceAccess: async () => ({
    baseUrl: "http://127.0.0.1:4096",
    owner: { kind: "managed" },
    transport: "http",
  }),
}));

mock.module("@/services/opencode/historyBoundary", () => ({
  serializeHistoryOwner: () => "managed",
}));

mock.module("@/services/opencode/capabilities", () => ({
  resolveOpenCodeModelRef: async () => null,
}));

mock.module("@/services/opencode/sessionModel", () => ({
  fetchServerDefaultModel: async () => null,
  pickSessionModel: () => null,
  resolveStoredModel: async () => null,
}));

mock.module("@/services/opencode/client", () => ({
  createOpenCodeClient: (_baseUrl: string, _opts: any) => ({
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (!sessionGetResult) {
          throw {
            _tag: "SessionNotFoundError",
            sessionID,
            message: `Session not found: ${sessionID}`,
          };
        }
        return sessionGetResult;
      },
      create: async (params: any) => {
        sessionCreateCalls.push(params);
        return {
          id: params.id || "ses_created_123",
          location: params.location,
        };
      },
      switchModel: async () => {},
    },
  }),
  lastStatusForSessionLookup: () => (sessionGetResult ? 200 : 404),
}));

describe("Stage 4 - Directory Move Reconciliation & Missing Session Protection", () => {
  beforeEach(() => {
    conversationRow = null;
    updatedPatches = [];
    sessionGetResult = null;
    sessionCreateCalls = [];
    resolveWorkspaceCalled = false;
  });

  it("reconciles directory on reopen when imported session moved while TBAi was closed", async () => {
    const OLD_DIR = "/remote/workspaces/project-alpha";
    const NEW_DIR = "/remote/workspaces/project-alpha-moved";
    const SESSION_ID = "ses_imported_move_001";

    conversationRow = {
      id: "conv-move-1",
      engine: "opencode",
      opencodeSessionId: SESSION_ID,
      opencodeDirectory: OLD_DIR,
      opencodeImported: true,
      opencodeServiceOwner: "managed",
    };

    sessionGetResult = {
      id: SESSION_ID,
      location: { directory: NEW_DIR },
      time: { created: 1000, updated: 2000 },
    };

    const binding = await ensureOpenCodeSession("conv-move-1");

    // Must return the new directory
    expect(binding.sessionId).toBe(SESSION_ID);
    expect(binding.directory).toBe(NEW_DIR);
    expect(binding.reusedExistingSession).toBe(true);

    // SQLite must be updated with the authoritative directory from OpenCode
    expect(updatedPatches).toHaveLength(1);
    expect(updatedPatches[0]).toEqual({
      id: "conv-move-1",
      patch: { opencodeDirectory: NEW_DIR },
    });
    expect(conversationRow.opencodeDirectory).toBe(NEW_DIR);

    // No session was created
    expect(sessionCreateCalls).toHaveLength(0);
    // Did NOT fall back to local workspace resolution
    expect(resolveWorkspaceCalled).toBe(false);
  });

  it("preserves conversation ID and OpenCode session ID after move", async () => {
    const SESSION_ID = "ses_imported_continuity_002";
    conversationRow = {
      id: "conv-continuity-1",
      engine: "opencode",
      opencodeSessionId: SESSION_ID,
      opencodeDirectory: "/path/initial",
      opencodeImported: true,
      opencodeServiceOwner: "managed",
    };

    sessionGetResult = {
      id: SESSION_ID,
      location: { directory: "/path/moved" },
      time: { created: 1000, updated: 2000 },
    };

    const binding = await ensureOpenCodeSession("conv-continuity-1");

    expect(binding.sessionId).toBe(SESSION_ID);
    expect(conversationRow.id).toBe("conv-continuity-1");
    expect(conversationRow.opencodeSessionId).toBe(SESSION_ID);
  });

  it("raises OpenCodeImportedSessionMissingError and never creates session when imported session is 404", async () => {
    const SESSION_ID = "ses_imported_missing_003";
    conversationRow = {
      id: "conv-missing-1",
      engine: "opencode",
      opencodeSessionId: SESSION_ID,
      opencodeDirectory: "/remote/dir",
      opencodeImported: true,
      opencodeServiceOwner: "managed",
    };

    // sessionGetResult is null -> 404
    sessionGetResult = null;

    await expect(ensureOpenCodeSession("conv-missing-1")).rejects.toThrow(
      OpenCodeImportedSessionMissingError,
    );

    // Must NOT call session.create()
    expect(sessionCreateCalls).toHaveLength(0);
    // Must NOT delete or overwrite the persisted pointer
    expect(conversationRow.opencodeSessionId).toBe(SESSION_ID);
    expect(updatedPatches).toHaveLength(0);
  });

  it("preserves session recreation behavior on 404 for ordinary TBAi-created conversations", async () => {
    const STALE_SESSION_ID = "ses_native_stale_004";
    conversationRow = {
      id: "conv-native-1",
      engine: "opencode",
      opencodeSessionId: STALE_SESSION_ID,
      opencodeDirectory: null,
      opencodeImported: false,
      opencodeServiceOwner: "managed",
    };

    // Stale session returns 404
    sessionGetResult = null;

    const binding = await ensureOpenCodeSession("conv-native-1");

    // A new session is created for ordinary native conversation
    expect(sessionCreateCalls).toHaveLength(1);
    expect(binding.reusedExistingSession).toBe(false);
    expect(binding.sessionId).not.toBe(STALE_SESSION_ID);
    expect(resolveWorkspaceCalled).toBe(true);
  });

  it("preserves adopted non-local directory formats as opaque strings", async () => {
    const NON_LOCAL_PATH = "/var/remote/mount/subpath/app";
    const SESSION_ID = "ses_adopted_opaque_005";

    conversationRow = {
      id: "conv-adopted-1",
      engine: "opencode",
      opencodeSessionId: SESSION_ID,
      opencodeDirectory: NON_LOCAL_PATH,
      opencodeImported: true,
      opencodeServiceOwner: "adopted:http://192.168.1.50:51234",
    };

    sessionGetResult = {
      id: SESSION_ID,
      location: { directory: NON_LOCAL_PATH },
      time: { created: 1000, updated: 2000 },
    };

    const binding = await ensureOpenCodeSession("conv-adopted-1");

    expect(binding.directory).toBe(NON_LOCAL_PATH);
    // Did NOT touch filesystem or resolve hidden chat workspace
    expect(resolveWorkspaceCalled).toBe(false);
    expect(updatedPatches).toHaveLength(0);
  });

  it("reconcileOpenCodeSessionDirectory updates SQLite matching authoritative metadata", async () => {
    const OLD_DIR = "/opt/project/v1";
    const NEW_DIR = "/opt/project/v2";
    const SESSION_ID = "ses_reconcile_006";

    conversationRow = {
      id: "conv-reconcile-1",
      engine: "opencode",
      opencodeSessionId: SESSION_ID,
      opencodeDirectory: OLD_DIR,
      opencodeImported: true,
      opencodeServiceOwner: "managed",
    };

    sessionGetResult = {
      id: SESSION_ID,
      location: { directory: NEW_DIR },
      time: { created: 1000, updated: 3000 },
    };

    const result = await reconcileOpenCodeSessionDirectory("conv-reconcile-1");

    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.directory).toBe(NEW_DIR);
    expect(updatedPatches).toHaveLength(1);
    expect(updatedPatches[0].patch.opencodeDirectory).toBe(NEW_DIR);
  });

  it("reconcileOpenCodeSessionDirectory skips DB write when directory is unchanged", async () => {
    const CURRENT_DIR = "/opt/project/same";
    const SESSION_ID = "ses_reconcile_same_007";

    conversationRow = {
      id: "conv-reconcile-same",
      engine: "opencode",
      opencodeSessionId: SESSION_ID,
      opencodeDirectory: CURRENT_DIR,
      opencodeImported: true,
      opencodeServiceOwner: "managed",
    };

    sessionGetResult = {
      id: SESSION_ID,
      location: { directory: CURRENT_DIR },
      time: { created: 1000, updated: 3000 },
    };

    const result = await reconcileOpenCodeSessionDirectory("conv-reconcile-same");

    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.directory).toBe(CURRENT_DIR);
    expect(updatedPatches).toHaveLength(0);
  });

  it("reconcileOpenCodeSessionDirectory raises OpenCodeImportedSessionMissingError for missing imported session", async () => {
    conversationRow = {
      id: "conv-reconcile-missing",
      engine: "opencode",
      opencodeSessionId: "ses_missing_999",
      opencodeDirectory: "/opt/project",
      opencodeImported: true,
      opencodeServiceOwner: "managed",
    };

    sessionGetResult = null;

    await expect(reconcileOpenCodeSessionDirectory("conv-reconcile-missing")).rejects.toThrow(
      OpenCodeImportedSessionMissingError,
    );
  });
});
