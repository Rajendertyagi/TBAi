import { describe, it, expect, mock, beforeEach } from "bun:test";
import { ClientError } from "@opencode/client";
import * as realOpenCodeClient from "@/services/opencode/client.ts";

/**
 * Tests for session termination (V2 interrupt -> remove), the liveness probe,
 * and the RT-001 create/persist window.
 *
 * Isolation: `sessions.ts` reaches the outside world through four seams —
 * `conversationService` (storage), `opencodeOrphanService` (the durable
 * journal), `openCodeServerManager.ensureBaseUrl` (process ownership) and
 * `createOpenCodeClient` (the official V2 client). All four are stubbed, so no
 * process is spawned, no database is opened and no network I/O happens.
 *
 * The `./client` mock is a PARTIAL mock (spread over the real module) on
 * purpose. `sessions.ts` also imports `lastStatusForSessionLookup` from that
 * same module, so a factory that listed only `createOpenCodeClient` left the
 * namespace incomplete and the import failed to link. Spreading the real
 * module keeps every un-stubbed export genuinely real instead of silently
 * absent.
 *
 * The session id is now MINTED BY THE CODE UNDER TEST (RT-001), so tests read
 * it back from the create call (`createdId()`) instead of assuming a constant.
 * The default create implementation echoes the supplied id, exactly as the
 * real server does (verified against OpenCode 2.1.2).
 */

type LoggedCreate = {
  id?: string;
  location: { directory: string };
  agent?: string;
  model?: unknown;
};

/** Ordered journal/create steps, so "intent before create" is observable. */
let steps: string[] = [];
/** Ordered log of the V2 session calls the code under test makes. */
let calls: string[] = [];
let createArgs: LoggedCreate[] = [];
let conversation: Record<string, unknown> | null = null;
let updates: Array<{ id: string; patch: unknown }> = [];
/**
 * The read seam: defaults to the shared `conversation` row. RT-001 cases
 * override it to fail (verification-unknown).
 */
let getImpl_forStorage: () => Promise<Record<string, unknown> | null>;

let getImpl: (args: { sessionID: string }) => Promise<unknown>;
let createImpl: (args: LoggedCreate) => Promise<unknown>;
let interruptImpl: () => Promise<unknown>;
let removeImpl: () => Promise<unknown>;
/** Storage seam: the pointer write. Defaults to succeeding and landing. */
let updateImpl: (id: string, patch: Record<string, unknown>) => Promise<void>;
/**
 * Durable journal seams. Defaults mirror the real store: the intent is
 * written, the orphan record reports open, and the intent is deleted.
 */
let intentRecordImpl: (input: {
  conversationId: string;
  sessionId: string;
  locationDirectory?: string;
}) => Promise<boolean>;
let intentDeleteImpl: (conversationId: string, sessionId: string) => Promise<boolean>;
let orphanRecordImpl: (input: {
  conversationId: string;
  sessionId: string;
  locationDirectory?: string;
  persistErrorCategory?: string;
  cleanupErrorCategory?: string;
}) => Promise<boolean>;
let intentRecords: Array<{
  conversationId: string;
  sessionId: string;
  locationDirectory?: string;
}> = [];
let deletedIntents: Array<{ conversationId: string; sessionId: string }> = [];
let orphanRecords: Array<{
  conversationId: string;
  sessionId: string;
  locationDirectory?: string;
  persistErrorCategory?: string;
  cleanupErrorCategory?: string;
}> = [];
/** Flag for test C: the verification re-read (second `get` call) fails. */
let verifyFailsAfterEntryRead: (() => Promise<Record<string, unknown> | null>) | null = null;
let storageGetCallCount = 0;

const SUBMITTED_DIRECTORY = "D:\\ws\\chats\\conv-1";
const SERVER_RECORDED_DIRECTORY = "D:\\ws\\server-recorded";
const LIVE_ID = "ses_live0000000000000000000000";

/** The id the code under test supplied to `session.create`. */
function createdId(): string {
  return createArgs[0]?.id ?? "";
}

/** Rejection carrying the V2 tagged body the official client throws on a 404. */
function sessionNotFound(sessionID: string): unknown {
  return { _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` };
}

mock.module("@/services/storage", () => ({
  conversationService: {
    get: async () => {
      storageGetCallCount += 1;
      if (storageGetCallCount === 2 && verifyFailsAfterEntryRead) {
        throw new Error("read: database is locked");
      }
      return getImpl_forStorage();
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
      await updateImpl(id, patch);
    },
  },
}));

// The journal lives beside `conversationService` in its own table, so it is
// stubbed independently: its writes are observable through `steps`,
// `intentRecords`, `deletedIntents` and `orphanRecords`.
mock.module("@/services/storage/opencodeSessionOrphans", () => ({
  opencodeOrphanService: {
    recordCreateIntent: async (input: {
      conversationId: string;
      sessionId: string;
      locationDirectory?: string;
    }): Promise<boolean> => {
      steps.push("intent");
      intentRecords.push(input);
      return intentRecordImpl(input);
    },
    deleteCreateIntent: async (conversationId: string, sessionId: string): Promise<boolean> => {
      steps.push("delete-intent");
      deletedIntents.push({ conversationId, sessionId });
      return intentDeleteImpl(conversationId, sessionId);
    },
    recordOrphanedSession: async (input: {
      conversationId: string;
      sessionId: string;
      locationDirectory?: string;
      persistErrorCategory?: string;
      cleanupErrorCategory?: string;
    }): Promise<boolean> => {
      steps.push("orphan");
      orphanRecords.push(input);
      return orphanRecordImpl(input);
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
      create: (args: LoggedCreate) => {
        steps.push("create");
        createArgs.push(args);
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

beforeEach(() => {
  steps = [];
  calls = [];
  createArgs = [];
  updates = [];
  intentRecords = [];
  deletedIntents = [];
  orphanRecords = [];
  storageGetCallCount = 0;
  conversation = { engine: "opencode", opencodeSessionId: LIVE_ID };
  getImpl_forStorage = async () => conversation;
  // Echo the requested id, like the real server; a lookup names the id it was
  // asked about unless a case deliberately answers differently.
  getImpl = async (args) => ({ id: args.sessionID });
  createImpl = async (args) => ({
    id: args.id,
    location: { directory: SERVER_RECORDED_DIRECTORY },
  });
  interruptImpl = async () => ({ interrupted: true });
  removeImpl = async () => undefined;
  // Default storage write succeeds AND lands on the row, mirroring the real
  // store. A test that forces a failure overrides this.
  updateImpl = async (_id, patch) => {
    if (conversation) conversation = { ...conversation, ...patch };
  };
  intentRecordImpl = async () => true;
  intentDeleteImpl = async () => true;
  orphanRecordImpl = async () => true;
  verifyFailsAfterEntryRead = null;
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
    // A crash-interrupted create may have left an intent for the same id; it
    // has nothing left to recover once the session is gone.
    expect(deletedIntents).toEqual([{ conversationId: "conv-1", sessionId: LIVE_ID }]);
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

  it("rejects transport failures as OpenCodeError", async () => {
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

  it("rejects a response for a DIFFERENT id instead of answering about this one", async () => {
    // Identity, not just existence: the reconciler uses this probe to decide
    // whether a remote session is safe to remove.
    getImpl = async () => ({ id: "ses_someoneelse0000000000000000" });
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
    getImpl = async (args) => {
      throw sessionNotFound(args.sessionID);
    };

    expect(await ensureOpenCodeSession("conv-1")).toEqual({
      sessionId: createdId(),
      directory: SERVER_RECORDED_DIRECTORY,
      reusedExistingSession: false,
    });
    expect(calls).toEqual([`get:${LIVE_ID}`, `create:${SUBMITTED_DIRECTORY}`]);
    expect(updates).toEqual([{ id: "conv-1", patch: { opencodeSessionId: createdId() } }]);
  });

  it("falls back to the submitted directory when a create response omits location", async () => {
    // A partial native V2 response still supplies a session id. When it omits
    // location, the request's submitted workspace remains the honest fallback.
    conversation = { engine: "opencode", opencodeSessionId: null };
    createImpl = async (args) => ({ id: args.id });

    const binding = await ensureOpenCodeSession("conv-1");
    expect(binding).toEqual({
      sessionId: createdId(),
      directory: SUBMITTED_DIRECTORY,
      reusedExistingSession: false,
    });
    expect(calls).toEqual([`create:${SUBMITTED_DIRECTORY}`]);
    expect(updates).toEqual([{ id: "conv-1", patch: { opencodeSessionId: createdId() } }]);
  });
});

/**
 * RT-001 — the create→persist window. A successful remote create must never be
 * followed by a persistence failure that silently loses TBAi's only handle to
 * the remote session. These cases force `conversationService.update` to fail
 * immediately after a real (mocked) remote create and assert the resulting
 * state — no false success, no silent orphan, no unredacted log leak.
 *
 * Three-outcome verification: a read that FAILS is "unknown", and the code
 * must NOT treat it as absence. The remote session stays put, an open
 * durable record is written via `opencodeOrphanService`, and the operation
 * still fails.
 */
describe("ensureOpenCodeSession — RT-001 create/persist window", () => {
  /** A create-path conversation: no stored pointer, so `create` runs. */
  function noPointerConversation(): void {
    conversation = { engine: "opencode", opencodeSessionId: null };
  }

  /** `update` fails AND the re-read sees no pointer. */
  function failPersistAndNotPersisted(): void {
    noPointerConversation();
    updateImpl = async () => {
      throw new Error("database is locked");
    };
  }

  it("A. persists the id and runs no compensating cleanup on success", async () => {
    noPointerConversation();
    const binding = await ensureOpenCodeSession("conv-1");

    expect(binding).toEqual({
      sessionId: createdId(),
      directory: SERVER_RECORDED_DIRECTORY,
      reusedExistingSession: false,
    });
    expect(conversation?.opencodeSessionId).toBe(createdId());
    expect(calls).toEqual([`create:${SUBMITTED_DIRECTORY}`]);
    // No orphan record: nothing went wrong.
    expect(orphanRecords).toEqual([]);
    // The pre-create intent was durable and removed once the pointer landed.
    expect(intentRecords.length).toBe(1);
    expect(intentRecords[0]).toMatchObject({
      conversationId: "conv-1",
      sessionId: createdId(),
      locationDirectory: SUBMITTED_DIRECTORY,
    });
    expect(deletedIntents).toEqual([{ conversationId: "conv-1", sessionId: createdId() }]);
  });

  it("A2. records the intent BEFORE the create request", async () => {
    noPointerConversation();
    await ensureOpenCodeSession("conv-1");
    expect(steps.indexOf("intent")).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf("intent")).toBeLessThan(steps.indexOf("create"));
  });

  it("B. returns the binding when a failed write's pointer is confirmed on the row", async () => {
    noPointerConversation();
    // The write's row landed; the call itself still threw (e.g. a lost commit
    // ack). A successful re-read shows the exact pointer: recover.
    updateImpl = async (_id, patch) => {
      if (conversation) conversation = { ...conversation, ...patch };
      throw new Error("commit acknowledgement lost");
    };

    const binding = await ensureOpenCodeSession("conv-1");
    expect(binding.sessionId).toBe(createdId());
    expect(conversation?.opencodeSessionId).toBe(createdId());
    // No compensating cleanup: the remote session is TBAi's and must stay.
    expect(calls).toEqual([`create:${SUBMITTED_DIRECTORY}`]);
    expect(orphanRecords).toEqual([]);
    // The pointer is on the row, so the intent has served its purpose.
    expect(deletedIntents).toEqual([{ conversationId: "conv-1", sessionId: createdId() }]);
  });

  it("C. treats a failed verification re-read as UNKNOWN, refuses cleanup, and records the orphan durably", async () => {
    noPointerConversation();
    failPersistAndNotPersisted();
    // The entry read (conversation row load at the top of ensure) succeeds;
    // only the post-failure verification re-read fails. That is the
    // three-outcome `unknown` case: pointer state unestablished.
    verifyFailsAfterEntryRead = () => Promise.resolve(conversation);

    let caught: unknown;
    try {
      await ensureOpenCodeSession("conv-1");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeSessionPersistError);
    const failure = caught as InstanceType<typeof OpenCodeSessionPersistError>;
    expect(failure.cleanup).toBe("verification_unknown");
    expect(failure.sessionId).toBe(createdId());
    expect(failure.recorded).toBe(true);
    expect(failure.cause).toBeInstanceOf(Error);
    // No remove call was made: the possibly-bound session must not be deleted.
    expect(calls).toEqual([`create:${SUBMITTED_DIRECTORY}`]);
    // The durable recovery record was written and reports open; it carries
    // just enough to identify the orphan without duplicating secrets.
    expect(orphanRecords.length).toBe(1);
    expect(orphanRecords[0]).toMatchObject({
      conversationId: "conv-1",
      sessionId: createdId(),
      locationDirectory: SERVER_RECORDED_DIRECTORY,
    });
    expect(orphanRecords[0]!.persistErrorCategory).toBeDefined();
  });

  it("D. removes the exact remote session when absence is confirmed and the removal is confirmed", async () => {
    noPointerConversation();
    failPersistAndNotPersisted();
    // Confirmation lookup: the session is gone after removal.
    getImpl = async (args) => {
      throw sessionNotFound(args.sessionID);
    };

    let caught: unknown;
    try {
      await ensureOpenCodeSession("conv-1");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeSessionPersistError);
    const failure = caught as InstanceType<typeof OpenCodeSessionPersistError>;
    expect(failure.cleanup).toBe("confirmed_removed");
    expect(failure.sessionId).toBe(createdId());
    expect(failure.cause).toBeInstanceOf(Error);
    // Removal targeted THIS id and was confirmed by a follow-up lookup.
    expect(calls).toEqual([
      `create:${SUBMITTED_DIRECTORY}`,
      `remove:${createdId()}`,
      `get:${createdId()}`,
    ]);
    // No binding was handed back, no orphan record: the session is gone.
    expect(conversation?.opencodeSessionId).toBeNull();
    expect(orphanRecords).toEqual([]);
    // The intent is no longer needed once the id is proven absent.
    expect(deletedIntents).toEqual([{ conversationId: "conv-1", sessionId: createdId() }]);
  });

  it("E. records the orphan durably when removal fails", async () => {
    noPointerConversation();
    failPersistAndNotPersisted();
    removeImpl = async () => {
      throw new ClientError("Transport", { cause: new Error("offline") });
    };

    let caught: unknown;
    try {
      await ensureOpenCodeSession("conv-1");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeSessionPersistError);
    const failure = caught as InstanceType<typeof OpenCodeSessionPersistError>;
    expect(failure.cleanup).toBe("removal_failed");
    expect(failure.sessionId).toBe(createdId());
    expect(failure.recorded).toBe(true);
    expect(failure.cleanupError).toBeDefined();
    // A durable record was written; the error does not claim removal succeeded.
    expect(orphanRecords.length).toBe(1);
    expect(orphanRecords[0]).toMatchObject({
      conversationId: "conv-1",
      sessionId: createdId(),
      cleanupErrorCategory: "network",
    });
  });

  it("F. keeps the outcome conservative when removal succeeded but the confirmation lookup was inconclusive", async () => {
    noPointerConversation();
    failPersistAndNotPersisted();
    // Remove resolves; the confirmation lookup itself fails (transport).
    removeImpl = async () => undefined;
    getImpl = async () => {
      throw new ClientError("Transport", { cause: new Error("offline") });
    };

    let caught: unknown;
    try {
      await ensureOpenCodeSession("conv-1");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeSessionPersistError);
    const failure = caught as InstanceType<typeof OpenCodeSessionPersistError>;
    // A failed lookup is NOT positive evidence of absence.
    expect(failure.cleanup).toBe("lookup_inconclusive");
    expect(failure.sessionId).toBe(createdId());
    expect(failure.recorded).toBe(true);
    // The outcome is recorded conservatively, not claimed as removed.
    expect(orphanRecords.length).toBe(1);
    expect(orphanRecords[0]).toMatchObject({
      conversationId: "conv-1",
      sessionId: createdId(),
      cleanupErrorCategory: "network",
    });
  });

  it("H. reports removal_failed when the remove call resolves but the session remains", async () => {
    noPointerConversation();
    failPersistAndNotPersisted();
    // The remove call succeeds, but the follow-up lookup still finds it. A
    // resolved call is not proof of removal.
    removeImpl = async () => undefined;
    getImpl = async (args) => ({ id: args.sessionID });

    let caught: unknown;
    try {
      await ensureOpenCodeSession("conv-1");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeSessionPersistError);
    const failure = caught as InstanceType<typeof OpenCodeSessionPersistError>;
    expect(failure.cleanup).toBe("removal_failed");
    expect(failure.recorded).toBe(true);
    expect(orphanRecords.length).toBe(1);
    // The intent is NOT deleted: the session may still be live.
    expect(deletedIntents).toEqual([]);
  });

  it("G. does not leak the session id into log messages (redaction regression)", async () => {
    noPointerConversation();
    failPersistAndNotPersisted();
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

    // The operation failed and recorded a durable recovery row; the id lives
    // on the error object and in the journal row, NOT in any log `message`.
    expect(caught).toBeInstanceOf(OpenCodeSessionPersistError);
    const failure = caught as InstanceType<typeof OpenCodeSessionPersistError>;
    const id = createdId();
    expect(failure.sessionId).toBe(id);
    expect(failure.message).not.toContain(id);
    expect(failure.message).not.toContain("could NOT be confirmed");

    const entries = logger.getRecentEntries(before);
    const events = entries.filter((entry) =>
      String(entry.event ?? "").startsWith("opencode.session_"),
    );
    expect(events.length).toBeGreaterThan(0);
    for (const entry of events) {
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(id);
    }
    // The durable journal still names the orphan: recovery is not lost.
    expect(orphanRecords[0]).toMatchObject({ sessionId: id });
  });

  it("I. clears the pre-create intent when the create is proven absent", async () => {
    noPointerConversation();
    // The call fails before the server commits anything; the probe answers 404.
    createImpl = async () => {
      throw new ClientError("Transport", { cause: new Error("connection reset") });
    };
    getImpl = async (args) => {
      throw sessionNotFound(args.sessionID);
    };

    let caught: unknown;
    try {
      await ensureOpenCodeSession("conv-1");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeError);
    const id = createdId();
    expect(calls).toEqual([`create:${SUBMITTED_DIRECTORY}`, `get:${id}`]);
    expect(conversation?.opencodeSessionId).toBeNull();
    expect(orphanRecords).toEqual([]);
    // Proven never-created: no recovery obligation remains.
    expect(intentRecords.length).toBe(1);
    expect(deletedIntents).toEqual([{ conversationId: "conv-1", sessionId: id }]);
  });

  it("J. adopts a session the server created despite a failed create response", async () => {
    noPointerConversation();
    // The server committed the session, then the response path failed. The
    // supplied id is the correlation key, so the session is recoverable and
    // TBAi's to keep.
    createImpl = async () => {
      throw new ClientError("Transport", { cause: new Error("response truncated") });
    };
    getImpl = async (args) => ({
      id: args.sessionID,
      location: { directory: SERVER_RECORDED_DIRECTORY },
    });

    const binding = await ensureOpenCodeSession("conv-1");
    const id = createdId();
    expect(binding).toEqual({
      sessionId: id,
      directory: SERVER_RECORDED_DIRECTORY,
      reusedExistingSession: false,
    });
    expect(conversation?.opencodeSessionId).toBe(id);
    expect(calls).toEqual([`create:${SUBMITTED_DIRECTORY}`, `get:${id}`]);
    expect(deletedIntents).toEqual([{ conversationId: "conv-1", sessionId: id }]);
    expect(orphanRecords).toEqual([]);
  });

  it("K. leaves the intent durable when the create probe cannot answer", async () => {
    noPointerConversation();
    createImpl = async () => {
      throw new ClientError("Transport", { cause: new Error("offline") });
    };
    // The probe fails for a reason that is NOT a 404: presence is unknown.
    getImpl = async () => {
      throw new ClientError("Transport", { cause: new Error("offline") });
    };

    let caught: unknown;
    try {
      await ensureOpenCodeSession("conv-1");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeError);
    expect(conversation?.opencodeSessionId).toBeNull();
    // The intent is the durable handoff to the reconciler: it must survive.
    expect(intentRecords.length).toBe(1);
    expect(deletedIntents).toEqual([]);
    // Nothing was deleted remotely and no orphan claim was made yet.
    expect(orphanRecords).toEqual([]);
    expect(calls[0]).toBe(`create:${SUBMITTED_DIRECTORY}`);
  });

  it("L. refuses a create response that names a different id", async () => {
    noPointerConversation();
    createImpl = async () => ({ id: "ses_someoneelse0000000000000000" });

    await expect(ensureOpenCodeSession("conv-1")).rejects.toBeInstanceOf(OpenCodeError);
    expect(updates).toEqual([]);
    expect(conversation?.opencodeSessionId).toBeNull();
    // The supplied-id intent remains the only durable handle to whatever the
    // server did; the reconciler settles it.
    expect(intentRecords.length).toBe(1);
    expect(deletedIntents).toEqual([]);
    expect(orphanRecords).toEqual([]);
  });

  it("M. reports recorded=false when neither journal write is durable", async () => {
    noPointerConversation();
    failPersistAndNotPersisted();
    intentRecordImpl = async () => {
      throw new Error("database is closed");
    };
    orphanRecordImpl = async () => {
      throw new Error("database is closed");
    };
    removeImpl = async () => {
      throw new ClientError("Transport", { cause: new Error("offline") });
    };

    let caught: unknown;
    try {
      await ensureOpenCodeSession("conv-1");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeSessionPersistError);
    const failure = caught as InstanceType<typeof OpenCodeSessionPersistError>;
    expect(failure.cleanup).toBe("removal_failed");
    // No durable record exists, so the error must not claim one.
    expect(failure.recorded).toBe(false);
  });

  it("N. still reports recorded=true when the intent survived an orphan-write failure", async () => {
    noPointerConversation();
    failPersistAndNotPersisted();
    // The intent wrote successfully; only the upgrade-to-orphan failed.
    orphanRecordImpl = async () => {
      throw new Error("database is closed");
    };
    removeImpl = async () => {
      throw new ClientError("Transport", { cause: new Error("offline") });
    };

    let caught: unknown;
    try {
      await ensureOpenCodeSession("conv-1");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeSessionPersistError);
    const failure = caught as InstanceType<typeof OpenCodeSessionPersistError>;
    expect(failure.cleanup).toBe("removal_failed");
    // The pre-create intent is still an open, actionable recovery record.
    expect(failure.recorded).toBe(true);
    expect(intentRecords.length).toBe(1);
    expect(deletedIntents).toEqual([]);
  });
});
