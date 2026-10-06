/**
 * Diagnostic candidate provenance for the context-limit resolver.
 *
 * These tests exist because the resolver used to answer every failure mode
 * identically: a provider that published `contextWindow: 0`, an operator who
 * typed `524288.5`, and a model with no figure at all all resolved to the same
 * `conservative_default` ceiling, with nothing surviving to say which had
 * happened. Every assertion below is therefore about the RECORD — what was
 * supplied, what became of it, and whether the selection could have differed.
 *
 * The invariant under test throughout: `candidates` is diagnostic output. It
 * is written after the winner is chosen and is never read while choosing it.
 */
import { describe, expect, it } from "bun:test";
import {
  UNKNOWN_LIMIT_CEILING,
  resolveContextLimit,
} from "./limits";
import type { LimitCandidateRecord } from "./types";

const MODEL = "claude-test";
const base = { providerType: "custom" as const, modelId: MODEL, providerId: "provider-a" };

function candidate(
  limit: { candidates?: readonly LimitCandidateRecord[] },
  field: LimitCandidateRecord["field"],
): LimitCandidateRecord | undefined {
  return limit.candidates?.find((record) => record.field === field);
}

/** Everything EXCEPT the diagnostic block, used to prove selection is unchanged. */
function withoutDiagnostics<T extends { candidates?: unknown }>(limit: T): Omit<T, "candidates"> {
  const { candidates: _ignored, ...rest } = limit;
  return rest;
}

describe("rejected candidates are reported, not discarded", () => {
  // A — fractional candidate is rejected.
  it("rejects a fractional candidate with an explicit reason and keeps the original", () => {
    const limit = resolveContextLimit({
      ...base,
      model: { contextWindow: 200_000.75, contextWindowSource: "provider_reported" },
    });

    const stored = candidate(limit, "model.contextWindow");
    expect(stored?.present).toBe(true);
    expect(stored?.valid).toBe(false);
    expect(stored?.rejectionReason).toBe("non_integer");
    expect(stored?.suppliedValue).toBe(200_000.75);
    expect(stored?.value).toBeNull();
    expect(stored?.selected).toBe(false);
    expect(stored?.outcome).toBe("rejected");

    // And the rejection actually cost it the selection.
    expect(limit.source).toBe("conservative_default");
    expect(limit.maxInputTokens).toBe(UNKNOWN_LIMIT_CEILING);
    expect(limit.maxInputTokens).not.toBe(200_000);
  });

  // B — an invalid candidate never wins, even alongside a valid one.
  it("never lets an invalid candidate win, even when it is the only supplied figure", () => {
    for (const bad of [
      { value: 0, reason: "non_positive" },
      { value: -1, reason: "non_positive" },
      { value: Number.NaN, reason: "non_finite" },
      { value: Number.POSITIVE_INFINITY, reason: "non_finite" },
      { value: 12.5, reason: "non_integer" },
      { value: "512000" as unknown as number, reason: "not_a_number" },
    ] as const) {
      const limit = resolveContextLimit({
        ...base,
        model: { contextWindow: bad.value, contextWindowSource: "provider_reported" },
      });
      expect(limit.source).toBe("conservative_default");
      expect(candidate(limit, "model.contextWindow")?.rejectionReason).toBe(bad.reason);
      expect(candidate(limit, "model.contextWindow")?.selected).toBe(false);
    }
  });

  // C — absent is distinguishable from invalid.
  it("distinguishes an absent candidate from an invalid one", () => {
    const absent = resolveContextLimit({ ...base });
    const invalid = resolveContextLimit({
      ...base,
      model: { contextWindow: -1, contextWindowSource: "provider_reported" },
    });

    // Both fall back to the same ceiling — that is the pre-existing contract
    // and it must not change. What changes is that they are no longer identical.
    expect(absent.source).toBe(invalid.source);
    expect(absent.maxInputTokens).toBe(invalid.maxInputTokens);
    expect(withoutDiagnostics(absent)).toEqual(withoutDiagnostics(invalid));

    const absentRecord = candidate(absent, "model.contextWindow");
    const invalidRecord = candidate(invalid, "model.contextWindow");

    expect(absentRecord?.present).toBe(false);
    expect(absentRecord?.valid).toBe(false);
    expect(absentRecord?.rejectionReason).toBeNull();
    expect(absentRecord?.suppliedValue).toBeNull();
    // Absence is not a rejection: nothing was supplied, so nothing was judged.
    expect(absentRecord?.outcome).toBe("not_compared");

    expect(invalidRecord?.present).toBe(true);
    expect(invalidRecord?.valid).toBe(false);
    expect(invalidRecord?.rejectionReason).toBe("non_positive");
    expect(invalidRecord?.suppliedValue).toBe(-1);
    expect(invalidRecord?.outcome).toBe("rejected");

    expect(absentRecord).not.toEqual(invalidRecord);
  });

  // D — two equal valid candidates reach the agreement branch non-vacuously.
  it("reaches the agreement branch, and labels both candidates as agreeing", () => {
    const limit = resolveContextLimit({
      ...base,
      model: { contextWindow: 512_000, contextWindowSource: "provider_reported" },
      configuredContextWindow: 512_000,
    });

    // Non-vacuous: both candidates really were collected, so the branch that
    // reports the stronger authority executed rather than being skipped.
    const records = limit.candidates?.filter((record) => record.valid) ?? [];
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.value)).toEqual([512_000, 512_000]);
    expect(records.every((r) => r.outcome === "agreed")).toBe(true);
    expect(records.every((r) => r.selected)).toBe(true);

    expect(limit.source).toBe("provider_reported");
    expect(limit.maxInputTokens).toBe(512_000);
    // Agreement is not a disagreement.
    expect(limit.divergent).toBe(false);
    expect(limit.divergentValue).toBeUndefined();
  });

  // E — two conflicting valid candidates preserve the existing precedence.
  it("keeps configured precedence on conflict and records the loser", () => {
    const limit = resolveContextLimit({
      ...base,
      model: { contextWindow: 128_000, contextWindowSource: "provider_reported" },
      configuredContextWindow: 512_000,
    });

    expect(limit.maxInputTokens).toBe(512_000);
    expect(limit.source).toBe("configured");
    expect(limit.divergent).toBe(true);
    expect(limit.divergentValue).toEqual({ value: 128_000, source: "provider_reported" });

    const stored = candidate(limit, "model.contextWindow");
    const configuredRecord = candidate(limit, "configuredContextWindow");
    expect(stored?.outcome).toBe("lost_precedence");
    expect(stored?.selected).toBe(false);
    expect(configuredRecord?.outcome).toBe("conflicted");
    expect(configuredRecord?.selected).toBe(true);
  });

  // F — one valid candidate preserves existing behaviour.
  it("keeps single-candidate behaviour and marks the lone winner", () => {
    const limit = resolveContextLimit({
      ...base,
      model: { contextWindow: 200_000, contextWindowSource: "provider_reported" },
    });

    expect(limit.maxInputTokens).toBe(200_000);
    expect(limit.source).toBe("provider_reported");
    expect(limit.divergent).toBe(false);

    const stored = candidate(limit, "model.contextWindow");
    expect(stored?.selected).toBe(true);
    expect(stored?.outcome).toBe("not_compared");
    // Nothing else was supplied, so there was nothing to compare against and
    // nothing to reject — absence is reported as absence.
    const configuredRecord = candidate(limit, "configuredContextWindow");
    expect(configuredRecord?.present).toBe(false);
    expect(configuredRecord?.selected).toBe(false);
  });

  // G — zero valid candidates preserve the conservative fallback.
  it("falls back conservatively when every candidate is invalid", () => {
    const limit = resolveContextLimit({
      ...base,
      model: { contextWindow: 0, contextWindowSource: "provider_reported" },
      configuredContextWindow: Number.NaN,
    });

    expect(limit.maxInputTokens).toBe(UNKNOWN_LIMIT_CEILING);
    expect(limit.source).toBe("conservative_default");
    expect(limit.divergent).toBe(false);

    expect(candidate(limit, "model.contextWindow")?.outcome).toBe("rejected");
    expect(candidate(limit, "configuredContextWindow")?.rejectionReason).toBe("non_finite");
    // Nothing was selected because nothing was valid.
    expect(limit.candidates?.every((record) => !record.selected)).toBe(true);
  });

  // H — diagnostics never influence selection.
  it("cannot change the winner, whatever it records", () => {
    const cases = [
      { ...base, model: { contextWindow: 200_000, contextWindowSource: "provider_reported" as const } },
      { ...base, model: { contextWindow: 128_000, contextWindowSource: "provider_reported" as const }, configuredContextWindow: 512_000 },
      { ...base, model: { contextWindow: 512_000, contextWindowSource: "provider_reported" as const }, configuredContextWindow: 512_000 },
      { ...base, model: { contextWindow: 1000.9, contextWindowSource: "provider_reported" as const } },
      { ...base },
    ] as const;

    for (const input of cases) {
      const first = resolveContextLimit(input as never);
      const second = resolveContextLimit(input as never);
      // Selection is a pure function of the participating candidates.
      expect(withoutDiagnostics(first)).toEqual(withoutDiagnostics(second));
      // And the diagnostic block is deterministic too, so a reader comparing
      // two runs is not shown noise.
      expect(first.candidates).toEqual(second.candidates);
    }

    // A rejected candidate plus a valid one: the valid one still wins, and the
    // record of the rejected one does not change that.
    const mixed = resolveContextLimit({
      ...base,
      model: { contextWindow: 7.5, contextWindowSource: "provider_reported" },
      configuredContextWindow: 64_000,
    });
    expect(mixed.maxInputTokens).toBe(64_000);
    expect(mixed.source).toBe("configured");
    expect(candidate(mixed, "model.contextWindow")?.selected).toBe(false);
    expect(candidate(mixed, "configuredContextWindow")?.selected).toBe(true);
  });

  it("records the observed figure without letting it arbitrate", () => {
    const limit = resolveContextLimit({
      ...base,
      model: { contextWindow: 0, contextWindowSource: "provider_reported" },
      observedContextWindow: 300_000,
    });

    // Observed is consulted only where nothing else produced a value.
    expect(limit.maxInputTokens).toBe(300_000);
    expect(limit.source).toBe("observed");
    const observed = candidate(limit, "observedContextWindow");
    expect(observed?.selected).toBe(true);
    expect(observed?.source).toBe("observed");
  });

  it("rejects a fractional observed figure instead of flooring it", () => {
    const limit = resolveContextLimit({
      ...base,
      observedContextWindow: 300_000.5,
    });
    expect(limit.source).toBe("conservative_default");
    expect(candidate(limit, "observedContextWindow")?.rejectionReason).toBe("non_integer");
  });
});