# TBAi Direct - Compaction Behaviors Plan (SUPERSEDED)

**Date:** 2026-10-04
**Workstream:** TBAi Direct only (no Code/OpenCode)
**Status:** SUPERSEDED 2026-10-05 - shipped and browser-verified; see the as-built record below and `docs/decisions.md`
**Baseline at time of writing:** `typecheck` 0 · `lint` 0 · `build` 0 · `3824 pass / 23 skip / 0 fail` (3847 tests, 278 files)

---

## As built — status at 2026-10-05

**All three changes below shipped and were browser-verified.** This file is kept as the
historical plan. `docs/decisions.md` is the source of truth for what was decided and why;
where this plan and the shipped code disagree, the code and `decisions.md` win.

Two things shipped that this plan never asked for, and three places where the
implementation deliberately diverged. Both matter to anyone reading this file.

### Shipped, absent from this plan

| Addition | Where | Tests |
|---|---|---|
| Direct `/compact` slash palette | `web/src/features/chat/directCompactEntries.ts`; `commandNameOf` in `compactCommand.ts` | `directSlashPalette.test.ts` (19) |
| Summary adequacy floor + transcript fencing | `src/context/compaction/summarize.ts` | `runtime.test.ts` (+15) |

The palette also fixed a real defect found while testing it: the row was handed the
command **token** (`/compact`) where the palette API expects the sigil-less **name**
(`compact`), so selecting it inserted `//compact`, which matched no command and was sent
to the model as an ordinary message.

The adequacy floor closed a live data-loss bug: a span ending
`Reply with just the word ok.` / `ok` summarised to the literal string `ok`, and
compaction applied it — 41 messages replaced by two characters, durably.

### Divergences — deliberate, each recorded in `docs/decisions.md`

| Plan said | Shipped | Why |
|---|---|---|
| Collapsed label carries counts: `Context compacted automatically · 12 messages · 4.2k → 900 tokens` | `Context compacted`; counts live only in the expanded panel | One quiet line. `compaction-divider.test.tsx` now forbids counts in the label |
| "id-keyed expand state survives a refresh" | `useState(origin !== "manual")` | Id-keyed module state grows without bound; forgetting which divider was last open is the cheaper failure |
| Outer `Popover` wrapping the ring + new `ContextPanelContent.tsx` | Optional `action` node inside the vendored `ContextDisplayContent`; that file was never created | The planned approach **did not work** — the ring's inner tooltip trigger consumed the click, so the panel could never open. It passed every test. Found only by clicking it in a browser |
| In-flight marker "in the button row" | Own `role="status"` line between the textarea and the button row | Announced to assistive tech, and out of the click path |

### Stale references in the body below

Treat as historical. Evidence line refs have moved (`Composer.tsx:553-583`;
`ChatWindow.tool-output-once.test.ts` `:135`/`:142`, now `:121-128`). The test inventory
is out of date: `manualCompactPersistence` 6 → 13, `compaction-divider` 6 → 16,
`compactCommand` 51 → 59. `context-meter` (23) still matches.

The baseline at time of writing (`3824 pass / 23 skip / 0 fail`) no longer describes the
suite, which carries pre-existing failures unrelated to this work: 12 in
`src/services/opencode` (they spawn the real `opencode.exe`), and 11 in
`tests/integration` (`workspace.test.ts` cross-file interference plus the Ollama SSE
spike).

### Still true

The "Must not regress" section held. `src/db/index.ts` and
`src/context/compaction/contract.ts` are untouched, so the schema and the
`applyCompaction` splice are unchanged, and `summarizeSpan` still has a single call site
(`src/context/assemble.ts:515`). The non-goals were respected: no summary persisted as a
message, no operation table, no retry, no Code/OpenCode change.

---
## Objective — user-visible

Three behaviors, in the order a user meets them.

1. **After anything compacts, you can read what it kept.**
   Click the divider → the summary text is there.
   Today the transcript says only "Context compacted automatically". The summary is
   produced and stored, then never shown — so a compaction that removes conversation
   history cannot be audited by the person whose history it removed.

2. **While `/compact` runs, something happens.**
   Today the composer waits silently for up to 30 s (the summariser ceiling), then the
   divider appears. A transient indicator shows immediately instead.

3. **The composer shows its context on demand.**
   Click the ring → occupancy vs window, where the limit came from, how much is cached,
   and a "Compress now" action.

**Scope:** three small changes. No new table, no migration, no new endpoint, no new
message part type, no ZCode field mirroring.

---

## Current state — evidence

**Evidence classes:** **R** repository-verified · **T** test-verified · **I**
route/integration-verified · **B** browser/live-verified · **S** ZCode source-verified ·
**U** unknown.

**ZCode is available locally at `D:\Temp\ZCode`.** Every **S**-class claim below is
line-verifiable in this environment — the files exist and the cited ranges are within
file lengths. A later pass should confirm line *contents*, not just that the paths resolve.

**Reference trees:** ZCode `apps/zcode-cli/packages/` (not `packages/` at the repo root);
TBAi tests `bun test <path> --isolate`.

| Fact | Class | Location |
|---|---|---|
| `CompactionReport` carries `summaryTokens` but **not** `summaryText` | **R** | `src/context/types.ts` |
| Summary text is produced and stored in `conversation_compactions.summary_text` | **R** | `src/context/compaction/orchestrate.ts` |
| Each compaction writes **its own** divider row; row id derives from `operationId` | **R** | `src/routes/direct-compact-command.ts:290` |
| Assembly synthesises the summary from the record via a pure splice | **R** | `src/context/compaction/contract.ts:663,685` |
| `conversation_compactions` is a single rolling row keyed by `conversation_id` | **R** | `src/db/index.ts` |
| `/compact` gives no feedback during the summariser call | **R** | `web/src/components/Composer.tsx:553-583` |
| `runDirectCompact`, `buildDividerPart` already exist | **R** | `web/src/features/chat/compactCommand.ts` |
| `ui/popover.tsx` exists; `ui/hover-card.tsx` / `ui/progress.tsx` do not | **R** | `web/src/components/ui/` |
| `radix-ui@1.6.7` exports `HoverCard` | **R** | installed package |
| AI SDK v7 usage is aggregate-only — no per-source attribution | **R** | `LanguageModelUsage` |
| assistant-ui has no compaction primitive and no context-window or budget accounting | **R** | sweep of `@assistant-ui/core@0.3.19`: zero hits for `compaction\|contextWindow\|tokenBudget\|tokenUsage` |
| ZCode also does not render the summary in its transcript | **S** | `ConversationRowView.tsx:1761-1782` |

---

## Change 1 — the summary becomes readable

### Design

Each divider carries **its own** summary, embedded at write time.

This is the only correct option. Reading it back on click is wrong: because
`conversation_compactions` is a single rolling row keyed by `conversation_id`, it holds
only the **latest** summary — an older divider would display the wrong text.

Because the divider row is written per operation, at compaction time, when the text is
already known, embedding is correct by construction: survives reload, needs no lookup,
has no race, and creates no second source of truth.

### Flow

```
/compact ──▶ summariser ──▶ record persisted ──▶ divider written WITH summary
                                                     │
                              hard reload ───────────┘
                                     ▼
                        divider replays from SQLite, same text
```

### Changes

| File | Change |
|---|---|
| `src/context/types.ts` | `CompactionReport` gains `summaryText: string \| null` |
| `src/context/compaction/orchestrate.ts` | carry `summary.summaryText` onto the outcome |
| `src/context/assemble.ts` | propagate into the report the seam publishes |
| `src/routes/direct-compact-command.ts` | `summary` on the divider payload; `buildDividerStoredContent` stores it |
| `src/routes/chat.ts` | `compactionPart()` includes it — covers automatic **and** recovery |
| `web/src/features/chat/compactCommand.ts` | `summary` on `DirectCompactStatus`; `buildDividerPart` carries it; the SSE status parser reads it |
| `web/src/components/assistant-ui/elements/compaction-divider.tsx` | expandable |

### UI

Collapsed — unchanged line, plus counts:

> ─── Context compacted automatically · 12 messages · 4.2k → 900 tokens ───

Expanded, on click, same width:

> **Summary of the compacted turns**
> The user asked about X, then Y. We established Z…

- Toggle, not a modal. `Marker` stays the container so the existing severity tone
  (`TONE[outcome]`) is preserved.
- Expand state is local component state. Nothing persisted, nothing sent.
- Absent summary — pre-change rows, or a `skipped`/`failed` outcome — renders
  **not expandable**, with no empty box.
- Divider ids are stable across reload, so id-keyed expand state survives a refresh.

### Tests

- Parser: divider `data` with and without `summary`
- Renderer: `compacted` + summary → expandable; `skipped`/`failed` → not expandable;
  missing summary → no empty state
- **Route**: manual `/compact` → the persisted divider row's part contains the summary
  text; exactly one divider row; reload replays it
- **Route**: automatic compaction → same
- **Route**: `summarize_failed` → divider present, **no** summary, no claim of compaction
- **Regression**: `web/src/components/ChatWindow.tool-output-once.test.ts` guards this.
  Two counting assertions in it matter here — one that the route assigns `instructions:`
  only from `conversation.systemPrompt`, one that the seam narrows it exactly once
  (`:135`, `:142`). Both must keep distinguishing the summariser system prompt from
  compaction narrowing.
- **Log guard**: a source-level assertion that `chat_compact_*` log fields carry counts,
  never the summary text (AGENTS.md forbids logging message text)

### Live verification

Browser: `/compact` on a long conversation → click the divider → summary text visible →
hard reload → click again → same text. Screenshot both states.

### Risks

| Risk | Mitigation |
|---|---|
| Summary text reaches a log line | AGENTS.md forbids it; add the source-level guard test |
| Row size growth | Summary is bounded by the existing summariser budget. Measure before/after on a long conversation |
| Existing status parsing breaks on the new field | Additive field; the parser ignores unknown keys. Covered by the existing `compactCommand.test.ts` (51 cases) |

### Non-goals

No durable lifecycle states. No operation table. No `phase`/`cause` axes. No retry. **No
summary persisted as a transcript message** — `applyCompaction`'s splice erases anything
inside the covered prefix, so it would be permanently invisible to the model.

---

## Change 2 — feedback while compacting

### Design

Local Composer state. Deliberately **not** durable and **not** a message.

A durable lifecycle is the right long-term answer, but it needs an operation record.
A local flag delivers the actual missing behaviour — "the app is working" — in roughly
ten lines with no schema change and no server change.

### Changes

| File | Change |
|---|---|
| `web/src/components/Composer.tsx` | `compacting` state in `runDirectCompactCommand`: set before the await, cleared in `finally`; transient marker in the button row |

### Behaviour

- The marker appears immediately on submit and disappears when the divider lands.
- On transport failure the marker clears and the **composer text is retained** so a retry
  is possible. This is the existing ordering contract — do not invert it.
- Not persisted. Not a message. Nothing enters history.
- Uses the existing `ui/thread-running-dot.tsx` or plain muted text. No new component.

### Tests

- Source guard: the flag is set before the await and cleared in `finally` — prevents a
  stuck indicator on an unhandled throw
- Existing `manualCompactPersistence.test.ts` guards must stay green: `startRun: false`,
  no `fetch` / `appendStored` / `upsertStored`, composer cleared only **after** the append
- Failure path: text is retained

### Live verification

Browser: trigger `/compact`, screenshot **during** the summariser call showing the
indicator, then the terminal state.

### Risks

Low. The only real risk is a stuck indicator, covered by the `finally` plus its test.

---

## Change 3 — composer context panel

### Design

A shadcn **`Popover`**, click-triggered, wrapping the existing ring.

**Not HoverCard.** ZCode uses HoverCard and then hand-writes a touch workaround, because
Radix HoverCard swallows `click` on touch (`contextUsage.tsx:892-906`). Click-to-open is
the better interaction for a panel that contains a button, `ui/popover.tsx` already
exists, and the vendored ring already implements click-to-pin.

### Panel contents — all from data already published

| Row | Source |
|---|---|
| Occupancy | `usedTokens / windowTokens`, as a percentage |
| Window provenance | `windowSource` — reported by provider / set in this app / estimated / unknown |
| Cached portion | `cachedInputTokens / usedTokens` |
| Compress now | action |

**No contributor breakdown.** It would require new per-source accounting in
`assemble.ts`. AI SDK v7 reports aggregate usage only, so it cannot be derived from the
model call. Skipping it is the stable choice; the panel is genuinely useful without it.

### Changes

| File | Change |
|---|---|
| `web/src/components/context-ring.tsx` | wrap in `Popover`; keep `if (!serverContext) return null` |
| new `web/src/components/chat/ContextPanelContent.tsx` | presentational rows |
| `web/src/features/chat/compactCommand.ts` | reuse `runDirectCompact` — **no new transport** |

### Two hard constraints

1. **`directCapabilityAuthority.test.ts` forbids any `??` in `context-ring.tsx`** and
   requires the null guard. In a component whose denominator is a number, a `??` is
   indistinguishable from a substituted window. Satisfy the guard; do not relax it.
2. **"Compress now" must route through the existing send funnel** — the same path as
   typing `/compact` and pressing Enter. No second trigger, no second transport. It must
   produce exactly one compaction and exactly one divider row.

### Tests

- The panel renders nothing when there is no authoritative reading
- All four `windowSource` provenance strings render
- Cached percentage is hidden when `cachedInputTokens` is absent — never rendered as 0%
- **No `??` fallback** anywhere in the ring or the panel
- "Compress now" issues exactly one compaction

### Live verification

Browser: click the ring → screenshot the open panel over a live conversation showing
occupancy, provenance, and cached percentage. Click "Compress now" → exactly one divider
appears.

### Risks

| Risk | Mitigation |
|---|---|
| The panel becomes a second context authority | Display-only; every number comes from `useCurrentContext`, which reads the server's value |
| Panel drifts from the ring | Both read the one hook |
| New dependency creep | None — `ui/popover.tsx` already installed |

---

## Order

**1 → 2 → 3.** Changes 1 and 2 are small and independent. Change 3 is larger and benefits
from Change 1 already being visible in the transcript.

---

## Must not regress

Verified working today; all of this stays green.

- Manual `/compact`, `/compress`, `/compact <instructions>`
- Automatic compaction, and **repeated** automatic compaction — generation 1 → 2,
  coverage advancing, distinct operation ids, no duplicate rows
- Overflow recovery: retry gated on `compactionApplied === true`, one-attempt guard
  intact, **no divider on a no-op recovery**
- Exactly one durable divider row per operation; reload durability
- Context-ring authority: `resolveContextLimit` remains the only limit source; no 128k
  fallback anywhere in Direct; no `??`
- `conversation_compactions` schema **unchanged**; `applyCompaction` splice **unchanged**
- Code/OpenCode suites — **untouched**: `codeCompactConformance`, `compactSession`,
  `codeContextMeter`, `codeOccupancy`, `contextTokens`,
  `opencode-context-meter-runtime`, `code-budget`

Test files that must stay green — 33 files across `src/context/**`, `src/routes/**`,
`tests/integration/**`, `web/src/**`. The load-bearing ones:

`compaction.test.ts` (35) · `runtime.test.ts` · `seam.test.ts` · `budget.test.ts` (39) ·
`provenance.test.ts` (46) · `direct-manual-compact.test.ts` (15) ·
`direct-a1-certification.test.ts` · `direct-compact-command.test.ts` (27) ·
`compactCommand.test.ts` (51) · `context-meter.test.ts` (23) ·
`manualCompactPersistence.test.ts` (6) · `directCapabilityAuthority.test.ts` ·
`compaction-divider.test.tsx` (6)

---

## Validation

1. Targeted: `direct-manual-compact`, `direct-a1-certification`, `direct-compact-command`,
   `compaction-divider`, `compactCommand`, `context-meter`,
   `manualCompactPersistence`, `directCapabilityAuthority`
2. `bun run typecheck` → 0
3. `bun run lint` → 0
4. `bun run build` → 0
5. `bun run test` → full suite, actual counts recorded
6. Browser: all three live verifications above, with screenshots

**Baseline to beat: 3824 pass / 23 skip / 0 fail (3847 tests, 278 files).**

---

## Not doing

- Durable `started → retrying → terminal` lifecycle — needs an operation table. Later.
- Operation retry — ZCode has none, and TBAi's summariser deliberately rejects
  over-budget output rather than truncating it (`summarize.ts:18`)
- Contributor breakdown, partial compaction, micro-compaction, session-memory compaction,
  policy-layer separation
- A persisted circuit breaker — ZCode's is in-process only
- Any summary persisted as a transcript message
- Any change to Code/OpenCode compaction

## Known unverified — unchanged by this plan

- **Overflow recovery in a live browser.** Proven at route level only; no real provider
  overflow has been observed in the app.
- **Two automatic dividers rendered simultaneously.** Proven in the durable store
  (`generation` 1 and 2, distinct operation ids, advanced checkpoint) but never observed
  on screen at the same time.

Neither may be reported as fixed without new evidence.

---

## Appendix A — library audit

Verified this session so it is not re-derived.

### assistant-ui `@assistant-ui/react@0.15.20` + `@assistant-ui/core@0.3.19`

`primitives/` = actionBar, actionBarMore, assistantModal, attachment, branchPicker,
chainOfThought, composer, error, message, messagePart, queueItem, reasoning,
selectionToolbar, suggestion, thread, threadList, threadListItem, threadListItemMore.

**Sweep for `compaction|contextWindow|tokenBudget|tokenUsage` across all of
`@assistant-ui/core` → zero hits.**

| Need | Primitive | Verdict |
|---|---|---|
| Divider part | `makeAssistantDataUI`, `AssistantDataUIProps`, `DataMessagePartProps`, `useMessagePartData` | **Use — already used correctly** |
| Operation lifecycle | `MessageStatus` | **Not usable** |
| Raw provider usage | `useThreadTokenUsage`, `getThreadMessageTokenUsage` (`@assistant-ui/ai-sdk`) | **Aggregate only — not a substitute for `useCurrentContext`** |
| Context-window / budget accounting | *nothing* | None exists |
| Compaction primitive | *nothing* | None exists |

### Two accounting hooks, and why the plan uses ours

`useThreadTokenUsage` (`@assistant-ui/ai-sdk/dist/usage.d.ts`) reads the newest assistant
message's usage out of `metadata.custom` — the same metadata our `useCurrentContext` reads.
But it returns only `{ totalTokens, inputTokens, outputTokens, reasoningTokens,
cachedInputTokens }`.

It has **no window, no provenance, and no per-source attribution**. `useCurrentContext`
returns the server-resolved window, its provenance, occupancy, cached input, and the
`resolvedFor` binding that suppresses stale readings. So the panel reads
`useCurrentContext`; the library hook is strictly less information about the same data.

This also settles the contributor-breakdown question with evidence rather than
assumption: **even the library's own token hook is aggregate**, so a per-source breakdown
cannot be derived from either source. It would require new server-side accounting, which
is why Change 3 omits it.

`MessageStatus` is the trap — **four** variants, not three:

```ts
type MessageStatus =
  | { readonly type: "running" }
  | { readonly type: "requires-action"; readonly reason: "tool-calls" | "interrupt" }
  | { readonly type: "complete"; readonly reason: "stop" | "unknown" }
  | { readonly type: "incomplete";
      readonly reason: "cancelled" | "tool-calls" | "length" | "content-filter" | "other" | "error";
      readonly error?: ReadonlyJSONValue }
```

It does carry error and cancellation reasons, so the earlier "no error variant" reading
was wrong. The rejection **still stands on a different and stronger ground**: it models
*message streaming*, not *operation progress*. Every variant is scoped to one message
reaching a terminal state, whereas a `data-tbai-compact` part can be terminal while the
message containing it is still streaming. There is also no `started`-then-terminal
transition, no attempt counter, and no way to hold a state across two requests — which is
what a compaction operation spanning a client round-trip requires.

### Two caveats on this sweep

- **`@assistant-ui/core` is a transitive dependency**, declared nowhere in
  `web/package.json`. It resolves through bun's store via `@assistant-ui/react`'s own
  `node_modules`. The sweep finding is valid for the installed version, but per AGENTS.md
  ("never rely on undeclared transitive dependencies") nothing may be *imported* from it.
  Read it for auditing; do not build on it.
- Test counts quoted elsewhere in this document are static `it(`-definition counts. Where
  a file uses `it.each`, the runtime count is higher — `budget.test.ts` is quoted as 39
  definitions and executes 44 cases.

**Checked and not applicable:**

- `useMessageStallDetection` — `unstable_`, deprecated. Detects stalled *streams*
  (`stalled`, `stalledForMs`, 2 s default). Not a status machine.
- `branchPicker` — `BranchPickerPrimitiveRoot/Previous/Next/Number/Count`. Navigation UI
  for sibling message variants. No persistence, no summarised prefix, no retained tail.
  Not a compaction model.
- `ModelContext` / `ModelContextRegistry` / `mergeModelContexts` — model-side instruction
  injection. Belongs to the memory workstream, not the panel.

### Other libraries

| Need | Use | State |
|---|---|---|
| Panel container | `ui/popover.tsx` | installed |
| Divider | `ui/marker.tsx` | installed |
| Segmented bar | plain `div`s | shadcn `Progress` has no `segments` prop, so adding it would mean overriding the indicator anyway |
| Cache gate, pin, reset | vendored `context-display` | already shipped |

`HoverCard` **is** available from `radix-ui@1.6.7`, re-exported through the package's
`./*` barrel (`dist/index.d.mts`: `export { reactHoverCard as HoverCard }`). Change 3 does
not use it — see the rationale above.

### ZCode, for reference only

`microcompact.ts` (threshold-triggered tool-result clearing, keep-recent-5, media guard,
≥256-token savings gate) and `policy.ts` (in-process circuit breaker at 3 consecutive
failures, cancellation excluded) are the two mechanisms TBAi does not have. Neither is
needed for the three behaviours above. ZCode's transcript also does not render the
summary text, so the divider behaviour in Change 1 is already beyond it.

---

## Appendix B — rejected approaches

Recorded so they are not re-proposed.

| Approach | Why rejected |
|---|---|
| Persist the summary as a `data-tbai-summary` assistant message | `applyCompaction` is a pure splice over the covered prefix. A summary message inside that prefix is spliced out of **every** request and can never reach the model. It would also be re-posted each turn and would enter `covered_message_ids`, perturbing the planner. |
| Fetch the summary on click | The rolling row holds only the latest summary, so an older divider would show the wrong text. |
| Reuse `MessageStatus` for compaction lifecycle | It describes message streaming, not operation progress, and has no error state. |
| ZCode `phase` / `compactReason` axes | Mirrors another codebase's data model without a behavioural need here. |
| Operation-level retry (`attempt`/`maxAttempts`) | ZCode has none — its `MAX_COMPACT_PROMPT_TOO_LONG_RETRIES` is a summariser-*input* narrowing retry. TBAi's summariser deliberately rejects over-budget output. |
| Persisted circuit breaker | ZCode's is in-process only. Persistence is a defensible divergence but needs its own decision record. |
| HoverCard for the panel | Radix HoverCard swallows touch `click`; ZCode carries a workaround for it. Click-to-open is better for a panel with a button. |
| Contributor breakdown | Needs new per-source accounting; AI SDK gives aggregate usage only. |
| `it.skip` for tracking unimplemented parity rows | `it.skip` does not fail a run — a skipped test is indistinguishable from a passing one in CI. If parity tracking is ever revived, use a failing count-budget assertion. |
