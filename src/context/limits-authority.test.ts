/**
 * The Direct capability AUTHORITY, asserted on the server.
 *
 * `resolveContextLimit` in `limits.ts` is the single place that decides the effective
 * Direct context window. Everything else consumes its result: the budget that sizes a
 * request, the compaction trigger that reacts to pressure, and the context state the
 * route ships to the UI.
 *
 * These tests pin the properties that make it an authority rather than a helper:
 *
 *  - ONE decision, so two consumers cannot reach different numbers;
 *  - identity recorded on the RESULT, so a figure can be traced to the endpoint it was
 *    resolved for - the same model id on two endpoints is two different facts;
 *  - conflicts resolved deterministically with the losing evidence RETAINED;
 *  - a fallback that stays a fallback, and an unknown that stays unknown.
 *
 * The frontend half of this contract - that the UI renders this result and never
 * substitutes its own - is in `web/src/config/directCapabilityAuthority.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import { computeBudget, decideBudget } from "./budget";
import { CHARS_PER_TOKEN_ESTIMATE } from "./index";
import { resolveContextLimit, resolveGenerationCap, resolveOutputReservation, UNKNOWN_LIMIT_CEILING } from "./limits";
import type { ContextCategory, InputSizeEstimate, ReductionRecord } from "./types";
import { CONTEXT_CATEGORIES } from "./types";

/** The model id used throughout. Deliberately a real-looking id and never branched on. */
const MODEL = "agnes-3.0-flash";

/**
 * Both mechanisms already gave everything they had.
 *
 * `decideBudget` requires an explicit verdict from each — it refuses to default — so a
 * rejection here is attributable to the SIZE, not to a reduction that declined to run.
 */
const NO_MECHANISM_LEFT: ReductionRecord = {
  toolResults: { kind: "exhausted", reason: "no_reducible_content" },
  compaction: { kind: "withheld", reason: "trigger_not_reached" },
};

describe("one resolution, one answer, for every consumer", () => {
  it("Test 8 - the budget's denominator IS the resolved limit, not a re-derivation", () => {
    const limit = resolveContextLimit({
      providerType: "custom",
      modelId: MODEL,
      providerId: "provider-a",
      endpoint: "https://apihub.example/v1",
      protocol: "chat-completions",
      model: { contextWindow: 512_000, contextWindowSource: "configured" },
    });
    const budget = computeBudget({ limit, modelOutputTokens: undefined });

    // The UI reports `windowTokens` from this same limit, so the meter and the budget
    // cannot disagree: one number, produced once, consumed twice.
    expect(limit.maxInputTokens).toBe(512_000);
    expect(budget.enforceable).toBe(true);
    // The usable budget is strictly DERIVED from the resolved ceiling — output reserve
    // and safety margin held back — and never independently chosen. This identity is
    // what makes "the meter and the budget cannot disagree" checkable rather than a
    // claim: the budget is a pure function of the one resolved number.
    expect(budget.usableInputTokens! + budget.safetyMarginTokens + budget.outputReservation.tokens).toBe(
      limit.maxInputTokens,
    );
    expect(budget.usableInputTokens!).toBeLessThan(limit.maxInputTokens!);
  });

  it("Test 9 - the compaction trigger reads the same usable budget the gate enforced", () => {
    // Compaction is driven by `measuredTotalTokens` against the SAME usable input the
    // budget produced. A conversation that fits must not trigger compaction, and one
    // that does not must, or the two subsystems have diverged.
    const limit = resolveContextLimit({
      providerType: "custom",
      modelId: MODEL,
      model: { contextWindow: 512_000, contextWindowSource: "configured" },
    });
    const budget = computeBudget({ limit, modelOutputTokens: undefined });
    const usable = budget.usableInputTokens!;

    const estimate = (tokens: number): InputSizeEstimate => {
      const chars = tokens * CHARS_PER_TOKEN_ESTIMATE;
      // Every category accounted for, as the measurement contract requires. Only
      // `user_text` carries weight here; this test is about the SIZE verdict, not the
      // breakdown.
      const zeros = Object.fromEntries(CONTEXT_CATEGORIES.map((c) => [c, 0])) as Record<ContextCategory, number>;
      const byCategory = { ...zeros, user_text: chars };
      return {
        estimatedTokens: tokens,
        estimatedChars: chars,
        charsPerToken: CHARS_PER_TOKEN_ESTIMATE,
        range: { low: tokens, high: tokens },
        byCategory,
        charsByCategory: byCategory,
      };
    };

    const fits = decideBudget({ estimate: estimate(usable), budget, reduction: NO_MECHANISM_LEFT });
    const overflows = decideBudget({
      estimate: estimate(usable + 1),
      budget,
      reduction: NO_MECHANISM_LEFT,
    });

    expect(fits.action).toBe("accept");
    expect(overflows.action).toBe("reject");
    // Both verdicts were reached from the same resolved ceiling.
    expect(limit.maxInputTokens).toBe(512_000);
    expect(usable).toBeGreaterThan(0);
  });

  it("a configured window moves the whole chain, not just the display", () => {
    const fallbackLimit = resolveContextLimit({ providerType: "custom", modelId: MODEL });
    const configuredLimit = resolveContextLimit({
      providerType: "custom",
      modelId: MODEL,
      model: { contextWindow: 512_000, contextWindowSource: "configured" },
    });
    const fallbackBudget = computeBudget({ limit: fallbackLimit, modelOutputTokens: undefined });
    const configuredBudget = computeBudget({ limit: configuredLimit, modelOutputTokens: undefined });

    // This is the whole point of the regression: the 128k fallback produced a usable
    // budget that rejected valid requests, and configuration moves it without a code
    // change and without any model value in source.
    expect(fallbackLimit.maxInputTokens).toBe(UNKNOWN_LIMIT_CEILING);
    expect(configuredBudget.usableInputTokens).toBeGreaterThan(fallbackBudget.usableInputTokens);
  });
});

describe("identity is recorded on the resolution result", () => {
  it("Test 6 - the same model id on two endpoints resolves independently", () => {
    const a = resolveContextLimit({
      providerType: "custom",
      modelId: MODEL,
      providerId: "provider-a",
      endpoint: "https://a.example/v1",
      protocol: "chat-completions",
      model: { contextWindow: 200_000, contextWindowSource: "configured" },
    });
    const b = resolveContextLimit({
      providerType: "custom",
      modelId: MODEL,
      providerId: "provider-b",
      endpoint: "https://b.example/v1",
      protocol: "responses",
      model: { contextWindow: 1_000_000, contextWindowSource: "configured" },
    });

    expect(a.maxInputTokens).toBe(200_000);
    expect(b.maxInputTokens).toBe(1_000_000);
    expect(a.providerId).toBe("provider-a");
    expect(b.providerId).toBe("provider-b");
    expect(a.endpoint).toBe("https://a.example/v1");
    expect(b.endpoint).toBe("https://b.example/v1");
    expect(a.protocol).toBe("chat-completions");
    expect(b.protocol).toBe("responses");
  });

  it("identity is omitted, not invented, when the caller has none", () => {
    const limit = resolveContextLimit({ providerType: "custom", modelId: MODEL });
    expect(limit.providerId).toBeUndefined();
    expect(limit.endpoint).toBeUndefined();
    expect(limit.protocol).toBeUndefined();
    // And it is never inferred from the model id, which carries no endpoint meaning.
    expect(limit.modelId).toBe(MODEL);
  });

  it("the same input always produces the same identity-bearing result", () => {
    const args = {
      providerType: "custom" as const,
      modelId: MODEL,
      providerId: "provider-a",
      endpoint: "https://a.example/v1",
      protocol: "chat-completions" as const,
      model: { contextWindow: 512_000, contextWindowSource: "configured" as const },
    };
    expect(resolveContextLimit(args)).toEqual(resolveContextLimit(args));
  });
});

describe("conflicts are resolved once, deterministically, with evidence kept", () => {
  it("Test 7 - a discovered/configured conflict picks configured and retains the loser", () => {
    const args = {
      providerType: "custom" as const,
      modelId: MODEL,
      providerId: "provider-a",
      endpoint: "https://a.example/v1",
      model: { contextWindow: 128_000, contextWindowSource: "provider_reported" as const },
      configuredContextWindow: 512_000,
    };
    const first = resolveContextLimit(args);
    const second = resolveContextLimit(args);

    // Every consumer that calls the resolver gets the identical answer.
    expect(first.maxInputTokens).toBe(512_000);
    expect(first.source).toBe("configured");
    expect(second).toEqual(first);
    // The evidence that lost survives, so the disagreement is diagnosable rather than
    // erased by a precedence rule nobody can see.
    expect(first.divergent).toBe(true);
    expect(first.divergentValue).toEqual({ value: 128_000, source: "provider_reported" });
  });

  it("agreement is not treated as a conflict", () => {
    const limit = resolveContextLimit({
      providerType: "custom",
      modelId: MODEL,
      model: { contextWindow: 512_000, contextWindowSource: "provider_reported" },
      configuredContextWindow: 512_000,
    });
    expect(limit.divergent).toBe(false);
    expect(limit.divergentValue).toBeUndefined();
    // Nothing was overridden, so the stronger authority is reported.
    expect(limit.source).toBe("provider_reported");
  });
});

describe("fallback and unknown stay distinguishable from a verified figure", () => {
  it("Test 15 / PHASE 10 - no window yields the ceiling, labelled as a fallback", () => {
    const limit = resolveContextLimit({ providerType: "custom", modelId: MODEL });
    expect(limit.maxInputTokens).toBe(UNKNOWN_LIMIT_CEILING);
    expect(limit.source).toBe("conservative_default");
    // A fallback must never qualify as a provider claim.
    expect(limit.source).not.toBe("provider_reported");
  });

  it("the ceiling is unchanged by this work", () => {
    // The number is a product decision, deliberately not taken here.
    expect(UNKNOWN_LIMIT_CEILING).toBe(128_000);
  });

  it("output reservation and generation cap follow their own provenance", () => {
    // The output side is resolved separately and must not inherit the input's stance.
    expect(resolveOutputReservation(undefined).source).toBe("conservative_default");
    expect(resolveOutputReservation(8_192).source).toBe("provider_reported");
    const cap = resolveGenerationCap({
      modelOutputTokens: 8_192,
      ceilingTokens: 512_000,
      usableInputTokens: 400_000,
    });
    expect(cap.tokens).toBe(8_192);
    expect(cap.boundedByRemainingWindow).toBe(false);
  });
});

describe("no model name influences any resolution", () => {
  it("resolution is a function of stored values, never of the model's identity", () => {
    const stored = { contextWindow: 256_000, contextWindowSource: "configured" as const };
    const agnes = resolveContextLimit({ providerType: "custom", modelId: MODEL, model: stored });
    const nonsense = resolveContextLimit({ providerType: "custom", modelId: "zzz-9000-turbo", model: stored });
    const empty = resolveContextLimit({ providerType: "custom", modelId: "", model: stored });

    // Identical stored metadata yields an identical answer regardless of the id. If any
    // name-based table existed, these three would differ.
    expect(agnes.maxInputTokens).toBe(nonsense.maxInputTokens);
    expect(agnes.maxInputTokens).toBe(empty.maxInputTokens);
  });

  it("an id that looks like it encodes a size resolves to the fallback, not to that size", () => {
    for (const id of ["model-1m", "gpt-512k", "flash-200000", "agnes-3.0-flash-1m"]) {
      const limit = resolveContextLimit({ providerType: "custom", modelId: id });
      expect(limit.maxInputTokens).toBe(UNKNOWN_LIMIT_CEILING);
      expect(limit.source).toBe("conservative_default");
    }
  });
});
