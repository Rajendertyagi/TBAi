# TBAi UI foundation audit (read-only)

Date: 2026-11-18. Scope: the non-color "skeleton" of the UI — typography, spacing,
radius, edges, elevation. Colors are owned by themes and are out of scope.

This audit is the evidence for `rulebook.css`. It lists what TBAi already has
before proposing anything new. No source file was changed to produce it.

## Reference: what OpenChamber does

From `D:\Temp\openchamber\packages\ui\src\styles\`:

- `design-system.css:961-1029` — one `@theme inline` block holds the whole
  non-color skeleton: `--font-weight-normal` (963), radius steps (965-970),
  semantic spacing aliases `--space-1..8` (973-978), z/transition tokens
  (981-985), and shadow-to-elevation mappings (989-992). The Tailwind spacing
  scale (995-1028) is rebuilt from `--spacing-N: calc(N * var(--padding-scale))`
  so one multiplier rescales the app.
- `design-system.css:16,21` — `--ui-regular-font-weight: 400`, `--padding-scale: 1`.
- `design-system.css:43-52` — semantic text sizes `--text-markdown`,
  `--text-code`, `--text-ui-header`, `--text-ui-section`, `--text-ui-label`,
  `--text-meta`, `--text-micro`, `--text-settings-page-title`.
- `design-system.css:57-64` — three edge strengths derived from one theme
  border variable: `--oc-edge-muted` (40%), `--oc-edge` (70%),
  `--oc-edge-strong` (100%) of `--interactive-border`.
- `design-system.css:66-94` — three elevation levels `--oc-elevation-button`,
  `--oc-elevation-raised`, `--oc-elevation-floating`, each a hairline ring plus
  soft shadows; `.dark` overrides at 148-171.
- `typography.css:1-34` — semantic classes (`.typography-markdown`,
  `.typography-code`, `.typography-ui-header`, `.typography-ui-section`,
  `.typography-ui-label`, `.typography-meta`, `.typography-micro`) that set
  **font-size only** (plus a rounded line-height), never a color.

The pattern to adopt: one named skeleton, semantic roles instead of raw values,
three edge strengths, three elevation levels, and everything derived from a
theme-controlled base so a theme change rescales the whole app.

## Group 1 — Typography

### Existing tokens (all theme/settings-controlled)

| Token | File:line | Controlled by |
|---|---|---|
| `--font-sans` | `web/src/styles/globals.css:38` | appearance setting via `typography.ts:543` (`root.style.setProperty`) |
| `--font-mono` | `globals.css:41` | static fallback stack |
| `--font-weight-base: 300` | `globals.css:46` | appearance setting via `typography.ts:548` |
| `--code-font-family` | `globals.css:47` | appearance setting via `typography.ts:550` |
| `--code-font-size: 13px` | `globals.css:49` | appearance setting via `typography.ts:551` |
| `--code-font-weight: 400` | `globals.css:50` | appearance setting via `typography.ts:555` |
| `--terminal-font-family` | `globals.css:51` | appearance setting via `typography.ts:557` |
| `--terminal-font-size: 12px` | `globals.css:53` | appearance setting via `typography.ts:558` |
| `--terminal-font-weight: 400` | `globals.css:54` | appearance setting via `typography.ts:562` |
| `--reading-line-height: 1.5` | `globals.css:55` | appearance setting via `typography.ts:564` |
| root `font-size: 93.75%` | `globals.css:58` | appearance setting via `typography.ts:544` |
| `@utility text-2xs` | `globals.css:291-293` | static, rem with a 9px floor |

`applyTypographyToDom` (`typography.ts:530-568`) is the single writer. SQLite is
authoritative; localStorage is a passive pre-paint cache.

### Gap

TBAi has **no semantic text-size roles** (no equivalent of OpenChamber's
`--text-ui-header` / `--text-meta` / `--text-micro`). Components therefore pick
raw Tailwind sizes (`text-xs`, `text-sm`, `text-[11px]`) per call site.

### Reuse vs new

Reuse `--font-sans`, `--font-weight-base`, `--code-font-*`, `--terminal-font-*`,
`--reading-line-height`, and the root font-size. Define **new semantic size
roles** (justified gap) in `rem` so they scale with the appearance-controlled
root size — never a fixed `px` and never a font family or weight literal.

## Group 2 — Spacing

### Existing tokens

| Token | File:line | Controlled by |
|---|---|---|
| `spacing` in `cssVars.theme` | `web/src/themes/Default.json:12` (`0.25rem`); present in all 24 theme JSONs | theme |
| `--radius` etc. | theme JSONs `cssVars.theme` | theme |
| `--sidebar-row-height: 30px` | `globals.css:148` | static geometry |
| `--sidebar-row-radius: 8px` | `globals.css:149` | static geometry |
| chrome geometry constants | `web/src/lib/window-chrome.ts:17-45` | static, published by `chrome-vars.ts:38-47` |

### Gap / inconsistency

`--spacing` is defined by every theme but **not consumed anywhere** in
`web/src` (grep for `var(--spacing)` returns zero hits). Components use Tailwind
spacing utilities (`p-3`, `gap-2`) that resolve against Tailwind's own scale, so
changing a theme's `spacing` has no effect. OpenChamber fixes this with
`--spacing-N: calc(N * var(--padding-scale))` and `--space-N` aliases.

### Reuse vs new

Reuse the theme's `--spacing` as the single base. Define `--space-1..8` aliases
derived from it. Do not hardcode px. TBAi has no `--padding-scale`; the rulebook
notes it as a future extension rather than inventing a competing multiplier.

## Group 3 — Radius

### Existing tokens (theme-controlled, derived — DO NOT REDEFINE)

| Token | File:line |
|---|---|
| `--radius: 0.625rem` | `globals.css:109` |
| `--radius-sm: calc(var(--radius) * 0.6)` | `globals.css:274` |
| `--radius-md: calc(var(--radius) * 0.8)` | `globals.css:275` |
| `--radius-lg: var(--radius)` | `globals.css:276` |
| `--radius-xl: calc(var(--radius) * 1.2)` | `globals.css:277` |
| `--radius-2xl: calc(var(--radius) * 1.6)` | `globals.css:278` |
| `--radius-3xl: calc(var(--radius) * 2)` | `globals.css:279` |
| `--radius-4xl: calc(var(--radius) * 2.6)` | `globals.css:280` |
| theme `radius` values | `themes/*.json` `cssVars.theme` (e.g. `vercel` 0.5rem, `mono` 0rem) |

### Inconsistency

Call sites pick different steps for the same role: buttons and inputs use
`rounded-4xl` (`components/ui/button.tsx:9`, `input.tsx:14`), popovers use
`rounded-xl` (`popover.tsx:26`), sidebar rows use
`rounded-[var(--sidebar-row-radius)]` (`Sidebar.tsx:342`, a separate 8px token),
tabs use `rounded-t-lg` (`TabStrip.tsx:160`). The scale itself is sound; the
mapping from role to step is not documented.

### Reuse vs new

**No new radius scale.** Document the existing derived scale and add only
semantic aliases that point at existing steps (aliases carry no new value).

## Group 4 — Edges

### Existing tokens

| Token | File:line | Controlled by |
|---|---|---|
| `--border` | `globals.css:93` (light), `globals.css:201` (dark) | theme |
| `--input` | `globals.css:94` / `201` | theme |
| `--sidebar-border` | `globals.css:102` / `210` | theme |
| `--card-outline` | `globals.css:119` / `219` | theme |
| `--card-soft` | `globals.css:118` / `218` | theme |

TBAi has **no equivalent of OpenChamber's `--interactive-border`** and no edge
strength scale.

### Inconsistency (the defect this group fixes)

Border weights and opacities are chosen ad hoc:

- `border-border/40` — `components/Composer.tsx:451`
- `border-border/50` — `components/EnginePicker.tsx:25`, `PageTitleStrip.tsx:33`
- `border-sidebar-border/50` — `components/StatusBar.tsx:79`
- full `border-border` — `components/ui/button.tsx:9`, `Sidebar.tsx:331`
- `border-none` on glass surfaces — `popover.tsx:26`, `Composer.tsx:509`

Active tab selection is conveyed by `bg-background` alone (`TabStrip.tsx:161-163`)
with no edge, so on a background-colored strip the selected tab has no visible
boundary. This is the "invisible selection border" problem.

### Reuse vs new

Reuse `--border` (theme-controlled) as the single color source. Define **three
new edge strengths** — muted / base / strong — as `color-mix` of `--border` with
`transparent`, mirroring OpenChamber's `--oc-edge-*` pattern. Justified gap: no
strength scale exists, and the ad hoc opacities above are the symptom.

## Group 5 — Elevation

### Existing tokens

| Token | File:line | Controlled by |
|---|---|---|
| `--elevation-floating` | `globals.css:132-134` (light), `228` (dark) | static geometry, theme-independent |
| `--elevation-overlay` | `globals.css:135` (light), `229` (dark) | static geometry |
| `--shadow-floating` | `globals.css:284` → `--elevation-floating` | alias |
| `--shadow-overlay` | `globals.css:285` → `--elevation-overlay` | alias |
| `--glass-blur/tint/saturation` | `globals.css:125-127` / `224-226` | static |
| `@utility glass-surface` | `globals.css:408-412` | derived from glass tokens |

### Inconsistency

There is no **button** or **raised** level — only floating and overlay. Call
sites fall back to Tailwind's `shadow-xs` / `shadow-sm` (`Composer.tsx:451`,
others), which are hardcoded black shadows unrelated to the theme. OpenChamber
has exactly three levels and maps Tailwind `shadow-sm/md/lg` onto them
(`design-system.css:989-992`).

### Reuse vs new

Reuse `--elevation-floating` and `--elevation-overlay` (and their `--shadow-*`
aliases). Define **two new levels** — button and raised — with geometry only,
color derived from theme variables via `color-mix`. Justified gap: the lower two
steps of the three-level ladder are missing.

## Summary: OpenChamber vs TBAi

| Concern | OpenChamber | TBAi today | Adopt |
|---|---|---|---|
| Skeleton location | one `@theme inline` block | scattered across `globals.css` + components | one rulebook artifact |
| Semantic text roles | `--text-*` + `.typography-*` classes | none; raw `text-xs/sm` | semantic size roles + size-only classes |
| Spacing | `--spacing-N` from `--padding-scale`, `--space-N` aliases | `--spacing` defined by themes but unused | derive `--space-N` from `--spacing` |
| Radius | fixed steps in `@theme` | derived scale from one `--radius` (better) | keep TBAi's scale; document role mapping |
| Edges | three `--oc-edge-*` strengths | ad hoc `/40`, `/50`, full, `border-none` | three strengths from `--border` |
| Elevation | three `--oc-elevation-*` levels | two (`floating`, `overlay`) | add button + raised, reuse the other two |

TBAi's radius derivation is already stronger than OpenChamber's and must be
preserved. The three things worth adopting are the semantic typography roles,
the spacing aliases that actually consume `--spacing`, and the three-step edge
and elevation ladders.

---

# Full UI/UX audit (six points + patterns + governance)

This section extends the five-group token audit above to the whole UI/UX scope.
It is still read-only: no source file was changed.

## Point 1 — Design identity

**What exists today.** TBAi is already dense and compact:

- root `font-size: 93.75%` (`globals.css:58`) and `--font-weight-base: 300`
  (`globals.css:46`) — thin, small default text, both appearance-controlled.
- hairline borders from theme `--border` (`globals.css:93/201`), with ad hoc
  opacity variants (`Composer.tsx:451` `/40`, `EnginePicker.tsx:25` `/50`).
- layered shadows via `--elevation-floating` / `--elevation-overlay`
  (`globals.css:132-135, 228-229`) and the glass surface utility
  (`globals.css:408-412`).
- compact chrome geometry: `--sidebar-row-height: 30px` (`globals.css:148`),
  `--title-bar-height` from `window-chrome.ts:17`.

**What would need to change.** The character is right; the *consistency* is not.
The same role gets different border opacities, different radius steps and
different shadow levels across surfaces. The rulebook's edge strengths,
elevation ladder and role aliases would make the identity repeatable without
changing its character. No change to font weight or density is proposed — those
are user settings.

## Point 2 — Layout & structure

| Surface | File:line | Sizing contract |
|---|---|---|
| App shell | `app/layout/AppShell.tsx:205` | title band `h-[var(--title-bar-height)]`, `border-b border-border glass-surface` |
| Sidebar | `components/Sidebar.tsx:130` | `w-[var(--sidebar-width,224px)]`, `border-r border-sidebar-border` |
| Activity rail | `components/ActivityBar.tsx:59` | `w-[var(--activity-bar-width)]`, `border-r border-sidebar-border` |
| Status bar | `components/StatusBar.tsx:79` | `h-8`, `border-t border-sidebar-border/50` |
| Tab strip | `components/TabStrip.tsx:160` | `rounded-t-lg`, `basis-48` tabs |
| Chat column | `globals.css` chat utilities | centred column from `--chat-column-width` |
| Composer | `components/Composer.tsx:451,509` | `rounded-xl border-border/40`, glass + `shadow-floating` |

**How they relate and resize.** `lib/window-chrome.ts:17-45` is the single
source of truth for chrome geometry; `lib/chrome-vars.ts:38-47` publishes it as
CSS variables (`--sidebar-width`, `--title-bar-height`, `--activity-bar-width`,
`--left-chrome-width`, `--right-chrome-reserve`, `--chat-column-width`).
Components consume `w-[var(--…)]` / `h-[var(--…)]` — no inline widths. This is a
good pattern and must be preserved.

**Inconsistency.** The sidebar uses a full `border-sidebar-border`, the status
bar uses `/50`, and the composer uses `border-border/40` — three different edge
weights for adjacent chrome. The tab strip's `basis-48` is a literal while the
rest of the chrome is variable-driven.

## Point 3 — Visual system (five verified + four added)

The five existing groups (typography, spacing, radius, edges, elevation) are
verified above. Four more were audited:

### Iconography

- Icons come from `lucide-react`; `components/ui/button.tsx:9` sets
  `[&_svg:not([class*='size-'])]:size-4` (16px) globally.
- `button.tsx:30` `icon-xs` uses `size-6` with `size-3` icons (24px target, 12px
  glyph).
- `features/opencode/OpenCodeChipShared.tsx:205` uses `strokeWidth="2"` while
  most lucide defaults are 1.5–2 — no shared stroke token.
- OpenChamber has no separate icon scale either; it relies on the button's
  `[&_svg]` rule. TBAi's gap is only the missing named sizes/stroke.

**Reuse vs new:** reuse lucide's default stroke and the button's existing
`[&_svg]` sizing. Define named icon sizes/stroke only as aliases so call sites
stop inventing `size-3` / `size-4` / `size-5` per component. No color.

### Motion

- Only one motion token exists: `--animation-duration: 200ms`
  (`globals.css:438`, `@utility aui-disclosure-timing`), pinned to a TS constant
  by a test.
- Components use Tailwind `animate-in/out` (`popover.tsx:27`) and `animate-pulse`
  (`TabStrip.tsx:171`, mermaid skeleton) with no shared duration/easing.
- Reduced motion is handled ad hoc per element: 27 `motion-reduce:` branches
  (mostly in vendored assistant-ui elements such as `surfaces.tsx` and
  `reasoning.tsx`). The gap is that these are not driven by a shared token, not
  that handling is absent. (Corrected from an earlier claim that grep returned
  zero hits — that pattern missed Tailwind's `motion-reduce:` variant.)
- OpenChamber has `--oc-motion-popup-duration/easing`, `-exit-duration`,
  `-layout-duration/easing` (`design-system.css:100-104`) and reduced-motion
  overrides in `typography.css:310-316`.

**Reuse vs new:** reuse `--animation-duration` as the base. Define named
duration/easing aliases and a reduced-motion contract. No color.

### Focus

- 56 `focus-visible:ring/outline` call sites and 35 `outline-none` across
  `web/src`; ring widths vary (`ring-1`, `ring-2`, `ring-[3px]`).
- `--ring` is theme-controlled (`globals.css:95/203`) and already exposed as
  `--color-ring` (`globals.css:263`).
- OpenChamber deliberately removes rings (`:focus-visible { outline: none }`,
  `design-system.css:824-838`) and uses a hover fill instead. **Do not copy that
  part** — TBAi must keep a visible focus indicator for accessibility. Adopt the
  *single named ring* idea, not the removal.

**Reuse vs new:** reuse `--ring`. Define one focus width/offset alias so every
control uses the same visible indicator. Color comes from `--ring`, never a
literal.

### Layering (z-index)

- Raw values in use: `z-50` (24 call sites), `z-10` (9), `z-20` (1), `z-0` (1).
- No named z scale in TBAi. OpenChamber has `--z-base/raised/overlay/modal`
  (`design-system.css:981-984`).

**Reuse vs new:** define a four-step named z scale mirroring OpenChamber. These
are numbers, not colors. No existing scale to reuse, so this is a justified new
group.

## Point 4 — Components and their states

| Component | File | Current states | Inconsistency |
|---|---|---|---|
| Button | `components/ui/button.tsx:8-40` | default/outline/secondary/ghost/destructive/link; xs/sm/default/lg/icon sizes | `rounded-4xl` for every button; `focus-visible:ring-[3px]`; no loading state |
| Input | `components/ui/input.tsx:14` | default, focus, aria-invalid, disabled, read-only | `rounded-4xl`, `ring-[3px]`, `bg-input/30` |
| Card surfaces | `globals.css:118-119, 218-219` | `--card-soft` + `--card-outline` | borderless by design; no named raised level |
| Dialog | `components/ui/dialog.tsx` | open/close | uses `shadow-overlay`; radius step differs from popover |
| Popover | `components/ui/popover.tsx:26` | open/close | `rounded-xl`, `border-none`, `shadow-floating` |
| Menus | `context-menu.tsx`, `dropdown-menu.tsx` | highlighted, disabled, submenu | shortcut text uses `tracking-wide/widest` literals (`context-menu.tsx:143`, `dropdown-menu.tsx:203`) |
| Tabs | `TabStrip.tsx:152-164` | active/inactive/dragging | active has **no edge**, only `bg-background` |
| Badge | `components/ui/badge.tsx` | variants | small text sizes chosen per call site |
| Tool cards | `components/shared/approval-card.tsx` | default/selected | soft surface + outline tokens; no named elevation |

**Cross-cutting state gaps:** no loading state on Button/Input; error state is
`aria-invalid` with hardcoded destructive opacities; selected state is often
background-only (tabs, some rows), which is the invisible-border defect.

## Point 5 — States & interactions / accessibility

- **Invisible selection border:** active tab `TabStrip.tsx:161-163` uses
  `bg-background text-foreground` with no edge. On a background-colored strip
  the selection has no visible boundary. Fix: `--rule-edge-strong` bottom edge.
- **Visible focus:** 56 ring call sites with three different widths. Needs one
  named ring (`--rule-focus-*`) derived from `--ring`.
- **24×24 targets:** `size-6` / `icon-xs` (`button.tsx:30`,
  `tooltip-icon-button.tsx:26`, `PageTitleStrip.tsx:40`,
  `StatusBarQuickActions.tsx:45`) meet the 24px floor exactly — acceptable but
  at the boundary; do not shrink further.
- **Reduced motion:** handled ad hoc per element (27 `motion-reduce:` branches,
  mostly in vendored assistant-ui elements), not through a shared token. Give
  the new motion tokens a single `prefers-reduced-motion` branch that collapses
  them to zero.
- **Tracking:** `--tracking-normal` is defined in 25 theme JSONs but consumed
  nowhere; components use literal `tracking-tight/wide/wider/widest`
  (`surfaces.tsx:44`, `context-menu.tsx:143`, `dropdown-menu.tsx:203`,
  `CommandPalette.tsx:207`). Same defect class as `--spacing`.

## Point 6 — Every surface

Routes from `config/routes.ts:9-27` and `app/router.tsx:37-174`:

- Chat (`/chat/:threadId?`) and Code (`/code/:agentId?`) — the primary surfaces.
- Settings: providers, appearance, typography, workspace, opencode-config,
  desktop, memory, mcp, logs, folders, quick-messages (`routes.ts:33-46`).
- Scheduler, archived, theme-lab, keyboard-lab (`router.tsx:64-201`).
- Error surface: `RouteError` is the `errorElement` for four branches
  (`router.tsx:42,48,81,172`).
- Loading surface: `HydrateFallback.tsx`, `IndexRedirect.tsx:38-43`,
  `ThreadBootSkeleton.tsx`, mermaid skeleton.

The five-group rulebook was written for chat; every one of these surfaces must
be checked in the rollout (see the per-surface checklist in the plan).

## Patterns: empty / loading / error / confirmation

- **Empty:** `IndexRedirect.tsx:15` explicitly refuses to treat failed hydration
  as empty — good pattern. No shared empty-state component found.
- **Loading:** `HydrateFallback.tsx`, `ThreadBootSkeleton.tsx:11-23`,
  mermaid skeleton (`mermaid-diagram.tsx:390-394`) — several bespoke skeletons,
  no shared loading token beyond `animate-pulse`.
- **Error:** `RouteError.tsx:20` per route branch; no shared error-state visual.
- **Confirmation:** `components/shared/settings.tsx` and feature dialogs;
  `tool-fallback.tsx:47` documents confirm flows. No shared confirmation visual
  language.

**Gap:** four pattern families, four bespoke implementations. The rulebook does
not define pattern components (out of scope — it is tokens only), but the plan
must verify each pattern uses the same edge/elevation/typography roles.

## Governance

- **Where tokens live:** theme colors in `web/src/themes/*.json` → generated
  `styles/themes.css`; shape tokens in `styles/globals.css:33-286`; typography
  written to the DOM by `features/appearance/typography.ts:530-568`; chrome
  geometry in `lib/window-chrome.ts` → `lib/chrome-vars.ts`.
- **How a component is added:** `AGENTS.md:24-28` — minimum custom code, prefer
  `@assistant-ui/react`, shadcn/ui, Radix; `AGENTS.md:92` — `ChatWindow.tsx`
  uses assistant-ui primitives only; `AGENTS.md:114` — one feature per
  `web/src/features/<name>/`, shared settings grammar in
  `components/shared/settings.tsx`; no second router/state/UI framework.
- **Reuse-before-define:** stated in `AGENTS.md:24` and enforced here by the
  rulebook's `--rule-*` prefix and the "reuse vs new" verdict in every group.
- **Dependency integrity:** `AGENTS.md:49-75` — inspect the tree before adding
  anything; the assistant-ui train is frozen (`AGENTS.md:83`).

See `governance.md` for the short operating rules derived from this.

---

# Technical studies (A, B, C)

## Correction to an earlier finding

The Point 5 audit above said "no `prefers-reduced-motion` handling anywhere in
`web/src`". That was **wrong** — the grep pattern missed Tailwind's
`motion-reduce:` variant. There are **26** `motion-reduce:` usages, mostly in
vendored assistant-ui elements (`surfaces.tsx:17,20,23,26,33,40,52`,
`reasoning.tsx:182,191,213,282`, `agent-status.tsx:46`). The real gap is that
reduced motion is handled **ad hoc per element**, not through a shared token —
which is exactly what the rulebook's motion group addresses. The rulebook text
is correct; this audit line is corrected here.

## A. assistant-ui elements

### The constraint

- `AGENTS.md:83-85` — the assistant-ui dependency train is frozen. No
  `@assistant-ui/*` upgrade, downgrade, replacement or independent
  re-resolution without explicit compatibility review and approval.
- `AGENTS.md:92-93` — `ChatWindow.tsx` uses assistant-ui primitives only; no
  custom rendering of messages.
- `AGENTS.md:89-91` — `runtime.ts` is the only place that wires the chat
  transport to `/api/chat`.
- `AppShell.tsx:71-74,196-251` — hosts the root `AssistantRuntimeProvider`;
  Code mode isolates via `CodeShell` / `OpenCodeIsolationBoundary`
  (`<AuiProvider extends={null}>`). Do not change this boundary.

### Element inventory (26 files in `web/src/components/assistant-ui/elements/`)

**Vendored from the registry / upstream — DO NOT EDIT:**

| Element | Evidence | Note |
|---|---|---|
| `approval-card.tsx` | header:4-16 "Official assistant-ui Approval card element, vendored from the registry" | one adaptation: lucide icon names; carries `--card-soft`/`--card-outline` decisions |
| `code-diff.tsx` | header:4-24 "vendored from the registry"; two deliberate deviations (theming, copy) | keep byte-identical to upstream otherwise |
| `terminal-block.tsx` | header "vendored verbatim" | same icon-name adaptation as approval-card |
| `web-search.tsx` | header:4 "vendored from the registry" | registry URL recorded |
| `tool-fallback.tsx` | header "vendored into this repo" | default renderer for tools without a purpose-built element |
| `context-display.tsx` / `.aui.tsx` | header:2 "Vendored from assistant-ui (MIT) … verbatim" | Radix flavor; three documented adaptations |
| `mermaid-diagram.aui.tsx`, `shiki-highlighter.aui.tsx` | `.aui` wiring files | upstream adapters |

**App-owned / local adapter — restyleable with care:**

| Element | Role |
|---|---|
| `surfaces.tsx` | shared class constants (`paper`, `field`, `ghostButton`, `inkButton`, `pressable`, `collapsePanel`, `mono`) — the main restyle lever |
| `reasoning.tsx` / `.aui.tsx` | reasoning display; uses `--animation-duration` and `motion-reduce:` |
| `tool-group.tsx`, `tool-timeline.tsx`, `session-timeline.tsx` | tool presentation; `session-timeline.tsx` header says the mapping is "deliberately app-owned" |
| `code-budget.tsx` | app-owned wrapper that keeps the vendored highlighter byte-identical |
| `mermaid-source.tsx` | app-owned normalisation before the vendored renderer |
| `compaction-divider.tsx`, `progress-stages.tsx` | TBAi's own stream parts (`data-tbai-compact`, `data-tbai-progress`) |
| `agent-status.tsx`, `message-actions.tsx`, `thread-boot-skeleton.tsx`, `tooltip-icon-button.tsx` | app-owned presentation |

### What is restyleable, what is frozen, what is missing

- **Restyleable:** `surfaces.tsx` class constants, app-owned elements, and the
  `className` passed to vendored elements at their call sites. `data-slot`
  attributes exist on 12 elements (`tool-fallback.tsx` 16, `reasoning.tsx` 9,
  `mermaid-diagram.tsx` 8, `tool-group.tsx` 6, `context-display.tsx` 3, etc.) —
  these are stable CSS hooks that can be targeted without editing the element.
- **Frozen:** the vendored files themselves, the `@assistant-ui/*` versions, the
  runtime wiring in `runtime.ts`, and the provider boundary in `AppShell.tsx`.
- **Missing:** no single token layer for the elements — `surfaces.tsx` hardcodes
  `border-border/60`, `bg-foreground/[0.04]`, `duration-150`, `rounded-full`,
  `tracking-tight`. These are exactly the rulebook's edge, spacing, motion,
  radius and tracking groups.

### Which upgrade points are constrained

| Point | Constraint | Safe restyle path |
|---|---|---|
| Identity | low — character is in `surfaces.tsx` | change class constants, not vendored files |
| Layout | high — `AppShell` runtime provider + chrome vars | only chrome geometry tokens, never the provider |
| Visual system | medium — elements use their own class strings | target `data-slot` hooks and `surfaces.tsx`; keep `--animation-duration` |
| Components | high — vendored elements are frozen | restyle via `className` / `data-slot`, never edit the element |
| States | medium — Radix `data-*` states are upstream | add CSS for `data-[state=…]` / `data-[disabled]` on the hooks |
| Surfaces | medium — Code mode is isolated | restyle Direct surfaces; leave `OpenCodeIsolationBoundary` alone |

## B. shadcn/ui primitives (16 files)

| Primitive | cva variants | data-slot | States present | Missing / inconsistent | Rulebook group |
|---|---|---|---|---|---|
| `button.tsx:8-40` | 6 variants, 7 sizes | `button` | default, hover, focus, disabled, aria-invalid | no loading; `rounded-4xl`; `ring-[3px]` | radius, focus, edges, motion |
| `input.tsx:14` | none | `input` | default, focus, disabled, read-only, aria-invalid | no loading; `rounded-4xl` vs textarea `rounded-xl` | radius, edges, focus |
| `textarea.tsx:14` | none | `textarea` | default, focus, disabled, aria-invalid | `rounded-xl` (differs from input); no loading | radius, edges |
| `badge.tsx:8-30` | 6 variants | `badge`, `data-variant` | default, hover (link), focus, aria-invalid | `rounded-4xl`; `ring-[3px]` | radius, focus, typography |
| `select.tsx` | 10 cva sites | `select*` | open, selected, disabled, invalid | raw `rounded-[6px]`; `ring-[3px]` | radius, focus, edges |
| `dialog.tsx` | 10 cva sites | `dialog*` | open/close, overlay | `shadow-overlay`; radius step differs from popover | elevation, radius, layering |
| `alert-dialog.tsx` | 9 cva sites | `alert-dialog*` | open/close, destructive | same as dialog | elevation, layering |
| `popover.tsx:26` | 3 cva sites | `popover*` | open/close | `rounded-xl`, `border-none`, `shadow-floating` | radius, edges, elevation |
| `dropdown-menu.tsx` | 14 cva sites | `dropdown-menu*` | highlighted, disabled, submenu open, destructive | `rounded-[6px]`; `tracking-widest` shortcut | radius, focus, tracking |
| `context-menu.tsx` | 9 cva sites | `context-menu*` | highlighted, disabled, submenu | `tracking-wide` shortcut | radius, focus, tracking |
| `tabs` (via app `TabStrip.tsx:152-164`) | none | — | active, inactive, dragging | active has **no edge** | edges, focus |
| `switch.tsx:20-45` | none (hand-rolled, dependency-free) | none | checked, disabled | no focus ring; `h-5 w-9` literal | focus, motion |
| `tooltip.tsx` | 4 cva sites | `tooltip*` | open/close | z-index literal | layering |
| `collapsible.tsx` | 3 cva sites | `collapsible*` | open/closed | uses `--animation-duration` already | motion |
| `marker.tsx` | 5 cva sites | `marker*` | default | — | typography |
| `thread-last-message-time.tsx`, `thread-running-dot.tsx` | none | — | running/idle | — | typography, motion |

**Cross-cutting:** `data-slot` is consistently present (shadcn convention) and is
the safe CSS hook. `focus-visible:ring-[3px]` appears on button, input, badge and
select — four different call sites with the same raw value. No primitive has a
loading state. `switch.tsx` is deliberately dependency-free and has no focus
ring — an accessibility gap.

## C. Tailwind v4 mechanism (verified)

From `web/src/styles/globals.css`:

- `@import "tailwindcss"` (line 1), theme imports (2-29), `@custom-variant dark`
  (31). There is **no `repo-tokens.css` in TBAi** — that file exists only in the
  sandbox repo. TBAi's bridge is the `@theme inline` block at line 234.
- `@theme inline` (234-286) maps existing CSS variables into Tailwind namespaces:
  `--font-sans: var(--font-sans)` (235), `--color-*: var(--*)` (236-273), the
  derived radius scale (274-280), and `--shadow-floating/overlay` (284-285).
  Because it is `inline`, the values are inlined into generated utilities and
  the variables are **not** re-emitted — the source variables in `:root` remain
  authoritative.
- `@utility` (291-500) defines real utilities: `text-2xs` (291), `text-3xs`
  (298), `folder-tile` (305), `sidebar-row-surface` (368), `glass-surface` (408),
  `aui-disclosure-timing` (437), `glass-arrow` (441). These are the pattern for
  any new rulebook utility.
- `@layer base` (502) holds element defaults.

**Which rulebook tokens can become utilities:** the ones that map to a Tailwind
namespace — text sizes (`--text-*` → `text-*`), radius (`--radius-*` →
`rounded-*`), shadow (`--shadow-*` → `shadow-*`), spacing (`--spacing-*` →
`p-*`/`gap-*`), color (`--color-*` → `bg-*`/`text-*`). The rest must stay `:root`
variables consumed with `var()`: edge strengths, elevation geometry, focus ring
width/offset, z steps, icon sizes/stroke, motion durations/easing.

**The `@theme inline` circular-var trap (verified in the sandbox):** declaring
`@theme inline { --text-meta: var(--text-meta); }` where `--text-meta` is defined
in `:root` is self-referential. Tailwind emits the variable but generates **no**
`.text-meta` utility. The correct pattern is what `globals.css:235` does — map a
*differently named* source variable (`--font-sans` from the appearance system)
into the Tailwind namespace, or use plain `@theme` with a literal value when a
new scale is genuinely intended. The sandbox rulebook hit this exact failure and
switched to plain `@theme` plus an `@source inline(...)` safelist.

**Correct wiring point for a future pass:** import the promoted rulebook in
`globals.css` **after** `./themes.css` (line 29) so theme variables exist first,
and before `@layer base` (502). Do not add a second `@theme inline` block that
self-references its own declarations.
