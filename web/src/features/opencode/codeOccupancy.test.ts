/**
 * Runtime-shaped tests for the occupancy selector.
 *
 * The numbers come from a LIVE opencode 2.0.22 session driven through TBAi's own
 * Code path: three trivial turns produced session-ledger totals of
 * 12,451 -> 24,005 -> 35,571 while the newest assistant response stayed flat at
 * 11,524. That divergence is the defect these tests pin shut.
 */

import { describe, expect, it } from "bun:test";
import type { SessionMessageInfo } from "@opencode/client";
import { occupancyTokens, resolveCodeOccupancy } from "./codeOccupancy";

const tokens = (input: number, output = 0, read = 0) => ({
  input,
  output,
  reasoning: 0,
  cache: { read, write: 0 },
});

const assistant = (id: string, value: ReturnType<typeof tokens>): SessionMessageInfo =>
  ({ type: "assistant", id, time: { created: 1 }, tokens: value }) as unknown as SessionMessageInfo;

const compaction = (
  id: string,
  status: "running" | "completed" | "failed",
): SessionMessageInfo =>
  ({
    type: "compaction",
    id,
    time: { created: 1 },
    status,
    reason: "auto",
    summary: "",
    recent: "",
  }) as unknown as SessionMessageInfo;

describe("resolveCodeOccupancy: the ledger is never the answer", () => {
  it("reads the NEWEST response, not the sum of every response", () => {
    // The measured live shape: three turns, each ~11.5K, ledger total 35,571.
    const messages = [
      assistant("m1", tokens(11_520, 4)),
      assistant("m2", tokens(11_520, 4)),
      assistant("m3", tokens(11_520, 4)),
    ];
    const result = resolveCodeOccupancy(messages);
    expect(result?.state).toBe("measured");
    // 11,524 - the current fill. NOT 34,644, which is what the ledger reports.
    expect(occupancyTokens(result)?.input).toBe(11_520);
  });

  it("stays flat across turns while the ledger grows", () => {
    const one = resolveCodeOccupancy([assistant("m1", tokens(11_520, 4))]);
    const three = resolveCodeOccupancy([
      assistant("m1", tokens(11_520, 4)),
      assistant("m2", tokens(11_520, 4)),
      assistant("m3", tokens(11_520, 4)),
    ]);
    expect(occupancyTokens(three)).toEqual(occupancyTokens(one));
  });

  it("returns null when nothing reports tokens", () => {
    expect(resolveCodeOccupancy([])).toBeNull();
    expect(resolveCodeOccupancy([assistant("m1", tokens(0))])).toBeNull();
  });

  it("skips a malformed payload rather than trusting it", () => {
    const broken = { type: "assistant", id: "m1", time: { created: 1 }, tokens: { input: 1 } };
    const messages = [
      broken as unknown as SessionMessageInfo,
      assistant("m2", tokens(500)),
    ];
    expect(occupancyTokens(resolveCodeOccupancy(messages))?.input).toBe(500);
  });
});

describe("resolveCodeOccupancy: compaction decides unknown", () => {
  it("a finished compaction is unknown, not the older pre-compaction reading", () => {
    const result = resolveCodeOccupancy([
      assistant("m1", tokens(900_000)),
      compaction("c1", "completed"),
    ]);
    expect(result?.state).toBe("unknown");
    expect(occupancyTokens(result)).toBeUndefined();
  });

  it("a running compaction leaves the previous reading standing", () => {
    // Nothing has been rewritten yet, so the last measurement is still true.
    const result = resolveCodeOccupancy([
      assistant("m1", tokens(900_000)),
      compaction("c1", "running"),
    ]);
    expect(occupancyTokens(result)?.input).toBe(900_000);
  });

  it("a failed compaction leaves the previous reading standing", () => {
    const result = resolveCodeOccupancy([
      assistant("m1", tokens(900_000)),
      compaction("c1", "failed"),
    ]);
    expect(occupancyTokens(result)?.input).toBe(900_000);
  });

  it("a response AFTER a compaction restores the reading", () => {
    // This is the repopulation path: the next response measures the new window.
    const result = resolveCodeOccupancy([
      assistant("m1", tokens(900_000)),
      compaction("c1", "completed"),
      assistant("m2", tokens(12_000)),
    ]);
    expect(result?.state).toBe("measured");
    expect(occupancyTokens(result)?.input).toBe(12_000);
  });

  it("repeated compactions each reset the reading", () => {
    const result = resolveCodeOccupancy([
      assistant("m1", tokens(900_000)),
      compaction("c1", "completed"),
      assistant("m2", tokens(12_000)),
      compaction("c2", "completed"),
      assistant("m3", tokens(11_000)),
    ]);
    expect(occupancyTokens(result)?.input).toBe(11_000);
  });

  it("a trailing compaction wins over an earlier response", () => {
    const result = resolveCodeOccupancy([
      assistant("m1", tokens(11_000)),
      compaction("c1", "completed"),
    ]);
    expect(result?.state).toBe("unknown");
  });
});

describe("resolveCodeOccupancy: cached input does not inflate the ring", () => {
  it("keeps cache.read inside the payload without adding it twice", () => {
    // OpenChamber's documented 330% case: cache.read far exceeds the window.
    const withCache = resolveCodeOccupancy([assistant("m1", tokens(200_000, 32_000, 3_291_956))]);
    expect(occupancyTokens(withCache)?.cache.read).toBe(3_291_956);
    // The selector returns the raw payload; the ring's numerator rule is what
    // refuses to add cache.read on top of a reported total.
    expect(occupancyTokens(withCache)?.input).toBe(200_000);
  });
});
