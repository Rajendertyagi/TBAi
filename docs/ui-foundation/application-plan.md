# Rulebook application plan (NOT executed)

This plan describes how to apply `rulebook.css` in a later pass. Nothing here
has been done. No source file has been changed by this audit.

Ground rules for the eventual implementation:

- Apply one group at a time. Verify after each phase; do not batch.
- Never introduce a color literal. Every color comes from a theme variable.
- Never redefine an existing token. Aliases point at existing values.
- Do not touch the uncommitted OpenCode recovery work
  (`docs/2026-11-16-*`, `docs/opencode-context.md`,
  `src/services/opencode/serverManager.ts`, `tests/**`).
- Keep the change reviewable: a phase that touches more than one surface should
  be split.

## Phase 0 — Prepare the wiring point

**Surfaces/files:** `web/src/styles/globals.css` (import site only).

**Change:** decide where the rulebook will live once promoted from `docs/` to a
real stylesheet (candidate: `web/src/styles/rulebook.css`) and import it after
the theme import so theme variables are already defined. Keep the `--rule-*`
prefix until the names are agreed; do not rename existing tokens.

**Verification:** `bun run typecheck`, `bun run build`; confirm no visual change
(the file only declares variables and unused classes at this point).

**Rollback:** remove the single import line.

## Phase 1 — Edges (highest value, lowest risk)

**Surfaces:** composer, engine picker, page title strip, status bar, sidebar,
buttons/inputs, tab strip.

**Files:** `components/Composer.tsx`, `EnginePicker.tsx`, `PageTitleStrip.tsx`,
`StatusBar.tsx`, `Sidebar.tsx`, `TabStrip.tsx`, `components/ui/button.tsx`,
`input.tsx`.

**Change:** replace ad hoc `border-border/40`, `border-border/50`,
`border-sidebar-border/50`, full `border-border` and `border-none` with
`var(--rule-edge-muted)`, `var(--rule-edge)`, `var(--rule-edge-strong)` by role.
Give the active tab a `--rule-edge-strong` bottom edge so selection is visible
without relying on background alone.

**Verification:** typecheck, build, unit tests; screenshots of the tab strip and
composer in light and dark; confirm the selected tab has a visible boundary in
both themes.

**Rollback:** revert the listed files; the edge tokens are inert on their own.

## Phase 2 — Elevation

**Surfaces:** composer, popovers, dialogs, toasts, scroll pill.

**Files:** `components/Composer.tsx`, `ElicitationModal.tsx`, `ScrollPill.tsx`,
`components/ui/popover.tsx`, `dialog.tsx`, `components/AppToaster.tsx`.

**Change:** map `shadow-xs` / `shadow-sm` call sites to
`var(--rule-elevation-button)` or `var(--rule-elevation-raised)`; keep
`shadow-floating` / `shadow-overlay` where they already resolve to the existing
theme tokens. Do not add a new shadow literal.

**Verification:** typecheck, build; screenshots of a popover and a dialog in
both themes; confirm shadows follow the theme (no black halo in dark mode).

**Rollback:** revert the listed files.

## Phase 3 — Spacing

**Surfaces:** all padded/gapped surfaces, starting with the sidebar and chat
column.

**Files:** `components/Sidebar.tsx`, `app/layout/AppShell.tsx`, chat column
components, then the remaining call sites in small batches.

**Change:** replace Tailwind spacing utilities with `var(--rule-space-N)` where
the theme's `--spacing` should take effect. Keep chrome geometry
(`window-chrome.ts` / `chrome-vars.ts`) untouched — it is a separate, already
tokenized system.

**Verification:** typecheck, build; switch a theme whose `spacing` differs and
confirm layout actually rescales (this is the bug being fixed); screenshots in
both themes.

**Rollback:** revert the batch; spacing tokens are inert on their own.

## Phase 4 — Typography roles

**Surfaces:** settings pages, sidebar labels, message meta, code blocks.

**Files:** settings page components, `Sidebar.tsx`, message components,
`components/ui/*` where raw `text-xs/sm` appears.

**Change:** apply the `.typography-*` size-only classes. Do not set font family
or weight — those remain owned by the appearance system. Keep
`--code-font-size` / `--terminal-font-size` as the source for code roles.

**Verification:** typecheck, build; change the appearance font size and confirm
every role scales; screenshots in both themes and at two font sizes.

**Rollback:** revert the batch.

## Phase 5 — Radius role mapping

**Surfaces:** buttons, inputs, cards, popovers, sidebar rows, tabs.

**Files:** `components/ui/button.tsx`, `input.tsx`, `popover.tsx`, `dialog.tsx`,
`Sidebar.tsx`, `TabStrip.tsx`, card components.

**Change:** map roles to the existing derived steps via the role aliases
(`--rule-radius-control/surface/popover`). **Do not change `--radius` or add a
new radius scale.** Reconcile the separate `--sidebar-row-radius` token by
pointing it at the shared step if the visual result is identical.

**Verification:** typecheck, build; switch between a rounded theme and `mono`
(radius 0) and confirm every surface follows, including sidebar rows and tabs;
screenshots in both themes.

**Rollback:** revert the batch; the derived scale itself is never modified.

## Per-surface checklist

Use this for each phase; mark a surface done only when every applicable box is
checked in both light and dark.

- [ ] **Sidebar** — edge strength, row radius, label typography, spacing
- [ ] **Tab strip** — selected tab has a visible strong edge, radius step, label size
- [ ] **Chat** — message typography, spacing, no color literals introduced
- [ ] **Composer** — raised elevation, edge strength, radius, spacing
- [ ] **Status bar** — muted edge, meta typography, spacing
- [ ] **Settings pages** — semantic typography roles, spacing, edge strengths
- [ ] **Dialogs** — floating/overlay elevation, popover radius, edge strength
- [ ] **Tool cards** — soft surface + outline tokens, raised elevation, label size

## Global verification for the finished rollout

- `bun run typecheck` — exit 0
- `bun run build` — exit 0
- `bun run test` — real pass/fail counts recorded
- `bun run lint` — exit 0 with `--error-on-warnings`
- Screenshots: every surface in the checklist, light and dark, at desktop width
- Grep: no hex/oklch/rgb/hsl in the promoted rulebook; no `border-border/[0-9]`
  left in the listed call sites
- Confirm the uncommitted OpenCode recovery files are byte-for-byte unchanged

---

# Full-scope phases (six points + patterns + governance)

The phases above cover the five token groups. The phases below cover the rest
of the audited scope. All are **not executed**. Order is by risk: additive
tokens first, behavior-adjacent changes last.

## Phase 6 — Layering (additive, lowest risk)

**Surfaces/files:** every surface using raw `z-*` — popovers, dialogs, menus,
toasts, command palette, sidebar overlays. Key files: `components/ui/popover.tsx`,
`dialog.tsx`, `dropdown-menu.tsx`, `context-menu.tsx`, `components/AppToaster.tsx`,
`components/CommandPalette.tsx`, `components/LeftEdgeChrome.tsx`.

**Change:** replace raw `z-10/20/50` with `var(--rule-z-raised/overlay/modal)`.
Do not change the relative order — only the names.

**Verification:** typecheck, build; open a dialog over a popover over the sidebar
and confirm stacking is unchanged; screenshots in both themes.

**Rollback:** revert the listed files; z tokens are inert on their own.

## Phase 7 — Motion and reduced motion

**Surfaces/files:** disclosure components (reasoning, tool-group, tool-fallback),
popover/dialog animations, `animate-pulse` skeletons, `globals.css:437-439`.

**Change:** map durations to `--rule-motion-fast/base` and easing to
`--rule-motion-easing`. Add a `prefers-reduced-motion` branch that collapses the
new tokens to zero. Keep the existing disclosure test pinned to the same value.

**Verification:** typecheck, build, the disclosure-timing unit test; emulate
reduced motion in the browser and confirm no animation; screenshots of a
popover open/close in both themes.

**Rollback:** revert the listed files and the media query.

## Phase 8 — Iconography and focus

**Surfaces/files:** `components/ui/button.tsx`, `tooltip-icon-button.tsx`,
`PageTitleStrip.tsx`, `StatusBarQuickActions.tsx`,
`features/opencode/OpenCodeChipShared.tsx`, and all 56 focus-ring call sites.

**Change:** apply `--rule-icon-size-*` / `--rule-icon-stroke` to glyphs; keep the
24px target floor (`--rule-icon-target-min`). Replace `ring-1/2/[3px]` with one
`--rule-focus-*` ring derived from `--ring`. **Keep focus visible** — do not
adopt OpenChamber's ring removal.

**Verification:** typecheck, build; keyboard-tab every surface and confirm a
visible, consistent ring; measure that no interactive target is below 24×24;
screenshots in both themes with focus shown.

**Rollback:** revert the listed files.

## Phase 9 — States and accessibility

**Surfaces/files:** `TabStrip.tsx` (invisible selection), sidebar rows, tool
cards (`components/shared/approval-card.tsx`), Button/Input (loading/error),
all empty/loading/error surfaces.

**Change:** give the active tab a `--rule-edge-strong` bottom edge; add a
loading state to Button/Input using the motion tokens; unify `aria-invalid`
styling on the edge scale; verify every empty/loading/error surface uses the
same typography and spacing roles. No color literals.

**Verification:** typecheck, build, unit tests; keyboard and screen-reader pass
on the tab strip and a form; screenshots of default/hover/focus/selected/
disabled/loading/error for one button, one input and one tab in both themes.

**Rollback:** revert the listed files.

## Phase 10 — Every surface sweep

**Surfaces/files:** all routes from `config/routes.ts:9-27` and
`app/router.tsx:37-174` — chat, code, scheduler, archived, folders, memory, mcp,
logs, quick-messages, providers, appearance, typography, workspace,
opencode-config, desktop, theme-lab, keyboard-lab, plus `RouteError`,
`HydrateFallback`, `IndexRedirect`.

**Change:** apply the per-surface checklist below to each route in small
batches. Do not batch more than two routes per review.

**Verification:** typecheck, build, full test suite with real counts; screenshot
each route in light and dark at desktop width; confirm the four pattern
families (empty/loading/error/confirmation) use consistent roles.

**Rollback:** revert the batch; each route is independent.

## Expanded per-surface checklist

Mark a surface done only when every applicable box is checked in both themes.

- [ ] **Sidebar** — edge strength, row radius, label typography, spacing, focus ring
- [ ] **Tab strip** — selected tab has a visible strong edge, radius step, label size, 24px target
- [ ] **Chat** — message typography, spacing, no color literals, reduced motion
- [ ] **Composer** — raised elevation, edge strength, radius, spacing, loading state
- [ ] **Status bar** — muted edge, meta typography, spacing, icon sizes
- [ ] **Settings pages** — semantic typography roles, spacing, edge strengths, focus
- [ ] **Dialogs** — floating/overlay elevation, popover radius, edge strength, z step
- [ ] **Tool cards** — soft surface + outline tokens, raised elevation, label size, states
- [ ] **Activity rail** — icon sizes, 24px targets, focus ring, z step
- [ ] **Empty / loading / error / confirmation** — shared roles across all routes

## Governance checks for every phase

- Reuse before define: if an existing token covers the need, use it; do not add
  a competing scale (`AGENTS.md:24`).
- No new dependency; assistant-ui train stays frozen (`AGENTS.md:83`).
- No color literal in the rulebook or in component changes.
- No source file changed outside the phase's listed files.
- Uncommitted OpenCode recovery files remain byte-for-byte unchanged.
