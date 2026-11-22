# Dockview Evaluation Plan — TBAi Workspace Architecture

**Status:** research and planning only — no implementation authorized, no dependency changes made.
**Date:** 2026-11-22
**Branch / HEAD inspected:** `ui-foundation-upgrade` @ `a2f453d3c5f093aa9fa2ee2049e89d6d6769e2b2` (local HEAD verified equal to `origin/ui-foundation-upgrade` via `git ls-remote` before work began).
**Working-tree note:** `docs/workspace-redesign/WORKSPACE_ARCHITECTURE_PLAN.md` has an uncommitted consumer-description correction from a prior task; it was preserved untouched. The only other working-tree item is untracked prototype screenshots.

## Evidence conventions

- **[SOURCE]** — read directly from TBAi source at the inspected HEAD, with `file:line`.
- **[OFFICIAL]** — Dockview official documentation or typedocs, with URL.
- **[SOURCE-DV]** — Dockview published package source read from its GitHub repository, with path.
- **[INFERENCE]** — reasoned consequence of verified facts; not experimentally proven.
- **[UNVERIFIED]** — must be tested in a POC before relying on it.

No Dockview experiment was run for this evaluation. The completed TBAi multi-runtime experiments (`technical-audit.md` §2b.1–2b.5) were **not** repeated; their documented results are preserved and cited as **[EXPERIMENT]**.

---

## 1. Executive recommendation

**Recommendation: investigate further with a bounded, time-boxed POC; do not adopt Dockview into production yet, and do not abandon the existing plan yet.** [INFERENCE]

Rationale:

- Dockview is a mature, MIT-licensed, actively maintained docking layout library whose free core covers nearly all of TBAi's **spatial** requirements: tabs, groups, nested splits, drag-to-resize splitters, drag-and-drop, floating groups, popout windows, save/restore via `toJSON()`/`fromJSON()`, render modes, and baseline accessibility. **[OFFICIAL]** This is exactly the machinery the current plan proposes to build by hand (§5.2/§5.5 of `WORKSPACE_ARCHITECTURE_PLAN.md`: recursive layout tree, geometry computation, splitters, tab strips, persistence).
- The single most important TBAi requirement — **moving a panel must not destroy the chat runtime, active stream, composer text, or scroll position** — is *designed for* by Dockview (`renderer: "always"` + `moveTo()`), but is **not proven** for TBAi's specific `DirectChatHost` / `OpenCodeChatHost` with assistant-ui contexts. Dockview's own docs warn that the default renderer removes elements from the DOM and that docking moves panel elements between groups. **[OFFICIAL]** The current custom plan has the same unproven status (its §5.5 explicitly says state preservation is not yet proven).
- Therefore the decision should be made by a **POC that tests the real hosts**, not by feature count. If Dockview preserves real host state across moves, adopting it removes a substantial amount of custom layout code and maintenance risk. If it does not, the existing plan remains the fallback.

This is not a decision to implement Dockview; it is a decision to spend a bounded POC effort resolving the one question that determines the architecture.

---

## 2. Dockview findings (official documentation and source)

### 2.1 Package, licensing, compatibility

| Fact | Evidence |
|---|---|
| `dockview-react@8.9.1`, MIT licensed, depends on `dockview ^8.9.1`. | npm `dockview-react` page; GitHub `dockview/dockview` README. **[OFFICIAL]** |
| Peer dependencies: `react` and `react-dom` `^16.8.0 \|\| ^17.0.0 \|\| ^18.0.0 \|\| ^19.0.0` — React 19 is explicitly supported. | npm peer deps; GitHub issue #919 "React 19 peer deps" closed. **[OFFICIAL]** |
| Core is zero-dependency; all packages MIT except `dockview-enterprise` (commercial). | GitHub README and `LICENCE.md`. **[OFFICIAL]** |
| Enterprise (commercial, licence key, 30-day trial) adds: multi-row tabs, pinned tabs, advanced overflow (search/MRU), DnD compass, smart guides, auto-hide/dock-to-edge groups, layout history (undo/redo), spatial keyboard navigation, keyboard docking. | `https://dockview.dev/docs/overview/licence`; enterprise launch blog. **[OFFICIAL]** |
| Free core already includes: dockable grid, nested layouts, floating groups, popout windows, edge groups, maximize/restore, tab groups/chips, tab overflow, tab/chip context menus, DnD (tab/group/external, touch/pen), drag-to-resize splitters, size constraints, render modes, save/restore, custom panel state, themes/CSS variables, programmatic layout control, panel/group APIs, lifecycle events, ARIA roles, screen-reader announcements, focus indicators, keyboard focus navigation. | `https://dockview.dev/docs/overview/licence` feature table. **[OFFICIAL]** |
| Actively maintained: recent commits address React 18+ `<Activity>`/StrictMode effect replay and instance retention (`useKeptInstance`). | GitHub commit `17d5ba615a` (2026-10-05) and `react.ts`. **[SOURCE-DV]** |

**Conclusion:** no Enterprise feature is required by TBAi's binding requirements. The free MIT core is sufficient on paper. **[INFERENCE]**

### 2.2 Rendering and state preservation

| Fact | Evidence |
|---|---|
| `renderer: "onlyWhenVisible"` (default) removes the panel element from the DOM when hidden; DOM-specific state such as scrollbar position is lost, and measured sizes may read 0px. | `https://dockview.dev/docs/core/panels/rendering/`. **[OFFICIAL]** |
| `renderer: "always"` keeps the DOM tree alive but hidden via `visibility: hidden`; DOM state (including native scroll position) is preserved. The panel component instance stays alive and subscriptions/lifecycle hooks continue while hidden. | Same. **[OFFICIAL]** |
| The panel instance is only destroyed when removed from Dockview; the renderer affects only the DOM element. | Same. **[OFFICIAL]** |
| Hidden `always` panels continue browser work (CSS animations, `requestAnimationFrame`, autoplay video, iframes); pause explicitly via `onDidVisibilityChange` or conditionally render inner content. | Same. **[OFFICIAL]** |
| Docking moves a panel's element between groups; an iframe rendered the default way reloads on every move. `renderer: "always"` avoids this because the element is never removed from the DOM (maintainer comment: element is "absolutely positioned and hidden as required"). | Same; GitHub issue #718 maintainer comment. **[OFFICIAL]** |
| `moveTo()` documentation: "A panel can be relocated to a different group and position without being destroyed and re-created." | `https://dockview.dev/docs/core/panels/move`. **[OFFICIAL]** |
| React adapter renders each panel through `ReactDOM.createPortal` into a Dockview-owned DOM element; the portal is created once per `ReactPart` and stored in a portal store. React context therefore comes from the React tree position where `DockviewReact` is rendered, not from the DOM position. | `packages/dockview-react/src/react.ts` (`ReactPart.createPortal`, `usePortalsLifecycle`). **[SOURCE-DV]** |
| `useKeptInstance` keeps the Dockview instance across React 18+ effect cleanups that are not unmounts (Activity, StrictMode); a real unmount disposes it. | `react.ts`; commit `17d5ba615a`. **[SOURCE-DV]** |

**Critical caveat:** the official statements about instance preservation concern the **Dockview panel instance** and the **DOM element**. They do not, by themselves, prove that a TBAi `DirectChatHost` (which creates an assistant-ui runtime in a `useEffect`) or an `OpenCodeChatHost` (which bootstraps a session and subscribes to events) will keep its runtime, stream, and context across a move. The React portal mechanism makes this *plausible* but it must be verified with real hosts. **[UNVERIFIED]**

### 2.3 Persistence

| Fact | Evidence |
|---|---|
| `toJSON()` serializes the layout; `onDidLayoutChange` fires on changes with a `reasons` set (`geometry`, `structure`, `activePanel`, `panelTitle`, `panelParameters`). | `https://dockview.dev/docs/core/state/save`. **[OFFICIAL]** |
| `fromJSON(data, { reuseExistingPanels: boolean })` restores a layout; invalid/corrupt layouts throw and reset gracefully. | `https://dockview.dev/docs/core/state/load`; typedocs `DockviewApi.fromJSON`. **[OFFICIAL]** |
| `addGroupFromJSON` / `addPanelFromJSON` rebuild a single group or panel from serialized state; `serializeGroup` produces a self-contained group. | typedocs `DockviewComponent`. **[OFFICIAL]** |
| Issue #718 (open) records that `fromJSON()` replaces the whole layout and destroys/recreates panels; a maintainer later referenced PR #778 adding a `keepExistingPanels`-style option. The published API now exposes `reuseExistingPanels`, but its exact semantics for live runtimes are not documented in the docs pages read here. | GitHub issue #718; typedocs. **[OFFICIAL / UNVERIFIED]** |

**Implication:** Dockview's `toJSON()` is a good spatial-layout payload for TBAi's device-local persistence, but TBAi must wrap it with its own `version` + `migrate` (per `useDesktopLayout` precedent) and must decide whether restore-after-restart (fresh runtimes, acceptable) and in-session "reset layout" (must not destroy live runtimes) use the same call. They likely should not. **[INFERENCE]**

### 2.4 Accessibility, responsiveness, maintenance

- Baseline accessibility is in the free core: WAI-ARIA tablist/tab/tabpanel/region roles, roving tabindex within the tab strip, screen-reader announcements, `:focus-visible` indicators. Broader keyboard navigation (`F6` group cycling, keyboard docking, spatial navigation) is Enterprise. **[OFFICIAL]**
- No built-in responsive layout switching was found in the docs read; TBAi's narrow-screen behavior (`interaction-model.md:61`: optional panels become an overlay at ≤960px) would remain TBAi's responsibility, likely via programmatic layout changes or hiding groups. **[INFERENCE / UNVERIFIED]**
- Dockview uses portals and measures element rects; the FlexLayout ADR recorded that portaled content cannot be exercised under happy-dom/jsdom (`decisions.md:4676-4679`). Dockview likely has the same constraint — DOM-level tests of a Dockview-backed surface may be impossible, pushing verification to E2E. **[INFERENCE]**

---

## 3. TBAi current state (source-verified)

- `chatTabs.ts:20-27,92-108` is the canonical conversation identity system (`kind: "chat" | "agent"`, `ref`, keys `chat:<ref>` / `agent:<ref>`). Engine is derived from the conversation row by `threadEngine()` (`remoteThreadListAdapter.tsx:370-380`). **[SOURCE]**
- `DirectChatHost.tsx:25-46` creates an isolated Direct runtime per host via `AuiProvider extends={null}` + `useAppChatRuntime` + shared `threadListAdapter`. **[SOURCE]**
- `OpenCodeView.tsx:40-201` owns session bootstrap, config/model resolution, timeout/retry, recovery, first-prompt handoff, permissions, forms, terminal, and diff; `useOpenCodeRuntime.ts:13-88` owns client/controller/runtime with dispose and epoch reconnect. **[SOURCE]**
- `workspacePanels.ts:15-61` is a minimal Direct-only panel store (`{id, tabKey, order}`); `WorkspaceSurface.tsx:14-47` renders keyed sibling hosts and filters the active tab. **[SOURCE]**
- `TabStrip.tsx:6-13,82-90` uses `@dnd-kit/dom` and `@dnd-kit/react` (`DragDropProvider`, `useSortable`, `KeyboardSensor`, `PointerSensor`) for tab reordering. `web/package.json:17-18` pins both at `0.5.1`. **[SOURCE]**
- The authoritative plan (`WORKSPACE_ARCHITECTURE_PLAN.md` §5.2/§5.5) proposes a custom discriminated-union layout tree, a stable host layer with absolutely positioned wrappers, geometry-derived placement, and a conversation-activity projection for the Sidebar. It explicitly states state preservation is not yet proven. **[SOURCE]**
- Completed experiments proved: two real Direct runtimes with stub transports work (§2b.1); the backend handles two concurrent conversations (§2b.3); mixed Direct+OpenCode **mounting** works but no sends were asserted (§2b.4/§2b.5). **[EXPERIMENT]**

---

## 4. Feature / requirement comparison

| TBAi requirement | Dockview free core | Current custom plan | dnd-kit + custom | FlexLayout (prior POC) |
|---|---|---|---|---|
| Tabs per panel | Yes (tab groups, overflow, custom tab components) **[OFFICIAL]** | Planned (`PanelNode.tabs`) | Would need custom | Yes, but identity re-derivation problem |
| Nested splits | Yes (nested layouts, grid) **[OFFICIAL]** | Planned (`SplitNode`) | Would need custom | Yes |
| Resize | Yes (drag splitters, constraints) **[OFFICIAL]** | Planned (geometry + pointer capture) | Would need custom | Yes |
| Drag-and-drop / move | Yes (tab/group/external DnD, `moveTo`) **[OFFICIAL]** | Planned (dnd-kit reuse) | Yes (installed) | Yes |
| Floating panels | Yes **[OFFICIAL]** | Not planned | No | Popouts only |
| Save/restore | Yes (`toJSON`/`fromJSON`) **[OFFICIAL]** | Planned (localStorage + migrate) | Would need custom | Yes, but model issues |
| Hidden panels keep state | `renderer: "always"` **[OFFICIAL]**; TBAi runtime survival **unverified** | Stable host layer; **unverified** | Would need custom | Portaled content, DOM-test impossible |
| Direct/OpenCode isolation | Dockview is layout-only; hosts remain TBAi-owned **[INFERENCE]** | Hosts own runtimes | Same | Same |
| `chatTabs` canonical identity | Dockview panel id must map to `hostId`; TBAi keeps identity **[INFERENCE]** | Explicit | Explicit | Prior POC had to re-derive identity |
| No duplicate conversation store | Yes if panel state holds only `hostId` + params **[INFERENCE]** | Explicit | Explicit | Risky |
| Activity indicators | Dockview lifecycle events can drive publishers; execution status still from hosts **[INFERENCE]** | Activity projection designed | Same | Not addressed |
| Accessibility | Baseline in core; advanced keyboard is Enterprise **[OFFICIAL]** | Must build | Must build | Library-provided |
| Responsive overlay | Not provided; TBAi responsibility **[INFERENCE]** | TBAi responsibility | TBAi responsibility | Not addressed |
| New dependency | `dockview-react` + `dockview` (2 packages, MIT) | None | Already installed | Would need `flexlayout-react` (rejected by ADR) |
| Custom code to maintain | Lowest for spatial layout | Highest | High | Medium |

**Conclusion:** Dockview removes the largest chunk of custom work (layout tree, geometry, splitters, tab strips, DnD, persistence serialization). It does not remove TBAi's content hosts, identity system, activity projection, or security boundaries — those remain TBAi responsibilities under any option. **[INFERENCE]**

---

## 5. Compatibility concerns and unresolved questions

1. **Runtime preservation across `moveTo()`** — the decisive question. Must be tested with real `DirectChatHost` and `OpenCodeChatHost`, active streams, composer text, and scroll. **[UNVERIFIED]**
2. **React context through portals** — Dockview portals render from `DockviewReact`'s React-tree position. TBAi hosts use `AuiProvider extends={null}` internally, which should preserve isolation, but this must be verified with two hosts of each engine. **[SOURCE-DV / UNVERIFIED]**
3. **`fromJSON()` and live runtimes** — `reuseExistingPanels` semantics are not fully documented; in-session restore/reset must not destroy active runtimes. **[UNVERIFIED]**
4. **Hidden `always` panels continue work** — TBAi must pause streams/timers via `onDidVisibilityChange` or conditional inner rendering; otherwise hidden chats keep CPU/network active. **[OFFICIAL / INFERENCE]**
5. **Panel id vs `chatTabs` identity** — Dockview panel ids must be derived from `hostId` (`conv:<conversationId>`), with `chatTabs` tabKey and content type in panel parameters. A conversation must not be mounted twice; Dockview's id uniqueness helps but the reconciler is still TBAi's job. **[INFERENCE]**
6. **Activity indicators** — Dockview panel lifecycle events (`onDidAddPanel`, `onDidRemovePanel`, `onDidVisibilityChange`) can drive publisher registration, but execution status still comes from hosts and server-backed sources per `WORKSPACE_ARCHITECTURE_PLAN.md` §2.2. **[INFERENCE]**
7. **Persistence versioning** — Dockview's serialized shape is library-owned; TBAi must wrap it with `version` + `migrate` and reconcile tab keys against `chatTabs` on load. **[INFERENCE]**
8. **Responsive behavior** — no built-in overlay mode found; TBAi must implement narrow-screen layout changes. **[UNVERIFIED]**
9. **DOM testing** — portaled, rect-measured content likely cannot be tested under happy-dom; E2E coverage becomes mandatory. **[INFERENCE]**
10. **Enterprise creep** — advanced keyboard docking, multi-row tabs, pinned tabs, layout history are Enterprise; if any becomes a binding requirement later, a commercial licence would be needed. None is binding today. **[OFFICIAL]**

---

## 6. Proposed architecture if Dockview is adopted

```
Chat Threads (persistent navigation)   DockviewReact (spatial layout owner)
  useConversationsList (HTTP)            groups / tabs / splits / floating
  useChatTabsStore (identity/membership) panel id = hostId (conv:<id>, etc.)
  activity projection (§2.2)             panel params = { tabKey, contentType, resource }
        |                                       |
        +---------- chatTabs tabKey ------------+
                   kind + ref
                        |
              TBAi CONTENT HOSTS (rendered as Dockview panel components)
              DirectChatHost / OpenCodeChatHost / file / terminal / browser
              each owns its runtime/session and UI state
                        |
   AuiProvider extends={null} + AssistantRuntimeProvider (per host)
```

- **Dockview owns spatial layout only**: groups, splits, sizes, tab strips, DnD, floating, serialization. TBAi does not maintain a second layout tree. **[DECISION]**
- **`chatTabs` remains canonical** for conversation identity and shared membership. Dockview panel ids are derived from `hostId`; panel parameters carry the `chatTabs` tabKey and content type. No second conversation store. **[DECISION]**
- **Content hosts remain TBAi-owned** and are rendered as Dockview panel components. Direct and OpenCode execution systems stay separate; `AuiProvider extends={null}` is retained inside each host. **[DECISION]**
- **Render mode:** all chat panels use `renderer: "always"`; pause work on `onDidVisibilityChange`. **[DECISION — POC to verify]**
- **Persistence:** `toJSON()` payload wrapped in TBAi's versioned localStorage record; content identity refs stay in `sharedTabs`; `migrate` reconciles panel ids against `chatTabs`. **[DECISION]**
- **Activity:** Dockview lifecycle events register/unregister publishers; execution status and transport health come from hosts and server-backed sources as already specified. **[DECISION]**

---

## 7. Dependencies and features: what changes

**Would become unnecessary if Dockview is adopted:**
- The custom recursive layout tree and geometry computation (`WORKSPACE_ARCHITECTURE_PLAN.md` §5.2/§5.5).
- The custom splitter implementation and pointer-capture resize handling.
- `@dnd-kit/dom` / `@dnd-kit/react` **for tab strip reordering** — Dockview provides tab DnD. (They may remain useful elsewhere; no removal without a separate decision.)
- Custom tab-strip UI for workspace panels (Dockview provides tab groups, overflow, custom tab components).

**Would remain necessary:**
- `chatTabs`, `DirectChatHost`, `OpenCodeChatHost`, the activity projection, `useAppChatRuntime`, shared `threadListAdapter`, all security boundaries, and the Sidebar.
- TBAi's versioned persistence wrapper and migration logic.
- Responsive layout behavior and any Enterprise feature avoided by staying on the free core.

**New dependencies:** `dockview-react` and its `dockview` dependency (both MIT, zero external deps). Requires an ADR per `AGENTS.md` dependency discipline. **[DECISION — not authorized by this document]**

---

## 8. Risks, trade-offs, migration, rollback

- **Risk:** runtime state loss on move — mitigated only by POC verification; if it fails, do not adopt.
- **Risk:** hidden panels consuming CPU/network — mitigate with `onDidVisibilityChange` pausing.
- **Risk:** `fromJSON()` destroying live runtimes — use `moveTo()`-based reconciliation for in-session changes; reserve `fromJSON()` for cold restore.
- **Risk:** E2E-only testability — accept that DOM tests cannot cover Dockview internals; fund E2E coverage.
- **Risk:** licence/feature creep — stay on MIT core; revisit only with an explicit ADR.
- **Migration:** introduce Dockview behind a feature flag in a dev-only route; migrate one content type (Direct) first; keep the existing `WorkspaceSurface` path intact until POC acceptance.
- **Rollback:** because the POC is isolated behind a flag and no production code changes, rollback is removing the flag/route. No data migration is involved because layout persistence is device-local and versioned. **[DECISION]**

---

## 9. Phased POC plan with measurable acceptance criteria

**POC-0 — Dependency and isolation spike (no production code).** Add `dockview-react` in a dev-only lab route; mount two empty panels with `renderer: "always"`. Verify React 19 build, CSS import, and that two panels render. Exit: dev route mounts with no console errors; production bundle contains no Dockview chunk.

**POC-1 — Real Direct hosts.** Mount two real `DirectChatHost`s as Dockview panels with distinct conversation ids. Type into each composer, scroll each transcript, start a stream in one. Move a panel between groups with `moveTo()`. Exit: same host component instance (assert via a ref counter), composer text, scroll position, and stream continuity preserved; no cross-talk.

**POC-2 — Real OpenCode host + mixed arrangement.** Add a real `OpenCodeChatHost` panel alongside a Direct host. Verify session bootstrap, event subscription, and first-prompt handoff still work inside a Dockview panel. Exit: both runtimes mount, sends are independent, no cross-runtime interference (this closes the §2b.4/§2b.5 gap).

**POC-3 — Hidden/visibility behavior.** Hide a panel with an active stream; verify `onDidVisibilityChange` fires and that pausing/resuming works. Exit: hidden panel does not keep unnecessary work running; state is intact on reveal.

**POC-4 — Persistence.** `toJSON()` → `fromJSON()` across a simulated reload; verify layout restores and panel ids reconcile against `chatTabs`. Test in-session reset with `reuseExistingPanels` or `moveTo()`-based reconciliation. Exit: no live runtime destroyed by in-session layout change; cold restore produces fresh runtimes with correct identities.

**POC-5 — Accessibility and responsive.** Verify tab keyboard navigation, ARIA roles, and a narrow-screen layout change. Exit: keyboard-only tab switching works; narrow layout has no horizontal overflow.

Each phase must produce a written result with exact commands and observed behavior before the next begins. No phase authorizes production adoption.

---

## 10. Tests required before approving production adoption

1. **Runtime preservation E2E:** two real Direct hosts, distinct reply markers, composer text, scroll, active stream; move between groups; assert instance identity and no state loss (record message parts individually per §2b.5).
2. **Mixed-runtime E2E:** Direct + OpenCode panels, concurrent sends, distinct markers, isolated responses and lifecycle events, no cross-runtime interference.
3. **OpenCode lifecycle in a panel:** session bootstrap, event subscription, recovery-epoch reconnect, first-prompt handoff, permissions/forms/terminal/diff still functional.
4. **Visibility E2E:** hidden panel pauses work via `onDidVisibilityChange`; state intact on reveal; no duplicate subscriptions.
5. **Persistence E2E:** versioned layout save/restore; corrupt payload falls back; in-session reset does not destroy live runtimes; panel ids reconcile with `chatTabs`.
6. **Identity E2E:** a conversation cannot be mounted in two panels; two browser panels may show the same URL.
7. **Activity E2E:** Sidebar running/stopping/terminal status and `lastMessageAt` remain correct with multiple isolated hosts.
8. **Accessibility E2E:** keyboard tab navigation, ARIA roles, focus indicators; document which features would require Enterprise.
9. **Responsive E2E:** narrow-screen layout has no overflow and preserves state.
10. **Quality gates:** `bun run verify`, `test:dom`, `test:e2e`, `bun run security`; exact counts recorded; no commit/push before end-to-end verification.

---

## 11. Documentation reconciliation list

| Document | Required update if Dockview is adopted |
|---|---|
| `WORKSPACE_ARCHITECTURE_PLAN.md` §5.2/§5.5 | Replace custom layout tree + stable host layer with Dockview layout ownership; retain content-host and identity decisions. |
| `WORKSPACE_ARCHITECTURE_PLAN.md` §9/§10 | Replace custom layout phases/tests with Dockview POC acceptance tests. |
| `docs/decisions.md` | Add ADR for the new dependency and for layout ownership; record alternatives (custom, dnd-kit, FlexLayout, Dockview). |
| `docs/architecture.md` | Add Dockview to the frontend stack and workspace ownership section. |
| `docs/state-management.md` | Document versioned Dockview layout persistence alongside `useDesktopLayout`. |
| `docs/workspace-redesign/technical-audit.md` | Annotate §2.4/§2.6 as historical; note Dockview supersedes the custom layout concern if adopted. |
| `docs/workspace-redesign/interaction-model.md` | Update panel/tab behavior to Dockview semantics; keep responsive requirements. |

No existing document is modified by this evaluation.

---

## 12. Remaining uncertainties

- Whether `renderer: "always"` + `moveTo()` preserves TBAi's real assistant-ui/OpenCode runtime instances, contexts, streams, composer text, and scroll — the decisive POC-1/POC-2 question. **[UNVERIFIED]**
- Exact semantics of `fromJSON(..., { reuseExistingPanels: true })` for live runtimes. **[UNVERIFIED]**
- Whether Dockview's portal-based rendering permits any DOM-level testing, or whether all coverage must be E2E. **[INFERENCE]**
- Whether narrow-screen overlay behavior can be implemented cleanly with Dockview's programmatic API. **[UNVERIFIED]**
- Whether any Enterprise feature becomes binding during implementation (would require a licence decision). **[UNVERIFIED]**

**Bottom line:** Dockview is the strongest candidate to replace TBAi's *custom spatial layout* work, but the decision hinges on one experimentally answerable question. Run the bounded POC; adopt only if real-host state preservation is proven; otherwise retain the existing plan. No implementation or dependency change is authorized by this document.
