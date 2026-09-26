import { describe, it, expect, mock, beforeEach } from "bun:test";
import { ClientError } from "@opencode/client";

/**
 * Tests for session termination (V2 interrupt -> remove) and the liveness probe.
 *
 * Isolation: `sessions.ts` reaches the outside world through three seams —
 * `conversationService` (storage), `openCodeServerManager.ensureBaseUrl`
 * (process ownership) and `createOpenCodeClient` (the official V2 client).
 * All three are stubbed, so no process is spawned, no database is opened and
 * no network I/O happens. Only the V2 call sequence and the error handling
 * under test are real.
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

const SUBMITTED_DIRECTORY = "D:\\ws\\chats\\conv-1";
const CREATED_SESSION_ID = "ses_created00000000000000000000";

/** Rejection carrying the V2 tagged body the official client throws on a 404. */
function sessionNotFound(sessionID: string): unknown {
  return { _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` };
}

mock.module("../storage", () => ({
  conversationService: {
    get: async () => conversation,
    update: async (id: string, patch: unknown) => {
      updates.push({ id, patch });
    },
  },
}));

mock.module("../workspace", () => ({
  resolveConversationWorkspace: async () => ({ dir: SUBMITTED_DIRECTORY }),
}));

mock.module("./client", () => ({
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
      create: (args: {
        location: { directory: string };
        agent?: string;
        model?: unknown;
      }) => {
        calls.push(`create:${args.location.directory}`);
        return createImpl(args);
      },
    },
  }),
}));

const { openCodeServerManager } = await import("./serverManager");
const { createOpenCodeClient } = await import("./client");
const { OpenCodeError } = await import("./errors");
const { terminateOpenCodeSession, isOpenCodeSessionLive, ensureOpenCodeSession } =
  await import("./sessions");

(openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> })
  .ensureBaseUrl = async () => "http://127.0.0.1:0";

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
});

describe("terminateOpenCodeSession — V2 call mapping", () => {
  it("B/C. calls session.interrupt then session.remove with the stored id", async () => {
    const result = await terminateOpenCodeSession("conv-1");
    expect(calls).toEqual([`interrupt:${LIVE_ID}`, `remove:${LIVE_ID}`]);
    expect(result).toEqual({ terminated: true });
  });

  it("D. preserves lifecycle order: interrupt strictly before remove", async () => {
    await terminateOpenCodeSession("conv-1");
    expect(calls.indexOf(`interrupt:${LIVE_ID}`)).toBeLessThan(
      calls.indexOf(`remove:${LIVE_ID}`),
    );
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

  it("D. stays best-effort: a failing remove still clears the pointer", async () => {
    removeImpl = async () => {
      throw sessionNotFound(LIVE_ID);
    };
    const result = await terminateOpenCodeSession("conv-1");
    expect(result).toEqual({ terminated: true });
    expect(updates).toEqual([{ id: "conv-1", patch: { opencodeSessionId: null } }]);
  });

  it("D. stays best-effort when BOTH calls fail", async () => {
    interruptImpl = async () => {
      throw new ClientError("Transport", { cause: new Error("boom") });
    };
    removeImpl = async () => {
      throw new ClientError("UnexpectedStatus", { cause: { status: 500 } });
    };
    const result = await terminateOpenCodeSession("conv-1");
    expect(calls).toEqual([`interrupt:${LIVE_ID}`, `remove:${LIVE_ID}`]);
    expect(result).toEqual({ terminated: true });
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
    });
  });

  it("reports no scope rather than guessing when the server names none", async () => {
    // A null scope is honest: the runtime then leaves its subscription unscoped
    // (the previous behaviour) instead of scoping to an invented path.
    getImpl = async () => ({ id: LIVE_ID });
    expect(await ensureOpenCodeSession("conv-1")).toEqual({
      sessionId: LIVE_ID,
      directory: null,
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
    });
    expect(calls).toEqual([`get:${LIVE_ID}`, `create:${SUBMITTED_DIRECTORY}`]);
    expect(updates).toEqual([
      { id: "conv-1", patch: { opencodeSessionId: CREATED_SESSION_ID } },
    ]);
  });

  it("falls back to the submitted directory when a create response omits location", async () => {
    // A partial native V2 response still supplies a session id. When it omits
    // location, the request's submitted workspace remains the honest fallback.
    conversation = { engine: "opencode", opencodeSessionId: null };
    createImpl = async () => ({ id: CREATED_SESSION_ID });

    expect(await ensureOpenCodeSession("conv-1")).toEqual({
      sessionId: CREATED_SESSION_ID,
      directory: SUBMITTED_DIRECTORY,
    });
    expect(calls).toEqual([`create:${SUBMITTED_DIRECTORY}`]);
    expect(updates).toEqual([
      { id: "conv-1", patch: { opencodeSessionId: CREATED_SESSION_ID } },
    ]);
  });
});
