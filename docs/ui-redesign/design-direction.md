# Proposed TBAi design direction

## Design identity

A polished, professional desktop AI development workspace: calm, information-dense, developer-focused, and coherent across all major pages. Inspired by OpenChamber's structure, adapted to TBAi's features.

## Visual system

### Color
- One restrained accent: warm amber/gold, consistent with the existing warm theme palettes. Used for active navigation, primary actions, and key indicators only.
- Semantic status colors: success green, warning amber, danger red, info blue — used only for status, never decoration.
- Surfaces: a small hierarchy of background → surface → elevated surface, derived from the active theme. No random per-card accent colors.
- Both dark and light themes are designed targets, not inversions of each other.

### Typography
- Clear hierarchy: page title (20–22px), section title (14px), body (13px), meta (11px), micro (10px).
- Thin-to-regular weights for body; medium/semibold for titles and active states.
- Monospace reserved for code, paths, IDs, and technical metadata.

### Spacing and layout
- A single 4/8px rhythm. Compact areas use smaller steps; no second competing scale.
- Generous but intentional whitespace in main workspaces; dense but readable sidebars.
- No oversized empty areas — welcome and empty states should use space purposefully.

### Borders and surfaces
- Hairline borders for structure; stronger edges only for active/focused elements.
- Avoid cards inside cards. Use surface fills and spacing to group content before adding borders.
- Rounded corners: moderate (8–12px). No pill-shaped controls except small status chips.

### Elevation
- Three levels: low (controls), medium (panels/composer), high (dialogs/overlays).
- Shadows derived from theme variables; no black halos in dark mode.

### Icons
- Consistent 16px glyphs in navigation and controls; 20px for section headers.
- One icon set (lucide, already in use). Outline icons for navigation, filled only where it conveys state.
- 24×24 minimum click targets for all interactive controls.

### Interactive states
- One visible focus ring derived from the theme's ring token.
- Hover, active, selected, disabled, loading, error, and success states defined for every control.
- Loading uses disabled + dimmed with a subtle shimmer; no spinners.
- Reduced-motion support: all new motion collapses to zero when requested.

## Navigation model
- Left icon rail: primary surfaces (Chat, Code, Scheduler, Folders, MCP, Settings).
- Conversation sidebar: grouped by In work / Projects / Recent, with clear active state and search.
- Top header: page title, short description, and contextual actions — consistent across all pages.
- Right inspector (where useful): session/context information. Collapsible; hidden by default on narrow windows.

## What this is NOT
- Not a new design system competing with `docs/ui-foundation/`. It builds on those tokens conceptually.
- Not a generic dashboard. It is a developer workspace with TBAi's real features.
- Not a minor styling cleanup. The proposed screens show structural and visual changes.
