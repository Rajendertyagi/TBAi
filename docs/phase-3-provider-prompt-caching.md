# Phase 3 — Provider Prompt Caching

**Date:** 2026-10-01 · **Scope:** TBAi only. **No Phase 4 or Phase 5 work.**

**Labels:** **IMPLEMENTED** · **VERIFIED** · **LIVE-VERIFIED** · **UNVERIFIED** ·
**UNKNOWN** · **DEFERRED**.

---

# 1. Scope

**What this phase is.** Provider-side reuse of a stable model-request prefix, to
the extent the vendor actually documents support for the exact model.

**What it is not.** An application-level context cache (§3.8 of the roadmap), and
not a compaction or summarisation mechanism.

## What was built

| Piece | Status |
|---|---|
| Capability registry keyed by provider + protocol + **exact model** | IMPLEMENTED |
| Unknown-model policy (send nothing) | IMPLEMENTED |
| Request-level cache controls for Anthropic + OpenAI | IMPLEMENTED |
| Stable-prefix identity with invalidation reasons | IMPLEMENTED |
| Cache observation from provider-reported usage | IMPLEMENTED, LIVE-VERIFIED |
| Two-request verification protocol | IMPLEMENTED (evaluates legs; performs no requests) |
| `cache_observed` diagnostics per request | IMPLEMENTED, LIVE-VERIFIED |
| Live cache write/read on a real provider | **UNVERIFIED** — see §11 |

## The architectural decision that shaped everything

**No per-block cache markers. Request-level controls only.**

Both remaining providers' *explicit* cache controls are per content block: the AI
SDK reads Anthropic's `cache_control` from each **message part's**
`providerOptions` (`convert-to-anthropic-prompt.ts:174,286,498`), and OpenAI's
`prompt_cache_breakpoint` is an **input content-block field**. Expressing either
would mean writing provider-specific fields into the Layers B and C that
`assembleContext` produced — which would breach three Phase 3 rules at once: the
capability boundary, the no-bypass rule, and the ban on provider branches in the
orchestration layer.

Both vendors document a **request-level** mode that needs no per-block markers, and
both recommend it for exactly TBAi's shape (an append-only growing conversation):

- Anthropic **automatic caching** — one top-level `cache_control`; the provider
  moves the breakpoint to the last cacheable block. The guide calls it "the
  simplest way to enable prompt caching" and "best for multi-turn conversations".
- OpenAI **implicit mode** — `prompt_cache_options.mode = "implicit"`; OpenAI places
  a breakpoint at the end of the latest eligible message.

So those are what Phase 3 enables. **Explicit per-block breakpoints are DEFERRED**
— they require a Phase 2 contract change to expose marker placement, which is a
larger architectural decision than this phase is authorised to take. The registry
records this honestly as `supportsExplicitControls: false` rather than claiming a
capability TBAi cannot currently express.

---

# 2. Provider/model capability registry

`src/context/cache/capabilities.ts` · `src/context/cache/types.ts`

**Keyed by `providerType | protocol | modelId`.** Exact match. No prefix matching,
no family fallback, no numeric heuristic, and a test asserts the registry contains
no `.startsWith("claude"…)` / `.includes("gpt"…)`.

**Why exact-keying is mandatory, not stylistic.** Anthropic's documented minimums
are **non-monotonic across generations**:

| Model | Documented minimum |
|---|---|
| `claude-opus-5-5` | **512** |
| `claude-opus-4-8` | **1,024** |
| `claude-opus-4-7` | **2,048** |
| `claude-opus-4-5` | **4,096** |

A family rule would have to pick one number and be wrong for the other three. A
test pins all four.

## Registry contents

| Provider | Protocol | Models | Min prefix | Mode | Namespace |
|---|---|---|---|---|---|
| `anthropic` | *(Messages API)* | `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5`, `claude-opus-5` | **512** | `both` | `anthropic` |
| `anthropic` | | `claude-opus-4-8`, `claude-sonnet-5`, `claude-sonnet-4-6` | **1,024** | `both` | `anthropic` |
| `anthropic` | | `claude-opus-4-7` | **2,048** | `both` | `anthropic` |
| `anthropic` | | `claude-opus-4-6`, `claude-opus-4-5`, `claude-haiku-4-5`, `claude-haiku-4-5-20251001` | **4,096** | `both` | `anthropic` |
| `openai` | `responses` | `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`, `gpt-5.6-cyber` | **1,024** | `both` | `openai` |
| `openai` | `responses` | `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`, `gpt-5.2`, `gpt-5.1`, `gpt-5.1-chat-latest`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5`, `gpt-5-codex`, `gpt-4.1` | **varies** — see below | `implicit` | `openai` |
| `openai` | `chat-completions` | *(same two groups)* | as above | as above | `openaiCompatible` |
| `google` | `responses` | `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.1-pro-preview` | **4,096** | `implicit` | `openaiCompatible` |
| `google` | `responses` | `gemini-2.5-flash`, `gemini-2.5-pro` | **2,048** | `implicit` | `openaiCompatible` |

Everything else resolves to `unknown`.

### Two deliberate absences

**OpenAI pre-5.6 has no recorded number.** The guide states the minimum "varies by
request settings, including tools, images, output schemas, reasoning effort, and
verbosity". That is not a number, so `documentedMinimumPrefixTokens` is **absent**
and `cacheExperimentEligibility` refuses a *sizing* claim for those models while
still permitting an existence check. Recording a stand-in would be
indistinguishable downstream from a vendor commitment.

**Anthropic models retired outside the Claude API are excluded.** `claude-haiku-3-5`,
`claude-sonnet-4`, `claude-opus-4-1`, `claude-opus-4` are documented as available
"retired, except on Bedrock and Google Cloud" — surfaces TBAi does not use. TBAi's
Anthropic provider talks to the Claude API, where they are unavailable, and
automatic caching returns a **400** on legacy Bedrock regardless. Including them
would create entries that can never legitimately match.

Mythos models are excluded too: their minimums are documented but they are
limited-availability with no public Claude API ID in the models overview.

## The `namespace` field

Part of the surface's identity, recorded **with** the capability rather than passed
in by the caller. This is not tidiness — it fixes a bug the tests caught during
implementation: a caller-supplied namespace put Anthropic's `cacheControl` under
the `openai` key, where the Anthropic provider **silently ignores it**. The failure
would have been indistinguishable from "caching did not happen".

---

# 3. Official provider documentation

All read **2026-10-01** — re-verified against live vendor pages, not the roadmap's
2026-09-30 table.

| Provider | Source |
|---|---|
| Anthropic | `https://platform.claude.com/docs/en/build-with-claude/prompt-caching` |
| Anthropic model IDs | `https://platform.claude.com/docs/en/about-claude/models/overview` |
| OpenAI | `https://developers.openai.com/api/docs/guides/prompt-caching` |
| OpenAI model IDs | `https://developers.openai.com/api/docs/models` |
| Google | `https://ai.google.dev/gemini-api/docs/caching` (page updated 2026-09-02) |

## The roadmap's §3.2 was OUTDATED — corrected here

The 2026-09-30 table states *"Caching is **explicit** on Anthropic: `cache_control`
markers are required. Without a marker nothing is cached."*

**That is no longer true.** Anthropic now documents **automatic caching**: a single
**top-level** `cache_control` field, with the system moving the breakpoint to the
last cacheable block as the conversation grows. It is documented as available on
every platform **except** legacy Amazon Bedrock (Opus 4.6 and earlier), where it
returns a **400**.

This correction is load-bearing: automatic caching is precisely the request-level
control Phase 3 needs, and without re-verification the phase would have concluded
that Anthropic caching was inexpressible and shipped nothing.

**The non-monotonic minimums warning in §3.2 is confirmed** and now enforced by a
test rather than by prose.

## Documented facts per provider

### Anthropic — `claude-opus-5-5` (representative)

| Property | Value |
|---|---|
| Explicit cache support | Yes — per-block `cache_control`, max **4** breakpoints |
| Automatic cache support | **Yes** — top-level `cache_control` |
| TTL | **5m** (default), **1h** (2× base input price) |
| Cache key | **Not supported** |
| Minimum prefix | **512** tokens (model-specific; see §2) |
| Prefix composition | `tools` → `system` → `messages`, in that order |
| Lookback | 20 blocks per breakpoint |
| Write field | `cache_creation_input_tokens` |
| Read field | `cache_read_input_tokens` |
| Uncached field | `input_tokens` — **only tokens after the last breakpoint** |
| Total input | `cache_read + cache_creation + input_tokens` |

### OpenAI — `gpt-6.1-sol` (GPT-5.6 and later)

| Property | Value |
|---|---|
| Explicit breakpoints | Supported — `prompt_cache_breakpoint: {mode:"explicit"}` on a content block |
| Implicit breakpoints | At the end of the latest eligible message |
| Cache key | `prompt_cache_key` — optional, for separate cache accounting |
| Minimum prefix | **1,024** visible input tokens (hidden system tokens excluded) |
| Max cache writes | **4** per request |
| TTL | `prompt_cache_options.ttl` — **`30m` is the only supported value**, also the default |
| Prewarm | `prompt_cache_options.prewarm` (Responses API) |
| Write field | `usage.input_tokens_details.cache_write_tokens` |
| Read field | `usage.input_tokens_details.cache_read_tokens` |
| Cache write charge | 1.25× uncached input (0.1× read on most, 0.05× on GPT-6.1 Sol) |

⚠️ **`prompt_cache_options` on a pre-5.6 model is a documented hazard.** TBAi gates
it on the exact model id, so it is never sent to an earlier model. The installed
SDK additionally strips `promptCacheRetention` on GPT-6+ and emits a warning
(`openai-chat-language-model.ts:227-234`).

### Google — `gemini-3.8-flash`

| Property | Value |
|---|---|
| Implicit caching | **Enabled by default** for Gemini 2.5+; no parameter needed |
| Explicit caching | Requires a separately-created cache resource + `cachedContent` — an out-of-band resource lifecycle TBAi does not have. **Not claimed.** |
| Minimum prefix | 4,096 (3.x Flash / 3.1 Pro Preview), 2,048 (2.5 Flash / Pro) |
| Read field | `cachedContentTokenCount` / `total_cached_tokens` |
| Write field | **None reported** |

### Ollama, and custom / OpenAI-compatible endpoints

| Surface | Capability | Why |
|---|---|---|
| `ollama` | `unknown`, unobservable | A local runtime, not a documented caching service. The SDK's OpenAI-compatible dialect exposes no cache usage field. |
| `custom` | `unknown` | **Protocol compatibility is not cache capability.** Asserting support from an OpenAI-shaped response would breach the rule against inferring capability. |

---

# 4. Cache parameter compatibility

| | Anthropic | OpenAI Responses | OpenAI Chat | Google | openai-compatible |
|---|---|---|---|---|---|
| Cache control expressible | ✅ `both` | ✅ `both` | ✅ | n/a (implicit) | ❌ **none in SDK** |
| Sent by TBAi | `{anthropic:{cacheControl:{type:"ephemeral"}}}` | `{openai:{promptCacheOptions:{mode:"implicit"}}}` | same, namespace `openaiCompatible` | nothing | nothing |
| Per-block markers | DEFERRED (§1) | DEFERRED (§1) | DEFERRED | not applicable | not available |

**`@ai-sdk/openai-compatible@3.0.44` exposes NO cache control at all** — only a
passive read of `prompt_tokens_details.cached_tokens` if an upstream sends it. This
is the concrete reason a `custom` provider resolves to `unknown` even when it
speaks a dialect OpenAI itself understands.

## Usage fields — the SDK normalises them, but the names are still recorded

AI SDK v7 exposes `LanguageModelUsage.inputTokenDetails.{noCacheTokens,
cacheReadTokens, cacheWriteTokens}` — **separate write and read counts**, which is
what makes the two-request protocol possible at all.

The registry still records each provider's **own** field names
(`CacheUsageField`), because those are what a person verifies against a vendor doc
or a raw response. Normalisation is an SDK convenience, not a reason to discard
the documented vocabulary.

Two gaps recorded honestly, not papered over:

| Provider | Write observable? | Read observable? |
|---|---|---|
| Anthropic | ✅ | ✅ |
| OpenAI Responses | ✅ | ✅ |
| OpenAI Chat Completions | ❌ **not reported** | ✅ |
| Google | ❌ **not reported** | ✅ |

---

# 5. Stable prefix contract

`src/context/cache/prefix.ts`

The provider caches the **serialised prefix**. Anthropic documents the order as
`tools` → `system` → `messages` — which is TBAi's Layer B → A → C, so **Phase 2's
three-layer model is also the caching model.**

## Determinism — VERIFIED, inherited from Phase 2

| Layer | Determinism | Source |
|---|---|---|
| B.1 native tools | ✅ byte-identical key order across repeated builds | Phase 2 guarantee G7, tested in `assemble.test.ts:97` |
| B.2 MCP tools | ✅ sorted by server then name | Phase 2 |
| A instructions | ✅ server-owned, or absent | Phase 2 |
| C.1 retained history | ✅ persisted `order_seq` | Phase 2 |

Phase 3 adds **verification**, not new determinism. `computePrefixIdentity`
fingerprints the ordered prefix and reports invalidation reasons.

## Dynamic fields — identified, not removed

Phase 3 forbids removing metadata to force cacheability. TBAi genuinely has
per-request ids, and all sit **outside** the cacheable prefix:

| Field | Where it lives | In the prefix? |
|---|---|---|
| `requestId` | transport / logging only | **No** — never serialised into the model request |
| run `streamId` | run bookkeeping | **No** |
| generated message id | the **response** | **No** |
| tool descriptions | Layer B, code-defined | Yes — stable by construction |
| MCP tool membership | Layer B, connection state | Yes — **the highest-likelihood churn source** |

`computePrefixIdentity` therefore covers exactly the three layers, which is why it
is stable across otherwise-different requests.

## The fingerprint is content-free

`sha256`, full 64 hex chars, never truncated. Component digests (instructions,
tools) exist so a mismatch can be **attributed** — "the tool set changed" versus
"the instructions changed" — without revealing anything. A test asserts the secret
does not appear in the identity or its log projection.

## Current turn excluded — deliberately

Including it would make every request's fingerprint unique. Anthropic documents
this trap precisely: *"Breakpoint on content that changes every request… You pay
for a fresh cache write on every request and never get a read."*

Appended history is an **extension**, not an invalidation: the earlier prefix is
still a prefix of the new request. `isExtensionOf` distinguishes append from
rewrite/reorder/shrink.

---

# 6. Cache identity / invalidation

**TBAi sends NO cache key by default.** `buildCacheProviderOptions` forwards a key
only when the capability documents `supportsCacheKey`, and today only OpenAI does.

The reasons this is the right default:

1. **Anthropic has no cache key at all** — so a TBAi-wide key scheme could not be
   universal.
2. **Google's implicit caching needs none.**
3. **On GPT-5.6+ OpenAI states the key is not needed to optimise caching** — it is
   for *separate cache accounting* per customer.
4. **On earlier models the key IS a routing optimisation** and would be valuable —
   but §3 of the OpenAI guide warns it must be stable and partitioned, and those
   are product decisions about user grouping.

A client-controlled key is explicitly out of reach: the key is server-derived, and
TBAi derives none today. **DEFERRED**, with the exact inputs it would need recorded
in `request.ts`.

## Invalidation reasons

| Reason | Layer | Cause |
|---|---|---|
| `tool_definitions_changed` | B.1 | native tool names/order differ — **including pure reordering** |
| `mcp_tool_set_changed` | B.2 | MCP membership changed (connect/disconnect) |
| `instructions_changed` | A | conversation system prompt differs |
| `history_appended` | C.1 | retained ids are not an extension of the previous prefix |
| `message_extended_in_place` | C.1 | reserved; OpenAI documents that extending a message can strand a cached endpoint |
| `model_changed` / `provider_changed` / `protocol_changed` | — | reserved; the provider keys its cache by model and routing |
| `reasoning_setting_changed` | A/B | reserved; Anthropic and OpenAI both document thinking/effort as prefix-affecting |

The three `reserved` reasons are declared in the enum but not yet emitted — they
describe cross-request changes this in-request function cannot observe. Recording
them now keeps the vocabulary complete without inventing detection.

---

# 7. Documented vs observed thresholds

**These are separate types with no field in common.** `CacheCapability` is
vendor-documented and static; `CacheObservation` is per-request. No function
accepts one where the other is expected, and nothing writes an observation back
into the registry.

- `DocumentedCacheCapability.documentedMinimumPrefixTokens` — a vendor **floor**,
  never a promise that a request at that size caches.
- `CacheObservation.{writeTokens, readTokens, uncachedInputTokens}` — what one
  provider actually reported.
- `CacheExperimentResult` carries both in **separate** `documented` and `observed`
  fields, side by side and never merged.

**The below-threshold rule.** When a measured prefix is under the documented
minimum, the run is annotated `measured_prefix_below_documented_minimum` and the
verdict becomes `cache_not_observed`.

## The three-way observation — the point of the whole module

| Outcome | Meaning |
|---|---|
| `write_observed` / `read_observed` / `write_and_read_observed` | the provider reported a non-zero number |
| `not_observed` | the provider **reported the field and it was zero** — nothing cached. A **normal outcome** |
| `unobservable` | the model exposes **no** cache field — nothing can be said either way |

`not_observed` ≠ `unobservable`: the first means the provider looked and had
nothing; the second means there was nothing to look at. Collapsing them would turn
an unmeasured model into a negative result.

---

# 8. Verification protocol

`src/context/cache/verification.ts`

```text
REQUEST 1  →  stable prefix P + suffix A   →  expect cache WRITE
REQUEST 2  →  the SAME prefix P + suffix B →  expect cache READ
```

The suffix **must** differ (a byte-identical repeat proves nothing about which part
was reused) and the prefix **must** be identical (otherwise a missing read is
uninterpretable rather than negative). Both are checked; both failures are
recorded as reasons.

## Verdicts

| Verdict | Meaning | Supports a conclusion? |
|---|---|---|
| `write_then_read_observed` | both legs reported activity | ✅ |
| `write_observed_read_not_observed` | wrote, then did not read | ✅ |
| `cache_not_observed` | **normal below-threshold / not-cached outcome** | ❌ **explicitly** |
| `inconclusive_unobservable` | no cache field exists on this model | ❌ |
| `inconclusive_prefix_mismatch` | the two requests did not share a prefix | ❌ |
| `ineligible_unknown_capability` | nothing documents this model | ❌ |

`cache_not_observed` carries `supportsConclusion: false` **by design** — it is the
result that must never be read as "caching does not work here".

## Eligibility for a sizing claim

`cacheExperimentEligibility` requires **both**:

1. A documented, observable capability **with a recorded minimum number**.
2. `contextLimitSource === "provider_reported"`.

Rule 2 is R1's binding rule enforced at the point the decision would be taken. A
`conservative_default` or `configured` limit may bound safety, never a cache
experiment. **VERIFIED live** — see §11.

---

# 9. Unknown-model behavior

For `capability.status === "unknown"`:

| | |
|---|---|
| Explicit provider cache parameter | **never sent** |
| Fake threshold | **impossible** — `UnknownCacheCapability` has no threshold field |
| Fake TTL | **impossible** — same |
| Fake cache key | **never sent** |
| Cache-support claim | **never made** — `cacheSupported: false`, `verification: "unverified"` |
| Experiment verdict | `ineligible_unknown_capability` |
| Logged reason | `cacheControlOmissionReason=capability_unknown` |

The honesty is **structural**: `UnknownCacheCapability` has no
`documentedMinimumPrefixTokens`, no `documentedTtlOptions` and no `supportsCacheKey`
member, so a consumer wanting one is forced by the compiler to handle the case. No
convention, no discipline.

**Implicit caching is documented separately**, as the rules require: Google's and
OpenAI's pre-5.6 models resolve to `cacheMode: "implicit"` with
`cacheSupported: true`, and `buildCacheProviderOptions` returns
`implicit_caching_needs_no_parameter`. That is a *documented capability with no
parameter*, categorically different from `unknown`.

---

# 10. Usage / observability

## Existing surface, reused rather than duplicated

TBAi already had a cache-read path: `buildChatMessageMetadata` attaches the SDK's
`totalUsage`, and `@assistant-ui/ai-sdk`'s `useThreadTokenUsage` maps
`inputTokenDetails.cacheReadTokens` → `cachedInputTokens`, which
`context-display.tsx` renders as a "Cached input" segment. That chain already
worked; Phase 3 did not modify it.

**The gap Phase 3 filled:** the SDK exposes a cache **WRITE** count and TBAi
surfaced neither write nor read to its own logs. `observeSdkCacheUsage` now reads
`inputTokenDetails` in one place — inside the cache module — so the route never
names an SDK cache field.

## The `cache_observed` log line

Every Direct request emits one, LIVE-VERIFIED against the running server:

| Key | Meaning |
|---|---|
| `unit: "tokens"` | the numeric keys deliberately avoid the word (below) |
| `cacheObservation` | `write_observed` / `read_observed` / `write_and_read_observed` / `not_observed` / `unobservable` |
| `cacheWriteSize`, `cacheReadSize`, `cacheUncachedSize` | provider-reported counts, `null` when absent |
| `cacheObservationSupportsSizing` | may this observation authorise a sizing claim |
| `cacheCapabilityKey` | `provider\|protocol\|modelId` |
| `capabilityStatus`, `capabilityMode` | `unknown` vs `documented`; `implicit` / `explicit` / `both` / `unknown` |
| `cacheControlSent`, `cacheControlModes`, `cacheControlOmissionReason` | whether a control went out and, if not, **which of four enumerated reasons** |
| `documentedMinimumPrefix`, `documentedSource`, `documentedVerifiedOn` | **DOCUMENTED** values, `null` when unknown |
| `prefixFingerprint`, `prefixStable`, `prefixInvalidationReasons`, `prefixNativeToolCount`, `prefixMcpToolCount` | prefix identity — digests and counts, **never content** |
| `contextLimitSource`, `phase3ExperimentEligible` | R1's rule, evaluated per request |

### Two standing constraints honoured

**No key contains the substring `token`.** `logger.ts`'s `SENSITIVE_KEY_RE` matches
`.*token.*` and would replace the values with `[REDACTED]`, destroying the
diagnostic. `cacheWriteSize` / `cacheReadSize` carry the unit in `unit: "tokens"`
instead — the same convention Phase 2 established for the budget diagnostics. A
test pins it.

Note the deliberate asymmetry: the **typed** fields keep honest names
(`CacheObservation.writeTokens`), exactly as Phase 2 preserved
`InputSizeEstimate.estimatedTokens` while renaming only the log-boundary keys. Only
the log projection is constrained.

**No prompt content.** The fingerprint is a digest; the projection carries counts
and tool-name counts. A test asserts a secret string in the system prompt appears
nowhere in the identity or its projection.

---

# 11. Live verification

Server started on `:3012` against the real database. **Provider configuration was
not modified.**

| Check | Result |
|---|---|
| Normal request | **LIVE-VERIFIED** — HTTP 200, 945 ms, 63 SSE frames |
| Oversized 4 MB request | **LIVE-VERIFIED** — HTTP 400 in 62 ms, pre-flight |
| Configured provider | `agnes` / `custom` / `agnes-3.0-flash` (3 models, 0 with `contextWindow`) |
| Cache control sent | **`false`**, reason `capability_unknown` |
| Documented minimum | `null` — no fabricated number |
| Capability status | `unknown` |
| Prefix identity | fingerprint computed, `prefixStable=true`, 15 native tools, 0 MCP |
| Context limit source | `conservative_default` → **`phase3ExperimentEligible=false`** |
| Provider-side cache error | **none** — no `cache_control` sent, no 400 |

## Live result: the unknown-model policy, demonstrated

The configured provider is a `custom` OpenAI-compatible endpoint. It resolved to
`unknown`, so **nothing was sent** — which is precisely correct. Inferring cache
support from protocol compatibility would have risked a parameter the endpoint may
reject.

### An incidental observation, recorded but NOT promoted to a capability

The live `cache_observed` line reported `cacheReadSize=0` and
`cacheUncachedSize=3881`. That means the endpoint **did return a field the
openai-compatible SDK reads as a cache count**, and the value was zero — so the
outcome is `not_observed` (the provider looked and had nothing), not
`unobservable`.

This does **not** upgrade the capability. Nothing documents this model, the value
was zero, and a single zero is not evidence of support. It is recorded here as an
**UNKNOWN** observation worth re-examining, not as a finding.

## What is NOT live-verified

| Item | Status | Why |
|---|---|---|
| **A real cache write** | **UNVERIFIED** | Requires an Anthropic or OpenAI credential. Only a `custom` endpoint is configured. |
| **A real cache read** | **UNVERIFIED** | Same. |
| Latency/cost improvement | **UNVERIFIED** | Requires the above. |
| Ollama behaviour | **UNVERIFIED** | No Ollama provider configured. |
| Gemini behaviour | **UNVERIFIED** | No Google provider configured. |

**No cache hit is claimed.** No Anthropic or OpenAI request was made, so nothing
about real provider cache behaviour is demonstrated. The live run demonstrates the
**unknown-model policy and the diagnostics**, which is what it can honestly show.

⚠️ **The configured provider cannot produce a cache experiment at all**, and no
attempt was made to change that: `capability` is `unknown` and
`contextLimitSource` is `conservative_default`. Both gates correctly refuse. The
task's instruction not to modify provider configuration was followed, so no
`provider_reported` sizing claim was manufactured.

---

# 12. Residual risks

| # | Risk | Status |
|---|---|---|
| P3-R1 | **The registry is a dated snapshot.** Verified 2026-10-01; every entry carries `verifiedOn` so staleness is visible. New models resolve to `unknown` and send nothing — safe, but not useful. | Accepted; re-verify before relying on a new model |
| P3-R2 | **No Anthropic/OpenAI credential configured**, so no cache write or read has ever been observed. The whole two-request protocol is exercised only by tests. | **UNVERIFIED** — the phase's largest gap |
| P3-R3 | **Explicit per-block breakpoints are DEFERRED.** Anthropic's automatic caching places the breakpoint at the last cacheable block, which the vendor documents as the wrong choice when a varying block is last. TBAi's current-turn tail is exactly that. So Anthropic caching may underperform until marker placement exists. | **DEFERRED** — needs a Phase 2 contract change |
| P3-R4 | **No cache key is sent.** On pre-5.6 OpenAI the key is a documented routing optimisation; without it, hit rates may be lower than achievable. | **DEFERRED** — product decision (per-user accounting) |
| P3-R5 | OpenAI pre-5.6 has **no recorded minimum**, so a sizing claim is impossible for those models. | By design |
| P3-R6 | `message_extended_in_place`, `model_changed`, `provider_changed`, `protocol_changed`, `reasoning_setting_changed` are declared but **not emitted** — they describe cross-request changes this in-request function cannot observe. | Accepted |
| P3-R7 | The `custom` endpoint returned a zero cache-read field. If it does support caching, TBAi will not use it until documented. | **UNKNOWN** |
| P3-R8 | The Anthropic **auto-caching ↔ 4-breakpoint interaction** is unverified live: the vendor documents a 400 when 4 explicit blocks already exist, and `CacheControlValidator` counts only per-block ones. TBAi sends zero per-block markers, so no slot is consumed — reasoned, not measured. | **UNVERIFIED** |
| P3-R9 | Phase 4 compaction will rewrite Layer C and can reset cache reuse — OpenAI documents this explicitly. Phase 3 does not address it. | Handed to Phase 4 (§13) |

---

# 13. Phase 4 boundary

**No Phase 4 or Phase 5 work was performed.** No summarisation, no compaction
trigger, no history rewriting, no compaction marker, no memory injection.

What Phase 4 **can** rely on from Phase 3:

1. **`computePrefixIdentity` is available and stable.** A compactor can fingerprint
   a pre-compaction and post-compaction prefix and show whether reuse survived.
2. **`evaluateCacheExperiment` will report `inconclusive_prefix_mismatch`** when a
   compaction changes the prefix — so Phase 4's effect on cache reuse is measurable
   rather than assumed.
3. **`CacheObservation` is already distinguished from capability**, so a cache
   measurement taken across a compaction boundary cannot be mistaken for a
   capability change.
4. **Documented minimums are recorded per exact model**, so Phase 4 can size a
   compaction target against a vendor floor.

What Phase 4 must **not** assume:

- That a cache hit survived a compaction. OpenAI's guide states compaction "can
  prevent reuse from the first changed token onward". Measuring is required.
- That `cache_not_observed` means caching broke — it is the normal outcome for a
  short prefix.
- That the context ceiling bounds anything cache-related. R1's rule stands: a
  `conservative_default` limit may bound safety, never a cache conclusion.

**Suggested Phase 4 prerequisite** (not implemented here): a compaction policy
that preserves the prefix head. OpenAI's guide is explicit that summarisation and
truncation "can change the prefix and reset cache reuse", and Anthropic documents
the same for rewriting cached content. That decision belongs to Phase 4.

---

# Exit criteria

| # | Criterion | Verdict |
|---|---|---|
| 1 | Capability registry keyed by full provider + model | **PASS** — `provider\|protocol\|modelId`, no family match, tested |
| 2 | Explicit unknown-model policy | **PASS** — sends nothing; `UnknownCacheCapability` structurally cannot carry a threshold |
| 3 | Official provider documentation recorded | **PASS** — §3, four sources, dated, plus a correction to the roadmap |
| 4 | Model/version-specific parameters gated correctly | **PASS** — `prompt_cache_options` gated on GPT-5.6+; unknown/custom send nothing; tested |
| 5 | Stable deterministic prefix preserved | **PASS** — inherits Phase 2 G7; verified by fingerprint |
| 6 | Cache identity / invalidation defined | **PARTIAL** — fingerprint + 4 emitted reasons + 5 reserved; no cache key sent (DEFERRED, R4) |
| 7 | Documented threshold separated from observed | **PASS** — separate types, separate result fields, no write-back |
| 8 | Two-request verification protocol implemented | **PASS** — evaluates legs; performs no requests |
| 9 | Cache read/write usage distinguished | **PASS** — `inputTokenDetails` read; write gaps recorded honestly per provider |
| 10 | No-cache / below-threshold represented honestly | **PASS** — `cache_not_observed` with `supportsConclusion: false` |
| 11 | Provider-specific logic isolated from orchestration | **PASS** — 0 matches in `chat.ts`/`assemble.ts`/`budget.ts`/`limits.ts`/`types.ts`, asserted by test |
| 12 | Phase 2 invariants preserved | **PASS** — see the `instructions:` incident below |
| 13 | Live verification separate from static | **PASS** — §11 vs §8; live run labelled UNVERIFIED for write/read |
| 14 | No unsupported cache parameter sent | **PASS** — live run sent none; 0 cache-related provider errors |
| 15 | No conservative/default limit used for cache sizing | **PASS** — `cacheExperimentEligibility` refuses; LIVE-VERIFIED `phase3ExperimentEligible=false` |

## An invariant this phase broke and then fixed

**Phase 3 initially broke a Phase 2 test, and the test was right.**

`ChatWindow.tool-output-once.test.ts` pins that `src/routes/chat.ts` contains
**zero** `instructions:` occurrences — `instructions` is the reserved `streamText`
Layer A key, and the route must never name the system-prompt seam. My first
`computePrefixIdentity({ instructions: … })` call reintroduced that key in the
route. It did not change any system prompt, but it reused a reserved name in the
one file the invariant protects, which is exactly the ambiguity the test exists to
prevent.

Fixed by renaming the field to `layerAText`, mirroring Phase 2's own
`InstructionsLayer.text`. The Phase 2 test was **not** weakened, and the reserved
name is now used nowhere in the route.

**Tests:** `2948 pass / 2 skip / 0 fail` — 2950 across 230 files
(baseline 2899/228; **+49 Phase 3 tests, +1 file**). Backend typecheck exit 0, web
typecheck exit 0, production build exit 0.

---

**No overall "complete" verdict is claimed.** Criterion 6 is PARTIAL, and criteria
8, 9 and 14 are IMPLEMENTED and test-verified but **not live-verified against any
real provider** — the largest open item is P3-R2.