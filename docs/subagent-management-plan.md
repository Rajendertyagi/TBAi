# Subagent management — detailed plan

Status: **proposed, not started.** Research complete; every claim below is
sourced. This file follows the rule in `AGENTS.md` that an architectural change
is proposed in `docs/` with its reason and the alternatives considered.

Research date **2026-09-30**. Sources, all read at source rather than from
memory: OpenCode 2.0.15's shipped `opencode.exe` read as bytes, the OpenCode v2
docs, OpenChamber's source at `D:\Temp\openchamber`, the assistant-ui registry
JSON, and TBAi's own code and installed `@opencode/client` types.

---

## 1. The problem, stated as a reader would

Today, a Code-mode turn that delegates work shows one card: the subagent's name,
its prompt, and whatever text came back. That is all.

Four things a reader cannot see, in rough order of how much they matter:

1. **That the subagent is blocked.** When a subagent raises a permission request
   it has nowhere to put it. OpenChamber says this outright: *"a permission
   request raised by a child session has no representation in the transcript, so
   this panel is the only place it becomes visible."* In TBAi a blocked subagent
   is indistinguishable from a thinking one.
2. **What the subagent did.** Its own tool calls are in its own session, which
   TBAi never reads.
3. **That it is still running**, or how long it has been. The card shows a
   spinner only for the delegation itself.
4. **What it cost**, and which of several subagents is which.

The card that exists is *correct* — it was built to stop a raw JSON dump and it
does that. The problem is that it is nearly featureless, and the gap is
structural rather than cosmetic: TBAi has no notion of a child session at all.

---

## 2. What OpenCode provides — the contract

Verified against the v2 docs and confirmed by reading the shipped binary.

### The tool

One tool, `subagent`. Its description, recovered from the binary's string table
at offset 96568032, is *"A short 3-5 word label for the task, displayed to the
user"*. A real capture on 2026-09-30 sent `{ agent, description, prompt }`.
`task` is the v1 spelling.

### The result needs no unwrapping

OpenChamber unwraps a `<task id=… state=…><task_result>…</task_result></task>`
envelope. **The regex `<task_result>\s*([\s\S]*?)\s*<\/task_result>` is inside
OpenCode's own binary** (offset 94973513), so v2 strips the envelope server-side
and TBAi receives clean markdown. OpenChamber's unwrap is legacy defence for
older builds.

Recorded because it looks like a bug and is not — nobody should re-chase it.

### Child sessions

> *"Subagents run with fresh context in foreground or background child sessions."*

| Fact | Source |
|---|---|
| Child session id | `metadata.sessionID` on the subagent tool part |
| Child → parent | `Session.Info.parentID` |
| Live status | `client.session.active()` |
| The child's steps | `client.session.context({ id })` |
| Its file changes | `client.session.diff({ id })` |
| Its cost and tokens | `client.session.stats({ id })` |

**The installed `@opencode/client` supports all of this today.** `SessionInfo`
carries `parentID, agent, cost, tokens, outcome, title, permissions, revert`. And
`SessionListInput.limit` accepts a **`parentID`**, so the *server* filters
children — a client-side scan over every session is unnecessary.

**This answers the question that gated the plan: TBAi does not retain child
sessions, but nothing stops it.** It has simply never called `session.list`.

### Agents

Defined in Markdown or JSONC, with `mode: primary | subagent | all`.

| Agent | Mode | Note |
|---|---|---|
| `build` | primary | default coding agent |
| `plan` | primary | explores and plans; may write plan files |
| `general` | subagent | research and multi-step; **cannot launch more subagents** |
| `explore` | subagent | searches and reads; no edits |
| `compaction`, `title`, `summary` | hidden | maintenance, not selectable |

**V2 has no `scout` agent** — it was removed.

Per agent: `color` (six-digit hex, for UI), `description` (shown to the model
choosing an agent), `steps` (on the final step tools are removed and the model
must summarise), `hidden`, and `model` (inherits the parent's when unset).

### Permissions

The `subagent` action on the parent controls **which agents** it may launch,
matched against an agent id. The child then runs on **its own** permissions — so
a child can hold authority the parent lacks, and a reader judging "is this safe"
has to look at the child, not the parent.

---

## 3. What OpenChamber does with it

Read from source, not from the UI.

### In the transcript — `chat/message/parts/taskToolModel.ts`

- `readTaskSessionIdFromRecord` takes `metadata.sessionID` (v2), still accepting
  a legacy `<task_metadata>` block for v1
- `buildTaskSummaryEntriesFromSession` walks the **child's own messages** and
  projects each tool call into `{ id, tool, status, input }`. This is how
  "what did the subagent actually do" is answered — by reading the child, not by
  parsing prose
- `stripTaskMetadataFromOutput` and `unwrapTaskResultEnvelope` clean the output
  before markdown

### The management view — `chat/work-status/WorkStatusSubagentsSection.tsx`

- Children: `liveSessions.filter(c => c.parentID === sessionId)`
- Per-child state, in this priority order: **needs permission → asked a question
  → working → done**, plus cost
- Cost rolls up through **nested** subagents (`useSubagentCostRollup`)
- **One** directory-wide subscription for all children — per-child hooks would
  multiply store subscriptions by the number of subagents
- Self-expands **only** on the empty→present edge, so it does not fight a user who
  deliberately collapsed it
- Click a child → its session opens read-only in a context tab, or navigates on
  surfaces that cannot host one
- `lib/agentColors.ts` gives each agent a stable colour
- `sections/agents/AgentsPage.tsx` manages the agents themselves

`__tests__/issue-2903-subagent-status-line-only.test.tsx` exists, which suggests
this area has already broken once for them.

---

## 4. What assistant-ui offers

Both read from the registry. **Neither is exported by the installed
`@assistant-ui/react` 0.15.20** — both are copy-in items, and the train is frozen,
so adopting either is a decision rather than an import.

### `elements-task-card` — the one to adopt

> *"A delegated task with its state, timing, result, and transcript in one card."*

```ts
TaskCard      { label, meta, state, elapsed, actions, result,
                open, onOpenChange, children }
TaskStateIcon { state, className }
type TaskCardState = "working" | "waiting" | "done" | "failed" | "cancelled"
```

- `children` is a **collapsible transcript slot** — the child's steps
- `state` covers exactly the states that matter here, and `waiting` is the one
  that names a child blocked on permission
- `result` is a separate always-visible region, distinct from the transcript
- `meta` takes the model id; `elapsed` the duration

### `elements-subagent-list` — recommended to defer

> *"Parallel workers with their own progress, models, and completions."*

```ts
SubagentList { agents: { name, model }[], completedCount,
               progress: number[], showSummary, summaryAgent }
```

For *parallel* workers, and it needs a real per-agent progress percentage.
Nothing established today supplies one, so it would render a decorative 0%.

### Dependencies: none new

`TaskCard` needs `surfaces` (`mono`, `paper`); `SubagentList` also needs `range`
(`pct`). **Both are already vendored** — `elements/surfaces.tsx` exports `mono`
at L45 and `paper` at L7, and `utils/range.ts` exists. Both pull only
`lucide-react`, already present. So adopting `TaskCard` adds no dependency and
no new component to `components/ui`.

---

## 5. What TBAi has today

| | |
|---|---|
| Card | `subagentView` in `tools/opencode/ui.tsx` — title from `args.agent ?? args.subagent_type`, prompt as gate preview, raw result as body |
| Timeline | `session-timeline.tsx:81` — verb "Delegated", `ListChecksIcon` |
| Permission | `subagent` is in `permissionPolicy.ts`'s `ASKED_ACTIONS` |
| Child sessions | **none** — `projectV2History` (`v2History.ts:177`) binds to one session's snapshot; no `parentID` anywhere in `web/src` |
| Child state, cost, colour, transcript, elapsed, click-through | **none** |

---

## 6. Decisions taken

All four settled by the maintainer on 2026-09-30. Decision 5 was not raised and
keeps its earlier default.

| # | Decision | Outcome |
|---|---|---|
| 1 | Vendor `elements-task-card`? | **Yes — vendor it.** No new dependency: `surfaces` and `range` are already vendored. |
| 2 | `elements-subagent-list` too? | **Yes — vendor it as well.** See the note below, because it carries a data prerequisite the other phases do not. |
| 3 | Management-view placement | **Extend the existing Code dock.** No new route, no new surface. |
| 4 | Do we hold child sessions? | **Yes.** `session.list({ limit: { parentID } })` already exists in the installed client, so this is a call TBAi has never made rather than new infrastructure. |
| 5 | Nested subagents? | **Out of scope for v1** (unchanged — not raised). |

### Decision 2 carries a prerequisite the others do not

`SubagentList` is for *parallel* workers and its `progress: number[]` prop wants a
real per-agent completion percentage. Nothing established supplies one: TBAi has
no child-session data at all today, and even once the child-session reader lands,
a percentage would have to be **derived** rather than read.

So vendoring the component is cheap and safe, but **it must not be wired to a
fabricated number.** A `0%` progress bar on every agent is worse than no bar — it
asserts a measurement that was never taken. The honest options, in order:

1. Compute progress from something real, and omit the bar when it cannot be
   computed
2. Render only the agents that genuinely have a value
3. Defer the wiring while keeping the element vendored

**Recommendation:** vendor it with decision 1, wire it in the management view
(Phase 3) alongside the section that already knows each child's state, and treat
the progress bar as optional output rather than a default. A child that is `done`
is fully known; a child that is `working` is not, and must not be given a number
that implies otherwise.

### Decision 1 in practice

`elements-task-card.tsx` is vendored byte-identical, per the frozen-train rule
that vendored elements are wrapped and never forked. All TBAi-specific logic
lives in an adapter beside it, so a future upstream change is a re-vendor rather
than a merge.

---

## 7. The plan

Ordered so each phase is useful alone and none depends on a later one being
approved. Files are named per the repo's one-feature-one-module rule.

### Phase 0 — the capture, before anything is built

Two facts the whole plan rests on are **unverified in TBAi**:

1. that a subagent tool part carries `metadata.sessionID`
2. that a child's permission request reaches TBAi's permission store

Both are read from OpenChamber's reader, not observed here. A few minutes of
driving one real delegated turn either confirms the plan or invalidates Phase 1's
transcript and all of Phase 2. **Nothing should be built before this runs**, and
it costs almost nothing.

- Record whether `metadata.sessionID` appears on the subagent part
- Record whether a child's permission request is visible to TBAi at all
- Record what a child session's `session.context()` and `session.stats()` return
  for a real run, so Phase 0 is designed against observed shapes rather than a
  reader's guess at them

If (1) is false, Phase 1 loses its transcript and Phase 2 loses its rows, and the
plan needs rewriting rather than adjusting. That is worth ten minutes to find out.

### Phase 1 — make child sessions addressable (the foundation)

Nothing above this line is possible without it, and it is smaller than it sounds:
the client methods already exist.

- New `web/src/features/opencode/v2ChildSessions.ts` — one module owning child
  lookup. Its whole job: given a parent session id, return the children via
  `client.session.list({ limit: { parentID } })`, plus each child's live status
  and cost. **No new dependency, no new endpoint, no new server code.**
- New `v2ChildSessions.test.ts` — children are found by `parentID`; an empty list
  is an empty list, not an error; a malformed entry is dropped rather than
  throwing.

**Why this is its own phase:** every other phase reads through it, and it is the
only phase that changes what data TBAi holds. It can ship and be ignored.

### Phase 2 — the card tells the truth

**What changes for a reader:** the card gains a state icon, a duration, a
collapsible list of the subagent's own steps, and a result region. A blocked
subagent reads as **waiting** instead of as silence.

- Vendor `elements-task-card.tsx` byte-identical, per the frozen-train rule that
  vendored elements are wrapped, never forked
- New `web/src/tools/opencode/subagent-card.tsx` — the `TaskCard` adapter. It maps
  the tool part's status to `TaskCardState`, formats `elapsed` from the part's
  `time.ran`/`time.completed` (already carried for every tool part), and fills
  `children` from Phase 1's child steps, projected the way
  `buildTaskSummaryEntriesFromSession` does
- The gate path is untouched: `argPreview` still shows the prompt, because that is
  what a reader is being asked to allow
- New `subagent-card.test.tsx`, plus a registry update in `toolkit.ts`

**Depends on:** Phase 1 for the steps. Without it, ship the card with state,
elapsed and result and leave `children` empty — still an improvement, and honest.

**Critical:** the `waiting` state must be driven by a real signal, not by
"has been running a while". Phase 1 has to surface a child's pending permission
or the state is decorative. This is the one place where a plausible-looking
implementation would be a lie.

### Phase 3 — the management view

**What changes for a reader:** a Code-dock section lists every child session as
one row — title, state (**needs permission · asked a question · working ·
done**), cost. Clicking a row opens that child's session. It appears the moment
the first subagent starts and does not re-expand after you collapse it.

- **Extend the existing Code dock.** It already renders `OpenCodeSessionRow` and
  `OpenCodePermissions` in `OpenCodeView.tsx:291-294`. This follows the repo's
  "extend surfaces, never duplicate" rule and needs **no new route, no new
  surface, no new settings entry**
- New `web/src/features/opencode/OpenCodeSubagentsSection.tsx` — the section and
  its rows, modelled on OpenChamber's but built on Phase 1
- `SubagentList` is wired here, where each child's state is already known — and
  **not** earlier, since this is the first phase that could supply it honestly.
  See decision 2: a working child's progress is not known and must not be given a
  number implying otherwise
- One subscription for all children, not one per child
- Reuse the collapsed-section pattern already in the dock rather than inventing
  one

**This is the phase that changes what a reader can *do*.** Phases 1 and 3 are
polish; this is capability. It is also where the blocked-permission case stops
being invisible, which is the whole reason OpenChamber built the panel.

### Phase 4 — agent identity

Per-agent colour, so two subagents are tellable apart at a glance in both the card
and the section. The agent catalogue is already fetched for the agent picker
(`getOpenCodeCapabilities`), so this is reading a field that is already in hand.

- `color` from the agent definition, per the v2 docs
- Only if the catalogue actually carries it - **to be confirmed in Phase 0's
  capture**, not assumed

### Phase 5 — the guards

The two facts the whole plan rests on are **unverified in TBAi**:

1. that a subagent tool part carries `metadata.sessionID`
2. that a child's permission request reaches TBAi's permission store

Both are read from OpenChamber's reader, not observed here. The `be6f75a` lesson
is that a name-keyed assumption with nothing enforcing it fails silently and gets
filed as a missing feature. Phase 0 is the capture that settles them; this phase
is the part that must not be skipped afterwards:

- **One test per fact, each proved by breaking it** — the discipline the tool-UI
  tracker already uses, including the two cases where breaking revealed the
  mutation could not fail because the code turned out to be unreachable. A guard
  that cannot fail is not a guard, and two of mine were, until the mutation
  harness caught them.
- A guard for the child-session reader that fails when `parentID` filtering is
  removed, and one that fails when a malformed child entry starts throwing
  instead of being dropped.
- **No registry guard is needed.** `opencode-v2-tools.test.ts` already pins
  `subagent` as registered and as a v1 alias that must be **kept**, so the
  `be6f75a` failure mode cannot recur. Adding a second copy of that assertion
  would be duplication, not defence.

---

## 8. What this plan deliberately does not do

- **No new server route.** Everything is the client methods TBAi already has.
- **No new dependency.** `TaskCard`'s two imports are vendored already.
- **No agent-management page.** OpenChamber has one; TBAi's agent picking already
  reads OpenCode's catalogue, and a management UI is a separate feature.
- **No cost attribution beyond one level.** See decision 5.
- **Nothing is removed.** The existing `subagentView` is replaced, not deleted
  alongside.
