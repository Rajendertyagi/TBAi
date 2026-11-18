import { describe, it, expect, mock, beforeEach } from "bun:test";
import * as realOpenCodeClient from "@/services/opencode/client.ts";

/**
 * Wave 1 concurrency probe (expected RED pre-fix, must pass after fix).
 *
 * Two concurrent `ensureOpenCodeSession` calls for the same OpenCode
 * conversation with no stored session must result in exactly ONE
 * `session.create` and both callers receiving the same sessionId.
 *
 * Today there is no in-flight dedup: both calls race past the
 * `opencodeSessionId` check, each creates its own session, and the second
 * `conversationService.update` silently overwrites the first
 * (last-writer-wins) — so `create` is called TWICE and the ids differ. That
 * failure is expected and wanted: it pins the race the fix must close.
 *
 * Isolation: `sessions.ts` reaches the outside world through `../storage`
 * (conversation row), `../storage/opencodeSessionOrphans` (the RT-001
 * create-intent journal), `./client` (the official V2 client),
 * `openCodeServerManager.ensureBaseUrl` (process ownership) and
 * `../workspace` (workspace dir resolution). All five are stubbed — no
 * process is spawned, no database is opened, no network I/O happens — so the
 * `create` is given an artificial delay to force the real race window open.
 * Specifiers mirror `sessions.test.ts` (`../storage`, `./client`); the
 * workspace stub exists because, unlike the resume-path tests there, this
 * no-pointer path always reaches `resolveConversationWorkspace`.
 *
 * The `./client` mock is a PARTIAL mock (spread over the real module) on
 * purpose. `sessions.ts` also imports `lastStatusForSessionLookup` from that
 * same module, so a factory that listed only `createOpenCodeClient` left the
 * namespace incomplete and the import failed to link. It used to pass only
 * because another file had already mocked `./client` more fully into the shared
 * module registry; `bun test --isolate` gives every file its own registry, so
 * this file now has to stand on its own. Spreading the real module keeps every
 * un-stubbed export genuinely real instead of silently absent.
 */

let createCalls = 0;
let conversation: Record<string, unknown> | null = null;
let updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
let createEntered = 0;
let releaseCreate: (() => void) | null = null;
let createBarrier: Promise<void> | null = null;
let lastCreatePermissions:
  | ReadonlyArray<{ action: string; resource: string; effect: string }>
  | undefined;
// Barrier at model.default (after params.permissions snapshot, before create).
let modelDefaultEntered = 0;
let releaseModelDefault: (() => void) | null = null;
let modelDefaultBarrier: Promise<void> | null = null;

mock.module("@/services/storage", () => ({
  conversationService: {
    get: async () => conversation,
    update: async (id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
      // Emulate the real store: the write lands, so a later reader would see
      // the last writer's pointer (the last-writer-wins half of the bug).
      if (conversation) conversation = { ...conversation, ...patch };
    },
  },
}));

mock.module("@/services/storage/opencodeSessionOrphans", () => ({
  opencodeOrphanService: {
    recordCreateIntent: async () => true,
    deleteCreateIntent: async () => true,
    recordOrphanedSession: async () => true,
  },
}));

mock.module("@/services/opencode/client", () => ({
  ...realOpenCodeClient,
  createOpenCodeClient: () => ({
    session: {
      get: async () => {
        throw new Error("not reached: no stored session in this probe");
      },
      create: async (args: { id: string; permissions?: typeof lastCreatePermissions }) => {
        createCalls += 1;
        createEntered += 1;
        lastCreatePermissions = args.permissions;
        // Deterministic barrier: hold until the test releases it, so both
        // callers overlap inside `create` regardless of timing.
        if (createBarrier) await createBarrier;
        // The real server echoes the caller-supplied id (RT-001).
        return { id: args.id };
      },
    },
    // Reached by `fetchServerDefaultModel` for a session created with no model.
    // Empty catalogue = the server advertises no default, so the session stays
    // unbound and this file keeps asserting only what it is about: the create
    // dedup. Not recorded in the create counter, which must stay exact.
    agent: { list: async () => ({ data: [] }) },
    model: {
      list: async () => ({ data: [] }),
      default: async () => {
        modelDefaultEntered += 1;
        if (modelDefaultBarrier) await modelDefaultBarrier;
        return { data: null };
      },
    },
  }),
}));

mock.module("@/services/workspace", () => ({
  resolveConversationWorkspace: async () => ({
    mode: "simple",
    dir: "D:\\ws\\chats\\conv-race",
    folderId: "folder-race",
    folderName: "Chat",
  }),
}));

const { openCodeServerManager } = await import("@/services/opencode/serverManager.ts");
const { ensureOpenCodeSession } = await import("@/services/opencode/sessions.ts");

(openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
  async () => "http://127.0.0.1:0";

beforeEach(() => {
  createCalls = 0;
  createEntered = 0;
  lastCreatePermissions = undefined;
  releaseCreate = null;
  createBarrier = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  modelDefaultEntered = 0;
  releaseModelDefault = null;
  modelDefaultBarrier = new Promise<void>((resolve) => {
    releaseModelDefault = resolve;
  });
  updates = [];
  conversation = {
    engine: "opencode",
    opencodeSessionId: null,
    opencodeAgent: null,
    opencodeModel: null,
    opencodeVariant: null,
  };
});

describe("ensureOpenCodeSession — concurrent first-session race", () => {
  it("two concurrent calls with no stored session create EXACTLY ONE session and share its id", async () => {
    const firstP = ensureOpenCodeSession("conv-race");
    const secondP = ensureOpenCodeSession("conv-race");
    // Release the model-resolution barrier so the flow reaches create.
    for (let i = 0; i < 100 && modelDefaultEntered === 0; i += 1) await Bun.sleep(1);
    releaseModelDefault?.();
    // With the fix both callers dedupe into one create; without it two creates
    // are entered. Release once at least one create is in flight.
    for (let i = 0; i < 100 && createEntered === 0; i += 1) await Bun.sleep(1);
    releaseCreate?.();
    const [first, second] = await Promise.all([firstP, secondP]);
    expect(createCalls).toBe(1);
    expect(first.sessionId).toBe(second.sessionId);
  });

  // M2 / §3-C: different option shapes must still dedupe, and a security-
  // sensitive caller's permissions must not be silently discarded.
  it("concurrent calls with different permission shapes create one session with merged restrictions", async () => {
    const { READ_ONLY_PERMISSIONS } = await import("@/services/opencode/sessions.ts");
    const firstP = ensureOpenCodeSession("conv-race-shapes"); // no options (user path)
    const secondP = ensureOpenCodeSession("conv-race-shapes", {
      permissions: READ_ONLY_PERMISSIONS,
    }); // scheduler path
    for (let i = 0; i < 100 && modelDefaultEntered === 0; i += 1) await Bun.sleep(1);
    releaseModelDefault?.();
    for (let i = 0; i < 100 && createEntered === 0; i += 1) await Bun.sleep(1);
    releaseCreate?.();
    const [first, second] = await Promise.all([firstP, secondP]);

    expect(createCalls).toBe(1); // RED before fix: 2
    expect(first.sessionId).toBe(second.sessionId); // RED before fix: different ids

    // The READ_ONLY caller's restrictions must be honored even though the
    // no-options caller arrived first: most-restrictive-wins merge.
    expect(lastCreatePermissions).toBeDefined();
    const editRule = lastCreatePermissions!.find((r) => r.action === "edit");
    expect(editRule?.effect).toBe("deny");
    const shellRule = lastCreatePermissions!.find((r) => r.action === "shell");
    expect(shellRule?.effect).toBe("deny");
  });

  // F1 (independent audit): a restrictive caller joining AFTER the initial
  // params.permissions snapshot but before create dispatch must still have its
  // restrictions included. The fix refreshes params.permissions at dispatch.
  it("includes permissions merged after the initial snapshot at create dispatch", async () => {
    const { READ_ONLY_PERMISSIONS } = await import("@/services/opencode/sessions.ts");
    // First caller with no options: snapshots params.permissions (undefined),
    // then blocks at model.default (after snapshot, before create).
    const firstP = ensureOpenCodeSession("conv-late-merge");
    for (let i = 0; i < 100 && modelDefaultEntered === 0; i += 1) await Bun.sleep(1);
    expect(modelDefaultEntered).toBe(1);

    // Late joiner merges restrictive permissions into the shared options while
    // the first caller is suspended between snapshot and create.
    const secondP = ensureOpenCodeSession("conv-late-merge", {
      permissions: READ_ONLY_PERMISSIONS,
    });

    // Release model resolution, then the create barrier.
    releaseModelDefault?.();
    for (let i = 0; i < 100 && createEntered === 0; i += 1) await Bun.sleep(1);
    releaseCreate?.();
    await Promise.all([firstP, secondP]);

    expect(createCalls).toBe(1);
    // The create must carry the late-merged restrictions (RED before the
    // dispatch-time refresh: params.permissions was snapshotted as undefined).
    expect(lastCreatePermissions).toBeDefined();
    expect(lastCreatePermissions!.find((r) => r.action === "edit")?.effect).toBe("deny");
    expect(lastCreatePermissions!.find((r) => r.action === "shell")?.effect).toBe("deny");
  });
});
