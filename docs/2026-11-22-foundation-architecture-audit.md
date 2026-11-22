# TBAi Foundation Architecture Audit — `ui-foundation-upgrade` @ `55b8ed5`

**Date:** 2026-11-22
**Repository:** `Rajendertyagi/TBAi`
**Branch:** `ui-foundation-upgrade`
**Verified remote HEAD:** `55b8ed5edcf3c79035c653a70a78f21b49bea888`
**Mode:** independent, read-only audit. Seven parallel `opencode/iceman-free` auditors inspected actual source; the project manager independently verified the remote commit via GitHub API, the git state, installed dependency versions, and several central source claims. No implementation, no commits during the audit, no dependency changes.

## Evidence categories used in this report

| Category | Meaning |
|---|---|
| **Independently verified source behavior** | `file:line` claims read directly from the working tree by auditors or the PM. |
| **Agent-reported test results** | Test counts stated in docs or by agents, not re-run in this audit. |
| **Actual CI results** | An observed workflow/check result. **None available** — no check runs, commit statuses, or Actions runs for this branch. |
| **Untested / unknown** | Plausible but not proven by inspected source or tests. |

---

## A. Current architecture

**Backend (one Bun/Hono process).** `src/routes/index.ts` composes per-concern modules; dependency direction is `routes → services → db` with four documented value-level `routes → db` exceptions (`index.ts:6`, `providers.ts:2`, `memories.ts:3`, `scheduler.ts:6`). Direct streaming uses AI SDK v7 with a process-local run registry (`src/services/chat-runs.ts`) plus a durable SQLite resumable store (`src/lib/resumable.ts`, `src/services/chat-streams/*`). OpenCode is isolated in `src/services/opencode/` behind an allowlisted proxy (`proxyRoutes.ts:1-205`, `proxyAuthorization.ts:96-159`). MCP is server-executed behind `mcpManager`. Credentials are AES-256-GCM encrypted under a per-install DEK.

**Frontend (one presentation layer, two isolated runtimes).** `AppShell.tsx:112-128` derives `runtimeThreadId` from the active chat tab and creates **one canonical Direct runtime** via `useAppChatRuntime`, provided to the whole shell at `AppShell.tsx:229`. `ChatShell` is a branch shell only; `CodeShell` mounts OpenCode at `/code/:agentId?`. `ChatWindow` is engine-neutral via `mode="chat" | "agent"`. OpenCode uses `AuiProvider extends={null}` (`OpenCodeIsolationBoundary.tsx:10-15`); panel Direct hosts use the same pattern (`DirectChatHost.tsx:25-46`).

**Identity.** Conversation `ref` + `kind` is canonical (`chatTabs.ts:20-27,92-108`), mapped to `chat:<id>` / `agent:<id>` and `/chat/:id` / `/code/:id`. Shared membership is SQLite-authoritative via preferences snapshot; local active key, draft, detached refs are per-window Zustand. Reconciliation is removal-only on confirmed 404 (`tabReconciliation.ts:20-81`).

**Workspace panels.** `workspacePanels.ts:15-61` stores `{id, tabKey, order}` only. `WorkspaceSurface.tsx:14-47` renders stable keyed hosts, filters the active tab, and mounts `DirectChatHost` for bound Direct chats. No persistence, no move/close/resize/split UI, no non-chat content.

**Verified installed versions:** `@assistant-ui/react@0.15.32`, `@assistant-ui/ai-sdk@0.0.16`, `ai@7.0.145`, `assistant-stream@0.3.55`, `@opencode/client@2.2.6`.

---

## B. Foundation assessment

| Area | Class | Severity | Confidence |
|---|---|---:|---|
| Conversation identity / tab keys / routes | **KEEP** | Low | High |
| Shared membership vs local presentation split | **KEEP** | Low | High |
| Direct/OpenCode execution isolation | **KEEP** | Low | High |
| Direct runtime factory + panel host (`DirectChatHost`) | **KEEP** | Low | High |
| OpenCode session-scoped runtime + dispose/reconnect | **KEEP** | Low | High |
| Stable host identity on reorder (CSS order, keyed id) | **KEEP** | Low | High |
| Per-thread operation scoping, query-keyed cache, per-owner history visit | **KEEP** | Low | High |
| Backend streaming durability + cleanup | **KEEP** | Low | High |
| Credential/approval/proxy/path-confinement security | **KEEP** | Low | High |
| Router owns pages only | **KEEP** | Low | High |
| AppShell responsibility concentration | **IMPROVE** | Medium | High |
| Direct runtime tied to shell active tab | **IMPROVE** | Medium | High |
| Global one-shot provider overrides | **IMPROVE** | Medium | High |
| Module-level singleton inventory/reset discipline | **IMPROVE** | Medium | Medium |
| Workspace panel model (Direct-only, no persistence) | **REDESIGN** | High | High |
| Privileged primary runtime vs "position not runtime" target | **REDESIGN** | High | High |
| OpenCode panel hosting | **REDESIGN** (missing capability) | Medium | High |
| Multi-live Direct runtime independence | **REDESIGN** (future) | High | Medium |
| Multi-draft support | **DEFER** (v1 assumption) | High if changed | High |
| Resize/split/non-chat content | **DEFER** | Medium | High |
| Real multi-surface E2E coverage | **REDESIGN** (test strategy) | High | High |
| `runBash` unsandboxed boundary | **IMPROVE** (make unmissable) | High if misunderstood | High |

---

## C. Findings

### Real defects / verified risks

1. **Privileged primary runtime contradicts the product target.** `AppShell.tsx:112-128,229` owns one canonical Direct runtime bound to the active tab; `WorkspaceSurface.tsx:16-23` filters the active tab out of panels; `workspacePanels.ts:38-46` rejects drafts and agent tabs. The redesign docs define Primary Chat as a *position, not a runtime* (`product-architecture.md:15,23-26`), but the code makes it a runtime owner. Consequence: conversation identity is position-independent, but runtime ownership is not — moving the "primary" conversation is constrained by special cases. **Severity High, Confidence High.** This is an architecture gap, not a runtime bug.

2. **Global one-shot overrides can cross concurrent Direct surfaces.** `providersStore.ts:30-32,89-96` holds `selectedProviderId/ModelId/ReasoningLevel` globally; `runtime.ts:337,379-423` consumes and reverts them. Two concurrent Direct sends can race on consumption/revert. **Severity Medium, Confidence High.**

3. **`runBash` is not sandboxed.** `src/services/tools.ts:1-40,342-360` confines only the starting directory; the command body runs with server privileges. Future terminal/workspace features must not be treated as sandboxed. **Severity High if misunderstood, Confidence High.** This is a documented boundary fact, not a missing feature.

4. **Boundary debt.** Four value-level `routes → db` imports and route-local idempotency maps (`src/routes/conversations.ts:44-78,135-241`). **Severity Medium, Confidence High.**

5. **No capacity policy for many open panels.** Each `DirectChatHost` owns a runtime; no LRU/unmount policy found. **Severity Medium, Confidence Medium** (no load test).

### Missing future capabilities (not defects)

- OpenCode cannot be panelized: `WorkspaceSurface.tsx:31-33` excludes it; `router.tsx:163-173` has a single Code route. The runtime core is instance-scoped and reusable — this is composition work, not a new engine.
- Panel model cannot express generic content: `workspacePanels.ts:15-19` has no content type, size, split tree, or persistence.
- No resize/split/move UI: `movePanel`/`closePanel` exist in the store but no component calls them (`AppShell.tsx:149-152` only opens).
- Multi-draft blocked by singleton `chat:new` and single `draftClientRequestId` (`materializeDraft.ts:45-55`).
- No real multi-surface E2E: CI E2E scope (`.github/workflows/tests.yml:450-464`) has no workspace-panel scenario.

### Documentation drift

- `docs/state-management.md:74,147` describes `tbai:openTabs` persistence; no such key exists in `web/src` — actual mirror is `preferences.snapshot.sharedTabs`.
- `docs/workspace-redesign/README.md:8` claims "current uncommitted diff touches 6 production files"; git is clean at the verified SHA.
- `docs/architecture.md:80-118,212-266` omits `features/workspace/`.
- Workspace-redesign audits name `lastGoodThreads` / `lastMountedConversationId`; code uses `threadListCache` (`remoteThreadListAdapter.tsx:104-116`) and `lastMountedByOwner` WeakMap (`useDirectHistoryWindow.ts:427-458`).
- `loadProviders()` is called in both `AppShell.tsx:154-157` and `ChatShell.tsx:20-23` (harmless duplication).

**No auditor found docs silently reintroducing the old privileged Primary Chat *runtime* concept** — the redesign docs explicitly define it as a position. The drift is code-vs-target, not doc-vs-target.

---

## D. Recommended target architecture

The simplest durable design that meets the stated requirements:

1. **Content-owned runtimes, not position-owned.** A generic content host keyed by `(engine, conversationId)` mounts the appropriate runtime wherever the content is displayed. `DirectChatHost` already proves this pattern for Direct; build the equivalent `OpenCodeChatHost` by extracting the session bootstrap + `useOpenCodeRuntime` chain out of `OpenCodeView`. AppShell should own chrome and a workspace layout, **not** a Direct runtime.

2. **Generic panel/content model.** Replace `{id, tabKey, order}` with a small tree: panel/split node → ordered tabs → `{contentType, identity, context}`. Keep the proven invariant: stable node id, CSS/layout order, keyed hosts so moves never remount. Content types (Direct, OpenCode, file tree, viewer, browser) are renderers selected by `contentType`; no per-type panel classes.

3. **Persistence split.** Layout tree (types, order, sizes, active tabs) → device-local localStorage, following the `useDesktopLayout` `persist` precedent. Content identity refs → existing SQLite `sharedTabs`. Never persist message state or secrets.

4. **Scope the remaining globals.** Move one-shot overrides from global Zustand into per-content/surface state (or key them by surface id). Keep the singleton draft only if the product keeps one draft; otherwise make `draftClientRequestId` per-draft.

5. **Keep the boundaries that are already good.** Do not merge Direct/OpenCode runtimes, do not add a universal runtime abstraction, do not add a second tab system or router, do not introduce a generic tool-card framework. Keep `resolveSafe`/grant checks, OpenCode proxy allowlist, MCP server-executed boundary, and the unsandboxed-shell disclosure.

6. **Security for future workspace tools.** Files/terminal/browser features must go through `resolveSafe` + grants; terminal must be labeled unsandboxed; OpenCode exposure via explicit allowlist entries; MCP treated as server-privileged.

---

## E. Migration implications

**Retain (no rewrite):** identity model, `chatTabs`, adapters, both runtimes and their isolation boundaries, operation scoping, resumable/history/recovery machinery, backend route composition, security controls, stable host invariant, existing tests.

**Improve:** extract runtime ownership out of AppShell into content hosts; scope one-shot overrides; generalize the panel store with a content type and layout tree; add layout persistence; add real multi-surface integration/E2E tests; reconcile the four documentation drifts; make the unsandboxed shell boundary explicit in future UX.

**Genuine restructuring:** (a) AppShell must stop being the canonical Direct runtime owner — this is the central change; (b) OpenCode needs a reusable panel host; (c) the panel model needs a content-type/layout-tree representation. None of this requires a rewrite of the execution systems.

---

## F. Verification gaps

| Category | Status |
|---|---|
| **Independently verified source behavior** | All cited file:line claims were read directly by auditors; the PM personally verified AppShell runtime ownership, panel store, product-architecture docs, git state, and remote commit. |
| **Remote commit** | Verified via `git ls-remote` and GitHub API: SHA, message, parent `d3d81a6`, all 13 files match local. |
| **Installed dependency versions** | Verified from `node_modules` by the runtime auditor. |
| **Agent-reported test results** | Counts in `docs/decisions.md:9060` and `README.md:9` (unit 4999 / integration 1037 / DOM 828) are **claims**, not re-run in this audit. |
| **Actual CI results** | **None.** No check runs, commit statuses, or Actions runs for this branch. No CI pass/fail can be cited. |
| **Untested behavior** | Live browser/Tauri E2E; real multi-runtime concurrency; memory under many panels; OpenCode remount/reuse; backend endpoint semantics under failure; redaction completeness; load/concurrency stress. |
| **Local-only limitation** | Only `docs/workspace-redesign/prototype/screenshots/` (untracked, non-code). All code is on the remote at the verified SHA. |

---

## G. Recommended implementation order

1. **Owner decisions first (blocking):** Is "Primary Chat" a permanent *position* with no privileged runtime, or just a name for the active surface? Is single-draft a durable product assumption? Is layout persistence device-local only? Is OpenCode panelization in scope now? These cannot be settled from code.

2. **Extract runtime ownership from AppShell into a content host** — the key unblocker for "runtime ownership must not depend on screen position." Reuse `DirectChatHost` as the pattern; prove two Direct content hosts with independent runtimes via real integration tests.

3. **Generalize the panel model** to content type + identity + layout tree, preserving the stable-id/CSS-order invariant. Add persistence per the state-management tiers.

4. **Add an OpenCode content host** by extracting the bootstrap/runtime chain from `OpenCodeView`; keep the execution engine untouched.

5. **Scope one-shot overrides** per content/surface; decide draft idempotency key scope.

6. **Add non-chat content types incrementally** — file tree + read-only viewer first (lowest risk, per `product-architecture.md:113`), then browser/editor only after security review.

7. **Build real multi-surface E2E coverage** before declaring the workspace foundation complete; add DirectChatHost isolation-contract tests.

8. **Reconcile documentation** (state-management `tbai:openTabs`, architecture.md workspace section, README status, stale audit names) in the same commits as the changes they describe.

---

## Bottom line

The foundations are **good enough to build on for the current model** — identity, isolation, streaming, security, and the stable-host invariant are sound. The one demonstrated architectural limitation against the stated product is **runtime ownership in AppShell**, which makes one Direct runtime privileged by position. Fix that, generalize the panel model, and add real multi-surface tests; no broad rewrite is warranted.
