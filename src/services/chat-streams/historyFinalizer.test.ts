import { describe, expect, it } from "bun:test";
import {
  ASSISTANT_UI_STORAGE_FORMAT,
  finalizeDetachedRunHistory,
  toStoredMessageContent,
  type FinalUIMessage,
  type HistoryFinalizerDeps,
  type HistoryFinalizerStore,
} from "./historyFinalizer";

/**
 * Unit tests for the detached-run history finalizer.
 *
 * The store is a stateful fake so the guarded transitions behave like the real
 * ones (a claim can only be won once) and so the idempotency and concurrency
 * guarantees are asserted directly rather than inferred from a route's timing.
 * The route-level trigger — attached vs detached, completed vs failed — is
 * covered in tests/integration/detached-history-finalization.test.ts.
 */

interface FakeStore extends HistoryFinalizerStore {
  claims: string[];
  skips: number;
  completes: number;
  conversationId: string | null;
  historyState: "pending" | "claimed" | "done" | "skipped";
  terminalKind: "completed" | "failed" | "cancelled" | "interrupted";
}

function fakeStore(
  overrides: Partial<FakeStore> = {},
): FakeStore {
  const store: FakeStore = {
    claims: [],
    skips: 0,
    completes: 0,
    conversationId: "conv_1",
    historyState: "pending",
    terminalKind: "completed",
    getRunContext: () => ({
      conversationId: store.conversationId,
      requestId: "req_1",
      providerId: "prov_1",
      modelId: "model_1",
      historyState: store.historyState,
      historyMessageId: store.claims[0] ?? null,
      historyClaimedAt: null,
    }),
    claimHistory: (streamId, messageId) => {
      // The real guard: a claim needs a pending row AND a completed run, and only
      // one caller can win it.
      if (store.historyState !== "pending" || store.terminalKind !== "completed") return false;
      store.historyState = "claimed";
      store.claims.push(messageId);
      return true;
    },
    completeHistory: () => {
      if (store.historyState !== "claimed") return false;
      store.historyState = "done";
      store.completes += 1;
      return true;
    },
    skipHistory: () => {
      if (store.historyState === "done" || store.historyState === "skipped") return false;
      store.historyState = "skipped";
      store.skips += 1;
      return true;
    },
    ...overrides,
  };
  return store;
}

interface WriteCall {
  conversationId: string;
  entry: { id: string; parent_id: string | null; format: string; content: unknown };
}

function recordingDeps(store: HistoryFinalizerStore, failWith?: Error) {
  const writes: WriteCall[] = [];
  const deps: HistoryFinalizerDeps = {
    store,
    upsertStored: async (conversationId, entry) => {
      if (failWith) throw failWith;
      writes.push({ conversationId, entry });
    },
  };
  return { deps, writes };
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function assistantMessage(overrides: Partial<FinalUIMessage> = {}): FinalUIMessage {
  return {
    id: "msg_assistant_1",
    role: "assistant",
    parts: [{ type: "text", text: "the answer", state: "done" }],
    ...overrides,
  };
}

describe("history finalizer — persisted shape", () => {
  it("writes the adapter's shape: the id in the row, never inside content", async () => {
    const store = fakeStore();
    const { deps, writes } = recordingDeps(store);
    const message = assistantMessage({ metadata: { custom: { providerId: "prov_1" } } });

    const outcome = await finalizeDetachedRunHistory(deps, {
      streamId: "run_1",
      responseMessage: message,
      isAborted: false,
      parentId: "msg_user_1",
      log: silentLog,
    });

    expect(outcome).toBe("written");
    expect(writes.length).toBe(1);
    const write = writes[0];
    expect(write.conversationId).toBe("conv_1");
    expect(write.entry.id).toBe("msg_assistant_1");
    expect(write.entry.parent_id).toBe("msg_user_1");
    expect(write.entry.format).toBe(ASSISTANT_UI_STORAGE_FORMAT);
    // `aiSDKV6FormatAdapter.encode` strips the id; storing it in the payload too
    // would diverge from every row the browser has already written.
    expect(write.entry.content).not.toHaveProperty("id");
    expect(write.entry.content).toMatchObject({
      role: "assistant",
      parts: [{ type: "text", text: "the answer", state: "done" }],
      metadata: { custom: { providerId: "prov_1" } },
    });
  });

  it("copies every other key verbatim, so tool and reasoning parts survive", () => {
    const content = toStoredMessageContent(
      assistantMessage({
        parts: [
          { type: "reasoning", text: "thinking" },
          { type: "tool-read_file", toolCallId: "call_1", state: "output-available" },
        ],
      }),
    ) as { parts: Array<{ type: string }> };
    expect(content.parts.map((p) => p.type)).toEqual(["reasoning", "tool-read_file"]);
  });

  it("marks the row done only after the write succeeded", async () => {
    const store = fakeStore();
    const { deps } = recordingDeps(store);
    await finalizeDetachedRunHistory(deps, {
      streamId: "run_1",
      responseMessage: assistantMessage(),
      isAborted: false,
      parentId: null,
      log: silentLog,
    });
    expect(store.historyState).toBe("done");
    expect(store.completes).toBe(1);
  });
});

describe("history finalizer — never fabricates", () => {
  const cases: Array<{
    name: string;
    responseMessage: FinalUIMessage | null;
    isAborted: boolean;
  }> = [
    { name: "no final message at all", responseMessage: null, isAborted: false },
    { name: "an aborted run", responseMessage: assistantMessage(), isAborted: true },
    { name: "an empty parts array", responseMessage: assistantMessage({ parts: [] }), isAborted: false },
    {
      name: "a message with no id",
      responseMessage: assistantMessage({ id: "" }),
      isAborted: false,
    },
    {
      name: "a non-assistant message",
      responseMessage: assistantMessage({ role: "user" }),
      isAborted: false,
    },
  ];

  for (const testCase of cases) {
    it(`writes nothing and reports a typed skip for ${testCase.name}`, async () => {
      const store = fakeStore();
      const { deps, writes } = recordingDeps(store);

      const outcome = await finalizeDetachedRunHistory(deps, {
        streamId: "run_1",
        responseMessage: testCase.responseMessage,
        isAborted: testCase.isAborted,
        parentId: "msg_user_1",
        log: silentLog,
      });

      expect(outcome).toBe("skipped");
      expect(writes.length).toBe(0);
      // The row is closed out rather than left `pending` to be retried forever.
      expect(store.historyState).toBe("skipped");
      expect(store.skips).toBe(1);
    });
  }

  it("skips explicitly when the run has no conversation to write into", async () => {
    const store = fakeStore({ conversationId: null });
    const { deps, writes } = recordingDeps(store);

    const outcome = await finalizeDetachedRunHistory(deps, {
      streamId: "run_1",
      responseMessage: assistantMessage(),
      isAborted: false,
      parentId: null,
      log: silentLog,
    });

    expect(outcome).toBe("skipped");
    expect(writes.length).toBe(0);
    expect(store.historyState).toBe("skipped");
  });
});

describe("history finalizer — exactly once", () => {
  it("writes nothing when the claim is lost, so a second finalizer is a no-op", async () => {
    const store = fakeStore();
    const { deps, writes } = recordingDeps(store);
    const input = {
      streamId: "run_1",
      responseMessage: assistantMessage(),
      isAborted: false,
      parentId: null,
      log: silentLog,
    };

    expect(await finalizeDetachedRunHistory(deps, input)).toBe("written");
    // A duplicate callback, a lifecycle hook firing twice, a re-entrant call.
    expect(await finalizeDetachedRunHistory(deps, input)).toBe("not_claimed");
    expect(await finalizeDetachedRunHistory(deps, input)).toBe("not_claimed");
    expect(writes.length).toBe(1);
  });

  it("produces exactly one write under concurrent finalization", async () => {
    const store = fakeStore();
    const { deps, writes } = recordingDeps(store);
    const input = {
      streamId: "run_1",
      responseMessage: assistantMessage(),
      isAborted: false,
      parentId: null,
      log: silentLog,
    };

    const outcomes = await Promise.all([
      finalizeDetachedRunHistory(deps, input),
      finalizeDetachedRunHistory(deps, input),
      finalizeDetachedRunHistory(deps, input),
    ]);

    expect(outcomes.filter((o) => o === "written").length).toBe(1);
    expect(writes.length).toBe(1);
    expect(store.completes).toBe(1);
  });

  it("refuses to finalize a run that did not complete", async () => {
    for (const terminalKind of ["failed", "cancelled", "interrupted"] as const) {
      const store = fakeStore({ terminalKind });
      const { deps, writes } = recordingDeps(store);
      const outcome = await finalizeDetachedRunHistory(deps, {
        streamId: "run_1",
        responseMessage: assistantMessage(),
        isAborted: false,
        parentId: null,
        log: silentLog,
      });
      expect(outcome).toBe("not_claimed");
      expect(writes.length).toBe(0);
      expect(store.historyState).toBe("pending");
    }
  });
});

describe("history finalizer — failure handling", () => {
  it("never leaves a bare claim behind when the write throws", async () => {
    const store = fakeStore();
    // A foreign-key failure is the realistic case: the conversation was deleted
    // while the run was streaming.
    const { deps } = recordingDeps(store, new Error("FOREIGN KEY constraint failed"));

    const outcome = await finalizeDetachedRunHistory(deps, {
      streamId: "run_1",
      responseMessage: assistantMessage(),
      isAborted: false,
      parentId: null,
      log: silentLog,
    });

    expect(outcome).toBe("failed");
    // `claimed` with no recovery path would silently lose an otherwise good reply.
    expect(store.historyState).toBe("skipped");
    expect(store.completes).toBe(0);
  });

  it("never throws, whatever the store or the message service does", async () => {
    const store = fakeStore({
      claimHistory: () => {
        throw new Error("database is locked");
      },
    });
    const { deps } = recordingDeps(store);
    await expect(
      finalizeDetachedRunHistory(deps, {
        streamId: "run_1",
        responseMessage: assistantMessage(),
        isAborted: false,
        parentId: null,
        log: silentLog,
      }),
    ).resolves.toBe("failed");
  });
});
