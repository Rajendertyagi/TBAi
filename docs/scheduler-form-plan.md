# TBAi Shared AI Capability & Configuration Layer — Corrected Architecture Plan

**Status:** revision 3 (review corrections to §3–§9). **No implementation performed.**
**Scope of this document:** `scheduler-form-plan.md` only.

Revision 3 answers six review findings plus the Anthropic deferral. It is a targeted
correction of §3–§9 only; §1–§2 and §10 remain as revision 2 except where a correction
is recorded in §1.1. Two revision-2 statements are withdrawn as unsupported (§3.1) and
one is corrected as an undercount (§2.7, §6.3). Every new claim below is anchored to a
file and line in `node_modules`, a verbatim provider-doc sentence fetched on 2026-11-03,
or a line in this repository at `8e07e1d`.

---

## 0. Audit record

| Item | Value |
|---|---|
| Branch inspected | `ci/tauri-e2e-verify` (local and `remotes/origin/ci/tauri-e2e-verify`) |
| Commit inspected | `8e07e1da900b5df634e975b8aa5f50560167c69b` (`8e07e1d`) |
| Local HEAD | `8e07e1d` — identical to the audited commit |
| Working tree | `bun.lock` and `package.json` modified (pre-existing, unrelated, untouched) |
| Source changes made | none |
| Commits / pushes made | none |

### Files read at the audited commit

Backend:
- `src/services/modelDiscovery.ts` (11,633 bytes)
- `src/services/capabilityDiscovery.ts` (7,611 bytes)
- `src/routes/providers.ts`
- `src/routes/chat/provider-options.ts` (4,946 bytes)
- `src/routes/chat/validate-and-resolve.ts` (9,958 bytes)
- `src/services/scheduler/schedulerExecution.ts` (22,482 bytes)
- `src/services/scheduler/schedulerValidation.ts` (5,936 bytes)
- `src/services/scheduler/schedulerTypes.ts`
- `src/services/ai.ts` (5,496 bytes)
- `src/types/index.ts`
- `src/lib/validation.ts`
- `src/services/opencode/capabilities.ts`
- `src/services/opencode/sessions.ts`
- `src/services/opencode/scheduledExecution.ts`

Frontend:
- `web/src/types/index.ts`
- `web/src/features/providers/ProviderDialog.tsx`
- `web/src/features/scheduler/SchedulerPage.tsx`
- `web/src/components/composer/DirectChips.tsx`

Installed SDK type definitions (versions verified from `node_modules/*/package.json`):
- `@ai-sdk/openai` 4.0.97 — `dist/index.d.ts`
- `@ai-sdk/anthropic` 4.0.83 — `dist/index.d.ts` **and `dist/index.js`** (revision 3 reads the
  runtime build, not only the types, because the request-level option path and the
  warning behaviour are both decided there)
- `@ai-sdk/google` 4.0.100 — `dist/index.d.ts`
- `ai` 7.0.145 — `dist/index.d.ts` (revision 3: the `warnings` surface on `StepResult`
  and on the `streamText` result)

Additional files read for revision 3 (all at `8e07e1d`):
- `src/routes/chat/model.ts` — the authoritative chat resolution order (§4.6)
- `src/routes/chat/validate-and-resolve.ts:210` — where the reasoning default is applied
- `src/services/scheduler/schedulerValidation.ts:65-120` — the engine guard (§8.4)
- `web/src/features/scheduler/components/JobEditor.tsx:135,888,957` — conversation typing and filtering (§8.4)
- `src/db/index.ts:603,633` — `scheduler_jobs` / `scheduler_runs` columns
- `src/lib/validation.ts:10-13,56,77,167,206,560,619,672` — capability + selection schemas

### Official documentation checked

- https://docs.ollama.com/capabilities/thinking (fetched 2026-11-03 as markdown; quoted verbatim in §3.1)
- https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx (fetched 2026-11-03; §3.1 line 253 quoted verbatim)
- https://ai.google.dev/gemini-api/docs/openai (fetched 2026-11-03; the effort→level/budget table and the disable rule quoted verbatim in §7.3)
- https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking

---

## 1. Corrections to the previous revision

The previous revision contained factual errors that invalidated parts of its design. Each is corrected here.

| # | Previous claim | Verified fact | Correction |
|---|---|---|---|
| 1 | "`src/services/modelDiscovery.ts` and `src/services/capabilityDiscovery.ts` do NOT exist. Model discovery is in `src/routes/providers.ts` and `src/services/ai.ts`." | Both files exist at `8e07e1d`. `git ls-files` lists both, plus `tests/unit/services/capabilityDiscovery.test.ts`. `src/routes/providers.ts:10` is `import { discoverModels } from "../services/modelDiscovery";`. | Claim withdrawn. Discovery is a real, tested subsystem. Any design that assumed it was absent was designed against a fiction. |
| 2 | "Ollama: Omit (no thinking support in scheduler execution…)" | Ollama documents model-specific thinking metadata (`thinking.values`, `thinking.default`) via `/api/show`, and `reasoning_effort` / `reasoning.effort` on `/v1/chat/completions`. | Ollama is a first-class reasoning provider. It must not be omitted. See §3. |
| 3 | "No provider exposes model-specific reasoning levels via discovery." | Ollama does, via `/api/show`. TBAi simply does not read it. | The gap is in TBAi's parser, not in the providers. |
| 4 | Frontend resolver returns `["off","low","medium","high"]` when support is `unknown`. | This presents four levels as if the model supported them. | Forbidden. Unknown must not render as supported. See §4. |
| 5 | `isReasoningSupported` returns `support !== "unsupported"` (so `unknown` ⇒ true). | Collapses the three-state contract. | Forbidden. `unknown` is not `supported`. See §4. |
| 6 | `resolveDirectDefaults` falls back to `providers[0]`. | Silently binds a job to a provider the user did not select. | Forbidden. Unresolvable active provider returns `ok: false`. See §4. |
| 7 | `resolveOpenCodeDefaults` falls back to `capabilities.models[0]?.id`. | Silently picks the first model when the server advertises no default. | Forbidden. Return `null` and require explicit selection. See §4. |
| 8 | Shared backend adapter = a wrapper importing `buildReasoningProviderOptions` from `src/routes/chat/provider-options.ts`. | Leaves the implementation inside a route module and leaves Scheduler's duplicate in place. | The implementation moves to `src/services/ai-capabilities.ts`; both consumers import it. See §5. |
| 9 | "Chat: keep `ReasoningLevel` as 4-level union. Scheduler: widen to `string`." | Produces two divergent contracts for one concept, and an unrestricted string on the Scheduler side. | One validated contract across all seven layers. See §6. |
| 10 | `validateThinkingLevel` returns `true` when `levels` is empty ("unknown → allow"). | Treats absence of metadata as permission. | Forbidden. See §6. |
| 11 | Scheduler mapping hardcodes `providerOptions.openai`. | `providerOptionsNamespace()` returns `openaiCompatible` for `ollama` and for chat-completions `custom`/`openai`. The hardcoded key means those providers never receive the option. | Use `providerOptionsNamespace()` and `resolveApiProtocol()`. See §5. |
| 12 | `ReasoningCapability.levels?: string[]` described as the only capability field. | Accurate, but the previous revision never used it for Ollama, the one provider that actually populates it. | Ollama discovery must populate `levels` and a model default. See §3. |

### 1.1 Revision 3 corrections

Review findings, each verified against disk or the provider doc before being accepted or
rejected. One review claim is **not** supported by the docs and is corrected differently
than requested (row 13).

| # | Revision-2 statement | Verified fact | Correction |
|---|---|---|---|
| 13 | (Review) "Ollama documents `thinking.default` as either a boolean or a string." | The doc documents **`values`** as "booleans (`true` or `false`) for on/off controls. It can also contain model-defined strings". `default` is documented only as "used when `think` is not set", with a single string example (`"medium"`). No boolean `default` appears in the doc. | The requested widening to `string \| boolean` is **adopted for the parser** — a boolean `default` must not be discarded as malformed — but it is recorded as an inference from the `think` value domain, not as a documented sentence. See §3.1, §3.2. |
| 14 | `ReasoningSelection` = `{off} \| {default} \| {none} \| {level}`. | A boolean-control model whose `thinking.default` is `false` cannot be switched **on**: `off`/`default`/`none`/named levels give no "enabled" value, and §3.4 rule 2 ("map any enabled level to `true`") presumes levels that by definition do not exist. | Add `{ kind: "enabled" }`. See §6.1, §6.2. |
| 15 | "`off` explicitly disables reasoning" + "Both send no reasoning option". | Contradiction, and provider docs show why it matters: Google — "Reasoning cannot be turned off for Gemini 2.5 Pro or 3 models"; Anthropic SDK 4.0.83 emits `thinking cannot be disabled for ${modelId}; it always uses adaptive thinking` and **drops the setting**. | `off` becomes provider-specific: send the provider's disable value where one is documented, otherwise send nothing **and report the limitation**. Omission is never reported as success. See §6.1, §7.0, §5.2. |
| 16 | Gemini 2.5 budgets 1024/4096/8192 labelled "documented". | Google's published OpenAI-compat mapping is `minimal`→1,024, `low`→1,024, `medium`→**8,192**, `high`→**24,576**. | Relabel 1024/4096/8192 as **TBAi heuristics**, keep Google's table beside them, and state that they are not Google's conversion. See §7.3. |
| 17 | §8.1: `ThinkingLevel` becomes `"off" \| "default" \| "none" \| string`. | In TypeScript that union reduces to `string` — no compile-time restriction, which §6.2 rule 6 forbids. No encode/decode was defined for the "scalar string" persistence form either. | One branded-free, injective scheme: object union internally, `"level:<value>"` prefixed wire form, with `encodeReasoningSelection` / `decodeReasoningSelection` in exactly one module per tree. See §6.2a, §6.5. |
| 18 | Model-reported default outranks the configured provider default (`selected → modelDefault → providerDefault → "off"`). | Today's verified order is one-shot request → conversation → `provider.thinking` → `"off"`; the model default is not consulted at all (`src/routes/chat/model.ts:54`, `:86`, then `validate-and-resolve.ts:210`). | Provider default outranks model default; the model default is used only when nothing is configured, and is always displayed as such. See §4.6. |
| 19 | "`src/lib/validation.ts` — Six sites (56, 167, 206, 560, 619, 672)." | There are **seven** enum sites; line 77 (`providerCreateSchema.thinking`) was missed, and `reasoningCapabilitySchema` (lines 10-13) declares only `support` + `levels`, so the new capability fields would be stripped by validation. | Seven sites, plus capability-schema extension with combination validation and a discovery→API→save→reload round-trip test. See §6.3, §6.6, §8.1, §9.5, §9.6. |
| 20 | §11 issue 1 — "the exact SDK option path for adaptive effort must be confirmed at implementation time". | It is now confirmed against the pinned build. `anthropicLanguageModelOptions` declares request-level `effort` (enum `low/medium/high/xhigh/max`) beside `thinking`; `dist/index.js:3781` writes `output_config: { effort … }`. | §11 issue 1 withdrawn. §7.2 rewritten with the resolved path, the per-model restriction table copied from the SDK's own doc comments, and the one thing the SDK does **not** expose publicly. |
| 21 | (Review) "Include both server-side engine guards and frontend engine-aware filtering." | Confirmed, and worse than described: `checkExistingThread` checks engine mismatch **only inside** the `engine === "opencode"` branch (`schedulerValidation.ts:90-93`) — a Direct job targeting an OpenCode conversation is not rejected. `JobEditor.tsx:135` types conversations as `{id,title}` only, and `:957` reaches the engine anyway through `(c as any).engine`; the Direct selector at `:888` lists **all** conversations unfiltered. | Both directions enforced server-side; `engine` added to the prop type and the `as any` removed; Direct filters to non-OpenCode conversations. See §8.4, §9.11 (case 61) and §9.12 (case 62). |

---

## 2. Corrected source audit

### 2.1 Discovery subsystem (exists)

`src/services/capabilityDiscovery.ts` exports:
- `CONTEXT_LIMIT_FIELDS`, `OUTPUT_LIMIT_FIELDS` — API field names, read defensively in order.
- `validTokenCount(value)` — rejects NaN/Infinity/≤0.
- `LIMIT_EXTRACTION_RULES`, `limitRuleFor(providerType)` — per-provider *shape* rules only (`ollama: { wrappers: ["model_info","parameters"] }`, `custom: { wrappers: ["top_provider","limits"] }`).
- `extractCapabilities(entry, rule)` — returns limits with the source field recorded.
- `extractOllamaModelInfoLimits(modelInfo)` — suffix matching on `.context_length`, `.max_input_tokens`, `.max_tokens`.

The module's own header states the governing rule: it reads **structural** metadata and must never infer a capability from a model name.

`src/services/modelDiscovery.ts` exports `discoverModels(input)` and normalizes per provider:
- `normalizeOpenAI`, `normalizeAnthropic`, `normalizeGoogle` — each sets `capabilities: unknownReasoning()` (i.e. `{ reasoning: { support: "unknown" } }`) and extracts limits only.
- `normalizeOllama` + `fetchOllamaModel` — the only place reasoning is reported at all.

### 2.2 The actual Ollama reasoning gap

`fetchOllamaModel` (modelDiscovery.ts:104-124) reads the `capabilities` array and nothing else:

```ts
const caps = raw?.capabilities;
const capabilities =
  Array.isArray(caps) && caps.some((c) => c === "thinking")
    ? { reasoning: { support: "supported" as const } }
    : unknownReasoning();
```

Consequences, all verified:
- `thinking.values` is never read, so named levels are never discovered.
- `thinking.default` is never read, so the model default is never known.
- A model that reports `thinking` in `capabilities` is marked `supported` with **no** `levels`, which downstream code then fills with generic levels.
- `values: [false]` (documented as "model does not support thinking") is indistinguishable from missing metadata: both fall to `unknown`. Explicit unsupported is collapsed into unknown.

### 2.3 Reasoning mapper (chat)

`src/routes/chat/provider-options.ts` — `buildReasoningProviderOptions(provider, model, reasoning)`:
- Returns `{}` for `reasoning === "off"`.
- Google: `thinkingLevel` for generation ≥ 3, `thinkingBudget` for 2.5, `includeThoughts: true` always.
- Anthropic: legacy `thinking: { type: "enabled", budgetTokens }` only.
- OpenAI/custom: `[providerOptionsNamespace(provider)]: { reasoningEffort }`.
- **No Ollama branch.** `ollama` falls through to `return {}` — Ollama receives no reasoning option in chat either.
- Every level lookup uses `?? "medium"` / `?? 4096`, so an unrecognized level silently becomes `medium`.
- Uses a name-based `LITE_MODEL = /lite|nano/i` gate, which contradicts the discovery module's stated rule against inferring capability from model names.

### 2.4 Reasoning mapper (Scheduler) — duplicate

`src/services/scheduler/schedulerExecution.ts:199-217` re-implements the same mapping inline:
- `const thinking = job.thinkingLevel ?? "off";`
- `const isLite = /lite|nano/i.test(job.modelId || "");`
- Google branch always uses `thinkingBudget` — **no generation check**, so Gemini 3+ models get the wrong parameter.
- Anthropic branch legacy-only.
- OpenAI/custom branch writes `providerOptions.openai` **unconditionally**, ignoring `providerOptionsNamespace()`.
- No Ollama branch.
- Same `?? 4096` / `?? "medium"` silent defaults.

This is a genuine second implementation, not a wrapper. Two mappers, already divergent (Google generation handling).

### 2.5 Shared protocol helpers (exist, underused)

`src/services/ai.ts`:
- `OPENAI_COMPATIBLE_PROVIDER_NAME = "openaiCompatible"`
- `resolveApiProtocol(config)` — `openai: "responses"`, `custom`/`ollama: "chat-completions"`, google/anthropic `undefined`.
- `usesOpenAICompatibleModel(config)` — true for `custom`/`ollama`/chat-completions `openai`.
- `providerOptionsNamespace(config)` — `"openaiCompatible"` or `"openai"`.

`ollama` resolves to `chat-completions`, so its namespace is `openaiCompatible`. Neither mapper currently honours that for Ollama, because neither has an Ollama branch.

### 2.6 Capability types (three-state, already correct)

`src/types/index.ts` and `web/src/types/index.ts` both define:
```ts
export type CapabilitySupport = "supported" | "unsupported" | "unknown";
export interface ReasoningCapability { support: CapabilitySupport; levels?: string[]; }
```
The backend comment is explicit: *"Absence of metadata is NOT evidence of absence — consumers must never collapse unknown into false."* The previous revision's resolver violated this in three places.

### 2.7 Fixed four-level unions (validation sites)

`src/lib/validation.ts` uses `z.enum(["off", "low", "medium", "high"])` at **seven**
lines — 56, 77, 167, 206, 560, 619, 672 — chat request, **provider create**, conversation
create, conversation update, scheduler job create, scheduler AI-tool create, scheduler
update. Revision 2 said six and missed line 77; the count is corrected in §1.1 row 19.
Line 808 (`logLevelFilterSchema`) also contains `"off"` but is a log-level enum, not a
reasoning site, and must not be touched.

Also fixed at:
- `src/lib/validation.ts:10-13` — `reasoningCapabilitySchema`, which declares **only**
  `support` and `levels`. Any new capability field is stripped by validation today.
- `src/types/index.ts:140` — `ProviderConfig.thinking?: "off"|"low"|"medium"|"high"`
- `web/src/types/index.ts:72` — `ReasoningLevel`
- `web/src/types/index.ts:391,456` — `SchedulerJob.thinkingLevel`, `SchedulerJobDraft.thinkingLevel`
- `src/services/scheduler/schedulerTypes.ts` — `ThinkingLevel`
- `web/src/components/composer/DirectChips.tsx:27` — `THINKING_OPTIONS`
- `web/src/features/providers/ProviderDialog.tsx:37` — `THINKING_OPTIONS`

### 2.8 Frontend consumers (verified)

- `DirectChips.tsx:159` — `stored ?? custom?.reasoningLevel ?? providerDefault`, where `providerDefault = providers.find(p => p.id === pid)?.thinking ?? "off"`. Renders from the fixed `THINKING_OPTIONS` list regardless of model capability.
- `SchedulerPage.tsx:168-169` — `providers[0]?.id`, `providers[0]?.model`. Confirmed bug: ignores the active provider.
- `ProviderDialog.tsx` — exposes a provider-level `thinking` select with four options. It does **not** reference `capabilities` or `reasoning` and offers no per-model capability editing. Confirmed by grep.

### 2.9 OpenCode

- `src/services/opencode/capabilities.ts` — `OpenCodeDefaultModel { providerID, modelID, name }`; `resolveOpenCodeModelRef` prefers `providerID/modelID` then bare id; `listOpenCodeModelVariants`; `resolveOpenCodeVariant`.
- `src/services/opencode/sessions.ts:903-910` — variant applied only inside `if (modelRef)`. The server-default-model branch does not apply a stored variant. Confirmed gap.
- `web/src/features/opencode/useOpenCodeCapabilities.ts` exists; `defaultModel` is optional.

---

## 3. Ollama capability discovery (corrected)

### 3.1 Documented contract (quoted verbatim, 2026-11-03)

From https://docs.ollama.com/capabilities/thinking — *"Thinking controls vary by model.
Use `/api/show` to discover the values a model supports and the value Ollama uses by
default"*, and the example response is exactly:

```json
{ "thinking": { "values": ["low", "medium", "high"], "default": "medium" } }
```

The four field rules, verbatim:

- *" `values` can contain booleans (`true` or `false`) for on/off controls. It can also
  contain model-defined strings for named levels."*
- *" `default` is used when `think` is not set."*
- *" `values: [false]` means the model does not support thinking."*
- *"If `thinking` is omitted, the model has no thinking metadata. The model might conduct
  thinking based on its existing behavior."*

Request side, verbatim — `think` on a chat/generate request:

- *"`true`: request thinking output."*
- *"`false`: request no thinking output, if the model permits it."*
- *"`null`: use the model default."*
- *"A string: select a supported level from `thinking.values`. Use the exact value from
  `/api/show`. Numbers are not supported."*
- *"If the model resolves named levels from `/api/show` metadata, Ollama applies supported
  names exactly. Unsupported names use the model default."*

From `docs/api/openai-compatibility.mdx` (line 253, verbatim):

> `reasoning_effort` and `reasoning.effort` control model thinking. Use `/api/show` to
> discover each model's supported values and default. When a model uses its metadata to
> resolve named levels, supported names are applied exactly and unsupported names resolve
> to the model default. Boolean-only models that support enabling thinking map recognized
> compatibility efforts to `true`, while `"none"` requests `false`. Models without
> metadata retain the existing compatibility aliases: `"minimal"` maps to `"low"`, and
> `"xhigh"` or `"ultra"` map to `"max"`. GPT-OSS keeps its existing OpenAI compatibility
> conversion: `"minimal"` uses `"low"`, `"xhigh"` or `"ultra"` use `"high"`, and `"none"`
> requests no thinking output.

**What the docs do and do not say about `default`** (this corrects both revision 2 and one
review claim). The boolean-or-string rule applies to **`values`**. For `default`, the docs
state only when it is used, and the single published example is a string. A boolean
`default` is therefore **not a documented value** — it is an inference, because "`default`
is used when `think` is not set" and the `think` domain includes booleans, so a
boolean-only model's default must come from the same value space as its `values`.

Consequence for this plan: the parser accepts `string | boolean` for `default` so a real
boolean default is preserved rather than thrown away as malformed, **and** the inference
is labelled as such here rather than cited as documentation. Revision 2's `defaultLevel?:
string` alone is wrong in the other direction: it silently discards a value the daemon
returned.

**The `false ∈ values` rule is the disable signal.** Nothing else in the Ollama docs
expresses "this model can be turned off": `values: [false]` alone means *no thinking at
all*. So `false` being present in `values` is the only provider-reported evidence of
disable-ability, and the compatibility doc confirms the wire consequence only for
boolean-only models (`"none"` requests `false`). For a named-level model, `false` is by
definition not in `values`, and no documented `reasoning_effort` value requests no
thinking — so **`off` cannot be honoured on a named-level Ollama model** and must be
reported as such (§7.0, §7.5).

### 3.2 Required discovery change

`fetchOllamaModel` must parse `thinking` alongside `capabilities` and produce a
`ReasoningCapability` that preserves all three states, the levels, the reported
disable-ability, and the model default.

```ts
// src/services/modelDiscovery.ts — shape only, not final code
type OllamaThinking =
  | { state: "absent" }                       // no `thinking` key
  | { state: "unsupported" }                  // values === [false]
  | { state: "boolean"; allowsOff: boolean }  // values ⊆ [true, false]
  | { state: "levels"; values: string[]; default?: string | boolean }
  | { state: "malformed" };                   // wrong shape/types
```

Rules, each mapped to a documented sentence:

| `/api/show` observation | `support` | `levels` | `booleanControl` | `disable` | model default | provenance |
|---|---|---|---|---|---|---|
| `thinking` key absent | `unknown` | absent | absent | `unknown` | absent | `unknown` |
| `thinking.values` is exactly `[false]` | `unsupported` | absent | absent | `unknown` | absent | `provider_reported` |
| `values` contains `true`, `values` contains `false` | `supported` | absent | `true` | `reported` | `thinking.default` if it is a member of `values` | `provider_reported` |
| `values` contains `true` only | `supported` | absent | `true` | `not_reported` | as above | `provider_reported` |
| `values` contains strings | `supported` | exactly those strings | absent | `not_reported` (no documented disable for level models) | `thinking.default` only if it is a **string** member of `values` | `provider_reported` |
| `thinking` present but wrong type / non-array `values` | `unknown` | absent | absent | `unknown` | absent | `unknown` (recorded as malformed) |
| `/api/show` unreachable or non-2xx | `unknown` | absent | absent | `unknown` | absent | `unknown` |

Additional constraints:
- **Compatibility with older Ollama responses.** Older daemons return `capabilities`
  without `thinking`. When `thinking` is absent but `capabilities` contains `"thinking"`,
  the result is `supported` with **no** levels, no boolean flag, `disable: "unknown"` and
  no default — never generic levels, never `unsupported`.
- **Boolean-only controls must not be represented as named levels.** A boolean control
  yields `supported` with no `levels`; the UI must render an on/off control, not a
  four-item level list.
- **Named levels are model-defined and opaque.** They are stored verbatim. They are never
  translated into `off/low/medium/high` at discovery time — that mapping is a
  request-time decision (§7.5).
- **`default` is validated against `values`, by type as well as by membership.** A string
  default not present in the string `values` is discarded (recorded as malformed); a
  boolean default beside string `values` is discarded the same way. A discarded default is
  never replaced by a guess.
- **Explicit unsupported is preserved.** `values: [false]` must produce `support:
  "unsupported"`, not `unknown`. The current code cannot express this.
- **Missing metadata is not unsupported.** Absent `thinking` stays `unknown`, because the
  docs say the model may still think on its own.
- **Mixed `values` (booleans and strings together) is malformed.** The doc describes two
  alternatives, not a combination; a mixed array is recorded as `malformed` and yields
  `unknown`, rather than being split into a best guess.

### 3.3 Provenance

`ReasoningCapability` gains optional fields, mirrored in `src/types/index.ts` and
`web/src/types/index.ts`:

```ts
export type ReasoningProvenance =
  | "provider_reported"      // parsed from /api/show `thinking`
  | "provider_capabilities"  // legacy `capabilities: ["thinking"]` only
  | "configured"             // a human set it (only if §4.5 option (a) is adopted)
  | "unknown";               // nothing reported

/** Whether the source reports that thinking can be switched off. */
export type ReasoningDisable = "reported" | "not_reported" | "unknown";

export interface ReasoningCapability {
  support: CapabilitySupport;
  levels?: string[];
  /** True when the control is boolean on/off rather than named levels. */
  booleanControl?: boolean;
  /** Provider-reported ability to turn thinking OFF — never inferred from absence. */
  disable?: ReasoningDisable;
  /** Model's own default, as reported. Boolean for boolean-only controls. */
  defaultLevel?: string | boolean;
  provenance?: ReasoningProvenance;
}
```

Provenance exists so "a human typed it" and "the daemon said it" can never be confused —
the same discipline `capabilityDiscovery.ts` already applies to token limits via
`provider_reported` / `configured`. `disable` exists so "the model refuses to stop
thinking" and "we were never told" are never both rendered as a silent success (§6.1).

These three new fields are **not** advisory: they must be declared in
`reasoningCapabilitySchema` or `modelCapabilitiesSchema` strips them on every write.
See §8.1 and the round-trip test in §9.6.

### 3.4 Runtime path

- Ollama's model is built through `createOpenAICompatible`
  (`resolveApiProtocol("ollama") === "chat-completions"`), so the wire path is
  `/v1/chat/completions` and the option key is
  `providerOptionsNamespace() === "openaiCompatible"`.
- The runtime field is therefore `reasoning_effort` (SDK: `reasoningEffort`), **not** the
  native `think` parameter. TBAi does not call `/api/chat` anywhere in the reasoning path.
- Mapping a TBAi selection to an Ollama effort:
  1. **Discovered named levels** (`levels` non-empty): send the level verbatim when it is
     in `levels`; otherwise send nothing and surface `level_not_supported` (do not silently
     send the model default — the doc says Ollama substitutes the default, which in the UI
     reads as "my setting did nothing").
  2. **`booleanControl` with `disable: "reported"`**: `enabled` → `true`; `off` → `"none"`
     (documented to request `false` for boolean-only models); `default` → send nothing.
  3. **`booleanControl` with `disable: "not_reported"`** (`values: [true]`): `enabled` →
     `true`; `off` → send nothing **and report `disable_not_supported`** — `false` was not
     offered, so no wire value can request it; `default` → send nothing.
  4. **Named-level model + `off`**: send nothing and report `disable_not_supported`, per
     §3.1 — there is no documented `reasoning_effort` value that turns a level model off.
  5. **`support === "unknown"`**: send nothing. Do not rely on the compatibility aliases,
     because whether they apply depends on metadata TBAi does not have (the aliases belong
     to models *without* metadata, and GPT-OSS has a third mapping again).
  6. **`support === "unsupported"`**: send nothing; `off` and `default` are the only valid
     selections.

---

## 4. Shared frontend resolver (corrected)

Target module: `web/src/lib/ai-capabilities.ts`.

### 4.1 Rules the previous draft violated

1. Never return generic reasoning levels when support is `unknown`.
2. Never let missing metadata evaluate as supported.
3. Preserve `supported` / `unsupported` / `unknown` end to end.
4. Never fall back to the first provider when the active provider cannot be resolved.
5. Never silently select the first OpenCode model when the server advertises no default.
6. Store OpenCode model references as `providerID/modelID`.
7. Represent the model default separately from the provider default and the user's selected value.
8. Never let model metadata outrank a default the user configured (§4.6).
9. Never render `off` as achieved when the model or provider contract cannot disable
   thinking; say so instead (§4.7).
10. Never collapse a boolean control into a named-level list, and never let an on/off
    model be switched on by an implied level (§4.2, §6.1).

### 4.2 Resolver shape

```ts
/** What the UI may offer for one model. Never invents capability. */
export type ThinkingOptions =
  | {
      state: "supported";
      levels: string[];
      /** Present only for boolean on/off controls. */
      booleanControl?: true;
      /** Model's own reported default, as reported. */
      defaultLevel?: string | boolean;
      /** Whether the source says thinking can be turned off. */
      disable: ReasoningDisable;
    }
  | { state: "unsupported" }
  | { state: "unknown"; providerContract: ProviderContract | null };

export function resolveThinkingOptions(
  model: ModelOption | undefined,
  provider: ProviderConfig | undefined,
): ThinkingOptions;
```

- `supported` + `levels` → offer exactly those levels, plus `default`. Offer `off` only
  when `disable === "reported"` **or** the provider contract (§7.0) documents a disable
  value; otherwise `off` is shown as unavailable, not as a silently-accepted choice.
- `supported` + `booleanControl` → offer **on and off** (or on only, when
  `disable === "not_reported"`), plus `default`. On is the selection `{ kind: "enabled" }`
  (§6.1); it is not a level and must not be rendered as one.
- `supported` with no levels and no boolean flag (legacy `capabilities: ["thinking"]`) →
  `{ state: "unknown", providerContract }`. The model is known to think, but which levels
  it accepts is not known, so the UI must not present a level list as model support.
- `unsupported` → `{ state: "unsupported" }`. The thinking control is hidden; `off`
  remains the stored value.
- `unknown` → `{ state: "unknown", providerContract }`, where `providerContract` is the
  documented closed set for that provider+protocol (§7), or `null` when no documented
  contract exists. When `null`, the UI offers only `off` and `default`.

`isReasoningSupported` is replaced by an explicit three-way accessor. There is no boolean
that returns `true` for `unknown`.

**A boolean default renders honestly.** `defaultLevel` can be `true`/`false` (§3.3), so the
"model default" label is formatted through one helper that handles both a level name and a
boolean, and the boolean case says "thinking on by default" / "thinking off by default"
rather than printing `true`.

### 4.3 Defaults resolution

```ts
export type DirectDefaults =
  | { ok: true; providerId: string; modelId: string | null;
      thinking: {
        providerDefault: ReasoningSelectionScalar | null;
        modelDefault: string | boolean | null;
        selected: ReasoningSelectionScalar | null;
        effective: ReasoningSelection;
        /** True when `effective` came from a value the model cannot honour. */
        needsAttention: boolean;
      } }
  | { ok: false; reason: "no_active_provider" | "active_provider_missing" };

export function resolveDirectDefaults(
  providers: ProviderConfig[],
  activeProviderId: string | null,
  conversationSelection?: ReasoningSelectionScalar | null,
): DirectDefaults;
```

- `activeProviderId` that does not resolve → `{ ok: false, reason: "active_provider_missing" }`. No `providers[0]` fallback.
- `modelId` is `provider.model ?? null`. A provider with no configured model yields `null`, and the UI requires a selection rather than guessing.
- The thinking values are returned **separately**, never collapsed:
  - `providerDefault` — `provider.thinking ?? null` (the provider-level configured default).
  - `modelDefault` — `model.capabilities.reasoning.defaultLevel ?? null` (what the model itself reports).
  - `selected` — the persisted user/conversation/request value, or `null` meaning "not chosen".
  - `effective` — the single resolved selection, computed by §4.6, not by an ad-hoc `??` chain at the call site.
  - `needsAttention` — true when `effective` is `off` on a model whose `disable` is not
    `"reported"` and whose provider contract documents no disable value (§4.7).

### 4.4 OpenCode defaults

```ts
export type OpenCodeDefaults =
  | { ok: true; agent: string | null; model: string | null; variant: string | null }
  | { ok: false; reason: "no_capabilities" };

export function resolveOpenCodeDefaults(capabilities: OpenCodeCapabilities): OpenCodeDefaults;
```

- `model` is `providerID/modelID` when `defaultModel` exists, else `null`.
- **No** fallback to `capabilities.models[0]`. When `model` is `null`, the editor requires an explicit selection and explains why (the server advertises no default).
- `variant` is `null` meaning "Default" (omit), matching `buildOpenCodeThinkingOptions`'s existing `{ id: "", label: "Default" }` convention.

### 4.5 Manual per-model capability editing

The previous revision implied capability data could be configured. It cannot: `ProviderDialog.tsx` has no capability UI, and the previous revision's own file list added none.

Two honest options; this plan takes the second:

- **(a) Introduce editing** — requires `web/src/features/providers/ProviderDialog.tsx` changes, a per-model capability editor, `provenance: "configured"` on every written value, a precedence rule (configured overrides reported, with the reported value retained for comparison), and validation so a typed level is checked against the provider contract. This is real scope and is **not** included here.
- **(b) Describe the limitation** — until (a) exists, capability data comes only from discovery. For every provider except Ollama, discovery reports `unknown`, so the UI offers `off` plus the documented provider contract levels and labels them as the provider's contract, not as model support. That label is the entire mitigation.

**Decision: (b).** No `ProviderDialog.tsx` change in this plan. If (a) is later wanted, it is a separate plan with its own tests.

### 4.6 Precedence: the existing contract is preserved

Revision 2 ordered defaults `selected → modelDefault → providerDefault → "off"`, which
lets model metadata silently outrank a value the user configured. That is reversed here,
and the reversal is anchored to what the backend does today, verified at `8e07e1d`:

- `src/routes/chat/model.ts` header states the order as *"1. the request's own
  `providerId` / `model` / `reasoningLevel` (one-shot overrides…), 2. the conversation's
  persisted default (SQLite source of truth), 3. the active provider's saved default"*;
- `withProviderDefaults()` (`model.ts:54`) applies `reasoning ?? provider.thinking ?? "off"`;
- the conversation branch (`model.ts:86`) applies `reasoningLevel ?? conv?.reasoningLevel ?? undefined`;
- `validate-and-resolve.ts:210` then applies `effectiveReasoning ?? provider.thinking ?? "off"` **again**.

New order, one place, no double application:

1. request / one-shot override (`reasoningLevel` on the chat request);
2. conversation persisted selection (`conversations.reasoning_level`);
3. Scheduler: the job's `thinkingLevel`;
4. provider-level configured default (`provider.thinking`);
5. model-reported default (`capabilities.reasoning.defaultLevel`), used **only** when
   steps 1–4 produced nothing. This is the one addition relative to today, and it is the
   weakest tier precisely so a user's configured default can never lose to metadata;
6. `off`.

`resolveDirectDefaults` computes this; call sites stop writing their own `??` chains. The
duplicate application at `validate-and-resolve.ts:210` is removed in the same change — the
route consumes `effective` rather than re-deriving it, so there is exactly one precedence
function in the codebase.

**Display vs. resolution are separate questions.** Even when step 5 wins, the control must
label it "model default: `medium`" rather than showing it as a user choice, because the
user did not choose it.

### 4.7 A limitation is displayed, never swallowed

When `effective` is `off` but the model cannot disable thinking, the resolver reports
`needsAttention: true` and the surface says which. Three distinct states must not be
collapsed into one "Off" label:

| State | What the UI says |
|---|---|
| `off`, disable documented/reported | "Off" |
| `off`, model always thinks | "Off — not supported by this model; it always thinks. Lower the effort level instead." |
| `off`, nothing known (`unknown`) | "Off — no reasoning setting is sent; the model may still think." |

Server-side, the same distinction is what `applied.kind` + `notices` exist for (§5.2), and
the provider SDK's own warnings are captured, not discarded (§7.2).

---

## 5. Backend adapter (corrected)

### 5.1 What changes

The previous revision proposed a wrapper around `src/routes/chat/provider-options.ts`. That keeps the implementation inside a route module and leaves Scheduler's duplicate intact. Instead:

- **Move** the provider-specific implementation into `src/services/ai-capabilities.ts`.
- `src/routes/chat/provider-options.ts` is **deleted**, not re-exported. A re-export would preserve two import paths for one concept and invite the duplicate back.
- Both consumers import from `src/services/ai-capabilities.ts`:
  - `src/routes/chat/validate-and-resolve.ts`
  - `src/services/scheduler/schedulerExecution.ts`
- `resolveJobModel`'s inline block (schedulerExecution.ts:199-217) is **removed**, not left beside the new call.

### 5.2 Module contract

```ts
// src/services/ai-capabilities.ts
export interface ReasoningRequest {
  provider: Pick<ProviderConfig, "type" | "apiProtocol">;
  model: string;
  /** Typed internal selection — never a bare string (§6.2a). */
  selection: ReasoningSelection;
  /** Discovered capability for this model, when available. */
  capabilities?: ModelCapabilities;
}

/** Why the requested setting was not, or not only, what was sent. */
export type ReasoningNoticeCode =
  | "level_not_supported"
  | "disable_not_supported"       // off cannot be honoured on this model
  | "model_always_thinks"         // provider documents that thinking is mandatory
  | "no_provider_contract"        // custom/unknown endpoint, nothing classified
  | "provider_model_unreachable"; // Scheduler: capability data absent at fire time

export interface ReasoningResolution {
  /** providerOptions to pass to streamText; empty when nothing is sent. */
  providerOptions: Record<string, Record<string, unknown>>;
  /** What was actually sent, for logging and tests. */
  applied:
    | { kind: "off"; sent: true }
    | { kind: "off"; sent: false }   // requested off, nothing sent (see notices)
    | { kind: "default" }
    | { kind: "enabled"; sent: true }
    | { kind: "level"; level: string; sent: true }
    | { kind: "none"; reason: string };
  /** Empty only when the request is fully honoured. */
  notices: Array<{ code: ReasoningNoticeCode; detail: string }>;
}

export function resolveReasoningProviderOptions(req: ReasoningRequest): ReasoningResolution;
```

- Uses `providerOptionsNamespace(provider)` and `resolveApiProtocol(provider)` from `src/services/ai.ts`. No mapper may hardcode `"openai"`.
- Returns `applied` **and** `notices` so a caller can log why nothing was sent. The current mappers cannot distinguish "off" from "unrecognized level" from "no branch for this provider" — all three produce `{}`. `{ kind: "off", sent: false }` exists precisely so "we omitted the parameter" is never recorded as "reasoning is off" (§6.1).
- No `?? "medium"` fallback anywhere. An unrecognized level yields `applied: { kind: "none", reason: "level_not_supported" }` plus the matching notice.
- `notices` is the **contract-level** half of the story. The provider's own runtime
  objections are a separate, additional channel and must be captured too — §5.4.

### 5.3 Equivalence requirement

A test must assert that for the same `(provider.type, provider.apiProtocol, model, selection, capabilities)` tuple, the `providerOptions` **and** the `notices` produced through the chat path and through the Scheduler path are deep-equal. This is only meaningful once both call the same function, which is the point of the move. Equivalence on `providerOptions` alone would still permit the two paths to disagree about whether the setting was honoured.

---

### 5.4 Provider warnings are captured, not discarded

The mapper can only act on what TBAi knows before the call. A provider can still refuse a
setting at request time, and `ai` 7.0.145 surfaces that: `StepResult.warnings` is
`CallWarning[] | undefined` (`node_modules/ai/dist/index.d.ts:1019`) and the `streamText`
result carries `warnings: PromiseLike<CallWarning[] | undefined>` (`:2856`), where
`CallWarning` resolves to the provider's `SharedV4Warning`. The Anthropic build uses this
channel for exactly the refusal cases this plan must display (§7.2), e.g. `thinking cannot
be disabled for ${modelId}; it always uses adaptive thinking. The thinking setting has been
removed. Lower 'effort' to reduce thinking.` (`@ai-sdk/anthropic` `dist/index.js:3732`).

Verified at `8e07e1d`: **nothing in `src/` or `web/` reads provider warnings today** — no
`AI_SDK_LOG_WARNINGS` assignment, no `warnings` consumer in the chat route or Scheduler
execution. So this is a real gap, not a documentation fix.

Required, in both execution paths:
- `src/routes/chat/*`: after each step, read `warnings`; log each with
  `logger.warn("reasoning", "reasoning_setting_not_applied", { requestId, code, detail })`
  — the `detail` string from the provider is copied verbatim, and no message text, prompt
  or secret is logged with it.
- `src/services/scheduler/schedulerExecution.ts`: the same, using the run's `requestId`.
  A warning never changes the run's `status`, and it is never written into
  `scheduler_runs.error` (that column means "the run failed"). `scheduler_runs` gains no
  column — the plan's no-migration rule stands. The operator-visible record is the log line.
- Where a notice or warning is knowable **before** save, the editor shows it (§4.7); the
  post-hoc warning is the fallback for what only the provider knows.

## 6. App-wide reasoning contract (corrected)

The previous revision left chat on a fixed four-level union and widened only Scheduler. That is not app-wide, and it leaves chat unable to express a model-defined Ollama level. One contract, seven layers.

### 6.1 The value

Five distinct concepts, kept distinct. Persistence is a single string; the internal value
is the typed union of §6.2a.

| Selection | Meaning | Wire effect |
|---|---|---|
| `off` | The user asked for reasoning to be **off**. | Provider-specific (§7.0): send the provider's documented disable value where one exists; otherwise send nothing **and** emit `disable_not_supported` / `model_always_thinks`. Omitting the parameter is never reported as success. |
| `default` | Defer to the model's own native default. | Send nothing. The provider applies its default. Distinct from `off` because nothing is asserted about the outcome. |
| `enabled` | Boolean-control models only: ask for thinking **on**. | Send the provider's documented on value (Ollama: `true` via a recognized effort). Valid **only** when `booleanControl` is reported. |
| `none` | The provider's own "no reasoning" wire value. | Sent verbatim where the contract defines it (OpenAI `reasoning_effort: "none"`; Google 2.5 Flash-class `reasoning_effort: "none"` on the compat path; Ollama `"none"` for boolean-only models). Never assumed, never stored as a user choice today (§11 item 6). |
| `level:<value>` | A named level. | Validated against discovery, then sent verbatim or rejected with a notice. |

**Correction of the revision-2 contradiction.** Revision 2 wrote that `off` "explicitly
disables reasoning" and, in the same table, that `off` "sends no reasoning option". Those
cannot both hold: omitting a parameter lets the model use its default, which for a great
many reasoning models means it thinks. Providers document this directly:

- Google — *"If you want to disable thinking, you can set `reasoning_effort` to `"none"`
  for 2.5 models. Reasoning cannot be turned off for Gemini 2.5 Pro or 3 models."*
- Anthropic (from the pinned 4.0.83 build) — models such as `claude-opus-5-5` and
  `claude-fable-5-1` *"reject `enabled` and `disabled`"*; the SDK *"drops the unsupported
  setting, emits a warning, and sends an adaptive thinking request"*, with the user-visible
  text *"thinking cannot be disabled for …; it always uses adaptive thinking. The thinking
  setting has been removed. Lower 'effort' to reduce thinking."*

So `off` means *"the user wants no reasoning"*, and whether that is achievable is a
per-model fact carried by `disable` (§3.3) and the provider contract (§7.0). `default`
means *"do not decide"*. `off` on an always-thinking model resolves to **nothing sent plus
a notice**, and the UI says so (§4.7). Collapsing `off` and `default` — as
`DirectChips.tsx:159` does today with `?? "off"` — is what lets a screen claim "Off" while
the model thinks.

`enabled` exists because revision 2's contract could not switch a boolean-only Ollama model
on when its default is off: `off`/`default`/`none`/named-levels offer no "on", and §3.4's
old rule "map any enabled level to `true`" referenced levels that by definition do not
exist for such a model. It is a first-class selection, not a level.

### 6.2 Validation

```ts
export function validateReasoningSelection(
  raw: ReasoningSelectionScalar,
  provider: Pick<ProviderConfig, "type" | "apiProtocol">,
  model: string,
  capabilities?: ModelCapabilities,
): { ok: true; selection: ReasoningSelection } | { ok: false; reason: string };
```

Rules:
1. `off` and `default` are always **accepted as inputs** — a saved value must never be
   rejected at the boundary for a reason the user cannot act on. Accepting `off` is not a
   claim that disabling is possible; that is decided at mapping time (§5.2, §7.0).
2. If `capabilities.reasoning.support === "supported"` and `levels` is non-empty: the level
   must be in `levels`.
3. If `support === "supported"` with `booleanControl`: only `enabled`, `off`, `default` are
   valid. `off` is accepted, but when `disable !== "reported"` it maps to "nothing sent"
   plus a `disable_not_supported` notice (§5.2) rather than to a wire disable.
4. If `support === "supported"` with no levels and no boolean flag (legacy
   `capabilities: ["thinking"]`): only the documented provider contract applies (§7).
5. If `support === "unsupported"`: only `off` and `default` are valid. A level or `enabled`
   is rejected with a specific reason.
6. If `support === "unknown"`: the level must be in the **documented provider contract**
   for that provider+protocol. It is never accepted merely because it is a string. When no
   documented contract exists (e.g. an unclassified `custom` endpoint), only `off` and
   `default` are valid.
7. `enabled` is rejected when `booleanControl` is not reported — it is not a synonym for a
   level.
8. Unrestricted strings are never accepted, and there is no "bounded string" path.
   A bare value that is not a reserved keyword is decoded **only** through the single
   legacy rule of §6.2a item 3, and must then still satisfy rules 2 and 6 — being
   decodable is not being valid.

### 6.2a Internal type, serialized form, and encode/decode

Revision 2 declared an object union in one place and `"off" | "default" | "none" | string`
in another, then persisted a scalar with no defined conversion. That is fixed here: one
internal type, one validated scalar, and explicit total conversions.

```ts
/** Internal, everywhere in services, validators and React state. */
export type ReasoningSelection =
  | { kind: "off" }
  | { kind: "default" }
  | { kind: "enabled" }
  | { kind: "none" }
  | { kind: "level"; level: string };

/** Persisted + wire form: a validated string. */
export type ReasoningSelectionScalar = string;

/** Reserved bare keywords. A level can never be written bare. */
export const REASONING_KEYWORDS = ["off", "default", "enabled", "none"] as const;

export function encodeReasoningSelection(s: ReasoningSelection): ReasoningSelectionScalar;
export function decodeReasoningSelection(raw: ReasoningSelectionScalar): ReasoningSelection;
```

Encoding is injective and prefix-based:

| Selection | Encoded |
|---|---|
| `{kind:"off"}` | `"off"` |
| `{kind:"default"}` | `"default"` |
| `{kind:"enabled"}` | `"enabled"` |
| `{kind:"none"}` | `"none"` |
| `{kind:"level",level:"high"}` | `"level:high"` |

Decoding:
1. `off` / `default` / `enabled` / `none` (exact, case-sensitive) → that keyword selection.
2. A value starting with `"level:"` → a level whose text is the remainder; the remainder
   must satisfy `z.string().min(1).max(200)` (the same bound
   `reasoningCapabilitySchema` puts on `levels`, `src/lib/validation.ts:12`) and contain no
   control characters.
3. Any other bare value → **legacy**: treat it as a level name. This is the only
   backward-compatibility rule, and it is what lets today's stored `"low"`, `"medium"` and
   `"high"` keep loading (§6.4). New writes never use this form.
4. `""` or a whitespace-only value → rejected, not decoded as a level.

Why prefixing rather than a bare level: Ollama levels are *model-defined strings* (§3.1),
so a level literally named `"off"` is representable. Under a bare scheme such a level
would silently decode as "disable reasoning". Under the prefix scheme it encodes as
`"level:off"` and decodes as the level. That collision is the reason the scheme is prefixed
at all, and it is covered by a test (§9.2, case 14).

Placement and one-owner rule: `src/lib/reasoning-selection.ts` (backend) and
`web/src/lib/reasoning-selection.ts` (frontend mirror). Both trees already duplicate the
capability types (§2.6), and no shared package exists to import from, so the mirror follows
the existing convention rather than inventing one. A source-text drift guard is mandatory
(§6.5) because a mirror without a guard silently diverges.

The scheduler type stops being an open union:

```ts
// src/services/scheduler/schedulerTypes.ts
// before: export type ThinkingLevel = "off" | "low" | "medium" | "high";
// after:  export type ThinkingLevel = ReasoningSelection;
```

`"off" | "default" | "none" | string` is explicitly **not** used: in TypeScript that union
reduces to `string` and enforces nothing, which is exactly what §6.2 rule 8 forbids.
`JobPayload.thinkingLevel` in `schedulerStore.ts` takes `ReasoningSelectionScalar` at the
persistence edge; the column stays TEXT.

### 6.3 The seven layers

| Layer | File | Change |
|---|---|---|
| Frontend chat selection | `web/src/components/composer/DirectChips.tsx` | Render from `resolveThinkingOptions`; show `off` vs `Default` vs "cannot disable" distinctly (§4.7); consume `resolveDirectDefaults().thinking.effective` instead of a local `?? "off"` chain. |
| Conversation persistence | `src/lib/validation.ts:167`, `:206` | Replace the four-value enum with `reasoningSelectionScalarSchema`; decode to the typed selection before storing. |
| Chat API validation | `src/lib/validation.ts:56`, `src/routes/chat/validate-and-resolve.ts`, `src/routes/chat/model.ts` | Same schema; `ResolvedChatModel.reasoning` becomes `ReasoningSelection` (it is a bare `string` today, `model.ts:31`); single precedence application (§4.6); resolve through `resolveReasoningProviderOptions`; read step `warnings` (§5.4). |
| Provider/model config validation | `src/lib/validation.ts:77`, `:10-13` | `providerCreateSchema.thinking` follows the selection schema (the site revision 2 missed); `reasoningCapabilitySchema` declares `booleanControl`, `disable`, `defaultLevel` (`string \| boolean`), `provenance`, with combination rules (§6.6). |
| Scheduler job editing + validation | `web/src/features/scheduler/components/JobEditor.tsx`, `web/src/types/index.ts`, `src/lib/validation.ts:560`, `:619`, `:672`, `src/services/scheduler/schedulerValidation.ts` | Capability-driven control; `thinkingLevel: ReasoningSelection \| null` where `null` means `default`; add `checkThinkingLevel` to the existing `check*` chain (`checkScheduleFields`, `checkProvider`, `checkExistingThread`, `checkOpenCodeFields`); enforce **both** engine directions (§8.4). |
| Scheduler persistence | `src/services/scheduler/schedulerTypes.ts`, `schedulerStore.ts` | `ThinkingLevel` becomes `ReasoningSelection`; the store encodes to the scalar at the SQL boundary; column stays TEXT. |
| Provider execution mapping | `src/services/ai-capabilities.ts` | Single mapper; `providerOptionsNamespace()` + `resolveApiProtocol()`; emits `notices`; reads the provider contract table (§7.0). |

### 6.4 Backward compatibility

- Existing saved values `low` / `medium` / `high` decode through the **single legacy rule**
  of §6.2a item 3 (a bare non-keyword string is a level). `off` decodes to `{kind:"off"}`,
  which is what it always meant. No migration.
- A stored `"off"` on a model that cannot disable thinking **does not change meaning**: the
  request omits the parameter, as today, and the only difference is that the UI and the log
  now say the model still thinks. No saved row is rewritten to reach that.
- `null`/`undefined` on a Scheduler job continues to mean "no explicit selection" → resolves
  to `default` → sends nothing. Revision 2 described this as matching
  `job.thinkingLevel ?? "off"`; the outcome (nothing sent) is the same, but the **label is
  not** — `"off"` and `default` are different displays (§6.1), so this is a deliberate
  visible change: a job with no stored level now reads "Default" instead of "Off". That is
  the correction the reviewer asked for, and it must be called out in the implementation
  report rather than passed off as behaviour-preserving. The stored value stays as-is.
- A saved value that is not valid for the newly resolved model is **not** silently replaced.
  It is surfaced as "not supported by this model" with the previous value retained, per the
  existing `DirectChips` intent.
- No database schema change. `thinking_level` and `reasoning_level` remain TEXT, and both
  keep accepting the legacy bare form on read.

### 6.5 Front/back drift guard

`tests/unit/web/lib/reasoningSelectionMirror.test.ts` asserts both copies declare the same
keyword set and the same `level:` prefix, by reading both source files. It asserts the
invariant (one keyword list, one prefix), not the formatting. Per the repository rule that a
guard must be able to fail, it is verified by making the two lists disagree and watching the
test go red before implementation sign-off.

### 6.6 Capability schema combination rules

`reasoningCapabilitySchema` (`src/lib/validation.ts:10-13`) must reject combinations the
parser is never supposed to emit, so a corrupt stored capability cannot survive a round
trip:

| Condition | Verdict |
|---|---|
| `support: "unsupported"` with `levels` present | reject |
| `support: "unsupported"` with `booleanControl: true` | reject |
| `support: "supported"` + `booleanControl: true` + non-empty `levels` | reject (two control kinds, §3.2 mixed-`values` rule) |
| `defaultLevel` is a string not present in `levels` (when `levels` non-empty) | reject |
| `defaultLevel` is a boolean while `booleanControl !== true` | reject |
| `disable: "reported"` with `support !== "supported"` | reject |
| `provenance: "provider_reported"` with `support: "unknown"` | reject (nothing was reported) |
| `support: "unknown"` with `levels` present | reject |

Everything else stays optional, so today's `{ reasoning: { support: "unknown" } }` payloads
validate unchanged. Combination checks live in the schema (a `.refine` with a specific
message per row), not in the mapper.

---

## 7. Provider mapping rules (corrected)

### 7.0 What `off` means, per provider

`off` is one user intent with different realisations. This table is the single place that
decides it, and it is what the mapper reads. "Nothing sent" is never, on its own, a claim
that thinking stopped.

| Provider / class | Documented way to stop thinking | `off` sends | Notice when `off` is requested |
|---|---|---|---|
| OpenAI (both protocols) | `reasoning_effort: "none"` is in the SDK enum (`@ai-sdk/openai` 4.0.97, `dist/index.d.ts:54`) | `reasoningEffort: "none"` under `providerOptionsNamespace()` | none (contract value exists); a per-model restriction is still reported via §5.4 warnings |
| Anthropic — models accepting `disabled` | `thinking: { type: "disabled" }` | `disabled` | none |
| Anthropic — always-adaptive models (`claude-opus-5-5`, `claude-fable-5-1`, per the SDK doc comment) | none — they "reject `enabled` and `disabled`" | **nothing** | `disable_not_supported` + "it always uses adaptive thinking. Lower 'effort' to reduce thinking." |
| Anthropic — `claude-sonnet-5-5` | `between_tools` (its lowest setting) | `{ type: "between_tools" }` | `model_always_thinks`, wording "lowest thinking setting, not off" |
| Anthropic — disable only at some efforts | SDK flag `rejectsThinkingDisabledAboveHighEffort` | `disabled` only when the selection's effort ≤ `high`; otherwise nothing | `disable_not_supported` naming the effort |
| Google — Gemini 2.5 Flash-class | "you can set `reasoning_effort` to `"none"` for 2.5 models"; native `thinkingBudget: 0` where allowed | compat path: `none`; native: `thinkingBudget: 0` | none |
| Google — "Gemini 2.5 Pro or 3 models" | **none** — "Reasoning cannot be turned off for Gemini 2.5 Pro or 3 models." | **nothing** | `model_always_thinks` |
| Ollama — boolean control with `false ∈ values` | `"none"` on the compat path ("`"none"` requests `false`") | `reasoningEffort: "none"` | none |
| Ollama — named-level models | none documented | **nothing** | `disable_not_supported` (§3.1) |
| Ollama — no metadata (`unknown`) | unknown | nothing | `no_provider_contract` |
| Custom / unclassified | unknown until classified (§7.4) | nothing | `no_provider_contract` |

Rules that hold across the table:
- A notice is **not** an error. The request proceeds; only the claim "reasoning is off"
  would have been false.
- Notices are emitted by the mapper (§5.2) and, where the provider objects at request time,
  confirmed by the SDK warning channel (§5.4). Both are logged; neither changes a
  Scheduler run's `status`.
- Where a class is decided by model identity (Anthropic, and Google 2.5-vs-3), the source
  of that decision must be labelled: provider-reported only when discovery says so,
  otherwise a TBAi-maintained contract table (§7.2, §7.3, §11 item 2).

### 7.1 OpenAI

- SDK union (`@ai-sdk/openai` 4.0.97, `dist/index.d.ts:54`): `"none" | "low" | "medium" | "high" | "xhigh" | "max" | "minimal"`. The same file also declares `reasoningEffort?: string | null` at `:197` on another options type — a string-typed field is **not** evidence that arbitrary strings are accepted by the API.
- **The SDK union is not proof that every model accepts every value.** Support varies by model and by API protocol (Responses vs Chat Completions).
- Mapping: send the level only when it is in the model's discovered `levels`, or, absent discovery, in a documented per-model contract. Otherwise send nothing and report `level_not_supported`.
- `"none"` is passed through as the provider's disable value when the contract allows it; `"default"` sends nothing; `"off"` sends `"none"` (row 1 of §7.0).

### 7.2 Anthropic — resolved against the pinned 4.0.83 build

Revision 2 deferred the option path ("must be confirmed at implementation time"). It is
confirmed now, from the installed package, so implementation has nothing left to guess.

**The request-level path exists and is public.** `anthropicLanguageModelOptions`
(`@ai-sdk/anthropic` 4.0.83, `dist/index.d.ts:592`) declares both fields side by side:

- `thinking` — a discriminated union of
  `{ type: "adaptive", display?, blockBinding? }`,
  `{ type: "enabled", budgetTokens? }`,
  `{ type: "disabled" }`,
  `{ type: "between_tools" }`;
- `effort` — `z.enum(["low","medium","high","xhigh","max"])` at request level
  (`dist/index.d.ts:659`), **not** only on system messages (`:576`).

Both are re-exported publicly as `AnthropicLanguageModelOptions` /
`AnthropicProviderOptions` (`dist/index.d.ts:1900`). The runtime build confirms the wire
mapping: `output_config: { effort … }` is emitted from `anthropicOptions.effort`
(`dist/index.js:3781`). So TBAi sends exactly:

```ts
providerOptions.anthropic = { thinking: { type: "adaptive", display: "summarized" }, effort: "high" }
```

**The SDK encodes the model restrictions TBAi must respect.** Verbatim from the `thinking`
doc comment (`dist/index.js:888-896`):

> Models that always use adaptive thinking (e.g. `claude-opus-5-5`, `claude-fable-5-1`)
> reject `enabled` and `disabled`. For those models the provider drops the unsupported
> setting, emits a warning, and sends an adaptive thinking request. Use `effort` to control
> how much they think.
>
> `claude-sonnet-5-5` supports `between_tools`, its lowest thinking setting, and the
> provider uses it in place of `disabled` for that model.

`display` semantics, verbatim (`dist/index.js:900-905`):

> - `"omitted"`: Thinking blocks are present but text is empty (**default for Opus 4.7+**).
> - `"summarized"`: Thinking content is returned.
> - `"updates"`: Thinking updates are returned between tool calls.

`effort` defaults, verbatim (`dist/index.js:1001-1005`): *"The API default is `high` for
most models and `medium` for `claude-opus-5-5`."*

Two further SDK behaviours the mapper must not fight:
- `between_tools` with `xhigh`/`max` is silently lowered to `high`, **with a warning**
  (`dist/index.js:3753-3757`).
- a flag named `rejectsThinkingDisabledAboveHighEffort` gates `disabled` by effort
  (`dist/index.js:3745`) — the "only under particular effort settings" case the review
  noted.

**A live defect revision 2 did not name.** Because `display` defaults to `"omitted"` on
Opus 4.7+, an adaptive request without an explicit `display: "summarized"` returns thinking
blocks with **empty text**. TBAi would show an empty reasoning section and no error. This
is the Anthropic counterpart of Google's `includeThoughts` rule (§7.3) and belongs in the
same mapper: whenever TBAi asks for thinking, it must also ask for the summary to be
returned.

**What the SDK does *not* give TBAi.** `getModelCapabilities(modelId)` exists in the
runtime build (`dist/index.js:3603`) and returns exactly the predicates TBAi needs —
`supportsAdaptiveThinking`, `rejectsThinkingDisabled`,
`rejectsThinkingDisabledAboveHighEffort`, `rejectsBudgetThinking`,
`supportsBetweenToolsThinking`, `supportsXhighEffort` — but it is **not exported** (it does
not appear in `dist/index.d.ts`, and the public export list at `:1900` does not include it).
TBAi must therefore keep its own model→mode table, label it as a **TBAi-maintained contract**
with the SDK build as its source, and treat §5.4 warnings as the correction channel when the
two disagree. `AnthropicModelId` (`dist/index.d.ts:571`) is *not* a usable substitute: it
ends in `(string & {})`, so it is an open set and says nothing about thinking mode.

| Model group | `thinking: {type:"enabled", budgetTokens}` | `thinking: {type:"adaptive"}` + `effort` | `disabled` |
|---|---|---|---|
| Sonnet 4.5 (deprecated), Opus 4.5, Haiku 4.5, earlier Claude 4 | Supported — the only option | **Returns 400** | accepted |
| Opus 4.6, Sonnet 4.6 | Accepted but `budget_tokens` **deprecated** | Supported — the migration target | accepted, subject to the effort gate |
| 4.7 and later (Opus 4.7/4.8, Opus 5, Opus 5.5, Sonnet 5, Sonnet 5.5, Fable 5, Fable 5.1, Haiku 5.5) | **Returns 400** | Required | rejected by always-adaptive models; `between_tools` substituted on Sonnet 5.5 |

- Mapping rule: the boundary is decided by **model**, not by a global default. The current
  mapper sends legacy `type:"enabled"` to every Anthropic model, which is a 400 on 4.7+ and
  deprecated on 4.6. This is a live defect, not a future concern.
- Because Anthropic's `/v1/models` listing reports no reasoning metadata, the model→mode
  decision comes from the table above and is labelled as a TBAi contract, never as
  provider-reported capability (`provenance` stays `unknown` for these rows).

### 7.3 Google

- SDK (`@ai-sdk/google` 4.0.100, `dist/index.d.ts:19-22`) — the request-level
  `thinkingConfig` is `{ thinkingBudget?: number; includeThoughts?: boolean; thinkingLevel?:
  "minimal" | "low" | "medium" | "high" }`. All three are optional and the union is **not**
  a per-model statement.
- The "exactly one of `thinkingLevel` / `thinkingBudget`, and when neither is set the
  provider sends `thinkingLevel: 'low'`" wording is from the SDK's **Live-model** options
  type (`dist/index.d.ts:843-854`), not from the primary `thinkingConfig`. Revision 2 cited
  it as if it applied to every Gemini path; it is quoted here with its actual scope, and the
  mutual-exclusivity rule below is treated as a TBAi-side rule (never send both), which holds
  regardless.
- Supported levels vary **by model, not just by generation**. Google's own compat table has
  a separate column per model and the columns disagree inside one generation. Verbatim, from
  https://ai.google.dev/gemini-api/docs/openai:

  | `reasoning_effort` (OpenAI) | `thinking_level` (Gemini 4 Argon) | `thinking_level` (Gemini 3.1 Flash-Lite) | `thinking_level` (Gemini 3 Flash) | `thinking_budget` (Gemini 2.5) |
  |---|---|---|---|---|
  | `minimal` | `low` | `minimal` | `minimal` | 1,024 |
  | `low` | `low` | `low` | `low` | 1,024 |
  | `medium` | `medium` | `medium` | `medium` | **8,192** |
  | `high` | `high` | `high` | `high` | **24,576** |

  Two things follow. `minimal` is not a level on every current model — Argon maps it down to
  `low` — so the previous revision's "generation ≥ 3 ⇒ all levels" rule is too coarse. And
  the budget column is Google's, not a suggestion.

- **Google's documented budget conversion vs. TBAi's own presets.** These are two different
  things and revision 2 labelled the first as if it were the second.

  | Level | Google's documented `thinking_budget` (Gemini 2.5) | TBAi preset **proposed** | Label |
  |---|---|---|---|
  | `minimal` | 1,024 | — | — |
  | `low` | 1,024 | 1024 | matches Google |
  | `medium` | **8,192** | **4096** | **TBAi heuristic — half of Google's value** |
  | `high` | **24,576** | **8,192** | **TBAi heuristic — one third of Google's value** |

  The 1024 / 4096 / 8192 triple is what TBAi's current mapper hardcodes
  (`?? 4096` aside). It is **not** Google's conversion and must not be described as
  documented. Two acceptable outcomes, and the implementation must pick one explicitly:
  (a) adopt Google's published values, or (b) keep the cheaper presets and label them in the
  code and in `docs/provider-system.md` as deliberate TBAi cost choices. This plan takes
  **(b)** — it changes no existing behaviour — and requires the mislabelling to be corrected
  wherever the numbers appear.

- **Disable.** Verbatim: *"If you want to disable thinking, you can set `reasoning_effort`
  to `"none"` for 2.5 models. Reasoning cannot be turned off for Gemini 2.5 Pro or 3
  models."* So `off` maps to `none` / `thinkingBudget: 0` only for the 2.5 Flash-class, and
  to *nothing sent + `model_always_thinks`* for 2.5 Pro and every Gemini 3+ model (§7.0).
  Google's `thinkingLevel` union has no `"none"` member (`dist/index.d.ts:22`), which is
  consistent with the sentence above rather than contradicting it.
- `includeThoughts: true` must be sent whenever any thinking config is sent, or the UI
  receives no thought summaries at all. This is the one flag that must not be dropped — and
  §7.2 shows Anthropic has the same requirement in a different field (`display`), so the
  rule is "ask for the summary to be returned", per provider.
- The `lite`/`nano` name gate is removed. Whether a model accepts a budget is a documented
  per-model fact, not a substring match. (Note the current chat mapper's gate is dead code
  for the Google-3 path anyway: `isLite` is only consulted on the 2.5 branch.)
- Per-model restrictions must be retained per model, not per family. `GoogleModelId`
  (`dist/index.d.ts:16`) is again an open set ending in `(string & {})`, so it cannot bound
  anything; the table above is the evidence and TBAi's copy of it is a labelled contract.

### 7.4 Custom

- Requires an explicit compatible-protocol decision. `resolveApiProtocol` already defaults `custom` to `chat-completions`.
- **Do not assume all OpenAI-compatible providers support all OpenAI parameters.** A `custom` endpoint is not evidence of `reasoning_effort` support.
- Default: send nothing unless the provider has been explicitly classified. Classification is a configuration decision, and until it exists the honest behaviour is `off`/`default` only, with the UI saying so.

### 7.5 Ollama

- Runtime path is `/v1/chat/completions` via `createOpenAICompatible`; namespace is
  `openaiCompatible`; field is `reasoning_effort`.
- Levels come from discovered `thinking.values` (model-defined, opaque, sent verbatim).
- Boolean-control models: `{kind:"enabled"}` → a recognized effort that the daemon maps to
  `true`; `{kind:"off"}` → `"none"`, which the compat doc says "requests `false`" — and only
  for boolean-only models.
- Named-level models: `off` has **no documented wire value** (§3.1), so TBAi sends nothing
  and reports `disable_not_supported`. `"none"` is not quietly reused here, because the
  sentence that defines it is scoped to boolean-only models.
- Unsupported names must not be sent: Ollama would silently substitute the model default,
  which reads in the UI as "my setting did nothing".
- The compatibility aliases (`minimal`→`low`, `xhigh`/`ultra`→`max`) and the GPT-OSS
  exception are **not** relied upon. They apply to models *without* metadata, and TBAi
  cannot tell from `/v1/chat/completions` which class a model is in; the honest behaviour
  for `unknown` remains "send nothing".
- Ollama is **not** omitted from Scheduler reasoning.
---

## 8. Complete file-change list (corrected)

### 8.1 Backend

| File | Change |
|---|---|
| `src/lib/reasoning-selection.ts` **(NEW)** | The one owner of the contract: `ReasoningSelection`, `ReasoningSelectionScalar`, `REASONING_KEYWORDS`, `encodeReasoningSelection`, `decodeReasoningSelection`, `validateReasoningSelection`, and the `reasoningSelectionScalarSchema` used by `validation.ts`. Pure + dependency-free, so both routes and services can import it without a cycle. |
| `src/services/ai-capabilities.ts` **(NEW)** | The single provider-specific mapper: `resolveReasoningProviderOptions` returning `{ providerOptions, applied, notices }`, and `documentedReasoningContract(provider, model)` implementing §7.0. Uses `providerOptionsNamespace()` and `resolveApiProtocol()`. Contains no `?? "medium"` and no hardcoded namespace. |
| `src/services/modelDiscovery.ts` | `fetchOllamaModel`: parse `thinking.values` **and** `thinking.default`; emit `levels`, `booleanControl`, `disable`, `defaultLevel` (`string \| boolean`), `provenance`; distinguish absent / unsupported / boolean-with-/without-off / levels / mixed / malformed; preserve legacy `capabilities:["thinking"]` as supported-without-levels. Never infers disable-ability from absence. |
| `src/routes/chat/provider-options.ts` **(DELETE)** | Implementation moves to `ai-capabilities.ts`. Not re-exported. |
| `src/routes/chat/model.ts` | `ResolvedChatModel.reasoning` becomes `ReasoningSelection` (bare `string` today, `:31`); `withProviderDefaults` applies the §4.6 order exactly once; the model-reported default is consulted only when request/conversation/provider are all unset. |
| `src/routes/chat/validate-and-resolve.ts` | Import from `src/services/ai-capabilities.ts` + `src/lib/reasoning-selection.ts`; validate before mapping; pass `capabilities` for the resolved model; **delete the duplicate `?? provider.thinking ?? "off"` at `:210`**; read step `warnings` and log them (§5.4). |
| `src/services/scheduler/schedulerExecution.ts` | Delete the inline mapping block (lines 199-217); call `resolveReasoningProviderOptions`; remove the `isLite` name gate and the hardcoded `openai` namespace; log `notices` and provider `warnings` against the run's `requestId`. Writes nothing into `scheduler_runs.error` for a notice. |
| `src/services/scheduler/schedulerValidation.ts` | Two changes, both required: (1) add `checkThinkingLevel(value, providerId, modelId)` using `validateReasoningSelection`, wired into the existing `check*` chain; (2) **close the engine guard** — see §8.4. |
| `src/services/scheduler/schedulerTypes.ts` | `ThinkingLevel` becomes `ReasoningSelection`. **Not** `"off" \| "default" \| "none" \| string` — that union reduces to `string` and enforces nothing (§6.2a). |
| `src/services/scheduler/schedulerStore.ts` | `thinkingLevel` accepts `ReasoningSelection`, encodes to the scalar at the SQL boundary; column unchanged (TEXT). |
| `src/lib/validation.ts` | **Seven** enum sites (56, 77, 167, 206, 560, 619, 672) replaced by `reasoningSelectionScalarSchema`; **and** `reasoningCapabilitySchema` (`:10-13`) extended with `booleanControl`, `disable`, `defaultLevel: string \| boolean`, `provenance`, plus the §6.6 combination rules. Without the second half the new fields are stripped on every write. `logLevelFilterSchema` (`:808`) is not a reasoning site and stays untouched. |
| `src/types/index.ts` | `ReasoningCapability`: add `disable: ReasoningDisable`, `defaultLevel?: string \| boolean`, `booleanControl?: boolean`, `provenance`; add `ReasoningDisable` and `ReasoningProvenance`. `ProviderConfig.thinking` (`:140`) widens to `ReasoningSelectionScalar`. |
| `src/services/opencode/sessions.ts` | Apply stored variant in the server-default-model branch (currently only inside `if (modelRef)`). |
| `src/routes/providers.ts` | No change required (already imports `discoverModels`). Listed to record that the audit claim about it was wrong, not to modify it. |

### 8.2 Frontend

| File | Change |
|---|---|
| `web/src/lib/reasoning-selection.ts` **(NEW)** | Mirror of the backend contract (keywords, prefix, encode/decode, validate). Guarded against drift by §6.5. |
| `web/src/lib/ai-capabilities.ts` **(NEW)** | `resolveThinkingOptions`, `resolveDirectDefaults` (returns `effective` + `needsAttention`), `resolveOpenCodeDefaults`, and the one default-level formatter that renders both a string and a boolean `defaultLevel`. |
| `web/src/types/index.ts` | `ReasoningCapability` gains `disable` / `defaultLevel` / `booleanControl` / `provenance`; `ReasoningLevel` (`:72`) is replaced by `ReasoningSelection` + the scalar; `SchedulerJob.thinkingLevel` (`:391`) and `SchedulerJobDraft.thinkingLevel` (`:456`) follow. |
| `web/src/components/composer/DirectChips.tsx` | `THINKING_OPTIONS` (`:27`) stops being the source of the list; render from `resolveThinkingOptions`; distinguish `off` / `Default` / `on` (§4.2); replace the `stored ?? custom?.reasoningLevel ?? providerDefault` chain at `:159` with `resolveDirectDefaults`; render the §4.7 limitation text. |
| `web/src/features/scheduler/SchedulerPage.tsx` | Use `activeProviderId` via `resolveDirectDefaults`; remove `providers[0]` at `:168-169`; pass `engine` on the conversations it hands to `JobEditor`. |
| `web/src/features/scheduler/components/JobEditor.tsx` | Capability-driven thinking control; OpenCode agent/model from live catalogue; qualified `providerID/modelID`; require explicit selection when no default; lock fields for existing conversation. Plus §8.4: `conversations` prop typed with `engine` (`:135` today), the `(c as any).engine` cast at `:957` removed, and the Direct selector at `:888` filtered. |
| `web/src/features/scheduler/lib/scheduler-draft.ts` | Types follow; `null` means default. |
| `web/src/config/tools.ts` | New copy strings for the §4.7 limitation notices and the on/off control, per the existing rule that TBAi tool/chat UI copy has exactly one owner. |
| `web/src/features/providers/ProviderDialog.tsx` | **No change.** Per §4.5 decision (b), per-model capability editing is out of scope. Its `THINKING_OPTIONS` (`:37`) becomes the *provider default* picker only, and must accept the encoded scalar. |

### 8.3 Explicitly not changed

- No database schema or migration. `thinking_level` / `reasoning_level` are TEXT and stay TEXT.
  `scheduler_runs` gains no notices/warnings column (§5.4); the operator record is the log.
- No new dependencies.
- No new API endpoints.
- No changes to `src/services/capabilityDiscovery.ts` (its limit extraction is correct and orthogonal).
- No `AI_SDK_LOG_WARNINGS` global installation — TBAi reads `StepResult.warnings` directly
  at the two execution boundaries rather than installing a process-wide hook.

### 8.4 Direct/OpenCode isolation — both directions (new in revision 3)

Verified at `8e07e1d`, this is asymmetric in the backend and absent in the frontend:

- `schedulerValidation.ts:90-93` rejects a non-OpenCode target **only inside** the
  `engine === "opencode"` branch. There is no `else` branch, so a **Direct** job with
  `conversationPolicy: "existing_thread"` pointing at an OpenCode conversation passes
  validation. The doc comment at `:62-63` already promises "engine mismatch" in both
  directions, so the code contradicts its own stated contract.
- `JobEditor.tsx:135` types the prop as `Array<{ id: string; title: string }>` — no engine —
  yet `:957` filters with `(c as any).engine === "opencode"`. That cast exists only because
  the type is missing a field, and it violates the repository's no-`any` rule.
- The Direct branch (`:888`) renders `conversations.map(...)` **unfiltered**, so a user can
  pick an OpenCode conversation for a Direct job and the server accepts it today.

Required changes, all in scope:
1. `checkExistingThread` gains the mirror guard: when `engine !== "opencode"` and the target
   `conversation.engine === "opencode"`, return a specific error naming the mismatch. Legacy
   rows with `engine: null` keep today's semantics (the existing branch already treats
   OpenCode as an explicit value rather than a default).
2. `JobEditor`'s `conversations` prop is typed `Array<{ id: string; title: string; engine: "direct" | "opencode" | null }>`;
   the `as any` is deleted; the Direct selector filters to non-OpenCode conversations and the
   OpenCode selector filters the other way.
3. `SchedulerPage` must supply the field — the conversation list it already fetches needs
   `engine` in whatever selector or store provides it, and that type change is part of this
   file list, not a follow-up.

`src/lib/validation.ts` also needs the engine value accepted where conversation targets are
validated, so a mismatch is rejected with a stated reason rather than a generic 400.

---

## 9. Test matrix (corrected)

Revision 2 listed 33 scenarios with no paths, so nothing proved where any of them would
run. Each scenario below is anchored to the file that will contain it, and every path is
inside a directory that already exists (or, for two new files, an existing layer directory).
All of them are collected by the current runners: `bun run test` scans
`./tests/unit ./tests/integration`, `bun run test:dom` scans `./tests/dom`, and
`bun run test:locations` fails any test written outside `tests/`.

Baseline, measured at `8e07e1d`: **no test in `tests/` references
`buildReasoningProviderOptions`, `reasoningEffort` or `thinkingBudget`** (`grep -rln` returns
nothing). The current mapper has zero coverage, so every case below is new and there is no
existing characterization suite to preserve — which is itself why §5.3's equivalence test and
§9.1–§9.3 must be written before the move, not after it.

### 9.1 `tests/unit/services/ollamaThinkingDiscovery.test.ts` (NEW)

Drives `fetchOllamaModel` against stubbed `/api/show` bodies. No live daemon.

1. **Named levels and default** — `thinking: { values: ["low","medium","high"], default: "medium" }` → `support: "supported"`, `levels` exactly those three, `defaultLevel: "medium"`, `disable: "not_reported"`, `provenance: "provider_reported"`.
2. **Boolean control with off reported** — `values: [true, false]` → `supported`, `booleanControl: true`, `disable: "reported"`, no `levels`.
3. **Boolean control without off** — `values: [true]` → `supported`, `booleanControl: true`, `disable: "not_reported"`.
4. **Boolean default preserved** — `values: [true, false], default: false` → `defaultLevel === false` (a boolean survives; it is not discarded as malformed).
5. **Explicit unsupported** — `values: [false]` → `support: "unsupported"`, not `unknown`.
6. **Unknown metadata** — `thinking` key absent → `unknown`, no levels, no default, `disable: "unknown"`.
7. **Malformed metadata** — `thinking: "yes"`, `values: "low"`, `values: ["low", true]` (mixed) → `unknown` + malformed recorded, no crash, no invented levels.
8. **Default rejected on type mismatch** — string `default: "turbo"` not in `values`; and boolean `default: true` beside string `values` → `defaultLevel` absent.
9. **Legacy daemon** — `capabilities: ["thinking"]`, no `thinking` key → `supported`, no levels, `disable: "unknown"`, `provenance: "provider_capabilities"`.
10. **Unreachable daemon** — non-2xx → `unknown`; discovery continues for the other models in the same call.

### 9.2 `tests/unit/lib/reasoningSelection.test.ts` (NEW)

Covers `src/lib/reasoning-selection.ts` (§6.2a) — encode/decode totality and validation.

11. **Round trip** — every selection kind survives `decode(encode(x)) === x`.
12. **Legacy bare values decode as levels** — `"low"`, `"medium"`, `"high"`, and an arbitrary stored `"turbo"`.
13. **`"off"` decodes to `{kind:"off"}`, not a level** — the legacy meaning is preserved.
14. **Reserved-word level collision** — a discovered level named `"off"` encodes to `"level:off"` and decodes back to `{kind:"level", level:"off"}`; it is never read as "disable".
15. **Malformed scalars rejected** — `""`, `"   "`, `"level:"`, `"level:" + 250 chars`, a value containing a control character.
16. **`enabled` requires a boolean control** — valid with `booleanControl: true`, rejected with levels-only and with `unknown`.
17. **Level must be in discovered `levels`** — `"level:ultra"` against `["low","medium","high"]` → `ok: false`, reason `level_not_supported`.
18. **`unknown` support admits only the provider contract** — a contract level passes, an off-contract string is rejected; an unclassified `custom` accepts only `off`/`default`.

### 9.3 `tests/unit/services/aiCapabilities.test.ts` (NEW)

Covers `resolveReasoningProviderOptions` + `documentedReasoningContract` across all providers.

19. **Ollama namespace** — produces `providerOptions.openaiCompatible.reasoningEffort`, never `providerOptions.openai`. **(8)**
20. **Ollama boolean off** — `{off}` + `disable: "reported"` → `reasoningEffort: "none"`, `applied {kind:"off",sent:true}`, no notices.
21. **Ollama named-level off** — `{off}` + levels → **no option sent** and notice `disable_not_supported` — the case revision 2 got wrong. **(2)**
22. **Ollama unknown sends nothing** — no aliases relied upon.
23. **OpenAI `off`** — sends `reasoningEffort: "none"` (row 1, §7.0).
24. **OpenAI per-contract rejection** — `xhigh` where excluded → nothing sent + `level_not_supported`; same level where allowed → verbatim. **(9)**
25. **Protocol namespace split** — `openai` responses vs `openai` chat-completions differ. **(10, 18)**
26. **Anthropic legacy model** — `thinking: {type:"enabled", budgetTokens}`, `adaptive` never sent. **(11)**
27. **Anthropic 4.6** — adaptive + `effort`, no `budgetTokens`. **(12)**
28. **Anthropic 4.7+** — adaptive + `effort`, `type:"enabled"` never sent. **(13)**
29. **Anthropic summary is requested** — every adaptive request carries `display: "summarized"`; a test asserts the empty-thinking defect (§7.2) cannot recur.
30. **Anthropic always-adaptive `off`** — `claude-opus-5-5`-class: nothing sent + notice `model_always_thinks`; `claude-sonnet-5-5`-class: `between_tools` + `model_always_thinks`; effort-gated disable emits `disable_not_supported` above `high`.
31. **Google budget labels** — `low`/`medium`/`high` → 1024/4096/8192 (TBAi presets, asserted as behaviour) and a table-driven case naming Google's documented 1024/8192/24576 so the two cannot be silently conflated again. **(15)**
32. **Google never sends both** — `thinkingLevel` absent when a budget is sent.
33. **Google `includeThoughts`** — present on every request that sends any thinking config. **(16)**
34. **Google disable split** — 2.5-Flash-class `off` → disable value sent; Gemini 3 / 2.5 Pro `off` → nothing sent + `model_always_thinks`.
35. **Custom classification** — unclassified sends nothing + `no_provider_contract`; classified chat-completions sends `reasoningEffort` under `openaiCompatible`. **(17)**
36. **No silent medium** — an unrecognized level never becomes `"medium"`, and no branch uses `?? 4096`.
37. **Chat/Scheduler equivalence** — same `(type, apiProtocol, model, selection, capabilities)` yields deep-equal `providerOptions` **and** `notices` through both call paths. **(19)**

### 9.4 `tests/unit/tooling/no-duplicate-reasoning-mapping.test.ts` (NEW)

38. **No second mapper survives** — source-text scan asserting `schedulerExecution.ts` and `validate-and-resolve.ts` contain no provider-specific reasoning branches (no `thinkingBudget`, `budgetTokens`, `reasoningEffort` literals). Follows the existing `tests/unit/tooling/` guard style; asserts the invariant, not the layout. **(20)** Verified able to fail by re-adding a branch and watching it go red.

### 9.5 `tests/unit/lib/reasoningCapabilitySchema.test.ts` (NEW)

39. **§6.6 combination table** — one case per row, each rejected with its stated message.
40. **Legacy payloads still validate** — `{ reasoning: { support: "unknown" } }` unchanged.
41. **All seven enum sites accept the encoded form** — a table over the chat, conversation create/update, provider create, scheduler job create, scheduler AI-tool create and scheduler update schemas asserting `"level:high"`, `"off"`, `"default"`, `"enabled"` are accepted and `"turbo"` is accepted only as legacy.
42. **`logLevelFilterSchema` is untouched** — asserts `"off"` still validates there as a log level, guarding against a sweep-the-file edit.

### 9.6 `tests/integration/providers/capabilityRoundTrip.test.ts` (NEW)

The path the review called out as missing. Uses an in-process stub `/api/show`, no network.

43. **Discovery → API → persistence → reload** — a boolean-control model is discovered, saved through `POST/PATCH /api/providers`, read back from SQLite, re-validated by `reasoningCapabilitySchema`, and the reloaded `ModelOption.capabilities.reasoning` is deep-equal to what the parser produced (`booleanControl`, `disable`, `defaultLevel` as a boolean, `provenance`). Any dropped field fails here, which is the exact defect §8.1 prevents.
44. **Levels round trip** — named levels and a string `defaultLevel` survive the same path.

### 9.7 `tests/unit/chat/reasoningResolution.test.ts` (NEW)

Drives `resolveChatModel` + the route's application point.

45. **Precedence** — request override beats conversation, conversation beats `provider.thinking`, `provider.thinking` beats the model-reported default, model default beats `"off"`; one case per tier boundary. **(§4.6)**
46. **Configured provider default is not outranked by metadata** — provider `thinking: "low"` + model `defaultLevel: "high"` → effective `"low"` (the reversal of revision 2).
47. **Model default used only when nothing is configured** — all three tiers unset + `defaultLevel: "medium"` → effective `"level:medium"` **and** the label says "model default".
48. **Single application** — after the `validate-and-resolve.ts:210` duplicate is deleted, the provider default is applied exactly once (asserted by a case where double application would differ).

### 9.8 `tests/unit/chat/providerWarnings.test.ts` (NEW)

49. **Provider objections are logged, not swallowed** — a fake model whose step result carries `warnings: [{ type: "unsupported", message: "thinking cannot be disabled …" }]` produces a `logger.warn` with event `reasoning_setting_not_applied` and the requestId; a warning never flips a run to failed. **(§5.4)**

### 9.9 `tests/unit/web/lib/aiCapabilitiesResolver.test.ts` (NEW)

50. **Unknown is never supported** — `resolveThinkingOptions` returns `state: "unknown"`; no generic level list is produced. **(21)**
51. **Missing metadata is never permission** — a model with no `capabilities` behaves as `unknown`. **(22)**
52. **Unsupported hides the control** — no level list; only `off`/`default`. **(23)**
53. **Boolean control renders on/off** — levels list is empty, `enabled` is offered, no four-item list.
54. **Cannot-disable is surfaced, not claimed** — `off` + `disable: "not_reported"` yields `needsAttention: true` and the distinguishing text of §4.7; the three UI states are three different outputs.
55. **`defaultLevel` formatting** — a string renders the level; `true`/`false` renders on/off wording; neither prints the raw boolean.
56. **Provider fallback removed** — unresolvable `activeProviderId` → `ok: false`, never `providers[0]`. **(24)**
57. **OpenCode model fallback removed** — no `defaultModel` → `model: null`, never `models[0]`. **(25)**
58. **Legacy `supported`-without-levels is not a level list** — `{ state: "unknown", providerContract }`.

### 9.10 `tests/unit/web/lib/reasoningSelectionMirror.test.ts` (NEW)

59. **Front/back drift guard** — both trees declare the same `REASONING_KEYWORDS` and the same `level:` prefix (§6.5). Proven able to fail by editing one list, running it red, and reverting.

### 9.11 `tests/unit/scheduler/schedulerThinkingValidation.test.ts` (NEW)

60. **`checkThinkingLevel`** — a contract-valid level passes; an off-contract level is rejected with the specific reason; `null` passes as "default"; a `custom` unclassified provider rejects every level.
61. **Both engine directions** — a Direct job targeting an OpenCode conversation is rejected; an OpenCode job targeting a Direct conversation is still rejected; legacy `engine: null` rows keep existing semantics. **(30, §8.4)** Written first and observed failing against `8e07e1d`, which is the evidence that the missing Direct guard is real.

### 9.12 `tests/dom/scheduler/jobEditorEngineConversations.test.tsx` (NEW)

62. **Direct selector hides OpenCode conversations** and the OpenCode selector hides Direct ones; a source scan asserts `JobEditor.tsx` contains no `as any`, so the cast cannot come back once the prop type carries `engine`. **(§8.4)**
63. **Capability-driven thinking control** — a boolean-control model shows on/off; an always-thinking model shows the limitation text; a model with named levels shows exactly those.
64. **No default advertised** — the editor requires an explicit selection and says why. **(29)**

### 9.13 `tests/dom/components/directChipsThinking.test.tsx` (NEW)

65. **`Off` vs `Default` vs `On` are distinguishable** in the rendered chip, including after a reload, and `off` on an always-thinking model displays the limitation copy rather than a bare "Off". **(§4.7)**

### 9.14 `tests/integration/persistence/reasoningBackcompat.test.ts` (NEW)

66. **Saved conversations** — rows holding `off`/`low`/`medium`/`high` load unchanged and remain selectable. **(31)**
67. **Saved Scheduler jobs** — `thinkingLevel: null` resolves to "send nothing"; the stored value is not rewritten. **(32)**
68. **A `null` job now reads "Default"** — the deliberate visible change of §6.4, asserted so it cannot silently become `"Off"` again.
69. **Invalid-for-model saved value** — surfaced as unsupported with the value retained, never replaced. **(33)**
70. **Qualified OpenCode refs** — stored `providerID/modelID`; legacy bare ids still resolve; a job with no explicit model and a stored variant applies that variant at session creation. **(27, 28)**
71. **SchedulerPage never binds to a non-active provider** — a job is not created against `providers[0]`. **(26)**

Scenario numbers in parentheses are the revision-2 list, kept so the earlier audit trail still resolves. Scenarios **2, 21, 29, 30, 43, 45, 46, 54, 61, 62** are the ones that exist specifically because of the review, and **61** is the one to write first: it fails against `8e07e1d` today.

---

## 10. Ordered implementation phases

0. **Engine isolation guard first** — `schedulerValidation.ts` Direct→OpenCode guard plus
   `JobEditor` conversation typing/filtering. Covered by §9.11 case 61 and §9.12 case 62.
   This is the only item that is a pure bug fix with no dependency on the rest of the plan,
   and case 61 fails against `8e07e1d` before the change, which is the proof it is real.
1. **Types and contract** — `src/lib/reasoning-selection.ts` + its `web/` mirror,
   `ReasoningCapability` fields (`disable`, `defaultLevel`, `booleanControl`, `provenance`)
   and `ReasoningProvenance` / `ReasoningDisable` in both type trees. Tests §9.2, §9.10. No
   behaviour change yet.
2. **Ollama discovery** — `fetchOllamaModel` parsing; tests §9.1 (1–10). The only phase that
   adds new capability data.
3. **Shared mapper** — create `src/services/ai-capabilities.ts`, delete
   `src/routes/chat/provider-options.ts`, port chat, then delete Scheduler's inline block.
   Tests §9.3 (19–37) and §9.4 (38). §9.3 case 37 is the equivalence gate and must pass
   before the old file is deleted, not after.
4. **Validation** — `src/lib/validation.ts` **seven** sites + `reasoningCapabilitySchema` +
   `checkThinkingLevel`; tests §9.5 (39–42) and §9.11 (60), and the round trip §9.6 (43–44).
5. **Resolution and warnings** — `src/routes/chat/model.ts` precedence, removal of the
   duplicate application at `validate-and-resolve.ts:210`, provider-warning capture in both
   execution paths; tests §9.7 (45–48) and §9.8 (49).
6. **Frontend resolver** — `web/src/lib/ai-capabilities.ts`; `DirectChips.tsx`;
   `SchedulerPage.tsx`; tests §9.9 (50–58) and §9.13 (65).
7. **JobEditor** — capability-driven controls, OpenCode catalogue wiring, qualified model
   refs; tests §9.12 (62–64).
8. **OpenCode session variant** — `sessions.ts` server-default branch; test §9.14 case 70.
9. **Backward compatibility pass** — tests §9.14 (66–71), plus a manual check against an
   existing database.

Each phase is independently revertible. Phase 0 and phases 1–5 carry the correctness fixes;
6–9 carry the UI and compatibility work. Phase 4 depends on phase 1 (the schema validates
the encoded form) and phase 3 depends on phase 1 as well — no phase may introduce a second
place that constructs a `ReasoningSelection`.

---

## 11. Remaining unresolved issues

1. ~~**Anthropic SDK option path for adaptive effort.**~~ **Withdrawn.** Resolved against
   the pinned 4.0.83 build in §7.2: `providerOptions.anthropic = { thinking: { type:
   "adaptive", display }, effort }`, with `output_config.effort` written at
   `dist/index.js:3781`. Nothing about the path is left to discover at implementation time.
2. **The provider restriction tables are TBAi-owned copies.** Both `AnthropicModelId` and
   `GoogleModelId` end in `(string & {})` — open sets that bound nothing — and the Anthropic
   SDK's `getModelCapabilities` is internal, not exported. So §7.0/§7.2/§7.3 tables are
   hand-maintained, each row labelled with the build or doc page it came from. They will
   drift. Required mitigation: each table row carries its source string, and the suite is
   re-run whenever `@ai-sdk/anthropic`, `@ai-sdk/google` or `@ai-sdk/openai` moves.
3. **Per-model OpenAI effort contracts.** The API publishes no machine-readable per-model
   effort list, so OpenAI levels are validated against discovery (which reports `unknown`)
   or the labelled contract only. The UI must keep saying "provider contract", not "this
   model supports it".
4. **Per-model Gemini level support.** Google's compat table names current models (Gemini 4
   Argon, 3.1 Flash-Lite, 3 Flash) but is not exhaustive. A Gemini model absent from the
   table behaves as `unknown`, not as "all levels".
5. **Custom provider classification.** No mechanism exists to declare "this endpoint
   supports `reasoning_effort`". Until it does, `custom` stays `off`/`default` only. This is
   §4.5 option (a) territory and is a separate plan.
6. **`none` user-selectability.** Unchanged from revision 2: kept in the contract for
   validation and mapping, not exposed as a user choice.
7. **Ollama boolean `default`.** Accepted by the parser as an inference from the documented
   `think` value domain (§3.1), not as a documented sentence. If a real daemon is found to
   report something else, the parser rule — not the inference label — must change, and this
   item is re-opened.

---

## 12. Confirmation

Revision 3 (2026-11-03):

- **No implementation work performed.** Nothing under `src/`, `web/` or `tests/` was
  created, modified or deleted. No dependency, no schema, no migration.
- **No commit and no push.** `HEAD` remains `8e07e1d` on `ci/tauri-e2e-verify`; `bun.lock`
  and `package.json` were already modified before this task and were left untouched.
- **One file written:** `docs/scheduler-form-plan.md` (untracked, as it was before).
- **Two kinds of edit, both disclosed.** (1) Encoding repair: the revision-2 file carried
  **139** double-encoded UTF-8 sequences (`â€”`, `â†’`, `Â§`, `â‰¥`, `â‡’`, `â€¦`, `â‰¤`)
  across 90 lines — an em dash written as UTF-8, re-read as CP1252 and re-encoded. Each was
  replaced with its intended character, verified to reduce the residual count to 0. This is
  a separate concern from the content corrections and touched no prose meaning. (2) The
  §3–§9 corrections plus the §1.1 record, §2.7 count fix, §10 phase renumber and §11
  withdrawal that those corrections forced.
- **Every new factual claim in revision 3 was verified in this session** — against
  `node_modules` files and line numbers, against `src/`/`web/` line numbers at `8e07e1d`, or
  against provider pages fetched on 2026-11-03 and quoted verbatim. Where a claim is an
  inference rather than a documented sentence, it is labelled as one (§3.1, §11 item 7).
- **One review claim was not accepted as stated** — §1.1 row 13 records that the Ollama docs
  document `values` as boolean-or-string, not `default`, and the fix is justified on that
  basis instead.