# TBAi — Application-Wide Typography & Font Consistency Audit

**Date:** 2026-11-05
**Status:** Read-only investigation and evidence gathering. No code modified.
**Baseline:** branch `ci/tauri-e2e-verify`, HEAD `dd82ed8` ("feat(appearance): independent typography per surface with factor-based app scale").
**Working tree at audit time:** 7 files uncommitted — `globals.css` (+1 line: adds `[data-slot="code-preview"] code` to the code-font selector list, i.e. the fix for defect §14.2 of the plan doc), two test files (`tests/dom/appearance/typography.test.tsx`, `tests/e2e/appearance-scaling.spec.ts`), two docs, two scripts. The audited core (`typography.ts`, `index.html`, `AppearancePage.tsx`, `ThemeLab.tsx`, `theme-css.ts`) is clean at HEAD.

---

## Part 1 — Executive findings

### Overall consistency

The typography architecture is **internally coherent and mostly works**. All five settings (Interface, Code, Terminal, Reading Line Height, Application Scale) follow the complete chain:

```
User setting → localStorage (`tbai-typography`) → pre-paint bootstrap (web/index.html)
             + runtime applyTypographyToDom (typography.ts) → CSS vars on <html>
             → globals.css rules → rendered components
```

The e2e layer proves it with real `getComputedStyle` assertions in Chromium.

### Where each setting actually lands (verified)

- **Interface family/size/weight** → the whole Tailwind type ramp via `@theme` `calc()` tokens. Applied to ~480+ scale-responsive `text-*` utilities app-wide.
- **Code family/size/weight** → fenced markdown, shiki blocks, inline code, diffs, and the OpenCode JSON preview (via the unlayered `[data-slot]`/`.aui-*` rules).
- **Terminal family/size/weight** → `[data-slot="terminal-block"]` root and the inherited row `div`s.
- **Reading line-height** → `.aui-md-p`, `.aui-md-li`, `.aui-reasoning-text` only (prose; deliberately not code/controls).
- **App scale** → `zoom` on `<html>` (0.75–1.5). Tauri disables native zoom hotkeys (`zoomHotkeysEnabled: false`), so this is the only application-level scale path.

### Most important confirmed problems

1. **~28 literal-pixel `text-[Npx]` declarations bypass the interface scale** — compact metadata chips, badges, timestamps and counters stay visually fixed when Interface Font Size changes, while surrounding text grows. The scale-locked pattern (`text-[calc(var(--interface-font-size)*…)]`) already exists in 5 places and was simply not generalized.
2. **The `mono` helper** (`font-mono text-[11px] tracking-tight`, `surfaces.tsx:44`) is a fixed-size, fixed-stack double bypass used in 4 assistant-ui elements for metadata chips.
3. **The fixed `--font-mono` generic stack is a third, silent family channel** — logs, token counts, paths, tool metadata, and even terminal *error lines* (`terminal-ui.tsx:122,127`) render in the fixed generic mono, not the user's terminal/code choice. Documented as deliberate, but its boundaries are inconsistent in practice.
4. **Interface font weight only affects inherited text** — 124× `font-medium`/`font-semibold` and 9× `font-normal` pin fixed numbers; every button (`components/ui/button.tsx:8` defaults to 500) ignores the setting.
5. **`folder-tile` `@utility` hardcodes 10px/700/line-height:1** (documented as deliberate geometry, still a bypass).
6. **Settings-page title sizes are inconsistent across routes** — the canonical `settings.tsx` grammar uses `text-base`, but `/mcp`, `/logs`, `/providers`, `/quick-messages` re-implement their own `h1` at `text-base`/`text-sm`.

### Important unknowns (need runtime verification)

- Whether the bundled `@fontsource` woff2 actually loads and renders — no `document.fonts` test; e2e only checks the computed *string* of the family, which is identical even when the font silently falls back.
- Extreme-scale behavior (75%/150%) for the fixed-pixel elements — legibility/clip at scale. E2e covers overflow only, not typography legibility.
- The `.aui-md-pre`-specific cascade win is not locked by a computed test (only shiki + `code-preview` cases are, per the test audit).

### Corrections to earlier in-conversation claims

Two findings made earlier in this session were **wrong** and are corrected by direct source verification:

1. "Code font setting is mostly decorative — the global `pre`/`code` element rule beats the code-surface rule." **False.** The `.aui-md-pre` / `[data-slot=…]` / `.aui-* pre` rules are (0,1,0)+(0,1,1) **unlayered**; the element rule is (0,0,1). The code-font rule wins on every fenced code block, inline code, diff and JSON preview. The `font-mono` utility class on those elements is a dead carrier (layered, loses to unlayered CSS).
2. "Terminal rows stay 11px regardless of the Terminal Font Size setting." **False.** `TerminalBlock` rows are plain `div`s that inherit from the `[data-slot="terminal-block"]` root, which the unlayered CSS rule sets to `var(--terminal-font-size)`. The 11px `mono` helper is used only on the "failed"/"exit 0" status chips, not the output rows.

---

## Part 2 — Existing typography architecture

### Storage

Single JSON object `tbai-typography` (v2) in `localStorage`, read by `readTypography()` (`typography.ts:432`). `:root` defaults in `globals.css:31-49` are the fallback when no setting is stored.

### Font families & bundling

`web/package.json:19-29` declares 11 fontsource packages; `globals.css:5-15` imports all 11 (10 variable + 1 static). All are installed and present under `web/node_modules/@fontsource*/`.

| Group (id in `typography.ts`) | Bundled (woff2) | System-only fallback |
|---|---|---|
| UI_FONTS (10) | inter, roboto, open-sans, source-sans-3, plus-jakarta-sans, outfit, figtree, lato (static 100/300/400/700/900) | **sf-pro**, **system** |
| MONO_FONTS (5) | jetbrains-mono, fira-code, source-code-pro | **sf-mono**, **system-mono** |

So 13 of 15 families rely on OS fonts; on Windows the "SF Pro"/"SF Mono" options silently fall through to Segoe UI / Consolas / system mono.

**Lato special case:** `@fontsource/lato` (static, not `@fontsource-variable/lato`) ships only fixed woff2 at weights 100/300/400/700/900. `typography.ts:145` matches this (`weights: [100, 300, 400, 700, 900]`); `clampWeightForFont` (the discrete branch) snaps to the nearest available weight, mirrored in the pre-paint bootstrap.

### How settings are applied (two paths, kept in lockstep)

- **Pre-paint** — inline script in `web/index.html:47-149` mirrors `typography.ts`'s v1→v2 migration, validation and per-font weight clamping, writing the same vars + `zoom` before first paint. A unit test extracts `FONT_MAP`/`MONO_MAP` from this file and asserts they match `UI_FONTS`/`MONO_FONTS` on **families only** (see Part 10).
- **Runtime** — `applyTypographyToDom()` (`typography.ts:463`) writes vars + `zoom` + `data-code-wrap`/`data-terminal-wrap` on user change / reset.

### CSS tokens (single source of truth)

The `:root`/`.dark` block + `@theme` type-scale (`calc()` of `--interface-font-size`, `globals.css:289-302`) + `@utility text-2xs/3xs` (`globals.css:309-314`) + the unlayered code/terminal/reading/wrap rule blocks (`globals.css:559-628`).

- **No `!important`** exists in first-party CSS or JS (the only `!` is a shiki background utility, font-irrelevant).
- Unlayered plain CSS beats Tailwind's `@layer utilities` — this is exactly why the `.aui-*`/`[data-slot]` rules outrank the `font-mono` utility on the same element.
- `@theme inline` (`globals.css:228-280`) inlines values into utilities for colour/radius/shadow; `--font-sans` self-references are valid only because `inline` form is used there.
- No `tailwind.config.*` exists; Tailwind v4 is config-free, all tokens flow through `@theme`/`@utility` in `globals.css`.

### Flow per setting (all complete, verified)

| Setting | Persist | Pre-paint | Runtime | CSS var consumed by | Rendered target |
|---|---|---|---|---|---|
| Interface family/size/weight | ✅ | ✅ | ✅ | `--font-sans`,`--interface-font-size`,`--font-weight-base` | whole `text-*` ramp (inherited) |
| Code family/size/weight/wrap | ✅ | ✅ | ✅ | `--code-font-*`,`data-code-wrap` | `.aui-md-pre`,`[data-slot=code-diff/code-preview]`,shiki,inline code |
| Terminal family/size/weight/wrap | ✅ | ✅ | ✅ | `--terminal-font-*`,`data-terminal-wrap` | `[data-slot="terminal-block"]` + inherited rows |
| Reading line-height | ✅ | ✅ | ✅ | `--reading-line-height` | `.aui-md-p/.aui-md-li/.aui-reasoning-text` only |
| App scale | ✅ | ✅ | ✅ | `zoom` on `<html>` | whole viewport uniformly |

### `zoom` / Tauri

`document.documentElement.style.zoom` is the only application-scale mechanism, written by `applyTypographyToDom` (`typography.ts:498-503`) and the pre-paint bootstrap (`index.html:140-144`). `src-tauri/tauri.conf.json:30` sets `zoomHotkeysEnabled: false` on the `main` window — this only disables Tauri's native Ctrl+±/Ctrl+0 hotkeys; it does **not** set a default zoom, font size, or `defaultFontSize`. No webview font/DPI/zoom-factor configuration exists in `src-tauri` (Rust or config). The webview inherits system/WebView2 defaults for anything not covered by the app's CSS variables.

---

## Part 3 — Complete application surface inventory

**Global chrome** (`components/` + `app/layout/AppShell.tsx`): ActivityBar, Sidebar (+ sections/rows/folders), TabStrip, StatusBar, CommandPalette, Left/RightEdgeChrome, WindowControls, PageContextMenu, ContextMenus, Tooltips.

**Chat** (`ChatWindow.tsx`, `features/chat/`): user/assistant messages, `AssistantTurnFooter` (model/duration/tokens/sent-at), reasoning block, tool groups, welcome screen + composer (`Composer.tsx`), `ContextRing`/`ContextDisplay`, error card.

**Tool rendering** (`components/assistant-ui/elements/` + `tools/`): tool-group/timeline (`tool-timeline.tsx`), approval cards (`components/shared/approval-card.tsx`, vendored `elements/approval-card.tsx` is unused/reference), web-search (`web-search.tsx`), browser/filesystem/computer/scheduler/todo UIs (`tools/<engine>/`), terminal block (`terminal-block.tsx`), code-diff (`code-diff.tsx`), code-budget (`code-budget.tsx`), result-fields (`result-fields.tsx`), body-budget (`body-budget.tsx`), edit-preview (`edit-preview.tsx`), context-display (`context-display.tsx`), progress-stages (`progress-stages.tsx`), agent-status (`agent-status.tsx`), reasoning (`reasoning.tsx`), compaction-divider.

**Code & technical content (D):** markdown fenced (`markdown-text.tsx` `pre` override, `aui-md-pre`), shiki-highlighted (`shiki-highlighter.tsx`, `.aui-shiki-base`), inline code (`aui-md-inline-code` + `font-mono`), diffs (`code-diff.tsx`, `[data-slot="code-diff"]`), OpenCode JSON preview (`OpenCodeConfigPage.tsx`, `[data-slot="code-preview"]` + nested `<code>`), tool JSON bodies (`Json`/`FieldsOrJson` via `BoundedBody`), logs (`LogsPanel.tsx`), terminal output (`terminal-block.tsx`), error details/stack (`ChatWindow.tsx` error card `<pre>`).

**Settings (E)** — 11 routes under `SettingsLayout` (`router.tsx:84-150`): `/memories`, `/mcp`, `/logs`, `/folders`, `/quick-messages`, `/providers`, `/appearance`, `/desktop`, `/workspace`, `/opencode-config`; plus `/scheduler` as a top-level workbench route (`router.tsx:64`). Shared grammar: `components/shared/settings.tsx`.

**Dialogs/overlays (F):** confirm dialogs, provider dialogs, import dialogs (OpenCode), approval cards, search overlay (CommandPalette), popovers/dropdowns/context menus, `ElicitationModal`, question forms (OpenCode Questions).

**Special content (G):** markdown headings/lists/tables/blockquotes (`markdown-text.tsx` overrides), mermaid (`mermaid-source.tsx`), assistant reasoning (`reasoning.tsx`), syntax-highlighted content, long unbroken strings (code `whitespace-pre` + `codeScroll`).

---

## Part 4 — Typography behavior matrix

Legend: **Applied** = setting visibly controls it · **Inherited** = inherits from parent · **Fixed** = hardcoded, ignores the setting · **Overridden** = a closer rule wins · **N/A** · **Not verified** = needs runtime.

| Surface (representative element) | Int. family | Int. size | Int. weight | Code fam/size | Terminal fam/size | Reading LH | App scale |
|---|---|---|---|---|---|---|---|
| Prose `.aui-md-p`/li (chat) | Applied | Applied (text-sm) | Inherited | N/A | N/A | **Applied** | Applied |
| Reasoning body | Applied | Applied | Inherited | N/A | N/A | Applied | Applied |
| Markdown code / shiki / inline | Applied (mono base) | Fixed (code ramp) | N/A | **Applied** | N/A | Fixed (leading-relaxed) | Applied |
| Diff rows | Applied | Fixed | N/A | Applied | N/A | Fixed | Applied |
| Terminal output rows | Applied | Fixed | N/A | N/A | **Applied** | N/A | Applied |
| Terminal "exit 0"/"failed" chips | Applied | **Fixed** (11px mono helper) | N/A | N/A | **Fixed** | N/A | Applied |
| Tool metadata chips / `mono` helper | Applied | **Fixed** (11px) | N/A | **Fixed** | **Fixed** | N/A | Applied |
| Timestamps / token counts / counters | Applied | **Fixed** (10–11px) | N/A | N/A | N/A | N/A | Applied |
| Settings titles/labels (grammar) | Applied | Applied | Fixed (font-semibold) | N/A | N/A | Fixed (leading-5) | Applied |
| Settings descriptions | Applied | Applied | Inherited | N/A | N/A | **Fixed** (leading-5) | Applied |
| Log view / logs | Applied | **Fixed** (2xs + leading-5) | N/A | **Fixed** (generic mono) | **Fixed** | N/A | Applied |
| Folder tile (sidebar) | **Fixed** (10px/700) | **Fixed** | **Fixed** | N/A | N/A | N/A | Applied |
| Buttons / controls | Applied | Applied | **Fixed** (500 default) | N/A | N/A | N/A | Applied |
| Everything (zoom) | — | — | — | — | — | — | **Applied** |

**Setting ownership matrix (control → scope):**

| Setting | Intended scope | Actual scope | Known exceptions | Confirmed gaps |
|---|---|---|---|---|
| Interface size | all UI text | type ramp (xs–9xl, 2xs, 3xs) | ~28 literal `text-[Npx]` chips; folder-tile | counters/badges/timestamps stay fixed |
| Interface family | all UI text | inherited everywhere | system-only families (sf-pro/system) fall through on Windows | no font-load test |
| Interface weight | base text | inherited base only | every `font-medium/semibold/normal` (181 sites) | headings/buttons ignore it |
| Code family/size | code blocks, diffs, previews | fenced/shiki/inline/diff/JSON-preview | `font-mono` chips in diffs & terminal error lines use generic stack | `.aui-md-pre` win not test-locked |
| Terminal family/size | terminal output | block + inherited rows | `mono` chips, `terminal-ui` error lines bypass | row inheritance untested |
| Reading LH | prose | p/li/reasoning only | settings desc, code, diffs use fixed leading | li/reasoning untested at computed level |
| App scale | whole UI | zoom on `<html>` | none (uniform) | extreme-scale legibility unverified |

---

## Part 5 — Hardcoded typography inventory

Full line-level detail was gathered by a dedicated surface auditor; the load-bearing groups:

### A. Literal-pixel sizes (bypass interface scale) — 28 sites

Clustered in:

| File:line | Value | Surface |
|---|---|---|
| `components/ActivityBar.tsx:88` | `text-[9px]` | scheduler-unseen-count badge (rail icon corner) |
| `components/assistant-ui/elements/web-search.tsx:82` | `text-[9px]` | web-search "domain" chip glyph |
| `components/ChatWindow.tsx:1090` | `text-[10px]` | error-card raw `<pre>` details (with `font-mono`) |
| `components/assistant-ui/elements/progress-stages.tsx:75` | `text-[10px]` | agent-progress stage percentage |
| `components/assistant-ui/elements/context-display.tsx:554` | `text-[10px]` | context-ring meter readout |
| `features/mcp/components/McpPanel.tsx:76,369,375,385,387,462,703` | `text-[10px]` | MCP transport/status chips, enabled/disabled text, resource label, error hint |
| `components/assistant-ui/elements/code-budget.tsx:128` | `text-[11px]` | code block truncation notice |
| `components/assistant-ui/elements/tool-timeline.tsx:75,86` | `font-mono text-[11px]` | tool group / tool label metadata chips |
| `tools/body-budget.tsx:88` | `text-[11px]` | tool body truncation notice |
| `tools/edit-preview.tsx:134` | `text-[11px]` | edit-preview notice line |
| `components/ChatWindow.tsx:472` | `text-[11px]` | message timestamp |
| `features/providers/ProviderDialog.tsx:602,619,631` | `text-[10px]` | model-chip "default" label, context-window input, "set window" link |
| `features/scheduler/components/JobListItem.tsx:168` | `text-[10px] font-mono` | job name / cron chip |
| `features/scheduler/components/JobDetail.tsx:279` | `text-[10px] font-mono` | run id / prompt chip |
| `features/opencode/OpenCodeConfigPage.tsx:498,576` | `font-mono text-[11px]` | config source path / rule resource |
| `features/opencode/OpenCodeConfigPage.tsx:583,617` | `text-[10px]` | malformed-config warning, footer hint |
| `components/assistant-ui/elements/surfaces.tsx:44` | `text-[11px]` | inside `mono` export (see B) |

**The correct scale-locked pattern (5 sites, kept as examples):** `approval-card.tsx:105` (`*0.84375`), `tool-timeline.tsx:51,69` (`*0.84375`), `web-search.tsx:85` (`*0.84375`), `SidebarSection.tsx:46` (`*0.8125`).

### B. `mono` helper (fixed 11px + generic stack) — `surfaces.tsx:44`

`export const mono = "font-mono text-[11px] tracking-tight";` — importers: `agent-status.tsx:56` (elapsed chip), `code-diff.tsx:108` (`+N −M` count row), `terminal-block.tsx:86,98` ("failed"/"exit 0" chips), `web-search.tsx:88` (domain chip).

### C. `font-mono` (generic stack, intentional) — ~52 direct uses

Logs, IDs, paths, counts, tool result values, terminal error lines (`terminal-ui.tsx:122,127`), command-palette subtitle, scheduler chips, OpenCode session ids, MCP names, folder paths. Deliberate per the `globals.css:559` comment, but the boundary is fuzzy (see Part 9 #6).

### D. Font-weight pins — 181 declarations

`font-medium`×124 (incl. `button.tsx:8` base — every button defaults to 500), `font-semibold`×47 (headings, semantic), `font-normal`×9 (pins 400, defeats a raised base weight: `tool-group.tsx:116`, `context-menu.tsx:50,89,143`, `dropdown-menu.tsx:52,171`, `OpenCodeImportDialog.tsx:402`, `JobEditor.tsx:455`, `JobListItem.tsx:163`), `font-bold`×1 (`ActivityBar.tsx:65` logo square).

### E. Line-height pins

`leading-5`×12 + `leading-4`×2 on all `settings.tsx` descriptions (`settings.tsx:31,90,128,153`) and `LogsPanel` (732,767,789,879,970,1010) — pin a fixed px line-height independent of `--reading-line-height`. `leading-relaxed` on `code-diff.tsx:120`, `markdown-text.tsx:255`, `shiki-highlighter.tsx:18` (`[&_pre]`), `compaction-divider.tsx:206`, `ThemeLab.tsx:138,150`, `OpenCodeConfigPage.tsx:169`. `leading-none` on single-line chrome (layout-appropriate, no conflict).

### F. `folder-tile` `@utility` — `globals.css:327-329`

`font-size: 10px; font-weight: 700; line-height: 1;` — a hardcoded tile that bypasses every font variable (documented as fixed geometry, deliberately).

### G. `:root font-size: 16px` fixed — `globals.css:52`

Any element that **inherits** `font-size` rather than using a `text-*` utility renders at the fixed 16px regardless of `--interface-font-size` (e.g. bare `font-mono` input in `JobEditor.tsx:688`, `TerminalBlock` card root before the `[data-slot]` override, several `font-medium` divs in `ThemeLab.tsx`/tool UIs).

### H. `text-[calc(var(--interface-font-size)*…)]` (correct, scale-locked) — 5 sites

Listed in §A. These are the pattern the literal-px sites should adopt.

### I. Inline `style={{ … }}` font metrics — none

Zero inline-style `fontSize`/`fontFamily`/`fontWeight`/`lineHeight` declarations in `web/src`. All 15 `style={{…}}` sites found are colour/geometry or library `animationDelay`.

---

## Part 6 — CSS cascade & override findings

### The decisive contest: code-block font-family

For a fenced `<pre class="aui-md-pre"><code>`:

| Rule (globals.css) | Sets | Specificity | Layer |
|---|---|---|---|
| `code,kbd,samp,pre,.font-mono` (561-567) | `var(--font-mono)` | element `pre`/`code` = **(0,0,1)**; `.font-mono` = (0,1,0) | unlayered |
| `.aui-md-pre, … [data-slot="code-preview"] code, …` (571-583) | `var(--code-font-family)` | `.aui-md-pre` = **(0,1,0)**; `X pre`/`X code` = **(0,1,1)** | unlayered |

**Winner:** the code-surface rule (higher specificity, both unlayered). **Verdict: the Code Font Family setting DOES change the rendered family on fenced code blocks, inline code, diffs, and the OpenCode JSON preview.**

Per-element results (element → winning rule → rendered family):

| Element | Winner | Rendered family |
|---|---|---|
| `<pre class="aui-md-pre">` | `.aui-md-pre` (0,1,0) | `--code-font-family` |
| `<code>` inside `.aui-md-pre` | `.aui-md-pre code` (0,1,1) | `--code-font-family` |
| shiki `<pre>` in `.aui-shiki-base`/`.aui-code-block` | `.aui-shiki-base pre` / `.aui-code-block pre` (0,1,1, tie, identical value) | `--code-font-family` |
| inline `<code class="aui-md-inline-code … font-mono">` | `.aui-md-inline-code` (0,1,0 unlayered beats `code` element (0,0,1) and beats the layered `font-mono` utility) | `--code-font-family` at 0.95× size |
| `[data-slot="code-diff"]` div (rows are plain divs) | `[data-slot="code-diff"]` (0,1,0 unlayered beats the same div's layered `font-mono`) | `--code-font-family` — the `font-mono` class is a **dead carrier** |
| `[data-slot="terminal-block"]` div + row divs | `[data-slot="terminal-block"]` (0,1,0 unlayered beats layered `font-mono`) | `--terminal-font-family` — `font-mono` class is a **dead carrier** again; rows inherit |
| `pre[data-slot="code-preview"]` + inner `<code>` | (0,1,0)/(0,1,1) | `--code-font-family` |
| `pre` at `ChatWindow.tsx:1090` (only `font-mono` class, no `.aui-*`) | layered `font-mono` utility (the only matching rule) | `--font-mono` — **NOT** code-font (intentional) |

**The `font-mono` utility class is a cosmetic no-op** on any element that also carries `.aui-md-pre`, `[data-slot="code-diff"]`, `[data-slot="code-preview"]`, `[data-slot="terminal-block"]`, or `.aui-md-inline-code` — it's in `@layer utilities` and the unlayered `.aui-*`/`[data-slot]` rule at equal-or-higher specificity always wins. It **does** apply where no such unlayered class exists (logs, IDs, token counts, tool metadata, `ChatWindow.tsx:1090`), which is the intended split.

### Terminal rows

The `[data-slot="terminal-block"]` rule (0,1,0 unlayered) sets family/size/weight on the root; the plain `div` rows **inherit** it. The 11px `mono` chips are the only fixed-size bits inside the block.

### Theme blocks

`theme-css.ts` `.dark` / `data-tbai-theme` blocks set **colours only** — they never set font metrics and cannot override typography.

### `!important`

None in first-party CSS or JS. The single `!` is a shiki background utility (`shiki-highlighter.tsx:18`, `[&_pre]:bg-muted/30!`) — background only, font-irrelevant.

### Tauri / webview

No webview font/zoom configuration (see Part 2). `zoomHotkeysEnabled: false` means the app-scale `zoom` is the sole application-level scaling path.

### ThemeLab cascade quirk

`ThemeLab.tsx:148-161` puts `aui-md-pre` on a **`div`** wrapping a real `<pre><code>` (its own comment at :115-118 claims it measures "the styling the app really ships"). Result: the outer div gets `.aui-md-pre` (0,1,0 → code-font), but the inner real `pre` only matches the generic element rule (0,0,1 → `--font-mono`), while the inner `<code>` gets `.aui-md-pre code` (0,1,1 → code-font). So the lab's "fenced block" specimen renders its text at `--font-mono`, **under-reporting** what the real chat surface shows (where the `pre` itself carries `aui-md-pre`). The lab measures a divergent tree.

---

## Part 7 — Confirmed defects

| ID | Sev | Location | Expected | Actual | Root cause | User-visible consequence | Confidence |
|---|---|---|---|---|---|---|---|
| D-1 | P2 | 28 literal `text-[Npx]` sites (§5A) | track Interface Font Size | fixed px; only App Scale moves them | arbitrary Tailwind px values don't reference `--interface-font-size` | changing interface size leaves timestamps/badges/counters visually unchanged while surrounding text grows | **High** (source) |
| D-2 | P2 | `surfaces.tsx:44` `mono` + 4 importers | follow code/terminal font+size | fixed 11px + generic mono stack | helper hardcodes both | metadata chips never adopt the user's chosen code/terminal font | **High** |
| D-3 | P2 | `:root font-size:16px` + bare elements (`JobEditor.tsx:688`, `TerminalBlock` root pre-override) | track interface size | inherit fixed 16px | no `text-*` utility on element | a few surfaces ignore the interface size setting | **Medium-High** |
| D-4 | P2 | `AppearancePage`/UI `font-medium`×124 incl. `button.tsx:8` base | Interface weight applies | every control pinned to 500 | weight utilities override `--font-weight-base` | changing body weight does nothing to buttons, headings, labels | **High** |
| D-5 | P3 | `terminal-ui.tsx:122,127` (exit/timeout lines) | use Terminal font | use generic `font-mono` | styled outside the `terminal-block` slot | terminal error lines stay in the fixed stack regardless of terminal font choice | **High** |
| D-6 | P3 | settings-page titles inconsistent (`/mcp` `text-base`, `/logs`,`/providers` `text-sm`) | single page-title role | three sizes for the same role | routes re-implement `h1` instead of the grammar | settings pages don't look uniform | **High** |
| D-7 | P3 | `folder-tile` `@utility` 10px/700 (`globals.css:327-329`) | intentional | fixed | documented geometry | sidebar tile ignores all font settings | **High** (intentional) |
| D-8 | P3 | 9 `font-normal` sites (§5D) | honor raised base weight | pinned 400 | explicit `font-normal` | raising the base weight leaves these at 400 | **High** |

---

## Part 8 — Intentional exceptions (do not auto-change)

- **`--font-mono` fixed generic stack** for logs, IDs, paths, token counts, tool metadata (`globals.css:559`) — explicitly "NEVER written by a setting"; a metadata channel, not a bug.
- **`leading-none` on single-line chrome** (titles, badges, swap labels) — layout-correct compact line height.
- **`text-2xs`/`text-3xs`** are *scale-locked* `calc()` of `--interface-font-size` (`globals.css:309-314`) — the *correct* compact-metadata sizes, unlike the literal `text-[10px]` chips which duplicate them at a fixed value.
- **Diffs never wrap** (`code-diff.tsx`) — intentional.
- **Code/terminal line-heights independent of reading LH** — by design (the setting's scope is prose).
- **`folder-tile` fixed 10px** — a geometric tile, documented deliberate.

---

## Part 9 — Inconsistency & design-decision register (not bugs; need a decision)

1. **Where do literal px chips live on the scale?** D-1's 28 sites: adopt `text-2xs/3xs` (scale-locked) or stay fixed for "stable dense metadata"? Currently they are fixed *and* the scale-locked equivalents already exist — the same job done inconsistently.
2. **What exactly is "Terminal typography"?** `terminal-ui.tsx` error lines and `mono` status chips bypass it (D-5). Should the whole block (incl. exit lines) be terminal-scoped, or only the output rows?
3. **`mono` helper ownership** — one shared helper vs per-surface metadata tokens.
4. **Interface weight semantics** — fixed-emphasis (current: headings/buttons always 500/600) vs base-relative. 124 medium + 47 semibold sites are the tension.
5. **Settings-page title role** — standardize on one size across all routes (D-6).
6. **Code vs metadata font boundary** — tool result values (`result-fields.tsx:222`), paths, and `JobDetail` prompt IDs are "code-looking" but use generic mono; decide which are code-font vs metadata.
7. **ThemeLab specimen fidelity** — it measures a divergent tree (Part 6); decide whether the lab should mirror the real DOM.
8. **System-only families on Windows** — sf-pro/sf-mono/system degrade to OS fonts; acceptable or should they be flagged.

---

## Part 10 — Test coverage & blind spots

**Layers & runner commands** (`package.json:25-36`):
- unit + integration: `bun run test` → `./tests/unit ./tests/integration`
- DOM: `bun run test:dom` → `./tests/dom` (happy-dom; `globals.css` is NOT loaded)
- E2E: `bun run test:e2e` → Playwright `tests/e2e` (isolated server on :3101)
- **No `tauri-packaged` test layer** (only `verify:packaged-origin`, CI-only, and cannot build on this dev box — no MSVC linker).

**What each relevant test actually proves:**

| File | Layer | Proves | Type |
|---|---|---|---|
| `tests/unit/appearance/typography.test.ts` | unit | defaults, v1→v2 migration (lossless), appScale validation, per-field v2 validation, weight clamping, `formatAppScale`, scoped resets, corrupted-storage recovery, **bootstrap family parity** (extracts `FONT_MAP`/`MONO_MAP` from `index.html`, compares to `UI_FONTS`/`MONO_FONTS`), bootstrap never writes `--font-mono` | config + source-text |
| `tests/dom/appearance/typography.test.tsx` | dom (happy-dom) | `applyTypographyToDom` writes the v2 var set and never `--font-mono`/`--font-weight-mono` (root inline-style only, **no computed style**); wrap attrs; source-text guards on `globals.css` selectors; vendored structural anchors (terminal-block, code-diff, OpenCodeConfigPage markup); **new guard: `[data-slot="code-preview"] code` is in the same code-font rule as `[data-slot="code-preview"]`** | root inline-style + source-text |
| `tests/e2e/appearance-scaling.spec.ts` | e2e (Chromium, real `getComputedStyle`) | interface/code/terminal independence, code & terminal wrap (byte-identical copy), reading LH prose-only, **OpenCode nested-`<code>` code font**, `zoom` geometry, 75/100/150 no-overflow | **computed-style (the real proof)** |

**Blind spots (important, untested):**

1. **Pre-paint *value* drift** — only families are guarded; the v1 `baseSize→appScale` math, zoom removal, and wrap-attr writes in `index.html` are mirrored but not asserted (the unit test only checks the strings `appScale`/`data-code-wrap`/`data-terminal-wrap` appear).
2. **`.aui-md-pre` cascade win** — only shiki + `code-preview` are computed-tested; the `class=aui-md-pre`-vs-`pre`-element win is not locked at the computed level.
3. **Terminal *row* font inheritance** — computed family/size asserted on the block, not a row.
4. **Interface weight vs the 181 `font-*` sites** — no test that headings/buttons honor (or intentionally ignore) `--font-weight-base`.
5. **Reading LH on `.aui-md-li` / `.aui-reasoning-text`** — only `.aui-md-p` is computed-tested.
6. **Font bundle availability** — no `document.fonts` assertion that e.g. Fira Code / Lato-400 actually load; a missing family returns the same computed string and silently passes the e2e family check.
7. **Packaged Tauri/WebView2** — CI-only, not buildable locally; Tauri-side font/zoom behavior is **unverified** here.

---

## Part 11 — Standardization requirements (decision topics only, no implementation)

A future standard must settle:

- **Semantic roles**: which named roles exist (body / dense-metadata / heading / code / terminal / reading-prose / control) and which one each surface maps to.
- **Interface-size coverage**: adopt the `text-2xs/3xs` scale-locked tokens for all compact metadata (retiring the 28 literal px sites) *or* explicitly mark which stay fixed.
- **Weight model**: fixed-emphasis (current) vs base-relative.
- **Code vs metadata font boundary**: exactly which mono surfaces use `--code-font-family`, which use `--terminal-font-family`, which stay on the fixed `--font-mono`.
- **Terminal scope**: does "terminal typography" include exit/timeout lines and status chips, or only output rows?
- **Reading-LH scope**: confirm prose-only, or extend to code/diff.
- **Settings-page title role**: one canonical size across all routes.
- **Extreme-scale policy**: what happens at 75%/150% for fixed-pixel elements.
- **Exceptions to document**: `folder-tile`, `leading-none` chrome, fixed `--font-mono` metadata.

---

## Part 12 — Evidence & confidence index

**Source-confirmed (high):** all of Part 6's cascade rulings (specificity computed from `globals.css:559-596`), the surface inventory (every `file:line` in Parts 3–5), `typography.ts`/`index.html` flow, font-package reconciliation (`web/package.json` ↔ `globals.css` ↔ `web/node_modules`), Tauri config (`tauri.conf.json:30`), the `mono`/`font-mono`/weight/leading/tracking counts.

**Runtime-confirmed:** the e2e `getComputedStyle` results (interface/code/terminal independence, wrap, reading-LH, `zoom`, OpenCode nested `<code>`) — but only for the specific elements the spec names.

**Inferences:** D-3 (inherited-16px elements) and the ThemeLab divergence — reasoned from the CSS, not executed.

**Unverified hypotheses:** D-7/folder-tile at extreme scale, Lato discrete-weight rendering, system-family Windows fallback, all packaged-WebView2 behavior (cannot build locally).

---

## Decisions needed before any implementation plan

1. **Compact metadata** — scale-locked (`text-2xs/3xs`) or deliberately fixed? (affects 28 sites + `mono` helper)
2. **Interface font weight** — keep fixed-emphasis (buttons/headings always 500/600) or make it base-relative?
3. **Terminal vs code boundary** — should terminal exit/timeout lines and status chips use `--terminal-font-family`, `--font-mono`, or the code font?
4. **Settings-page title** — standardize to one size across all settings routes?
5. **Testing scope** — add computed-style tests for the `.aui-md-pre` win, terminal *row* inheritance, `font-*` weight sites, and a `document.fonts` load assertion?
6. **Packaged Tauri** — accept that WebView2 font/zoom verification is CI-only (not runnable on this box)?
7. **System-only families** — document/flag the Windows fallback for sf-pro/sf-mono/system, or leave as-is?
