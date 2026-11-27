# TBAi — Recursive Workspace Test Strategy

**Status:** Future test obligations supporting `CONTEXTUAL_WORKSPACE_IMPLEMENTATION_PLAN.md`. Documentation only; no test in this document has been written or run. No implementation authorized.

**Audited branch / HEAD:** `ui-foundation-upgrade` @ `4c0cda723263a075458cb7a44025af40c059debd`.

**Date:** 2026-11-28

**P0 gate:** the first phase proves arbitrary-depth recursion on the installed Dockview 8.9.1 package. The current two-group E2E case is explicitly **not** proof of depth. A specific three-or-more-level case must be written and executed before any content type is added.

**Evidence rule:** a test file's existence is not proof it passed. All current pass counts are agent-reported (`WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:187-188,644`); no hosted CI evidence exists. Every future test below must be executed and its exact counts recorded before its phase is accepted.

---

## 1. Testing principles

1. **Behavior, not layout.** Assert the dependency or invariant, not formatting or DOM wrapping. Source-text guards must assert an invariant and be able to fail.
2. **Prove the guard can fail.** For each new guard: introduce the defect, run the test, watch it fail, revert, run it green. Record the mutation and result.
3. **Layer appropriateness.** Pure logic → unit; component contracts and state isolation → DOM (happy-dom); real Dockview geometry, DnD, streams, and persistence → Playwright E2E; server contracts and containment → integration.
4. **No weakening.** Never delete a test to make a gate green; never relax TypeScript, lint, or assertions.
5. **All tests under `tests/`** (`bun run test:locations` is a hard gate). Layer first, feature second.
6. **Exact reporting.** Record command, exit code, pass/fail/skip counts, and what was skipped.

---

## 2. Test layers and what each must cover

### 2.0 P0 — recursive foundation (must pass before P1)

| Case | User-visible behavior | Assertion |
|---|---|---|
| Split right | One pane becomes two side by side | 2 groups, distinct group ids, both panels present |
| Split child down | The child pane becomes two stacked | 3 groups; the original child is now a branch with two leaves |
| Split descendant right | A grandchild pane splits again | 4 groups; **three or more levels** in `grid.root` |
| Save / reload / restore | Deep arrangement returns exactly | every panel id, size, active tab and group structure preserved |
| Move between panes | Drag a panel to another group | no `onPanelClose`, no disposal, identity preserved |
| Focus navigation | Move focus across nested groups | active panel follows; keyboard/ARIA baseline present |
| Minimum sizes | Drag sash beyond limit | pane clamps to minimum; no zero-size pane |

**Evidence rule:** this case must be executed against the real installed package. Do not claim it passes from source inspection or from the existing two-group E2E case.

### 2.1 Unit — `tests/unit/web/workspace/`

| Area | Future cases | Must fail if |
|---|---|---|
| `contentTypeForPanelId` | `chat:`/`agent:` delegate to existing classifier; reserved non-chat prefixes map to their types; unknown prefix → `null` | `parseTabKey` widened, or a non-chat prefix collides with `chat`/`agent` |
| `parsePanelParams` (extended) | Existing cases at `dockview-params.test.ts:36-42,50-59,73-86` remain byte-identical; new non-chat params accepted with exact key set | Cross-check removed, extra field allowed, or non-serializable value admitted |
| `desiredPanelIds` | Keeps canonical + non-chat ids, dedupes; `desiredPanelKeys` still drops malformed keys (`panel-registry.test.ts:32-38`) | `desiredPanelKeys` relaxed or claim Set keyed by panel id |
| `reconcileLayout` (widened) | Non-chat panel kept when id in `allowedPanelIds`; stale chat refs still dropped (`layout-persistence.test.ts:89-102`); floating/popout/edge still dropped (`:144-162`) | Allowed set auto-accepts all ids, or `params.tabKey === id` invariant removed |
| Controller | Adds non-chat panel with `renderer:"always"`; `focusOrOpen` accepts known non-chat id; `onPanelClose` never called for non-chat id; `onPanelRemoved` called | `parseTabKey` guard used for non-chat, or close semantics leak to non-chat |
| Opening service | Request → identity key → reuse/create; duplicate detection by identity not title; modifier override forces new; placement options passed | Identity keyed by title, or placement omitted |
| Panel state module | Per-panel state keyed by panel id; corrupt payload falls back field-by-field; no secrets/paths stored | State keyed by type only, or corrupt read throws |

### 2.2 DOM — `tests/dom/workspace/`

| Area | Future cases | Must fail if |
|---|---|---|
| Multi-panel identity | Two chat panels with different conversations get distinct runtimes; same conversation refused (`direct-host-parity.test.tsx:274-281` extended) | Claim removed or keyed by panel id |
| Non-chat panel beside chat | Non-chat panel id survives save/load with exact `data-param-keys="contentType,tabKey"` (`dockview-split-group-contract.test.tsx:149-153,180`) | Params widened with a state field |
| Per-panel state isolation | File Viewer A and B hold different current files/scroll; focusing one does not change the other | State keyed by type or shared module singleton |
| Focus non-destructive | Focusing panel B leaves panel A's host, composer, and activation generation unchanged | `focusOrOpen` removes or replaces a panel |
| Tab ownership | No second conversation-tab store; global strip retired; group-scoped active-panel change updates only that group | Two strips render conversation tabs |
| Automatic click handlers | Clicking a file path in a tool card calls the opening service with correct identity; clicking a URL does the same | Handler missing or wrong type inferred |
| Source guards | Generic infra imports no OpenCode internals (`OpenCodePanel.integration.test.tsx:575-609`); `chatTabs.ts` unchanged; no second layout engine import | New panel component placed in generic infra |

### 2.3 Integration — `tests/integration/`

| Area | Future cases | Must fail if |
|---|---|---|
| File list/read API | Conversation-scoped root resolution; traversal `../` rejected; symlink escape rejected; missing folder → `folder_unavailable`; missing conversation → `conversation_missing`; bounded reads; no absolute path returned as authority | `resolveSafe` bypassed or client-supplied root accepted |
| Zod validation | Bounded strings; `conversationId` min 1/max 200; `safeParse` failure → 400 with issues; server re-resolves root after validation | Schema loosened or root taken from body |
| Browser (if approved) | Origin isolation; no access to app credentials/API; teardown on panel close | Embedded surface shares app origin |
| Terminal (if approved) | cwd confinement; process teardown with panel; no auto-approve; explicit unsandboxed warning | Process outlives panel or shell described as sandboxed |

### 2.4 E2E — `tests/e2e/workspace/`

| Case | User-visible flow | Assertion |
|---|---|---|
| Manual open beside | Click `+` → choose File Viewer → Beside | Both panels visible; chat runtime/composer/scroll intact |
| Manual open below | Click `+` → choose Terminal → Below | Vertical split; sash resizes; both visible |
| Click file | Click `src/services/workspace.ts` in chat | File Viewer opens/activates with tree context; conversation tab untouched |
| Click URL | Click docs link in chat | Browser panel opens/activates with that URL |
| Duplicate click | Click same file twice | One panel focused, not duplicated; modifier creates second |
| Two chats | Click second conversation in Chat Threads | Two chat panels, distinct identities, independent runtimes |
| Move | Drag File Viewer tab below chat | `onDidMovePanel` + settled mutation; no close; state survives |
| Close one panel | Close File Viewer | Only that panel removed; conversation membership/history untouched |
| Restart | Reload with mixed layout | All panel types restored; chat rebinds; viewer rebinds to conversation + relative path; browser reopens URL |
| Corrupt layout | Inject invalid JSON | Safe default; no crash |
| Stale conversation | Delete a conversation, reload | Its panel pruned; other panels intact |
| Unavailable folder | Remove project folder, open Files | Clear unavailable state; folder row preserved |
| Narrow window | Resize to minimum | Minimum sizes respected; no panel silently disposed |
| Keyboard/a11y | Tab through panels and tabs | ARIA roles present; focus visible; roving tabindex works |

---

## 3. Guard-failure proofs (required for each new guard)

| Guard | Defect to introduce | Expected failure |
|---|---|---|
| Non-chat id classifier | Map a non-chat prefix through `parseTabKey` | Unit classifier case fails |
| Params invariant | Add a state field to `PanelParams` | `dockview-params.test.ts:80-86` and DOM `data-param-keys` case fail |
| Reconciliation preservation | Remove non-chat ids from `desiredPanelIds` | Unit reconcile case fails; E2E restart loses panel |
| Chat-host claim | Key claim by panel id instead of tab key | DOM duplicate-claim case fails |
| Reuse by identity | Key by title instead of identity key | Unit duplicate case fails; E2E duplicate-click creates two panels |
| Per-panel state | Share one module-level state object | DOM state-isolation case fails |
| File containment | Skip `resolveSafe` | Integration traversal/symlink cases fail |
| No write path | Add a write call in File Viewer | Source guard fails |
| Browser ADR gate | Implement before ADR | Documentation gate fails review |

Record the mutation, the failing command, and the reverted green run in the phase report.

---

## 4. Acceptance-criteria coverage

All `DP-01 … DP-16` from `CONTEXTUAL_WORKSPACE_IMPLEMENTATION_PLAN.md` §5 map to at least one future test above. No criterion is satisfied by a source-text guard alone. DP-09 and DP-15 may be deferred only by an approved ADR; a deferral is recorded, not silently assumed.

---

## 5. Quality gates for each phase

- `bun run typecheck` (four projects) exit 0.
- `bun run lint` (`--error-on-warnings`) exit 0.
- `bun run format:check` exit 0.
- `bun run test:locations` exit 0.
- `bun run build` exit 0.
- `bun run verify` exit 0 with exact counts recorded.
- `bun run test:e2e --project=chromium-headless dockview-workspace.spec.ts` exit 0 with exact counts recorded.
- `bun run security` where the phase touches file/browser/terminal surfaces.

Compilation or a passing count is not completion; the full diff must be reviewed and unrelated work preserved.
