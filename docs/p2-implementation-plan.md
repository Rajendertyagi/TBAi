# Phase P2 Implementation Plan: Shared Reasoning Codec & Metadata Discovery (SUPERSEDED)

> [!WARNING]
> **SUPERSEDED & SIMPLIFIED:** This proposal has been cancelled in favor of direct AI SDK v7 native integration with minimum custom code.
> - **No Thinking Budget / Token Count Controls:** Numeric token budget controls and inputs are completely dropped. The UI and API retain strictly the 4 discrete levels: Default (stored as `"off"`), Low, Medium, High.
> - **Matches Native AI SDK v7:** Native `reasoning` effort levels (`"low"`, `"medium"`, `"high"`) are handled natively or through minimal providerOptions in `src/routes/chat/provider-options.ts`.
> - **No Code Changes Required for Simplification:** Direct Chat and the composer already use this 4-level model. No numeric inputs or sliders exist.

---

## 1. Scope & Non-Goals

### In Scope for Phase P2
1. **Canonical Reasoning Metadata Types:**
   - Upstream-compatible `ReasoningControl` tagged union (`toggle`, `effort`, `budget_tokens`).
   - Additive `ReasoningCapability` with provenance (`controls?: ReasoningControl[]`, `source?: "provider_reported" | "model_catalog"`).
   - Mirrored across `src/types/index.ts` and `web/src/types/index.ts` with validation in `src/lib/validation.ts`.
2. **Models.dev Reasoning Control Ingestion & Normalization:**
   - Ingest `reasoning` and `reasoning_options` in `src/services/modelCatalog.ts`.
   - Distinct 5-state normalization (unsupported, undialable, dialable, unencodable by adapter, unknown).
   - Resilient parsing: malformed individual controls are skipped without invalidating the catalog snapshot.
   - Enforce exact `(providerKey, modelId)` identity for recognized providers (`openai`, `anthropic`, `google`).
3. **Shared Backend Reasoning Codec (`src/services/provider-options.ts`):**
   - Relocate `src/routes/chat/provider-options.ts` to `src/services/provider-options.ts`.
   - Implement `allowedReasoningSelections()` and `resolveReasoningSelection()`.
   - Single authority for AI SDK `providerOptions` encoding, namespace resolution, and refusal generation.
4. **Direct Chat Integration:**
   - Update `src/routes/chat/validate-and-resolve.ts` and `src/routes/chat/model.ts` to call the shared service.
   - Return typed 400 Bad Request with `allowed` selections when an invalid or out-of-bounds selection is requested.
   - Widen chat request validation in `src/lib/validation.ts` to accept validated strings while preserving legacy values.
5. **Backend Verification & Guards:**
   - Comprehensive unit and integration test suite asserting encoding parity, bound enforcement, and error responses.

### Explicit Non-Goals (Deferred to P3 or Future Decisions)
- **NO Scheduler Changes in P2:** Scheduler keeps its existing 4-level schema (`off/low/medium/high`), validation, types, and inline execution encoder in `src/services/scheduler/schedulerExecution.ts`. Scheduler adoption of the shared encoder is strictly **Phase P3**.
- **NO UI Changes in P2:** No modifications to `DirectChips.tsx`, `JobEditor.tsx`, `ProviderDialog.tsx`, or `ChatWindow.tsx`. Dynamic reasoning UI controls belong strictly to **Phase P3**.
- **NO Synthetic "On" or Disabling:** No `"on"` or `{ kind: "enabled" }` states. Explicit disabling (e.g. `thinkingBudget: 0`) is deferred until verified per-model allowlists exist. `"off"` remains Provider default (send no options).
- **NO Models.dev Output Limit Ingestion:** Models.dev `limit.output` ingestion is excluded from P2 (remains an independent future decision). However, existing provider-reported output caps are read by the Anthropic budget clamper.
- **NO Database Migrations:** SQLite columns (`provider_configs.thinking`, `scheduler_jobs.thinking_level`) are already TEXT and remain unchanged.

---

## 2. Current Architecture & Affected Call Sites

### Current Call Sites of `src/routes/chat/provider-options.ts`
1. `src/routes/chat/validate-and-resolve.ts:10` imports `buildReasoningProviderOptions`.
2. `scripts/verify-reasoning.ts:16` imports `buildReasoningProviderOptions`.
3. `tests/helpers/chat-route-parity.baseline.json` records `src/routes/chat/provider-options.ts` (monitored by route parity guard).

### Current Call Sites of Models.dev Enrichment
- `src/services/modelDiscovery.ts:311` calls `enrichModels(discovered, { type, endpoint })`.
- Currently enriches context limits only. P2 extends `enrichModels` to also enrich `capabilities.reasoning` with `model_catalog` provenance without overwriting existing provider-reported capabilities.

---

## 3. Exact File-Change List for P2

| Action | Path | Owning Area | Purpose |
|---|---|---|---|
| **Move & Extend** | `src/routes/chat/provider-options.ts` → `src/services/provider-options.ts` | Backend Services | Canonical reasoning selection validator and AI SDK provider options encoder. |
| **Delete** | `src/routes/chat/provider-options.ts` | Backend Routes | Removed to prevent duplicate implementations and maintain single authority. |
| **Modify** | `src/types/index.ts` | Shared Types | Add `ReasoningControl`, update `ReasoningCapability` with `controls` and `source`. |
| **Modify** | `web/src/types/index.ts` | Frontend Types | Mirror `ReasoningControl` and `ReasoningCapability` updates. |
| **Modify** | `src/lib/validation.ts` | Shared Validation | Add `reasoningControlSchema`, update `reasoningCapabilitySchema`, widen chat `reasoningLevel`. |
| **Modify** | `src/services/modelCatalog.ts` | Backend Services | Normalize Models.dev `reasoning` / `reasoning_options` into `ReasoningControl[]`; enrich `capabilities.reasoning`. |
| **Modify** | `src/routes/chat/validate-and-resolve.ts` | Backend Routes | Import `resolveReasoningSelection` from `src/services/provider-options.ts`; enforce typed 400 refusal. |
| **Modify** | `src/routes/chat/model.ts` | Backend Routes | Document widened reasoning selection string in `ResolvedChatModel`. |
| **Modify** | `src/routes/chat/types.ts` | Backend Routes | Update import path for reasoning types if referenced. |
| **Modify** | `scripts/verify-reasoning.ts` | Tooling / Scripts | Update import path to `src/services/provider-options.ts`. |
| **Modify** | `tests/helpers/chat-route-parity.baseline.json` | Test Tooling | Update recorded route paths to reflect module relocation out of routes. |
| **Create** | `tests/unit/services/provider-options.test.ts` | Unit Tests | Tests for selection resolution, provider encoding rules, bound checks, and refusal generation. |
| **Modify** | `tests/unit/services/modelCatalog.test.ts` | Unit Tests | Tests for reasoning control ingestion, resilient malformed-control skipping, and enrichment rules. |

---

## 4. Data Model & Normalization Contract

### 4.1 Canonical TypeScript Definitions (`src/types/index.ts` & `web/src/types/index.ts`)
```ts
export type ReasoningControl =
  | { readonly type: "toggle" }
  | { readonly type: "effort"; readonly values: readonly string[] }
  | {
      readonly type: "budget_tokens";
      readonly min?: number;
      readonly max?: number;
    };

export interface ReasoningCapability {
  support: CapabilitySupport;
  levels?: string[];
  controls?: ReasoningControl[];
  source?: "provider_reported" | "model_catalog";
}
```

### 4.2 Models.dev Reasoning Ingestion (`src/services/modelCatalog.ts`)
Upstream Models.dev publishes two fields per model:
- `reasoning: boolean`
- `reasoning_options?: Array<{ type: string; values?: string[]; min?: number; max?: number }>`

#### Normalization Invariants:
1. **Explicitly Unsupported (`reasoning === false`):**
   - `support: "unsupported"`, `controls: []`.
   - Offered selections: `["off"]`.
2. **Supported, Undialable (`reasoning === true` with missing or empty `reasoning_options`):**
   - `support: "supported"`, `controls: []`.
   - Offered selections: `["off"]` (Provider default).
3. **Supported with Controls (`reasoning === true` with valid `reasoning_options`):**
   - Parse each raw control:
     - `type === "toggle"`: `{ type: "toggle" }`.
     - `type === "effort"`: if `values` is an array of non-empty strings, normalize by trimming and deduplicating. Emit `{ type: "effort", values }`. Skip invalid control.
     - `type === "budget_tokens"`: validate `min` and `max`. Upstream admits `min = -1` or `min >= 0`. If valid, emit `{ type: "budget_tokens", min, max }`. Skip invalid control.
   - **Resilience Guard:** If an individual control is structurally malformed (e.g. `values: "bad"`), skip that specific control. Do **not** fail model normalization or invalidate the catalog snapshot.
   - If at least one valid control survives, set `controls: validControls`, `support: "supported"`.
4. **Adapter Encodability View (Computed at Resolution Time):**
   - A model may publish controls that the installed adapter cannot encode (e.g., `toggle` on Google or native OpenAI; `budget_tokens` on compatible gateways).
   - The encoder computes adapter-supported selections dynamically; unencodable controls collapse to `["off"]` (Provider default).
5. **Enrichment Non-Overwriting Guarantee:**
   - In `enrichModels()`, if `model.capabilities?.reasoning` already has `support: "supported"` or `support: "unsupported"` from a `provider_reported` source (e.g., Ollama `/api/show`), the catalogue **never** overwrites it.

---

## 5. Shared Service API & Responsibilities (`src/services/provider-options.ts`)

```ts
export type ReasoningProviderOptions = Record<string, JsonObject>;

export interface ReasoningDecisionInput {
  provider: Pick<ProviderConfig, "type" | "apiProtocol">;
  model: string;
  selection: string | undefined;
  capability?: ReasoningCapability;
  outputCap?: number;
}

export type ReasoningDecision =
  | { ok: true; providerOptions: ReasoningProviderOptions }
  | {
      ok: false;
      reason: "unsupported_value" | "unsupported_capability";
      allowed: readonly string[];
    };

/**
 * Resolves requested reasoning selection into verified AI SDK providerOptions
 * or returns a typed refusal with valid choices.
 */
export function resolveReasoningSelection(input: ReasoningDecisionInput): ReasoningDecision;

/**
 * Computes valid allowed selections for a model capability under a specific provider adapter.
 */
export function allowedReasoningSelections(
  capability: ReasoningCapability | undefined,
  provider: Pick<ProviderConfig, "type" | "apiProtocol">,
): readonly string[];
```

---

## 6. Selection Validation & Encoding Rules

### 6.1 Selection Semantics Table

| Selection | Meaning | Wire Payload | Notes |
|---|---|---|---|
| `undefined` / omitted | Provider default | `{}` | No reasoning parameter sent. |
| `"off"` | Provider default | `{}` | Always valid on every provider and model. Never sends a disable. |
| `"default"` | Catalog marker | `{}` | Defensively accepted as Provider default; never stored or sent literally. |
| `"none"` | Explicit no-reasoning effort | `reasoningEffort: "none"` | Valid **only** when advertised on OpenAI native or compatible gateways. |
| Published effort value | Exact depth | Adapter-specific effort | Intersected with adapter's supported values (e.g. Anthropic `low/medium/high/xhigh/max`). |
| Budget preset (`low`/`medium`/`high`) | Numeric token budget | Adapter-specific budget | Valid when capability has budget control and no effort control. Clamped to `[max(min ?? 1, 1), max]`. |

### 6.2 Provider-Specific Encoding Matrix

1. **Effort Dominates Budget:** If capability contains an `effort` control, budget presets are **not** offered, avoiding ambiguous selections.
2. **OpenAI Native (`type: "openai"`, default endpoint):**
   - Effort control: `{ openai: { reasoningEffort: value } }` for `value` in `["none", "minimal", "low", "medium", "high", "xhigh", "max"]`.
   - Toggle / Budget controls: Unencodable by adapter. Collapses to Provider default (`"off"`).
3. **OpenAI-Compatible Gateways (`type: "custom"` or non-default endpoints):**
   - Effort control: `{ [providerOptionsNamespace(provider)]: { reasoningEffort: value } }`.
   - Toggle / Budget controls: Unencodable by adapter (`@ai-sdk/openai-compatible` strips unknown keys). Collapses to Provider default. **Never emit a `thinking` object.**
4. **Google Gemini (`type: "google"`):**
   - Effort control: `{ google: { thinkingConfig: { thinkingLevel: value, includeThoughts: true } } }` for `value` in `["minimal", "low", "medium", "high"]`.
   - Budget control (no effort control): `{ google: { thinkingConfig: { thinkingBudget: clamped, includeThoughts: true } } }`. Clamped to `[max(min ?? 1, 1), max]`. `min = -1` contributes no lower bound and is never transmitted.
   - Toggle control without budget: Unencodable. Collapses to Provider default.
   - Unknown capability: Preserves existing generation fallback (`thinkingLevel` for Gemini ≥3, `thinkingBudget` otherwise).
5. **Anthropic (`type: "anthropic"`):**
   - Effort control: `{ anthropic: { effort: value, thinking: { type: "adaptive" } } }` for `value` in `["low", "medium", "high", "xhigh", "max"]`.
   - Budget control (no effort control): `{ anthropic: { thinking: { type: "enabled", budgetTokens: clamped } } }`. Clamped to `[max(min ?? 1024, 1024), max]`. If `outputCap` is known, clamped to `outputCap - 1`.
   - Toggle control: Does not imply disable support; collapses to Provider default.
6. **No Silent Clamping:**
   - If client requests an invalid selection (e.g. `"ultra-high"` or an unsupported level), return `{ ok: false, reason: "unsupported_value", allowed }`. Never floor to `"medium"` or `4096`.

---

## 7. Direct Chat Integration Sequence

1. **HTTP Request Boundary (`src/routes/chat/validate-and-resolve.ts`):**
   - Extract `reasoningLevel` from validated request payload.
   - Lookup resolved model capabilities.
   - Call `resolveReasoningSelection({ provider, model: modelId, selection: reasoningLevel, capability: model.capabilities?.reasoning })`.
   - If `!decision.ok`:
     - Return immediate HTTP 400 Bad Request with structured JSON:
       ```json
       {
         "error": "Invalid reasoning selection",
         "reason": decision.reason,
         "allowed": decision.allowed
       }
       ```
   - If `decision.ok`:
     - Pass `decision.providerOptions` into chat execution context (`assemble-run.ts`).
2. **Backward Compatibility:**
   - Omitted or `"off"` requests succeed on all models and transmit `{}`.
   - Pre-existing conversations with stored `"off"` continue working transparently.

---

## 8. Error Handling & Backward Compatibility

1. **Stored Config & DB Rows:**
   - `provider_configs.thinking` and `conversations.custom.reasoningLevel` accept any validated string.
   - Legacy stored values (`"off"`, `"low"`, `"medium"`, `"high"`) remain valid where they match allowed selections.
   - If a stored conversation references a selection no longer supported by an updated model, the route fails visibly with 400 and lists `allowed` rather than silently mutating user intent.
2. **Catalogue Unavailability:**
   - If Models.dev is unreachable, discovery proceeds with provider-reported capabilities (or `unknown`).
   - Chat execution never calls Models.dev and is immune to external catalog downtime.

---

## 9. Comprehensive Test Matrix for Phase P2

### 9.1 Unit Tests: `tests/unit/services/provider-options.test.ts`
1. **Provider Default (`"off"` and `undefined`):**
   - Encodes `{}` across OpenAI native, compatible, Google, and Anthropic.
   - Never sends `reasoningEffort: "none"`, `thinkingBudget: 0`, or `thinking: { type: "disabled" }`.
2. **OpenAI Native & Compatible:**
   - Encodes `reasoningEffort` correctly under `openai` or dynamic compatible namespace.
   - Rejects toggle/budget on compatible gateway with `unsupported_capability`.
   - Never emits a `thinking` key on compatible gateways.
3. **Google Encoding:**
   - Encodes `thinkingLevel` when effort control is present.
   - Encodes `thinkingBudget` when budget control is present.
   - Verifies sentinel `min = -1` is never transmitted.
4. **Anthropic Encoding:**
   - Encodes `effort` + `{ thinking: { type: "adaptive" } }` for effort control.
   - Encodes `{ thinking: { type: "enabled", budgetTokens } }` clamped to `[1024, max]` and `outputCap - 1`.
5. **Selection Validation & Refusal:**
   - Refuses unadvertised effort value with `allowed` list.
   - Refuses out-of-bounds budget token request.
   - Refuses `"on"`, `"disabled"`, or `{ kind: "enabled" }` requests.
   - Defensively handles `"default"` by encoding `{}`.
6. **No Silent Fallbacks:**
   - Confirms that unknown selections never produce `medium` or `4096`.

### 9.2 Unit Tests: `tests/unit/services/modelCatalog.test.ts`
1. **Reasoning Ingestion:**
   - Normalizes `reasoning: false` to `support: "unsupported"`.
   - Normalizes `reasoning: true` with empty options to `support: "supported"`, `controls: []`.
   - Normalizes `effort` and `budget_tokens` correctly.
2. **Resilient Control Skipping:**
   - An individual malformed control (e.g. invalid bounds or wrong types) is skipped while valid sibling controls are retained.
   - A model with malformed controls does not discard the catalog or trigger fallback to null.
3. **Enrichment Invariants:**
   - Enriches `capabilities.reasoning` with `source: "model_catalog"`.
   - Never overwrites existing `provider_reported` reasoning capabilities.

### 9.3 Integration Tests: Direct Chat Route
1. **Valid Reasoning Request:** Returns 200 stream with expected provider options logged.
2. **Invalid Reasoning Request:** Returns 400 Bad Request before stream initialization.
3. **Chat Execution Isolation:** Statically asserts that chat request execution does not import `modelCatalog.ts`.

---

## 10. Verification Commands

```powershell
# 1. Typecheck all workspace projects
bun run typecheck

# 2. Test locations check
bun run test:locations

# 3. Orphan module boundary check
bun test tests/unit/tooling/no-orphan-modules.test.ts

# 4. Scoped Biome linter on touched P2 files (with zero warnings)
bun x @biomejs/biome check --error-on-warnings --max-diagnostics=none `
  src/services/provider-options.ts `
  src/services/modelCatalog.ts `
  src/routes/chat/validate-and-resolve.ts `
  src/types/index.ts `
  web/src/types/index.ts `
  src/lib/validation.ts `
  tests/unit/services/provider-options.test.ts `
  tests/unit/services/modelCatalog.test.ts

# 5. Targeted unit tests
bun test tests/unit/services/provider-options.test.ts
bun test tests/unit/services/modelCatalog.test.ts
bun test tests/unit/services/discovery-catalog-integration.test.ts
bun test tests/unit/context/limits-precedence.test.ts

# 6. Canonical test harness
bun run test
bun run test:dom
```

---

## 11. Ordered Implementation Steps (When Authorized)

1. **Step 1: Types & Validation:**
   - Update `src/types/index.ts` and `web/src/types/index.ts` with `ReasoningControl` and updated `ReasoningCapability`.
   - Update `src/lib/validation.ts` schemas.
2. **Step 2: Service Extraction & Codec:**
   - Move `src/routes/chat/provider-options.ts` to `src/services/provider-options.ts`.
   - Implement `allowedReasoningSelections` and `resolveReasoningSelection`.
   - Update imports in `scripts/verify-reasoning.ts` and `tests/helpers/chat-route-parity.baseline.json`.
3. **Step 3: Models.dev Reasoning Normalization:**
   - Update `src/services/modelCatalog.ts` to ingest `reasoning` and `reasoning_options`.
   - Extend `enrichModels()` to enrich `capabilities.reasoning`.
4. **Step 4: Direct Chat Route Integration:**
   - Update `src/routes/chat/validate-and-resolve.ts` to call `resolveReasoningSelection` and return 400 on refusal.
5. **Step 5: Test Execution & Verification:**
   - Execute all verification gates and confirm zero errors.

---

## 12. Rollback Strategy
- Phase P2 makes no database schema changes.
- Rollback can be performed via atomic `git revert` of the P2 implementation commit, leaving existing provider configs and chat functional.

---

## 13. Acceptance Criteria for P2
- `ReasoningControl[]` matches canonical types (`values`, not `allowedValues`; no synthetic `on`).
- `src/services/provider-options.ts` is the single authority for Direct Chat reasoning options.
- Models.dev reasoning controls normalize with resilient control skipping.
- Scheduler implementation remains 100% untouched in P2.
- No UI components are modified in P2.
- All verification commands exit 0.
