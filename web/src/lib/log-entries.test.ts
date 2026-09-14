import { describe, it, expect } from "bun:test";
import { maxSeq, mergeLogEntries, serializeLogEntries } from "./log-entries";

const e = (seq: number) => ({ seq, event: `ev${seq}` });

describe("mergeLogEntries", () => {
  it("appends within one boot and caps at the limit", () => {
    const first = mergeLogEntries([], [e(1), e(2)], null, "boot-a", 3);
    expect(first.reset).toBe(false);
    expect(first.entries.map((x) => x.seq)).toEqual([1, 2]);

    const second = mergeLogEntries(first.entries, [e(3), e(4)], first.bootId, "boot-a", 3);
    expect(second.reset).toBe(false);
    expect(second.entries.map((x) => x.seq)).toEqual([2, 3, 4]);
  });

  it("replaces the list when the server restarted (seqs reused)", () => {
    const before = mergeLogEntries([], [e(98), e(99)], null, "boot-a");
    // Server rebooted: seqs restart at 1. Appending would collide React keys
    // with the stale rows and leak DOM nodes on every update.
    const after = mergeLogEntries(before.entries, [e(1), e(2)], before.bootId, "boot-b");
    expect(after.reset).toBe(true);
    expect(after.entries.map((x) => x.seq)).toEqual([1, 2]);
    expect(after.bootId).toBe("boot-b");
  });

  it("ignores empty batches", () => {
    const prev = [e(1)];
    const kept = mergeLogEntries(prev, [], "boot-a", "boot-a");
    expect(kept.reset).toBe(false);
    expect(kept.entries).toEqual(prev);
  });

  it("drops re-delivered seqs so React keys stay unique", () => {
    // Initial GET /recent returns the full ring; the SSE backlog that follows
    // contains the same entries. Appending both doubles every key.
    const prev = [e(1), e(2)];
    const dup = mergeLogEntries(prev, [e(1), e(2), e(3)], "boot-a", "boot-a");
    expect(dup.reset).toBe(false);
    expect(dup.entries.map((x) => x.seq)).toEqual([1, 2, 3]);
    // Fully stale batch: same array back, no re-render churn.
    const stale = mergeLogEntries(dup.entries, [e(1), e(2)], "boot-a", "boot-a");
    expect(stale.entries).toBe(dup.entries);
  });

  it("maxSeq tracks the since cursor", () => {
    expect(maxSeq([])).toBe(0);
    expect(maxSeq([e(3), e(9), e(4)])).toBe(9);
  });

  it("serializes entries as JSON lines", () => {
    expect(serializeLogEntries([])).toBe("");
    const out = serializeLogEntries([
      { seq: 1, event: "a" },
      { seq: 2, event: "b" },
    ]);
    expect(out).toBe('{"seq":1,"event":"a"}\n{"seq":2,"event":"b"}\n');
  });
});
