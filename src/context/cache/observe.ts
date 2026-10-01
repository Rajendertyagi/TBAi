/**
 * Phase 3 — cache observation from provider-reported usage.
 *
 * One request's usage tells you what happened to THAT request. It never tells you
 * what a model can do. This module exists to keep those apart:
 *
 * - `CacheCapability` (from `capabilities.ts`) is vendor-documented and static.
 * - `CacheObservation` (here) is per-request and provider-reported.
 *
 * Nothing here writes back into the registry. An observation that contradicts the
 * documentation is a finding to investigate, not a fact to overwrite — Phase 3's
 * rules require observed behaviour to be measured independently and recorded
 * separately.
 *
 * ## The three-way outcome is the whole point
 *
 * A request below a documented minimum, or one a provider chose not to cache,
 * **succeeds and reports no cache activity**. That is a normal outcome. Reporting
 * it as a failure would be wrong, and reporting it as a hit would be worse. So:
 *
 * | Outcome          | Meaning                                             |
 * |------------------|-----------------------------------------------------|
 * | observed         | the provider reported a non-zero number              |
 * | `not_observed`   | the provider reported the field and it was zero/absent — nothing cached, nothing concluded |
 * | `unobservable`   | this model exposes no cache usage field — nothing can be said either way |
 */

import { cacheCapabilityKey, type CacheCapability, type CacheObservation } from "./types";

/**
 * The AI SDK's normalised usage detail.
 *
 * AI SDK v7 (`LanguageModelUsage.inputTokenDetails`) exposes `noCacheTokens`,
 * `cacheReadTokens` and `cacheWriteTokens` separately, which is what makes the
 * write/read distinction possible at all. Note the SDK does NOT surface a cache
 * WRITE for the OpenAI Chat Completions dialect or for Google, so an absent
 * `cacheWriteTokens` there means "not reported", never "zero written".
 */
export interface CacheUsageDetail {
  readonly inputTokens?: number | undefined;
  readonly noCacheTokens?: number | undefined;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
}

function count(value: number | undefined | null): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The AI SDK's `streamText` usage object, structurally.
 *
 * Named here rather than in the route so the orchestration layer never names an
 * SDK cache field. `observeSdkCacheUsage` is the only place that reads them.
 */
export interface SdkUsageLike {
  readonly inputTokens?: number | undefined;
  readonly inputTokenDetails?:
    | {
        readonly noCacheTokens?: number | undefined;
        readonly cacheReadTokens?: number | undefined;
        readonly cacheWriteTokens?: number | undefined;
      }
    | undefined;
}

/**
 * Classify one request's cache activity directly from the AI SDK's usage object.
 *
 * This is the entry point the route uses. It exists so the provider/SDK-shaped
 * detail lives in this module rather than in `chat.ts`, which keeps the route
 * free of both provider names and SDK cache field names.
 */
export function observeSdkCacheUsage(input: {
  capability: CacheCapability;
  usage: SdkUsageLike;
}): CacheObservation {
  const detail = input.usage.inputTokenDetails;
  return observeCacheUsage({
    capability: input.capability,
    usage: {
      inputTokens: input.usage.inputTokens,
      noCacheTokens: detail?.noCacheTokens,
      cacheReadTokens: detail?.cacheReadTokens,
      cacheWriteTokens: detail?.cacheWriteTokens,
    },
  });
}

/**
 * Classify one request's cache activity.
 *
 * @param capability The documented capability for this exact model.
 * @param usage Provider-reported usage detail, as the SDK normalised it.
 * @returns An observation whose `supportsSizingClaim` is false unless a real
 *          number was reported for a documented capability.
 */
export function observeCacheUsage(input: {
  capability: CacheCapability;
  usage: CacheUsageDetail;
}): CacheObservation {
  const { capability, usage } = input;
  const capabilityKey = cacheCapabilityKey(capability);

  const read = count(usage.cacheReadTokens);
  const write = count(usage.cacheWriteTokens);
  const uncached = count(usage.noCacheTokens) ?? (read === undefined && write === undefined ? count(usage.inputTokens) : undefined);

  const readObserved = read !== undefined && read > 0;
  const writeObserved = write !== undefined && write > 0;

  // The provider is only "unobservable" when BOTH fields are absent. A field
  // that is present and zero means the provider looked and had nothing to report.
  if (read === undefined && write === undefined) {
    return {
      kind: "unobservable",
      capabilityKey,
      supportsSizingClaim: false,
    };
  }

  let kind: CacheObservation["kind"];
  if (readObserved && writeObserved) kind = "write_and_read_observed";
  else if (readObserved) kind = "read_observed";
  else if (writeObserved) kind = "write_observed";
  else kind = "not_observed";

  // A sizing claim needs BOTH a documented capability and a real number.
  // `not_observed` is explicitly excluded: "nothing happened" is not evidence
  // about what would happen with a different prefix.
  const supportsSizingClaim = capability.status === "documented" && (readObserved || writeObserved);

  return {
    kind,
    capabilityKey,
    supportsSizingClaim,
    ...(write !== undefined ? { writeTokens: write } : {}),
    ...(read !== undefined ? { readTokens: read } : {}),
    ...(uncached !== undefined ? { uncachedInputTokens: uncached } : {}),
  };
}

/**
 * Loggable projection of an observation.
 *
 * Key names avoid any substring `token` — `logger.ts`'s `SENSITIVE_KEY_RE`
 * matches `.*token.*` and would replace the values with "[REDACTED]", making the
 * whole diagnostic useless. `unit: "tokens"` carries the unit unambiguously,
 * which is the same convention Phase 2 established for the budget diagnostics.
 */
export function describeCacheObservation(observation: CacheObservation): Record<string, unknown> {
  return {
    unit: "tokens",
    cacheObservation: observation.kind,
    cacheWriteSize: observation.writeTokens ?? null,
    cacheReadSize: observation.readTokens ?? null,
    cacheUncachedSize: observation.uncachedInputTokens ?? null,
    cacheObservationSupportsSizing: observation.supportsSizingClaim,
    cacheCapabilityKey: observation.capabilityKey,
  };
}

/**
 * Whether a provider-reported usage object can prove anything about caching.
 *
 * Separate from the observation itself because it is a property of the MODEL, and
 * it is what the two-request protocol checks before it will run: an unobservable
 * model can still be exercised, but its result can only ever be `not_observed`
 * or `unobservable`, so the run is labelled accordingly instead of being treated
 * as a negative result.
 */
export function isCacheObservable(capability: CacheCapability): boolean {
  return capability.usageEvidence.readObservable || capability.usageEvidence.writeObservable;
}