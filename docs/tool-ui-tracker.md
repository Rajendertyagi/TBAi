# TBAi Tool-UI Tracker

The single record of what is done, what is outstanding, and how each outstanding
item gets done. This replaces "read the code and reconstruct" as the way to find
out where things stand.

**Why this file exists.** `docs/tool-ui-atlas.html` is a good design-review
document, and it already carried status prose — `done:`, `Open:`, and a
`Not looked at yet` list. It was excluded from git by `.gitignore:76-84`, which is
the *right* call for its 3.8 MB of screenshots and the *wrong* call for its text:
the pixels are evidence for a decision already made, but the status is live state.
So the one document tracking this work was unversioned and unreviewable, and
three features shipped today with no record anywhere except the git log.

**The rule that keeps this true:**

> A change to a tool-UI surface updates its row in this file, in the same commit.

If a PR touches a tool card and not this file, the omission is visible in the
diff. That is the whole mechanism — no discipline required, just a row.

---

## Done

Each verified, with the evidence that proves it. Commit hashes are the proof; a
row without one is not done.

| Item | What changed | Evidence |
|---|---|---|
| Code fences bounded before highlighting | A settled fence is cut to a row/char budget *before* Shiki tokenises it. Honest note names what is missing and says copy still yields the whole fence. | `4dbdd2a` |
| One shared text budget | `web/src/lib/text-budget.ts` is the only place that answers "how much text may this paint". The terminal, diff, fence and tool-body budgets all flow from it. | `4dbdd2a` |
| Tool result bodies bounded | `Json` (behind every tool result, incl. `read_file`) was uncapped — it had a CSS `max-height`, which clips text already serialised and laid out. Now bounded pre-render, 11 call sites at once. | `e1cc7b9` |
| Silent 4000-char truncation removed | The browser tool sliced output at a hardcoded 4000 and said nothing, so a cut result looked like a complete answer. Now counted. | `e1cc7b9` |
| Hardcoded limits removed | `textPreview`'s literal 2000 and inline message, the dir and process listing caps. All in the shared config now. | `e1cc7b9` |
| Edit approval shows the real change | An edit gate answered "allow this?" with the model's Find/Replace text. It now shows the actual diff — removed and added lines — from the patch OpenCode already computes *before* running the edit. | `4cde8aa` |
| Tool duration badge | Elapsed time on the card, Direct and Code surfaces. | `fa8a3b2`, `369a14b` |
| Readable durations | Past a minute the badge stopped being `3618.8s`. Three ranges, zero-padded so the ticking value cannot change width. | `b2e48e5` |
| `write` gates show the diff | Verified live that a `write` permission carries a new-file unified diff, so no synthesis was needed. Content preview remains the fallback. | `b2e48e5` |
| One canonical `ApprovalCard` | Two components shared a name and one was dead. Documented which is canonical, plus a guard test — the vendored file is kept, because the train is frozen. | `b2e48e5` |
| Flat results render as rows | Six tools painted a JSON envelope for small flat objects. `FieldsOrJson` renders rows, falls back to bounded JSON when nested. | `b303dcd` |
| **Direct-chat edit gate shows a diff** | The gate that answers "allow this?" showed the model's Find/Replace text. It now shows the change, with surrounding context, from a read-only endpoint that is `runEdit` minus the write. No diff library added — the edit *is* the diff. Pair kept as the fallback. | `93ecc8b` |
| **`scheduler` is approvable** | A tool that creates and fires jobs unattended was ungated. Now gated per call: `list`/`get` answer freely, `create`/`update`/`delete`/`run_now` ask, and anything unrecognised asks. | this commit |
| **Question observability moved to the live card** | Four `question.*` events were logged only by a component nothing renders, so the contract passed while every real question was unloggable. Events moved to the live dock; 686 lines of dead code deleted. | `3fa4800` |
| **The timeline counts real files** | "N steps · 0 files changed" on every coding turn. The count was a missing *shape*, not a wrong number: the tool results carry no line counts, but the patch on every call does. Counts derived from the patch and published on the library's own `artifact` slot. | `288c263` |
| **`TodoList` was not a todo list** | The "three designs for one feature" finding counted a progress renderer as a todo renderer. It renders server-aggregated stages, not a plan. Renamed to `progress-stages` / `ProgressStages`. | this commit |
| **index-in-`key` refuted** | Re-derived per site: 10 candidates, 3 vendored (frozen), 4 skeletons with no identity, 3 stateless, 1 append-only log. The single real candidate is safe today for a specific, recorded reason. Nothing changed. | this commit |
| OpenCode configuration page | Read/edit permission rules, file-driven, no invented permission system. | `c371fc7`, `440a39d`, `f7a59f6` |

### How each was verified

- `typecheck` and `build` exit 0, re-run independently.
- Full unit suite. Baseline at the session start was **12 failures** (8
  session-model, 4 load-sensitive spellcheck timeouts). Still 12, same set,
  verified by diffing the failure lists — zero introduced.
- **Every guard was tested by deliberately breaking it.** A test that has never
  failed has not been shown to work. Five real defects were caught this way,
  two of them introduced by the same change that shipped with them:
  - a `children` prop that let a caller render unbounded text beside a correctly
    computed bound;
  - a character-budget window one unit too large, which dropped the last row of
    every over-budget body in full;
  - the lenient diff parser claiming a change that did not exist, as `+0 -0`;
  - a private copy of the character cap reintroduced into a tool module, which
    the single-source guard caught after `textPreview` moved;
  - emptying the scheduler read-action set, and separately deleting
    `question.accepted` — both caught, confirming the policy and the
    observability contract are pinned to *behaviour* and not to a file path;
  - the timeline's file count, broken at **both** ends — removing the published
    artifact, and making the reader ignore it. A test on either half alone would
    have passed while the number stayed at zero, which is how the bug survived.
- **Two of the carried-over findings were refuted by re-deriving them** rather
  than by acting on them: the "three todo renderers" and the "six index-in-`key`
  sites" items. Both had been corroborated only by a grep. Two of this audit's
  findings being wrong is itself the reason the rest were treated as claims to
  check instead of work to do — one of them (`R1` in the original audit) had
  already turned out to be wrong too.
- **Live browser verification for the edit gate**, with the test confirmed to
  fail when the gate is reverted. Re-confirmed 2026-09-30: the live Code-surface
  gate spec passes against a real server and a real model, and the real OpenCode
  config was verified restored afterwards.
- **A skip on setup is a skip on the test.** `seedConversation.ts` records the
  trap — specs that "skipped on every run while still reporting green". The live
  edit-gate spec had it in a subtler form: three distinct causes (no OpenCode
  server, config not editable, no `edit/*` rule) were collapsed into one `null`
  and skipped on any of them. Now only "no OpenCode server" skips; the other two
  **fail**, because they are regressions in the very API the spec depends on. The
  sibling config spec was checked and is already correct — it asserts the server
  responds, and skips only on genuine data conditions.
- **Where a surface could not be reached, the gap is named rather than implied.**
  Two live claims are not browser-verified and are called out where they are
  recorded: the Direct-chat gate's fetch-and-swap transition (a Direct gate needs
  a real model turn to exist), and the timeline's rendered label (it needs a live
  OpenCode session with a completed edit). Both are covered end to end in tests
  across the real modules instead.

---

## Fix next

Ordered. Nothing here needs investigation — that is the point.

### 0. ~~The two open questions from Tool coverage~~ — both done

- **The dead vendored `ApprovalCard` — DONE (`b2e48e5`).** An upstream element
  nobody imports, while an app-owned component of the same name carries every
  call. Resolved *without* deleting a vendored file, because the assistant-ui
  train is frozen: the element's header now states it is reference and names the
  successor, and a guard test proves it has no importers, names the shared card,
  and that the tool fallback imports the shared one. Verified by redirecting an
  import and watching the guard fail.
- **Is `scheduler` meant to be approvable? — DONE.** It was `display:
  "standalone"` but absent from `toolApproval`, with no comment explaining
  either, and a tool that creates and *fires* jobs unattended with the
  conversation's provider credentials is a real privilege. Gated now, per
  **call** rather than per tool, because `scheduler` is one tool with six
  actions and `toolApproval` is keyed by tool name — gating the whole tool would
  have prompted the reader to approve `list`, the call a model makes to answer
  *"what jobs are there?"*. The schema is a discriminated union on `action`, and
  AI SDK v7's tool-level `needsApproval` receives the input, so the decision is
  made where the discriminant is.

  - `list`, `get` — ungated. A read that changes nothing is not a privilege.
  - `create`, `update`, `delete`, `run_now` — gated. `run_now` is included even
    though nothing persistent changes: it executes a stored prompt immediately,
    on this machine, with those credentials.
  - **anything unknown is gated**, including an unreadable `action`. A new action
    added to the schema without a decision here stops and asks rather than
    inheriting the read-only trust. Validation rejects the call immediately
    afterwards either way, so gating costs nothing.

  Policy lives in `schedulerActionNeedsApproval` (`src/tools/index.ts`), exported
  so it is testable without a runtime — the alternative failure, silently
  ungating a new action, is invisible until a job fires on its own. Verified by
  emptying the read-action set and watching the test fail.

### 1. ~~Look at the three new surfaces~~ — DONE, no defects

Captured and inspected. The fence truncation note, the tool-body note, and the
diff in the edit gate were all correct: honest counts (`600 more lines` for a
2600-line fence against a 2000 budget), highlighting intact, prose untouched, and
the gate showing real `-`/`+` rows under a `+1 -1` header. A fourth surface
(`FieldsOrJson`) was captured and reviewed the same way — `delete_file` reads
`path / deleted: yes / wasDir: no` where it was previously JSON.

### 2. ~~Duration format for long spans~~ — DONE (`b2e48e5`)

`formatDuration` in `web/src/tools/elapsed.tsx`. Under a minute it keeps the
library's own `12.3s`; under an hour `2m 14s`; beyond that `1h 03m`, with
seconds dropped and the minute zero-padded so the ticking value cannot change
width. A real failed `shell` call rendered `3618.8s`; it now renders `1h 00m`.
OpenChamber has the identical line and the identical problem, so there was no
reference to copy and the shape is a decision.

### 3. ~~`write` approvals show a diff~~ — DONE (`b2e48e5`)

The five-minute probe answered it: **a `write` permission does carry
`metadata.files[].patch`**, as a proper new-file diff, `@@ -0,0 +1,5 @@`, every
line an addition. So no synthesis was needed anywhere in this app and no custom
diff code was written — the existing `patchToCodeDiffs` + `CodeDiff` path renders
it unchanged. The raw `content` argument preview stays as the fallback, because
`metadata.files` is optional.

### 4. ~~Flat tool results render as rows~~ — DONE (`b303dcd`)

`file_info`, `system_info`, `scheduler`, `delete_file`, `process_kill` and
`write_file` were painting a raw JSON envelope for what are all small flat
objects of named primitives. `FieldsOrJson` renders rows for the flat case and
falls back to the bounded JSON body for anything nested. See *Tool coverage*
below for the reasoning and the size of the thing.

### 5. ADRs — recorded below, pending a home in `docs/decisions.md`

The three decisions are written up in *Architectural decisions* at the foot of
this file. They are **not** in `docs/decisions.md` yet, and that is deliberate:
that file has 171 uncommitted lines from another agent mid-edit, and committing
it would capture a half-finished state of their work under this change. The
alternative — leaving the ADRs unwritten — is worse, and is why they are here
instead.
  (`@@ -0,0 +1,N @@`), which is what OpenChamber does. ~45 min.

No code before the probe answers.

---

## Open questions — carried from the atlas, never seen on screen

From `docs/tool-ui-atlas.html`'s "Not looked at yet" list. **Still unverified by
me** — read from the atlas, not confirmed against the running app. They lived
only in a gitignored file, which is why they are copied here; the `.gitignore`
entry now says so explicitly.

One of them was *partly* confirmed by the tool inventory, without being
deliberately checked: the "three separate designs for one feature" note. The
inventory found exactly three renderers for the same idea — the native `todo`
tool's hand-rolled checkbox list, OpenCode's `todowrite` compact row, and
`elements/todo-list.tsx` rendering a `data-tbai-progress` stream part. Three
designs, one feature, still true.

| Item | State | Note |
|---|---|---|
| **Todo list** | **Refuted — one name was lying** | "Three designs for one feature" counted a progress renderer as a todo renderer. Renamed. See below. |
| **A gap on the right** | **Measured, root-caused, unchanged on purpose** | 174px, and it is a design difference rather than a stray value. Your call, and it is now a one-line decision. See below. |
| **Dead code** | **Resolved — but not the way it looked** | The 376-line question form *was* dead, and deleting it exposed a bigger problem. See below. |
| **`0 files changed` in the coding chat** | **Fixed** | Structurally zero, and not because the count was wrong. See below. |
| **MCP tool output** | Unexercised | Buttons match the reference; a real MCP tool has never been run here. |
| **Focus does not follow the questions** | Matches reference | Stepping to the next question does not move the cursor into it. The reference app has the same gap, so we match rather than lead. |
| **Thinking / reasoning block** | Works | Only appears at thinking level `high`; at the default there is nothing, which looks broken but is not. |

### Three todo renderers — the third was not one, and it was named `TodoList`

The atlas said "three separate designs for one feature", and the tool inventory
corroborated it without checking: a native `todo` checkbox list, OpenCode's
`todowrite` compact row, and `elements/todo-list.tsx`. **One of those three does
not exist, and it was the one that broke the finding.**

`elements/todo-list.tsx` renders the `data-tbai-progress` stream part. It is not a
todo list and never was:

- The stages are **derived server-side by aggregating tool calls into semantic
  categories** — `list_dir` + `search_files` + `file_info` all collapse into one
  "Inspecting workspace" row, per `TOOL_STAGE_MAP` in `src/lib/progress-stages.ts`.
- Nothing in it is a plan the model authored.
- The **Direct** surface has no todo tool at all, so a component called
  `TodoList` implied a task list the engine never produces.

So the real shape is **one progress renderer and two todo renderers**, over two
data sources on two surfaces. Renamed to `progress-stages.tsx` / `ProgressStages`,
with the reason recorded in the file so the misnomer cannot come back as a finding.

The atlas also claimed none of the three "can be seen", because "the tool depends
on does not exist in this OpenCode build". That is right about OpenCode's
`todowrite` and **wrong about the progress renderer**, which is emitted from
`src/routes/chat.ts` and is live on the Direct surface. Worth stating plainly,
because "unreachable" is the kind of note that stops anyone from looking — and it
was wrong about the one renderer that is reachable.

**What was left alone, deliberately.** The two genuine todo renderers do overlap:
the Code transcript's `OpenCodeTodoWriteToolUI` and the Code dock's
`OpenCodeTodoTracker` both read the latest `todowrite` input. That is not
duplication, it is the same distinction already drawn for diffs: a tool card is
the **historical record** of a call, the dock is **current state**. Collapsing them
would delete one or the other, and the record is the more valuable of the pair.

#### An unresolved question found on the way: does the progress panel survive a reload?

While confirming the rename had not broken anything, the progress panel could not
be made to render from a **seeded** history message. What is established:

- The server **stores and returns it correctly** —
  `GET /api/conversations/{id}/messages` returns the `data-tbai-progress` part with
  its stages intact. Persistence is not the problem.
- The browser does not paint it. The message loads (its text renders), the part
  does not.
- **This is not caused by the rename.** The pre-rename component was checked out
  of git and registered in place of the new one, and it does not render either.
  That control is the reason this is reported as an open question rather than a
  regression.

What is **not** established, and why it matters: the real persistence flow is
"the client persists what the runtime holds at run start", so the shape a genuine
run stores may differ from a hand-written seed. I have been wrong before in this
exact shape of assumption — a seeded message cannot open a Direct-chat approval
gate, because that gate is produced by the AI SDK's approval flow during a real
turn. **Reporting "the progress panel disappears on reload" off a hand-written
seed would repeat that mistake.** The e2e stub provider streams text only and
issues no tool calls, so it cannot produce a run with stages either.

To settle it: one real turn against a real provider that makes a tool call, then
reload the thread. That is the test, and it is not written yet because it cannot
pass in this environment. Recorded rather than guessed.

### The 170px gap: measured, root-caused, and deliberately not changed

The atlas reported "your messages end 170px further right than the assistant's, in
every single exchange" and said "may well be deliberate". It was deliberate, and
the cause is a design difference rather than a stray number.

**Measured**, at a 1440px viewport, with text long enough that neither side is
width-limited by its own content:

| | width | aligned |
|---|---|---|
| message column | 1168px | — |
| message root | 1136px | — |
| both message inners | 966px | **opposite** |

966 is exactly 85% of 1136. Both sides carry `max-w-[85%]`; the user root is
`items-end` and the assistant root is `items-start`. So the two inners are the
*same width* and 15% of the root is empty on the assistant's right — 170px, plus
the column padding, measured at 174px. The gap is not a bug in a value. It is what
`85%` means when you apply it to two sides that face opposite directions.

**Why the reference app does not have it.** OpenChamber caps the **column** once —
`width: min(100%, 48rem)` (and `64rem` in wide mode), centred — and applies
`max-w-[85%]` to the **user bubble only** (`ChatMessage.tsx`). Both sides then
share one measure, so there is nothing to be asymmetric about.

**So there are two things here, and only one of them is the 170px.**

1. The gap. Cosmetically it is defensible — a filled card on one side, plain prose
   on the other, which is the pattern every chat app uses, and it is invisible on
   short messages because each side hugs its own edge.
2. The **measure**, which is the real problem and the one the gap was a symptom
   of. 966px of 14px text is roughly 120 characters per line. Comfortable prose is
   45–90. The reference's 48rem column is 768px, and it applies to both sides.

**Recommendation: adopt the reference's single column cap.** One cap, centred,
`max-w-[85%]` kept on the user bubble only. It removes the asymmetry and fixes the
measure in the same change, and it copies a decision rather than inventing one.

**Not changed, and this one is genuinely your call rather than a blocker.** It
narrows the whole transcript — on a 1440px screen the conversation goes from 1168px
to 768px, with visibly wider empty margins. That is a real cost, it is a taste
question with two defensible answers, and unlike the edit preview there is no
technical unknown hiding behind it. The investigation is finished; the decision
is one line: *narrow the column to 48rem, or keep the wide transcript and the
asymmetry?*

### "0 files changed" was a missing shape, not a wrong number

The timeline label said `0 files changed` on every single turn of a coding
session. The atlas recorded it as "structurally zero for a *different* reason"
than the Direct-chat case, and it was right that the reasons differ — but it
never said what the other reason was, so the item sat unfixed.

**The cause.** `toStats` reads `added` / `removed` off each tool's own result
object. OpenCode's `edit` and `write` outputs carry neither, and nothing in the
OpenCode path ever produced them. So the arithmetic was correct and the input was
always empty. A correct answer to an empty question is indistinguishable from a
lie, which is why it read as one.

The Direct-chat half of this was already fixed, and *correctly* — by gating the
timeline off in Direct mode entirely (`shouldShowSessionTimeline`), on the
reasoning that "M files changed" is OpenCode vocabulary and Direct results carry
no line counts at all. That left the coding surface, the only one that shows the
label, as the only place it could still be wrong.

**The data was never missing.** Every one of those calls already carries a
unified diff — the same patch the approval gate shows *before* the edit runs and
the completed card shows after. It has `+`/`-` rows, so it is countable, and the
app already has the counter (`patchToCodeDiffs`) because every diff on screen goes
through it. The number was simply never wired to the label.

**Where it now lives, and why `artifact`.** assistant-ui's `ToolCallMessagePart`
carries `artifact?: unknown`, documented as "UI-only artifact associated with the
tool result" — part of the official library type, and unused in this repo. That is
exactly this data: derived in the browser, never sent to the model, read only by a
renderer. No cast, no app-specific metadata channel. The alternative, writing the
counts into the tool's `result`, would have been a different kind of dishonesty:
inventing fields on a payload the tool never returned, in an object the card may
itself render.

**A stale comment, corrected.** `adapt.ts` claimed "`write` has NO patch at all
(a whole-file write has nothing to diff against)". The live payload says
otherwise — `write` sends `@@ -0,0 +1,N @@`, every line an addition, and a new
file is the *easiest* case to diff. The claim had been used as a reason not to
build this. Corrected in place, because a wrong comment that reads as a verified
finding is worse than no comment.

**The tests are a chain, deliberately.** They run the real projection and then the
real timeline reader, and assert on the label. A test on either half alone would
have passed while the number stayed at zero — which is precisely how this bug
survived. Both halves were mutation-checked: removing the `artifact` from the
producer, and making the consumer ignore it, each fail the suite.

Not browser-verified: the rendered label needs a live OpenCode session with a
completed edit, which is not seedable from the conversations API. The chain is
covered end to end in tests; the pixels are not claimed.

### The dead question form was hiding a live gap

The atlas recorded `shared/QuestionFormCard` (376 lines) as dead code, "safe to
delete, but deleting is your decision". It was dead: imported by nothing but its
own test, while the question dock above the composer draws
`features/opencode/V2FormCard`.

Before deleting, the `question.*` observability contract was checked, because
`observability-coverage.test.ts` pinned four events to that file. Two findings:

1. Those four events — `question.submitted` / `.accepted` / `.failed` /
   `.dismissed` — were logged **only by the dead component**. The live card
   logged none of them. So the contract was satisfied by a file nothing renders,
   and **every real question was unanswerable from the logs** — you could not
   tell a question the user skipped from one that failed to send.
2. Deleting the file without moving the events would have made the contract
   vacuous rather than honest.

So the events moved to `V2FormCard` (submit, accept, fail, and dismiss — a
dismissal is a decision, and it is the outcome an operator most often needs to
tell apart from a failure), the test now points at the file with the behaviour,
and the 686 lines of dead component and dead test were deleted. The guard was
verified to bite by removing `question.accepted` and watching it fail.

This is the general lesson, and it is why deleting "obviously dead" code deserves
the same suspicion as writing new code: the test pinning it was not guarding the
feature, it was guarding a **file path**.

---

## Needs a decision — do not start without one

These are not fixes. Each needs a judgement call first.
### ~~Direct-chat edit preview~~ — DONE (`93ecc8b`), and the reasoning was wrong

This was parked here as needing a maintainer decision, on the grounds that it
required a new dependency or hand-written diff code. **Both parts of that were
wrong, and the error is worth recording so it is not repeated.**

What was *right*: AI SDK v7's `ToolApprovalRequestOutput` carries only
`toolCall`, `reason`, and an HMAC `signature` binding them. There is no slot for
server-supplied data and the payload cannot be extended.

What was *wrong* is the conclusion drawn from it. It rules out putting the diff
**in the approval request**. It does not rule out the gate **asking the server
for it** — which is a thing the browser may do freely, and which the gate
already does for the outside-workspace check.

The second error was assuming a diff must be *computed*. It need not be.
`edit_file` is a contiguous string replacement, so the change is not something to
be discovered — it is already known. Which lines the match occupies and which
lines replace them were *handed to the function*. `previewEdit` emits a standard
unified patch from that, and the gate parses it with the existing
`patchToCodeDiffs`, exactly like every other diff in the app.

**No diff library was added, and none was needed.** An LCS diff would have
recovered information the function was given, and it is the riskier half:
quadratic on a large file, a new dependency, and for `replaceAll` a hunk whose
line numbers are only correct *after* the earlier matches are applied. So the
preview shows the **first** match exactly and reports the count, and the card
says how many places repeat. A plausible-but-wrong line number is precisely the
kind of lie this change exists to remove.

**The honesty problem I worried about did not materialise**, because the preview
is `runEdit` minus the write: same `resolveSafe` path check, same read, same
"`oldText` not found" failure. That parity is the property, and the tests assert
it directly — preview, then apply with the real `runEdit`, then confirm the
patch's added lines are what the file now says. The file is byte-identical after
a preview.

The Find/Replace pair is now the **fallback**, not the answer: endpoint refused,
file moved, text no longer matching, network down, unparseable patch — all of
them show the pair, because a gate must always show something the reader can
judge and a blank card is worse than the pair. What the pair cannot show, and
the reason the endpoint exists, is the surrounding context: it cannot show
whether the replacement lands where the author meant.

Also fixed here: `textPreview` moved out of `tools/filesystem/ui.tsx` into its
own module, because three modules use it and importing it back from a sibling
tool would have closed a cycle. And `previewFiles` is a pure function, so
"usable diff or fall back" is testable without a DOM — this repo has none under
`bun test`, and every component test renders through `renderToStaticMarkup`,
which captures only the first paint. A transition cannot be asserted that way,
so the decision that drives it was pulled out as a function rather than shipping
a DOM dependency to test three lines of branching.

**Live verification, 2026-09-30: the Code-surface gate spec PASSES.** Run with
`TBAI_E2E_LIVE=1` against a real OpenCode server and a real model — the log shows
the session form, the model selection, the prompt, the permission round-trip, and
the config write and restore. The real config was checked afterwards and `edit/*`
is back to `allow` with every deny rule intact, which is the one thing that had to
be true afterwards. An earlier run in this session appeared to skip because the
config arm had not taken; the cause was environmental, not the spec.

**What is NOT browser-verified:** the **Direct-chat** gate's fetch-and-swap
transition. A Direct-chat gate is produced by the AI SDK's approval flow during a
real model turn, so it cannot be opened from a seeded message — the same trap as
every other seeded attempt in this file. The Direct rendered result was captured
and inspected (context lines, red removal, green addition, `+1 -1`, Approve/Deny),
the endpoint is covered by five e2e tests against the running server, and the
diff-or-fallback decision is unit-tested — but the transition itself rests on two
lines of `useState` in front of a pure function. Stated rather than implied.

### Subagent transparency

A subagent call shows nothing of what it did. A real information gap, but a
feature rather than a defect.

### index-in-`key` — re-derived, and the finding as stated does not hold

This was carried as "six app-owned sites, mechanically fixable **if** the finding
is real", with a note that it had never been independently re-derived and that
another finding from the same audit had turned out wrong. Re-derived now. The
audit found 10 sites; **one** is worth a comment and **none** is worth a change.

| Site | Verdict |
|---|---|
| `surfaces.tsx`, `terminal-block.tsx`, `code-diff.tsx`, `web-search.tsx` | **Vendored.** The assistant-ui train is frozen, so these are not ours to change. Two of them already key on content (`${i}-${line}`, `${cycle}-${result.domain}`). |
| `Sidebar.tsx`, `JobDetail.tsx`, `SearchResults.tsx` | **Skeleton placeholders** — fixed-length `animate-pulse` divs. There is no identity to key on; the index *is* the identity. |
| `LogsPanel.tsx:731` (other) | **Append-only log lines.** Never reordered or removed, so an index is not merely acceptable but correct. |
| `directory-browser.tsx:62` | **Stateless breadcrumb spans.** Navigation changes the list, but each row holds no state, so React reusing a node by index produces correct output. |
| `ChatWindow.tsx:466` | **Stateless metadata chips** (`12t`, provider, model, `thinking:high`). The chip list grows as data arrives; the rows carry no state, only text and a `title` attribute. |
| `McpPanel.tsx:617` | **The one genuinely live list** — recent MCP events, reversed, growing as events arrive, so every index shifts. Still correct output: stateless rows. |
| **`LogsPanel.tsx:731` (targets)** | **The only real candidate.** See below. |

**Why the candidate is still safe today.** It is the one row that is not
stateless: a controlled `<Input>` and a Radix `<Select>` per target override, in a
list whose remove button filters by index — so removal from the middle is
possible, and Radix `Select` carries meaningful internal state (open, highlighted).

It does not misbehave for one specific reason: **removal is click-driven.** To
drop a row you must click that row's ✕, which moves focus to the ✕ first, so
focus is never sitting in a *different* row when the indices shift underneath it.
Both children are controlled, so React writes the new `value` correctly.

What would make it unsafe, and is worth knowing before writing any of it:
reordering the rows, removing a row from *above* the focused one, or making
either child uncontrolled. If that ever happens, the fix is a stable id on the
target — **not** a content-derived key, since the key would change as you type
and remount the input mid-keystroke. Adding an id means a settings migration, and
it is not worth paying for a bug that cannot currently occur.

**Nothing changed.** Six of the ten are not ours or have no identity, three render
correctly, and the last would need a data-model migration to guard against a
future edit. Recording the reasoning is worth more than a mechanical sweep — the
sweep would have churned a frozen dependency and a settings schema to fix nothing.

---

## Tool coverage — all 28 registered tools

Authoritative count, read from `web/src/tools/toolkit.ts`: **15 native + 13
OpenCode = 28 registered tool names.** Every entry is `type: "backend"` —
render-only, name-keyed. The registry is the single boundary; MCP and dynamic
tools are deliberately *not* registered and fall through to `ToolFallback`.

### The four shapes, and which element is the right fit

Every card is one of these. Naming the shape first is the point — most "which
element should this use" questions are answered by picking the right shape.

| Shape | Best-fit element | Used by |
|---|---|---|
| Live/completed CLI output | **`TerminalBlock`** (vendored) | `run_command`, `bash`, `shell` |
| A file change, decided or recorded | **`CodeDiff`** (vendored) | `edit` |
| A web-search result | **`WebSearch`** (vendored) | `websearch` |
| Everything else | **`ToolFallback`** (vendored) | MCP, unknown names |
| A fenced code block in prose | **`MarkdownText`** + bounded highlighter | all message text |

### Native (15)

| # | Tool | Card shows today | Shape | Gated |
|---|---|---|---|---|
| 1 | `read_file` | `BoundedBody` of file content | body | no |
| 2 | `list_dir` | hand-rolled `📁/📄` rows, capped | body | no |
| 3 | `search_files` | hand-rolled `path:line` + snippet rows | body | no |
| 4 | `file_info` | `Json` | body | no |
| 5 | `write_file` | `FieldsOrJson` rows; gate previews raw content | rows | **yes** |
| 6 | `edit_file` | `FieldsOrJson` rows; gate previews Find/Replace | rows | **yes** |
| 7 | `delete_file` | `Json` | body | **yes** |
| 8 | `run_command` | **`TerminalBlock`** `variant="ink"` | terminal | **yes** |
| 9 | `process_list` | hand-rolled `name (pid)` + MB rows | body | no |
| 10 | `process_kill` | `Json` | body | **yes** |
| 11 | `system_info` | `Json` | body | no |
| 12 | `scheduler` | `Json` — one uniform envelope for 5 actions | body | no |
| 13 | `todo` | hand-rolled checkbox list | body | no |
| 14 | `browser` | `BoundedBody` of stdout/stderr | body | no |
| 15 | `browser_action` | same | body | **yes** |

Six native tools gate via `toolApproval` in `src/routes/chat.ts:525-532`:
`write_file`, `edit_file`, `delete_file`, `run_command`, `process_kill`,
`browser_action`.

### OpenCode (13)

Gating differs: OpenCode emits its own `permission.asked` events, projected onto
the tool part as an assistant-ui `approval` with `allow-once` / `allow-always` /
`reject-once` options. A catch-all `ask` rule means most calls hit a gate.

| # | Tool | Card shows today | Shape | Gated |
|---|---|---|---|---|
| 16 | `read` | `ResultBody` `<pre>` | body | in practice |
| 17 | `glob` | `ResultBody` | body | in practice |
| 18 | `grep` | `ResultBody` | body | in practice |
| 19 | `bash` | **`TerminalBlock`** `variant="ink"` | terminal | **yes** |
| 20 | `shell` | same component as `bash` | terminal | **yes** |
| 21 | `edit` | **`CodeDiff`**, gate shows the *pending* diff | diff | **yes** |
| 22 | `write` | `ResultBody`; gate shows the **new-file diff** | diff | **yes** |
| 23 | `task` | `ResultBody`; gate previews the prompt | body | no |
| 24 | `todowrite` | compact row + count | body | no |
| 25 | `webfetch` | `ResultBody` | body | in practice |
| 26 | `websearch` | **`WebSearch`** + provider caption | web | in practice |
| 27 | `skill` | `ResultBody` | body | no |
| 28 | `question` | read-only receipt; answered on the question dock | body | n/a |

### The available element set — 23 modules

**Vendored (18)** — keep byte-identical to upstream; wrap, never fork:
`code-diff`, `terminal-block`, `tool-fallback`, `tool-group`, `tool-timeline`,
`web-search`, `approval-card`, `context-display` (+`.aui`), `reasoning`
(+`.aui`), `shiki-highlighter` (+`.aui`), `markdown-text`, `mermaid-diagram`
(+`.aui`), `tooltip-icon-button`, `surfaces`.

**App-owned (5)** — these exist *because* something could not be done upstream:

| Module | Why it exists |
|---|---|
| `code-budget` | Bounding a fence before Shiki tokenises it; no upstream option |
| `mermaid-source` | Repairs the `graph TD;` header models emit, without forking |
| `session-timeline` | Maps all 28 tool names to verb+icon for `ToolTimeline` |
| `progress-stages` | Renders TBAi's own `data-tbai-progress` contract. **Was `todo-list` / `TodoList`, and the old name was wrong** — see *Three todo renderers* below. |
| `thread-boot-skeleton` | Shared history-pending placeholder, both surfaces |

### Coverage verdicts

**Result bodies — all 28 covered.** Every path that paints tool output now goes
through `BoundedBody` → `text-budget.ts`. This was the broad fix (`e1cc7b9`).

**Structured data - CLOSED (`b303dcd`).** `file_info`, `system_info`, `scheduler`,
`delete_file`, `process_kill` and `write_file` all render a raw `Json` envelope.
That was the weak spot: *bounded*, but bounded-and-ugly - a machine payload where
key/value data belonged. There is no vendored element for structured tool output,
so this needed app code, and `FieldsOrJson` is the smallest thing that does the
job: rows for a flat object, the existing bounded JSON body for anything nested.
`delete_file` now reads `path / deleted: yes / wasDir: no`.

`dirSummary` and `processSummary` are the same idea with custom layouts and were
left alone on purpose - converting them means moving proven, visually tuned
layouts, and this change is additive.

**Two findings worth deciding on:**

1. **The vendored `elements/approval-card.tsx` is imported by nothing.** The
   shared wrapper `components/shared/approval-card.tsx` defines its *own*
   `ApprovalCard` - same name, different component, no import between them. So
   an upstream element is vendored and dead while an app-owned one carries the
   name. **RESOLVED (`b2e48e5`)** - the vendored file stays (the assistant-ui
   train is frozen) and its header now states it is reference and names the
   successor, with a guard test proving it has no importers.

2. **`scheduler` is `display: "standalone"` but is not in the `toolApproval`
   map.** No comment explains it, and standalone normally means the card manages
   its own layout. **RESOLVED** — it is now gated per *call*, not per tool, via
   the tool-level `needsApproval` and the schema's `action` discriminant, so
   `list`/`get` answer without a prompt and `create`/`update`/`delete`/`run_now`
   do not. See *Fix next* item 0 for the full policy and why the per-tool option
   was rejected.

3. **A `question.*` observability contract was pinned to a file nothing
   rendered.** `observability-coverage.test.ts` required four lifecycle events
   from `shared/QuestionFormCard`, which no production code imports; the live
   question dock draws `features/opencode/V2FormCard`, which emitted none of
   them. The guard passed and the behaviour was absent. **RESOLVED** — the events
   moved to the live card, the test points there, and the dead component is
   deleted. The lesson is in *Open questions* below: a test that pins a **file
   path** is not guarding a feature.

---

## Architectural decisions

Written up here rather than in `docs/decisions.md` — see *Fix next* item 5 for
why. They are ADR-shaped and should move there when that file's in-flight edits
land.

### One module owns every rendered-body limit

`web/src/lib/text-budget.ts` is the single answer to "how much of this text may
this paint", and the terminal, diff, code-fence and tool-body budgets all flow
from it.

**Why.** Each surface had answered differently — some with a limit, some with a
CSS `max-height` (which clips text already serialised and laid out), and the
browser tool with a hardcoded `slice(0, 4000)` that told the reader nothing at
all. A second rule invented per surface is the failure mode, so the rule lives in
one place and a new body consumes it rather than restating it.

**The part that is not obvious:** a CSS height cap is not a bound. It clips text
that has already been paid for. The bound has to land on the data.

### A gate shows the change under decision, not the tool's description

An edit or write approval renders the diff — from the patch OpenCode computes
*before* running the tool and ships with the permission request. No diff is
generated in this app, and none needs to be.

**Why the old pin was wrong.** `ui.test.ts` asserted the gate must show
Find/Replace and must NOT show a diff, reasoning that "the user would be
approving a change that has not happened yet". That has it backwards: the change
not having happened is the entire reason a gate exists. Find/Replace omits the
surrounding context, so it cannot show whether the replacement lands where the
author meant — which is what a reviewer is judging.

**The distinction that must not be collapsed:** `pendingPatch` describes the
future and belongs to the gate; `diffPatch` describes the past and belongs to the
completed card. They used to share a slot.

**Cost of being wrong here was measured, not assumed.** The first wiring put the
budget in `markdown-text.tsx` and it did nothing, because `ChatWindow` passes its
own highlighter and a caller's `components` prop is spread last. Typecheck, build
and the entire unit suite were green.

### TBAi's own message metadata, not an extended library type

The pending patch travels as `metadata.custom.opencode.pendingPatches`, keyed by
tool call — the same place the completed patch already lived.

**Why.** assistant-ui's tool part has no slot for it. `ToolApprovalDisplay` is a
mode enum (`"decision" | "select" | "text"`), not content. Bolting an extra
property onto a closed library type would need a cast, which the repo forbids.
TBAi's own metadata is free, already read by the renderer for the completed
patch, and keeps the library type untouched.

### The edit gate asks the server for the change; it does not compute it

`previewEdit` (server) is `runEdit` minus the write, and the Direct-chat gate
fetches it from `/api/tools/edit-preview` when the gate opens. It renders
through the app's existing `patchToCodeDiffs` + `CodeDiff`. **No diff library was
added and no diff algorithm was written**, on either side of the wire.

**Why not a diff dependency.** This was the decision that blocked the work for
several sessions, and it was decided on a false premise. The constraint was real
— AI SDK v7's `ToolApprovalRequestOutput` is HMAC-signed with no metadata slot —
but that rules out the diff travelling *in the approval request*, not the gate
*requesting* it. A second error compounded it: assuming the diff had to be
computed. For a contiguous string replacement the change is already known, so an
LCS diff would have re-derived what it was handed, at quadratic cost and with a
new dependency.

**Why the preview is honest where a "prediction" would not be.** The concern was
that `runEdit` re-reads the file at execution, so a preview could describe a
change that no longer applies. That is real for any preview, and it is why the
preview is defined as *the same function with the write removed*: same
`resolveSafe` check, same read, same failure conditions. The tests assert the
parity against the real `runEdit` rather than against expected patch text, so a
divergence between "what is shown" and "what will happen" is a test failure
rather than a surprise.

**Why only the first match, for `replaceAll`.** Occurrence *n* sits at line
numbers shifted by the edits before it, so a hunk for the fifth match would
carry a location that is only correct once the first four are applied. Printing
it would be a plausible-looking lie in the exact place the user is asked to
trust. So the preview shows the first match and reports the count.

**The general lesson, recorded because it generalises.** When a step is blocked,
check *which* step. Here the real block was "the browser may not receive
server-computed data inside a signed envelope", and the thing being built was
"the browser may receive server-computed data". Those are different problems, and
conflating them cost more than the work did.

**Verified against the live server before any of it was built.** The question —
does OpenCode send a precomputed patch on a *pending* permission — was the whole
premise, and it was answerable in five minutes by driving the server. It was, for
both `edit` and `write`.

---

## House rules learned here

Worth keeping, because each one cost a round trip:

- **Verify the premise before building on it.** The whole edit-approval fix hinged
  on one question — does OpenCode send a pre-computed patch? — answerable in five
  minutes against the live server. It was answered first, and the fix was then
  mechanical. Contrast with the Direct-chat path, which looked identical from the
  outside and is not.
- **Do not let a bound be bypassable.** A `children` prop on a bounded component
  let the full unbounded payload paint beside a correct budget and a marker.
  Remove the prop; do not document it.
- **A test that has never failed is not a test.** Every guard added here was
  verified by breaking the thing it guards.
- **Parse leniently for a log, strictly for a decision.** The diff parser returns
  a "file" for a line of prose — right for a completed card, wrong on a gate,
  where it claimed a change that did not exist.
- **Seed the file under test.** A model asked to edit a file that does not exist
  goes looking instead, and the turn ends with no edit proposed — indistinguishable
  from the feature being broken. This cost one false failure.
- **The live browser test must be shown to fail.** Passing on the first run after
  a change to the render path is not evidence.
