# Theme system — 10 colour themes, light and dark

**Date:** 2026-10-03
**Status:** done, verified
**Supersedes:** the "Phase B — colour" section of
[`2026-10-02-openchamber-ui-reskin-plan.md`](./2026-10-02-openchamber-ui-reskin-plan.md),
which described colour as a single one-off swap. It is now a theme system.

---

## What this is, in plain terms

The app previously had exactly two looks: light and dark, both neutral grey. This
adds **eleven colour themes**, each available in **both** light and dark:

Classic (TBAi's existing look, unchanged) · Aura · Ayu · Carbonfox · Catppuccin ·
Cursor · Fields of the Shire · Gruvbox · JetBrains · OpenChamber · Vesper

You pick them in **Settings → Appearance**. There are two lists — one for light
mode, one for dark — because they are genuinely separate choices: you can run a
warm palette in light and a cool one in dark.

**Nothing changes for anyone who does not touch the setting.** A fresh install
and any existing install both keep TBAi's current colours, because `classic` is
the default in both slots and generates no CSS at all.

---

## The decisions, and why

### Colour theme and light/dark are two axes, not one

OpenChamber stores `themeMode` (`light`/`dark`) separately from a palette, and so
does this. The alternative — one theme that is "the light one" or "the dark one" —
would force a choice to change both at once.

### The palettes are generated, not hand-written

Adding a theme here is **data, plus one command**. Not a CSS block.

The first plan was to hand-write 20 CSS blocks. That was wrong for three reasons,
all of which showed up while doing it:

1. 20 blocks means 20 places to mistype a value, and no way to diff two themes
   meaningfully.
2. Upstream palettes are **incomplete** — `surface.elevatedForeground` is missing
   from all 20, `primary.foreground` from 5, `status.errorForeground` from 6. A
   static stylesheet would need every gap hand-filled, which is exactly how
   invented hex values get in.
3. The mapping itself (OpenChamber's 4 colour groups → TBAi's 33 tokens) is
   non-trivial and must exist exactly once.

So the mapping lives in `theme-css.ts`, and `scripts/build-themes.mjs` runs it to
produce two committed files.

### Generated CSS rather than a runtime-injected stylesheet

OpenChamber injects a `<style>` element at runtime with `!important` on every
declaration. That works, but it lands **after first paint**, so a theme can flash
the wrong colours on load.

Here the blocks are a real stylesheet (`src/styles/themes.css`, imported by
`globals.css`). It is render-blocking, so the theme is correct on the very first
painted frame — verified, not assumed: see *Verification* below.

Because the file is render-blocking, no `!important` is needed. Specificity alone
separates the two layers:

| Generated | Stylesheet | Result |
|---|---|---|
| `html[data-tbai-theme="x"]:not(.dark)` (0,2,1) | `:root` (0,1,0) | theme wins |
| `html[data-tbai-theme="x"].dark` (0,2,1) | `.dark` (0,1,0) | theme wins |
| *(no attribute)* | `:root` / `.dark` | **Classic stands** |

That last row is why the default is genuinely zero-risk: with no attribute set,
`themes.css` matches nothing at all and the stylesheet's own colours apply
unchanged.

### Runtime code is two attributes and nothing else

Because the colours are already in the stylesheet, the only runtime work is
setting the mode class and `data-tbai-theme`. That means the pre-paint bootstrap
in `index.html` carries **no colour logic**, so it cannot drift away from
`ThemeProvider`. Both callers share `theme-dom.ts`.

### Missing values are derived, never guessed

Every absent palette field has a documented fallback, derived from colours the
palette *does* provide — usually by mixing toward its own background or
foreground, which keeps a derived shade inside the theme's hue instead of
drifting to grey.

One case needed care: palettes often define `interactive.selection` as a
**translucent** tint. TBAi uses `bg-accent` as a solid row highlight, so an alpha
token there renders as a hole. Translucent selections are flattened over the
elevated surface, keeping the tint and guaranteeing a real fill.

### A theme may pick its foregrounds, but not invisible ones

Seven upstream foreground/background pairs failed WCAG. Carbonfox light put its
warning label at **1.68:1** against its own warning colour — not subtle, unreadable.

A palette's choice is kept when it passes and discarded when it does not, in
favour of the most legible colour that same palette offers. The status colour
itself is never touched — only the label. A theme whose choice was already fine
(Gruvbox, both variants) is left exactly as upstream defined it; there is a test
asserting that, so the repair cannot quietly flatten every theme toward the same
two colours.

### Shape stays out of it

`--radius`, `--glass-*` and `--elevation-*` are **not** in any theme block. Phase
A's surface work is theme-independent, and there is a test asserting no palette
can set those tokens.

---

## Field contract

| Group | Fields kept |
|---|---|
| `primary` | `base`, `foreground`, `hover`, `active`, `muted` |
| `surface` | `background`, `foreground`, `muted`, `mutedForeground`, `elevated`, `elevatedForeground`, `overlay`, `subtle` |
| `interactive` | `border`, `borderHover`, `selection`, `selectionForeground`, `hover`, `active`, `focusRing` |
| `status` | `error`, `errorForeground`, `warning`, `warningForeground`, `success`, `successForeground` |

Dropped as having no TBAi consumer: upstream's `syntax`, `markdown`, `tools`,
`pr`, `chat`, `config` groups and `status.info`.

---

## Token mapping

`--background`, `--foreground`, `--card`, `--popover`, `--muted`,
`--muted-foreground`, `--secondary`, `--border`, `--input`, `--ring`,
`--sidebar*`, `--primary*`, `--accent*`, `--destructive*`, `--success*`,
`--warning*`, `--statusbar`, `--card-soft`, `--card-outline` — 33 tokens, all
resolved for all 22 palette/variant combinations (11 themes × 2).

`--statusbar` and `--sidebar*` have no upstream equivalent; they follow one fixed
rule so all themes stay consistent (sidebar/statusbar = the muted surface).

`--card-soft` / `--card-outline` are a faint wash of the palette's own foreground
(2.5% light / 4% dark), mirroring how the stylesheet already uses translucent
white/black. They stay translucent so the tool and permission cards keep their
borderless treatment.

---

## How to add a theme

1. Add the family to `WANTED` in `web/scripts/build-themes.mjs` with its display
   name.
2. `cd web && bun run scripts/build-themes.mjs`
3. Commit `theme-data.ts` and `themes.css` together.

No component changes, ever. The picker iterates the registry.

The default OpenChamber source path can be overridden:
`bun scripts/build-themes.mjs <path-to-web-dist-assets>`.

---

## Second pass: rendered-element audit (2026-10-03, later)

### What was wrong with the first pass's verification

It verified the **welcome screen** only, across all 22 combinations. Every other
surface — menus, popovers, selects, dialogs, toasts, markdown, code blocks, tool
cards, hover and selected rows — had never been rendered under any palette. So
"every token resolved without error" had been mistaken for "it looks right".
Those are different claims, and only one of them was ever checked.

### The instrument

Two additions, both dev-only:

| File | Role |
|---|---|
| `web/src/features/appearance/ThemeLab.tsx` | Renders every themed surface at once, each labelled with `data-lab` |
| `web/scripts/theme-audit.mjs` | Walks the rendered DOM and measures it |

The lab is a top-level route behind `import.meta.env.DEV`, so it is compiled out
of production, and it sits **outside** the chat shell so it needs no session and
no `/api` traffic — nesting it would make it depend on the runtime it exists to
inspect.

The audit resolves each element's *real* background by alpha-compositing its whole
ancestor chain, because TBAi's tokens are deliberately translucent (`bg-muted/30`,
the glass utilities, the card wash). Reading `backgroundColor` alone would score a
code block's text against `rgba(0,0,0,0)`. It opens each overlay in turn — portals
included, which is why it measures every text-bearing element rather than only
the labelled specimens.

Output is grouped by element and ranked by weakest margin, split into
*mapping-rule candidates* (failing in many combinations → one bad rule) and
*individual palettes*. That split is the point: fixing per theme would paper over
the first kind.

### What it found, and what was wrong with it

Everything below failed in **21–22 of 22** combinations, i.e. none of it was a bad
palette. It was all mapping.

| Element | Before | Cause |
|---|---|---|
| hovered / selected rows | **1.01** | `--accent` from `surface.subtle`, which 6 of 20 palettes omit |
| muted fill (inline code, table head, secondary button) | **1.05** | `--muted` from `surface.muted`, often ~2% off background |
| sidebar / statusbar | 1.04 | same |
| links (markdown + link button) | **2.61** | links used `--primary`, a *fill* colour, as text |
| destructive / warning / success as text | 1.68–3.13 | status colours used as text without adjustment |
| popover / dialog / tooltip / toast text | 3.35 | `elevatedForeground` absent from all 20 palettes |
| muted text, blockquote, tool card, code block | 3.67 | `mutedForeground` below the body-text threshold |
| sonner toast border | hard grey edge | see below |

OpenChamber's own CSS showed three causes directly: hover/active come from
`interactive.hover`/`interactive.active` rather than `accent`; it **re-anchors the
foreground whenever it changes a fill** (`.bg-muted { --foreground: … }`), which
TBAi does not; and links use a dedicated `markdown.link`.

### The fixes

1. **`ensureSeparation` / `ensureForeground`** — a fill or text colour that is too
   close to its background is blended toward the palette's own foreground by the
   *smallest* amount that clears the threshold (bisection, 20 steps, deterministic).
   Hue is preserved and a palette that was already adequate is untouched.
2. **Enforced against every surface a value is used on**, not just the page. That
   was a second round of failures: `--muted` was clear of the background but not
   of a card, and `--link` was clear of the page but not of a card.
3. **New `--link` / `--link-hover` tokens**, mapped from upstream `markdown.link`
   (present in all 20 palettes), used by markdown links and the `link` button
   variant. `--primary` stays a fill.
4. **`elevatedForeground` derived** with its own contrast check instead of falling
   back to `foreground`, which is what put overlay text at 3.35.
5. **`--destructive` / `--warning` / `--success` held to the body-text threshold**,
   since all three are read as text on status lines.
6. **sonner toast border** — `--normal-border` was being set from
   `globals.css` and silently doing nothing, because sonner writes that variable
   **inline** on the toaster, and an inline declaration beats any stylesheet rule.
   Replaced with a direct `border-color` on `[data-sonner-toast]`, which is not
   inline. (`--border-radius` from the same rule had always worked, because
   sonner does not set that one — which is what made the failure easy to miss.)

### Two mistakes worth remembering

- **`readableForeground` destroys hue.** It maximises contrast, so asked for a
  colour that must *be* a colour it returned black: `--link` became `#000000` and
  `--destructive` became `#000000` on 10 themes. That produced a *worse* result
  than the bug it replaced. Hence `ensureForeground`, which adjusts lightness and
  keeps the hue.
- **`Object.keys()` on an array of strings returns indexes.** It silently emptied
  every palette during development. The generated-file sync test exists because of
  it, and it has since caught a real desync too.

### After the fixes

`scripts/theme-audit.mjs`, 22 combinations, **37,286 checks, 0 page errors**:

- **No text-legibility failures at all** (every row needing 4.5:1 is gone).
- Remaining rows are all *by design* and are labelled as such: elevated surfaces
  matching the page (Phase A is borderless-with-shadow, and several palettes set
  `elevated` equal to `background`), and faint borders.
- Two honest leftovers: the borderless tool card's wash measures 1.01 against the
  page in 13 combinations — it reads through its ring and the buttons on it, which
  is the Phase A treatment, and strengthening it is a one-value change if wanted.
  And Classic's own destructive red is 3.76:1 as text, which is pre-existing and
  deliberately untouched.

### New tests

`theme-css.test.ts` now asserts the *classes the audit found*, not just
token-vs-token pairs — accent-vs-popover, muted-vs-card, link-vs-card,
warning-as-text — plus one that every colour token is defined in **both** `:root`
and `.dark`. That last one exists because `--link` was added to `:root` only and
shipped invisible in Classic dark mode (1.12:1); nothing else caught it, since
ported themes define their own blocks and the generated-CSS tests never look at
Classic.

37 theme tests, 0 failures. `typecheck` 0, `lint` 0, `build:web` 0.

### Reproducing

```
cd web && bun run dev            # the lab is dev-only
bun run scripts/theme-audit.mjs --base http://localhost:5173 --shots
```

---

## Files

| File | Role |
|---|---|
| `web/scripts/build-themes.mjs` | Extracts palettes, writes the two generated files |
| `web/src/features/appearance/theme-data.ts` | **generated** — palettes, types, registry |
| `web/src/styles/themes.css` | **generated** — the 20 colour blocks |
| `web/src/features/appearance/theme-color.ts` | Parsing, WCAG contrast, mixing, flattening |
| `web/src/features/appearance/theme-css.ts` | The one palette → token mapping |
| `web/src/features/appearance/theme-storage.ts` | Three persisted decisions, total reads |
| `web/src/features/appearance/theme-dom.ts` | The only DOM writer, shared by bootstrap + provider |
| `web/src/features/appearance/ThemePicker.tsx` | Swatch grid on native radios |
| `web/src/components/theme-provider.tsx` | Rewritten; `theme`/`setTheme`/`toggleTheme` unchanged |
| `web/index.html` | Pre-paint bootstrap (class + attribute only) |

### Storage keys

| Key | Meaning |
|---|---|
| `tbai-theme` | mode: `light` \| `dark` — **pre-existing, unchanged** |
| `tbai-theme-light` | palette for light mode |
| `tbai-theme-dark` | palette for dark mode |

Reads are total: unknown, corrupt or partial values fall back to the default. A
bad key can never brick the shell.

---

## Provenance and licence

The palettes are extracted **verbatim** from OpenChamber's compiled theme
registry. OpenChamber is MIT licensed — Copyright (c) 2025 Bohdan Triapitsyn —
which permits reuse and redistribution provided the notice is retained. The notice
is carried in the generated files, in `docs/decisions.md`, and in the Appearance
page itself.

Individual palettes credit their own upstream author on `ThemeDefinition.author`
(Cursor → `cedricverlinden`, Gruvbox → "Artem Evsevev, adapted for
OpenChamber"), preserved so a future licence change has the provenance it needs.

---

## Verification

| Gate | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun run build:web` | exit 0 |
| `bun run test` | **3505 pass, 10 skip, 0 fail** (3515 tests / 257 files) |
| Theme tests | 34 pass, 0 fail |

**Automated visual check, all 22 combinations** (11 themes × 2 modes), each seeded
in `localStorage` *before* the document existed:

- Background colour identical before and after React mounted — **no flash of the
  wrong theme**. This was measured, not assumed.
- `data-tbai-theme` correct on the first evaluation, including absent for
  `classic`.
- `html` mode class correct.
- **Zero console errors.**

**Confirmed by eye**, light and dark: Classic (unchanged neutral), OpenChamber
light (warm cream, orange accent), Gruvbox dark, and the Appearance page with both
pickers — 22 radios, 2 selected.

### Known-unverified

Sonner toasts were visually confirmed under the *previous* neutral theme. They
read `--popover` through the `glass-surface` token, so they follow whatever theme
is active, but nobody has watched one render under a coloured theme.

---

## Traps worth remembering

- **`Object.keys()` on an array of strings returns indexes, not values.** This
  silently emptied every palette during development. The generated-file sync test
  exists because of it.
- **Both generated files are committed.** Editing either by hand desyncs them;
  `theme-css.test.ts` fails the build if they drift.
- **`scripts/build-themes.mjs` reads outside the repo** (an installed
  OpenChamber). It is a one-off authoring tool, not a build step — nothing in
  `build:web` invokes it.