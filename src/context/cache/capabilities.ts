/**
 * Phase 3 — the provider/model cache capability registry.
 *
 * ## Why this is keyed by EXACT model identity
 *
 * A single threshold per provider family is unsafe, and the vendors say so in
 * their own words. Anthropic's documented minimums are **non-monotonic across
 * generations**: Claude Opus 4.5 requires 4,096 tokens while the *newer* Opus 4.8
 * requires 1,024 and Opus 5.5 requires 512. A family-level rule is therefore wrong
 * by construction, not merely imprecise — it would send a 2,000-token prefix to a
 * model that cannot cache it and reject it on a model that can.
 *
 * So every entry here is keyed by `providerType|protocol|modelId`. There is no
 * prefix matching, no family fallback, and no numeric heuristic. A model absent
 * from this table resolves to `unknown`, which sends nothing.
 *
 * ## Why that default is safe
 *
 * Every entry records the documentation URL and the date it was read
 * (`verifiedOn`), so a stale table is visible rather than silently trusted. New
 * models default to `unknown` and are added deliberately, with their source.
 */

import type { ApiProtocol } from "../../types";
import {
  cacheCapabilityKey,
  type CacheCapability,
  type CacheCapabilityLookup,
  type CacheNamespace,
  type CacheUsageEvidence,
  type DocumentedCacheCapability,
  type UnknownCacheCapability,
} from "./types";

/** Date the vendor documentation below was read. Bump on re-verification. */
const VERIFIED_ON = "2026-10-01";

const ANTHROPIC_SOURCE = "https://platform.claude.com/docs/en/build-with-claude/prompt-caching";
const ANTHROPIC_MODELS_SOURCE = "https://platform.claude.com/docs/en/about-claude/models/overview";
const OPENAI_SOURCE = "https://developers.openai.com/api/docs/guides/prompt-caching";
const GOOGLE_SOURCE = "https://ai.google.dev/gemini-api/docs/caching";

/**
 * Anthropic reports writes and reads separately, so both are observable.
 * Documented field names are preserved even though the SDK normalises them.
 */
const ANTHROPIC_USAGE: CacheUsageEvidence = {
  writeField: "cache_creation_input_tokens",
  readField: "cache_read_input_tokens",
  writeObservable: true,
  readObservable: true,
};

/** OpenAI's Responses API reports `cache_write_tokens`; Chat Completions does not. */
const OPENAI_RESPONSES_USAGE: CacheUsageEvidence = {
  writeField: "input_tokens_details.cache_write_tokens",
  readField: "input_tokens_details.cache_read_tokens",
  writeObservable: true,
  readObservable: true,
};

const OPENAI_CHAT_USAGE: CacheUsageEvidence = {
  readField: "prompt_tokens_details.cached_tokens",
  writeObservable: false,
  readObservable: true,
};

/** Google reports cache reads; there is no separate cache-write field. */
const GOOGLE_USAGE: CacheUsageEvidence = {
  readField: "cached_content_token_count",
  writeObservable: false,
  readObservable: true,
};

/**
 * No provider in TBAi's registry exposes a cache usage field through the
 * OpenAI-compatible dialect unless it implements OpenAI's own reporting, which
 * the `@ai-sdk/openai-compatible` package does read — but only if the upstream
 * actually sends the field. Treated as unobservable rather than assumed absent.
 */
const NO_USAGE_EVIDENCE: CacheUsageEvidence = {
  writeObservable: false,
  readObservable: false,
};

interface AnthropicModelEntry {
  readonly modelId: string;
  readonly minPrefixTokens: number;
}

/**
 * Anthropic minimums, transcribed from the "Cache limitations" section of the
 * prompt-caching guide.
 *
 * ⚠️ RETIRED-EXCEPT-ON-BEDROCK/GOOGLE-CLOUD models (Opus 4.1, Opus 4, Sonnet 4,
 * Haiku 3.5) are deliberately ABSENT: their documented minimums apply to
 * platforms TBAi does not use. TBAi's Anthropic provider talks to the Claude API
 * (`createAnthropic` in `services/ai.ts`), where those models are not available,
 * and automatic caching returns a 400 on legacy Bedrock regardless. Including
 * them would create an entry that can never legitimately match.
 *
 * Mythos models are absent too: the guide documents their minimums but they are
 * limited-availability and have no public Claude API ID in the models overview.
 */
const ANTHROPIC_MODELS: readonly AnthropicModelEntry[] = [
  // 512 tokens — current flagship generation and legacy equivalents.
  { modelId: "claude-fable-5-1", minPrefixTokens: 512 },
  { modelId: "claude-opus-5-5", minPrefixTokens: 512 },
  { modelId: "claude-sonnet-5-5", minPrefixTokens: 512 },
  { modelId: "claude-fable-5", minPrefixTokens: 512 },
  { modelId: "claude-opus-5", minPrefixTokens: 512 },
  // 1,024 tokens.
  { modelId: "claude-opus-4-8", minPrefixTokens: 1_024 },
  { modelId: "claude-sonnet-5", minPrefixTokens: 1_024 },
  { modelId: "claude-sonnet-4-6", minPrefixTokens: 1_024 },
  // 2,048 tokens.
  { modelId: "claude-opus-4-7", minPrefixTokens: 2_048 },
  // 4,096 tokens.
  { modelId: "claude-opus-4-6", minPrefixTokens: 4_096 },
  { modelId: "claude-opus-4-5", minPrefixTokens: 4_096 },
  { modelId: "claude-haiku-4-5", minPrefixTokens: 4_096 },
  { modelId: "claude-haiku-4-5-20251001", minPrefixTokens: 4_096 },
];

interface OpenAIModelEntry {
  readonly modelId: string;
  /**
   * Models at and after GPT-5.6 support BOTH implicit and explicit caching and
   * accept `prompt_cache_options`. Earlier models support implicit caching only.
   */
  readonly supportsExplicitControls: boolean;
  /** Documented minimum. 1,024 from 5.6; "varies by request settings" before. */
  readonly minPrefixTokens?: number;
}

/**
 * OpenAI documents the pre-5.6 minimum as "varies by request settings" and
 * explicitly warns it is NOT a constant per model id. That is recorded as
 * `undefined` — a documented-varies value must not become a number, because a
 * number here would be used to size a prefix the vendor never committed to.
 */
const OPENAI_MODELS_EXPLICIT: readonly string[] = [
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-luna",
  "gpt-5.6-cyber",
];

const OPENAI_MODELS_IMPLICIT_ONLY: readonly string[] = [
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5.1-chat-latest",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5",
  "gpt-5-codex",
  "gpt-4.1",
];

const OPENAI_MODELS: readonly OpenAIModelEntry[] = [
  ...OPENAI_MODELS_EXPLICIT.map((modelId) => ({
    modelId,
    supportsExplicitControls: true,
    minPrefixTokens: 1_024,
  })),
  ...OPENAI_MODELS_IMPLICIT_ONLY.map((modelId) => ({
    modelId,
    supportsExplicitControls: false,
    minPrefixTokens: undefined,
  })),
];

interface GoogleModelEntry {
  readonly modelId: string;
  readonly minPrefixTokens: number;
}

/** Google documents implicit caching only for the Gemini API surface TBAi uses. */
const GOOGLE_MODELS: readonly GoogleModelEntry[] = [
  { modelId: "gemini-3.8-flash", minPrefixTokens: 4_096 },
  { modelId: "gemini-3.7-flash", minPrefixTokens: 4_096 },
  { modelId: "gemini-3.6-flash", minPrefixTokens: 4_096 },
  { modelId: "gemini-3.5-flash", minPrefixTokens: 4_096 },
  { modelId: "gemini-3.1-pro-preview", minPrefixTokens: 4_096 },
  { modelId: "gemini-2.5-flash", minPrefixTokens: 2_048 },
  { modelId: "gemini-2.5-pro", minPrefixTokens: 2_048 },
];

/** Lookup key for one documented capability. */
const REGISTRY = new Map<string, DocumentedCacheCapability>();

/**
 * Namespace for an OpenAI-family surface. `openaiCompatible` is used for TBAi's
 * OpenAI-COMPATIBLE provider TYPE (custom/ollama speaking the chat-completions
 * dialect), never for the native OpenAI provider — see `resolveApiProtocol` and
 * `providerOptionsNamespace` in `services/ai.ts`.
 *
 * Custom and Ollama surfaces are deliberately NOT registered: their capability is
 * unknown, so there is nothing to key and nothing to send.
 */
function openaiNamespace(protocol: ApiProtocol): "openai" | "openaiCompatible" {
  return protocol === "chat-completions" ? "openaiCompatible" : "openai";
}

function register(entry: DocumentedCacheCapability): void {
  REGISTRY.set(cacheCapabilityKey(entry), entry);
}

for (const { modelId, minPrefixTokens } of ANTHROPIC_MODELS) {
  register({
    providerType: "anthropic",
    // The Anthropic provider always uses the Claude Messages API; `aiProtocol`
    // is ignored for it, but the key stays complete so lookups are unambiguous.
    protocol: "responses" as ApiProtocol,
    namespace: "anthropic" as const,
    modelId,
    status: "documented",
    cacheSupported: true,
    // Anthropic documents automatic (top-level `cache_control`) AND explicit
    // per-block breakpoints.
    cacheMode: "both",
    documentedMinimumPrefixTokens: minPrefixTokens,
    documentedBreakpointLimit: 4,
    documentedTtlOptions: ["5m", "1h"],
    supportsCacheKey: false,
    // FALSE, and this is the load-bearing decision for the whole phase: the AI
    // SDK reads per-block `cache_control` from each message part's
    // providerOptions, so expressing explicit breakpoints would mean writing
    // provider-specific markers into Phase 2's Layers B and C. That violates the
    // Phase 3 rule that provider specifics stay behind the capability boundary
    // and never bypass the assembly seam. Request-level automatic caching needs
    // no Phase 2 change and is what TBAi uses.
    supportsExplicitControls: false,
    usageEvidence: ANTHROPIC_USAGE,
    source: `${ANTHROPIC_SOURCE} (minimums); ${ANTHROPIC_MODELS_SOURCE} (model ids)`,
    verifiedOn: VERIFIED_ON,
    verification: "vendor_documented",
  });
}

for (const { modelId, supportsExplicitControls, minPrefixTokens } of OPENAI_MODELS) {
  register({
    providerType: "openai",
    protocol: "responses",
    namespace: openaiNamespace("responses"),
    modelId,
    status: "documented",
    cacheSupported: true,
    cacheMode: supportsExplicitControls ? "both" : "implicit",
    // OMITTED rather than defaulted: OpenAI documents this as varying by
    // request settings, so there is no number to record. See the type's contract.
    ...(minPrefixTokens !== undefined ? { documentedMinimumPrefixTokens: minPrefixTokens } : {}),
    ...(supportsExplicitControls
      ? { documentedBreakpointLimit: 4, documentedTtlOptions: ["30m"] as const }
      : { documentedTtlOptions: ["in_memory", "24h"] as const }),
    supportsCacheKey: true,
    // Per-block `prompt_cache_breakpoint` is an input content-block field, which
    // would again mean rewriting assembled layers. Request-level `mode` is not.
    supportsExplicitControls: false,
    usageEvidence: OPENAI_RESPONSES_USAGE,
    source: OPENAI_SOURCE,
    verifiedOn: VERIFIED_ON,
    verification: "vendor_documented",
  });

  // The Chat Completions dialect reports reads but no cache-write field.
  register({
    providerType: "openai",
    protocol: "chat-completions",
    namespace: openaiNamespace("chat-completions"),
    modelId,
    status: "documented",
    cacheSupported: true,
    cacheMode: supportsExplicitControls ? "both" : "implicit",
    ...(minPrefixTokens !== undefined ? { documentedMinimumPrefixTokens: minPrefixTokens } : {}),
    supportsCacheKey: true,
    supportsExplicitControls: false,
    usageEvidence: OPENAI_CHAT_USAGE,
    source: OPENAI_SOURCE,
    verifiedOn: VERIFIED_ON,
    verification: "vendor_documented",
  });
}

for (const { modelId, minPrefixTokens } of GOOGLE_MODELS) {
  register({
    providerType: "google",
    protocol: "responses",
    namespace: "openaiCompatible" as const,
    modelId,
    status: "documented",
    cacheSupported: true,
    // Implicit only. Google's EXPLICIT caching requires a separately created
    // cache resource referenced by `cachedContent` — an out-of-band resource
    // lifecycle TBAi does not have, so it is not claimed here.
    cacheMode: "implicit",
    documentedMinimumPrefixTokens: minPrefixTokens,
    supportsCacheKey: false,
    supportsExplicitControls: false,
    usageEvidence: GOOGLE_USAGE,
    source: GOOGLE_SOURCE,
    verifiedOn: VERIFIED_ON,
    verification: "vendor_documented",
  });
}

/**
 * Resolve the documented cache capability for one exact provider surface.
 *
 * Never throws and never guesses. A model with no entry resolves to `unknown`,
 * which is the correct answer for every model released after `VERIFIED_ON`, every
 * custom/OpenAI-compatible endpoint, and every Ollama model.
 *
 * @returns A documented capability, or an `unknown` one carrying a reason.
 */
export function resolveCacheCapability(key: CacheCapabilityLookup): CacheCapability {
  const registryKey = cacheCapabilityKey(key);
  const documented = REGISTRY.get(registryKey);
  if (documented) return documented;

  return {
    ...key,
    // Recorded even for an unknown capability, because the lookup must produce a
    // complete surface. Nothing is ever sent under it — an unknown capability
    // returns no provider options at all.
    namespace: namespaceFor(key),
    status: "unknown",
    cacheSupported: false,
    cacheMode: "unknown",
    usageEvidence: NO_USAGE_EVIDENCE,
    verification: "unverified",
    reason: unknownReason(key),
  } satisfies UnknownCacheCapability;
}

/**
 * The providerOptions key a surface's model reads, mirroring
 * `providerOptionsNamespace` in `services/ai.ts`.
 *
 * A custom/ollama surface speaks the OpenAI-compatible dialect, so it reads
 * `openaiCompatible`. Anthropic reads its own namespace, which is precisely the
 * value a caller-supplied namespace argument would get wrong.
 */
function namespaceFor(key: { providerType: string; protocol: ApiProtocol }): CacheNamespace {
  switch (key.providerType) {
    case "anthropic":
      return "anthropic";
    case "openai":
      return openaiNamespace(key.protocol);
    default:
      // `custom` and `ollama` both build an OpenAI-compatible model.
      return "openaiCompatible";
  }
}

/**
 * No surface in TBAi's registry has a verified cache usage field it can report
 * without a documented capability.
 *
 * A `custom` OpenAI-compatible endpoint MIGHT implement OpenAI's reporting, and
 * the SDK would read the field if the upstream sent it. Claiming reads are
 * observable there would be inferring capability from protocol compatibility,
 * which Phase 3 rule 7 forbids — so it stays unobservable until measured, and the
 * observation is then `unobservable` rather than a fabricated negative.
 */
function unknownReason(key: { providerType: string; modelId: string }): string {
  if (key.providerType === "custom") {
    return "custom_endpoint_capability_unknown: protocol_compatibility_does_not_imply_cache_capability";
  }
  if (key.providerType === "ollama") return "local_runtime_no_documented_cache_capability";
  return `no_documented_capability_for_exact_model: ${key.providerType}/${key.modelId}`;
}

/**
 * Every documented entry, for tests and diagnostics. Never used to build a
 * lookup by scanning — the map is the single lookup path.
 */
export function documentedCacheCapabilities(): readonly DocumentedCacheCapability[] {
  return [...REGISTRY.values()];
}