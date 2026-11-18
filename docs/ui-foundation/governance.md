# UI foundation governance (short operating rules)

This file states how to keep TBAi's UI system consistent. It is documentation
only. It does not change code and does not import the rulebook.

## Where things live

| Concern | Owner | Source of truth |
|---|---|---|
| Theme colors | theme system | `web/src/themes/*.json` → generated `web/src/styles/themes.css` |
| Shape tokens (radius, elevation, glass) | global stylesheet | `web/src/styles/globals.css:33-286` |
| Typography settings | appearance feature | `web/src/features/appearance/typography.ts:530-568` writes to the DOM |
| Chrome geometry | lib | `web/src/lib/window-chrome.ts` → `web/src/lib/chrome-vars.ts` |
| Component primitives | shadcn/Radix layer | `web/src/components/ui/*` |
| Feature UI | one feature per directory | `web/src/features/<name>/` |
| Shared settings grammar | shared components | `web/src/components/shared/settings.tsx` |
| Proposed non-color skeleton | this directory | `rulebook.css` (standalone artifact) |

## The rules

1. **Reuse before define.** Before adding any token, find the existing one. The
   audit lists them with file:line. If an existing token covers the need, use it.
   Never create a competing scale.
2. **Colors stay with themes.** No hex, oklch, rgb or hsl in a token artifact or
   a component. Where a color is unavoidable, derive it from a theme variable
   with `color-mix` (e.g. `var(--border)`, `var(--foreground)`, `var(--ring)`).
3. **New tokens use `--rule-*`.** The prefix marks a proposal and prevents a
   collision with an existing token. Rename only after the phase is accepted.
4. **One group per phase.** Apply one token group at a time, verify, then move
   on. A phase touching more than two surfaces should be split.
5. **Library first.** `AGENTS.md:24-28`: prefer `@assistant-ui/react`, shadcn/ui,
   Radix and the stdlib before writing custom UI. `ChatWindow.tsx` uses
   assistant-ui primitives only (`AGENTS.md:92`). No second router, state
   framework or UI framework (`AGENTS.md:114`).
6. **No new dependency without a decision.** `AGENTS.md:46,49-75`: inspect the
   dependency tree first; the assistant-ui train is frozen (`AGENTS.md:83`).
7. **Keep focus visible.** Do not adopt OpenChamber's ring removal. Every
   interactive control keeps a visible focus indicator derived from `--ring`.
8. **Respect reduced motion.** Any new motion token needs a
   `prefers-reduced-motion` branch that collapses it to zero.
9. **24×24 minimum targets.** `size-6` / `icon-xs` are at the floor; do not
   shrink interactive targets below it.
10. **Do not touch the OpenCode recovery work.** `docs/2026-11-16-*`,
    `docs/opencode-context.md`, `src/services/opencode/serverManager.ts` and
    `tests/**` are uncommitted work owned by another effort. Leave them
    byte-for-byte unchanged.

## How a component is added

1. Check `components/ui/*` for an existing primitive. Extend it rather than
   creating a parallel component.
2. If a new primitive is genuinely needed, place it in `components/ui/` and
   follow the existing cva variant pattern (`button.tsx:8-40`).
3. Feature-specific UI goes in `features/<name>/`, never in a shared folder for
   convenience (`AGENTS.md:114`).
4. Use the rulebook roles for size, spacing, edge, elevation, focus and z-index.
   Do not introduce a raw value that a named role already covers.
5. Verify: typecheck, build, lint, affected tests, and light/dark screenshots of
   default / hover / focus / selected / disabled / loading / error states.

## How a token is added

1. Find the existing token (audit.md). If one exists, reuse it.
2. If none exists, justify the gap in `audit.md` with file:line evidence.
3. Add the token to `rulebook.css` with a `--rule-*` prefix and a comment naming
   the theme variable it derives from.
4. Add the plain-language explanation to `rulebook.md`.
5. Add a phase to `application-plan.md` with files, verification and rollback.
6. Only after acceptance, promote the token into the real stylesheet and rename
   it if the team agrees.
