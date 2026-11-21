# TBAi Canonical UI Architecture & Coherence Master Plan

**Document Path:** `docs/ui-foundation/canonical-ui-coherence-plan.md`  
**Author:** AI Project Architect  
**Status:** PROPOSED & READY FOR IMPLEMENTATION (Zero code changed)  
**Target Baseline:** Branch `review/managed-opencode-hardening-2026-11-15`  
**Permanent Development Policy:** Enforces `AGENTS.md` (no external runtime bloat, library-first, no color literals, frozen assistant-ui train).

---

## 1. Executive Vision & Problem Statement

### 1.1 The Problem with the Current State
TBAi’s UI has evolved organically across multiple features (Direct Chat, OpenCode Agent, Scheduler, MCP, Settings, Providers). This created visual fragmentation:
- **Inconsistent Edges**: Multiple disparate border opacities (`border-border/40`, `/50`, `/60`, `border-input`, `border-none`) with no clear visual hierarchy.
- **Weak Selection Contrast**: Active tabs, active sidebar items, and selected radio/options do not stand out clearly against inactive items.
- **Focus Ring Inconsistency**: Over 50 different interactive sites use varied outline offsets, ring opacities, and thicknesses, harming keyboard navigation.
- **Corner Radius Clashes**: Pill buttons (`rounded-4xl`), square inputs, and rounded popovers mix unevenly across screens.

### 1.2 Why the Previous Plan (`self-audit-and-plan.md`) Was Rejected
The earlier 12-phase plan proposed manually editing 80+ feature files across the codebase to swap out Tailwind classes for custom `--rule-*` CSS variables.
- **Anti-Pattern File Churn**: Manually touching 80 feature files is fragile, high-risk, and hard to maintain.
- **Violates Component Encapsulation**: In standard design systems, feature screens never manage their own border or focus rules; they consume base primitives.
- **Layout Breakage Risk**: Sweeping fluid spacing tokens (`--rule-space-N`) into layout containers (`AppShell.tsx`, `Sidebar.tsx`, chat scroll column) breaks pixel-calibrated desktop window chrome and scroll bounds.

---

## 2. Core Architectural Principles (Industry Standard)

This master plan follows the standard 3-tier architecture used by top applications (Linear, Raycast, Vercel):

```
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 1: Canonical Semantic Tokens (web/src/styles/globals.css)         │
│         Borders, Focus Rings, Elevation, and Surface Roles             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (Inherited by)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 2: Base UI Primitives (web/src/components/ui/ & surfaces.tsx)     │
│         Button, Input, Tab, Dialog, Popover, Badge, Dropdown           │
│         All hover, focus, active, & disabled states live here          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (Consumed by)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 3: Feature Surfaces (Chat, OpenCode, Scheduler, Settings)         │
│         Feature components ONLY compose Tier 2 primitives.             │
│         Zero custom border, focus, or interactive styling in features. │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Zero New Dependencies**: Zero new npm packages. No secondary CSS preprocessors.
2. **Zero Color Literals**: No hex (`#fff`), rgb, or oklch literals. All colors derive strictly from the active theme's CSS variables (`var(--border)`, `var(--foreground)`, `var(--ring)`, `var(--primary)`) via `color-mix`.
3. **Touch the Lego Bricks, Not the Whole House**: Changing 6 base primitives in `web/src/components/ui/` automatically cascades consistency across 40+ screens without touching 80 feature files.
4. **Shell & Chrome Immunity**: Window chrome (`window-chrome.ts`, `chrome-vars.ts`) and shell layout boundaries (`AppShell.tsx`) are strictly protected from fluid spacing changes.

---

## 3. Tier 1: Canonical Semantic Tokens

Defined centrally in `web/src/styles/globals.css` inside the existing `@layer base` and theme root. These tokens extend the existing Tailwind v4 theme without adding conflicting stylesheets.

```css
:root {
  /* --- 1. Edge & Border Roles (Derived from active theme --border) --- */
  --edge-subtle: color-mix(in srgb, var(--border) 40%, transparent); /* Inactive panels, dividers */
  --edge-default: var(--border);                                      /* Standard card & container bounds */
  --edge-strong: color-mix(in srgb, var(--border) 85%, var(--foreground) 15%); /* Active/focused containers */
  --edge-active: var(--primary);                                      /* Selected tab, active row indicator */

  /* --- 2. Focus & Keyboard Accessibility --- */
  --focus-ring: var(--ring);
  --focus-ring-offset: 2px;
  --focus-ring-width: 2px;

  /* --- 3. Interactive Touch & Click Floors --- */
  --target-min-size: 1.5rem; /* 24px floor for accessibility */

  /* --- 4. Elevation & Popover Surfaces --- */
  --elevation-low: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --elevation-medium: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  --elevation-modal: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);
}
```

---

## 4. Tier 2: Base Primitive Specifications

The 6 canonical files in `web/src/components/ui/` and `surfaces.tsx` that govern the entire app:

### 4.1 Buttons (`web/src/components/ui/button.tsx`)
- **Corners**: Standardize on `rounded-md` (or theme-driven `--radius`) instead of awkward `rounded-4xl` pill extremes.
- **Focus**: Unified `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`.
- **Target Floor**: All `icon-xs` / `icon-sm` sizes enforce a minimum click target of `min-h-[24px] min-w-[24px]`.
- **Active State**: Subtle physical press `active:scale-[0.98] motion-reduce:active:scale-100`.

### 4.2 Inputs & Textareas (`web/src/components/ui/input.tsx`, `textarea.tsx`)
- **Border**: Border uses `border-edge-default`, transitioning to `border-edge-strong` on hover.
- **Focus**: Clean outline with `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1`.
- **Height**: Standardized `min-h-[2.25rem]` (36px) across text inputs, selects, and pickers.

### 4.3 Tabs & Selection (`web/src/components/ui/tab.tsx` / `TabStrip.tsx`)
- **Inactive Tab**: Muted text, subtle border divider, transparent background.
- **Active Tab**: 
  - 100% foreground text brightness.
  - Distinct 2px high-contrast bottom border / accent marker (`border-primary` or `--edge-active`).
  - Subtle background fill (`bg-background` or `bg-muted/40`).

### 4.4 Modals, Dialogs & Popovers (`dialog.tsx`, `popover.tsx`, `dropdown-menu.tsx`)
- **Border**: Strict `border border-edge-default`.
- **Elevation**: Unified `--elevation-modal` (no dark halos in dark mode; relies on edge definition).
- **Radius**: Consistent `rounded-lg` derived from `--radius`.

### 4.5 Assistant-UI Shared Surfaces (`web/src/components/assistant-ui/elements/surfaces.tsx`)
- Standardize `paper`, `floating`, `field`, and `fieldInteractive` to consume `--edge-subtle` and `--edge-default`.
- Keep the `@assistant-ui/*` dependency train frozen and vendored element files untouched.

---

## 5. Implementation Roadmap (3 Safe, Verifiable Milestones)

Instead of 12 fragmented phases, this work is organized into 3 high-impact, low-risk milestones:

### Milestone 1: Token Foundation & Interactive Primitives (Immediate Impact)
- **Scope**:
  - Add canonical tokens to `web/src/styles/globals.css`.
  - Update `button.tsx`, `input.tsx`, `textarea.tsx`, and `surfaces.tsx`.
  - Update `TabStrip.tsx` active selection state.
- **Verification Gate**:
  - `bun run typecheck` exit 0.
  - `bun run lint` & `bun run format:check` exit 0.
  - `bun run test:dom` (all 878 DOM tests pass).
  - Visual proof: All buttons, text fields, and tabs across the app immediately align with unified borders and focus rings.

### Milestone 2: Overlay & Elevation Consistency
- **Scope**:
  - Standardize `dialog.tsx`, `popover.tsx`, `dropdown-menu.tsx`, and `context-menu.tsx`.
  - Verify high-contrast edges in both Light mode and Dark mode.
  - Ensure zero z-index conflicts (modals > dropdowns > sidebars > chat).
- **Verification Gate**:
  - Open command palette, provider dialog, and settings modals.
  - Confirm consistent elevation and clean boundary edges.

### Milestone 3: Route-Level Density & Alignment Audit
- **Scope**:
  - Inspect the 4 main application surfaces: Direct Chat, OpenCode Agent, Scheduler, and Settings.
  - Replace any lingering raw HTML buttons or ad-hoc custom borders with the Tier 2 primitives.
  - Ensure responsive viewport integrity down to 600px width.
- **Verification Gate**:
  - Full production build: `bun run build` exit 0.
  - End-to-end smoke test across all routes.

---

## 6. Edge Cases & Durability Guarantees

1. **Theme Diversity (23+ JSON Themes)**:
   - Uses `color-mix` with `var(--border)` and `var(--foreground)`. It works identically on pure black OLED themes, high-contrast themes, and pastel light themes.
2. **Accessibility & Reduced Motion**:
   - Focus rings conform to WCAG 2.1 AA (minimum 2px ring with 3:1 contrast).
   - All interactive scale effects include `motion-reduce:transition-none` and `motion-reduce:transform-none`.
3. **assistant-ui Frozen Train Compliance**:
   - Vendored assistant-ui elements (`approval-card.tsx`, `code-diff.tsx`, `terminal-block.tsx`) remain 100% byte-untouched. They inherit styles cleanly through `surfaces.tsx`.
4. **Desktop App Geometry Safety**:
   - Shell boundaries, title bar heights, and chat composer docks remain untouched. No layout jumping or scrollbar flickering.

---

## 7. Definition of Done

A milestone is only marked complete when:
- [ ] `bun run typecheck` exits 0 across all tsconfigs.
- [ ] `bun run lint` & `bun run format:check` exit 0.
- [ ] `bun run test:dom` passes 100% with real counts.
- [ ] `bun run build` succeeds without bundle or chunk errors.
- [ ] Active tabs and focus states are clearly distinguishable on both light and dark backgrounds.
