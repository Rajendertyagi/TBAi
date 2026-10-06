/**
 * The in-memory observed-limit store, and the hierarchy it feeds.
 *
 * ## The one property worth testing hard
 *
 * A context window is a fact about a MODEL on an ENDPOINT under an ACCOUNT. All three
 * can differ for the same model id, so the only acceptable behaviour for a lookup that
 * does not match EXACTLY is to return nothing. A "closest match" would plan compaction
 * against a window belonging to a different deployment, which fails silently and in the
 * dangerous direction.
 *
 * So these tests are mostly about refusal, plus one about precedence: an observation is
 * evidence, and evidence must never overrule a declared figure.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  UNKNOWN_LIMIT_CEILING,
  describeLimitSource,
  isPhase3ExperimentEligible,
  resolveContextLimit,
} from "./limits";
import {
  MAX_OBSERVED_LIMIT_ENTRIES,
  clearObservedContextWindows,
  observeContextWindow,
  observedContextWindowCount,
  readObservedContextWindow,
} from "./observed-limits";
import type { ModelOption } from "../types";

const PROVIDER = "prov-a";
const OTHER_PROVIDER = "prov-b";
const ENDPOINT = "https://gateway.example/v1";

function model(id: string): { providerId: string; modelId: string; endpoint: string; protocol: string } {
  return { providerId: PROVIDER, modelId: id, endpoint: ENDPOINT, protocol: "chat-completions" };
}

afterEach(() => {
  clearObservedContextWindows();
});

describe("an observation is scoped to exactly one provider, model and endpoint", () => {
  it("reads back what it recorded", () => {
    observeContextWindow(model("m1"), 524_288);
    expect(readObservedContextWindow(model("m1"))?.limitTokens).toBe(524_288);
  });

  it("does not cross to another provider", () => {
    observeContextWindow(model("m1"), 524_288);
    expect(readObservedContextWindow({ ...model("m1"), providerId: OTHER_PROVIDER })).toBeUndefined();
  });

  it("does not cross to another model on the same provider", () => {
    observeContextWindow(model("m1"), 524_288);
    expect(readObservedContextWindow(model("m2"))).toBeUndefined();
  });

  it("does not cross to another endpoint", () => {
    observeContextWindow(model("m1"), 524_288);
    expect(readObservedContextWindow({ ...model("m1"), endpoint: "https://other.example/v1" })).toBeUndefined();
  });

  it("does not cross to another protocol", () => {
    observeContextWindow(model("m1"), 524_288);
    expect(readObservedContextWindow({ ...model("m1"), protocol: "responses" })).toBeUndefined();
  });

  it("cannot be made to collide by shifting characters between fields", () => {
    // Length-prefixed keys, so `("ab","c")` and `("a","bc")` cannot produce one key.
    observeContextWindow({ providerId: "ab", modelId: "c", endpoint: "", protocol: "" }, 200_000);
    expect(readObservedContextWindow({ providerId: "a", modelId: "bc", endpoint: "", protocol: "" })).toBeUndefined();
  });

  it("supersedes rather than accumulating when the provider changes its window", () => {
    observeContextWindow(model("m1"), 524_288);
    observeContextWindow(model("m1"), 262_144);
    expect(readObservedContextWindow(model("m1"))?.limitTokens).toBe(262_144);
    expect(observedContextWindowCount()).toBe(1);
  });

  it("refuses to record a non-positive or fractional figure", () => {
    observeContextWindow(model("m1"), 0);
    observeContextWindow(model("m1"), -5);
    observeContextWindow(model("m1"), 1.5);
    expect(readObservedContextWindow(model("m1"))).toBeUndefined();
  });

  it("stays bounded under a flood of distinct keys", () => {
    for (let i = 0; i < MAX_OBSERVED_LIMIT_ENTRIES + 40; i += 1) {
      observeContextWindow(model(`m${i}`), 200_000);
    }
    expect(observedContextWindowCount()).toBeLessThanOrEqual(MAX_OBSERVED_LIMIT_ENTRIES);
  });
});

describe("the resolution hierarchy", () => {
  const bare = { providerType: "custom" as const, providerId: PROVIDER, endpoint: ENDPOINT, protocol: "chat-completions" };

  it("falls back to the conservative stand-in when nothing is known", () => {
    const limit = resolveContextLimit({ ...bare, modelId: "m1" });
    expect(limit.maxInputTokens).toBe(UNKNOWN_LIMIT_CEILING);
    expect(limit.source).toBe("conservative_default");
  });

  it("uses an observed limit when the registry has nothing", () => {
    const limit = resolveContextLimit({ ...bare, modelId: "m1", observedContextWindow: 524_288 });
    expect(limit.maxInputTokens).toBe(524_288);
    expect(limit.source).toBe("observed");
    expect(describeLimitSource(limit)).toBe("observed");
  });

  it("ignores a nonsense observation and keeps the stand-in", () => {
    const limit = resolveContextLimit({ ...bare, modelId: "m1", observedContextWindow: 0 });
    expect(limit.maxInputTokens).toBe(UNKNOWN_LIMIT_CEILING);
    expect(limit.source).toBe("conservative_default");
  });

  it("does NOT let an observation override declared provider metadata", () => {
    const declared = { id: "m1", provider: "custom", contextWindow: 200_000, contextWindowSource: "provider_reported" } as unknown as ModelOption;
    const limit = resolveContextLimit({ ...bare, modelId: "m1", model: declared, observedContextWindow: 524_288 });
    expect(limit.maxInputTokens).toBe(200_000);
    expect(limit.source).toBe("provider_reported");
  });

  it("does NOT let an observation override an explicitly configured limit", () => {
    const limit = resolveContextLimit({
      ...bare,
      modelId: "m1",
      configuredContextWindow: 64_000,
      observedContextWindow: 524_288,
    });
    expect(limit.maxInputTokens).toBe(64_000);
    expect(limit.source).toBe("configured");
  });

  it("still resolves a declared/conflict the way it did before observations existed", () => {
    // configured beats a provider listing, and the loser is recorded rather than lost.
    const declared = { id: "m1", provider: "custom", contextWindow: 200_000, contextWindowSource: "provider_reported" } as unknown as ModelOption;
    const limit = resolveContextLimit({ ...bare, modelId: "m1", model: declared, configuredContextWindow: 64_000, observedContextWindow: 524_288 });
    expect(limit.maxInputTokens).toBe(64_000);
    expect(limit.source).toBe("configured");
    expect(limit.divergent).toBe(true);
    expect(limit.divergentValue).toEqual({ value: 200_000, source: "provider_reported" });
  });

  it("keeps the observation out of phase-3 eligibility, as declared", () => {
    // R1 admits ONLY `provider_reported`. An error-derived figure must not silently
    // authorise cache sizing or a cache experiment. Asserting the gate itself, not
    // the source string, so a future widening of R1 has to fail here deliberately.
    const observed = resolveContextLimit({ ...bare, modelId: "m1", observedContextWindow: 524_288 });
    expect(observed.source).toBe("observed");
    expect(isPhase3ExperimentEligible(observed)).toBe(false);

    const standIn = resolveContextLimit({ ...bare, modelId: "m1" });
    expect(isPhase3ExperimentEligible(standIn)).toBe(false);
  });
});