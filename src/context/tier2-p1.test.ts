/**
 * P-1 — an unknown model's ceiling is ADVISORY, not terminal.
 *
 * ## The failure this prevents
 *
 * A ~101K assembled request against a real ~512K Agnes window exceeded TBAi's
 * 128K `conservative_default` stand-in. That stand-in was enforced terminally, so
 * the request was rejected at `chat.ts` preflight, the provider was NEVER contacted,
 * and no limit could ever be learned. The loop repeated every turn, and repeated
 * compaction kept retargeting the same old span.
 *
 * The defect is not "the number was too small". It is that **a figure TBAi invented
 * was treated as a figure the provider stated**, and enforcing it prevented the only
 * mechanism (`observed`) that could have corrected it.
 *
 * ## What these tests deliberately do NOT do
 *
 * They do not assert that a stand-in is a good estimate. It is not — it refuses real
 * capability. They assert that it is not AUTHORITATIVE, which is a different and
 * narrower claim, and that Tier 2 still bounds the request.
 */

import { describe, expect, it } from "bun:test";
import { computeBudget, decideBudget } from "./budget";
import { TIER_2_MAX_TOKENS, evaluateTier2 } from "./tier2";
import { UNKNOWN_LIMIT_CEILING, resolveContextLimit } from "./limits";
import type { ContextBudget, ContextLimit, InputSizeEstimate, LimitSource, ReductionRecord } from "./types";

const EXHAUSTED: ReductionRecord = {
  toolResults: { kind: "exhausted", reason: "no_reducible_content" },
  compaction: { kind: "exhausted", reason: "disabled" },
};

function estimate(point: number, low: number, high: number): InputSizeEstimate {
  return {
    estimatedTokens: point,
    estimatedChars: point * 3,
    charsPerToken: 3,
    range: { low, high },
    byCategory: {} as InputSizeEstimate["byCategory"],
    charsByCategory: {} as InputSizeEstimate["charsByCategory"],
  };
}

function budgetFor(limit: ContextLimit): ContextBudget {
  return computeBudget({ limit });
}

function unknownLimit(): ContextLimit {
  return resolveContextLimit({ providerType: "custom", modelId: "agnes-2.5-flash" });
}

function knownLimit(contextWindow: number): ContextLimit {
  return resolveContextLimit({
    providerType: "anthropic",
    modelId: "claude-test",
    model: { contextWindow, contextWindowSource: "provider_reported" },
  });
}

describe("A. unknown model — the stand-in is advisory, never terminal", () => {
  it("resolves to conservative_default, confirming the fixture is the real case", () => {
    expect(unknownLimit().source).toBe("conservative_default");
    expect(unknownLimit().maxInputTokens).toBe(UNKNOWN_LIMIT_CEILING);
  });

  it("produces ADVISORY, not reject, when the request exceeds the stand-in", () => {
    const limit = unknownLimit();
    const budget = budgetFor(limit);
    const usable = budget.usableInputTokens!;

    // Comfortably over the 92,928 usable planning budget the Agnes request hit.
    const decision = decideBudget({
      estimate: estimate(usable + 20_000, usable + 15_000, usable + 25_000),
      budget,
      reduction: EXHAUSTED,
      limitSource: limit.source,
    });

    expect(decision.action).toBe("advisory");
    if (decision.action !== "advisory") throw new Error("expected advisory");
    expect(decision.reason).toBe("limit_not_authoritative");
    // The stand-in it exceeded is reported, so the diagnostic never implies the
    // provider stated it.
    expect(decision.planningCeilingTokens).toBe(usable);
    expect(decision.overBy).toBeGreaterThan(0);
  });

  it("produces ADVISORY in the reduction_exhausted branch too", () => {
    // The other rejection branch. Both had to change: fixing only `over_limit`
    // would leave the straddling-band case terminal.
    const limit = unknownLimit();
    const budget = budgetFor(limit);
    const usable = budget.usableInputTokens!;

    const decision = decideBudget({
      estimate: estimate(usable + 5_000, usable - 100, usable + 9_000),
      budget,
      reduction: EXHAUSTED,
      limitSource: limit.source,
    });

    expect(decision.action).toBe("advisory");
  });

  it("treats `unknown` as advisory as well as conservative_default", () => {
    const limit = resolveContextLimit({ providerType: "custom", modelId: "x" });
    const budget = budgetFor(limit);
    const usable = budget.usableInputTokens!;
    const decision = decideBudget({
      estimate: estimate(usable + 20_000, usable + 20_000, usable + 20_000),
      budget,
      reduction: EXHAUSTED,
      limitSource: limit.source as LimitSource,
    });
    expect(decision.action).toBe("advisory");
  });

  it("still accepts a request that fits under the stand-in", () => {
    const limit = unknownLimit();
    const budget = budgetFor(limit);
    const decision = decideBudget({
      estimate: estimate(1_000, 900, 1_100),
      budget,
      reduction: EXHAUSTED,
      limitSource: limit.source,
    });
    expect(decision.action).toBe("accept");
  });
});

describe("B. known model — authoritative limits stay terminal (P-2 preserved)", () => {
  it("still REJECTS over a provider-reported ceiling", () => {
    const limit = knownLimit(128_000);
    const budget = budgetFor(limit);
    const usable = budget.usableInputTokens!;

    const decision = decideBudget({
      estimate: estimate(usable + 20_000, usable + 15_000, usable + 25_000),
      budget,
      reduction: EXHAUSTED,
      limitSource: limit.source,
    });

    expect(decision.action).toBe("reject");
    if (decision.action !== "reject") throw new Error("expected reject");
    expect(decision.reason).toBe("over_limit");
  });

  it("still REJECTS over a configured ceiling", () => {
    // P-2: a configured limit is an account/entitlement statement and keeps its
    // precedence. The P-1 relaxation must not leak into it.
    const limit = resolveContextLimit({
      providerType: "custom",
      modelId: "x",
      model: { contextWindow: 128_000, contextWindowSource: "configured" },
    });
    expect(limit.source).toBe("configured");

    const budget = budgetFor(limit);
    const usable = budget.usableInputTokens!;
    const decision = decideBudget({
      estimate: estimate(usable + 20_000, usable + 15_000, usable + 25_000),
      budget,
      reduction: EXHAUSTED,
      limitSource: limit.source,
    });
    expect(decision.action).toBe("reject");
  });

  it("still REJECTS over an observed ceiling", () => {
    const limit = resolveContextLimit({
      providerType: "custom",
      modelId: "x",
      observedContextWindow: 128_000,
    });
    expect(limit.source).toBe("observed");

    const budget = budgetFor(limit);
    const usable = budget.usableInputTokens!;
    const decision = decideBudget({
      estimate: estimate(usable + 20_000, usable + 15_000, usable + 25_000),
      budget,
      reduction: EXHAUSTED,
      limitSource: limit.source,
    });
    expect(decision.action).toBe("reject");
  });

  it("still REJECTS over a catalog ceiling", () => {
    const limit = resolveContextLimit({
      providerType: "custom",
      modelId: "x",
      model: { contextWindow: 128_000, contextWindowSource: "provider_reported" },
    });
    const budget = budgetFor(limit);
    const usable = budget.usableInputTokens!;
    const decision = decideBudget({
      estimate: estimate(usable + 20_000, usable + 15_000, usable + 25_000),
      budget,
      reduction: EXHAUSTED,
      limitSource: limit.source,
    });
    expect(decision.action).toBe("reject");
  });
});

describe("C. the advisory relaxation is bounded by Tier 2", () => {
  it("a request above the 128K stand-in but below Tier 2 passes the guard", () => {
    const v = evaluateTier2(estimate(101_000, 95_000, 110_000), "conservative_default");
    expect(v.outcome).toBe("within_assembly_limit");
  });

  it("an advisory decision on a huge request is STILL stopped by Tier 2", () => {
    // This is the pairing that makes P-1 safe. Advisory means "the provider decides",
    // not "nothing bounds this".
    const limit = unknownLimit();
    const budget = budgetFor(limit);
    const usable = budget.usableInputTokens!;
    const decision = decideBudget({
      estimate: estimate(TIER_2_MAX_TOKENS + 1_000_000, TIER_2_MAX_TOKENS + 500_000, TIER_2_MAX_TOKENS + 2_000_000),
      budget,
      reduction: EXHAUSTED,
      limitSource: limit.source,
    });

    expect(decision.action).toBe("advisory");
    expect(evaluateTier2(estimate(TIER_2_MAX_TOKENS + 2_000_000, 0, TIER_2_MAX_TOKENS + 2_000_000), limit.source).outcome).toBe(
      "assembly_limit_exceeded",
    );
  });

  it("a known model with a huge window is still bounded by Tier 2", () => {
    // Tier 1 says 8M — far above Tier 2. This is the case that proves the guard is
    // not merely "the largest model window": a provider-reported ceiling cannot
    // raise it, because Tier 2 runs later and is unconditional.
    const limit = knownLimit(8_000_000);
    expect(limit.maxInputTokens).toBe(8_000_000);

    // Under the guard: allowed, because Tier 1 also permits it.
    const under = evaluateTier2(estimate(3_000_000, 2_500_000, 3_500_000), limit.source);
    expect(under.outcome).toBe("within_assembly_limit");

    // Over the guard but under Tier 1's 8M: REJECTED. Tier 1 alone would have let
    // this through, which is precisely why Tier 2 exists.
    const between = evaluateTier2(estimate(5_000_000, 4_500_000, 5_000_000), limit.source);
    expect(between.outcome).toBe("assembly_limit_exceeded");
    if (between.outcome !== "assembly_limit_exceeded") throw new Error("expected breach");
    // And it is labelled as a KNOWN model's limit, not an advisory one.
    expect(between.limitWasAdvisory).toBe(false);
  });
});

describe("D. Agnes regression — the exact recorded failure", () => {
  // Values are the ones the RCA recorded, not approximations chosen to pass.
  const FALLBACK = 128_000;
  const OUTPUT_RESERVE = 4_096;
  const SAFETY_MARGIN = 0.25;

  it("reproduces the 92,928 usable planning budget from the real arithmetic", () => {
    const afterReserve = FALLBACK - OUTPUT_RESERVE;
    const usable = afterReserve - Math.floor(afterReserve * SAFETY_MARGIN);
    expect(usable).toBe(92_928);
  });

  it("a ~101K request is ADVISORY under the 128K stand-in (was: rejected)", () => {
    const limit = unknownLimit();
    const budget = budgetFor(limit);
    expect(budget.usableInputTokens).toBe(92_928);

    const decision = decideBudget({
      estimate: estimate(101_000, 96_000, 108_000),
      budget,
      reduction: EXHAUSTED,
      limitSource: limit.source,
    });

    // Before this change this was `{ action: "reject", reason: "over_limit" }`.
    expect(decision.action).toBe("advisory");
  });

  it("the same ~101K request passes Tier 2, so transport is reachable", () => {
    const v = evaluateTier2(estimate(101_000, 96_000, 108_000), "conservative_default");
    expect(v.outcome).toBe("within_assembly_limit");
    expect(101_000).toBeLessThan(TIER_2_MAX_TOKENS);
  });

  it("a real 512K window would have admitted this request all along", () => {
    // The point of the fix: the request was never actually too large. It only
    // exceeded a number TBAi invented.
    const realWindow = 524_288;
    const afterReserve = realWindow - OUTPUT_RESERVE;
    const usable = afterReserve - Math.floor(afterReserve * SAFETY_MARGIN);
    expect(101_000).toBeLessThan(usable);
  });
});

describe("diagnostics distinguish advisory from accept and reject", () => {
  it("an advisory verdict is recorded as advisory, never as accept", () => {
    const limit = unknownLimit();
    const budget = budgetFor(limit);
    const usable = budget.usableInputTokens!;
    const decision = decideBudget({
      estimate: estimate(usable + 20_000, usable + 15_000, usable + 25_000),
      budget,
      reduction: EXHAUSTED,
      limitSource: limit.source,
    });
    expect(decision.action).toBe("advisory");
    // The decision object carries the planning ceiling so a log line can show that
    // the request was over a stand-in rather than over a stated limit.
    if (decision.action !== "advisory") throw new Error("expected advisory");
    expect(decision.planningCeilingTokens).toBe(usable);
  });
});