# R1 Investigation — Model-Reported Context Limit

**Date:** 2026-10-01 · **Read-only.** No production code, test, schema, dependency,
or roadmap was modified. No commit, no push.

---

# 1. Finding

**R1 is two independent defects, not one, and the second is architectural.**

| Branch | Reachable? | Cause |
|---|---|---|
| `model_reported` | **No** | `assemble.ts:220` never passes `model`. A **wiring gap** (category **A**) |
| `configured` | **No — and unreachable by construction** | No caller passes `configuredContextWindow`, **and no such field exists**: a user-typed limit is stored on `ModelOption.contextWindow`, which is the *same* field `model_reported` reads. The two branches cannot be distinguished by the current data model |

**Consequence:** every production Direct request resolves to
`source: "default"`, i.e. `UNKNOWN_LIMIT_CEILING = 128_000`.

**The material correction to the certification:** R1 does **not** make the budget
permissive-safe in the way I assumed. For the model this install actually uses, the
provider documents **512K** (see §8) — **four times larger** than the 128k TBAi
assumes. **Wiring the real limit would make the budget LOOSER, not stricter.**
TBAi is currently **rejecting requests this model could serve**.

---

# 2. Current production flow

```text
POST /api/chat                                            chat.ts:148
  → resolveChatModel({providerId, model, ...})            chat.ts:205
      → registry.get(providerId)                          providers.ts:65  (SYNC, in-memory Map)
      → returns { provider: ProviderConfig, model, reasoning }
         ProviderConfig.models: ModelOption[]             types/index.ts:59
  → modelConfig = {...provider, apiKey?, model}            chat.ts:228-237
      (.models SURVIVES the spread)
  → assembleContext({ provider: modelConfig, modelId })   chat.ts:333-334
      → resolveContextLimit({ providerType, modelId })    assemble.ts:220-223
          ⚠️ model metadata IS in scope as provider.models — it is simply not read
  → computeBudget({ limit })                              assemble.ts:224
  → decideBudget(...)                                     assemble.ts:225
  → streamText({ maxOutputTokens: reserve })              chat.ts:587
```

### The exact production caller

```ts
// src/context/assemble.ts:220-223  — the only production call
const limit: ContextLimit = resolveContextLimit({
  providerType: provider.type,
  modelId,
});
```

Two arguments supplied. `model` and `configuredContextWindow` are **not supplied**.
`provider.models` is in scope on the enclosing object and is never read.

### Where `model_reported` can originate

Exactly one place assigns a real window during discovery:

```ts
// src/services/modelDiscovery.ts:131 — inside normalizeAnthropic ONLY
contextWindow: typeof m?.max_input_tokens === "number" ? m.max_input_tokens : undefined,
```

`normalizeOpenAI` (`:111-119`), `normalizeGoogle` (`:140`) and `normalizeOllama`
(`:151`) set **no** `contextWindow`. `normalizeOpenAI` says so explicitly:
*"OpenAI listing endpoints expose identity only — no truthful per-model capability
source exists here."*

---

# 3. Provider/model metadata inventory

### Sources of a real `contextWindow` in TBAi

| Source | Mechanism | Providers | Automatic? |
|---|---|---|---|
| **Provider discovery** | `modelDiscovery.ts:131` reads `max_input_tokens` | **Anthropic only** | Yes, on provider create/update |
| **User configuration** | `ProviderDialog.tsx:309-330` (`commitWindow`) → `modelOptionSchema.contextWindow` (`validation.ts:23`) → persisted to `provider_configs.models` | **Any** | No — manual, per model |
| Absent | field simply undefined | Any | — |

### Live registry state (read-only query of `data/chat.db`)

```
provider_configs rows: 1
  id=sb9c50gb5a10qd2nrduf5113  name=agnes  type=custom  model=agnes-3.0-flash
    models: 3 entries
      id=agnes-3.0-flash  contextWindow=(undefined)
      id=agnes-2.0-flash  contextWindow=(undefined)
      id=agnes-2.5-flash  contextWindow=(undefined)
    entries WITH a numeric contextWindow: 0/3
```

### Inventory table

| Provider | Model identifier | Context-limit source | Value | Available before assembly? | Verified |
|---|---|---|---|---|---|
| `custom` (`agnes`) | `agnes-3.0-flash` | none — undefined | — | Yes (field present, value absent) | ✅ live DB query |
| `custom` (`agnes`) | `agnes-2.5-flash` | none — undefined | — | Yes | ✅ live DB query |
| `custom` (`agnes`) | `agnes-2.0-flash` | none — undefined | — | Yes | ✅ live DB query |
| `anthropic` (any configured) | any discovered | provider discovery (`max_input_tokens`) | per-model, provider-reported | **Yes** — persisted at config time | ✅ `modelDiscovery.ts:131` |
| `openai` / `google` / `ollama` / `custom` | any | **none automatic** | — | Yes (if user-set) | ✅ normalizers omit it |
| any | any | **user-configured** | user-typed | Yes (if set) | ✅ `ProviderDialog.tsx:309` |

---

# 4. Why `model_reported` is unreachable

**Category A — an accidental wiring gap — for `model_reported`.**
**Category B, plus a data-model limitation — for `configured`.**

The dependency flow is *not* blocked anywhere. Every piece exists and is reachable:

1. `discoverModels` fetches real limits (network, **config time only**) → `providers.ts:161,191`
2. Results persist to `provider_configs.models` (SQLite JSON)
3. `ProviderRegistry.loadFromDb` parses them into `ProviderConfig.models` (`providers.ts:36-48`), at boot
4. `resolveChatModel` returns that `ProviderConfig` (`chat-model.ts:29,51`)
5. `modelConfig` spreads it, so `.models` survives (`chat.ts:234,237`)
6. `assembleContext` receives it as `provider` (`chat.ts:333`)
7. **← the chain stops here.** `resolveContextLimit` is called without it.

There is **no architectural boundary** keeping discovery away from assembly: the
metadata is already in the seam's own input object. Nothing prevents passing it.
This is an unfinished wire, not a designed separation.

**For `configured`, the cause is deeper.** Even if a caller passed
`configuredContextWindow`, no such value could be produced: a user's typed limit
and a provider's reported limit are stored in the **same field**
(`ModelOption.contextWindow`). The `configured` branch is therefore unreachable
*by construction*, not merely unwired. Distinguishing them requires either a
separate field or a provenance marker on the stored value — a **data-model**
change, not a wiring change.

⚠️ This also means that if the wiring were fixed as-is, a **user-typed** limit
would be reported as `model_reported` — mislabelled provenance. The `source` field
would become actively misleading.

---

# 5. 128k fallback analysis

| Question | Answer |
|---|---|
| Where does it come from | `src/context/limits.ts:32` `export const UNKNOWN_LIMIT_CEILING = 128_000` |
| Hardcoded | **Yes** — one exported constant |
| Configurable | **No.** Referenced only in `limits.ts`, `index.ts`, and tests. No env var, no setting, no config field |
| Used for unknown models only | **Yes** — it is the terminal `return` of `resolveContextLimit` (`limits.ts:72`) |
| Every production request reaches it | **Yes** — both other branches are unreachable (§4) |
| Is it the same constant as the UI's display default | **No** — `web/src/config/modelContext.ts` has its own `DEFAULT_MODEL_CONTEXT_WINDOW`, deliberately not imported. Two independent 128k values |
| Tests asserting it | Yes — `budget.test.ts:153` (`maxInputTokens === UNKNOWN_LIMIT_CEILING`), `:154` (`default_conservative`), `:159` (`> 0`); `assemble.test.ts:191` (`limitSource` contains `default_conservative`) |

**Fallback value unchanged by this investigation.**

---

# 6. Behaviour change from wiring real limits

Modeled, not implemented.

### For this install (`agnes`, no `contextWindow` set)

| | Today | If wired, no user value set | If wired **and** the user sets 512K |
|---|---|---|---|
| Limit source | `default` | `default` — **unchanged** | `model_reported` |
| `maxInputTokens` | 128,000 | **128,000 — unchanged** | 524,288 |
| Output reserve | 4,096 | 4,096 | 4,096 |
| Safety margin (25%) | 30,976 | 30,976 | 130,048 |
| Usable input | **92,928** | **92,928 — unchanged** | 390,144 |

**Wiring alone changes nothing on this install**, because 0 of 3 models carry a
value. Behaviour only moves if a value is *also* supplied — by discovery
(Anthropic) or by the user (any provider).

### Direction of change

- **Larger real window → budget LOOSES.** Requests currently rejected between ~93k
  and ~390k estimated tokens would be accepted. For `agnes` (512K) this is the
  realistic case.
- **Smaller real window → budget TIGHTENS.** A user who sets 32k, or a provider
  reporting a small limit, would start seeing rejections that do not occur today.
- **No `data-*`, reasoning, or assembly-structure change.** The budget, margin, and
  decision logic are untouched; only the ceiling input differs.
- **Stable prefix / assembly structure: unchanged.** Determinism lives in Layer B
  ordering and is independent of the limit.
- **Provider-specific behaviour leaking into orchestration?** Not by itself — but
  ⚠️ the *discovery* asymmetry (Anthropic reports, others do not) means the same
  orchestration code would behave differently per provider purely because of what
  discovery happens to supply. That is a coupling worth naming, not a blocker.

### Classification

| | |
|---|---|
| **Behaviour change** | Yes — accept/reject threshold moves when a real limit exists |
| **Safety improvement** | Direction depends on the value: a correct large limit stops **false rejections**; a wrong small limit **introduces** false rejections |
| **Architectural change** | **No** for the wiring. **Yes** if the `configured`/`model_reported` provenance split is to be honoured |

---

# 7. Model-discovery timing

| Question | Answer |
|---|---|
| Is discovery network-backed | **Yes** — `fetchJson` against `api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, or a custom endpoint (`modelDiscovery.ts:10-12,21`) |
| When does it run | **Config time only** — `providers.ts:161,191` (provider create/update). **Never per request** |
| Where does the result live | `provider_configs.models`, SQLite JSON |
| Is it available before `assembleContext` | **Yes** |
| Is it available before model execution | **Yes** |
| Would supplying it require a network call | **No** |
| Would it require an async lookup | **No** |
| Would it require a new cache | **No** — the registry already **is** the cache |
| Would it slow every request | **No** — `registry.get()` is a synchronous `Map.get()` (`providers.ts:65`), populated at boot |
| Is it already available locally | **Yes** |

**Conclusion: wiring costs one array lookup, no I/O, no new state.** The metadata
is already in the seam's input object.

---

# 8. Current-model verification

Sources kept separate, as required.

| Model | Provider-documented | TBAi-configured | TBAi-discovered | Runtime |
|---|---|---|---|---|
| `agnes-3.0-flash` | **512K** — Agnes AI docs, "Limits and pricing" (`wiki.agnes-ai.com/en/docs/agnes-30-flash`) | none | none (custom provider; no auto-discovery) | **128,000** enforced by TBAi |
| `agnes-2.5-flash` | **512K** — Agnes AI docs (`wiki.agnes-ai.com/en/docs/agnes-25-flash`) | none | none | 128,000 |
| `agnes-2.0-flash` | not found | none | none | 128,000 |

⚠️ **Conflicting secondary sources.** Agnes AI's own wiki states **512K** for both
3.0 and 2.5 Flash. Two third-party sources state the **production/API** checkpoint
of Agnes 3.0 Flash has a **1-million-token** window (distinguishing it from a
262,144-token *open-weight preview* checkpoint on Hugging Face). **This
investigation does not resolve which figure applies to the endpoint this install
points at** — the configured endpoint was not inspected beyond its `type: custom`
classification, and a third-party blog is not authoritative over vendor docs.

**Either way both candidate figures (512K, 1M) are far larger than TBAi's 128k.**

**Implication:** TBAi is **currently rejecting requests this model can serve.** That
is the opposite of the risk I recorded in the certification ("supplying a real
`contextWindow` tightens enforcement"). The correction is material and R1's
sign is **opposite** to the one I previously recorded.

---

# 9. Phase 3 impact

| Question | Answer |
|---|---|
| Can Phase 3 be implemented with R1 open | **Yes** |
| Can Phase 3 safely use the 128k fallback | **Yes for cache mechanics**, **with a stated caveat**: all cache-prefix sizing and minimum-prefix comparisons would be computed against a ceiling that is not the model's |
| Would cache capability selection depend on the same metadata | **Yes** — Phase 3's per-model cache minimums (§3.2 of the roadmap) are keyed on **full provider + model id**, and R1's limit is keyed the same way. Both are per-model facts, but they are **different facts** (input window vs cache threshold) and neither supplies the other |
| Could a wrong context limit invalidate cache/prefix experiments | **Yes, in one specific way**: if the ceiling is used to decide how large a prefix may grow before being split, a too-small ceiling (128k vs 512k) would split a prefix that should stay whole, **measurably depressing cache hit rate**. This would produce a wrong conclusion about whether caching helps |
| Which parts of Phase 3 are blocked | **None strictly blocked.** §3.2 capability table, measurement, deterministic ordering, and the two-request verification protocol are all independent of the input ceiling. The **at-risk** work is any sizing or segmentation decision that assumes the ceiling is real |

**R1 does not block Phase 3. It degrades the validity of one class of Phase 3
experiment** — specifically, a prefix-size or segmentation measurement.

---

# 10. Decision options

Presented without ranking.

### Option 1 — Wire existing model metadata into `resolveContextLimit`

- **Files:** `src/context/assemble.ts` (lookup `provider.models` by `modelId`, pass `model`)
- **Architectural impact:** None. No new module, no new state
- **Runtime impact:** One synchronous array lookup; no I/O
- **Behaviour-change risk:** **None on this install** (0/3 models carry a value). On Anthropic installs, the ceiling becomes real — usually larger. On a user who set a small window, tighter
- **Reversibility:** Trivial — remove one argument
- **Testing:** Needs a test that `provider.models` with a `contextWindow` yields `model_reported`, and an end-to-end assemble test
- ⚠️ **Incomplete alone:** a user-typed value would still be labelled `model_reported`, so `source` becomes misleading

### Option 2 — Add a dedicated context-capability lookup layer

- **Files:** new `src/context/capability.ts`; `assemble.ts` calls it; `limits.ts` narrows to consume it
- **Architectural impact:** Separates *where limits come from* from *how they are resolved*, mirroring the Phase 2 split between capability lookup and policy
- **Runtime impact:** Same single lookup; module indirection
- **Behaviour-change risk:** Same as Option 1, plus whatever provenance change accompanies it
- **Reversibility:** Easy — module is additive
- **Testing:** Lookup-layer unit tests (provider precedence, per-model vs per-family keying) plus the existing budget tests unchanged
- ⚠️ **Could also carry the provider-precedence table Phase 3 needs**, if capability facts are centralised

### Option 3 — Keep the 128k fallback until capability data is normalised

- **Files:** none
- **Architectural impact:** None; R1 stays open and documented
- **Runtime impact:** None
- **Behaviour-change risk:** **Zero** — current false-rejection behaviour persists
- **Reversibility:** N/A
- **Testing:** None new
- ⚠️ Leaves a known false-rejection path in place indefinitely, and leaves one class of Phase 3 experiment invalid (§9)

### Option 4 — Wire it **and** make provenance truthful

- **Files:** `assemble.ts` + a provenance marker on stored model metadata (e.g. `contextWindowSource` on `ModelOption`, or a separate user-set field) + `limits.ts` mapping
- **Architectural impact:** A **data-model change** — the only option that makes the `configured` branch reachable
- **Runtime impact:** Single lookup; plus a fallback for rows written before the field exists
- **Behaviour-change risk:** Same threshold change as Option 1; plus a migration decision for existing rows
- **Reversibility:** Harder — touches persisted shape
- **Testing:** Lookup, provenance mapping, legacy-row fallback, budget, and an end-to-end provenance assertion
- ⚠️ Requires deciding how existing rows (which have no marker) are treated — treat as `configured`? as `unknown`?

**Evidence-supported option 5 — make the false-rejection visible without changing enforcement:** log `provider.models` entries whose `contextWindow` is absent, so an operator can see that a real limit was never captured. Changes no threshold; makes the gap observable.

---

# 11. Required regression coverage

**What existing Phase 2 tests already assume (read, not modified):**

| Location | Assumption |
|---|---|
| `budget.test.ts:153` | An unresolvable limit yields exactly `UNKNOWN_LIMIT_CEILING` |
| `budget.test.ts:154` | Its description contains `default_conservative` |
| `budget.test.ts:159` | `UNKNOWN_LIMIT_CEILING > 0` |
| `budget.test.ts:190-195` | Arithmetic with a **100,000** synthetic limit via `model: { contextWindow }` — exercises `model_reported` directly |
| `budget.test.ts:201,215` | Small-window (100) non-negativity |
| `assemble.test.ts:191` | A real assemble yields `default_conservative` — **this would FAIL if the fixture provider ever carried a `contextWindow`** |

⚠️ **`assemble.test.ts:191` is coupled to current behaviour**: its fixture provider
has no models, so it resolves to `default`. Any wiring change must keep that
fixture honest or the assertion must be updated deliberately.

**Coverage needed if R1 is fixed:**

1. `resolveContextLimit` with a model carrying `contextWindow` → `model_reported` (already at `budget.test.ts:190`, but only via a synthetic direct call, never through `assembleContext`)
2. `assembleContext` end-to-end with a provider whose `models` contains the selected model with a window → `limitSource: model_reported`
3. Model id **not** present in `models` → falls back to `default` (no throw)
4. Model present with `contextWindow: 0` or negative → ignored, falls back (existing guard, needs an integration-level assertion)
5. A **smaller** real window tightening the budget and producing `reject` where 128k would accept — the safety direction
6. A **larger** real window loosening the budget — the false-rejection fix
7. Provenance truthfulness, if Option 4: user-set vs provider-reported produce distinct `source` values
8. Determinism: identical provider metadata → identical budget across repeated assemblies

**Not needed:** changes to any Phase 1 invariant suite. The pruner, approval
lifecycle, pairing, and ordering are untouched by limit resolution.

---

# 12. Remaining unknowns

| # | Unknown |
|---|---|
| U-R1.1 | **Which published figure applies to the configured `agnes` endpoint** — 512K (vendor wiki) or 1M (third-party, production checkpoint). Not resolvable without inspecting the endpoint's own model metadata |
| U-R1.2 | Whether the endpoint's `/v1/models` returns any context metadata TBAi could read. `normalizeCustom` was not observed to fetch capability data; a custom gateway may expose more than TBAi currently asks for |
| U-R1.3 | Whether OpenAI / Google / Ollama expose a context limit anywhere TBAi could reach. `normalizeOpenAI` states no truthful source exists *for the listing endpoint it uses* — not that none exists anywhere |
| U-R1.4 | Whether user-set windows are already common in other installs. This one has 0/3 set; other installs are not observable from here |
| U-R1.5 | Whether any Phase 3 sizing work already assumes the ceiling is real. Phase 3 has not started, so nothing depends on it yet |
| U-R1.6 | Whether the `configured` branch should exist at all, or whether `source` should be reduced to reported / unknown with provenance carried elsewhere |

---

# 13. Recommendation for Phase 3 gate

**No option is selected.** The following must be decided before implementation:

1. **Decide the direction R1 moves in.** The evidence says the current 128k causes
   **false rejections** on this install's model (documented 512K, possibly 1M).
   That is the opposite of the risk recorded in the certification. Whether to
   correct it is a product decision about accepting larger requests, not only a
   technical one.

2. **Decide whether provenance must be truthful.** If `source: "model_reported"`
   may describe a user-typed number, then either Option 4 is chosen or the
   `configured` branch is removed and `source` is documented as
   "configured-or-reported". Reporting a user's own input as a provider's figure
   is a truthfulness defect, independent of which number is used.

3. **Decide the ceiling's role in Phase 3 sizing.** If any Phase 3 work sizes or
   segments a prefix by the input ceiling, it must first know whether the ceiling
   is real. Otherwise a 128k ceiling splits prefixes that a 512K model would keep
   whole, and the resulting cache-hit measurement is wrong.

4. **Decide whether the false-rejection path is acceptable to carry into Phase 3.**
   Carrying it is safe for correctness — a smaller ceiling only rejects earlier —
   but it silently caps conversation length at a number unrelated to the model.

5. **Decide whether provider-precedence belongs in a capability layer now.** Phase 3
   needs a per-model capability table (§3.2). R1 needs a per-model limit. If both
   are to live somewhere, a shared capability module avoids two divergent
   lookups; if not, they should stay separate and the duplication named.

**No implementation is required before Phase 3 *starts*,** but items 1 and 3 should
be settled before Phase 3 runs any prefix-sizing experiment, or its results will
be measured against a ceiling that does not describe the model.

---

R1 investigation complete. No implementation performed. Phase 3 remains unstarted.
