# R1 Implementation Report

**Date:** 2026-10-01 · **Scope:** TBAi only (`D:\Temp\ai-chat-app`).

**Status labels used throughout:** **IMPLEMENTED** (code changed) · **VERIFIED**
(read or run) · **LIVE-VERIFIED** (exercised against the running server) ·
**UNKNOWN** (not establishable from available evidence) · **DEFERRED**
(deliberately not done).

**Companion documents:** `docs/r1-context-limit-decision.md` (evidence, §13–15 the
final decisions) · `docs/adr-2026-10-01-direct-context-assembly.md` (amended
contract) · `docs/TBAi-context-subagent-roadmap.md` (§3.0.1 binding rule).

---

# 1. Final decisions

## A1 — Provenance data model

**RESOLVED: Option 1 — an additive sibling field `ModelOption.contextWindowSource`.**

The five options in `docs/r1-context-limit-decision.md` §7 were evaluated. Option 1
was selected on evidence, not preference:

- **The project already owns this exact pattern.** `ModelCapabilities` on
  `ModelOption` is an additive optional object in the same JSON column with an
  explicit tri-state stance, its own Zod schema, and 12 acceptance tests
  (`src/services/modelCapabilities.test.ts`). Provenance adopts the established
  shape rather than introducing a parallel one.
- **Migration-free and non-destructive.** The field is optional, so every existing
  row still validates. Verified by round-trip tests.
- **Option 2 rejected:** it would leave legacy rows holding a bare number where a
  `value` key is expected — a shape mismatch needing a migration or a tolerant
  read — and it breaks ~40 frontend read sites for no gain in correctness.
- **Option 3 rejected as impossible** for the reported/configured split: provenance
  is unrecoverable *in principle* once two origins share one field, and any
  derivation from the value would reintroduce exactly the hardcoded per-family
  table §3.2 warns against.

### Storable vs resolvable states

| State | Storable? | Produced by |
|---|---|---|
| `provider_reported` | ✅ | Discovery, via `providerReportedLimit` |
| `configured` | ✅ | Provider dialog, via `configuredLimit` |
| `conservative_default` | ❌ **not storable** | Resolver, when no stored figure exists |
| `unknown` | ❌ **not storable** | Only where a caller builds a limit with no ceiling |

`conservative_default` and `unknown` are never persisted against a model: no
writer produces them, and storing either would assert a fact no source supplied.

### Per-state properties

| | `provider_reported` | `configured` | `conservative_default` | `unknown` |
|---|---|---|---|---|
| **Origin** | Provider's own listing/API | Human typed it | TBAi's assumption | Nothing known |
| **Persistence** | `ModelOption` JSON column | same | none (derived) | none (derived) |
| **Authority** | The provider | This installation | TBAi | none |
| **Hard enforcement** | ✅ | ✅ | ✅ (bounded conservatively) | ❌ `enforceable: false` |
| **Display as a provider fact** | ✅ | ⚠️ must read as user-set | ❌ never | ❌ never |
| **Phase 3 experiment sizing** | ✅ | ❌ | ❌ **forbidden** | ❌ **forbidden** |

### "A user value can never be labelled `provider_reported`" — enforced structurally

Two writer helpers in `src/types/index.ts`, mirrored in `web/src/types/index.ts`:

| Writer | Helper | Produces |
|---|---|---|
| `modelDiscovery.ts` (provider listing) | `providerReportedLimit(v)` | `provider_reported` |
| `ProviderDialog.tsx` (human) | `configuredLimit(v)` | `configured` |

The dialog contains no code path that can emit the `provider_reported` stance,
because the stance is not a literal it writes — it comes from the helper. This is a
property of the module boundary, not of code review diligence.

## A2 — Limit resolution semantics

**RESOLVED.** Authoritative order, implemented in `resolveContextLimit`:

| # | Situation | Effective limit | Source | Divergence |
|---|---|---|---|---|
| 1 | Exactly one candidate | that candidate | its own stance | — |
| 2 | Two candidates, **equal** | the value | `provider_reported` | not divergent |
| 3 | Two candidates, **conflicting** | the **configured** value | `configured` | `divergentValue` records the loser |
| 4 | No candidates | 128 000 | `conservative_default` | — |

**Configured wins a conflict.** Not assumed — justified:

- A published window is **model-wide**; this vendor's documentation states limits
  "follow the entitlement shown for your Agnes AI account and API key". An operator
  may be describing a **per-account** reality no documentation can express.
- Overriding an explicit human setting silently is worse than honouring it.
- Deterministic, and never changes a setting behind the operator's back.
- Cannot authorise a Phase 3 experiment (rule 3 yields `configured`, which
  `isPhase3ExperimentEligible` denies).

The inverse was rejected: it would let a model-wide listing override a deliberate
operator choice — a capability regression with no safety benefit.

**Legacy rows (no stance).** Resolve as `configured` (`LEGACY_SOURCE`). The label
that **fails closed** was chosen deliberately: mislabelling as `provider_reported`
could let an unverified number authorise cache sizing (the over-claim R1 exists to
prevent), whereas mislabelling discovered data as `configured` only *understates*
authority — enforcement still uses the number, and eligibility is correctly denied.

**Conflict reachability — VERIFIED, and a residual risk.** In practice a conflict
is rare: discovery **replaces** a provider's whole `models` array on save
(`src/config/providers.ts`), so a configured value is overwritten rather than
contested. That upstream behaviour is unspecified, unchanged here, and recorded as
**A3 — still open**.

## P3 — Output reservation vs generation cap

**RESOLVED: separated.** Two quantities that answer different questions:

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

The second term is what preserves `input + output <= ceiling` — the invariant the
pre-R1 sharing of one value satisfied by accident. **Without it**, a model
documenting a 65 536-token output on a 10 000-token window would receive a cap
larger than its entire context, sending TBAi into a provider rejection it had
already pre-flighted against. A test asserts the invariant across a matrix.

**The number was NOT raised, and the vendor figure was NOT hardcoded.**
`DEFAULT_GENERATION_CAP` equals `DEFAULT_OUTPUT_RESERVATION`, so behaviour is
**bit-identical for every path that exists today** — no provider currently
populates an output ceiling. Verified live (§9): `generationCap=4096`, exactly the
pre-R1 value. The 65 536 figure lives in documentation, not in generic context
logic; a vendor constant there is precisely what decision §7 warned against.

---

# 2. Vendor verification

Re-verified before coding, as required. **External research, not repository
verification.**

| Field | Value |
|---|---|
| Provider | `agnes`, type `custom` |
| Endpoint | `https://apihub.agnes-ai.com/v1` |
| Protocol | `chat-completions` |
| Model | `agnes-3.0-flash` |

**Authoritative source:** Agnes AI official documentation wiki,
`https://wiki.agnes-ai.com/en/docs/agnes-30-flash`, accessed **2026-10-01**.

| Documented | Value |
|---|---|
| Base URL | `https://apihub.agnes-ai.com/v1` |
| Model name | `agnes-3.0-flash` |
| Context window | `512K` |
| Maximum output | `65,536 tokens` |

**Endpoint applicability — VERIFIED, exact.** The vendor's Overview table lists
Base URL `https://apihub.agnes-ai.com/v1`, matching TBAi's configured endpoint
character for character. This is endpoint-specific documentation, not a model-wide
generalisation.

**The earlier 1M conflict stays resolved.** The 1M claim traces to `mindstudio.ai`,
hosted on MindStudio's own CDN (`ai.mscdn.ai`), describing **MindStudio's**
catalogue. The vendor's page for the exact API-served model TBAi calls states
512K, and explicitly warns against conflating its 262K open-weight preview with
the production model.

### Unresolved and left UNKNOWN

| # | Unknown | Why it matters |
|---|---|---|
| U-R1.1 | **"512K" is shorthand** — 512,000 or 524,288 is not stated. **Not converted** into a precise hardcoded value. | ~2.4% of a ceiling |
| U-R1.2 | Entitlement may reduce the effective window ("limits follow the entitlement shown for your account"). | Directly motivates the configured-wins conflict rule |
| U-R1.3 | Whether any provider listing TBAi talks to exposes `max_output_tokens`. Not verified. | `maxOutputTokens` is therefore populated by nothing today — **UNKNOWN, not filled in** |

Other configured models, same source: `agnes-2.5-flash` 512K; `agnes-2.0-flash`
512K and **vendor-deprecated** (P4, undecided).

---

# 3. Data model

```ts
// src/types/index.ts  (mirrored in web/src/types/index.ts)

export const CONTEXT_WINDOW_SOURCES = ["provider_reported", "configured"] as const;
export type ContextWindowSource = (typeof CONTEXT_WINDOW_SOURCES)[number];

export interface SourcedNumber { readonly value: number; readonly source: ContextWindowSource; }

export function providerReportedLimit(value: number): SourcedNumber;
export function configuredLimit(value: number): SourcedNumber;

export interface ModelOption {
  // …unchanged
  contextWindow?: number;             // value alone carries NO authority
  contextWindowSource?: ContextWindowSource;      // NEW
  maxOutputTokens?: number;                       // NEW
  maxOutputTokensSource?: ContextWindowSource;    // NEW
}
```

**Schema — IMPLEMENTED, backwards compatible.** `modelOptionSchema` gains two
optional enums. Existing rows validate unchanged; the enum rejects
`conservative_default`, `unknown`, and the pre-R1 spelling `model_reported`.
Persisted in the **existing** `provider_configs.models` JSON column — **no schema
migration, no data migration, no new table, no destructive operation.**

**Registry — unchanged.** `loadFromDb` already `JSON.parse`s the column; the new
keys ride along.

**Enforcement shape change.** `LimitSource` is renamed to the canonical four-state
vocabulary (`model_reported` → `provider_reported`, `default` →
`conservative_default`), aligning the code with the Phase 3 input contract in
decision §10. This is a type-level rename; no behaviour change. `ContextLimit`
gained `divergent` and `divergentValue`.

---

# 4. Implementation

| File | Change |
|---|---|
| `src/types/index.ts` | `CONTEXT_WINDOW_SOURCES`, `ContextWindowSource`, `SourcedNumber`, `providerReportedLimit`, `configuredLimit`; `ModelOption` gains `contextWindowSource`, `maxOutputTokens`, `maxOutputTokensSource` |
| `web/src/types/index.ts` | Mirror of the above for the UI's single writer |
| `src/lib/validation.ts` | `contextWindowSourceSchema`; `modelOptionSchema` gains the two optional fields |
| `src/services/modelDiscovery.ts` | Anthropic normalizer reads `max_input_tokens` / `max_output_tokens` **through `providerReportedLimit`**; no stance is emitted when the listing omits a figure |
| `src/context/types.ts` | `LimitSource` renamed to the canonical four states; `ContextLimit.divergent` / `.divergentValue`; new `GenerationCap`; `ContextBudget.generationCap`; `OutputReservation.source` renamed |
| `src/context/limits.ts` | Resolution order + conflict handling + `LEGACY_SOURCE`; `resolveGenerationCap`; `isPhase3ExperimentEligible`; `selectModelOption`; rewritten header documenting R1 |
| `src/context/budget.ts` | `computeBudget` computes `generationCap`; `budgetDiagnostics` adds `phase3ExperimentEligible`, `generationCap*`, `limitDivergent*` |
| `src/context/assemble.ts` | **Wiring** — `selectModelOption(provider.models, modelId)` → `resolveContextLimit({ model })` → `computeBudget({ modelOutputTokens })` |
| `src/routes/chat.ts` | `maxOutputTokens` reads `generationCap.tokens`, not `outputReservation.tokens` |
| `web/src/features/providers/ProviderDialog.tsx` | `commitWindow` writes via `configuredLimit`; unsetting clears the stance too |

### The wiring (was the dead branch)

```ts
// assemble.ts — before: providerType + modelId only, so `model_reported` was
// unreachable dead code and every request resolved to the 128k stand-in.
const limit = resolveContextLimit({ providerType: provider.type, modelId });

// after
const selectedModel = selectModelOption(provider.models, modelId);
const limit = resolveContextLimit({ providerType: provider.type, modelId, model: selectedModel });
const budget = computeBudget({ limit, modelOutputTokens: selectedModel?.maxOutputTokens });
```

**No per-request network discovery. No new discovery service. No new cache. No
provider-specific branch inside `assembleContext`** — verified by grep (§8). The
registry is the only source, which is precisely why `source` can only ever be a
stance someone actually recorded.

---

# 5. Limit resolution behavior

All nine cases required by the task, implemented deterministically:

| Case | Behavior | Source emitted |
|---|---|---|
| No provider value, no configured value | 128 000 stand-in | `conservative_default` |
| No configured value, provider value present | provider value | `provider_reported` |
| No provider value, configured value present | configured value | `configured` |
| Both present, equal | the value | `provider_reported` |
| Both present, conflicting | configured value + loser recorded | `configured`, `divergent: true` |
| Malformed / zero / negative / NaN / Infinity | treated as absent → stand-in | `conservative_default` |
| Fractional value | floored | as stored |
| Provider value unavailable (model not listed) | stand-in | `conservative_default` |
| Unknown model | stand-in, `divergent: false` | `conservative_default` |

**No silent provenance change** — every path's emitted source is asserted by a test.

**Logging.** `describeLimitSource` emits `conservative_default(128000)`, which says
out loud that the number is a stand-in. Divergence keys appear **only** when a
conflict occurred, so the common case carries no extra keys. No secret is logged;
the numeric keys still avoid the substring `token` because
`logger.ts SENSITIVE_KEY_RE` would redact them (unchanged — that is a security
boundary, not a naming preference).

---

# 6. Output reservation / generation cap

**Separated**, with the invariant preserved explicitly. See §1 P3 above.

| Path | `outputReservation` | `generationCap` | `maxOutputTokens` sent |
|---|---|---|---|
| Unknown model (today's only live path) | 4 096 | 4 096 | **4 096** (unchanged) |
| Provider-documented 65 536 output, 512K window | 4 096 | 65 536 | 65 536 |
| Provider-documented 65 536 output, 10k window | 4 096 | < 65 536, `boundedByRemainingWindow: true` | clamped |
| Limit not enforceable | 4 096 | documented or default | never unbounded |

**Precedence:** model-documented ceiling → else default; then always clamped by the
room remaining in the window. **Invariant `usableInput + generationCap <= ceiling`
is asserted across a matrix of ceilings × output figures.**

---

# 7. Phase 3 safety contract

**IMPLEMENTED.** Added to `docs/TBAi-context-subagent-roadmap.md` §3.0.1 and to the
ADR; enforced by `isPhase3ExperimentEligible` and surfaced as
`phase3ExperimentEligible` on every assembled request.

```text
A conservative_default or unknown context ceiling
  MAY     bound safety enforcement
  MUST NOT size a cache prefix / choose a breakpoint / segment an experiment
  MUST NOT claim cache effectiveness or interpret hit/read/write results
```

Only `provider_reported` qualifies. A `configured` figure is this installation's
belief, not a statement by the model.

**Why code rather than prose:** the failure is silent. Measured against the 128k
stand-in while a model documents 512K, a prefix-splitting experiment depresses
observed cache-hit rate and yields a confidently wrong conclusion about whether
caching helps. R1 verified this is a live condition for this install's model.

---

# 8. Tests

**`bun run test` (canonical — plain `bun test` closes the shared `bun:sqlite`
singleton):**

| Suite | Result |
|---|---|
| Full suite | **2 899 pass / 2 skip / 0 fail — 2 901 tests across 229 files** |
| Before R1 (baseline) | 2 853 pass / 2 skip / 0 fail — 228 files |
| Delta | **+46 tests, +1 file** — all additive, none modified in substance |

**New: `src/context/provenance.test.ts` — 46 tests, 0 fail**, covering the eleven
required areas:

| # | Requirement | Representative test |
|---|---|---|
| 1 | `provider_reported` | "reports a provider-stated figure as provider_reported" |
| 2 | `configured` | "reports a human-set figure as configured, never as provider_reported" |
| 3 | `conservative_default` | "reports no figure at all as a conservative stand-in" |
| 4 | `unknown` | resolver-path suite + `enforceable: false` budget test |
| 5 | Conflict | "prefers the operator's figure when the two disagree", "does not report divergence when the two figures agree" |
| 6 | Invalid metadata | "rejects a value that is present but unusable" (0, −1, NaN, Infinity) |
| 7 | Metadata reaches resolver | "enforces a provider-reported limit the seam was never given before" |
| 8 | Correct source per path | whole resolution suite |
| 9 | Reserve vs cap | "raises generation to a provider-documented output ceiling", "keeps input + output within the effective limit" |
| 10 | Phase 3 eligibility | "authorises an experiment only for a provider-reported ceiling" + 4 refusals |
| 11 | Stand-in cannot size an experiment | "refuses to size an experiment from the conservative stand-in" |

Plus: legacy-row labelling, magnitude-not-inferred, writer separation, schema
round-trip, discovery-tagging (fetch-mocked), and the false-rejection correction
("accepts a request the stand-in would have refused").

**Updated (not weakened):** `budget.test.ts` and `assemble.test.ts` — enum renames
only. `assemble.test.ts`'s fixture provider still carries **no `models` array**, so
the unknown path remains the path under test; R1 did not weaken the fixture to make
wiring pass. Verified: wiring broke **zero** existing tests, as predicted.

---

# 9. Live verification

Server started on `:3011` against the real database.

| Check | Result |
|---|---|
| Provider config | `agnes` / `custom` / `agnes-3.0-flash`, 3 models, **0/3 carry `contextWindow`** |
| **Normal request** | **LIVE-VERIFIED** — HTTP 200, 2 468 ms, **75 SSE frames** |
| **Oversized request (4 MB)** | **LIVE-VERIFIED** — **HTTP 400 in 48 ms**, before any provider call |
| Diagnostics on the normal request | `windowLimit=128000`, `limitSource=conservative_default(128000)`, `phase3ExperimentEligible=false`, `outputReserve=4096`, `generationCap=4096`, `generationCapBoundedByWindow=false`, `usableInput=92928`, `enforceable=true`, `decision=accept` |
| Provider invoked on the oversized request? | **No** — rejection is pre-flight |
| `limitDivergent` key | absent (correct — no conflict occurred) |
| Prompt text in diagnostics | absent |

**`generationCap=4096` is the key live datum**: it equals the pre-R1
`outputReservation=4096`, confirming the P3 separation is behaviour-neutral for
every path that currently exists.

### IMPLEMENTED but LIVE-UNVERIFIED

**The `provider_reported` path could not be exercised live.** The installed
configuration has **0/3 models carrying `contextWindow`** — the configured
provider is type `custom`, whose listing endpoint exposes identity only (Phase 1
F14), so discovery has nothing to record.

**Provider configuration was deliberately NOT modified** to manufacture a result,
per the task's instruction and the standing rule that configuration changes require
maintainer authorisation. The result is reported as **IMPLEMENTED but
LIVE-UNVERIFIED** rather than claimed as demonstrated.

Evidence the path is nevertheless exercised: 12 tests drive it end-to-end through
`assembleContext` with fetch-mocked discovery, including the assertion that a
larger provider-reported limit **loosens** the budget and one that the stand-in
would have refused is then **accepted**.

---

# 10. Residual risks

| # | Risk | Status |
|---|---|---|
| **A3** | **Discovery replaces the whole `models` array on save**, so a user's configured window is overwritten rather than contested. Upstream behaviour, unspecified. The conflict rule is therefore rarely exercised — chosen for clarity, not frequency. | **OPEN** — unchanged, out of R1 scope |
| **P1** | **The 128k stand-in still rejects ~76% of the usable window** of a model documented at 512K. The resolver *can* now honour a real limit; this install has no model carrying one. | **OPEN** — product decision |
| **P2** | Whether conversations should be allowed to reach 512K, and what that means for history growth, persistence size, and the Phase 4 compaction trigger. | **OPEN** — product decision |
| **P3** | `maxOutputTokens` is populated by **no verified source** — no confirmed provider listing exposes it. The field exists because the arithmetic needs it; today the cap is always the default. | **UNKNOWN**, honestly recorded |
| **U-R1.1** | "512K" is shorthand; the exact integer is not documented. Not converted to a hardcoded constant. | **UNKNOWN** |
| **U-R1.2** | Entitlement tier may reduce the effective window. Unruled out by documentation. | **UNKNOWN** |
| **P4** | `agnes-2.0-flash` is **vendor-deprecated** and still selectable. | **OPEN** — product decision |
| **Q14** | Legacy rows are labelled `configured`. For a row discovery actually wrote, this **understates** authority: enforcement is unaffected, but Phase 3 eligibility is denied until re-discovery upgrades the stance. Fail-closed by design. | Accepted |
| — | A3-adjacent: nothing prevents a *future* writer from adding a new stance. The enum is the boundary; a new writer must pick one. | Accepted |

---

# 11. Git state

Five clean, logically separated commits (recommended 5-way split). **Nothing
pushed.**

| # | Commit | Scope |
|---|---|---|
| 1 | `docs(context): R1 provenance decision + generation-cap separation` | ADR amendment, decision record §13–15, roadmap §3.0.1 + §2.3 criteria |
| 2 | `feat(context): add limit provenance so a configured figure is never provider-reported` | data model, schema, writers, resolver, wiring |
| 3 | `feat(context): separate input reservation from model generation cap` | `GenerationCap`, `budget.ts`, `chat.ts` |
| 4 | `test(context): cover R1 provenance, conflict resolution and generation-cap invariants` | `provenance.test.ts` + enum renames |
| 5 | `docs(context): R1 implementation report` | this file |

**Scope discipline.** The working tree carries **30 modified and 18 untracked**
files belonging to **other workstreams** (tab reconciliation, OpenCode V2, devtools,
e2e helpers, `scripts/`). **None was staged or committed.** Each commit was
verified with `git status` + diff review against the intended path list.

---

# 12. Phase 3 readiness

Assessed against the six conditions in the task.

| Condition | Met? | Evidence |
|---|---|---|
| Provenance is explicit and truthful | ✅ | Four-state `LimitSource`; only two storable stances; writers go through helpers so a user value cannot be `provider_reported`; legacy rows fail closed |
| Limit resolution is deterministic | ✅ | Four documented rules, order-fixed, matrix-tested including conflicts and invalid metadata |
| No unknown/default limit treated as cache-sizing truth | ✅ | `isPhase3ExperimentEligible` returns false for `conservative_default`, `configured`, `unknown`, legacy, and conflicted; `phase3ExperimentEligible` emitted per request |
| Output reserve semantics explicit | ✅ | Reservation and cap separated; invariant `usableInput + generationCap <= ceiling` asserted |
| Phase 2 tests green | ✅ | 2 899 pass / 2 skip / 0 fail; typecheck exit 0 (backend + web); build exit 0 |
| Documentation reflects reality | ✅ | Decision §13–15, ADR amendment, roadmap §3.0.1, this report |

# Phase 3: READY

All six conditions hold.

**Two honest qualifications, neither of which blocks starting Phase 3:**

1. **No run in this installation is currently eligible for a sizing-dependent
   cache experiment**, because 0/3 configured models carry a provider-reported
   limit. Phase 3's §3.2 capability table, deterministic-ordering verification, and
   the two-request write-then-read protocol are **unaffected and can begin
   immediately**. Any experiment that sizes a prefix against the window requires a
   model with `provider_reported` provenance first — which is exactly what the
   eligibility check now refuses to let happen silently.
2. **P1/P2 remain open product decisions.** They bound the ceiling, not the
   provenance machinery. Phase 3 can proceed without them; a sizing experiment
   against a 128k window would simply be measuring the wrong thing, which the new
   rule prevents it from doing silently.

---

# Decision Table

| Question | Resolution | State |
|---|---|---|
| **Provider vs configured provenance** | Option 1 — additive `contextWindowSource`; two writer helpers make a user value structurally unable to be labelled `provider_reported`; legacy rows fail closed to `configured` | **IMPLEMENTED, VERIFIED** |
| **Exact model limit** | Vendor-documented **512K** context, **65 536** output at the **exact configured endpoint** (Base URL matches character for character); "512K" exact integer **UNKNOWN** and not hardcoded | **VERIFIED** (external) |
| **128k behaviour** | Unchanged at 128 000 — not a safety calibration, an assumption. Still rejects ~76% of the usable window for a documented 512K model | **OPEN — product decision P1/P2** |
| **Schema / data-model treatment** | Additive optional fields in the existing JSON column; **no migration, non-destructive**; ~40 frontend read sites untouched | **IMPLEMENTED, VERIFIED** |
| **Output reserve vs generation cap** | Separated. Cap = min(documented ceiling, remaining window); default unchanged at 4 096, so today's behaviour is bit-identical | **IMPLEMENTED, VERIFIED, LIVE-VERIFIED** |
| **Phase 3 dependency** | Not a hard blocker. The binding rule and `isPhase3ExperimentEligible` are in place; eligibility is emitted per request | **READY** |

---

R1 decision and implementation complete. Phase 3 was not started.