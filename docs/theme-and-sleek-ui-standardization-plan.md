# Comprehensive Architecture Plan: Sleek Borderless UI & Theme Standardization

**Document Version:** 1.0  
**Target:** TBAi Web Frontend (`web/src/`)  
**Design Philosophy:** Sleek, Thin, Modern (Borderless / Hairline Dividers + Soft Floating Elevation)

---

## 1. Executive Summary & Codebase Audit Findings

### 1.1 Inline Properties Audit (`web/src`)
A comprehensive AST and text scan across all TypeScript/TSX files in `web/src` was conducted to determine if hardcoded styles or inline properties were overriding themes.

* **Total `style={{ ... }}` occurrences found:** 20
  * **Dynamic Dimensions / Math Only:**
    * TanStack Virtualizer pixel heights and transforms (`VirtualizedTranscript.tsx`, `LogsViewer.tsx`).
    * Dynamic progress bar percentages (`context-display.tsx:431, 551`).
    * Dynamic animation stagger delays (`code-diff.tsx:124`).
    * User-custom folder color swatches (`FolderTile.tsx`, `FoldersPage.tsx`).
  * **Hardcoded Theme Colors in `style`:** **0 (Zero)**.
* **Hardcoded Tailwind Color Classes in JSX:**
  * Only 4 occurrences across the entire app:
    * Modal backdrop overlay: `bg-black/50` in `dialog.tsx` and `alert-dialog.tsx`.
    * Default folder color: `bg-[#6b7280]` in `FoldersPage.tsx`.
    * Log level badge: `bg-slate-500/15` in `LogRow.tsx`.

### 1.2 Core Diagnosis
The codebase itself is already remarkably disciplined—it does not suffer from inline style hacks or scattered hardcoded hex codes. 

**The root cause of UI distortion and harshness is 100% located in un-normalized community JSON tokens:**
1. **Geometry Warp:** Raw JSON files inject `radius: 0px` (forcing retro rectangular boxes on buttons and dialogs) or `1.5rem` (blowing cards into giant pills).
2. **Harsh Black Borders:** Raw JSON files inject `border: oklch(0 0 0)` (100% opaque jet-black cut lines) which break the sleek, borderless aesthetic.
3. **Status Bar Readability Collapse:** Raw JSON files have no `--statusbar` token; defaulting `--statusbar` to `--secondary` causes severe contrast failure with `text-muted-foreground` in `StatusBar.tsx`.
4. **Link Contrast Failure:** Raw JSON files have no `--link` token; defaulting to `--primary` (which is meant as a solid button fill) makes prose links unreadable as text.

---

## 2. Industry Best Practice & Design Contract

Modern sleek UI architectures (Linear, Vercel Geist, modern shadcn/ui, macOS Apple HIG) enforce four fundamental design boundaries:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   TBAi CORE DESIGN SYSTEM (Fixed)                      │
│                                                                        │
│  1. GEOMETRY:     0.625rem (10px) Base Radius Scale                   │
│  2. SURFACES:     Borderless soft fills (bg-card-soft)                 │
│  3. ELEVATION:    Multi-layer soft ambient shadows (no harsh edges)    │
│  4. BORDERS:      Translucent hairlines (8%–12% foreground tint)       │
│  5. TYPOGRAPHY:   Inter / JetBrains Mono (User Settings Protected)     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                    THEME LAYER (Dynamic Colors Only)                   │
│                                                                        │
│  • Background & Surface Hues (Light, Dark, Muted)                      │
│  • Primary Button Fills & Active Indicators                            │
│  • Accent Badges & Highlights                                          │
│  • Syntax Highlighting Palette                                         │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Four-Pillar Implementation Plan

### Pillar 1: Enforce the Geometry Invariant (Radius Normalization)
* **Rule:** Themes define **color palettes only**, never structural corner geometry.
* **Action in [generate-themes.ts](file:///D:/Temp/ai-chat-app/web/scripts/generate-themes.ts):**
  * Strip raw JSON `radius` properties (like `0px` in `neo-brutalism`/`doom-64` and `1.5rem` in `pastel-dreams`).
  * Lock the app's `--radius` token firmly to TBAi's standard `0.625rem` (10px).
* **Verifiable Outcome:**
  * All buttons (`rounded-md`), code blocks (`rounded-xl`), modals (`rounded-2xl`), and tool cards maintain a refined, consistent curve across all 24 themes.

### Pillar 2: The Borderless & Hairline Surface Contract
* **Rule:** Replace harsh 100% opaque black/white border cuts with delicate translucent hairlines and soft floating shadows.
* **Action in [generate-themes.ts](file:///D:/Temp/ai-chat-app/web/scripts/generate-themes.ts):**
  * Normalize `--border` and `--sidebar-border` using dynamic relative transparency:
    * Light mode: `color-mix(in srgb, var(--foreground) 9%, transparent)`
    * Dark mode: `color-mix(in srgb, var(--foreground) 12%, transparent)`
  * Ensure `--card-soft` and `--card-outline` maintain the borderless contract defined in [approval-card.tsx](file:///D:/Temp/ai-chat-app/web/src/components/shared/approval-card.tsx#L28):
    ```tsx
    export const CARD_SURFACE = "rounded-2xl bg-card-soft ring-1 ring-card-outline";
    ```
  * Maintain `--elevation-floating` and `--elevation-overlay` soft shadows across all themes.
* **Verifiable Outcome:**
  * Zero harsh black cut lines slicing through cards or dialogs.
  * Surfaces appear lightweight, thin, and floating.

### Pillar 3: Status Bar & Legibility Contract
* **Rule:** Status bar text must meet WCAG AA contrast (minimum 4.5:1 ratio) in every theme.
* **Action in [generate-themes.ts](file:///D:/Temp/ai-chat-app/web/scripts/generate-themes.ts):**
  * Decouple `--statusbar` from `--secondary`.
  * Compute `--statusbar` as a subtle offset from `--background` (e.g. 6%–8% step), ensuring `text-muted-foreground` and `text-foreground` remain crisp and easily readable.
* **Action for Links:**
  * Compute `--link` with verified contrast against `--background` (rather than copying `--primary`).
* **Verifiable Outcome:**
  * Bottom status bar in [StatusBar.tsx](file:///D:/Temp/ai-chat-app/web/src/components/StatusBar.tsx#L79) is 100% legible in all 24 themes.

### Pillar 4: Inter-Library Harmony
* **Harmonize 4 Key Libraries:**
  1. **`@assistant-ui/react`:** Preserves the inverted monochrome User Bubble (`bg-foreground text-background border-t border-r border-border/40`) from [ChatWindow.tsx:468](file:///D:/Temp/ai-chat-app/web/src/components/ChatWindow.tsx#L468).
  2. **Tailwind v4:** Standardizes `@theme inline` utilities so utilities cleanly map to normalized tokens.
  3. **`react-shiki`:** Syntax highlighter card uses normalized `rounded-xl` and hairline `border-border/40`.
  4. **Radix UI:** Floating menus and popovers inherit `--elevation-floating` soft shadows with zero border clipping.

---

## 4. Verification & Testing Protocol

Before considering any phase complete, the following gates must pass:

1. **Automated Unit Tests:**
   * Run `bun test tests/unit/web/appearance/`
   * Assert all 24 themes pass WCAG AA contrast for body text, status bar text, and links.
   * Assert all themes emit standard `0.625rem` radius and normalized hairlines.
2. **Typecheck & Linter:**
   * Run `bun run typecheck` across all 4 TypeScript targets (0 errors).
   * Run `bun x biome check` (0 formatting/lint errors).
3. **Production Build:**
   * Run `bun run build` (Clean production bundle in < 3s).
4. **Visual Inspection:**
   * Standalone comparison file [`D:\Temp\tbai-theme-comparison.html`](file:///D:/Temp/tbai-theme-comparison.html) verified across all presets.
