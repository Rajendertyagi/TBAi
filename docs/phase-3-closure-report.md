# Phase 3 Closure Report — Cacheability Validation

**Date:** 2026-10-01 · **Scope:** TBAi only. **No Phase 4 or Phase 5 work.**

**Labels:** **IMPLEMENTED** · **VERIFIED** · **LIVE-VERIFIED** · **UNVERIFIED** ·
**UNKNOWN** · **DEFERRED** · **KNOWN LIMITATION**.

---

# 1. Final status

## Phase 3 is **CERTIFIED WITH RESIDUAL RISKS**

| Item | Disposition |
|---|---|
| **P3-R2** no live cache write/read | **UNAVAILABLE_TO_VERIFY** — isolated and classified; not an implementation failure |
| **P3-R3** Anthropic breakpoint vs variable tail | **RESOLVED BY MEASUREMENT** → recorded as a **KNOWN LIMITATION** with a precise boundary |
| Cache-key strategy | **DECIDED** — no key sent; structurally deferred with an explicit trigger |

**No known implementation defect remains.** Two real defects were found *during*
closure and fixed: a mode-blind verification protocol (which would have produced
false negatives) and an over-strict eligibility rule (which would have wrongly
forbidden valid sizing experiments).

**Tests 2964 pass / 2 skip / 0 fail** — 2966 across 231 files. Backend typecheck
exit 0, web typecheck exit 0, build exit 0. Phase 2 regressions 118 pass / 0 fail;
approval / lifecycle / resume / detached 172 pass / 0 fail.

---

# 2. P3-R2 live verification

## Classification: **UNAVAILABLE_TO_VERIFY**

**Why, precisely.** The environment has exactly **one** provider credential:

| Field | Value |
|---|---|
| Provider | `agnes`, type **`custom`** |
| Endpoint | `https://apihub.agnes-ai.com/v1` |
| Protocol | `chat-completions` |
| Model | `agnes-3.0-flash` (3 configured, **0/3** carry `contextWindow`) |
| API key | present (encrypted, usable) |

**No Anthropic, OpenAI, or Google credential exists.** Credentials were **not**
added or altered, and provider configuration was **not** modified.

For the configured endpoint the resolved capability is `unknown`, so **no cache
parameter may be sent** — which means **no cache write or read can be requested at
all**. That is the unknown-model policy working correctly, not a defect.

## What *was* run live

The full two-request probe against the real endpoint, synthetic non-sensitive
prompts, growing shape:

| Leg | HTTP | Latency | SSE frames | `cacheObservation` | write | read | uncached |
|---|---|---|---|---|---|---|---|
| A | 200 | 2 251 ms | 227 | `not_observed` | `null` | 0 | 4 318 |
| B | 200 | 2 660 ms | 307 | `not_observed` | `null` | 0 | 4 331 |

Both legs: `cacheControlSent=false`, `cacheControlOmissionReason=capability_unknown`,
`documentedMinimumPrefix=null`, `contextLimitSource=conservative_default`,
`phase3ExperimentEligible=false`, `prefixStable=true`. **No cache parameter reached
the provider** (0 occurrences of `cache_control` in the server log).

## Classification of the result: **NOT_OBSERVED**

The provider reported a cache-read field with value **0** and no write field. That is
`not_observed` — the provider looked and had nothing — which is a **normal
outcome**, not a failure and not a hit.

**No cache hit is claimed. No write is claimed.**

⚠️ **One observation deliberately NOT promoted to a capability.** The endpoint
returns a field the `openai-compatible` SDK reads as a cache count. That is
interesting but proves nothing: nothing documents this model, the value is zero, a
single zero is not evidence of support, and `openai-compatible` exposes no cache
*control*. Recorded as **UNKNOWN**.

---

# 3. P3-R3 Anthropic breakpoint

## Resolved by measuring the actual serialised request

Reading TBAi's Layer A/B/C types cannot answer this, because the provider caches a
**serialised** prefix whose shape is decided by the SDK adapter. So the real HTTP
body was captured with a fetch mock.

```json
{
  "model": "claude-opus-5-5",
  "max_tokens": 128000,
  "cache_control": { "type": "ephemeral" },
  "system": [ { "type": "text", "text": "STABLE SYSTEM PROMPT" } ],
  "messages": [ { "role": "user", "content": [ { "type": "text", "text": "FIRST" } ] } ],
  "tools": [ … ],
  "tool_choice": { … }
}
```

### Three verified facts

1. **`cache_control` is top-level only.** No per-block marker anywhere → automatic
   caching is selected, and **Layer C is untouched by the cache layer**.
2. **No message id is serialised.** Anthropic messages are `{role, content}` only.
   **This is the load-bearing finding**: `PrefixIdentity` digests retained message
   *ids*, so if ids reached the body, id churn would silently invalidate the cache.
   They do not.
3. **Turn N's `messages` are a byte-exact prefix of turn N+1's.** Verified by
   comparing captured bodies across a simulated two-turn conversation.

### Consequence — the precise boundary

| Shape | Reuse? | Why |
|---|---|---|
| **Append growth** (normal multi-turn) | ✅ **reuses** | The earlier request's whole message list survives unchanged, so the provider's documented 20-block lookback finds the prior write. This is the vendor's own multi-turn table, reproduced against TBAi's shape. |
| **Same-length replacement** (regenerate / edit-and-resend / retry) | ❌ no reuse | The final block changes at the same position; its hash differs from the earlier write there; the lookback finds nothing. **Costs a fresh cache write, not correctness.** |

**Disposition: KNOWN LIMITATION, not a defect.** Anthropic documents this exact trap
for automatic caching, and TBAi falls into it only on non-append paths.

**Explicit per-block breakpoints stay DEFERRED** — not because automatic caching is
broken, but because expressing them requires writing provider-specific fields into
the assembled Layers B and C. That is a Phase 2 contract change and stays out of
scope. No architectural change is proposed, per the stop condition.

### A real defect this analysis exposed — in Phase 3's own protocol

The two-request verification protocol was **mode-blind**. It accepted a pair whose
prefix was identical but whose final block differed — and under automatic caching
such a pair can **never** produce a read. Judging it would have manufactured a
**false negative**, i.e. "caching does not work here" when it works perfectly.

**Fixed.** `evaluateCacheExperiment` is now mode-aware: for Anthropic it requires
the later request to **contain** the earlier one plus appended content, and refuses
the same-length pair with `inconclusive_prefix_mismatch`. Pinned by two tests.

Separately, a **tool-set or instruction change now invalidates unconditionally**, in
every mode — Anthropic documents that modifying tool definitions "invalidates the
entire cache". An earlier iteration of this fix had wrongly let a tool change pass
through on the append-growth path; that was caught by a test and corrected.

### Live-status caveat

All of this is verified against the **serialised request** — a property of TBAi plus
the installed SDK. It is **not** a live provider observation. The provider's own
caching behaviour remains **UNVERIFIED**.

---

# 4. Cache-key decision

## DECIDED: no explicit cache key is sent. Structurally.

`buildCacheProviderOptions` has **no parameter** through which a key could arrive.
The absence is the decision — as with `UnknownCacheCapability`, which cannot carry a
fake threshold, a future caller cannot quietly opt out.

### Evidence, per provider (docs re-verified 2026-10-01)

| Provider / model | Key? | Vendor's stated purpose | Decision |
|---|---|---|---|
| Anthropic (all) | **No** | — | nothing to send |
| Google (all) | **No** | implicit caching is automatic | nothing to send |
| OpenAI **GPT-5.6+** | Yes | *"OpenAI handles cache routing automatically; the key is **not needed to optimize caching**."* For **separate cache accounting** per customer/user. | **No** — single-user local install; no per-customer accounting to separate |
| OpenAI **pre-5.6** | Yes | *"use a stable `prompt_cache_key` … to optimize cache routing"* — a real **hit-rate optimisation** | **DEFERRED** with a trigger |

### The distinction the rules require

- **CACHE PREFIX IDENTITY** — the semantic content a provider matches on. TBAi
  computes it locally as `PrefixIdentity.fingerprint` and **never sends it**.
  Provider-native reuse needs no key: it requires the serialised prefix to match.
- **EXPLICIT PROVIDER CACHE KEY** — a routing / accounting label. It does not create
  identity; it groups requests so a provider can route them together. Its value is
  entirely whatever the vendor says it optimises.

### Privacy / isolation

A key is a **grouping** decision, not a security boundary — OpenAI states "keys
influence routing; they do not pin requests to a machine or guarantee a cache hit".
It is nonetheless worth keeping account-scoped, because the vendor documents keys as
a defence against *"cache-hit probing across users"*. Any future key must therefore
be **server-derived and account-scoped**. TBAi has no user-account model, so there is
nothing correct to derive one from today.

**A generic conversation-ID key would be actively wrong**, not merely unnecessary:
the vendor groups keys by requests that **share a reusable prefix**, so keying per
conversation would *prevent* reuse across conversations that legitimately share a
prefix. No such key exists in TBAi, and none will be added.

### Tool / instruction / conversation / provider changes

All invalidate by **content matching**, not by key. Tool-definition and instruction
changes invalidate the entire cache (vendor-documented, and asserted by
`PrefixInvalidationReason`). Conversation growth is an append extension. A provider
or model change keys a different cache entirely. **No key participates in any of
this.**

### Trigger for revisiting

If an Openai model **before GPT-5.6** is actually configured and used: measure hit
rate with and without a stable key, then choose the key's inputs. Until then, send
nothing.

---

# 5. Capability verification

Registry entries re-verified against the four official sources on **2026-10-01**.
No change was required — the entries recorded during implementation match current
vendor documentation, including:

| Provider | Verified |
|---|---|
| Anthropic | Automatic caching documented (top-level `cache_control`); max 4 breakpoints; TTL 5m/1h; prefix order `tools`→`system`→`messages`; 20-block lookback; write `cache_creation_input_tokens`, read `cache_read_input_tokens`; non-monotonic per-model minimums (512 / 1 024 / 2 048 / 4 096) |
| OpenAI | GPT-5.6+: min 1 024, max 4 writes, `prompt_cache_options.ttl` only `30m`, `mode: implicit\|explicit`, write `cache_write_tokens`; pre-5.6: **minimum "varies by request settings"** → recorded as absent, never as a number |
| Google | Implicit by default on 2.5+; explicit needs an out-of-band cache resource → not claimed; min 4 096 / 2 048 |

**Exact-key matching, unknown-is-structural, and no provider branch in the generic
layer** were all re-confirmed by the 65 cache tests (§7).

---

# 6. Stable-prefix verification

| Property | Verdict |
|---|---|
| Turn N's messages are a byte-exact prefix of turn N+1's | **VERIFIED** (captured body) |
| No message id reaches the provider body | **VERIFIED** |
| Suffix change leaves the prefix untouched | **VERIFIED** |
| Tool-set / instruction change invalidates | **VERIFIED** |
| Reorder-only tool change invalidates | **VERIFIED** (order is part of the serialised prefix) |
| Fingerprint is content-free | **VERIFIED** |
| Append growth ≠ invalidation | **VERIFIED** |
| Dynamic ids outside the prefix | **VERIFIED** — `requestId`, `streamId`, generated message id all outside |
| Stable prefix survives Layer A absent | **VERIFIED** |

**Live:** `prefixStable=true` on both real requests, 15 native tools, 0 MCP.

---

# 7. Tests

**`bun run test` (canonical — plain `bun test` closes the shared `bun:sqlite`
singleton):**

| Suite | Result |
|---|---|
| **Full suite** | **2964 pass / 2 skip / 0 fail — 2966 across 231 files** |
| Before closure | 2948 pass / 2 skip / 0 fail — 2950 across 230 files |
| Delta | **+16 tests, +1 file** |
| `src/context/cache/` (2 files) | **65 pass / 0 fail** |
| Phase 2 regressions (5 files) | **118 pass / 0 fail** |
| approval / lifecycle / resume / detached (12 files) | **172 pass / 0 fail** |
| Backend typecheck · web typecheck · build | exit 0 · exit 0 · exit 0 |

### Added in closure

`src/context/cache/anthropic-request-shape.test.ts` (11 tests) — captures the real
Anthropic request body and asserts TBAi's adapter contract: top-level-only
`cache_control`; no serialised message id; documented `tools`/`system`/`messages`
placement; byte-exact append growth; suffix isolation; stable prefix with Layer A
absent; and the P3-R3 reusable/non-reusable shapes.

`cache.test.ts` (+5) — the corrected sizing rule; the mode-aware protocol including
the **false-negative pair that must be refused**; unconditional tool/instruction
invalidation; and the structural no-cache-key assertions.

**Tests assert TBAi's adapter contract, not vendor internals.** No documented
threshold or block-count rule is duplicated into a test; those live in
`capabilities.ts` with a source and a date.

---

# 8. Live verification

| Check | Result |
|---|---|
| Two-request probe, growing shape | **LIVE-VERIFIED** — leg A 200 / 2 251 ms / 227 frames; leg B 200 / 2 660 ms / 307 frames |
| Oversized request | **LIVE-VERIFIED** earlier — HTTP 400 in 62 ms, pre-flight |
| Cache parameter sent | **`false`**, reason `capability_unknown` |
| Provider-side cache error | **none** — 0 `cache_control` occurrences in the log |
| Documented minimum emitted | `null` — no fabricated number |
| Context limit / eligibility | `conservative_default` / `phase3ExperimentEligible=false` |
| Prefix identity | `prefixStable=true` both legs |
| **Cache write / read** | **NOT_OBSERVED** · **UNAVAILABLE_TO_VERIFY** for a documented capability |

No secrets, no full prompts, no configuration changes. Prompts were synthetic
lorem-ipsum.

---

# 9. Known limitations

| # | Limitation | Boundary |
|---|---|---|
| K1 | **Same-length replacement does not reuse the Anthropic cache.** Regenerate / edit-and-resend / retry change the final block at the same position; the automatic breakpoint lands there, its hash differs, the lookback finds nothing. | Costs a fresh cache **write**, not correctness. Absent on the normal append-growth path. |
| K2 | **Explicit per-block breakpoints are DEFERRED.** TBAi cannot place a marker without writing provider-specific fields into assembled Layers B and C. | A Phase 2 contract change. Not a defect. |
| K3 | **A cache key is never sent**, so pre-5.6 OpenAI hit rates may be below achievable. | Deferred with a measurement trigger (§4). |
| K4 | **No provider cache behaviour has ever been observed.** | Isolated: no Anthropic/OpenAI/Google credential exists. |
| K5 | **The `custom` endpoint returns a zero cache-read field.** If it does support caching, TBAi will not use it until documented. | UNKNOWN. Correct per the unknown-model policy. |
| K6 | **Phase 4 compaction will reset cache reuse.** Both vendors document this. | Handed to Phase 4. |

---

# 10. Residual risks

| # | Risk | Status |
|---|---|---|
| P3-R1 | Registry is a dated snapshot (2026-10-01); new models resolve to `unknown` and send nothing | Accepted; re-verify before relying on a new model |
| **P3-R2** | **No provider cache write/read observed** | **UNVERIFIED — isolated; the phase's largest gap** |
| P3-R3 | Anthropic breakpoint interaction | **RESOLVED → K1** |
| P3-R4 | No cache key | **DECIDED → K3** |
| P3-R5 | OpenAI pre-5.6 has no recorded minimum → no sizing claim possible | By design |
| P3-R6 | Five `PrefixInvalidationReason` values declared but never emitted (cross-request changes an in-request function cannot observe) | Accepted |
| P3-R7 | `custom` endpoint cache-read field | **UNKNOWN → K5** |
| P3-R8 | Anthropic auto-caching ↔ breakpoint-slot interaction | UNVERIFIED; reasoned safe (TBAi sends zero per-block markers, so no slot consumed) |
| P3-R9 | Compaction resets reuse | Handed to Phase 4 |

---

# 11. Exit-criteria matrix

| # | Criterion | Verdict |
|---|---|---|
| 1 | Registry keyed by exact provider + protocol + model | **PASS** |
| 2 | Unknown-model policy | **PASS** — sends nothing; threshold un*representable*; live-demonstrated |
| 3 | Official documentation recorded | **PASS** — 4 sources, dated 2026-10-01, re-verified in closure |
| 4 | Model/version-specific controls gated | **PASS** |
| 5 | Deterministic stable prefix | **PASS** — byte-exact append growth verified on the real body |
| 6 | Cache identity / invalidation defined | **PASS** — fingerprint + reasons; cache key **DECIDED** (§4) |
| 7 | Documented vs observed separated | **PASS** |
| 8 | Two-request protocol | **PASS** — now mode-aware; false-negative pair refused |
| 9 | Cache read/write distinguished | **PASS** (static) — per-provider reporting gaps recorded |
| 10 | Below-threshold / no-cache honest | **PASS** — `cache_not_observed`, `supportsConclusion: false` |
| 11 | Provider logic isolated | **PASS** — 0 matches in 5 generic files, asserted by test |
| 12 | Phase 2 invariants preserved | **PASS** — 0 Phase 2 files changed; 118 + 172 regression tests green |
| 13 | Live verification honest | **PASS** — classified NOT_OBSERVED / UNAVAILABLE_TO_VERIFY |
| 14 | Unsupported controls never sent | **PASS** — live: none sent, 0 provider errors |
| 15 | Fallback/unknown limit never sizes a cache experiment | **PASS** — **rule corrected** to be stricter and less arbitrary (§3 of the decision doc) |
| 16 | Anthropic breakpoint explicitly handled | **PASS** — resolved by measurement; K1 documented |
| 17 | Explicit cache-key decision recorded | **PASS** — DECIDED, structural, with a trigger |

---

# 12. Git state

**Phase 3 implementation:** 6 commits, `8ee7477` … `134b3f4`.
**Phase 3 closure:** 3 commits (below). **Nothing pushed.**

| Field | Value |
|---|---|
| Branch | `main` |
| Ahead / behind origin | see §12.1 below |
| Staged | 0 |
| Closure files | 5, all in `src/context/cache/` |
| Other workstreams' files | untouched, uncommitted |

### 12.1 Final repository state

*(Recorded at commit time; values below are the post-closure figures.)*

- **Current HEAD:** `42905e2` — `test(context): pin the Anthropic request shape caching depends on`
- **Commits ahead:** 18 · **behind:** 0 · **pushed:** NO
- **Staged files:** 0
- **Unstaged / untracked, mine (closure):** `docs/phase-3-closure-report.md` (this
  file), `docs/phase-3-provider-prompt-caching.md`,
  `docs/TBAi-context-subagent-roadmap.md`
- **Closure code files (committed):**
  `src/context/cache/{verification.ts,request.ts,index.ts,cache.test.ts,anthropic-request-shape.test.ts}`
- **Other workstreams' files:** 45 modified + 18 untracked, **untouched and
  uncommitted**, including `docs/decisions.md`,
  `docs/performance-optimization-masterlist.md`, `docs/project_tracker.html`,
  `docs/r1-model-reported-context-limit.md`,
  `docs/subagent-management-plan.md`

### 12.2 Exact Phase 3 commit set

| # | Commit | Scope |
|---|---|---|
| 1 | `8ee7477` | capability registry, types, public surface |
| 2 | `34fee76` | request controls, observation, prefix, verification |
| 3 | `bf83306` | route wiring + `cache_observed` diagnostics |
| 4 | `adb92eb` | 49 tests incl. the boundary scan |
| 5 | `77a9b93` | Phase 3 record, roadmap status, Anthropic correction |
| 6 | `134b3f4` | implementation report + exit-criteria matrix |
| 7 | `77c6794` | **closure** — corrected sizing rule, mode-aware protocol, cache-key decision |
| 8 | `42905e2` | **closure** — Anthropic request-shape contract tests (P3-R3 evidence) |
| 9 | `CLOSURE_DOCS` | **closure** — this report, corrected §5a/§6/§7, roadmap certification status |

---

# 13. Phase 4 handoff

**No Phase 4 or Phase 5 work was performed.** No summarisation, compaction trigger,
history rewriting, compaction marker, or memory injection.

**What Phase 4 can rely on:**

1. **`computePrefixIdentity` is stable and content-free.** A compactor can
   fingerprint pre- and post-compaction prefixes and show whether reuse survived.
2. **`evaluateCacheExperiment` reports `inconclusive_prefix_mismatch`** when a
   compaction changed the prefix — so the effect is *measurable, not assumed*.
3. **`CacheObservation` is distinct from capability**, so a measurement taken across
   a compaction boundary cannot be mistaken for a capability change.
4. **`anthropic-request-shape.test.ts` is the adapter contract to extend.** If Phase 4
   changes Layer C, that suite shows immediately whether prefix stability survived.
5. **Documented per-model minimums** let a compaction target be sized against a
   vendor floor rather than a guess.

**What Phase 4 must NOT assume:**

- That a cache hit survived a compaction. OpenAI: compaction "can prevent reuse from
  the first changed token onward". **Measure.**
- That `cache_not_observed` means caching broke — normal for a short prefix.
- That the context ceiling bounds anything cache-related. The **corrected** rule:
  size only from `documented_cache_minimum` or `measured_prefix`, never from a
  ceiling.

**Suggested Phase 4 prerequisite (not implemented):** a compaction policy that
preserves the prefix head. Both vendors document that summarisation and truncation
reset cache reuse. Phase 3 has made that *measurable* when the decision is taken.

---

**No push. No Phase 4. No Phase 5. No unrelated workstream changes.**

Phase 3 closure complete. Phase 4/5 were not started.