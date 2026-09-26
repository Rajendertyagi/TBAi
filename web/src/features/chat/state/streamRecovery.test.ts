import { describe, expect, it, beforeEach } from "bun:test";
import {
  classifyStreamStatus,
  fetchConversationRunStatus,
  resolveStreamRecovery,
  setRecheckDelaysForTests,
  useStreamRecoveryStore,
  type StreamStatus,
} from "./streamRecovery";

/**
 * The recovery decision is the one place in Phase 3 where a wrong answer creates
 * a DUPLICATE assistant message, so it is tested as a safety property rather than
 * as UI behaviour: Retry must be impossible for every terminal kind except the
 * one a live send can never produce.
 */

const BASE: StreamStatus = {
  streamId: "s1",
  status: "error",
  terminalKind: "interrupted",
  restarted: true,
  historyState: "skipped",
  chunkCount: 3,
  byteLen: 120,
  ageMs: 5_000,
  finalizedAgeMs: 1_000,
};

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 404,
    headers: { "Content-Type": "application/json" },
  });
}

describe("stream recovery — the Retry safety gate", () => {
  it("allows Retry only for a run the server reports as interrupted", () => {
    expect(classifyStreamStatus({ terminalKind: "interrupted" }, "do the thing")).toEqual({
      reason: "interrupted",
      canRetry: true,
    });
  });

  it("withholds Retry when the prompt was lost with the crashed run", () => {
    // Observed live: a crashed run's user message is never written to history
    // (the server was down when the browser tried), so there is nothing to
    // re-send. The strip still explains, but a button that silently does nothing
    // is worse than no button.
    expect(classifyStreamStatus({ terminalKind: "interrupted" }, "")).toEqual({
      reason: "interrupted",
      canRetry: false,
    });
    expect(classifyStreamStatus({ terminalKind: "interrupted" }, "   ").canRetry).toBe(false);
  });

  it("refuses Retry for a run that completed — the duplicate-reply case", () => {
    // A completed run already has its answer in history. Offering Retry here is
    // the one bug that produces a second assistant message for it.
    expect(classifyStreamStatus({ terminalKind: "completed" }, "hi").canRetry).toBe(false);
  });

  it.each(["failed", "cancelled"] as const)(
    "refuses Retry for a %s run the user just watched fail",
    (terminalKind) => {
      expect(classifyStreamStatus({ terminalKind }, "hi").canRetry).toBe(false);
    },
  );

  it("refuses Retry when the terminal state cannot be read at all", () => {
    // Failing toward "no button" is the only safe direction: an unconfirmed run
    // might be a completed one.
    expect(classifyStreamStatus(null, "hi")).toEqual({ reason: "unavailable", canRetry: false });
  });

  it("refuses Retry while a run is still streaming", () => {
    expect(classifyStreamStatus({ terminalKind: null }, "hi").canRetry).toBe(false);
  });
});

describe("stream recovery — durable status read", () => {
  it("asks about the CONVERSATION, not a stream id the client may have lost", async () => {
    const seen: string[] = [];
    const status = await fetchConversationRunStatus("conv 1/x", async (input) => {
      seen.push(String(input));
      return jsonResponse({ run: BASE });
    });
    expect(status).toMatchObject({ terminalKind: "interrupted", restarted: true });
    // The conversation id is encoded, and no stream id is involved at all: this is
    // what makes recovery survive a transport-cleared pointer and an app restart.
    expect(seen[0]).toBe("/api/chat/stream-status?conversationId=conv%201%2Fx");
  });

  it("reports no run as null, which is the normal state of an unanswered thread", async () => {
    const status = await fetchConversationRunStatus("c1", async () => jsonResponse({ run: null }));
    expect(status).toBeNull();
  });

  it("treats a non-OK status as unknown rather than guessing", async () => {
    const status = await fetchConversationRunStatus("c1", async () => jsonResponse({}, false));
    expect(status).toBeNull();
  });

  it("treats a transport failure as unknown rather than throwing", async () => {
    const status = await fetchConversationRunStatus("c1", async () => {
      throw new Error("network down");
    });
    expect(status).toBeNull();
  });
});

describe("stream recovery — published state", () => {
  beforeEach(() => {
    setRecheckDelaysForTests(null);
    useStreamRecoveryStore.getState().clearAll();
  });

  it("publishes a per-thread state and clears only that thread", async () => {
    await resolveStreamRecovery("thread_a", "hello", { fetchImpl: async () => jsonResponse({ run: BASE }) });
    await resolveStreamRecovery("thread_b", "hello", {
      fetchImpl: async () => jsonResponse({ run: { ...BASE, terminalKind: "completed" } }),
    });

    const { byThread } = useStreamRecoveryStore.getState();
    expect(byThread.thread_a).toMatchObject({
      reason: "interrupted",
      canRetry: true,
      prompt: "hello",
      streamId: "s1",
    });
    expect(byThread.thread_b).toMatchObject({ reason: "unavailable", canRetry: false });

    useStreamRecoveryStore.getState().clear("thread_a");
    expect(useStreamRecoveryStore.getState().byThread.thread_a).toBeUndefined();
    // One thread's notice never silences another's.
    expect(useStreamRecoveryStore.getState().byThread.thread_b).toBeDefined();
  });

  it("publishes nothing for a thread that has no run at all", async () => {
    // A fresh conversation must not be nagged with a recovery notice.
    await resolveStreamRecovery("thread_empty", "", { fetchImpl: async () => jsonResponse({ run: null }) });
    expect(useStreamRecoveryStore.getState().byThread.thread_empty).toBeUndefined();
  });

  it("clears a stale notice when the conversation's run is now healthy", async () => {
    await resolveStreamRecovery("thread_f", "hi", { fetchImpl: async () => jsonResponse({ run: BASE }) });
    expect(useStreamRecoveryStore.getState().byThread.thread_f).toBeDefined();
    await resolveStreamRecovery("thread_f", "hi", {
      fetchImpl: async () => jsonResponse({ run: { ...BASE, status: "streaming", terminalKind: null } }),
    });
    expect(useStreamRecoveryStore.getState().byThread.thread_f).toBeUndefined();
  });

  it("keeps an UNCONFIRMED notice when a failed run's status cannot be read yet", async () => {
    // The case that decides the whole design: a crash is detected while the
    // backend is DOWN, so the status is unreadable at exactly the moment the
    // notice is created. Erasing it here left the later recovery check with
    // nothing to re-check, and the user never got a Retry.
    const offline = {
      fetchImpl: async () => {
        throw new Error("offline");
      },
    };
    const failed = await resolveStreamRecovery("thread_g", "the prompt", {
      ...offline,
      assumeRun: true,
    });
    expect(failed.state.reason).toBe("unavailable");
    expect(failed.state.canRetry).toBe(false);
    expect(failed.status).toBeNull();
    // The notice survives, carrying the prompt, so the recovery check can upgrade
    // it once the server can answer.
    expect(useStreamRecoveryStore.getState().byThread.thread_g).toMatchObject({
      reason: "unavailable",
      canRetry: false,
      prompt: "the prompt",
    });

    // And the upgrade: the same thread, now answerable.
    const upgraded = await resolveStreamRecovery("thread_g", "the prompt", {
      fetchImpl: async () => jsonResponse({ run: BASE }),
    });
    expect(upgraded.state.canRetry).toBe(true);
    expect(useStreamRecoveryStore.getState().byThread.thread_g?.reason).toBe("interrupted");
  });

  it("keeps asking until the verdict arrives, then upgrades to a real Retry", async () => {
    // The convergence loop, which is the mechanism verified live against a real
    // provider: the failure is detected while the backend is DOWN, so the first
    // read always fails, and the notice is only useful if something asks again.
    setRecheckDelaysForTests([5, 10, 20]);
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      // Down for the first two attempts, then the backend answers.
      if (calls <= 2) throw new Error("offline");
      return jsonResponse({ run: BASE });
    };

    await resolveStreamRecovery("thread_loop", "rebuild the bridge", {
      assumeRun: true,
      fetchImpl: flaky,
    });
    expect(calls).toBe(1);
    expect(useStreamRecoveryStore.getState().byThread.thread_loop?.canRetry).toBe(false);

    // Wait for the chain to converge on its own.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (useStreamRecoveryStore.getState().byThread.thread_loop?.canRetry) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const settled = useStreamRecoveryStore.getState().byThread.thread_loop;
    expect(settled?.reason).toBe("interrupted");
    expect(settled?.canRetry).toBe(true);
    // The prompt survived, which is what makes the Retry a real re-send.
    expect(settled?.prompt).toBe("rebuild the bridge");
    expect(calls).toBeGreaterThanOrEqual(3);
  }, 10000);

  it("stops asking once the notice is cleared, and gives up after its attempts", async () => {
    setRecheckDelaysForTests([5, 10]);
    let calls = 0;
    await resolveStreamRecovery("thread_giveup", "hi", {
      assumeRun: true,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("still offline");
      },
    });
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // Bounded: 1 initial read + 2 retries, then it stops rather than polling.
    expect(calls).toBe(3);
    // And the unconfirmed notice is still there for the user, just without a Retry.
    expect(useStreamRecoveryStore.getState().byThread.thread_giveup?.canRetry).toBe(false);

    // Clearing the thread cancels any pending attempt.
    useStreamRecoveryStore.getState().clear("thread_giveup");
    const before = calls;
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(before);
  }, 10000);

  it("publishes nothing when the status is unreadable and no run is known", async () => {    // No evidence at all: a thread nobody asked a question on. Publishing here
    // would nag on every fresh conversation.
    await resolveStreamRecovery("thread_h", "", {
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(useStreamRecoveryStore.getState().byThread.thread_h).toBeUndefined();
  });

  it("returns the status so the caller can tell a dead run from a live one", async () => {
    const terminal = await resolveStreamRecovery("thread_d", "hi", {
      fetchImpl: async () => jsonResponse({ run: { ...BASE, status: "error", terminalKind: "interrupted" } }),
    });
    expect(terminal.status?.status).toBe("error");

    const live = await resolveStreamRecovery("thread_e", "hi", {
      fetchImpl: async () => jsonResponse({ run: { ...BASE, status: "streaming", terminalKind: null } }),
    });
    // A live producer must keep its resume pointer — this is the distinction that
    // stops the client re-resuming a dead stream forever while never cutting off a
    // run that is genuinely still going.
    expect(live.status?.status).toBe("streaming");
  });
});
