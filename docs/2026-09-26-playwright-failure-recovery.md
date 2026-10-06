# Fix the failing Playwright specs — plan

**Status:** plan only, independently audited. No implementation yet.
**Date:** 2026-09-26
**Baseline:** `bunx playwright test` → **54 passed / 20 failed** (74 tests, 16 files; 10 failures per browser project).
**Workers:** no `workers` key in `web/playwright.config.ts`; Playwright's default is 50% of logical CPUs, which is 4 on this 8-core machine. `fullyParallel: false` serialises tests *within* a file, not across files.

> **Audit correction.** A first draft of this plan carried four wrong claims. They are
> corrected below and marked **[corrected]**, because the wrong versions sent me down
> a dead end: the composer-menu fix I attempted failed, and the plan had misread why.

## Why this plan exists

`web/e2e/phase-4-first-send.spec.ts` contained the glob `"**/api/chat"` inside a
`/** */` block comment. The `*/` terminated the comment early, the file failed to
transform, and Playwright aborted collection of the whole suite — `bun run
test:e2e` reported **0 tests in 0 files**. Fixed in `dfb2142`; collection is now
74 tests in 16 files. Unblocking it exposed failures that had been invisible for as
long as the file was unloadable.

## Cluster A — the composer's right-click menu never opens (CONFIRMED, cause corrected)

**Symptom:** right-clicking the composer opens the **page** menu (`New Chat`,
`Toggle Sidebar`, `Toggle Status Bar`, `Open Settings`) and never the composer's own
menu, on both projects. Dead since `7d11e19` (2026-09-14), when
`composer-bar.spec.ts` and `ComposerContextMenu.tsx` landed together.

**Cause [corrected]:** `ComposerContextMenu` renders

```tsx
<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
```

and `children` is assistant-ui's `ComposerPrimitive.Unstable_TriggerPopoverRoot`,
which **renders no DOM** — it only returns context providers
(`TriggerPopoverRootContext.js:253-272`) and forwards no props. So every prop Radix's
`Slot` injects (`ref`, `onContextMenu`, `data-slot`) is **silently dropped**: the
composer's context-menu trigger does not exist in the DOM at all. The 74
`[data-slot="context-menu-trigger"]` elements I counted on the page all belong to
`SidebarThreadRow`, `FolderHeader`, `FolderConversationRow`, `TabStrip` and
`JobListItem` — none to the composer.

**Two claims from the first draft that were wrong:**

- *"assistant-ui calls `preventDefault()` on `contextmenu`"* — **false**. There are
  zero `contextmenu`/`onContextMenu` matches in `@assistant-ui/react@0.15.20/dist`.
  The `preventDefault` I captured from a minified `handleEvent` was **Radix's own
  trigger handler** (`react-context-menu@2.3.7` calls `handleOpen(event)` then
  `event.preventDefault()`), observed on one of the sidebar's triggers.
- *"Radix's `checkForDefaultPrevented` blocks the composer menu"* — the setting is
  real (`@radix-ui/primitive@1.1.7` defaults it to `true`) but **causally inert
  here**, because no trigger node renders to be blocked.

**Fix:** make the trigger a real DOM element that is a *descendant* of
`ComposerPrimitive.Root`, so its handler runs before the form's
`onContextMenu`/`stopPropagation` (which is what keeps the page menu suppressed).
Concretely, in `ComposerContextMenu.tsx` give the trigger a real element to adopt —
`asChild` around a `<div ref={boxRef}>` instead of `asChild` around a renderless
provider — and in `Composer.tsx` move `<ComposerContextMenu>` **inside**
`<ComposerPrimitive.Root>` so it wraps the input area rather than the whole form.

**Verification:** dispatch `contextmenu` on the textarea and assert a
`[data-slot="context-menu-content"]` appears containing `Cut`; assert the page
menu's `New Chat` item is still absent. Probe first, then the two specs.

## Cluster B — running dot never appears for a NEW chat [corrected]

**Cause:** `useConversationsList` (`web/src/features/sidebar/hooks/useConversationsList.ts:63-114`)
is a **one-shot fetch** with no post-send refetch. `refetch` is wired only to
`onMutate` (row rename/archive/delete) and to `recoveryEpoch`. After a first send
the brand-new conversation is not in the sidebar list, so **no `ThreadRunningDot` is
mounted at all** — the spec asserts on an element that does not exist.

**Secondary defect (real, keep in scope):** `useThreadListItemRunning`
(`web/src/components/ui/thread-running-dot.tsx:19-34`) resolves the item runtime in
`useMemo(..., [aui, remoteId])` and subscribes with
`runtime?.subscribe(onChange) ?? (() => {})`. For a row that mounts before its
thread is bound, the subscription is a **no-op**, so `useSyncExternalStore` never
re-renders. This would still bite after the list is fixed.

**Note:** the sidebar row list is deliberately NOT assistant-ui's — `Sidebar.test.tsx:35-49`
forbids `SidebarThreadRow` from depending on assistant-ui, yet `ThreadRunningDot`
reads `aui.threads`. Worth a decision, not a silent fix.

**Verify first, in one line:** add `await page.reload()` after the send. If the dot
appears, the list-freshness cause is confirmed and the memo theory is secondary.

## Cluster C — `phase-4-first-send` D1/D2 cleanup TypeError (CONFIRMED, cause corrected)

**Symptom:** `TypeError: undefined is not an object (evaluating 'page.request.delete')`.

**Cause [corrected]:** the first draft claimed `request` is a fixture and not a
property of `page`. **False** — `page.request` is a documented `Page` property
(`playwright-core@1.63.0/types/types.d.ts:5842`). The real defect is a type
confusion: `cleanupMarker` calls `rmConv(request, id)`
(`phase-4-first-send.spec.ts:68`) passing an **`APIRequestContext`**, but `rmConv`
dereferences `page.request.delete(...)` (`:43-45`). `APIRequestContext` has no
`.request`, so it is `undefined.delete`.

**Compounding:** the throw is inside a loop body, so it only fires when a previous
run left a marker-bearing conversation behind — making it **conditional and
self-perpetuating**. It happens in the `try` (`:133`) *and* the `finally` (`:137`),
so the `finally` throw replaces whatever the `try` produced. Every real assertion
is at `:121-130`, i.e. **before** the throw, so the assertions most likely passed.

**Fix:** make `rmConv` accept `APIRequestContext` and call `context.delete(...)`
directly. **Both D1 (`:68`) and D2 (`:190`/`:194`) use the same helper and are
exposed** — the first draft listed only D1.

## Cluster D — `phase-ua-d` D4 missing scratch directory (CONFIRMED)

`mkFolder` (`web/e2e/phase-ua-d.spec.ts:29-36`) documents that the path is
"pre-created on disk — registration requires a real dir". `D:\PM\ua-d-d2` exists
but **`ua-d-d4` does not**, and `src/routes/folders.ts:147-155` maps
`FolderRegistrationError("path_missing")` to **404**. `playwright.config.ts` has
**no `globalSetup`**, so nothing creates them.

**Fix:** a `globalSetup` that creates the scratch dirs (fixes the class, not the
instance), or have the spec create its own dir. Prefer `globalSetup`.

## Cluster E — self-perpetuating and shared-state spec bugs (CONFIRMED)

1. **`availability-recovery` leaks a conversation permanently.** It POSTs
   `/api/conversations` (`:27-30`) and **never deletes it** — no `finally`, no
   cleanup anywhere. Its only count assertion is
   `expect(data.threads).toHaveLength(1)` (`:76`), so after one full run the shared
   DB holds a "Known Conversation" forever and **every later full run fails**. This
   is the cheapest thing in the whole plan and plausibly explains its own failure.
   **Note [corrected]:** it never sends at all — it asserts the draft is kept and the
   URL is still `/chat/new` (`:56`,`:69`,`:70`). The first draft wrongly filed it
   under "first send".
2. **`newchat-flow` collides by reading, not writing.** It is documented read-only
   (`newchat-flow.spec.ts:9`) and creates nothing. It collides because it reads
   globally-shared state concurrently mutated by other workers and asserts an exact
   URL: it picks `threads[0]` (`:19`) while the sidebar's first row is an untitled
   "New Conversation", and it uses `status=all` (`:76`) where the sidebar uses
   `status=regular` (`Sidebar.tsx:228`).
3. **`phase-8-tabs` is `mode: "serial"`** (`phase-8-tabs-navigation.spec.ts:69`), so
   its single reported failure is a **file-level abort**, not the named test. "reload
   restores tabs/URL" (`:286`) is the **last** test in the file and the least likely
   to be the one that broke. Re-diagnose from the file's first failure.
4. **No `webServer` and no per-worker `DATA_DIR`**: the config attaches to whatever
   server the maintainer already runs (port from `data/port`), with its own
   `DATA_DIR`. So "run serially" fixes only within-run concurrency, **not** specs
   that pollute the persistent DB (item 1).

## Cluster F — `phase-ua-d` D2 is a sidebar assertion, not a send failure [corrected]

The first draft filed D2 under "sent text never appears". It **never sends**. Its
reported failure is `expect(activeRow).toHaveCount(1)` (`:233`) — a **sidebar
highlight/sort/DOM-shape** assertion; its other assertions read seeded history
(`:224`, `:238`). Likely shares Cluster E's causes, not Cluster C's.

## Cluster C′ — genuine first-send failures (STILL UNSTUDIED)

`phase-ua-d` D1 waits for `getByText('matrix check D1')`, which never appears, and
`composer-bar` send/stop fails on a gated `/api/chat` run. Whether these are one
cause or several is **not established**. The study must cover, in order:
`web/src/runtime.ts` (what the browser sends, how it binds the new thread) →
`src/routes/chat.ts` (admission, resumable stream id, first-message persistence) →
`src/lib/model-messages.ts` (`prepareModelMessages`) → `src/routes/conversations.ts`
(recently changed by the `clientRequestId` fix; confirm it is unrelated).

**Constraint:** do not change product behaviour to satisfy a test. If the product is
right and the test is stale, the test is what changes.

## Order of work

1. **Cluster E1** — `availability-recovery` cleanup. Cheapest, self-perpetuating, and
   it may clear its own failure.
2. **Cluster C** — `rmConv` type confusion. Two tests, unambiguous.
3. **Cluster D** — `globalSetup` for the scratch dirs. Fixes a class.
4. **Cluster A** — confirmed cause, concrete fix, probe before/after.
5. **Cluster B** — one-line reload probe to confirm list freshness, then fix.
6. **Cluster F / E2 / E3** — re-diagnose with the noise from steps 1-3 removed.
7. **Cluster C′** — study the API/SDK seam last, with the cleanest signal.

## Acceptance

- `bunx playwright test` → **0 failed**, reported per browser project.
- `bun run typecheck` → 0. `bun run build` → 0.
- `bun run test` stays green (1798 pass / 0 fail).
- Any spec change justified by a measured cause, never by "it went green".
- No cluster closed by deleting or loosening an assertion.
- Repeat the full e2e run **twice**: a spec that leaks persistent state must pass on
  the second run too. This is the check that would have caught E1 originally.

## Out of scope

- `web/e2e` is still excluded from typechecking (`web/tsconfig.json` includes only
  `["src"]`). Measured cost: 71 pre-existing type errors, nearly all from the
  `type Page = Parameters<Parameters<typeof test>[0]>[0]["page"]` idiom resolving
  to `never`. Separate task.
- The OpenCode V2 work in `docs/superpowers/plans/2026-09-25-opencode-v2-tool-pipeline.md`.
