# TBAi — Full UI/UX Redesign: Audit and Visual Proposal

This folder contains a **design-only** proposal for a complete, visibly meaningful UI/UX redesign of TBAi. No production code, styles, configuration, dependencies, or functionality were changed to produce it.

## What this is

A proposal for making TBAi look and feel like one coherent, professionally designed desktop AI development workspace — taking inspiration from OpenChamber's desktop experience, adapted to TBAi's own features and workflows.

This is **not** another token/border-radius/shadow cleanup. The existing UI foundation work (`docs/ui-foundation/`) is preserved and treated as existing work; this proposal builds on it conceptually but focuses on layout, structure, hierarchy, and visual quality.

## How to view the proposal

**Interactive prototype (preferred):** open `prototype/index.html` in a browser. It is a standalone HTML file with no dependencies. Use the top switcher to view Shell, Chat, Settings, and Scheduler, and the top-right button to toggle dark/light themes.

**Static screenshots:** `screenshots/proposed/` contains dark and light renders of each proposed screen. `screenshots/before/` contains real screenshots of the current application for comparison.

## Start here

**`IMPLEMENTATION-PLAN.md` is the single authoritative plan.** It consolidates what already exists, what is genuinely missing, what was deliberately dropped, and the correct build sequence. Read it first.

`requirements.md` is a historical record of preferences gathered during the design discussion — many were later superseded. `application-shell.md` describes an **old, rejected** shell design (icon rail, top header, inspector with fake stats) and must not be used as a spec.

## Documents

- `IMPLEMENTATION-PLAN.md` — **authoritative** consolidated plan and sequence.
- `audit.md` — current UI audit based on real screenshots, with concrete problems.
- `openchamber-reference.md` — reference research and applicable patterns.
- `design-direction.md` — proposed visual identity and design decisions.
- `application-shell.md` — navigation and layout specification.
- `page-designs.md` — Chat, Code, Scheduler, Providers, and Settings direction.
- `prototype/index.html` — standalone visual prototype.
- `screenshots/before/` — current application screenshots (real, captured at 1440×900).
- `screenshots/proposed/` — redesigned visual proposals (dark and light).

## Status

DESIGN COMPLETE — awaiting owner approval to implement. No production code changed. See `IMPLEMENTATION-PLAN.md` for the sequence.
