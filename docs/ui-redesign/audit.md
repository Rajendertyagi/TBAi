# Current UI audit — TBAi

Based on real screenshots captured from the running application at 1440×900, dark and light themes. Screenshots are in `screenshots/before/`.

## Route inventory (from `web/src/app/router.tsx` and `config/routes.ts`)

Primary surfaces: `/` (index redirect), `/chat/:threadId?`, `/code/:agentId?`, `/scheduler`, `/archived`.
Settings surfaces (under `SettingsLayout`): `/memory`, `/mcp`, `/logs`, `/folders`, `/quick-messages`, `/providers`, `/appearance`, `/typography`, `/desktop`, `/workspace`, `/opencode-config`.
DEV-only: `/theme-lab`, `/keyboard-lab`. Error/loading: `RouteError`, `HydrateFallback`, `IndexRedirect`.

## Concrete visual problems

### 1. Overcrowded tab strip (Chat, all pages) — `screenshots/before/chat-dark.png`
The tab strip shows many tabs with heavily truncated labels ("New c", "hi", "Fonts", "SpellC", "ChatPl", "GenUI", "Impor", "Direct", "New C"...). At 1440px the strip is saturated; tabs are unreadable and the active tab is hard to identify. This is the single most visible usability problem.
**Improvement:** replace the many-tab model with a single active conversation plus a compact "recent" dropdown, or cap visible tabs and move the rest into an overflow menu. Give the active tab a clear title and accent marker.

### 2. Dense, noisy sidebar (all pages) — `chat-dark.png`, `scheduler-dark.png`
The sidebar packs folders, nested conversations, timestamps, and counts into a narrow column. Multiple groups (Folders, Chats) with long truncated names create visual noise. The active item is a subtle background tint.
**Improvement:** clearer grouping with section headers, stronger active state, less truncation (wider sidebar or shorter labels), and a dedicated search entry point.

### 3. Huge empty center area (Chat welcome) — `chat-dark.png`
The welcome screen floats a heading and three suggestion cards in a large void. The cards use random accent colors (orange, magenta, purple) that do not correspond to any product semantic.
**Improvement:** a purposeful welcome layout with a clear starting action, restrained accent colors, and content that uses the space intentionally rather than leaving it empty.

### 4. Inconsistent page structure (Chat vs Scheduler vs Settings)
Chat uses a full-width canvas with a bottom composer; Scheduler uses a large bordered container with a grid of template cards; Settings uses a left sub-nav plus content. These are reasonable per-workflow differences, but the shared shell (top bar, sidebar, status bar) is thin and inconsistent — the top bar is only a breadcrumb plus a few icons, with no clear page title or contextual actions.
**Improvement:** a consistent top header with page title, description, and contextual actions across all surfaces, while preserving each workspace's appropriate layout.

### 5. Scheduler empty state is a wall of cards — `scheduler-dark.png`
"No scheduled jobs yet" is followed by eight template cards in a 3-column grid. This is visually heavy for an empty state and pushes the actual action ("create a job") below the fold.
**Improvement:** a focused empty state with a primary action and a small set of suggested templates, not a full card grid.

### 6. Settings lacks visual hierarchy — `appearance-dark.png`
Settings pages use simple stacked cards with rows. The left settings nav is a plain list. The result is functional but flat and generic; there is no strong section hierarchy or visual rhythm.
**Improvement:** grouped settings navigation with clear section labels, stronger page headers, and consistent control alignment.

### 7. Weak information hierarchy in messages — `chat-dark.png`
Assistant messages show name, model, text, code blocks, and tool results in a single undifferentiated flow. Code blocks and tool cards are visually similar; there is no clear "step" structure.
**Improvement:** stronger message role distinction, clearer code/tool presentation, and a visible step/phase structure for multi-step work.

### 8. Random accent colors
Suggestion cards and some icons use unrelated accent colors. The design has no restrained accent system.
**Improvement:** one restrained accent (warm amber/gold, consistent with OpenChamber's palette) plus semantic status colors only.

### 9. Theme behavior
Both dark and light themes render, but the light theme is a near-inversion rather than a deliberately designed light surface hierarchy. Contrast and surface separation are weaker in light mode.
**Improvement:** design both themes intentionally with distinct surface elevation and clear borders.

## Limitations of this audit
Screenshots were captured at 1440×900 in dark and light for the main routes. The 1280×800 and 1024×768 viewports and dialog/menu states were not exhaustively captured; the problems above are visible at the primary desktop size and are representative.
