/**
 * Phase 3 — provider prompt caching: public surface.
 *
 * ## The boundary this module draws
 *
 * Everything provider-specific about prompt caching lives here, behind four
 * questions the orchestration layer may ask:
 *
 * 1. `resolveCacheCapability` — what does the vendor document for this EXACT
 *    provider + protocol + model? (capabilities.ts)
 * 2. `buildCacheProviderOptions` — what request options, if any, should I send?
 *    (request.ts)
 * 3. `computePrefixIdentity` — is the prefix that will be cached stable? (prefix.ts)
 * 4. `observeCacheUsage` / `evaluateCacheExperiment` — what actually happened,
 *    and what may be concluded? (observe.ts, verification.ts)
 *
 * `assembleContext` and `chat.ts` contain no provider name and no cache
 * conditionals. That is the phase's central architectural requirement, and it is
 * asserted by a boundary test rather than trusted to review.
 *
 * ## What Phase 3 deliberately does NOT do
 *
 * - No per-block cache markers. Those would require writing provider-specific
 *   fields into the Layers B and C that Phase 2 assembled, which the phase rules
 *   forbid. Request-level modes are used instead, and both providers recommend
 *   them for an append-only conversation.
 * - No family-level thresholds. Anthropic's minimums are non-monotonic across
 *   generations, so a family rule is wrong by construction.
 * - No inference from protocol compatibility. A `custom` OpenAI-compatible
 *   endpoint resolves to `unknown` and sends nothing.
 */

export { resolveCacheCapability, documentedCacheCapabilities } from "./capabilities";

export {
  buildCacheProviderOptions,
  describeCacheDecision,
  isOmittedForUnknown,
  CACHE_OMISSION_REASONS,
  type CacheControlDecision,
  type CacheOmissionReason,
  type CacheProviderNamespace,
  type CacheProviderOptions,
} from "./request";

export {
  observeCacheUsage,
  observeSdkCacheUsage,
  describeCacheObservation,
  isCacheObservable,
  type CacheUsageDetail,
  type SdkUsageLike,
} from "./observe";

export {
  computePrefixIdentity,
  comparePrefixIdentities,
  describePrefixIdentity,
  type PrefixComponents,
} from "./prefix";

export {
  evaluateCacheExperiment,
  cacheExperimentEligibility,
  CACHE_VERDICTS,
  CACHE_SIZING_BASES,
  type CacheExperimentLeg,
  type CacheExperimentResult,
  type CacheSizingBasis,
  type CacheSizingBasisInput,
  type CacheVerdict,
} from "./verification";

export {
  CACHE_MODES,
  CACHE_OBSERVATIONS,
  CACHE_TTL_OPTIONS,
  CACHE_USAGE_FIELDS,
  CAPABILITY_VERIFICATIONS,
  PREFIX_INVALIDATION_REASONS,
  cacheCapabilityKey,
  isDocumented,
  type CacheCapability,
  type CacheCapabilityKey,
  type CacheMode,
  type CacheObservation,
  type CacheObservationKind,
  type CacheTtlOption,
  type CacheUsageEvidence,
  type CacheUsageField,
  type CapabilityVerification,
  type DocumentedCacheCapability,
  type PrefixIdentity,
  type PrefixInvalidationReason,
  type UnknownCacheCapability,
} from "./types";