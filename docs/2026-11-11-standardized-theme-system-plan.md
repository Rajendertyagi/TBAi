# Standardized Theme System Plan (Tailwind CSS v4 + shadcn/Radix UI)

**Date:** 2026-11-11
**Status:** Ready for Execution
**Scope:** Standardize TBAi themes using standard shadcn/Tailwind registry JSON files, auto-discovery via Vite, clean typography isolation, and a clean break from legacy theme formats.

---

## 1. Objectives & Clean-Break Principle

1. **Standardized & Durable Format:** Adopt standard shadcn/Tailwind registry JSON theme files containing `cssVars.light`, `cssVars.dark`, and optional `cssVars.theme`.
2. **Clean Break (No Legacy Layers):**
   - No backward-compatibility layer or ID aliasing for legacy OpenChamber themes (`classic`, `aura`, `ayu`, `vesper`, `carbonfox`, etc.).
   - Old OpenChamber theme format support is **completely removed**, not layered alongside.
   - If a saved theme ID in SQLite/localStorage does not match any current theme, it safely falls back to `default`.
3. **Plug-and-Play Extensibility:** Dropping any valid `*.json` theme into `web/src/themes/` makes it instantly available in the app without editing TypeScript code.
4. **Typography Shield:** Completely decouple font styling from theme JSON files so the app's dedicated typography settings (Inter, JetBrains Mono, font size, weight, line height) are never overridden by themes.
5. **Zero FOUC (Flash of Unstyled Content):** Maintain render-blocking pre-paint theme application in `index.html` via `data-tbai-theme` attribute and render-blocking CSS.

---

## 2. Source Set & Default Theme Definition

### 2.1 Theme Files
* **Source Location:** `D:\Temp\Themes`
* **Contents:** 24 JSON theme files + 1 `README.md` (which is excluded from discovery).
  - `amber-minimal.json`, `caffeine.json`, `catppuccin.json`, `claude.json`, `claymorphism.json`, `clean-slate.json`, `cosmic-night.json`, `darkmatter.json`, `Default.json`, `doom-64.json`, `graphite.json`, `mocha-mousse.json`, `modern-minimal.json`, `mono.json`, `Mydarktheme.json`, `nature.json`, `neo-brutalism.json`, `notebook.json`, `pastel-dreams.json`, `sage-garden.json`, `soft-pop.json`, `supabase.json`, `twitter.json`, `vercel.json`.
* **Destination in Repository:** `web/src/themes/`

### 2.2 `Default.json` Handling
* **ID:** `default` (slugified from `Default.json`).
* **Role:** Serves as the canonical default theme (`DEFAULT_THEME_ID = "default"`).
* **Behavior:** When `default` is selected, `index.html` and `theme-dom.ts` do not need an override attribute (or apply the default variables directly), keeping the baseline look identical to standard TBAi styles.

---

## 3. Explicit Token Mapping Contract (JSON → TBAi)

### 3.1 Direct Pass-Through (Standard shadcn Variables)
Extracted directly from `cssVars.light` and `cssVars.dark`:
* Surface: `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`
* Action/Branding: `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`
* Nuance/States: `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`
* Feedback: `--destructive`, `--destructive-foreground`
* Form controls: `--border`, `--input`, `--ring`
* Charts (if present): `--chart-1` through `--chart-5`

### 3.2 Filtered Out (App-Owned — Never Applied from Theme)
To preserve the user's custom typography configured in **Settings → Appearance**:
* `--font-sans`, `--font-mono`, `--font-serif`
* `--tracking-normal`, `--tracking-tight`, `--tracking-wide`, etc.
* Custom body letter-spacing rules from `@layer base` in the JSON.

### 3.3 Minimal Fallbacks for TBAi-Specific Tokens
If the JSON does not supply certain TBAi-specific tokens, they are derived using simple, robust rules:
* **`--radius`:** If present in `cssVars.theme.radius`, apply it; otherwise fallback to app default `0.625rem` (10px).
* **`--link` / `--link-hover`:** Fallback to `--primary` (or saturated accent); hover steps slightly darker in light mode, lighter in dark mode.
* **`--statusbar`:** Fallback to `--secondary` or `--muted`.
* **`--sidebar` family:**
  - `--sidebar` = `--card` (or slightly shifted `--background`)
  - `--sidebar-foreground` = `--card-foreground`
  - `--sidebar-primary` = `--primary`
  - `--sidebar-primary-foreground` = `--primary-foreground`
  - `--sidebar-accent` = `--accent`
  - `--sidebar-accent-foreground` = `--accent-foreground`
  - `--sidebar-border` = `--border`
  - `--sidebar-ring` = `--ring`
* **`--card-soft` / `--card-outline`:**
  - Light mode: `color-mix(in srgb, var(--foreground) 3%, transparent)` and `color-mix(in srgb, var(--foreground) 7%, transparent)`.
  - Dark mode: `color-mix(in srgb, var(--foreground) 5%, transparent)` and `color-mix(in srgb, var(--foreground) 9%, transparent)`.
* **`--success` / `--warning`:** Standard accessible green/amber values if omitted.
* **Elevation / Shadows / Spacings:** **App defaults preserved.** The app's elevation tokens (`--elevation-floating`, `--elevation-overlay`) and layout spacings are structural and remain owned by TBAi.

---

## 4. Loader & Registry Behavior Details

### 4.1 Auto-Discovery via Vite
```ts
// web/src/features/appearance/theme-loader.ts
const themeModules = import.meta.glob('/src/themes/*.json', { eager: true });
```
* **No hardcoded lists:** Themes are dynamically gathered from whatever JSON files exist in `web/src/themes/`.
* **ID Generation:** Filename without extension, converted to lowercase kebab-case (e.g. `Default.json` -> `default`, `Mydarktheme.json` -> `mydarktheme`).
* **Label Generation:** Uses `json.name` if present (e.g. `"claude"`, `"Catppuccin"`), formatted with title capitalization, falling back to the filename slug.
* **Fault Tolerance:** If a JSON file is invalid or malformed, log a clear warning to console and skip it. It will **never** throw an unhandled error or break the app build.

### 4.2 Minimal Public API
The loader exports:
```ts
export interface ThemeDefinition {
  id: string;
  name: string;
  lightVars: Record<string, string>;
  darkVars: Record<string, string>;
  swatch: {
    light: { background: string; foreground: string; primary: string; accent: string };
    dark: { background: string; foreground: string; primary: string; accent: string };
  };
}

export const THEMES: ThemeDefinition[];
export const DEFAULT_THEME_ID = "default";
export function getTheme(id: string): ThemeDefinition | undefined;
export function isThemeId(id: unknown): id is string;
```

---

## 5. Runtime Wiring Scope

1. **[`web/src/components/theme-provider.tsx`](file:///D:/Temp/ai-chat-app/web/src/components/theme-provider.tsx):**
   - Consume `THEMES` and `DEFAULT_THEME_ID = "default"` from the new loader.
   - Fall back unknown stored IDs directly to `"default"`.
2. **[`web/src/features/appearance/theme-dom.ts`](file:///D:/Temp/ai-chat-app/web/src/features/appearance/theme-dom.ts):**
   - Apply `data-tbai-theme="<id>"` to `<html>`.
   - Update `<meta name="theme-color">` to match the resolved background.
3. **[`web/src/features/appearance/theme-storage.ts`](file:///D:/Temp/ai-chat-app/web/src/features/appearance/theme-storage.ts):**
   - Validate stored IDs with `isThemeId(id)`. Unknown IDs fallback to `"default"`.
4. **[`web/src/features/appearance/ThemePicker.tsx`](file:///D:/Temp/ai-chat-app/web/src/features/appearance/ThemePicker.tsx):**
   - Render swatches using `theme.swatch[variant]`.
   - Grid dynamically scales with the available themes.
5. **[`web/src/features/preferences/state/usePreferencesSync.ts`](file:///D:/Temp/ai-chat-app/web/src/features/preferences/state/usePreferencesSync.ts):**
   - Synchronize authoritative SQLite theme preferences using the new theme IDs.
6. **[`web/index.html`](file:///D:/Temp/ai-chat-app/web/index.html) Pre-Paint Script:**
   - Pre-reads `tbai-theme-light` and `tbai-theme-dark`. If `id && id !== "default"`, sets `data-tbai-theme="id"`.
   - Guaranteed zero FOUC.
7. **CSS Integration (`globals.css` / `themes.css`):**
   - `themes.css` declares `html[data-tbai-theme="<id>"]:not(.dark)` and `html[data-tbai-theme="<id>"].dark` blocks for each theme.

---

## 6. Cleanup Scope (Specific Files)

1. **Delete Obsolete Files:**
   - `web/scripts/build-themes.mjs`
   - `web/scripts/theme-audit.mjs`
2. **Refactor / Replace:**
   - `web/src/features/appearance/theme-data.ts`: Replace 971 lines of generated OpenChamber tables with the dynamic loader.
   - `web/src/features/appearance/theme-css.ts`: Replace OpenChamber-specific derivation logic with shadcn token formatting.
   - `web/src/styles/themes.css`: Replaced with generated/compiled blocks for all 24 shadcn themes.
3. **Update Affected Tests:**
   - Update `tests/unit/web/appearance/theme-css.test.ts` to assert that all 24 shadcn themes resolve valid color tokens and meet WCAG contrast thresholds.
   - Update any appearance unit tests referencing legacy IDs (`aura`, `classic`, etc.) to use `default`, `claude`, `catppuccin`, etc.

---

## 7. Concrete Verification Criteria

* [ ] **Full Discovery:** All 24 theme JSON files from `D:\Temp\Themes` are discovered, loaded, and selectable in Settings → Appearance.
* [ ] **Plug-and-Play Durability:** Adding or removing any `.json` file in `web/src/themes/` updates the theme list automatically without code edits.
* [ ] **Mode Switching:** Every theme renders distinct, valid Light and Dark palettes.
* [ ] **Zero FOUC:** Reloading the app with an active theme renders the correct colors instantly before first paint.
* [ ] **Typography Safety:** Changing themes does not change fonts, weights, sizes, or line heights (user typography remains 100% authoritative).
* [ ] **Graceful Fallback:** If SQLite or localStorage contains an unknown or legacy theme ID, the app falls back cleanly to `default` with no crash.
* [ ] **UI Component Health:** Buttons, inputs, dialogs, dropdowns, code blocks, sidebar, status pill, and warning/destructive badges render cleanly with proper contrast across all themes.
* [ ] **Build & Types:** `bun run typecheck` and `bun run build` succeed with exit code 0.
