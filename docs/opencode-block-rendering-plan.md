# Code-mode block rendering + rich tool UIs — plan

Status: **Implementation complete. Automated verification complete. Live
verification partial — the permission/question blocker is fixed and live-verified;
a completed `edit` diff and `read` body remain unverified.**

- **IMPLEMENTED:** Phases 2, 3A, 3B, 3C and 4 are written and wired (see §3–§5).
- **AUTOMATED VERIFIED:** the unit/render suites pass under the established 30s
  timeout — **706 pass / 2 skip / 0 fail** (exact count and command in §7). The
  default 5s full-suite run is flaky because of process-spawning tests — a timeout
  budget problem, **not** a defect. The phases are therefore verified by
  automated tests, not claimed "fully gated" against live behavior.
- **LIVE VERIFIED:** a completed `bash` tool call renders correctly as its own
  terminal block (`echo handover-probe-ok`, green `✓ exit 0` badge, output, no
  console errors) — see §6.4. The model `opencode/union-alpha` ("Union Alpha
  Free") was confirmed working for *generation* in a live conversation (it emits
  `write` tool calls) — see §6.
- **LIVE VERIFIED — permissions & questions (2026-09-17).** The wedge is fixed
  **in TBAi code** and proven live. OpenCode's permission and question stores are
  **directory-scoped**, so the V1-shaped adapter's unscoped calls answered `[]` /
  404 — that, not a server defect, is why a `write`/`edit` sat at `running`. The
  compatibility layer (`opencodeScope.ts`, `permissionCompat.ts`,
  `questionCompat.ts`, `initialHydration.ts`, `stalePermissions.ts`, composed in
  `runtimeClient.ts`) now supplies the session's directory. Measured live on the
  managed 1.18.31 server, and through the real UI:
  - `GET /permission?directory=<dir>` returns the real request (unscoped: `[]`).
  - `POST /permission/<id>/reply?directory=<dir>` `{"reply":"once"}` → **200
    `true`**, tool `running → completed`.
  - `POST /permission/<id>/reply?directory=<dir>` `{"reply":"reject"}` → **200
    `true`**, tool `running → error` (not stuck).
  - `POST /question/<id>/reply?directory=<dir>` `{"answers":[["TypeScript"]]}` →
    **200 `true`**, question `completed`.
  - Driven via the UI (Playwright, network captured): a permission raised with
    **no page open** surfaced after load (initial hydration) and both Approve and
    Deny resolved on the directory-scoped route, with no unscoped reply and no
    fallback call.
- **LIVE BLOCKED (do not claim fixed):** a completed `edit` **diff** and a
  completed `read` body have NOT been observed live. This is now a
  **verification** gap (the run to capture it is in flight), no longer the
  environment blocker it was — see §6.5.

The compatibility layer that underpins all of this — `@assistant-ui/react-opencode@0.2.23`
(frontend: OpenCode v2 SSE/parts ⇄ assistant-ui `ExternalStoreRuntime`) plus
`@assistant-ui/ai-sdk`'s `AISDKToolkit` (backend: our tools ⇄ AI SDK v7
`ai@7.0.93`) — has been studied from installed source and the official docs and
is documented in §9. The part/permission/diff projection contract there is what
the rendering code speaks.

Scope: the reported rendering defects in Code mode —
"tools permission in nested block and other block are also in one big block and
then sub blocks not as separate blocks", and the absence of rich tool rendering
("code block, terminal output, diff, tool calling").

Constraint carried from the request: **assistant-ui + AI SDK v7 + Tailwind +
shadcn/radix only, minimum custom code.** No library fork, no new dependency, no
backend change.

---

## 1. What is actually wrong (verified against installed source, not assumed)

### 1.1 One wrapper bubble around every part

`ChatWindow.tsx:256` wraps the whole `GroupedParts` tree in a single
`<div className="max-w-[85%] space-y-2 rounded-xl bg-muted px-3.5 py-2.5 text-sm">`.
Every block — reasoning, tool groups, text — is a child of that one surface, so
there is no way for a sub-block to read as its own block. This is the
"one big block" complaint.

### 1.2 Tools are nested *inside* the chain-of-thought block

`ChatWindow.tsx:180-184`:

```ts
const groupedBy = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
  "standalone-tool-call": [],
});
```

`groupPartByType` coalesces **adjacent parts sharing a path prefix** into a
nested tree (`groupParts.d.ts:15-24`). Because `"tool-call"` carries the
`group-chainOfThought` prefix, every tool group is rendered as a *child* of the
`group-chainOfThought` node (`ChatWindow.tsx:260-261` renders that node as a
plain `<div className="my-2">`). That is literally "tools in a nested block".

### 1.3 `standalone-tool-call` never matches in Code mode

The map already contains the correct official entry (`"standalone-tool-call": []`
— an empty path means *ungrouped*, i.e. rendered outside the grouping). It never
fires, for two independent reasons:

1. The registry-driven cases are resolved from `GroupByContext.toolUIs`
   (`groupParts.d.ts:37-45`). `OpenCodeView.tsx:218` mounts
   `<AssistantRuntimeProvider runtime={runtime}>` with **no `config`**, so no
   toolkit is registered and `toolUIs` is empty.
2. `part.toolUI` is therefore always `undefined` (`ChatWindow.tsx:296`), so every
   Code-mode tool call falls through to `ToolFallback` — 763 lines that render a
   name, args, and raw result. No terminal, no diff, no syntax highlighting.

### 1.4 The synthetic `indicator` part is silently dropped

`MessagePrimitive.GroupedParts` emits a trailing `{ type: "indicator" }` while
the message is running (default mode `"no-text"`, `MessageGroupedParts.d.ts:42-53`).
`ChatWindow.tsx:303-304` has no `case "indicator"` and returns `null`, so the
official streaming affordance is thrown away.

### 1.5 `GroupPart.counts` is unused

A group node carries per-status tallies —
`{ running, complete, incomplete, requiresAction }`
(`MessageGroupedParts.d.ts:8-14`). `ChatWindow.tsx:274` derives status from
`part.status.type === "running"` and size from `part.indices.length`, so a group
of five tools where one is still running looks identical to one where all five
are done, and a group containing a `requires-action` tool (a pending permission)
is not distinguishable from a settled one.

---

## 2. The official mechanisms used (no custom machinery)

| Need | Official mechanism | Evidence |
|---|---|---|
| Separate top-level blocks | `MessagePrimitive.GroupedParts` + `groupPartByType` paths | `MessageGroupedParts.d.ts:70-122` |
| Tools outside the trace | `"standalone-tool-call": []` | `groupParts.d.ts:37-45` |
| Per-tool rich UI | toolkit entry `render` | `toolbox.d.ts` (`ToolDefinition` = `WithRender<Tool,…>`) |
| Keep an approval card visible | toolkit entry `display: "standalone"` | `toolbox.d.ts:8-12`, `tools.d.ts:17-18` |
| Streaming affordance | `indicator` part | `MessageGroupedParts.d.ts:29-53` |
| Accurate group status | `GroupPart.counts` | `MessageGroupedParts.d.ts:8-14` |

Precedent in-repo: `web/src/tools/toolkit.ts` already sets
`display: "standalone"` on every approval-gated native tool. Direct mode is
correct; **Code mode simply registers nothing.**

---

## 3. Phase 2 — block structure (shared by both modes)

1. **Flatten the group tree.** Drop the `group-chainOfThought` prefix so a tool
   group is a *sibling* of a reasoning block instead of its child. Consecutive
   tool calls still coalesce into one `group-tool` (adjacent-prefix rule), so the
   "N tool calls" collapsible is preserved.
2. **One surface per block.** Remove the single assistant bubble; the message
   becomes a column in which each top-level node owns its own surface. Text
   renders as bare Markdown (the assistant-ui default), reasoning keeps its own
   panel, the tool group keeps `ToolGroupRoot variant="outline"`, and a
   standalone tool call renders its own surface.
3. **Status from `counts`**, not from `indices.length` + one `status.type` — so
   a group with a pending approval is visibly *not* settled.
4. **Handle `indicator`** with a trailing affordance instead of returning `null`.

Intended consequence: this changes the assistant message's look in **Direct mode
too**. `ChatWindow` is deliberately shared by both surfaces, and the single-bubble
layout is equally wrong for Direct tool calls, so the two are changed together
rather than forked. Reversible in one commit.

Explicitly *not* changed in Phase 2: user bubbles, the action bar / provenance
chips row, error rendering, `MessagePrimitive.Root`, the composer.

## 4. Phase 3 — Code-mode tool registry

Register renderers for OpenCode's **own** tool names on the client registry, so
`part.toolUI` resolves instead of every Code tool call falling through to
`ToolFallback`. The model-facing contract is unaffected: the server
(`src/tools/index.ts` → `AISDKToolkit`) remains the single authority for what
the model may call, and these entries are `type: "backend"` render-only.

**Ordering is load-bearing — do not reorder.** Phase 3A (stale-permission guard
parity) MUST land before 3B (argument/result normalization) and 3C (the
`bash`/`edit`/`write` + other rich mappings). The reason is concrete: `bash`,
`edit` and `write` are exactly the tools that hit the stale-permission wedge, so
mapping them onto a rich UI *before* `ApprovalGate` carried the shared guard would
reintroduce it. Gated tools must therefore never bypass the shared
stale-permission guard — see §4.4.3 for the parity test that locks this in.

**Correction to this plan's first draft.** The original table below was written
from memory and was wrong in two ways, both caught by asking the running server
instead of assuming:

- **There is no `list` tool.** `GET /experimental/tool/ids` returns
  `invalid, question, bash, read, glob, grep, edit, write, task, webfetch,
  todowrite, websearch, skill, apply_patch`. A `list` mapping would have been
  dead code.
- **`apply_patch` and `skill` were never listed**, and `question` / `invalid`
  exist too.

Per-tool argument schemas come from
`GET /experimental/tool?provider=<p>&model=<m>` — the server's own JSON Schema
per tool. That is the authority for every field name in
`web/src/tools/opencode/adapt.ts`:

| OpenCode tool | OpenCode args | gated? | mapped in |
|---|---|---|---|
| `read` | `filePath`, `offset?`, `limit?` | no | Phase 3B |
| `glob` | `pattern`, `path?` | no | Phase 3B |
| `grep` | `pattern`, `path?`, `include?` | no | Phase 3B |
| `bash` | `command`, `timeout?`, `workdir?` | **yes** | Phase 3C |
| `edit` | `filePath`, `oldString`, `newString`, `replaceAll` | **yes** | Phase 3C |
| `write` | `content`, `filePath` | **yes** | Phase 3C |
| `todowrite` | `todos` | no | **IMPLEMENTED** — `OpenCodeTodoWriteToolUI` |
| `task` | `description`, `prompt`, `subagent_type`, `task_id?`, `command?` | no | **IMPLEMENTED** — `OpenCodeTaskToolUI` |
| `webfetch` | `url`, `format?`, `timeout?` | no | **IMPLEMENTED** — `OpenCodeWebFetchToolUI` |
| `websearch` | `query`, `numResults?`, `type?`, `livecrawl?`, `contextMaxCharacters?` | no | **IMPLEMENTED** — official `WebSearch` element (see §4.0.2) |
| `skill` | `name` | no | **IMPLEMENTED** — `OpenCodeSkillToolUI` |
| `question` | `questions` | no | **IMPLEMENTED** — `OpenCodeQuestionToolUI` (also fixes the crash below) |
| `apply_patch` | *(no schema returned by `/experimental/tool`)* | unknown | keep `ToolFallback` — **BLOCKED**: cannot be mapped faithfully without its real args |
| `invalid` | `error`, `tool` | no | keep `ToolFallback` — internal |

Unmapped tools keep `ToolFallback`, so nothing regresses to a blank block.

**Correction to the rows above.** `apply_patch` and `question` both appear in
`GET /experimental/tool/ids` but **neither** returns a schema from
`GET /experimental/tool?provider=…&model=…` (12 tools do; these two do not). The
`question` args are therefore taken from the SDK's own `QuestionInfo` type and
from what the question surface already reads (`questions`), not from that
endpoint. `apply_patch` has no such corroborating source, so it stays unmapped
rather than guessed — the original instruction ("Do NOT invent mappings") applies.

### 4.0.1 The `question` tool form architecture (Phase B2)

OpenCode questions are **form interactions**, distinct from permissions/approvals.
Key architecture invariants (Phase B2):

- **Data Model:** Preserves complete `OpenCodeQuestionRequest` state (`id`, `directory`, `sessionID`, `questions[]`, tool metadata).
- **Form UI:** Interactive form component (`QuestionCard`) replacing approval-shaped buttons. Reuses form primitives (radios for single-choice, checkboxes for multi-choice, freeform custom input, and step-by-step navigation for multi-question requests).
- **Tool Linking:** Tool call ID (`request.tool.callID`) is contextual metadata for inline presentation on that tool card. Answer identity remains `requestID` + `directory`.
- **Response Path:** Answers submit via `replyToQuestion(requestID, answers)` where `answers` is a positional `string[][]` matching `questions[]`. Rejections submit via `rejectQuestion(requestID)`.
- **Separation:** Questions never touch `respondToApproval()`, `permission.reply()`, `ApprovalGate`, or `ToolFallback`'s `addResult()`.
- `BackendToolView` gained a `status.type === "requires-action" && !approval`
  branch rendering `argPreview`. Without it the card fell to the final spinner,
  which reads as "still working" for something actually blocked on a person. The
  branch cannot fire for a native tool: a gated native part always has an
  `approval`, which returns earlier.

### 4.0.2 `websearch` — official assistant-ui element, on a PROVEN payload

**The probe (2026-09-19, managed 1.18.31, three real calls).** `websearch` was
run for real and the part read back through
`GET /session/{id}/message?directory=…`. The payload is **structured JSON in a
STRING** — case A, not plain text:

```
state.output  (string, JSON-encoded):
  { "search_id": "search_fcc8c055…",
    "results": [ { "url":  "https://sematext.com/blog/node-js-logging",
                   "title": "Node.js Logging Tutorial: Best Practices & How-to",
                   "publish_date": "2025-03-19" | null,
                   "excerpts": [ "…" ] }, … ] }

state.metadata: { "provider": "parallel", "truncated": false }   ← NO hits
```

Verified across 3 payloads: 10 hits each, `excerpts` always present,
`publish_date` sometimes `null`. So hits are in **`output`**, not `metadata` —
and `metadata` holds only provider bookkeeping.

**Element used:** the official `WebSearch` from
`@assistant-ui/elements-web-search`, vendored by hand to
`web/src/components/assistant-ui/elements/web-search.tsx` (no `components.json`,
no npm dependency; its `../utils/range` dependency was already vendored).
Contract: `query`, `results: readonly {title, domain}[]`, `visibleResults`,
`searching`, `cycle`.

**Mapping** (`parseOpenCodeWebSearchHits`, `tools/opencode/adapt.ts`):

| OpenCode field | Element field | Note |
|---|---|---|
| `args.query` | `query` | verbatim |
| `results[].title` | `title` | verbatim |
| `results[].url` | `domain` | **hostname**, leading `www.` stripped |
| — | `searching` | `status.type === "running"` |
| — | `visibleResults` | hit count |
| — | `cycle` | `0` |

Only fields the payload has are used. A hit with no usable `title`/`url` is
**dropped**, never given a placeholder — the element's avatar and domain label
would otherwise show invented text.

**Fallback.** Plain text, an unparseable payload, or `null` → `results: []`, so
the element renders its query and status with no rows, and the existing
`TextBody` shows the raw result. Nothing is discarded: the element displays only
`title` + `domain`, while the payload also carries `url` and `excerpts`, so the
raw result stays visible beneath the element in **both** branches.

**Fields intentionally not displayed by the element:** `publish_date`,
`excerpts` (snippets), `search_id`, `metadata.provider`, `metadata.truncated`.
All remain visible through the raw-text fallback.

**One deliberate deviation from upstream:** the status line upstream reads the
literal `Read 3 sources`. A fixed "3" beside a real list states a false number,
and upstream's own docs invite editing it, so it now derives from
`results.length`. No prop, field or style was added.

**Not claimed:** no structured-search support is asserted for any *other* tool,
and no URL/snippet/ranking/avatar was added to the element.

#### 4.0.2.1 Card ownership — the bug that made the element dead code

The first version guarded the element branch with `const gated = p.approval !=
null`. **That is wrong for this deployment.** Nearly every tool is gated here
(the catch-all `{"permission":"*","action":"ask"}` rule), so `approval` stays
non-null for the *entire* lifecycle — pending, approved, running, complete. The
element branch therefore never ran, and every search fell through to the old
`websearch · <query>` card showing raw JSON. Observed live before the fix.

The gate owns the card only while the decision is **pending**. Four conditions
mirror `BackendToolView`'s own branches so no state it handles is lost:

| Condition | Mirrors |
|---|---|
| `gateUndecided` = `approval != null && approval.approved === undefined` | its gate branch (awaiting an answer, or the request is gone) |
| `awaitingContinuation` = `approved === true && result === undefined && status.type !== "running"` | its "Approved — will execute with your next message" row |
| `failed` = `status.type === "incomplete"` | its cancelled/failed row |
| `denied` = `denialOf(result, approval) != null` | its Denied row, via the **shared** exported rule |

Only when none holds does the element render. `failureOf` is **not** exported, so
no local copy was made — `status.type === "incomplete"` covers the failure path
for this tool, and a string result cannot carry the `error` field it inspects.

#### 4.0.2.2 Streaming query

`args.query` is a **partial parse** while the model is still writing the tool
call, so the pill could show a half-written query. The renderer now reads
`useToolArgsStatus<{ query: string }>()` — verified present in the installed
`@assistant-ui/react@0.15.20` (declared in
`@assistant-ui/core/…/useToolArgsStatus.d.ts`) — and holds the placeholder
`"Searching…"` while `propStatus.query === "streaming"`.

Two details that matter: `propStatus` is a **`Partial`**, so `undefined` is the
ordinary "already complete" case and only an explicit `"streaming"` may hold the
placeholder; and the hook **throws outside a tool-call message part**, so it is
called unconditionally at the top to keep hook order stable.

#### 4.0.2.3 Status

- `permissionPayloadCompat`-style claim discipline applies here too: **the
  element path is LIVE VERIFIED**, not merely implemented.
- **LIVE VERIFIED 2026-09-19** — observed in the running UI on a real gated
  `websearch` call (query *"AI chat app python tutorial 2026"*): the card
  rendered the query pill, the status line `Read 10 sources`, and 10 result rows
  with domain-lettered avatars (`L L R T L A D T G R`), titles and domains — then
  the raw result beneath, as designed. This is the exact path
  `OpenCodeWebSearchToolUI → parseOpenCodeWebSearchHits → <WebSearch>`, so the
  card-ownership fix is confirmed in the browser and not just in typecheck.
- The status line reading **10** (not upstream's literal `3`) confirms the one
  deliberate deviation is in effect.
- Unit coverage for the mapping/fallback/state rows (T3-O24…T3-O32) remains
  **handed to the test agent** — a visual pass is not a substitute for those.

### 4.1 Blocking finding — the existing UIs read OUR field names

The rich UIs are written against our own native tool schemas, not OpenCode's:

- `ReadFileToolUI` reads `p.args.path` and `(r as any).content`
  (`web/src/tools/filesystem/ui.tsx:625-638`).
- OpenCode's `read` uses `filePath`.

The pinned runtime passes OpenCode's `state.input` through **verbatim** as
`part.args` (`openCodeMessageProjection.js`: `args = state.input`), so a direct
name-for-name mapping renders an empty title and an empty body — worse than
`ToolFallback`, which at least shows the raw JSON.

**Resolved** by `web/src/tools/opencode/adapt.ts`: an explicit, documented alias
table (`filePath → path`, `oldString → oldText`, `newString → newText`,
`pattern → query`, `workdir → cwd`) plus a result shim. Aliases are *added*
alongside OpenCode's original field, so a wrong mapping shows up as a redundant
field rather than as missing data.

**Result shape — corrected.** A completed part's `state` was observed live
(a real `bash` completion via `POST /session/{id}/shell`, which needs no model):

```
{ status: "completed", input: {...}, output: <string>, title: <string>,
  metadata: { output: <string> }, time: { start, end } }
```

`output` is a plain **string**, and the runtime maps `result: state.output`, so
`part.result` is that string. Note `@opencode/schema@2.0.4` (installed)
describes a *newer* shape with no `output` at all; reading it first produced a
wrong "the result never arrives" conclusion. The running server is 1.18.31 —
**verify against the running server, not the installed schema package.**

**Reuse boundary.** The `*ToolUI` exports are ~15-line wrappers that hardcode
the title, the arg shape *and* the result shape. For an OpenCode tool all three
differ, so adapting one means overriding exactly what it hardcodes. The honest
reuse boundary is `BackendToolView` — the shared shell that owns the card, the
approval gate, collapsed decision rows and status handling. `tools/opencode/ui.tsx`
builds on that, adding no new card machinery.

### 4.2 Blocking finding — the stale-permission guard would be bypassed

Phase 1's guard lives in `tool-fallback.tsx` (`ToolFallbackApproval`). A
permission-gated tool routed to a rich UI goes through `BackendToolView` →
`ApprovalGate` (`web/src/tools/filesystem/ui.tsx:81`), which had its **own**
submit path and **no** stale guard. Routing `bash` / `edit` / `write` there
without parity would reintroduce exactly the wedge the user hit — on the very
tools that hit it.

**Resolved in Phase 3A.** Both surfaces now consume one shared guard
(`useStaleApprovalGuard` in `stores/stalePermissionsStore.ts`), and
`ApprovalGate` has exactly one call site (`ui.tsx:485`), so every rich UI and
the terminal adapter inherit it. Guarded by:
- `stores/stalePermissionsStore.test.ts` — the pure rule, plus scoped parity
  assertions that both surfaces apply the guard and neither re-implements it.
- `components/assistant-ui/elements/tool-fallback.test.ts` — the *ordering*
  contract (bail-out precedes the controls; the gone-signal is checked before
  the retryable path).
- Both were mutation-checked: disabling the guard fails them, and a comment
  naming the forbidden tokens does not satisfy them.

Also noted, not blocking: `ApprovalGate`'s outside-workspace pre-check posts to
`/api/tools/check` with a conversation id (`:110-125`). For an OpenCode
conversation that lookup may not resolve; the code already treats failure as
non-blocking ("worst case the warning is absent"), so the gate still works.

### 4.3 Blocking finding — Code mode never mounted the tool registry

The real reason Code mode showed **no** rich tool UI, independent of argument
names. `AuiConfig` is scoped to the provider it is passed to, and
`OpenCodeView` mounts its **own** `AssistantRuntimeProvider`:

```tsx
<AssistantRuntimeProvider runtime={runtime}>   // no config
```

The registry that `part.toolUI` reads is `s.tools.toolUIs`, which lives in that
scope. With no config there, it is empty — so *every* Code tool part fell
through to `ChatWindow`'s generic `ToolFallback`, however well the toolkit was
populated. Adding the OpenCode renderers alone changed nothing; the browser
still showed `Used tool: read`.

**Resolved** by giving the Code view the same registry the chat view uses:

```tsx
const config = useMemo(() => AuiConfig({ tools: Tools({ toolkit: appToolkit }) }), []);
```

Reusing the official `Tools` resource is safe here even though it also
registers entries with model context: the OpenCode runtime never reads model
context (verified — no `modelContext` reference in the package; it builds
prompts server-side from OpenCode's own tool list), so only the renderer half
takes effect.

Browser-verified after the fix, on the real part
(`ses_f54ae8edeffe5KwBUMIf2Wi32p`, `read` with `filePath: "D:\Temp\ai-chat-app"`):
the card renders **`read · D:\Temp\ai-chat-app`** with the `Reading…` state, as
its own block, with no console errors.

**Not verified live:** the result *body*. Every tool part in this project's
history is still `running` (41 sessions, 4 tool parts, 0 completed), and a fresh
run cannot complete because the configured provider reports
`credit insufficient balance: balance=0`. The body is therefore covered by a
real render of the component with real OpenCode-shaped data
(`tools/opencode/ui.test.ts`), not by a live conversation.

## 4.4 Phase 3C — the permission-gated tools (`bash`, `edit`, `write`)

Phase 3A landed first because it is the precondition: these three tools are the
ones that hit the wedge, so mapping them onto a rich UI before `ApprovalGate`
carried the stale-permission guard would have reintroduced it.

**Which tools are gated was read from the server, not assumed.** `GET /agent` on
the live OpenCode server returns a *flat rule list* per agent, not a per-tool
map. Across all 7 agents there is a catch-all `* → ask` rule, so in this
deployment effectively every tool is permission-gated — `read` is additionally
gated for `.env` patterns, and `edit` is explicitly gated. Consequence: the
3B-mapped `read`/`glob`/`grep` already flow through the guarded `ApprovalGate`,
and `bash`/`edit`/`write` inherit the same single lifecycle rather than a new one.

### 4.4.1 `bash` could not reuse `RunCommandTerminalUI` — two mismatches

1. **Title.** `RunCommandTerminalUI` hardcodes `title="run_command"`. Rendering
   OpenCode's `bash` through it would mislabel the tool. `TerminalBlock` and
   `resultToLines` are shared modules, so the `bash` view composes the official
   terminal block directly with a correct `bash · <command>` title, and falls
   back to `BackendToolView` whenever an approval is pending or there is no
   output yet — so the gate is never bypassed by the terminal fast-path.
2. **Result shape.** `RunCommandTerminalUI` expects `{ stdout, stderr, exitCode }`;
   OpenCode's `bash` result is a plain string, and `metadata` (which holds
   `exitCode`) is dropped by the runtime before our UI sees it. `adapt.ts`
   therefore grows a `bash` result shim that builds the envelope.

`edit`/`write` need no result shim (their results are plain strings the shared
`TextBody` renders), but they do need an `argPreview`: the shared factory gained
an optional `argPreview` hook so `edit` shows the find/replace pair and `write`
shows the content — and, matching the native UIs, that preview appears in the
**approval gate** branch, not the completed body.

### 4.4.2 A pre-existing bug found while reusing the terminal block

`TerminalBlock` declares and documents `status?: "success" | "error"` and
branches on it in the body, but **omits `status` from its destructuring list** —
so the body read the global `window.status` instead. Effect: `status === "error"`
was never true, a failed command rendered a green `exit 0` badge, and
`RunCommandTerminalUI`'s own `status="error"` was silently dropped. Fixed with a
one-line destructuring change; the deviation is recorded in the file's header
(it is otherwise vendored verbatim and marked "do not edit"), so a future
re-vendor cannot quietly restore the bug. `terminal-block.test.ts` locks it in,
including a test that an ambient global cannot influence the badge.

### 4.4.3 Guard: still exactly one approval path

`tools/opencode/approvalParity.test.ts` asserts, over comment-stripped source,
that the OpenCode renderers (a) reach approval only via `BackendToolView`, (b)
never import `ApprovalGate`, (c) never re-implement the stale-permission rule,
(d) pass `respondToApproval` down but never call it, (e) build no approval chrome
of their own, and (f) export a renderer for every gated tool they claim to map.
(f) is asserted against the module's actual exports rather than its source
spelling, because `edit`/`write` are built by the shared factory while `bash` is
hand-written — the two legitimately register differently.

## 5. Phase 4 — diff routing (implemented, gated)

Goal as written: route an `edit`'s own patch into `DiffViewer`, so an edit renders
as a diff without the model having to echo it in a fenced block. Achieved — but
the premise in the original line was wrong in two ways, and both mattered.

### 5.1 Blocking finding — the patch is in `metadata`, not in the result

"OpenCode `edit`/`write` results carry a patch" is false. Surveyed over **every**
completed `edit`/`write` part in the local OpenCode database (253 parts):

| | `edit` | `write` |
|---|---|---|
| `state.output` | always `"Edit applied successfully."` | always `"Wrote file successfully."` |
| `metadata.diff` | **148 / 148** | **0 / 105** |
| `metadata.filediff` (`file`,`patch`,`additions`,`deletions`) | **148 / 148** | **0 / 105** |
| `metadata.filepath` + `exists` | — | 105 / 105 |

So the result is a fixed human string, and **`write` has no patch at all** — a
whole-file write has nothing to diff against. Phase 4 is therefore an `edit`
feature; rendering an empty diff card for `write` would be wrong.

**Diff behavior contract (preserved by design):** render a real `DiffViewer` for
`edit` **only when a valid patch exists** (extracted from
`metadata.custom.opencode.parts`, because `mapToolState` drops `state.metadata` —
see §5.2/§5.3); render **no** diff for `write` (it has none); and fall back to the
normal `"Edit applied successfully."` / `"Wrote file successfully."` string
whenever no patch is present. The approval UI must stay free of any future edit
patch until approval has completed (§5.3).

### 5.2 Blocking finding — the projection drops `metadata`

`mapToolState` (`@assistant-ui/react-opencode`) returns exactly
`{args, argsText, result, isError}` — `input`→`args`, `output`→`result`, and
`state.metadata` is never forwarded. Read naively, the diff is unreachable.

It is reachable, though: `projectServerMessage` puts the **untouched** parts in
message metadata (`metadata.custom.opencode.parts`), and `ChatWindow` already
reads that path (`s.message.metadata?.custom`) for its provenance chips. So no
backend change and no fork — the diff is one `useAuiState` away.

### 5.3 Design — a pure view plus a thin hook wrapper

`useAuiState` **throws** without an `AuiProvider` ("You are using a component or
hook that requires an AuiProvider"). Putting it straight into the `edit` renderer
broke two render tests immediately — which is the useful signal: it forces the
split.

- `openCodePatchFromParts(rawParts, callId)` — pure extraction, in `adapt.ts`.
  Matches on `callID` (the projection derives `toolCallId` from it), reads
  `filediff.patch` then `metadata.diff`, and returns null on anything partial,
  malformed or whitespace-only.
- `OpenCodeEditView` — pure: the patch arrives as a `diffPatch` **prop**, so it
  is renderable in a unit test with no provider.
- `OpenCodeEditToolUI` — the registered component: one hook call, then delegates.

The approval gate is untouched: `BackendToolView` only reaches `summarize` once
the part is decided, so the gate keeps showing `argPreview` (the find/replace
pair). A test passes a patch *and* a pending approval and asserts the gate does
**not** show the patch — approving a change that has not happened yet would be
the bug.

`parse-diff` (already the `DiffViewer` parser) handles OpenCode's git-style
header — `Index:`, the `===` rule, `---`/`+++` — verified against a real patch
string, so no adapter is needed.

### 5.4 What is verified, and what is not

Verified:
- The extraction against the **real** recorded metadata shape (survey above).
- `parse-diff` on a **real** patch string (1 file, 1 chunk, 3 adds).
- The render: with a real patch the diff shows and the "applied successfully"
  string is gone; without one it falls back to the string.
- The hook path **live in the browser**: a temporary probe on the live `write`
  part printed `parts=3 match=true hasMeta=false patch=no` — i.e. the raw parts
  array is reachable from inside a tool part and `callID` matches. (`hasMeta`/
  `patch` are false because that part is still `running`; OpenCode writes
  `metadata` only on completion.) The probe was removed and the trace checked.

**Not verified live: a completed `edit` rendering its diff in our app.** The
render logic, extraction, and `parse-diff` are all covered by unit tests against
the real recorded patch shape (survey of 253 real parts), so the chain is
verified at every link that can be exercised without a completed edit part. The
end-to-end visual is not, because a completed `edit` part cannot be produced here
— see §6 for why (OpenCode's message-creation endpoint is down).

---

## 6. Phase 3D — verify in a real Code conversation (root cause resolved; live run blocked by environment)

### 6.1 Sixth finding (headline) — OpenCode's message-creation endpoint is down

The live run cannot be produced in this environment, and the reason is a broken
server endpoint, not a model problem.

`POST /session/{id}/message` is the endpoint the app calls to send a prompt and
that an assistant turn is built from. It is currently failing:

- Driving the app UI properly: selected `opencode/nemotron-3.5-lightning-free`
  through the composer's model picker (the app's catalog only exposes
  `opencode`-free + `bai` models — the connected `google` provider is **not**
  selectable), typed a write+edit prompt, sent it. The conversation was created
  and the session's model was set (`opencode/nemotron-3.5-lightning-free`), but the
  OpenCode session received **0 messages** — the dispatch silently failed.
- Calling the endpoint directly returns **`500 Unexpected server error`** with a
  ref; a second attempt **hangs** (no response for 3+ minutes). A `GET` on the
  same session still works, so the server process is alive but this write path is
  wedged/broken.

Because no message can be created, **neither** a real model run **nor** a synthetic
injection of a completed `edit` part can be performed. That is the true root cause
of every remaining "not verified live" item.

### 6.2 Fifth finding — the original mis-diagnosis ("no credit") was wrong

Still worth recording, because it pointed verification at the wrong thing.

- `bai` (the `/config` default) genuinely is out of credit (`balance=0`) — but it
  is **not** the model Code mode uses.
- `GET /provider` shows `connected: ["google","opencode","openrouter","bai"]`;
  `opencode` offers **free models** including `nemotron-3.5-lightning-free`, the
  model actually selected in Code mode.
- That model's **text** generation works: `prompt_async` with
  `{providerID:"opencode",modelID:"nemotron-3.5-lightning-free"}` and "Reply with
  exactly: PING" returned `text="PING"`, `completed=true`. It is merely slow.

### 6.3 Fourth finding — even with a working model, tool calls stall via `prompt_async`

`prompt_async` is a single generation step; it does **not** pump OpenCode's
multi-turn agent loop (tool execution + result feeding + approval). A write+edit
prompt emitted the tool calls as `running` parts with `time:{start}` and no `end`,
the turn stayed `completed=false` indefinitely, and there were **0 pending
permissions** (so it is not the approval gate). Text-only turns complete
normally. Only the app's streaming runtime drives that loop — and the app's
dispatch is exactly what the §6.1 endpoint failure blocks.

### 6.4 Seventh finding — a completed tool call DOES render correctly (verified live)

The completed state had never been observed. It now has been, using
`POST /session/{id}/shell` to create a real completed part with **no model call**:

> Rendered live: the completed `bash` part shows its own terminal block with the
> command `echo handover-probe-ok`, a green **`✓ exit 0`** badge, and the output
> `handover-probe-ok`, as a standalone block, with no console errors.

This confirms the `TerminalBlock` `status` fix works in production (the badge only
renders when `done` is true) and that completed-state rendering works end-to-end.

### 6.5 What remains unverified, and what would unblock it

Unverified live: a completed `edit` **diff** and a completed `read` body. (The
approve/deny gate is no longer in this list — it is live-verified; see the Status
block.) The render logic for both is unit-tested against real recorded shapes, so
the code path is exercised at every link except the final projection→UI step.

**Do NOT fake completion to close these gaps.** Concretely, none of the
following are acceptable substitutes for a real completed `edit`/`read`/approval
path through OpenCode → runtime → UI:
- manually manufacturing runtime state (e.g. seeding a `completed` tool part by
  hand) in production code;
- bypassing OpenCode (calling the model or tools directly to produce a part);
- adding a refresh or polling loop whose only purpose is to paper over the
  missing completed part;
- adding artificial `completed` parts to the app or runtime source.

The gaps stay open and are reported as **LIVE BLOCKED** until a real
`state.status === "completed"` tool part renders through the actual path.

**Root cause (corrected 2026-09-17 — the earlier note here was wrong).** This
section previously claimed a **server-side permission deadlock** and said no TBAi
code change could fix it. That diagnosis was incorrect, and the correction
matters: the probe had sent the reply **without** the session's `?directory=`,
so it resolved an empty store and answered `PermissionNotFoundError`. The stores
are **directory-scoped** — the canonical route works as soon as the directory is
supplied. Measured live against the managed 1.18.31 server:

```
GET  /permission                             -> []
GET  /permission?directory=<sessionDir>      -> [ <the pending request> ]
GET  /question?directory=<sessionDir>        -> [ <the pending question> ]
POST /permission/<rid>/reply?directory=<dir> {"reply":"once"}    -> 200 true, tool running -> completed
POST /permission/<rid>/reply?directory=<dir> {"reply":"reject"}  -> 200 true, tool running -> error
POST /question/<qid>/reply?directory=<dir>   {"answers":[["…"]]} -> 200 true, question completed
```

The fix therefore belongs in TBAi code and is **implemented**: `opencodeScope.ts`
owns the directory rule once; `permissionCompat.ts` / `questionCompat.ts` add it
to the list + reply calls; `initialHydration.ts` replays the authoritative
pending set on connect; `stalePermissions.ts` reconciles against the same scoped
endpoint; `runtimeClient.ts` composes all four. **No OpenCode config change, no
server patch, and no workaround was required.**

**What still remains:** the completed `edit` **diff** and `read` **body** have not
yet been captured live. A real completed `edit` part carrying
`metadata.filediff.patch` must render through OpenCode → runtime → UI before that
is marked **LIVE VERIFIED**. A detailed handover is in
`docs/handover-phase-3d-verification.md`.

---

## 7. Verification gates (every phase)

- `bun run typecheck` (root: backend + web) — must exit 0.
- `bun run test` — full suite (**708 tests / 75 files**).

  **Pre-existing flakiness, now diagnosed precisely.** Under the default 5s
  per-test timeout the suite reports a variable number of failures (observed: 6,
  then 12) in files this work never touches — `runBash onOutput` (3),
  `chat terminal wiring` (1), `computer tools > lists processes` (1),
  `CredentialStore` (4), `todo service` (3). Diagnosis:

  - Each failing test file **passes in isolation**, and `src/services/` (104)
    and `src/services/ + tests/unit/` (418) both pass as groups.
  - `terminal-runbash.test.ts` takes **2.6–3.4s per test when run alone** — a
    ~1.5× margin against the 5s default. Under the suite's own parallel load
    (bun runs files concurrently, `--max-concurrency` default 20) it crosses 5s
    and fails, and the resulting stalls cascade into the unrelated
    `CredentialStore`/`todo` assertions.
  - Decisive check: `bun test --path-ignore-patterns "web/e2e/**"
    --timeout=30000` → **706 pass, 2 skip, 0 fail, exit 0** in ~31s (re-run for
    this plan update: 706 pass / 2 skip / 0 fail, 1953 expect() calls, 708 tests
    across 75 files, 30.72s). The 2 skips are pre-existing browser-adapter binary
    tests, unrelated to this work.

  So: a timeout budget problem, not a defect. Raising the timeout for this
  process-spawning cluster (or lowering `--max-concurrency`) is the fix; no
  source change is warranted. All failures are in untouched files, verified
  with `git status --porcelain` per file.
- Compile/typecheck: `bun run typecheck` (root `tsc --noEmit` for backend + web)
  **succeeds** — re-run for this plan update exited 0 with no errors.
- Web bundle: the **fresh-output** build `cd web && bunx vite build --emptyOutDir
  false` **succeeds** (re-run for this update: built in 23.25s, no errors — only
  chunk-size warnings). The plain `bun run build` web step is blocked by the CLI
  bulk-delete shim on Vite's own `emptyDir`; that shim is an **environment guard
  against bulk deletion**, i.e. an environment artifact, **not a source
  compilation failure**. Do not weaken or bypass application safety checks in the
  source code to make the ordinary build "pass"; use the fresh-output build
  instead.
- Artifact check: grep the built bundle for the new wiring.
- Browser: the user is the only one who can confirm the rendered result. Report
  honestly what was and was not observed.

## 8. Explicitly out of scope

No fork or patch of `@assistant-ui/*`; no new dependency; no SDK or binary
version change; no backend/proxy change; no SSE/transport change; no change to
permission or approval semantics (Phase 1 behaviour is preserved — a
permission-gated tool still renders through `ToolFallbackApproval` when it has no
registered UI, and a `standalone` tool still keeps its card out of a collapsed
group).

---

## 9. Compatibility layer study — OpenCode v2 ⇄ assistant-ui ⇄ AI SDK v7

Captured from the installed code on disk (`node_modules`) and the official docs
(`assistant-ui.com/docs/runtimes/opencode/overview`, `opencode.ai/v2/docs/api`,
confirmed packages in the lockfile). The rendering code in Phases 2–4 must speak
the contracts below.

### 9.0 Canonical version & ownership (read before adding any OpenCode code)

```
Canonical OpenCode API:        V2
Frontend dependency:           @assistant-ui/react-opencode@0.2.23
                               (currently V1-shaped)
TBAi-owned compatibility code: web/src/tools/opencode/      (toolkit:
                               alias table, renderers, parity tests)
                               web/src/features/opencode/   (view shell,
                               runtime hook, permissions, chips)
No production V1 calls are added elsewhere.
```

- The **canonical** OpenCode API is **V2** (`@opencode-ai/sdk` `/v2/client`).
  The `@assistant-ui/react-opencode@0.2.23` bridge is **currently V1-shaped** in
  how it projects parts, but it is the supported bridge and is what the app uses.
- **TBAi-owned compatibility code lives in two folders**, both under
  `web/src/.../opencode/`:
  - `web/src/tools/opencode/` — the toolkit layer (`adapt.ts` alias table,
    `ui.tsx` renderers, `approvalParity.test.ts` and the other `*.test.ts`).
  - `web/src/features/opencode/` — the view shell (`OpenCodeView.tsx`,
    `CodeShell.tsx`), the runtime hook (`useOpenCodeRuntime.ts`), permissions
    (`OpenCodePermissions.tsx`, `stalePermissions.ts`) and chips.
  This is noted explicitly because an earlier draft implied only
  `web/src/features/opencode/`; that is incomplete — the rich-tool mapping code
  is in `web/src/tools/opencode/`. **No new V1-shaped calls may be added anywhere
  outside these two folders.**
- The backend bridge (`@assistant-ui/ai-sdk` `AISDKToolkit`) is in
  `src/tools/index.ts`; it speaks AI SDK v7 (`ai@7.0.93`), not OpenCode V1.

### 9.1 Two bridges, not one

| Layer | Package (on disk) | Role |
|---|---|---|
| OpenCode v2 server | `@opencode-ai/sdk@1.18.31` (`/v2/client`) | Typed HTTP + SSE client to the agent server |
| **Frontend bridge** | `@assistant-ui/react-opencode@0.2.23` | Maps OpenCode sessions/parts → assistant-ui `Thread` primitives |
| Runtime | `@assistant-ui/react@0.15.20` + `ExternalStoreRuntime` + `RemoteThreadList` | assistant-ui's streaming runtime (shadcn/ui + Tailwind v4) |
| **Backend bridge** | `@assistant-ui/ai-sdk@0.0.6` | `AISDKToolkit` turns our Zod tools into an **AI SDK v7** `ToolSet` |
| AI SDK v7 | `ai@7.0.93` | Vercel AI SDK v7 `streamText` on the server |

"assistant-ui stream + assistant ai sdk 7" is accurate, with one nuance: the
**backend** streams/describe via AI SDK v7 (`AISDKToolkit` → `streamText`); the
**frontend** does *not* stream via AI SDK v7 — it streams via OpenCode's own SSE,
adapted by `react-opencode`. So the "stream" half and the "sdk 7" half are
different legs of the same pipeline.

### 9.2 Frontend data flow (the runtime adapter)

```
OpenCode v2 server ──SSE──▶ OpenCodeEventSource        (OpenCodeEventSource.js)
                                   │ client.event.subscribe()
                                   ▼
                          OpenCodeThreadController      (per session; reduces events
                                   │                       → OpenCodeThreadState)
                                   ▼
                          openCodeMessageProjection     (openCodeMessageProjection.js)
                                   │  state → ThreadMessage repository
                                   ▼
                useRemoteThreadListRuntime / ExternalStoreRuntime   (useOpenCodeRuntime.js)
                                   │
                                   ▼
                    Thread primitives → shadcn/ui + Tailwind renderers
```

- `useOpenCodeRuntime` (`useOpenCodeRuntime.js:227`) builds an
  `@opencode-ai/sdk/v2` client, a per-process `OpenCodeEventSource`, and wraps
  everything in `useRemoteThreadListRuntime` (OpenCode sessions = assistant-ui
  threads).
- `OpenCodeEventSource` (`OpenCodeEventSource.js:90`) is the SSE pump: it calls
  `client.event.subscribe()`, normalizes each event (`normalizeEventPayload`),
  and has exponential-backoff reconnect. This is the literal "assistant-ui
  stream" half.
- `OpenCodeThreadController` keeps an `OpenCodeThreadState` (reduced from
  events); the projection reads that state to build messages.

### 9.3 The projection contract — the heart of the compatibility

`openCodeMessageProjection.js` translates OpenCode's part model to assistant-ui's:

| OpenCode part | assistant-ui part |
|---|---|
| `text` | `text` |
| `reasoning` | `reasoning` |
| `file`/image | `image`/`file` |
| `tool` | `tool-call` (with `args`, `result`, `approval`) |
| `step-start`/`step-finish` | `data` part `opencode-step-start`/`-finish` |
| `patch`/`snapshot` | `data` part `opencode-patch`/`opencode-snapshot` |
| `retry`/`compaction`/`agent`/`subtask` | `data` part `opencode-<type>` |

Two compatibility facts that drive the rendering work:

1. **`mapToolState` (line 42) only emits `{ args, argsText, result, isError }`.**
   It deliberately **drops `state.metadata`** (where OpenCode puts the actual
   `diff`/`filediff`). That is exactly why Phase 4's `openCodePatchFromParts`
   reads the raw parts from `metadata.custom.opencode.parts` instead (set at line
   316) — the diff is preserved there even though the tool-call primitive loses
   it. **This seam is the single most important one for any rich tool UI.**
2. **Status** (`getMessageStatus`, line 275): a pending permission →
   `requires-action` (tool-calls); an error → `incomplete`; otherwise
   `running`/`complete`. **Permissions** are resolved per `callID`
   (`getPendingPermissionForToolCall`) and projected onto the tool-call's
   `approval` field — this drives the approve/deny card (Phase 3C gate).

Streaming timing is handled separately by `useOpenCodeStreamingTiming` (injected
into the projection's `metadata.timing`), so token/streaming UI is decoupled
from the part mapping.

### 9.4 Backend mirror (`src/tools/index.ts`)

The server side of the same contract: `AISDKToolkit({ toolkit: entries })` converts
each Zod `toolSchemas.*` into an AI SDK v7 `ToolSet` (`parameters` =
`z.toJSONSchema`). Each tool's `execute` runs server-side (filesystem/terminal/
browser/scheduler). `withThreadContext` binds request-scoped `workspaceDir` +
`threadId` + terminal streaming into the toolkit. This is the AI SDK v7 half: our
tools are described to the model exactly as OpenCode's backend tools are.

### 9.5 OpenCode v2 API surface (from `opencode.ai/v2/docs/api`)

The bridge is built on: `client.event.subscribe()` (SSE),
`GET /api/session/{id}/message` (projected messages),
`POST /api/session/{id}/prompt` ("durably admit input and schedule agent-loop
execution" — the multi-turn tool loop), `POST /api/session/{id}/shell`,
`GET /api/session/{id}/diff` (per-file diffs of a turn — the structured source of
the edit diff), and the permission/question endpoints. 135 operations, 241
schemas — the SDK is the typed client for all of it.

### 9.6 Where the compatibility risk lives (for future work)

- The frontend adapter is **experimental** (assistant-ui docs label it v0.0.3;
  API may change). `react-opencode@0.2.23` is newer than the docs' example but
  the contract in §9.3 is stable in this build.
- The **`metadata` drop in `mapToolState`** is the one seam that cannot be ignored:
  any rich data OpenCode attaches to a tool (diffs, file paths, tokens) must
  travel through `metadata.custom.opencode.parts`, **not** the tool-call `result`.
  `OpenCodeEditToolUI` correctly hooks that path via `useAuiState` (Phase 4).
- The frontend does not read `modelContext` (verified — no reference in the
  package; prompts are built server-side from OpenCode's tool list), so reusing the
  shared official `Tools` resource in the Code view (§4.3) only activates its
  renderer half. This is why the Code view can be given the same `AuiConfig` as the
  chat view without pulling in model-context machinery.

### 9.7 V2 interaction-payload compatibility layer — **IMPLEMENTED**

The frozen bridge handles only the **V1** event names (`permission.asked`,
`permission.replied`, `question.asked`, `question.replied`, `question.rejected`).
This build also emits **V2** variants of the same lifecycle, and the adapter has
no case for them, so such a frame is dropped **silently** — no error, no warning,
just a request that never reaches `pending` and a tool that never finishes. That
is a different failure from the directory-scope one (which at least answered
`[]`), and it is invisible from the UI.

**Actual shapes — PROVEN, not inferred.** From the installed SDK's own types
(`@opencode-ai/sdk@1.18.31` `v2/gen/types.gen.d.ts`) **and** a real captured SSE
frame (`sse-raw2.log:101`):

```
permission.v2.asked
  {"id":"per_probe_v2_create_1","sessionID":"ses_…","action":"bash",
   "resources":["echo v2-create-probe"],"metadata":{"probe":true}}
  → no `source` at all: a V2 request may legitimately have no tool link

permission.v2.replied
  {"sessionID":"ses_…","requestID":"per_probe_v2_create_1","reply":"once"}
  → field-identical to V1

permission.v2.asked (full)   { id, sessionID, action, resources[], save?, metadata?, source? }
permission.asked     (V1)    { id, sessionID, permission, patterns[], metadata, always[], tool? }
PermissionV2Source           { type: "tool", messageID, callID }   // `type` required, `source` optional
```

Questions need **no property mapping**: `QuestionV2Info` ≡ `QuestionInfo`,
`QuestionV2Tool` ≡ `QuestionTool`, `QuestionV2Option` ≡ `QuestionOption` — every
field is identical, so only the event name differs. Adding property mappings
there would have been invented work.

**Mapping implemented** (`web/src/features/opencode/permissionPayloadCompat.ts`,
pure and non-mutating):

| V2 | V1 | Note |
|---|---|---|
| `action` | `permission` | the adapter names the request by this |
| `resources` | `patterns` | **required** — the panel reads `patterns.length` |
| `save` | `always` | **required** — the card reads `always.length` |
| `source` | `tool` | **only when `source.type === "tool"`**; never fabricated |
| `metadata` | `metadata` | defaults to `{}` (optional in V2, required in V1) |
| event name | V1 event name | all five V2 names remapped |

`patterns`/`always` are always emitted as arrays. A V2 request with no `source`
stays **unlinked** — it is answerable through the Phase 1 fallback panel, which
is the correct outcome; inventing a `callID` would attach it to an unrelated tool
card. A frame with no usable identity (`id`/`sessionID`) is returned **unchanged**
so the adapter ignores it exactly as it does today.

**Wrapper order — the load-bearing part.** `runtimeClient.ts` applies it **last**:

```
OpenCode event source → event scope → permission/question scope
                      → initial hydration/replay → V2 payload normalization
                      → react-opencode adapter
```

`applyInitialHydration` synthesizes its replayed frames *inside its own wrapper*,
so a normalizer applied earlier would never see them. Applied last it is the
outermost wrapper and therefore normalizes **both** live SSE frames and
hydration-replayed frames through one mapping.

**A bug the sanity check caught before hand-off:** the first implementation
routed every `permission.*` frame through the asked-shaped property projection.
A reply carries `requestID`, not `id`, so it failed the identity check and passed
through **unmapped** — the V2 reply would have been dropped. Only
`permission.v2.asked` has differing properties; every other mapped event is a
name change alone.

**Status**

- `permissionPayloadCompat.ts` — **IMPLEMENTED**
- typecheck 0 · build 0 — **AUTOMATED VERIFIED** (coding-agent scope)
- focused unit + integration + ordering tests — **HANDED TO THE TEST AGENT**
- live Code-mode verification (V2 permission → pending → tool link → resolve;
  unlinked V2 → fallback card; V2 question lifecycle) — **UNKNOWN / NOT YET RUN**

**Limitations**

- The V2 **event** shape is proven from a captured frame; the V2 shape of the
  *hydration list* (`GET /permission?directory=`) was **not** captured, so the
  hydration path is covered by construction (ordering) rather than by a live
  sample. The normalizer is a no-op for V1 items either way.
- No inline question rendering is added here (explicitly out of scope); a V2
  question is answerable through the existing question surface.
- The layer is deletable the day upstream ships a V2-native adapter.

**Net:** the compatibility layer is `@assistant-ui/react-opencode` (frontend:
OpenCode v2 SSE/parts ⇄ assistant-ui `ExternalStoreRuntime`) plus
`@assistant-ui/ai-sdk`'s `AISDKToolkit` (backend: our tools ⇄ AI SDK v7). Both are
wired in this repo; the part/permission/diff contracts above are what the
rendering code speaks.

---

## 10. Phase B — Tool-linked question bridge (implemented, live verification blocked)

**Status: IMPLEMENTED — automated tests with test agent — live run LIVE BLOCKED (see below).**

### Why pure approval projection was insufficient

Projecting a tool-linked question as an `approval` object would render through
the existing card — but answers could never be delivered: `onRespondToToolApproval`
inside `useOpenCodeRuntime` routes **only** to `replyToPermission`, and
`RespondToToolApprovalOptions` (`{approvalId, approved, optionId?, text?,
reason?}` — proven in the installed `@assistant-ui/core@0.3.19` types) has no
answers slot. Question answers (`string[][]`) must travel `replyToQuestion`,
which lives on the runtime extras. So the bridge answers through extras, not
through the approval response.

### Boundary selected

`web/src/features/opencode/toolLinkedQuestion.ts` — the ONLY module that knows
`toolCallId → pending question` and `answers → replyToQuestion` /
`skip → rejectQuestion`. It consumes the public extras hooks
(`useOpenCodeQuestions`, `useOpenCodeRuntimeExtras`); the renderer
(`OpenCodeQuestionToolUI`) consumes only this named capability — no
`react-opencode` import outside `features/opencode/`, verified by grep. This
corrects §4.0.1's reading: AGENTS.md forbids `tools/**` importing the
*adapter*, not consuming a named capability from the owning `opencode/` dir
(the sanctioned pattern).

### Why no new store

The adapter already owns pending/answered/rejected question state and exposes
it; the capability mirrors nothing. Answered/skipped requests leave `pending`,
so both mounts retire automatically.

### Matching, paths, panel

Strict `request.tool.callID === toolCallId`; anything else → `null` →
existing read-only view (never fabricated, never `addResult`). Linked →
inline shared `QuestionFormCard` → `replyToQuestion(answers)` / `rejectQuestion`.
Panel (`OpenCodeQuestions`) renders unlinked only — the same linked-here /
unlinked-there split the permission panel uses. Unlinked tool cards keep the
non-interactive preview that points at the panel: one answerable surface,
not two.

OpenCode questions are questionnaire/form interactions, not permission approvals.
Linked requests render inline; unlinked requests render in the fallback panel. Both
surfaces use the same provider-agnostic `QuestionFormCard` (`web/src/components/shared/QuestionFormCard.tsx`)
with native radio/checkbox inputs, custom freeform mutual exclusion, and step-wizard
navigation (Dismiss, Back, Next, Submit). Old approval UI (`ApprovalCard`, `ApprovalActions`,
"Answer" / "Skip" buttons) has been completely removed from questions.

### Tests

Handed to the test agent (matcher cases, inline render cases incl. no-`addResult`,
panel linked-exclusion + answered/rejected removal, direct-approval regression).

### Automated verification — RECONCILED 2026-09-18 (test agent)

`toolLinkedQuestion.test.ts` (NEW, 15) + `ui.test.ts` +4 → focused files
**40/0**; opencode dirs (8 files) **96/0**. Full suite 816/92: **803 pass /
2 skip / 11 fail** — all 11 in the known flaky set (isolation 29/0), zero
Phase-B failures, no weakening. Coding-agent typecheck re-run exit 0 with
the new test files. Incidental observation (pinned by test, not a bug):
the unlinked read-only preview renders on completed parts; running parts
show the "Waiting for your answer…" shell.

### Paseo cross-check — DEFERRED revisions (2026-09-18, read-only study)

A read-only study of Paseo (`@opencode-ai/sdk` 1.14.46, V2 direct) confirms
the bridge direction and proposes four form-model corrections, NOT YET
APPROVED — do not implement until reviewed: (1) no Skip in the protocol —
Dismiss → `reject` (label change, same call); (2) one request = one
paginated form with tabs + auto-advance (ours stacks all questions);
(3) freeform forced on every question; (4) answers header-keyed → positional
`string[][]`. Paseo-side facts (separate `question.*` APIs, drop-unlinked,
stale-prune, auto-accept exclusion) all hold in TBAi's design already.

### Live verification — BLOCKED 2026-09-18 (fresh evidence, not assumed)

A genuine pending question requires a model-driven `question` tool call, and
all three trigger paths were re-probed against the managed 1.18.31 server:
`POST /session/{id}/message` → **500 UnknownError** (same wall as §6.1);
`prompt_async` does not pump the agent loop (§6.3); **no question-create
route exists** (`POST /api/session/{id}/question` and `POST /question` both
answer the SPA fallback). The Paseo browser host (the only production path
that pumps the loop) is disconnected. Reply *delivery* is already proven at
transport level (§6.5: `POST /question/<qid>/reply` → 200). What remains is a
live pending question to answer inline + Skip + unlinked single-surface check.

### Remaining limitation

Message/tool removed while its question stays pending → UNKNOWN (documented,
no recovery machinery — same class as §6.5's open items).

---

## 11. Genuine reconnect (implemented, tests pending)

**Why `refresh()` was not relabeled.** Traced to source: extras `refresh()`
→ `controller.refresh()` → `load(true)` → `session.get` + `session.messages`
→ history re-projection. The SSE event source subscribes independently and is
never torn down by this path. It re-reads history; it re-establishes nothing.
Labeling it "Reconnect" would misstate the action, so the button keeps no
such label and `refresh()` is preserved untouched.

**New `reconnect()` capability** (`useOpenCodeRuntime.ts`): bumps a client
epoch, rebuilding the client with the SAME sessionId + directory. The
adapter's `useEffect(registry.activate/dispose)` then disposes the old
registry (existing cleanup path) and subscribes anew — a genuine fresh event
subscription, followed by the normal hydration + reconcile path
(`initialHydration` on first `server.connected`, adapter `stream.reconnected`
re-list). No second SSE, no new store/context, no SDK changes.

**Single-subscription invariant:** rebuilds serialize through React state;
each disposes its predecessor via the existing effect cleanup, so exactly
one subscription is ever active. Rapid clicks are idempotent rebuilds.

**Session preservation:** same id + directory flow into the factory; no new
session, no workspace change, no conversation impact. Session switches
rebuild naturally through the same memo deps.

**Recovery:** post-reconnect state restores through the canonical paths —
controller `load()`, hydration replay, `stream.reconnected` reconcile
(permissions/questions re-listed, todos hydrated). Failure surfaces as the
error heart via `loadState`; never false Connected.

**UI** (`OpenCodeStatus`, composer folder row): Reconnect button;
Reconnecting… while the fresh load cycle settles (armed + loading);
disabled while reconnecting, sessionless, or runtime-less. Runtime safety:
only null-safe hooks used; no throwing extras call remains.

**Status:** IMPLEMENTED — typecheck + build green. Automated tests with test
agent (lifecycle, replacement, concurrency, preservation, delivery,
hydration, failure, switching). No live user run yet.

### Phase B2 — SDK/API contract lock (2026-09-18)

Audited TBAi's question path against the installed `@opencode-ai/sdk@1.18.31`
V2 generated types (the official contract for the pinned deployment) and the
live official V2 API reference. Result on all 14 checks: **no genuine
mismatch** — `QuestionRequest`/`QuestionInfo`/`QuestionOption`/`QuestionTool`/
`QuestionAnswer` shapes, `multiple?`/`custom?` semantics, `question.reply`
(`{requestID, answers?: string[][], directory?}`) / `reject` (`{requestID,
directory?}`), requestID + directory identity, zero permission-API use for
questions, transport-only compat, SDK-client-only operations, no private
imports, no wire logic in UI. No code changes made.

Two observations recorded, neither a mismatch: (1) current official docs list
a newer **Form** system (`session.form.*`, `formID ^frm_`) with no question
routes — the installed 1.18.31 SDK has questions and no forms, so questions
remain the live contract here; forms are a forward-compat watch item, not
actionable. (2) An unapproved parallel implementation (generic form core +
replacement card, 4 files) was found wired into `OpenCodeQuestions.tsx`,
breaking typecheck and duplicating the approved UI; with no SDK mismatch to
justify it, the tree was restored to the approved Phase B state and the 4
files removed. Gates re-run green after restoration.

**PHASE B2 SEMANTICS LOCKED — SDK/API VERIFIED.**
---

## Phase C — OpenCode `todowrite` (multi-step task tracking)

### Contract & Authority (audited against live 1.18.31 server & SDK)

1. **Wire Model**:
   ```ts
   {
     content: string;
     status: "pending" | "in_progress" | "completed" | "cancelled";
     priority: "high" | "medium" | "low";
   }
   ```
   - **No ID exists on the wire.** The array position/order is authoritative.
   - OpenCode's backend implementation (`SessionTodo.update`) executes `DELETE FROM todos WHERE session_id = ?` followed by re-inserting the new list.

2. **Lifecycle & Endpoints**:
   - **Hydration API**: `client.session.todo({ sessionID, directory })` (GET `/session/:id/todo?directory=...`). Returns `OpenCodeTodo[]`.
   - **Streaming Events**: SSE `todo.updated` frame carries `{ sessionID, todos: OpenCodeTodo[] }`.
   - **Replacement Semantics**: Every update replaces the list completely. `[]` is authoritative empty; `undefined` is unhydrated.
   - **Storage Rules**: In-memory projection store only (`OpenCodeTodoStore` keyed by `sessionID`). No SQLite persistence, no duplicate SSE connections.

3. **Rendering Decoupling**:
   - **Historical tool-call cards** (`OpenCodeTodoWriteToolUI`) render the exact snapshot passed in `args.todos` and are immutable once rendered. They do NOT subscribe to `useOpenCodeTodos`.
   - **Ambient projection**: Exposed via `useOpenCodeTodos(sessionId)` (backed by `useSyncExternalStore`) for future ambient task-list surfaces.

4. **Implementation Boundaries**:
   - `web/src/features/opencode/todoState.ts` — in-memory store (`OpenCodeTodoStore`), `useOpenCodeTodos`, event observer, initial hydration helper.
   - `web/src/features/opencode/runtimeClient.ts` — composes `applyTodoCompat` on the single client event stream.
   - `web/src/features/opencode/initialHydration.ts` — calls `hydrateSessionTodos` asynchronously when `server.connected` is received.
   - `web/src/features/opencode/useOpenCodeRuntime.ts` — lifecycle boundaries: `openCodeTodoStore.attachSession(sessionId)` on mount and `openCodeTodoStore.clearSession(sessionId)` on unmount/detach.
   - `web/src/tools/opencode/ui.tsx` — `OpenCodeTodoWriteToolUI` renders `args.todos` statically with status indicators.

5. **Lifecycle Race Hardening Guarantees**:
   - **Monotonic generation**: Increments on every `attachSession` and `clearSession`, never resets.
   - **Monotonic revision**: Increments on every live SSE `todo.updated` event.
   - **Hydration safety**: Hydration captures `(generation, revision)` at dispatch and only applies if the session is still active, generation is unchanged, and revision is unchanged (`newer event > older hydration`).
   - **Detach safety**: `clearSession` invalidates generation, clears snapshot, and drops trailing SSE events.
   - **Reattach safety**: Reattaching a session bumps generation, ensuring older in-flight hydration requests from prior attachments can never overwrite the newly attached session.

6. **TodoWrite Presentation — Single Current Task List UX**:
   - **Core Invariant**: Exactly ONE full TodoList is mounted for the active OpenCode session (`OpenCodeTodoTracker`), backed strictly by `OpenCodeTodoState` (`session.todo()` + `todo.updated`).
   - **Compact Historical Tool Calls**: `OpenCodeTodoWriteToolUI` (`web/src/tools/opencode/ui.tsx`) renders a compact audit record (e.g. `todowrite · 2/3 completed` title with status icon, completion note, and task counts) rather than repeating full interactive checklists in the transcript stream. It stays in default tool grouping alongside other tools in the transcript.
   - **Historical Immutability**: Historical tool cards strictly calculate their summary from their invocation's own `args.todos` snapshot. They do NOT subscribe to `useOpenCodeTodos` or mutate when subsequent `todo.updated` events arrive.
   - **Single Ambient Task Tracker**: `OpenCodeTodoTracker` (`web/src/features/opencode/OpenCodeTodoTracker.tsx`) consumes `useOpenCodeTodos(sessionId)` ONLY. Mounted in `OpenCodeSessionRow` (session header row).
     - Compact status pill (`X/Y tasks` with live status icons: checkmark if all completed, spinner if active, list icon otherwise).
     - Expandable Popover shows the full session task checklist using `TodoListView`.
     - Hides/clears when `todos` is empty `[]` or `undefined`.
   - **Session Isolation**: Switching sessions immediately projects the newly selected session's state from `openCodeTodoStore` without leakage from prior sessions.
   - **Status Mapping**: OpenCode's 4 canonical wire statuses are preserved and mapped visually: `pending` → circle (`pending`), `in_progress` → spinner (`active`), `completed` → checkmark (`done`), `cancelled` → x-circle (`cancelled`). Cancelled tasks are tracked distinctly and never counted as completed in the compact ratio.
