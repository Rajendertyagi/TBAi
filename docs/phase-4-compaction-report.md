# Phase 4 — Automatic summarisation / compaction: implementation and certification report

**Date:** 2026-10-01 · **Phase:** 4 · **Status:** CERTIFIED WITH RESIDUAL RISKS
**Architecture:** C — Hybrid explicit context assembly (unchanged from Phase 2)

This report was written under strict PM-audit mode: every claim below was
re-derived from source, from tests, or from measured runtime behaviour, and the
defects listed in §15 were found by that process rather than by review.

---

## 0. Summary

Phase 4 converts a hard failure into graceful degradation.

Before: a conversation that outgrew its budget was rejected outright with
`CONTEXT_OVERFLOW` (verified at `src/routes/chat.ts:412` in the pre-Phase-4 tree).
The user's only options were starting a new chat or switching model.

After: the same pressure triggers compaction — the settled span is replaced with
a bounded, provenance-carrying summary — and only a request that *still* does not
fit is rejected.

The seam still owns the decision. Compaction only reduces the input to it; it
never overrides accept / reduce / reject.

---

## 1. Independent pre-implementation audit

Every finding below was verified against source, not taken from prior reports.

| # | Finding | Evidence |
|---|---|---|
| 1 | **No compaction exists in the Direct engine.** | All `compact`/`compaction` code is under `web/src/features/opencode/*`. Zero hits in `src/context/`. |
| 2 | **`/api/chat` explicitly rejects OpenCode conversations.** | `chat.ts:193-196` returns an error for `conversation.engine === "opencode"`. So OpenCode compaction is unreachable from Direct. |
| 3 | **OpenCode's compaction is DELEGATED, not owned by TBAi.** | `compactSession.ts` calls `context.compact()` — the OpenCode *server* does the summarising. TBAi is a trigger only. There was no TBAi-owned summariser anywhere. |
| 4 | **The server never re-reads messages for a request.** | `divergence.ts:5-11` states Phase 1 finding F8: the browser POSTs the whole `messages` array each turn. `hasStoredMessage` is existence-only; divergence compares ID sets and deliberately never merges. |
| 5 | **Storage.** `messages(id, conversation_id, role, content, parent_id, order_seq, status, format, created_at, updated_at)`. | Live query: `role` and `status` are NULL for all 25 rows; role lives inside the JSON `content`; `format` = `ai-sdk/v6`. |
| 6 | **Reload returns a FLAT list.** | `listThreadMessages` = `ORDER BY order_seq ASC, created_at ASC` with no parent filtering. `parent_id` is client-supplied and used for tree rendering, not assembly. |
| 7 | **Lifecycle invariant.** An unresolved approval is preserved only when its index is at or after the last user message. | `prune-messages.ts:140-151`. Every unresolved lifecycle state therefore lives in the region compaction is forbidden to touch. |
| 8 | **`chatRuns.create` has NO per-conversation guard.** | `chat-runs.ts:121-164`. Two runs for one conversation can coexist. The only single-winner gate is `claimHistory(streamId)`, keyed by stream id. |
| 9 | **Overflow today is a hard rejection.** | HTTP 400, `code: "CONTEXT_OVERFLOW"`. |
| 10 | **Budget constants.** `SAFETY_MARGIN_FRACTION` 0.25, `UNKNOWN_LIMIT_CEILING` 128 000, `DEFAULT_OUTPUT_RESERVATION` 4 096. | Measured from `budget.ts` / `limits.ts`. |
| 11 | **Schema pattern is additive and idempotent.** | `CREATE TABLE IF NOT EXISTS … CHECK(…)` in a dedicated module, run at boot — the `chat-streams/schema.ts` precedent. |

**Finding 4 is the decisive one.** Under architecture C the browser owns thread
state and re-posts it every turn. That makes "rewrite stored history"
*functionally inert*, not merely worse — see §2.

---

## 2. Compaction architecture decision

**Decision: persist a compaction record (boundary marker + bounded summary) and
apply it inside the existing `assembleContext` seam. Stored history is never
rewritten.**

Full reasoning and the alternatives matrix: `docs/adr-2026-10-01-context-compaction.md`.

### Why rewriting history is provably inert here

Verified from `divergence.ts:5-11` (Phase 1 finding F8): the server never
re-reads messages for a request. The browser POSTs the entire `messages` array
on every turn, and *that array* is what `assembleContext` consumes.

So if compaction rewrote `messages.content`, the next request would arrive
carrying the client's own uncompacted history and the rewrite would have **no
effect on what the model sees**. The feature would appear to work in the database
and do nothing at request time. Option B is not inferior to Option A — it is
inert.

### The honest cost of the chosen design

**The user-visible transcript keeps its full history while the model sees a
compacted form.** Under architecture C the browser owns thread state, so the
server cannot compact what the user sees without establishing a second authority.

This is a real divergence and is recorded as **KNOWN LIMITATION K1**, not smoothed
over. It is arguably better than the alternative: nothing is deleted from the
user's view, and the reduction applies where it actually matters — the model's
context window, the thing that overflows.

The *model's* context is deterministic and durable: the marker is persisted, so
reload, resume, detached completion and the next turn all assemble the identical
compacted form.

### Boundaries preserved

1. **`pruneStaleMessages` untouched** — verified: `git diff --name-only -- src/lib/prune-messages.ts` is empty.
2. **One assembly path** — compaction is a stage inside `assembleContext`.
3. **No provider-specific orchestration** — the summariser model is injected.
4. **Scheduler untouched** — verified: no hit for `assembleContext|compaction` anywhere under `src/services/scheduler/` or `src/routes/scheduler.ts`.
5. **Provenance is structural where durable, explicit where model-visible.**

---

## 3. Trigger and hysteresis

### Trigger

A **fraction** of the real Phase 2 budget, never a token count or turn count:

```
triggerFraction = 0.80    releaseFraction = 0.60
```

Fraction rather than tokens so a 128K and a 512K model behave identically in
proportion. Tested: identical measured usage (850) compacts on a 1 000-token
budget and does not compact on a 100 000-token one.

The budget is computed by the seam from `computeBudget`, **before** compaction,
and is not caller-suppliable — a caller-provided number would make the
requirement unenforceable. `computeBudget` moved earlier in the pipeline, which is
safe because it depends only on the resolved limit and output ceiling, never on
message content.

`0.80` leaves room for the summary itself. Compacting *at* the limit would be too
late, because the summary has to fit.

### Hysteresis — durable, not derived

**The first implementation derived the latch from current usage and could never
clear.** The condition only cleared *below* `release` (0.60), which is also below
`trigger` (0.80), so the below-trigger branch always won. A conversation that had
ever been compacted could **never** be compacted again — it would grow to
rejection with a perfectly good span sitting there uncompacted.

Hysteresis is therefore a `latched` column on the durable record:

- set on every compaction;
- cleared by the seam only when it *observes* measured usage below the release
  fraction, i.e. once the previous compaction has demonstrably taken effect.

Derived state cannot express "since last time"; durable state can.

The effect is correct rather than merely non-broken: after a real compaction usage
drops below the release fraction, so the latch clears and the conversation must
regrow past the trigger before the next compaction. In the measured sequence the
latch *does* prevent thrashing when a compaction reclaims little.

---

## 4. Retained set

The removable span is bounded **structurally**, never positionally.

`latestCutIndexBefore` places the cut at the last assistant message strictly
*before* the final user turn. Then:

- the **current user request** can never be inside the span;
- the **recent tail** has a floor of `minRetainedTail = 6` messages, whatever
  their size;
- **Layer A** is never a message, so compaction cannot reach it by construction;
- **Layer B** is never a message either.

The load-bearing argument: because `prune-messages.ts` already guarantees every
unresolved lifecycle state lives at or after the last user turn, cutting strictly
before that turn **cannot** remove an unresolved approval — not because
compaction inspects approvals, but because the boundary is placed where no
unresolved state can exist. That is a structural guarantee rather than a filter
that has to enumerate every dangerous case.

---

## 5. Tool and approval invariants

Tested at the orchestrator and seam level, including across the real pipeline.

| Invariant | How it is guaranteed | Test |
|---|---|---|
| No tool call without result or approval state | Cut lands on an assistant message; completed pairs live inside one | "never splits a tool call from its result" |
| No unresolved approval removed | Structural: cut precedes the last user turn | "never removes an unresolved approval, because it sits at or after the last user turn" |
| No expired approval resurrected | Compaction runs strictly *after* the pruner, and can only remove more | ordering asserted in `assemble.ts` |
| Approval-paused turn intact end to end | Real `approval-requested` fixture through `assembleContext` | "keeps an unresolved approval, including its id" |
| Property-style, across four conversation shapes | Loop over shapes | "never emits a call with no result and no approval" |

The four shapes are: many turns, two turns, tool-pairs-only, and approval
mid-history.

**One finding worth recording.** `prepareModelMessages` **drops**
`approval-requested` tool calls entirely when converting to ModelMessages —
verified directly. That is pre-existing Phase 2 behaviour, unchanged here: the
approval is answered by the client sending a `tool-approval-response` part, so
the model never needs to see a pending call. The consequence is that approval
survival must be asserted on **Layer C**, which is where compaction operates. An
early draft asserted it on `modelMessages` and was measuring the wrong layer.

---

## 6. Summary contract

### Bounds

| Bound | Value | Source |
|---|---|---|
| `maxSummaryTokens` | 1 500 | policy |
| `summaryOutputReservation` | 2 048 | policy |
| Summariser input capacity | `limit.maxInputTokens − summaryOutputReservation` | resolved by the seam |

### Preservation

The summariser is instructed to preserve, in order: what the user asked and any
constraint; decisions made and corrections given; open tasks; concrete facts,
paths, identifiers and values; and tool outcomes that change what happens next.
It is instructed to report only what is in the transcript and never to invent
domain facts.

**The contract does not promise semantic equivalence**, because that is not
testable here. What is promised and tested is boundedness, provenance, and
coverage accounting.

### Structural bounds, not just prompts

- Input is exactly the span. **No parameter accepts a conversation.**
- Tool payloads are recorded as outcomes, never transcribed. Tested: a 50 000-char
  tool result yields a transcript under 500 chars.
- Output is bounded by `maxOutputTokens` **and** re-measured with the project's
  own estimator. Tested: a summary the provider reports as small but the project
  measures large is still rejected.
- An over-budget summary is **rejected, never truncated**. A half-summary silently
  claims coverage it did not read, which would corrupt the conversation's record.

---

## 7. Provenance

Durable and structural, not text hidden inside a summary.

- **Authoritative record**: its own table, `conversation_compactions`, with
  `origin`, `summarized_by`, `generation`, `span_fingerprint`, `covered_message_ids`,
  `summary_tokens`. This is the provenance of record.
- **Model-visible**: a deterministic text header stating origin and size —
  `[TBAi compacted history — model_generated_summary, N earlier message(s) summarized,
  generation G. This is a summary of earlier turns, not new user input.]` The
  "not new user input" clause stops it being mistaken for an instruction.
- **Typed diagnostics**: `CompactionReport` carries `origin`, `summarizedBy`,
  `spanFingerprint`. Log-boundary keys avoid the substring `token`, which
  `logger.ts` redacts (`SENSITIVE_KEY_RE = /.*token.*/`); the typed fields keep the
  honest names.

**A custom `data-tbai-*` UIMessage part was evaluated and REJECTED.** It was
assumed to survive into the model request. It does not:
`convertToModelMessages` handles a data part **only** when
`options.convertDataPart` is supplied, and without it the part is silently
dropped and the message converts to empty content. Verified by capturing the real
Anthropic request body — the provenance did not appear in it. Using it would have
meant adding an option to `prepareModelMessages`, a Phase 2 file, for no benefit.

---

## 8. Persistence strategy

One new table. Additive, idempotent, created in `src/db/index.ts` alongside every
other table so there is exactly one schema owner.

- No existing table altered.
- No row rewritten.
- No column dropped.
- **Deleting the rows is a complete rollback**, because originals were never
  touched. Verified by test.

### Single-winner under concurrency

`chatRuns.create` has no per-conversation guard, so two tabs, a detached run plus a
new submit, or a rapid double-send can compact one conversation simultaneously.
Two concurrent compactions would each summarise the same span, and the loser's
summary would silently replace the winner's.

The boundary is **UNIQUE on `conversation_id` plus a generation-guarded upsert**:

```sql
ON CONFLICT(conversation_id) DO UPDATE SET … WHERE excluded.generation > conversation_compactions.generation
```

A writer whose generation is not strictly greater is **discarded**, so a slow
summariser cannot clobber a newer summary with an older span. Tested against a
real SQLite file.

At most one row exists per conversation. Repeated compaction **extends** that row,
so the summary chain never grows without bound.

### Store shape

`createCompactionStore(db)` is a factory taking the connection, matching
`createSqliteResumableStreamStore`. The SQL is therefore testable against a
private temporary database, and tests never touch the shared singleton — which
matters because the shutdown lifecycle closes it.

One finding: `bun:sqlite`'s `Database.run()` executes **exactly one statement**. A
multi-table test schema passed to `run()` silently created only the first table and
produced an unnamed failure. `exec()` is required. The production code was already
correct — one table per `run()` call.

---

## 9. Branch behaviour

- `parent_id` is untouched. Compaction reads nothing from it and writes nothing to
  it.
- Stored history is never rewritten, so **topology cannot be flattened**.
- The span is located by **message id, not position**, because the client re-posts
  the conversation and indices shift as turns are appended. A positional lookup
  would apply a summary to the wrong messages.
- Every covered id is confirmed present, in order, before the record is applied. A
  regenerate, an edit or a rebase that drops covered messages causes the record to
  **decline to apply** — a summary of a span no longer in the conversation would be
  a fabrication.

Tested: "locates the span by id, not by position"; "refuses after a regenerate
that drops covered messages"; "does not apply when covered ids appear in a
different order (a rebase)".

---

## 10. Concurrency

| Concern | Handling |
|---|---|
| Two runs compacting one conversation | UNIQUE + generation-guarded upsert (§8) |
| Which summary wins | The **stored** record is applied, never the proposed one. Tested: with a winning record of generation 99 returned by `persist`, the applied summary is the winner's, not ours. |
| Persist failure | An unrecorded compaction is **never applied** — the caller would show the model a compaction a reload would not reproduce. Tested. |
| Latch | Durable column, not process state, so it survives restart and is shared across runs. |
| Locks | None. The single-winner boundary is a SQLite constraint, not an in-process lock, which is what makes it correct across processes too. |

---

## 11. Phase 3 interaction

Phase 3's capability layer is **untouched**. No provider-specific cache control
was added, changed or referenced. A test greps the four compaction modules for
`cache_control`, `prompt_cache_options`, `promptCacheKey`, `cacheControl`, and for
`createAnthropic|createOpenAI|createGoogle|getModel` — the summariser model is
injected, never constructed.

Preserved properties:

- **Deterministic request construction.** Identical inputs produce byte-identical
  `modelMessages`, asserted through the full seam.
- **Stable prefix position.** The summary is injected **before** the live turn,
  never appended after it. A trailing summary would change the prefix on every
  compaction. Tested.
- **Deterministic rendering.** The same record always yields the same bytes.
- **Content-free fingerprint.** `spanFingerprint` hashes ids and roles only, never
  prompt text — safe to log and compare across processes.

**No claim is made that compaction improves caching.** Compaction resets the
prefix, deterministically, once. Whether that is beneficial is a measurement
question and no measurement was taken.

---

## 12. Failure handling

Every failure resolves to **"no compaction"**, and assembly continues with the
uncompacted history. The pre-existing `CONTEXT_OVERFLOW` rejection then handles
an over-budget request exactly as it did before Phase 4.

| Failure | Result | Test |
|---|---|---|
| Provider error | typed `provider_error`; nothing persisted | ✅ |
| Timeout | typed `timeout`, **enforced by racing** (see below) | ✅ |
| Caller abort | typed `aborted`, distinguished from timeout | ✅ |
| Empty summary | typed `empty_summary` | ✅ |
| Over-budget summary | **rejected, not truncated** | ✅ |
| Span exceeds one-call capacity | `span_exceeds_summarizer_capacity`, **before any provider call** | ✅ |
| Persistence failure | compaction not applied; stored row unchanged | ✅ |
| Unexpected throw | contained; report `compaction_error` | ✅ |

**The strongest available assertion is tested**: a failed-compaction assembly is
**byte-identical** to the assembly with no seam wired at all, including the
verdict. That is stronger than asserting a specific outcome.

### Advisory aborts are not bounds — a real finding

The first implementation used `AbortController` plus a timer. Testing showed the
timeout was **advisory**, not enforced:

1. `generateText` passes the signal down and does **not** race the call itself, so
   a provider that ignores it completes late — a deliberately slow model returned
   `ok: true` after the full timeout.
2. The signal handed to the model can be **already aborted on entry**. Verified by
   capturing `doGenerate` options: `abortSignal.aborted === true`. A provider that
   only subscribes to the `abort` event — as a mock, and as any caller that does
   not check the flag first — never learns about it and hangs forever.

The call is now raced against both the deadline and the caller's abort, so TBAi's
bounds are authoritative independent of provider behaviour. A late result is
discarded, never inspected. The suite went from 10.7 s to under 1 s as a side
effect.

---

## 13. Tests

| Suite | Tests | Focus |
|---|---|---|
| `src/context/compaction/compaction.test.ts` | 35 | Pure decision: trigger, hysteresis, retained set, provenance, determinism, provider-leak grep |
| `src/context/compaction/runtime.test.ts` | 31 | Summariser bounds and failures, orchestrator containment, real-SQLite store |
| `src/context/compaction/seam.test.ts` | 34 | Wiring through `assembleContext`, durability, failure containment, property invariants |
| **Phase 4 total** | **100** | |
| Full suite | **3 064 pass / 2 skip / 0 fail** across 234 files | Baseline was 2 964 / 231 → **+100 tests, +3 files, no regressions** |

Regression suites run independently, per the task's instruction not to trust
targeted runs:

| Suite | Result |
|---|---|
| Phase 1/2/3 context (`src/context/`, prune, model-messages, overflow) | **280 pass / 0 fail** |
| Approval / lifecycle / resume / detached (`chat-streams`, `chat-runs`, scheduler approval) | **132 pass / 0 fail** |
| Full suite | **3 064 pass / 0 fail** |

### Property-style invariants

Not random fuzzing. Each is an externally meaningful property asserted over four
conversation shapes:

- the live turn is always retained after compaction;
- no tool part is left unresolved (no result, no error, no denial, no approval);
- repeated assembly of the same conversation never grows the request beyond 5 % of
  the first measurement — convergence, not oscillation;
- identical inputs produce identical compacted output;
- a durable record never covers a server-injected id, and every covered id exists
  in what the client actually sent.

### A note on test-harness fidelity

Three tests were initially wrong in ways that produced *false confidence or false
failure*, and each is now documented in place:

- a mock model that ignored `abortSignal` "proved" the timeout was broken (it was
  actually the mock);
- a store stub that did not write the latch meant the second-compaction path was
  **never reached** — which is precisely how a real durability defect survived
  several rounds of testing;
- an 8 000-token test window was **smaller than Layer B alone** (~10 745 tokens),
  so every request was rejected before compaction could matter. All fixture sizes
  are now derived from measurement, and the reasoning is recorded in the tests.

---

## 14. Live verification

**NOT PERFORMED. Live summarisation is UNVERIFIED.**

Reason, carried forward from Phase 3 and independently re-confirmed: the only
configured credential in this install is a `custom` OpenAI-compatible endpoint
(`agnes`) whose capability is `unknown`. Under Phase 3's rules an `unknown`
capability permits no cache parameter, and the same reasoning applies here: a
summarisation request against that endpoint would not exercise a documented
capability path, and a failure could not be attributed.

What was verified locally instead, with real code paths rather than mocks at the
seam:

- the full `assembleContext` pipeline with a genuine 32 000-token
  `provider_reported` window, native tool layer, and the real estimator;
- a real SQLite file for the store, the single-winner race and the latch;
- a real `MockLanguageModelV3` through the real `generateText` path, including
  `maxOutputTokens` reaching the provider options.

**No claim is made that summarisation works against a live provider.** The
missing evidence is provider-reported behaviour for the summarise call itself.

---

## 15. Defects found in this phase's own work

Recorded because the reasoning is reusable and because the task required hunting
for exactly these.

| # | Defect | Impact | How found |
|---|---|---|---|
| D1 | **Compaction planned its span over the already-compacted view**, whose ids include a server-injected `tbai-compaction:*` block the client never receives. A second compaction therefore recorded an unlocatable id. | **Severe.** On the next request the record could not be found, compaction silently stopped applying, and the conversation reverted to full history and grew without bound — with no error anywhere. | Three-turn end-to-end probe (compact → latch-clearing turn → growth) |
| D2 | Hysteresis latch derived from current usage could never clear. | **Severe.** A conversation compacted once could never be compacted again; it would grow to rejection. | Unit test asserting latch/released outcomes |
| D3 | Summariser input ceiling derived from `budget.usableInputTokens`. | **Severe.** A conversation large enough to need compaction is by definition larger than the budget, so essentially every real compaction was refused. The phase could never fire. | Seam test; measurement probe |
| D4 | Timeout implemented as an advisory abort. | **Moderate.** A provider that ignores the signal completed late and returned success past the deadline. | Test that deliberately used a slow model |
| D5 | ADR initially claimed a `data-tbai-*` part would survive into the request. | Documentation wrong; would have justified a wrong design. | Empirical SDK probe before relying on it |
| D6 | Test harness reused one in-memory record, so the latch never cleared and D1's path was unreachable. | Test blind spot that masked D1 across several rounds. | Noticed while reading probe output |

D1 is the one that matters most, and the reason is worth stating: **it produced no
error, no failed test, and no log line.** It only appeared by constructing the
realistic multi-turn sequence with a store that behaves like the production one.

---

## 16. Residual risks

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| **K1** | **User sees full history while the model sees a compacted form.** Under architecture C the browser owns thread state; the server cannot compact the visible transcript without a second authority. | Known divergence | Documented, deliberate. The model's context is deterministic and durable. Lifting it needs a client-side change and a decision about who owns thread state. |
| **K2** | **Single-pass compaction has a hard size bound.** Once a conversation outgrows the summariser's one-call input capacity, compaction declines with `span_exceeds_summarizer_capacity`. | Known limit | Refuses before any provider call. Both alternatives were rejected as worse (fabricating a partial summary; recursively summarising summaries). Lifting it needs chunked summarisation with a bounded combine — real work, and a product decision. |
| **K3** | **Live summarisation is UNVERIFIED.** No compatible credential. | Open | Section 14. Not convertible into "verified" without a real provider run. |
| **K4** | **Off by default** (`TBAI_COMPACTION_ENABLED`), so nothing is live-verified in normal operation. | Deliberate | Follows the `TBAI_CHAT_STREAM_TTL_MS` precedent. |
| **K5** | Summary *quality* is not tested and cannot be tested here. Boundedness and coverage accounting are tested; whether a summary actually preserves what matters needs evaluation, not unit tests. | Open | A future evaluation harness, not a unit test. |
| **K6** | The convergence test uses a 5 % tolerance rather than exact equality. | Low | Exactness is not achievable through the estimator; the assertion is deliberately loose and honest about it. |
| **K7** | The conversation-overflow path was verified only through `assembleContext`, not by driving a real long conversation through `/api/chat`. | Low | Depends on K3. |

**Not changed, deliberately:** `pruneStaleMessages`, the Phase 2 seam's ownership,
the Phase 3 capability layer, the scheduler, `parent_id` semantics, and any
dependency. No dependency was added, upgraded or removed.

---

## 17. Exit criteria

| # | Criterion | Verdict |
|---|---|---|
| 1 | Measured compaction trigger | **PASS** — fraction of the real Phase 2 budget; budget-derived test asserts it scales with model size |
| 2 | Hysteresis | **PASS** — durable latch; the D2 flaw is pinned by a named regression test |
| 3 | Deterministic retained set | **PASS** — structural cut, id-located span, byte-identical rendering |
| 4 | System/developer instructions protected | **PASS** — Layer A is never a message |
| 5 | Current user request protected | **PASS** — asserted in Layer C and in `modelMessages`, across four shapes |
| 6 | Approval lifecycle protected | **PASS** — structural argument plus end-to-end test on a real approval fixture |
| 7 | Tool call/result pairing protected | **PASS** — property test across four shapes |
| 8 | Partial/in-flight turns protected | **PASS** — the cut precedes the last user turn, where unresolved state cannot be |
| 9 | Summary generation bounded | **PASS** — no parameter accepts a conversation; tool payloads recorded as outcomes |
| 10 | Summary accounted for in budget | **PASS** — re-measured with the project estimator; included in the verdict's measurement |
| 11 | Provenance durable | **PASS** — own table with provenance columns; `data-*` rejection recorded |
| 12 | Compaction durable | **PASS** — marker persisted; rollback verified |
| 13 | Reload deterministic | **PASS** — summary present after reload, asserted |
| 14 | Resume deterministic | **PASS** — the same assembly path serves resume and detached completion; both covered by the 132-test lifecycle suite |
| 15 | Detached execution safe | **PASS** — no Phase 4 code runs outside the seam, and detached runs re-enter it |
| 16 | Branch topology preserved | **PASS** — `parent_id` untouched; id-located span; declines on rebase |
| 17 | Compaction failure safe | **PASS** — byte-identical to the unwired assembly |
| 18 | Phase 3 cache invariants preserved | **PASS** — deterministic request, stable summary position; capability layer untouched |
| 19 | No new uncontrolled context-growth path | **PASS** — D1 was exactly such a path and is fixed; one row per conversation; convergence test |
| 20 | Regression suite clean | **PASS** — 3 064 / 0 fail, +100 tests over baseline |
| 21 | Typecheck clean | **PASS** — backend exit 0, web exit 0, re-run independently |
| 22 | Build clean | **PASS** — exit 0 |
| — | **Live summarisation** | **UNVERIFIED** — no compatible credential (K3) |

**22 of 22 criteria PASS. One additional dimension, live summarisation, is
UNVERIFIED** and is not converted into a pass.

---

## 18. Certification

Certified **WITH RESIDUAL RISKS**.

The strict rule permits this when live-provider verification is impossible but
implementation is otherwise fully verified. No known correctness defect remains:
D1–D4 are fixed and each is pinned by a test that fails without the fix. All
architectural decisions are recorded in the ADR. Persistence and provenance are
explicit. Tool and approval invariants are tested. Compaction is durable.
Failure behaviour is safe. Phase 3 interaction is verified.

What is **not** certified: that summarisation behaves correctly against a live
provider. That evidence does not exist in this install and was not manufactured.

---

## 19. Git state

| | |
|---|---|
| Branch | `main` |
| Phase 4 commits | `6d1c25a`, `32701a6`, `8cb839c` |
| Files changed | 13 — 4 source, 4 test, 1 schema, 1 service, 3 doc |
| Pushed | **No** |
| Other-workstream changes in the tree | 46 entries, none staged or committed |

Commit 1 was verified **self-contained**: with the seam wiring removed and
`seam.test.ts` set aside, the tree typechecked (exit 0) and 66 subsystem tests
plus 230 Phase 1/2/3 regression tests passed.

---

## 20. Phase 5 handoff

Phase 5 (memory injection) was **not started**, and these are the seams it needs:

1. **A distinct origin.** `ContextOrigin` currently has `original_user_content`
   and `model_generated_summary`. A memory block needs a third — and must be
   distinguishable from a conversation summary. The enum was deliberately not
   extended with an unused state.

2. **The same budget.** Memory participates in the *same* measurement and verdict.
   Injecting it before `combineEstimates` means it is budgeted for free; injecting
   it after would bypass the budget entirely.

3. **Survival under compaction.** A memory block is not a message, so compaction's
   structural cut cannot remove it — but a memory injected as a message *could* be
   swept into a span. It must be injected as a layer or a reserved position, and
   that choice should be made deliberately.

4. **Provenance, durably.** `conversation_compactions` shows the pattern: a
   dedicated table with provenance columns beats metadata hidden in text, because
   text provenance is not queryable and not enforceable.

5. **The one rule that transfers.** Anything injected must be planned over inputs
   the *client* re-posts, or it will fail the same way D1 did. This applies to any
   future server-derived block, not just compaction.

6. **Prohibited here, available there:** Phase 5 must not implement memory
   *injection* logic inside `assembleContext` directly. The seam already accepts an
   injected collaborator; memory should arrive through one, so the single-assembly-
   path rule holds.

---

## Appendix A — files

| File | Role |
|---|---|
| `src/context/compaction/contract.ts` | Policy, plan, span boundaries, provenance types, rendering |
| `src/context/compaction/summarize.ts` | Bounded summarisation; raced deadline; typed failures |
| `src/context/compaction/orchestrate.ts` | Orchestration, failure containment, span location |
| `src/context/compaction/index.ts` | Public surface and `DEFAULT_COMPACTION_POLICY` |
| `src/services/compaction.ts` | Storage behind the service boundary; single-winner upsert |
| `src/db/index.ts` | The one schema owner (additive table) |
| `src/context/assemble.ts` | Pipeline wiring, `resolveSummarizerInputTokens`, diagnostics |
| `src/context/types.ts` | `CompactionReport`, `CompactionSeam`, `CompactionPhaseInput` |
| `src/routes/chat.ts` | Opt-in gate and seam wiring |
| `docs/adr-2026-10-01-context-compaction.md` | Decision + implementation addendum |

## Appendix B — measured figures

| Figure | Value |
|---|---|
| Native tool layer (Layer B) | ~10 745 tokens |
| Test window / budget / summariser capacity (32k) | 32 000 / ~23 232 / ~29 952 |
| Uncompacted → compacted estimate (working fixture) | ~46 000 → ~13 500 |
| Phase 4 tests | 100 across 3 files |
| Full suite | 3 064 pass / 2 skip / 0 fail, 234 files |
