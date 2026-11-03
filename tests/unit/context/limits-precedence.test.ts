import { describe, expect, it } from "bun:test";
import { resolveContextLimit, describeLimitSource } from "@/context/limits";
import { computeBudget, decideBudget } from "@/context/budget";
import { CHARS_PER_TOKEN_ESTIMATE } from "@/context/index";
import {
  CONTEXT_CATEGORIES,
  type ContextCategory,
  type InputSizeEstimate,
  type ReductionRecord,
} from "@/context/types";

const base = { providerType: "openai" as const, modelId: "gpt-4o", providerId: "p1" };

const NO_MECHANISM_LEFT: ReductionRecord = {
  toolResults: { kind: "exhausted", reason: "no_reducible_content" },
  compaction: { kind: "withheld", reason: "trigger_not_reached" },
};

function estimate(tokens: number): InputSizeEstimate {
  const chars = tokens * CHARS_PER_TOKEN_ESTIMATE;
  const zeros = Object.fromEntries(CONTEXT_CATEGORIES.map((c) => [c, 0])) as Record<
    ContextCategory,
    number
  >;
  const byCategory = { ...zeros, user_text: chars };
  return {
    estimatedTokens: tokens,
    estimatedChars: chars,
    charsPerToken: CHARS_PER_TOKEN_ESTIMATE,
    range: { low: tokens, high: tokens },
    byCategory,
    charsByCategory: byCategory,
  };
}

describe("limits precedence and agreement with model_catalog", () => {
  it("configured beats provider_reported, observed, and model_catalog (configured wins)", () => {
    const limit = resolveContextLimit({
      ...base,
      configuredContextWindow: 200_000,
      model: { contextWindow: 128_000, contextWindowSource: "provider_reported" },
      observedContextWindow: 64_000,
    });
    expect(limit.maxInputTokens).toBe(200_000);
    expect(limit.source).toBe("configured");
    expect(limit.divergent).toBe(true);
    expect(limit.divergentValue?.value).toBe(128_000);
    expect(limit.divergentValue?.source).toBe("provider_reported");
  });

  it("provider_reported beats observed and model_catalog", () => {
    const limit = resolveContextLimit({
      ...base,
      model: { contextWindow: 128_000, contextWindowSource: "provider_reported" },
      observedContextWindow: 64_000,
    });
    expect(limit.maxInputTokens).toBe(128_000);
    expect(limit.source).toBe("provider_reported");
    expect(limit.divergent).toBe(true);
    expect(limit.divergentValue?.value).toBe(64_000);
    expect(limit.divergentValue?.source).toBe("observed");
  });

  it("observed beats model_catalog", () => {
    const limit = resolveContextLimit({
      ...base,
      model: { contextWindow: 128_000, contextWindowSource: "model_catalog" },
      observedContextWindow: 64_000,
    });
    expect(limit.maxInputTokens).toBe(64_000);
    expect(limit.source).toBe("observed");
    expect(limit.divergent).toBe(true);
    expect(limit.divergentValue?.value).toBe(128_000);
    expect(limit.divergentValue?.source).toBe("model_catalog");
  });

  it("model_catalog wins over conservative default when sole candidate", () => {
    const limit = resolveContextLimit({
      ...base,
      model: { contextWindow: 272_000, contextWindowSource: "model_catalog" },
    });
    expect(limit.maxInputTokens).toBe(272_000);
    expect(limit.source).toBe("model_catalog");
    expect(limit.divergent).toBe(false);
    expect(describeLimitSource(limit)).toBe("model_catalog");
  });

  it("configured and provider_reported agreeing retains provider_reported agreement source", () => {
    const limit = resolveContextLimit({
      ...base,
      configuredContextWindow: 128_000,
      model: { contextWindow: 128_000, contextWindowSource: "provider_reported" },
    });
    expect(limit.maxInputTokens).toBe(128_000);
    expect(limit.source).toBe("provider_reported");
    expect(limit.divergent).toBe(false);
  });

  it("observed and model_catalog agreeing selects observed without divergence", () => {
    const limit = resolveContextLimit({
      ...base,
      model: { contextWindow: 64_000, contextWindowSource: "model_catalog" },
      observedContextWindow: 64_000,
    });
    expect(limit.maxInputTokens).toBe(64_000);
    expect(limit.source).toBe("observed");
    expect(limit.divergent).toBe(false);
  });
});

describe("model_catalog advisory budget decisions", () => {
  it("treats model_catalog ceiling as advisory when request exceeds budget", () => {
    const limit = resolveContextLimit({
      ...base,
      model: { contextWindow: 32_000, contextWindowSource: "model_catalog" },
    });
    const budget = computeBudget({ limit, modelOutputTokens: 4096 });
    expect(budget.usableInputTokens).toBeDefined();
    const usable = budget.usableInputTokens!;

    const overDecision = decideBudget({
      estimate: estimate(usable + 5000),
      budget,
      reduction: NO_MECHANISM_LEFT,
      limitSource: limit.source,
    });

    // Must be advisory, NOT a hard terminal reject
    expect(overDecision.action).toBe("advisory");
    if (overDecision.action === "advisory") {
      expect(overDecision.reason).toBe("limit_not_authoritative");
    }
  });

  it("treats provider_reported ceiling as terminal reject when request exceeds budget", () => {
    const limit = resolveContextLimit({
      ...base,
      model: { contextWindow: 32_000, contextWindowSource: "provider_reported" },
    });
    const budget = computeBudget({ limit, modelOutputTokens: 4096 });
    const usable = budget.usableInputTokens!;

    const overDecision = decideBudget({
      estimate: estimate(usable + 5000),
      budget,
      reduction: NO_MECHANISM_LEFT,
      limitSource: limit.source,
    });

    // Authoritative limit must reject
    expect(overDecision.action).toBe("reject");
  });
});
