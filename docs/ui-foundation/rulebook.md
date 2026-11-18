# TBAi UI rulebook — plain-language guide

This is a **design artifact**, not code that runs. It is not imported anywhere.
It describes one coherent "skeleton" of named values for the parts of the UI
that are not colors. Colors stay with the theme system.

The idea is borrowed from OpenChamber: one place names every value, and call
sites use the name instead of a raw number. When a theme or an appearance
setting changes, everything that uses the name follows.

## The rule: reuse before defining

TBAi already has good tokens. The rulebook does not replace them. For each
group it first names the existing variable, then defines a new token **only**
where the audit proved a gap. New tokens use a `--rule-*` prefix so they can
never collide with an existing one.

## 1. Typography

**What it controls:** the size of text in each role — header, section, label,
body, meta, micro, markdown, code.

**What it reuses:** `--font-sans`, `--font-weight-base`, `--code-font-*`,
`--terminal-font-*`, `--reading-line-height`, and the root font size. All of
these are written to the DOM by the appearance system
(`features/appearance/typography.ts:530-568`), so they already follow the user's
font, size and weight settings.

**Why it is not a color:** it only sets `font-size` (and a rounded line-height).
The semantic classes never set `color`, `background` or any theme color.

**Why new tokens exist:** TBAi has no semantic text-size roles. Components pick
raw `text-xs` / `text-sm` / `text-[11px]` per call site. The new `--rule-text-*`
roles are in `rem`, so they scale with the appearance-controlled root size —
they are not fixed pixels and they do not set a font family or weight.

**OpenChamber mapping:** same as its `--text-*` variables and `.typography-*`
size-only classes in `typography.css`.

## 2. Spacing

**What it controls:** the 4/8px rhythm used for padding and gaps.

**What it reuses:** the theme's `--spacing` (defined in every theme JSON,
`0.25rem` by default). The audit found it defined but never consumed — changing
it currently does nothing.

**Why it is not a color:** it is a length derived from a theme variable with
`calc()`. No hex/oklch/rgb/hsl and no hardcoded px.

**Why new tokens exist:** `--rule-space-1..8` are aliases that finally make the
theme's `--spacing` do real work. TBAi has no `--padding-scale`; if one is added
later, the aliases can multiply by it, matching OpenChamber.

## 3. Radius

**What it controls:** corner rounding.

**What it reuses:** TBAi's existing derived scale — `--radius-sm` through
`--radius-4xl`, all computed from one `--radius` (`globals.css:109, 274-280`).
This is actually stronger than OpenChamber's fixed steps, so it is kept as-is.

**Why it is not a color:** it is a length derived from `--radius`.

**Why there are no new radius values:** the audit found no missing scale. The
only problem is that call sites choose different steps for the same role
(`rounded-4xl` on buttons, `rounded-xl` on popovers, a separate 8px sidebar-row
token). The rulebook adds only role aliases (`--rule-radius-control`,
`-surface`, `-popover`) that point at existing steps and carry no new value.

## 4. Edges

**What it controls:** how strongly a boundary is drawn — three strengths:
muted (quiet dividers), base (normal framing), strong (must hold its shape,
e.g. a selected row or an input outline).

**What it reuses:** the theme's `--border` (`globals.css:93` light, `201` dark).

**Why it is not a color:** the three strengths are `color-mix()` of `--border`
with `transparent`. The color still comes from the theme; the rulebook only
names how much of it to use. Widths are plain lengths (1px).

**Why new tokens exist:** TBAi has no strength scale. Call sites invent their
own opacities — `border-border/40`, `/50`, full `border-border`, `border-none` —
and the active tab uses only a background change, so its selection has no
visible edge. Three named strengths fix both problems. This mirrors
OpenChamber's `--oc-edge-muted` / `--oc-edge` / `--oc-edge-strong`.

## 5. Elevation

**What it controls:** how far a surface lifts off the page — three levels:
button (a pressable control), raised (a panel in the layout, e.g. the composer),
floating (a menu or popover over content).

**What it reuses:** `--elevation-floating` and `--elevation-overlay` plus their
`--shadow-*` aliases (`globals.css:132-135, 228-229, 284-285`).

**Why it is not a color:** the geometry (offsets, blur, spread) is fixed, but
every color in the shadows is a `color-mix()` of theme variables — `--border`
for the hairline ring and `--foreground` for the cast shadow. No black or white
literal is written.

**Why new tokens exist:** TBAi has only two levels. Call sites without a
matching level fall back to Tailwind's `shadow-xs` / `shadow-sm`, which are
hardcoded black shadows unrelated to the theme. Adding button and raised
completes the three-level ladder. OpenChamber does the same with
`--oc-elevation-button/raised/floating` and maps Tailwind `shadow-sm/md/lg`
onto them.

## 6. Iconography

**What it controls:** the size of an icon glyph and its stroke weight, plus the
minimum size of the target it sits in.

**What it reuses:** lucide-react's default stroke and the existing button rule
`[&_svg:not([class*='size-'])]:size-4` (`components/ui/button.tsx:9`).

**Why it is not a color:** sizes are lengths and stroke is a number. No color is
involved.

**Why new tokens exist:** call sites invent `size-3` / `size-4` / `size-5`, and
one uses `strokeWidth="2"` (`OpenCodeChipShared.tsx:205`). Named sizes make the
icon rhythm consistent. The 24px target floor is documented, not lowered.

## 7. Motion

**What it controls:** how long a transition takes and its easing.

**What it reuses:** `--animation-duration` (`globals.css:438`) as the base.

**Why it is not a color:** durations and easing curves are not colors.

**Why new tokens exist:** only one duration exists today, and there is no
`prefers-reduced-motion` branch anywhere in `web/src`. The rulebook adds fast /
base aliases and a reduced-motion branch that collapses both to zero. This
mirrors OpenChamber's `--oc-motion-*` tokens (`design-system.css:100-104`).

## 8. Focus

**What it controls:** the width and offset of the visible keyboard focus ring.

**What it reuses:** `--ring` (`globals.css:95/203`), which is theme-controlled and
already exposed as `--color-ring` (`globals.css:263`).

**Why it is not a color:** the width and offset are lengths. The ring *color* is
`var(--ring)` — the theme owns it, so no literal appears here.

**Why new tokens exist:** 56 call sites use `ring-1`, `ring-2` or `ring-[3px]`.
One named ring makes focus consistent and visible. OpenChamber removes rings
(`design-system.css:824-838`); **do not copy that** — TBAi keeps a visible focus
indicator for accessibility.

## 9. Layering

**What it controls:** the stacking order of chrome, panels, overlays and modals.

**What it reuses:** nothing — TBAi has no named z scale (raw `z-50` / `z-10` /
`z-20` across 34 call sites).

**Why it is not a color:** z-index values are integers.

**Why new tokens exist:** a four-step scale mirrors OpenChamber's
`--z-base/raised/overlay/modal` (`design-system.css:981-984`) and replaces magic
numbers with named roles.

## What to do with this file

## Additional reuse rules from the technical studies

- **Tracking:** `--tracking-normal` is defined in 25 theme JSONs but consumed
  nowhere; components use literal `tracking-tight/wide/wider/widest`. It is the
  same defect class as spacing. When a tracking role is needed, derive it from
  `--tracking-normal` — do not add a literal. This is a reuse rule, not a new
  token group.
- **Reduced motion:** 26 `motion-reduce:` branches already exist, mostly in
  vendored assistant-ui elements (`surfaces.tsx`, `reasoning.tsx`). Reuse that
  pattern; the rulebook's reduced-motion block only gives them a shared source.
- **Vendored elements:** restyle through `elements/surfaces.tsx` class constants
  and `data-slot` CSS hooks, never by editing a vendored file. See
  `constraints.md`.
- **Tailwind bridge:** TBAi uses `@theme inline` in `globals.css:234-286`. Do not
  self-reference a variable inside that block — it generates no utility. New
  real utilities belong in `@utility` blocks.

## What to do with this file

Do not import it. Use `application-plan.md` for the phased rollout. The plan
decides which surfaces move to which token, one group at a time, with a
verification step after each phase. `governance.md` states the operating rules
that keep the system consistent, and `constraints.md` is what an implementer
reads before touching assistant-ui or shadcn/ui code.
