/**
 * Phase 3 — provider prompt caching: capability types.
 *
 * The type system here encodes the phase's central rule: **documented capability
 * and observed behaviour are different kinds of fact and must never be merged.**
 *
 * `CacheCapability` is what the VENDOR documents. `CacheObservation` is what one
 * live request reported. They are separate types with no field in common, and no
 * function accepts one where the other is expected. That is deliberate: Phase 3's
 * failure mode is a confidently wrong conclusion ("caching does not help here")
 * drawn from an observation, or an experiment sized from a number nobody measured.
 *
 * `unknown` is a first-class state, not an absence of one. An unknown capability
 * carries NO thresholds, NO TTLs and NO cache key, because a stand-in value there
 * would be indistinguishable from a documented fact downstream.
 */

import type { ApiProtocol } from "../../types";

/**
 * How a provider/model supports prompt caching.
 *
 * - `implicit` — the provider caches on its own; the correct request sends
 *   nothing. Sending a parameter would be wrong, not merely redundant.
 * - `explicit` — caching requires a provider request parameter.
 * - `both` — documented as supporting each independently.
 * - `none` — documented as NOT supporting prompt caching.
 * - `unknown` — no current authoritative documentation for this exact model.
 */
export const CACHE_MODES = ["implicit", "explicit", "both", "none", "unknown"] as const;
export type CacheMode = (typeof CACHE_MODES)[number];

/**
 * TTL values that appear in real provider documentation. An enum rather than
 * `string`, so a typo cannot become a TTL a provider will reject.
 */
export const CACHE_TTL_OPTIONS = ["5m", "1h", "30m", "in_memory", "24h"] as const;
export type CacheTtlOption = (typeof CACHE_TTL_OPTIONS)[number];

/**
 * Provider response fields that report cache activity, as the VENDOR names them.
 *
 * Kept even though the installed AI SDK normalises all of them onto
 * `usage.inputTokenDetails.{cacheReadTokens,cacheWriteTokens}`: these names are
 * what a person verifies against a provider's own documentation and against a raw
 * response, so the documented vocabulary must survive somewhere in the codebase.
 */
export const CACHE_USAGE_FIELDS = [
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "input_tokens_details.cache_read_tokens",
  "input_tokens_details.cache_write_tokens",
  "prompt_tokens_details.cached_tokens",
  "cached_content_token_count",
  "total_cached_tokens",
] as const;
export type CacheUsageField = (typeof CACHE_USAGE_FIELDS)[number];

/** Vendor usage fields that evidence a cache write, and a cache read. */
export interface CacheUsageEvidence {
  /** Field naming tokens written to cache. Absent when the provider reports none. */
  readonly writeField?: CacheUsageField;
  /** Field naming tokens read from cache. Absent when the provider reports none. */
  readonly readField?: CacheUsageField;
  /**
   * Whether a WRITE is observable at all.
   *
   * Distinct from `writeField` being undefined for a different reason: some
   * providers report reads only. Without this flag an absent write field is
   * ambiguous between "no write happened" and "writes are not reported".
   */
  readonly writeObservable: boolean;
  readonly readObservable: boolean;
}

/** How confidently a capability is known. Never `observed`. */
export const CAPABILITY_VERIFICATIONS = [
  /** Read from current official vendor documentation for this exact model. */
  "vendor_documented",
  /** Not in vendor docs; present in the installed SDK's typed options. */
  "sdk_declared_only",
  /** Nothing authoritative establishes this. */
  "unverified",
] as const;
export type CapabilityVerification = (typeof CAPABILITY_VERIFICATIONS)[number];

/**
 * The LOOKUP triple. Deliberately excludes `namespace`, which is derived from the
 * surface rather than chosen by a caller — so a lookup cannot be split by it.
 */
export interface CacheCapabilityLookup {
  readonly providerType: string;
  readonly protocol: ApiProtocol;
  readonly modelId: string;
}

/** Identity of one exact provider surface. Cache behaviour is keyed to this. */
export interface CacheCapabilityKey {
  /** TBAi's provider type, exactly as `ProviderConfig["type"]`. */
  readonly providerType: string;
  /** Wire protocol. Cache semantics can differ per protocol for one provider. */
  readonly protocol: ApiProtocol;
  /** The FULL model identifier. Never a family, never a prefix. */
  readonly modelId: string;
  /**
   * The `providerOptions` key the AI SDK model for this surface reads.
   *
   * Part of the surface's identity, not a caller-supplied argument: an
   * OpenAI-compatible model reads `openaiCompatible` while a native OpenAI model
   * reads `openai`, and Anthropic reads `anthropic`. Passing this in from outside
   * is how an Anthropic cache option ends up under the `openai` key and is
   * silently ignored by the provider — so it is recorded with the capability.
   */
  readonly namespace: CacheNamespace;
}

/** providerOptions keys the AI SDK provider packages actually read. */
export const CACHE_NAMESPACES = ["anthropic", "openai", "openaiCompatible"] as const;
export type CacheNamespace = (typeof CACHE_NAMESPACES)[number];

/** Canonical, unambiguous registry key. Never constructed by string concat elsewhere. */
export function cacheCapabilityKey(key: CacheCapabilityLookup): string {
  return `${key.providerType}|${key.protocol}|${key.modelId}`;
}

/**
 * A capability that CURRENT vendor documentation establishes.
 *
 * Every field is a documented fact. `documentedMinimumPrefixTokens` is the
 * vendor's compatibility FLOOR, never a promise that a request at that size will
 * cache — which is why it is named `documented…` and lives only here.
 */
export interface DocumentedCacheCapability extends CacheCapabilityKey {
  readonly status: "documented";
  readonly cacheSupported: true;
  /** Never `unknown` and never `none` on a documented capability. */
  readonly cacheMode: Exclude<CacheMode, "unknown" | "none">;
  /**
   * Vendor's minimum cacheable prefix. A floor, not a guarantee.
   *
   * OPTIONAL because the absence is itself a documented fact: OpenAI states the
   * pre-GPT-5.6 minimum "varies by request settings, including tools, images,
   * output schemas, reasoning effort, and verbosity", which is not a number.
   * Recording a stand-in there would be indistinguishable downstream from a
   * vendor commitment, so the field is simply absent and
   * `cacheExperimentEligibility` treats an absent minimum as ineligible for a
   * SIZING claim while still permitting an existence check.
   */
  readonly documentedMinimumPrefixTokens?: number;
  /** Vendor's cap on explicit breakpoints, when it documents one. */
  readonly documentedBreakpointLimit?: number;
  /** TTL values the vendor documents for this model. */
  readonly documentedTtlOptions?: readonly CacheTtlOption[];
  /** Whether a stable cache key can be supplied. */
  readonly supportsCacheKey: boolean;
  /**
   * Whether explicit per-block markers can be expressed **without modifying
   * TBAi's assembled request layers**.
   *
   * This is narrower than "the provider supports explicit caching". Anthropic
   * supports per-block `cache_control`, but the AI SDK reads it from each
   * message part's providerOptions — so expressing it would mean writing
   * provider-specific markers into Phase 2's Layers B and C, which the Phase 3
   * rules forbid. Separating the two is what keeps the decision honest.
   */
  readonly supportsExplicitControls: boolean;
  readonly usageEvidence: CacheUsageEvidence;
  /** Documentation URL for the claim. */
  readonly source: string;
  /** ISO date the documentation was read. */
  readonly verifiedOn: string;
  readonly verification: Exclude<CapabilityVerification, "unverified">;
}

/**
 * A capability nothing establishes.
 *
 * Structurally incapable of carrying a threshold, a TTL or a cache key. Every
 * consumer that wants one of those has to handle this case, because the type has
 * none of those fields — the compiler does the enforcing, not a convention.
 */
export interface UnknownCacheCapability extends CacheCapabilityKey {
  readonly status: "unknown";
  readonly cacheSupported: false;
  readonly cacheMode: "unknown";
  readonly usageEvidence: CacheUsageEvidence;
  readonly verification: "unverified";
  /** Why this is unknown. Kept short and free of secrets. */
  readonly reason: string;
}

export type CacheCapability = DocumentedCacheCapability | UnknownCacheCapability;

/** Narrowing helper: true only for vendor-documented capabilities. */
export function isDocumented(capability: CacheCapability): capability is DocumentedCacheCapability {
  return capability.status === "documented";
}

/**
 * What ONE live request reported about cache activity.
 *
 * Three-way, and the third case is the point:
 * - `write_observed` / `read_observed` — the provider reported a number.
 * - `not_observed` — the provider reported nothing. This is a NORMAL outcome
 *   (a below-threshold request succeeds and simply caches nothing) and is
 *   explicitly NOT a failure and NOT a hit.
 * - `unobservable` — this provider/model exposes no cache usage field, so nothing
 *   can be concluded either way.
 *
 * `notObserved` and `unobservable` are different: the first means the provider
 * looked and had nothing to say, the second means there was nothing to look at.
 */
export const CACHE_OBSERVATIONS = [
  "write_observed",
  "read_observed",
  "write_and_read_observed",
  "not_observed",
  "unobservable",
] as const;
export type CacheObservationKind = (typeof CACHE_OBSERVATIONS)[number];

export interface CacheObservation {
  readonly kind: CacheObservationKind;
  /** Provider-reported tokens written to cache. Absent unless observed. */
  readonly writeTokens?: number;
  /** Provider-reported tokens read from cache. Absent unless observed. */
  readonly readTokens?: number;
  /** Provider-reported input tokens that were neither read nor written. */
  readonly uncachedInputTokens?: number;
  /** Which registry key produced this observation. */
  readonly capabilityKey: string;
  /**
   * Whether this observation may be used to size a cache experiment.
   *
   * False whenever the capability is unknown OR the observation is not a real
   * number — so a `not_observed` result can never be laundered into "caching does
   * not work here", which is the claim the two-request protocol exists to settle.
   */
  readonly supportsSizingClaim: boolean;
}

/**
 * Why a cache prefix cannot be reused. Every dynamic field TBAi puts in a request
 * is accounted for by one of these rather than being removed to force cacheability.
 */
export const PREFIX_INVALIDATION_REASONS = [
  "tool_definitions_changed",
  "mcp_tool_set_changed",
  "instructions_changed",
  "reasoning_setting_changed",
  "model_changed",
  "provider_changed",
  "protocol_changed",
  "history_appended",
  "message_extended_in_place",
] as const;
export type PrefixInvalidationReason = (typeof PREFIX_INVALIDATION_REASONS)[number];

/**
 * A fingerprint of the intended stable prefix, computed WITHOUT its content.
 *
 * A digest, never the text: this is logged and compared, so it must not carry
 * prompt content. Two requests sharing a fingerprint are the condition the
 * two-request verification protocol requires.
 */
export interface PrefixIdentity {
  /** Digest over the ordered, serialised prefix. Content-free. */
  readonly fingerprint: string;
  /** Layer A instruction digest, or null when the conversation has none. */
  readonly instructionsFingerprint: string | null;
  /** Ordered native tool names. */
  readonly nativeToolNames: readonly string[];
  /** Ordered MCP tool names. */
  readonly mcpToolNames: readonly string[];
  /** Ids of retained history messages forming the prefix. */
  readonly retainedMessageIds: readonly string[];
  /** Whether the prefix can be reused as-is. */
  readonly stable: boolean;
  /** Populated when `stable` is false. */
  readonly invalidationReasons: readonly PrefixInvalidationReason[];
}