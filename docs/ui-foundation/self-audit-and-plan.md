# TBAi UI foundation — end-to-end self-audit and updated plan

Date: 2026-11-18. This document is the result of auditing the six existing
`docs/ui-foundation/` artifacts against the actual repository, then producing an
updated implementation plan. It is documentation only — no source code was
changed to produce it, and no stage of the plan has been executed.

---

## Part 1 — Self-audit of our own work

### Claims verified against the code

| Claim | Verified |
|---|---|
| `motion-reduce:` usages | 27 (audit said 26 — drift from concurrent edits) |
| focus-visible ring/outline sites | 57 (audit said 56 — same drift) |
| `--tracking-normal` in themes | 25 ✅ |
| `var(--spacing)` consumers | 0 ✅ |
| Color literals in rulebook.css | 0 ✅ |
| No rulebook import in app | 0 ✅ |

### Defects found in our own documents

1. **`rulebook.md` has a duplicated heading** — "## What to do with this file"
   appears twice (line 166 empty, line 185 real). The first is a stray empty
   heading.
2. **`rulebook.md:134` states a false claim** — "there is no
   `prefers-reduced-motion` branch anywhere in `web/src`." This is wrong, and
   the document contradicts itself at line 175 ("26 `motion-reduce:` branches
   already exist"). The correction exists only in `audit.md`, not here.
3. **`audit.md` Point 5 (line 288) still states the false claim as fact** — the
   correction at line 412 discloses it, but a reader of Point 5 alone is misled.

These are documentation defects, not code. They should be fixed before anyone
relies on the docs. They have not been fixed here.

### Scope gaps in the plan itself

- No phase covers the **concurrent source changes** now in the repo
  (`ChatWindow.tsx`, `message-actions.tsx`, `agent-status.tsx`,
  `OpenCodePrimaryStatus.tsx`, tests). The plan assumes a clean base.
- No phase covers **settling the OpenCode work** — it is listed as a "do not
  touch" constraint, but there is no step to commit or set it aside first.
- The plan has **no explicit "definition of done"** per phase beyond the
  verification commands.

---

## Part 2 — Updated plan (4 stages)

### Preconditions (before Stage A)

1. **Set aside the uncommitted OpenCode work** — commit or stash it in
   coordination with its owner. Establish a clean, known base.
2. **Settle the concurrent source changes** (`ChatWindow.tsx`,
   `message-actions.tsx`, `agent-status.tsx`, `OpenCodePrimaryStatus.tsx`,
   related tests) so the base is stable.
3. **Use an isolated worktree** — never the working folder.
4. **Fix the three documentation errors** listed in Part 1.

### Protected — never touched

- OpenCode recovery files: `docs/2026-11-16-*`, `docs/opencode-context.md`,
  `src/services/opencode/serverManager.ts`, `tests/**`.
- Vendored assistant-ui elements: `approval-card.tsx`, `code-diff.tsx`,
  `terminal-block.tsx`, `web-search.tsx`, `tool-fallback.tsx`,
  `context-display.tsx`, `context-display.aui.tsx`, `mermaid-diagram.aui.tsx`,
  `shiki-highlighter.aui.tsx`.
- Window chrome and title bar geometry: `web/src/lib/window-chrome.ts`,
  `web/src/lib/chrome-vars.ts`.
- `@assistant-ui/*` versions (frozen train). No new dependencies. No color
  literals. Keep visible focus rings, 24×24 minimum targets, and reduced-motion
  support.

### Design decisions — no guessing

Corner roundness, spacing, and tab style come **only** from existing theme tokens
and the rulebook. Where the rulebook does not decide, the item is an **open
question** at the end of this document. No value is invented in this plan.

#### Resolved — tab style (was Open Question 1)

The active tab is marked by a **top accent line** and a **matching icon color**,
in the style of Microsoft Edge tabs. The shape already exists (rounded top
corners, active tab blends into content, close button on active/hover); only the
accent line and icon color are added.

- **Project color (tab belongs to a project):** use the folder's stored color.
  This is user data — a hex read from storage — so it is legitimate "data color"
  and must NOT be a theme token (the user picked it and it must survive theme
  changes). Same rule as the folder tile.
- **Default color (no project / no color set):** use the theme token
  `--muted-foreground`. It follows light/dark, reads as "no project color," and
  is already the inactive-tab text color. `--primary` is deliberately not used —
  it would make every plain chat look like an active accent.
- **One token for both** the top line and the icon — simple, as requested.
- **Data wiring:** `TabStrip` currently receives only `{ kind, ref }`. Stage B
  must resolve `conversation.workspaceFolderId → folder.color` and pass it in.
  The data exists (`types/index.ts:113,162`); it needs connecting.
- **Runtime value to CSS:** the tab element sets a CSS custom property carrying
  the resolved color (`--tab-accent: <folder color>` or `--muted-foreground` as
  fallback). This is explicitly allowed ("CSS custom properties carrying a
  runtime value") and is NOT a hardcoded color in a component.

#### Resolved — radius role mapping (was Open Question 2)

Buttons and inputs use the `radius-lg` step; cards and the composer use
`radius-xl`; popovers use `radius-xl`. These are aliases to the existing derived
scale (`globals.css:274-280`) — no new radius values, and `--radius` itself is
never changed. This replaces the current inconsistency (`rounded-4xl` on
buttons, `rounded-xl` on popovers, a separate 8px sidebar-row token).

#### Resolved — loading state (was Open Question 7)

Loading on Button and Input is disabled + dimmed with the existing shimmer/pulse
animation. No spinner, no new icon, no new dependency. Reuses `shimmer` /
`animate-pulse` / `--animation-duration`, consistent with the one-source motion
decision.

#### Resolved — motion (was Open Question 6)

Accept the existing `--animation-duration` (200ms) as the single source. Add only
named aliases that point to it — no new timing values. The app already has a test
pinning this value and 26 `motion-reduce:` branches; new durations would create
drift and break that test. Keep one source, add reduced-motion support around it.

#### Resolved — icon sizes (was Open Question 5)

Keep three named icon sizes (small / medium / large). Never raise the 24×24px
minimum click target — it is the WCAG 2.2 accessibility floor, and raising it
would make compact controls bulkier. The icon glyph may be small; the clickable
area stays at least 24×24.

#### Resolved — spacing scale (was Open Question 3)

Keep ONE scale — the 4/8px rhythm derived from the theme's `--spacing`. No
second or denser scale. Compact areas use the smaller steps (`space-1`,
`space-2`) rather than a new scale. This matches OpenChamber's single-scale
approach and avoids a competing system.

#### Settings scope decision

The settings web UI already controls colors (theme + palette pickers) and
typography (font, weight, size, line height). That is the right set and stays.

Do NOT add radius, edge, shadow, focus, motion, z-index or icon-size controls to
settings. These are design-system internals, not user preferences; exposing them
adds storage/sync/test complexity and lets a user break the coherence this
upgrade is meant to create. Project rules require minimum custom code and
configuration-first, not "expose every token."

No new density control. The app already exposes chat width
(Narrow/Comfortable/Wide), reading line spacing (Compact/Balanced/Relaxed), font
size, and window zoom — four ways to affect density. A fifth "Compact/Comfortable"
setting would create two competing "compact" concepts and add storage/sync/test
complexity for little benefit. Spacing tokens stay internal to the design system.

---

## Stage A — Foundation: connect the rulebook and lock all tokens

**Goal:** one central design system, defined once, complete. No partial rollout.

**Exact files:**
- `web/src/styles/rulebook.css` (new — promoted from `docs/ui-foundation/rulebook.css`, all nine token groups locked, `--rule-*` names finalized)
- `web/src/styles/globals.css` — import the rulebook after `./themes.css` (line 29), before `@layer base` (502); add the reduced-motion branch for the new motion tokens

**What changes:** the rulebook becomes a real stylesheet; every token is defined once; no component changes.

**Checks to run later:** `bun run typecheck`, `bun run build`; confirm zero visual change; confirm no color literals; confirm no self-referencing `@theme inline` declarations.

**Rollback:** remove the import line and delete the new stylesheet.

**Definition of done:** all nine groups present and locked; build green; no visual change; no color literals; protected files byte-identical.

---

## Stage B — Building blocks: each shared component finished in ONE pass

**Goal:** every shared component is completed completely — edges, focus, radius, spacing, text roles, icons, motion, and states — in a single pass per file. No component is revisited in a later stage.

**Exact files (each changed once, completely):**

*UI primitives:*
- `web/src/components/ui/button.tsx`
- `web/src/components/ui/input.tsx`
- `web/src/components/ui/textarea.tsx`
- `web/src/components/ui/badge.tsx`
- `web/src/components/ui/select.tsx`
- `web/src/components/ui/dialog.tsx`
- `web/src/components/ui/alert-dialog.tsx`
- `web/src/components/ui/popover.tsx`
- `web/src/components/ui/dropdown-menu.tsx`
- `web/src/components/ui/context-menu.tsx`
- `web/src/components/ui/tooltip.tsx`
- `web/src/components/ui/collapsible.tsx`
- `web/src/components/ui/switch.tsx`
- `web/src/components/ui/marker.tsx`

*Shared chrome:*
- `web/src/components/Composer.tsx`
- `web/src/components/Sidebar.tsx`
- `web/src/components/ActivityBar.tsx`
- `web/src/components/StatusBar.tsx`
- `web/src/components/TabStrip.tsx`
- `web/src/components/EnginePicker.tsx`
- `web/src/components/PageTitleStrip.tsx`
- `web/src/components/ScrollPill.tsx`
- `web/src/components/ElicitationModal.tsx`
- `web/src/components/AppToaster.tsx`
- `web/src/components/CommandPalette.tsx`
- `web/src/components/LeftEdgeChrome.tsx`
- `web/src/components/RightEdgeChrome.tsx`
- `web/src/components/WindowControls.tsx`
- `web/src/components/StatusBarQuickActions.tsx`
- `web/src/components/context-ring.tsx`
- `web/src/components/shared/settings.tsx`
- `web/src/components/shared/approval-card.tsx`
- `web/src/features/chat/components/ChatHeader.tsx`
- `web/src/features/chat/components/QuickActions.tsx`
- `web/src/components/composer/DirectChips.tsx`
- `web/src/features/opencode/OpenCodeChipShared.tsx`

*App-owned assistant-ui elements (restyleable; vendored ones excluded):*
- `web/src/components/assistant-ui/elements/surfaces.tsx`
- `web/src/components/assistant-ui/elements/reasoning.tsx`
- `web/src/components/assistant-ui/elements/tool-group.tsx`
- `web/src/components/assistant-ui/elements/tool-timeline.tsx`
- `web/src/components/assistant-ui/elements/session-timeline.tsx`
- `web/src/components/assistant-ui/elements/code-budget.tsx`
- `web/src/components/assistant-ui/elements/mermaid-source.tsx`
- `web/src/components/assistant-ui/elements/compaction-divider.tsx`
- `web/src/components/assistant-ui/elements/progress-stages.tsx`
- `web/src/components/assistant-ui/elements/agent-status.tsx`
- `web/src/components/assistant-ui/elements/message-actions.tsx`
- `web/src/components/assistant-ui/elements/thread-boot-skeleton.tsx`
- `web/src/components/assistant-ui/elements/tooltip-icon-button.tsx`

**What changes in each:** raw `border-border/40`, `/50`, `border-none` → edge roles; `ring-[3px]` and mixed ring widths → one focus role from `--ring`; `rounded-4xl`/`rounded-xl`/`rounded-[6px]` → radius roles; raw padding/gap → spacing roles; raw `text-xs/sm` → text roles; `size-3/4/5` and `strokeWidth="2"` → icon roles; `duration-150/200/300` → motion roles; raw `z-10/20/50` → z roles; `shadow-xs/sm` → elevation roles. Add missing loading state to Button/Input; give `switch.tsx` a visible focus ring. For `TabStrip.tsx`: add the top accent line and matching icon color using the resolved project color (or `--muted-foreground` default), with the data-wiring step described in the resolved tab decision. Keep focus visible, 24×24 targets, and reduced-motion branches.

**Checks to run later:** `bun run typecheck`, `bun run build`, `bun run lint`, `bun run test`; screenshots of default/hover/focus/selected/disabled/loading/error for one button, one input, one tab, in light and dark; keyboard-tab pass; target-size measurement; reduced-motion emulation.

**Rollback:** revert the Stage B files as one unit; Stage A tokens remain inert on their own.

**Definition of done:** every listed file uses only token roles; no raw color/radius/shadow/z/spacing values remain; all states present; accessibility checks pass; protected files byte-identical.

---

## Stage C — Screens: every route moves onto the building blocks

**Goal:** every route consumes the finished building blocks. No screen styles itself with raw values.

**Every route (from `config/routes.ts` and `app/router.tsx`):**

| Route | File |
|---|---|
| `/` (index redirect) | `web/src/app/IndexRedirect.tsx` |
| `/chat/:threadId?` | `web/src/features/chat/components/ChatView.tsx` |
| `/code/:agentId?` | `web/src/features/opencode/CodeShell.tsx` |
| `/scheduler` | `web/src/features/scheduler/SchedulerPage.tsx` |
| `/archived` | `web/src/features/sidebar/ArchivedPage.tsx` |
| `/memory` | `web/src/features/memories/components/MemoryPanel.tsx` |
| `/mcp` | `web/src/features/mcp/components/McpPanel.tsx` |
| `/logs` | `web/src/components/LogsPanel.tsx` |
| `/folders` | `web/src/features/folders/FoldersPage.tsx` |
| `/quick-messages` | `web/src/features/quick-messages/QuickMessagesPage.tsx` |
| `/providers` | `web/src/features/providers/ProvidersPage.tsx` |
| `/appearance` | `web/src/features/appearance/AppearancePage.tsx` |
| `/typography` | `web/src/features/appearance/TypographyPage.tsx` |
| `/desktop` | `web/src/features/desktop/DesktopSettings.tsx` |
| `/workspace` | `web/src/features/workspace/WorkspacePage.tsx` |
| `/opencode-config` | `web/src/features/opencode/OpenCodeConfigPage.tsx` |
| `/theme-lab` (DEV only) | `web/src/features/appearance/ThemeLab.tsx` |
| `/keyboard-lab` (DEV only) | `web/src/features/permissions/KeyboardLab.tsx` |
| error surface | `web/src/app/RouteError.tsx` |
| loading surface | `web/src/app/HydrateFallback.tsx` |
| `*` catch-all → `/` | no UI to restyle (navigation only) |

**What changes in each:** remove screen-local raw styling; consume the shared building blocks; use shared empty/loading/error/confirmation roles. Code mode (`/code`) is restyled on the Direct side only — the `OpenCodeIsolationBoundary` and runtime are untouched.

**Screenshots (required):** before **and** after for **every route above**, in **light and dark**, at desktop width. Before images are captured before any Stage C edit; after images after the route is migrated. The DEV-only routes (`/theme-lab`, `/keyboard-lab`) are excluded from the screenshot set because they are compiled out of production builds.

**Checks to run later:** `bun run typecheck`, `bun run build`, `bun run test` with real counts; screenshot every route in both themes; confirm the four pattern families use shared roles.

**Rollback:** revert routes in small batches; each route is independent.

**Definition of done:** every route uses only building blocks; before/after screenshots exist for every route in both themes; no raw styling remains in any screen; protected files byte-identical.

---

## Stage D — Guard and final verification

**Goal:** make the system self-enforcing so it cannot drift back.

**Exact files:**
- `tests/unit/web/ui-token-guard.test.ts` (new — the automatic guard)

**The guard, in plain language:** it is a spell-checker for styling. It reads every screen and shared component file and **fails the build** if it finds a color written by hand (hex/oklch/rgb/hsl), a hand-set corner radius (`rounded-[Npx]`), a raw z-index (`z-[N]`, `z-10/20/50`), a raw shadow (`shadow-[...]`, `shadow-xs/sm`), or raw spacing (`p-[Npx]`, `gap-[Npx]`) outside the token system. It has an allowlist for protected files and for the documented legitimate exceptions (measured geometry, interactive transforms, CSS custom properties carrying runtime values). If someone adds a raw value later, the build breaks and the change cannot land.

**Checks to run later:** `bun run typecheck`, `bun run build`, `bun run lint`, `bun run test`, `bun run test:locations`, `bun run test:dom`; prove the guard can fail by introducing a defect, watching it fail, then reverting; full screenshot set review.

**Rollback:** delete the guard test file; the design system itself is unaffected.

**Definition of done:** guard passes on the clean tree and demonstrably fails on an injected defect; all checks green with real numbers; every route has before/after screenshots in both themes; protected files byte-identical.

---

## File table — each file appears once

| File | Stage | Everything that changes in it |
|---|---|---|
| `web/src/styles/rulebook.css` (new) | A | All nine token groups defined and locked |
| `web/src/styles/globals.css` | A | Import rulebook; reduced-motion branch |
| `web/src/components/ui/button.tsx` | B | Edges, focus, radius, spacing, text, icons, motion, states (incl. loading) |
| `web/src/components/ui/input.tsx` | B | Same + loading state |
| `web/src/components/ui/textarea.tsx` | B | Edges, focus, radius, spacing, text |
| `web/src/components/ui/badge.tsx` | B | Edges, focus, radius, spacing, text |
| `web/src/components/ui/select.tsx` | B | Edges, focus, radius, spacing |
| `web/src/components/ui/dialog.tsx` | B | Elevation, radius, edges, z |
| `web/src/components/ui/alert-dialog.tsx` | B | Elevation, radius, edges, z |
| `web/src/components/ui/popover.tsx` | B | Elevation, radius, edges, z |
| `web/src/components/ui/dropdown-menu.tsx` | B | Radius, focus, tracking, z |
| `web/src/components/ui/context-menu.tsx` | B | Radius, focus, tracking, z |
| `web/src/components/ui/tooltip.tsx` | B | Elevation, z |
| `web/src/components/ui/collapsible.tsx` | B | Motion |
| `web/src/components/ui/switch.tsx` | B | Focus ring, motion |
| `web/src/components/ui/marker.tsx` | B | Text roles |
| `web/src/components/Composer.tsx` | B | Edges, elevation, radius, spacing, states |
| `web/src/components/Sidebar.tsx` | B | Edges, radius, spacing, text, focus |
| `web/src/components/ActivityBar.tsx` | B | Icons, targets, focus, z |
| `web/src/components/StatusBar.tsx` | B | Edges, text, spacing, icons |
| `web/src/components/TabStrip.tsx` | B | Top accent line + matching icon color (project color / `--muted-foreground` default), radius, text, target, data wiring |
| `web/src/components/EnginePicker.tsx` | B | Edges, focus |
| `web/src/components/PageTitleStrip.tsx` | B | Edges, icons, focus |
| `web/src/components/ScrollPill.tsx` | B | Elevation, z |
| `web/src/components/ElicitationModal.tsx` | B | Elevation, edges, z |
| `web/src/components/AppToaster.tsx` | B | Elevation, z |
| `web/src/components/CommandPalette.tsx` | B | Elevation, z, tracking |
| `web/src/components/LeftEdgeChrome.tsx` | B | Edges, z |
| `web/src/components/RightEdgeChrome.tsx` | B | Edges, z |
| `web/src/components/WindowControls.tsx` | B | Icons, targets, focus |
| `web/src/components/StatusBarQuickActions.tsx` | B | Icons, targets, focus |
| `web/src/components/context-ring.tsx` | B | Focus, text |
| `web/src/components/shared/settings.tsx` | B | Text, spacing, edges, states |
| `web/src/components/shared/approval-card.tsx` | B | Soft surface, outline, elevation, states |
| `web/src/features/chat/components/ChatHeader.tsx` | B | Focus, text, icons |
| `web/src/features/chat/components/QuickActions.tsx` | B | Focus, icons |
| `web/src/components/composer/DirectChips.tsx` | B | Focus, edges |
| `web/src/features/opencode/OpenCodeChipShared.tsx` | B | Icons, focus, stroke |
| `web/src/components/assistant-ui/elements/surfaces.tsx` | B | All shared class constants → token roles |
| `web/src/components/assistant-ui/elements/reasoning.tsx` | B | Motion, edges, text |
| `web/src/components/assistant-ui/elements/tool-group.tsx` | B | Motion, edges, text |
| `web/src/components/assistant-ui/elements/tool-timeline.tsx` | B | Motion, edges, text |
| `web/src/components/assistant-ui/elements/session-timeline.tsx` | B | Edges, text |
| `web/src/components/assistant-ui/elements/code-budget.tsx` | B | Text, spacing |
| `web/src/components/assistant-ui/elements/mermaid-source.tsx` | B | Text, spacing |
| `web/src/components/assistant-ui/elements/compaction-divider.tsx` | B | Focus, text |
| `web/src/components/assistant-ui/elements/progress-stages.tsx` | B | Text, spacing |
| `web/src/components/assistant-ui/elements/agent-status.tsx` | B | Motion, text |
| `web/src/components/assistant-ui/elements/message-actions.tsx` | B | Focus, icons |
| `web/src/components/assistant-ui/elements/thread-boot-skeleton.tsx` | B | Motion, spacing |
| `web/src/components/assistant-ui/elements/tooltip-icon-button.tsx` | B | Icons, targets, focus |
| `web/src/app/IndexRedirect.tsx` | C | Consume building blocks; empty/loading roles |
| `web/src/features/chat/components/ChatView.tsx` | C | Consume building blocks |
| `web/src/features/opencode/CodeShell.tsx` | C | Consume building blocks (Direct side only; isolation boundary untouched) |
| `web/src/features/scheduler/SchedulerPage.tsx` | C | Consume building blocks |
| `web/src/features/sidebar/ArchivedPage.tsx` | C | Consume building blocks |
| `web/src/features/memories/components/MemoryPanel.tsx` | C | Consume building blocks |
| `web/src/features/mcp/components/McpPanel.tsx` | C | Consume building blocks |
| `web/src/components/LogsPanel.tsx` | C | Consume building blocks |
| `web/src/features/folders/FoldersPage.tsx` | C | Consume building blocks |
| `web/src/features/quick-messages/QuickMessagesPage.tsx` | C | Consume building blocks |
| `web/src/features/providers/ProvidersPage.tsx` | C | Consume building blocks |
| `web/src/features/appearance/AppearancePage.tsx` | C | Consume building blocks |
| `web/src/features/appearance/TypographyPage.tsx` | C | Consume building blocks |
| `web/src/features/desktop/DesktopSettings.tsx` | C | Consume building blocks |
| `web/src/features/workspace/WorkspacePage.tsx` | C | Consume building blocks |
| `web/src/features/opencode/OpenCodeConfigPage.tsx` | C | Consume building blocks |
| `web/src/features/appearance/ThemeLab.tsx` | C | Consume building blocks (DEV only) |
| `web/src/features/permissions/KeyboardLab.tsx` | C | Consume building blocks (DEV only) |
| `web/src/app/RouteError.tsx` | C | Shared error-state roles |
| `web/src/app/HydrateFallback.tsx` | C | Shared loading-state roles |
| `tests/unit/web/ui-token-guard.test.ts` (new) | D | Automatic raw-value guard |

**Files appearing more than once: none.** This is intentional and required by rule 3(b): each shared component is finished completely in one pass in Stage B, and each screen is finished in one pass in Stage C. No file is revisited. If a later defect forces a second edit to a file, that is a deviation and must be flagged and justified in the stage report.

---

## Risk list

| What could break | How we would notice | How we would undo |
|---|---|---|
| A theme stops controlling radius/spacing/shadows | Theme-switch check in Stage A/C; screenshots across themes; a theme with radius 0 (`mono`) shows rounded corners | Revert the token mapping; re-point the role to the existing theme variable |
| Focus rings disappear or become inconsistent | Keyboard-tab pass in Stage B/D; guard test | Restore `--rule-focus-*` from `--ring`; keep `:focus-visible` |
| Click targets shrink below 24×24 | Target-size measurement in Stage B | Restore `size-6`/`icon-xs` floor |
| Motion runs for users who requested reduced motion | Reduced-motion emulation in Stage A/B/D | Restore the `prefers-reduced-motion` branch that collapses tokens to zero |
| Vendored assistant-ui element edited by mistake | Protected-file check in every stage; guard allowlist | Revert the file to its byte-identical upstream state |
| OpenCode recovery work overwritten | Protected-file check; git status before/after | Restore from the pre-work commit/stash |
| Window chrome geometry changes | Protected-file check on `window-chrome.ts`/`chrome-vars.ts` | Revert those files |
| Guard false-positives on legitimate inline styles | Guard fails on a clean tree; allowlist review | Add the documented exception to the allowlist with a reason |
| A screen keeps raw styling | Guard test fails; screenshot review | Migrate that screen to building blocks |
| New dependency introduced | Dependency check in every stage | Remove it; use the existing library |

---

## Open questions for you

1. ~~**Tab style** — resolved: top accent line + matching icon, project color from folder data, `--muted-foreground` default, Edge-like shape.~~
2. ~~**Radius roles** — resolved: buttons/inputs → `radius-lg`; cards/composer → `radius-xl`; popovers → `radius-xl`. Values come from the theme; only the role mapping was in question.~~
3. ~~**Spacing scale** — resolved: keep ONE scale (4/8px rhythm derived from the theme's `--spacing`). No second/denser scale. Compact areas use the smaller steps (`space-1`, `space-2`) rather than a new scale.~~
4. ~~**Density control** — resolved: NO new density control. The app already has chat width (Narrow/Comfortable/Wide), reading line spacing (Compact/Balanced/Relaxed), font size, and window zoom. A fifth "Compact/Comfortable" setting would create two competing "compact" concepts and add complexity for little benefit. Spacing tokens stay internal to the design system.~~
5. ~~**Icon sizes** — resolved: keep three named sizes (small/medium/large). Never raise the 24×24px minimum click target — it is the WCAG 2.2 accessibility floor, and raising it would make compact controls bulkier. The icon glyph may be small; the clickable area stays at least 24×24.~~
6. ~~**Motion durations** — resolved: accept the existing `--animation-duration` (200ms) as the single source. Add only named aliases that point to it — no new timing values. The app already has a test pinning this value and 26 `motion-reduce:` branches; new durations would create drift and break that test. Keep one source, add reduced-motion support around it.~~
7. ~~**Loading state** — resolved: disabled + dimmed with the existing shimmer/pulse animation. No spinner, no new icon, no new dependency. Reuses `shimmer` / `animate-pulse` / `--animation-duration`, consistent with the one-source motion decision.~~
8. ~~**DEV-only routes** — resolved: skip `/theme-lab` and `/keyboard-lab` in the before/after screenshot set. They are compiled out of production builds (`import.meta.env.DEV`), so no shipped user sees them. They remain listed in Stage C for consistency, but the screenshot requirement excludes them.~~
