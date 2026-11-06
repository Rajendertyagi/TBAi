# TBAi — Typography, Terminal & Application Scaling: Implementation Record (P0, implemented)

**Date:** 2026-11-05
**Status:** Implemented in `dd82ed8` (`feat(appearance): independent typography per surface with factor-based app scale`), on branch `ci/tauri-e2e-verify`. This document is the approved Revision 2 plan and the record of what was built; §14 lists the post-review corrections. The packaged WebView2 zoom observation runs in the `tauri` CI job, not locally (no MSVC linker on the development box).
**Revision 2 (2026-11-05, maintainer review):** corrected CSS font ownership (`--font-mono` stays the fixed generic stack; code/terminal get their own variables), inventoried and classified all 52 arbitrary pixel font-size declarations, `appScale` is now an exact factor (0.75–1.5) with lossless legacy migration, packaged zoom-hotkey test reuses the existing WebDriver infrastructure (no new script), and the Tailwind v4 `@theme` mechanism was verified empirically (plain `@theme`, not `@theme inline`; line-height tokens are unitless and need no override). See §13.
**Baseline (verified):** branch `ci/tauri-e2e-verify`, HEAD `42930ff` (`feat(appearance): decouple interface and code typography with scoped resets`), clean tree. Tauri CLI **2.12.3**, Rust crate **2.12.5**. No `xterm`/`pty` dependency anywhere; **TBAi has no live PTY terminal** — all "terminal" output is captured tool output rendered as HTML rows.

## 1. Open-source reference findings

**Zed** (visual-customization, terminal, all-settings docs):

- Separate owners per rendering context: `ui_font_family` / `ui_font_size` / `ui_font_weight` (UI chrome), `buffer_font_family` / `buffer_font_size` / `buffer_font_weight` + `buffer_line_height` (editor), `terminal.font_family` / `font_size` / `font_weight` / `line_height` (terminal). Agent panel and markdown preview get their own optional overrides that *fall back* to UI/buffer fonts.
- Weights are CSS 100–900; line heights are named presets (`comfortable` 1.618 / `standard` 1.3 / `{custom}`).
- **Adopt:** independent ownership per context; named line-height presets; fallback-not-sharing (each context has its own value, never a shared variable "because they're equal").
- **Do not adopt:** Zed's settings-file/JSON-schema machinery, per-language overrides, ligature config — out of scope.

**VS Code** (terminal/appearance, codebasics, tips-and-tricks):

- `editor.fontFamily` / `editor.fontSize` (editor only), `terminal.integrated.fontFamily` / `fontSize` / `fontWeight` / `lineHeight` (terminal only), `window.zoomLevel` (whole workbench, number, default 0, ~20%/step), `editor.wordWrap` (`off|on|wordWrapColumn|bounded`), and language-scoped `[Log]: editor.fontSize` (proof that "output panel ≠ editor" scoping is a solved pattern).
- **Adopt:** the separation of *editor vs terminal vs workbench-zoom*; word wrap as a display-only preference; zoom as a whole-layout multiplier distinct from font size.
- **Do not adopt:** the settings system, `window.zoomLevel`'s step model (TBAi uses explicit 75–150%), GPU/WebGL renderer concerns (no PTY).

**Tauri `zoomHotkeysEnabled`** (installed schema `node_modules/@tauri-apps/cli/config.schema.json`, `WindowConfig`):

- `boolean`, **default `false`**. Windows: controls WebView2's `IsZoomControlEnabled`. macOS/Linux: injects a ctrl/cmd +/- polyfill (requires `webview:allow-set-webview-zoom`). Android/iOS: unsupported.
- **Decision:** set `"zoomHotkeysEnabled": false` explicitly on the `main` window in `src-tauri/tauri.conf.json` (`app.windows[0]`). It is already the default in the installed version, but explicit pins it against upstream default changes and documents intent. **No global keyboard listeners.** Verify in the packaged Windows WebView2 build (§6).

## 2. Current TBAi architecture — actual rendering surfaces (verified)

**Storage & apply path**

- `web/src/features/appearance/typography.ts` — `TypographyConfig` v1 (`fontFamily`, `monoFontFamily`, `fontWeight`, `monoFontWeight`, `baseSize`, `codeFontSize`, `lineHeight`); `readTypography()` (L244) migrates missing `monoFontWeight`/`codeFontSize` from the first commit (`fcd16b6`); `applyTypographyToDom()` (L324) writes `--font-sans`, `--font-mono`, `--font-weight-base`, `--font-weight-mono`, `--code-font-size`, `--font-line-height` and `zoom` on `documentElement`; scoped resets L364/L378/L393; `resetTypography()` L407.
- `web/index.html` L36–87 — pre-paint bootstrap duplicates the font maps and normalization. **Drift found:** the bootstrap does *not* clamp weights to font capabilities (TS does via `clampWeightForFont`), so pre-paint and post-mount can disagree (e.g. Open Sans requested 900 → bootstrap applies 900, TS clamps to 800).
- `web/src/main.tsx` does **not** call `applyTypographyToDom`; the bootstrap is the only pre-paint path, `AppearancePage` applies on change.
- Application scale = CSS `zoom` on `documentElement`, `baseSize` 12–24px → 0.75–1.5 (`SCALE_CONFIG`, typography.ts L197). UI shows **px**, not %.

**CSS (`web/src/styles/globals.css`)**

- `:root` L26–149: `font-size: 16px` (L41, fixed), `line-height: var(--font-line-height)` (L42), `font-weight: var(--font-weight-base)` (L43).
- `code, kbd, samp, pre, .font-mono { font-family: var(--font-mono) }` L528–534 (family only).
- `.aui-md-inline-code` L537–540: `calc(var(--code-font-size) * 0.95)` + `var(--font-weight-mono)`.
- `.aui-md-pre`, `.aui-shiki-base pre`, `.aui-code-diff pre/code` L542–550: `var(--code-font-size)` + `var(--font-weight-mono)` (unlayered → beats Tailwind utilities). **`.aui-code-diff` is a dead selector** — it exists only in this file; the component renders `data-slot="code-diff"` (`code-diff.tsx` L102). The live selectors are `[data-slot="code-diff"]` and `[data-slot="terminal-block"]`.
- `code, kbd, samp, pre, .font-mono { font-family: var(--font-mono) }` L528–534 — **this is the leakage path**: the Code Font selection writes `--font-mono`, so logs, IDs, paths, token counts and tool metadata all change with it.
- `.ai-message-content` L494–496 — **dead CSS** (no usages).
- `text-2xs` / `text-3xs` L274–279 — rem-based custom utilities.

**Rendering surfaces**

| Surface | File | Current type styling | Class |
|---|---|---|---|
| Markdown prose `<p>` / `<li>` | `markdown-text.tsx` L166, L247 | `leading-relaxed` (1.625) — **overrides inherited `--font-line-height`; the Reading setting is currently dead for prose** | prose |
| Fenced code `<pre>` | `markdown-text.tsx` L257 | `text-[13px]` (dead — unlayered `.aui-md-pre` wins) + `overflow-x-auto` | code |
| Shiki output | `shiki-highlighter.tsx` L18 | `[&_pre]:text-[13px]` (dead, same reason) + `overflow-x-auto` | code |
| Inline code | `markdown-text.tsx` L269 | `text-[0.85em]` (dead — unlayered `.aui-md-inline-code` wins) | code |
| Diffs | `code-diff.tsx` L103, L120 | `font-mono text-xs`, `whitespace-pre`, `codeScroll` (`overflow-x-auto`) | code |
| Terminal (run_command, OpenCode bash/shell) | `terminal-block.tsx` L69, L124–135 | `font-mono text-xs`; rows are plain `<div>`s (normal wrapping, container `overflow-hidden`) | **terminal** |
| Logs viewport | `LogsPanel.tsx` L970, L1030 | `font-mono text-2xs leading-5` | **logs — not terminal, not code** |
| Tool metadata / IDs / token counts / paths | `surfaces.tsx` L44 (`mono` = `font-mono text-[11px]`), `context-display.tsx`, `tool-timeline.tsx`, `approval-card.tsx`, scheduler/opencode pages, `ChatWindow.tsx` L992/L1090 | fixed px, `font-mono` | metadata — leave alone |
| Error-details `<pre>` | `ChatWindow.tsx` L1090 | `font-mono text-[10px]` | explicit semantic typography — leave |

**Tests that exist:** `tests/unit/appearance/typography.test.ts` (v1, scoped resets), `tests/e2e/appearance-scaling.spec.ts` (75/100/150 zoom regression + v1 persistence + scoped resets), DOM tests under `tests/dom/` (happy-dom via `tests/setup/dom-preload.ts`). Packaged-app infra exists in the `tauri` CI job (tauri-driver + msedgedriver + gsudo medium integrity; `bun run verify:packaged-origin`) but **no interactive WebDriver suite yet**.

## 3. Final settings ownership matrix

| Change | Must change | Must remain unchanged |
|---|---|---|
| Interface font family | Interface text | Code, terminal, logs, metadata |
| Interface font size | Interface text (rem type scale) | Code, terminal, stored app scale, spacing/radius |
| Interface weight | Interface base weight | Code/terminal weights, explicit `font-medium/semibold` |
| Code font family | Code surfaces (fences, inline code, diffs, code previews) | Interface, terminal, logs, metadata |
| Code font size | Code surfaces | Interface, terminal |
| Code weight | Code surfaces | Interface, terminal |
| Code wrap | Code wrapping (visual only) | Source content, copy output, diffs, terminal wrap |
| Terminal font family | TerminalBlock output | Code, interface, logs |
| Terminal font size | TerminalBlock output | Code, interface |
| Terminal weight | TerminalBlock output | Code, interface |
| Terminal wrap | TerminalBlock rows (visual only) | Code wrap, content |
| Reading line height | `.aui-md-p`, `.aui-md-li` (+ reasoning, see Q3) | Controls, headers, code, terminal, logs |
| Application scale | Whole UI geometry (zoom) | All stored typography preferences |

No shared state across categories; identical defaults are stored per-category.

## 4. Storage schema v2 & migration

Keep key `tbai-typography`, bump `version: 2`. One record, no framework.

```ts
interface TypographyConfig {
  version: 2;
  // Interface
  interfaceFontFamily: string;   // ← fontFamily
  interfaceFontSize: number;     // NEW, px, default 16, range 12–24
  interfaceFontWeight: number;   // ← fontWeight
  // Code
  codeFontFamily: string;        // ← monoFontFamily
  codeFontSize: number;          // ← codeFontSize (11–20)
  codeFontWeight: number;        // ← monoFontWeight
  codeWordWrap: boolean;         // NEW, default false
  // Terminal
  terminalFontFamily: string;    // NEW, default "jetbrains-mono"
  terminalFontSize: number;      // NEW, default 12, range 10–20
  terminalFontWeight: number;    // NEW, default 400
  terminalWrap: boolean;         // NEW, default true (preserves current wrapping)
  // Reading
  readingLineHeight: number;     // ← lineHeight (1.35 / 1.5 / 1.65)
  // Application scale
  appScale: number;              // ← baseSize, FACTOR 0.75–1.5, default 1 (UI shows %)
}
```

**Migration (v1 from both commits → v2):** `fontFamily→interfaceFontFamily`, `fontWeight→interfaceFontWeight`, `monoFontFamily→codeFontFamily`, `monoFontWeight→codeFontWeight` (fallback `fontWeight`), `codeFontSize→codeFontSize`, `lineHeight→readingLineHeight`, `baseSize→appScale = clamp(baseSize / 16, 0.75, 1.5)`. **No rounding — every legacy value is a sixteenth and exactly representable in binary floating point, so the conversion is lossless:**

| baseSize | appScale | UI shows |
|---|---|---|
| 12px | 0.75 | 75% |
| 13px | 0.8125 | 81.25% |
| 14px | 0.875 | 87.5% |
| 15px | 0.9375 | 93.75% |
| 16px | 1 | 100% |
| 17px | 1.0625 | 106.25% |
| 18px | 1.125 | 112.5% |
| 19px | 1.1875 | 118.75% |
| 20px | 1.25 | 125% |
| 21px | 1.3125 | 131.25% |
| 22px | 1.375 | 137.5% |
| 23px | 1.4375 | 143.75% |
| 24px | 1.5 | 150% |

Validation: finite number, 0.75–1.5, else default `1`. UI: slider `min=0.75 max=1.5 step=0.0625` (1/16 — exactly the legacy 12–24px range), presets 75 / 87.5 / 100 / 112.5 / 125 / 150, display trims trailing zeros (`81.25%`, `87.5%`, `100%`). `zoom = String(appScale)`; property removed at exactly `1`. New fields take defaults. Every value validated; weights clamped per-font at apply time (`clampWeightForFont`, unchanged); corrupted/unknown → defaults. Scoped resets: `resetInterfaceTypography` (family/size/weight), `resetCodeTypography` (family/size/weight/wrap), `resetTerminalTypography` (new), `resetReadingTypography` (line height), `resetApplicationScale` (appScale), `resetTypography` (all, atomic). Each preserves the other groups — same pattern as today.

**index.html bootstrap:** rewritten to v2 with *identical* normalization, **plus** per-font weight min/max in the maps so pre-paint clamps exactly like TS (fixes the existing drift). A unit test will extract `FONT_MAP`/`MONO_MAP` from `index.html` and assert they match `UI_FONTS`/`MONO_FONTS` stacks and weight ranges — drift fails the suite.

## 5. Minimal file list

**MODIFY**

1. `web/src/features/appearance/typography.ts` — v2 schema, migration, `applyTypographyToDom` (zoom from `appScale` factor; writes `--code-font-family`, `--terminal-font-family/size/weight`, `--code-font-weight`, `--interface-font-size`, `--reading-line-height`; `data-code-wrap` / `data-terminal-wrap` on `<html>`; **never writes `--font-mono`**), scoped resets, `INTERFACE_FONT_SIZE_CONFIG`, `TERMINAL_FONT_SIZE_CONFIG`, `APP_SCALE_CONFIG` (0.75–1.5, step 1/16).
2. `web/src/features/appearance/AppearancePage.tsx` — five groups (Interface / Code / Terminal / Reading / Application Scale) + Reset all; scale shown as **%** (slider 0.75–1.5 step 0.0625; presets 75 / 87.5 / 100 / 112.5 / 125 / 150; trailing zeros trimmed); interface-size slider; terminal group; per-group reset.
3. `web/src/features/appearance/TypographyPreview.tsx` — add terminal preview; show % scale; interface size.
4. `web/src/styles/globals.css` — **plain `@theme`** override of `--text-*` to `calc(var(--interface-font-size) * <default rem>)` (verified: v4.3.3 emits `:root { --text-sm: calc(...) }` and utilities reference `var(--text-sm)`; `--text-*--line-height` are unitless ratios and need **no** override); `text-2xs/3xs` → calc(); new `--interface-font-size`, `--code-font-family`, `--code-font-weight` (rename of `--font-weight-mono`), `--terminal-font-family/size/weight`, `--reading-line-height` (rename of `--font-line-height`); **`--font-mono` stays the fixed generic monospace stack — no setting writes it**; generic rule `code, kbd, samp, pre, .font-mono` → `var(--font-mono)` kept; code-surface rules (`.aui-md-pre`, `.aui-md-pre code`, `.aui-shiki-base pre`, `.aui-shiki-base pre code`, `.aui-md-inline-code`, `.aui-code-block pre/code`, `[data-slot="code-diff"]`) → `var(--code-font-family)` + `var(--code-font-size)` + `var(--code-font-weight)`; `[data-slot="terminal-block"]` → terminal vars; `[data-code-wrap="on"]` → `pre-wrap` + `overflow-wrap:anywhere` on `.aui-md-pre` / `.aui-shiki-base pre` only (**never** `[data-slot="code-diff"]`); `[data-terminal-wrap]` rules; `.aui-md-p, .aui-md-li { line-height: var(--reading-line-height) }`; **remove dead `.aui-code-diff` rule** (matches nothing — the component renders `data-slot="code-diff"`); remove dead `.ai-message-content`.
5. `web/index.html` — v2 bootstrap (identical normalization + weight clamping; sets `--code-font-family` / `--terminal-*` / `--interface-font-size` / `--reading-line-height` / factor zoom; **does not touch `--font-mono`**).
6. `web/src/components/assistant-ui/elements/markdown-text.tsx` — drop `leading-relaxed` on `p`/`li`; drop dead `text-[13px]` / `text-[0.85em]`.
7. `web/src/components/assistant-ui/elements/shiki-highlighter.tsx` — drop dead `[&_pre]:text-[13px]`.
8. `web/src/components/assistant-ui/elements/terminal-block.tsx` — drop `font-mono text-xs` (CSS owns via `[data-slot="terminal-block"]`); wrap on → `whitespace-pre-wrap` + `overflow-wrap:anywhere` (preserves spaces/indentation); wrap off → `whitespace-pre` + `overflow-x-auto` on the output body.
9. `web/src/components/assistant-ui/elements/code-diff.tsx` — drop `font-mono text-xs` (CSS owns via `[data-slot="code-diff"]`); **always** `whitespace-pre` + horizontal scroll.
10. `web/src/components/ChatWindow.tsx` — L1073/L1078/L1086 → `text-2xs` (interface text, zero-diff); L992 stays generic mono (status message); L1090 stays fixed 10px (diagnostic).
11. Interface-text arbitrary sizes → calc/`text-2xs`/`text-3xs` (zero visual change at 16px, all respond to Interface Font Size): `SidebarSection.tsx` L46 (13px → `calc(var(--interface-font-size) * 0.8125)`), `web-search.tsx` L85, `tool-timeline.tsx` L51/L69, `approval-card.tsx` L105 (13.5px → `calc(var(--interface-font-size) * 0.84375)`), `OpenCodeConfigPage.tsx` L211/L225/L238/L271/L533/L567/L697, `OpenCodeModelChip.tsx` L102 (11px → `text-2xs`), `QuickMessagesPage.tsx` L301 (0.625rem → `text-3xs`).
12. `src-tauri/tauri.conf.json` — `"zoomHotkeysEnabled": false` in `app.windows[0]`.
13. `scripts/verify-packaged-webview-origin.ts` — add a `zoom-hotkeys` stage to the **existing** session (no new script, no duplicate driver/session/port-mirror/integrity logic): after the `fetch` stage, read `document.documentElement.style.zoom` + computed root font-size, send Ctrl+Plus / Ctrl+Minus / Ctrl+0 via the WebDriver Actions API (same raw-HTTP `httpJson` pattern), re-read and assert unchanged; record the stage in `packaged.json`.
14. `tests/unit/tooling/webview-origin-evidence.test.ts` — update `PACKAGED_STAGES` and stage assertions for the new stage.
15. `tests/unit/appearance/typography.test.ts` — v2, migration from both v1 shapes (exact factor values: 13→0.8125, 14→0.875, 15→0.9375, 18→1.125), per-field validation, independent weight clamping, scoped resets, master reset, corruption recovery.
16. `tests/e2e/appearance-scaling.spec.ts` — v2 storage; independence assertions; copy-preservation; keep 75/100/150 regression.
17. `docs/decisions.md` — record the decision (required by repo rules).

**NEW**

18. `tests/dom/appearance/typography.test.tsx` — happy-dom: `:root` variables/attributes set correctly; `.font-mono` still resolves to the fixed default (not the code selection); `[data-slot="terminal-block"]` / `[data-slot="code-diff"]` carry the right vars; reset isolation; pre-paint vs runtime agreement (via the shared normalization).

**NOT touched:** `LogsPanel.tsx`, `surfaces.tsx` (`mono`), `tool-timeline.tsx` chips (L75/L86, metadata), `context-display.tsx`, sidebar/scheduler/opencode pages (except the lines listed in #11), `ChatWindow.tsx` L472/L992/L1090, `.font-mono` utility, `ThemeLab.tsx` (only the two dead code classes), `OpenCodeConfigPage.tsx` L167 (see §10 Q8).

## 6. Tauri WebView zoom-hotkey decision

Set `"zoomHotkeysEnabled": false` on the `main` window (`src-tauri/tauri.conf.json` L20–30). Verified against the installed schema: `WindowConfig.zoomHotkeysEnabled`, boolean, default `false`, Windows → WebView2 `IsZoomControlEnabled`. Explicit setting = pinned behavior + self-documenting; no JS keyboard interception; no double scaling (CSS zoom is the only scale mechanism). **Verification:** packaged Windows build in the `tauri` CI job - Ctrl+Plus/Minus/0 must not change WebView zoom (verified at the default application scale). Settings scale persistence across restart is covered by the browser E2E persistence test, not by the packaged artifact. (In a plain dev browser Ctrl+Plus *will* zoom - that's the browser, not the app, and is out of scope.)

## 7. CSS & rendering strategy

- **Font ownership is explicit; `--font-mono` is never written by a setting.** `--font-sans` = interface; `--font-mono` = fixed generic monospace stack (logs, IDs, paths, token counts, tool metadata — unchanged by any setting); `--code-font-family` = selected code font; `--terminal-font-family` = selected terminal font. Code-specific properties apply only to actual code surfaces; terminal properties only to `[data-slot="terminal-block"]`.
- **Interface font size = actual font-size setting, not zoom.** Root `font-size` stays `16px`; Tailwind v4 `--text-*` are overridden in **plain `@theme`** to `calc(var(--interface-font-size) * <default rem>)` — verified empirically against the installed `tailwindcss@4.3.3`: `:root` receives `--text-sm: calc(var(--interface-font-size) * 0.875)` and utilities emit `font-size: var(--text-sm)`. The `--text-*--line-height` tokens are **unitless ratios** (`calc(1.25 / 0.875)`) and need no override — they scale proportionally. `text-2xs/3xs` become calc() too. Zero visual change at the 16px default; spacing, radius and layout stay fixed. (`@theme inline` was tested and rejected: it inlines the calc into every utility and drops the `:root` variable; it is only required for same-name `var()` references such as the repo's `--font-sans: var(--font-sans)`. Rejected alternative: `:root { font-size: var(--interface-font-size) }` — scales all rem including spacing/radius.)
- **Application scale = CSS `zoom`** on `documentElement` (kept; supported in WebView2/Chromium and Firefox 126+; already covered by the 75/100/150 e2e). Stored as `appScale` **factor** (0.75–1.5); never writes font preferences.
- **Code wrap** is `white-space` only → copying preserves source exactly; diffs excluded (always `whitespace-pre` + horizontal scroll); horizontal scroll preserved when off.
- **Terminal wrap** applies only to `TerminalBlock` rows; `pre-wrap` preserves spaces/tabs/newlines so indentation survives; `overflow-wrap:anywhere` breaks unbroken strings. No PTY exists, so no character-cell/cursor concerns. Logs and metadata are never matched by these rules.
- **Reading line height** becomes a real rule on `.aui-md-p` / `.aui-md-li` (replacing the dead inherited variable + `leading-relaxed`).
- Code/terminal/interface families are `var(--code-font-family)` / `var(--terminal-font-family)` / `var(--font-sans)`; `.font-mono` and the generic `code, kbd, samp, pre` rule keep `var(--font-mono)` — no global size/weight changes.

## 8. UI organization & reset behavior

One `SettingsSection` ("Typography") containing five bordered groups, each with its own Reset (ghost button) and the section header carrying **Reset all** — same visual language as today. Order: Interface → Code → Terminal → Reading → Application Scale. Each group shows a live preview (interface: text sample; code: existing Shiki preview; terminal: a `TerminalBlock`-style sample). Application Scale displays **75%–150%** (slider 0.75–1.5 step 0.0625; presets 75 / 87.5 / 100 / 112.5 / 125 / 150; trailing zeros trimmed), never px. Resets are scoped exactly as in §4; Reset all is atomic (single write of defaults). No new components beyond what `SettingsSection`/`SettingRow`/`Select`/`Input`/`Button` already provide.

## 9. Test strategy

- **Unit** (`tests/unit/appearance/typography.test.ts`): defaults; v1→v2 migration from *both* historical shapes with **exact factor values** (13→0.8125, 14→0.875, 15→0.9375, 18→1.125, 12→0.75, 24→1.5); `appScale` validation (NaN, 0.5, 2, `"1.25"` → default 1); per-field validation; independent weight clamping (incl. discrete Lato); each scoped reset preserves the others; master reset; corrupted/outdated recovery; bootstrap parity guard (source-text check on `index.html`: sets `--code-font-family`, never `--font-mono`; factor zoom).
- **DOM** (`tests/dom/appearance/typography.test.tsx`, happy-dom): `:root` carries the right variables/`data-*` attributes; `.font-mono` still resolves to the fixed default stack (not the code selection); `[data-slot="terminal-block"]` / `[data-slot="code-diff"]` carry the right vars; updating one group leaves the others' variables untouched; bootstrap-vs-TS normalization agreement (shared pure function + source-text guard on `index.html`).
- **E2E** (`tests/e2e/appearance-scaling.spec.ts`, real browser): **independent computed-style assertions** — interface change ⇒ code/terminal computed font-family/size/weight unchanged; code change ⇒ interface/terminal unchanged; terminal change ⇒ interface/code unchanged; app scale changes geometry but not stored font prefs; code wrap on ⇒ copied text byte-identical; terminal wrap ⇏ code wrap; reading line height affects prose only; each reset preserves unrelated groups; Reset all restores defaults; reload persists. Keep the 75/100/150 overlay/virtualizer regression.
- **Packaged app** (`scripts/verify-packaged-webview-origin.ts`, `zoom-hotkeys` stage, `tauri` CI job, Windows WebView2, medium integrity): Ctrl+Plus/Minus/0 leave `window.devicePixelRatio` unchanged (verified at the default application scale); the app's inline `style.zoom` and computed root font-size are asserted separately. Settings scale persistence across restart is covered by the browser E2E persistence test, not by the packaged artifact. Reuses the existing session/driver/port-mirror/integrity machinery - no duplicate infrastructure.
- Gates: `bun run verify` + `bun run test:dom` + the `tauri` job; report real numbers.

## 10. Risks & unresolved questions

1. ~~Interface-size mechanism~~ — **resolved (verified).** Plain `@theme` override of `--text-*` to `calc(var(--interface-font-size) * <default rem>)`; compiled a scratch stylesheet with the installed `tailwindcss@4.3.3` and confirmed `:root` receives the calc variable and utilities emit `font-size: var(--text-sm)`. `--text-*--line-height` are unitless ratios — no override needed. `@theme inline` tested and rejected (inlines calc into every utility, drops the `:root` variable; only needed for same-name `var()` references). Root `font-size` stays `16px`.
2. ~~Arbitrary `text-[Npx]`~~ — **resolved (inventoried & classified, see §13.2).** Interface text → calc/`text-2xs`/`text-3xs` (zero-diff, responds); compact metadata → fixed; code/terminal → their owners; status notices → fixed. No blanket replacement.
3. **Reasoning text** (`.aui-reasoning-text`, `reasoning.tsx` L280) — include in Reading line-height scope? *Proposed: yes (it is prose); confirm.*
4. **Terminal wrap default** — proposed `true` (preserves today's wrapping; implemented as `pre-wrap` + `overflow-wrap:anywhere`, strictly better for unbroken strings). Confirm.
5. ~~`appScale` representation~~ — **resolved.** Factor `0.75–1.5` (default `1`); lossless migration from every legacy `baseSize` (all sixteenths, exactly representable); UI shows trimmed percent (`81.25%`, `87.5%`, `100%`); slider step 1/16.
6. **Packaged Ctrl+Plus test** — **resolved (reuse).** Implemented as a `zoom-hotkeys` stage inside the existing `scripts/verify-packaged-webview-origin.ts` session (Actions API via the same raw-HTTP `httpJson`); no new script, no duplicate driver/session/port-mirror/integrity logic. `tests/unit/tooling/webview-origin-evidence.test.ts` updated for the new stage. No CI workflow change — the `tauri` job already runs this script at medium integrity.
7. CSS `zoom` is non-standard (Baseline 2024); fine for WebView2, but if TBAi ever targets Firefox-ESR < 126 it breaks — noted, not acted on.
8. **`OpenCodeConfigPage.tsx` L167** — `<pre>` preview of `opencode.json`, fixed 11px. It is a code preview but does not use the code-block renderer. *Proposed: make it respond to `--code-font-size` (honest owner; 11→13px visual change). Alternative: keep fixed 11px as explicitly semantic. Maintainer to decide.*
9. Pre-existing drift fixed in passing (bootstrap weight clamping; dead `.ai-message-content`; dead `text-[13px]`; dead `.aui-code-diff` rule) — all inside files already being modified; no unrelated changes.
10. `.aui-md-pre` unlayered-vs-utility fragility disappears once the dead utilities are removed.

## 11. Implementation phases

1. **P1 — Storage v2 + migration + unit tests** (`typography.ts`, `index.html` bootstrap, unit tests).
2. **P2 — CSS strategy + rendering surfaces** (`globals.css`, `markdown-text.tsx`, `shiki-highlighter.tsx`, `terminal-block.tsx`, `code-diff.tsx`, `ChatWindow.tsx`).
3. **P3 — Appearance UI** (five groups, previews, scoped resets, `AppearancePage.tsx`, `TypographyPreview.tsx`).
4. **P4 — Tauri `zoomHotkeysEnabled` + packaged verification** (`tauri.conf.json`, `zoom-hotkeys` stage in `scripts/verify-packaged-webview-origin.ts`, `tests/unit/tooling/webview-origin-evidence.test.ts`). Independent after P1.
5. **P5 — DOM/E2E tests + full verify + `docs/decisions.md`.**

P1 → P2 → P3 are sequential; P4 is independent after P1; P5 closes. Each phase ends with its tests green; no commit until the full `verify` + `tauri` job pass.

## 12. Verdict

**IMPLEMENTED** in `dd82ed8` on branch `ci/tauri-e2e-verify`. All §10 decision points were resolved by the maintainer before implementation: reasoning body text follows the reading line height, terminal wrapping defaults ON, and the OpenCode JSON preview is a code surface (`[data-slot="code-preview"]`). `bun run verify` passed, and `tests/e2e/appearance-scaling.spec.ts` passed 10/10 in both `chromium-headless` and `edge-headless`.

**Verified facts** are marked as such above. The packaged WebView2 zoom observation cannot run on the development box (no MSVC linker, so neither `cargo install tauri-driver` nor `bunx tauri build` completes); it runs in the `tauri` CI job. §14 records the corrections made after the maintainer's review of the pushed implementation.

## 13. Revision 2 — corrected sections (2026-11-05, maintainer review)

### 13.1 CSS font ownership and exact selectors

Four independent owners; **no setting ever writes `--font-mono`**:

| Variable | Owner | Written by |
|---|---|---|
| `--font-sans` | Interface | Interface Font setting |
| `--font-mono` | Generic monospace (fixed default stack) | **nobody** — logs, IDs, paths, token counts, tool metadata |
| `--code-font-family` | Code surfaces | Code Font setting |
| `--terminal-font-family` | Terminal output | Terminal Font setting |

```css
/* Generic monospace — fixed default stack. LogsPanel, IDs, paths,
   token counts, tool metadata, .font-mono utility. Unchanged by any setting. */
code, kbd, samp, pre, .font-mono {
  font-family: var(--font-mono);
}

/* Code surfaces — selected code font + size + weight. */
.aui-md-pre,
.aui-md-pre code,
.aui-shiki-base pre,
.aui-shiki-base pre code,
.aui-md-inline-code,
.aui-code-block pre,
.aui-code-block code,
[data-slot="code-diff"] {
  font-family: var(--code-font-family);
}
.aui-md-pre,
.aui-md-pre code,
.aui-shiki-base pre,
.aui-shiki-base pre code,
[data-slot="code-diff"] {
  font-size: var(--code-font-size);
  font-weight: var(--code-font-weight);
}
.aui-md-inline-code {
  font-size: calc(var(--code-font-size) * 0.95);
  font-weight: var(--code-font-weight);
}

/* Terminal — selected terminal font + size + weight. */
[data-slot="terminal-block"] {
  font-family: var(--terminal-font-family);
  font-size: var(--terminal-font-size);
  font-weight: var(--terminal-font-weight);
}
```

- `TerminalBlock` drops `font-mono text-xs`; `CodeDiff` drops `font-mono text-xs` — CSS owns both via the `data-slot` selectors.
- **Dead rule removed:** `.aui-code-diff pre, .aui-code-diff code` (globals.css L542–543) — matches nothing; the component renders `data-slot="code-diff"` (`code-diff.tsx` L102). Replaced by `[data-slot="code-diff"]`.
- `[data-slot="code-diff-empty"]` (ChatWindow L991) and the L1090 error dump stay on the generic mono stack — they are status/diagnostic messages, not code.
- `.font-mono` utility keeps `var(--font-mono)` (via the existing `@theme inline` mapping) — LogsPanel, `surfaces.tsx` `mono`, `context-display.tsx`, `tool-timeline.tsx` chips, `approval-card.tsx`, sidebar/scheduler/opencode metadata: all unchanged.
- `index.html` bootstrap sets `--code-font-family` / `--terminal-*` / `--interface-font-size` / `--reading-line-height` / factor zoom — never `--font-mono`.

### 13.2 Arbitrary font-size classification (52 matches = 51 declarations + 1 comment)

**Code/terminal owner — remove dead declarations (5):**
`shiki-highlighter.tsx` L18 (`[&_pre]:text-[13px]`, dead), `markdown-text.tsx` L257 (`text-[13px]`, dead), `markdown-text.tsx` L269 (`text-[0.85em]`, dead), `ThemeLab.tsx` L142 + L150 (dev-lab mirrors). Plus `OpenCodeConfigPage.tsx` L167 (`<pre>` opencode.json preview, 11px) — **code preview, proposed → `var(--code-font-size)`; see §10 Q8**.

**Interface text — must respond to Interface Font Size (17):**
11px → `text-2xs` (0.6875×16 = 11px exact): `ChatWindow.tsx` L1073, L1078, L1086; `OpenCodeConfigPage.tsx` L211, L225, L238, L271, L533, L567, L697; `OpenCodeModelChip.tsx` L102.
10px → `text-3xs` (0.625×16 = 10px exact): `QuickMessagesPage.tsx` L301 (0.625rem).
13px → `calc(var(--interface-font-size) * 0.8125)`: `SidebarSection.tsx` L46.
13.5px → `calc(var(--interface-font-size) * 0.84375)`: `web-search.tsx` L85, `tool-timeline.tsx` L51, L69, `approval-card.tsx` L105.
All zero visual change at 16px; all respond to the setting. (Alternative: round to `text-xs`/`text-sm` — rejected, not zero-diff.)

**Compact metadata — intentionally fixed (25):**
`ActivityBar.tsx` L88 (9px badge); `ChatWindow.tsx` L472 (11px timestamp), L1090 (10px font-mono diagnostic dump); `tool-timeline.tsx` L75, L86 (11px font-mono chips); `surfaces.tsx` L44 (`mono`, 11px); `progress-stages.tsx` L75 (10px); `context-display.tsx` L554 (10px); `McpPanel.tsx` L76, L369, L375, L385, L387, L462, L703 (10px); `JobListItem.tsx` L168 (10px font-mono); `JobDetail.tsx` L279 (10px font-mono); `ProviderDialog.tsx` L602, L619, L631 (10px); `OpenCodeConfigPage.tsx` L495, L573 (11px font-mono), L580 (10px amber), L614 (10px); `web-search.tsx` L82 (9px badge).

**Compact status notices — fixed, documented (3):**
`code-budget.tsx` L128, `body-budget.tsx` L88 (truncation notices, `role="status"`), `edit-preview.tsx` L134 (occurrences notice).

**Not a declaration (1):** `globals.css` L272 (comment).

### 13.3 Exact scale migration

`appScale` is a **factor** `0.75–1.5` (default `1`); `zoom = String(appScale)`; property removed at exactly `1`. Migration `appScale = clamp(baseSize / 16, 0.75, 1.5)` is **lossless** — every legacy value is a sixteenth, exactly representable in binary floating point:

12→0.75 (75%) · 13→0.8125 (81.25%) · 14→0.875 (87.5%) · 15→0.9375 (93.75%) · 16→1 (100%) · 17→1.0625 (106.25%) · 18→1.125 (112.5%) · 19→1.1875 (118.75%) · 20→1.25 (125%) · 21→1.3125 (131.25%) · 22→1.375 (137.5%) · 23→1.4375 (143.75%) · 24→1.5 (150%)

Validation: finite number in range, else `1`. UI: slider `min=0.75 max=1.5 step=0.0625` (1/16 — exactly the legacy range), presets 75 / 87.5 / 100 / 112.5 / 125 / 150, display trims trailing zeros.

### 13.4 Revised minimal file list

See §5 (revised): `scripts/verify-packaged-zoom-hotkeys.ts` is **not** created; the zoom-hotkey check is a `zoom-hotkeys` stage inside the existing `scripts/verify-packaged-webview-origin.ts` session (Actions API via the same raw-HTTP `httpJson`), with `tests/unit/tooling/webview-origin-evidence.test.ts` updated. No CI workflow change.

### 13.5 Updated test requirements

- **Unit:** exact factor migration values (13→0.8125, 14→0.875, 15→0.9375, 18→1.125); `appScale` validation (NaN / 0.5 / 2 / `"1.25"` → 1); bootstrap parity guard (`index.html` sets `--code-font-family`, never `--font-mono`; factor zoom).
- **DOM:** `.font-mono` resolves to the fixed default (not the code selection); `[data-slot="terminal-block"]` / `[data-slot="code-diff"]` carry the right vars; reset isolation.
- **E2E:** independent computed-style assertions for interface / code / terminal / app scale; code wrap on ⇒ copied text byte-identical; terminal wrap ⇏ code wrap; reading line height affects prose only; resets preserve unrelated groups; 75/100/150 regression retained.
- **Packaged (`tauri` CI job, medium integrity):** `zoom-hotkeys` stage - `window.devicePixelRatio` is read, then each of `Ctrl+=`, `Ctrl+Shift+=`, `Ctrl+-` and `Ctrl+0` is sent separately with a read taken immediately before and after it; every pair must be identical. The app's inline `style.zoom` and computed root font-size are asserted separately (application scaling, not browser zoom). The packaged artifact verifies browser zoom shortcuts at the default application scale; it does not prove non-default application-scale persistence across packaged restarts (that is covered by the browser E2E persistence test).

## 14. Post-review corrections (2026-11-05)

The maintainer reviewed the pushed implementation and found two real defects and one documentation issue. All three are corrected here.

### 14.1 Packaged zoom probe could pass falsely

The stage compared one read taken before all three chords with one read taken after them, and treated `document.documentElement.style.zoom` plus the computed root font-size as the browser-zoom signal. Both choices are wrong:

- `style.zoom` is TBAi's own inline CSS scale, not the WebView's page zoom.
- Page zoom moves `window.devicePixelRatio`; the computed root font-size can stay unchanged.
- `Ctrl+0` resets the zoom, so a working `Ctrl+=` followed by `Ctrl+0` ends exactly where it started and the endpoint comparison passes.

The stage now reads `window.devicePixelRatio` as the browser-zoom signal, sends each chord separately (`Ctrl+=`, `Ctrl+Shift+=`, `Ctrl+-`, `Ctrl+0`), and compares the reads taken immediately before and after **each** chord. The app's inline `zoom` and computed root font-size remain a separate assertion. A partial probe fails: every shortcut in `ZOOM_SHORTCUTS` must be present in the recorded steps.

`tests/unit/tooling/webview-origin-evidence.test.ts` covers the failure matrix, including the exact regression this replaced: a `Ctrl+=` that moves the pixel ratio followed by a `Ctrl+0` that resets it now fails on the `Ctrl+=` step. The guard was falsified by temporarily restoring the endpoint comparison — the regression case failed with `stage: null` — then reverted.

### 14.2 OpenCode JSON preview ignored the selected code font

`OpenCodeConfigPage.tsx` renders `<pre data-slot="code-preview"><code>{raw}</code></pre>`. The code-font rule covered the `<pre>` but not the nested `<code>`, and the generic `code` rule applies `--font-mono` directly to that child, so selecting a code font never reached the visible text. `[data-slot="code-preview"] code` is now in the same selector group that sets `var(--code-font-family)`.

Coverage, both halves:

- `tests/e2e/appearance-scaling.spec.ts` — the real component is rendered against a stubbed `/api/opencode/config` snapshot (the e2e server has no managed OpenCode server or global config), and the computed font family of the nested `<code>` is asserted after selecting a non-default code font.
- `tests/dom/appearance/typography.test.tsx` — the stylesheet guard asserts both selectors belong to the same code-font rule, and the component anchor asserts the preview really nests a `<code>` element.

Both guards were falsified: removing the selector failed the stylesheet guard, and replacing `<code>` with a non-code element failed the component anchor.

### 14.3 This document's status

The status line said "Plan only — awaiting maintainer approval. No code modified, nothing committed or pushed." while the implementation was already committed in `dd82ed8`. It now records the implementation and this section records the corrections.
