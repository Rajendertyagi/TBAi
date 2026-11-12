/**
 * Theme CSS & Swatch utilities.
 * Single unified access point to theme tokens and swatches.
 */
import type { ThemeDefinition, ThemeVariant } from "./theme-data";

/** Every colour token globals.css declares. */
export const TBAI_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--link",
  "--link-hover",
  "--success",
  "--success-foreground",
  "--warning",
  "--warning-foreground",
  "--border",
  "--input",
  "--ring",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
  "--sidebar-ring",
  "--statusbar",
  "--card-soft",
  "--card-outline",
] as const;

/**
 * Resolves all 33 TBAi CSS variables directly from the authoritative theme token definition.
 * ZERO fabrication or guessing — returns the exact theme tokens.
 */
export function resolveThemeVars(
  theme: ThemeDefinition,
  variant: ThemeVariant,
): Record<string, string> {
  return theme.tokens[variant];
}

/**
 * Returns the 3-swatch colors (background, surface, primary) for the theme picker preview.
 */
export function themeSwatch(
  theme: ThemeDefinition,
  variant: ThemeVariant,
): {
  background: string;
  surface: string;
  primary: string;
} {
  return theme.swatch[variant];
}

/**
 * Serialise a theme into its CSS block (null for built-in default theme).
 */
export function themeCss(theme: ThemeDefinition, variant: ThemeVariant): string | null {
  if (theme.builtin) return null;
  const isDark = variant === "dark";
  const selector = isDark
    ? `html[data-tbai-theme="${theme.id}"].dark`
    : `html[data-tbai-theme="${theme.id}"]:not(.dark)`;

  const vars = resolveThemeVars(theme, variant);
  const lines = [`${selector} {`];
  for (const [prop, val] of Object.entries(vars)) {
    lines.push(`  ${prop}: ${val};`);
  }
  lines.push("}");
  return lines.join("\n");
}
