# History Window + Test Relocation — Findings Handoff

**Date:** 2026-10-10
**Status:** P2 **remains HOLD**. Nothing in this document is committed.
**Purpose:** park the state of the Direct history-window work and the test-relocation fallout
so the typecheck/test agent can finish first, then pick this up without re-deriving anything.

Two other efforts are running concurrently in this tree. Ownership is stated explicitly per
item so nothing gets done twice:

| Area | Owner | State |
|---|---|---|
| Typecheck remediation (`tests/tsconfig.*`, `tests/helpers/`, test relocation) | another agent | **in progress — do not touch** |
| This document's Part A (history window) | this agent | changes made, uncommitted |
| This document's Part B (E2E infra) | this agent | 2 uncommitted fixes, awaiting maintainer decision |

---

## Part A — Direct history window

### A1. Test J: unbounded click on a conditionally-rendered control — FIXED

**File:** `tests/e2e/history/p2-live-runtime.spec.ts`, test J.

**Defect.** J clicked "Scroll to bottom" with no timeout:

```ts
await page.getByRole("button", { name: /scroll to bottom/i }).click().catch(() => undefined);
```

That pill renders `null` when `atEnd && unseen === 0`
(`web/src/components/ScrollPill.tsx:59`) — i.e. exactly the state J reaches after paging to
the root. Playwright's default `actionTimeout` is `0` (wait forever) and
`web/playwright.config.ts` sets none. The `.catch()` never fired because the call never
settled, so the test died on its own timeout reporting only `Test timeout exceeded` with **no
named action**.

**Diagnosis evidence (dose-response, same spec, same build hash, only `actionTimeout` varying):**

| `actionTimeout` | Result | Duration |
|---|---|---|
| 15s | PASS ×3 | 21.6s / 19.9s / 19.8s |
| 120s | PASS | ~126s |
| 0 (project default) | HANG ×2 | 300s, 180s |

Duration tracked `actionTimeout` almost exactly (+~5s of real work) — the signature of one
action consuming its whole allowance, failing, being swallowed by `.catch()`, then the
remaining assertions passing.

**Fix applied.** Replaced the click with a direct scroll on the scroller element itself
(`scroller(page).evaluate(el => { el.scrollTop = el.scrollHeight; })`) — the container is
unconditional and already mounted — plus a **stronger** assertion that the tip is the last
non-empty row. "Last non-empty" was measured, not guessed: the mounted shape is
`["", body-248, body-249", ""]`, so asserting on the literal last row would pin a
virtualization artefact instead of message order.

**Result:** 3.3s with the default config, three consecutive runs, plus two negative controls
(restoring the original click reproduces the hang; a wrong expectation fails with
`Received string: "concurrent-body-249"`).

### A2. Paging failures were completely silent — FIXED

This was a known, previously deferred finding. Two sites swallowed the failure.

**`web/src/features/chat/history/DirectViewportBridge.tsx` — `onLoadEarlier`:**

```ts
try {
  await loadEarlier();
} catch {
  // The controller is fail-closed and left the window untouched; the thread
  // still shows what it had, so there is nothing to recover here.
} finally { ... }
```

The comment rationalised the bug. Because the window is deliberately unchanged, a failed
"Load earlier" was **indistinguishable from a click that did nothing**: no message moved, no
row appeared, no log line, no retry.

**Fix:**
- `web/src/features/chat/history/useDirectHistoryWindow.ts` — `loadEarlier`'s catch now logs
  `history.page_load_failed` with the conversation id, at the failure site.
- `web/src/features/chat/history/DirectViewportBridge.tsx` — the catch now raises a `sonner`
  error toast.
- `web/src/config/history.ts` — new `copy.loadEarlierFailed` so no string is hardcoded in the
  component (per the no-hardcoding rule).

**Deliberate non-choice:** the existing `loadFailed` flag is **not** reused. That flag means
"the initial load never arrived" and drives a full-reload Retry row; setting it for a paging
failure would claim the whole history is unavailable while the transcript is plainly
populated — a false statement. The log event name is distinct for the same reason.

### A3. Dead retention fallback — DELETED

**File:** `web/src/adapters/threadHistoryAdapter.ts`.

The windowed `withFormat().load()` catch returned `retainedHistory(remoteId)`, which was
**unreachable in production**. Re-verified against current code before deleting:

1. `loadTip()` runs only when `controller.rows().length === 0`.
2. `lastGoodHistory` and the window controller are populated and dropped **together** —
   `invalidateHistoryCache()` clears both, and `dropWindowController` is reachable from
   nowhere else in `web/src` (grepped).
3. Therefore a conversation holding a retained projection also holds committed rows, so the
   fetch is skipped and the catch can never run.

`retainedHistory` there could only ever return `[]`, so replacing it with `{ messages: [] }`
is **behaviour-preserving**, not a semantic change. The stale comment above the cache — which
claimed a failed `load()` retains the previous projection — was corrected to state that the
retention serves only the base (unformatted) adapter's `load()`.

`retainedHistory` is still used by the base adapter (4 call sites), so nothing was orphaned.

### A4. Verification for Part A

| Check | Result |
|---|---|
| `tsc --noEmit` in `web/` | **0 errors** |
| biome on the 4 changed files | clean |
| DOM history + core | **105 pass / 0 fail** |
| `tests/unit/web/adapters` (incl. Phase 3 retention tests) | **49 pass / 0 fail** |
| full `bun run test:dom` | **425 pass / 0 fail** |
| E2E `p2-paging` | **2 passed** |
| E2E `p2-direct-history-window` | **1 passed** |
| E2E `p2-live-runtime` (incl. J and K) | **4 passed** |
| E2E `p2-history-load-recovery` | **9 passed** |

### A5. Open items in Part A

1. **No tests were written for A2/A3.** Per `AGENTS.md` this agent does not author test files.
   Needs, from the test agent:
   - a failed `loadEarlier` logs `history.page_load_failed` and does **not** set `loadFailed`;
   - the toast copy resolves from `historyConfig.copy.loadEarlierFailed`;
   - (optional) a guard that the deleted fallback stays gone.
2. **Surface decision, unresolved.** A transient toast was chosen for paging failure. A
   persistent inline retryable row is the alternative and is a different design — **needs a
   maintainer decision before building.**
3. **P2 is still HOLD.** Mandatory acceptance criteria are not all met, and the `e2e` CI job
   has **never executed**. P2 cannot be declared resolved on local evidence alone.

---

## Part B — Test relocation fallout (E2E was completely non-functional)

The tests-centralization migration moved specs from `web/e2e/` to `tests/e2e/` and bucketed
them into subdirectories. This broke E2E two separate ways.

### B1. Every spec failed to compile — 0 tests could run

**Root cause: module type, not path.** `web/package.json` declares `"type": "module"`; the root
`package.json` does not (so CommonJS). Playwright's transform branches on whether the file is
ESM (`node_modules/playwright/lib/common/index.js:1052-1074`), so it parsed every relocated
`.ts` spec as **plain JavaScript**:

```
BuildMessage: Expected "from" but found "{"     ← `import type {`
BuildMessage: Unexpected !                     ← `anchor!.key`
```

`bun build` transpiled the exact same files without complaint — only Playwright's CJS path
failed. Result: **all 28 spec files failed, "No tests found" in 0 files.**

**Fix applied:** new `tests/package.json` → `{ "type": "module" }`.
**Verified:** collection went `0 tests in 0 files` → `86 tests in 28 files`.

### B2. The E2E gate was silently green while running nothing — MOST DANGEROUS FINDING

`scripts/run-e2e.ts` → `specFiles()` used a **non-recursive** `fs.readdirSync(E2E_DIR)`.
Specs now live in subdirectories (`history/`, `core/`, `tools/`, …), so the `.spec.ts` filter
matched nothing and the runner reported:

```
[e2e] 0 spec file(s), project=chromium-headless, live=false
[e2e] spec files ok: 0, failed: 0          ← exit 0
```

A **green gate that executed zero tests**. This is precisely the silent-coverage-loss the new
`AGENTS.md` test-location rule exists to prevent — reintroduced by the runner meant to serve
it. Any regression, present or future, would have gone unnoticed.

**Fix applied:** recursive `collectSpecFiles()`.

### B3. Absolute Windows paths break Playwright's file matching

A sub-bug surfaced from the B2 fix: Playwright treats positional args as **regexes** matched
against each file's path. Absolute Windows paths are full of backslashes, which are regex
escapes, so every pattern failed → `No tests found` for all 28 files.

**Fix applied:** emit paths **relative to the E2E root, POSIX-separated**.

### B4. Verification for Part B

| Check | Result |
|---|---|
| `bun run test:e2e` | **24/28 spec files pass** (was 0/28) |
| `bun run test:locations` | OK |
| `bun run test` | 3946 pass / 43 skip / 0 fail |
| `bun run test:dom` | 425 pass / 0 fail |

**Two uncommitted edits exist for Part B and are awaiting a maintainer decision:**
`scripts/run-e2e.ts` (B2 + B3) and `tests/package.json` (B1). **Without them,
`bun run test:e2e` reports success while running zero tests.** Reverting them restores a
false-green gate.

---

## Part C — Typecheck remediation (owned by the other agent — NOT ours)

Recorded here only so the findings are not lost. **Do not act on this section from this
document; it belongs to the concurrent typecheck work.**

`bun run typecheck` failed with **434 errors** at the time of writing:
`tests/tsconfig.backend.json` = 152, `tests/tsconfig.web.json` = 282.

Identified root causes (four, independent):

1. **`tests/helpers/repo-root.ts:22` imports itself** —
   `import { REPO_ROOT } from "./repo-root";` inside `repo-root.ts`. Produces TS2395/TS2440
   plus TS2300 duplicate `REPO_ROOT` in every consuming test. A plain, unambiguous bug.
2. **`@assistant-ui/core` is not a declared dependency at all.**
   `tests/helpers/dom/audit-harness.ts` imports it; it is absent from both `package.json`
   files and resolves `MODULE_NOT_FOUND` from the repo root, from `web/`, and from
   `tests/`. It exists only as an unhoisted transitive of `@assistant-ui/react`. This
   directly violates `AGENTS.md`: *"Never rely on undeclared transitive dependencies."*
3. **The two-project split has no answer for mixed tests.**
   `tests/unit/mcp/mcp-connection.test.ts` imports both `@/db` (backend) and
   `@web/lib/mcpCopy.ts` (web). The backend project excludes it; the web project includes it,
   where `@/*` → `web/src/*`, so the backend imports cannot resolve. Neither project can
   typecheck it correctly. Its `exclude`/`include` lists are hand-maintained and had drifted.
4. **Lost path aliases.** `#ai-sdk-react`, `#deep-repo`, `#deep-convert` in
   `tests/spikes/p2-candidate-d/` resolve in no project.

Everything else (TS7006 implicit-any ×30, TS18046 unknown ×16, TS2351 not-constructable ×21,
TS6133 unused ×19) cascades from those unresolved modules and types. Fixing the four causes
should collapse most of the 434.

**Note for the decision record:** cause 2 is a *dependency decision*, not a mechanical fix. Per
`AGENTS.md` it needs recording in `docs/decisions.md`.

---

## Part D — Virtualization fallout (4 E2E specs still failing)

Not caused by the relocation — these are genuine UI assertion failures:

| Spec | Failure |
|---|---|
| `components/context-menu-spellcheck.spec.ts` | menu item renders `data-disabled` / `aria-disabled="true"` |
| `core/phase-ua-d.spec.ts` | `regenerate` button not visible; `getByText('seed check D2')` not visible |
| `tools/tool-body-budget.spec.ts` | `tool call` trigger not visible |

Common thread: a control or trigger that should be on screen is not. **Most likely fallout from
the concurrent TanStack Virtual migration — this is a hypothesis, not a finding.** Not
investigated.

### Interaction with the test J assertion

The J assertion added in A1 depends on two virtualizer behaviours:
- rendered DOM row order tracks logical order;
- the transcript mounts trailing rows with no text.

The second was **measured** (`["", body-248, body-249", ""]`), not assumed. If the virtualizer
changes how rows mount or order, that assertion needs revisiting.

### Correction to an earlier lead

A previously reported "65px-wide transcript scroller" suspicion about the history tests is
**withdrawn**. It was measured on an older build; the failure snapshot shows a normal,
populated transcript. Narrow-scroller layout is not implicated.

---

## Part E — Open decisions for the maintainer

1. Keep or revert the two Part B edits? (They gate whether E2E runs anything at all.)
2. Transient toast vs. persistent inline retryable row for paging failure (A5.2).
3. How to resolve `@assistant-ui/core` — declare it, or stop importing it (Part C.2)?
4. Should the 4 virtualization E2E failures (Part D) be triaged now or after the migration
   lands?
5. Resolve the `historyWindow.ts` questions in Part F before any cleanup is considered.

---

## Part F — `historyWindow.ts` dead-code investigation (2026-10-10, documentation only)

> **SUPERSEDED IN PART BY PART G (2026-10-10).** F0–F4 below are retained as the
> investigation record. The disposition that followed is in **Part G**: the invariant
> checker was made honest and given an enforcement point, the inaccurate anchors
> comment was corrected, and the stale `web/spikes/` artifacts were removed. Read
> Part G for the current state.

**No cleanup was performed in this part.** This part records an investigation and its open questions.
Nothing in `historyWindow.ts` was modified here.

### F0. Correction to an earlier recommendation in this session

An earlier verbal recommendation in this session was to **delete** `checkWindowInvariants`,
`totalWindowBytes`, `WindowSizer`, `ProtectedRegion`/`ViewportAnchor` and `"repositioning"`.
That recommendation was made on grep evidence alone and **it was wrong to state it as a
direction.** `docs/decisions.md:3868-3875` explicitly retains two of those symbols:

> `historyWindow.ts` is no longer frozen in its original form. Its page-merge and integrity
> responsibilities survive and are still needed: `buildCandidateWindow` (page merge on the
> shared anchor, branch-aware contiguity), `checkWindowInvariants`,
> `computeProtectedRegion`/`requestAnchorFor` for position restoration. What is retired is the
> DATA-EVICTION responsibility…

Treat F1–F3 as **questions to answer**, not as a deletion list.

### F1. The invariant checker reports constants for three of its five fields

**Verified** — `web/src/features/chat/history/historyWindow.ts:274-294`:

| Field | Line | How it is produced |
|---|---|---|
| `contiguous` | 278-284 | **Computed** — walks the window comparing `parentId` to the previous id |
| `chainOrdered` | 289 | Alias: literally `contiguous` again, not an independent check |
| `protectedContained` | 288 | **Hardcoded `true`** |
| `countBounded` | 290 | **Hardcoded `true`** |
| `bytesBounded` | 291 | **Hardcoded `true`** |
| `satisfied` | 292 | Alias: literally `contiguous` |

Why this is misleading: `WindowInvariantReport` (`:262-269`) reads like a verification result,
and three of its fields would report `true` for a window that violates the property they are
named after. A caller cannot distinguish "checked and passed" from "never checked".

**Verified** — the three constant fields have **no consumer anywhere** in the repository. A
repo-wide search for `protectedContained`, `countBounded`, `bytesBounded` returns matches only
in their own declaration and return site. `chainOrdered` is read exactly once, by a test
(`tests/unit/web/history/historyWindow.test.ts:323`).

**Verified** — `checkWindowInvariants` has **no production call site**. Repo-wide references are
its own definition (`historyWindow.ts:274`) and two calls in
`tests/unit/web/history/historyWindow.test.ts:319,329`.

**Verified** — those two tests assert only `satisfied`, `contiguous` and `chainOrdered`
(`:321-323`, `:331-332`). They therefore never detect the hardcoded fields, because they never
assert on them.

**Open question.** `docs/decisions.md:3871` names `checkWindowInvariants` as a surviving
responsibility, yet nothing in production calls it. Either the intended enforcement point was
never wired up, or the decision record is stale. **This must be resolved before the function is
judged dead** — the correct outcome may be to *wire it in*, not remove it.

### F2. Suspected remnants of the retired eviction design — candidates for review

**These are candidates only. No consumer or contract was read exhaustively for any of them,
and none of them is established as safe to delete.**

| Candidate | Location | What was actually verified |
|---|---|---|
| `WindowSizer` / `defaultWindowSizer` | `historyWindow.ts:86, 91` | **Verified:** parameters typed `WindowSizer` at `:248` (`commitWindow`) and `:276` (`checkWindowInvariants`) are named `_sizer` and are not referenced in either function body. **Verified:** no production consumer; referenced only by `totalWindowBytes` and by `tests/unit/web/history/historyWindow.test.ts:8,23,301`. |
| `totalWindowBytes` | `historyWindow.ts:161` | **Verified:** exported and called only from `tests/unit/web/history/historyWindow.test.ts:307`. No production consumer found. |
| `computeProtectedRegion` | — | **Verified: no longer exists in `web/src` at all.** Repo-wide it appears only in `tests/spikes/p2-candidate-d/scroll-harness/entry.tsx:41,390`, in the stale bundle (F4), and in `docs/decisions.md:3871`. **Open question:** the decision record retains it "for position restoration", so its removal from production source is either an unfinished gap or a stale decision. |
| `ProtectedRegion` / `ViewportAnchor` | `historyWindow.ts:47-61` | **Verified: NOT removable.** `windowController.ts:111` declares `export type Anchors = ProtectedRegion["active"]`, a live production type dependency. `viewportAnchor` consumers of the nested `active` shape exist at `windowController.ts:133,156,171,264`. |
| `"repositioning"` | `historyWindow.ts:41` | **Verified:** a member of the `WindowState` union that is never produced. `stateForActivity` (`:149-153`) returns only `"streaming"`, `"approval"` or `"stable"`, and `commitWindow:252` is the only assignment to `state` in the module. No production or test code writes this value. |

**Open question — anchors are documented as required but are not supplied.**
`useDirectHistoryWindow.ts:40-42` states the controller's `anchors` "are REQUIRED and are only
ever filled from real DOM measurement". However the production construction site
`ensureWindowController` (`useDirectHistoryWindow.ts:137-161`) passes **no** `anchors` option, so
`windowController.ts:171` falls back to `() => ({ top: null, bottom: null })`. Either the comment
is wrong or the measurement wiring is missing. This is unresolved and is a candidate cause of
position-restoration behaviour, not just a tidiness issue.

### F3. Architectural context (investigator's assessment)

The current history design rests on four properties that match widely used practice:

- **Append-only logical buffer** — older pages are prepended, never evicted
  (`historyWindow.ts:11-18`, and `docs/decisions.md:3863-3875`).
- **DOM virtualization owns the footprint bound**, not data eviction.
- **Stable persisted message identities** as the list key, so a prepend does not move rows.
- **Cursor-based paging** on the parent chain, via `requestAnchorFor` (`:230-236`).

The virtualization layer was separately checked against the TanStack Virtual published chat
composition and uses it as documented (`anchorTo: 'end'`, `followOnAppend`,
`scrollEndThreshold`, `measureElement`, stable `getItemKey`, loading state outside the
coordinate container — `web/src/components/VirtualizedTranscript.tsx:133-195`).

The concern is only that some **vocabulary and helper surface** of the retired eviction design
appears to remain. That is an assessment about tidiness and drift, **not** proof that every
symbol listed in F2 is obsolete — `ProtectedRegion` is a live production type, and
`checkWindowInvariants` / `computeProtectedRegion` are named in `docs/decisions.md`.

### F4. Stale compiled artifact (reported, not acted on)

**Verified:** `web/spikes/p2-candidate-d/scroll-harness/bundle.js` is a committed-looking
compiled bundle that still contains the retired eviction implementation — `applyWindowConstraints`,
`computeProtectedRegion`, `messageLimit`, `byteLimit` (around lines 53486, 53624, 54349). It is
a build artifact sitting in a non-test source path, and it is a plausible contributor to the
Part C typecheck failures. **No action taken.**

### F5. Proposed direction — NOT approved, NOT implemented

**Status: proposed only.** No deletion, signature change or behavioural change has been made or
is authorised.

The *shape* of the investigation's suggestion is: remove genuinely obsolete accounting and
protected-region machinery, remove invariant fields that do not perform checks, and retain the
real contiguity check at the appropriate enforcement point.

**Before any future deletion is approved, all of the following are required:**

1. Read every relevant consumer and contract — grep is not consumer review.
2. Trace production call paths, not just search results.
3. Identify every test that relies on the existing API or its semantics.
4. Confirm the actual enforcement point for contiguity (see F1 — it may be missing, not dead).
5. Reconcile against `docs/decisions.md:3868-3875`, which currently retains
   `checkWindowInvariants` and `computeProtectedRegion`; that record must be updated or
   overridden deliberately, not silently contradicted.
6. Preserve the unrelated history remediation in Part A and all concurrent work.

---

---

## Part G — Disposition of the Part F findings (2026-10-10)

Everything below was **implemented and verified**, except where marked open.

### G0. What changed

| File | Change |
|---|---|
| `web/src/features/chat/history/historyWindow.ts` | `checkWindowInvariants` now returns only `{ contiguous, satisfied }`, both computed from one real walk. Removed `protectedContained`, `countBounded`, `bytesBounded` (hardcoded) and `chainOrdered` (a second name for `contiguous`). Dropped the unused `_sizer` parameter. |
| `web/src/features/chat/history/windowController.ts` | `#commit` now calls the checker on the **candidate before any state is assigned** and fails closed with `incomplete-slice` if the merge is holed. |
| `web/src/features/chat/history/useDirectHistoryWindow.ts` | Corrected the ownership comment: `anchors` are optional, defaulted to null, never supplied here, and nothing reads them. Records that prepend stability comes from TanStack, not anchors. |
| `web/spikes/p2-candidate-d/scroll-harness/*.js` | **Removed.** Two 2-month-old compiled bundles (2.19 MB + 2.48 MB, both dated 2026-08-10), pre-migration output of `build.ts`, which now writes to `tests/spikes/p2-candidate-d/scroll-harness/`. |
| `tests/unit/web/history/windowController.test.ts` | New `merged-window integrity` suite: the hole case, plus a normal prepend that must still be accepted. |
| `tests/unit/web/history/historyWindow.test.ts` | Dropped the assertion on the removed `chainOrdered` alias. |
| `tests/unit/web/adapters/threadHistoryAdapter.phase3.test.ts` | `[P2-01]` fixture now links its rows (`m2.parent_id = "m1"`). See G3. |
| `docs/decisions.md` | Amended the frozen-core decision to record the new enforcement point. |

### G1. The invariant gap was real — negative control

`buildCandidateWindow` joins a new page to the held window by **index offset from
the first shared id**. Neither it nor the backend's `contiguous` flag verifies the
interior links of the MERGED window. A page whose overlap id still exists but whose
links no longer line up — a branch changed under a retained window — produced a
window with a hole, which was committed and rendered.

**Negative control (executed):** with the guard disabled, the new test fails with
`rejects.toBeInstanceOf` → *"Received promise that resolved"* — the holed merge
commits silently. With the guard in place, all 46 tests in
`tests/unit/web/history` pass. The test discriminates.

### G2. Why one existing fixture had to change

`[P2-01]` built its slice as `m1(parent_id: null), m2(parent_id: null)` — two rows
with **no link between them**. That chain cannot come from the real backend:
`getWindowSlice` walks the parent chain recursively, so every row after the first
names the row before it. The fixture was latently invalid and passed only because
nothing verified the merged window. Linking the rows **strengthens** the test; no
assertion was weakened or removed.

### G3. Corrections to Part F

- **F4 was wrong.** `web/spikes/**` does **not** contribute to the typecheck
  failures. It is `.js`, no tsconfig includes it (the `spikes/**` globs in
  `tests/tsconfig.web.json` resolve to `tests/spikes/`), and `allowJs` is off
  everywhere. Nothing referenced it. It was policy cruft, not a build problem.
- **`checkWindowInvariants` was not merely unused — it was also unused *and*
  misleading.** Both halves are now resolved; the decision record's claim that the
  integrity responsibility "survives" is finally true.

### G4. Still open

- `computeProtectedRegion` is recorded in `docs/decisions.md` as surviving but
  **does not exist in `web/src`**. `tests/spikes/.../entry.tsx` still imports it, so
  that spike cannot typecheck. Completing or retiring the position-restoration path
  is a real decision, not a cleanup.
- `WindowSizer` / `defaultWindowSizer` / `totalWindowBytes` remain: they are no
  longer used by any *enforcement* path, but `totalWindowBytes` is exported and
  tested, and removing them is a separate API decision.
- `"repositioning"` remains a never-produced `WindowState` member.

---

## Working-tree hygiene

- **Nothing committed, pushed, stashed, reset, cleaned or discarded.**
- No changes to production behaviour beyond Part A. No changes to approval gates, providers,
  dependencies, or the assistant-ui train.
- `dist/web` was rebuilt by the E2E runner (build-first gate); build provenance verified fresh
  on every E2E run (`dist/web matches the current source`).
- Temporary diagnostic configs, probes and trace output live **outside** the repo under
  `%TEMP%\opencode\tbai-repro\`.
- Protected files (`docs/right-hand-workspace-audit.md`, `docs/right-hand-workspace-demo.html`)
  untouched.