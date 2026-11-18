# What you can and cannot change — read before touching UI code

Plain-language guide for whoever applies the rulebook later. This is
documentation only; nothing here has been applied.

## The one rule above all others

**Reuse before define.** If a token already exists, use it. Do not add a second
scale. The audit lists every existing token with its file and line.

## assistant-ui

### What you MUST NOT change

- The `@assistant-ui/*` package versions. The train is frozen (`AGENTS.md:83-85`).
  No upgrade, downgrade, replacement or independent re-resolution without an
  explicit compatibility review and approval.
- Vendored element files: `approval-card.tsx`, `code-diff.tsx`,
  `terminal-block.tsx`, `web-search.tsx`, `tool-fallback.tsx`,
  `context-display.tsx`, `context-display.aui.tsx`, `mermaid-diagram.aui.tsx`,
  `shiki-highlighter.aui.tsx`. Their headers say "vendored" / "verbatim" and
  record the registry URL. They are kept byte-identical so a future
  `assistant-ui add` can reconcile against upstream.
- `runtime.ts` — the only place that wires the chat transport (`AGENTS.md:89-91`).
- The `AssistantRuntimeProvider` in `AppShell.tsx:196-251` and the Code-mode
  isolation boundary (`AppShell.tsx:71-74`). Do not merge the two runtimes.
- `ChatWindow.tsx` message rendering — assistant-ui primitives only
  (`AGENTS.md:92-93`). Do not hand-roll message rendering.

### What you CAN change

- `elements/surfaces.tsx` — the shared class constants (`paper`, `field`,
  `ghostButton`, `inkButton`, `pressable`, `collapsePanel`, `mono`). This is the
  main restyle lever for vendored elements: they import these constants, so
  changing a constant restyles them without editing the vendored file.
- App-owned elements: `reasoning.tsx`, `tool-group.tsx`, `tool-timeline.tsx`,
  `session-timeline.tsx`, `code-budget.tsx`, `mermaid-source.tsx`,
  `compaction-divider.tsx`, `progress-stages.tsx`, `agent-status.tsx`,
  `message-actions.tsx`, `thread-boot-skeleton.tsx`, `tooltip-icon-button.tsx`.
- The `className` you pass to a vendored element at its call site.
- CSS targeting the `data-slot` attributes that 12 elements expose
  (`tool-fallback` 16, `reasoning` 9, `mermaid-diagram` 8, `tool-group` 6,
  `context-display` 3, etc.). These are stable hooks — prefer them over editing
  the element.

### Safe restyle path

1. Change `surfaces.tsx` constants or add CSS for a `data-slot` hook.
2. Keep `--animation-duration` as the motion source; do not replace it with a
   new literal.
3. Keep the `motion-reduce:` branches that already exist (26 of them).
4. Verify typecheck, build, and the assistant-ui element tests. Do not change
   the runtime or the provider boundary.

## shadcn/ui primitives

### What you MUST NOT change

- The `data-slot` attributes — they are the stable CSS contract used across the
  app and by assistant-ui elements.
- The Radix state attributes (`data-[state=open]`, `data-[disabled]`,
  `data-[variant=destructive]`) — they come from upstream.
- The `spellCheck={false}` defaults on `input.tsx` and `textarea.tsx` — they are
  deliberate for identifiers and secrets.
- `switch.tsx` being dependency-free — do not add a Radix dependency for it.

### What you CAN change

- The cva variant class strings in `button.tsx:8-40`, `badge.tsx:8-30`,
  `select.tsx`, `dialog.tsx`, `alert-dialog.tsx`, `dropdown-menu.tsx`,
  `context-menu.tsx`, `popover.tsx`, `tooltip.tsx`, `collapsible.tsx`,
  `marker.tsx`.
- The plain class strings in `input.tsx:14` and `textarea.tsx:14`.

### Safe restyle path

1. Replace raw values with rulebook roles: `rounded-4xl` → radius role,
   `ring-[3px]` → focus role, `border-border/40` → edge role, `shadow-xs/sm` →
   elevation role, `tracking-wide` → tracking role.
2. Add the missing **loading** state to Button and Input using the motion tokens
   — do not invent a new animation literal.
3. Give `switch.tsx` a visible focus ring derived from `--ring` (it has none
   today).
4. Reconcile `input.tsx` (`rounded-4xl`) with `textarea.tsx` (`rounded-xl`) —
   pick one role, do not leave them different.
5. Verify typecheck, build, lint, and screenshots of default / hover / focus /
   selected / disabled / loading / error for each changed primitive in both
   themes.

## Colors

Never write a hex, oklch, rgb or hsl value in a rulebook file or a component
change. Colors belong to `web/src/themes/*.json` → `styles/themes.css`. When a
color is unavoidable, derive it from a theme variable with `color-mix`, e.g.
`color-mix(in srgb, var(--border) 40%, transparent)`.

## Tailwind v4 wiring

- TBAi's bridge is `@theme inline` in `globals.css:234-286`. It maps existing
  variables into Tailwind namespaces; it does not re-emit them.
- New real utilities go in `@utility` blocks (see `text-2xs` at 291,
  `glass-surface` at 408).
- **Do not self-reference inside `@theme inline`.** `--text-meta: var(--text-meta)`
  generates no utility. Map a differently named source variable, or use plain
  `@theme` with a literal when a new scale is intended.
- Import a promoted rulebook in `globals.css` after `./themes.css` (line 29) and
  before `@layer base` (502).

## Accessibility non-negotiables

- Keep focus visible. Do not copy OpenChamber's ring removal.
- Keep interactive targets at or above 24×24 (`size-6` / `icon-xs` are at the
  floor).
- Keep the existing `motion-reduce:` branches; add one for any new motion.
- Give the active tab a visible edge — background-only selection is invisible.

## Scope boundary

Do not touch the uncommitted OpenCode recovery work: `docs/2026-11-16-*`,
`docs/opencode-context.md`, `src/services/opencode/serverManager.ts`, and
`tests/**`. Leave them byte-for-byte unchanged.
