# Dockview POC — Result (POC-0 and POC-1)

**Date:** 2026-11-23
**Branch / HEAD:** `ui-foundation-upgrade` @ `a2f453d3c5f093aa9fa2ee2049e89d6d6769e2b2` (before POC changes)
**Status:** POC-0 and POC-1 executed. POC-1 (the decisive test) **PASSED**. No production adoption decision is made here.

## What was built (all dev-only / temporary)

- `dockview-react@8.9.1` added as a **devDependency** in `web/package.json` (+ lockfile).
- `web/src/features/workspace/DockviewLab.tsx` — dev-only lab mounting two **real** `DirectChatHost`s as Dockview panels with `renderer: "always"`, a mount counter per host, a "Move panel B below A" button, and an event log.
- `web/src/config/routes.ts` — added `DOCKVIEW_LAB: "/dockview-lab"` constant.
- `web/src/app/router.tsx` — added the lab route inside the existing `import.meta.env.DEV` block (compiled out of production).
- `web/vite.poc.config.ts` — temporary Vite config with an `/api` proxy to the backend (port 3015) so the lab could use real conversations.

## Verification performed

| Check | Result |
|---|---|
| `bunx tsc --noEmit` (web) | exit 0 |
| `bun run typecheck` (repo) | exit 0 |
| `bun run lint` | exit 0 |
| `bun run format` | applied (2 files) |
| `bun run build:web` | exit 0 |
| Production bundle contains Dockview library code / lab component | **No** — only the harmless `/dockview-lab` route-path string constant remains; no `DockviewReact`, `dockview-core`, or lab chunk. POC-0 exit criterion met. |

## POC-1 — decisive result: PASSED

**Setup:** two real Direct conversations (`j8rf1ocag6b4ubqiveruspl0`, `vlah93dgw7k302nmr729dxke`) mounted as Dockview panels with `renderer: "always"`, each showing real message history and a live composer.

**Action:** clicked "Move panel B below A" (`panel.api.moveTo({ group, position: "bottom" })`).

**Observed (browser snapshot + screenshot):**
- Mount counters stayed at **A=1, B=1** — neither host component remounted.
- Panel B moved from the right column to **below** panel A (tab y-position changed from 41 to 977).
- Both conversations' full message histories, reasoning blocks, tool states, and composers remained intact.
- Event log recorded `moved vlah93... from 2 to 2` and `mounts A=1 B=1`.
- No new console errors (only pre-existing assistant-ui deprecation warnings).

**Conclusion:** with `renderer: "always"`, Dockview's `moveTo()` preserves real `DirectChatHost` component instances and their assistant-ui runtime state across a cross-group move. This is the question the evaluation said the whole decision hinged on. **[VERIFIED in this POC]**

## POC-2 — Mixed Direct + OpenCode: PASSED (mounting)

**Setup:** added a third panel hosting a real OpenCode runtime (`DockviewOpenCodeHost`, which reuses `bootstrapOpenCodeSession` + `useOpenCodeRuntime` + `OpenCodeIsolationBoundary` + `ChatWindow mode="agent"`), conversation `rsp8stebcid7i20rj6a7gnf0`, alongside the two Direct panels.

**Observed:** three panels rendered simultaneously — two Direct + one OpenCode. The OpenCode panel showed its own Agent/Model/Auto-approve composer controls (distinct from the Direct composers). Mount counters stayed at **A=1, B=1, OC=1**. No console errors. The backend log showed the OpenCode session's inbox/permission/form subscriptions active. **[VERIFIED in this POC]**

**Not proven:** concurrent *sends* with distinct reply markers and isolated responses/lifecycle events between Direct and OpenCode. The browser typing tool could not drive a send (focus limitation). This remains an outstanding E2E requirement.

## POC-3 — Hidden-panel execution continuity: PARTIAL

**Setup:** "Hide B" activates panel A in the same group; with `renderer: "always"` the inactive panel stays mounted but hidden (`visibility: hidden`), which is the exact state to test.

**Observed:** after hiding, mount counter for B stayed at **1** — the host was not unmounted. Dockview's documented contract keeps `always` panel component instances, subscriptions, and lifecycle hooks alive while hidden. The OpenCode session's inbox/permission/form polling continued in the backend log while panels were hidden. **[VERIFIED structurally]**

**Not proven:** an actual in-flight Direct stream or OpenCode operation continuing to completion *while hidden* — the browser typing tool could not initiate a send. This remains an outstanding E2E requirement.

## POC-4 — Save/restore: PASSED (no runtime destruction)

**Setup:** `api.toJSON()` → `api.fromJSON(saved, { reuseExistingPanels: true })` with three panels open.

**Observed:** mount counters stayed at **A=1, B=1, OC=1** after restore — no host was destroyed or recreated. Tab DOM ids changed (`dv-tab-6/7/8`) but all three conversations' content, composers, and tool states remained intact. No console errors. **[VERIFIED in this POC]**

**Caveat:** this was an in-session restore with `reuseExistingPanels: true`. A cold restore after a full page reload necessarily creates fresh runtimes (durable identity/layout only), which is a different operation.

## Not yet tested (remaining POC phases)

- POC-5: accessibility and responsive behavior.
- Concurrent mixed Direct + OpenCode sends with distinct reply markers (E2E).
- A real stream/operation continuing to completion while its panel is hidden (E2E).
- Composer-text preservation across a move (browser typing tool lost keyboard focus in this environment; the instance-preservation result makes this likely but it was not directly asserted).

## Cleanup / rollback

All POC changes are isolated: dev dependency, one lab component, one route constant, one dev-route entry, one temporary Vite config. Removing them restores the prior state; no production code or data was changed. No commit or push was made for the POC.
