# TBAi UI foundation — end-to-end self-audit and detailed plan

Date: 2026-11-18. This document is the result of auditing the six existing
`docs/ui-foundation/` artifacts against the actual repository, then producing a
detailed implementation plan. It is documentation only — no source code was
changed to produce it, and no phase of the plan has been executed.

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
2. **`rulebook.md` line 134 states a false claim** — "there is no
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

## Part 2 — Detailed plan

### Precondition (before any phase)

- Commit or set aside the uncommitted OpenCode recovery work and the concurrent
  source changes. Establish a clean, known base.
- Work in an isolated copy/worktree, not the working folder.
- Fix the three documentation defects above.

### Phase 0 — Wire the foundation

- **File:** `web/src/styles/globals.css` — import the promoted rulebook after
  `./themes.css` (line 29), before `@layer base` (502).
- **Verify:** typecheck, build; confirm zero visual change.
- **Rollback:** remove the import line.

### Phase 1 — Edges & selection (highest value)

- **Files:** `Composer.tsx`, `EnginePicker.tsx`, `PageTitleStrip.tsx`,
  `StatusBar.tsx`, `Sidebar.tsx`, `TabStrip.tsx`, `ui/button.tsx`, `ui/input.tsx`.
- **Change:** `border-border/40`, `/50`, full, `border-none` → `--rule-edge-muted`,
  `--rule-edge`, `--rule-edge-strong`. Active tab gets a strong bottom edge.
- **Verify:** typecheck, build, tests; screenshots of tab strip + composer in
  light/dark; confirm selected tab has a visible boundary.
- **Rollback:** revert files.

### Phase 2 — Focus, targets, reduced motion (accessibility)

- **Files:** all 57 focus sites, `ui/switch.tsx`, `ui/button.tsx`, `ui/input.tsx`,
  `ui/badge.tsx`, `ui/select.tsx`, `surfaces.tsx`.
- **Change:** one `--rule-focus-*` ring from `--ring`; keep focus visible; 24×24
  floor; add reduced-motion branch for new motion tokens.
- **Verify:** keyboard-tab every surface; measure no target below 24×24; emulate
  reduced motion; screenshots with focus shown.
- **Rollback:** revert files.

### Phase 3 — Elevation & surfaces

- **Files:** `Composer.tsx`, `ElicitationModal.tsx`, `ScrollPill.tsx`,
  `ui/popover.tsx`, `ui/dialog.tsx`, `AppToaster.tsx`.
- **Change:** `shadow-xs/sm` → `--rule-elevation-button/raised`; keep
  floating/overlay on existing theme tokens.
- **Verify:** typecheck, build; popover + dialog screenshots in both themes; no
  black halo in dark.
- **Rollback:** revert files.

### Phase 4 — Spacing

- **Files:** `Sidebar.tsx`, `AppShell.tsx`, chat column components, then remaining
  call sites in small batches.
- **Change:** Tailwind spacing → `--rule-space-N` where theme `--spacing` should
  take effect. Leave `window-chrome.ts`/`chrome-vars.ts` untouched.
- **Verify:** switch a theme with different spacing; confirm layout rescales;
  screenshots.
- **Rollback:** revert batch.

### Phase 5 — Typography roles

- **Files:** settings pages, `Sidebar.tsx`, message components, `ui/*` with raw
  `text-xs/sm`.
- **Change:** apply `.typography-*` size-only classes; font family/weight stay
  with appearance system.
- **Verify:** change appearance font size; confirm every role scales; screenshots
  at two font sizes.
- **Rollback:** revert batch.

### Phase 6 — Radius role mapping

- **Files:** `ui/button.tsx`, `input.tsx`, `popover.tsx`, `dialog.tsx`,
  `Sidebar.tsx`, `TabStrip.tsx`, card components.
- **Change:** map roles to existing derived steps via `--rule-radius-*` aliases.
  **Never change `--radius` or add a scale.** Reconcile `--sidebar-row-radius` if
  identical.
- **Verify:** switch between a rounded theme and `mono` (radius 0); confirm every
  surface follows.
- **Rollback:** revert batch.

### Phase 7 — Layering

- **Files:** `ui/popover.tsx`, `dialog.tsx`, `dropdown-menu.tsx`,
  `context-menu.tsx`, `AppToaster.tsx`, `CommandPalette.tsx`, `LeftEdgeChrome.tsx`.
- **Change:** raw `z-10/20/50` → `--rule-z-raised/overlay/modal`; keep relative
  order.
- **Verify:** dialog over popover over sidebar; stacking unchanged; screenshots.
- **Rollback:** revert files.

### Phase 8 — Motion

- **Files:** disclosure components, popover/dialog animations, `globals.css:437-439`.
- **Change:** durations → `--rule-motion-fast/base`, easing → `--rule-motion-easing`;
  reduced-motion collapses to zero; keep disclosure test pinned.
- **Verify:** disclosure-timing test; emulate reduced motion; popover open/close
  screenshots.
- **Rollback:** revert files + media query.

### Phase 9 — Iconography

- **Files:** `ui/button.tsx`, `tooltip-icon-button.tsx`, `PageTitleStrip.tsx`,
  `StatusBarQuickActions.tsx`, `OpenCodeChipShared.tsx`.
- **Change:** `--rule-icon-size-*` / `--rule-icon-stroke`; keep 24px target floor.
- **Verify:** icon rhythm consistent; targets ≥24×24; screenshots.
- **Rollback:** revert files.

### Phase 10 — States & patterns

- **Files:** `TabStrip.tsx`, `approval-card.tsx`, `ui/button.tsx`, `input.tsx`, all
  empty/loading/error surfaces.
- **Change:** loading state on Button/Input; unify `aria-invalid` on edge scale;
  empty/loading/error/confirmation use shared roles.
- **Verify:** default/hover/focus/selected/disabled/loading/error screenshots for
  one button, input, tab in both themes.
- **Rollback:** revert files.

### Phase 11 — Every surface sweep

- **Files:** all routes from `config/routes.ts` — chat, code, scheduler, archived,
  folders, memory, mcp, logs, quick-messages, providers, appearance, typography,
  workspace, opencode-config, desktop, theme-lab, keyboard-lab, plus `RouteError`,
  `HydrateFallback`, `IndexRedirect`.
- **Change:** apply the per-surface checklist, max two routes per review.
- **Verify:** full test suite with real counts; screenshot each route in light/dark;
  confirm four pattern families consistent.
- **Rollback:** revert batch; each route independent.

### Definition of done (every phase)

- typecheck exit 0, build exit 0, lint exit 0, tests with real pass/fail counts.
- Screenshots of every changed surface in light and dark.
- No color literals, no competing token scales, no new dependencies.
- OpenCode recovery files byte-for-byte unchanged.
- No phase starts until the previous one's checks pass.

### What you get

One coherent app: consistent look on every screen, visible selection, consistent
states, accessible focus/targets/motion, theme-correct tokens, and a maintainable
system for the future file tree, viewer, and browser.
