/**
 * Phase 3 — provider prompt caching: permanent test suite.
 *
 * These assert the phase's non-negotiables as externally observable behaviour:
 *
 * - the capability registry is keyed by the FULL provider + protocol + model, and
 *   a missing entry resolves to `unknown` rather than to a guess;
 * - no provider ever receives another provider's cache syntax;
 * - documented capability and observed behaviour stay separate types;
 * - a conservative_default context limit can never authorise cache sizing;
 * - a request that succeeds with no cache usage is "not observed", never "hit"
 *   and never "failed";
 * - the generic orchestration layer contains no provider-specific cache branch.
 *
 * Values are transcribed from vendor documentation read on the date recorded in
 * `capabilities.ts`. These tests deliberately assert the TRANSCRIPTION (that a
 * model id maps to the documented number) rather than that the vendor still
 * documents it — re-verification is a dated human action, recorded in
 * `docs/phase-3-provider-prompt-caching.md`.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildCacheProviderOptions,
  cacheExperimentEligibility,
  computePrefixIdentity,
  comparePrefixIdentities,
  describeCacheObservation,
  describePrefixIdentity,
  documentedCacheCapabilities,
  evaluateCacheExperiment,
  isCacheObservable,
  isDocumented,
  observeCacheUsage,
  resolveCacheCapability,
  type CacheExperimentLeg,
  type PrefixComponents,
} from "./index";

// ─── A. Capability registry ────────────────────────────────────────────────

describe("A · capability registry is keyed by full provider + model identity", () => {
  it("resolves a documented Anthropic model with its own documented minimum", () => {
    const capability = resolveCacheCapability({
      providerType: "anthropic",
      protocol: "responses",
      modelId: "claude-opus-5-5",
    });
    expect(capability.status).toBe("documented");
    if (!isDocumented(capability)) throw new Error("expected documented");
    expect(capability.documentedMinimumPrefixTokens).toBe(512);
    expect(capability.cacheMode).toBe("both");
    expect(capability.documentedBreakpointLimit).toBe(4);
    expect(capability.documentedTtlOptions).toEqual(["5m", "1h"]);
    // Explicit per-block controls are NOT claimed: they would require writing
    // provider-specific markers into the assembled Phase 2 layers.
    expect(capability.supportsExplicitControls).toBe(false);
  });

  it("keeps model-specific minimums distinct rather than collapsing to a family", () => {
    // The whole reason the registry is keyed by exact model: Anthropic's
    // documented minimums are NON-MONOTONIC across generations.
    const minimums = ["claude-opus-5-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-5"].map(
      (modelId) => {
        const capability = resolveCacheCapability({ providerType: "anthropic", protocol: "responses", modelId });
        return isDocumented(capability) ? capability.documentedMinimumPrefixTokens : undefined;
      },
    );
    // 512 → 1024 → 2048 → 4096. A family rule would have to pick one and be
    // wrong for the other three.
    expect(minimums).toEqual([512, 1_024, 2_048, 4_096]);
    expect(new Set(minimums).size).toBe(4);
  });

  it("never matches a family: an unlisted sibling model is unknown", () => {
    const capability = resolveCacheCapability({
      providerType: "anthropic",
      protocol: "responses",
      modelId: "claude-opus-5-6-not-yet-released",
    });
    expect(capability.status).toBe("unknown");
    expect(capability.cacheMode).toBe("unknown");
  });

  it("resolves a documented OpenAI model and distinguishes explicit from implicit-only", () => {
    const gpt56 = resolveCacheCapability({ providerType: "openai", protocol: "responses", modelId: "gpt-6.1-sol" });
    const gpt5 = resolveCacheCapability({ providerType: "openai", protocol: "responses", modelId: "gpt-5" });
    if (!isDocumented(gpt56) || !isDocumented(gpt5)) throw new Error("expected documented");
    expect(gpt56.cacheMode).toBe("both");
    expect(gpt56.documentedMinimumPrefixTokens).toBe(1_024);
    expect(gpt5.cacheMode).toBe("implicit");
    // OpenAI documents the pre-5.6 minimum as VARYING. No number is recorded,
    // because a stand-in would be indistinguishable from a vendor commitment.
    expect(gpt5.documentedMinimumPrefixTokens).toBeUndefined();
  });

  it("resolves a documented Google model as implicit-only", () => {
    const capability = resolveCacheCapability({
      providerType: "google",
      protocol: "responses",
      modelId: "gemini-3.8-flash",
    });
    if (!isDocumented(capability)) throw new Error("expected documented");
    expect(capability.cacheMode).toBe("implicit");
    expect(capability.documentedMinimumPrefixTokens).toBe(4_096);
    // Explicit Gemini caching needs a separately-created cache resource.
    expect(capability.supportsExplicitControls).toBe(false);
  });

  it("does NOT let a custom endpoint inherit OpenAI's documented capability", () => {
    // Protocol compatibility is not capability. This is the rule that keeps a
    // third-party gateway from being sent a parameter it may reject.
    for (const modelId of ["gpt-6.1-sol", "gpt-5", "claude-opus-5-5", "gemini-3.8-flash"]) {
      const capability = resolveCacheCapability({ providerType: "custom", protocol: "chat-completions", modelId });
      expect(capability.status).toBe("unknown");
      if (capability.status === "unknown") {
        expect(capability.reason).toContain("protocol_compatibility");
      }
    }
  });

  it("treats Ollama as unobservable rather than claiming support", () => {
    const capability = resolveCacheCapability({
      providerType: "ollama",
      protocol: "chat-completions",
      modelId: "qwen3:8b",
    });
    expect(capability.status).toBe("unknown");
    expect(isCacheObservable(capability)).toBe(false);
  });

  it("keeps protocol in the key: the same OpenAI model differs by dialect", () => {
    const responses = resolveCacheCapability({ providerType: "openai", protocol: "responses", modelId: "gpt-6.1-sol" });
    const chat = resolveCacheCapability({
      providerType: "openai",
      protocol: "chat-completions",
      modelId: "gpt-6.1-sol",
    });
    if (!isDocumented(responses) || !isDocumented(chat)) throw new Error("expected documented");
    // Chat Completions reports no separate cache-write field.
    expect(responses.usageEvidence.writeObservable).toBe(true);
    expect(chat.usageEvidence.writeObservable).toBe(false);
    expect(chat.usageEvidence.readObservable).toBe(true);
  });

  it("records a source and a verification date for every documented entry", () => {
    for (const capability of documentedCacheCapabilities()) {
      expect(capability.source).toMatch(/^https:\/\//);
      expect(capability.verifiedOn).toBe("2026-10-01");
      expect(capability.verification).toBe("vendor_documented");
    }
  });

  it("excludes Anthropic models retired outside the Claude API surface", () => {
    // Their documented minimums apply to Bedrock / Google Cloud, which TBAi does
    // not use; including them would create entries that can never legitimately
    // match a TBAi request.
    for (const modelId of ["claude-haiku-3-5", "claude-sonnet-4", "claude-opus-4-1", "claude-opus-4"]) {
      const capability = resolveCacheCapability({ providerType: "anthropic", protocol: "responses", modelId });
      expect(capability.status).toBe("unknown");
    }
  });
});

// ─── C. Request construction ───────────────────────────────────────────────

describe("C · explicit controls are emitted only where verified", () => {
  it("sends Anthropic automatic caching as a top-level request option", () => {
    const capability = resolveCacheCapability({
      providerType: "anthropic",
      protocol: "responses",
      modelId: "claude-opus-5-5",
    });
    const decision = buildCacheProviderOptions({ capability });
    expect(decision.send).toBe(true);
    // Automatic caching: one top-level cache_control, no per-block marker, so no
    // Phase 2 change is required.
    expect(decision.providerOptions?.anthropic).toEqual({ cacheControl: { type: "ephemeral" } });
    expect(decision.requestedModes).toContain("automatic");
  });

  it("sends OpenAI implicit mode for an explicit-capable model", () => {
    const capability = resolveCacheCapability({
      providerType: "openai",
      protocol: "responses",
      modelId: "gpt-6.1-sol",
    });
    const decision = buildCacheProviderOptions({ capability });
    expect(decision.send).toBe(true);
    expect(decision.providerOptions?.openai).toEqual({ promptCacheOptions: { mode: "implicit" } });
  });

  it("sends NOTHING for an implicit-only capability, because none is needed", () => {
    const capability = resolveCacheCapability({
      providerType: "google",
      protocol: "responses",
      modelId: "gemini-3.8-flash",
    });
    const decision = buildCacheProviderOptions({ capability });
    expect(decision.send).toBe(false);
    expect(decision.providerOptions).toBeUndefined();
    expect(decision.reason).toBe("implicit_caching_needs_no_parameter");
  });

  it("sends NOTHING for an unknown model, and says why", () => {
    const capability = resolveCacheCapability({
      providerType: "custom",
      protocol: "chat-completions",
      modelId: "agnes-3.0-flash",
    });
    const decision = buildCacheProviderOptions({ capability });
    expect(decision.send).toBe(false);
    expect(decision.providerOptions).toBeUndefined();
    expect(decision.reason).toBe("capability_unknown");
  });

  it("never sends one provider's syntax to another", () => {
    const anthropic = resolveCacheCapability({ providerType: "anthropic", protocol: "responses", modelId: "claude-opus-5-5" });
    const openai = resolveCacheCapability({ providerType: "openai", protocol: "responses", modelId: "gpt-6.1-sol" });
    const anthropicDecision = buildCacheProviderOptions({ capability: anthropic });
    const openaiDecision = buildCacheProviderOptions({ capability: openai });
    const anthropicPayload = JSON.stringify(anthropicDecision.providerOptions);
    const openaiPayload = JSON.stringify(openaiDecision.providerOptions);
    expect(anthropicPayload).not.toContain("promptCacheOptions");
    expect(openaiPayload).not.toContain("cacheControl");
  });

  it("places options under the namespace the model actually reads", () => {
    // The namespace comes FROM the capability. This test pins the bug that
    // motivated that decision: an Anthropic cache option placed under `openai`
    // would be silently ignored by the Anthropic provider, and the failure would
    // look exactly like "caching did not happen".
    const anthropic = resolveCacheCapability({
      providerType: "anthropic",
      protocol: "responses",
      modelId: "claude-opus-5-5",
    });
    expect(anthropic.namespace).toBe("anthropic");
    expect(buildCacheProviderOptions({ capability: anthropic }).providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });

    const openai = resolveCacheCapability({
      providerType: "openai",
      protocol: "responses",
      modelId: "gpt-6.1-sol",
    });
    expect(openai.namespace).toBe("openai");
    expect(buildCacheProviderOptions({ capability: openai }).providerOptions).toEqual({
      openai: { promptCacheOptions: { mode: "implicit" } },
    });
  });

  it("records the compatible-dialect namespace for the chat-completions protocol", () => {
    const chat = resolveCacheCapability({
      providerType: "openai",
      protocol: "chat-completions",
      modelId: "gpt-6.1-sol",
    });
    expect(chat.namespace).toBe("openaiCompatible");
  });

  it("forwards a TTL only when the capability documents that exact value", () => {
    const anthropic = resolveCacheCapability({ providerType: "anthropic", protocol: "responses", modelId: "claude-opus-5-5" });
    expect(
      buildCacheProviderOptions({ capability: anthropic, ttl: "1h" }).providerOptions?.anthropic,
    ).toEqual({ cacheControl: { type: "ephemeral", ttl: "1h" } });
    // A TTL the vendor never documented for this model is dropped, not defaulted.
    expect(
      buildCacheProviderOptions({ capability: anthropic, ttl: "24h" }).providerOptions?.anthropic,
    ).toEqual({ cacheControl: { type: "ephemeral" } });
  });

  it("never sends a cache key to a provider that does not support one", () => {
    const anthropic = resolveCacheCapability({ providerType: "anthropic", protocol: "responses", modelId: "claude-opus-5-5" });
    const decision = buildCacheProviderOptions({ capability: anthropic, cacheKey: "abc" });
    expect(decision.cacheKey).toBeUndefined();
    expect(JSON.stringify(decision.providerOptions)).not.toContain("abc");
  });
});

// ─── B. Provenance: documented vs observed ─────────────────────────────────

describe("B · documented and observed stay separate", () => {
  it("classifies a real cache write from provider-reported usage", () => {
    const capability = resolveCacheCapability({ providerType: "anthropic", protocol: "responses", modelId: "claude-opus-5-5" });
    const observation = observeCacheUsage({
      capability,
      usage: { cacheWriteTokens: 5_000, cacheReadTokens: 0, noCacheTokens: 120 },
    });
    expect(observation.kind).toBe("write_observed");
    expect(observation.writeTokens).toBe(5_000);
    expect(observation.supportsSizingClaim).toBe(true);
  });

  it("classifies a real cache read", () => {
    const capability = resolveCacheCapability({ providerType: "anthropic", protocol: "responses", modelId: "claude-opus-5-5" });
    const observation = observeCacheUsage({
      capability,
      usage: { cacheReadTokens: 5_000, cacheWriteTokens: 0, noCacheTokens: 120 },
    });
    expect(observation.kind).toBe("read_observed");
    expect(observation.readTokens).toBe(5_000);
  });

  it("keeps unknown unknown — an observation never upgrades a capability", () => {
    const capability = resolveCacheCapability({ providerType: "custom", protocol: "chat-completions", modelId: "x" });
    const observation = observeCacheUsage({ capability, usage: { cacheReadTokens: 9_000 } });
    expect(observation.kind).toBe("read_observed");
    // The provider reported a number, but nothing documents this model, so it may
    // not authorise a sizing claim.
    expect(observation.supportsSizingClaim).toBe(false);
    expect(capability.status).toBe("unknown");
    // The registry was not mutated by the observation.
    expect(resolveCacheCapability({ providerType: "custom", protocol: "chat-completions", modelId: "x" }).status).toBe(
      "unknown",
    );
  });

  it("reports both write and read when a provider reports both", () => {
    const capability = resolveCacheCapability({ providerType: "anthropic", protocol: "responses", modelId: "claude-opus-5-5" });
    const observation = observeCacheUsage({
      capability,
      usage: { cacheReadTokens: 3_000, cacheWriteTokens: 200 },
    });
    expect(observation.kind).toBe("write_and_read_observed");
  });
});

// ─── D + E. Verification protocol ──────────────────────────────────────────

describe("D · the two-request protocol distinguishes write from read", () => {
  const capability = resolveCacheCapability({ providerType: "anthropic", protocol: "responses", modelId: "claude-opus-5-5" });

  /** Same retained prefix; the CURRENT TURN differs, which is the varying suffix. */
  function leg(suffixId: string, observation: CacheExperimentLeg["observation"]): CacheExperimentLeg {
    const prefix: PrefixComponents = {
      layerAText: "You are a helpful assistant.",
      nativeToolNames: ["read_file", "write_file"],
      mcpToolNames: [],
      retainedMessageIds: ["m1", "m2"],
      currentTurnIds: [suffixId],
    };
    return { suffixId, prefix, observation };
  }

  it("reports write-then-read when the second request reads the first's prefix", () => {
    const result = evaluateCacheExperiment({
      capability,
      measuredPrefixTokens: 4_000,
      legs: [
        leg("turn-a", observeCacheUsage({ capability, usage: { cacheWriteTokens: 4_000 } })),
        leg("turn-b", observeCacheUsage({ capability, usage: { cacheReadTokens: 4_000 } })),
      ],
    });
    expect(result.verdict).toBe("write_then_read_observed");
    expect(result.supportsConclusion).toBe(true);
    // Documented and observed are carried side by side, never merged.
    expect(result.documented?.minimumPrefixTokens).toBe(512);
    expect(result.observed.readTokens).toBe(4_000);
  });

  it("represents a below-threshold silent success as cache_not_observed, NOT failure", () => {
    // The headline case: both requests SUCCEED and neither caches anything.
    const result = evaluateCacheExperiment({
      capability,
      measuredPrefixTokens: 100,
      legs: [
        leg("turn-a", observeCacheUsage({ capability, usage: { inputTokens: 100, noCacheTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } })),
        leg("turn-b", observeCacheUsage({ capability, usage: { inputTokens: 100, noCacheTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } })),
      ],
    });
    expect(result.verdict).toBe("cache_not_observed");
    // Explicitly NOT usable as a conclusion — this is the result that must never
    // be read as "caching does not work here".
    expect(result.supportsConclusion).toBe(false);
    expect(result.reasons.some((r) => r.includes("below_documented_minimum"))).toBe(true);
  });

  it("never treats a missing usage field as a cache hit", () => {
    const result = evaluateCacheExperiment({
      capability,
      legs: [
        leg("turn-a", observeCacheUsage({ capability, usage: {} })),
        leg("turn-b", observeCacheUsage({ capability, usage: {} })),
      ],
    });
    // Absent fields mean the provider exposed nothing, which is distinct from a
    // reported zero.
    expect(result.observed.firstLeg).toBe("unobservable");
    expect(result.verdict).toBe("cache_not_observed");
    expect(result.supportsConclusion).toBe(false);
  });

  it("refuses to conclude when the prefix changed between requests", () => {
    const changed: CacheExperimentLeg = {
      suffixId: "turn-b",
      prefix: {
        layerAText: "You are a helpful assistant.",
        nativeToolNames: ["read_file", "write_file", "NEW_TOOL"],
        mcpToolNames: [],
        retainedMessageIds: ["m1", "m2"],
        currentTurnIds: ["turn-b"],
      },
      observation: observeCacheUsage({ capability, usage: { cacheWriteTokens: 4_000 } }),
    };
    const result = evaluateCacheExperiment({
      capability,
      measuredPrefixTokens: 4_000,
      legs: [
        leg("turn-a", observeCacheUsage({ capability, usage: { cacheWriteTokens: 4_000 } })),
        changed,
      ],
    });
    expect(result.verdict).toBe("inconclusive_prefix_mismatch");
    expect(result.supportsConclusion).toBe(false);
  });

  it("flags an experiment whose suffix did not actually vary", () => {
    const result = evaluateCacheExperiment({
      capability,
      measuredPrefixTokens: 4_000,
      legs: [
        leg("same", observeCacheUsage({ capability, usage: { cacheWriteTokens: 4_000 } })),
        leg("same", observeCacheUsage({ capability, usage: { cacheReadTokens: 4_000 } })),
      ],
    });
    expect(result.reasons).toContain("suffix_must_differ_between_requests");
  });

  it("reports an unknown-capability model as ineligible, which is more precise than a negative", () => {
    // Ollama: no documented capability AND no cache usage field. The unknown-
    // capability verdict is checked first and is the more informative answer —
    // there was never a documented capability to test in the first place.
    const ollama = resolveCacheCapability({ providerType: "ollama", protocol: "chat-completions", modelId: "llama3" });
    const result = evaluateCacheExperiment({
      capability: ollama,
      legs: [
        leg("turn-a", observeCacheUsage({ capability: ollama, usage: { inputTokens: 5_000 } })),
        leg("turn-b", observeCacheUsage({ capability: ollama, usage: { inputTokens: 5_000 } })),
      ],
    });
    expect(result.verdict).toBe("ineligible_unknown_capability");
    expect(result.supportsConclusion).toBe(false);
    expect(result.documented).toBeNull();
  });

  it("reports a DOCUMENTED but unobservable model as inconclusive, not as a negative", () => {
    // A real state: a model the vendor documents as cacheable but whose API
    // exposes no cache usage field. Nothing can be concluded either way, so the
    // verdict must be inconclusive rather than "cache_not_observed".
    const documentedUnobservable = {
      providerType: "anthropic",
      protocol: "responses",
      namespace: "anthropic",
      modelId: "claude-opus-5-5",
      status: "documented",
      cacheSupported: true,
      cacheMode: "implicit",
      documentedMinimumPrefixTokens: 512,
      supportsCacheKey: false,
      supportsExplicitControls: false,
      usageEvidence: { writeObservable: false, readObservable: false },
      source: "https://example.invalid/doc",
      verifiedOn: "2026-10-01",
      verification: "vendor_documented",
    } as const;
    const result = evaluateCacheExperiment({
      capability: documentedUnobservable,
      legs: [
        leg("turn-a", observeCacheUsage({ capability: documentedUnobservable, usage: { inputTokens: 5_000 } })),
        leg("turn-b", observeCacheUsage({ capability: documentedUnobservable, usage: { inputTokens: 5_000 } })),
      ],
    });
    expect(result.verdict).toBe("inconclusive_unobservable");
    expect(result.supportsConclusion).toBe(false);
    // The DOCUMENTED facts survive even though the run concluded nothing.
    expect(result.documented?.minimumPrefixTokens).toBe(512);
  });
});

// ─── Rule 10: a conservative default limit must never size an experiment ───

describe("Rule 10 · a conservative_default limit cannot size a cache experiment", () => {
  const capability = resolveCacheCapability({ providerType: "anthropic", protocol: "responses", modelId: "claude-opus-5-5" });

  it("permits sizing only when the context limit is provider_reported", () => {
    expect(cacheExperimentEligibility({ capability, contextLimitSource: "provider_reported" }).eligible).toBe(true);
  });

  it("refuses sizing from a conservative_default ceiling", () => {
    const eligibility = cacheExperimentEligibility({ capability, contextLimitSource: "conservative_default" });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasons.some((r) => r.includes("conservative_default"))).toBe(true);
  });

  it("refuses sizing from a configured (user-set) limit", () => {
    expect(cacheExperimentEligibility({ capability, contextLimitSource: "configured" }).eligible).toBe(false);
  });

  it("refuses sizing when the vendor documents no fixed minimum", () => {
    const varies = resolveCacheCapability({ providerType: "openai", protocol: "responses", modelId: "gpt-5" });
    const eligibility = cacheExperimentEligibility({ capability: varies, contextLimitSource: "provider_reported" });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasons.some((r) => r.includes("no_documented_minimum"))).toBe(true);
  });

  it("refuses sizing for an unknown capability", () => {
    const unknown = resolveCacheCapability({ providerType: "custom", protocol: "chat-completions", modelId: "agnes-3.0-flash" });
    expect(cacheExperimentEligibility({ capability: unknown, contextLimitSource: "provider_reported" }).eligible).toBe(false);
  });
});

// ─── Stable prefix determinism ─────────────────────────────────────────────

describe("stable prefix identity is content-free and detects churn", () => {
  const base: PrefixComponents = {
    layerAText: "SYSTEM",
    nativeToolNames: ["a", "b"],
    mcpToolNames: ["mcp__s__t"],
    retainedMessageIds: ["m1", "m2"],
    currentTurnIds: ["turn-1"],
  };

  it("produces an identical fingerprint when only the current turn changes", () => {
    const first = computePrefixIdentity(base);
    const second = computePrefixIdentity({ ...base, currentTurnIds: ["turn-2"] }, first);
    // The current turn is the variable tail; including it would make every
    // request's prefix unique, which is the documented trap.
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.stable).toBe(true);
  });

  it("treats appended history as an extension, not an invalidation", () => {
    const first = computePrefixIdentity(base);
    const second = computePrefixIdentity({ ...base, retainedMessageIds: ["m1", "m2", "m3"] }, first);
    expect(comparePrefixIdentities(first, second).identical).toBe(false);
    // Appending preserves the earlier prefix, which is exactly what a growing
    // conversation does; the provider can still reuse the shorter cached prefix.
    expect(second.stable).toBe(true);
  });

  it("detects tool-definition churn", () => {
    const first = computePrefixIdentity(base);
    const second = computePrefixIdentity({ ...base, nativeToolNames: ["a", "b", "c"] }, first);
    expect(second.stable).toBe(false);
    expect(second.invalidationReasons).toContain("tool_definitions_changed");
  });

  it("detects MCP tool-set churn — the highest-likelihood source", () => {
    const first = computePrefixIdentity(base);
    const second = computePrefixIdentity({ ...base, mcpToolNames: ["mcp__s__t", "mcp__s2__t2"] }, first);
    expect(second.invalidationReasons).toContain("mcp_tool_set_changed");
  });

  it("detects instructions churn", () => {
    const first = computePrefixIdentity(base);
    const second = computePrefixIdentity({ ...base, layerAText: "SYSTEM CHANGED" }, first);
    expect(second.invalidationReasons).toContain("instructions_changed");
  });

  it("detects reordering of the same tools as a different prefix", () => {
    const first = computePrefixIdentity(base);
    const second = computePrefixIdentity({ ...base, nativeToolNames: ["b", "a"] }, first);
    expect(second.invalidationReasons).toContain("tool_definitions_changed");
  });

  it("never places prompt content in the fingerprint or its projection", () => {
    const identity = computePrefixIdentity({ ...base, layerAText: "SECRET_SYSTEM_PROMPT_TEXT" });
    expect(identity.fingerprint).not.toContain("SECRET");
    expect(JSON.stringify(identity)).not.toContain("SECRET_SYSTEM_PROMPT_TEXT");
  });

  it("handles a conversation with no instructions (Layer A absent)", () => {
    const identity = computePrefixIdentity({ ...base, layerAText: undefined });
    expect(identity.instructionsFingerprint).toBeNull();
    expect(identity.fingerprint).toHaveLength(64);
  });
});

// ─── Rule 11/12: observability hygiene ─────────────────────────────────────

describe("observability never leaks prompts or trips the logger redaction", () => {
  /**
   * The LOG boundary is what the logger redacts. Typed fields may keep honest
   * names — `CacheObservation.writeTokens` is exactly analogous to Phase 2's
   * `InputSizeEstimate.estimatedTokens`, which the ADR deliberately preserved
   * while renaming only the log-boundary keys. So this asserts on the PROJECTION
   * the route actually passes to the logger.
   */
  function logProjectionKeys(): string[] {
    const capability = resolveCacheCapability({
      providerType: "anthropic",
      protocol: "responses",
      modelId: "claude-opus-5-5",
    });
    const observation = observeCacheUsage({
      capability,
      usage: { cacheReadTokens: 1_234, cacheWriteTokens: 99, noCacheTokens: 7 },
    });
    const decision = buildCacheProviderOptions({ capability });
    const prefix = computePrefixIdentity({
      layerAText: "S",
      nativeToolNames: [],
      mcpToolNames: [],
      retainedMessageIds: [],
      currentTurnIds: [],
    });

    // The exact projections chat.ts logs.
    const observationLog = {
      unit: "tokens",
      cacheObservation: observation.kind,
      cacheWriteSize: observation.writeTokens ?? null,
      cacheReadSize: observation.readTokens ?? null,
      cacheUncachedSize: observation.uncachedInputTokens ?? null,
      cacheObservationSupportsSizing: observation.supportsSizingClaim,
      cacheCapabilityKey: observation.capabilityKey,
    };
    const decisionLog = decision.send
      ? { cacheControlSent: true, cacheControlModes: [...decision.requestedModes], cacheControlOmissionReason: null }
      : { cacheControlSent: false, cacheControlModes: [], cacheControlOmissionReason: decision.reason };
    const prefixLog = {
      prefixFingerprint: prefix.fingerprint,
      prefixStable: prefix.stable,
      prefixInvalidationReasons: prefix.invalidationReasons,
      prefixInstructionsPresent: prefix.instructionsFingerprint !== null,
      prefixNativeToolCount: prefix.nativeToolNames.length,
      prefixMcpToolCount: prefix.mcpToolNames.length,
      prefixRetainedMessageCount: prefix.retainedMessageIds.length,
    };
    return [...Object.keys(observationLog), ...Object.keys(decisionLog), ...Object.keys(prefixLog)];
  }

  it("emits no LOG key containing the substring 'token'", () => {
    // `logger.ts` SENSITIVE_KEY_RE matches `.*token.*` and would replace the
    // values with [REDACTED], destroying the diagnostic. The standing Phase 2
    // rule still applies to cache counters.
    for (const key of logProjectionKeys()) {
      expect(key.toLowerCase()).not.toContain("token");
    }
  });

  it("carries the unit explicitly, since the keys cannot say 'tokens'", () => {
    const capability = resolveCacheCapability({
      providerType: "anthropic",
      protocol: "responses",
      modelId: "claude-opus-5-5",
    });
    const observation = observeCacheUsage({ capability, usage: { cacheReadTokens: 5 } });
    const projection = describeCacheObservation(observation);
    expect(projection.unit).toBe("tokens");
    expect(projection.cacheReadSize).toBe(5);
  });

  it("keeps the prefix fingerprint free of prompt content", () => {
    const prefix = computePrefixIdentity({
      layerAText: "SECRET_SYSTEM_PROMPT",
      nativeToolNames: ["read_file"],
      mcpToolNames: [],
      retainedMessageIds: ["m1"],
      currentTurnIds: ["t1"],
    });
    const projection = describePrefixIdentity(prefix);
    expect(JSON.stringify(projection)).not.toContain("SECRET_SYSTEM_PROMPT");
    expect(prefix.fingerprint).toHaveLength(64);
  });
});

// ─── Rule 13: provider specifics stay behind the capability boundary ────────

describe("provider-specific cache logic never leaks into the orchestration layer", () => {
  const cacheModule = readFileSync(new URL("./capabilities.ts", import.meta.url), "utf8");

  it("keeps every provider name inside src/context/cache/", () => {
    // The generic layer must not branch on a provider, and must not contain a
    // provider-specific cache SYNTAX. Calling `resolveCacheCapability` /
    // `buildCacheProviderOptions` is fine — asking an abstract question is the
    // point. Naming a provider or writing its wire syntax is not.
    const chatRoute = readFileSync(new URL("../../routes/chat.ts", import.meta.url), "utf8");
    const assemble = readFileSync(new URL("../assemble.ts", import.meta.url), "utf8");
    const budget = readFileSync(new URL("../budget.ts", import.meta.url), "utf8");
    const limits = readFileSync(new URL("../limits.ts", import.meta.url), "utf8");

    for (const [name, source] of [
      ["chat.ts", chatRoute],
      ["assemble.ts", assemble],
      ["budget.ts", budget],
      ["limits.ts", limits],
    ] as const) {
      // Strip comments so documentation may mention providers freely; only
      // EXECUTABLE code is constrained.
      const executable = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
        .join("\n");

      // No provider branching.
      expect(executable, `${name} must not branch on a provider`).not.toMatch(
        /provider(Type)?\s*[!=]==?\s*['"](anthropic|openai|google|ollama)['"]/,
      );
      expect(executable, `${name} must not match on a model name`).not.toMatch(
        /(model|modelId)\.startsWith\(\s*['"](claude|gpt|gemini|agnes)/,
      );

      // No provider-specific cache WIRE SYNTAX. The identifiers TBAi uses to
      // carry a decision are its own; the syntax that reaches a provider
      // (`cache_control`, `prompt_cache_options`, …) must not appear here.
      expect(executable, `${name} must not contain provider cache wire syntax`).not.toMatch(
        /cache_control|prompt_cache_options|prompt_cache_key|cacheWrite|cacheRead|cachedContent/,
      );
    }
  });

  it("keeps the single existing reasoning providerOptions seam intact", () => {
    // Regression guard for the merge Phase 3 had to make: `streamText` accepts
    // ONE `providerOptions`, so cache options are merged into the existing
    // reasoning options rather than spread as a second argument.
    const chatRoute = readFileSync(new URL("../../routes/chat.ts", import.meta.url), "utf8");
    const providerOptionsKeys = chatRoute.match(/^\s*providerOptions:/gm) ?? [];
    expect(providerOptionsKeys.length).toBe(1);
    expect(chatRoute).toContain("...(cacheControl?.providerOptions ?? {})");
  });

  it("has no model-name pattern matching in the registry", () => {
    // A family/prefix rule is what makes a threshold table unsafe. Exact-key
    // lookups only.
    const executable = cacheModule
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n");
    expect(executable).not.toMatch(/\.startsWith\(\s*['"](claude|gpt|gemini|agnes)/);
    expect(executable).not.toMatch(/\.includes\(\s*['"](claude|gpt|gemini)/);
  });
});