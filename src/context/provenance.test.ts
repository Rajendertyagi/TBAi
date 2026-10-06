/**
 * R1 — limit provenance, resolution order, and the generation cap.
 *
 * R1 found that `ModelOption.contextWindow` mixed a provider-reported figure
 * and a human-typed one in the same field, so provenance was unrecoverable and
 * the pre-R1 `model_reported` branch would have logged a user's number as the
 * provider's own. These assert the properties that close that defect:
 *
 * - a stance is ALWAYS reported alongside a number, and never inferred from it;
 * - a user-entered value can never be labelled `provider_reported`;
 * - a stood-in-for ceiling can never authorise a Phase 3 cache experiment;
 * - the input-budget reserve and the model's generation cap are separate
 *   quantities, and `input + output <= ceiling` holds.
 *
 * These assert EXTERNALLY MEANINGFUL behaviour (which stance comes out, whether a
 * Phase 3 experiment is authorised, whether the arithmetic invariant holds)
 * rather than mirroring the resolver's branches.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_GENERATION_CAP,
  UNKNOWN_LIMIT_CEILING,
  computeBudget,
  isPhase3ExperimentEligible,
  resolveContextLimit,
  resolveGenerationCap,
  selectModelOption,
} from "./index";
import type { UIMessage } from "ai";
import { assembleContext } from "./index";
import type { ContextLimit } from "./types";
import { configuredLimit, providerReportedLimit, type ModelOption, type ProviderConfig } from "../types";
import { contextWindowSourceSchema, modelOptionSchema } from "../lib/validation";
import { discoverModels } from "../services/modelDiscovery";

const modelId = "m-1";

/** A provider carrying exactly the stored model metadata under test. */
function providerWith(models: ModelOption[]): ProviderConfig {
  return { id: "p1", name: "Test", type: "custom", model: modelId, models } as unknown as ProviderConfig;
}

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage;
}

const signal = new AbortController().signal;

async function assembleWith(models: ModelOption[], messages: UIMessage[] = [user("u1", "hi")]) {
  return assembleContext({
    conversationId: undefined,
    submittedMessages: messages,
    runId: "run_test",
    provider: providerWith(models),
    modelId,
    systemPrompt: undefined,
    toolSignal: signal,
  });
}

describe("R1 · provenance travels with the number", () => {
  it("reports a provider-stated figure as provider_reported", () => {
    const limit = resolveContextLimit({
      providerType: "anthropic",
      modelId,
      model: { contextWindow: 524288, contextWindowSource: "provider_reported" },
    });
    expect(limit.source).toBe("provider_reported");
    expect(limit.maxInputTokens).toBe(524288);
  });

  it("reports a human-set figure as configured, never as provider_reported", () => {
    // THE R1 DEFECT. A number the user typed must never acquire the provider's
    // authority, no matter how plausible its magnitude.
    const limit = resolveContextLimit({
      providerType: "custom",
      modelId,
      model: { contextWindow: 524288, contextWindowSource: "configured" },
    });
    expect(limit.source).toBe("configured");
    expect(limit.source).not.toBe("provider_reported");
    expect(limit.maxInputTokens).toBe(524288);
  });

  it("does not infer provenance from the magnitude of a value", () => {
    // A 512K user-typed figure and a 512K provider figure are indistinguishable
    // by number. Only the recorded stance separates them.
    const typed = resolveContextLimit({
      providerType: "custom",
      modelId,
      model: { contextWindow: 524288, contextWindowSource: "configured" },
    });
    const stated = resolveContextLimit({
      providerType: "custom",
      modelId,
      model: { contextWindow: 524288, contextWindowSource: "provider_reported" },
    });
    expect(typed.maxInputTokens).toBe(stated.maxInputTokens);
    expect(typed.source).not.toBe(stated.source);
  });

  it("reports no figure at all as a conservative stand-in", () => {
    const limit = resolveContextLimit({ providerType: "custom", modelId });
    expect(limit.source).toBe("conservative_default");
    expect(limit.maxInputTokens).toBe(UNKNOWN_LIMIT_CEILING);
  });

  it("treats an unknown model exactly like an unknown limit", () => {
    const limit = resolveContextLimit({ providerType: "custom", modelId: "never-heard-of-it" });
    expect(limit.source).toBe("conservative_default");
    expect(limit.divergent).toBe(false);
  });

  it("resolves a pre-R1 bare value as configured rather than claiming it was reported", () => {
    // A row written before R1 has a number and no stance. Failing closed toward
    // `configured` understates authority instead of over-claiming it.
    const limit = resolveContextLimit({
      providerType: "anthropic",
      modelId,
      model: { contextWindow: 200000 },
    });
    expect(limit.source).toBe("configured");
    expect(limit.maxInputTokens).toBe(200000);
  });

  it("rejects a value that is present but unusable", () => {
    // Present-and-invalid must not degrade into a stand-in presented as fact.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const limit = resolveContextLimit({
        providerType: "anthropic",
        modelId,
        model: { contextWindow: bad, contextWindowSource: "provider_reported" },
      });
      expect(limit.source).toBe("conservative_default");
    }
  });

  it("rejects a fractional value rather than flooring it into an authoritative window", () => {
    // A context limit is a COUNT of tokens. Flooring 1000.9 to 1000 and then
    // trusting the result published a figure no source ever stated, under a
    // provenance label implying a source did state it. The malformed value is
    // therefore discarded, and the original is preserved for diagnosis.
    const limit = resolveContextLimit({
      providerType: "custom",
      modelId,
      model: { contextWindow: 1000.9, contextWindowSource: "provider_reported" },
    });

    expect(limit.source).toBe("conservative_default");
    expect(limit.maxInputTokens).toBe(UNKNOWN_LIMIT_CEILING);
    // Flooring must not be reachable by any route back into authority.
    expect(limit.maxInputTokens).not.toBe(1000);

    const stored = limit.candidates?.find((c) => c.field === "model.contextWindow");
    expect(stored?.present).toBe(true);
    expect(stored?.valid).toBe(false);
    expect(stored?.rejectionReason).toBe("non_integer");
    // The value the provider actually wrote is kept, unrounded.
    expect(stored?.suppliedValue).toBe(1000.9);
    expect(stored?.value).toBeNull();
    expect(stored?.selected).toBe(false);
  });

  it("cannot promote a fractional candidate to authority through flooring", () => {
    // Regression guard for the exact defect: whatever the caller supplies, a
    // non-integer window must never become `maxInputTokens`, and must never
    // carry `provider_reported`.
    for (const bad of [1000.9, 0.5, 524288.1, Number.EPSILON * 1e12]) {
      const limit = resolveContextLimit({
        providerType: "custom",
        modelId,
        model: { contextWindow: bad, contextWindowSource: "provider_reported" },
      });
      expect(limit.source).not.toBe("provider_reported");
      expect(limit.source).toBe("conservative_default");
      expect(Number.isInteger(limit.maxInputTokens)).toBe(true);
      expect(limit.maxInputTokens).not.toBe(Math.floor(bad));
      // A rejected figure must not be able to authorise anything downstream.
      expect(isPhase3ExperimentEligible(limit)).toBe(false);
    }
  });

  it("selects the requested model and nothing else, by id alone", () => {
    const models: ModelOption[] = [
      { id: "other", provider: "custom", contextWindow: 1, contextWindowSource: "provider_reported" },
      { id: modelId, provider: "custom", contextWindow: 2, contextWindowSource: "provider_reported" },
    ];
    expect(selectModelOption(models, modelId)?.contextWindow).toBe(2);
    // No provider-name or model-name knowledge may leak into this lookup.
    expect(selectModelOption(undefined, modelId)).toBeUndefined();
    expect(selectModelOption([], modelId)).toBeUndefined();
  });
});

describe("R1 · conflicting provider and configured figures", () => {
  const conflictInput = {
    providerType: "custom" as const,
    modelId,
    model: { contextWindow: 524288, contextWindowSource: "provider_reported" as const },
    configuredContextWindow: 100000,
  };

  it("prefers the operator's figure when the two disagree", () => {
    // Decision A2. A published window is model-wide; this vendor's own docs say
    // limits follow the account entitlement, so the operator may know a
    // per-account truth the listing cannot express.
    const limit = resolveContextLimit(conflictInput);
    expect(limit.maxInputTokens).toBe(100000);
    expect(limit.source).toBe("configured");
  });

  it("makes the disagreement observable instead of discarding it", () => {
    const limit = resolveContextLimit(conflictInput);
    expect(limit.divergent).toBe(true);
    expect(limit.divergentValue).toEqual({ value: 524288, source: "provider_reported" });
  });

  it("is deterministic — the same inputs always resolve the same way", () => {
    const first = resolveContextLimit(conflictInput);
    const second = resolveContextLimit(conflictInput);
    expect(first).toEqual(second);
  });

  it("does not report divergence when the two figures agree", () => {
    const limit = resolveContextLimit({ ...conflictInput, configuredContextWindow: 524288 });
    expect(limit.divergent).toBe(false);
    expect(limit.divergentValue).toBeUndefined();
    // Agreement means no intent is overridden, so the stronger authority is
    // honestly reportable.
    expect(limit.source).toBe("provider_reported");
  });

  it("never reports divergence when only one figure exists", () => {
    const limit = resolveContextLimit({
      providerType: "custom",
      modelId,
      model: { contextWindow: 524288, contextWindowSource: "provider_reported" },
    });
    expect(limit.divergent).toBe(false);
    expect(limit.divergentValue).toBeUndefined();
  });

  it("does not manufacture a conflict from an unusable configured figure", () => {
    const limit = resolveContextLimit({ ...conflictInput, configuredContextWindow: 0 });
    expect(limit.divergent).toBe(false);
    expect(limit.source).toBe("provider_reported");
  });
});

describe("R1 · only a provider-reported ceiling may size a Phase 3 experiment", () => {
  /** Build a limit the way a caller would, from a stored model. */
  function limitFor(model?: Pick<ModelOption, "contextWindow" | "contextWindowSource">): ContextLimit {
    return resolveContextLimit({ providerType: "custom", modelId, model });
  }

  it("authorises an experiment only for a provider-reported ceiling", () => {
    expect(
      isPhase3ExperimentEligible(limitFor({ contextWindow: 524288, contextWindowSource: "provider_reported" })),
    ).toBe(true);
  });

  it("refuses to size an experiment from the conservative stand-in", () => {
    // The binding Phase 3 rule: a fictional ceiling may bound safety, never a
    // cache experiment.
    expect(isPhase3ExperimentEligible(limitFor())).toBe(false);
    expect(isPhase3ExperimentEligible(limitFor())).toBe(false);
  });

  it("refuses to size an experiment from an operator's configured belief", () => {
    expect(isPhase3ExperimentEligible(limitFor({ contextWindow: 524288, contextWindowSource: "configured" }))).toBe(
      false,
    );
  });

  it("refuses to size an experiment from a pre-R1 bare value", () => {
    expect(isPhase3ExperimentEligible(limitFor({ contextWindow: 524288 }))).toBe(false);
  });

  it("refuses to size an experiment when a conflict was resolved", () => {
    const limit = resolveContextLimit({
      providerType: "custom",
      modelId,
      model: { contextWindow: 524288, contextWindowSource: "provider_reported" },
      configuredContextWindow: 100000,
    });
    expect(isPhase3ExperimentEligible(limit)).toBe(false);
  });
});

describe("R1 · input reserve and generation cap are different quantities", () => {
  const statedLimit = resolveContextLimit({
    providerType: "custom",
    modelId,
    model: { contextWindow: 524288, contextWindowSource: "provider_reported" },
  });

  it("keeps the pre-R1 behaviour when no source documents an output ceiling", () => {
    // No provider populates an output ceiling today, so generation is still
    // capped at the reserve-sized default. The change must be behaviour-neutral
    // for every path that currently exists.
    const budget = computeBudget({ limit: statedLimit });
    expect(budget.generationCap.tokens).toBe(DEFAULT_GENERATION_CAP);
    expect(budget.generationCap.source).toBe("conservative_default");
  });

  it("raises generation to a provider-documented output ceiling", () => {
    // The capability R1 exposed: a model documenting 65,536 output tokens was
    // capped at 4,096 because the two quantities shared one value.
    const budget = computeBudget({ limit: statedLimit, modelOutputTokens: 65536 });
    expect(budget.generationCap.tokens).toBe(65536);
    expect(budget.generationCap.source).toBe("provider_reported");
    // The input reserve does NOT follow it — that is the whole point.
    expect(budget.outputReservation.tokens).toBeLessThan(65536);
  });

  it("keeps input + output within the effective limit", () => {
    // The invariant the pre-R1 sharing of one value satisfied by accident.
    for (const ceiling of [524288, 128000, 10000, 2000]) {
      for (const modelOutputTokens of [undefined, 65536, 8192]) {
        const limit = resolveContextLimit({
          providerType: "custom",
          modelId,
          model: { contextWindow: ceiling, contextWindowSource: "provider_reported" },
        });
        const budget = computeBudget({ limit, modelOutputTokens });
        expect((budget.usableInputTokens ?? 0) + budget.generationCap.tokens).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it("clamps a documented output ceiling that exceeds the room left in the window", () => {
    // A 65,536-token output cap on a 10,000-token window would send TBAi into a
    // provider rejection it had already pre-flighted against.
    const limit = resolveContextLimit({
      providerType: "custom",
      modelId,
      model: { contextWindow: 10000, contextWindowSource: "provider_reported" },
    });
    const cap = computeBudget({ limit, modelOutputTokens: 65536 }).generationCap;
    expect(cap.tokens).toBeLessThan(65536);
    expect(cap.boundedByRemainingWindow).toBe(true);
  });

  it("still produces a positive cap when the limit is not enforceable", () => {
    // No ceiling means no window to clamp against — but an uncapped generation is
    // not an option.
    const unenforceable: ContextLimit = {
      maxInputTokens: undefined,
      source: "unknown",
      providerType: "custom",
      modelId,
      divergent: false,
    };
    const budget = computeBudget({ limit: unenforceable, modelOutputTokens: 65536 });
    expect(budget.enforceable).toBe(false);
    expect(budget.generationCap.tokens).toBe(65536);
    expect(budget.generationCap.boundedByRemainingWindow).toBe(false);
  });

  it("never lets the generation cap reach or exceed zero", () => {
    for (const ceiling of [1, 2, 100, 4096]) {
      const limit = resolveContextLimit({
        providerType: "custom",
        modelId,
        model: { contextWindow: ceiling, contextWindowSource: "provider_reported" },
      });
      for (const modelOutputTokens of [undefined, 65536]) {
        const cap = resolveGenerationCap({
          modelOutputTokens,
          ceilingTokens: ceiling,
          usableInputTokens: computeBudget({ limit, modelOutputTokens }).usableInputTokens,
        });
        expect(cap.tokens).toBeGreaterThan(0);
      }
    }
  });

  it("loosens the budget when a real, larger limit becomes known", () => {
    // The false-rejection correction R1 exists for: the stand-in refuses ~76% of
    // the usable window of a documented 512K model.
    const standIn = computeBudget({ limit: resolveContextLimit({ providerType: "custom", modelId }) });
    const real = computeBudget({ limit: statedLimit });
    expect(real.usableInputTokens!).toBeGreaterThan(standIn.usableInputTokens!);
  });
});

describe("R1 · model metadata actually reaches the resolver", () => {
  it("enforces a provider-reported limit the seam was never given before", async () => {
    // Pre-R1 the seam passed only providerType+modelId, so `model_reported` was
    // dead code and every request resolved to the stand-in.
    const result = await assembleWith([
      { id: modelId, provider: "custom", contextWindow: 524288, contextWindowSource: "provider_reported" },
    ]);
    expect(result.context.provenance.limit.source).toBe("provider_reported");
    expect(result.diagnostics.limitSource).toBe("provider_reported");
    expect(result.diagnostics.phase3ExperimentEligible).toBe(true);
  });

  it("carries an operator's figure through as configured, not as reported", async () => {
    const result = await assembleWith([
      { id: modelId, provider: "custom", contextWindow: 524288, contextWindowSource: "configured" },
    ]);
    expect(result.context.provenance.limit.source).toBe("configured");
    expect(result.diagnostics.phase3ExperimentEligible).toBe(false);
  });

  it("still resolves to the stand-in when the provider lists no matching model", async () => {
    const result = await assembleWith([{ id: "a-different-model", provider: "custom" }]);
    expect(result.context.provenance.limit.source).toBe("conservative_default");
    expect(result.diagnostics.phase3ExperimentEligible).toBe(false);
  });

  it("still resolves to the stand-in for a provider that exposes no limit metadata", async () => {
    // OpenAI/Google/Ollama/custom listings carry identity only (Phase 1 F14).
    const result = await assembleWith([{ id: modelId, provider: "custom" }]);
    expect(result.context.provenance.limit.source).toBe("conservative_default");
  });

  it("applies a provider-reported output ceiling to the request's generation cap", async () => {
    const result = await assembleWith([
      {
        id: modelId,
        provider: "custom",
        contextWindow: 524288,
        contextWindowSource: "provider_reported",
        maxOutputTokens: 65536,
        maxOutputTokensSource: "provider_reported",
      },
    ]);
    expect(result.context.provenance.budget.generationCap.tokens).toBe(65536);
  });

  it("rejects an oversized request against the real limit, not the stand-in", async () => {
    const huge = [user("u1", "x".repeat(3_000_000))];
    const result = await assembleWith(
      [{ id: modelId, provider: "custom", contextWindow: 524288, contextWindowSource: "provider_reported" }],
      huge,
    );
    expect(result.decision.action).toBe("reject");
  });

  it("never terminally rejects against a stand-in, and still bounds the request", async () => {
    // ~200k tokens: refused against the 128k stand-in, fine against a real 512K.
    //
    // P-1 changed the second half of this test. It previously asserted that an
    // unknown model produced `reject` — i.e. that a figure TBAi INVENTED was enforced
    // as though the provider had stated it. That is the Agnes failure: the request
    // never reaches transport, so no real limit can ever be learned. The stand-in is
    // now advisory, and Tier 2 (not the stand-in) is what bounds the request.
    const big = [user("u1", "x".repeat(600_000))];

    const real = await assembleWith(
      [{ id: modelId, provider: "custom", contextWindow: 524288, contextWindowSource: "provider_reported" }],
      big,
    );
    expect(real.decision.action).not.toBe("reject");

    const standIn = await assembleWith([{ id: modelId, provider: "custom" }], big);
    // Advisory, not terminal — the request proceeds so the provider can decide.
    expect(standIn.decision.action).toBe("advisory");
    // And the request is still converted for transport, which is what "not terminal"
    // has to mean in practice.
    expect(standIn.context.modelMessages.length).toBeGreaterThan(0);
    // Tier 2 passed it: ~200k is far below the 4,194,304 assembly ceiling.
    expect(standIn.tier2.outcome).toBe("within_assembly_limit");
    // The stand-in is reported as a stand-in, never as the provider's own figure.
    expect(standIn.diagnostics.limitSource).toBe("conservative_default(128000)");
  });

  it("reports divergence in diagnostics only when it happened", async () => {
    const agreed = await assembleWith([
      { id: modelId, provider: "custom", contextWindow: 524288, contextWindowSource: "provider_reported" },
    ]);
    expect(agreed.diagnostics.limitDivergent).toBeUndefined();
  });

  it("keeps the diagnostics free of prompt text while reporting provenance", async () => {
    const secret = "SECRET_PROBE_STRING_NOT_FOR_LOGS";
    const result = await assembleWith(
      [{ id: modelId, provider: "custom", contextWindow: 524288, contextWindowSource: "configured" }],
      [user("u1", secret)],
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain(secret);
  });
});

describe("R1 · the two writers cannot be confused", () => {
  it("gives discovery a provider_reported figure and the dialog a configured one", () => {
    expect(providerReportedLimit(524288)).toEqual({ value: 524288, source: "provider_reported" });
    expect(configuredLimit(524288)).toEqual({ value: 524288, source: "configured" });
    // Identical magnitudes, opposite authority — the stance is the only difference.
    expect(providerReportedLimit(1).value).toBe(configuredLimit(1).value);
    expect(providerReportedLimit(1).source).not.toBe(configuredLimit(1).source);
  });

  it("accepts exactly the two storable stances in persisted config", () => {
    expect(contextWindowSourceSchema.parse("provider_reported")).toBe("provider_reported");
    expect(contextWindowSourceSchema.parse("configured")).toBe("configured");
    // The resolver's other two states are not facts about a model and must never
    // be persisted against one.
    for (const bad of ["conservative_default", "unknown", "model_reported", "reported", ""]) {
      expect(() => contextWindowSourceSchema.parse(bad)).toThrow();
    }
  });

  it("round-trips a stanced model through storage without losing the stance", () => {
    const stored: ModelOption = {
      id: modelId,
      provider: "custom",
      contextWindow: 524288,
      contextWindowSource: "provider_reported",
      maxOutputTokens: 65536,
      maxOutputTokensSource: "provider_reported",
    };
    const restored = modelOptionSchema.parse(JSON.parse(JSON.stringify(stored)) as unknown);
    expect(restored).toEqual(stored);
  });

  it("still validates a pre-R1 row that carries no stance", () => {
    // Backwards compatible: existing rows must keep loading, unchanged.
    const legacy = modelOptionSchema.parse({ id: modelId, provider: "custom", contextWindow: 200000 });
    expect(legacy.contextWindow).toBe(200000);
    expect(legacy.contextWindowSource).toBeUndefined();
  });

  it("rejects a stanced model whose stance is not a real one", () => {
    expect(() =>
      modelOptionSchema.parse({ id: modelId, provider: "custom", contextWindow: 1, contextWindowSource: "guessed" }),
    ).toThrow();
  });

  it("resolves a stored-and-restored provider figure back to provider_reported", () => {
    // Full round-trip: written by the provider writer, persisted, reloaded, resolved.
    const written = { id: modelId, provider: "custom", ...providerReportedLimit(524288) };
    const stored = { ...written, contextWindow: written.value, contextWindowSource: written.source };
    const restored = modelOptionSchema.parse(stored);
    const limit = resolveContextLimit({
      providerType: "custom",
      modelId,
      model: selectModelOption([restored], modelId),
    });
    expect(limit.source).toBe("provider_reported");
    expect(isPhase3ExperimentEligible(limit)).toBe(true);
  });
});

describe("R1 · discovery is the only producer of a provider_reported figure", () => {
  const origFetch = globalThis.fetch;

  function serveModels(payload: unknown): void {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/models")) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("tags a figure read from the provider's own listing as provider_reported", async () => {
    serveModels({ data: [{ id: "claude-x", display_name: "X", max_input_tokens: 200000, max_output_tokens: 8192 }] });
    const [model] = await discoverModels({ type: "anthropic", endpoint: "http://mock", apiKey: "k" });
    expect(model?.contextWindow).toBe(200000);
    expect(model?.contextWindowSource).toBe("provider_reported");
    expect(model?.maxOutputTokens).toBe(8192);
    expect(model?.maxOutputTokensSource).toBe("provider_reported");
  });

  it("emits no stance at all when the listing omits the figure", async () => {
    // Absence of metadata is not evidence of a limit. Emitting a stand-in here
    // would persist a number the provider never stated.
    serveModels({ data: [{ id: "claude-x" }] });
    const [model] = await discoverModels({ type: "anthropic", endpoint: "http://mock", apiKey: "k" });
    expect(model?.contextWindow).toBeUndefined();
    expect(model?.contextWindowSource).toBeUndefined();
  });

  it("gives no provider-derived figure to listings that expose none", async () => {
    // Phase 1 F14: openai/google/ollama/custom listings carry identity only.
    serveModels({ data: [{ id: "gpt-x" }] });
    const openai = await discoverModels({ type: "openai", endpoint: "http://mock/v1" });
    expect(openai[0]?.contextWindowSource).toBeUndefined();
    expect(openai[0]?.maxOutputTokens).toBeUndefined();
  });

  it("never lets discovery produce a configured figure", async () => {
    serveModels({ data: [{ id: "claude-x", max_input_tokens: 200000 }] });
    const [model] = await discoverModels({ type: "anthropic", endpoint: "http://mock", apiKey: "k" });
    expect(model?.contextWindowSource).not.toBe("configured");
  });
});