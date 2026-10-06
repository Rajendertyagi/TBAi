/**
 * Tier 2 — the universal assembly ceiling.
 *
 * These tests exist to prove the INVARIANT, not the constant: for every request,
 * regardless of what TBAi knows about the model, the assembled request is bounded.
 * The constant itself is a policy value, so a test asserting only "it equals
 * 4194304" would pass forever without proving anything about behaviour.
 */

import { describe, expect, it } from "bun:test";
import { ASSEMBLY_LIMIT_CODE, TIER_2_MAX_TOKENS, evaluateTier2 } from "./tier2";
import type { InputSizeEstimate } from "./types";

/** An estimate whose pessimistic (`range.high`) figure is exactly `high`. */
function estimateAt(high: number): InputSizeEstimate {
  return {
    estimatedTokens: high,
    estimatedChars: high * 3,
    charsPerToken: 3,
    // `low` is the optimistic end; a breach is judged on `high` alone.
    range: { low: Math.floor(high / 2), high },
    byCategory: {} as InputSizeEstimate["byCategory"],
    charsByCategory: {} as InputSizeEstimate["charsByCategory"],
  };
}

/** An estimate with an INDEPENDENT point and pessimistic figure. */
function estimateWith(point: number, high: number): InputSizeEstimate {
  return {
    estimatedTokens: point,
    estimatedChars: point * 3,
    charsPerToken: 3,
    range: { low: Math.floor(point / 2), high },
    byCategory: {} as InputSizeEstimate["byCategory"],
    charsByCategory: {} as InputSizeEstimate["charsByCategory"],
  };
}

describe("the constant", () => {
  it("is the approved policy value of 4,194,304 (2^22)", () => {
    expect(TIER_2_MAX_TOKENS).toBe(4_194_304);
  });

  it("sits above the largest credible model window the architecture must serve", () => {
    // 2,097,152 is the highest context window surviving a reliability filter over
    // the models.dev corpus. If this ever fails, the architecture's lower anchor
    // moved and the value must be re-derived rather than silently kept.
    expect(TIER_2_MAX_TOKENS).toBeGreaterThan(2_097_152);
  });

  it("is finite — an infinite or unset guard makes the invariant vacuous", () => {
    expect(Number.isFinite(TIER_2_MAX_TOKENS)).toBe(true);
    expect(Number.isSafeInteger(TIER_2_MAX_TOKENS)).toBe(true);
  });
});

describe("a request below the ceiling passes", () => {
  it("passes at exactly the ceiling (the bound is inclusive)", () => {
    expect(evaluateTier2(estimateAt(TIER_2_MAX_TOKENS), "provider_reported").outcome).toBe(
      "within_assembly_limit",
    );
  });

  it("passes one token below the ceiling", () => {
    expect(evaluateTier2(estimateAt(TIER_2_MAX_TOKENS - 1), "provider_reported").outcome).toBe(
      "within_assembly_limit",
    );
  });

  it("passes the Agnes regression size with enormous headroom", () => {
    // ~101K against a 4.19M ceiling: the guard exists for pathological assembly,
    // not for this request. This is the assertion that keeps the Agnes path open.
    expect(evaluateTier2(estimateAt(101_000), "conservative_default").outcome).toBe(
      "within_assembly_limit",
    );
  });
});

describe("a request above the ceiling is rejected", () => {
  it("breaches at exactly one token over", () => {
    const v = evaluateTier2(estimateAt(TIER_2_MAX_TOKENS + 1), "provider_reported");
    expect(v.outcome).toBe("assembly_limit_exceeded");
  });

  it("reports the pessimistic figure, the ceiling, and the overage", () => {
    const over = TIER_2_MAX_TOKENS + 5_000;
    const v = evaluateTier2(estimateAt(over), "provider_reported");
    if (v.outcome !== "assembly_limit_exceeded") throw new Error("expected a breach");
    expect(v.estimatedTokens).toBe(over);
    expect(v.ceilingTokens).toBe(TIER_2_MAX_TOKENS);
    expect(v.overBy).toBe(5_000);
  });

  it("judges on range.high, not the point estimate", () => {
    // Point estimate comfortably under the ceiling, pessimistic end far over it.
    // Judging on the point estimate would let a denser-than-assumed corpus through,
    // which is the failure decideBudget's own rule exists to prevent.
    const e = estimateWith(1_000, TIER_2_MAX_TOKENS + 1);
    expect(e.estimatedTokens).toBeLessThan(TIER_2_MAX_TOKENS);
    expect(evaluateTier2(e, "provider_reported").outcome).toBe("assembly_limit_exceeded");
  });

  it("treats a non-finite estimate as within the limit rather than breaching", () => {
    // An unusable measurement must not fabricate a terminal failure. Tier 2 bounds
    // real assembly; a broken estimator is a different defect and is reported
    // elsewhere rather than converted into a user-facing rejection.
    const e = estimateAt(0);
    const broken: InputSizeEstimate = { ...e, range: { low: 0, high: Number.NaN } };
    expect(evaluateTier2(broken, "provider_reported").outcome).toBe("within_assembly_limit");
  });
});

describe("the guard is unconditional — no source can raise or skip it", () => {
  // Every provenance the resolver can emit, including the two advisory ones. The
  // whole point is that a fully-known model with a 2M window is bounded exactly like
  // an unknown one, and that an operator-configured limit cannot lift the ceiling.
  const SOURCES = [
    "provider_reported",
    "configured",
    "model_catalog",
    "observed",
    "conservative_default",
    "unknown",
  ] as const;

  for (const source of SOURCES) {
    it(`breaches for an unknown-limit source (${source})`, () => {
      expect(evaluateTier2(estimateAt(TIER_2_MAX_TOKENS + 1), source).outcome).toBe(
        "assembly_limit_exceeded",
      );
    });

    it(`passes for a small request regardless of source (${source})`, () => {
      expect(evaluateTier2(estimateAt(101_000), source).outcome).toBe("within_assembly_limit");
    });
  }

  it("labels an unknown model as advisory and a known model as not", () => {
    const unknown = evaluateTier2(estimateAt(TIER_2_MAX_TOKENS + 1), "conservative_default");
    const known = evaluateTier2(estimateAt(TIER_2_MAX_TOKENS + 1), "provider_reported");
    if (unknown.outcome !== "assembly_limit_exceeded" || known.outcome !== "assembly_limit_exceeded")
      throw new Error("expected breaches");
    expect(unknown.limitWasAdvisory).toBe(true);
    expect(known.limitWasAdvisory).toBe(false);
  });
});

describe("the breach is distinguishable from every other Direct failure", () => {
  it("carries its own error code, separate from CONTEXT_OVERFLOW", () => {
    expect(ASSEMBLY_LIMIT_CODE).toBe("ASSEMBLY_LIMIT_EXCEEDED");
    expect(ASSEMBLY_LIMIT_CODE).not.toBe("CONTEXT_OVERFLOW");
  });

  it("has a distinct outcome string from any budget verdict", () => {
    const v = evaluateTier2(estimateAt(TIER_2_MAX_TOKENS + 1), "provider_reported");
    // Budget verdicts are accept / reject / advisory; a Tier 2 breach is none of them.
    expect(["accept", "reject", "advisory"]).not.toContain(v.outcome);
  });
});