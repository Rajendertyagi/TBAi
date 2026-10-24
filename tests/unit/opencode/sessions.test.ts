import { describe, it, expect, mock, beforeEach } from "bun:test";
import { ClientError } from "@opencode/client";
import * as realOpenCodeClient from "@/services/opencode/client.ts";

/**
 * Tests for session termination (V2 interrupt -> remove) and the liveness probe.
 *
 * Isolation: `sessions.ts` reaches the outside world through three seams —
 * `conversationService` (storage), `openCodeServerManager.ensureBaseUrl`
 * (process ownership) and `createOpenCodeClient` (the official V2 client).
 * All three are stubbed, so no process is spawned, no database is opened and
 * no network I/O happens. Only the V2 call sequence and the error handling
 * under test are real.
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

/** Ordered log of the V2 session calls the code under test makes. */
let calls: string[] = [];
let conversation: Record<string, unknown> | null = null;
let updates: Array<{ id: string; patch: unknown }> = [];

let getImpl: (args: { sessionID: string }) => Promise<unknown>;
let createImpl: (args: {
  location: { directory: string };
  agent?: string;
  model?: unknown;
}) => Promise<unknown>;
let interruptImpl: () => Promise<unknown>;
let removeImpl: () => Promise<unknown>;
/** Storage seam: the pointer write. Defaults to succeeding and landing. */
let updateImpl: (id: string, patch: Record<string, unknown>) => Promise<void>;

const SUBMITTED_DIRECTORY = "D:\\ws\\chats\\conv-1";
const CREATED_SESSION_ID = "ses_created00000000000000000000";

/** Rejection carrying the V2 tagged body the official client throws on a 404. */
function sessionNotFound(sessionID: string): unknown {
  return { _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` };
}

mock.module("@/services/storage", () => ({
  conversationService: {
    get: async () => conversation,
    update: async (id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
      await updateImpl(id, patch);
    },
  },
}));

mock.module("@/services/workspace", () => ({
  resolveConversationWorkspace: async () => ({ dir: SUBMITTED_DIRECTORY }),
}));

mock.module("@/services/opencode/client", () => ({
  ...realOpenCodeClient,
  createOpenCodeClient: () => ({
    session: {
      get: (args: { sessionID: string }) => {
        calls.push(`get:${args.sessionID}`);
        return getImpl(args);
      },
      interrupt: (args: { sessionID: string }) => {
        calls.push(`interrupt:${args.sessionID}`);
        return interruptImpl();
      },
      remove: (args: { sessionID: string }) => {
        calls.push(`remove:${args.sessionID}`);
        return removeImpl();
      },
      create: (args: { location: { directory: string }; agent?: string; model?: unknown }) => {
        calls.push(`create:${args.location.directory}`);
        return createImpl(args);
      },
    },
    // A session created with no model reaches `fetchServerDefaultModel`, which
    // reads the catalogue through this same client. An EMPTY catalogue is the
    // honest answer here: the server advertises no default, so the session stays
    // unbound - which is what the cases above assert. Deliberately not recorded
    // in `calls`, because the V2 session sequence is what those cases check.
    agent: { list: async () => ({ data: [] }) },
    model: { list: async () => ({ data: [] }) },
  }),
}));

const { openCodeServerManager } = await import("@/services/opencode/serverManager.ts");
const { createOpenCodeClient } = await import("@/services/opencode/client.ts");
const { OpenCodeError } = await import("@/services/opencode/errors.ts");
const { terminateOpenCodeSession, isOpenCodeSessionLive, ensureOpenCodeSession } = await import(
  "@/services/opencode/sessions.ts"
);
const { OpenCodeSessionPersistError } = await import("@/services/opencode/sessions.ts");
const { logger } = await import("@/lib/logger.ts");

(openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
  async () => "http://127.0.0.1:0";

/** Client from the mocked factory; its `session.*` behaviour is the *Impl vars. */
const stubClient = createOpenCodeClient("http://127.0.0.1:0");

const LIVE_ID = "ses_live0000000000000000000000";

beforeEach(() => {
  calls = [];
  updates = [];
  conversation = { engine: "opencode", opencodeSessionId: LIVE_ID };
  getImpl = async () => ({ id: LIVE_ID });
  createImpl = async () => ({
    id: CREATED_SESSION_ID,
    location: { directory: "D:\\ws\\server-recorded" },
  });
  interruptImpl = async () => ({ interrupted: true });
  removeImpl = async () => undefined;
  // Default storage write succeeds AND lands on the row, mirroring the real
  // store. A test that forces a failure overrides this.
  updateImpl = async (_id, patch) => {
    if (conversation) conversation = { ...conversation, ...patch };
  };
});

describe("terminateOpenCodeSession — V2 call mapping", () => {
  it("B/C. calls session.interrupt then session.remove with the stored id", async () => {
    const result = await terminateOpenCodeSession("conv-1");
    expect(calls).toEqual([`interrupt:${LIVE_ID}`, `remove:${LIVE_ID}`]);
    expect(result).toEqual({ terminated: true });
  });

  it("D. preserves lifecycle order: interrupt strictly before remove", async () => {
    await terminateOpenCodeSession("conv-1");
    expect(calls.indexOf(`interrupt:${LIVE_ID}`)).toBeLessThan(calls.indexOf(`remove:${LIVE_ID}`));
  });

  it("clears the persisted pointer after a successful termination", async () => {
    await terminateOpenCodeSession("conv-1");
    expect(updates).toEqual([{ id: "conv-1", patch: { opencodeSessionId: null } }]);
  });

  it("D. stays best-effort: a failing interrupt still lets remove run", async () => {
    interruptImpl = async () => {
      throw sessionNotFound(LIVE_ID);
    };
    const result = await terminateOpenCodeSession("conv-1");
    expect(calls).toEqual([`interrupt:${LIVE_ID}`, `remove:${LIVE_ID}`]);
    expect(result).toEqual({ terminated: true });
  });

  it("L2: a failing remove KEEPS the pointer, so the session is not orphaned", async () => {
    // L2 CHANGED THIS. The old behaviour cleared the pointer even when the
    // remote removal failed, which ORPHANED the session: the server still had
    // it, and nothing held the handle that could remove it. A kept pointer is
    // recoverable - the next attempt tries again.
    removeImpl = async () => {
      throw sessionNotFound(LIVE_ID);
    };
    const result = await terminateOpenCodeSession("conv-1");
    expect(result.terminated).toBe(false);
    expect(result.reason).toBe("remote-removal-failed");
    // The pointer is NOT cleared.
    expect(updates).toEqual([]);
  });

  it("L2: a failing remove keeps the pointer, but a SUCCESSFUL one clears it", async () => {
    removeImpl = async () => {
      throw sessionNotFound(LIVE_ID);
    };
    await terminateOpenCodeSession("conv-1");
    expect(updates).toEqual([]);

    // The next attempt succeeds, and only then is the pointer cleared.
    removeImpl = async () => undefined;
    const result = await terminateOpenCodeSession("conv-1");
    expect(result.terminated).toBe(true);
    expect(updates).toEqual([{ id: "conv-1", patch: { opencodeSessionId: null } }]);
  });

  it("stays best-effort when BOTH calls fail", async () => {
    interruptImpl = async () => {
      throw new ClientError("Transport", { cause: new Error("boom") });
    };
    removeImpl = async () => {
      throw new ClientError("UnexpectedStatus", { cause: { status: 500 } });
    };
    const result = await terminateOpenCodeSession("conv-1");
    expect(calls).toEqual([`interrupt:${LIVE_ID}`, `remove:${LIVE_ID}`]);
    // The removal failed, so the pointer is kept and the reason is reported.
    expect(result.terminated).toBe(false);
    expect(result.reason).toBe("remote-removal-failed");
    expect(updates).toEqual([]);
  });

  it("does nothing when the conversation has no session pointer", async () => {
    conversation = { engine: "opencode", opencodeSessionId: null };
    const result = await terminateOpenCodeSession("conv-1");
    expect(calls).toEqual([]);
    expect(updates).toEqual([]);
    expect(result).toEqual({ terminated: false });
  });

  it("does nothing when the conversation does not exist", async () => {
    conversation = null;
    const result = await terminateOpenCodeSession("conv-1");
    expect(calls).toEqual([]);
    expect(result).toEqual({ terminated: false });
  });
});

describe("isOpenCodeSessionLive — liveness semantics", () => {
  it("G. reads a healthy V2 response as live", async () => {
    getImpl = async () => ({ id: LIVE_ID });
    expect(await isOpenCodeSessionLive(stubClient, LIVE_ID)).toBe(true);
  });

  it("G. reads a missing session (V2 tagged 404) as dead", async () => {
    getImpl = async () => {
      throw sessionNotFound(LIVE_ID);
    };
    expect(await isOpenCodeSessionLive(stubClient, LIVE_ID)).toBe(false);
  });

  it("G. rejects transport failures as OpenCodeError", async () => {
    getImpl = async () => {
      throw new ClientError("Transport", {
        cause: Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" }),
      });
    };
    await expect(isOpenCodeSessionLive(stubClient, LIVE_ID)).rejects.toBeInstanceOf(OpenCodeError);
  });

  it("rejects authentication failures as OpenCodeError", async () => {
    getImpl = async () => {
      throw { _tag: "UnauthorizedError", message: "Unauthorized" };
    };
    await expect(isOpenCodeSessionLive(stubClient, LIVE_ID)).rejects.toBeInstanceOf(OpenCodeError);
  });

  it("rejects malformed responses as OpenCodeError", async () => {
    getImpl = async () => {
      throw new ClientError("UnsupportedContentType");
    };
    await expect(isOpenCodeSessionLive(stubClient, LIVE_ID)).rejects.toBeInstanceOf(OpenCodeError);
  });

  it("rejects unexpected HTTP 500 responses as OpenCodeError", async () => {
    getImpl = async () => {
      throw new ClientError("UnexpectedStatus", { cause: { status: 500 } });
    };
    await expect(isOpenCodeSessionLive(stubClient, LIVE_ID)).rejects.toBeInstanceOf(OpenCodeError);
  });

  it("rejects unknown failures as OpenCodeError", async () => {
    getImpl = async () => {
      throw new Error("something unexpected");
    };
    await expect(isOpenCodeSessionLive(stubClient, LIVE_ID)).rejects.toBeInstanceOf(OpenCodeError);
  });

  it("rejects a response with no session id as OpenCodeError", async () => {
    getImpl = async () => ({ id: undefined });
    await expect(isOpenCodeSessionLive(stubClient, LIVE_ID)).rejects.toBeInstanceOf(OpenCodeError);
  });
});

describe("ensureOpenCodeSession — the binding carries the event-stream scope", () => {
  // The browser runtime addresses a session's event stream by its directory: an
  // unscoped `GET /event` is a stub that carries no session events, which is why
  // a finished reply used to appear only after a refresh. The seam therefore has
  // to hand the scope out with the id, from the server's own session record.

  it("resumes with the V2 `location.directory` the server records", async () => {
    getImpl = async () => ({
      id: LIVE_ID,
      location: { directory: "D:\\ws\\chats\\conv-1" },
    });
    expect(await ensureOpenCodeSession("conv-1")).toEqual({
      sessionId: LIVE_ID,
      directory: "D:\\ws\\chats\\conv-1",
      reusedExistingSession: true,
    });
  });

  it("reports no scope rather than guessing when the server names none", async () => {
    // A null scope is honest: the runtime then leaves its subscription unscoped
    // (the previous behaviour) instead of scoping to an invented path.
    getImpl = async () => ({ id: LIVE_ID });
    expect(await ensureOpenCodeSession("conv-1")).toEqual({
      sessionId: LIVE_ID,
      directory: null,
      reusedExistingSession: true,
    });
  });

  it("rejects lookup failures without creating a replacement session", async () => {
    const failures = [
      new ClientError("Transport", { cause: new Error("offline") }),
      { _tag: "UnauthorizedError", message: "Unauthorized" },
      new ClientError("UnsupportedContentType"),
      new ClientError("UnexpectedStatus", { cause: { status: 500 } }),
      new Error("unknown failure"),
    ];
    for (const failure of failures) {
      calls = [];
      getImpl = async () => {
        throw failure;
      };
      await expect(ensureOpenCodeSession("conv-1")).rejects.toBeInstanceOf(OpenCodeError);
      expect(calls).toEqual([`get:${LIVE_ID}`]);
      expect(updates).toEqual([]);
    }
  });

  it("recreates when the stored session is gone", async () => {
    // A definitive not-found must not be handed back as a live binding. The
    // create path runs instead, using the submitted workspace as its request
    // location and the native V2 response location as the returned scope.
    getImpl = async () => {
      throw sessionNotFound(LIVE_ID);
    };
    createImpl = async () => ({
      id: CREATED_SESSION_ID,
      location: { directory: "D:\\ws\\server-recorded" },
    });

    expect(await ensureOpenCodeSession("conv-1")).toEqual({
      sessionId: CREATED_SESSION_ID,
      directory: "D:\\ws\\server-recorded",
      reusedExistingSession: false,
    });
    expect(calls).toEqual([`get:${LIVE_ID}`, `create:${SUBMITTED_DIRECTORY}`]);
    expect(updates).toEqual([{ id: "conv-1", patch: { opencodeSessionId: CREATED_SESSION_ID } }]);
  });

  it("falls back to the submitted directory when a create response omits location", async () => {
    // A partial native V2 response still supplies a session id. When it omits
    // location, the request's submitted workspace remains the honest fallback.
    conversation = { engine: "opencode", opencodeSessionId: null };
    createImpl = async () => ({ id: CREATED_SESSION_ID });

    expect(await ensureOpenCodeSession("conv-1")).toEqual({
      sessionId: CREATED_SESSION_ID,
      directory: SUBMITTED_DIRECTORY,
      reusedExistingSession: false,
    });
    expect(calls).toEqual([`create:${SUBMITTED_DIRECTORY}`]);
    expect(updates).toEqual([{ id: "conv-1", patch: { opencodeSessionId: CREATED_SESSION_ID } }]);
  });
});

/**
 * RT-001 — the create→persist window. A successful remote create must never be
 * followed by a persistence failure that silently loses TBAi's only handle to
 * the remote session. These cases force `conversationService.update` to fail
 * immediately after a real (mocked) remote create and assert the resulting
 * state, not merely that an error surfaced.
 */
describe("ensureOpenCodeSession — RT-001 create/persist window", () => {
  /** A create-path conversation: no stored pointer, so `create` runs. */
  function noPointerConversation(): void {
    conversation = { engine: "opencode", opencodeSessionId: null };
  }

  it("A. persists the id and runs no compensating cleanup on success", async () => {
    noPointerConversation();
    const binding = await ensureOpenCodeSession("conv-1");

    expect(binding).toEqual({
      sessionId: CREATED_SESSION_ID,
      directory: "D:\\ws\\server-recorded",
      reusedExistingSession: false,
    });
    // The pointer is on the row, and the create was the ONLY remote call:
    // no interrupt/remove ran, because nothing needed compensating.
    expect(conversation?.opencodeSessionId).toBe(CREATED_SESSION_ID);
    expect(calls).toEqual([`create:${SUBMITTED_DIRECTORY}`]);
  });

  it("A2. treats a failed write whose pointer LANDED as success, with no cleanup", async () => {
    noPointerConversation();
    // The row is written, then the call still throws (e.g. a lost commit ack).
    // The pointer is durable, so the binding is safely established.
    updateImpl = async (_id, patch) => {
      if (conversation) conversation = { ...conversation, ...patch };
      throw new Error("commit acknowledgement lost");
    };

    const binding = await ensureOpenCodeSession("conv-1");
    expect(binding.sessionId).toBe(CREATED_SESSION_ID);
    expect(conversation?.opencodeSessionId).toBe(CREATED_SESSION_ID);
    // No remote cleanup: the session is bound and must be kept.
    expect(calls).toEqual([`create:${SUBMITTED_DIRECTORY}`]);
  });

  it("B. removes the exact remote session and rejects when persistence fails", async () => {
    noPointerConversation();
    updateImpl = async () => {
      throw new Error("database is locked");
    };
    // Confirmation lookup: the session is gone after removal.
    getImpl = async () => {
      throw sessionNotFound(CREATED_SESSION_ID);
    };

    let caught: unknown;
    try {
      await ensureOpenCodeSession("conv-1");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeSessionPersistError);
    const failure = caught as InstanceType<typeof OpenCodeSessionPersistError>;
    expect(failure.cleanup).toBe("removed");
    expect(failure.sessionId).toBe(CREATED_SESSION_ID);
    expect(failure.cause).toBeInstanceOf(Error);
    // The compensating removal targeted THIS session id, and the outcome was
    // confirmed by a lookup rather than assumed from the call returning.
    expect(calls).toEqual([
      `create:${SUBMITTED_DIRECTORY}`,
      `remove:${CREATED_SESSION_ID}`,
      `get:${CREATED_SESSION_ID}`,
    ]);
    // No successful binding was handed back, and the pointer was not written.
    expect(conversation?.opencodeSessionId).toBeNull();
  });

  it("C. records the orphan durably and does NOT claim removal when cleanup fails", async () => {
    noPointerConversation();
    updateImpl = async () => {
      throw new Error("database is locked");
    };
    removeImpl = async () => {
      throw new ClientError("Transport", { cause: new Error("offline") });
    };
    const before = logger.lastSeq;

    let caught: unknown;
    try {
      await ensureOpenCodeSession("conv-1");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeSessionPersistError);
    const failure = caught as InstanceType<typeof OpenCodeSessionPersistError>;
    expect(failure.cleanup).toBe("unconfirmed");
    // The id is preserved on the error and the message does not claim removal.
    expect(failure.sessionId).toBe(CREATED_SESSION_ID);
    expect(failure.message).toContain("could NOT be confirmed");
    expect(failure.cleanupError).toBeDefined();

    // The durable record: a log entry that still names the orphaned session.
    // (The structured `sessionId` field is redacted, so the id rides in
    // `message`; this asserts the record is actually actionable.)
    const orphanRecords = logger
      .getRecentEntries(before)
      .filter((entry) => entry.event === "opencode.session_orphaned");
    expect(orphanRecords.length).toBe(1);
    expect(String(orphanRecords[0]!.message)).toContain(CREATED_SESSION_ID);
    expect(orphanRecords[0]!.conversationId).toBe("conv-1");
  });

  it("C2. reports unconfirmed when remove resolves but the session still exists", async () => {
    noPointerConversation();
    updateImpl = async () => {
      throw new Error("database is locked");
    };
    // `remove` returns without error, but the session is still on the server:
    // a resolved call is not proof of removal.
    removeImpl = async () => undefined;
    getImpl = async () => ({ id: CREATED_SESSION_ID });

    let caught: unknown;
    try {
      await ensureOpenCodeSession("conv-1");
    } catch (error) {
      caught = error;
    }

    const failure = caught as InstanceType<typeof OpenCodeSessionPersistError>;
    expect(failure).toBeInstanceOf(OpenCodeSessionPersistError);
    expect(failure.cleanup).toBe("unconfirmed");
    expect(failure.sessionId).toBe(CREATED_SESSION_ID);
  });
});
