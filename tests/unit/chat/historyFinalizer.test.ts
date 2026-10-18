import { describe, expect, it } from "bun:test";
import { MessageIdentityError, type HistoryResolution } from "@/services/storage/messages.ts";
import {
  ASSISTANT_UI_STORAGE_FORMAT,
  finalizeDetachedRunHistory,
  toStoredMessageContent,
  type FinalUIMessage,
  type HistoryFinalizerDeps,
  type HistoryFinalizerStore,
} from "@/services/chat-streams/historyFinalizer.ts";

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

function fakeStore(overrides: Partial<FakeStore> = {}): FakeStore {
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
    claimHistory: (_streamId, messageId) => {
      // The real guard: a claim needs a pending row AND a completed run, and only
      // one caller can win it.
      if (store.historyState !== "pending" || store.terminalKind !== "completed") return false;
      store.historyState = "claimed";
      store.claims.push(messageId);
      return true;
    },
    // Mirrors the real transactional guard: the transition and the verification
    // commit together, a verification throw leaves the row untouched, and a row with
    // no conversation can never be closed as `done`.
    completeHistoryWithVerifiedMessage: <T>(
      _streamId: string,
      verify: (context: { conversationId: string; historyMessageId: string | null }) => T,
    ) => {
      if (store.historyState !== "claimed" || store.conversationId === null) {
        return { status: "guard_missed" as const };
      }
      try {
        const resolution = verify({
          conversationId: store.conversationId,
          historyMessageId: store.claims[0] ?? null,
        });
        store.historyState = "done";
        store.completes += 1;
        return { status: "committed" as const, resolution };
      } catch (error) {
        // `completes` is deliberately NOT incremented: the rollback means the
        // `claimed -> done` write never happened.
        return { status: "failed" as const, error, busy: false };
      }
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

/** One call into the message resolver, recorded so the guard's inputs are assertable. */
interface ResolutionCall {
  conversationId: string;
  historyMessageId: string | null;
  messageId: string;
  parentId: string | null;
  format: string;
  content: unknown;
}

/**
 * The finalizer's message dependency, faked at the ONE call the guard makes.
 *
 * `writes` records only resolutions that actually write, so `matched` (already in
 * history) is distinguishable from `written`/`repaired` without reaching into the
 * real store - the same distinction the real transactional resolver makes.
 */
function recordingDeps(
  store: HistoryFinalizerStore,
  options: { failWith?: Error; resolution?: HistoryResolution } = {},
) {
  const writes: WriteCall[] = [];
  const calls: ResolutionCall[] = [];
  const deps: HistoryFinalizerDeps = {
    store,
    messages: {
      resolveMessageForHistorySync: (input) => {
        calls.push({
          conversationId: input.conversationId,
          historyMessageId: input.historyMessageId,
          messageId: input.messageId,
          parentId: input.parentId,
          format: input.format,
          content: input.content,
        });
        if (options.failWith) throw options.failWith;
        const resolution = options.resolution ?? "written";
        if (resolution !== "matched") {
          writes.push({
            conversationId: input.conversationId,
            entry: {
              id: input.messageId,
              parent_id: input.parentId,
              format: input.format,
              content: input.content,
            },
          });
        }
        return resolution;
      },
    },
  };
  return { deps, writes, calls };
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
    {
      name: "an empty parts array",
      responseMessage: assistantMessage({ parts: [] }),
      isAborted: false,
    },
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
    const { deps } = recordingDeps(store, { failWith: new Error("FOREIGN KEY constraint failed") });

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
    // The transaction rolled back: the `claimed -> done` write never happened.
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

describe("history finalizer — the client may have persisted already", () => {
  it("closes the obligation without writing when the message is already in history", async () => {
    const store = fakeStore();
    const { deps, writes } = recordingDeps(store, { resolution: "matched" });

    const outcome = await finalizeDetachedRunHistory(deps, {
      streamId: "run_1",
      responseMessage: assistantMessage(),
      isAborted: false,
      parentId: "msg_user_1",
      log: silentLog,
    });

    expect(outcome).toBe("already_persisted");
    // No write at all: `upsertStored` is ON CONFLICT DO UPDATE, so writing would
    // overwrite the client's own row.
    expect(writes).toHaveLength(0);
    expect(store.completes).toBe(1);
    expect(store.historyState).toBe("done");
  });

  it("resolves against the message's own conversation and the claimed identity", async () => {
    const store = fakeStore();
    const { deps, writes, calls } = recordingDeps(store);

    const outcome = await finalizeDetachedRunHistory(deps, {
      streamId: "run_1",
      responseMessage: assistantMessage(),
      isAborted: false,
      parentId: null,
      log: silentLog,
    });

    // The stream row's conversation is the scope, and the id the CLAIM recorded is the
    // expected identity - not any id the captured message happens to carry.
    expect(calls).toHaveLength(1);
    expect(calls[0].conversationId).toBe("conv_1");
    expect(calls[0].messageId).toBe("msg_assistant_1");
    expect(calls[0].historyMessageId).toBe("msg_assistant_1");
    expect(outcome).toBe("written");
    expect(writes).toHaveLength(1);
  });

  it("reports a repair when a stored row did not match the capture", async () => {
    const store = fakeStore();
    const { deps, writes } = recordingDeps(store, { resolution: "repaired" });

    const outcome = await finalizeDetachedRunHistory(deps, {
      streamId: "run_1",
      responseMessage: assistantMessage(),
      isAborted: false,
      parentId: null,
      log: silentLog,
    });

    expect(outcome).toBe("repaired");
    expect(writes).toHaveLength(1);
    expect(store.historyState).toBe("done");
  });

  it("leaves the row open, and writes nothing, when the stored row contradicts the capture", async () => {
    const store = fakeStore();
    const { deps, writes } = recordingDeps(store);
    // The real resolver's refusals, classified by the caller rather than collapsed
    // into a write failure.
    deps.messages.resolveMessageForHistorySync = () => {
      throw new MessageIdentityError("msg_assistant_1", "identity");
    };

    const outcome = await finalizeDetachedRunHistory(deps, {
      streamId: "run_1",
      responseMessage: assistantMessage(),
      isAborted: false,
      parentId: null,
      log: silentLog,
    });

    expect(outcome).toBe("conflicted");
    expect(writes).toHaveLength(0);
    // NOT skipped: closing it would turn an unresolved reply into a discarded one.
    expect(store.historyState).toBe("claimed");
    expect(store.skips).toBe(0);
  });

  it("checks for the message only after winning the claim", async () => {
    const store = fakeStore({ historyState: "claimed" });
    const { deps, writes, calls } = recordingDeps(store);

    const outcome = await finalizeDetachedRunHistory(deps, {
      streamId: "run_1",
      responseMessage: assistantMessage(),
      isAborted: false,
      parentId: null,
      log: silentLog,
    });

    // The claim is the authority on who may finalize, so a finalizer that lost it
    // must not go looking at — or touching — the message at all.
    expect(outcome).toBe("not_claimed");
    expect(calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it("defers to a live holder instead of stealing or abandoning its claim", async () => {
    const store = fakeStore();
    // The transition misses, but the row read back is still `claimed` WITH a
    // conversation: a live finalizer holds it, or the compare-and-set raced. That is
    // contention — not a lost claim and not a write failure — so the row must be
    // neither stolen nor marked `skipped`.
    store.completeHistoryWithVerifiedMessage = () => ({ status: "guard_missed" });
    const { deps, writes } = recordingDeps(store);

    const outcome = await finalizeDetachedRunHistory(deps, {
      streamId: "run_1",
      responseMessage: assistantMessage(),
      isAborted: false,
      parentId: null,
      log: silentLog,
    });

    expect(outcome).toBe("not_claimed");
    expect(writes).toHaveLength(0);
    expect(store.historyState).toBe("claimed");
    expect(store.skips).toBe(0);
  });
});
