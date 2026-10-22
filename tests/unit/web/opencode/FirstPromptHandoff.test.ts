import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { REPO_ROOT } from "../../../helpers/repo-root";
import path from "node:path";
import {
  fireFirstPromptHandoff,
  isSessionThreadBound,
} from "@web/features/opencode/FirstPromptHandoff.tsx";
import {
  claimPendingFirstMessage,
  peekPendingFirstMessage,
  setPendingFirstMessage,
} from "@web/features/chat/state/pendingFirstMessage.ts";
import { V2_PROMPT_MESSAGE_ID_KEY } from "@web/features/opencode/sync/optimistic.ts";

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
    expect(isSessionThreadBound({ remoteId: "ses_2", externalId: "ses_2" }, "ses_1")).toBe(false);
  });

  it("missing session id never binds", () => {
    expect(isSessionThreadBound({ remoteId: "ses_1", externalId: "ses_1" }, undefined)).toBe(false);
  });

  it("externalId wins, remoteId is the fallback", () => {
    expect(isSessionThreadBound({ remoteId: "ses_1", externalId: "ses_1" }, "ses_1")).toBe(true);
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
    expect(claimPendingFirstMessage("conv-draft")?.text).toBe("hello code");
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

describe("fireFirstPromptHandoff — a failed dispatch is not retried automatically", () => {
  it("M19: a rejected append is not dispatched again by a later settled attempt", async () => {
    // The dispatch may have reached the server and only its answer was lost.
    // Re-dispatching it on the next settled observation is how a message gets
    // delivered twice, so a failed handoff is inert until the user sends
    // again. The old behaviour released the claim and the next observation
    // re-sent the same prompt.
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

    // A later settled attempt finds nothing to dispatch.
    const second = await fireFirstPromptHandoff({
      conversationId: "conv-retry",
      sessionId: "ses_1",
      boundSessionId: "ses_1",
      append: (text) => {
        appendCalls.push(text);
        return Promise.resolve();
      },
    });
    expect(second).toBe("none");
    expect(appendCalls).toEqual(["precious prompt"]);
    // The failed entry is still there, marked failed, so the reader can see
    // that it did not go through.
    expect(peekPendingFirstMessage("conv-retry")?.failed).toBe(true);
  });

  it("M13: a crash between the claim and the dispatch resumes the SAME prompt", async () => {
    // The claim carries the message id, so the resumed dispatch is the same
    // prompt server-side - the server admits a repeated id as the existing
    // prompt - and the reader's message is not lost.
    //
    // A CRASH, not a failed dispatch. The two are different contracts:
    //
    // - a **failed dispatch** marks the entry failed, and a failed entry is
    //   never dispatched again automatically (M19) - the reader decides;
    // - a **crash** leaves the entry CLAIMED in storage with its id, and the
    //   next mount finds it and resumes it.
    //
    // So the first dispatch is ABANDONED here - the promise never settles,
    // because the process that would settle it is gone. That is what a crash
    // is, and it is the only state a resume can happen from.
    setPendingFirstMessage("conv-crash", "precious prompt");
    const sentIds: string[] = [];
    // Never settles: the tab is gone.
    const abandoned = new Promise<void>(() => undefined);
    void fireFirstPromptHandoff({
      conversationId: "conv-crash",
      sessionId: "ses_1",
      boundSessionId: "ses_1",
      append: () => Promise.resolve(),
      sendWithId: (message) => {
        sentIds.push(String(message.metadata?.custom?.[V2_PROMPT_MESSAGE_ID_KEY] ?? ""));
        return abandoned;
      },
    });
    // The dispatch is in flight: the entry is claimed, with an id.
    const claimed = peekPendingFirstMessage("conv-crash");
    expect(claimed?.claimed).toBe(true);
    expect(claimed?.messageId).toBeTruthy();
    // And it is NOT marked failed - a crash is not a failure.
    expect(claimed?.failed).toBeFalsy();

    // A fresh mount (the same storage) resumes it, with the SAME id.
    //
    // NOTHING is re-staged here, and that is the point of the case: a crash
    // leaves the entry in storage, CLAIMED, with the id the first dispatch
    // carried. The fresh mount finds that entry and resumes it.
    //
    // The old setup called `setPendingFirstMessage` again, which OVERWRITES
    // the entry with a fresh one - and a fresh one has a fresh id. So the
    // resume could never carry the same id, and the case could not have
    // detected it if it had not.
    const resumed = await fireFirstPromptHandoff({
      conversationId: "conv-crash",
      sessionId: "ses_1",
      boundSessionId: "ses_1",
      append: () => Promise.resolve(),
      sendWithId: (message) => {
        sentIds.push(String(message.metadata?.custom?.[V2_PROMPT_MESSAGE_ID_KEY] ?? ""));
        return Promise.resolve();
      },
    });
    expect(resumed).toBe("sent");
    // The ids are REAL. Without this the equality below would compare two
    // empty strings - which is what happened when the test read a metadata
    // key the code never writes: `?? ""` turned "no id" into "", and
    // `expect("").toBe("")` passed for the wrong reason.
    expect(sentIds[0]).not.toBe("");
    expect(sentIds[1]).not.toBe("");
    // And the resumed dispatch carries the SAME id, so the server admits it
    // as the SAME prompt rather than a second one.
    expect(sentIds[0]).toBe(sentIds[1]);
  });
});

describe("FirstPromptHandoff — structural boundary pins", () => {
  it("gates on the bound session identity and never initializes a draft thread", async () => {
    const source = await Bun.file(
      path.join(REPO_ROOT, "web/src/features/opencode/FirstPromptHandoff.tsx"),
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
    // Null-render boundary with claim -> dispatch -> clear.
    expect(source).toContain("claimPendingFirstMessage(conversationId)");
    expect(source).toContain("runtime.thread.append(text)");
    expect(source).toContain("clearPendingFirstMessage(conversationId)");
    // M19 CHANGED THIS. The failure path marks the entry FAILED rather than
    // releasing the claim: a dispatch that failed may have reached the server,
    // and the next settled observation must not send the prompt again. The
    // old contract released the claim, and the release is what re-sent it.
    expect(source).toContain("markPendingFirstMessageFailed(conversationId)");
    expect(source).not.toContain("unclaimPendingFirstMessage");
    expect(source).toContain("return null");
  });

  it("OpenCodeView hosts the boundary inside the provider with no competing consumer", async () => {
    const source = await Bun.file(
      path.join(REPO_ROOT, "web/src/features/opencode/OpenCodeView.tsx"),
    ).text();
    expect(source).toContain("<FirstPromptHandoff");
    // The old racing effect is gone: exactly one first-prompt consumer.
    expect(source).not.toContain("claimPendingFirstMessage(conversationId)");
  });

  it("recovery reconnects only on epoch change while mounted, never on stale mount", async () => {
    const source = await Bun.file(
      path.join(REPO_ROOT, "web/src/features/opencode/OpenCodeView.tsx"),
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
