# Native OpenCode V2 Tool Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make native OpenCode V2 tool calls render, update, fail, approve, and reload correctly for `read`, `write`, `edit`, `shell`, and `websearch`.

**Architecture:** Keep OpenCode V2 events and history as the source of truth. Normalize official tool lifecycle events and V2 content arrays at the V2 state/projection boundary, then adapt the existing assistant-ui tool renderers to the normalized result/metadata shape. Register both observed V2 tool names (`shell` and `bash`) without creating a second execution or approval path.

**Tech Stack:** Bun, React 19, TypeScript, `@opencode/client@2.0.16`, `@assistant-ui/react`, Bun test, Playwright.

**Spec:** The generated `@opencode/client@2.0.16` declarations and the native V2 event/history contracts exercised by the focused test suite.

## Status (verified 2026-09-26)

Tasks 1–5 are implemented. `bun run typecheck` and `bun run build` both exit 0.

What is actually proven, and by which kind of test:

- **Deterministic (no provider).** The reducer, history, projection, adaptation, and
  renderer suites cover each link on its own, and three seam tests hold the links
  together: a linked `permission.asked` reaching the shell card as a working gate, a
  failed execution exposing no approval card, and history → projection →
  `openCodePatchFromParts` → rendered diff.
- **Real server (live `opencode serve`, nothing mocked).**
  `web/e2e/opencode-v2-permission-live.spec.ts` drives a genuine gated `shell` call
  to the native permission reply endpoint and asserts the command then runs;
  `web/e2e/opencode-v2-edit-reload-live.spec.ts` drives a genuine `edit`, reloads the
  page, and asserts the patch still renders as a diff rather than the literal
  `"Edit applied successfully."`. The second test is what executes
  `useOpenCodeEditPatch` in a real browser — unit tests cannot, because they inject
  `diffPatch` as a prop.

Two things about those live tests are worth recording, because both were found by
measurement rather than assumed:

- The edit prompt names the `write`/`edit` tools and rules out the shell. Left to
  itself the model sometimes reports that it has no `edit` tool and falls back to
  the shell, which is permission-gated and therefore never produces a patch. That
  made the first version of the test fail 1 run in 4; after the prompt change, 7
  consecutive runs passed across both browser projects.
- A live `permission.asked` carries save patterns, so the shared gate renders
  option-backed controls (`Allow` / `Always allow` / `Deny`) rather than the generic
  `Approve` pair that an options-free permission produces. The tests accept either
  spelling, so they assert the gate exists rather than its copy.

### Deviations from the plan, and why

1. Task 5 asked for browser coverage of the approval path that does not depend on a
   real provider. The official client cannot be driven that way: a fulfilled SSE
   body closes the stream, which the client treats as a fatal generation error
   (`v2ThreadController.ts`), so a controller fed a mocked `/api/event` never
   reaches `ready`. The same assertions are therefore covered twice instead — seam
   tests over the real reducer/projection/renderer, and the real-server browser test.
2. Task 1's second step says the new reducer cases "fail because only `input.started`
   is currently handled". That described the tree when the plan was written and is no
   longer true — the tool lifecycle now has seven handlers in `v2Events.ts`. The
   step is checked because the work it describes is done, not because its premise
   still holds.
3. This plan said to preserve the dirty working tree and not commit. The maintainer
   directed that the Task 5 verification work be committed after review (`d85878e`).

### Known failures that predate this work

`bun run test` is still not green, and was not green before this plan's tasks. Three
failures that sat inside the V2 boundary have since been fixed; the rest are
reported rather than fixed here, because they belong to other subsystems:

Fixed (all inside the V2 feature boundary this plan owns):

- `tests/unit/toolkit.test.ts` — the expected tool-name list was never updated when
  `shell` was registered alongside `bash` in Task 4, so the registry held a name the
  test did not expect.
- `web/src/stores/stalePermissionsStore.test.ts` — a genuine parity gap, not a stale
  expectation: `OpenCodePermissions.tsx` was the one approval surface that did not
  consult the stale store, so a permission the server had forgotten still offered
  Approve/Deny that could only ever 404. It now goes through the same
  `useStaleApprovalGuard` as the tool-card surfaces.
- `web/src/lib/observability-coverage.test.ts` — `compactSession.ts` emitted no
  lifecycle events at all, so a `/compact` run could not be reconstructed from logs.
  `runCompactSession` now records started/completed/failed, and the Composer calls it
  rather than inlining the runtime call.

Still failing, in other subsystems:

- `src/services/todo.test.ts` (8) — `FOREIGN KEY constraint failed`; the suite seeds
  synthetic thread ids that no longer satisfy the schema.
- `tests/integration/first-send-opencode-draft.test.ts` — duplicate
  `clientRequestId` POSTs answer 500 instead of 200.
- `web/src/features/opencode/sessionBootstrap.test.ts` (2) — these PASS in isolation
  and only fail inside the full run, so this is a test-isolation problem, not a bug.

## Global Constraints

- Do not add a second OpenCode client, execution path, or permission protocol.
- Preserve official V2 event identity, generation scoping, approval response mapping, reconnect, and first-prompt behavior.
- Never auto-approve a tool or fabricate a permission card for `session.execution.failed`.
- Keep the existing assistant-ui tool renderers and shared `BackendToolView`/`ApprovalGate`; do not create a second approval UI.
- Preserve the dirty working tree; do not reset, stash, commit, or push.
- Every new public function gets happy-path and edge-case coverage; run typecheck, build, focused tests, and the Code-route Playwright test before completion.

## Review Focus

- A `session.tool.input.started` event followed by native V2 input, call, progress, success, and failure events must converge to the correct assistant-ui tool status.
- Native V2 `content` arrays and `state.error` must display real output and failure text rather than `No output` or a completed result.
- A linked `shell` permission must expose Approve/Deny controls; a failed execution with no `permission.asked` must not expose a false card.
- V2 edit metadata must survive history projection and produce a diff after reload.
- `shell` and `bash` must use the same terminal renderer without duplicate registrations or execution logic.

---

### Task 1: Normalize native V2 tool lifecycle events

**Files:**
- Modify: `web/src/features/opencode/v2Events.ts`
- Modify: `web/src/features/opencode/v2Types.ts`
- Test: `web/src/features/opencode/v2Events.test.ts`

**Interfaces:**
- Consumes official `V2Event` variants for `session.tool.input.delta`, `session.tool.input.ended`, `session.tool.called`, `session.tool.progress`, `session.tool.success`, and `session.tool.failed`.
- Produces the existing `V2MessagePartState` tool shape with terminal `output`, `status`, and preserved `permissionId`.

- [x] Add failing reducer tests that start a tool, apply input/call/progress/success, and assert input/output/status convergence; add a failure case asserting error output/status.
- [x] Run the reducer tests and confirm the new cases fail because only `input.started` is currently handled.
- [x] Implement event handlers using official event data and existing `applyAssistantEvent`/`replacePart`; do not drop unknown event types silently if they are part of the official tool lifecycle.
- [x] Run the reducer tests and confirm all cases pass.

### Task 2: Preserve V2 result arrays and edit metadata

**Files:**
- Modify: `web/src/features/opencode/v2Types.ts`
- Modify: `web/src/features/opencode/v2History.ts`
- Modify: `web/src/features/opencode/v2MessageProjection.ts`
- Test: `web/src/features/opencode/v2History.test.ts`
- Test: `web/src/features/opencode/v2MessageProjection.test.ts`

**Interfaces:**
- Produces tool parts with `output: unknown`, explicit `error` status, and an optional raw OpenCode metadata field consumed by renderers.
- Produces assistant-ui tool calls where running tools use `result: undefined`, completed tools use defined output, and failed tools use incomplete/error presentation.

- [x] Add failing tests for V2 text-content arrays, V2 error objects, `metadata.files[].patch`, running projection, and failed projection.
- [x] Add `metadata` to the tool state only as the smallest raw metadata boundary needed by the edit renderer.
- [x] Preserve completed/error content without converting it to a legacy string; preserve metadata on the normalized tool part.
- [x] Map `pending`/`running` to `result: undefined`; map errors to an incomplete/error assistant-ui status and retain the error text.
- [x] Run history/projection tests and confirm they pass.

### Task 3: Adapt OpenCode renderers to the V2 result contract

**Files:**
- Modify: `web/src/tools/opencode/adapt.ts`
- Modify: `web/src/tools/opencode/ui.tsx`
- Test: `web/src/tools/opencode/adapt.test.ts`
- Test: `web/src/tools/opencode/ui.test.ts`
- Test: `web/src/tools/opencode/websearch.test.tsx`

**Interfaces:**
- Consumes normalized V2 tool results and metadata.
- Produces the existing rich renderer props and shared approval behavior.

- [x] Add failing tests for V2 content arrays for read/write/edit/shell, V2 websearch JSON wrapped in `{ type: "text", text }`, and V2 `metadata.files[].patch`.
- [x] Add a shared text extraction helper for V2 content arrays while preserving string compatibility.
- [x] Make read/write/edit/shell result renderers use the extracted text and the preserved V2 patch metadata.
- [x] Make websearch parse the extracted text payload and retain plain-text fallback behavior.
- [x] Run all OpenCode renderer/adaptation tests and confirm they pass.

### Task 4: Register the observed V2 shell name and linked approvals

**Files:**
- Modify: `web/src/tools/toolkit.ts`
- Modify: `web/src/tools/opencode/ui.tsx`
- Modify: `web/src/features/opencode/OpenCodePermissions.tsx` only if a rendered linked tool cannot reach the shared gate.
- Test: `web/src/tools/opencode/approvalParity.test.ts`
- Test: `web/src/tools/opencode/ui.test.ts`
- Test: `web/src/features/opencode/v2MessageProjection.test.ts`

**Interfaces:**
- Registers `shell` and `bash` against the same existing terminal renderer.
- Keeps the existing assistant-ui approval response contract and native permission endpoint.

- [x] Add a failing registry/UI test proving the observed `shell` name resolves to the terminal renderer and receives the same approval controls as `bash`.
- [x] Register `shell` as a standalone backend tool using the existing `OpenCodeBashToolUI` implementation; do not add execution code.
- [x] Verify linked approval projection produces `approval` and the shared renderer exposes Approve/Deny; do not make the fallback panel render linked requests.
- [x] Run approval parity and renderer tests.

### Task 5: Add end-to-end coverage and verify the real flow boundaries

**Files:**
- Modify: `web/e2e/opencode-v2-code-route.spec.ts` only for deterministic tool fixtures or existing test hooks; do not depend on a real provider for permission correctness.
- Create or modify focused V2 event/projection tests as needed.
- Modify: `docs/decisions.md` and `docs/phases.md` after verification.

- [x] Add a deterministic browser test covering a linked pending tool approval using the official V2 fixture/event boundary; assert visible `Approve once` and `Deny`, then assert the reply request uses the native permission endpoint.
- [x] Add a browser assertion that `session.execution.failed` without `permission.asked` displays an execution error and does not display a false approval card.
- [x] Run the focused native/tool suites, `bun run typecheck`, `bun run build`, and `bunx playwright test e2e/opencode-v2-code-route.spec.ts --project=chromium-headless`.
- [x] Report actual counts and explicitly separate deterministic UI coverage from real-provider execution, which remains environment-dependent.
