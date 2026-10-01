/**
 * Phase 3 — request-level cache controls.
 *
 * This module is the ONLY place provider-specific cache request syntax lives.
 * The orchestration layer asks an abstract question ("what cache options does
 * this provider/model need?") and receives a typed result; it never names a
 * provider. That is the whole point of the boundary — `chat.ts` contains no
 * `if (provider === "anthropic")`, and neither does `assembleContext`.
 *
 * ## Why request-level options only
 *
 * Both remaining providers' explicit cache controls are **per content block**:
 * Anthropic reads `cache_control` from each message part's providerOptions, and
 * OpenAI reads `prompt_cache_breakpoint` from an input content block. Expressing
 * either would mean writing provider-specific markers into the Layers B and C
 * that `assembleContext` produced — which would violate the Phase 3 rule that
 * provider specifics never bypass the assembly seam, and would put provider
 * branches inside the generic context layer.
 *
 * Both providers document a request-level mode that needs no per-block markers,
 * and both recommend it for exactly TBAi's shape — an append-only, growing
 * conversation:
 *
 * - Anthropic **automatic caching**: one top-level `cache_control` field; the
 *   provider moves the breakpoint to the last cacheable block as the
 *   conversation grows. The guide states it is "the simplest way to enable prompt
 *   caching" and "best for multi-turn conversations".
 * - OpenAI **implicit mode**: `prompt_cache_options.mode = "implicit"`; OpenAI
 *   places a breakpoint at the end of the latest eligible message.
 *
 * So Phase 3 enables exactly those. Explicit per-block breakpoints are DEFERRED —
 * they need a Phase 2 contract change to expose marker placement, which is a
 * larger decision than this phase is authorised to make.
 *
 * ## The conservative default is to send nothing
 *
 * For an `implicit` or `unknown` capability the correct request sends no cache
 * parameter at all. Sending one would be wrong rather than merely redundant, and
 * for `unknown` it is exactly what the phase's rules forbid.
 */

import type { CacheCapability, CacheTtlOption, UnknownCacheCapability } from "./types";

/**
 * The provider-options bag TBAi hands to `streamText`.
 *
 * Declared structurally rather than imported. The AI SDK's own `ProviderOptions`
 * alias lives in `@ai-sdk/provider-utils`, which is a TRANSITIVE dependency of
 * `ai` — and AGENTS.md forbids relying on undeclared transitive packages, because
 * a hoisting change would break the build.
 *
 * The local JSON types mirror the SDK's exactly, so this is structurally
 * assignable to the upstream `SharedV4ProviderOptions = Record<string, JSONObject>`.
 * `unknown` is deliberately NOT used for the value type: it is wider than the
 * SDK's JSON value union and would not type-check at the `streamText` call site,
 * which is exactly the check we want to keep.
 */
export type CacheJsonValue = null | string | number | boolean | CacheJsonObject | CacheJsonValue[];
export interface CacheJsonObject {
  [key: string]: CacheJsonValue | undefined;
}
export type CacheProviderOptions = Record<string, CacheJsonObject>;

/**
 * The providerOptions namespace a surface's model reads.
 *
 * DERIVED FROM THE CAPABILITY, never passed in. This is deliberate: the obvious
 * design — a caller supplying `providerOptionsNamespace(modelConfig)` — puts
 * Anthropic's cache options under the `openai` key, where the Anthropic provider
 * silently ignores them. The namespace is part of the provider surface's
 * identity, so it is recorded with the capability in `capabilities.ts`.
 */
export type CacheProviderNamespace = CacheCapability["namespace"];

/** Outcome of asking what to send. Carries the reason, so omission is explainable. */
export type CacheControlDecision =
  | {
      readonly send: boolean;
      readonly providerOptions: CacheProviderOptions | undefined;
      /** Modes the options actually request, for diagnostics. */
      readonly requestedModes: readonly string[];
      /**
       * Why nothing was sent. Enumerated rather than free text so a log line is
       * greppable and an omitted control is never mistaken for a bug.
       */
      readonly reason?: CacheOmissionReason;
    };

/** Enumerated reasons a cache control was not sent. */
export const CACHE_OMISSION_REASONS = [
  "capability_unknown",
  "capability_none",
  "implicit_caching_needs_no_parameter",
  "explicit_controls_not_available_without_phase2_change",
] as const;
export type CacheOmissionReason = (typeof CACHE_OMISSION_REASONS)[number];

/**
 * Build the request-level cache controls for one request.
 *
 * @param capability Result of `resolveCacheCapability` for this exact model.
 *                   Supplies the providerOptions namespace itself.
 * @param ttl Optional TTL, only honoured when the capability documents it.
 */
export function buildCacheProviderOptions(input: {
  capability: CacheCapability;
  ttl?: CacheTtlOption | undefined;
}): CacheControlDecision {
  const { capability } = input;
  const namespace = capability.namespace;

  if (capability.status === "unknown") return omit("capability_unknown");
  if (!capability.cacheSupported) return omit("capability_none");

  // Implicit caching is the provider's own behaviour. No parameter is correct,
  // and adding one would assert a control TBAi does not have.
  if (capability.cacheMode === "implicit") return omit("implicit_caching_needs_no_parameter");

  // `both` (Anthropic automatic caching, OpenAI GPT-5.6+ implicit mode).
  const options: CacheJsonObject = {};
  const requestedModes: string[] = [];

  if (capability.providerType === "anthropic") {
    // Top-level `cache_control`: Anthropic's documented AUTOMATIC caching. The
    // AI SDK maps this straight onto the request body
    // (anthropic-language-model.ts: `cache_control: anthropicOptions.cacheControl`),
    // so it needs no per-block marker and no Phase 2 change.
    options.cacheControl = { type: "ephemeral" };
    requestedModes.push("automatic");
    const ttl = pickTtl(input.ttl, capability.documentedTtlOptions);
    if (ttl) options.cacheControl = { type: "ephemeral", ttl };
  } else if (capability.providerType === "openai") {
    // `prompt_cache_options.mode = "implicit"` places a breakpoint at the end of
    // the latest eligible message, which is the right shape for an append-only
    // conversation and needs no per-content-block marker.
    options.promptCacheOptions = { mode: "implicit" };
    requestedModes.push("implicit");
    const ttl = pickTtl(input.ttl, capability.documentedTtlOptions);
    if (ttl && ttl === "30m") options.promptCacheOptions = { mode: "implicit", ttl };
  } else {
    // A documented `both` capability from a provider with no request-level
    // expression. Refusing here is the safe branch: it must never fall through to
    // sending another provider's syntax.
    return omit("explicit_controls_not_available_without_phase2_change");
  }

  // ── CACHE KEY: formally deferred, and structurally so ──────────────────────
  //
  // TBAi supplies NO explicit cache key, and this function has no parameter
  // through which one could arrive. That is the decision, recorded in
  // `docs/phase-3-closure-report.md` §4, and it is expressed by ABSENCE rather
  // than by a convention a future caller could quietly opt out of.
  //
  // The evidence, from vendor documentation read 2026-10-01:
  //
  // - Anthropic has no cache key at all, so a universal scheme is impossible.
  // - Google needs none: its implicit caching is automatic.
  // - OpenAI GPT-5.6 and later: "OpenAI handles cache routing automatically; the
  //   key is not needed to optimize caching." It exists for SEPARATE CACHE
  //   ACCOUNTING per customer or user — which a single-user local install has no
  //   use for.
  // - OpenAI before GPT-5.6: the key IS a documented hit-rate optimisation
  //   ("use a stable prompt_cache_key ... to optimize cache routing"). That is
  //   the one case where a key could measurably help, and it is the exact trigger
  //   for revisiting: if such a model is actually configured, measure hit rate
  //   with and without a key before enabling one. TBAi registers these models and
  //   currently sends none.
  //
  // A conversation-ID key would be actively WRONG, not merely unnecessary: the
  // vendor groups keys by requests that SHARE a reusable prefix, so keying per
  // conversation would prevent reuse across conversations that legitimately
  // share a prefix. OpenAI also documents keys as a defence against cache-hit
  // probing across users — a consideration a client-influenceable key would
  // weaken.
  //
  // TBAi's own identity of a reusable prefix is `PrefixIdentity.fingerprint`,
  // computed locally and never sent. Provider-native caching already supplies the
  // identity that matters: reuse requires the serialised prefix to match.
  return {
    send: true,
    providerOptions: { [namespace]: options },
    requestedModes,
  };
}

/**
 * A TTL is only ever forwarded when the capability DOCUMENTS that exact value.
 * Substituting a default would send a TTL the vendor never stated for this model.
 */
function pickTtl(requested: CacheTtlOption | undefined, documented: readonly CacheTtlOption[] | undefined) {
  if (!requested || !documented) return undefined;
  return documented.includes(requested) ? requested : undefined;
}

function omit(reason: CacheOmissionReason): CacheControlDecision {
  return { send: false, providerOptions: undefined, reason, requestedModes: [] };
}

/**
 * Diagnostic projection of a decision.
 *
 * Keys avoid any substring `token` because `logger.ts` redacts those (the
 * standing rule from Phase 2). No prompt content is involved: this reports
 * WHICH control was sent and why one was not, never a prefix.
 */
export function describeCacheDecision(decision: CacheControlDecision): Record<string, unknown> {
  if (decision.send) {
    return {
      cacheControlSent: true,
      cacheControlModes: [...decision.requestedModes],
      cacheControlOmissionReason: null,
      // Always false. Recorded so a log line can never imply a key is in play,
      // and so the deferred status is visible rather than merely absent.
      cacheKeySent: false,
    };
  }
  return {
    cacheControlSent: false,
    cacheControlModes: [],
    cacheControlOmissionReason: decision.reason,
  };
}

/** Convenience for the route: an unknown capability always sends nothing. */
export function isOmittedForUnknown(capability: CacheCapability): capability is UnknownCacheCapability {
  return capability.status === "unknown";
}