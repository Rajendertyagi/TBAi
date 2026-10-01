# R1 Decision & Provenance Design Gate

**Date:** 2026-10-01 · **Design phase.** Sections 1–12 as originally written were
design-and-verification only: no production code, test, schema, provider
configuration, dependency, or roadmap was modified. **Sections 13–15 were added
by the subsequent implementation task**, which resolved A1, A2 and P3 and changed
the listed production files. See `docs/r1-context-limit-implementation-report.md`
for the implementation record.

**Verification labels used throughout:** **VERIFIED** (read in code or queried),
**INFERRED** (reasoned from verified facts), **UNKNOWN**, **PRODUCT DECISION**,
**ARCHITECTURAL DECISION**.

---

# 1. R1 Finding

**VERIFIED.** R1 is two independent defects.

| Branch | Reachable? | Root cause | Class |
|---|---|---|---|
| `model_reported` | **No** | `assemble.ts:220` never passes `model` | ARCHITECTURAL: unfinished wire |
| `configured` | **No — unreachable by construction** | A user-set limit and a provider-reported limit occupy the **same field**; no separate concept exists | ARCHITECTURAL: data-model gap |

**VERIFIED.** Every production Direct request therefore resolves to
`source: "default"` = `UNKNOWN_LIMIT_CEILING = 128_000`.

**VERIFIED — and this corrects the certification.** For the models this install
actually uses, the vendor documents **512K**. TBAi's 128k ceiling is therefore
**roughly 4× smaller than the real limit**, and TBAi is **rejecting requests these
models can serve**. The certification recorded the opposite risk ("supplying a
real limit tightens enforcement"); for this configuration the change is
**loosening**, not tightening.

---

# 2. Current Data Flow

**VERIFIED** end to end.

```
SOURCE                       WRITER                          FIELD WRITTEN
─────────────────────────────────────────────────────────────────────────────
Provider discovery           normalizeAnthropic              ModelOption.contextWindow
                             modelDiscovery.ts:131             = max_input_tokens
                             ⚠️ ONLY Anthropic; OpenAI/Google/Ollama omit it

User / Provider UI           ProviderDialog.commitWindow     ModelOption.contextWindow
                             ProviderDialog.tsx:309-330        = parseContextWindowInput(text)
                             Any provider                    ⚠️ SAME FIELD as discovery

                                ↓
STORAGE                     provider_configs.models         SQLite TEXT, JSON array
                             (modelOptionSchema              {"id","label","provider",
                              validation.ts:19-25)             "contextWindow"?,"capabilities"?}
                             ⚠️ NO provenance field exists

                                ↓
REGISTRY                    ProviderRegistry.loadFromDb    providers.ts:36-48
                             JSON.parse → ModelOption[]      ⚠️ provenance already lost
                             Loaded at BOOT into a Map
                             registry.get() is SYNC          providers.ts:65

                                ↓
RESOLUTION                   resolveChatModel               chat-model.ts:29,51
                             returns { provider: ProviderConfig }
                             ProviderConfig.models carries the array

                             modelConfig = {...provider}     chat.ts:234,237
                             ⚠️ .models SURVIVES the spread

                                ↓
ASSEMBLY                    assembleContext({provider})     chat.ts:333
                             resolveContextLimit({           assemble.ts:220-223
                               providerType, modelId })       ⚠️ .models never read
                               ⚠️ no `model` argument
```

**VERIFIED.** Provenance is retained **nowhere**. It is lost at the moment a
discovered value and a user-typed value are written to the same field, and never
recoverable afterwards.

**VERIFIED.** The value TBAi *should* be able to read is present in the seam's own
input object at `assemble.ts`. The chain stops one line short of using it. There is
no architectural boundary preventing the read.

---

# 3. Current Provenance Problem

**VERIFIED.** Three facts make the current `source` field structurally incapable of
being truthful once wired:

1. **One field, two origins.** `ModelOption.contextWindow` is written by
   `modelDiscovery.ts:131` (provider's own API) and by `ProviderDialog.tsx:326`
   (human typing). Nothing distinguishes them in storage or memory.
2. **`configuredContextWindow` has no producer.** All four references to it are
   inside `limits.ts` itself (`:60,:62,:67,:68`). No field, API, or UI produces it.
3. **Naive wiring would make `source` lie.** If `model` were passed today, a
   user-typed `128000` would be returned as `source: "model_reported"` — a number
   the user invented, logged as the provider's own figure. That is a truthfulness
   defect in the Phase 2 diagnostics contract, independent of which number is used.

**Consequence for the ADR:** the Phase 2 contract states that `source` exists so
"a caller that wants a number and ignores `source` is misusing this function"
(`limits.ts:49-52`). That contract **cannot be honoured** with the current data
model.

---

# 4. Authoritative Model/Endpoint Verification

### TBAi configuration (VERIFIED — read-only query of `data/chat.db`)

| Field | Value |
|---|---|
| Provider id | `sb9c50gb5a10qd2nrduf5113` |
| Name / type | `agnes` / **`custom`** |
| **Endpoint** | **`https://apihub.agnes-ai.com/v1`** |
| **Protocol** | **`chat-completions`** (`api_protocol`) |
| Configured model | `agnes-3.0-flash` |
| Models in registry | `agnes-3.0-flash`, `agnes-2.5-flash`, `agnes-2.0-flash` — **all with `contextWindow` undefined (0/3)** |

### Vendor documentation (authoritative)

Source: **Agnes AI official documentation wiki**, `wiki.agnes-ai.com`
(accessed **2026-10-01**). The documentation's own "Overview" table lists
**Base URL `https://apihub.agnes-ai.com/v1`** — an **exact match** to TBAi's
configured endpoint, so this is endpoint-specific documentation, not a
model-wide generalisation.

| Model | Vendor context window | Vendor max output | Status per vendor |
|---|---|---|---|
| `agnes-3.0-flash` | **512K** | **65,536 tokens** | Current |
| `agnes-2.5-flash` | **512K** | **65.5K** | Generally available |
| `agnes-2.0-flash` | **512K** | **65.5K** | ⚠️ **DEPRECATED** — *"no longer recommended for new API integrations"* |

### Resolution of the earlier conflict

The R1 report recorded a conflicting third-party claim of **1M**. Resolved against
authoritative sources:

- The 1M figure originates from `mindstudio.ai`, hosted on MindStudio's own CDN
  (`ai.mscdn.ai`), describing models in **MindStudio's** catalogue.
- Agnes AI's own documentation explicitly warns against conflating its open-weight
  preview checkpoint (262,144 tokens, on Hugging Face) with the production
  API-served model.
- **The vendor's page for the exact API-served model TBAi calls states 512K.**

**VERIFIED: 512K is the authoritative vendor figure for this endpoint and these
model identifiers.** The 1M claim is third-party and not applicable.

### Uncertainty retained

| # | Uncertainty |
|---|---|
| U-R1.1 | ⚠️ "512K" is vendor shorthand; the **exact integer** is not stated in the wiki. 512K could be 512,000 or 524,288. **UNKNOWN** — and material, because the difference is ~2.4% of the ceiling |
| U-R1.2 | The vendor states *"Availability and rate limits follow the entitlement shown for your Agnes AI account and API key."* An **account-tier-specific** context reduction cannot be ruled out from documentation. **UNKNOWN** |
| U-R1.3 | Whether the endpoint's `/v1/models` response carries any context metadata TBAi could read directly. Not inspected; `normalizeCustom` was not observed fetching it. **UNKNOWN** |

---

# 5. Limit Semantics

Four conceptual cases, evaluated without choosing.

### A. Provider-reported value available

| | |
|---|---|
| **Enforcement** | Use it as the ceiling |
| **Budget** | `ceiling − reserve − 25% margin` |
| **Output reservation** | Currently independent — `resolveOutputReservation` reads a *separate* argument, so a reported **input** window does **not** automatically supply an output reserve |
| **Safety margin** | Unchanged (25%) |
| **Logging** | `limitSource: model_reported` |
| **UI** | `web/src/config/modelContext.ts` already prefers a model's `contextWindow` for the ring; a reported value would make the ring truthful too |
| **Phase 3** | Largest prefix a cache may span; the ceiling a segmentation decision must respect |

⚠️ **Assumption, not fact:** that a provider-reported figure is *trustworthy*. It is
trustworthy to the extent the provider's listing is accurate. Phase 3 §3.5 already
records that **published minimums are floors, not guarantees** — the same caution
applies to a published maximum.

### B. User-configured value available

| | |
|---|---|
| **Enforcement** | Use it |
| **Budget / margin** | Same arithmetic |
| **Output reservation** | Unchanged |
| **Logging** | Must be `configured`, **not** `provider_reported` |
| **UI** | User already typed it; the ring can show it as a user-set value |
| **Phase 3** | Usable as a ceiling, with the caveat that it reflects **this installation's belief**, not the model |

⚠️ **Not assumed safer or less safe.** A user-configured value can be **wrong in
either direction**: too small produces false rejections; too large produces
requests the provider rejects at a cost TBAi did not anticipate. It differs from a
provider figure in **authority** (who is accountable for the number), not in
reliability.

### C. No trustworthy value — the current state

| | |
|---|---|
| **Enforcement** | 128k ceiling; `usableInput = 92,928` |
| **Effect** | **False rejections** against a 512K model. VERIFIED for this install |
| **Logging** | `default_conservative(128000)` — already self-describing |
| **Phase 3** | Any prefix-sizing measurement is against a fictional ceiling |

### D. Conflicting values (provider-reported ≠ user-configured)

⚠️ **Currently undefined — no code path can even express the conflict**, because
only one value can exist at a time.

Candidate resolution behaviours, stated without selection:

| Behaviour | Consequence |
|---|---|
| Configured wins | User's explicit intent is honoured; a stale discovery value is ignored |
| Provider-reported wins | Freshness beats intent; a user who deliberately lowered the window is overridden |
| More conservative wins | Never over-rejects beyond either source; **caps capability at the lower of the two** |
| Configured wins, and divergence is logged | As above, plus the disagreement becomes observable |

Note: once a user sets a value manually, discovery does not overwrite it on this
path (`normalizeCustom`/`normalizeAnthropic` produce fresh arrays that are
**replaced**, not merged, on provider save — `providers.ts:161,191`). So in
practice the two do not currently contend; a conflict is only reachable if
discovery runs **after** a manual set on the same model. **The precedence rule is
therefore rarely exercised and should be chosen for clarity rather than frequency.**

---

# 6. 128K Fallback Analysis

**VERIFIED.** `UNKNOWN_LIMIT_CEILING = 128_000` (`limits.ts:32`), hardcoded, not
configurable, terminal fallback of `resolveContextLimit` (`:72`).

| Concern | Determination |
|---|---|
| **SAFETY** — a hard safety ceiling? | **No.** Nothing about 128k is derived from a safety property. It is an assumption about typical windows. It cannot prevent a request the *provider* rejects, because it is not calibrated to any provider |
| **CAPABILITY** — can it reject valid requests? | **Yes. VERIFIED.** Against a documented 512K model it rejects roughly **77% of the usable window** (`92,928 / 390,144` ≈ 24%). This is a **known, currently-active capability limitation** |
| **MEASUREMENT** — affects Phase 3 measurements? | **Yes.** Any experiment that sizes, segments, or bounds a cache prefix against this ceiling measures against a number that does not describe the model. A 128k ceiling splits prefixes a 512k model would keep whole, **depressing observed cache-hit rate** and producing a wrong conclusion about whether caching helps |
| **CACHE EXPERIMENT VALIDITY** | **Compromised** for any sizing-dependent experiment; **unaffected** for experiments that only observe cache write/read counts on a naturally-sized prefix |

**Separation, stated plainly:**

- **SAFETY:** 128k is not a safety mechanism. It provides *some* bound, which is
  better than none, but it is not calibrated.
- **CAPABILITY:** it imposes a real, measurable restriction today.
- **MEASUREMENT:** it does not affect measurement *accuracy* (the estimate is
  independent) — only *reach* (a conversation cannot grow past it).
- **CACHE EXPERIMENT VALIDITY:** it invalidates sizing-dependent conclusions.

**PRODUCT DECISION** — changing or raising the fallback is a product decision about
how long a conversation may become, not a technical one. **Not decided here.**
**ARCHITECTURAL DECISION** — whether a fallback should exist at all, and whether it
should be per-model rather than global.

---

# 7. Design Options

No option selected.

### Option 1 — Add provenance alongside `contextWindow`

```
contextWindow: number | null
contextWindowSource: "provider_reported" | "configured" | "conservative_default" | "unknown"
```

| | |
|---|---|
| **Data model** | Additive field on `ModelOption` |
| **Schema** | `modelOptionSchema` gains an optional enum. Existing rows valid — the field is optional, so **no migration is required** |
| **Registry** | Unchanged; JSON.parse carries it |
| **API** | Provider create/update gains an optional field; **backward compatible** |
| **UI** | `ProviderDialog.commitWindow` writes `configured`; discovery writes `provider_reported`. The existing "set window" affordance already exists |
| **Phase 2** | Backward compatible — absent source can default to `configured` for legacy rows, or `unknown` |
| **Phase 3** | ✅ Clean — a typed provenance is exactly what §3.2 needs |
| **Reversibility** | High — additive |
| **Testing** | Write-path provenance for both writers; legacy-row default; `resolveContextLimit` honours source; end-to-end assembly |

⚠️ **Gap:** nothing prevents a *future* writer from setting the wrong provenance.
Trust rests on discipline unless a type or setter enforces it.

### Option 2 — Replace the single field with a structured capability object

```
contextLimit: { value: number | null; source: Provenance; confidence?: "high"|"medium"|"low"; authority?: string }
```

| | |
|---|---|
| **Data model** | Breaking replace of `contextWindow` |
| **Schema** | ⚠️ **Legacy rows hold a bare number.** `JSON.parse` succeeds but the shape differs, so **a migration or a tolerant read is required** |
| **Registry** | Same |
| **API** | **Breaking** for any external consumer of the provider models payload |
| **UI** | Every `contextWindow` read site must change (`modelContext.ts:75`, `ProviderDialog.tsx` ×6, `context-display` ×many, `context-ring`) |
| **Phase 2** | `resolveContextLimit` narrows; existing budget tests unaffected |
| **Phase 3** | ✅ Strongest — carries `confidence` and `authority` alongside, which §3.5's documented-vs-observed distinction needs |
| **Reversibility** | **Low** — touches storage and API shape |
| **Testing** | Migration of legacy rows; tolerant read; all read sites |

⚠️ **Cost note:** `contextWindow` has **~40 read sites** across `web/src` (verified
by exhaustive grep). This is a wide change.

### Option 3 — Keep storage unchanged; derive provenance externally

| | |
|---|---|
| **Data model / schema / migration** | **None** |
| **Registry / API / UI** | **None** |
| **Phase 2 / Phase 3** | Compatible |

**Factual limitations — why this cannot fully work:**

1. **Provenance is unrecoverable in principle, not merely inconvenient.** Once a
   number is written, nothing in storage or memory distinguishes a vendor figure
   from a typed one. Any derivation must *guess*.
2. **A guess based on value is unsound.** "Large ⇒ provider-reported" fails: 512K
   could be either. "Model id is in a known table ⇒ provider-reported" re-introduces
   a hardcoded table — the exact thing Phase 3 §3.2 warns must be **per-model, never
   per-family**.
3. **It makes `source` unreliable by construction.** The Phase 2 contract that
   `source` exists to prevent misuse (`limits.ts:49-52`) would be void.
4. **Only a narrow subclass is derivable:** *absence* of a value is reliably
   `unknown`/`default`. That is the current behaviour.

**Verdict on facts, not preference:** Option 3 can be correct for the
`conservative_default` and `unknown` states, and **cannot** be correct for
distinguishing `provider_reported` from `configured`. Any use beyond that is
inference from a value.

### Option 4 — Provenance at the resolution boundary, derived from an explicit writer record

Keep `contextWindow` as-is; record provenance **where it is set** — e.g. the
discovery normalizer tags its output, and `commitWindow` tags the user's — and
carry it in a parallel in-memory map on `ProviderConfig` that is **not** persisted.

| | |
|---|---|
| **Data model / schema / migration** | **None persisted** |
| **Registry** | Gains an in-memory `modelProvenance: Map<string, Provenance>` |
| **API** | Unchanged |
| **UI** | Unchanged |
| **Phase 2 / Phase 3** | Compatible **in-process**; **lost on restart and on any provider save**, because discovery re-runs and re-derives |
| **Reversibility** | High |
| **Testing** | Writer tagging; restart/save behaviour; default fallback |

⚠️ **Honest weakness:** provenance survives only as long as the process. After a
restart, or after `providers.ts:191` re-runs discovery, a user-set value could be
overwritten anyway (discovery **replaces** the array) — so this does not fix the
underlying overwrite behaviour either.

### Option 5 — Evidence-supported: fix the wiring **and** the writer asymmetry first

Ship the one-line wiring (`assemble.ts` reads `provider.models`) while labelling
the result honestly as **`configured_or_reported`**, and defer the full provenance
split until the overwrite behaviour is also decided.

| | |
|---|---|
| **Data model / schema / migration** | None |
| **Behaviour change** | Ceiling becomes real where a value exists (Anthropic auto-discovery; any user who set one) |
| **Truthfulness** | ✅ Restored, because `source` no longer over-claims |
| **Phase 3** | ✅ Receives an honest provenance string, though not a full taxonomy |
| **Reversibility** | Trivial |
| **Testing** | Wiring + provenance labelling only |

⚠️ **Does not solve:** the discovery-overwrites-user-set behaviour, or the absence
of a full provenance taxonomy for Phase 3.

---

# 8. Phase 2 vs Phase 3 Boundary

| Work | Classification |
|---|---|
| Wire `provider.models` into `resolveContextLimit` | **Phase 2 follow-up** — completes a Phase 2 exit criterion (8) |
| Provenance taxonomy + storage | **Phase 2 follow-up**, or a Phase 3 prerequisite — see below |
| Making `source` truthful | **Phase 2 follow-up** — the Phase 2 contract depends on it |
| Discovery-overwrites-user-set behaviour | **Architectural decision**, unclassified |
| Output reservation calibration (see §9) | **Phase 2 follow-up** |

### Must provenance be solved before…

| Phase 3 activity | Blocked by R1? |
|---|---|
| **Measuring stable prefixes** | ⚠️ **Partly.** Measuring the *prefix that exists* is unaffected. Sizing a prefix *against the ceiling* is affected |
| **Choosing cache breakpoints** | ⚠️ **Partly.** Breakpoints on Layer A/B content are unaffected. Any choice bounded by the context window is affected |
| **Conducting cache hit/read/write experiments** | ⚠️ **Only if** the experiment's prefix size depends on the ceiling. A naturally-sized prefix is unaffected |
| **Selecting model-specific cache controls** | **No.** Cache minimums are a **different fact** from the input window. Neither supplies the other. §3.2 of the roadmap is independent |
| Building the §3.2 capability table | **No** |

**Conclusion:** provenance is **not a hard blocker** for Phase 3 to begin. It is a
**hard blocker for Phase 3 producing a trustworthy answer** on any question whose
prefix size is derived from the context window.

---

# 9. Test Impact

**VERIFIED.** Existing coupling, and — importantly — how little of it exists.

| Test | Depends on | Breaks if `model` is wired? |
|---|---|---|
| `assemble.test.ts:190-191` | Fixture provider has **no `models` array at all** (`assemble.test.ts:15-20`) → lookup finds nothing → still `default` | **No** |
| `budget.test.ts:152,154` | Calls `resolveContextLimit` directly with no `model` | **No** |
| `budget.test.ts:164` | `contextWindow: 0` → rejected by the guard → `default` | **No** |
| `budget.test.ts:173` | `resolveOutputReservation(undefined)` → `default` | **No** |
| `budget.test.ts:190-195` | 100,000 synthetic window via `model: {contextWindow}` — **already exercises `model_reported`** | **No** — unchanged |

**VERIFIED conclusion: wiring the model would break zero existing tests.** The
fixture providers carry no model metadata, so the "unknown" path stays the path
under test. New coverage is **additive**.

### Fixtures that should remain deliberately "unknown"

`assemble.test.ts`'s provider (`p1`, no `models`) is the correct unknown-case
fixture and should stay that way. The `budget.test.ts:164` zero-value fixture
correctly covers "present but unusable".

### Regression coverage required for provenance

1. Discovery writes `provider_reported`; `commitWindow` writes `configured`.
2. Legacy rows (no provenance field) resolve to a defined, documented state —
   **which one must be decided**, since it determines whether a pre-existing
   user-set value is mislabelled.
3. `resolveContextLimit` returns the source that was written, never a hardcoded one.
4. End-to-end `assembleContext` with a provider whose models contain the selected
   model → `limitSource` reflects the stored provenance.
5. A **larger** window loosens the budget (the false-rejection fix).
6. A **smaller** window tightens it and can `reject` where 128k would accept.
7. Discovery-overwrites-user-set: a behaviour that must be specified before it can
   be tested.

**No Phase 1 invariant suite is affected** — the pruner, pairing, approval
lifecycle, and ordering are untouched by limit resolution.

---

# 10. Phase 3 Input Contract

**What Phase 3 should receive** — a typed value, never a bare number:

```ts
interface ContextCapability {
  /** Maximum input tokens, or null when nothing is known. */
  readonly maxInputTokens: number | null;
  /** Who said so. Phase 3 must never infer this from the number. */
  readonly provenance:
    | "provider_reported"   // the provider's own listing/API
    | "configured"          // a human set it for this install
    | "conservative_default"// TBAi's stand-in; NOT a model fact
    | "unknown";            // nothing known
  /** Stable identity of the capability, for cache-control keying. */
  readonly providerId: string;
  readonly modelId: string;
}
```

### Why each field is required

| Field | Purpose |
|---|---|
| `maxInputTokens: number \| null` | Distinguishes "zero/unknown" from a real zero. A `0` and a `null` mean different things |
| `provenance` | **Prevents Phase 3 from inferring trust from magnitude.** A 512K that TBAi assumed must never drive a cache experiment |
| `providerId` + `modelId` | §3.2 requires keying on the **full** identifier, never a family pattern |

**Rule for Phase 3:** a `conservative_default` or `unknown` ceiling **may be used
for safety bounds but must not be used to size, segment, or conclude anything
about cache effectiveness.** That restriction must be stated in the Phase 3 plan,
because it is the specific way R1 would corrupt a measurement.

### Phase 3 work that can proceed independently

Unaffected by R1 today: the §3.2 per-model capability table and its sources;
deterministic-ordering verification; the two-request verification protocol
(write-then-read on a stable prefix); measurement plumbing for cache read/write
fields; the unknown-model policy (§3.6).

---

# 11. Decision Required

**No decision is made here.** These must be settled by the maintainer.

### ARCHITECTURAL DECISIONS

| # | Decision | Why it cannot be inferred |
|---|---|---|
| A1 | **Which provenance model** — Option 1 (field alongside), 2 (structured object), 4 (in-memory), 5 (wiring + honest label) | Depends on how much storage/API churn is acceptable and whether Phase 3 needs a full taxonomy or one honest label |
| A2 | **How legacy rows without provenance are treated** — `configured`, or `unknown` | Determines whether pre-existing user-set values are mislabelled as provider figures |
| A3 | **Whether discovery may overwrite a user-set value** | Currently discovery **replaces** the whole array (`providers.ts:161,191`), so a manual value can be lost. Unspecified behaviour, not a deliberate policy |
| A4 | **Whether `resolveContextLimit` keeps both branches** or collapses to a smaller honest vocabulary | A two-branch function that cannot distinguish its inputs is misleading by construction |

### PRODUCT DECISIONS

| # | Decision | Evidence bearing on it |
|---|---|---|
| P1 | **Whether to lift the 128k ceiling** for this install | VERIFIED: vendor documents 512K; current ceiling rejects ~76% of the usable window |
| P2 | **Whether conversations should be allowed to reach 512K**, and what that means for history growth, persistence size, and the Phase 4 compaction trigger | 512K is ~5.5× today's ceiling; compaction triggers will move materially |
| P3 | **Whether the output reservation should scale with a model's real output capability** | ⚠️ See below |
| P4 | **Whether `agnes-2.0-flash` (vendor-deprecated) should remain selectable** | VERIFIED: vendor marks it deprecated and "not recommended" |

### ⚠️ A second finding surfaced during this investigation

**VERIFIED.** `maxOutputTokens` is set to the **output reservation**
(`chat.ts:587`), and the reservation defaults to **4,096** (`limits.ts:42`).
Therefore **generation is currently capped at 4,096 tokens** — while the vendor
documents a **65,536**-token maximum output for this exact model.

This is coherent as a budget invariant (input ≤ ceiling − reserve, output ≤ reserve,
so input + output ≤ ceiling), but it means the reserve does double duty:
it both holds back input room **and** caps generation. At a 512K ceiling with a
4,096 reserve, roughly 130K of margin is unusable by either side.

⚠️ **This is P3 — PRODUCT DECISION, not a defect.** Raising the reservation would
loosen the budget *and* raise the generation cap simultaneously, which is a
behaviour change the maintainer should choose deliberately. It is recorded here
because it was discovered while verifying the limit and is materially related.

### Sequencing constraint

Items **A1 and P1** gate any implementation. **A2** must precede any storage change.
**P3** should be settled in the same pass, because the reservation and the ceiling
interact arithmetically.

---

# 12. Remaining Unknowns

| # | Unknown |
|---|---|
| U-R1.1 | The **exact integer** behind "512K" — 512,000 or 524,288. Vendor docs use shorthand. ~2.4% of the ceiling |
| U-R1.2 | Whether the account's entitlement tier can reduce the effective context window. Vendor states limits "follow the entitlement shown for your account" |
| U-R1.3 | Whether the endpoint's `/v1/models` exposes context metadata TBAi could read directly. Not inspected |
| U-R1.4 | Whether any other TBAi install has user-set windows. This one has 0/3; others are not observable |
| U-R1.5 | Whether OpenAI / Google / Ollama expose a context limit anywhere TBAi could reach. `normalizeOpenAI` states none exists *for the listing endpoint it uses* — not that none exists |
| U-R1.6 | Whether `source` should retain four states or collapse to fewer |
| U-R1.7 | Whether discovery-overwrites-user-set is intentional, incidental, or a latent bug |

---

# 13. Verification Record

**Read-only.** No file was modified; no test was modified or created.

**Repository verification (not web research):**

| Check | Result |
|---|---|
| `provider_configs` live query | 1 provider, 3 models, **0/3** carry `contextWindow`; endpoint `https://apihub.agnes-ai.com/v1`; `api_protocol: chat-completions` |
| `resolveContextLimit` production callers | 1 (`assemble.ts:220`), passing **2 of 4** arguments |
| `configuredContextWindow` references | 4 — **all inside `limits.ts`** |
| `contextWindow` write sites | 2 — `modelDiscovery.ts:131` (Anthropic only), `ProviderDialog.tsx:326` (user) |
| `discoverModels` callers | 2, **both** `providers.ts:161,191` — config time only |
| Registry load | `providers.ts:36-48`, at boot; `get()` synchronous |

**Tests run (existing only, none modified):**

| Suite | Result |
|---|---|
| `src/context/budget.test.ts` + `assemble.test.ts` + `context-overflow.test.ts` | **69 pass / 0 fail** |
| `src/services/modelCapabilities.test.ts` | **12 pass / 0 fail** |
| `web/src/config/modelContext.test.ts` | **7 pass / 0 fail** |
| **Total** | **88 pass / 0 fail** |

**Vendor documentation verification (external, kept separate from repository
verification):**

| Model | Context | Max output | Source | Accessed |
|---|---|---|---|---|
| `agnes-3.0-flash` | 512K | 65,536 | `wiki.agnes-ai.com/en/docs/agnes-30-flash` | 2026-10-01 |
| `agnes-2.5-flash` | 512K | 65.5K | `wiki.agnes-ai.com/en/docs/agnes-25-flash` | 2026-10-01 |
| `agnes-2.0-flash` | 512K | 65.5K | `wiki.agnes-ai.com/en/docs/agnes-20-flash` (deprecated) | 2026-10-01 |

Endpoint-specific: the vendor "Overview" table lists Base URL
`https://apihub.agnes-ai.com/v1`, matching TBAI's configured endpoint exactly.

---

# Decision Table

| Question | Current evidence | Decision needed before Phase 3? |
|---|---|---|
| **Provider vs configured provenance** | **VERIFIED** — both write the same field; provenance is lost at write time and unrecoverable. Naive wiring would log a user's number as `provider_reported` | **YES** — A1, A2. It is a truthfulness defect in the Phase 2 contract, not only a Phase 3 concern |
| **Exact model limit** | **VERIFIED (vendor, endpoint-matched)** — 512K context, 65,536 max output for `agnes-3.0-flash` at the configured endpoint. Exact integer behind "512K" is **UNKNOWN**; entitlement-tier effect **UNKNOWN** | **No** for Phase 3 cache-capability work (a different fact). **YES** for anything that sizes a prefix against the ceiling |
| **128k behaviour** | **VERIFIED** — hardcoded, unconfigurable, terminal fallback; rejects ~76% of the usable window for this model. Not a safety calibration; it is an assumption | **YES** — P1. It is a PRODUCT decision about conversation length |
| **Schema / data-model treatment** | Options 1–5 documented; Option 3 shown **unrecoverable in principle** for the reported/configured split; Option 1 needs no migration; Option 2 is a breaking change across ~40 read sites | **YES** — A1, A2, A3 |
| **Phase 3 dependency** | **VERIFIED** — nothing is strictly blocked. §3.2 capability table, deterministic ordering, and the two-request protocol are independent. **Sizing-dependent cache experiments are not** | **PARTIAL** — the constraint must be written into the Phase 3 plan: a `conservative_default`/`unknown` ceiling may bound safety but **must not size or conclude** |

---

# 13. FINAL DECISIONS (added by the implementation task, 2026-10-01)

Sections 1–12 above are preserved as written: they are the decision record's
*evidence*, and nothing in them is retro-fitted to the outcome. What follows is
what was decided and implemented.

## A1 — Provenance data model: **Option 1, an additive sibling field**

**Decision:** add `ModelOption.contextWindowSource` beside `contextWindow`.

**Why Option 1 and not Option 2** (the structured capability object):

- **The project already has this exact pattern.** `ModelCapabilities` on
  `ModelOption` is an additive optional object inside the same JSON column, with
  an explicit tri-state stance and its own acceptance criteria
  (`modelCapabilities.test.ts`, 12 tests). Provenance now follows the established
  shape rather than inventing a second one — AGENTS.md §2 requires a new feature
  to be a new module, not a parallel design.
- **Non-destructive and migration-free.** `contextWindowSource` is optional, so
  every existing row still validates through `modelOptionSchema`. Verified by a
  round-trip test. Option 2 would have left legacy rows holding a bare number
  where a `value` key was expected — a shape mismatch that needs either a
  migration or a tolerant read.
- **~40 frontend read sites.** Verified by exhaustive grep across `web/src`.
  Option 2 is a breaking change to all of them for no gain in correctness.

**The two storable states are exactly `provider_reported` and `configured`.**
`conservative_default` and `unknown` are **not** storable: no writer produces
them, and persisting either against a model would assert a fact no source
supplied. They exist only as resolver outcomes, in the four-state `LimitSource`
vocabulary. This mirrors `CapabilitySupport`, where `unknown` is a stance a
producer must take explicitly and never a value to infer.

**Enforcement that a user-entered value cannot be labelled `provider_reported`:**
two writer helpers in `src/types/index.ts` (and mirrored in `web/src/types/`):

| Writer | Helper | Produces |
|---|---|---|
| Provider discovery (`modelDiscovery.ts`) | `providerReportedLimit(v)` | `provider_reported` |
| Provider dialog (`ProviderDialog.tsx`) | `configuredLimit(v)` | `configured` |

The guarantee is **structural, not disciplinary**: the dialog has no code path
that can produce the `provider_reported` stance, because the stance is not a
literal it writes. This is the answer to the requirement that the labelling be
impossible rather than merely avoided.

## A2 — Resolution order: configured wins a conflict; the losing figure is recorded

**Decision (rules, in order):**

| # | Situation | Effective limit | Reported source |
|---|---|---|---|
| 1 | Exactly one candidate | that candidate | its own stance |
| 2 | Two candidates, **equal** | the value | `provider_reported` |
| 3 | Two candidates, **conflicting** | the **configured** value | `configured`, plus `divergentValue` |
| 4 | No candidates | `UNKNOWN_LIMIT_CEILING` (128 000) | `conservative_default` |

**Why `configured` wins rule 3**, given §5 warned against assuming a configured
value is safer or less safe:

- A published window is **model-wide**; this vendor's own documentation states
  limits "follow the entitlement shown for your Agnes AI account and API key". An
  operator who typed a number may be describing a **per-account** reality that no
  documentation can know. On the authority question the operator is closer to the
  truth than the listing is.
- Silently overriding an explicit human setting is worse than honouring it.
- It is deterministic and never changes a setting behind the operator's back.
- It cannot authorise a Phase 3 experiment: rule 3 yields `configured`, which
  `isPhase3ExperimentEligible` denies.

The inverse was rejected: "provider-reported automatically wins" would let a
model-wide listing override a deliberate operator choice — a capability
regression with no safety benefit.

**`unknown` remains in the vocabulary but the resolver does not emit it.** Rule 4
returns `conservative_default` because an unbounded request is not acceptable;
`unknown` is reachable only where a caller constructs a limit with no ceiling at
all. Recorded rather than removed, since `ContextBudget.enforceable` depends on it.

## Legacy rows (A2's data-migration half)

A pre-R1 row has a value and no stance. It resolves as **`configured`**, never
`provider_reported` (`LEGACY_SOURCE` in `limits.ts`).

Direction is the whole argument: mislabelling it `provider_reported` would let a
number nobody verified authorise cache sizing — the exact over-claim R1 exists to
prevent. Mislabelling provider-discovered data as `configured` only *understates*
authority: enforcement still uses the number, and eligibility is correctly denied.
**The label that fails closed was chosen deliberately.**

## P3 — Output reservation and generation cap are now separate quantities

**Decision: separate them**, with the invariant preserved explicitly rather than
by coincidence.

| | Input budget reservation | Model generation cap |
|---|---|---|
| Question | "How much input must I hold back?" | "How much may the model emit?" |
| Owner | TBAi's budget policy | The model's documented capability |
| Field | `budget.outputReservation` | `budget.generationCap` |
| Sent as | *(not sent)* | `maxOutputTokens` |
| Default | 4 096 | 4 096 (`DEFAULT_GENERATION_CAP`) |

```text
  generationCap = min( model's documented output ceiling,
                       ceiling − usableInputTokens )
```

The second term is what preserves `input + output <= ceiling` — the invariant
that made the pre-R1 sharing of one value coherent. **Without it**, a model
documenting a 65 536-token output on a 10 000-token window would receive a
generation cap larger than its entire context, sending TBAi into a provider
rejection it had already pre-flighted against. A test asserts the invariant
across a matrix of ceilings and output figures.

**The default was NOT raised.** `DEFAULT_GENERATION_CAP` equals
`DEFAULT_OUTPUT_RESERVATION` (4 096), so behaviour is **bit-identical for every
path that exists today** — no provider currently populates an output ceiling.
Verified: with the 128k stand-in, usable input 92 928, so the clamp permits
35 072 and the cap resolves to 4 096 exactly as before.

**The 65 536 vendor figure is deliberately not hardcoded.** A model's output
ceiling is read from its own listing (`max_output_tokens`) when the provider
exposes one — no source is currently verified to, so the field is populated by
nothing today. That is recorded as UNKNOWN, not filled in with the Agnes number,
because a vendor figure in generic context logic is exactly what §7 of this
document warned against.

---

# 14. PHASE 3 SAFETY RULE (binding)

Added to `docs/TBAi-context-subagent-roadmap.md` §3.0 and to the ADR. Enforced in
code by `isPhase3ExperimentEligible(limit)` rather than left to prose, because the
failure is silent — an experiment measured against a fictional ceiling yields a
confidently wrong answer about whether caching helps.

```text
A conservative_default or unknown context ceiling
  MAY     bound safety
  MUST NOT size a cache prefix
  MUST NOT choose a provider cache breakpoint
  MUST NOT segment a cache experiment
  MUST NOT claim cache effectiveness
  MUST NOT interpret cache hit / read / write results
```

Only `provider_reported` qualifies. A `configured` figure is this installation's
belief about a model, not a statement by the model — the same distinction §3.6
draws for cache thresholds, applied to the input window.

`budgetDiagnostics` emits `phase3ExperimentEligible` on every assembled request,
so Phase 3 log analysis can exclude ineligible runs instead of averaging a
fictional ceiling into a result.

---

# 15. DECISION STATUS

| Decision | Status |
|---|---|
| A1 provenance data model | **RESOLVED** — Option 1, additive sibling field |
| A2 legacy rows | **RESOLVED** — `configured` (fail-closed) |
| A2 conflict handling | **RESOLVED** — configured wins, divergence recorded |
| A3 discovery overwriting a configured value | **OPEN** — unchanged upstream behaviour; recorded as residual risk |
| A4 resolver vocabulary | **RESOLVED** — four-state `LimitSource` retained and made reachable end-to-end |
| P1 lift the 128k ceiling | **NOT DECIDED** — product decision; ceiling left at 128 000 |
| P2 allow 512K conversations | **NOT DECIDED** — product decision |
| P3 reserve vs generation cap | **RESOLVED** — separated, default unchanged, invariant preserved |
| P4 deprecated model selection | **NOT DECIDED** — product decision |

P1 and P2 remain open **product** decisions. P1 is why the false-rejection
capability limitation described in §6 is still live: the resolver now *can* use a
real limit, but this installation has no model carrying one.
