# TBAi — Minimal, Stable Model Capability Integration

**Status:** Architecture audit + implementation proposal. No source, test, dependency,
database or configuration change is part of this document.
**Audit baseline:** branch `ci/tauri-e2e-verify`, HEAD `8e07e1d`.
**Catalogue snapshot:** `https://models.dev/api.json` fetched 2026-11-03.

Scope: use Models.dev as the external source of model/provider capability metadata.
Audit what it actually provides, reuse TBAi's existing capability pipeline, and propose
the smallest integration that does not replace the provider adapters.

Non-negotiables carried from the brief: unknown stays unknown; no invented
capabilities; no pricing/benchmark/marketplace data; no new database tables,
migrations or dependencies; TBAi must keep working with the catalogue unavailable.

---

## 1. What Models.dev already gives us

Repository: `anomalyco/models.dev` — MIT, default branch `dev`, last push 2026-11-03.

### 1.1 Endpoints

| Endpoint | Size | Shape | Usable for capability work |
|---|---|---|---|
| `https://models.dev/api.json` | 5,962,647 B (**608,603 B gzip**) | `{ providerId: { id, env[], npm, api?, name, doc, models{} } }` | Yes — the only source of `reasoning_options` |
| `https://models.dev/models.json` | 506,241 B | 607 provider-agnostic canonical models | **No** — has `reasoning`, `attachment`, `limit`, `modalities`, but **zero** `reasoning_options` and no `structured_output` |
| `https://models.dev/catalog.json` | 6,468,912 B | providers + canonical models | Redundant with `api.json` |
| `https://models.dev/model-schema.json` | — | an *enum of model ids*, not a structural schema | No |

`api.json` is `{ providerId: Provider }` with **235 providers / 8,935 models** and no
top-level metadata: every top-level key is a provider id, so there is no `version` and
no `generatedAt`. Caching is `Cache-Control: public, max-age=0, must-revalidate` plus a
strong ETag; `If-None-Match` returns **304 with 0 bytes**, so revalidation is cheap.

### 1.2 Field coverage (all 8,935 models)

| Field | Present | Notes |
|---|---|---|
| `reasoning` | 8,935 | boolean, required by the schema. `true` on 6,848 |
| `reasoning_options` | 6,848 | array; **non-empty on 5,713**, empty `[]` on 1,135 |
| `tool_call` | 8,935 | boolean, 7,890 true |
| `attachment` | 8,935 | boolean, 5,794 true |
| `modalities{input,output}` | 8,935 | `text` 8,895 / `image` 5,658 / `pdf` 2,368 / `video` 1,653 / `audio` 805 |
| `structured_output` | 6,792 | boolean, 5,520 true / 1,272 false; absent on 2,143 |
| `limit{context,output}` | 8,935 | context 8,776, output 8,676 |
| `interleaved` | 1,343 | `{field:"reasoning_content"}` 1,147, `{field:"reasoning_details"}` 94, `true` 102 |
| `cost` | 8,538 | out of scope, never read |
| `canonical_model_id` | 7,617 | link to `models.json` |
| `status` | 968 | `deprecated` 893, `beta` 74, `alpha` 1 |

### 1.3 `reasoning_options` is real and typed

```
{ type: "effort",        values: [...] }   4,589 models
{ type: "toggle"                         }   1,427 models
{ type: "budget_tokens", min?, max?      }     609 models
                                             830 models carry 2+ options
```

Effort values in use: `high` 4,431, `low` 4,011, `medium` 3,407, `max` 2,219,
`none` 1,831, `xhigh` 1,824, `minimal` 697, `default` 2.

Budget options carry real bounds: `1024|undefined` 162, `128|32768` 58, `1024|63999` 33,
`1024|31999` 10, `1|131072` 5. `min: -1` means dynamic/unbounded.

The authoritative types are in the SDK source, `packages/sdk/src/types.ts:19-40`:

```ts
export interface ReasoningOptionToggle       { type: "toggle" }
export interface ReasoningOptionEffort       { type: "effort"; values: ReasoningEffort[] }
export interface ReasoningOptionBudgetTokens { type: "budget_tokens"; min?: number; max?: number }
```

Two semantics are load-bearing and easy to get wrong:

- `reasoning_options: []` means **"reasoning supported, no declared control dial"**.
  The v1 schema only requires `reasoning_options !== undefined` when
  `reasoning === true` (`packages/core/src/schema.ts:320-324`), and an empty array
  satisfies that. It is *not* "no reasoning".
- `reasoning: false` is an explicit **unsupported**, and `reasoning` is never absent.
  This maps directly onto TBAi's three-state `CapabilitySupport` with no interpretation.

### 1.4 Provider-scoped vs canonical

Provider files own reasoning controls ("Reasoning controls, `structured_output`, cache,
and service tiers are per host and go in provider files" — README), which is why
`models.json` has none. Coverage for TBAi's built-in provider types:

| TBAi type | Catalogue provider | Models | With reasoning options |
|---|---|---|---|
| `openai` | `openai` | 51 | 33 |
| `anthropic` | `anthropic` | 17 | 17 |
| `google` | `google` | 36 | 23 (+5 empty) |
| `ollama` | **absent** | — | — |

There is no `ollama` provider. The nearest entries are `ollama-cloud`
(`api: https://ollama.com/v1`) and `lmstudio` (`api: http://127.0.0.1:1234/v1`), neither
of which describes a user's local daemon or its installed tags.

225 of 235 providers declare an AI SDK `npm` package; 210 declare an `api` base URL.
788 models carry a per-model `provider` override (`npm`/`api`/`shape`), so the catalogue
is endpoint-aware at model granularity.

### 1.5 Maintenance, licensing, SDK

- **Licence:** MIT for code and data.
- **Update cadence:** `.github/workflows/sync-models.yml` runs **hourly**
  (`cron: "17 * * * *"`), syncs provider data, validates and commits to `dev`.
  `deploy.yml` redeploys the site on push; `validate.yml` runs on push to `dev`.
- **Official client:** `@opencode-ai/models` — **0.0.124**, first published
  2026-07-03 (**124 releases in ~4 months**), published daily at 05:23 UTC.
  7.38 MB unpacked / 33 files, optional peer `effect@4.0.0-beta.83`. By its own doc
  comment, *"Every method performs exactly one `GET` and nothing is ever cached."*
  It does expose a `./snapshot` entrypoint (bundled catalogue + `generatedAt`).

### 1.6 What TBAi can consume directly

| Field | Consumable now | Reason |
|---|---|---|
| `reasoning` | Yes → `ReasoningCapability.support` | Explicit three-state mapping |
| `reasoning_options[]` | Yes → `levels`, dial kind, budget bounds | Typed and provider-scoped |
| `tool_call` | Yes → `toolCall` support | Explicit boolean, real consumer exists |
| `attachment` / `modalities` | No | No attachment surface in `web/src` |
| `structured_output` | No | No `generateObject`/`streamObject` in `src/` |
| `interleaved` | Not in V1 | Valuable: 1,147 models declare `reasoning_content`, exactly the quirk documented at `src/services/ai.ts:55-77` |
| `limit` | No | Conflicts with the two-writer provenance contract (§2.3) |
| `cost`, `benchmarks` | Never | Out of scope |

---

## 2. What existing TBAi functionality can be reused

Baseline HEAD `8e07e1d`. Working tree at audit time held only pre-existing
`bun.lock` / `package.json` modifications plus the untracked earlier plan document.

### 2.1 Reused as-is

| Existing piece | Reuse |
|---|---|
| `src/services/modelDiscovery.ts:259` `discoverModels` | The single capability producer. One post-processing hook enriches every provider branch — no per-provider edits. |
| `src/services/capabilityDiscovery.ts:22` | Already declares the provenance vocabulary: *"A value from a third-party catalogue would be `model_catalog`"*. The intent is recorded; only the source is missing. |
| `src/types/index.ts:13` `ReasoningCapability`, `:24` `ModelCapabilities`, `:119` on `ModelOption` | Exactly the right shape. `support` takes the three-state stance; `levels?: string[]` already exists for opaque source-provided mode ids. |
| `src/lib/validation.ts:10-17`, `:40` | Zod boundary already validates persisted `capabilities`. |
| `ModelOption` storage | Lives inside the provider's existing `models` JSON column (`src/routes/providers.ts:239`), re-derived on each discovery pass. **No table, no migration, no schema change.** |
| `GET /api/providers` (`src/routes/providers.ts:34`) | The UI already receives `models[]` including `capabilities` — no new endpoint. |
| `src/services/ai.ts` provider adapters | Untouched. They own request construction; the catalogue is metadata only. |
| `src/routes/chat/provider-options.ts:91` | Stays the only place a reasoning wire option is built; it gains one guard. |

### 2.2 Existing gaps the audit found

- `ModelCapabilities` is **produced and persisted but never read** by product code.
  The only `capabilities.reasoning` readers are tests
  (`tests/unit/services/modelCapabilities.test.ts`). Adding metadata without a
  consumer changes nothing user-visible.
- The reasoning mapper has **no test**: `buildReasoningProviderOptions` is not
  referenced from `tests/`.
- The scheduler duplicates the mapper at
  `src/services/scheduler/schedulerExecution.ts:201-217`, and the copy has already
  diverged: it writes the `openai` namespace for `custom` chat-completions providers
  and omits Google's `includeThoughts`.
- Discovery returns `unknown` reasoning for OpenAI, Anthropic and Google
  (`src/services/modelDiscovery.ts:197`, `:222`, `:244`). Only Ollama reports a stance,
  from the `/api/show` `capabilities` token list (`:116-119`).

### 2.3 Decision: context/output limits are audited but not integrated

Provider listings already supply limits as `provider_reported`
(`src/services/capabilityDiscovery.ts:37-54`). The resolver has exactly two storable
writers and a documented arbitration in which `configured` beats `provider_reported` on
conflict (`src/context/types.ts:98`, `src/context/limits.ts:278-300`). Introducing a
weaker third authority means rewriting that arbitration — the redesign this task rules
out.

The catalogue's limits are also demonstrably dirty in this repository already:
`src/context/tier2.ts:36` records `99,999,999` sentinels, `5,000,000` / `10,000,000`
artifacts, and one model recorded 7.6× apart by two providers.

### 2.4 Decision: modality and structured-output fields are not imported

`web/src` has no attachment surface (no `accept=`, no file-attachment component), and
`src/` contains no `generateObject`/`streamObject`. Adding fields with no consumer is
precisely the speculative capability the brief prohibits.

---

## 3. What minimal additions are necessary

### 3.1 One new module

`src/services/modelCatalogue.ts` (owner: `services/`, external metadata + merge policy).

```ts
type CatalogueReasoningOption =
  | { type: "effort"; values: string[] }                   // → levels
  | { type: "toggle" }                                     // → booleanControl
  | { type: "budget_tokens"; min?: number; max?: number }; // → min/max tokens

interface CatalogueEntry {
  reasoning: boolean;                 // explicit, never absent
  reasoningOptions: CatalogueReasoningOption[];
  toolCall: boolean;
}

catalogueEntryFor(provider: ProviderConfig, modelId: string): CatalogueEntry | undefined;
mergeCapabilities(
  reported: ModelCapabilities | undefined,
  entry: CatalogueEntry | undefined,
): ModelCapabilities;
resolveModelCapabilities(provider: ProviderConfig, modelId: string): ModelCapabilities;
```

**Join rule (fail-closed).** `provider.type` maps to `{ openai: "openai",
anthropic: "anthropic", google: "google" }`. There is no entry when the provider has a
custom `endpoint` (it is then not necessarily that vendor), when `type` is `ollama` or
`custom`, or when no **exact** model id matches. No fuzzy matching, no name heuristics.

**Precedence.** Provider-reported stance wins unless it is `"unknown"`; then the
catalogue stance applies; if both are unknown, `"unknown"`. The same rule applies
independently to `toolCall`. Catalogue `levels` fill `levels` only when the provider
reported none.

**Network.** `refreshCatalogue()` only, and only from an explicit **discovery-time**
action: 24 h TTL, strong ETag revalidation (304 → keep snapshot), 3 s hard timeout, and
any failure leaves the previous snapshot or `undefined`. It stores only
`{provider: {model: CatalogueEntry}}` for the eligible providers — `cost`, `benchmarks`,
descriptions, families and logos are never retained.

### 3.2 One type extension, mirrored in three places

`ModelCapabilities.toolCall?: CapabilitySupport` in

- `src/types/index.ts:24`
- `web/src/types/index.ts:8`
- `src/lib/validation.ts:15` (`modelCapabilitiesSchema`)

`ReasoningCapability` is **not** changed. `levels` already exists and already carries
exactly this meaning ("opaque source-provided thinking mode identifiers").

### 3.3 Resolver consumers

| File | Change |
|---|---|
| `src/services/modelDiscovery.ts:259` | after the provider fetch, enrich the returned `ModelOption[]` via `mergeCapabilities` (one hook, not four branches) |
| `src/routes/chat/validate-and-resolve.ts:213` | pass `resolveModelCapabilities(provider, modelConfig.model)` into the builder |
| `src/routes/chat/provider-options.ts:91` | if `reasoning.support === "unsupported"` → return `{}`; otherwise unchanged |
| `src/routes/chat/assemble-run.ts:326` | skip `buildToolsContext` when `toolCall === "unsupported"`; `unknown` keeps today's behaviour |
| `src/services/scheduler/schedulerExecution.ts:201-217` | delete the duplicate mapping; call `buildReasoningProviderOptions(provider, job.modelId, thinking)` |
| `web/src/components/composer/DirectChips.tsx:28` | disable the four levels with honest copy when the selected model reports `support === "unsupported"` |

### 3.4 Explicitly not added

- No new database table or migration.
- No new dependency.
- No second chat runtime, no report/notice system.
- No level-clamping and no expansion of the `off | low | medium | high` vocabulary
  (`src/lib/validation.ts:56`).
- No change to `ProviderConfig.thinking`.
- No pricing, benchmarks, cost or marketplace code.

### 3.5 `levels` is recorded but not acted on in V1

`effort` values are a provider vocabulary (`minimal`, `xhigh`, `max`, `none`), while
TBAi's four levels are a UI vocabulary. Mapping between them is exactly the
per-provider redesign the brief forbids, and `buildReasoningProviderOptions` already owns
the wire mapping. V1 uses the catalogue for two unambiguous facts only: *does this model
reason at all* and *can it call tools*. Both are booleans that cannot be over-interpreted.

---

## 4. Recommended integration approach, and why

**Consume `https://models.dev/api.json` directly, behind the module in §3, with ETag
revalidation and a 24 h TTL. No SDK, no vendored snapshot, no ingestion pipeline.**

| Option | Verdict | Reason |
|---|---|---|
| Official SDK `@opencode-ai/models` | **Rejected** | 0.0.124 with 124 releases in four months and daily publishes — no compatibility promise. +7.38 MB unpacked for a typed 3.6 kB client that *"nothing is ever cached"*. Drags an optional `effect@4.0.0-beta.83` peer into the graph. AGENTS.md requires a clear reason for a dependency; this buys roughly 60 lines of `fetch` + Zod. |
| Direct generated JSON | **Chosen** | Zero dependencies, zero build steps, always current, ETag gives cheap 304s, and gzip makes the payload ~0.6 MB. A narrow Zod schema over `providers[id].models[id].{reasoning, reasoning_options, tool_call}` with a passthrough object means catalogue evolution cannot break TBAi. |
| Versioned local snapshot | **Rejected for V1** | The catalogue changes hourly; a snapshot is stale on day one, and keeping it fresh means either a custom ingestion script (the ingestion platform the brief forbids) or an upgrade treadmill on a 0.0.x dependency. It can be added later for air-gapped installs behind the same module boundary — the interface does not change. |

**The architecture stays independent of Models.dev.** Network access is confined to one
function, called only from explicit discovery. The request path
(`resolveModelCapabilities`) is synchronous and reads persisted `ModelOption.capabilities`
only. If models.dev is unreachable, slow, or returns garbage, every lookup is
`undefined`, every capability stays `"unknown"`, and Chat, Scheduler, Ollama and custom
endpoints behave exactly as they do at `8e07e1d`.

Provider adapters remain the only authority on request construction. The catalogue never
builds `providerOptions`.

---

## 5. Exact implementation phases

### Phase 0 — decision record

One entry in `docs/decisions.md` stating the source, the field-level precedence, the
fail-closed join, and why limits are excluded. Required by AGENTS.md for a new external
architectural input.

### Phase 1 — catalogue + merge, no behaviour change yet

- Create `src/services/modelCatalogue.ts`.
- Edit `src/services/modelDiscovery.ts:259` (single enrichment hook).
- Edit `src/types/index.ts:24`, `web/src/types/index.ts:8`,
  `src/lib/validation.ts:15` (`toolCall`).
- Tests:
  - new `tests/unit/services/modelCatalogue.test.ts` — join excludes `ollama`, `custom`
    and custom-endpoint providers; provider stance beats catalogue stance; catalogue
    fills an `unknown` stance; `reasoning:false` → `unsupported`;
    `reasoning_options: []` → `supported` with no levels; malformed payload, 500,
    timeout and 304 all leave the previous snapshot and never throw; no `cost` is
    retained in the stored snapshot.
  - extend `tests/unit/services/modelCapabilities.test.ts` — `toolCall` round-trips and
    `unknown` survives persistence.

**Acceptance:** with the network blocked, `discoverModels` returns byte-identical
capability output to HEAD.

### Phase 2 — shared resolver + consumers

- Add `resolveModelCapabilities` to the same module.
- Edit `src/routes/chat/provider-options.ts:91`,
  `src/routes/chat/validate-and-resolve.ts:213`,
  `src/routes/chat/assemble-run.ts:326`,
  `src/services/scheduler/schedulerExecution.ts:201-217`.
- Tests:
  - new `tests/unit/chat/reasoningProviderOptions.test.ts` — `unsupported` → `{}`;
    `unknown` → unchanged output for all five provider types; the namespace is still
    correct for chat-completions gateways.
  - new `tests/unit/scheduler/schedulerReasoningOptions.test.ts` — scheduler output is
    identical to the chat builder for the same input, including Google
    `includeThoughts` and the custom namespace.

**Acceptance:** the parity test fails if `schedulerExecution.ts` reintroduces its own
table.

### Phase 3 — UI honesty

- Edit `web/src/components/composer/DirectChips.tsx:28` only; no new surface.
- Test: new `tests/dom/components/directChipsReasoning.test.tsx` — an unsupported model
  disables all four options and the default label; `unknown` keeps them enabled.

**Acceptance:** the flow is walked in a browser. Select a catalogue-unsupported model,
open the reasoning chip, confirm it cannot be changed and says why. Select a local Ollama
model, confirm the chip is unchanged.

Five test files total: three new suites, one new module's coverage, one extension.

---

## 6. Risks and what Models.dev does not cover

1. **Local Ollama and custom endpoints are outside the catalogue.** There is no `ollama`
   provider (only `ollama-cloud` on `ollama.com`) and no way to identify an arbitrary
   `custom` endpoint without guessing. Those keep working on provider-reported data and
   stay `unknown` — correct and honest, but it means the benefit is uneven: strong for
   OpenAI/Anthropic/Google, nil for local models.
2. **Metadata is not runtime support.** A model listed with `reasoning_options` may
   reject the parameter on a given endpoint; a model without options may still think.
   V1 only ever withholds an option, never adds one — but `supported` must not be read as
   a guarantee.
3. **The catalogue does not encode wire shape.** `effort` / `toggle` / `budget_tokens`
   say what dials exist, not which AI SDK option carries them. TBAi's provider adapters
   remain the only authority; this is why the catalogue must never build
   `providerOptions`.
4. **No version, no SLA.** `api.json` carries no version or generation timestamp (only
   an ETag), changes hourly, and two installations can legitimately hold different
   snapshots. Diagnostics must log ETag, `fetchedAt` and provider/model counts rather
   than assume identity.
5. **Model-id drift.** Dated snapshots, aliases and tag suffixes
   (`claude-haiku-4-5-20251001`, `deepseek-v4.1-flash:1017`) will miss the catalogue.
   Exact-match-or-unknown is the rule; a fuzzy match would invent a capability.
6. **`reasoning_options: []` is ambiguous to a human reader but not to the schema.** It
   means "supported, undialable". Code that treats an empty array as unsupported
   reproduces the exact defect this work exists to avoid.
7. **Fields available but unused today:** vision/audio/video and `structured_output`
   have no TBAi consumer; `interleaved.field` (1,147 models declare `reasoning_content`)
   is machine-readable evidence for the streaming quirk documented at
   `src/services/ai.ts:55-77` and is the best next consumer; `limit` is available but
   conflicts with the existing two-writer provenance contract.
8. **Licensing and attribution.** MIT permits reuse. The module header should record the
   source URL, the MIT terms, and the fact that only factual capability fields are
   retained.
