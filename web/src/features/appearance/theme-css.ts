/**
 * Theme palette -> TBAi CSS custom properties.
 *
 * Why a generator instead of one CSS block per theme:
 *
 * - 20 hand-written blocks means 20 places to mistype a value and no way to
 *   diff two themes meaningfully. Here a theme is data, and the mapping is
 *   written once.
 * - Upstream palettes are genuinely incomplete (see `theme-data.ts`). Written as
 *   static CSS you would have to hand-fill every gap; here a gap is derived from
 *   colours the palette does provide, so there is exactly one derivation per
 *   token and no invented hex anywhere.
 *
 * Every declaration carries `!important`, so the injected sheet wins on cascade
 * order alone. That is what lets the stylesheet's own `:root`/`.dark` block stay
 * exactly as it is today and act as the default, with no specificity war.
 *
 * Block scoping is mode-specific (`:root:not(.dark)` / `.dark`) because TBAi
 * keeps two independent theme slots — the light palette and the dark palette can
 * come from different families, which is why both have to be separately
 * addressable at the same time.
 */

import type { ThemeDefinition, ThemePalette, ThemeVariant } from "./theme-data";
import { compositeOver, contrastRatio, formatColor, mix, parseColor, readableForeground, withAlpha } from "./theme-color";

/** Contrast between two CSS colours, or `null` if either cannot be parsed. */
function contrast(a: string, b: string): number | null {
  const ca = parseColor(a);
  const cb = parseColor(b);
  return ca && cb ? contrastRatio(ca, cb) : null;
}

/**
 * Derive a foreground that is legible on every surface it is read against, while
 * keeping the palette's hue.
 *
 * This is the ONLY way a foreground token is produced in this module, and that is
 * deliberate. The first version offered a candidate list including `#000000` and
 * `#ffffff` and took whichever won on contrast. That returned pure black for
 * `--card-foreground` on every theme with a light surface — and it passed every
 * contrast assertion, because black genuinely does contrast. It quietly destroyed
 * the palette: a violet theme's cards were labelled in black.
 *
 * Legibility is necessary and not sufficient. A foreground also has to belong to
 * the theme, so the palette's own value (or a fallback derived from the palette's
 * own foreground) is adjusted in lightness toward that foreground by the smallest
 * amount that clears the threshold on every background.
 *
 * An unparseable colour is passed through untouched: we cannot measure it, and
 * silently replacing a value we do not understand would be worse than trusting
 * the source.
 */
function deriveForeground(
  provided: string | undefined,
  fallback: string,
  behinds: readonly string[],
  toward: string,
  min: number,
): string {
  let current = provided ?? fallback;
  for (const behind of behinds) {
    current = ensureSeparation(current, behind, anchorFor(behind, toward, min), min);
  }
  return current;
}

/**
 * Where to slide a foreground when it has to move.
 *
 * Prefer the palette's own foreground, so a derived value stays in the theme's
 * hue. But blending toward it only works if it *works*: on a bright primary, a
 * palette whose foreground is a mid-tone cannot reach the threshold by moving
 * toward itself — at 100% blend it is exactly as legible as it started. So when
 * the preferred anchor cannot clear the bar, fall back to whichever of black or
 * white does, and accept losing the hue rather than shipping something
 * unreadable.
 *
 * This is the only place a foreground may become a neutral, and it happens only
 * for palettes whose own foreground is unusable as text on that surface.
 */
function anchorFor(behind: string, toward: string, min: number): string {
  const preferred = separation(toward, behind);
  if (preferred !== null && preferred >= min) return toward;
  return readableForeground(behind, ["#000000", "#ffffff"], toward);
}

/** Contrast between two colours, or `null` if either cannot be parsed. */
function separation(fill: string, behind: string): number | null {
  return contrast(fill, behind);
}

/**
 * Guarantee that a FILL is visibly distinct from the surface behind it.
 *
 * This is the fix for the single worst defect in the first pass. Six of the
 * twenty upstream palettes define no `surface.subtle`, and across most of them
 * `surface.muted` sits within about two percent of the background. Mapping those
 * straight through produced `--accent` at 1.01:1 against a menu panel and
 * `--muted` at 1.05:1 against the page — so hovered and selected rows gave the
 * reader no feedback whatsoever, and inline code and table headers were
 * indistinguishable from the background.
 *
 * A palette is allowed to be subtle; it is not allowed to be invisible. Where the
 * upstream value is too close to what sits behind it, the fill is blended toward
 * the palette's own foreground by the SMALLEST amount that clears `min`. Working
 * in the theme's own hue rather than to grey is what keeps the result on-palette,
 * and "smallest amount" keeps a palette that was already correct untouched.
 *
 * Returns the input unchanged when either colour is unparseable, so a value we
 * cannot measure is never silently replaced with one we invented.
 */
function ensureSeparation(
  fill: string,
  behind: string,
  toward: string,
  min: number,
): string {
  const current = separation(fill, behind);
  if (current === null || current >= min) return fill;

  // Bisect for the least blend that clears the minimum. Twenty steps is far
  // finer than any visible step and keeps this deterministic.
  let low = 0;
  let high = 1;
  let best = fill;
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    const candidate = mix(fill, toward, mid);
    const ratio = separation(candidate, behind);
    if (ratio !== null && ratio >= min) {
      best = candidate;
      high = mid;
    } else {
      low = mid;
    }
  }
  return best;
}

/**
 * Apply {@link ensureSeparation} against several backgrounds in turn.
 *
 * A fill is not used on one surface. `--muted` backs an inline-code chip on the
 * page, a table header inside a card, and the secondary button wherever it sits;
 * `--accent` backs a hovered row inside a menu panel and a chip on the page.
 * Clearing one of those and not the other leaves the element invisible in exactly
 * the place a reader is most likely to look — so each background is enforced in
 * sequence, and each step works from the previous result.
 */
function ensureSeparationFrom(
  fill: string,
  behinds: readonly string[],
  toward: string,
  min: number,
): string {
  return behinds.reduce(
    (current, behind) => ensureSeparation(current, behind, toward, min),
    fill,
  );
}

/**
 * Derive a foreground that is legible on every surface it is read against, while
 * keeping the palette's hue.
 *
 * This is the ONLY way a foreground token is produced in this module. The earlier
 * version offered a candidate list containing `#000000` and `#ffffff` and took
 * whichever won on contrast — which returned pure black for `--card-foreground`
 * on any theme whose surface was light. It passed every contrast assertion,
 * because black genuinely does contrast, while quietly destroying the palette:
 * a violet theme's cards were labelled in black. Legibility is necessary and not
 * sufficient; a foreground also has to belong to the theme.
 *
 * So: start from the palette's own value (or a fallback derived from the
 * palette's own foreground) and adjust its lightness toward that foreground by
 * the smallest amount that clears the threshold on every background.
 */

/** id of the single injected `<style>` element. */
export const THEME_STYLE_ID = "tbai-theme-variables";

/** Attribute carrying the active non-builtin theme family. */
export const THEME_ATTRIBUTE = "data-tbai-theme";

/**
 * Resolve a palette into the concrete custom-property values TBAi's
 * `globals.css` expects.
 *
 * Pure and framework-free: the picker renders swatches from it and the
 * injector serialises it, so both read exactly the colours the user will see.
 */
export function resolveThemeVars(
  theme: ThemeDefinition,
  variant: ThemeVariant,
): Record<string, string> {
  const p: ThemePalette = variant === "dark" ? theme.dark : theme.light;
  const primary = p.primary ?? {};
  const surface = p.surface ?? {};
  const interactive = p.interactive ?? {};
  const status = p.status ?? {};

  // --- surfaces -------------------------------------------------------------
  const background = surface.background ?? "#ffffff";
  const foreground = surface.foreground ?? "#000000";
  const elevatedRaw = surface.elevated ?? background;

  // Fills are enforced against every surface they are actually used on, not just
  // the page: `--muted` backs an inline-code chip on the background and a table
  // header inside a card; `--accent` backs a hovered row inside a menu panel and
  // a chip on the page. Clearing one and not the other is what left hover rows
  // invisible in the first pass.
  const muted = ensureSeparationFrom(
    surface.muted ?? mix(background, foreground, 0.06),
    [background, elevatedRaw],
    foreground,
    1.1,
  );

  // Secondary text is read at length across the whole app, so it is held to the
  // body-text threshold against every surface it lands on — not just the page.
  const mutedForeground = deriveForeground(
    surface.mutedForeground,
    mix(background, foreground, 0.45),
    [background, elevatedRaw, muted],
    foreground,
    4.5,
  );

  // `elevatedForeground` is absent from all 20 upstream palettes, so the naive
  // fallback (`foreground`) put popover, dialog, tooltip and toast text at 3.35:1.
  // Those surfaces get their own contrast-checked foreground instead — derived
  // from the palette's foreground, so a violet theme's panels are labelled in
  // violet-black rather than pure black.
  const elevatedForeground = deriveForeground(
    surface.elevatedForeground,
    foreground,
    [elevatedRaw],
    foreground,
    4.5,
  );
  const elevated = elevatedRaw;

  // `subtle` is the accent fill — hover rows and selected rows. Where a palette
  // omits it the selection tint is flattened (an alpha value would render as a
  // hole in a solid row highlight), then held off both surfaces it appears on.
  const selectionTint = interactive.selection;
  const accentSource = ensureSeparationFrom(
    surface.subtle ??
      (selectionTint ? compositeOver(selectionTint, elevated) : mix(background, foreground, 0.08)),
    [elevated, background],
    foreground,
    1.12,
  );

  // --- chrome ---------------------------------------------------------------
  const border = interactive.border ?? mix(background, foreground, 0.14);
  const borderHover = interactive.borderHover ?? mix(background, foreground, 0.22);
  const focusRing = interactive.focusRing ?? mix(primary.base ?? foreground, background, 0.45);

  // --- primary --------------------------------------------------------------
  const primaryBase = primary.base ?? foreground;
  // Missing in 5 of 20 palettes. Derived from the palette's own foreground rather
  // than defaulting to white, and adjusted rather than replaced when the palette
  // does supply one that is too weak.
  const primaryForeground = deriveForeground(
    primary.foreground,
    foreground,
    [primaryBase],
    foreground,
    3,
  );

  // --- status ---------------------------------------------------------------
  // `--destructive` is used two ways: as the destructive BUTTON fill behind
  // `--destructive-foreground`, and as destructive TEXT on menu rows and the link
  // button. The audit measured that text use at 2.88:1. Nudging the colour until
  // it is legible as text also deepens the button fill slightly, which is a fair
  // trade for a destructive action the reader can actually read.
  const errorRaw = status.error ?? "#dc2626";
  const error = ensureSeparationFrom(errorRaw, [elevated, background], foreground, 4.5);
  const warningRaw = status.warning ?? "#d97706";
  const successRaw = status.success ?? "#16a34a";
  // Same dual-use problem as destructive, and the same trade: warning and success
  // are read as text on status lines as well as used as fills, and upstream's own
  // values measured 1.68:1 (Carbonfox light) and 2.10:1 (Aura light) as text.
  const warning = ensureSeparationFrom(warningRaw, [elevated, background], foreground, 4.5);
  const success = ensureSeparationFrom(successRaw, [elevated, background], foreground, 4.5);
  const errorForeground = deriveForeground(status.errorForeground, foreground, [error], foreground, 3);
  const warningForeground = deriveForeground(status.warningForeground, foreground, [warning], foreground, 3);
  const successForeground = deriveForeground(status.successForeground, foreground, [success], foreground, 3);

  // --- link ----------------------------------------------------------------
  // A dedicated link colour rather than `--primary`. `--primary` is a fill meant
  // to sit behind `--primary-foreground`; set as link text it measured 2.61:1.
  // Upstream ships `markdown.link` in all 20 palettes for precisely this, and a
  // link that cannot be read is a link that does not exist.
  const linkHover = (p.markdown as { linkHover?: string } | undefined)?.linkHover;
  const linkFinal = deriveForeground(
    (p.markdown as { link?: string } | undefined)?.link,
    primaryBase,
    [background, elevatedRaw],
    foreground,
    4.5,
  );

  // --- borderless card family ----------------------------------------------
  // Kept as a low-alpha wash of the palette's own foreground, mirroring how the
  // default stylesheet uses translucent white/black. Directions differ because a
  // dark card needs more lift above its background than a light one.
  const cardWash = variant === "dark" ? 0.04 : 0.025;

  return {
    "--background": background,
    "--foreground": foreground,
    "--card": elevated,
    "--card-foreground": elevatedForeground,
    "--popover": elevated,
    "--popover-foreground": elevatedForeground,
    "--primary": primaryBase,
    "--primary-foreground": primaryForeground,
    "--secondary": muted,
    "--secondary-foreground": foreground,
    "--muted": muted,
    "--muted-foreground": mutedForeground,
    "--accent": accentSource,
    "--accent-foreground": deriveForeground(undefined, foreground, [accentSource], foreground, 4.5),
    "--destructive": error,
    "--destructive-foreground": errorForeground,
    "--link": linkFinal,
    "--link-hover": ensureSeparationFrom(
      linkHover ?? mix(linkFinal, foreground, variant === "dark" ? 0.18 : 0.12),
      [background, elevatedRaw],
      foreground,
      4.5,
    ),
    "--success": success,
    "--success-foreground": successForeground,
    "--warning": warning,
    "--warning-foreground": warningForeground,
    "--border": border,
    "--input": borderHover,
    "--ring": focusRing,
    "--sidebar": ensureSeparation(muted, background, foreground, 1.1),
    "--sidebar-foreground": mutedForeground,
    "--sidebar-primary": primaryBase,
    "--sidebar-primary-foreground": primaryForeground,
    "--sidebar-accent": accentSource,
    "--sidebar-accent-foreground": deriveForeground(undefined, foreground, [accentSource], foreground, 4.5),
    "--sidebar-border": border,
    "--sidebar-ring": focusRing,
    "--statusbar": ensureSeparation(muted, background, foreground, 1.1),
    "--card-soft": withAlpha(foreground, cardWash),
    "--card-outline": withAlpha(foreground, 0.06),
  };
}

function declarations(vars: Record<string, string>): string {
  // Every value is normalised through `formatColor`, including ones taken
  // verbatim from a palette. Without that the generated stylesheet would be a mix
  // of palette hex and derived oklch — the derivation helpers emit oklch, so
  // anything they touched would differ in format from anything they did not. shadcn
  // and Tailwind v4 both author in oklch, and one format per file is also what
  // makes the file diffable.
  return Object.entries(vars)
    .map(([key, value]) => `  ${key}: ${formatColor(value)};`)
    .join("\n");
}

/**
 * Serialise a palette into the stylesheet block for it.
 *
 * The selector is scoped to the theme's own attribute, so all families coexist:
 *
 *   html[data-tbai-theme="aura"]:not(.dark)   (0,2,1)  beats  :root  (0,1,0)
 *   html[data-tbai-theme="aura"].dark         (0,2,1)  beats  .dark  (0,1,0)
 *
 * No `!important` is needed or wanted — the two layers are separated by
 * specificity, so an ordinary utility or a later component rule can still
 * override a token if it ever needs to.
 *
 * Returns `null` for the built-in Classic theme: its colours already live in
 * `globals.css`, so emitting them again would be a second source of truth that
 * could drift. Returning `null` is what lets Classic be a true zero-risk default.
 */
export function themeCss(theme: ThemeDefinition, variant: ThemeVariant): string | null {
  if (theme.builtin) return null;
  const body = declarations(resolveThemeVars(theme, variant));
  const selector =
    variant === "dark"
      ? `html[data-tbai-theme="${theme.id}"].dark`
      : `html[data-tbai-theme="${theme.id}"]:not(.dark)`;
  return `${selector} {\n${body}\n}`;
}

/** Cheap swatch triple for the picker. Read from the same resolver, never separately. */
export function themeSwatch(theme: ThemeDefinition, variant: ThemeVariant): {
  background: string;
  surface: string;
  primary: string;
} {
  const vars = resolveThemeVars(theme, variant);
  return {
    background: vars["--background"],
    surface: vars["--card"],
    primary: vars["--primary"],
  };
}