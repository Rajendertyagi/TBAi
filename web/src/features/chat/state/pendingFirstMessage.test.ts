import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  setPendingFirstMessage,
  peekPendingFirstMessage,
  claimPendingFirstMessage,
  unclaimPendingFirstMessage,
  clearPendingFirstMessage,
} from "./pendingFirstMessage";

/**
 * Wave-2 Phase 4 — pending first-prompt handoff (cases 2p, 10p, 16p, 17, 18p).
 *
 * The module owns one invariant: a materialized OpenCode draft has AT MOST
 * ONE pending first-prompt handoff, fired EXACTLY ONCE into the session-bound
 * runtime. These tests pin the storage contract the OpenCodeView consume
 * effect depends on:
 *   - single-slot overwrite, empty no-op, corrupt/empty → null
 *   - claim is persisted (a remount between claim and clear cannot refire)
 *   - consume-once across a simulated remount (case 17)
 *   - single append total (case 18 is pinned in firstSendPhase4.test.ts
 *     against a mock runtime; here the storage half is pinned)
 *   - no timer-based waits in this module (case 16)
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
    expect(claimPendingFirstMessage("conv-a")).toBe("hello code");
    // Claimed: a second consumer (remount/reconnect) must not refire.
    expect(claimPendingFirstMessage("conv-a")).toBeNull();
  });

  it("single-slot overwrite: a second set replaces the first (at most one handoff)", () => {
    setPendingFirstMessage("conv-b", "first");
    setPendingFirstMessage("conv-b", "second");
    expect(claimPendingFirstMessage("conv-b")).toBe("second");
  });

  it("empty text is a no-op (nothing staged, nothing to claim)", () => {
    setPendingFirstMessage("conv-c", "");
    expect(peekPendingFirstMessage("conv-c")).toBeNull();
    expect(claimPendingFirstMessage("conv-c")).toBeNull();
  });

  it("entries are keyed per conversation (case 7 frontend half)", () => {
    setPendingFirstMessage("conv-bound", "bound text");
    expect(claimPendingFirstMessage("conv-sibling")).toBeNull();
    expect(claimPendingFirstMessage("conv-bound")).toBe("bound text");
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

describe("pendingFirstMessage — consume lifecycle (cases 17 + 18 storage half)", () => {
  it("claim → clear → second claim returns null: refresh/remount cannot replay (case 17)", () => {
    setPendingFirstMessage("conv-remount", "send me once");
    // First mount consumes.
    expect(claimPendingFirstMessage("conv-remount")).toBe("send me once");
    clearPendingFirstMessage("conv-remount");
    // Simulated remount after a refresh: nothing left to fire.
    expect(peekPendingFirstMessage("conv-remount")).toBeNull();
    expect(claimPendingFirstMessage("conv-remount")).toBeNull();
  });

  it("claim persists before append: a crash between claim and clear still cannot refire", () => {
    setPendingFirstMessage("conv-crash", "in flight");
    expect(claimPendingFirstMessage("conv-crash")).toBe("in flight");
    // Simulate a fresh read after a restart (same backing store): the entry
    // is present but marked claimed, so no second fire.
    expect(peekPendingFirstMessage("conv-crash")?.claimed).toBe(true);
    expect(claimPendingFirstMessage("conv-crash")).toBeNull();
  });

  it("unclaim releases a synchronously-failed handoff so a later attempt may fire", () => {
    setPendingFirstMessage("conv-retry", "try again");
    expect(claimPendingFirstMessage("conv-retry")).toBe("try again");
    unclaimPendingFirstMessage("conv-retry");
    expect(claimPendingFirstMessage("conv-retry")).toBe("try again");
    clearPendingFirstMessage("conv-retry");
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
    expect(claimPendingFirstMessage("conv-peek")).toBe("look only");
  });
});

describe("pendingFirstMessage — no timing sleeps (case 16)", () => {
  it("the module contains no timer-based waits", async () => {
    const source = await Bun.file(new URL("./pendingFirstMessage.ts", import.meta.url)).text();
    expect(source).not.toContain("setTimeout");
    expect(source).not.toContain("setInterval");
    expect(source).not.toContain("Bun.sleep");
  });
});
