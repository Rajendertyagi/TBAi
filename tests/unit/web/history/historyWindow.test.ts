import { describe, expect, it } from "bun:test";
import {
  IDLE_RUNTIME,
  buildCandidateWindow,
  checkWindowInvariants,
  commitWindow,
  createInitialWindowState,
  defaultWindowSizer,
  requestAnchorFor,
  runtimeStateIsBusy,
  stateForActivity,
  totalWindowBytes,
  type ProtectedRegion,
  type RuntimeActivity,
  type WindowMessage,
  type WindowSizer,
} from "@web/features/chat/history/historyWindow.ts";

const KB = 1024;
const NORMAL_BYTES = 2 * KB;
const OVERSIZED_BYTES = 500 * KB;

const declaredSizer: WindowSizer = (message) => {
  const declared = (message.content as { bytes?: number }).bytes;
  return typeof declared === "number" ? declared : NORMAL_BYTES;
};

function msg(id: string, parentId: string | null, bytes = NORMAL_BYTES): WindowMessage {
  return { id, parentId, format: "raw", content: { bytes } };
}

function chain(count: number, oversizedIndexes: readonly number[] = []): WindowMessage[] {
  const oversized = new Set(oversizedIndexes);
  const out: WindowMessage[] = [];
  for (let i = 1; i <= count; i += 1) {
    out.push(
      msg(`m${i}`, i === 1 ? null : `m${i - 1}`, oversized.has(i) ? OVERSIZED_BYTES : NORMAL_BYTES),
    );
  }
  return out;
}

function slice(all: readonly WindowMessage[], from: number, to: number): WindowMessage[] {
  return all.slice(from - 1, to);
}

function bounds(from: number, to: number): ProtectedRegion["active"] {
  return {
    top: { messageId: `m${from}`, offset: 0 },
    bottom: { messageId: `m${to}`, offset: 0 },
  };
}

const ids = (messages: readonly WindowMessage[]) => messages.map((m) => m.id);
const indexOf = (messages: readonly WindowMessage[], id: string) =>
  messages.findIndex((m) => m.id === id);

/* ------------------------------------------------------------------ *
 * Candidate construction & merging
 * ------------------------------------------------------------------ */

describe("P2 candidate construction & merging", () => {
  it("merges an overlapping older slice without duplicating the overlap", () => {
    const all = chain(20);
    const current = slice(all, 11, 20);
    const olderPage = slice(all, 6, 15); // overlaps 11..15
    const merged = buildCandidateWindow(current, olderPage, "older");

    expect(ids(merged)).toEqual(ids(slice(all, 6, 20)));
    expect(new Set(ids(merged)).size).toBe(merged.length);
  });

  it("is idempotent when the same slice is requested twice", () => {
    const all = chain(20);
    const current = slice(all, 10, 20);
    const duplicate = slice(all, 10, 20);
    const merged = buildCandidateWindow(current, duplicate, "older");

    expect(ids(merged)).toEqual(ids(current));
  });

  it("relocates the window on an explicit jump with no shared anchor", () => {
    const all = chain(100);
    const current = slice(all, 1, 10);
    const distant = slice(all, 80, 90);
    const merged = buildCandidateWindow(current, distant, "explicit");

    expect(ids(merged)).toEqual(ids(distant));
  });

  it("ignores a disjoint slice during incremental movement rather than corrupting the window", () => {
    const all = chain(100);
    const current = slice(all, 50, 60);
    const disjoint = slice(all, 1, 10);
    const merged = buildCandidateWindow(current, disjoint, "older");

    expect(ids(merged)).toEqual(ids(current));
  });

  it("preserves order and single-branch membership", () => {
    const all = chain(30);
    const current = slice(all, 15, 25);
    const older = slice(all, 5, 18);
    const merged = buildCandidateWindow(current, older, "older");

    for (let i = 1; i < merged.length; i += 1) {
      expect(merged[i].parentId).toBe(merged[i - 1].id);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Append-only window commit (no data eviction)
 * ------------------------------------------------------------------ */

describe("P2 append-only window commit", () => {
  it("commits a candidate directly without evicting messages", () => {
    const all = chain(300);
    const state = createInitialWindowState();
    const committed = commitWindow(
      state,
      all,
      { hasMoreBefore: false, hasMoreAfter: false },
      bounds(1, 10),
      "explicit",
      IDLE_RUNTIME,
      declaredSizer,
    );

    expect(committed.window.length).toBe(300);
    expect(committed.hasMoreBefore).toBe(false);
    expect(committed.hasMoreAfter).toBe(false);
  });

  it("prepends older pages while preserving already-loaded messages", () => {
    const all = chain(100);
    let state = createInitialWindowState();
    state = commitWindow(
      state,
      slice(all, 51, 100),
      { hasMoreBefore: true, hasMoreAfter: false },
      bounds(90, 100),
      "explicit",
    );

    const merged = buildCandidateWindow(state.window, slice(all, 1, 60), "older");
    state = commitWindow(
      state,
      merged,
      { hasMoreBefore: false, hasMoreAfter: false },
      bounds(90, 100),
      "older",
    );

    expect(state.window.length).toBe(100);
    expect(state.window[0].id).toBe("m1");
    expect(state.window[state.window.length - 1].id).toBe("m100");
  });

  it("switches branch onto a different chain cleanly", () => {
    const main = chain(50);
    const sibling = chain(50).map((m) =>
      msg(`s${m.id.slice(1)}`, m.parentId ? `s${m.parentId.slice(1)}` : null),
    );

    let state = createInitialWindowState();
    state = commitWindow(state, main, { hasMoreBefore: false, hasMoreAfter: false }, bounds(10, 20), "explicit");
    state = commitWindow(state, sibling, { hasMoreBefore: false, hasMoreAfter: false }, bounds(10, 20), "explicit");

    expect(indexOf(state.window, "m25")).toBe(-1);
    expect(indexOf(state.window, "s25")).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < state.window.length; i += 1) {
      expect(state.window[i].parentId).toBe(state.window[i - 1].id);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Runtime semantics
 * ------------------------------------------------------------------ */

describe("P2 runtime semantics — streaming and pending interactions", () => {
  const streaming: RuntimeActivity = { isStreaming: true, hasPendingApproval: false, hasPendingQuestion: false };
  const approval: RuntimeActivity = { isStreaming: false, hasPendingApproval: true, hasPendingQuestion: false };
  const question: RuntimeActivity = { isStreaming: false, hasPendingApproval: false, hasPendingQuestion: true };

  it("recognises every busy runtime state", () => {
    expect(runtimeStateIsBusy(streaming)).toBe(true);
    expect(runtimeStateIsBusy(approval)).toBe(true);
    expect(runtimeStateIsBusy(question)).toBe(true);
    expect(runtimeStateIsBusy(IDLE_RUNTIME)).toBe(false);
  });

  it("parks the window in the matching observed state", () => {
    expect(stateForActivity(streaming)).toBe("streaming");
    expect(stateForActivity(approval)).toBe("approval");
    expect(stateForActivity(question)).toBe("approval");
    expect(stateForActivity(IDLE_RUNTIME)).toBe("stable");
  });

  it("preserves active streamed message through a navigation commit", () => {
    const all = chain(100);
    let state = createInitialWindowState();
    state = commitWindow(state, slice(all, 80, 100), { hasMoreBefore: true, hasMoreAfter: false }, bounds(90, 100), "explicit", streaming);
    expect(state.state).toBe("streaming");

    const merged = buildCandidateWindow(state.window, slice(all, 60, 85), "older");
    state = commitWindow(state, merged, { hasMoreBefore: true, hasMoreAfter: false }, bounds(90, 100), "older", streaming);
    expect(indexOf(state.window, "m100")).toBeGreaterThanOrEqual(0);
    expect(state.state).toBe("streaming");
  });

  it("preserves the message and tool context an approval needs", () => {
    const all = chain(100);
    let state = createInitialWindowState();
    state = commitWindow(state, slice(all, 80, 100), { hasMoreBefore: true, hasMoreAfter: false }, bounds(90, 95), "explicit", approval);
    const merged = buildCandidateWindow(state.window, slice(all, 60, 85), "older");
    state = commitWindow(state, merged, { hasMoreBefore: true, hasMoreAfter: false }, bounds(90, 95), "older", approval);

    for (const id of ["m90", "m91", "m92", "m93", "m94", "m95"]) {
      expect(indexOf(state.window, id)).toBeGreaterThanOrEqual(0);
    }
    expect(state.state).toBe("approval");
  });

  it("never reorders messages while committing", () => {
    const all = chain(100);
    let state = createInitialWindowState();
    state = commitWindow(state, slice(all, 80, 100), { hasMoreBefore: true, hasMoreAfter: false }, bounds(90, 100), "explicit");
    const order = ids(state.window);

    const merged = buildCandidateWindow(state.window, slice(all, 60, 85), "older");
    state = commitWindow(state, merged, { hasMoreBefore: true, hasMoreAfter: false }, bounds(90, 100), "older");

    const keptOrder = ids(state.window).filter((id) => order.includes(id));
    expect(keptOrder).toEqual(order);
  });
});

/* ------------------------------------------------------------------ *
 * Submission semantics
 * ------------------------------------------------------------------ */

describe("P2 submission semantics", () => {
  it("keeps a newly submitted message at the tip", () => {
    const all = chain(50);
    let state = createInitialWindowState();
    state = commitWindow(state, all, { hasMoreBefore: false, hasMoreAfter: false }, bounds(40, 50), "explicit");

    const submitted = msg("m51", "m50");
    const merged = [...state.window, submitted];
    state = commitWindow(state, merged, { hasMoreBefore: false, hasMoreAfter: false }, bounds(51, 51), "explicit");

    expect(ids(state.window)).toContain("m51");
    expect(state.window[state.window.length - 1].id).toBe("m51");
  });
});

/* ------------------------------------------------------------------ *
 * Request anchors & defaults
 * ------------------------------------------------------------------ */

describe("P2 request anchors & the append-only contract", () => {
  it("carries no eviction ceiling at all", () => {
    // P2 REBASE retired the message/byte limits: the buffer is append-only and
    // virtualization, not eviction, bounds the DOM. This asserts their ABSENCE
    // so a silently reintroduced ceiling fails here rather than quietly dropping
    // pages the user explicitly paged in.
    const state = createInitialWindowState();
    expect(Object.keys(state)).not.toContain("messageLimit");
    expect(Object.keys(state)).not.toContain("byteLimit");
    expect(Object.keys(state)).not.toContain("byteLimitExceededByProtection");
    expect(Object.keys(state)).not.toContain("messageLimitExceededByProtection");
  });

  it("defaults an initial state to stable and empty", () => {
    const state = createInitialWindowState();
    expect(state.state).toBe("stable");
    expect(state.window).toEqual([]);
    expect(state.hasMoreBefore).toBe(false);
    expect(state.hasMoreAfter).toBe(false);
  });

  it("anchors an older load on the window's first message", () => {
    const all = chain(10);
    expect(requestAnchorFor(all, "older")).toBe("m1");
  });

  it("anchors a newer load on the window's last message", () => {
    const all = chain(10);
    expect(requestAnchorFor(all, "newer")).toBe("m10");
  });

  it("returns null for an empty window", () => {
    expect(requestAnchorFor([], "older")).toBeNull();
    expect(requestAnchorFor([], "newer")).toBeNull();
  });

  it("measures real serialized bytes", () => {
    const message = { id: "m1", parentId: null, format: "raw", content: "€".repeat(100) };
    expect(defaultWindowSizer(message)).toBe("raw".length + 300 + 2);
    expect((message.content as string).length).toBe(100);
  });

  it("calculates total window bytes", () => {
    const messages = [msg("m1", null, 100), msg("m2", "m1", 200)];
    expect(totalWindowBytes(messages, declaredSizer)).toBe(300);
  });
});

/* ------------------------------------------------------------------ *
 * Window invariants
 * ------------------------------------------------------------------ */

describe("P2 window invariants", () => {
  it("holds for a valid contiguous chain", () => {
    const all = chain(50);
    const state = commitWindow(createInitialWindowState(), all, { hasMoreBefore: false, hasMoreAfter: false });
    const report = checkWindowInvariants(state);

    expect(report.satisfied).toBe(true);
    expect(report.contiguous).toBe(true);
  });

  it("detects a broken parent link in the window", () => {
    const broken = [msg("m1", null), msg("m2", "m999")]; // m999 is broken parent
    const state = commitWindow(createInitialWindowState(), broken, { hasMoreBefore: false, hasMoreAfter: false });
    const report = checkWindowInvariants(state);

    expect(report.satisfied).toBe(false);
    expect(report.contiguous).toBe(false);
  });
});