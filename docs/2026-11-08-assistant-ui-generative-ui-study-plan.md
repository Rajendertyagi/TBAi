# Assistant-UI Generative UI — Study & Plan (Direct Chat + OpenCode Chat)

**Date:** 2026-11-08  
**Scope:** `D:\Temp\ai-chat-app-typography-v7` on `feat/typography-v7` (study/plan only; no implementation).  
**Sources studied:** assistant-ui Generative UI API reference pages (`/docs/api-reference/generative-ui/*`), installed packages (`@assistant-ui/react@0.15.32`, `@assistant-ui/ai-sdk@^0.0.16`, `ai@7.0.145`), current Direct/OpenCode runtime and rendering code, `AGENTS.md`, `docs/architectural-principles.md`, `docs/architecture.md`.  
**Constraint:** assistant-ui train is frozen; Direct and OpenCode runtimes must not merge; OpenCode internals must not leak into shared UI; questions are forms (not approval cards); library-first UI; no framework multiplication.

---

## 1. Executive summary

Generative UI is feasible in TBAi **only in a constrained, installed-contract form today**. The installed `@assistant-ui/react@0.15.32` already provides the **spec + renderer** primitives needed to render a serializable generative UI tree safely behind an allowlist:

- `GenerativeUIRender` / `GenerativeUIRenderError`
- `GenerativeUISpec` / `GenerativeUINode` / `GenerativeUIMessagePart` types
- `MessagePrimitive.GenerativeUI`
- `MessagePrimitive.Parts` support for `generative-ui` parts via `components.generativeUI = { components, Fallback }` (verified in installed tests)

The newer docs APIs are **not present** in the installed build: `JSONGenerativeUI`, `defineGenerativeComponents`, `defaultGenerativeUILibrary`, `buildPresentParameters`, `renderGenerativeUI`, `toSpecCatalog`, action registry helpers, and `present`/`prompt_user` tool builders. There is also **no `@assistant-ui/vite` `"use generative"` compiler** configured.

**Implication:** TBAi cannot adopt the full docs-described “tool-builder + compiled library + action registry” pipeline without an explicit assistant-ui compatibility review/upgrade (frozen). The plan therefore has two tracks:

1. **Track A (now, frozen-train compatible):** render-only generative UI using installed spec/renderer contracts, with TBAi-owned component allowlist, validation, and engine-specific data projection/emission. No `present`/`prompt_user` tool builders; no compiler; no action registry from upstream.
2. **Track B (future, requires approval):** evaluate upgrading assistant-ui/ai-sdk stack to gain `JSONGenerativeUI`/actions/prompt-user tooling, only after compatibility review and proof that Direct/OpenCode boundaries and existing tool/approval/question contracts remain intact.

**Recommendation:** implement Track A as a narrow, read-only/display-first capability first (cards, tables, charts, badges, progress-like summaries, static layouts) with strict allowlist and no arbitrary code execution. Defer interactive actions and `prompt_user` semantics until Track B or until TBAi designs an explicit, engine-safe interaction contract that does not collide with permissions/questions.

---

## 2. Study: docs vs installed capabilities

### 2.1 Docs describe (target API surface)

From the fetched docs:

| Area | Docs API | Purpose |
|---|---|---|
| Tool builders | `JSONGenerativeUI`, `present`, `promptUser` | Create frontend/human-in-the-loop tools from a component library |
| Component library | `defineGenerativeComponents`, `defaultGenerativeUILibrary`, `GenerativeUILibrary` | Define schemas + renderers; default vocabulary |
| Actions | `ActionDispatchContext`, `ActionHandler`, action registry | Handle `$action` from interactive components; `prompt_user` can resume with result |
| Spec | `GenerativeUISpec`, `GenerativeUINode`, `GenerativeUIMessagePart` | Serializable UI tree carried in message part |
| Rendering | `buildPresentParameters`, `renderGenerativeUI`, `toSpecCatalog`, `MessagePrimitive.GenerativeUI` | Schema generation, rendering, catalog/serialization |

Key semantics from docs:
- `present` renders model-produced `{ _type, ...props }` tree and resolves immediately.
- `prompt_user` pauses for human input; rendered UI supplies result; actions may resume depending on runtime.
- Unknown component names must not render; allowlist is required.
- Stream-friendly progressive rendering of partial specs.
- Actions are a separate contract from rendering.

### 2.2 Installed in `@assistant-ui/react@0.15.32` (verified)

Verified from installed dist/tests:

| Capability | Status | Evidence |
|---|---|---|
| `GenerativeUIRender` | Present | `web/node_modules/@assistant-ui/react/src/tests/generative-ui.test.tsx`, dist exports |
| `GenerativeUIRenderError` | Present | same |
| `GenerativeUISpec` / node/part types | Present (core/react types) | dist/index.d.ts references `GenerativeUIMessagePart`, `GenerativeUINode`, `GenerativeUISpec` from `@assistant-ui/core` |
| `MessagePrimitive.GenerativeUI` | Present | primitive test renders spec from part scope |
| `MessagePrimitive.Parts` generative UI handling | Present | primitive test: `components={{ generativeUI: { components, Fallback } }}` renders `type:"generative-ui"` parts; warns if allowlist missing |
| `JSONGenerativeUI` | **Not found** | grep over installed exports/dist |
| `defineGenerativeComponents` | **Not found** | same |
| `defaultGenerativeUILibrary` | **Not found** | same |
| `buildPresentParameters` / `renderGenerativeUI` / `toSpecCatalog` | **Not found** | same |
| Action registry / `present` / `prompt_user` builders | **Not found** | same |
| `@assistant-ui/vite` `"use generative"` compiler | **Not configured** | no project config found |

### 2.3 Practical conclusion

TBAi can **render** generative UI specs today if it:
1. produces/receives a valid `GenerativeUISpec` in a `generative-ui` message part (or renders via `GenerativeUIRender` in a controlled wrapper), and
2. supplies a strict component allowlist.

TBAi **cannot** rely on installed upstream tool-builder/action infrastructure. Any “model emits UI” pipeline must be TBAI-owned (or deferred to Track B), and any interactivity must be designed carefully to avoid colliding with existing approval/question contracts.

---

## 3. Current architecture mapping (relevant to Generative UI)

### 3.1 Direct Chat

- **Runtime/transport:** `web/src/runtime.ts` uses `@assistant-ui/ai-sdk` `useChatRuntime` + `AssistantChatTransport` against `/api/chat`.
- **Backend stream:** `src/routes/chat/*` validates, assembles context, runs AI SDK `streamText`, converts to UI message stream (`toUIMessageStream`/`createUIMessageStream`/`createUIMessageStreamResponse`), supports resumable streams, progress data parts (`data-tbai-progress`), tool approval, terminal output, overflow recovery, settlement.
- **Tools:** native AI SDK `tool()` definitions in `src/tools/index.ts`; MCP tools merged server-side; request-scoped `toolsContext`.
- **UI rendering:** `web/src/components/ChatWindow.tsx` renders assistant messages via `MessagePrimitive.GroupedParts`/`MessagePrimitive.Parts`, with custom handling for text/reasoning/tool groups/data parts and `part.toolUI ?? <ToolFallback>`.
- **Tool UI registration:** `web/src/tools/toolkit.ts` (`nativeToolkit`/`openCodeToolkit`/`appToolkit`) + `AuiConfig`/`Tools` in runtime providers.

### 3.2 OpenCode Chat

- **Boundary:** `web/src/features/opencode/*` owns native V2 client, controller, event reduction, history, permissions, forms, cancellation. `OpenCodeView.tsx` provides `AssistantRuntimeProvider` + `AuiConfig` and composes `ChatWindow mode="agent"`.
- **Runtime:** `useOpenCodeRuntime` → `createV2ThreadController` + `useV2AssistantRuntime` (`useExternalStoreRuntime`).
- **Projection:** `v2MessageProjection.ts` converts V2 state into `ThreadMessageLike`/branchable items; tool parts become `tool-call` parts with args/result/approval/timing/artifacts; raw OpenCode parts preserved in `metadata.custom.opencode.parts`.
- **Tool UI:** engine-owned renderers in `web/src/tools/opencode/ui.tsx`, registered via `openCodeToolkit`/`appToolkit`.
- **Questions/forms:** native V2 forms are separate from tool approval; `question` tool renderer is read-only historical; interactive forms owned by OpenCode feature (`OpenCodeQuestions`/`V2FormCard`). This separation must be preserved.

### 3.3 Shared presentation boundary

`ChatWindow` and `Composer` are shared presentation surfaces; engine-specific behavior enters through runtime/context boundaries (`mode`). Generative UI rendering, if shared, must be **presentation-only** and must not introduce a shared execution/runtime abstraction.

---

## 4. Integration design — Track A (frozen-train compatible)

### 4.1 Design principles

1. **Render-only first:** display generative UI specs; no arbitrary JS execution; no dynamic component loading; no `eval`/function-from-string.
2. **Allowlist only:** every render path passes an explicit component map. Unknown components render fallback/error UI, never arbitrary components.
3. **Engine-specific emission/projection, shared rendering contract:** Direct and OpenCode may produce generative UI through different mechanisms, but both should normalize to the same TBAi-owned spec/component contract before rendering.
4. **No runtime merge:** Direct uses AI SDK/UI stream/runtime; OpenCode uses V2 projection/runtime. Generative UI must not become a reason to unify them.
5. **No collision with approvals/questions:** generative UI actions are **not** tool approvals and **not** OpenCode/Direct question forms. Interactive generative UI is deferred unless a separate, explicit contract is designed.
6. **Library-first, TBAi-thin:** use installed `GenerativeUIRender`/`MessagePrimitive.GenerativeUI`/parts support; add only TBAi normalization, allowlist, and safe wrappers.

### 4.2 Shared rendering layer (presentation)

Create a small TBAi-owned generative UI presentation module (proposed location: `web/src/components/assistant-ui/elements/generative-ui.tsx` or `web/src/features/chat/components/generative-ui/` only if it becomes feature-sized; keep shared if used by both engines through `ChatWindow`).

Responsibilities:
- Export a **single allowlisted component registry** for TBAi generative UI (or a function that returns it).
- Provide a `GenerativeUIFallback` for unknown/malformed nodes (non-throwing in production UI path where appropriate; log safely).
- Provide a wrapper around `MessagePrimitive.GenerativeUI` / `GenerativeUIRender` that:
  - validates/coerces the spec shape defensively (stream-friendly, partial-safe),
  - catches `GenerativeUIRenderError` and renders a bounded error card,
  - applies TBAi styling constraints (no inline static styles except runtime-measured cases; use theme tokens/Tailwind).
- Integrate with `MessagePrimitive.Parts`/`GroupedParts` in `ChatWindow` by adding `components.generativeUI` (and/or explicit part handling) so `type:"generative-ui"` parts render consistently.

**Important:** `ChatWindow` is engine-neutral. The allowlist and renderer must not import OpenCode client/runtime code. Any engine-specific data adaptation happens before the part reaches shared rendering.

### 4.3 Component allowlist (v1)

Start with a **closed, low-risk vocabulary**. Do not expose arbitrary HTML/component names from model output.

Suggested v1 allowlist categories (all TBAi-owned wrappers over existing UI primitives where possible):

| Component | Purpose | Risk | Notes |
|---|---|---|---|
| `Card` | container/title/sections | low | semantic wrapper |
| `Stack` / `Grid` | layout | low | constrained props |
| `Text` / `Markdown` | text blocks | medium | Markdown must use existing safe `MarkdownText` path; no raw HTML |
| `Badge` / `Tag` | labels/status | low | theme tokens only |
| `KeyValue` / `DescriptionList` | structured facts | low | bounded rows |
| `Table` | tabular data | medium | bounded rows/cols/cell length; no HTML cells |
| `Progress` | progress indicator | low | numeric clamped |
| `Callout` / `Alert` | info/warn/error | low | map to existing alert styles |
| `CodeBlock` | read-only code | medium | reuse bounded syntax highlighter; no execution |
| `Image` (optional, later) | display image URL/data | high | strict URL/data policy, CSP/sanitization considerations; defer unless needed |

**Not in v1:** forms, buttons that dispatch actions, tool invocation controls, file pickers, arbitrary links with unvalidated targets, iframes, scriptable widgets, chart libraries that execute expressions. Charts can be added later only as declarative data rendered by a fixed TBAi chart component.

### 4.4 Spec validation & normalization

Add a TBAi validator/normalizer (proposed: `web/src/lib/generative-ui/spec.ts` or engine-specific adapters that call a shared validator):

- Accept only objects matching `GenerativeUISpec` shape (`root` node/array).
- Enforce max depth, max node count, max children per node, max string length, max table rows/cells.
- Strip/ignore unknown props not needed by allowlisted components (or validate per component schema if/when schemas are introduced).
- Normalize legacy/alternate keys only if explicitly supported; default to strict.
- For streaming/partial specs, tolerate incomplete but safe structures; never throw uncaught errors into transcript rendering.

This is defense-in-depth: the installed renderer throws on unknown components; TBAi should also bound size/shape before rendering.

---

## 5. Direct Chat integration plan

### 5.1 Emission path options (Track A)

Because installed `JSONGenerativeUI`/`present` tool builders are unavailable, Direct Chat needs a TBAi-owned emission strategy. Options:

| Option | Mechanism | Pros | Cons | Recommendation |
|---|---|---|---|---|
| A1. Data part (`data-tbai-generative-ui`) | Backend writes transient/final data part via `createUIMessageStream` writer; frontend registers `makeAssistantDataUI` or handles in `ChatWindow` data rendering | Fits existing progress pattern; no tool-call semantics; easy to bound | Not a native `generative-ui` message part; requires custom rendering path | **Good v1** if `generative-ui` part support is awkward through current AI SDK/assistant-ui-ai-sdk path |
| A2. Native `generative-ui` message part | Emit/construct `type:"generative-ui", spec` in message content | Uses installed primitive/parts support directly | Requires confirming AI SDK UI message stream + `@assistant-ui/ai-sdk` transport/runtime preserve this part type end-to-end; may need adapter/history handling | **Preferred target** if verified compatible with installed stack |
| A3. Tool result rendered as generative UI | Define a TBAi tool (e.g. `render_ui`/`present_ui`) whose result contains spec; custom tool UI renders via `GenerativeUIRender` | Uses existing tool infrastructure; explicit provenance | Looks like a tool call; model/tool contract must be designed; not the same as docs `present` frontend tool | Acceptable fallback; keep separate from real execution tools |

**Plan:** spike/verify A2 first in a branch-local prototype/test harness. If installed `@assistant-ui/ai-sdk`/history adapters do not preserve `generative-ui` parts cleanly, use A1 for v1 and keep A2 as Track B/compatibility follow-up.

### 5.2 Backend responsibilities (Direct)

- **No new streaming protocol.** Reuse existing UI message stream.
- If A1: add a bounded writer helper in chat stream execution (near progress emission) to emit `data-tbai-generative-ui` with `{ spec, id?, source }`.
- If A3: add a native tool definition in `src/tools/index.ts` only if product-approved; schema must accept only validated spec payload; execution returns spec/result metadata; no side effects.
- **Validation:** validate spec size/shape server-side before emitting/storing when the server is the emitter. Never trust client-provided generative UI specs as executable instructions.
- **Persistence/history:** ensure thread history adapter/storage can round-trip the chosen part representation without corrupting message content. `ThreadHistoryAdapter` stores format adapter output; verify compatibility.
- **Security:** redact/log safely (no raw user secrets; avoid logging full large specs except debug-gated summaries).

### 5.3 Frontend responsibilities (Direct)

- `ChatWindow`: register generative UI rendering in parts components (`generativeUI` allowlist/Fallback) or handle `data-tbai-generative-ui` in the existing data-part branch.
- `runtime.ts` / transport: no custom transport; only verify part pass-through.
- Tool UI: if A3, add a dedicated renderer under `web/src/tools/<engine>/` or a shared generative-ui tool renderer only if truly engine-neutral; register in `nativeToolkit`/`appToolkit` as appropriate.
- Keep Direct/OpenCode separation: Direct-specific emission logic stays in Direct/backend/runtime path; shared renderer remains presentation-only.

---

## 6. OpenCode Chat integration plan

### 6.1 Boundary constraints

OpenCode generative UI must be handled inside/through the OpenCode feature boundary:
- Protocol parsing/projection in `web/src/features/opencode/*` (or engine-owned adapter code called from it).
- Tool-specific rendering in `web/src/tools/opencode/*` only when tied to OpenCode tool semantics.
- Shared `ChatWindow` may render the final normalized `generative-ui` part, but must not understand OpenCode wire format.

### 6.2 Projection path options

| Option | Mechanism | Pros | Cons | Recommendation |
|---|---|---|---|---|
| O1. Project to `generative-ui` message part | In `v2MessageProjection.ts`/runtime store projection, convert a recognized OpenCode payload into `ThreadMessageLike` content containing `{ type:"generative-ui", spec }` | Uses installed primitive rendering; clean UI contract | Requires a stable OpenCode payload source; must not guess wire format | **Preferred if** OpenCode emits a defined generative UI payload/part |
| O2. Project to tool-call + OpenCode tool UI | Keep as tool part; `OpenCode*ToolUI` renders spec via `GenerativeUIRender` | Fits existing OpenCode tool rendering model; no message-part schema risk | Tied to tool-call UX; may not match docs’ generative-ui part semantics | **Pragmatic fallback** for OpenCode-specific tools |
| O3. Metadata/custom rendering outside parts | Store spec in `metadata.custom` and custom-render in `ChatWindow` | Flexible | Bypasses assistant-ui part model; risks special-case sprawl | Avoid |

**Plan:** first determine whether OpenCode V2 has/ will have a generative UI payload. If not, do **not invent** protocol assumptions. Use O2 only for explicit, named OpenCode tools/payloads that TBAi controls or can reliably detect. If OpenCode later provides a stable spec payload, add O1 projection behind a narrow adapter with tests.

### 6.3 OpenCode-specific responsibilities

- `v2MessageProjection.ts`: only map well-defined, validated payloads. Unknown payloads must fall back to existing text/tool rendering.
- `v2RuntimeStore`/controller: no changes for render-only v1 unless a new event/part type is formally supported.
- `web/src/tools/opencode/adapt.ts` / `ui.tsx`: if using O2, normalize OpenCode result/metadata into a TBAi generative spec with strict validation; render with shared allowlist.
- Preserve existing question/permission/form behavior. Generative UI must not answer permissions or replace `session.form`/question flows.

---

## 7. Security, safety, and policy

### 7.1 Hard rules

- **No arbitrary code execution.** Specs are data; components are pre-registered React components.
- **Closed allowlist.** Unknown component names never render as real components.
- **Bounded rendering.** Cap nodes, depth, children, text/table/code sizes; truncate safely with visible indication where appropriate.
- **Safe Markdown/code rendering.** Reuse existing `MarkdownText`/bounded syntax highlighter paths; no raw HTML injection.
- **No secret leakage.** Specs/results must not include credentials/tokens; logging follows existing redaction rules.
- **No approval bypass.** Generative UI buttons/actions cannot trigger privileged tool execution without existing approval/runtime contracts.
- **Questions remain forms.** Any user-input interaction that semantically asks the user to answer questions must use the existing question/form contracts, not approval cards and not ad hoc generative UI action hacks.

### 7.2 Interactive actions (deferred)

Docs describe `$action` dispatch and `prompt_user` resumption. Installed 0.15.32 does not expose the full action/registry/tool-builder surface. Therefore:

- **v1:** no interactive actions, or only inert UI.
- **v2 (design required):** if interactivity is needed before Track B, design a TBAi-owned action envelope with:
  - explicit action IDs mapped to safe handlers,
  - engine-specific dispatch (Direct vs OpenCode) behind adapters,
  - no direct tool execution from renderer,
  - audit/logging,
  - clear separation from approvals and question forms.

Do not implement `$action` execution by interpreting arbitrary model-provided handlers.

---

## 8. Data contracts

### 8.1 Canonical internal spec

Use the installed `GenerativeUISpec` shape as the canonical render contract:

```ts
type GenerativeUISpec = {
  root: GenerativeUINode | readonly GenerativeUINode[];
};

type GenerativeUINode = {
  component: string;      // allowlisted TBAi component name
  props?: Record<string, unknown>;
  children?: readonly (GenerativeUINode | string)[];
  // optional stable key fields only if supported/needed; validate strictly
};
```

### 8.2 Transport/projection contracts

- **Direct A1 (data part):** `data-tbai-generative-ui` payload `{ version: 1, spec: GenerativeUISpec, source: "direct", status?: "partial"|"complete" }`.
- **Direct A2 (native part):** `{ type: "generative-ui", spec }` as `GenerativeUIMessagePart`-compatible content, only if end-to-end pass-through is verified.
- **Direct A3 (tool):** tool name TBD (`present_ui`/`render_ui`), input/output schema validated by Zod; result contains `{ spec }`; renderer ignores unknown fields.
- **OpenCode O1:** projected assistant-ui part `{ type:"generative-ui", spec }` from a validated OpenCode payload.
- **OpenCode O2:** tool-call args/result normalized to `{ spec }` and rendered by OpenCode tool UI.

All contracts need versioning (`version: 1`) and size limits.

---

## 9. Backend/tool responsibilities

### 9.1 Direct backend

- Owns emission only for server-originated generative UI (tool result, stream data part, or approved server transform).
- Validates spec before writing to stream/history.
- Applies request/thread correlation logging (`requestId`, `threadId`, `streamId`) with safe summaries.
- Does not expose secrets or raw sensitive payloads.

### 9.2 OpenCode backend/proxy

- No TBAi-side invention of OpenCode generative UI protocol.
- If OpenCode server/protocol adds generative UI support, TBAi backend changes must remain within OpenCode service/route boundaries and preserve existing session/permission/form contracts.

### 9.3 Tooling

- Track A should avoid adding a general-purpose “UI execution” tool unless there is a clear product need. Prefer explicit, narrow tools.
- Any new tool must follow existing patterns: Zod schema, approval policy as needed, server-side execution boundaries, render-only client UI registration.

---

## 10. UI ownership

| Concern | Owner |
|---|---|
| Shared generative UI renderer wrapper, allowlist, fallback, bounds | shared UI/lib (`web/src/components/assistant-ui/elements/*` or `web/src/lib/generative-ui/*`), imported by `ChatWindow`/tool UIs as appropriate |
| Direct data-part/tool emission handling | Direct chat/runtime/tooling owners (`src/routes/chat/*`, `src/tools/*`, `web/src/runtime.ts`, `web/src/tools/*`, `ChatWindow` data branch) |
| OpenCode payload detection/projection | `web/src/features/opencode/*` |
| OpenCode tool-specific generative rendering | `web/src/tools/opencode/*` |
| Shared transcript rendering hook | `web/src/components/ChatWindow.tsx` (engine-neutral) |
| Interactive actions/forms/permissions | **not** generative UI renderer; existing permission/question/form systems |

No new generic component framework. No universal custom tool-card framework expansion.

---

## 11. Testing strategy

### 11.1 Unit tests

- Spec validator/normalizer: accepts valid specs, rejects/contains oversized/malformed specs, handles partial streaming shapes safely.
- Allowlist renderer: known components render; unknown component uses fallback/error; no throw escapes into transcript.
- Direct emission helper (if A1/A3): emits bounded payload; redacts/logs safely.
- OpenCode projection/adapter: recognized payload maps to spec; unrecognized payload falls back unchanged.

### 11.2 DOM/component tests

- `ChatWindow`/parts rendering: `generative-ui` part renders with allowlist; missing allowlist/fallback behavior is controlled.
- Error boundary/fallback UI for malformed spec.
- Streaming/partial spec updates do not crash.

### 11.3 Integration tests

- Direct: `/api/chat` stream includes generative UI payload (chosen path) and history reload preserves it.
- OpenCode: projected message containing generative UI renders in `ChatWindow mode="agent"` without importing OpenCode runtime into shared components.

### 11.4 E2E (targeted)

- Direct chat receives and renders a simple generative card/table.
- OpenCode chat renders equivalent payload through its own path.
- Malformed/unknown component shows safe fallback, not blank transcript/crash.

### 11.5 Regression checks

- Existing tool rendering, approvals, OpenCode permissions/forms, progress data parts, markdown/code rendering, and virtualization remain unchanged.
- Run `bun run verify` to completion before claiming done (note: prior session left `bun run test` incomplete; do not repeat that reporting gap).

---

## 12. Rollout phases

### Phase 0 — Compatibility spike (no product behavior)
- Verify installed stack behavior for `generative-ui` message parts through `@assistant-ui/ai-sdk` transport + thread history + `MessagePrimitive.Parts`.
- Verify A1 data-part rendering path as fallback.
- Deliverable: short decision note in plan/PR description: A1, A2, or A3 for Direct v1.

### Phase 1 — Render-only foundation
- Add TBAi generative UI allowlist + validator + safe renderer wrapper.
- Wire `ChatWindow` to render generative UI parts/data parts.
- Add tests for allowlist, bounds, fallback, and rendering.
- No model/tool emission yet except test fixtures.

### Phase 2 — Direct Chat v1
- Implement chosen Direct emission path (A1/A2/A3).
- Server-side validation and history compatibility.
- Feature flag/config gate if needed.
- E2E smoke for Direct.

### Phase 3 — OpenCode Chat v1
- Implement O1 or O2 only for explicitly supported payloads.
- Keep all protocol logic inside OpenCode boundary.
- E2E smoke for OpenCode.

### Phase 4 — Hardening
- Observability (counts/sizes/fallback reasons, redacted).
- Performance bounds under virtualization/streaming.
- Accessibility pass for rendered components.

### Phase 5 — Track B evaluation (separate decision)
- Compatibility review for upgrading assistant-ui/ai-sdk to gain `JSONGenerativeUI`, actions, `present`/`prompt_user`, catalog/schema helpers.
- Evaluate impact on frozen train, existing tool UIs, approvals, OpenCode runtime, and tests.
- Only proceed with explicit approval.

---

## 13. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Installed stack lacks docs APIs | Cannot use official tool-builder/action pipeline | Track A uses installed renderer/spec primitives; Track B requires upgrade review |
| `generative-ui` part not preserved by AI SDK transport/history | Direct A2 fails | Spike in Phase 0; fallback to A1/A3 |
| OpenCode has no stable generative UI payload | O1 impossible without guessing | Do not invent protocol; use O2 only for explicit payloads or defer |
| Unsafe model-generated UI | XSS/UI injection/DoS | Closed allowlist, strict validation, size bounds, safe Markdown/code components, no raw HTML/eval |
| Boundary erosion | OpenCode/Direct coupling | Engine-specific projection/emission; shared renderer presentation-only; no `@opencode/client` runtime in shared UI |
| Collision with approvals/questions | Broken interaction contracts | No actions in v1; questions remain forms; approvals remain approval APIs |
| Performance regressions in transcript | Jank during streaming/virtualization | Bound spec size, memoize renderer, avoid heavy components in v1, test under virtualization |
| Frozen assistant-ui train | Upgrade pressure | Record decision; no dependency churn without compatibility review |

---

## 14. Non-goals (v1)

- No `JSONGenerativeUI`/`defineGenerativeComponents`/`defaultGenerativeUILibrary` adoption on frozen train.
- No `present`/`prompt_user` tool-builder integration from newer docs.
- No `$action` dispatch, action registry, or generative UI-driven tool execution.
- No `@assistant-ui/vite` `"use generative"` compiler setup.
- No merging Direct and OpenCode runtimes.
- No OpenCode protocol invention.
- No replacement of existing tool UIs, approval cards, or question/form systems.
- No arbitrary component registry or remote component loading.

---

## 15. Open decisions (need explicit product/architecture choice)

1. **Direct v1 emission path:** A1 data part vs A2 native `generative-ui` part vs A3 tool-result UI (decide after Phase 0 spike).
2. **OpenCode payload source:** is there an actual OpenCode V2 generative UI payload to support, or is v1 Direct-only?
3. **Component vocabulary:** exact v1 allowlist (cards/table/badges/progress/code/markdown subset) and prop schemas.
4. **Persistence:** should generative UI specs be stored as final message parts only, or also transient during streaming?
5. **Interactivity policy:** remain display-only until Track B, or design a TBAi-owned safe action contract.
6. **Feature flag:** gate behind config/flag for initial rollout?

---

## 16. Recommended next step

Run **Phase 0** as a small, isolated spike (no user-facing feature): prove whether installed `@assistant-ui/ai-sdk` + current history/runtime preserve a `generative-ui` message part in Direct Chat; if not, confirm `data-tbai-generative-ui` rendering in `ChatWindow`. Then implement **Phase 1** (allowlist + safe renderer + tests) before any model-facing emission.
