# Phase 3 Implementation Report — Provider Prompt Caching

**Date:** 2026-10-01 · **Scope:** TBAi only. **No Phase 4 or Phase 5 work.**

**Labels:** **IMPLEMENTED** · **VERIFIED** · **LIVE-VERIFIED** · **UNVERIFIED** ·
**UNKNOWN** · **DEFERRED**.

---

# 1. Executive status

**Phase 3 is IMPLEMENTED and test-verified. It is NOT live-verified against any
real provider, and no cache hit is claimed.**

| | |
|---|---|
| Capability registry | IMPLEMENTED, VERIFIED |
| Unknown-model policy | IMPLEMENTED, VERIFIED |
| Request-level controls (Anthropic, OpenAI) | IMPLEMENTED, VERIFIED |
| Provider-specific logic isolated from orchestration | IMPLEMENTED, VERIFIED (asserted by test) |
| Cache observation + diagnostics | IMPLEMENTED, LIVE-VERIFIED (unknown path) |
| Two-request verification protocol | IMPLEMENTED, VERIFIED |
| **Real cache write / read** | **UNVERIFIED — no Anthropic or OpenAI credential configured** |
| Explicit per-block breakpoints | **DEFERRED** — needs a Phase 2 contract change |
| Cache key | **DEFERRED** — product decision |

Tests **2948 pass / 2 skip / 0 fail** — 2950 across 230 files (baseline
2899/228; **+49 tests, +1 file**). Backend typecheck exit 0, web typecheck exit 0,
build exit 0.

Five local commits, **nothing pushed**. 46 files belonging to other workstreams
remain untouched and uncommitted.

---

# 2. Capability registry

`src/context/cache/{types,capabilities}.ts`

**Keyed by `providerType | protocol | modelId`** — exact match, no family
fallback. A test asserts the registry contains no `.startsWith("claude"…)`.

**Why mandatory:** Anthropic's documented minimums are **non-monotonic across
generations** — Opus 5.5 = 512, Opus 4.8 = 1,024, Opus 4.7 = 2,048, Opus 4.5 = 4,096.
A family rule is wrong by construction, not merely imprecise. All four are pinned.

Registered: 13 Anthropic models, 16 OpenAI models × 2 protocols, 7 Google models.
Everything else resolves to `unknown`.

**Two deliberate absences.** OpenAI pre-5.6 records **no** minimum, because the
guide says it varies by request settings — a stand-in would be indistinguishable
from a vendor commitment. Anthropic models retired outside the Claude API
(`claude-haiku-3-5`, `claude-sonnet-4`, `claude-opus-4-1`, `claude-opus-4`) are
excluded: their documented minimums apply to Bedrock/Google Cloud, and automatic
caching returns a 400 on legacy Bedrock regardless.

**Unknown is structural.** `UnknownCacheCapability` has no threshold, TTL or
cache-key member, so a consumer wanting one is forced by the compiler to handle
the case. No fake number is representable — not by discipline.

**The `namespace` field is part of the identity**, recorded with the capability
rather than passed in. See §4.

---

# 3. Provider documentation

Four official sources, read **2026-10-01**. Full table in
`docs/phase-3-provider-prompt-caching.md` §3.

⚠️ **The roadmap's §3.2 was outdated and is corrected.** It stated *"Caching is
**explicit** on Anthropic: `cache_control` markers are required. Without a marker
nothing is cached."* Anthropic now documents **automatic caching** — a single
**top-level** `cache_control`, breakpoint moved to the last cacheable block, 400
only on legacy Bedrock (Opus 4.6 and earlier).

**This correction was load-bearing.** Automatic caching is precisely the
request-level control Phase 3 needs. Had I trusted the 2026-09-30 table, I would
have concluded Anthropic caching was inexpressible without per-block markers and
shipped nothing for the one provider I could most plausibly have verified.

**Other documented facts:** Anthropic max 4 breakpoints, TTL 5m/1h, prefix order
`tools`→`system`→`messages`, 20-block lookback. OpenAI GPT-5.6+: min 1,024, max 4
writes, `prompt_cache_options.ttl` only `30m`, write field
`input_tokens_details.cache_write_tokens`. Google implicit by default on 2.5+;
explicit needs an out-of-band cache resource TBAi does not have — **not claimed**.

---

# 4. Implementation

## The architectural decision that shaped the phase

**Request-level cache controls only. Per-block markers DEFERRED.**

Both remaining providers' *explicit* controls are per content block: the AI SDK
reads Anthropic's `cache_control` from each **message part's** providerOptions
(`convert-to-anthropic-prompt.ts:174,286,498`), and OpenAI's
`prompt_cache_breakpoint` is an **input content-block field**. Expressing either
would mean writing provider-specific fields into the Layers B and C that
`assembleContext` produced — breaching three rules at once: the capability
boundary, the no-bypass rule, and the ban on provider branches in the
orchestration layer.

Both vendors document a request-level mode needing no per-block markers and
recommend it for an append-only conversation. Those are what Phase 3 enables, and
the registry records `supportsExplicitControls: false` rather than claiming a
capability TBAi cannot express.

## Files

| File | Change |
|---|---|
| `src/context/cache/types.ts` | `CacheCapability` discriminated union; `CacheObservation`; prefix identity types |
| `src/context/cache/capabilities.ts` | The dated registry + `resolveCacheCapability` |
| `src/context/cache/request.ts` | `buildCacheProviderOptions` — the only provider syntax in the codebase |
| `src/context/cache/observe.ts` | `observeSdkCacheUsage` / `observeCacheUsage` — three-way classification |
| `src/context/cache/prefix.ts` | Content-free fingerprint + invalidation reasons |
| `src/context/cache/verification.ts` | Two-request evaluation + sizing eligibility |
| `src/context/cache/index.ts` | Public surface |
| `src/context/cache/cache.test.ts` | 49 tests |
| `src/routes/chat.ts` | Capability resolution, merged `providerOptions`, `cache_observed` log |

## Two real bugs the tests caught

**1. Anthropic options under the wrong namespace.** My first design took the
namespace as a caller argument, computed from `providerOptionsNamespace(modelConfig)`
— which returns `openai` or `openaiCompatible` and **never** `anthropic`. Anthropic's
`cacheControl` would have been emitted under the `openai` key, where the Anthropic
provider **silently ignores it**. The failure would have been indistinguishable
from "caching did not happen", and it would only have surfaced against a real
credential.

Fixed by recording the namespace **with the capability**, so the caller cannot get
it wrong.

**2. Phase 3 broke a Phase 2 invariant — and the Phase 2 test was right.**
`ChatWindow.tool-output-once.test.ts` pins that `chat.ts` contains **zero**
`instructions:` occurrences, because `instructions` is the reserved `streamText`
Layer A key and the route must never name the system-prompt seam. My first
`computePrefixIdentity({ instructions: … })` reintroduced it.

It changed no system prompt, but it reused a reserved name in the one file the
invariant protects — precisely the ambiguity that test exists to catch. Fixed by
renaming the field to `layerAText` (mirroring Phase 2's `InstructionsLayer.text`).
**The Phase 2 test was not weakened.** This was caught in the full suite, not by
my targeted runs — worth noting that targeted runs would have missed it.

## A third issue the tests caught

`streamText` accepts **one** `providerOptions`. My first wiring spread cache
options and then the existing reasoning options spread later, silently clobbering
them. Fixed by merging into a single object, with a test pinning that exactly one
`providerOptions` seam exists.

---

# 5. Stable-prefix verification

**Determinism is inherited from Phase 2, not re-implemented.** Layer B ordering is
byte-identical across repeated builds (Phase 2 guarantee G7), Layer A is
server-owned, Layer C ordering is persisted. Phase 3 adds *verification*.

`computePrefixIdentity` fingerprints the ordered prefix with `sha256` (full 64
chars) and reports invalidation reasons.

**Dynamic fields — identified, not removed.** `requestId` is transport-level and
never serialised into the model request; `streamId` is run bookkeeping; the
generated message id belongs to the **response**. None is in the prefix, which is
why the fingerprint is stable across otherwise-different requests. MCP tool
membership is the genuine churn source and is tracked as
`mcp_tool_set_changed`.

**Current turn excluded — deliberately.** Including it would make every request's
fingerprint unique, which is the exact trap Anthropic documents ("you pay for a
fresh cache write on every request and never get a read"). Appended history is an
**extension**, not an invalidation.

**Content-free.** Component digests let a mismatch be *attributed* (tool set vs
instructions) without revealing anything. A test asserts a secret in the system
prompt appears nowhere in the identity or its log projection.

LIVE-VERIFIED: `prefixStable=true`, fingerprint present, 15 native tools, 0 MCP.

---

# 6. Cache-control behavior

| Capability | Sent | Omission reason |
|---|---|---|
| Anthropic `both` | `{anthropic:{cacheControl:{type:"ephemeral"}}}` | — |
| OpenAI Responses `both`/`implicit` | `{openai:{promptCacheOptions:{mode:"implicit"}}}` | — |
| OpenAI chat-completions | same, namespace `openaiCompatible` | — |
| Google `implicit` | **nothing** | `implicit_caching_needs_no_parameter` |
| `custom` / `ollama` | **nothing** | `capability_unknown` |

**A TTL is forwarded only when the capability documents that exact value** — never
defaulted, because substituting a default would send a TTL the vendor never stated.

**No cache key is sent.** Only OpenAI supports one, and on GPT-5.6+ the vendor says
it is not needed to optimise caching (it is for per-customer accounting); on
earlier models it is a routing optimisation whose partitioning is a product
decision. **DEFERRED.**

**`@ai-sdk/openai-compatible` exposes no cache control at all** — only a passive
read of `cached_tokens`. That is the concrete reason a `custom` provider resolves
to `unknown` even when it speaks a dialect OpenAI understands.

---

# 7. Verification protocol

```text
REQUEST 1  →  stable prefix P + suffix A   →  expect cache WRITE
REQUEST 2  →  the SAME prefix P + suffix B →  expect cache READ
```

Both conditions are **checked**: an identical suffix or a changed prefix is
recorded as a reason and the run is refused.

| Verdict | Supports a conclusion? |
|---|---|
| `write_then_read_observed` | ✅ |
| `write_observed_read_not_observed` | ✅ |
| `cache_not_observed` | ❌ **by design** |
| `inconclusive_unobservable` | ❌ |
| `inconclusive_prefix_mismatch` | ❌ |
| `ineligible_unknown_capability` | ❌ |

`cache_not_observed` carries `supportsConclusion: false` because it is the result
that must never be read as "caching does not work here". Latency and request
success are never consulted.

**Sizing eligibility** requires a documented, observable capability **with a
recorded minimum** *and* `contextLimitSource === "provider_reported"` — R1's rule
enforced at the point the decision would be taken.

---

# 8. Tests

**`bun run test` (canonical — plain `bun test` closes the shared `bun:sqlite`
singleton):**

| Suite | Result |
|---|---|
| Full suite | **2948 pass / 2 skip / 0 fail — 2950 tests across 230 files** |
| Baseline before Phase 3 | 2899 pass / 2 skip / 0 fail — 228 files |
| Delta | **+49 tests, +1 file** — all additive |
| `src/context/cache/cache.test.ts` | 49 pass / 0 fail |
| Phase 2 context suites | 115 pass / 0 fail (unchanged) |
| Backend typecheck | exit 0 |
| Web typecheck | exit 0 |
| Production build | exit 0 |

The 49 cover: exact-key registry lookup; model-specific minimums kept distinct; a
custom endpoint never inheriting OpenAI's capability; protocol in the key; controls
emitted only where verified; one provider's syntax never reaching another; correct
namespace; TTL forwarded only when documented; observations never upgrading a
capability; write-then-read; the below-threshold silent success as
`cache_not_observed`; prefix mismatch refused; documented-but-unobservable
inconclusive; Rule 10 refusals; the boundary scan; the `instructions:` regression.

Tests assert **externally meaningful behaviour** — which stance comes out, whether
an experiment is authorised, whether the invariant holds — not that a branch was
taken.

---

# 9. Live verification

Server on `:3012`, real database, **provider configuration unmodified**.

| Check | Result |
|---|---|
| Normal request | **LIVE-VERIFIED** — HTTP 200, 945 ms, 63 SSE frames |
| Oversized 4 MB | **LIVE-VERIFIED** — HTTP 400 in 62 ms, pre-flight, no provider call |
| Cache control sent | **`false`**, reason `capability_unknown` |
| Documented minimum | `null` — no fabricated number |
| Capability status / mode | `unknown` / `unknown` |
| Prefix identity | fingerprint, `prefixStable=true`, 15 tools, 0 MCP |
| Context limit source | `conservative_default` → **`phase3ExperimentEligible=false`** |
| Provider-side cache error | none — nothing was sent |

The live run demonstrates the **unknown-model policy and the diagnostics**, which
is all it honestly can: the configured provider is a `custom` OpenAI-compatible
endpoint, so it correctly resolves to `unknown` and receives no parameter.

---

# 10. Unverified cases

| Item | Status | Why |
|---|---|---|
| **A real cache write** | **UNVERIFIED** | Needs an Anthropic or OpenAI credential; only a `custom` endpoint is configured |
| **A real cache read** | **UNVERIFIED** | Same |
| Latency / cost improvement | **UNVERIFIED** | Requires the above |
| Ollama behaviour | **UNVERIFIED** | Not configured |
| Gemini behaviour | **UNVERIFIED** | Not configured |
| Anthropic auto-caching ↔ 4-breakpoint interaction | **UNVERIFIED** | TBAi sends zero per-block markers so no slot is consumed — reasoned, not measured |

**No cache hit is claimed.** No Anthropic or OpenAI request was made.

**One incidental live observation, recorded but NOT promoted.** The
`cache_observed` line reported `cacheReadSize=0`, meaning the custom endpoint
returned a field the openai-compatible SDK reads as a cache count, with a zero
value — so the outcome is `not_observed` (the provider looked and had nothing),
not `unobservable`. This does **not** upgrade the capability: nothing documents the
model, the value was zero, and a single zero is not evidence of support. Recorded
as **UNKNOWN**.

**No provider configuration was changed** to manufacture eligibility. The task's
instruction was followed, and because both gates (`capability: unknown` and
`contextLimitSource: conservative_default`) correctly refuse, **no
`provider_reported` sizing claim was produced**.

---

# 11. Residual risks

| # | Risk | Status |
|---|---|---|
| P3-R1 | The registry is a **dated snapshot** (2026-10-01). New models resolve to `unknown` and send nothing — safe, not useful. | Accepted; re-verify before relying on a new model |
| P3-R2 | **No provider cache write or read has ever been observed.** The two-request protocol is exercised only by tests. | **UNVERIFIED — the phase's largest gap** |
| P3-R3 | **Explicit per-block breakpoints are DEFERRED.** Anthropic automatic caching places the breakpoint at the *last cacheable block*, which its own guide calls wrong when a varying block is last — and TBAi's current-turn tail is exactly that. Anthropic caching may underperform until marker placement exists. | **DEFERRED** — needs a Phase 2 contract change |
| P3-R4 | **No cache key.** On pre-5.6 OpenAI it is a documented routing optimisation; hit rates may be lower than achievable. | **DEFERRED** — product decision |
| P3-R5 | OpenAI pre-5.6 has no recorded minimum, so a sizing claim is impossible for those models. | By design |
| P3-R6 | Five `PrefixInvalidationReason` values are declared but never emitted — they describe cross-request changes an in-request function cannot observe. | Accepted |
| P3-R7 | The `custom` endpoint returned a zero cache-read field. If it does support caching, TBAi will not use it until documented. | **UNKNOWN** |
| P3-R8 | Anthropic auto-caching ↔ breakpoint-slot interaction unverified live. | **UNVERIFIED** |
| P3-R9 | Phase 4 compaction will rewrite Layer C and can reset cache reuse. Phase 3 does not address it. | Handed to Phase 4 |

---

# 12. Exit-criteria matrix

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Registry keyed by full provider + model | **PASS** | `provider\|protocol\|modelId`; no family match; 4 minimums pinned |
| 2 | Explicit unknown-model policy | **PASS** | Sends nothing; threshold un*representable*; omission reason enumerated |
| 3 | Official documentation recorded | **PASS** | 4 sources, dated; roadmap error corrected |
| 4 | Model/version-specific gating | **PASS** | `prompt_cache_options` gated on GPT-5.6+; custom/ollama send nothing |
| 5 | Stable deterministic prefix preserved | **PASS** | Inherits G7; fingerprint LIVE-VERIFIED |
| 6 | Cache identity / invalidation defined | **PARTIAL** | Fingerprint + 4 emitted + 5 reserved reasons; **no cache key sent** (R4) |
| 7 | Documented vs observed separated | **PASS** | Separate types; separate result fields; no write-back (asserted) |
| 8 | Two-request protocol implemented | **PASS** | Both conditions checked; 6 verdicts; never infers from latency |
| 9 | Read/write usage distinguished | **PASS** | `inputTokenDetails` read; per-provider gaps recorded honestly |
| 10 | No-cache case honest | **PASS** | `cache_not_observed`, `supportsConclusion: false` |
| 11 | Provider logic isolated | **PASS** | 0 matches in 5 generic files, asserted by test |
| 12 | Phase 2 invariants preserved | **PASS** | `prune-messages.ts` unchanged; one invariant broke, was fixed, test not weakened |
| 13 | Live separate from static | **PASS** | §9 vs §7; write/read labelled UNVERIFIED |
| 14 | No unsupported parameter sent | **PASS** | Live: none sent, 0 cache errors |
| 15 | No default limit used for sizing | **PASS** | Eligibility refuses; LIVE-VERIFIED `phase3ExperimentEligible=false` |

**No overall "complete" verdict is claimed.** Criterion 6 is PARTIAL; criteria 8, 9
and 14 are IMPLEMENTED and test-verified but **not live-verified against any real
provider**. The largest open item is **P3-R2**.

---

# 13. Git state

Five commits, **nothing pushed**. Branch `main`, 15 ahead / 0 behind.

| # | Commit | Scope |
|---|---|---|
| 1 | `8ee7477` | capability registry, types, public surface |
| 2 | `34fee76` | request controls, observation, prefix, verification |
| 3 | `bf83306` | route wiring + `cache_observed` diagnostics |
| 4 | `adb92eb` | 49 tests incl. the boundary scan |
| 5 | `77a9b93` | Phase 3 doc, roadmap status, Anthropic correction |

**11 files, +2968/−8.** Scope was verified with `git status` and diff review before
each commit. **46 files belonging to other workstreams remain untouched and
uncommitted**, and no temp artifacts were left behind.

---

# 14. Phase 4 handoff

**No Phase 4 or Phase 5 work was performed.** No summarisation, compaction
trigger, history rewriting, compaction marker, or memory injection.

What Phase 4 **can rely on**:

1. **`computePrefixIdentity` is available and stable.** A compactor can fingerprint
   a pre- and post-compaction prefix and show whether reuse survived.
2. **`evaluateCacheExperiment` reports `inconclusive_prefix_mismatch`** when a
   compaction changed the prefix — so the effect is measurable, not assumed.
3. **`CacheObservation` is already distinct from capability**, so a measurement
   taken across a compaction boundary cannot be mistaken for a capability change.
4. **Documented minimums are per exact model**, so a compaction target can be sized
   against a vendor floor.

What Phase 4 must **not assume**:

- That a cache hit survived a compaction. OpenAI's guide states compaction "can
  prevent reuse from the first changed token onward". **Measure.**
- That `cache_not_observed` means caching broke — it is the normal short-prefix
  outcome.
- That the context ceiling bounds anything cache-related. R1's rule stands: a
  `conservative_default` limit may bound safety, never a cache conclusion.

**Suggested Phase 4 prerequisite** (not implemented): a compaction policy that
preserves the prefix head. Both vendors document that summarisation and truncation
reset cache reuse, so this decision belongs to Phase 4 — but Phase 3 has made it
*measurable* when it is taken.

---

**No push. No Phase 4. No Phase 5. No unrelated workstream changes.**

Phase 3 execution complete. Phase 4/5 were not started.