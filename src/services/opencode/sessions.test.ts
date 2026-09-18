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
let interruptImpl: () => Promise<unknown>;
let removeImpl: () => Promise<unknown>;

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
    },
  }),
}));

const { openCodeServerManager } = await import("./serverManager");
const { createOpenCodeClient } = await import("./client");
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

  it("G. reads the OpenCode 1.18.29 HTTP 500 (directory gone) as LIVE, not stale", async () => {
    // Measured: the 500 correlates 100% with the session's bound directory
    // having been removed from disk, never with the session being absent.
    // Treating it as dead made TBAi recreate the session on every call.
    getImpl = async () => {
      throw new ClientError("UnexpectedStatus", { cause: { status: 500 } });
    };
    expect(await isOpenCodeSessionLive(stubClient, LIVE_ID)).toBe(true);
  });

  it("G. reads a transport failure as dead (unreachable = cannot verify)", async () => {
    getImpl = async () => {
      throw new ClientError("Transport", {
        cause: Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" }),
      });
    };
    expect(await isOpenCodeSessionLive(stubClient, LIVE_ID)).toBe(false);
  });

  it("reads a malformed response as dead", async () => {
    getImpl = async () => {
      throw new ClientError("UnsupportedContentType");
    };
    expect(await isOpenCodeSessionLive(stubClient, LIVE_ID)).toBe(false);
  });

  it("never throws — an unknown failure reads as dead", async () => {
    getImpl = async () => {
      throw new Error("something unexpected");
    };
    await expect(isOpenCodeSessionLive(stubClient, LIVE_ID)).resolves.toBe(false);
  });

  it("reads a response with no id as dead", async () => {
    getImpl = async () => ({ id: undefined });
    expect(await isOpenCodeSessionLive(stubClient, LIVE_ID)).toBe(false);
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

  it("accepts the V1 wire shape, where the directory is top-level", async () => {
    // OpenCode 1.18.x answers its V1 session route with a flat `directory`, so
    // both shapes are read rather than pinning the seam to one server version.
    getImpl = async () => ({ id: LIVE_ID, directory: "D:\\ws\\chats\\conv-2" });
    expect(await ensureOpenCodeSession("conv-1")).toEqual({
      sessionId: LIVE_ID,
      directory: "D:\\ws\\chats\\conv-2",
    });
  });

  it("prefers the V2 location field when both are present", async () => {
    getImpl = async () => ({
      id: LIVE_ID,
      directory: "D:\\stale",
      location: { directory: "D:\\ws\\current" },
    });
    expect((await ensureOpenCodeSession("conv-1")).directory).toBe("D:\\ws\\current");
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

  it("keeps the 1.18.29 `directory gone` 500 as live, with no scope", async () => {
    // The session exists; its directory is what is missing, so there is nothing
    // to scope to — but it must still be resumed, not replaced.
    getImpl = async () => {
      throw new ClientError("UnexpectedStatus", { cause: { status: 500 } });
    };
    expect(await ensureOpenCodeSession("conv-1")).toEqual({
      sessionId: LIVE_ID,
      directory: null,
    });
  });

  it("recreates when the session is genuinely gone", async () => {
    // A definitive not-found must not be handed back as a live binding: the
    // create path then runs (and throws here, since the stub has no `create`),
    // which is the documented recreate-rather-than-resume direction.
    getImpl = async () => {
      throw sessionNotFound(LIVE_ID);
    };
    await expect(ensureOpenCodeSession("conv-1")).rejects.toThrow();
  });
});
