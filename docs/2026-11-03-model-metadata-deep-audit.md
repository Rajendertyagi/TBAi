# TBAi — Models.dev Integration: Deep Audit and Simplified Plan

> [!WARNING]
> **SUPERSEDED FOR REASONING EFFORT — HISTORICAL, NOT AN ACTIVE PLAN.** The proposed custom reasoning codec, Models.dev reasoning-metadata discovery framework, prefixed/dynamic selection schemas, and the P2/P3 reasoning phases in this document are superseded. Direct Chat reasoning effort uses the simpler, library-first implementation built on AI SDK v7 native reasoning (see **§15, "Current implementation — native AI SDK v7"**, and `src/routes/chat/provider-options.ts`).
>
> - **Active in this document:** the context-window catalogue work (P1) and the discovery name-filter cleanup (P4).
> - **Historical in this document:** §4, §5, §9.1's moved-codec component, §10's P2/P3 rows, §11's reasoning schemas, §12, §13.5–§13.7, §14's reasoning notes, and §15's P2/P3. They are retained as an audit record and must not be implemented.
> - **Deferred, requiring separate approval:** model-specific reasoning metadata, dynamic selections, exact-value validation with `allowed` refusals, and any Scheduler adoption of a shared reasoning path.

**Revision:** 2.4 — reasoning-effort supersession reconciliation
**Date:** 2026-11-04
**Status:** Investigation and planning only. No source file, test, schema, dependency, or configuration was modified. No migration was run. Nothing was committed or pushed.
**Supersedes:** Revision 2.3. Revision 2.4 changes documentation status only: it applies the warning above throughout the document, marks the custom reasoning codec, reasoning-metadata discovery, and dynamic-selection phases as historical, and records model-specific reasoning metadata and dynamic selections as deferred work requiring separate approval. No R1–R6 decision is changed as a record, and none of them authorizes implementation. Revision 2.3 made exactly two corrections and left the architecture, the R1–R6 decisions, and every unaffected section unchanged: (1) the P2/P3 order is corrected so the shared backend encoder, exact-value validation, and backend tests land in P2, and no dynamic reasoning choice is exposed in the UI or accepted by the Scheduler until P3; (2) `budget_tokens.min = -1` is described as a valid upstream sentinel whose semantics must not be assumed from the observed catalogue rows, rather than as universal dynamic thinking. Revision 2.2 had superseded 2.1, which had corrected eight-state vocabulary but reinterpreted TBAi's existing stored `"off"` as an explicit-disable request and inferred Google/Anthropic disable support from catalogue fields that do not prove it. Revision 2.2 restored `"off"` to its actual current meaning (send no option = provider default), removed explicit disabling from the initial release, separated advertised `none` from `off`, removed the Google `min <= 0` inference entirely (the documented per-model rule is deferred, not adopted), corrected the Anthropic disable claim (`between_tools` is not a full disable), verified the provider-default/conversation/one-shot/scheduler path against the source, and corrected the observed-limit staleness claim. §0.4 remains the Revision 2.1 record; §0.5 remains the Revision 2.2 record. The architecture, module count, context-window resolver, budget/compaction policy, cache design, identity rules, and Scheduler scope are unchanged. Revision 1's research is preserved; its multi-module architecture remains replaced. `docs/2026-11-03-model-capability-integration.md` remains the earlier narrow proposal.
**Method:** direct reading of the TBAi working tree at `8e07e1d`, live measurement of `https://models.dev/api.json`, read-only study of Cline at pinned revision `5b454165353ac1edc9a7db0ff416739044985908`, verification against the **upstream Models.dev schema** (`sst/models.dev`, `dev` branch, `packages/core/src/schema.ts` and `schema-v2.ts`, plus its `AGENTS.md`), verification against the **installed** provider SDK type declarations and adapter implementations, and verification against the **official provider documentation** for Gemini and Claude thinking controls. Every claim is labelled **[Verified]**, **[Assumption]**, or **[Recommendation]**. Anything that could not be verified is labelled **[Unverified]** and named in Appendix B. Line numbers are from the TBAi tree at the commit above and will drift; the quoted symbol names are the durable reference.

---

## 0. Executive verdict

### 0.1 What is actually true today

1. **[Verified]** TBAi already has a complete, provenance-carrying context-limit pipeline. There is exactly one call to `resolveContextLimit` — `src/context/assemble.ts:327` — and everything downstream (`computeBudget`, the 0.8 compaction trigger, `generationCap`, `streamText.maxOutputTokens`) already consumes its result. The missing piece is not wiring. It is **where a better number comes from**, and **what authority that number has**.
2. **[Verified]** TBAi's capability type is already tri-state and already refuses to infer capability from model names (`src/types/index.ts:1-28`). The current defects are the *producers*, not the vocabulary.
3. **[Verified]** The Direct chat path discovers models from provider listings and never consults a catalogue. The scheduler does not use context assembly at all (`src/services/scheduler/schedulerExecution.ts:453-460`: one user message, no history, no budget, no `maxOutputTokens`).
4. **[Verified]** Reasoning support is `unknown` for OpenAI, Anthropic, and Google by construction (`src/services/modelDiscovery.ts:197,222,244`), and Ollama is `supported` only when `/api/show` returns the literal `"thinking"` token (`:116-119`).
5. **[Verified]** Direct Chat passes `low`/`medium`/`high` to AI SDK v7's top-level `reasoning` option (`src/routes/chat/execute-direct-stream.ts:405-410`); `"off"` omits it. `src/routes/chat/provider-options.ts:34-51` adds only Google's `includeThoughts`. The scheduler still re-implements a provider-specific encoder inline (`schedulerExecution.ts:199-217`) — the remaining divergence.
6. **[Verified]** Models.dev publishes far more than the earlier plan assumed — structured `reasoning_options` for 6,848 models, `limit.input` for 1,718, `limit.output` for all 8,935 — and far less than a naive reading hopes: **no protocol semantics, no defaults, no per-model freshness**.

### 0.2 What Revision 1 got wrong

Revision 1's research was sound; its recommended architecture was not. It introduced nine new files across three new module folders, per-model freshness fields, optional user binding, ETag revalidation, a disk-cache option, and a separate reasoning framework — none of which Cline does, and none of which TBAi needs.

| Revision 1 recommendation | Verdict | Correction |
|---|---|---|
| `src/services/modelCatalog/{client,normalize,identity,index}.ts` | **Rejected.** Four files for one fetch, one normalize, one lookup. | One file: `src/services/modelCatalog.ts`. |
| `src/services/catalogEnrichment.ts` | **Rejected.** A separate module whose only caller is discovery. | One exported function in `modelCatalog.ts`. |
| `src/services/reasoning/{capabilities,encode,index}.ts` | **Rejected.** A reasoning framework beside the existing encoding seam. | Also rejected in Revision 2.4: native AI SDK v7 reasoning needs no shared encoder, and `provider-options.ts` stays in `routes/chat/` (§15). |
| `ModelOption.catalogFetchedAt` / `catalogModelId` | **Rejected.** Cline has neither; `discoveredAt` already records the pass. | No new freshness fields. |
| `ProviderConfig.catalogProviderKey` | **Rejected.** New user configuration with no demonstrated need. | No enrichment for custom providers at all. |
| ETag / 304 revalidation | **Rejected.** Cline uses a plain fetch and a TTL. | TTL + in-flight dedup + last-known-good, exactly Cline's shape. |
| Optional disk cache | **Rejected.** No measured cold-start problem. | In-memory only. |
| `canonical_model_id` matching | **Rejected as before.** | Exact `(provider key, model id)` only. |
| Tool-definition gating, image/structured-output surfacing | **Out of scope.** Not asked for; adds responsibilities. | Not in this plan. |

### 0.3 The single sentence

> Fetch Models.dev during discovery, store its numbers and controls with a `model_catalog` provenance, keep TBAi's resolver and budget as the only authority, and extend the one existing encoder so chat and scheduler share it.

### 0.4 Correctness issues resolved

Seven defects in Revision 2 are corrected below. The architecture is unchanged; each correction is a rule, a validation bound, or a precedence, not a new module. The section numbers point to the corrected text.

| # | Previous behaviour (Rev 2) | Corrected behaviour (Rev 2.1) | Supporting source evidence | Test case |
|---|---|---|---|---|
| C1 | Reasoning vocabularies contradicted each other: §4.3 said `off` "always means send no reasoning option", while §12.3 sent explicit disables; §4.3 said supported/no-controls "reasons by default", while §12.1 said it "does not claim disable"; `none`/`default` were called ordinary values but `default` was also a distinct choice. | One vocabulary with eight distinct selection semantics, defined once in §12.1 and used by §4.1, §4.3, §5.3, §4.6, §12.2, §12.3. **Sending no option is never called disable**; it is "provider default". Explicit disable is a separate selection, offered only when the adapter can express it. `reasoning: true` with no usable control means "supported and undialable", not "enabled by default". | TBAi's `off` branch sends no reasoning option (`execute-direct-stream.ts:407`; `provider-options.ts:38` returns `{}`); installed `@ai-sdk/anthropic` `thinking` union (§12.3); `@ai-sdk/google` `thinkingBudget`; Models.dev publishes no default (§2.7). | §13.5 (semantics matrix), §13.7 (UI/encoder equality) |
| C2 | Compatible gateways were given `thinking: { type: "enabled" \| "disabled" }` and `thinking: { type: "enabled", budget_tokens }`; Anthropic toggle-on used `thinking: { type: "enabled" }`; Google `off` always sent `{}` even where a disable is documented. | Compatible gateways accept **only** `reasoningEffort`; toggle/budget controls are not offered on them. Anthropic `on` uses `{ type: "adaptive" }` only where an effort control exists. Google `off` uses `thinkingBudget: 0` only when a budget control publishes `min <= 0`; otherwise it is not offered. Effort controls dominate budget controls everywhere. | `@ai-sdk/openai-compatible` schema has exactly `user/reasoningEffort/textVerbosity/strictJsonSchema` and strips unknown keys (`dist/index.d.ts:18-27`); Cline's `routing_generic-compatible.ts` emits no generic `thinking`; `@ai-sdk/google` maps `reasoning: "none"` to `{ thinkingBudget: 0 }` (`dist/index.js:2398`); Google Cloud/Firebase docs state `thinking_budget: 0` disables 2.5 Flash/Flash-Lite. | §13.5 (compatible + toggle refused; Google off; Anthropic on), §13.8 guard 6 |
| C3 | Validation rejected `budget_tokens.min = 0` and `-1` (`z.number().int().positive()`), dropped `min <= 0`, and required non-empty non-null effort values. | Accept the upstream schema exactly: `min >= -1`, `max >= 0`, both optional, `min <= max`; effort entries may be `null`; `"default"` is retained. Skip only schema-invalid individual controls; never fail the model. `-1` is stored but never transmitted and is treated as `0` when resolving a preset. | Upstream `packages/core/src/schema.ts`: `min: z.number().min(-1).optional()`, `max: z.number().min(0).optional()`, effort `z.enum([... , "default"]).nullable()`; live payload has 37 `min=0` and 2 `min=-1` (§2.5). | §13.2 (min 0, min -1, missing bounds, null effort, duplicate controls) |
| C4 | P3 claimed the Scheduler's context-budget problem was fixed by "pass `model.maxOutputTokens`"; §14.2 said "shared codec + `maxOutputTokens`". | `maxOutputTokens` is a **per-generation output cap** only. Total context budgeting, accumulated tool-loop history, and compaction remain absent from the Scheduler. The superseded phase would have fixed only the per-generation cap and the namespace bug; a separate, explicitly out-of-scope item covers context assembly. No claim of resolution. | `schedulerExecution.ts:453-460` calls `streamText` with one user message, `stopWhen: stepCountIs(10)`, no `maxOutputTokens`, no `assembleContext`; chat passes `generationCap` and assembles context (`execute-direct-stream.ts:440`, `assemble-run.ts`). | §13.6 (scheduler cap only), §14.2, §15 deferred work |
| C5 | Precedence ranked `model_catalog` above `observed`, and `collectCandidates` excluded observed from arbitration entirely (`limits.ts:249`). | Precedence is `configured > provider_reported > observed > model_catalog > conservative_default > unknown`. Observed becomes a real candidate with evidence: it is keyed by provider config id + exact model + endpoint + protocol and is parsed only from a classified context-overflow error on that endpoint; catalogue data is third-party, model-wide, and endpoint-agnostic. A provider declaration still outranks an observation. | `src/context/observed-limits.ts` key construction; `src/lib/context-window-observation.ts:150-184` (context-overflow only); `src/context/limits.ts:249,380-415`; `budget.ts:358-363` shows divergence is diagnostics-only. | §13.4 (catalogue 128k + observed 64k → observed) |
| C6 | UI choices were derived from capability alone; nothing proved every rendered choice was encodable, and toggle-only/effort-only/budget-only/toggle+effort/toggle+budget were not checked against the adapter. | `allowedReasoningSelections` is the single validity rule; `reasoningChoices` must return exactly that set. Values are intersected with the adapter's accepted set (Google `minimal/low/medium/high`; Anthropic `low/medium/high/xhigh/max`; OpenAI `none/minimal/low/medium/high/xhigh/max`; compatible any string). A choice that would produce `unsupported_capability` is never rendered. | Installed SDK enums (§12.3); `DirectChips.tsx` fixed list; `JobEditor.tsx` hardcoded select; §13.7 matrix. | §13.7 cross-tree matrix; §13.8 guards 7–8 |
| C7 | **`"default"`** was described as an "ordinary advertised value" that could be passed verbatim. | `"default"` is a distinct selection meaning "use the provider's default depth": it is always available for supported capability (sending nothing is always encodable), is the only choice when the capability is undialable, and is encoded as **no level/budget field**. An advertised `default` is the same choice, not a duplicate. The literal string `"default"` is never transmitted. | Upstream schema admits `"default"`; no installed adapter accepts a `"default"` effort value (`@ai-sdk/openai` enum, `@ai-sdk/google` enum, `@ai-sdk/anthropic` enum). | §13.5 (`default` → `{}`), §13.8 guard 7 |

### 0.5 Correctness issues resolved in Revision 2.2

> **Status (Revision 2.4):** These six decisions remain the audit record for the reasoning semantics the superseded proposal would have implemented. Nothing here authorizes implementation. The invariants that still describe the live native path are: `off`/absent = Provider default and never a disable; no explicit-disable or `"on"` selection exists; no stored value is reinterpreted. Dynamic metadata, effort values beyond `low`/`medium`/`high`, budget presets, and `allowed` refusals are deferred (§15).

Revision 2.1's reasoning semantics were wrong in six places. The architecture is unchanged; each correction removes a claim, a stored value, or an inference that the source does not support. **§0.4 C1, C2, and C7 are superseded by R1/R2/R4 below; C3's bounds stand but its `-1` reading is corrected; C5's precedence stands but its staleness prose is corrected; C4 and C6 stand.**

| # | Previous behaviour (Rev 2.1) | Corrected behaviour (Rev 2.2) | Exact source evidence | Test case |
|---|---|---|---|---|
| R1 | `"off"` was reinterpreted as an explicit-disable request and encoded as Anthropic `thinking: { type: "disabled" }`, Google `thinkingBudget: 0`, or `reasoningEffort: "none"`. Because `"off"` is the stored default in provider configs, conversations, and the UI, first enrichment would have changed "send nothing" into "send a disable" without any user action. | `"off"` keeps its exact current meaning: **send no reasoning option** = provider default. It is never encoded as a disable, never reinterpreted, and never migrated. A missing selection also means provider default. Explicit disabling is removed from the initial release; no new stored value is introduced. | `src/routes/chat/execute-direct-stream.ts:407` (`"off"` omits the native reasoning option); `src/routes/chat/provider-options.ts:34-51` (Google `includeThoughts` only); `src/routes/chat/model.ts:54`; `src/routes/chat/validate-and-resolve.ts:210`; `src/services/scheduler/schedulerExecution.ts:199,202`; `web/src/components/composer/DirectChips.tsx:150-159`; `src/routes/providers.ts:66` (INSERT default `"off"`). | §13.5 (`off` → `{}` on every provider), §13.6 (default-path trace; enrichment writes no selection) |
| R2 | The UI could render `off` (reinterpreted as an explicit disable) and an advertised `none` as two chips with the same wire value, and `"on"` was invented as an explicit-enable selection. | One visible selection for explicit no-reasoning: **advertised `none`**. `off` is Provider default and sends nothing, so it is not a duplicate. `"on"` is removed: adaptive-without-effort was never verified. Four categories remain distinct: Provider default (`off`/absent), advertised `none`, explicit-disable toggle (**deferred, not offered**), and normal effort values. | `web/src/components/composer/DirectChips.tsx:27-32`; installed adapter effort enums (§12.3); models.dev measured 1,831 models advertising an effort `none` (§2.5); Cline `supportsOff = toggle \|\| advertised.has("none")` (`providers/model-facts.ts`). | §13.5 (`off` and `none` produce different requests), §13.7 matrix |
| R3 | Google `off` was offered whenever `budget_tokens.min <= 0`, and `min = -1` was treated as interchangeable with `0`. | Google has **no Off in the initial release**. `min <= 0` is not evidence of disable support, and `-1` is a valid upstream sentinel whose meaning is not assumed from the observed rows — not a claim of universal dynamic thinking, and not zero. `off` sends nothing on every Google model. A deferred, separately verified rule could add Off for `gemini-2.5-flash` and `gemini-2.5-flash-lite` only; it is not part of this plan. | `execute-direct-stream.ts:407` (today `off` adds no reasoning option and no Google `includeThoughts`); official Google docs for 2.5 Flash/Flash-Lite (`thinkingBudget: 0` disables), 2.5 Pro (cannot disable), and Gemini 3.x (cannot disable); models.dev rows publish 2.5 Flash-Lite `min 512` and 2.5 Pro `min 128` (§2.5). | §13.5 (Google `off` → `{}`; `-1` never emitted), §13.7 (no Off chip for Google) |
| R4 | Anthropic `off` with a `toggle` was encoded `thinking: { type: "disabled" }`, a catalogue `toggle` was read as proof of disable support, and `between_tools` was described as a complete disable. | Anthropic has **no Off in the initial release**. A catalogue `toggle` is not evidence: official documentation rejects `disabled` for Sonnet 5, Haiku 5.5, Opus 5.5, and Opus 4.7, and Sonnet 5.5 substitutes `between_tools`, which disables only *upfront* thinking and still returns between-tool notes. Unverified models offer no disable. Effort and budget controls remain available; `off` sends nothing. | Official Anthropic thinking documentation (per-model table); installed `@ai-sdk/anthropic` 4.0.83 rewrite behaviour (`dist/index.js:3721-3743`); models.dev publishes `toggle` on `claude-haiku-5-5` and `claude-sonnet-5`. | §13.5 (Anthropic `off` → `{}`; no `disabled`/`between_tools`), §13.7 |
| R5 | The provider-default → conversation → one-shot → scheduler path was asserted rather than traced, and the scheduler's provider-default fallback was unverified. | Traced end to end. Chat resolves `request > conversation > provider.thinking > "off"`; the frontend transmits `"off"` (truthy); the footer hides it; the scheduler uses `thinkingLevel ?? "off"` with **no** provider fallback; provider creation defaults `"off"`. Enrichment writes only capability metadata, never a selection, so first enrichment cannot turn an existing `"off"` into a disable or an invented level. | `src/routes/chat/model.ts:54`; `src/routes/chat/validate-and-resolve.ts:210`; `web/src/runtime.ts:415-418,440`; `web/src/components/ChatWindow.tsx:690-691`; `schedulerExecution.ts:199-202`; `src/routes/providers.ts:66`; `web/src/features/providers/ProviderDialog.tsx` form default. | §13.6 (default-path trace; scheduler `null`/`off`), §13.7 |
| R6 | §3.3 claimed an observed limit "cannot be stale" and introduced "no false pre-flight rejection risk". | Observed limits have **no TTL** and are not invalidated by credential, account, name, model-list, or default-model edits on the same provider row. Only endpoint/protocol edits produce a new key, and only process restart or the 256-entry LRU removes an entry. `observed` is terminal in `decideBudget`, so a stale-low observation can cause a false pre-flight rejection. This is pre-existing and is recorded, not fixed. The precedence (observed > model_catalog) is unchanged. | `src/context/observed-limits.ts` (Map, 256-entry LRU, length-prefixed `keyOf`, no TTL, `observedAt` diagnostics-only); `src/routes/providers.ts:86-137` (stable id; endpoint/protocol editable; credential replaced under the same id); `src/context/budget.ts:196-197` (only `conservative_default`/`unknown` are advisory). | §3.3 (staleness/invalidation table), §13.4 (stale observation row) |

---

## 1. Current TBAi architecture and actual code paths

### 1.1 The one context-limit seam

**[Verified]** The entire Direct context-limit decision is a pure function of the provider's stored `models` array:

```
provider.models (SQLite JSON)
  → selectModelOption(provider.models, modelId)        src/context/limits.ts:113
  → resolveContextLimit({...})                         src/context/limits.ts:319
  → computeBudget({ limit, modelOutputTokens })        src/context/budget.ts:87
  → runCompactionPhase({ usableInputTokens })          src/context/assemble.ts:350
  → decideBudget({ estimate, budget, reduction, limitSource })
  → generationCap                                      src/context/execute-direct-stream.ts:440
  → streamText({ maxOutputTokens })
```

The call site is `src/context/assemble.ts:316-339`:

```ts
const selectedModel = selectModelOption(provider.models, modelId);
const observed = readObservedContextWindow({
  providerId: provider.id, modelId, endpoint: provider.endpoint, protocol: provider.apiProtocol,
});
const limit: ContextLimit = resolveContextLimit({
  providerType: provider.type,
  modelId,
  model: selectedModel,
  observedContextWindow: observed?.limitTokens,
  providerId: provider.id, endpoint: provider.endpoint, protocol: provider.apiProtocol,
});
const budget = computeBudget({ limit, modelOutputTokens: selectedModel?.maxOutputTokens });
```

**[Verified]** This is the *only* `resolveContextLimit` call in production code. There is no second authority in the Direct path. `web/src/config/modelContext.ts:1-31` explicitly disclaims Direct authority and retains a resolver only for the OpenCode (Code) ring.

**Consequence:** improving model metadata does not require touching the budget, compaction, or stream code at all — only the value and provenance entering `resolveContextLimit`.

### 1.2 Discovery: what a provider listing actually yields

**[Verified]** `src/services/modelDiscovery.ts:259-304` fans out per provider type:

| Type | Source | Limits read | Reasoning stance |
|---|---|---|---|
| `openai`, `custom` | `GET /models` | `extractCapabilities` over flat/`top_provider`/`limits` | always `unknown` (`:197`) |
| `anthropic` | `GET /v1/models` | `max_input_tokens`, `max_output_tokens` | always `unknown` (`:222`) |
| `google` | `GET /v1beta/models` | `inputTokenLimit`, `outputTokenLimit` | always `unknown` (`:244`) |
| `ollama` | `GET /api/tags` then `POST /api/show` per model | `model_info`/`parameters` | `supported` iff `capabilities` contains `"thinking"` (`:116-119`) |

**[Verified]** The discovery filter has two halves:

```ts
// src/services/modelDiscovery.ts:58-62 — legitimate: non-chat modalities
function isExcludedModality(lowerId: string): boolean { /* embed|dall-e|whisper|tts|… */ }

// src/services/modelDiscovery.ts:71-77 — legacy family allowlist
function isKnownChatFamily(lowerId: string, type: string): boolean {
  return (/gpt|claude|gemini|llama|qwen|mistral|deepseek|codestral|sonnet|opus|haiku|flash|pro|yi|grok|phi|command|nighttales/.test(lowerId) || type === "ollama");
}
```

**[Verified]** The second half drops real chat models whose ids do not contain a listed token. Measured against the live catalogue, `o1`, `o3`, `o3-mini`, `o4-mini`, `gemma-4-*`, `deep-research-*`, and `lyria-3-*` all fail this regex while being marked chat-capable upstream. The function's own doc comment (`:64-70`) already says it must not become a capability mechanism — it is one today only as a noise filter, but it is a *name heuristic* that discards data.

**[Verified]** Limits are written through `withExtractedLimits` (`:159-183`) using `providerReportedLimit`, so a discovered number can never be confused with a user-entered one. A listing that omits limits yields **no value and no stance** — never a fabricated one.

### 1.3 Reasoning: capability, selection, encoding

**[Verified]** Types (`src/types/index.ts:11-28`):

```ts
export type CapabilitySupport = "supported" | "unsupported" | "unknown";
export interface ReasoningCapability { support: CapabilitySupport; levels?: string[] }
export interface ModelCapabilities { reasoning: ReasoningCapability }
```

**[Verified]** The chat route resolves the *level* with a three-step precedence (`src/routes/chat/model.ts:12-27,46-56,64-95`):

```
request.reasoningLevel > conversation.reasoningLevel > provider.thinking > "off"
```

then encoding happens in two places, not in a codec:

- `low`/`medium`/`high` are passed to `streamText` as the top-level `reasoning` option (`src/routes/chat/execute-direct-stream.ts:405-410`).
- `"off"` (or no selection) **omits the `reasoning` property entirely** (`:407`); no disable is transmitted.
- `src/routes/chat/provider-options.ts:34-51` adds only Google's `{ google: { thinkingConfig: { includeThoughts: true } } }` while reasoning is active. It does not choose an effort or a budget.
- Provider wire-format mapping (effort fields, thinking budgets, adaptive thinking) is performed by AI SDK v7 and the installed provider adapters, not by TBAi.

**[Verified] What `"off"` does today — the behaviour that must not change.** `"off"` omits the native reasoning option (`execute-direct-stream.ts:407`), so it sends no reasoning on every provider; `model.ts:54` supplies `"off"` when neither the request nor the conversation nor the provider has a value; `validate-and-resolve.ts:210` does the same on its path. The composer displays `stored ?? custom?.reasoningLevel ?? providerDefault`, where the provider default is `p.thinking ?? "off"` (`DirectChips.tsx:150-159`), and persists a chosen level as both the one-shot pick and `custom.reasoningLevel` (`:161-177`). The transport sends `"off"` because the string is truthy (`web/src/runtime.ts:415-418,440`); the footer suppresses it from the displayed turn record (`ChatWindow.tsx:690-691`). Provider creation stores `"off"` when `thinking` is omitted (`src/routes/providers.ts:66`). Therefore **no selection and `"off"` already mean the same thing: provider default.**

**[Verified — historical]** The earlier chat codec hardcoded budgets/levels and floored with `?? 4096` / `?? "medium"`. That code was replaced by the native option; `provider-options.ts` no longer contains a preset map. The **scheduler** still floors (`schedulerExecution.ts:204-215`), so the silent-clamp defect remains there and is deferred with Scheduler work (§15).

**[Verified]** The frontend offers a fixed four-item list (`web/src/components/composer/DirectChips.tsx:27-32`) and computes the displayed value as `stored ?? custom?.reasoningLevel ?? providerDefault` (`:159`). Nothing in the UI consults `ModelOption.capabilities`.

**[Verified]** Stored selections: conversation `custom.reasoningLevel` (thread metadata), provider `thinking`, scheduler `thinking_level` string column.

### 1.4 Tool context vs tool definitions

**[Verified]** These are separate products of assembly:

- `src/tools/index.ts:436-463` `buildToolsContext(...)` returns a **context object** (read_file/write_file/…/todo/scheduler permissions and workspace facts). It is passed to the model as instructions/context and to the UI.
- `src/context/assemble.ts:161-205` `buildToolLayer({ toolSignal, terminalTap, extraTools })` returns `{ tools, nativeToolNames, mcpToolNames, mcpServerIds }`. `layerB.tools` is the **AI SDK tool definition set**.
- `src/routes/chat/assemble-run.ts:325-326` assigns `state.tools = assembled.context.layerB.tools` and `buildToolsContext(...)` separately.
- `src/routes/chat/execute-direct-stream.ts:173` **throws** if `!tools`, and `:427` passes `tools: state.tools` to `streamText`.

### 1.5 Scheduler: a divergent second implementation

**[Verified]** `src/services/scheduler/schedulerExecution.ts:191-218` re-implements the mapping inline:

```ts
const thinking = job.thinkingLevel ?? "off";
const isLite = /lite|nano/i.test(job.modelId || "");
if (!isLite && thinking !== "off") {
  if (provider.type === "google")    { /* thinkingBudget only, no includeThoughts */ }
  else if (provider.type === "anthropic") { /* enabled, budgetTokens */ }
  else if (provider.type === "openai" || provider.type === "custom") {
    providerOptions.openai = { reasoningEffort: effort };   // ← namespace bug for compat gateways
  }
}
```

Divergences from chat:

| Divergence | Chat | Scheduler | Consequence |
|---|---|---|---|
| Google `includeThoughts` | always `true` | never set | Scheduler's Google runs produce no visible thought text even when reasoning is on. |
| Google generation | `thinkingLevel` for Gemini ≥3 | `thinkingBudget` only | Gemini 3 scheduler runs receive the wrong option and silently run at default depth. |
| OpenAI-compatible namespace | `providerOptionsNamespace(provider)` → `openaiCompatible` for gateways | literal `openai` | A compatible gateway receives options under an unknown key and ignores them. |
| Context budget | full assembly | none | `streamText` receives no `maxOutputTokens`; a 10-step tool loop can grow unbounded until the provider rejects it. |
| Model limit | `resolveContextLimit` | none | The scheduler cannot use a catalogue or provider limit even if one exists. |

**[Verified] Scheduler default semantics — preserved unchanged.** `schedulerExecution.ts:199` reads `job.thinkingLevel ?? "off"` and `:202` guards the entire mapping with `thinking !== "off"`. A `null` or `"off"` job therefore sends no reasoning option. Unlike chat, the scheduler does **not** fall back to `provider.thinking`; the job's own value is the only input. Revision 2.2 preserves this exactly: `off`/`null` remains provider default, and no disable or `on` shape is added to the scheduler.

**[Verified]** `src/services/scheduler/schedulerValidation.ts` validates schedule shape, provider existence, existing-thread resolution, and OpenCode fields — **not** the thinking level against the selected model. `schedulerTypes.ts:11,47` types it as the same four strings; `schedulerStore.ts` persists it as `thinking_level TEXT`.

---

## 2. Models.dev API findings

### 2.1 Transport

**[Verified]**

```
GET https://models.dev/api.json
HTTP/2 200
cache-control: public, max-age=0, must-revalidate
etag: "28ec03a91d7073a01aba3a5f4b05002b"
content-length: 5,962,655
body (parsed): 235 providers, 8,935 models
```

**[Verified]** The payload is a single JSON object keyed by provider id. There is **no** top-level `version`, `generatedAt`, `updatedAt`, or schema version. The only versioning available at runtime is the HTTP `ETag`.

**[Verified]** `https://models.dev/models.json` and `https://models.dev/catalog.json` exist as alternate shapes, but `api.json` is the one Cline consumes and the one this audit measured. A single fetch per refresh is sufficient; do not fetch three.

### 2.2 Provider entry — exactly six or seven keys

**[Verified]** Across all 235 providers, the key set is one of:

```json
{ "id", "name", "doc", "env", "npm", "models" }
{ "id", "name", "doc", "env", "npm", "api", "models" }
```

Real entry:

```json
{
  "id": "openai",
  "env": ["OPENAI_API_KEY"],
  "npm": "@ai-sdk/openai",
  "name": "OpenAI",
  "doc": "https://platform.openai.com/docs/models",
  "models": { "...": "..." }
}
```

**[Verified]** `api` is present on 210 providers and is always a **base URL string** (e.g. `"https://api.deepseek.com"`). It is *not* a protocol descriptor.

**[Verified]** `npm` distribution (top): `@ai-sdk/openai-compatible` 196, `@ai-sdk/anthropic` 8, `@ai-sdk/openai` 6, `@ai-sdk/azure` 2, then eleven one-off packages.

**This is the whole provider-level capability surface.** Anything not derivable from `id`, `npm`, or `api` must come from the per-model record or from code.

### 2.3 Model record — the fields that matter

**[Verified]** Relevant fields and their observed presence across 8,935 models:

| Field | Presence | Notes |
|---|---|---|
| `name` | all | display name, may differ from key |
| `limit.context` | 8,935 / 8,935 | total window; never absent |
| `limit.input` | 1,718 / 8,935 (19.2%) | maximum prompt tokens; usually absent |
| `limit.output` | 8,935 / 8,935 | maximum model output |
| `reasoning` | 8,935 / 8,935 (boolean) | `true` 6,848; `false` 2,087; never absent |
| `reasoning_options` | present on **all** `reasoning: true` models | array; may be empty |
| `reasoning_options[].type` | `toggle` 1,427 · `effort` 4,589 · `budget_tokens` 609 | no other type observed |
| `reasoning_options[].default` | **0** | no default is published |
| `reasoning_options: []` | 1,135 models | reasoning supported, nothing dialable |
| `tool_call` | all | `true` 7,890; `false` 1,045 |
| `structured_output` | all | `true` 5,520 |
| `modalities.input` includes `image` | 5,658 | text/image/video/audio/pdf |
| `canonical_model_id` | 7,617 | cross-provider identity, **not** capability identity |

### 2.4 Real response examples

**OpenAI — effort, plus an `input` limit smaller than `context`:**

```json
"openai/gpt-5.2": {
  "name": "GPT-5.2",
  "limit": { "context": 400000, "input": 272000, "output": 128000 },
  "reasoning": true,
  "reasoning_options": [{ "type": "effort", "values": ["none","low","medium","high","xhigh"] }],
  "tool_call": true,
  "structured_output": true,
  "modalities": { "input": ["text","image"], "output": ["text"] }
}
```

**OpenAI — the older three-value effort set (proves sets are model-specific):**

```json
"openai/o3-mini": {
  "limit": { "context": 200000, "output": 100000 },
  "reasoning": true,
  "reasoning_options": [{ "type": "effort", "values": ["low","medium","high"] }],
  "tool_call": true
}
```

**Anthropic — effort, no budget option on the current model:**

```json
"anthropic/claude-opus-4-7": {
  "limit": { "context": 1000000, "output": 128000 },
  "reasoning": true,
  "reasoning_options": [{ "type": "effort", "values": ["low","medium","high","xhigh","max"] }],
  "tool_call": true,
  "modalities": { "input": ["text","image","pdf"], "output": ["text"] }
}
```

**Anthropic — the budget form, with only a minimum:**

```json
"anthropic/claude-sonnet-4-5": {
  "limit": { "context": 200000, "output": 64000 },
  "reasoning": true,
  "reasoning_options": [{ "type": "budget_tokens", "min": 1024 }]
}
```

**DeepSeek — toggle and effort in the same array:**

```json
"deepseek/deepseek-v4-pro": {
  "limit": { "context": 1048576, "output": 393216 },
  "reasoning": true,
  "reasoning_options": [
    { "type": "toggle" },
    { "type": "effort", "values": ["low","high","max"] }
  ],
  "tool_call": true
}
```

**Google — a different effort vocabulary again:**

```json
"google/gemini-3.5-flash": {
  "limit": { "context": 1048576, "output": 65536 },
  "reasoning": true,
  "reasoning_options": [{ "type": "effort", "values": ["minimal","low","medium","high"] }],
  "tool_call": true,
  "structured_output": true,
  "modalities": { "input": ["text","image","video","audio","pdf"], "output": ["text"] }
}
```

**Google — a model with `reasoning: true` but nothing dialable:**

```json
"google/gemma-4-31b-it": {
  "limit": { "context": 262144, "output": 32768 },
  "reasoning": true,
  "reasoning_options": [],
  "tool_call": true
}
```

**Same id, different hosts — why provider scoping is mandatory:**

```json
"digitalocean/kimi-k3": { "limit": { "context": 1048576, "output": 131072 },
  "reasoning_options": [{ "type": "effort", "values": ["low","high","max"] }] }

"requesty/kimi-k3":  { "limit": { "context": 1048576, "output": 262144 },
  "reasoning_options": [{ "type": "effort", "values": ["none","low","medium","high","max"] }] }

"wally/kimi-k3":     { "limit": { "context": 1048576, "output": 65536 },
  "reasoning_options": [{ "type": "effort", "values": ["none","low","high","max"] }] }

"alibaba-cn/kimi-k3":{ "output": 1048576,
  "reasoning_options": [{ "type":"toggle" }, { "type":"effort", "values":["low","high","max"] }] }

"vivgrid/kimi-k3":   { "limit": { "context": 1000000, "output": 131072 },
  "reasoning_options": [] }
```

**Same id, different hosts — different control *kind*:**

```json
"google/gemma-4-31b-it":   { "reasoning_options": [{ "type": "toggle" }] }
"requesty/gemma-4-31b-it": { "reasoning_options": [{ "type": "effort", "values": ["none","low","medium","high","max"] }] }
"cortecs/gemma-4-31b-it":  { "reasoning_options": [] }
```

### 2.5 Measured aggregate facts

**[Verified]**

| Metric | Value |
|---|---|
| Providers | 235 |
| Models | 8,935 |
| `reasoning: true` | 6,848 |
| `reasoning: false` | 2,087 |
| `reasoning_options: []` among supported | 1,135 |
| Distinct effort values | `default, high, low, max, medium, minimal, none, xhigh` |
| `tool_call: false` | 1,045 |
| `structured_output: true` | 5,520 |
| Models accepting image input | 5,658 |
| `limit.input > limit.context` | **17** |
| `limit.output > limit.context` | **84** |
| `limit.input + limit.output > limit.context` | **808** |
| `budget_tokens.min` values | `0` ×37, `1` ×41, `128` ×58, `256` ×2, `512` ×9, `1024` ×216, `-1` ×2, absent ×244 |
| `budget_tokens.max` values | `24000/24576/31999/32000/32768/38912/50000/63999/64000/81920/127999/128000/131072/262144/393216`, absent ×367 |
| Models advertising effort value `none` | **1,831** |
| Models with both `toggle` and `effort` | 348 |
| … of those, whose effort set includes `none` | 24 |
| `toggle` with `values` | 0 |

### 2.5.1 Catalogue control versus documented disable

A catalogue control proves that the *model* offers a shape. It does not prove that the *endpoint* accepts a disable request, and a `toggle` is not a synonym for disable. The two providers where this distinction is load-bearing:

**Google — official documentation versus measured rows**

| Model | Documented `thinkingBudget: 0` | Measured models.dev row (2026-11-03) | TBAi initial release |
|---|---|---|---|
| `gemini-2.5-flash` | disables thinking | `toggle` + `budget_tokens` with `min: 0` | **No Off.** Provider default + budget presets. |
| `gemini-2.5-flash-lite` | disables thinking | `toggle` + `budget_tokens` with `min: 512` | **No Off.** Provider default + budget presets. |
| `gemini-2.5-pro` | **cannot disable** | `budget_tokens` with `min: 128` | **No Off.** Provider default + budget presets. |
| Gemini 3.x | **cannot disable** | `effort` only (`minimal/low/medium/high`) | **No Off.** Provider default + exact effort values. |

The Flash-Lite row is decisive: the documented disable is real, yet the catalogue publishes `min: 512`. A rule of "`min <= 0` means Off is available" therefore both misses a documented capability and would offer Off on any row where `min <= 0` happens not to mean disable. Revision 2.2 does not infer disable from `min`.

**Anthropic — official documentation versus measured rows**

| Model | Documented `thinking: { type: "disabled" }` | Measured models.dev row (2026-11-03) | TBAi initial release |
|---|---|---|---|
| `claude-haiku-5-5` | **rejected**; adaptive only (a disable is accepted only at effort ≤ `high`) | `toggle` | **No Off.** |
| `claude-sonnet-5` | **rejected**; adaptive only | `toggle` | **No Off.** |
| `claude-sonnet-5-5` | **replaced by `between_tools`**, which disables only upfront thinking | no `toggle` in the measured snapshot | **No Off**; `between_tools` is never labelled Off. |
| `claude-opus-5-5`, `claude-opus-4-7` | **rejected**; adaptive only | `effort` | **No Off.** |
| `claude-haiku-4-5` | **rejected** | budget-shaped row | **No Off.** |
| `claude-sonnet-4-6` | accepted (adaptive + extended thinking) | not used as evidence | **No Off** in the initial release; candidate for a deferred, verified per-model allowlist. |

The two `toggle` rows are decisive: a catalogue toggle does not prove that the model accepts a disable, and for Sonnet 5 the official answer is no. `between_tools` is not a substitute — it removes only the upfront thinking block and still returns between-tool notes — so it cannot be shown as "Off".

### 2.5.2 Contributor guidance and the limits of the catalogue

**[Verified]** The upstream `sst/models.dev` contributor guidance (`AGENTS.md`) states that reasoning controls are declared **per host, not per lab**: the same model id under different provider keys may publish different control kinds and value sets. §2.4's `kimi-k3` and `gemma-4-31b-it` rows demonstrate it in the live payload.

This has three consequences for TBAi:

1. **Provider-scoped keys only.** A row for one host must never enrich another host's provider. This is already the identity rule (§6.3), not a new one.
2. **A control is a model fact, not an endpoint instruction.** The catalogue says a model offers an effort/budget/toggle shape; it does not say which wire field the configured endpoint accepts. That remains TBAi code (§5.1).
3. **`none` is a value, not a universal disable verb.** It means "do not reason" in the provider's own effort vocabulary, and TBAi offers it only where the installed adapter has an effort field that accepts it. It never becomes a toggle-derived or Google-derived disable.

**[Verified]** The v2 upstream schema defines a `reasoning.default` member, but the v1 `api.json` payload TBAi consumes publishes **zero** `reasoning_options[].default` fields (§2.3). TBAi must therefore not behave as if a default were published; an advertised `default`, if one ever appears, maps to Provider default and is never transmitted (§12.1).

### 2.6 Data-quality anomalies that force validation

These are not hypothetical. **[Verified]** examples:

- `qiniu-ai/stepfun/step-3.5-flash`: `input 256,000 > context 64,000`.
- `poe/openai/gpt-5.5`: `input 922,000 > context 400,000`.
- `azure/claude-opus-4-5`: `budget_tokens.min = 1024`, no max.
- Two models publish `budget_tokens.min = -1`. `-1` is a valid value in the upstream schema, but the observed rows do not establish what it means, so TBAi does not assume a meaning. It preserves the value in metadata, never treats it as `0`, never transmits it as a token budget, and never uses it as a positive lower bound when deriving budget presets (§11.3, §12.3).
- 84 models publish `output > context`; `alibaba-cn/kimi-k3` publishes `output = context = 1,048,576`.
- 808 models publish `input + output > context`. **They cannot be added.**

**[Recommendation]** Treat every number as untrusted input at the boundary. Reject non-positive, non-integer, and internally inconsistent **context/output limit** figures; prefer the conservative figure when two disagree; never sum.

This strictness is for `limit.context` / `limit.input` / `limit.output` only. It must **not** be applied to `reasoning_options.budget_tokens`, whose upstream schema deliberately admits `min = -1` and `min = 0` (§11.3). Reusing the limit rule there is the defect corrected as C3.

### 2.7 What Models.dev does **not** publish

**[Verified]**

1. **No protocol semantics.** No field says "this provider accepts OpenAI Responses vs Chat Completions". `npm` identifies the SDK package, not the wire dialect; `@ai-sdk/openai` itself defaults to Responses, while 196 `@ai-sdk/openai-compatible` providers use Chat Completions. TBAi's `apiProtocol` cannot be derived safely from it.
2. **No reasoning defaults in the v1 `api.json` payload.** Zero `reasoning_options[].default` fields were measured. The v2 upstream schema defines a `default` member, but TBAi consumes v1 and must not behave as if it were present. TBAi must not invent one; an advertised `default` maps to Provider default and is never transmitted (§2.5.2).
3. **No per-model freshness.** No `updated_at` per model; only the HTTP `ETag` for the whole document.
4. **No capability-per-endpoint semantics beyond the provider key.** The record is *per provider entry*, which is the correct scoping — but there is no guarantee the provider key identifies the exact endpoint a user configured.

---

## 3. Context-window discovery and token-budgeting design

### 3.1 Four different quantities, never interchangeable

| Quantity | Source field | TBAi field | Meaning |
|---|---|---|---|
| Total context window | `limit.context` | *(none today)* | Everything the model can hold in one call, input + output together. |
| Maximum input | `limit.input` | `ModelOption.contextWindow` | The most prompt tokens the endpoint accepts. |
| Maximum output | `limit.output` | `ModelOption.maxOutputTokens` | The model's own generation ceiling. |
| Remaining budget | computed | `ContextBudget.usableInputTokens` / `generationCap` | What is actually left after history, tools, reservation, and margin. |

### 3.2 Correct mapping

**[Recommendation]** When both figures exist:

```
maxInputTokens = min(limit.context, limit.input)
```

When only one exists:

```
maxInputTokens = limit.input ?? limit.context
```

This is exactly the rule Cline implements (§7.2). It is conservative by construction: a provider that publishes `input > context` is treated as having only `context` usable — which prevents TBAi from planning a request the endpoint will reject. The 17 anomalous models then degrade to their `context` figure rather than to a fabricated larger one.

**Do not** compute `input + output` against `context`, and **do not** subtract `output` from `context` to obtain input. Cline's own README states the invariant explicitly: it is not required that `maxInputTokens + maxTokens <= contextWindow`.

**No default inside normalization.** Cline substitutes `128_000` / `4096` when fields are missing. TBAi must not: a fallback belongs in `resolveContextLimit` / `resolveGenerationCap`, where it is labelled `conservative_default`. Enrichment writes only figures the catalogue actually published.

**Output mapping:** `ModelOption.maxOutputTokens = limit.output`, passed to `computeBudget` unchanged. Existing `resolveOutputReservation` clamps the *reservation* to `MAX_OUTPUT_RESERVATION = 32,000` (`limits.ts:87,488-493`), while `resolveGenerationCap` uses the documented figure and clamps it to remaining window (`:517-551`). That separation already exists and must be preserved — the catalogue does not change either policy.

### 3.3 Provenance: a third stored source, and its authority

**[Recommendation]** Extend the stored vocabulary:

```ts
export const CONTEXT_WINDOW_SOURCES = ["provider_reported", "configured", "model_catalog"] as const;
```

and the resolved vocabulary:

```ts
export type LimitSource =
  | "provider_reported" | "configured" | "model_catalog"
  | "observed" | "conservative_default" | "unknown";
```

**Precedence (highest first):**

| Rank | Source | Why |
|---|---|---|
| 1 | `configured` | A human deliberately typed a number for this installation; overriding it silently is worse than honouring it. Unchanged from R1. |
| 2 | `provider_reported` | The endpoint actually serving the request declared the number. A declaration by the serving endpoint outranks a figure parsed from an error string. |
| 3 | `observed` | Learned from a real rejection **of this exact endpoint** under this account. More specific than any catalogue row, but weaker than a declaration. |
| 4 | `model_catalog` | A third party states it about a model id; authoritative *about the model*, not about this endpoint. |
| 5 | `conservative_default` | TBAi's stand-in. Not a claim. |
| 6 | `unknown` | No ceiling. |

**[Verified]** This preserves the existing `configured > provider_reported` decision (`limits.ts:270-318`, `docs/decisions.md` §R1). The only addition is a rung below `provider_reported`.

**What `observed` actually is — evidence, not assumption.** `readObservedContextWindow` reads an in-memory map (`src/context/observed-limits.ts`, 256 entries) whose key is the length-prefixed tuple `providerId | modelId | endpoint | protocol`. It is written only when a provider error was already classified `context_overflow`, by parsing a *context-labelled* integer out of that error (`src/lib/context-window-observation.ts:150-184`), and it is recorded at `execute-direct-stream.ts:689` from the raw error before recovery. Therefore:

- It describes **the actual endpoint under the actual account**, which is a stronger identity than a catalogue row keyed only by `(provider key, model id)`.
- It was true **at the moment that request was rejected**, which is why it is evidence. It is **not** guaranteed to be true now: the map has no TTL and does not re-validate a stored figure. The statement is a point-in-time observation, not a standing declaration.
- It may be the **total** context window rather than the maximum input. Using a total-window figure as the prompt ceiling is conservative (it under-plans by the output reservation), never over-permissive. That is the same direction of error the catalogue's `min(context, input)` rule chooses (§3.2).
- It is still a regex-extracted number, not a typed API field. That is why it ranks below `provider_reported`, whose value came from the provider listing, and above `model_catalog`, which is third-party and endpoint-agnostic.
- It is **in-memory and process-scoped**; it does not survive a restart. "Previously observed" therefore means "observed earlier in this process for this exact endpoint", not durable history.

**What invalidates an observation — exact behaviour**

`readObservedContextWindow` is a `Map` lookup with no expiry (`src/context/observed-limits.ts`). The only things that remove or supersede an entry are the key itself changing, process restart, the 256-entry LRU, or the test/operator `clearObservedContextWindows()` reset.

| Change | Key changes? | Effect |
|---|---|---|
| Endpoint edited on the provider row | **yes** (`endpoint` is part of `keyOf`) | Old entry becomes unreachable; the next overflow learns a new figure. |
| `apiProtocol` edited | **yes** | Same. |
| Provider deleted | row gone | The map entry remains until LRU eviction or restart; it is unreachable. |
| Provider `name` edited | no | Observation retained. |
| `models` list or default model edited | no | Observation retained — including when the model id stays the same but its real window changes. |
| API key / account replaced | **no** — `provider_configs.id` is unchanged | Observation retained, even though a different account can have a different window. |
| Model's real window changes upstream | no | Observation retained. |
| Process restart | — | Cleared (in-memory map). |
| A 257th distinct key | — | Least-recently-written entry evicted. |
| Elapsed time | no | **No TTL.** `observedAt` is diagnostics only and is never read as authority. |

**Consequence for budget authority.** `decideBudget` treats only `conservative_default` and `unknown` as advisory (`src/context/budget.ts:196-197`); `observed` is terminal. A stale-low observation can therefore reject a request the provider would accept — and because the request never reaches transport, no new observation can correct it until the process restarts, the LRU evicts it, or the endpoint/protocol changes. **This is pre-existing behaviour and is not changed by this plan.** It is recorded so this document does not claim otherwise; changing it would mean changing budget policy, which is out of scope. The asymmetry is deliberate: a catalogue figure is third-party and is made advisory (§3.4), while an observation is a real rejection of this exact endpoint.

The opposite order was Revision 2's assumption. Nothing in the code or the upstream data supports preferring a global third-party row to a figure learned from this endpoint's own overflow; the previous comment in `limits.ts:243-248` justified excluding observed from *arbitration between two declarations*, which remains true — it does not justify ranking it below a catalogue.

**Implementation shape:** `collectCandidates` already collects `model.contextWindow` (with its source, defaulting legacy rows to `configured`) and `configuredContextWindow`. It already records `observedContextWindow` but returns early at `limits.ts:249`. Remove that early return and widen the candidate source:

```ts
interface LimitCandidate {
  readonly value: number;
  readonly source: ContextWindowSource | "observed";
  readonly recordIndex: number;
}

const RANK: Record<ContextWindowSource | "observed", number> = {
  configured: 0,
  provider_reported: 1,
  observed: 2,
  model_catalog: 3,
};
```

- 0 valid candidates → `conservative_default` (the existing empty path, now reached only when even observed is absent or invalid).
- 1 → that candidate.
- ≥2, all equal → the highest-ranked candidate's source is reported (`agreed` for all).
- ≥2, conflicting → the highest-ranked wins; the highest-ranked loser is recorded in `divergentValue`; every other candidate is still visible in `candidates`.

The selection body becomes, in place of the current positional `first`/`second`:

```ts
const ranked = [...candidates].sort((a, b) => RANK[a.source] - RANK[b.source]);
const winner = ranked[0];
if (winner === undefined) return /* conservative_default path */;

const disagreeing = ranked.filter((c) => c.value !== winner.value);
if (disagreeing.length === 0) {
  /* source = winner.source; every candidate outcome "agreed" */
} else {
  const loser = disagreeing[0];
  if (loser !== undefined) {
    /* source = winner.source; divergent: true;
       divergentValue = { value: loser.value, source: loser.source };
       winner outcome "conflicted"; loser "lost_precedence" */
  }
}
```

This is a small, explicit widening of the existing four-rule algorithm, not a rewrite. It keeps `configured` first, keeps agreement meaningful, and keeps divergence observable. `observed` remains non-advisory (terminal), exactly as it is today; a stale observation can therefore cause a false pre-flight rejection. That is pre-existing and is recorded in §3.3, not introduced by this plan. `describeLimitSource` (`limits.ts:591`) gains a `model_catalog` label; `isPhase3ExperimentEligible` is untouched.

### 3.4 Authority in the budget: `model_catalog` is **advisory**

**[Recommendation]** `decideBudget` currently treats `conservative_default` and `unknown` as advisory (`src/context/budget.ts:196-197,219-229,261-270`). Add `model_catalog` to that advisory set.

Argument, because this is the least obvious call in the design:

- A catalogue figure can be wrong in both directions. If it is too low, a **terminal** rejection refuses work the provider would have accepted — and the user cannot proceed, because TBAi never sends the request and therefore never learns the real limit. That is the same trap `conservative_default` was made advisory to avoid (`budget.ts:188-197`).
- If it is too high, the provider rejects the request and the existing overflow path records an `observed` figure. That failure is recoverable; a false pre-flight rejection is not.
- The catalogue still does useful work when advisory: it sets the *planning* ceiling, so compaction fires earlier and the generation cap is sane. It simply does not hold veto power over transport.

**Consequence:** `model_catalog` is **not** `isPhase3ExperimentEligible` (that stays `provider_reported` only), and `describeLimitSource` must render it distinctly.

### 3.5 Where enrichment happens

**[Recommendation]** Enrich at **discovery**, not at request time, and only inside `discoverModels`.

```
POST /api/providers/discover
  → discoverModels()                  (provider listing, unchanged)
  → enrichModels(models, { type, endpoint })
       - only when the provider identity maps to an exact models.dev key
       - never overwrites an existing provider_reported/configured value
       - writes model_catalog via catalogLimit()
  → response.models
  → client persists user-selected subset
  → provider.models JSON in SQLite
```

Why not request-time:

1. `assemble.ts` is currently pure with respect to stored config. A live lookup would make the same conversation's budget change on a catalogue refresh, with no user action.
2. Models.dev availability would become a chat dependency, violating the brief's hard requirement.
3. It would put a 5.9 MB parse and a network object on the request path.

**Freshness:** `ModelOption.discoveredAt` already records when the pass ran. Do **not** add `catalogFetchedAt` or `catalogModelId`. Cline does not track per-model catalogue freshness either; the whole snapshot has one TTL. A re-discovery replaces `model_catalog` values and leaves `provider_reported` / `configured` untouched.

### 3.6 Missing, stale, and conflicting metadata

| Situation | Behaviour |
|---|---|
| No catalogue match for exact `(providerKey, modelId)` | No enrichment. `ModelOption` keeps only provider-reported values or nothing. Resolver falls back as today. **[Verified]** safe. |
| Catalogue has an entry but no `limit.context` | Cannot occur in the current payload (8,935/8,935), but handle as absent anyway. |
| Catalogue disagrees with provider listing | `provider_reported` wins; divergence recorded in `ContextLimit.divergent` / `divergentValue`. Existing mechanism. |
| Catalogue disagrees with an observed figure | `observed` wins (§3.3); divergence recorded. This is a behaviour change from Revision 2, which consulted observed only when nothing else existed. |
| Provider listing disagrees with an observed figure | `provider_reported` wins; divergence recorded. The declaration outranks the parsed error figure, unchanged in outcome but now visible as divergence. |
| A previously observed figure becomes stale | **No TTL.** It is retained until process restart, 256-entry LRU eviction, or an endpoint/protocol edit changes the key. Because `observed` is terminal in `decideBudget`, a stale-low figure can refuse a request. Pre-existing; not changed by this plan (§3.3). |
| Provider credentials or account change on the same row | The key is unchanged (`providerId` is stable), so the old observation still applies. Endpoint/protocol edits retire it. Pre-existing; not changed by this plan. |
| Catalogue disagrees with operator override | `configured` wins; existing `configured` > everything rule. |
| Catalogue value is invalid | Reject at normalization; do not store. Same strictness as `checkLimitCandidate` (`limits.ts:163+`). |
| Catalogue becomes unreachable | Refresh is skipped; last-known-good in memory continues to serve discovery. Chat is unaffected. |
| Catalogue corrects a previously stored value | Re-discovery replaces the `model_catalog` value. An existing `provider_reported` or `configured` value is **never** replaced by a catalogue value. |

### 3.7 What must not change

- `UNKNOWN_LIMIT_CEILING = 128_000` stays (`limits.ts:58`). It remains an assumption, now needed less often.
- `SAFETY_MARGIN_FRACTION = 0.25`, output reservation, generation cap, and the 0.8 compaction trigger are policy numbers and stay (`budget.ts:41`, `compaction/index.ts:81`).
- `LEGACY_SOURCE = "configured"` stays (`limits.ts:102`); a bare number with no stance is still treated as operator-entered.
- `isPhase3ExperimentEligible` stays `provider_reported`-only.

---

## 4. Dynamic reasoning capability and control discovery

> **HISTORICAL — superseded.** This section specifies the custom reasoning-metadata and dynamic-selection proposal. It is retained as the audit record and is **not** an implementation plan. The live implementation is described in §15, "Current implementation — native AI SDK v7"; dynamic selections are deferred.

### 4.1 What the data supports

**[Verified]** Five distinct states exist and must not be collapsed. The fifth was missing from Revision 2 and is the reason a published control could be shown but never sent.

| State | Signal | UI meaning |
|---|---|---|
| Explicitly unsupported | matched entry with `reasoning: false` | Only `off`, encoded as no reasoning option. |
| Supported, undialable | `reasoning: true` with `reasoning_options` absent or `[]` | One **"Provider default"** choice that sends nothing. **Do not claim reasoning is enabled by default** — the catalogue says it is supported, not that it is on. |
| Supported, dialable | `toggle`, `effort{values}`, `budget_tokens{min,max}` — at least one of which the installed adapter can encode | Offer exactly the usable published controls, plus the selections they imply (§12.1). |
| Supported, not encodable by this adapter | A control exists but the adapter has no field for it: a `toggle` on OpenAI native, Google, or an OpenAI-compatible gateway; a `budget_tokens` on OpenAI native or compatible | Treat as **undialable**: one "Provider default" choice. Never render a choice that would produce `unsupported_capability`. |
| Unknown | no exact catalogue match **and** provider listing reported nothing | Preserve TBAi's existing presets as a policy fallback; never claim it is model capability. |

Four terms must not be conflated:

- **`none`** is an **advertised effort value**, not a control type. It is the one visible selection for explicit no-reasoning, and it is usable only where the installed adapter has an effort field that accepts it (OpenAI native and compatible gateways). Google's and Anthropic's adapter effort sets do not contain `none`, so it is not offered there.
- **`default`** is a catalogue **marker**, not a selection. It resolves to Provider default, adds no second chip, and is never transmitted (§12.1).
- **`off`** is not a capability value at all. It is TBAi's existing stored name for **Provider default** — send nothing (§1.3).
- **`toggle`** is a control shape, not a claim that the model can be disabled. It does not become Off, and it does not become a budget.

`"on"` is removed from the vocabulary: adaptive-without-effort was never verified, and every other provider lacks an enable field.

### 4.2 Types — one additive block

**[Recommendation]** Extend `src/types/index.ts`; do not create a reasoning module:

```ts
export type ReasoningControl =
  | { readonly type: "toggle" }
  | { readonly type: "effort"; readonly values: readonly string[] }
  | { readonly type: "budget_tokens"; readonly min?: number; readonly max?: number };

export interface ReasoningCapability {
  support: CapabilitySupport;
  /** Existing field, retained unchanged and unused by the new producer. */
  levels?: string[];
  /** Published control shapes, in source order. */
  controls?: ReasoningControl[];
  /** Who asserted this capability. */
  source?: "provider_reported" | "model_catalog";
}
```

`type` is used rather than `kind` deliberately: it is Models.dev's own field name, so enrichment is a validation pass rather than a rename. Cline's schema uses `type` for the same reason.

**Why `source` is a plain field, not a new framework:** `support: "unknown"` and `support: "unsupported"` are only honest if a reader can tell *who* said so. A catalogue saying `false` is not the same claim as a provider saying `false`. This is one optional string, not a provenance subsystem.

### 4.3 The selection model

**[Recommendation]** Keep TBAi's tri-state and separate three vocabularies:

1. **Capability vocabulary** — what the model publishes (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `default`, a toggle, or a budget range).
2. **Policy vocabulary** — TBAi's presets (`off`, `low`, `medium`, `high`) that map to numeric budgets in code. These are application presets, not claims about a model.
3. **Stored selection** — the opaque string a conversation, provider, or job carries.

The stored selection has exactly these semantics. §12.1 is the normative table; this one exists so the reasoning design can be read in one place.

| Selection | Stored value | Meaning | Offered when | Wire result |
|---|---|---|---|---|
| Provider default | `"off"` (existing) **or** no value (`undefined`) | No opinion; let the provider decide. **Not** a disable. | Always. | Nothing sent. |
| Advertised `default` | none — resolves to `"off"` | The provider's default depth. Same choice as Provider default; not a second chip. | Whenever an effort value `default` is advertised. | Nothing sent. The literal `"default"` is never stored as a user selection and never transmitted. |
| Advertised `none` | `"none"` | **The one visible explicit no-reasoning selection**, in the provider's own effort vocabulary. | The capability advertises `none` **and** the adapter has an effort field that accepts it (OpenAI native, compatible). | `reasoningEffort: "none"`. |
| Published level | the exact string | That exact depth. | The value is published **and** accepted by the installed adapter. | Adapter-specific field (§12.3). |
| Budget preset | `"low" \| "medium" \| "high"` | Application preset within the published range. | Budget-only capability with a usable maximum. | Clamped positive integer budget; the label shows the number. |
| Unsupported | `"off"` only | The model cannot reason. | Always for `support: "unsupported"`. | Nothing sent. |
| Explicit disable | **no stored value** | Ask the provider to stop reasoning. | **Not offered in the initial release.** Deferred (§12.4). | — |
| Explicit enable (`"on"`) | **removed** | Ask for reasoning without a depth. | **Not offered.** Unverified. | — |

Rules:

- **"Send nothing" is never described as disable.** It is Provider default, and `"off"` is its stored name. No chip labelled Off means "send nothing" on a model that can reason; on such a model the chip is labelled **Provider default**.
- **No explicit disable in the initial release.** A catalogue `toggle`, an advertised `none`, or a Google `budget_tokens.min <= 0` is **not** evidence that the endpoint accepts a disable. `none` is an advertised effort value, not a disable instruction. Explicit disabling is a deferred, separately verified feature that must use a dedicated stored value and a verified per-model allowlist (§12.4).
- **`off` is always accepted and always sends nothing.** It is not offered as a separate chip beside `none`; the two are not duplicates because they produce different requests: `off` → `{}`, `none` → `reasoningEffort: "none"`.
- **Legacy selections remain valid where they were valid.** `"off"` always sends nothing. `low`/`medium`/`high` keep their preset meaning when capability is unknown or budget-only; on an effort-capable model they are valid only if advertised. A value outside the offered set is refused visibly with `allowed`, never remapped.
- **`default` is a marker, not a stored value.** It resolves to the Provider-default choice and is never transmitted literally.
- **Effort controls dominate budget controls.** If a capability publishes an effort control, budget presets are not offered; the exact values are. This removes the ambiguity where `"medium"` could mean an effort value or a budget preset, and matches Cline's Anthropic policy (§7.3, `routing_anthropic-compatible.ts`: an effort control selects adaptive mode even when a budget control is also advertised).
- **Budget presets are numeric and visible.** The catalogue publishes a range, not named levels. TBAi's `low/medium/high` remain application presets (`1024/4096/8192`), resolved within the effective `[max(min ?? 1, 1), max]` and displayed with the resulting token count (e.g. "High — 8,192 tokens"). Presets are deduplicated by resulting number when a narrow range collapses them. **No preset is ever 0.** `min = -1` is a valid upstream sentinel whose semantics must not be assumed from the observed rows: it contributes no lower bound, is never treated as `0`, and is never sent. A missing `max` means uncapped; `max <= 0` means no usable budget preset.
- **Unknown capability** offers the existing presets, labelled as presets in the control's accessible name so no reader mistakes them for model capability.
- **Unsupported** offers only `off`, encoded as nothing.
- **Never clamp a *selection*.** If a stored value is no longer in the offered set, the request boundary refuses it with a typed error and lists `allowed`. It must not pick `medium`.
- **Never invent a default.** `undefined` means "send nothing / provider default", not `"medium"`.

**[Verified — historical]** The superseded codec proposal targeted a preset map in `provider-options.ts` that floored an unknown selection to `medium`/`4096`. That map no longer exists: the native path passes `low`/`medium`/`high` to `streamText` and omits `reasoning` for any other value (`execute-direct-stream.ts:405-410`). The scheduler still floors (`schedulerExecution.ts:204-215`); that defect is deferred with Scheduler work (§15).

### 4.4 Provider-scoped by construction

**[Verified]** The same model id publishes different control kinds and value sets on different hosts (§2.4). Therefore:

- Reasoning metadata is keyed by **(provider key, model id)**, never by model id alone and never by `canonical_model_id`.
- A catalogue row for `openai/gpt-5.2` must not enrich a `custom` provider whose model id happens to be `gpt-5.2`.
- If the provider is a gateway with its own key, only that gateway's row applies — but TBAi does not enrich gateways at all in this plan (§6.2).

### 4.5 Serialization of dynamic selections

**[Recommendation]** Stored values widen from a four-value enum to an opaque, validated string:

- Chat request: `reasoningLevel?: string` (validated against the resolved capability at the route boundary, not against a fixed enum).
- Conversation metadata: `custom.reasoningLevel?: string`.
- Provider default: `thinking?: string` (unchanged column; validated on write).
- Scheduler (deferred — requires separate approval): `thinking_level TEXT` unchanged; the TypeScript type, the request schema, and validation would widen to the validated selection. The Scheduler keeps its existing four-level request schema, types, validation, and inline encoding.

**Backward compatibility:** the four existing strings remain accepted inputs with their existing meanings. `"off"` always means **send no reasoning option** = Provider default, on every model, with no exception and no reinterpretation. `low`/`medium`/`high` keep their preset meaning when capability is unknown or budget-only; on an effort-capable model they are accepted only when that exact value is advertised, otherwise the boundary refuses visibly with `allowed` (never remaps). No stored value is rewritten or silently mapped to another level. `"default"` is **not** added to the stored vocabulary: an advertised `default` resolves to the `"off"` choice. No explicit-disable or explicit-enable value is added.

### 4.6 UI — one small shared derivation

**[Recommendation]** Add one file, `web/src/lib/reasoning-options.ts`, with a pure function:

```ts
export interface ReasoningChoice {
  value: string;                 // stored: "off" (Provider default) | advertised value | preset
  label: string;
  kind: "provider-default" | "unsupported" | "value" | "preset";
}

export interface ReasoningChoiceInput {
  capability?: ReasoningCapability;
  /** Needed because encodability depends on the adapter, not the catalogue. */
  provider: { type: string; apiProtocol?: string };
}

export function reasoningChoices(input: ReasoningChoiceInput): ReasoningChoice[];
```

It has exactly two real callers, which is the threshold AGENTS.md sets for a shared helper:

- `web/src/components/composer/DirectChips.tsx` replaces the fixed `THINKING_OPTIONS` list when `controls` is present.
- `web/src/features/scheduler/components/JobEditor.tsx:812-818` replaces its hardcoded four-item select.

Rendering rules — these are the **same** rules as `allowedReasoningSelections` (§12.2), not a parallel UI opinion:

```
supported, dialable      → "Provider default" (stored "off") always;
                           exact advertised values the adapter accepts
                             (including "none" as the explicit no-reasoning choice);
                           plus low/medium/high (with token counts) when budget-only;
                           no Off or On chip
supported, undialable    → "Provider default" only
supported, not encodable → "Provider default" only (no dead chips)
unsupported              → "Off" only (sends nothing)
unknown/absent           → off/low/medium/high, labelled as presets
```

`"Provider default"` is stored as `"off"` (the existing value) or absent, and always sends nothing. It is offered for every supported capability because sending nothing is always encodable. An advertised `default` effort value resolves to this same choice and does not produce a second chip. `"none"`, when advertised and adapter-accepted, is a **different** choice and sends `reasoningEffort: "none"`; it does not replace or duplicate Provider default. No chip claims to disable reasoning in the initial release.

**Do not** show a disabled "medium" chip when the model publishes `low/high/max`. Showing a value that cannot be sent is the silent-clamp defect in UI form. The cross-tree matrix in §13.7 asserts that the values produced here and the values accepted by the backend are the same set for every provider × control combination.

---

## 5. Provider/API request-encoding design

> **HISTORICAL — superseded.** The shared codec and the `provider-options.ts` move proposed here are cancelled. Do not move the file and do not implement this encoder. AI SDK v7 owns provider wire-format mapping; see §15, "Current implementation — native AI SDK v7". The scheduler's separate inline encoder is deferred Scheduler work.

### 5.1 What Models.dev can and cannot decide

**[Verified]**

| Question | Answer from Models.dev? |
|---|---|
| Does this provider speak OpenAI Responses or Chat Completions? | **No.** |
| Does this provider accept `reasoningEffort` or `thinkingBudget`? | **Partially.** The model record says *which control shape the model offers*, not which wire field the endpoint accepts. |
| Is this an OpenAI-compatible gateway? | **Hint only.** `npm === "@ai-sdk/openai-compatible"` (196 providers) correlates, but does not define TBAi's protocol. |
| Is this the official endpoint? | **Hint only.** `api` is a base URL; TBAi must not infer identity from a URL alone. |

Therefore:

1. **Model capability discovery** — Models.dev. Data.
2. **Provider-specific control availability** — Models.dev, scoped by provider key. Data.
3. **API-protocol identification** — TBAi configuration (`ProviderConfig.apiProtocol`, `type`). Code + user choice, never catalogue.
4. **Reasoning selection and validation** — TBAi policy. Code, capability-aware.
5. **Request serialization** — TBAi codecs. Code.

### 5.2 One shared implementation — move the existing file

**[Recommendation]** Move `src/routes/chat/provider-options.ts` to `src/services/provider-options.ts` and extend it in place. Do not create a `reasoning/` package.

Why move: encoding is domain behaviour, not HTTP handling, and the scheduler cannot import a route module without inverting the `routes → services` direction. Moving is the smallest change that satisfies both callers.

Public surface stays small:

```ts
export type ReasoningProviderOptions = Record<string, JsonObject>;

export interface ReasoningDecisionInput {
  provider: Pick<ProviderConfig, "type" | "apiProtocol">;
  model: string;
  selection: string | undefined;
  capability?: ReasoningCapability;
  /** Model output ceiling, when known, to cap an Anthropic budget like Cline does. */
  outputCap?: number;
}

export type ReasoningDecision =
  | { ok: true; providerOptions: ReasoningProviderOptions }
  | { ok: false; reason: "unsupported_value" | "unsupported_capability";
      allowed: readonly string[] };

export function resolveReasoningSelection(input: ReasoningDecisionInput): ReasoningDecision;
/** The one validity rule. Takes the adapter because encodability depends on it.
 *  `"off"` is Provider default: always allowed, always encodes to `{}`. */
export function allowedReasoningSelections(
  capability: ReasoningCapability | undefined,
  provider: Pick<ProviderConfig, "type" | "apiProtocol">,
): readonly string[];
```

`buildReasoningProviderOptions` is renamed to `resolveReasoningSelection` because it now decides validity as well as encoding. The route and the scheduler both call it. The old route file is deleted; `validate-and-resolve.ts` and `routes/chat/types.ts` update their imports.

### 5.3 Per-protocol behaviour

The existing provider quirks move unchanged; new behaviour is driven only by the published control type.

**Two rules govern the table.** First, **a Models.dev control type is not a wire format**: the catalogue says *which control the model offers*, never which field the endpoint accepts. Second, **effort dominates budget**: when a capability publishes an effort control, the effort field is used and budget presets are not offered, so one request never carries two reasoning shapes.

| Branch | Rule |
|---|---|
| no selection (`undefined`) | `{}`. Never substitute `"medium"`. |
| `"off"` (Provider default, every capability) | `{}`. **Never a disable**: never `reasoningEffort: "none"`, never `thinkingBudget: 0`, never `thinking: { type: "disabled" }`, never `between_tools`. |
| advertised `"default"` | `{}`. Resolves to the Provider-default choice; the literal is never stored as a user selection and never sent. |
| `"none"` | OpenAI native / compatible, only when `none` is advertised and the adapter accepts it → `reasoningEffort: "none"` under the correct namespace. Not offered on Google or Anthropic, whose adapter effort sets do not contain `none`. |
| explicit disable | **Not offered.** No branch encodes `disabled`, `between_tools`, `thinkingBudget: 0`, or a disable-shaped effort. |
| explicit enable (`"on"`) | **Not offered.** No adapter shape is verified enough to enable reasoning without choosing a depth. |
| Google, `effort` control | `thinkingConfig: { thinkingLevel: value, includeThoughts: true }`. The value must be in the adapter's set `minimal/low/medium/high`; anything else is refused with `allowed`, not mapped. |
| Google, `budget` control (no effort control) | `thinkingConfig: { thinkingBudget: preset, includeThoughts: true }`, clamped to `[max(min ?? 1, 1), max]`; lite/nano guard retained. A published `min = -1` contributes no lower bound, is never sent, and is not a disable. No preset is ever 0. |
| Google, `toggle` without a budget control | No Google field expresses a toggle. Undialable: Provider default only. Do not translate the toggle into a budget or a disable. |
| Google, capability unknown | Existing generation fallback unchanged: `thinkingLevel` for Gemini ≥3, `thinkingBudget` otherwise, lite/nano skipped. This remains a code policy, not catalogue data. |
| Anthropic, `effort` control | Top-level `effort` plus `thinking: { type: "adaptive" }`. **[Verified]** against installed `@ai-sdk/anthropic` 4.0.83: `effort` accepts `low/medium/high/xhigh/max`; `thinking` accepts `adaptive`. A published value outside that set is refused, not mapped. |
| Anthropic, `budget` control, no effort control | `thinking: { type: "enabled", budgetTokens }`, preset clamped to `[max(min ?? 1024, 1024), max]` (the documented minimum is 1,024) and, when `outputCap` is known, to `outputCap - 1` (Cline's rule). |
| Anthropic, `toggle` + `budget`, no effort control | Budget presets only. The toggle is **not** offered as Off: it does not prove disable support, and `between_tools` is not a full disable (§2.5.1). |
| Anthropic, `toggle` + `effort` | Exact effort values only; Provider default is the `"off"` choice. No `on` chip and no toggle-derived disable. |
| Anthropic, `toggle` only | Undialable: Provider default only. A toggle alone has no verified TBAi wire shape. |
| OpenAI native, `effort` | `reasoningEffort` under `openai`. Values outside the SDK's accepted set (`none/minimal/low/medium/high/xhigh/max`) are refused. |
| OpenAI native, `toggle` or `budget` | Not representable on the native SDK. Undialable: Provider default only; any other selection is refused with `unsupported_capability`. Do not invent an effort. |
| Compatible gateway, `effort` | `reasoningEffort` under `providerOptionsNamespace(provider)` — fixes the scheduler's literal `openai` bug. **[Verified]** the compatible schema accepts `reasoningEffort: string`; a gateway may still reject a value on the wire, which is a provider error, not a reason to translate it. |
| Compatible gateway, `toggle` or `budget` | **Not representable.** `@ai-sdk/openai-compatible` declares exactly `user`, `reasoningEffort`, `textVerbosity`, and `strictJsonSchema`, and its object schemas use `z.core.$strip`; a `thinking` object is discarded before the request is built. Do not send it, and do not offer a control that depends on it. Undialable: Provider default only. |
| Unknown + preset | Existing preset maps, unchanged: Gemini generation split and lite/nano exclusion included. |
| Any selection without an encodable control | `"off"` (and advertised `default`) → `{}`; every other selection is refused with `allowed`. |

`providerOptionsNamespace` (`src/services/ai.ts:85-87`) remains the single namespace rule; the codec imports it. No second namespace table.

**Why the compatible-gateway change is a correction, not a preference.** Revision 2 assumed that a generic `thinking` object is forwarded to compatible gateways. The installed SDK's own option schema disproves it: unknown keys are stripped, so the object never reaches the wire. Some individual gateways do accept Anthropic-style `thinking`, but only through provider-specific rules in Cline (`routing_anthropic-compatible.ts`, `routing_generic-compatible.ts`), and only when TBAi has a configured provider identity that proves it. TBAi does not enrich gateways at all (§6.2), so there is no identity under which a generic `thinking` could be justified. Sending it would be an unverified field that silently does nothing.

### 5.4 What remains code, permanently

- The Gemini generation fallback when capability is unknown — Models.dev does not publish which option a generation accepts.
- The lite/nano exclusion for Gemini 2.5 budgets — a provider quirk, not model metadata.
- `includeThoughts` — a display policy, not a capability.
- The Anthropic SDK's accepted effort set and `adaptive` shape. No disable or `on` selection is offered, so the SDK's rewrite behaviour is documented but never exercised.
- The fact that `off` means "send nothing" and is never reinterpreted as a disable on any provider.
- Namespace selection for compatible gateways.
- TBAi preset budget numbers when no catalogue control exists, and their clamp to published bounds.
- **The adapter-encodability table**: which control types each installed adapter can actually transmit. This is the one place the code must know that `thinking` does not exist on the compatible schema, that Google has no toggle field, and that effort and budget are alternatives.

That set is small, data-free, and lives in the one moved file.

---

## 6. Local and custom-provider handling

### 6.1 Ollama

**[Verified]** `/api/tags` and `/api/show` remain authoritative for which models exist locally, their `model_info` limits, and the `"thinking"` capability token (`modelDiscovery.ts:104-124,293-299`).

**[Recommendation]** Never enrich Ollama from Models.dev. Tags (`llama3.2:3b`, `qwen3:8b-q4_K_M`) do not reliably match catalogue ids, and the local `model_info` is a truthful `provider_reported` figure. No catalogue key is resolved for `type: "ollama"`.

### 6.2 Custom / OpenAI-compatible

**[Verified]** `type: "custom"` is free-text endpoint + free-text model ids (`modelDiscovery.ts:27-33,271-277`). There is no identity relation to any catalogue provider.

**[Recommendation]** **No automatic enrichment for `custom`**, and no new configuration field. Not by model id, not by `canonical_model_id`, not by endpoint string equality. An `openai`-typed provider pointed at a non-default endpoint is treated the same way: no enrichment. This is the guard against "OpenAI-compatible inherits official OpenAI metadata just because it speaks the protocol".

Revision 1 proposed an explicit `catalogProviderKey` binding. It is dropped: Cline has no equivalent, the brief forbids additional configuration without a demonstrated need, and no user has reported a missing custom-provider capability.

### 6.3 Identity rules (exact)

A provider is eligible for enrichment only if **all** hold:

1. `type` is `openai`, `anthropic`, or `google`.
2. `endpoint` is absent **or** normalizes exactly to that provider's default base URL after stripping trailing slashes.
3. The model id matches **exactly** (case-sensitive) a key in that provider's `models` object.

| TBAi type | Default endpoint | models.dev key |
|---|---|---|
| `openai` | `https://api.openai.com/v1` | `openai` |
| `anthropic` | `https://api.anthropic.com` | `anthropic` |
| `google` | `https://generativelanguage.googleapis.com` | `google` |
| `ollama` | — | none |
| `custom` | — | none |

**No three-axis table is needed.** Cline's `PROVIDER_IDS_MAP` exists because its runtime ids (`openai-native`, `openai-codex`, `cline`) differ from models.dev keys. TBAi's three official type strings are identical to their models.dev keys, so a literal `type` is sufficient plus the endpoint guard. This is the smallest faithful adaptation of Cline's identity concept.

### 6.4 User overrides

**[Verified]** A context-window override already exists and is correctly labelled: `ProviderDialog.tsx:329-352` writes through `configuredLimit`, and `web/src/config/modelContext.ts:99-106` parses it strictly.

**[Recommendation]** Keep exactly as-is. No new output override is added in this plan; the catalogue supplies a published output figure, and `resolveGenerationCap` already handles its absence. A user-entered number remains the highest authority because it is `configured`.

### 6.5 `canonical_model_id`

**[Verified]** Present on 7,617 models; e.g. `cline-pass/glm-5.3-flash → zhipuai/glm-5.3-flash`. Cline **does not use it at all** (absent from its `ModelsDevModel` type and generated catalogue).

**[Recommendation]** Do not use it. The cross-host `kimi-k3` and `gemma-4-31b-it` differences (§2.4) prove why.

---

## 7. Cline's actual implementation, traced

This section replaces Revision 1's comparison table with the actual call graph from the pinned revision. It records what TBAi copies, adapts, and rejects.

### 7.1 Acquisition and normalization call graph

```
fetchModelsDevProviderModels(url, fetcher)
  → fetchModelsDevPayload(url, fetcher)
       - plain fetcher(url); response.ok check; response.json()
       - NO ETag, NO If-None-Match, NO conditional request
  → normalizeModelsDevProviderModels(payload)
       → getSelectedModelsDevProviders(payload)
            - iterate providers sorted by key
            - selectedTargetProviderId(key, source):
                resolveGeneratedProviderIdForModelsDevKey(key)   // explicit map
                ?? (usesSupportedAiSdkProvider(source)
                      ? source.id || key
                      : undefined)
            - skip blocked ids and duplicate target ids
            - require a current builtin key or a supported AI SDK npm
       → for each selected provider, for each model:
            toModelInfo(modelId, model)
              - maxInputTokens = resolveMaxInputTokens(model.limit)
              - outputToken = model.limit?.output ?? DEFAULT_MAX_TOKENS (4096)
              - contextWindow = model.limit?.context
              - maxTokens = Math.floor(outputToken)
              - capabilities = toCapabilities(model)
              - reasoningOptions = model.reasoning_options (passthrough)
              - pricing, status, releaseDate, family, operation, modalities
              - metadata.apiProtocol = MODEL_API_PROTOCOLS[provider.npm]
       → filter:
            - drop model.tool_call !== true && !isSpecializedOperationModel
            - drop deprecated
            - drop unsupported provider/operation combinations
       → sortModelsByReleaseDate
```

`fetchLiveProviderModels` merges this with Cline's recommended-model payload; a models.dev failure is caught and replaced with `{}`. There is no retry and no log at that boundary.

**What TBAi copies:** one fetch, one parse, one normalized index keyed by provider then exact model id; TTL + in-flight dedup at the service boundary.

**What TBAi rejects:** the model-dropping filter (TBAi must never remove a discovered model because a third party says `tool_call: false`), and the silent failure (TBAi logs one warning and keeps last-known-good).

### 7.2 Limit mapping

Cline's exact rule (`catalog-live.ts`, `resolveMaxInputTokens`):

```ts
export function resolveMaxInputTokens(limit) {
  const contextLimit = limit?.context;
  const inputLimit = limit?.input;
  if (typeof contextLimit === "number" && typeof inputLimit === "number") {
    return Math.min(contextLimit, inputLimit);
  }
  return inputLimit ?? contextLimit ?? DEFAULT_MAX_INPUT_TOKENS; // 128_000
}
```

and in `toModelInfo`:

```ts
const maxInputTokens = resolveMaxInputTokens(model.limit);
const outputToken = model.limit?.output ?? DEFAULT_MAX_TOKENS; // 4096
```

**Copy:** the `min(context, input)` rule and the `input ?? context` fallback.
**Reject:** the `128_000` / `4096` defaults inside normalization. TBAi labels fallbacks with provenance in the resolver; duplicating them here would make a stand-in look like a catalogue fact.

### 7.3 Reasoning control fold

Cline's `getModelReasoningControls` (`providers/model-facts.ts`) is a pure fold over `reasoningOptions`:

```ts
const effort = options.find((o) => o.type === "effort");
const budget = options.find((o) => o.type === "budget_tokens");
const toggle = options.some((o) => o.type === "toggle");
const advertised = new Set(effort?.values ?? []);
return {
  effort,
  budget,
  toggle,
  efforts: ACTIVE_REASONING_EFFORTS.filter((v) => advertised.has(v)),
  supportsOff: toggle || advertised.has("none"),
  supportsDefault: advertised.has("default"),
};
```

The schema (`sdk/packages/shared/src/llms/reasoning-options.ts`) is a discriminated union on `type`:

```ts
{ type: "toggle" }
{ type: "effort", values: (ReasoningLevel | "default" | null)[] }
{ type: "budget_tokens", min?: number, max?: number }   // min <= max refined
```

**Copy:** the three control shapes, the `supportsDefault` marker, and exact advertised values as the selection vocabulary.
**Reject — `supportsOff` as a TBAi UI rule.** Cline folds `toggle || advertised.has("none")` into one boolean and uses it to send `"none"` when a disable is requested. That is defensible for Cline's request normalizer, which only needs a wire value. It conflates three claims TBAi must keep separate: a toggle (not encodable as a disable on most providers, and not proof of disable support on Anthropic — §2.5.1), an advertised `none` (the explicit no-reasoning effort value), and Provider default (send nothing). TBAi copies only the `advertised.has("none")` half, as the offered `none` value where the adapter accepts it; it never derives Off or a disable from `toggle`.
**Reject:** the lossy fold itself. TBAi keeps the control array in source order, so a model advertising both `toggle` and `effort` (DeepSeek) can present both without collapsing them into a single boolean/level view.

**[Verified] Effort dominance is Cline's own policy, not a TBAi invention.** `routing_anthropic-compatible.ts` selects the `anthropic-adaptive` route whenever the controls contain an `effort` entry, **even when a numeric budget control is also advertised**, and then ignores the budget in favour of adaptive. TBAi applies the same dominance one layer earlier, at selection: a capability with an effort control offers its exact values and not budget presets (§12.1). This is what makes a single `"medium"` string unambiguous.

### 7.4 Reasoning request normalization

`normalizeReasoningRequest` (`providers/routing/reasoning-options.ts`) runs **before** any wire rule:

- `options === undefined` (no metadata) → pass effort through a default ladder: `low/medium/high` unchanged, `minimal → low`, `xhigh/max → high`.
- `options.length === 0` → remove reasoning entirely (send nothing).
- `enabled === false` → keep the disable only when `supportsOff`; otherwise remove it. **TBAi does not run this path**: it offers no disable in the initial release.
- `enabled === true` with no budget and no `default` → `normalizeReasoningEffort("medium", ...)`. **TBAi does not run this path** either: it offers no explicit enable.
- Effort is normalized to the **nearest advertised value**; ties preserve more capability.
- Anthropic budgets are capped at `outputCap - 1`; budget values are derived from a ratio of the model's output capacity.
- An advertised `"default"` is tracked as a capability flag (`supportsDefault`), never forwarded as an effort value. Cline's schema admits it because Models.dev publishes it; no adapter accepts it on the wire.

**Copy:** the branch structure (absent metadata → fallback; empty controls → send nothing; a disable only when the route proves it can be sent).
**Adapt:** Cline's unknown-metadata ladder (`minimal → low`, `xhigh/max → high`) is not needed. With unknown capability TBAi's UI offers only its four presets, so no out-of-preset value can reach the encoder; the existing preset encoding is already the fallback.
**Reject — two divergences and one omission.** (1) Cline's `normalizeReasoningEffort` **silently clamps** an unsupported selection to the nearest advertised effort. The brief explicitly forbids that. TBAi refuses with `{ reason: "unsupported_value", allowed }` and lets the user choose again. (2) Cline fills `enabled === true` with `"medium"` when no budget or `default` applies. TBAi offers no explicit enable, so no level is invented; Provider default sends nothing. **Omitted:** Cline's `enabled === false → keep only when supportsOff` branch is not copied, because TBAi's initial release offers no disable at all; `off` is Provider default and sends nothing. TBAi also does not derive budget values from a ratio: its presets are named, displayed, and clamped to published bounds.

### 7.5 Provider-option composition and rules

`composeAiSdkProviderOptions` (`providers/routing/provider-options.ts`):

1. `normalizeReasoningRequest(...)`.
2. `matchProviderOptionRules(PROVIDER_OPTION_RULES, input)` — each rule declares `applies`, optional `suppresses`, and `build`.
3. Build the base compatible/anthropic option buckets.
4. Merge the ordered patches into `providerOptions`.

Relevant rules (`provider-option-rules.ts`):

| Rule | Behaviour |
|---|---|
| `directAnthropicProviderRule` | On the official endpoint only, adds `{ anthropic: { fallbacks: "default" } }`; suppresses generic fanout. |
| `directGoogleProviderRule` | Owns the `google` bucket; suppresses generic fanout. |
| `openAiAdapterRule` | Always writes the `openai` bucket (`strictJsonSchema: false`), independent of provider id. |
| `genericProviderFanoutRule` | Writes provider-id and camelCase alias buckets for non-OpenAI targets unless suppressed. |
| `geminiThinkingRule` | Applies only when the model's controls include `budget_tokens` **and** a budget value is present; writes `{ google: { thinkingConfig: { thinkingBudget, includeThoughts: true } } }`. |
| `ollamaNativeOptionsRule` | Writes `{ ollama: { options: { num_ctx } } }`. |
| `openAiCodexRule` | Responses options plus provider-id aliases, with `store: false`. |

**Copy:** the separation between *selection normalization* and *wire rules*, and the idea that each provider quirk is one named rule in one file.
**Adapt:** TBAi needs five branches, not twenty-two rules. It does not need a rule table, a rule registry, or suppressions — a `switch` over `type` plus the control type is smaller and equally readable at TBAi's scale.
**Reject:** the codex/Azure/gateway-specific rules and the `fallbacks` default (TBAi does not send it today; adding it is a separate product decision).

### 7.6 Identity mapping

`provider-keys.ts` is an explicit three-axis table:

```ts
{ modelsDevKey, generatedProviderId?, runtimeProviderId? }
```

`resolveProviderModelCatalogKeys(providerId)` returns the generated ids plus the raw id. Unmapped runtime ids fall through to `[providerId]`, and the blocked set is empty.

**Copy:** the concept of an explicit identity mapping, not a fuzzy match.
**Adapt:** TBAi's three official type strings already equal their models.dev keys, so the mapping is `type` itself plus an endpoint guard (§6.3). No table.
**Reject:** the raw-id fall-through. For TBAi, an unmapped or non-default endpoint must mean **no enrichment**; otherwise a custom provider named `openai` could inherit official metadata.

### 7.7 Catalogue service defaults

`provider-defaults.ts`:

- `DEFAULT_MODELS_CATALOG_URL` is a constant.
- TTL is 10 minutes.
- Fetch timeout is 5 seconds.
- `MODELS_CATALOG_CACHE` and `MODELS_CATALOG_IN_FLIGHT` deduplicate concurrent refreshes.
- Merge precedence: generated → defaults → live → private → public → user overrides.
- Failure returns the bundled/default catalogue rather than throwing.

**Copy:** constant URL, 10-minute TTL, 5-second timeout, in-flight dedup, non-throwing failure, last-known-good.
**Adapt:** TBAi has no bundled generated catalogue. On failure with no prior snapshot, enrichment is simply skipped; discovery still returns the provider's own models.
**Reject:** the multi-layer merge precedence and user overrides — TBAi's only stored values are the user's selected `ModelOption`s.

### 7.8 Copy / adapt / reject summary

| Aspect | Decision |
|---|---|
| Fetch and normalize once | Copy. |
| `min(context, input)` / `input ?? context` | Copy. |
| Defaults inside normalization | Reject. TBAi's resolver owns fallbacks. |
| Drop models on `tool_call`/deprecated | Reject. Discovery must not hide models. |
| Control shapes (`toggle`/`effort`/`budget_tokens`) | Copy, with validation. |
| `supportsDefault` | Copy as a marker: an advertised `default` maps to Provider default and is never stored or transmitted. |
| `supportsOff` (`toggle \|\| advertised.has("none")`) | **Reject.** It conflates a toggle, an advertised `none`, and Provider default; copies only `advertised.has("none")` (§7.3). |
| Nearest-effort clamping | **Reject.** Refuse with `allowed`. |
| Ratio-derived budgets | Reject. TBAi presets, displayed and clamped. |
| Two-stage normalize → wire rules | Copy the separation; implement as one moved file. |
| Explicit provider identity | Adapt to three literal keys + endpoint guard. |
| Raw-id fall-through | Reject. |
| TTL + in-flight + non-throwing | Copy. |
| 4.4 MB generated snapshot | Reject. |
| ETag / disk cache | Reject. Not needed at TBAi's scale. |
| Silent failure | Adapt: log one warning, keep last-known-good. |
| Numeric budget/compaction heuristics | Reject. TBAi's policy is tested. |

---

## 8. Existing problems and risks

Severity: **H** = user-visible wrong behaviour or data loss; **M** = capability loss or misleading diagnostics; **L** = maintenance risk.

| # | Severity | Problem | Evidence |
|---|---|---|---|
| P1 | **H** | **Direct Chat resolved by native reasoning; Scheduler open.** The Scheduler still floors an unknown selection to `medium`/`4096`. A model publishing only `low/high/max`, or only `minimal/low/medium/high`, receives a value it may reject or silently run at a different depth. Direct Chat now forwards `low`/`medium`/`high` and omits the option otherwise. | `schedulerExecution.ts:204-215`; `execute-direct-stream.ts:405-410` |
| P2 | **H** | Scheduler encodes OpenAI-compatible reasoning under the literal `openai` namespace. Compatible gateways ignore it; reasoning silently does not happen. | `schedulerExecution.ts:213-216` vs `execute-direct-stream.ts:405-410` |
| P3 | **H** | Scheduler sets no **per-generation output cap** and performs no **context-window budgeting**, **compaction**, or **tool-loop history reduction**. `stopWhen: stepCountIs(10)` appends every tool result to the message array, so the input can grow until the provider rejects it. These are four different quantities (§3.1); setting `maxOutputTokens` addresses only the first. | `schedulerExecution.ts:453-460`; contrast `execute-direct-stream.ts:440` and `assemble-run.ts` |
| P4 | **M** | Google scheduler omits `includeThoughts` and always uses `thinkingBudget`; Gemini 3 gets the wrong option generation. | `schedulerExecution.ts:203-207` |
| P5 | **M** | Discovery drops real chat models by name regex (`o1`, `o3`, `o4-mini`, `gemma-4-*`, `deep-research-*`). | `modelDiscovery.ts:71-81` |
| P6 | **M** | OpenAI/Anthropic/Google reasoning is always `unknown`, so the tri-state is never exercised for the three providers where it matters most. | `modelDiscovery.ts:197,222,244` |
| P7 | **M** | Every model without provider-reported limits is budgeted against 128 K, refusing up to ~75 % of a 512 K window (documented). | `limits.ts:41-58` |
| P8 | **M** | The UI always offers four levels, including models that explicitly cannot use them, and never shows that a value was substituted. | `DirectChips.tsx:27-32,159` |
| P9 | **M** | There is no validation anywhere that a stored reasoning selection is valid for the selected model — chat, conversation, provider, or scheduler. | `validation.ts:56,560`; `schedulerValidation.ts` (no thinking check) |
| P10 | **M** | Reasoning encoding now differs in kind: Direct Chat delegates to AI SDK v7 native reasoning, while the Scheduler keeps an inline provider encoder that has diverged. | §1.5 |
| P11 | **L** | `model_catalog` is mentioned in prose (`capabilityDiscovery.ts:22-27`, `decisions.md:3083-3107`) but does not exist in types, so the documented design and the code disagree. | `capabilityDiscovery.ts:22-27` |
| P12 | **L** | `ProviderDialog.tsx` and `src/types/index.ts` contain pre-existing mojibake (`â€”`). Unrelated to this work; recorded so it is not mistaken for a regression from it. | `ProviderDialog.tsx:329,530,616` |
| P13 | **M** | No shared validity rule: the UI's fixed list and the Scheduler's inline encoder can disagree. Toggle-only, effort-only, budget-only, toggle+effort, and toggle+budget models have no defined offered set, and nothing proves every rendered choice is encodable. Direct Chat no longer encodes effort itself. | `DirectChips.tsx:27-32,159`; `JobEditor.tsx:812-818`; `schedulerExecution.ts:199-217` |

### 8.1 Risks in the proposed direction

| Risk | Mitigation |
|---|---|
| A wrong catalogue figure causes a false pre-flight rejection | Make `model_catalog` **advisory** (§3.4). |
| A stale stored figure outlives a catalogue correction | Re-enrich on every discovery; `model_catalog` values are replaced, `provider_reported`/`configured` are never replaced. `discoveredAt` records the pass; no per-field timestamp. |
| Provider keys do not match user configuration, so the feature looks inert | Accept misses. Log `catalogMatched: false` with the exact key tried. Never fuzzy-match. |
| Reasoning values differ by provider for the same model | Provider-scoped keys; no canonical fallback. |
| Models.dev outage breaks discovery | Enrichment is optional and non-throwing; last-known-good retained; chat never waits. |
| 5.9 MB parse on every refresh | Parse once per 10-minute TTL, only during discovery; never on the chat path. |
| Type changes break stored configs | All new fields optional; all old values valid; no DDL (§14). |
| A stored reasoning value becomes invalid when the model changes | **Superseded (historical).** The native path performs no capability validation; the adapter or provider rejects an unsupported value. Capability-aware refusal with `allowed` is deferred (§15). `"off"` always sends nothing. |
| First enrichment changes an existing conversation's reasoning | **Historical.** Enrichment does not ingest reasoning metadata today. If it did, it would write capability only, never a selection; `"off"`/absent always send nothing. Deferred with metadata discovery. |
| An explicit disable cannot be offered | Intentional scope decision: no catalogue field proves endpoint disable support, and `between_tools` is not a full disable. Deferred with a verified per-model allowlist (§12.4). |
| A stale observed limit causes a false pre-flight rejection | Recorded pre-existing behaviour (§3.3): no TTL, terminal in `decideBudget`, invalidated only by an endpoint/protocol key change, restart, or LRU eviction. Precedence and budget policy are unchanged; fixing it is out of scope. |
| Scheduler context growth is mistaken for solved by `maxOutputTokens` | Any future Scheduler work must be scoped to the per-generation cap and namespace fix. Context budgeting, compaction, and loop-history reduction are a separate item (§15, "Out of scope"). |
| A UI choice is rendered that the adapter cannot encode | **Historical.** No dynamic UI exists; the composer offers only `off`/`low`/`medium`/`high`. The one-validity-rule and cross-tree matrix are deferred with dynamic selections. |
| A catalogue `default`, `-1`, or disable is sent literally | **Historical.** No catalogue reasoning value reaches the wire today. `-1` is research data only; no disable encoding exists. Deferred with metadata discovery. |

---

## 9. Simplified architecture

### 9.1 Components — one new file, one moved file

> **Partly historical.** `src/services/modelCatalog.ts` and its context-window enrichment remain active. The moved `provider-options.ts` and the shared reasoning codec shown below are **cancelled**; do not move the file or implement the codec.

```
┌──────────────────────────────────────────────────────────────────────┐
│ src/services/modelCatalog.ts            (NEW, one file)              │
│   fetchCatalog()    5 s timeout, 10 min TTL, in-flight dedup,        │
│                     last-known-good, one warn on failure             │
│   normalize()       payload → compact index; min(context,input)      │
│   resolveCatalogKey({type, endpoint}) → "openai" | "anthropic" |      │
│                     "google" | undefined                             │
│   enrichModels(models, provider) → ModelOption[]                     │
│   lookup()          exact (provider key, model id)                   │
└──────────────────────────────────────────────────────────────────────┘
                │ called only from
                ▼
        discoverModels()  (src/services/modelDiscovery.ts)
                │
                ▼
        provider.models JSON (SQLite, unchanged)

At request time (pure, no catalogue access):
  resolveContextLimit()          ← reads stored model_catalog values
  resolveReasoningSelection()    ← moved to src/services/provider-options.ts
                                    reads stored controls
  streamText()
```

### 9.2 Data-flow rules

1. The chat request path **never** imports or awaits the catalogue service.
2. Enrichment runs only inside discovery (a user action) and is best-effort.
3. Stored provenance is always written through a writer function (`providerReportedLimit`, `configuredLimit`, new `catalogLimit`), never an inline literal.
4. The resolver remains a pure function of stored config plus the optional observed figure.
5. Protocol encoding remains code, in one module, shared by chat and scheduler.
6. No per-conversation snapshot, no metadata version, no new user configuration.

### 9.3 Source-of-truth comparison

| Information | Models.dev | Provider API | Local runtime (Ollama) | User override | Application code |
|---|---|---|---|---|---|
| Which models exist | ✗ | **✓ authoritative** | **✓ authoritative** | ✓ manual entry | — |
| Total context window | **✓** (`limit.context`) | sometimes | ✓ `model_info` | — | — |
| Max input | **✓** (`limit.input`, 19 %) | sometimes | ✓ | **✓ highest** | min() rule |
| Max output | **✓** (`limit.output`) | sometimes | ✓ | **✓ highest** | cap policy |
| Reasoning support | **✓** | rare | ✓ `"thinking"` | — | tri-state rules |
| Reasoning control kind/values | **✓** | rare | partial | — | validation + UI mode |
| Reasoning defaults | ✗ (none in the v1 payload; v2 defines an unused member) | ✗ | ✗ | ✓ explicit selection | "send nothing" |
| Wire protocol | ✗ | ✗ | ✗ | **✓** (`apiProtocol`) | **✓** codecs |
| Tool calling | **✓** (unused here) | rare | rare | — | out of scope |
| Image input | **✓** (unused here) | rare | rare | — | out of scope |
| Local runtime details | ✗ | ✗ | **✓** | — | — |
| Budget/compaction policy | ✗ | ✗ | ✗ | partial | **✓** |
| Prices | ✓ (unused) | ✗ | ✗ | — | — |

### 9.4 Precedence summary

**Context window (resolved):**

```
configured > provider_reported > observed > model_catalog > conservative_default > unknown
```

**Reasoning selection:**

```
one-shot request > conversation > provider setting > no selection (send nothing)
```

Validation against capability and adapter happens at the boundary; an invalid selection is refused, never replaced. `"off"` and no selection both send nothing (Provider default). An advertised `default` resolves to the same choice and is never transmitted. `"none"` is the only explicit no-reasoning selection and is offered only where the adapter has an effort field that accepts it. No disable or explicit-enable selection is offered in the initial release (§12.3, §12.4).

**Identity:**

```
official type + exact default endpoint → enrich
anything else → no enrichment
```

### 9.5 How much smaller this is than Revision 1

| Revision 1 | Revision 2 |
|---|---|
| 4 new catalogue modules + 1 enrichment module | 1 new file |
| 3 new reasoning modules | 1 moved file, extended |
| 2 new `ModelOption` provenance fields | 0 |
| 1 new `ProviderConfig` field | 0 |
| ETag + optional disk cache | TTL + in-flight + last-known-good |
| Generated-catalogue decision | no generated artefact |
| Tool gating + media surfacing | out of scope |

---

## 10. Exact files that need modification

> **Historical rows.** In §10.1 and §10.2, every row whose phase is P2 or P3 belongs to the superseded reasoning proposal and must not be implemented. The P1 portion of a P1/P2 row remains active; P4 rows remain active.
>
> Read the phase column as follows: **P1/P4 = active**; **P2 = superseded** (native reasoning replaced the codec, and `provider-options.ts` was not moved); **P3 = deferred, requiring separate approval**.

Every row names the owning layer and the reason.

### 10.1 New and moved files

| File | Owner | Purpose | Phase |
|---|---|---|---|
| `src/services/modelCatalog.ts` | services | Fetch/normalize/lookup/identity/enrich; the only module that knows Models.dev exists. | P1 |
| `src/services/provider-options.ts` | services | Moved from `src/routes/chat/provider-options.ts`; adds capability-aware validation and encoding. | P2 |
| `web/src/lib/reasoning-options.ts` | lib (shared by two features) | Pure derivation of UI choices from `ReasoningCapability`; consumed by composer and scheduler. | P3 |
| `tests/unit/services/modelCatalog.test.ts` | tests | Fetch/TTL/dedup/failure/normalize/identity/enrichment. | P1 |
| `tests/unit/services/provider-options.test.ts` | tests | Selection validation + all protocol branches. | P2 |
| `tests/unit/web/reasoning-options.test.ts` | tests | Choice derivation for all four capability states. | P3 |

### 10.2 Existing files

| File | Change | Why | Phase |
|---|---|---|---|
| `src/types/index.ts` | Add `model_catalog` to `CONTEXT_WINDOW_SOURCES`; add `catalogLimit()`; add `ReasoningControl`, `controls`, `source`; widen `ProviderConfig.thinking` to `string`. | Stored vocabulary. | P1/P2 |
| `src/lib/validation.ts` | Extend `contextWindowSourceSchema`; extend `reasoningCapabilitySchema`; widen chat `reasoningLevel` and Provider `thinking` to the validated selection schema. `schedulerJobCreateSchema.thinkingLevel` is not touched in these phases. | Boundary must accept the new context metadata, reasoning metadata, and chat/provider selection. | P1/P2 |
| `src/lib/validation.ts` | Widen `schedulerJobCreateSchema.thinkingLevel` to the validated selection schema. | Scheduler may accept dynamic advertised values only once the shared encoder and model-specific validation land alongside it. | P3 |
| `src/context/types.ts` | Add `"model_catalog"` to `LimitSource`. | Resolver output vocabulary. | P1 |
| `src/context/limits.ts` | Rank candidates explicitly; include `observed` as a candidate above `model_catalog`; add `model_catalog`; keep `configured` first; keep agreement/divergence. Remove the observed-only empty-path branch. | One place authority is decided (C5). | P1 |
| `src/context/budget.ts` | Add `model_catalog` to the advisory set. | A third-party figure must not hard-reject. | P1 |
| `src/services/modelDiscovery.ts` | P1: call `enrichModels` after normalization. P4: replace the `isKnownChatFamily` name regex with the modality-only filter. | P6; P5. The filter change is separable. | P1/P4 |
| `src/services/capabilityDiscovery.ts` | Update the "third-party catalogue is not produced here" comment: it is now produced by `modelCatalog.ts`. | The comment becomes false. | P1 |
| `src/services/scheduler/schedulerExecution.ts` | Replace the inline block with `resolveReasoningSelection`; pass `model.maxOutputTokens` as the **per-generation cap only**. Context budgeting, compaction, and tool-loop history reduction are not part of this change (P3 scope, §15). | §8 P2/P4. | P3 |
| `src/services/scheduler/schedulerTypes.ts` | `ThinkingLevel = string`, documenting the legacy four. | Dynamic values. | P3 |
| `src/services/scheduler/schedulerValidation.ts` | Validate the selection against the job's model capability. | P9. | P3 |
| `src/services/scheduler/schedulerStore.ts` | No schema change; widen only the TypeScript read/write type. | Column is already `TEXT`. | P3 |
| `src/routes/chat/validate-and-resolve.ts` | Call `resolveReasoningSelection`; map a refusal to 400 with `allowed`. | P1/P9. | P2 |
| `src/routes/chat/types.ts` | Update the imported return type. | Compile. | P2 |
| `scripts/verify-reasoning.ts` | Update the import and call site (it currently imports `buildReasoningProviderOptions` from the route file). | Listed consumer; must not be missed by the move. | P2 |
| `tests/helpers/chat-route-parity.baseline.json` | Replace the recorded `src/routes/chat/provider-options.ts` path with the new service path, or the parity guard will treat the move as a dropped route file. | Listed consumer; source-path guard. | P2 |
| `src/routes/chat/model.ts` | Update the doc comment for the widened vocabulary. | Accuracy. | P2 |
| `web/src/types/index.ts` | Mirror the capability fields; widen stored reasoning types. | Frontend consumes them. | P3 |
| `web/src/components/composer/DirectChips.tsx` | Use `reasoningChoices(...)`; remove the fixed-list assumption when controls exist. | P8. | P3 |
| `web/src/features/scheduler/components/JobEditor.tsx` | Use the same helper; drop the hardcoded union at `:93`. | Consistency. | P3 |
| `web/src/features/providers/ProviderDialog.tsx` | Show "Models.dev" when `contextWindowSource === "model_catalog"` (**deferred — not part of active P1 or P4; requires separate approval**). No source label is rendered today. | Transparency. | Deferred |
| `docs/decisions.md` | Record: third stored source, advisory authority, no canonical matching, no custom enrichment, protocol stays code, no migration. | ADR. | P1 |
| `docs/provider-system.md` | Document discovery enrichment and identity rules. | Operator-facing behaviour. | P1 |
| `docs/architecture.md` | Add `modelCatalog.ts` to the backend ownership table. | Ownership. | P1 |

### 10.3 Explicitly **not** touched

- `src/context/assemble.ts` budget ordering, `src/context/compaction/*`, `src/lib/prune-messages.ts`, `src/lib/model-messages.ts`, `src/services/tools.ts`, MCP, OpenCode, storage schema/DDL, `package.json` dependencies.
- No generated catalogue file. No disk cache. No per-conversation snapshot. No metadata version. No `catalogProviderKey`. No tool gating.

---

## 11. Type and validation changes

> **Partly historical.** `CONTEXT_WINDOW_SOURCES`, `catalogLimit`, and `LimitSource` remain active. `ReasoningControl`, `controls`/`source`, the `reasoningCapabilitySchema` extensions, and `reasoningSelectionSchema` are historical and superseded by native reasoning; do not implement them.

### 11.1 Types

```ts
// src/types/index.ts
export const CONTEXT_WINDOW_SOURCES = [
  "provider_reported",
  "configured",
  "model_catalog",
] as const;

export type ReasoningControl =
  | { readonly type: "toggle" }
  /** Non-null, non-empty, deduplicated values in source order. `"default"` is a
   *  marker, never a wire value. */
  | { readonly type: "effort"; readonly values: readonly string[] }
  /** Published bounds exactly as Models.dev states them: `min` may be -1 (a valid
   *  upstream sentinel whose meaning is not assumed) or 0, either bound may be
   *  absent, and no preset is ever clamped to 0 or transmitted negative. `-1` is
   *  not zero and is not a disable. */
  | { readonly type: "budget_tokens"; readonly min?: number; readonly max?: number };

export interface ReasoningCapability {
  support: CapabilitySupport;
  levels?: string[];
  /** Validated catalogue controls in source order, at most one per type.
   *  Encodability is derived by the adapter rules (§12.3), not stored. */
  controls?: ReasoningControl[];
  source?: "provider_reported" | "model_catalog";
}

/** Build a `model_catalog` limit. Used only by enrichment. */
export function catalogLimit(value: number): SourcedNumber {
  return { value, source: "model_catalog" };
}

export interface ProviderConfig {
  // …existing…
  /** Any advertised or preset selection; validated at the boundary.
   *  `"off"` (and absence) is Provider default: send no reasoning option. */
  thinking?: string;
}
```

```ts
// src/context/types.ts
export type LimitSource =
  | "provider_reported" | "configured" | "model_catalog"
  | "observed" | "conservative_default" | "unknown";
```

No `ModelOption` fields are added. Context/output provenance uses the existing `contextWindowSource` / `maxOutputTokensSource`; reasoning provenance uses `capabilities.reasoning.source`.

### 11.2 Validation

```ts
// src/lib/validation.ts
export const contextWindowSourceSchema = z.enum([
  "provider_reported", "configured", "model_catalog",
]);

/**
 * These bounds are the upstream Models.dev schema, not a TBAi policy:
 * effort values are nullable strings (the payload has no non-string values),
 * `budget_tokens.min >= -1`, `budget_tokens.max >= 0`, both optional, min <= max.
 * Normalization has already removed null effort entries (§11.3), so a stored
 * effort control always has at least one value.
 */
const reasoningControlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("toggle") }),
  z.object({
    type: z.literal("effort"),
    values: z.array(z.string().min(1).max(40)).min(1).max(64),
  }),
  z.object({
    type: z.literal("budget_tokens"),
    min: z.number().min(-1).optional(),
    max: z.number().min(0).optional(),
  }).refine((v) => v.min === undefined || v.max === undefined || v.max >= v.min, {
    message: "budget max must be >= min",
  }),
]);

export const reasoningCapabilitySchema = z.object({
  support: z.enum(["supported", "unsupported", "unknown"]),
  levels: z.array(z.string().min(1).max(200)).optional(),
  controls: z.array(reasoningControlSchema).max(8).optional(),
  source: z.enum(["provider_reported", "model_catalog"]).optional(),
});

/** An opaque selection, validated against the model's capability later.
 *  `"off"` is always accepted and means Provider default (send nothing). */
const reasoningSelectionSchema = z.string().min(1).max(40);
```

**Boundary rules (historical — not implemented)**

- `chatRequestSchema.reasoningLevel` → `reasoningSelectionSchema.optional()` was proposed for P2; it is superseded.
- Provider `thinking` → `reasoningSelectionSchema.optional()` was proposed for P2; it is superseded.
- `schedulerJobCreateSchema.thinkingLevel` keeps its existing four-level validation (`off`/`low`/`medium`/`high`). Widening it was deferred with the Scheduler work and requires separate approval; it would land with `schedulerTypes.ts`, `schedulerValidation.ts`, the Scheduler UI, and any shared encoder.
- The proposed chat-route capability validation with `400 { error, allowed }` is not implemented. The Scheduler has no capability validation either; both are deferred.

### 11.3 Enrichment rules

```
if existing.contextWindowSource ∈ {provider_reported, configured}: keep
else if catalog.context/input present:
    contextWindow = min(context, input)   // or input ?? context
    contextWindowSource = model_catalog

if existing.maxOutputTokensSource ∈ {provider_reported, configured}: keep
else if catalog.output present:
    maxOutputTokens = output
    maxOutputTokensSource = model_catalog

if existing.capabilities.reasoning.support === "unknown" and catalog row matched:
    capabilities.reasoning = {
      support: catalog.reasoning ? "supported" : "unsupported",
      controls: normalizeControls(catalog.reasoning_options),
      source: "model_catalog",
    }
```

**Validation at normalization:**

- `context`, `input`, `output` must be finite positive integers; otherwise drop the field. (This is the §2.6 limit rule; it does **not** apply to `budget_tokens`.)
- `input > context` → `min()` yields `context`; do not store `input`.
- `output > context` → store the published figure; `resolveGenerationCap` clamps it to the remaining window.
- `budget_tokens`: keep the control when every present bound satisfies the upstream schema — `min >= -1`, `max >= 0`, `min <= max`. **`min = 0` and `min = -1` are valid and stored.** Missing bounds are kept. Drop only a control that violates a bound or the ordering; keep every other control. Do not round, clamp, or reinterpret at normalization. `-1` is a valid upstream sentinel whose meaning is not assumed from the observed rows, **not zero**, and is never stored as a disable. A published `0` is a fact, but it does not make Off available: no disable is inferred from `min` (§2.5.1).
- `budget_tokens` with `max = 0` is stored (it is a true published fact) but yields no usable preset; the derived view (§12.1) treats it as undialable budget.
- `effort.values`: drop `null` entries and empty strings, deduplicate preserving first-seen order. `"default"` is retained as a marker. If nothing remains, drop the effort control — not the whole capability.
- Keep at most one control per `type`, the first in source order. Cline's fold uses `find`/`some`, so a duplicate type has never had meaning; collapsing at normalization keeps the stored shape unambiguous.
- Unknown control `type` → skip that object; do not fail the whole model.
- `reasoning_options` absent or not an array → `controls: undefined` (no published claim).
- `reasoning_options: []`, or every control dropped by the rules above → `support: "supported"`, `controls: []` (published, undialable), never `unsupported`.

The stored controls are the **validated catalogue facts**. Which of them the installed adapter can encode is *derived at read time* (§12.3), not written into storage, so a future adapter change does not require re-enrichment and no true metadata is discarded.

---

## 12. Reasoning selection contract

> **HISTORICAL — superseded.** This entire contract (offered selections, validation, encoding table, deferred disabling) describes the custom codec. It is **not** an implementation plan. Current behaviour is the native path in §15; model-specific and dynamic selections are deferred and require separate approval.

### 12.1 Offered selections

The offered set is produced by **one rule** used by both the UI and the encoder. It depends on the capability **and** the adapter, because the same control kind can be encodable on one provider type and not on another.

| Capability state | Offered selections | Notes |
|---|---|---|
| absent / `unknown` | `off`, `low`, `medium`, `high` | Existing presets, labelled as presets. `off` is Provider default. |
| `unsupported` | `off` | Encoder sends nothing; the model cannot reason. |
| `supported`, no usable control (absent, `[]`, or all adapter-unencodable) | `off`, labelled **"Provider default"** | Sends nothing. Does **not** claim disable and does **not** claim reasoning is enabled by default. |
| `effort[values]` only | each advertised value the adapter accepts, plus `off` (Provider default) | `none`, when advertised and accepted, is the explicit no-reasoning choice. An advertised `default` resolves to the `off` choice and adds no second chip. |
| `effort[values]` + `toggle` | the same as effort-only | The toggle adds no verified wire shape in the initial release; it never becomes Off or On. |
| `effort[values]` + `budget` | the same as effort-only | **Effort dominates budget**: no budget presets. |
| `budget{min,max}` only | `low`, `medium`, `high` (with token counts), plus `off` (Provider default) | Presets clamp to `[max(min ?? 1, 1), max]`; no preset is 0; `max` absent means uncapped; `max <= 0` means no presets (undialable). |
| `budget{min,max}` + `toggle` | presets, plus `off` (Provider default) | The toggle does not become Off; no disable is inferred (§2.5.1). |
| `toggle` only | `off` (Provider default) | A toggle alone has no verified TBAi wire shape; undialable. |

Rules:

- **Provider default is stored as `"off"` (existing) or absent, is always offered, and always sends nothing.** It is never labelled Off on a model that can reason, and it is never a disable.
- **No explicit disable and no `on` in the initial release.** A toggle, an advertised `none`, and a Google `min <= 0` are not disable evidence. Explicit disabling is deferred to a verified per-model allowlist (§12.4).
- **`none` is the one visible explicit no-reasoning selection.** It is offered only when advertised **and** accepted by the adapter's effort field. It is a separate choice from Provider default because it produces a different request (`reasoningEffort: "none"` vs `{}`).
- **An advertised `default` resolves to Provider default** and never produces a second chip or a transmitted literal.
- **Published effort values are intersected with the adapter's accepted set** before they are offered: Google `minimal/low/medium/high`; Anthropic `low/medium/high/xhigh/max`; OpenAI `none/minimal/low/medium/high/xhigh/max`; compatible any string. A value the adapter would refuse is not a choice.
- **`"off"` is always accepted**, on every capability, and sends nothing. Legacy `low`/`medium`/`high` remain accepted where they were valid before (§4.5); no other stored value is accepted outside the offered set.
- **`"default"` is never stored as a user selection and never transmitted as a literal** (§12.3).
- **`min = -1` never becomes `0` and no preset is ever 0.** `-1` contributes no lower bound and is never sent.

### 12.2 Validation

```ts
type ReasoningDecision =
  | { ok: true; providerOptions: ReasoningProviderOptions }
  | { ok: false; reason: "unsupported_value" | "unsupported_capability";
      allowed: readonly string[] };
```

- `selection === undefined` → `{ ok: true, providerOptions: {} }` (Provider default).
- `selection === "off"` → `{ ok: true, providerOptions: {} }` on **every** capability and every provider. This is Provider default, not a disable. It is always allowed.
- `selection === "default"` → `{ ok: true, providerOptions: {} }` defensively, but it is **not** added to `allowed` and is never stored as a user selection. The UI resolves an advertised `default` to the `"off"` choice before validation, so the encoder should never receive it; the defensive branch makes "never transmitted" a guarantee.
- `support === "unsupported"`: only `"off"` is accepted; anything else is refused with `allowed = ["off"]`. `"off"` encodes `{}`.
- `support === "unknown"` (or no capability at all): `off/low/medium/high` accepted; anything else refused with `allowed = ["off","low","medium","high"]`. These are presets, not model claims.
- `support === "supported"`: `selection` must be in the offered set from §12.1 **for this adapter**. `"off"` is always in that set. Otherwise refusal with that exact set.
- **Legacy `low`/`medium`/`high`** are not a special exception: they are accepted exactly where the offered set contains them — as presets for unknown/budget-only capability, or as exact advertised effort values. A value the current capability does not publish is refused with `allowed`, never remapped.
- **No disable or enable selection exists.** `"disabled"`, `"between_tools"`, and `"on"` are refused on every capability.
- Never clamp, never substitute, never invent a default. A refusal returns the same set the UI renders, so the error is actionable.

The encoder must not consult `capability.controls` directly to decide what is valid; it calls the same derivation used to build `allowed`. This is what prevents the UI and encoder from disagreeing (C6).

### 12.3 Encoding table

| Provider / selection | Encoding |
|---|---|
| Any + no selection (`undefined`) | `{}` |
| Any + `"off"` | `{}` — **never** a disable, never `reasoningEffort: "none"`, `thinkingBudget: 0`, `thinking: { type: "disabled" }`, or `between_tools` |
| Any + `"default"` (advertised marker, not a stored selection) | `{}`; the literal is never sent |
| Any + explicit disable or `"on"` | **Not offered**; no encoding exists in the initial release (§12.4) |
| Google + effort value | `{ google: { thinkingConfig: { thinkingLevel: value, includeThoughts: true } } }`, value in `minimal/low/medium/high` |
| Google + budget preset | `{ google: { thinkingConfig: { thinkingBudget: clamped, includeThoughts: true } } }`; lite/nano guard retained |
| Google + `"none"` | Not offered (Google's adapter effort set has no `none`) |
| Google + `toggle` without a budget control | Not offered (undialable) |
| Google + unknown + preset | Existing generation split (level for ≥3, budget otherwise; lite/nano guard) |
| Anthropic + effort value | `{ anthropic: { effort: value, thinking: { type: "adaptive" } } }`, value in `low/medium/high/xhigh/max` |
| Anthropic + budget preset (no effort control) | `{ anthropic: { thinking: { type: "enabled", budgetTokens: clamped } } }` |
| Anthropic + `"none"` | Not offered (Anthropic's adapter effort set has no `none`) |
| Anthropic + `toggle` + budget | Budget presets only; the toggle produces no Off |
| Anthropic + `toggle` only | Not offered (undialable) |
| OpenAI native + effort | `{ openai: { reasoningEffort: value } }` |
| OpenAI native + `"none"` (advertised) | `{ openai: { reasoningEffort: "none" } }` |
| OpenAI native + toggle or budget control | Not offered (undialable); never invent an effort |
| Compatible + effort | `{ [providerOptionsNamespace(provider)]: { reasoningEffort: value } }` |
| Compatible + `"none"` (advertised) | `{ [namespace]: { reasoningEffort: "none" } }` |
| Compatible + toggle or budget control | **Not offered. No `thinking` object is ever sent.** The SDK strips unknown keys. |
| Unsupported + `"off"` | `{}` |
| Unknown + preset | Existing preset maps, unchanged |

**Preset resolution:** `low = 1024`, `medium = 4096`, `high = 8192` (existing constants). The effective range is `[max(min ?? 1, 1), max ?? ∞]`; a value is clamped into it and floored to an integer. **No preset is ever 0**, because `0` is a documented disable on some Google models and a sentinel on others. `min = -1` is a valid upstream sentinel whose semantics must not be assumed from the observed rows: it contributes no lower bound, is **not** treated as `0`, and is never transmitted. If `max <= 0`, or the effective range is empty, no budget preset is offered. For Anthropic, additionally clamp to `outputCap - 1` when `outputCap` is known and raise the lower bound to 1,024 (the documented minimum), so `[max(min ?? 1024, 1024), max]`; a range that cannot hold a preset yields none. Presets that collapse to the same number are deduplicated. The resulting number is what the UI label shows, so the clamp is visible rather than silent.

**SDK verification (installed declarations and adapters):**

- `@ai-sdk/anthropic` 4.0.83 types `thinking` as `adaptive` | `enabled` (optional `budgetTokens`; required by the API in practice) | `disabled` | `between_tools`, and exposes top-level `effort: "low" | "medium" | "high" | "xhigh" | "max"`. Its adapter rewrites `disabled` to `between_tools` or removes it with a warning on models that always reason (`dist/index.js:3721-3736`), and rewrites `enabled` to `adaptive` when a model rejects budget thinking (`:3737-3743`). **That rewrite is why TBAi offers no disable**: a disabled request is not reliably honour-able, and `between_tools` disables only upfront thinking. `adaptive` is used only alongside an `effort` value.
- `@ai-sdk/google` exposes `thinkingLevel: "minimal" | "low" | "medium" | "high"`, `thinkingBudget`, and `includeThoughts`; setting either level or budget suppresses its own default. Its own fallback maps reasoning `none` to `{ thinkingBudget: 0 }` (`dist/index.js:2398`), which corroborates the documented disable for Gemini 2.5 Flash/Flash-Lite. It is **not** evidence that every model publishing `min <= 0` accepts a disable, and TBAi does not infer one (§2.5.1).
- `@ai-sdk/openai` exposes `reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`.
- `@ai-sdk/openai-compatible` declares exactly `user`, `reasoningEffort: string`, `textVerbosity`, `strictJsonSchema`, and strips unknown keys (`dist/index.d.ts:18-27`). **There is no `thinking` field.**

This resolves Revision 1's open Anthropic question — an effort-only catalogue row is encoded as `effort` + `adaptive`, never as a synthetic budget — and records Revision 2.2's scope decision: no disable or explicit-enable selection is encoded until a per-model verification exists (§12.4). The remaining **[Unverified]** items are named in Appendix B.

### 12.4 Deferred: explicit disabling

Explicit disabling is **not** part of the initial release. `off`/absent remains Provider default and always sends nothing. Adding a disable later requires all four of the following, in one separately authorized change:

1. **A new stored value** (for example `"disabled"`), so every existing `"off"` selection keeps its current meaning and no stored value is reinterpreted.
2. **A verified per-model allowlist** derived from official provider documentation, never from a Models.dev `toggle` or from `budget_tokens.min`. At minimum, Anthropic Sonnet 4.6 is documented to accept `disabled`; Sonnet 5, Sonnet 5.5 (rewritten to `between_tools`), Haiku 5.5, Haiku 4.5, Opus 5.5, and Opus 4.7 must not be offered it. Google would need a per-generation rule limited to `gemini-2.5-flash` and `gemini-2.5-flash-lite`, never 2.5 Pro or Gemini 3.x.
3. **An accurate UI label for substitution.** Anthropic's adapter can replace `disabled` with `between_tools` or remove it with a warning. `between_tools` is not a full disable and must never be labelled "Off"; the UI must be able to show "requested, not guaranteed" or refuse that model.
4. **A test matrix** proving the control is offered only for verified models and that a legacy `"off"` still sends nothing.

Until all four exist, no disable control is displayed anywhere.

---

## 13. Test plan and edge cases

> **Historical for reasoning.** §13.5 and §13.7, and the reasoning cases inside §13.6 and §13.8, describe tests for the superseded codec. They are retained as a record and are not active work. The context-window tests (§13.1–§13.4) remain active.

### 13.1 Catalogue module (`tests/unit/services/modelCatalog.test.ts`)

| Case | Asserts |
|---|---|
| First fetch populates snapshot | Provider/model counts; index keyed by provider then exact id. |
| TTL expiry | Refetches once. |
| Concurrent refresh | Exactly one network call (in-flight dedup). |
| Network failure with prior snapshot | Returns last-known-good; does not throw; warns once. |
| Network failure with no snapshot | Returns no enrichment; does not throw. |
| Malformed payload | Rejects the snapshot; retains previous; logs once. |
| Timeout | Aborts at 5 s; existing snapshot retained. |

### 13.2 Normalization and identity

| Case | Expected |
|---|---|
| `context=400000,input=272000` | `272000`. |
| `context=64000,input=256000` (anomaly) | `64000`. |
| No `input` | `context`. |
| No `context` and no `input` | no value. |
| `output=128000` | `128000`. |
| `reasoning: false` | `support: "unsupported"`, source `model_catalog`. |
| `reasoning: true`, `[]` | `support: "supported"`, `controls: []` (published, undialable). |
| `reasoning_options` absent / not an array | `support: "supported"`, `controls: undefined`. |
| toggle + effort | both controls preserved in order; the toggle is not interpreted as a disable. |
| `budget_tokens.min = -1` | control **kept** with `min: -1`; contributes no lower bound; no preset is 0; value never transmitted; **not** a disable. |
| `budget_tokens.min = 0` | control kept; **does not make Off available**; presets allowed when `max > 0`. |
| `effort.values` contains `none` | retained as an advertised value; offered only where the adapter's effort set accepts it (OpenAI native, compatible). |
| `budget_tokens` missing `min` and/or `max` | kept; missing `max` means uncapped, missing `min` contributes no lower bound (the preset floor is 1, so no preset can be 0). |
| `budget_tokens.max = 0` | kept; no usable budget preset. |
| `budget_tokens.min > max` | control dropped; other controls kept. |
| `budget_tokens.min < -1` or `max < 0` | control dropped; model still enriched. |
| `effort.values` contains `null` | null entries dropped; remaining values kept in order. |
| `effort.values` all `null` | effort control dropped; capability still `supported`. |
| `effort.values` contains `"default"` | retained as a marker; offered as Provider default; never transmitted. |
| Duplicate control of one type | first in source order kept. |
| Unknown control type | skipped; model still enriched. |
| `openai` + default endpoint | key `openai`. |
| `openai` + custom endpoint | no enrichment. |
| `custom` | no enrichment. |
| `ollama` | no enrichment. |
| Case difference in model id | no match (exact). |
| Model id present only on another provider | no match. |

### 13.3 Enrichment precedence

| Case | Expected |
|---|---|
| Provider-reported context exists | Not overwritten. |
| Configured context exists | Not overwritten. |
| Only catalogue exists | `model_catalog` written via `catalogLimit`. |
| Provider already reported reasoning | Not overwritten. |
| Unknown reasoning | Filled from catalogue. |

### 13.4 Resolver and budget

| Candidates | Winner | Provenance |
|---|---|---|
| configured + provider_reported | configured | `divergent: true` |
| configured + observed | configured | `divergent: true` |
| provider_reported + observed (different values) | provider_reported | `divergent: true` (outcome changes from Rev 2's silent winner: divergence is now recorded) |
| **observed (64k) + model_catalog (128k)** | **observed** | `divergent: true`; catalogue loses precedence (C5) |
| observed (64k) + model_catalog (64k) | observed | `agreed` |
| configured + model_catalog | configured | `divergent: true` |
| provider_reported + model_catalog | provider_reported | `divergent: true` |
| model_catalog only | model_catalog | advisory in budget |
| model_catalog equal to provider_reported | provider_reported | `agreed`, no divergence |
| observed only | observed | not advisory |
| none | `conservative_default` | advisory |
| invalid observed value | dropped; next candidate | diagnostic, rejection reason recorded |
| invalid catalog value | dropped; next candidate | diagnostic |

### 13.5 Selection and encoding

| Case | Expected |
|---|---|
| `undefined` | `{}` (not `"medium"`) |
| `"off"` on unknown / unmatched model | `{}` |
| `"off"` on OpenAI native, any capability | `{}`; no `reasoningEffort` key |
| `"off"` on compatible gateway, any capability | `{}`; no `reasoningEffort` key |
| `"off"` on Google, including budget `min = 0`, `min = -1`, `min = 128`, effort, and toggle-only | `{}`; **no `thinkingBudget: 0`** |
| `"off"` on Anthropic, including toggle, effort, budget, and toggle+budget | `{}`; **no `thinking` key at all** |
| `"off"` on unsupported | `{}` |
| `"default"` reaching the encoder | `{}`; the literal appears nowhere in `providerOptions` |
| Advertised `default` effort value | one Provider-default choice stored as `"off"`, not a second chip |
| `"none"` advertised + OpenAI native | `reasoningEffort: "none"` |
| `"none"` advertised + compatible gateway | `reasoningEffort: "none"` under the namespace |
| `"none"` on Google or Anthropic | refusal; `allowed` has no `none` (adapter effort set lacks it) |
| `"on"` on any provider/capability | refusal; `allowed` has no `on` |
| `"disabled"` or `"between_tools"` on any provider | refusal |
| Toggle-only Anthropic | offered set `["off"]`; every other selection refused |
| Toggle + effort Anthropic, `"off"` | `{}`; not `thinking: { type: "disabled" }` |
| Toggle + effort Anthropic, a value | `effort` + `adaptive` |
| `"xhigh"` where advertised and accepted (Anthropic) | `effort: "xhigh"` |
| `"xhigh"` advertised on Google | not offered; refusal, `allowed` lists the adapter set |
| `"medium"` where only `low/high/max` advertised | refusal, `allowed` lists three |
| Effort + budget both advertised, `"high"` | effort field only; no budget field |
| Preset on unknown capability | existing preset encoding |
| Unmatched model with stored `low`/`medium`/`high` | today's preset encoding, unchanged |
| Unsupported + `"off"` | `{}` |
| Unsupported + anything else | refusal, `allowed = ["off"]` |
| Compatible gateway + `"high"` | namespace `openaiCompatible`, not `openai`; no `thinking` key |
| Compatible gateway + toggle | refusal; **no `thinking` key in the output** |
| Compatible gateway + budget | refusal; no `thinking` key |
| Gemini effort + `"low"` | `thinkingLevel: "low"`, `includeThoughts: true` |
| Gemini budget + `"low"` | `thinkingBudget: 1024`, `includeThoughts: true` |
| Gemini budget `min = -1`, `"low"` | `thinkingBudget: 1024`; no negative value and no `0` emitted |
| Gemini budget `max = 0` | no preset offered; refusal |
| Anthropic effort + `"xhigh"` | `effort: "xhigh"`, `thinking: { type: "adaptive" }` |
| Anthropic budget + `"high"` | `budgetTokens: 8192` (clamped to `[min,max]` and `outputCap - 1`) |
| Native OpenAI + toggle `"on"` | refusal, no invented effort |
| Legacy stored `"off"` on any supported model | `{}`, accepted, rendered as Provider default |

### 13.6 Integration

| Case | Expected |
|---|---|
| `POST /api/providers/discover` with catalogue available | Enriched models; `provider_reported` untouched. |
| Same with catalogue unavailable (stubbed throw) | Identical model list; no enrichment; HTTP 200. |
| Discover → save → chat | `assemble.ts` resolves `model_catalog`; budget/compaction use it. |
| First enrichment of a model used by an existing conversation with stored `"off"` | The next request still sends `{}`; no disable and no invented level. |
| Enrichment writes | Only `provider_configs.models` capability fields change; `provider_configs.thinking`, `custom.reasoningLevel`, and `scheduler_jobs.thinking_level` are not written. |
| Unmatched model with stored `low`/`medium`/`high` | Same request as before enrichment. |
| Matched effort model with stored `"medium"` that is not advertised | 400 with `allowed` (chat) / validation error (scheduler); no provider call; never remapped to another level. |
| Chat with an invalid reasoning value | 400 with `allowed`; no provider call. |
| Scheduler run on a compatible gateway | `reasoningEffort` under the compatible namespace (regression for §8 problem P2). |
| Scheduler run on a compatible gateway with a toggle or budget control | No `thinking` object; Provider default or refusal (§12.3). |
| Scheduler job with `thinking_level = NULL` or `"off"` | No reasoning options; **no `provider.thinking` fallback** (§1.5). |
| Scheduler per-generation output cap | `streamText.maxOutputTokens` equals the model's published output figure when present; **deferred with Scheduler work — not part of an active phase**. |
| Scheduler context scope | `schedulerExecution.ts` still sends one user message and does not import `assembleContext`; no test claims context budgeting, compaction, or loop-history reduction. |
| Scheduler job saved with an invalid selection | Validation error at save; run-time revalidation fails loudly if the model changed. |

### 13.7 Frontend

**Cross-tree agreement matrix** (`tests/unit/web/reasoning-options.test.ts`). For every row, `reasoningChoices({capability, provider}).map(c => c.value)` must **equal** `allowedReasoningSelections(capability, provider)`. Equality, not subset: a choice offered on one side only is the defect this test exists for.

| Provider | Capability | Expected set |
|---|---|---|
| Anthropic | toggle only | `off` |
| Anthropic | effort only | `off` + adapter-accepted values (`low/medium/high/xhigh/max`) |
| Anthropic | budget only | `off`, `low`, `medium`, `high` |
| Anthropic | toggle + effort | `off` + adapter-accepted values |
| Anthropic | toggle + budget | `off`, `low`, `medium`, `high` |
| Anthropic | effort + budget | `off` + adapter-accepted values |
| OpenAI native | effort | `off` + adapter values (including `none` when advertised) |
| OpenAI native | effort + toggle | `off` + adapter values (the toggle adds nothing) |
| OpenAI native | toggle or budget | `off` |
| Google | effort | `off` + (`minimal/low/medium/high` ∩ advertised) |
| Google | effort + toggle | `off` + adapter values |
| Google | budget, any `min` (including `0` and `-1`) | `off`, `low`, `medium`, `high` |
| Google | toggle only | `off` |
| Compatible | effort | `off` + adapter values (including `none` when advertised) |
| Compatible | effort + toggle | `off` + adapter values |
| Compatible | toggle or budget | `off` |
| any | unknown / absent | `off`, `low`, `medium`, `high` |
| any | unsupported | `off` |

The "Provider default" chip carries the stored value `"off"`; it is not an additional value. An advertised `default` maps to this chip and adds no row. No row contains `"on"`, `"disabled"`, or `"between_tools"`.

DOM tests (`tests/dom/…`):

- Every rendered chip, when selected, passes the encoder decision (`ok: true`). No rendered choice produces `unsupported_capability`.
- Supported/undialable and adapter-unencodable controls → one "Provider default" chip (stored `"off"`).
- `unsupported` → only Off; it sends nothing.
- Unknown → the four presets, labelled as presets.
- A stored `"off"` on **any** supported model renders as "Provider default" and sends nothing; it is never shown as a disable.
- No Off or On chip is rendered for any supported model; a `toggle` alone produces only Provider default.
- `none` is rendered only where it is advertised and adapter-accepted; selecting it sends `reasoningEffort: "none"`, while Provider default sends `{}`.
- Stored value outside the offered set → visible "selection no longer supported" state with the allowed values; **no silent substitution**. `"off"` is always in the set, so it never reaches this state.
- Context ring still consumes only server metadata; no second resolver.

### 13.8 Guards that must be able to fail

Per AGENTS.md §6b, each guard is verified by introducing the defect first:

1. A test that fails if `provider-options.ts` ever contains a `?? "medium"` or `?? 4096` fallback.
2. A test that fails if the scheduler contains a literal `"openai"` namespace instead of `providerOptionsNamespace`.
3. A test that fails if `enrichModels` overwrites a `provider_reported` or `configured` value.
4. A test that fails if `canonical_model_id` appears anywhere in the resolution path.
5. A test that fails if the chat request path imports `modelCatalog.ts` (static import-graph assertion, same technique as `directCapabilityAuthority.test.ts`).
6. **No compatible `thinking`.** Encode every control kind under a compatible provider and assert that no bucket contains a `thinking` key. Verified by adding the old `thinking` branch and watching it fail.
7. **No literal `"default"`, no negative budget, and no zero budget.** Across every selection a capability+adapter can produce, assert the serialized `providerOptions` contains neither the string `"default"` as an effort value, nor a negative `thinkingBudget`/`budgetTokens`, nor a `thinkingBudget: 0`/`budgetTokens: 0`. Verified by encoding `"default"` verbatim, `-1`, and `0` and watching each fail.
8. **UI/encoder parity.** The §13.7 matrix must fail if a value is added to one derivation only. Verified by adding a temporary extra chip.
9. **Published bounds survive normalization.** A `min = 0` and a `min = -1` control must be stored. Verified by restoring the `.positive()` schema and watching the test fail.
10. **Scheduler scope.** A test that fails if `schedulerExecution.ts` imports `assembleContext` or `computeBudget` in any future Scheduler phase, so that work cannot quietly claim context management it does not implement.
11. **`off` is always provider default.** For every provider × control combination, encode `"off"` and assert the result is exactly `{}` — no `reasoningEffort`, no `thinking`, no `thinkingConfig`, no `thinkingBudget`. Verified by restoring the Rev 2.1 disable branch and watching it fail.
12. **No disable or enable encoding exists.** A source/AST-level guard fails if `provider-options.ts` emits `"disabled"`, `"between_tools"`, or `thinking: { type: "adaptive" }` without an accompanying `effort` value; a behaviour guard fails if `"on"`, `"disabled"`, or `"between_tools"` is accepted by `resolveReasoningSelection`. Verified by re-adding the `on` branch and watching it fail.
13. **No Google disable inference.** A capability with `toggle` and/or `budget_tokens.min <= 0` must not add Off to the offered set, and a `min = -1` row must never yield a `0` or negative budget. Verified by restoring the `min <= 0` rule and watching both assertions fail.
14. **Enrichment never writes a selection.** A test that fails if `enrichModels` (or any catalogue path) writes `ProviderConfig.thinking`, `custom.reasoningLevel`, or `scheduler_jobs.thinking_level`. Verified by adding a stray write and watching it fail.

### 13.9 Verification commands (for the implementation phase, not run now)

```
bun run typecheck
bun run lint
bun run test
bun run test:dom
bun run build
bun run test:locations
```

Real exit codes and suite/case counts must be reported; compilation is not completion.

---

## 14. Migration and backward compatibility

> **Status (Revision 2.4).** No migration is required today because the reasoning codec/metadata proposal was not implemented. Bullets below that mention `controls`, capability validation, or `allowed` describe that superseded proposal; they are not current behaviour. The live native behaviour is in §15.

### 14.1 No database migration

**[Verified]** `provider_configs.models` is a JSON column; every added field is optional. `provider_configs.thinking` and `scheduler_jobs.thinking_level` are already `TEXT`. Therefore:

- No `CREATE TABLE`, `ALTER TABLE`, index, or backfill.
- Old `ModelOption` rows remain valid: missing `controls` means "no catalogue claim".
- Old reasoning strings (`off/low/medium/high`) remain valid selections. `"off"` keeps its historical meaning — **send no reasoning option** — on **every** model, and is displayed as Provider default rather than Off (§4.3, §12.2). No stored value is migrated or reinterpreted.
- `low/medium/high` keep their preset meaning where they were valid before: unknown capability and budget-only capability. On a newly matched effort-capable model, they are accepted only when that exact value is advertised; otherwise the boundary refuses visibly with `allowed`, exactly as any other unsupported value. No catalog value is written into a selection.
- `LEGACY_SOURCE = "configured"` continues to handle bare `contextWindow` numbers.
- Stored `controls` are raw validated catalogue facts; the adapter-encodability view is derived at request time, so no re-enrichment is needed if an SDK version changes.

### 14.2 Behavioural compatibility

> **Partly historical.** The context-window rows describe active P1 work. Every reasoning row describes the superseded proposal; the live native behaviour is stated in §15, "Current implementation — native AI SDK v7".

| Surface | Before | After | Compatibility |
|---|---|---|---|
| Discover response | provider models only | provider models + optional catalogue fields | Additive; clients ignore unknown fields. |
| Stored model | two sources | may be `model_catalog` | New enum member; old rows unaffected. |
| Budget for a model with no provider limit | 128 K | a real figure when matched | **Intentional improvement**; diagnostics show the source. |
| Budget over an advisory ceiling | sent with `advisory` | unchanged, now also for `model_catalog` | No new hard failures. |
| Reasoning UI | always four levels | exact values when known, Provider default when undialable, presets when unknown; no Off/On disable chips | Visible change for catalogue-matched models; documented. |
| Existing stored `"off"` or no selection | sent nothing | sends nothing | **Unchanged on every provider**; never reinterpreted as a disable. |
| Existing stored `low`/`medium`/`high` | preset encoding | same preset encoding when capability is unknown or budget-only; exact value when advertised; visible refusal otherwise | No silent remap; a refusal is the already-accepted C6 behaviour. |
| Invalid stored selection | floored to medium | 400 / visible invalid state | **Intentional**; this is the defect being fixed. `"off"` is always accepted as Provider default and is not an exception. |
| Explicit disable / `"on"` | not present | **not added** | No regression; deferred (§12.4). |
| Context precedence | observed consulted only when nothing else existed | observed ranks above `model_catalog` and below `provider_reported` | Behaviour change for a model that has both a catalogue row and an observed figure; divergence is recorded (C5). |
| Observed limit staleness | no TTL; terminal in budget | unchanged | **Pre-existing and recorded (§3.3)**; enrichment does not modify observed limits or budget policy. |
| Scheduler selection | `thinkingLevel ?? "off"`, no provider fallback, four-level request schema | unchanged | `off`/`NULL` still sends nothing. Widening the schema/types and replacing the inline encoder were proposed in the superseded P3 and are **deferred, requiring separate approval**. |
| Scheduler | no max output, wrong namespace | per-generation `maxOutputTokens` and a namespace fix — **deferred with Scheduler work** | Bug fix, not part of any active phase; job configs unchanged. Context budgeting, compaction, and loop-history reduction are **unchanged** and remain out of scope. |

### 14.3 Rollback

Disabling enrichment and re-running discovery replaces `model_catalog` values; `provider_reported` and `configured` values are preserved. No operator-entered value can be lost.

### 14.4 What is **not** backward compatible, and why that is intended

1. **Historical (superseded codec).** The proposed rule that a stored reasoning value the model no longer publishes is refused with `allowed` is not implemented. The native path forwards `low`/`medium`/`high` to the adapter and lets the provider reject an unsupported value. Dynamic capability validation is deferred (§15). `"off"` still sends nothing.
2. Models dropped by the old name allowlist will appear in discovery after the P4 filter change. That is a fix, but it changes the visible model list.
3. No explicit-disable or explicit-enable selection is offered in the initial release. Neither exists today, so this is a deferred capability rather than a removed one (§12.4).

---

## 15. Phased implementation plan

Each phase is independently verifiable, leaves the tree green, and has a rollback that does not lose operator configuration.

**Phase dependencies:** **P1 (context windows) and P4 (discovery filter) are the active phases and are independent.** The former reasoning phases **P2 and P3 are superseded and deferred** (see the warning at the top of this document and "Current implementation — native AI SDK v7" below). No reasoning work should start from this document: model-specific reasoning metadata and dynamic selections require a new, separately approved proposal that starts from the native implementation.

### P1 — Context windows (the smallest useful slice)

**Deliverables**

- `src/services/modelCatalog.ts` (fetch, TTL, in-flight, normalize, identity, enrich).
- Types + validation: `model_catalog`, `catalogLimit`.
- `src/context/types.ts`, `limits.ts`, `budget.ts`: ranking + advisory.
- `discoverModels` calls `enrichModels`.
- Tests for normalization, identity, precedence, advisory.

**Not part of P1:** the Provider dialog "Models.dev" source label. No source label is rendered today (`ProviderDialog.tsx` writes `contextWindowSource` but displays no source); it is deferred and requires separate approval (§10.2).

**Exit criteria**

- A model published with `context 400k / input 272k` resolves `272000` and shows `model_catalog`.
- A model with a provider-reported or configured limit is unchanged.
- A catalogue outage produces the exact same discovery result as today.
- No DB migration; old rows resolve identically.

### P2 — Reasoning metadata and shared backend encoding (HISTORICAL — superseded)

> **Not an active plan.** The warning at the top of this document supersedes this phase in full. It is retained only as the record of the proposal that was evaluated and rejected. **Do not implement it:** do not move `provider-options.ts`, do not add `resolveReasoningSelection`/`allowedReasoningSelections`, do not widen the reasoning schemas, and do not add reasoning metadata ingestion. The catalogue facts cited below remain valid research about Models.dev; they are not work items.

**Superseded deliverables (not to be implemented)**

- `ReasoningControl`, `controls`, `source`; enrichment of `reasoning`/`reasoning_options` with strict validation.
- Move `src/routes/chat/provider-options.ts` → `src/services/provider-options.ts`; add the capability-aware decision function, the single `allowedReasoningSelections` derivation, and the shared provider-specific encoder.
- Exact-value validation: offer/accept only values the selected adapter can encode; refuse an unsupported value with `allowed` instead of mapping it to another level.
- Keep the `if (reasoning === "off") return {};` guard at the top of the encoder, **before every provider branch**. Precedence and meaning are unchanged: `off` and "no selection" are Provider default.
- Remove the unverified compatible-gateway `thinking` branch. Add **no** Google or Anthropic disable path, no `disabled`/`between_tools` encoding, and no `"on"` selection (§12.4). `none` is encoded only where the selected adapter accepts an effort value.
- Enforce effort-over-budget and the preset range `[max(min ?? 1, 1), max]`, so no preset emits a zero or negative budget and `-1` is never treated as a positive lower bound.
- Chat validates and encodes through the shared module; an invalid stored selection returns 400 with `allowed`.
- Widen the chat, conversation, and provider selection types without changing columns. The Scheduler would have remained untouched in P2 and adopted the shared schema in the (now deferred) P3. **No new stored value**: `"off"` remains Provider default; no disable or `"on"` value is added.
- Backend tests for normalization, exact-value validation, and every protocol branch.
- No UI exposure in P2; `DirectChips.tsx` and `JobEditor.tsx` would have kept their four-level behavior.

**Superseded exit criteria (historical)**

- A model advertising `xhigh` (accepted by the adapter) encodes `xhigh`; a model advertising only `low/medium/high` refuses `xhigh` with `allowed` and never sends `medium`.
- `"off"` and no selection produce `{}` on **every** provider and capability, with no `disabled`, no `between_tools`, no `thinkingBudget: 0`, and no `reasoningEffort: "none"`.
- No `"on"` and no explicit-disable selection exists in the encoder or in `allowedReasoningSelections`.
- A compatible gateway receives `reasoningEffort` under `providerOptionsNamespace`, never a `thinking` object.
- `"default"` never appears as a provider-option value, and no advertised `default` is stored or transmitted.
- `budget_tokens.min = 0` and `-1` survive enrichment; `-1` is not treated as a positive lower bound, and no preset or wire value is ever zero or negative.
- A chat request with an invalid stored selection returns 400 with `allowed`; no provider call is made.
- A scheduler job request carrying a value outside `off`/`low`/`medium`/`high` is still refused by the unchanged request schema.
- The backend test suites for metadata and encoding pass; the existing UI and Scheduler behavior is unchanged, with DOM tests still green.

### Current implementation — native AI SDK v7 (authoritative)

This subsection replaces P2 as the description of the live reasoning path. Verified against the working tree on 2026-11-04:

- **`low`, `medium`, `high`** are passed to `streamText` as the top-level `reasoning` option (`src/routes/chat/execute-direct-stream.ts:405-410`).
- **`"off"` and an absent selection omit the `reasoning` property entirely** (`:407`). No disable, no `thinkingBudget: 0`, and no `reasoningEffort: "none"` is transmitted for `off`.
- **Google `includeThoughts` is an additional provider option** (`src/routes/chat/provider-options.ts:34-51`): `{ google: { thinkingConfig: { includeThoughts: true } } }` is added while reasoning is active; the file chooses no effort or budget.
- **Provider wire-format mapping belongs to AI SDK v7** and the installed provider adapters: effort fields, thinking budgets, and adaptive thinking are emitted by the SDK, not by TBAi.
- **The four stored values remain the complete vocabulary:** `off`/absent, `low`, `medium`, `high`. Precedence is unchanged: request > conversation > provider `thinking` > `"off"` (`src/routes/chat/model.ts:54`).
- **No model-specific reasoning metadata is ingested.** `ReasoningCapability` remains `{ support, levels? }`; `controls`, `source`, dynamic effort values (`xhigh`, `minimal`, `none`, `max`), budget presets, capability validation, and `allowed` refusals do not exist.
- **The Scheduler is unchanged.** It still has its own inline encoder and four-level schema (`src/services/scheduler/schedulerExecution.ts:199-217`; `src/lib/validation.ts:560`).

### P3 — Dynamic UI and Scheduler integration (DEFERRED — requires separate approval)

> **Not scheduled and not authorized.** This phase depended on the superseded codec. Everything it proposed is deferred and requires a new, separately approved proposal that starts from the native implementation. Do not revive the old codec.

**Deferred work (requires separate approval)**

- Models.dev reasoning metadata ingestion (`reasoning_options`) and provenance (`controls`, `source`).
- Dynamic selections beyond `off`/`low`/`medium`/`high`, including advertised effort values and `none`.
- Exact-value validation with `allowed` refusals and a 400 contract.
- Composer choices and `web/src/lib/reasoning-options.ts`; any change to `DirectChips.tsx` or `JobEditor.tsx`.
- Scheduler adoption: widened request schema/types/validation, and replacing the inline encoder in `schedulerExecution.ts`.
- The per-generation output cap and namespace fix are Scheduler work; they are deferred with the rest and are not part of an active phase.

**Superseded deliverables (historical, not to be implemented)**

- `web/src/lib/reasoning-options.ts`; composer and scheduler UI consume it.
- Model-specific choices: exact advertised values, Provider default, budget presets, and `none` only where advertised and adapter-accepted.
- Replace the Scheduler's inline block with `resolveReasoningSelection`; validate the job's selection against the job's model capability.
- Fix scheduler namespace and Gemini generation/`includeThoughts`; pass `model.maxOutputTokens` as the **per-generation cap only**.
- Widen `schedulerJobCreateSchema.thinkingLevel`, `schedulerTypes.ts`, and the store's read/write type to the validated selection schema without changing the `thinking_level TEXT` column; `schedulerValidation.ts` validates the value against the job's model capability, and `JobEditor.tsx` offers the model-specific choices from `reasoning-options.ts`.
- Preserve the Scheduler's existing scope limitations (no context budgeting, compaction, or loop-history reduction).

**Superseded exit criteria (historical, not active)**

- P2's backend encoder would be present, and every rendered choice would pass `allowedReasoningSelections`; the §13.7 matrix would pass with UI choices equal to backend `allowed` for every provider × control row.
- Exact-values mode renders only values the selected adapter can encode; a value the backend would refuse is never offered.
- `reasoning_options: []`, absent controls, and adapter-unencodable controls render one "Provider default" choice (stored `"off"`).
- `reasoning: false` renders Off only.
- Unknown renders the existing presets, labelled as presets.
- A stored `"off"` on **any** model renders as Provider default and sends nothing; no chip is labelled Off as a disable.
- A `toggle`, an advertised `none`, and a Google `budget_tokens.min <= 0` add **no** Off chip and no disable.
- `none` appears only where advertised and adapter-accepted; it is a separate choice from Provider default, not a duplicate.
- No `"on"` choice exists on any provider.
- A stored value outside the offered set produces a visible refusal, not a substitution.
- A compatible-gateway scheduler run shows the option under the compatible namespace; a toggle or budget control produces no `thinking` key and offers only Provider default.
- An invalid scheduler selection fails validation at save and at run time, never a substitute.
- Anthropic effort-only models use `effort` + `adaptive`, never a synthetic budget; `toggle`-only Anthropic models offer Provider default alone.
- The Scheduler's message/tool-loop behaviour is unchanged; only its reasoning encoding and per-generation cap change. `schedulerExecution.ts` still does not import `assembleContext` or `computeBudget`.

### P4 — Discovery name-filter removal (independent)

**Deliverables**

- Replace `isKnownChatFamily` with the modality-only exclusion.
- Update the function's doc comment.

**Exit criteria**

- `o1`, `o3`, `o4-mini`, `gemma-4-*` appear in discovery.
- Non-chat modalities remain excluded.
- The change is its own commit; it does not alter provider-reported limits.

### Out of scope — Scheduler context management (not part of any active phase)

No active phase solves the Scheduler's context problem, and this plan does not claim it does. Four quantities are involved:

| Quantity | Scheduler today | Reusable infrastructure | In a future phase? |
|---|---|---|---|
| Per-generation output cap | absent | `resolveGenerationCap` / `ModelOption.maxOutputTokens` | No active phase; deferred with Scheduler work |
| Total context-window budgeting | absent | `resolveContextLimit` + `computeBudget` (pure) | No |
| Accumulated tool-loop history | grows with every step (`stepCountIs(10)`) | none today; needs a reduction policy | No |
| Compaction | absent | `assembleContext` compaction seam | No |

`resolveContextLimit`, `computeBudget`, and `resolveGenerationCap` are pure and could be called by the Scheduler for its **initial** request without touching the chat pipeline. `assembleContext` is **not** a drop-in: it requires a `conversationId`, submitted messages, a terminal tap wired to the native `run_command` tool, a run signal, and a compaction store; the Scheduler has no terminal stream and a different, read-only tool set (`assemble-run.ts`).

A follow-up item, separately authorized, would decide whether to (a) budget the first request with the pure functions and set its `generationCap`, and (b) add mid-loop history reduction. Until then, tool-loop growth is a **recorded limitation**, not a solved problem. Attaching it to the deferred Scheduler work would bundle an unrelated context-management redesign into that future proposal.

### Cross-phase gates

1. `bun run typecheck` and `bun run build` exit 0, re-run independently.
2. `bun run lint` with `--error-on-warnings`.
3. `bun run test`, `bun run test:dom`, `bun run test:locations` with recorded suite/case counts.
4. Full diff review; no unrelated changes; no DB DDL.
5. Each guard proven to fail against its defect before being accepted.

---

## Appendix A — Evidence commands used

```
curl -sSL -o md-api.json https://models.dev/api.json
curl -sSLI https://models.dev/api.json          # ETag, content-length
bun -e '<parse and count providers/models/limits/reasoning/shapes>'
git rev-parse HEAD                              # 8e07e1d

# Upstream schema (default branch is dev)
git ls-remote --symref https://github.com/sst/models.dev HEAD
curl -sSL https://raw.githubusercontent.com/sst/models.dev/dev/packages/core/src/schema.ts
curl -sSL https://raw.githubusercontent.com/sst/models.dev/dev/packages/core/src/schema-v2.ts
curl -sSL https://raw.githubusercontent.com/sst/models.dev/dev/AGENTS.md

# Installed adapter contracts
grep -n "thinking\|adaptive\|budgetTokens" node_modules/@ai-sdk/anthropic/dist/index.d.ts
grep -n "thinkingConfig\|thinkingLevel\|thinkingBudget\|includeThoughts" node_modules/@ai-sdk/google/dist/index.d.ts
sed -n '10,40p' node_modules/@ai-sdk/openai-compatible/dist/index.d.ts
grep -n "thinkingBudget: 0" node_modules/@ai-sdk/google/dist/index.js
sed -n '3700,3790p' node_modules/@ai-sdk/anthropic/dist/index.js
```

Official provider documentation read for this revision:

- **Google** — Google Cloud "Thinking" (Gemini 2.5 `thinking_budget: 0` disables on Flash and Flash-Lite; Pro cannot disable), Firebase AI Logic "Thinking", Google AI for Developers "Thinking" (Gemini 3 reasoning cannot be turned off). Google's own documentation describes `-1` as a provider-specific dynamic-budget value; that is a provider statement, not a meaning TBAi derives from catalogue rows, and TBAi assumes no semantics for `-1`. The installed adapter's `reasoning: "none"` → `{ thinkingBudget: 0 }` mapping corroborates only the 2.5 Flash/Flash-Lite cases; it is not evidence that any other model accepts 0.
- **Anthropic** — "Extended thinking" and the model-specific thinking pages for Haiku 4.5, Haiku 5.5, Sonnet 4.6, Sonnet 5, Sonnet 5.5, Opus 4.7 and Opus 5.5 (budget ≥ 1,024 and < `max_tokens`; `disabled` accepted only on Sonnet 4.6; `between_tools` on Sonnet 5.5 disables only upfront thinking).
- **Models.dev** — `AGENTS.md` (controls are per host; a capability is a fact about the model, not an endpoint instruction) and `schema-v2.ts` (`reasoning.default` is a discriminated union absent from the v1 `api.json` payload).

Current-source references re-verified for this revision: `src/routes/chat/provider-options.ts` (`:96`), `src/routes/chat/model.ts` (`:54`), `src/routes/chat/validate-and-resolve.ts` (`:210`), `src/services/scheduler/schedulerExecution.ts` (`:199`, `:202`), `src/routes/providers.ts` (`:57-66`, `:86-137`), `src/context/observed-limits.ts`, `src/context/budget.ts` (`:188-270`), `web/src/components/composer/DirectChips.tsx` (`:27-32`, `:150-159`, `:161-177`), `web/src/runtime.ts` (`:415-418`, `:440`), `web/src/components/ChatWindow.tsx` (`:690-691`).

Read-only TBAi files: `src/context/{limits,budget,assemble,types,observed-limits}.ts`, `src/services/{modelDiscovery,capabilityDiscovery,ai}.ts`, `src/services/scheduler/{schedulerExecution,schedulerTypes,schedulerValidation,schedulerStore}.ts`, `src/routes/chat/{provider-options,validate-and-resolve,model,assemble-run,execute-direct-stream}.ts`, `src/routes/providers.ts`, `src/types/index.ts`, `src/lib/validation.ts`, `src/tools/index.ts`, `web/src/components/composer/DirectChips.tsx`, `web/src/features/providers/ProviderDialog.tsx`, `web/src/config/modelContext.ts`, `web/src/types/index.ts`, `web/src/features/scheduler/components/JobEditor.tsx`.

Cline files (read-only, pinned revision): `sdk/packages/llms/src/catalog/catalog-live.ts`, `sdk/packages/llms/src/catalog/types.ts`, `sdk/packages/shared/src/llms/model-info.ts`, `sdk/packages/shared/src/llms/reasoning-options.ts`, `sdk/packages/llms/src/providers/model-facts.ts`, `sdk/packages/llms/src/providers/routing/reasoning-options.ts`, `sdk/packages/llms/src/providers/routing/provider-options.ts`, `sdk/packages/llms/src/providers/routing/provider-option-rules.ts`, `sdk/packages/llms/src/providers/provider-keys.ts`, `sdk/packages/core/src/services/llms/provider-defaults.ts`.

Installed SDKs verified: `@ai-sdk/anthropic` 4.0.83, `@ai-sdk/google`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible` in `node_modules`.

## Appendix B — Decisions resolved and remaining

> **Status (Revision 2.4):** The reasoning entries below are retained as the audit record of the superseded proposal. They do **not** authorize implementation. The live native path is described in §15, "Current implementation — native AI SDK v7". Model-specific reasoning metadata and dynamic selections are deferred and require separate approval.

**Resolved by Revision 2**

1. **Anthropic effort encoding (historical).** Installed `@ai-sdk/anthropic` 4.0.83 accepts top-level `effort` and `thinking: { type: "adaptive" }`. The superseded proposal would have encoded effort-only catalogue rows that way; the native path now delegates this mapping to AI SDK v7. (Revision 1 left this open.)
2. **Architecture size.** One new file (`modelCatalog.ts`) replaces Revision 1's nine. The moved codec and the shared UI helper belonged to the superseded reasoning proposal and are not part of any active phase (§15).
3. **Freshness.** `discoveredAt` plus a whole-snapshot TTL; no per-model catalogue timestamps, no ETag, no disk cache.
4. **Custom providers.** No enrichment, no new configuration field.
5. **Advisory vs terminal for `model_catalog`.** Advisory, for the false-rejection reason in §3.4.

**Resolved by Revision 2.1**

1. **Reasoning vocabulary.** Eight states, one normative table (§12.1); "send nothing" is provider default, never described as disable (C1). **Revised in 2.2:** `off` is that provider default, `none` is the sole explicit no-reasoning selection, explicit disable is deferred, and `"on"` is removed (R1/R2/R4).
2. **Compatible-gateway wire shape.** Only `reasoningEffort` exists on the installed schema; toggle/budget controls are not offered and no `thinking` object is sent (C2).
3. **Budget bounds.** `min = 0` and `min = -1` are valid upstream and are stored; only schema-invalid controls are skipped (C3). **Revised in 2.2:** `-1` is never read as `0` or as a disable, and no preset is ever 0 (R3).
4. **Scheduler scope.** `maxOutputTokens` is the per-generation cap; context budgeting, compaction, and loop growth remain out of scope (C4).
5. **Observed precedence.** `observed` ranks above `model_catalog` and below `provider_reported`, based on key scope and the overflow-error source (C5). **Revised in 2.2:** the figure has no TTL and can go stale; only an endpoint/`apiProtocol` change, restart, or LRU eviction clears it (R6).
6. **UI/encoder agreement.** One validity derivation and a cross-tree equality matrix (C6).
7. **`"default"`.** A stored selection that emits no field; never transmitted literally (C7). **Revised in 2.2:** it is a marker, never a stored selection; an advertised `default` resolves to the `"off"` (Provider default) choice and adds no chip (R2).

**Resolved by Revision 2.2**

1. **`"off"` semantics.** `"off"` and an absent selection both mean Provider default and send nothing. That identity is preserved in the native path (`execute-direct-stream.ts:407` omits the `reasoning` option); no stored value, column, or migration changes (R1).
2. **`none` versus `off`.** One visible explicit no-reasoning choice: the advertised `none` effort value, offered only on OpenAI native/compatible where the adapter encodes it. `off` is Provider default, not a disable. Four categories stay distinct: Provider default, advertised `none`, explicit disable, normal effort values. Explicit disable is not offered at all (R2).
3. **Google disable.** No Off control and no inference from `budget_tokens.min`. `-1` is a valid upstream sentinel whose meaning is not assumed from the observed rows and is never treated as 0. Per-model zero-budget disabling is recorded but not offered (R3).
4. **Anthropic disable.** No Off control and no inference from `toggle`. `between_tools` disables only upfront thinking and is never labelled a full disable. No `"on"` selection exists (R4).
5. **Default path and Scheduler.** Chat resolves `request > conversation > provider.thinking > "off"`; the scheduler reads only `job.thinkingLevel ?? "off"` with no provider fallback; both reach the encoder with `"off"`/absent meaning Provider default; first enrichment writes no selection (R5).
6. **Observed-limit staleness.** The map has no TTL, so an observation can become stale; endpoint/`apiProtocol` edits change the key, credential/name/models edits do not; `observed` is terminal in `decideBudget`, so a stale-low figure can cause a false pre-flight rejection. Recorded as pre-existing and out of scope (R6).

**Remaining — clearly marked [Unverified]**

1. **Anthropic `effort` + `adaptive` acceptance.** The SDK type accepts the pair and Cline selects adaptive for effort-bearing models, but no live Anthropic call is part of this investigation. Fallback if a real call rejects it: send the `effort` field alone (never a synthetic budget), and Provider default remains `{}`.
2. **Google `thinkingBudget: 0` per model.** Documented for Gemini 2.5 Flash/Flash-Lite and used by the installed adapter for `reasoning: "none"`. Revision 2.2 does not rely on this: no Google Off control exists and no preset emits 0, so an incorrect inference cannot be sent. Whether any other model accepts 0 is left unverified and unused.
3. **`budget_tokens.min = -1`.** Two models publish it; the upstream schema permits it. Its meaning is not established by the observed rows and TBAi assumes none. It preserves the value in metadata, never treats it as `0`, never uses it as a positive lower bound (`max(min ?? 1, 1)`), and never transmits it.
4. **Compatible-gateway `reasoningEffort` acceptance.** The SDK forwards the string; individual gateways may reject values outside their own ladder. TBAi sends only advertised values and does not translate or retry.
5. **Anthropic per-model disable support.** Official docs accept `disabled` only on Sonnet 4.6 and reject it on Haiku 4.5/5.5, Sonnet 5/5.5, and Opus 4.7/5.5; the installed adapter rewrites or drops it. Because that set must be re-verified per model and could change, explicit disabling is deferred (§12.4) rather than inferred.
6. **Catalogue URL configurability.** [Recommendation] fixed constant, matching Cline; no env var until a real offline/mirror need exists.
7. **Output override UI.** [Recommendation] not in this plan; revisit only if the catalogue's output figure proves insufficient in practice.