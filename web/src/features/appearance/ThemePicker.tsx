import { cn } from "../../lib/utils";
import { THEMES, type ThemeVariant } from "./theme-data";
import { themeSwatch } from "./theme-css";

/**
 * Palette picker: a swatch per theme, shown for one mode at a time.
 *
 * Built on native `<input type="radio">` rather than a hand-rolled ARIA widget.
 * That is a deliberate choice: radios inside a `<fieldset>` arrive with arrow-key
 * navigation, focus handling and screen-reader semantics already correct, so
 * there is no ARIA to keep in sync. `sr-only` hides the input while leaving it in
 * the accessibility tree, and the label is what gets styled.
 *
 * The two pickers in Appearance are independent — one drives light mode, one
 * drives dark — which is why `variant` is a prop rather than read from context.
 * Each swatch previews the palette *as it will look in that mode*, so choosing a
 * dark theme in the light row shows its light variant.
 */
export function ThemePicker({
  variant,
  value,
  onChange,
  className,
}: {
  variant: ThemeVariant;
  value: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <fieldset className={cn("min-w-0", className)}>
      <legend className="sr-only">
        Colour theme for {variant === "dark" ? "dark" : "light"} mode
      </legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {THEMES.map((theme) => {
          const swatch = themeSwatch(theme, variant);
          const id = `tbai-theme-${variant}-${theme.id}`;
          const selected = theme.id === value;

          return (
            <div key={theme.id} className="min-w-0">
              <input
                type="radio"
                id={id}
                name={`tbai-theme-${variant}`}
                value={theme.id}
                checked={selected}
                onChange={() => onChange(theme.id)}
                className="peer sr-only"
              />
              <label
                htmlFor={id}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5",
                  "transition-colors hover:bg-accent",
                  "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:outline-none",
                  selected && "border-ring bg-accent",
                )}
              >
                {/* Swatch colours come from the palette itself, so they can only be
                    inline — they are data, not design tokens. Layout, radius and
                    spacing all still come from tokens. */}
                <span
                  aria-hidden="true"
                  className="flex size-6 shrink-0 overflow-hidden rounded-full ring-1 ring-border"
                >
                  <span className="h-full flex-1" style={{ backgroundColor: swatch.background }} />
                  <span className="h-full flex-1" style={{ backgroundColor: swatch.surface }} />
                  <span className="h-full flex-1" style={{ backgroundColor: swatch.primary }} />
                </span>
                <span className="min-w-0 flex-1 truncate text-xs">{theme.name}</span>
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}