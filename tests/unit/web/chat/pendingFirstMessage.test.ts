import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { REPO_ROOT } from "../../../helpers/repo-root";
import path from "node:path";
import {
  setPendingFirstMessage,
  peekPendingFirstMessage,
  claimPendingFirstMessage,
  markPendingFirstMessageFailed,
  clearPendingFirstMessage,
} from "@web/features/chat/state/pendingFirstMessage";

/**
 * The pending first-prompt handoff's storage contract.
 *
 * The module owns one invariant: a materialized OpenCode draft has AT MOST
 * ONE pending first-prompt handoff, fired EXACTLY ONCE into the session-bound
 * runtime. These tests pin the storage contract the OpenCodeView consume
 * effect depends on:
 *   - single-slot overwrite, empty no-op, corrupt/empty -> null
 *   - the claim carries the message id, so a crash between the claim and the
 *     dispatch can RESUME the same prompt (M13)
 *   - a FAILED dispatch is never dispatched again automatically (M19)
 *   - consume-once across a simulated remount
 *   - no timer-based waits in this module
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

describe("pendingFirstMessage — staging contract", () => {
  it("set → peek returns the text; claim returns it once, second claim is null", () => {
    setPendingFirstMessage("conv-a", "hello code");
    expect(peekPendingFirstMessage("conv-a")?.text).toBe("hello code");
    expect(claimPendingFirstMessage("conv-a")?.text).toBe("hello code");
    // Claimed: a second consumer (remount/reconnect) must not refire.
    expect(claimPendingFirstMessage("conv-a")?.text).toBe("hello code");
  });

  it("single-slot overwrite: a second set replaces the first (at most one handoff)", () => {
    setPendingFirstMessage("conv-b", "first");
    setPendingFirstMessage("conv-b", "second");
    expect(claimPendingFirstMessage("conv-b")?.text).toBe("second");
  });

  it("empty text is a no-op (nothing staged, nothing to claim)", () => {
    setPendingFirstMessage("conv-c", "");
    expect(peekPendingFirstMessage("conv-c")).toBeNull();
    expect(claimPendingFirstMessage("conv-c")).toBeNull();
  });

  it("entries are keyed per conversation", () => {
    setPendingFirstMessage("conv-bound", "bound text");
    expect(claimPendingFirstMessage("conv-sibling")).toBeNull();
    expect(claimPendingFirstMessage("conv-bound")?.text).toBe("bound text");
  });

  it("corrupt / empty payloads read as null, never throw", () => {
    const holder = globalThis as unknown as {
      localStorage: { setItem: (k: string, v: string) => void };
    };
    holder.localStorage.setItem("tbai:pending-first-prompt:bad", "not-json{{{");
    expect(peekPendingFirstMessage("bad")).toBeNull();
    expect(claimPendingFirstMessage("bad")).toBeNull();
    holder.localStorage.setItem(
      "tbai:pending-first-prompt:empty",
      JSON.stringify({ text: "", createdAt: 0, claimed: false }),
    );
    expect(peekPendingFirstMessage("empty")).toBeNull();
  });
});

describe("pendingFirstMessage — consume lifecycle", () => {
  it("claim → clear → second claim returns null: refresh/remount cannot replay", () => {
    setPendingFirstMessage("conv-remount", "send me once");
    // First mount consumes.
    expect(claimPendingFirstMessage("conv-remount")?.text).toBe("send me once");
    clearPendingFirstMessage("conv-remount");
    // Simulated remount after a refresh: nothing left to fire.
    expect(peekPendingFirstMessage("conv-remount")).toBeNull();
    expect(claimPendingFirstMessage("conv-remount")).toBeNull();
  });

  it("M13: a crash between the claim and the dispatch can RESUME the same prompt", () => {
    // The claim and the message id are written together, so a crash after the
    // claim leaves an entry that the next mount can dispatch - with the SAME
    // id, which the server admits as the same prompt rather than a second
    // one. The old contract dropped it, and the reader's message was lost.
    setPendingFirstMessage("conv-crash", "in flight");
    const claimed = claimPendingFirstMessage("conv-crash");
    expect(claimed?.text).toBe("in flight");
    expect(claimed?.messageId).toBeTruthy();

    // Simulate a fresh read after a restart (same backing store).
    const resumed = claimPendingFirstMessage("conv-crash");
    expect(resumed?.text).toBe("in flight");
    // The SAME id: the server admits a repeated id as the same prompt.
    expect(resumed?.messageId).toBe(claimed?.messageId);
    clearPendingFirstMessage("conv-crash");
  });

  it("M19: a failed dispatch is never dispatched again automatically", () => {
    // The dispatch may have reached the server and only its answer was lost.
    // Re-dispatching it on the next settled observation is how a message gets
    // delivered twice, so a failed entry is inert until the user sends again.
    setPendingFirstMessage("conv-retry", "try again");
    expect(claimPendingFirstMessage("conv-retry")?.text).toBe("try again");
    markPendingFirstMessageFailed("conv-retry");
    expect(claimPendingFirstMessage("conv-retry")).toBeNull();
    expect(peekPendingFirstMessage("conv-retry")?.failed).toBe(true);
  });

  it("the user's next send replaces a failed entry", () => {
    setPendingFirstMessage("conv-again", "first try");
    claimPendingFirstMessage("conv-again");
    markPendingFirstMessageFailed("conv-again");
    // The reader sends again: a fresh entry replaces the failed one.
    setPendingFirstMessage("conv-again", "second try");
    expect(claimPendingFirstMessage("conv-again")?.text).toBe("second try");
  });

  it("clear is idempotent (double-clear never throws)", () => {
    setPendingFirstMessage("conv-idem", "x");
    clearPendingFirstMessage("conv-idem");
    expect(() => clearPendingFirstMessage("conv-idem")).not.toThrow();
    expect(peekPendingFirstMessage("conv-idem")).toBeNull();
  });

  it("peek never consumes: repeated peeks leave the handoff intact", () => {
    setPendingFirstMessage("conv-peek", "look only");
    expect(peekPendingFirstMessage("conv-peek")?.text).toBe("look only");
    expect(peekPendingFirstMessage("conv-peek")?.claimed).toBe(false);
    expect(claimPendingFirstMessage("conv-peek")?.text).toBe("look only");
  });
});

describe("pendingFirstMessage — no timing sleeps", () => {
  it("the module contains no timer-based waits", async () => {
    const source = await Bun.file(
      path.join(REPO_ROOT, "web/src/features/chat/state/pendingFirstMessage.ts"),
    ).text();
    expect(source).not.toContain("setTimeout");
    expect(source).not.toContain("setInterval");
    expect(source).not.toContain("Bun.sleep");
  });
});
