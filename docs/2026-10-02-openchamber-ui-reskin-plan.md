# UI Restyle — Phase A (shapes) now, Phase B (colour) later

**Status:** plan only. Nothing implemented. No file in `D:\Temp\ai-chat-app` has been modified.

**Date:** 2026-10-02
**Revised:** scope split after review — shapes first, colours deferred.

**Target:** give TBAi the *shape* of the standalone OpenChamber preview page
(`index.html` from the 2026-10-02 session). **Colours are deliberately NOT part of this phase.**

---

## 1. What the maintainer will see, step by step

1. **Open the app.** Nothing about the colours has changed — the app looks the same as today in
   cream/grey terms. Same background, same highlights, same text.
2. **Look at the message box at the bottom, the left sidebar, and the top strip.** They are now
   faintly see-through, with a soft blur. You can sense the content behind them.
3. **Right-click a row, or open any dropdown or popover.** The **outline line around it is gone**.
   Only a soft shadow remains. Corners are rounder — 12px, matching the preview page.
4. **Hover a menu item.** A softly rounded highlight instead of a square-cornered one.
5. **Dialogs, the slash-command palette and the model picker.** Same treatment:
   no hard edge, soft shadow, rounder corners. (The model picker inherits it from
   the shared `DropdownMenu` primitive.)

**What does NOT change:** every colour, every screen, every button position, every menu item, the
right-click behaviour, the theme switch, and all data. Purely shape and surface.

---

## 2. Why Phase A is safe and independent

The app has **zero hardcoded colours in components** — every surface refers to a *named* colour
mapped in `web/src/styles/globals.css`. That is why a colour reskin could later be a values-only
change (§7).

Phase A does **not touch any colour token at all**. It only:

- **adds** three new token families (`--glass-*`, `--elevation-*`, plus a derived radius scale)
- **changes** which visual classes ~13 floating-surface files use

Because glass is built from `color-mix(... var(--popover) ...)`, it works with **any** palette —
including today's neutral greys. Phase A therefore does not lock in the later colour work.

---

## 3. Phase A detail

### 3.1 Corner radius — the preview page's 12px

The app's radius scale is currently **fixed numbers** (hardcoded). Replace with shadcn's documented
derived form so one number drives every corner:

```css
/* globals.css — inside @theme inline */
--radius-sm:  calc(var(--radius) * 0.6);
--radius-md:  calc(var(--radius) * 0.8);
--radius-lg:  var(--radius);
--radius-xl:  calc(var(--radius) * 1.2);   /* = 12px  ← preview page's menu/composer radius */
--radius-2xl: calc(var(--radius) * 1.6);
--radius-3xl: calc(var(--radius) * 2);
--radius-4xl: calc(var(--radius) * 2.6);
```

`--radius` stays at its current `0.625rem` (10px):

| Token | Before | After |
|---|---|---|
| `sm` | 4px | 6px |
| `md` | 6px | 8px |
| `lg` | 8px | 10px |
| **`xl`** | 12px | **12px (unchanged)** |
| `2xl` | 16px | 16px |
| `4xl` | 26px | 26px (unchanged) |

Only the three smallest steps grow slightly. Then the floating surfaces move to `rounded-xl`:

| Surface | Today | Becomes |
|---|---|---|
| Context menu | `rounded-xl` | unchanged ✓ |
| Dropdown menu | `rounded-md` | `rounded-xl` |
| Popover | `rounded-md` | `rounded-xl` |
| Dialog / Alert dialog | `rounded-lg` | `rounded-xl` |
| Select list | `rounded-2xl` | `rounded-xl` |
| Composer | `rounded-2xl` | `rounded-xl` |
| Slash-command palette (`/`) | `rounded-xl` | unchanged ✓ |
| Model picker (`Composer.tsx:185`) | via `DropdownMenu` primitive | inherited ✓ |
| Menu item | `rounded-lg` | `rounded-md` (softer, 8px) |

### 3.2 Elevation — borderless, soft shadow

The "outline" the maintainer disliked is `border border-border` on floating panels plus the
`shadow-xl shadow-black/*` ring on the context menu. Phase A removes the border and replaces the
shadow with a soft, ringless stack.

`--shadow-*` is a first-class Tailwind v4 namespace, so exposing elevation tokens yields **genuine
`shadow-floating` / `shadow-overlay` classes** that re-resolve per theme. No hand-rolled class.

```css
/* globals.css — new tokens, added without touching existing colours */
--elevation-floating: 0 1px 2px -1px rgb(0 0 0 / .10),
                      0 6px 14px -4px rgb(0 0 0 / .12),
                      0 18px 32px -10px rgb(0 0 0 / .16);   /* light */
--elevation-overlay:  0 2px 6px -2px rgb(0 0 0 / .10),
                      0 16px 32px -12px rgb(0 0 0 / .18);
.dark {
  --elevation-floating: 0 2px 6px -2px rgb(0 0 0 / .55),
                        0 10px 26px -8px rgb(0 0 0 / .60);
  --elevation-overlay:  0 4px 12px -4px rgb(0 0 0 / .65),
                        0 24px 48px -16px rgb(0 0 0 / .70);
}

@theme inline {
  --shadow-floating: var(--elevation-floating);
  --shadow-overlay:  var(--elevation-overlay);
}
```

**Tuning note for implementation:** in light mode the current panel colour is pure white on a white
background, so a shadow alone carries the edge. The light `--elevation-*` values above are
deliberately a little stronger than a typical menu; they must be checked visually and nudged if a
panel edge reads too faintly. This is the one spot where Phase A is a judgement call rather than a
mechanical change.

### 3.3 Glass

Tailwind v4's documented `@utility` directive — lands in the `utilities` layer, works with variants,
overridable by other utilities. No inline styles.

```css
@utility glass-surface {
  background-color: color-mix(in srgb, var(--popover) var(--glass-tint), transparent);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
}

@media (prefers-reduced-transparency: reduce) {
  .glass-surface {
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    background-color: var(--popover);
  }
}
```

Tokens (per theme; these are **new**, they do not replace anything):

| Token | Light | Dark |
|---|---|---|
| `--glass-blur` | `22px` | `26px` |
| `--glass-tint` | `50%` | `52%` |
| `--glass-saturation` | `1.24` | `1.16` |

Applied to: composer box, slash-command palette, sidebar, title-bar strip,
context menu, dropdown menu,
popover, select list, dialog, alert dialog, scroll pill.

---

## 4. Phase A files

### 4.1 Token layer — 1 file

| File | Change |
|---|---|
| `web/src/styles/globals.css` | **add** `--glass-*` and `--elevation-*` tokens in `:root` / `.dark`; **add** `glass-surface` `@utility` + reduced-transparency fallback; **add** `--shadow-floating` / `--shadow-overlay` to `@theme inline`; **replace** the fixed radius values with the derived scale |

No existing colour token is edited. `--card-soft`, `--card-outline`, `--border`, `--popover` and the
rest are left exactly as they are.

### 4.2 Floating surfaces — 10 core files

| File | Lines | Change |
|---|---|---|
| `web/src/components/ui/context-menu.tsx` ⚠️ | 31, 113 | drop `shadow-xl shadow-black/*` and the `bg-popover` tint → `glass-surface shadow-floating` |
| `web/src/components/ui/dropdown-menu.tsx` | 32, 201 | `border border-border bg-popover shadow-md` → `glass-surface shadow-floating rounded-xl` |
| `web/src/components/ui/popover.tsx` | 33 | same → `glass-surface shadow-floating rounded-xl` |
| `web/src/components/ui/select.tsx` | 71 | `bg-popover ring-1 shadow-2xl rounded-2xl` → `glass-surface shadow-floating rounded-xl` |
| `web/src/components/ui/dialog.tsx` | 60 | `border border-border bg-background shadow-lg` → `glass-surface shadow-overlay rounded-xl` |
| `web/src/components/ui/alert-dialog.tsx` | 57 | same as dialog |
| `web/src/components/Composer.tsx` | 599, 649 | box → `glass-surface shadow-floating rounded-xl`; the slash-command palette (the `/` trigger) likewise |

> **Correction (2026-10-03):** line 649 was originally recorded here as the
> "model picker list". It is not — it is the **slash-command palette**
> (`Unstable_TriggerPopover char="/"`). The real model picker is
> `Composer.tsx:185`, a `DropdownMenu`, so it inherits the glass surface from the
> shared primitive with no per-file work. The styling outcome was correct; only
> this description was wrong.
| `web/src/components/Sidebar.tsx` | 98 | `bg-sidebar` → `glass-surface` |
| `web/src/app/layout/AppShell.tsx` ⚠️ | 80, 86 | title-bar strip → `glass-surface` |
| `web/src/components/ScrollPill.tsx` | 51 | → `glass-surface shadow-floating rounded-full` |

⚠️ = already has uncommitted work in the working tree (see §8).

### 4.3 Optional polish — 5 files (skip to keep Phase A tight)

`web/src/components/ui/tooltip.tsx:45` · `web/src/components/ElicitationModal.tsx:71-72` ·
`web/src/features/opencode/OpenCodeChipShared.tsx:308` ·
`web/src/components/assistant-ui/elements/mermaid-diagram.tsx:244` ·
`web/src/main.tsx:7` (sonner `<Toaster>`)

### 4.4 Documentation

`docs/decisions.md` — ADR: *"Derived radius scale; elevation exposed as `--shadow-*` theme tokens;
glass as a Tailwind `@utility`. Phase A of a two-phase restyle; colour deferred to Phase B."*
Required by AGENTS.md §Documentation.

### Totals

**Phase A: 12 files** (1 CSS + 10 components + 1 doc) · **17** with optional polish.
**Zero** changes to any of the 15 app pages · **zero** colour-token changes.

---

## 5. What Phase A must not break

| Constraint | Source | How it is honoured |
|---|---|---|
| Token names must survive | `approval-card.test.tsx:49,110,322` asserts `bg-card-soft` / `ring-card-outline` and that the tokens are *declared*; `V2FormCard.test.tsx:314` expects `bg-card-soft` | No existing token renamed or removed. `--card-soft` / `--card-outline` untouched. |
| Menu text and `data-slot` attributes | `context-menu.tsx` docblock; e2e uses `exact: true` item names; a11y reads `aria-keyshortcuts` | Untouched. Only visual classes change. |
| Library-first | AGENTS.md §Core rules 1-2 | Radix stays. The preview page's hand-rolled menu engine is **not** copied over. |
| No hardcoded values, no inline styles | AGENTS.md §Engineering standards 1 | All new numbers in the token layer; `glass-surface` via `@utility`; no `style={{}}` introduced. |
| Extend, never duplicate | AGENTS.md §UI changes | No new component, route, dialog or page. |
| No behaviour change | maintainer instruction | Shape only. Right-click behaviour explicitly unchanged. |

---

## 6. Verification (AGENTS.md §Definition of DONE)

1. `bun run typecheck` — exit 0, re-run independently.
2. `bun run build` — exit 0, re-run independently.
3. Full test suite — report actual suite/case numbers, not "should be fine".
4. **Visual check for the maintainer to confirm** — launch the app and screenshot:
   - light **and** dark, chat screen
   - settings → Appearance, confirming the toggle still works
   - one right-click menu open, one dropdown open, one dialog open
   - the **edge legibility check** from §3.2: is a white panel on a white background clearly
     separable? If not, nudge `--elevation-*` in light only.

---

## 7. Phase B — colour (deferred, designed for now, built later)

Kept here so Phase A is built with Phase B in mind. Phase B is a **values-only** swap of the palette
blocks, because no component refers to a raw colour. The values below were read from the preview
page, which took them from OpenChamber's `openchamber-light.json` / `openchamber-dark.json`.

| Token | Light | Dark |
|---|---|---|
| `--background` | `#fdfcfa` | `#120f0e` |
| `--foreground` | `#393a34` | `#c9c5ba` |
| `--card` | `#f8f7f5` | `#181715` |
| `--popover` | `#f8f7f5` | `#181715` |
| `--primary` | `#b35017` | `#da7c47` |
| `--primary-foreground` | `#ffffff` | `#120f0e` |
| `--muted` | `#f7f6f4` | `#171615` |
| `--muted-foreground` | `#5c5c54` | `#8f8b81` |
| `--accent` | `#efedea` | `#1f1d1b` |
| `--destructive` | `#b7493f` | `#da5b4a` |
| `--border` | `#e5e1de` | `#242323` |
| `--ring` | `#b3501755` | `#da7c4755` |
| `--sidebar` | `#f7f6f4` | `#171615` |
| `--sidebar-accent` | `#e9e6e2` | `#221f1d` |

Phase B files: `globals.css` only (plus optional `themes.css` split, which would need its own ADR).
Adding a **selectable extra theme** later is a separate behaviour task: one block of values plus one
row in Appearance settings — deliberately not bundled here.

---

## 8. Open question before implementation

`web/src/app/layout/AppShell.tsx` and `web/src/components/ui/context-menu.tsx` already contain
**uncommitted work** in the working tree (63 changed/untracked files overall). Options:

- **(a)** Edit carefully on top of the in-flight work — small, surgical, class-only edits.
- **(b)** Maintainer commits/stashes first so the two never mix.

Recommended: **(b)** — both files sit in Phase A's path and the working tree is large enough that a
clean base is safer to review.

---

## 9. Explicitly out of scope for Phase A

- **All colour changes** (that is Phase B).
- Right-click behaviour.
- Selectable extra themes.
- Font family/size, spacing, density, control sizes, layout — the "structural" tier, not requested.
- Any dependency change, including Radix, Tailwind, shadcn.
- Replacing assistant-ui primitives or message rendering.