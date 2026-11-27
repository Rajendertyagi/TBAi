# TBAi — Recursive Workspace Architecture

**Status:** **Authoritative product and architecture specification** for the workspace. Documentation only — it does **not** authorize implementation. The earlier fixed Main/Right region model and the two-level `Chat | File Viewer | Browser | Files` contextual-tab model are **superseded** by this document.

**Audited branch / HEAD:** `ui-foundation-upgrade` @ `4c0cda723263a075458cb7a44025af40c059debd` (local HEAD equals `git ls-remote origin refs/heads/ui-foundation-upgrade`, re-checked at task start).

**Date:** 2026-11-28

**Authority:** This is the single clear target specification. `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md` remains the authoritative phase roadmap; `DOCKVIEW_INTEGRATION_PLAN.md` remains the authoritative record of the *implemented* Dockview foundation. Historical implementation records are preserved, not rewritten.

---

## 1. Evidence classes

| Class | Meaning |
|---|---|
| **Source-verified** | Read directly from production source at the audited HEAD; file:line cited. |
| **Library-verified** | Read from installed package declarations or official docs; path/URL cited. |
| **Prototype-verified** | Read from `prototype/index.html` implementation, not just screenshots. |
| **Test-covered** | A test source asserts the behavior; read, **not executed** in this task. |
| **Agent-reported** | A document records a claimed result; not independently re-executed. No hosted CI evidence exists. |
| **Unverified / owner decision** | No source or test evidence; explicitly open. |

No test result here is claimed to have passed recently.

---

## 2. The product model in plain language

The workspace is a **desk you can keep building**. On the left is a permanent list of every conversation — Direct chats and Code sessions — grouped by project. That list never moves and never rearranges itself.

To its right is one flexible area made of **panes**. A pane is a box that shows something: a chat, a file tree, a file preview, a browser, a terminal, or a future tool. You can split any pane into two panes — side by side or one above the other. Then you can split either of those children again, and again, as deep as you like. Every pane stays visible until you close it.

You can put things there two ways:

- **Manually** — choose what to add and whether it becomes a tab in the current pane or a new pane to the side or below.
- **By acting** — click a file in a chat and a file viewer opens beside it; click a link and a browser opens. If the right thing is already open, it is brought forward instead of duplicated.

Chats keep running while you look at other things. Their text, drafts, scroll position and streams are not lost. Closing a file preview does not close the conversation. Rearranging panes does not restart anything.

There is **no permanent Main or Right workspace**, no mandatory three-column layout, and no fixed position for any runtime.

---

## 3. Terminology — product vs Dockview

The word "panel" must never mean both a container and its content. This document uses:

| Product term | Meaning | Dockview term |
|---|---|---|
| **Workspace** | The complete working area to the right of Chat Threads | one `DockviewReact` instance |
| **Pane** | A spatial container that can hold content and be split into child panes | a **group** (a leaf in Dockview's grid tree) |
| **Split** | Divides a pane into two child panes | a **branch** in the grid tree; `addPanel`/`addGroup` with `direction` |
| **Content panel / tab** | One piece of content inside a pane: Chat, File Viewer, Files, Browser, Terminal | a **panel** (a tab inside a group) |
| **Conversation** | A Direct or OpenCode session | canonical tab key `chat:<id>` / `agent:<id>` used as a panel id |
| **Layout** | The arrangement of panes and content | `SerializedDockview` (`grid.root` + `panels`) |

**Rule:** in product writing say **pane** for the box and **content tab** for what is inside it. In code, Dockview's own names (`panel`, `group`) are kept where they refer to the library, but TBAi-facing APIs use `pane` and `contentTab`.

---

## 4. Visual diagrams

### 4.1 Initial workspace — Chat Threads and one Chat pane

```text
┌──────────────────┬──────────────────────────────────────────────────────────────┐
│ CHAT THREADS     │  [ Chat ▾ ]                                    [ + ]          │
│                  │──────────────────────────────────────────────────────────────│
│ Projects         │  Chat · Project A / Chat 1                                   │
│  Project A       │  ┌────────────────────────────────────────────────────────┐  │
│   Chat 1    ●    │  │ You: Where does the workspace root come from?        │  │
│   Chat 2         │  │ Assistant: It is resolved server-side…                │  │
│  Project B       │  │                                                      │  │
│   Chat 3         │  │ [ composer                                         ] │  │
│ Other chats      │  └────────────────────────────────────────────────────────┘  │
│ Sessions         │                                                              │
└──────────────────┴──────────────────────────────────────────────────────────────┘
```

### 4.2 Chat split right — File Viewer visible at the same time

```text
┌──────────────────┬─────────────────────────────────┬──────────────────────────────┐
│ CHAT THREADS     │ [ Chat ▾ ] [ + ]               │ [ File Viewer ▾ ] [ + ]      │
│                  │─────────────────────────────────│──────────────────────────────│
│                  │ Chat · Project A / Chat 1       │ File Viewer · workspace.ts   │
│                  │ ┌─────────────────────────────┐ │ ┌────────┬─────────────────┐ │
│                  │ │ transcript + composer       │ │ │ tree   │ code preview    │ │
│                  │ │ (still live, still scrolled)│ │ │        │ read-only       │ │
│                  │ └─────────────────────────────┘ │ └────────┴─────────────────┘ │
└──────────────────┴─────────────────────────────────┴──────────────────────────────┘
                            ← draggable sash →
```

### 4.3 Nested example — three levels of splitting

```text
┌──────────────────┬──────────────────────────────┬──────────────────────────────────┐
│ CHAT THREADS     │ Pane A: Chat                 │ Pane B (split down):             │
│                  │ ┌──────────────────────────┐ │  ┌──────────────────────────────┐ │
│                  │ │ Direct Chat 1            │ │  │ Pane B1: File Viewer         │ │
│                  │ │ transcript + composer    │ │  │ tree │ code                 │ │
│                  │ └──────────────────────────┘ │  └──────────────────────────────┘ │
│                  │                              │  ─────────── sash ──────────────  │
│                  │                              │  ┌──────────────────────────────┐ │
│                  │                              │  │ Pane B2 (split right again): │ │
│                  │                              │  │ ┌────────────┬─────────────┐ │ │
│                  │                              │  │ │ Browser    │ Terminal    │ │ │
│                  │                              │  │ │ URL/state  │ shell/session│ │ │
│                  │                              │  │ └────────────┴─────────────┘ │ │
│                  │                              │  └──────────────────────────────┘ │
└──────────────────┴──────────────────────────────┴──────────────────────────────────┘
   Level 0: workspace   Level 1: A | B   Level 2: B1 / B2   Level 3: Browser | Terminal
```

**Any pane can be split again.** There is no depth limit in the model; practical limits come from minimum pane sizes and screen space.

### 4.4 A populated workspace — six content types

```text
┌──────────────────┬──────────────────────────────┬──────────────────────────────────┐
│ CHAT THREADS     │ [Direct ▾] [Agent ▾] [ + ]  │ [Files ▾] [Viewer ▾] [ + ]       │
│                  │──────────────────────────────│──────────────────────────────────│
│                  │ Direct Chat · Project A      │ File Tree · Project A            │
│                  │ ┌──────────────────────────┐ │ ┌──────────────────────────────┐ │
│                  │ │ transcript + composer    │ │ │ src / services / …           │ │
│                  │ └──────────────────────────┘ │ └──────────────────────────────┘ │
│                  ├──────────────────────────────│──────────────────────────────────│
│                  │ OpenCode · Project B         │ File Viewer · workspace.ts       │
│                  │ ┌──────────────────────────┐ │ ┌──────────────────────────────┐ │
│                  │ │ agent transcript         │ │ │ read-only code               │ │
│                  │ └──────────────────────────┘ │ └──────────────────────────────┘ │
│                  ├──────────────────────────────┴──────────────────────────────────│
│                  │ [Browser ▾] [Terminal ▾]                                        │
│                  │ ┌──────────────────────────────┬───────────────────────────────┐ │
│                  │ │ Browser · docs link          │ Terminal · Project A          │ │
│                  │ └──────────────────────────────┴───────────────────────────────┘ │
└──────────────────┴──────────────────────────────────────────────────────────────────┘
```

### 4.5 Manual creation — add tab, split right, split down

```text
  Click [ + ] in a pane
          │
          ▼
  ┌──────────────────────────────────────┐
  │ Add content tab to this pane         │
  │ Split pane right                     │
  │ Split pane down                      │
  └──────────────────────────────────────┘
          │
   choose action → choose content type
   (Chat, Agent, Files, File Viewer, Browser, Terminal, future)
          │
          ▼
  add tab to current pane  OR  create child pane right/below
```

### 4.6 Automatic opening from a file or URL click

```text
  Click file "src/services/workspace.ts" in a chat
          │
          ▼
  openPanel({ type: "file-viewer",
              context: { conversationId, relativePath },
              placement: "beside-source", reuse: "by-identity" })
          │
     ┌────┴────┐
     ▼         ▼
 exists?     absent?
 focus it    create child pane beside the source chat
     │         │
     └────┬────┘
          ▼
  visible feedback: pane highlighted, file loaded, chat still live
```

Same flow for a URL → `type: "browser"`, identity = normalized URL. Clicking the same item again focuses the existing pane; a modifier forces a new instance.

### 4.7 Save and restore after restart

```text
  onDidLayoutChange / onDidMutateLayout
          │
          ▼
  api.toJSON() → { grid.root (recursive branches), panels (id + params) }
          │
          ▼
  versioned envelope → device-local storage
          │
     ── restart ──
          │
          ▼
  load → migrate → validate → reconcile against canonical identities
          │
          ▼
  api.fromJSON(saved, { reuseExistingPanels: true })
          │
          ▼
  every pane, size, active tab and content identity restored
```

---

## 5. Concrete user workflows

1. **Start.** Click `Project A / Chat 1` in Chat Threads → a Chat pane opens.
2. **Split right.** Use the pane's `+` → *Split pane right* → choose File Viewer → a child pane opens beside the chat; both visible.
3. **Split a child down.** In the File Viewer pane, `+` → *Split pane down* → choose Browser → the File Viewer pane becomes two stacked panes.
4. **Split again.** In the Browser pane, `+` → *Split pane right* → choose Terminal → three levels deep.
5. **Click a file.** In any chat, click a file name → File Viewer opens or focuses beside the source; chat keeps streaming.
6. **Click a URL.** Click a link → Browser opens or focuses; headless `agent-browser` is not this panel.
7. **Two chats.** Open a second conversation into a new pane → two independent runtimes; the same conversation cannot be duplicated.
8. **Move.** Drag a content tab to another pane → identity and runtime preserved; move is never a close.
9. **Focus.** Click a pane to make it active; keyboard commands and URL selection follow the focused chat pane only.
10. **Close.** Close a content tab → only that tab closes; closing the last tab in a pane leaves an empty pane that can be reused or closed explicitly.
11. **Restart.** The full nested arrangement returns with identities, sizes and active selections.

---

## 6. Manual and automatic creation — one mechanism

Both paths call one `openContent(request)` service:

```text
  request = { contentType, context, placement, reuse, source }
  source = "manual" | "automatic"
          │
  identity = contentType + context key
          │
     ┌────┴────┐
     ▼         ▼
 existing    new
 focus       create pane at placement
     │         │
     └────┬────┘
          ▼
  register → mount (renderer:"always") → persist
```

- **Manual:** `+` offers *add tab*, *split right*, *split down*, then a content type. Repeatable from any pane at any depth.
- **Automatic:** file click → File Viewer with file-tree context; URL click → Browser. Placement defaults to beside the source pane; falls back to below if no room.
- **Reuse:** by identity, not title. Clicking the same file twice focuses the same viewer. A modifier or explicit "open another instance" creates a second one with a distinct instance id.
- **Feedback:** the target pane is highlighted; never open into an invisible location.

---

## 7. Context and lifecycle

- **Conversation context** = canonical tab key + conversation id. **Project context** = registered folder id resolved server-side.
- A pane created from a conversation inherits its conversation and project context. Child panes inherit the parent's context; an explicit control can change it.
- **Pinned vs follow-active:** a pane is pinned to its context by default; "follow active conversation" is an explicit opt-in. Switching one chat never silently changes another pane's files, URL or terminal cwd.
- **File identity** = conversation id + safe relative path; never an absolute path as authority. Backend resolves the root with `resolveConversationWorkspace` and confines with `resolveSafe`/`inspectTarget` (`src/services/workspace.ts:399-522`; `src/services/tools.ts:109-176`).
- **Browser identity** = normalized URL; session state is per pane. **Terminal identity** = conversation id + session id; process lifetime is bound to the pane; cwd is the conversation root; shell is **not sandboxed**.
- **Closing content vs closing a pane:** closing a tab removes only that content; closing a pane removes its tabs and children. Neither deletes conversation history or shared membership.
- **Empty pane:** after the last tab closes, the pane stays as an empty drop target until explicitly closed or reused by the next open action.
- **Containment is not caller authorization** (`WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:347`).

---

## 8. Technical architecture — Option A recommended

### 8.1 Decision

**Use one Dockview instance whose groups are the user-facing panes and whose recursive grid tree provides arbitrary-depth splits.** Do **not** use nested Dockview instances, and do **not** introduce an application-owned recursive splitter engine.

### 8.2 Evidence for Option A

- Dockview's grid is a recursive tree: `SerializedGridObject<T> = { type: 'leaf' | 'branch'; data: T | SerializedGridObject<T>[]; size?; visible? }` (`dockview-core/dist/cjs/gridview/gridview.d.ts:56-61`); `GridNode<T> = GridLeafNode<T> | GridBranchNode<T>` (`:38-54`). Locations are arbitrary-length `number[]` paths (`:14-15`).
- `SerializedDockview.grid.root` is that recursive tree with group state at leaves (`dockview-core/dist/cjs/dockview/dockviewComponent.d.ts:102-108`).
- Directional placement relative to any group: `AddPanelPositionOptions` / `AddGroupOptions` with `referenceGroup`, `direction: 'left'|'right'|'above'|'below'|'within'` (`dockview-core/dist/cjs/dockview/options.d.ts:733-807`; `gridview/baseComponentGridview.d.ts:13`).
- One `toJSON()` captures the whole tree; `fromJSON()` restores it (`component.api.d.ts:625-631`).
- **No documented depth limit** — a search for `maxDepth|depth limit|recursi` across installed declarations returned no matches.
- Official docs: `https://dockview.dev/docs/core/overview`, `.../panels/add`, `.../groups/add`, `.../state/save`, `.../state/load`.

### 8.3 Why not nested instances (Option B)

Nested instances are supported in the free package (`https://dockview.dev/docs/core/nested`; licence table "Nested layouts ✓"), but they are strictly worse here:

- Each instance has its own DnD scope (`DockviewApi.id`, `component.api.d.ts:336-338`); cross-instance moves need explicit `onUnhandledDragOver`/`onDidDrop` bridging.
- A parent `toJSON()` does **not** include a nested instance's layout — `GroupviewPanelState` has no nested-layout field (`dockview/types.d.ts:39-55`); persistence fragments into N blobs.
- Focus navigation is per instance; no cross-instance traversal is documented.
- Lifecycle coordination is added for no benefit: Option A already provides the recursion.

### 8.4 What TBAi must add

1. **Terminology-safe placement API** — one module mapping "split right/down on pane X" to `api.addPanel({ position: { referenceGroup, direction } })` / `api.addGroup(...)`. No inline layout logic in UI components.
2. **Discriminated panel identity** — replace the closed `{ tabKey, contentType: "direct"|"opencode" }` contract (`dockviewParams.ts:17-20,86-99`) with a union:
   - `{ kind: "chat", tabKey: "chat:<id>"|"agent:<id>", contentType: "direct"|"opencode" }`
   - `{ kind: "tool", panelId: "<type>:<uuid>", contentType: "file-tree"|"file-viewer"|"browser"|"terminal"|future }`
   Keep `parseTabKey` and `desiredPanelKeys` as the chat-identity guard; do not force `params.tabKey === id` for tool panels.
3. **Registry split** — keep `panelRegistry` claim-by-tab-key for chat hosts (`panelRegistry.ts:24-41`); add a separate tool-panel instance registry for identity/reuse. Never turn `chatTabs` into a generic panel store.
4. **Reconciliation and persistence** — widen `layoutPersistence.ts:134-144,186-221` to accept both identity kinds; build the allowed set from chat keys **plus** tool panel ids; keep versioned envelope, corrupt fallback, and the floating/popout/edge drop.
5. **One opening service** used by manual and automatic paths (§6).
6. **Per-panel state module** keyed by panel id for viewer path/scroll, browser URL/history, terminal session — Dockview params are identity-only and have no component-state slot.
7. **Click seams** — markdown anchors (`ChatWindow.tsx:923-925`), file-path text in tool cards (`filesystem/ui.tsx:827-934`) and result fields (`result-fields.tsx:202-228`).
8. **Navigation resolution** — global `TabStrip` (`AppShell.tsx:154`) and Dockview group tabs both render today; retire the strip only after migrating its nine unique behaviors, keeping Chat Threads as the sole navigator.

### 8.5 Rendering policy

`renderer: "always"` is set for chat panels (`dockviewController.ts:40,260`) and preserves hidden DOM/streams. Apply it to File Viewer and Browser to preserve scroll and navigation state. Terminal should use it only if a persistent session exists; otherwise use `onlyWhenVisible` with explicit state restore. Measure memory with many panels before making this universal.

---

## 9. Prototype as visual evidence

`prototype/index.html` is **not** the architecture. It is a standalone visual exploration and must be preserved untouched.

**What it already demonstrates (prototype-verified):**
- `panel(tab)` creates a content area with its own tabs (`:332`).
- `split(dir, children)` creates recursive layout containers (`:333`).
- `renderNode(node)` recursively renders the tree (`:440-452`).
- `splitPanel(id, dir)` replaces a panel with a split and child panels (`:479-483`).
- Tree helpers `findPanel`, `findSplit`, `countPanels`, `removeNode`, `normalize`, `replaceNode`, `appendPanel` (`:349-355`).
- Sash dragging with minimum width (`:515-525`) and tab drag between containers (`:526-545`).
- localStorage save/restore (`:546-547`).
- One chrome for every chat position (`:430`).

**What it does not demonstrate / is misleading:**
- **Primary Chat is a permanent special position** (`:275`, `:305`, `:326-328`) — contradicts "no reserved Main/Right".
- **`splitPanel` duplicates the active tab** (`:481`) instead of creating an empty/new panel.
- **Adding panels is not targeted at the selected pane** — `appendPanel` appends to the root split (`:355`, `:478`).
- **No automatic file/URL opening** — content renderers are static strings (`:393-415`); no click handlers.
- **No project-context inheritance** — tabs carry only `identity` (`:322`); content hardcodes "ai-chat-app" (`:396`).
- `normalize()` collapses single-child splits (`:353`); empty-pane lifecycle is undefined.
- Persistence is an unversioned flat blob (`:546-547`).
- Registry includes `editor` (`:316`) but not Terminal.

Use it as evidence that recursive splitting is understandable and visually coherent; do not copy its custom layout engine.

---

## 10. Limitations, trade-offs and risks

- **Browser panel** is not feasible today: no embedded browser, CSP has no `frame-src`, most sites refuse framing. Needs an ADR. The headless tool is not this panel.
- **Terminal panel** needs a new backend process/session owner; `runBash` is one spawn per call and unsandboxed (`src/services/tools.ts:342-359`).
- **File API** must be conversation-scoped with containment; no caller authorization exists.
- **Dockview free package** lacks pinned tabs, multi-row tabs, layout history, keyboard docking and edge groups; none is required for the core model.
- **Too many panes** shrink each other; provide temporary maximize and minimum sizes.
- **Persistence is a contract** — upgrades must not reset layouts.
- **Narrow windows** need drawer/sheet fallback.
- **Multiple windows** — shared membership is SQLite-authoritative; layout is device-local.
- **Not proven:** runtime behavior of unused placement APIs in this app, CSS-hide state preservation, embedded-browser feasibility, any test pass result.

---

## 11. Unresolved owner decisions

| ID | Decision | Options | Recommended | Why open |
|---|---|---|---|---|
| D1 | Global `TabStrip` ownership | Retire after migrating nine behaviors; keep slim navigator | Retire after migration | Both strips render today |
| D2 | Per-panel state owner | Feature-owned store keyed by panel id; plain module; session-only | Feature-owned, device-local, corrupt-safe | No owner exists |
| D3 | Reuse vs create | Reuse by identity; always-new; modifier override | Reuse by identity, modifier forces new | Deterministic duplicate detection needed |
| D4 | Automatic placement | Beside source; below; type-specific | Beside source, fallback below | Affects workflows |
| D5 | Non-chat URL behavior | No URL change; panel route | No URL change | `localActiveKey` is chat-only |
| D6 | File API + threat model | New scoped endpoint with `resolveSafe` | Approve with explicit unauthenticated-capability note | No safe file API |
| D7 | Browser scope | Embedded; read-only preview; defer | Defer until ADR | CSP/framing risk |
| D8 | Terminal scope | Persistent shell; read-only output; defer | Defer or read-only first | Unsandboxed shell |
| D9 | Narrow-window behavior | Minimum sizes + collapse; scroll; single-pane | Minimum sizes + collapse | No production test |
| D10 | Multi-window behavior | Device-local layout; shared region state | Device-local; shared membership unchanged | SQLite-authoritative membership |
| D11 | File Viewer editability | Read-only; writable editor | Read-only; editor needs ADR | No editor library |

---

## 12. Acceptance criteria

`DP-01 … DP-18` are defined with future-test traceability in `CONTEXTUAL_WORKSPACE_IMPLEMENTATION_PLAN.md` and `CONTEXTUAL_WORKSPACE_TEST_STRATEGY.md`. Sections 2–9 are the behavioral source for those criteria.
