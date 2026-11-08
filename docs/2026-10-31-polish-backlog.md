# Polish backlog — sidebar, menus, composer, chat surfaces (2026-10-31)

Collected while another agent is editing the tree. **No production code was changed
for this file.** Each item records what was measured or read, where, and what
"fixed" would mean. Append new items at the bottom; do not renumber existing ones.

How to use an item: read its Evidence, confirm the Reproduction (or re-measure it),
then implement to its Acceptance. Every fix needs a test that fails before it.

Legend: `[ ]` open · `[~]` needs a product decision · `[x]` done (date + commit)

---

## P1 · [ ] Code-mode retry pill re-animates every second

**Symptom (reported):** while the engine retries, the status pill visibly "refreshes"
every second instead of just counting down.

**Evidence**
- `web/src/features/opencode/OpenCodePrimaryStatus.tsx:93-109` puts the countdown
  into `label`: `` `${countdown} (attempt ${retry.attempt})` ``, where `countdown`
  is `Retrying in 9s` and changes each tick.
- `web/src/components/assistant-ui/elements/agent-status.tsx:55-56` renders the
  label with `key={label}` and `fade-in blur-in-[2px] animate-in duration-300`.
  A new label string per second remounts the span, so the 300 ms entrance
  animation replays every tick.
- The ticker itself is correct: `OPENCODE_RETRY_TICK_MS` in
  `web/src/features/opencode/config.ts:106-107`, interval only while a deadline exists
  (`OpenCodePrimaryStatus.tsx:57-64`).

**Fix direction:** keep `label` stable — `Retrying, attempt N` — and pass the
digits through `elapsed` (rendered mono/tabular at
`agent-status.tsx:60-61`). The visible line stays `aria-hidden` as today; the
`role="status"` announcer at `OpenCodePrimaryStatus.tsx:100-102` already speaks
the attempt once.

**Acceptance**
- With a retry deadline, the label node is **not** remounted between ticks
  (assert `key`/text stability, or that no `blur-in` animation restarts).
- Only the seconds text changes once per second.
- `formatRetryCountdown` is still the single owner of the number format.

---

## P2 · [x] "Request failed" renders inside the composer and deforms it

**Symptom (reported):** a chat failure shows the error strip inside the composer
card and the composer changes shape. It should appear on the main chat surface,
not inside the composer.

**Evidence**
- `web/src/components/composer/ComposerAlerts.tsx:31-59` renders three alerts
  (`codeSendError`, `compactError`, stream-recovery notice + Retry) as flex
  children.
- It is inserted inside the composer's bottom button row:
  `web/src/components/Composer.tsx:716`, whose parent is
  `Composer.tsx:561` — `<div className="flex items-end justify-between gap-1.5 px-3 pb-3 pt-2">`.
  An alert therefore becomes a third child of the button row and grows the card.
- Copy and reason mapping live in `web/src/config/composer.ts:86,96-113`
  (`streamRequestFailed: "The request failed."`, `streamRecoveryCopy`).
- A transcript-level error surface already exists for message errors:
  `web/src/components/ChatWindow.tsx:1029-1096` (`AssistantError` via
  `MessagePrimitive.Error` / `ErrorPrimitive.Root`). The composer alerts cover a
  different set (run recovery, Code-start failure, compaction), which is why they
  currently sit in the composer.

**Fix direction:** render run-recovery / code-send / compact errors on the main
surface — an inline notice above the transcript end (inside the dock but outside
`ComposerPrimitive.Root`, e.g. next to the existing reserved status row) or a
transcript banner. Keep Retry with the notice. The composer card must not gain a
single pixel of height when an alert appears.

**Acceptance**
- Force each of the three errors; the composer card's bounding box is identical
  with and without the alert.
- The error and its Retry are visible in the chat area, not inside the card.
- The existing `role="alert"` semantics survive the move.

**Related guard to add:** DOM test asserting composer height is invariant when
`ComposerAlerts` has content.

---

## P3 · [ ] Folder row "⋯" menu opens at the page's top-left corner

**Symptom (reported):** the folder menu appears at the top-left of the window
instead of beside the folder row.

**Measured** (Playwright, 1440×900, private e2e server; folder row at x=54 y=108):

| Surface | Content box | Trigger box at open |
|---|---|---|
| Folder `⋯` dropdown | **x=4, y=0** | **0×0** (own `display:flex`, ancestor `display:none`) |
| Folder right-click | x=116, y=123 (= pointer) | n/a — anchored at pointer |
| Chat `⋯` dropdown | x=263, y=154, trigger at y=236 | 22×22 (laid out) |
| Chat right-click | x=116, y=215 (= pointer) | n/a |

**Root cause:** the folder's trailing actions are revealed with a *layout-removing*
class. `web/src/features/sidebar/components/FolderHeader.tsx:69` —
`hidden ... group-hover:flex group-focus-within:flex`. When Radix opens a modal
menu it sets `pointer-events:none` on `body` (and moves focus into the portal), so
the row loses `:hover`/`:focus-within`, the container returns to `display:none`,
the trigger measures 0×0, and the popper anchors at `(0,0)`. The chat row does not
have this bug because it reveals by **opacity** while keeping layout
(`SidebarThreadRow.tsx:200`: `absolute inset-0 ... opacity-0 ... group-hover:opacity-100`).

**Fix direction (pick one):**
1. Reveal the folder actions like the chat row — keep them in layout
   (`opacity`/`pointer-events` toggle, or `invisible` instead of `hidden`).
2. Keep the class swap but give `DropdownMenuContent` an explicit anchor ref to
   the row (`<DropdownMenu anchor={rowRef}>`), so positions never depend on the
   trigger's box.

Option 1 is smaller and removes the mechanism, not just the symptom; it also
matches the row that already works.

**Acceptance**
- Click `⋯` on the first and last folder; content sits beside the trigger
  (`side="right"`), content x > trigger x, y within the row, never `(0,0)`.
- Keyboard open (focus + Enter) positions the same way.
- Right-click continues to open at the pointer.

---

## P4 · [ ] "Open folder in Explorer" must not depend on Tauri — do it natively

**Symptom (reported):** the item is absent from the folder menu in the browser
build. Direction from the maintainer: adding a folder already works without
Tauri, so revealing one must not depend on it either.

**Why Tauri was used, and why it is not needed**
- Today the item is gated on the desktop shell
  (`web/src/features/sidebar/components/FolderHeader.tsx:141`
  `canOpenInExplorer: isTauri()`), and the builder omits the entry when false
  (`web/src/features/sidebar/lib/menu-actions.tsx:210-221`). The desktop path is
  `web/src/lib/platform.ts:230-236` → `@tauri-apps/plugin-opener` `openPath`.
- **That is the only `openPath`/`openUrl` call site in the repository**
  (`grep -rn "openPath\|openUrl" web/src src-tauri` → one hit plus
  `src-tauri/Cargo.toml:16`). The opener plugin + capability exist for this one
  menu item.
- Tauri was needed only because a web page cannot start a process. TBAi already
  has a **local backend on the same machine as the browser**:
  - it binds loopback only — `hostname: "127.0.0.1"`
    (`src/services/server-listener.ts:127`; the comment there says "strictly
    loopback (never LAN-exposed)");
  - it already touches the user's filesystem for this exact feature:
    `GET /api/folders/browse` lists arbitrary local directories
    (`src/routes/folders.ts:112-137`), and folder registration realpaths and
    stats the directory (`src/services/folders.ts:182-208`,
    `canonicalizeRoot` at `src/services/tools.ts:90-98`);
  - it already spawns OS processes: `Bun.spawn` in `src/services/tools.ts:354`,
    `src/services/browser.ts:171`, and the managed OpenCode binary
    (`src/services/opencode/serverManager.ts:661`).

  Revealing a folder is therefore a backend capability, not a webview one.

**Native options studied online (2026-10-31)**
1. **Small Bun spawn in the backend (recommended).** One platform switch, argv
   array, no shell:
   - win32: `Bun.spawn(["explorer.exe", absPath], { stdio: "ignore" })`
   - darwin: `Bun.spawn(["open", absPath], { … })`
   - linux: `Bun.spawn(["xdg-open", absPath], { … })`
   Bun docs: `Bun.spawn` resolves the executable, supports `stdio`, and
   `proc.unref()` detaches so no zombie is left behind
   (<https://bun.com/docs/runtime/child-process>). Bun has **no** built-in
   file-manager opener (`Bun.openInEditor` is editor-only and is not a
   substitute), so this ~15-line function is the whole implementation.
2. **`open` npm package (sindresorhus).** ESM; on Windows it goes through
   PowerShell `Start-Process` (so a failure is observable), macOS `open`,
   Linux `xdg-open`, and it handles WSL/container edge cases. Cost: one
   dependency plus a `docs/decisions.md` entry. Defensible only if real
   macOS/Linux support arrives; the app is Windows-x64 today
   (`web/src/lib/platform.ts:1`).
3. **Keep the Tauri opener (rejected).** Leaves the web build without the item
   and keeps a dependency and a capability for one call.

**Windows facts that shape the implementation**
- `explorer.exe <path>` is widely reported to return **exit code 1 even when it
  succeeds**, so the exit code carries no signal. Validate the directory
  server-side before spawning, return success on spawn, and never map the exit
  code to an error. Mark this as an implementation-time check: run it once and
  record the observed code in the commit message.
- Do **not** use `cmd /c start "" "<path>"` with a concatenated string: a folder
  named `a&b` would be shell-interpreted, and `start` treats its first quoted
  argument as the window *title*. The argv-array form above passes the path as
  one argument and has neither problem.
- Bun on Windows has a known bug where `spawn(..., { detached: true })` +
  `unref()` children are killed when the parent exits
  (<https://github.com/oven-sh/bun/issues/31603>, 1.3.14+; workaround
  `cmd /c start`). It should not apply here — `explorer.exe` hands the request
  to the running shell and exits immediately — but the acceptance test must
  prove the window survives a server restart rather than assume it.

**Endpoint design**
- `POST /api/folders/:id/reveal` (no meaningful body), handled in
  `src/routes/folders.ts`; the spawn itself lives in `src/services/folders.ts`,
  keeping the `routes → services` direction (§File ownership).
- **The id is the only input.** The path comes from the DB row, and
  `folderUpdateSchema` (`src/lib/validation.ts:724-731`) has no `path` field, so
  a client cannot point the endpoint at an arbitrary directory.
- Service steps: `get(id)` → null ⇒ 404; `canonicalizeRoot(folder.path)`;
  `statSync().isDirectory()` ⇒ typed 404 if the folder disappeared;
  `kind === "chat"` (hidden chat folders, `src/services/folders.ts:138-148`) ⇒
  reject, that row is never user-visible; then spawn.
- Never accept a client path; never pass the path through a shell.

**Residual risk to record**
- Loopback-only binding does not stop a *simple* cross-origin request. Requiring
  `Content-Type: application/json` (as the other POSTs already do) forces a
  preflight that the CORS allowlist refuses
  (`src/config/cors.ts:isAllowedCorsOrigin`), so an arbitrary website cannot
  trigger a reveal. Record in `docs/security.md` that a process running as the
  user can — same trust level as the app itself.
- If the app is ever run remotely (SSH port-forward), the window opens on the
  *server* machine. Out of scope for a local desktop app; state it plainly.

**Frontend change (after the endpoint exists)**
- `FolderHeader.tsx`: `POST` the folder id through `apiFetch`; toast
  `copy.openInExplorerFailed` on non-2xx. The folder id is already in scope;
  `folder.path` is no longer needed by the client.
- Drop `canOpenInExplorer: isTauri()` — the item is always present. Update the
  parity test's "Explorer omitted in browser" expectation.
- Delete `openFolderInExplorer` from `platform.ts`; remove
  `@tauri-apps/plugin-opener` from `web/package.json`, the plugin registration
  in `src-tauri/src/main.rs:903`, `tauri-plugin-opener` in
  `src-tauri/Cargo.toml:16`, and the capability entry in
  `src-tauri/capabilities/default.json:17-18` — only after re-running the
  `openPath` grep (still a single hit today).
- Update the menu-copy comment in `web/src/config/sidebar.ts:79`
  ("desktop only" → available in every build).

**Acceptance**
- Browser build: both menu surfaces show "Open folder in Explorer"; clicking it
  opens the folder; an unknown or deleted id shows a toast and spawns nothing.
- Desktop build: same code path — no Tauri call, opener plugin gone from the
  bundle.
- Unit: the platform argv builder for win32/darwin/linux (spawn injected); the
  route test asserts the stored path is what gets spawned and that no
  client-supplied path is accepted.
- Windows exit code 1 is not surfaced as a failure.
- The Explorer window survives a backend restart.

**Sources**: Bun child process docs
<https://bun.com/docs/runtime/child-process> · Bun Windows detached/unref bug
<https://github.com/oven-sh/bun/issues/31603> · `open` package
<https://github.com/sindresorhus/open> · explorer exit-code reports
<https://stackoverflow.com/questions/52423031/why-does-opening-an-explorer-window-and-selecting-a-file-through-pythons-subpro>

---

## P5 · [ ] Chat row menu: add "Copy URL" (keep "Copy chat ID")

**Symptom (reported):** the chat menu only copies the id; add a copyable URL.

**Evidence**
- Current chat menu builder:
  `web/src/features/sidebar/lib/menu-actions.tsx:91-144`; `Copy chat ID` at
  `:114-120`.
- Route helpers: `threadUrl(remoteId, engine)` in
  `web/src/features/chat/state/chatTabs.ts:189-191`
  (`/chat/<id>` or `/code/<id>`); `urlForTab` at `:177-180`.
- Copy labels: `web/src/config/sidebar.ts:119-120,200-201`.
- Call site that supplies the clipboard action:
  `web/src/features/sidebar/components/SidebarThreadRow.tsx:176` (and `:335` for
  the archived row).
- **Related defect found:** the tab strip "copy link" copies the **relative**
  route (`web/src/components/TabStrip.tsx:298` → `urlForTab`), which pastes as
  `/chat/abc` in another app. A shared absolute-URL helper would fix both.

**Fix direction:** add `Copy URL` right after `Copy chat ID` (both entry points,
via the shared builder), copying
`${location.origin}${location.pathname}#${threadUrl(id, engine)}` (hash router).
Keep `Copy chat ID` as the raw id. Point TabStrip's copy at the same helper.

**Acceptance**
- Both menus list `Open in new tab, Rename…, Copy URL, Copy chat ID, Archive | Delete…`
  (order to confirm with the mockup owner; grouping unchanged).
- The copied URL opens the same conversation (Direct and Code) in a fresh tab.
- Parity test labels array updated; clipboard content asserted in a DOM/e2e test.

---

## P6 · [ ] Drag folders (with their chats) to reorder

**Symptom (requested):** folders should be draggable so a folder and its chats can
be kept at the top instead of a fixed order.

**Evidence**
- `folders` already has `sort_order` (`src/db/index.ts:477-491`) and the list is
  ordered by it (`src/services/folders.ts:243,254`); new folders append via
  `nextSortOrder()` (`src/services/folders.ts:119-128`), and the update path can
  write `sort_order` (`:300`).
- No reorder endpoint or sidebar drag UI exists. Only section order has a UI
  (move up/down): `web/src/features/sidebar/components/SidebarSectionOrderControl.tsx`.
- Drag infrastructure already ships: `@dnd-kit/react` + `@dnd-kit/dom` 0.5.1
  (`web/package.json:17-18`), used by `web/src/components/TabStrip.tsx:11-13,88`.
  No new dependency required.

**Fix direction**
1. Sidebar: make each folder block sortable (a drag handle on the folder row,
   not the whole row, so click-to-expand and text selection still work).
   A folder block drags its children with it because the block is the unit.
2. Persistence: add `PATCH /api/folders/reorder` (array of ids in order, Zod
   validated, one transaction writing `sort_order`) via a service method; keep
   `sort_order` the single source of truth.
3. Keyboard alternative is mandatory (dnd-kit `KeyboardSensor`): Alt+↑/↓ or a
   "Move up / Move down" pair in the folder menu.
4. Decide: do chat `kind='chat'` folders participate? They are hidden rows;
   they should not appear as drag targets. Confirm group (`folder_groups`)
   interaction — dragging within/between groups is a separate question.

**Acceptance**
- Dragging folder B above A reorders B (with all its conversations) above A.
- The new order survives a reload (persisted), and a second client sees it.
- Keyboard reorder works without a pointer.
- A drag does not navigate, expand, or open the menu.

---

## P7 · [ ] Sidebar row times do not tick

**Symptom (observed):** rows keep saying "just now" until something else
re-renders them.

**Evidence**
- `web/src/components/ui/thread-last-message-time.tsx:36` formats once per render;
  there is no timer anywhere in the sidebar.
- `formatRelativeTime` (`web/src/lib/date-format.ts:12-28`) reads `Date.now()` at
  call time only. It is the sole consumer (`grep formatRelativeTime`).

**Fix direction:** a coarse ticker (30–60 s) **inside this leaf** so the list does
not re-render — the component already exists to isolate runtime state from the
sidebar. Prefer one shared store/`useSyncExternalStore` clock over one interval per
row if the sidebar grows.

**Acceptance**
- A row rendered at "just now" becomes "1m ago" within a minute without any server
  call or thread-list update.
- No re-render of the sidebar list container on the tick (measure render counts).

---

## P8 · [ ] Settings → Folders still uses native prompts and old copy

**Symptom:** the folder settings page behaves and reads differently from the
sidebar menu for the same folder.

**Evidence — `web/src/features/folders/FoldersPage.tsx`**
- `:74` `window.prompt("Set alias (blank to clear)")`, button label `:82` `Set alias`
- `:86` `window.prompt("Set color (hex, e.g. #6b7280)")`, label `:94` `Set color`
- `:107` `window.confirm(...)` for removal
- `:177` `window.prompt("New group name")`

**Fix direction:** reuse the sidebar's rename dialog, the colour picker
(`FOLDER_COLORS` + `FolderTile`), and the styled confirm; align the labels with
`Rename folder…` / `Set color` / `Remove from workspace`. Move the shared pieces
to an owner both surfaces can import (do not duplicate the dialog).

**Acceptance**
- No `window.prompt` / `window.confirm` remains in the folders feature.
- Labels and behaviour match the sidebar for rename, colour, remove.

---

## P9 · [ ] Menu chrome and typography: match the approved mockup (thin labels, compact rows)

**Symptom (reported):** the sidebar menus should look like the approved mockup —
thin type, tighter rows, smaller muted icons — instead of the current larger,
heavier rows, and the `⋯` and right-click should render identically.

**Mockup spec** (`D:/Temp/tbai-left-side/index.html`, CSS at
`.ctx-menu` / `.ctx-item` / `.ctx-sep`, markup in the "Right-click menus"
section):

| Property | Mockup target | Current |
|---|---|---|
| Popover | radius 10px, 1px border, padding 4px, solid `popover` bg, shadow `0 16px 32px -14px rgb(0 0 0 / .55)` | dropdown: `rounded-xl border-none p-1` + `glass-surface`; context: same with `p-1.5` (`dropdown-menu.tsx:28-31`, `context-menu.tsx:26-29`) |
| Item height | 28px | `py-1.5` + `text-sm` ≈ 32px |
| Item padding | `0 8px` | `px-2` (dropdown) / `px-2.5` (context) |
| Item radius | 6px | 4px (dropdown `rounded-sm`) / 6px (context) |
| Label | 12.5px, weight 400 | `text-sm` (14px); context adds `font-medium` |
| Icon | 14×14, `muted-foreground`, `flex-none` | `size-4` (16px) at `menu-actions.tsx:97,108,117,136,175,185,203,216,228,239` + `menu-kit.tsx:59` |
| Icon gap | 8px | `gap-2` ✓ |
| Submenu chevron | 12×12, `margin-left:auto`, right-pointing, muted | `ChevronRight size-4` (`dropdown-menu.tsx:177`, `context-menu.tsx:95`) |
| Separator | 1px, margin 4px 6px, border colour at ~85% | dropdown `-mx-1 my-1 bg-muted` (`dropdown-menu.tsx:68`); context `bg-border/40` (`context-menu.tsx:66`) — the two disagree |
| Danger | label **and icon** destructive | label destructive only; icon keeps `currentColor` from the default class |
| Width | content-driven (mockup 262px is the demo card) | dropdown `min-w-[8rem]` + call-site `min-w-44`; context primitive `min-w-[10rem]`, no call-site width |

**Where the change goes.** Sidebar-scoped, through the shared renderers — not
the vendored primitives, which serve every menu in the app (providers, settings,
tab strip):
1. One exported item/popover class constant next to
   `renderMenuActions`/`renderFolderMenu` (`web/src/features/sidebar/components/menu-kit.tsx`)
   so both surfaces cannot drift — the same rule the action list already
   follows ("not a convention, the same data").
2. Icons move from `size-4` to `size-3.5 text-muted-foreground`, and the item
   carries `group` so a destructive item can colour its icon:
   `group-data-[variant=destructive]:text-destructive`.
3. Folder "New chat in this folder" currently uses `Plus`
   (`menu-actions.tsx:175`); the mockup uses the message-plus glyph
   (`MessageSquarePlus`), which matches "chat", not "add". Every other icon
   already matches the mockup's semantics (ExternalLink, Pencil, Palette, Link2,
   FolderOpen, Copy, Archive, Trash2).
4. Apply the popover class at the four sidebar call sites (`FolderHeader.tsx`
   ⋯ content + context content, `SidebarThreadRow.tsx` ×2) so the two surfaces
   match.

**Implementation traps (verified in the source)**
- The primitives set `border-none`; adding `border` in a caller class does not
  remove `border-style:none` (tailwind-merge treats them as different
  utilities). Add `border-solid` with the width, and verify computed
  `border-width` is 1px — otherwise the mockup's outline silently never appears.
- `glass-surface` supplies the current background/shadow. Passing `bg-popover`
  may not fully override it (gradients/backdrop). Confirm the computed
  background is solid before accepting the screenshot.
- Context and dropdown currently set different min-widths (`8rem`/`10rem`
  primitive, plus `min-w-44` only on dropdowns). Give both the same sidebar
  width class, or the columns will still differ after the rest matches.
- Labels already match the mockup except the documented US spelling
  (`Set color`). Do not "fix" the wording in this item.

**Acceptance**
- Computed styles for both surfaces of the same menu are identical: item
  height 28, radius 6, inline padding 8, font 12.5/400, icon 14, icon colour
  muted, separator 1px at 4/6 margins.
- A destructive item's icon is destructive, not muted.
- `sidebar-menu-parity.test.ts` still proves one action list behind both entry
  points, and gains a source guard that both surfaces receive the same class
  constant (a class passed to one surface only would fail it).
- Screenshot pair (`⋯` open and right-click open) is indistinguishable.

---

## P10 · [ ] New chat row and title stay invisible until a reload

**Symptom (reported):** send a prompt, the AI answers, and still neither the
sidebar row nor the thread name at the top appears. The sidebar keeps showing the
old rows plus "Load more"; the row and the name only show after a
page refresh. Clarified 2026-10-31: this is **not** about the `New chat` button —
the row and title must be correct *after the turn completed*, and they are not.
It should appear immediately at the top of its list, under the folder for a
project chat, with the generated name.

**Evidence — the chain, end to end**
1. Creation returns only an id. `initialize()` materializes the draft and returns
   `{ remoteId }` (`web/src/adapters/remoteThreadListAdapter.tsx:201-209`); the
   POST body fixes the title to the literal `"New Conversation"`
   (`web/src/features/chat/state/materializeDraft.ts:156-170`).
2. The real title is produced later, server-side, from the first user message:
   `web/src/services/storage/messages.ts:501-519` updates the row when the title
   is still `"New Conversation"` (or `title_source = 'auto'`).
3. That update never reaches the client. The message endpoint returns
   `{ success, persisted }` only (`src/routes/conversations.ts:347-383`), and the
   adapter's `generateTitle` is a deliberate no-op
   (`remoteThreadListAdapter.tsx:336-340`).
4. The sidebar is **not** fed by the runtime's thread list. Each surface runs its
   own fetch: `web/src/components/Sidebar.tsx:109-114` (Chats) and
   `web/src/features/sidebar/components/FolderConversationRow.tsx:29-34` (each
   expanded folder).
5. **The assistant reply does not change this.** Both the user turn and the
   assistant turn persist through the same `appendStored` → `POST
   /api/conversations/:id/messages` path
   (`web/src/adapters/threadHistoryAdapter.ts:171-190,225,289-293`), and that
   endpoint returns `{ success, persisted }` only
   (`src/routes/conversations.ts:347-383`). So the state after a *completed* turn
   is the same as after the first send: the row exists server-side with its
   derived title, and nothing in the browser asks for it again. There is no
   turn-boundary event to hang a refresh on today.
6. That fetch re-runs only on its query inputs, the availability recovery epoch,
   or an explicit `refetch()`
   (`web/src/features/sidebar/hooks/useConversationsList.ts:80-90,99-167`). The
   only `refetch` callers are rename / archive / delete on an existing row
   (`SidebarThreadRow.tsx:106-133,150-152`). Creation, auto-title and every
   message append touch none of those inputs, so no request is made.
7. Folder badges come from the folders store, loaded once on mount
   (`Sidebar.tsx:86-88`), so a new folder chat leaves the count stale too.
8. Header title reads the runtime's thread item
   (`web/src/features/chat/components/ChatHeader.tsx:118-124`), which holds the
   creation title, not the derived one; the tab title probes exactly once per
   `ref` (`web/src/components/TabStrip.tsx:46-78`), and the ref already changed
   before the first message was persisted.
9. This is known and worked around in tests rather than fixed:
   `tests/e2e/core/running-indicator.spec.ts:16-21` ("a conversation created by
   the send has no row until the list refetches — measured, the row count does
   not change during a first send"), `tests/e2e/history/phase-8-tabs-navigation.spec.ts:246-251`
   and `tests/e2e/core/phase-ua-d.spec.ts:250-262` both reload for this reason.

**Why "Load more" is on screen:** it is not a paging bug. The list is a stale
snapshot from mount, and `hasMore` is derived from that snapshot
(`useConversationsList.ts:155`). The new row is simply absent from it.
**Ordering needs no change:** the server sorts `updated_at DESC`
(`src/services/storage/conversations.ts:280`) and the hook always asks from
offset 0 with a growing limit (`useConversationsList.ts:108-112`), so once the
refresh happens the new row lands first — in Chats or in its folder.

**Fix direction**
1. **One invalidation signal, two producers.** Emit after (a) the draft
   materializes and (b) a message POST completes — both user and assistant
   messages go through `appendStored`, so (b) also covers the *post-response*
   case where the turn is over and the row/title are still missing. Owner:
   `web/src/features/chat/state/conversationMutations.ts`
   (already the conversation-mutation owner — extend, do not add a parallel
   module). Same shape as the existing `recoveryEpoch` subscription
   (`useConversationsList.ts:80-85`) so there is one mechanism, not two.
2. **Sidebar consumes it.** `useConversationsList` adds the revision to its
   effect dependencies; `Sidebar` calls `loadFolders()` on the same revision so
   folder counts update.
3. **Title surfaces.** Preferred: have `POST /api/conversations/:id/messages`
   return the row's title alongside `persisted` (the value is already in hand at
   `messages.ts:501-519`), so header and tab can show it with no extra request.
   Where it is written is the open question: refresh the assistant-ui thread
   list through a public 0.15.30 API (verify the exact method on the installed
   types — the train is frozen), or feed the existing
   `probeConversation`/`threadListAdapter.fetch` path that the tab already uses
   (`TabStrip.tsx:58-70`) and let the header prefer that title while the runtime
   item is stale. Do not add a second, independent title source.
4. **Coalesce.** Fire once per turn, never on streaming tokens; a refetch storm
   during a run would replace one bug with another.
5. **Not in scope here:** making a row exist the moment `New chat` is clicked.
   Creation-on-first-send is deliberate server behavior
   (`src/services/storage/conversations.ts:150-159` documents the hidden chat
   folder minted at creation), and changing it is a separate product decision.
   This item guarantees that after the first send everything is already correct.

**Acceptance**
- From `/#/chat/new`, send one message and let the assistant finish: the row
  appears in its list (top) with the generated name, the folder badge increments,
  and the header and tab show that name — all without a reload, and still true
  after the turn completes.
- Same for a simple chat (Chats section) and a project chat (its folder).
- One refetch per turn; no refetch while tokens stream.
- A test that fails on today's code: assert row + header title appear after the
  turn completes with **no** `page.reload()` (the three specs above currently
  encode the opposite; update them to assert the fixed behavior, not to keep the
  reload).

---

## P11 · [ ] The active conversation is effectively invisible in the light theme

**Symptom (reported, 2026-10-31):** "i cant any active chat indiactor which you
have said you have added ealier". No row reads as "you are here"; the app looks
like nothing is selected.

**Evidence**
- The indicator exists, but it is a fill and nothing else. `data-active` is set
  on the row (`SidebarThreadRow.tsx:184`, value derived at `:102-105`) and
  `sidebar-row-surface` (`:63-64`; `globals.css:325-334`) paints `[data-active]`
  with `--sidebar-accent`.
- Those two tokens are almost the same colour in the light theme:
  `--sidebar: oklch(0.9851 0 0)` (`globals.css:62`) versus
  `--sidebar-accent: oklch(0.9674 0.0013 286.4)` (`:66`) — ΔL **0.0177**, about
  1.8%. The dark pair is `0.205` → `0.28` (`:165,169`), about 7.5%, which is why
  the dark screenshots (`20-sidebar-parity-rest.png`,
  `21-sidebar-active-hover.png`) show *something* and the light theme reads as
  blank. The sidebar is also `glass-surface`, so the painted background is not
  exactly `--sidebar` either.
- Hover is **weaker** than active — `--sidebar-row-hover` is the accent at 70%
  (`globals.css:121`) — so "pointer is here" and "this is the open chat" differ
  by a fraction of an already invisible step.
- The approved mockup specs the same faint fill (`.p-row.active{background:
  var(--sidebar-accent)}`, mockup `index.html:515`). **This is the first item
  where implementing the mockup exactly reproduces the complaint** (P12 is the
  second), so it needs a deliberate, recorded deviation.
- There is no non-visual state either: the active row carries only `className`
  and `data-active` (`SidebarThreadRow.tsx:184`) — no `aria-current`/
  `aria-selected` — so assistive tech cannot identify the open chat.
- Both wiring paths must be covered by tests: folder children receive the
  URL-derived id (`FoldersSection.tsx:31,51`), while the Chats list passes none
  and falls back to the tab store's `activeKey`
  (`Sidebar.tsx:270-276`; `SidebarThreadRow.tsx:102-105`).

**Fix direction**
1. One new token, `--sidebar-row-active`, per theme, visibly separated from both
   the sidebar surface and the hover wash (accent mixed toward the foreground in
   light, toward white in dark — tune by measurement, not by taste). Paint
   `[data-active]` with it; leave hover unchanged so the states stay ordered.
2. Add a **2px left tick** inside the row (inset, so nothing shifts). The
   mockup already uses a 2px active tick for the left rail
   (`.railbtn.active::before`, `index.html:166-167`, described in its own text at
   `:1168`), so this keeps one visual language instead of inventing one.
3. Set `aria-current="true"` on the active row.
4. Do not encode "active" in colour alone — the tick survives at any contrast
   setting and any theme a port adds later.

**Acceptance**
- Measured in both themes: active row vs sidebar background ΔL ≥ 6% (light) and
  ≥ 8% (dark); active vs hover visibly distinct. Assert on computed styles, not
  on class names.
- A 2px tick is present on the active row; the title's x/y are identical to an
  inactive row (no reflow).
- Exactly one row per list carries `data-active` + `aria-current`; the keyboard
  focus ring is unaffected.
- Fails today on the contrast and aria assertions.

---

## P12 · [~] Folder name, chat name and the running dot sit on three left edges

**Symptom (reported):** "folder name agalined middle while chat thread name
aglined left keep left only" — folder names look indented/middle-aligned while
chat titles hug the left edge. Keep the chats left; bring the folder name to the
same edge.

**Evidence — measure the title, not the row**
- Folder row: `pl-2` + 18px letter tile + `gap-1.5` → label x ≈ **32px** inside
  the row (`FolderHeader.tsx:56-58,162-166`; tile size `globals.css:262-277`).
- Chats row, idle: `pl-2`, and `ThreadRunningDot` renders `null` when nothing is
  running, so the title is the first child → x = **8px**
  (`SidebarThreadRow.tsx:63-64,190`; `thread-running-dot.tsx:56-65`).
- Chats row, running: the dot (6px) plus the 6px gap appear → x = **20px**. The
  title therefore jumps 12px when a run starts and back when it ends — a second
  defect in the same slot, independent of folders.
- Folder children: `sidebar-folder-children` adds `padding-left:18px`
  (`globals.css:284-286`) → idle child x ≈ 26px, running child x ≈ 38px. Under
  one folder that is three edges: 32 (folder), 26 (idle chat), 38 (running chat).
- The mockup shares the defect: `.p-folder{gap:7px}` with an 18px `.ftile`
  versus `.p-row` padding 8px (`index.html:434-440,510-512`), and `.run-dot` is
  only rendered on the active row (`:907,522`). So the mockup cannot be the
  reference for this fix.

**Fix direction — needs a pick**
- **Option A (recommended).** Keep the folder colour and give every title the
  same left edge by removing the *leading* tile: name first at `pl-2`, the 18px
  letter tile becomes the row's trailing identity (beside the count, or reduced
  to a 6px colour dot at the right edge of the row). Folder and chat titles then
  share x = 8px, chats keep the left edge exactly as asked, and the fixed
  trailing slot still swaps count ↔ actions without reflow.
- **Option B.** Give *every* row the same 24px leading slot — folders keep the
  tile, chats gain the engine icon (P14) in that slot. Titles align at ≈32px,
  but no title starts at the left edge any more. This satisfies "aligned" and
  "coloured icons" together, at the cost of indenting every chat.
- **Option C (rejected).** Keep the tile leading and add a matching ghost slot to
  chats: aligns folder children with their folder but leaves the Chats section at
  8px, so the two sections still disagree.
- **Regardless of the pick:** reserve the running-dot slot — a fixed 6px box
  rendered always, dot drawn inside it — so a run start/finish never moves the
  title.

**Acceptance**
- `getBoundingClientRect().x` of the title is **one shared value** for a folder
  row and a top-level Chats row (Option A: 8px; Option B: the 32px slot edge).
- A folder child keeps its connector indent: its title x changes only by the
  slot decision (not by run state), and the indent relative to its folder stays
  constant.
- Starting and finishing a run does not move any title (asserted on both sides of
  the state change).
- The folder colour is still visible on every folder row **without hover**.
- A test that fails today: assert idle vs running title x, and folder vs chat
  title x.

---

## P13 · [ ] Mode controls carry the wrong icon, or none

**Symptom (reported):** "chat mode main option add icons here".

**Evidence**
- The composer scope chip reads "Chat mode" but renders a **Folder** icon in
  both the bound and the editable states (`WelcomeScopePicker.tsx:87` and `:112`;
  label from `config/welcome.ts:152`). The icon is always `Folder`, so in Chat
  mode it misrepresents the scope entirely.
- The Direct / OpenCode switch is text-only: `EnginePicker.tsx:19-45` builds
  `{ id, label }` entries and renders `{opt.label}` with no icon at all. It is
  shared by the welcome screen (`WelcomeEnginePicker.tsx:17`) and
  `NewProjectChatDialog.tsx:123`, so every creation surface is text-only.
- The chat-mode entry *inside* the scope menu already has an icon
  (`MessageSquare`, `WelcomeScopePicker.tsx:174`) — the inconsistency is only on
  the two triggers that represent the current mode.

**Fix direction**
- One shared engine descriptor module (see P14) supplying icon + colour + label;
  `EnginePicker` renders the icon inside each pill and keeps the existing active
  weight change.
- The scope chip picks its icon from the scope: a chat/messages glyph for
  "Chat mode", `Folder` for a project folder — instead of always `Folder`.
- All labels stay in `web/src/config/welcome.ts`; no literal strings in
  components (the current components already import from there — keep it that
  way).

**Acceptance**
- Scope = Chat mode → chip shows a chat icon; scope = a folder → chip shows the
  folder icon; switching the engine changes the pill's icon immediately.
- Icons are `aria-hidden`; each control keeps its present accessible name.
- DOM test for both chip states and both pills; fails today.

---

## P14 · [~] Coloured engine icons, the way Paseo marks each provider

**Symptom (requested):** "show colored icons jsut like paseo showing".

**Evidence**
- Paseo runs many providers (Claude Code, Codex, GitHub Copilot, OpenCode, Pi,
  Antigravity, Muse Code — `getpaseo/paseo` README) and its UI identifies each
  agent by its provider's own glyph. Its search surface is also where those
  entries are found (see P15).
- TBAi has two engines and **no visual identity** for either: `EnginePicker` is
  text-only (`EnginePicker.tsx:19-45`), there is no provider/engine icon
  component (`grep -rn "ProviderIcon\|providerIcon" web/src src` → no matches),
  and `web/src/config/` has no engine registry.
- The engine is already on every sidebar row (`item.engine`,
  `useConversationsList.ts:11,135,148`) and already drives routing
  (`SidebarThreadRow.tsx:173,333`), so a row badge needs no request change.
- The chat row's leading slot is empty when idle (P12), which is the natural
  home for this icon — P12 and P14 must be decided together.
- Constraint from P9: menu glyphs stay muted. Coloured icons are identity marks
  on rows and controls, **not** menu chrome.

**Fix direction**
- New `web/src/config/engines.ts`: `EngineVisual = { id; label; icon; color;
  foreground }` for `direct` and `opencode`, typed `satisfies Record<EngineId,
  EngineVisual>` so adding a third engine fails to compile until it has visuals.
  Components import the registry; no inline colours.
- The colour is data (an identity colour, like a folder's) — the documented
  exception to "theme tokens beat literal colours".
- Do not bundle third-party brand logos (licensing and payload); a lucide glyph
  in a fixed hue is the default, and a local SVG only if a logo is explicitly
  approved.
- Decide once where it appears: engine pills (P13), scope chip, sidebar chat
  rows, tab strip. Note the limit: Direct mode selects among *providers*, so a
  row can only show the engine; per-row provider identity would require adding
  the provider id to the conversations list payload — a separate decision.

**Acceptance**
- Both engines have a colour + glyph, and the same tuple renders on every chosen
  surface (one registry, no per-surface copies).
- Glyph contrast ≥ 3:1 against its own pill/row surface in both themes
  (measured).
- Exhaustiveness is enforced by the type contract, not by a test that lists
  strings.
- The P9 parity test still shows muted menu icons.

---

## P15 · [ ] Sidebar search becomes a popout (Paseo Command Center), not an inline swap

**Symptom (requested):** "we need to make side bar search just like paseo where
it shows popout window for search … check paseo".

**Evidence — today**
- Search lives in the left chrome: `Ctrl/⌘K` or the magnifier opens a 24px-high
  input **inside the chrome row**, and opening it forces the sidebar visible
  (`LeftEdgeChrome.tsx:37-43,52-76,88-116`).
- While a term is present the sidebar **replaces its entire section area** with
  `SearchResults` (`Sidebar.tsx:104,152-158`); minimum length 1
  (`config/sidebar.ts:145`); debounce in the store.
- It searches conversations only (`useConversationsList({ search })`,
  `SearchResults.tsx:37-41`). Folders and actions are not searchable.
- There is no palette/overlay surface in the tree
  (`grep "cmdk\|command" web/src/components/ui` → no matches).

**Evidence — Paseo**
- Paseo's search surface is the **Command Center**, opened with ⌘K/Ctrl+K:
  plugin docs ("`client.addCommandCenterItem` … opens via ⌘K/Ctrl+K",
  `paseo.sh/docs/plugins`), plugin listings ("command center (⌘K)" for archived
  workspaces, `paseo.sh/plugins/all`), and the changelog ("Added sidebar grouping
  to the Command Center", `paseo.sh/changelog`).
- Paseo is **open source** (`github.com/getpaseo/paseo`) and the Command Center is
  fully readable: `packages/app/src/command-center/` (`command-center.tsx`,
  `list-metrics.ts`, `results.ts`, `interaction.ts`, `root.tsx`), plus
  `keyboard/keyboard-shortcuts.ts`, `i18n/resources/en.ts` and `theme.ts`.
  Read on 2026-10-31 through the GitHub API; the studied copies are in
  `C:/Users/RTPC/AppData/Local/Temp/paseo-study/`.
- **A screenshot is not needed** — the layout, tokens and behaviour below are
  derived from source, not from public docs. The earlier version of this item
  said the layout was unverified; that is now resolved.
- No `cmdk` in `web/package.json`; the unified `radix-ui` 1.8.1 package
  (`web/package.json:33`) already supplies the Dialog primitive the app uses
  (`web/src/components/ui/dialog.tsx`).

**Studied spec — geometry (source: `command-center.tsx`, `list-metrics.ts`)**

| Part | Value |
|---|---|
| Overlay | full-screen flex, `justify-content:flex-start`, items centred, **top padding 48px** |
| Backdrop | `rgba(0,0,0,0.5)` (`0.45` only for the compact-native bottom sheet) |
| Panel | **640 × 560**, `max-width:92%`, `max-height:80%`, 1px `border`, radius **8**, `surface0`, `shadow.lg` = `0 12px 24px rgba(0,0,0,.40)`, `overflow:hidden` |
| Header | padding **16 / 12**, 1px bottom border; search row gap 8 |
| Input | 14px, `padding-block:4`, `flex:1`, no outline; muted placeholder |
| Scope chip | inline before/after the input, `gap:6`, `padding-inline:8`, radius 6, `borderAccent` 1px, `surface2`; height equals the input's line box **so showing or dropping it cannot resize the header** |
| Row | `padding-inline:16`, `justify-content:center` |
| Row heights | single-line **32** (6+20+6), two-line **46** (6+18+16+6) |
| Section label | a **32px band** (8+16+8), 12px, muted |
| Section divider | a **17px band** (8+1px+8) |
| Icon slot | **16 × 20** (line box height), content gap 12 |
| Selected / hover / pressed row | `surface1` (see the contrast note below) |
| Empty state | centred, muted, 16/24 padding, 14px |

**Token mapping — Paseo → TBAi**

| Paseo token | Value | TBAi today | Use |
|---|---|---|---|
| `SPACING[4]` / `[3]` / `[2]` / `[1.5]` / `[1]` / `[0.5]` | 16 / 12 / 8 / 6 / 4 / 2 | Tailwind `4` / `3` / `2` / `1.5` / `1` / `0.5` | 1:1 — no numeric tokens needed |
| `FONT_SIZE.base` / `.sm` / `.code` | 14 / 12 / 12 | `text-sm` / `text-xs` / `text-xs` (mono) | 1:1 |
| `ICON_SIZE.md` | 16 | `size-4` | row + input glyphs |
| `BORDER_RADIUS.lg` / `.md` | 8 / 6 | `rounded-lg` / `rounded-md` | panel / chip |
| `surface0` `#ffffff` | panel bg | `bg-popover` | not `bg-background` (differs in dark) |
| `surface1` `#fafafa` | row hover/selected | `bg-sidebar-accent` or the new `--sidebar-row-active` (P11) | see contrast note |
| `surface2` `#f4f4f5` | scope chip | `bg-muted` | |
| `foregroundMuted` `#71717a` | placeholder, labels | `text-muted-foreground` | |
| `borderAccent` `#ececf1` | chip border | `border-border` | |
| `shadow.lg` | `0 12px 24px rgba(0,0,0,.40)` | `shadow-overlay` (already used by `dialog.tsx`) | |
| `theme.colors.border` | 1px | `border-border` | panel + header rule |

**Studied spec — behaviour**

- **Two sections, in fixed bands.** Band 0 = ranked contributions (Actions);
  band 1 = pinned content: Workspaces (rank 2), Agents (rank 3), Files
  (rank 4). A section title renders only when that section has rows; dividers
  separate bands.
- **Empty query shows the five most recent items per category** — recency is the
  whole ranking, and empty `updated_at` sorts last. Paseo fires **no** remote
  query for an empty query.
- **Ranking is field-rank then match-tier.** A match in visible text outranks a
  match in a hidden keyword; within a tier the stronger match type wins; ties
  break on recency. Total ordering, so the highlighted row never jumps. A
  PR/MR number (`#1234`) only matches exactly.
- **The active row is preserved** as results change (matched by stable id) and
  falls back to the first row when it disappears. Any query change resets to
  the first row; selection is *not* reset by every keystroke of the same query
  string.
- **Keyboard**: ↑/↓ wrap around, Enter runs the active row, Esc closes,
  Backspace **on an empty query** clears the scope chip (a layered Esc/Backspace,
  not a second shortcut). Navigation is refused while the file index is still
  loading, so Enter cannot act on a stale row.
- **Auto-reveal is cancelled by manual scroll** — scrolling the list stops the
  "keep the active row visible" effect until the user moves selection again.
  That is the correct fix for list jumpiness and is cheap to copy.
- **Focus is restored to the invoking element** with retries, falling back to
  dispatching a `message-input.focus` event. In TBAi Radix Dialog already
  returns focus to `DialogTrigger`/the previously focused node, so the retry
  machinery is **not** copied — only the fallback intent (focus the composer
  when the invoking element is gone) is kept.
- **⌘K is a true toggle**: the shortcut registry entry is
  `command-center.toggle`, so a second press closes it. TBAi's current ⌘K only
  opens the inline input.
- **List is virtualised** (`initialNumToRender: 12`, `windowSize: 5`,
  `getItemLayout` with the exact row heights above). TBAi should copy the
  *heights* and defer virtualisation until a real list exceeds ~100 rows — React
  19 + 20–60 rows does not need it.
- **Compact native opens a bottom sheet** at 60%/90% snap points. There is no
  mobile TBAi target today; recorded only so the desktop panel is not mistaken
  for the only case.

**TBAi adaptations (the places Paseo cannot be copied verbatim)**

1. **The dialog primitive must be overridden, not restyled globally.**
   `dialog.tsx` centres `max-w-lg rounded-xl p-6 glass-surface`, which is a form
   dialog. The palette needs `p-0`, radius 8, `bg-popover`, a 1px border, and
   **top-anchored** placement (`top-12`, not vertically centred). Put these in a
   `className` on `DialogContent` at the palette call site; do not edit the
   shared primitive (every settings dialog uses it).
2. **Server search is unranked and snippet-less.** `GET
   /api/conversations?search=` is `title LIKE` OR `messages.content LIKE` OR
   FTS `MATCH`, ordered `updated_at DESC`
   (`src/services/storage/conversations.ts:264-277`), limit 20
   (`config/sidebar.ts:142`). So:
   - rank **client-side** over the returned page: title prefix > title word >
     title substring > recency. Do not present server order as relevance.
   - highlight **titles only** on the first version. A content snippet needs an
     FTS `snippet()` column in the API — a small, separate backend change, and
     it must not be smuggled into this item.
   - add an `AbortController` so a slow response for `"ab"` cannot overwrite
     results for `"abc"` (the current hook has no cancellation; ordering is
     guaranteed today only by the debounce).
3. **The current search contract stays.** `searchMinLength: 1`, the existing
   debounce and `/api/conversations?search=` remain the request shape. The
   palette adds *local* sections (Folders, Actions), it does not add a second
   search API.
4. **⌘K moves owner.** `LeftEdgeChrome.tsx:59` currently binds ⌘K to the inline
   input. The shortcut and the magnifier button both open the palette; the
   inline input (`:100-116`) and `SearchResults` (`SearchResults.tsx`,
   `Sidebar.tsx:152-158`) are deleted in the same change, or the app has two
   search surfaces.
5. **No `cmdk`.** Radix Dialog + a small listbox gives focus trap, escape and
   restore for free; the filtering and keyboard model are ~120 lines and the
   app already owns the ranking rules (adaptation 2). `cmdk` would add a
   dependency whose filtering model we would override anyway. If that judgement
   changes, record it in `docs/decisions.md` **before** installing.
6. **Selected-row contrast is a deliberate improvement over Paseo.** Paseo's
   selected row is `surface1` (`#fafafa` on `#ffffff`) — the same ~2% ΔL that
   P11 reports as invisible. The palette reuses the new P11 token
   (`--sidebar-row-active`) plus, if the P11 tick is adopted, the same 2px
   accent tick. Do not reproduce the invisible fill just because the source app
   does.

**Fix direction**
1. New surface with its own owner, `web/src/features/search/`: state
   (`state/searchStore.ts` — `open`, `query`, `activeId`), the overlay
   (`SearchPalette.tsx`), the row/list (`SearchResultsList.tsx`) and copy
   (`config.ts`). Mounted once in `AppShell`, so the shortcut does not depend on
   a sidebar being rendered.
2. Content, in Paseo's band order: **Actions** (New chat, New chat in this
   folder, Add folder, Settings, Keyboard shortcuts), then **Folders**
   (client-side match over `foldersStore`) and **Conversations** (server search,
   both engines). Rank as in adaptation 2.
3. One list implementation, `aria-activedescendant` listbox, no dependency.
4. The sidebar stops rendering `SearchResults`; section headers, scroll position
   and folder expansion survive a search.
5. Empty query = five most recent conversations per source + Actions, no network
   call. The highlighted row is always the first result.

**Ideas — better, robust, industry standard** (adopt or reject explicitly)

1. **Give the list real combobox semantics.** Input `role="combobox"`,
   `aria-expanded`, `aria-controls`, `aria-autocomplete="list"`; list
   `role="listbox"`; rows `role="option"` + `aria-selected`; the input owns
   `aria-activedescendant`, so focus never leaves it and typing never dies.
   Announce the result count in a polite live region ("12 results"). This is
   what ARIA APG specifies for a dialog combobox — it is a checklist item, not a
   taste call.
2. **Echo the query in the empty state.** "No matches for **xyz**" beats
   "No matches"; it confirms what was searched and is free.
3. **Separate "loading" from "empty".** A spinner only for the section that is
   actually pending (Paseo does exactly this for files), never a full-panel
   spinner that hides local results. A failed request shows an inline retry,
   not an empty list.
4. **Distinguish the four states in the test suite**: empty query (recents),
   results, no matches, request failed. All four are one-line fixtures.
5. **Never re-render the app behind the dialog.** The overlay is portalled and
   the palette state is its own store; a keystroke must not re-render
   `Sidebar`, the transcript or the composer. Measure with a render counter.
6. **Stable row identity, not index.** Results carry `kind + id`; the active id
   survives refetches (Paseo's `preserveActiveResultId`). Index-based selection
   is the classic palette bug.
7. **Show the destination in the subtitle**, not the source: `Direct · 2m ago`,
   `Code · project-name`, folder path for folders. Users disambiguate two
   similarly named chats by context, and it matches the sidebar rows (P14's
   engine identity can appear here for free).
8. **Cap and defer.** 5 per section on the empty query, 20 overall from the
   server; if a section exceeds ~8 rows, add "Show all" rather than scrolling a
   wall inside a 560px panel.
9. **Config-first strings and geometry.** `web/src/config/search.ts` holds every
   label, the per-section cap, the debounce and the key hints; the panel size
   lives with the shell geometry rules (§1b "Shell geometry has one source of
   truth") or as component constants with one owner — no copies.
10. **A visible shortcut hint** in the empty state footer (`↑↓ navigate · ↵ open
    · esc close`), and the palette's own row for "Keyboard shortcuts" so the
    hint is discoverable without it.
11. **Don't capture ⌘K while a text field owns the keystroke** for other
    bindings (e.g. ⌘K inside the composer should still open the palette —
    Paseo's toggle is global), but do not also bind bare `/`; shortcuts that
    fire while typing in a textarea are a common regression.
12. **Accessibility extras**: the panel is `role="dialog"` with
    `aria-modal="true"` and an accessible name; results are never colour-only
    (icons are `aria-hidden`, the name carries the meaning); the selected row is
    distinguishable in forced-colours mode (an outline, not just a fill).

**Acceptance**
- ⌘K (and Ctrl+K) opens the palette over the app; the shortcut is a toggle; the
  chrome magnifier opens the same surface. The sidebar, its sections and its
  expanded folders remain mounted and unchanged behind it.
- The panel measures 640×560 at ≥900px width (92%/80% below), sits 48px from the
  top, has radius 8 and a 1px border; header padding is 16/12.
- Typing filters after the existing debounce; ↑/↓ move and wrap; Enter opens the
  highlighted result and closes; Esc closes; focus returns to the trigger (or
  the composer when the trigger is gone).
- Folders and Actions are present; the empty query shows recents + actions and
  fires **no** request; results cover both engines and open Code conversations
  in Code mode.
- Ranking puts a title-prefix match above a body match regardless of
  `updated_at`; a stale response cannot overwrite a newer query's results.
- ARIA: combobox/listbox/option roles with `aria-activedescendant`,
  `aria-selected`, and a count announcement (asserted in a DOM test).
- A test that fails today: assert the sidebar section headers stay mounted while
  the palette is open (today they are removed), and that ⌘K opens a `dialog`.

---

## Decisions already made (keep, or reverse deliberately)

- `Set color` uses US spelling; the mockup writes `Set colour`.
- `Delete…` in the menu opens a confirmation; the confirm action is `Delete`.
- `Open folder in Explorer` moves to the local backend (P4): the browser and
  desktop builds use one code path, and the Tauri opener plugin is retired. The
  only sub-choice left is a ~15-line Bun spawn (recommended) versus the `open`
  package; both were studied, neither is implemented yet.
- The context menu's submenu indicator is now the same `ChevronRight` icon as the
  dropdown's (was a text `▸`).
- P9 styling is **sidebar-scoped** (shared class through `menu-kit`), not a
  restyle of the vendored `dropdown-menu`/`context-menu` primitives, which every
  menu in the app imports. A global restyle would be a separate decision.
- The reloads in `running-indicator.spec.ts`, `phase-8-tabs-navigation.spec.ts`
  and `phase-ua-d.spec.ts` (P10) are workarounds that encode today's defect.
  When P10 is fixed they change to assert the live behavior; they are not a
  settled contract.
- **The active-row fill in the mockup is not a target** (P11). It measures ~1.8%
  ΔL in the light theme; the implemented design exceeds the mockup with a
  stronger token plus a 2px tick, and the mockup is corrected to match rather
  than the code regressing to match it.
- **Label alignment deviates from the mockup's leading tile** (P12). The mockup
  indents folder names behind an 18px tile and renders the run dot only on the
  active row; one shared left edge and a reserved dot slot are the requested
  outcome. Option A (trailing tile/dot) versus Option B (leading slot on every
  row, chats gain the engine icon) is **still open** — this is the one new item
  that needs a product pick.
- **Coloured engine icons are identity marks, not menu chrome** (P14). Menu
  glyphs stay muted per P9; coloured glyphs appear on the engine controls, the
  scope chip and (if Option B) sidebar rows.
- **Search becomes a popout over the app** (P15); the sidebar no longer swaps
  its sections for a result list. Built on the existing Radix Dialog primitive,
  **no new dependency** (`cmdk` rejected on 2026-10-31 — see P15 adaptation 5;
  revisit only with a `docs/decisions.md` entry first). Two deviations from
  Paseo are decided, not accidental: the selected row uses the stronger P11
  token rather than Paseo's ~2% `surface1` fill, and results are ranked
  client-side because the TBAi search endpoint is still unranked.
- **⌘K belongs to the palette, not the sidebar chrome** (P15). The inline chrome
  input and `SearchResults` are removed in the same change, so there is exactly
  one search surface; the magnifier button opens the palette.

---

## P16 · [ ] Unread indicator ("replied but unseen" state)

**Symptom (reported):** When an assistant reply settles, the green dot disappears immediately. A conversation that received an answer while the user was away looks identical to one read hours ago; there is no visual clue that a reply arrived.

**Evidence — today**
- `web/src/components/ui/thread-running-dot.tsx:66` returns `null` the instant `isRunning` becomes false. Generation activity is tracked, but unseen replies are completely untracked.
- SQLite `conversations` table lacks a `last_read_at` timestamp.
- When `ThreadRunningDot` toggles on and off, the row title shifts 12px horizontally because the 6px dot slot is unreserved when idle (`P12` defect).

**Architecture & Library Alignment (Paseo parity + Tailwind v4 + shadcn/ui):**
- **Zero Hacks / Library First**: Use our existing official stack (`@assistant-ui/react`, Tailwind v4 tokens, Radix UI primitives, `bun:sqlite` with Hono). No hand-rolled timeouts or transient browser-only illusions.
- **Reserved 6px geometry**: Permanently reserve the 6px dot container on every row (matching Paseo's `reserveIdleStatusIndicatorSpace = true`). Starting or finishing a run never causes title reflow.
- **Four clean visual states**:
  1. `running`: Pulsing green dot (`bg-success animate-pulse`).
  2. `unseen`: Static accent dot (`bg-primary`). Font weight stays normal so row geometry is stable.
  3. `seen / idle`: Clean row, empty slot, muted relative timestamp.
  4. `open + running`: Pulsing green dot inside active row styling (P11).
  *(Pending tool approval / confirmation remains a distinct amber icon and never mixes with unread).*
- **Strict "Seen" rule**: Marked seen only when conversation tab is active, window has focus, and the newest reply is viewed.
- **Folder & Command Center Rollup**:
  - Folders show the static dot next to conversation count if any child chat is unseen.
  - The Command Center (P15 popout) reflects the same 4-state indicator in its leading item slot.
- **Persistence**: Backed by `conversations.last_read_at INTEGER` in SQLite, updated via `POST /api/conversations/:id/read`. Survives reloads and app restarts.

---

## P17 · [x] Folder letter tile (Option A) & context menu alignment

**Status:** Completed and verified (2026-10-31).

**Symptom (requested):** Folder name display and letter tile should follow Option A from the reference HTML (`D:/Temp/tbai-left-side/index.html`), folder names should be capitalized, and context menus should match the reference HTML's compact, refined styling without Linux-specific overhead.

**Target behavior (Option A + reference HTML alignment):**
1. **Option A solid letter tile**:
   - 18px × 18px square with 5px radius (`round(size * 0.25)`).
   - Solid background using the folder's assigned color (`--folder-tile-bg`).
   - High-contrast letter (`#ffffff` or `#111827`) computed via WCAG relative luminance.
2. **Capitalized folder name**:
   - Display label is capitalized (`Ai-chat-app` / `capitalize`) for consistent typography.
3. **Platform scope**:
   - Windows desktop (Tauri/Webview) and modern browser target. No Linux-specific branching or update files.
4. **Context & Dropdown Menu alignment (`.ctx-menu`)**:
   - Container: `rounded-[10px] p-1 border border-border bg-popover shadow-xl shadow-black/20`.
   - Items: Compact `h-7 px-2 text-xs (12.5px)` with `size-3.5` icons and `rounded-[6px]`.
   - Separators: Subtle hairline `my-1 mx-1.5 h-px bg-border/60`.
   - Visual unification: Right-click (`ContextMenu`) and `⋯` button (`DropdownMenu`) share identical geometry and items via `menu-actions.tsx`.

---

## P18 · [x] OpenCode live AI reply: live model details and timestamps without page refresh

**Status:** Completed and verified (2026-10-31).

**Symptom (reported):** In OpenCode Code mode, when the AI generates a reply, the footer below the message does not show model details, duration, or timestamps live; they only appear after manually refreshing the page.

**Evidence — root cause**
- In Direct chat, `metadata.custom` (`modelId`, `providerId`, `turnTiming`, `turnStartedAt`) is attached during streaming by the chat transport.
- In OpenCode Code mode, `ChatWindow.tsx:678-734` (`TurnRecordFooter`) reads `custom.modelId`, `custom.providerId`, and `custom.turnTiming` from message metadata.
- In `v2MessageProjection.ts:325-345`, these fields are populated by `assistantTurnFields(source)`.
- However, during live streaming in `v2Events.ts:278`, newly created live assistant messages have `source: null`. OpenCode SSE events stream parts (`session.text.delta`, `session.step.started`, etc.), but `message.source` is only populated from the full session history snapshot (`v2History.ts:208`), which runs on initial load / page refresh!
- `session.step.started` event data already contains `{ agent, model: { providerID, id }, started }`.
- `session.step.ended` event data already contains `{ tokens, cost }`.

**Target behavior (Zero-refresh live footer):**
1. **Populate turn metadata on live events**: When `session.step.started` arrives in `v2Events.ts`, update `message.source` (or synthetic live turn fields) on the assistant message state with `agent`, `model: { providerID, id }`, and `started` timestamp.
2. **Live duration and clock**: `TurnRecordFooter` will immediately receive `modelId`, `providerId`, and `turnStartedAt`, allowing the live duration clock and model badge to render dynamically while streaming without requiring a page refresh.
3. **Finalize on step ended**: When `session.step.ended` arrives, record `completed` and `tokens` so the final duration and token usage settle seamlessly.

---

## P19 · [x] Main chat breadcrumb root icon & sidebar row alignment

**Status:** Completed and verified (2026-10-31).

**Symptom (reported):**
1. In the main chat root header (`ChatHeader.tsx`), the breadcrumb root currently displays plain text with an arrow (`{rootName} > {title}`) with no leading icon.
2. In the sidebar rows (`FolderHeader`, `SidebarThreadRow`, `FolderConversationRow`), text alignment is inconsistent (some middle-aligned, inconsistent padding or baseline).

**Target behavior & Implemented Fix:**
1. In `ChatHeader.tsx`, added a leading icon before `{rootName}` inside the breadcrumb button:
   - For a Project folder (`rootHref.startsWith("/folders")`): `Folder` icon styled with `size-3.5 text-primary/80`.
   - For Temporary/Direct workspace: `Layers` icon styled with `size-3.5 text-muted-foreground/70`.
2. Fixed text alignment across sidebar rows:
   - In `FolderHeader.tsx`, ensured `text-left` is explicit on the button and title text with `cursor-pointer`.
   - In `SidebarThreadRow.tsx`, ensured consistent `text-left` on button and title span.
   - In `FolderConversationRow.tsx`, aligned padding to `pl-2` matching row tokens so no horizontal wobble or middle alignment occurs.

---

## P20 · [x] Folder & chat context menu parity with mockup

**Status:** Completed and verified (2026-10-31).

**Symptom (reported):**
1. Context menu options for folders and chat rows should strictly match mockup `D:/Temp/tbai-left-side/index.html` lines 1260–1315.
2. Specifically ensure "Open folder in Explorer", "Set color" (with palette), "New chat in this folder", "Rename...", "Manage links...", "Copy folder path", and "Remove from workspace" are present, fully functional, and trigger reliably on right-click anywhere on the folder row.
3. Chat row menu: "Open in new tab", "Rename...", "Copy chat ID", "Copy URL", "Archive", "Delete...".

**Target behavior & Implemented Fix:**
1. Verified `FolderHeader.tsx` wires `buildFolderMenuEntries` identically for both `ContextMenu` and `DropdownMenu`, with `canOpenInExplorer: true` calling `/api/folders/:id/reveal`.
2. All mockup items are present in identical order across right-click (`ContextMenu`) and kebab (`DropdownMenu`).
3. Color submenu in `menu-kit.tsx` renders the full 12-swatch grid plus default swatch with WCAG-compliant contrast tiles.

---

## Evidence appendix

- Menu geometry run: `C:/Users/RTPC/AppData/Local/Temp/tbai-menu-geom.mjs`
  (private server on 3110, 1440×900). Screenshots:
  `40-folder-more-geom.png`, `41-folder-context-geom.png`,
  `42-chat-more-geom.png`, `43-chat-context-geom.png` in
  `C:/Users/RTPC/AppData/Local/Temp/tbai-walk/`.
- Menu parity run: `tbai-menu-walk.mjs`, screenshots `30`–`34`, `sameFolder: true`,
  `sameChat: true`.
- Verified read-only: folder sort order/columns, dnd-kit usage, Tauri opener
  wiring, no backend reveal endpoint, thread URL helpers, composer alert call
  site.
- Verified read-only for P10–P15 (2026-10-31): message persistence path
  (`threadHistoryAdapter.ts` → `POST /messages`) for both user and assistant
  messages; sidebar fetch triggers and `refetch` callers; header/tab title
  sources; sidebar tokens and `sidebar-row-surface`; folder/chat/running-dot
  geometry; `EnginePicker`, `WelcomeScopePicker` and `config/welcome.ts`; sidebar
  search (`LeftEdgeChrome`, `SearchResults`, `Sidebar`, `config/sidebar.ts`); no
  engine/provider icon component; no `cmdk`; `radix-ui` 1.8.1 present.
- Paseo sources (read-only, 2026-10-31): public pages — `paseo.sh/docs`
  (install only), `paseo.sh/docs/plugins` ("Command Center items", opens via
  ⌘K/Ctrl+K), `paseo.sh/plugins/all` ("command center (⌘K)"), `paseo.sh/changelog`
  ("Added sidebar grouping to the Command Center"). **Layout, tokens and
  behaviour come from the open-source tree** (`github.com/getpaseo/paseo`):
  `packages/app/src/command-center/{command-center.tsx,list-metrics.ts,results.ts,interaction.ts,root.tsx}`,
  `packages/app/src/keyboard/keyboard-shortcuts.ts`,
  `packages/app/src/i18n/resources/en.ts`, `packages/app/src/theme.ts`,
  `packages/app/e2e/browser/command-center-grouping.spec.ts`. Local copies:
  `C:/Users/RTPC/AppData/Local/Temp/paseo-study/` (14 files, downloaded via the
  GitHub API; not in the repository).
- Mockup geometry quoted in P11/P12/P15 is from
  `D:/Temp/tbai-left-side/index.html` (`:166-167`, `:434-440`, `:510-523`,
  `:907`, `:1168`).
