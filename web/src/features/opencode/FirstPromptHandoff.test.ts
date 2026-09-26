import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  fireFirstPromptHandoff,
  isSessionThreadBound,
} from "./FirstPromptHandoff";
import {
  claimPendingFirstMessage,
  peekPendingFirstMessage,
  setPendingFirstMessage,
} from "../chat/state/pendingFirstMessage";

/**
 * Settled-boundary first-prompt handoff.
 *
 * The stashed draft prompt must enter the runtime only after the runtime's
 * main thread is bound to the bootstrapped native V2 session id. Firing on
 * the draft thread can target the wrong session during a thread switch and
 * race the settled handoff boundary.
 *
 * Deterministic: controllable deferred promises as barriers, no sleeps.
 */

function installMemoryStorage(): () => void {
  const holder = globalThis as unknown as { localStorage?: unknown };
  const prev = holder.localStorage;
  const store = new Map<string, string>();
  holder.localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  return () => {
    if (prev === undefined) delete holder.localStorage;
    else holder.localStorage = prev;
  };
}

let restoreStorage: (() => void) | null = null;
beforeEach(() => {
  restoreStorage = installMemoryStorage();
});
afterEach(() => {
  restoreStorage?.();
  restoreStorage = null;
});

describe("isSessionThreadBound — settled-boundary predicate", () => {
  it("draft thread (no identity) is not bound", () => {
    expect(isSessionThreadBound(undefined, "ses_1")).toBe(false);
    expect(isSessionThreadBound(null, "ses_1")).toBe(false);
    expect(isSessionThreadBound({}, "ses_1")).toBe(false);
  });

  it("wrong thread identity is not bound", () => {
    expect(isSessionThreadBound({ remoteId: "draft-1" }, "ses_1")).toBe(false);
    expect(
      isSessionThreadBound({ remoteId: "ses_2", externalId: "ses_2" }, "ses_1"),
    ).toBe(false);
  });

  it("missing session id never binds", () => {
    expect(
      isSessionThreadBound({ remoteId: "ses_1", externalId: "ses_1" }, undefined),
    ).toBe(false);
  });

  it("externalId wins, remoteId is the fallback", () => {
    expect(
      isSessionThreadBound({ remoteId: "ses_1", externalId: "ses_1" }, "ses_1"),
    ).toBe(true);
    expect(isSessionThreadBound({ remoteId: "ses_1" }, "ses_1")).toBe(true);
  });
});

describe("fireFirstPromptHandoff — draft thread never appends", () => {
  it("pending prompt + session id but unbound thread: no append, stash retained", async () => {
    setPendingFirstMessage("conv-draft", "hello code");
    const appendCalls: string[] = [];
    const outcome = await fireFirstPromptHandoff({
      conversationId: "conv-draft",
      sessionId: "ses_1",
      boundSessionId: undefined,
      append: (text) => {
        appendCalls.push(text);
        return Promise.resolve();
      },
    });
    expect(outcome).toBe("skipped");
    expect(appendCalls).toHaveLength(0);
    // Still staged (and unclaimed) for the settled attempt.
    expect(peekPendingFirstMessage("conv-draft")?.text).toBe("hello code");
    expect(claimPendingFirstMessage("conv-draft")).toBe("hello code");
  });

  it("wrong thread identity: no append, stash retained", async () => {
    setPendingFirstMessage("conv-wrong", "do not lose me");
    const appendCalls: string[] = [];
    const outcome = await fireFirstPromptHandoff({
      conversationId: "conv-wrong",
      sessionId: "ses_1",
      boundSessionId: "ses_other",
      append: (text) => {
        appendCalls.push(text);
        return Promise.resolve();
      },
    });
    expect(outcome).toBe("skipped");
    expect(appendCalls).toHaveLength(0);
    expect(peekPendingFirstMessage("conv-wrong")?.text).toBe("do not lose me");
  });

  it("no session id: no append", async () => {
    setPendingFirstMessage("conv-nosession", "waiting");
    const appendCalls: string[] = [];
    const outcome = await fireFirstPromptHandoff({
      conversationId: "conv-nosession",
      sessionId: undefined,
      boundSessionId: undefined,
      append: (text) => {
        appendCalls.push(text);
        return Promise.resolve();
      },
    });
    expect(outcome).toBe("skipped");
    expect(appendCalls).toHaveLength(0);
  });
});

describe("fireFirstPromptHandoff — settled thread appends exactly once", () => {
  it("bound thread claims, appends, and clears behind a deferred barrier", async () => {
    setPendingFirstMessage("conv-settled", "build me a widget");
    const appendCalls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = fireFirstPromptHandoff({
      conversationId: "conv-settled",
      sessionId: "ses_1",
      boundSessionId: "ses_1",
      append: (text) => {
        appendCalls.push(text);
        return gate;
      },
    });
    // Synchronous prefix ran before the barrier resolves: claimed + one append.
    expect(appendCalls).toEqual(["build me a widget"]);
    release();
    expect(await pending).toBe("sent");
    // Consumed: a later settled observation finds nothing to refire.
    expect(peekPendingFirstMessage("conv-settled")).toBeNull();
  });

  it("duplicate lifecycle observations refire nothing (claim semantics, no second store)", async () => {
    setPendingFirstMessage("conv-dup", "once only");
    const appendCalls: string[] = [];
    const call = () =>
      fireFirstPromptHandoff({
        conversationId: "conv-dup",
        sessionId: "ses_1",
        boundSessionId: "ses_1",
        append: (text) => {
          appendCalls.push(text);
          return Promise.resolve();
        },
      });
    expect(await call()).toBe("sent");
    expect(await call()).toBe("none");
    expect(await call()).toBe("none");
    expect(appendCalls).toEqual(["once only"]);
  });
});

describe("fireFirstPromptHandoff — append failure unclaims for retry", () => {
  it("rejected append releases the claim; a later settled attempt consumes it", async () => {
    setPendingFirstMessage("conv-retry", "precious prompt");
    const appendCalls: string[] = [];
    let rejectGate!: (err: unknown) => void;
    const gate = new Promise<void>((_resolve, reject) => {
      rejectGate = reject;
    });
    const first = fireFirstPromptHandoff({
      conversationId: "conv-retry",
      sessionId: "ses_1",
      boundSessionId: "ses_1",
      append: (text) => {
        appendCalls.push(text);
        return gate;
      },
    });
    expect(appendCalls).toEqual(["precious prompt"]);
    rejectGate(new Error("run failed"));
    expect(await first).toBe("failed");
    // Unclaimed, not lost: the retry consumes it exactly once more.
    const second = await fireFirstPromptHandoff({
      conversationId: "conv-retry",
      sessionId: "ses_1",
      boundSessionId: "ses_1",
      append: (text) => {
        appendCalls.push(text);
        return Promise.resolve();
      },
    });
    expect(second).toBe("sent");
    expect(appendCalls).toEqual(["precious prompt", "precious prompt"]);
    expect(peekPendingFirstMessage("conv-retry")).toBeNull();
  });
});

describe("FirstPromptHandoff — structural boundary pins", () => {
  it("gates on the bound session identity and never initializes a draft thread", async () => {
    const source = await Bun.file(
      new URL("./FirstPromptHandoff.tsx", import.meta.url),
    ).text();
    // Settled boundary: externalId wins, remoteId is the fallback.
    expect(source).toContain("threadListItem.externalId ??");
    expect(source).toContain("boundSessionId !== sessionId");
    // The handoff never drives thread-list initialization itself; a
    // wrong-thread or switch race leaves the prompt staged for the bound
    // native V2 session.
    expect(source).not.toContain(".initialize(");
    expect(source).not.toContain("/api/opencode/session");
    expect(source).not.toContain("session.create");
    // No timers, no navigation, no second runtime.
    expect(source).not.toContain("setTimeout");
    expect(source).not.toContain("useNavigate");
    expect(source).not.toContain("AssistantRuntimeProvider");
    // Null-render boundary with claim → append → clear/unclaim.
    expect(source).toContain("claimPendingFirstMessage(conversationId)");
    expect(source).toContain("runtime.thread.append(text)");
    expect(source).toContain("clearPendingFirstMessage(conversationId)");
    expect(source).toContain("unclaimPendingFirstMessage(conversationId)");
    expect(source).toContain("return null");
  });

  it("OpenCodeView hosts the boundary inside the provider with no competing consumer", async () => {
    const source = await Bun.file(
      new URL("./OpenCodeView.tsx", import.meta.url),
    ).text();
    expect(source).toContain("<FirstPromptHandoff");
    // The old racing effect is gone: exactly one first-prompt consumer.
    expect(source).not.toContain("claimPendingFirstMessage(conversationId)");
  });

  it("recovery reconnects only on epoch change while mounted, never on stale mount", async () => {
    const source = await Bun.file(
      new URL("./OpenCodeView.tsx", import.meta.url),
    ).text();
    // Previous-epoch ref + pure gate: mount records, transitions reconnect.
    expect(source).toContain("seenRecoveryEpochRef");
    expect(source).toContain("shouldReconnectForEpoch({");
    // The old unconditional mount-time reconnect is gone.
    expect(source).not.toContain("if (recoveryEpoch === 0 || !sessionId) return;");
    // The reconnect seam itself is untouched.
    expect(source).toContain("reconnect();");
  });
});
