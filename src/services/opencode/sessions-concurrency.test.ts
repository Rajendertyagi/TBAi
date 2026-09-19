import { describe, it, expect, mock, beforeEach } from "bun:test";

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
 * (conversation row), `./client` (the official V2 client),
 * `openCodeServerManager.ensureBaseUrl` (process ownership) and
 * `../workspace` (workspace dir resolution). All four are stubbed — no
 * process is spawned, no database is opened, no network I/O happens — so the
 * `create` is given an artificial delay to force the real race window open.
 * Specifiers mirror `sessions.test.ts` (`../storage`, `./client`); the
 * workspace stub exists because, unlike the resume-path tests there, this
 * no-pointer path always reaches `resolveConversationWorkspace`.
 */

let createCalls = 0;
let conversation: Record<string, unknown> | null = null;
let updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

mock.module("../storage", () => ({
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

mock.module("./client", () => ({
  createOpenCodeClient: () => ({
    session: {
      get: async () => {
        throw new Error("not reached: no stored session in this probe");
      },
      create: async () => {
        createCalls += 1;
        // Hold the race window open so both callers overlap inside `create`
        // instead of one finishing before the other starts.
        await Bun.sleep(25);
        return { id: `ses-race-${createCalls}` };
      },
    },
  }),
}));

mock.module("../workspace", () => ({
  resolveConversationWorkspace: async () => ({
    mode: "simple",
    dir: "D:\\ws\\chats\\conv-race",
    folderId: "folder-race",
    folderName: "Chat",
  }),
}));

const { openCodeServerManager } = await import("./serverManager");
const { ensureOpenCodeSession } = await import("./sessions");

(openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> })
  .ensureBaseUrl = async () => "http://127.0.0.1:0";

beforeEach(() => {
  createCalls = 0;
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
    const [first, second] = await Promise.all([
      ensureOpenCodeSession("conv-race"),
      ensureOpenCodeSession("conv-race"),
    ]);
    expect(createCalls).toBe(1);
    expect(first.sessionId).toBe(second.sessionId);
  });
});
