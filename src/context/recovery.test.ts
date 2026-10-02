/**
 * Bounded overflow recovery: the policy, tested exhaustively and without a
 * provider.
 *
 * The defect this pins is an ABSENCE. A provider context overflow used to be
 * classified, displayed, and then nothing happened - the user was told to retry
 * into the identical rejection. These cases exist so that "nothing happens"
 * cannot come back, and so the bound on recovery is a tested property rather than
 * an emergent one.
 */
import { describe, it, expect } from "bun:test";
import { decideOverflowRecovery, isRecoverableOverflow } from "./recovery";
import { classifyError, type ErrorCategory } from "../lib/errors";

const base = {
  category: "context_overflow" as const,
  alreadyAttempted: false,
  compactionEnabled: true,
  hasConversation: true,
};

describe("recovery: a context overflow is recoverable", () => {
  it("permits compact-and-retry on a first overflow", () => {
    expect(decideOverflowRecovery(base)).toEqual({
      outcome: "compact_and_retry",
      shouldRecover: true,
    });
  });

  it("ignores every non-overflow category", () => {
    for (const category of [
      "cancelled",
      "auth",
      "rate_limit",
      "network",
      "timeout",
      "validation",
      "config",
      "tool",
      "provider",
      "invalid_stream",
      "database",
      "lifecycle",
      "runtime",
      "transport",
      undefined,
    ]) {
      expect(decideOverflowRecovery({ ...base, category })).toEqual({
        outcome: "not_context_overflow",
        shouldRecover: false,
      });
    }
  });
});

describe("recovery: bounded to ONE attempt per request", () => {
  it("refuses a second recovery", () => {
    // The anti-loop guarantee. If compaction could not reduce the history enough,
    // an unbounded retry would compact, overflow, compact and never terminate.
    expect(decideOverflowRecovery({ ...base, alreadyAttempted: true })).toEqual({
      outcome: "recovery_already_attempted",
      shouldRecover: false,
    });
  });

  it("stays bounded however many times it is asked", () => {
    // Every attempt after the first is refused; none of them can widen it.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(decideOverflowRecovery({ ...base, alreadyAttempted: attempt > 0 }).shouldRecover).toBe(
        attempt === 0,
      );
    }
  });
});

describe("recovery: reports why it declined rather than failing silently", () => {
  it("declines when compaction is switched off", () => {
    expect(decideOverflowRecovery({ ...base, compactionEnabled: false })).toEqual({
      outcome: "compaction_disabled",
      shouldRecover: false,
    });
  });

  it("declines when there is no durable conversation to compact", () => {
    expect(decideOverflowRecovery({ ...base, hasConversation: false })).toEqual({
      outcome: "no_conversation",
      shouldRecover: false,
    });
  });

  it("checks the precondition before the bound, so a disabled seam is named", () => {
    // Order matters for diagnosis: "compaction is off" is more actionable than
    // "already attempted" when both are true.
    expect(
      decideOverflowRecovery({ ...base, alreadyAttempted: true, compactionEnabled: false }).outcome,
    ).toBe("recovery_already_attempted");
  });
});

describe("recovery: the classification it keys on", () => {
  it.each<[string, ErrorCategory]>([
    ["context length exceeded", "context_overflow"],
    ["maximum context length is 200000 tokens", "context_overflow"],
    ["prompt is too long", "context_overflow"],
    ["too many tokens", "context_overflow"],
  ])("treats %j as a recoverable overflow", (message, expected) => {
    const classified = classifyError(Object.assign(new Error(message), { status: 400 }));
    expect(classified.category).toBe(expected);
    expect(isRecoverableOverflow(classified.category)).toBe(true);
    expect(decideOverflowRecovery({ ...base, category: classified.category }).shouldRecover).toBe(true);
  });

  it("does NOT treat a payload-too-large as a context overflow", () => {
    // Same 4xx family, different problem: one oversized PART, which compacting
    // the span may not touch. Compacting here would rewrite a conversation that
    // was never too long.
    expect(isRecoverableOverflow("context_overflow")).toBe(true);
    expect(isRecoverableOverflow("provider")).toBe(false);
    expect(isRecoverableOverflow("validation")).toBe(false);
    expect(isRecoverableOverflow(undefined)).toBe(false);
  });
});

describe("recovery: independent of the general retry policy", () => {
  it("does not consult maxRetries", () => {
    // Direct sets DIRECT_MAX_RETRIES = 0. That is correct for transport faults
    // and for non-idempotent turns - and it must not silently disable overflow
    // recovery, which is a size problem with a known remedy.
    // Nothing in the decision reads a retry count, so recovery is unaffected.
    const withRetriesDisabled = decideOverflowRecovery({ ...base });
    expect(withRetriesDisabled.shouldRecover).toBe(true);
  });
});