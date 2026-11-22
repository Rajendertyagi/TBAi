/**
 * Direct history visit ownership (Fix 4).
 *
 * Visit tracking is keyed by a stable chat-content owner object, not one global
 * slot. Two Direct surfaces mounted at once track independently; a remount
 * inside the same owner is not a new visit; a newly opened owner starts fresh.
 */
import { describe, it, expect } from "bun:test";
import {
  beginHistoryVisit,
  clearAllWindowControllers,
  resetHistoryVisit,
} from "@web/features/chat/history/useDirectHistoryWindow";

describe("history visit ownership (WeakMap by owner)", () => {
  it("two simultaneous owners track independently", () => {
    const ownerA = {};
    const ownerB = {};
    // Owner A visits conv-1.
    expect(beginHistoryVisit(ownerA, "conv-1")).toBe(true);
    // Owner B visits conv-2 — independent, also a new visit.
    expect(beginHistoryVisit(ownerB, "conv-2")).toBe(true);
    // Owner A revisits conv-1: still not a new visit for A.
    expect(beginHistoryVisit(ownerA, "conv-1")).toBe(false);
    // Owner B revisits conv-2: still not a new visit for B.
    expect(beginHistoryVisit(ownerB, "conv-2")).toBe(false);
  });

  it("a different conversation in the same owner is a new visit", () => {
    const owner = {};
    expect(beginHistoryVisit(owner, "conv-1")).toBe(true);
    expect(beginHistoryVisit(owner, "conv-2")).toBe(true);
    expect(beginHistoryVisit(owner, "conv-1")).toBe(true);
  });

  it("a remount inside the same owner is not a new visit", () => {
    const owner = {};
    expect(beginHistoryVisit(owner, "conv-1")).toBe(true);
    // Simulate a runtime remount under the same content owner: same conversation.
    expect(beginHistoryVisit(owner, "conv-1")).toBe(false);
    expect(beginHistoryVisit(owner, "conv-1")).toBe(false);
  });

  it("a newly opened owner starts with a fresh visit record", () => {
    const closedOwner = {};
    expect(beginHistoryVisit(closedOwner, "conv-1")).toBe(true);
    // Closing content discards the owner; reopening creates a new object.
    const reopenedOwner = {};
    expect(beginHistoryVisit(reopenedOwner, "conv-1")).toBe(true);
    // The old owner is unaffected by the new one.
    expect(beginHistoryVisit(closedOwner, "conv-1")).toBe(false);
  });

  it("a coordinated full reset makes every owner's next mount a new visit", () => {
    const ownerA = {};
    const ownerB = {};
    expect(beginHistoryVisit(ownerA, "conv-1")).toBe(true);
    expect(beginHistoryVisit(ownerB, "conv-2")).toBe(true);
    // Same conversation again → not a new visit before the reset.
    expect(beginHistoryVisit(ownerA, "conv-1")).toBe(false);

    clearAllWindowControllers();

    // After the reset, even the same conversation in the same owner is a visit.
    expect(beginHistoryVisit(ownerA, "conv-1")).toBe(true);
    expect(beginHistoryVisit(ownerB, "conv-2")).toBe(true);
  });

  it("resetHistoryVisit clears only the given owner", () => {
    const ownerA = {};
    const ownerB = {};
    beginHistoryVisit(ownerA, "conv-1");
    beginHistoryVisit(ownerB, "conv-1");
    resetHistoryVisit(ownerA);
    // A is fresh again; B is untouched.
    expect(beginHistoryVisit(ownerA, "conv-1")).toBe(true);
    expect(beginHistoryVisit(ownerB, "conv-1")).toBe(false);
  });
});
