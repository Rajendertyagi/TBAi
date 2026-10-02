/**
 * The occupancy contract: current model-visible input, never token traffic.
 *
 * ## The defect class these pin
 *
 * Two numbers get called "input tokens". OCCUPANCY is the prompt the provider
 * was asked to hold; TRAFFIC is everything billed across a turn. A tool-using
 * turn makes several model calls and each re-reads the whole prompt, so traffic
 * can exceed the window several times over.
 *
 * Proven against AI SDK 7 with a real HTTP round trip, a stub reporting 5,000
 * then 9,000 prompt tokens over two steps:
 *
 *   per-step inputTokens ...... [5000, 9000]
 *   totalUsage.inputTokens ... 14000<- sum of steps: TRAFFIC
 *   last step inputTokens .... 9000<- final round trip: OCCUPANCY
 *
 * The meter must show 9,000. Showing 14,000 is the reported bug.
 */
import { describe, it, expect } from "bun:test";
import {
  buildContextState,
  providerOccupancyFromStepUsage,
  resolveOccupancy,
  toLimitProvenance,
  type ContextLimitProvenance,
  type OccupancyMeasurement,
} from "./occupancy";

/** AI SDK 7 `LanguageModelUsage` for ONE model call. */
const stepUsage = (inputTokens: number, cacheReadTokens?: number) => ({
  inputTokens,
  outputTokens: 40,
  totalTokens: inputTokens + 40,
  ...(cacheReadTokens === undefined
    ? {}
    : { inputTokenDetails: { cacheReadTokens, noCacheTokens: inputTokens - cacheReadTokens } }),
});

describe("occupancy: the provider's count of the last prompt", () => {
  it("reads a single step's prompt size as occupancy", () => {
    const measurement = providerOccupancyFromStepUsage(stepUsage(9_000));
    expect(measurement).toEqual({
      kind: "provider",
      inputTokens: 9_000,
      field: "last_step_input_tokens",
    });
  });

  it("keeps the cached portion separate instead of adding it", () => {
    const measurement = providerOccupancyFromStepUsage(stepUsage(90_000, 80_000));
    expect(measurement?.kind).toBe("provider");
    expect(measurement?.inputTokens).toBe(90_000);
    expect(measurement?.kind === "provider" ? measurement.cachedInputTokens : undefined).toBe(80_000);
    // 90k + 80k would be the 330%-readout bug.
    expect(measurement?.inputTokens).not.toBe(170_000);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "9000"],
    ["zero input", 0],
    ["negative input", -5],
    ["NaN", Number.NaN],
  ])("reports no measurement for %s rather than a fabricated zero", (_label, inputTokens) => {
    expect(providerOccupancyFromStepUsage({ inputTokens })).toBeUndefined();
  });
});

describe("occupancy: a summed turn is traffic and must not win", () => {
  it("prefers the measured round trip over an estimate", () => {
    const provider: OccupancyMeasurement = {
      kind: "provider",
      inputTokens: 9_000,
      field: "last_step_input_tokens",
    };
    expect(resolveOccupancy({ provider, estimatedTokens: 115_000 })?.inputTokens).toBe(9_000);
  });

  it("falls back to the estimate only when no measurement exists", () => {
    expect(resolveOccupancy({ estimatedTokens: 115_000 })).toEqual({
      kind: "estimate",
      inputTokens: 115_000,
      field: "chars_per_token",
    });
  });

  it("returns nothing when neither source produced a number", () => {
    expect(resolveOccupancy({})).toBeUndefined();
    expect(resolveOccupancy({ estimatedTokens: 0 })).toBeUndefined();
  });
});

describe("occupancy: provenance is never over-claimed", () => {
  it.each<[unknown, ContextLimitProvenance]>([
    ["provider_reported", "provider_reported"],
    ["configured", "configured"],
    ["conservative_default", "conservative_default"],
  ])("passes %s through", (input, expected) => {
    expect(toLimitProvenance(input)).toBe(expected);
  });

  it.each([["trust_me"], [""], [undefined], [null], [42]])(
    "narrows %p to unknown rather than defaulting to a trusted source",
    (input) => {
      expect(toLimitProvenance(input)).toBe("unknown");
    },
  );
});

describe("occupancy: the published state", () => {
  const occupancy = providerOccupancyFromStepUsage(stepUsage(9_000));

  it("carries used tokens, the window, and both provenances", () => {
    const state = buildContextState({
      occupancy,
      windowTokens: 1_000_000,
      windowSource: "configured",
      usableInputTokens: 746_928,
    });
    expect(state).toEqual({
      usedTokens: 9_000,
      windowTokens: 1_000_000,
      windowSource: "configured",
      usableInputTokens: 746_928,
      measurement: occupancy,
    });
  });

  it("refuses to publish without a denominator", () => {
    // A meter with no window cannot honestly report a percentage.
    expect(
      buildContextState({ occupancy, windowTokens: undefined, windowSource: "configured", usableInputTokens: 1 }),
    ).toBeUndefined();
    expect(
      buildContextState({ occupancy, windowTokens: 0, windowSource: "conservative_default", usableInputTokens: 0 }),
    ).toBeUndefined();
  });

  it("refuses to publish without occupancy", () => {
    expect(
      buildContextState({
        occupancy: undefined,
        windowTokens: 1_000_000,
        windowSource: "provider_reported",
        usableInputTokens: 900_000,
      }),
    ).toBeUndefined();
  });

  it("falls back to the window when no usable budget was reported", () => {
    const state = buildContextState({
      occupancy,
      windowTokens: 1_000_000,
      windowSource: "provider_reported",
      usableInputTokens: undefined,
    });
    expect(state?.usableInputTokens).toBe(1_000_000);
  });
});

describe("occupancy: THE REGRESSION", () => {
  it("a three-step turn reports occupancy, not the traffic sum", () => {
    // The real shape of the bug: three steps of ~950k context. Traffic says
    // 2.86M, which against a 1M window reads as 100% full.
    const perStep = [950_000, 950_000, 960_000];
    const traffic = perStep.reduce((a, n) => a + n, 0);
    const lastStep = providerOccupancyFromStepUsage(stepUsage(perStep.at(-1)!));

    expect(traffic).toBe(2_860_000);
    expect(lastStep?.inputTokens).toBe(960_000);

    const state = buildContextState({
      occupancy: lastStep,
      windowTokens: 1_000_000,
      windowSource: "configured",
      usableInputTokens: 746_928,
    });
    expect(state).toBeDefined();
    // 96%, not 286%.
    expect(Math.round((state!.usedTokens / state!.windowTokens) * 100)).toBe(96);
  });
});