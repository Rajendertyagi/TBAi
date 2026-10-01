# Phase 4 — Final PM certification (adversarial audit)

**Date:** 2026-10-01 · **Phase:** 4 · **Verdict: CERTIFIED WITH RESIDUAL RISKS**
**Architecture:** C — Hybrid explicit context assembly (unchanged; no second context system)

This audit treated every prior claim — including the previous agent's report, its
test count, and its 22/22 exit-criteria claim — as unverified. It found one severe
defect the previous report missed (**D9**, below), fixed it, and separately achieved
the first **live** compaction observation this project has had.

---

## 1. Independent baseline

Git at audit start: `HEAD 2165f4f`, 25 ahead / 0 behind of `origin/main`, nothing
pushed, 0 staged, 46 unrelated dirty entries.

The previous report claimed "22 of 22 criteria PASS". That claim was not accepted.
Each claim below was re-derived from source, tests, or measured runtime behaviour.

---

## 2. Actual compaction path (Part 1)

Reconstructed from production code, not from the report.

```
POST /api/chat
  chat.ts:171   chatRequestSchema.safeParse            (Zod boundary)
  chat.ts:193   threadId = parsed.data.id             ← the seam's thread gate
  chat.ts:352   assembleContext({
                  conversationId, submittedMessages, provider, modelId,
                  systemPrompt, toolSignal,
                  compaction: compactionEnabled() && threadId ? {...} : undefined   (chat.ts:366)
                })
    assemble.ts:188  pruneStaleMessages(submittedMessages)      lifecycle repair
    assemble.ts:205  reduceToolResults(repaired)                 request-side reduction
    assemble.ts:235  computeBudget({limit, maxOutputTokens})     budget (moved earlier)
    assemble.ts:246  runCompactionPhase({...})                   ← Phase 4, module-private
    assemble.ts:268  combineEstimates([A, B, layerC])            measure compacted C
    assemble.ts:274  decideBudget({estimate, budget, ...})      accept / reduce / reject
    assemble.ts:279  decision==="reject" ? [] : prepareModelMessages(layerC.messages, tools)
    chat.ts:439      if (decision.action === "reject") → 400 CONTEXT_OVERFLOW
    chat.ts:636      streamText({ messages: modelMessages, ...layerA.toStreamTextOptions(),
                                  ...mergedProviderOptions })
```

### Single-path audit (searched, not assumed)

| Question | Finding |
|---|---|
| Alternative context-assembly routes? | **None.** `assembleContext` has exactly one production call site (`chat.ts:352`). |
| Duplicate compaction triggers? | **None.** `runCompactionPhase` is module-private (`assemble.ts:377`, not exported) and called once (`assemble.ts:246`). |
| `streamText` bypassing the seam? | **One**, in `schedulerExecution.ts:344`. Verified it builds `messages: [{ role: "user", content: fullPrompt }]` — a single synthetic prompt from `job.prompt`, never assembled conversation history. It cannot reach compaction, by design (Scheduler is a separate engine). |
| Who can enable compaction? | Exactly one site, `chat.ts:367`, gated on `compactionEnabled()` (env) **and** `threadId`. |
| Does the route send anything on reject? | **No.** `assemble.ts:279` yields `modelMessages = []` on reject, and `chat.ts:439` returns 400 before `streamText`. |
| Is anything recomputed after the reject check? | **No.** `modelMessages` is assigned once at `assemble.ts:279` and consumed at `chat.ts:638`. |

**Confirmed:** one Direct context path, one compaction trigger, no bypass, and
compaction is inert unless a caller supplies the seam.

---

## 3. Trigger verification (Parts 2 & 3)

Exercised through the **real** `assembleContext`, estimator, budget, planner, and
store. Only the summariser model (the provider boundary) was mocked.

### Measured budget model (32 000-token `provider_reported` window)

```
usableInputTokens (A+B+C budget) = 23232
trigger threshold (0.80)          = 18585
release threshold (0.60)          = 13939
summariser capacity (32000-2048)  = 29952
native tool layer alone           ≈ 10745 tokens
```

### Full trace, above trigger

```
PRE-compaction total   = 28930          trigger 18585   (over by 10345)
compaction applied     = true           reason = compacted
selected span          = 36 messages    u2 .. a19
span fingerprint       = span:23a2475b:36
summariser input       = 49518 chars    maxOutputTokens = 2048
summary output         = 19 tokens
POST-compaction total  = 12656          reclaimed (est) = 16362
final budget           = 23232          HEADROOM = 10576
decision               = accept         modelMessages = 7
summary in request     = true
live turn in request   = true
approval in LayerC     = true           (ap-live present)
SYSTEM RULES in LayerC = false          (Layer A is never a message)
```

Under budget (18 032 tokens): `applied=false`, `reason=below_trigger`,
**0 summariser provider calls**, `decision=accept`.

### Adversarial sweep (turns 8→22, single monotonic run)

```
turns  8 → 18032  below_trigger  accept   0 provider calls
turns  9 → 18939  compacted     accept   1 provider call    ← flips here
turns 10..22      compacted     accept   1 provider call each
```

- **No off-by-one:** the flip sits cleanly between 18 032 and 18 939 against a
  threshold of 18 585.
- **No threshold-rounding defect:** every applied compaction reduces the total
  (28 930 → 12 656); `post < pre` asserted for all 15 rows.
- **Monotone:** compaction never flips back from true to false.
- **No no-op compaction:** exactly one provider call per applied compaction, zero
  otherwise, asserted per row.

### Repeated compaction (12-turn sequence, shared store)

```
turn  0  total 12656  applied=true   gen 1  latched=true
turn  1  total 13565  applied=false  gen 1  latched=false   ← latch released
turns 2-6  14473→18106  below_trigger
turn  7  total 12656  applied=true   gen 2  latched=true    ← second compaction
turns 8-11 13565→16290 below_trigger
```

- **Hysteresis clears** (observed: `latched` true → false), and re-arms.
- **Generation never regresses** (asserted pairwise).
- **At most one row** in the store at any time.
- **No thrashing:** one compaction per ~7 turns of growth.
- **Span never repeats:** `u2..a19` → `u2..a26` → `u2..a33`, always extending
  forward. Every covered id verified present in the client-sent list, and no
  `tbai-compaction:` id ever present.
- **In-band values refuse:** 14 473 / 15 381 / 16 290 / 17 198 / 18 106 all inside
  `[release, trigger]` → `below_trigger`, no compaction. Above trigger while latched
  → `above_release_but_within_hysteresis`, no compaction.

---

## 4. K2 verification (Part 4) — MANDATORY

The required property: **COMPACTION REFUSED ≠ SILENTLY SEND ORIGINAL OVERSIZED
REQUEST.**

### Planner level

A span of 36 000 tokens against a 29 952 capacity → `plan.kind = none`,
`plan.reason = span_exceeds_summarizer_capacity`.

### Through the real seam

```
PRE  total = 129230   budget = 23232   range.low = 77538
PRE  decision = reject   modelMessages = 0
POST compaction applied = false   reason = span_exceeds_summarizer_capacity
POST decision   = reject
POST modelMessages sent to provider = 0     ← MUST BE 0, and is 0
POST total      = 129230                     ← identical to PRE: refusal reduces nothing
records persisted = 0
```

### Boundary sweep

```
turns | repeat |  preTotal | compaction | decision | msgsSent | sent while over budget?
   20 |     60 |     28930 |       true |   accept |        7 | false
   30 |     60 |     38014 |       true |   accept |        7 | false
   30 |    120 |     64414 |      false |   reject |        0 | false
   34 |    120 |     71567 |      false |   reject |        0 | false
   40 |    150 |     99897 |      false |   reject |        0 | false
   40 |    200 |    129230 |      false |   reject |        0 | false
   60 |    200 |    188464 |      false |   reject |        0 | false
```

**Verdict: PASS.** Compaction succeeds up to capacity (38 014 → accept), and beyond
it declines and the request is **rejected with nothing sent**. No oversized send.

### The A/B test that establishes Phase 4 cannot make anything worse

Same conversation, seam wired vs not:

```
turns |  no seam: total decision msgs | with seam: total decision msgs
   20 |     28920  reduce   61 |     12655  accept    7
   31 |     38912  reject    0 |     16288  accept   19
   41 |     47995  reject    0 |     19013  accept   28
   43 |     49812  reject    0 |     20830  reduce   34
```

All 30 divergences favour compaction; `withSeam.total ≤ bare.total` asserted 30/30.
Without compaction, turns 31+ are rejected outright.

### F-A — a PRE-EXISTING Phase 2 behaviour, found and quantified

The A/B also exposed something Phase 4 does **not** own. With **no compaction
wired at all**:

```
turns |   point |  range.low | range.high |  usable | decision | sent
   26 |   34370 |      20622 |      41244 |   23232 |  reduce | 79
   30 |   38003 |      22802 |      45604 |   23232 |  reduce | 91
   35 |   42545 |      25527 |      51054 |   23232 |  reject |  0
```

TBAi **sends** requests whose *point estimate* is up to ~1.6× the usable budget,
whenever `range.low` stays under. That is Phase 2's certified estimate-band design
(`decideBudget`), entirely independent of Phase 4, and compaction only *delays* it
(reject at turn 31 without compaction, turn 43 with it). It is reported here because
it is a real residual risk in the same code path K2 lands in, and because if the
provider disagrees with TBAi's estimator the user gets a generic provider error
rather than a clean `CONTEXT_OVERFLOW`. **Not a Phase 4 defect; not fixed here.**

---

## 5. K1 verification (Part 5) — user-view vs model-context

### What was measured

```
messages the client sent / user transcript      = 42
messages removed from the MODEL's view          = 36
messages the MODEL actually sees                = 6
summary block injected into the model's view    = 1
```

### The five surfaces asked for

| Surface | State |
|---|---|
| What the browser displays | The client's full transcript. Unchanged. |
| What SQLite stores | `messages` **untouched** — verified statically: compaction issues SQL only against `conversation_compactions` (SELECT / INSERT / UPDATE-latched / DELETE). Zero references to `messages`, `upsertStored`, or `messageService` anywhere in the compaction module or `services/compaction.ts`. |
| What `assembleContext` sees | The full client-submitted list, then the compacted view. |
| What the model receives | 6 messages + 1 summary block. |
| Does it survive reload / resume / next turn? | **Yes** for the model's context — turn 1, turn 2 (reload) and turn 3 (reload) produced **byte-identical** `layerC.messages`. Next turn also re-applied it. |

### Can the user discover that compaction occurred? — NO

| Probe | Result |
|---|---|
| `/api/conversations/:id/messages` mentions compaction | **false** |
| Conversation message list carries compaction metadata | **false** |
| `web/src` files (excluding the OpenCode feature) mentioning compaction | **none** |
| `src/routes` + `src/services` mentioning compaction (excluding `compaction.ts`) | **none** |

### Classification (not a patch)

The durable record exists, is fully auditable, and does explain the divergence after
the fact (`covered_message_ids`, `span_fingerprint`, `generation`, `origin`,
`summarized_by`, `summary_tokens`). But **nothing surfaces it to the user**:

1. no API field on the history response indicating a compaction exists;
2. no indicator in the transcript that the model's view differs;
3. no way for the user to learn *what* was summarised or *when*;
4. no way for the user to inspect or challenge the summary.

This is a **product/architecture consequence, not an implementation defect**, and it
is deliberately **not** patched. Under architecture C the browser owns thread state,
so surfacing it requires a decision about who owns thread state and whether the
model's context should be disclosed at all. It also interacts with K1's core
trade-off: telling the user "the model no longer sees 36 of your messages" is a
product statement, not a bug fix.

---

## 6. Summary quality (K5) — Part 6

### The honest boundary

Summary **semantics** are produced by the model. A mock summariser defines its own
quality, so mocking can only verify the **pipeline**. That split is what follows.

### Pipeline — VERIFIED

Every fact the preservation contract names reaches the summariser:

```
user constraint A      CONSTRAINT_ALPHA       present=true
user constraint B      CONSTRAINT_BETA        present=true
important decision     DECISION_TOKEN_9F3A    present=true
later override         OVERRIDE_TOKEN_77B2    present=true
tool outcome path      read_file              present=true
tool outcome state     output-available       present=true
unresolved task        UNRESOLVED_TASK_5C1D   present=true
tool payloads transcribed verbatim? false  (outcomes, not bytes)
```

Expired state is excluded **through the real seam**: an expired approval spliced
mid-history produced `lifecycleRepair = {removedToolParts: 1, …}`, and the summariser
prompt contained neither `EXPIRED_APPROVAL_ID_EE01` nor `tcStale`.

The prompt does request the contract: constraints, decisions, corrections, open tasks,
identifiers, tool outcomes, and an explicit "never invent, infer, or add domain
facts".

### Semantic quality — one live sample, not a verdict

From the live run (§17), the model's summary was:

> "1. The user posed 95 synthetic questions numbered 3 through 95. Each question
> enforced a constraint to keep the output terse and recorded a decision selecting
> the corresponding option (e.g., option 3, option 4) …"

That correctly abstracted the *pattern* of constraints and decisions rather than
copying filler — good evidence, on synthetic repetitive content, for a single case.

**K5 verdict: UNVERIFIED.** One live sample on synthetic filler is not a quality
result. Nothing here establishes that a summary preserves a conflicting instruction,
an identifier that matters three turns later, or a tool outcome that changes the next
action. That needs an evaluation set and a rubric, not a unit test. No such harness
exists, and inventing a pass from token-reduction or keyword presence would be
exactly the mistake this audit was told to avoid.

---

## 7. Summary boundary and recursion (Part 7)

### Size boundary — measured, not predicted

```
words | approxTokens | outcome
     1 |            1 | accepted (3 tok measured)
   100 |          125 | accepted (168)
   500 |          625 | accepted (835)
  1000 |         1250 | REJECTED (measured 1668 > 1500)
  2000 |         2500 | REJECTED
 60000 |        75000 | REJECTED
   ""  |            - | REJECTED (empty_summary)
"   \n\t "          | REJECTED (empty_summary)
```

The cap is enforced by **re-measuring with this project's estimator**, not by trusting
the provider. The project estimator is meaningfully more conservative than chars/4
(835 vs 625 measured tokens), so the bound bites earlier than a naive estimate
predicts. Over-budget summaries are **rejected, never truncated**.

### Recursion / unbounded growth — NOT a growth source

60 generations against a conversation growing every turn:

```
generations reached     = 3+        summary size max = 19 tokens
rows in store           = 1         (one summary, replaced — no chain growth)
max total across 60 turns = 18105   final total = 17198
```

The summary is injected as **exactly one message**, so replacing an N-message span
can never increase the message count. Repeated summary replacement does not compound:
**11 identical turns after one compaction produced exactly 1 summariser call** — no
re-summarising on reload.

---

## 8. Tool / approval safety (Part 8) — hard gate

Seven adversarial conversation shapes, each with the cut boundary placed
immediately before, at, and after tool interactions. The cut is audited on the
**post-prune** list, because that is what compaction actually receives.

```
shape | cut | lastUser | cut<lastUser | cutIsAssistant | prunedCut | brokenPairs
single completed pair              |   1 |        2 |         true |            true |         1 | 0
multiple pairs                     |   3 |        4 |         true |            true |         3 | 0
duplicate tool ids in one message  |   1 |        2 |         true |            true |         1 | 0
approval mid-history (stale)       |   3 |        4 |         true |            true |         1 | 0
denied + errored + answered        |   1 |        2 |         true |            true |         1 | 0
two assistants after the last user |   1 |        2 |         true |            true |         1 | 0
incomplete tool call mid-history   |   3 |        4 |         true |            true |         1 | 0
```

End-to-end through the real seam with every lifecycle state present:

```
compaction applied = true       summariser calls = 1
BEFORE: answered=4 pendingApproval=1 broken=0
AFTER : answered=3 pendingApproval=1 broken=0
AFTER ids pending = ["tcLive"]     live approval id survives in LayerC = true
lifecycleRepair = {removedToolParts: 0, preservedApprovals: 1}
```

The one answered call lost is a compacted, already-resolved historical pair — not a
dangling one. No broken pair, no orphaned lifecycle, no approval resurrection, and
`input-available` (an incomplete call) does not reappear.

Oversized tool results: compaction declined on capacity, `decision = reject`,
`modelMessages = 0`, and every tool still answered.

**An audit finding about my own method:** the first pass reported a "broken pair"
for a stale incomplete tool call. It was an artefact of auditing the *raw* message
list. `pruneStaleMessages` had already removed it (verified directly: it drops
`toolCallId "inc"` and preserves `apL`). The structural guarantee is that compaction
runs strictly *after* repair and can only remove more.

---

## 9. Partial / in-flight turns (Part 9)

The corrected premise: the concrete persisted mid-run state is an **approval pause**.

| State | Verified |
|---|---|
| Completed turn | Cut lands on an assistant boundary; completed pairs are atomic within one message. |
| Approval-paused turn | The live approval `ap-live` / `apLiveLive` survives every shape; `cut < lastUserIndex` in all seven. |
| Incomplete tool interaction | Removed by the pruner before compaction; cannot enter a span. |
| Detached run | No Phase 4 code runs outside the seam, and detached runs re-enter it. Covered by the 132-test lifecycle suite (0 fail). |
| Resume | Same assembly path; the record is re-applied. |
| Resume → auto-continue | Same path; no compaction-specific state. |

The structural argument, tested: `prune-messages.ts` preserves an approval only when
its index is `>= lastUserIndex`, so every unresolved lifecycle state lives at/after
the last user turn — a region compaction is forbidden to reach. Compaction never cuts
through an active interaction.

---

## 10. Durability (Part 10) — reconstructed context, not row existence

```
turn 1 (compaction)  applied=true   7 messages
turn 2 (reload)      record_applied_no_new_compaction:below_trigger   7 messages
turn 3 (reload)                                                    7 messages
turn 1 context === turn 2 context ?  true
turn 2 context === turn 3 context ?  true
turn 4 (next turn)   summaryPresent = true
summariser calls over the whole sequence = 1
```

The model's context is **byte-identical** across reloads. Verified on reconstructed
`layerC.messages`, not on row existence.

Detached completion and process restart were not separately re-exercised in this
audit; they are covered by the 132-test lifecycle/resume/detached suite and share this
same seam, so they are marked **PASS (indirect)** in the matrix rather than claimed
as direct observation.

---

## 11. Provenance (Part 11)

Durable and **structural** — columns, not free-form text. Read back from a real
SQLite file written by a live compaction:

```
columns = conversation_id, compaction_id, generation, latched, span_start_index,
          span_end_index, covered_message_ids, span_fingerprint, summary_text,
          summary_tokens, origin, summarized_by, created_at, updated_at

origin           = model_generated_summary
summarizedBy     = custom/agnes-3.0-flash
generation       = 1
latched          = 0
span indices     = 5..191
covered ids      = 187   first=p_a2 last=p_a95
spanFingerprint  = span:8d538f00:187
summaryTokens    = 287
createdAt        = 1700000000000
```

Can the system distinguish the required categories?

| Category | Distinguishable? |
|---|---|
| original user message | Yes — it is a `messages` row, untouched by compaction. |
| original assistant output | Yes — same. |
| tool result | Yes — same, and pruned by lifecycle repair before compaction. |
| compaction summary | Yes — `origin = model_generated_summary`, its own row, plus an explicit text header in the request. |
| future injected context | Place reserved: `CONTEXT_ORIGINS` has exactly two members and Phase 5 adds the third. |
| compaction metadata | Yes — the remaining columns. |

Provenance survives a read cycle, and survives a **subsequent compaction** (gen 1 → 2:
`generation` advanced, `origin` and `summarizedBy` preserved, fingerprint changed
`span:23a2475b:36` → `span:b4cd10e0:50`, covered ids 36 → 50).

Not free-form: the only text is the summary body itself; every attribution fact is a
column.

---

## 12. Storage strategy (Part 12)

| Property | Verified |
|---|---|
| Schema | One new table, `CREATE TABLE IF NOT EXISTS`, in `src/db/index.ts` — the single schema owner, alongside every other table. |
| Additive | **Confirmed.** `git diff 813d59b..HEAD` contains no `ALTER TABLE`, no `DROP`, no rewrite of an existing table. |
| Backward compatible | `IF NOT EXISTS` + nullable-free defaults; an existing DB gains a table and nothing else. |
| Ordering | Not applicable — the table holds one row per conversation, not a sequence. |
| Write path | One upsert, guarded by `excluded.generation > conversation_compactions.generation`. |
| Read paths | `SELECT *` / `SELECT 1` by `conversation_id`. |
| Deletion | `ON DELETE CASCADE` from `conversations`, with `PRAGMA foreign_keys=ON` (`src/db/index.ts:43`, and again at `:265` for the rebuild). |
| Orphan rows | Impossible while the pragma is on — the FK cascades. |
| Duplicate active records | Impossible — `conversation_id` is the PRIMARY KEY; measured 1 row after 5 writes and after interleaved races. |
| Generation guard | Verified on real SQLite: gen 7 stored, gen 3 **discarded**, gen 8 stored, gen 8 duplicate **discarded**. |
| Corrupt row | `get()` returns `undefined` (degrades to "no compaction"), `has()` stays `true`. Assembled requests are never broken by one unreadable row. |
| Rollback | Deleting the rows is complete, because originals were never touched. |

---

## 13. Concurrency / single-winner (Part 13) — MANDATORY

### D9 — DEFECT FOUND, FIXED, AND PINNED

The previous report claimed the single-winner guarantee was correct. It was not.

`maybeCompact` applied whatever record `persist` returned using **its own plan
indices**. Under a same-generation race the store returns the *winner's* record, so
the loser spliced the winner's summary across the loser's index range.

Verified concretely:

```
A wins generation 1 over 20 turns   record covers [a2 .. a19]  (35 ids)
B loses over 24 turns, plan indices [5 .. 47]
B's request BEFORE fix = u0,a0,u1,a1,u2,SUMMARY,live
                        -> u20,a20,u21,a21,u22,a22,u23,a23  DROPPED
                        -> and covered by NO durable record
B's request AFTER fix  = u0,a0,u1,a1,u2,SUMMARY,u20,a20,u21,a21,u22,a22,u23,a23,live
                        -> all 8 retained
```

Eight messages removed with no representation, no provenance, and a model told a
summary that did not describe what was removed. Reachable via two tabs, a detached
run plus a new submit, auto-continue, or a rapid double send.

**Two fixes.** Race identity is now `(generation, spanFingerprint)`, **not**
`compactionId` — the audit showed id detection is unsound, because two writers at the
same generation produce the *same* id whenever the id derives from the generation,
and a probe doing exactly that made a losing writer believe it had won. And when the
race is lost, the winner's record is applied **located by id** (the ordinary reload
path), or nothing is compacted at all if their span is absent.

### Can two summaries both become authoritative? — No

```
write gen 7 -> stored gen 7 "SUMMARY generation 7"
write gen 3 -> stored gen 7 "SUMMARY generation 7"      stale discarded
write gen 8 -> stored gen 8 "SUMMARY generation 8"
write gen 8 again -> stored gen 8 "SUMMARY generation 8" same-gen duplicate discarded
rows for the conversation = 1
```

Interleaved, with the fresh writer finishing first:

```
gen 9 (fresh) -> stored 9 ; gen 8 (stale, arriving later) -> stored 9
FINAL = gen 9, "SUMMARY B (fresh span)"     stale writer did NOT clobber
reverse order: gen 20 stored, then stale gen 19 -> stored gen 20
```

At **equal** generation the first writer wins and the loser adopts the stored record.
That is deterministic and both requests converge — but it is precisely the case that
produced D9, and it is now handled by id-located application rather than index
splicing.

---

## 14. Failure handling (Part 14) — timeout measured, not described

### Timeout enforcement, wall-clock measured, worst-case model

A model that **never resolves and ignores `abortSignal`**:

```
timeoutMs=  60 -> elapsed=  62ms  ok=false failure=timeout
timeoutMs= 200 -> elapsed= 200ms  ok=false failure=timeout
caller abort after 50ms -> elapsed=53ms  ok=false failure=aborted
pre-aborted signal -> ok=false failure=aborted
```

The bound is **authoritative**: TBAi stops waiting near its own deadline regardless of
provider behaviour, and `aborted` is distinguished from `timeout`. The previous report
asserted this; it is now measured.

### Every failure class, with state integrity

| # | Failure | Containment | Corrupt state? | Oversized send? | Approval/tool loss? |
|---|---|---|---|---|---|
| 1 | summariser throws | typed `provider_error`, assembly continues | no | no | no |
| 2 | malformed / empty result | typed `empty_summary`, refused | no | no | no |
| 3 | exceeds output cap | **rejected, not truncated** | no | no | no |
| 4 | timeout | typed `timeout`, measured above | no | no | no |
| 5 | caller abort | typed `aborted` | no | no | no |
| 6 | storage write fails | `persist_failed`, nothing applied | no | no | no |
| 7 | generation guard loses | stored record returned and applied by id (D9 fix) | no | no | no |
| 8 | span unlocatable (loser) | `lost_race_span_not_locatable`, nothing removed | no | no | no |
| 9 | post-compaction measurement throws | contained by the seam's boundary | no | no | no |
| 10 | capacity exceeded | `span_exceeds_summarizer_capacity` → reject | no | no | no |

The strongest containment assertion, tested: **a failed-compaction assembly is
byte-identical to the assembly with no seam wired at all**, including the verdict.

No case produces a generic failure where an actionable context error is required: the
overflow path returns HTTP 400 with `code: "CONTEXT_OVERFLOW"` and a specific message
naming the two remedies (new chat, or a model with a larger limit).

---

## 15. Phase 3 interaction (Part 15) — invalidation audit only

| Check | Result |
|---|---|
| Deterministic output | Identical inputs → byte-identical `layerC.messages` across independent runs. |
| Deterministic placement | Summary at index 4, live turn at index 5 — always **before** the live turn, never appended after. |
| Prefix identity changes when semantics change | Verified: fingerprint moved `span:23a2475b:36` → `span:b4cd10e0:50` when the covered span extended. |
| No stale identity across materially different compacted history | Covered ids are re-verified id-by-id and in order before application; a mismatch declines (`span_not_present`). |
| Provider-specific controls untouched | A test greps the compaction module for `cache_control`, `prompt_cache_options`, `promptCacheKey`, `cacheControl`, `createAnthropic|createOpenAI|createGoogle|getModel`. Zero hits. `src/context/cache/*` appears in **no** Phase 4 diff. |
| Untrusted limits not used to size cache conclusions | Compaction uses `limit.maxInputTokens` for capacity and `usableInputTokens` for the trigger; no cache sizing is derived from either. |

**No claim is made that compaction improves cache hit rate.** This was an
invalidation/correctness audit only; no cache measurement was taken and none is
implied.

---

## 16. Branching / parent_id (Part 16)

```
branch A (same history)      -> applied=true   reason=record_applied
branch B (covered ids gone)  -> applied=false  reason=span_not_present
branch C (ids reordered)     -> applied=false  reason=span_not_present
compaction references parent_id? false (orchestrate.ts and contract.ts)
```

- A summary is **never shared across an incompatible branch**: an absent or reordered
  covered set causes a decline, because a summary of a span no longer in the
  conversation would be a fabrication.
- Topology is not flattened — `parent_id` is never read or written, and `messages` is
  never rewritten.
- No unrelated history is modified.

One honest gap: because the durable record is keyed by `conversation_id`, two branches
**within the same conversation** share it. The id-located application means the record
applies to whichever branch still contains the covered ids, and declines on the
branch that does not. That is safe, but it means a regenerated branch loses its
compaction and reverts to full history until it re-crosses the trigger. Not a
defect; worth knowing.

---

## 17. Live verification (Part 20) — ACHIEVED

The previous report recorded live summarisation as UNVERIFIED. The audit achieved it.

### Credential position (re-checked, read-only)

```
provider_configs rows = 1
- agnes: type=custom endpoint=https://apihub.agnes-ai.com/v1 model=agnes-3.0-flash
```

No Anthropic / OpenAI / Google credential exists. **No credential and no provider
configuration was modified.** The database used was a **read-only COPY** of
`data/chat.db` placed in a scratch `DATA_DIR`, so the user's data was never written.

Note the reasoning differs from Phase 3: cache controls need a *documented* capability
before a parameter may be sent, but summarisation is a plain completion with no such
gate. So the existing credential was legitimately sufficient.

### Live observations

| Observation | Evidence |
|---|---|
| Live generation works | `ai.response … outcome=completed`, HTTP 200, streaming |
| Seam activates only when gated | `not_attempted` with no `threadId` → `below_trigger` once `id` was supplied |
| **Compaction actually fires** | `applied=true reason=compacted est=14730 gen=1 spanMsgs=187 summarySize=287 origin=model_generated_summary by=custom/agnes-3.0-flash` |
| Context reduction | ~86 000 → 14 730 tokens (≈83%) |
| Durable record written | Live row read back from SQLite (all columns, §11) |
| Durability live | Next turn: `record_applied_no_new_compaction:below_trigger` — record re-applied, **no re-summarisation** |
| No injected ids live | `any injected id in covered? false` |
| **K2 refusal live** | `applied=false reason=span_exceeds_summarizer_capacity est=193634 limitSource=conservative_default`, then HTTP 400 `CONTEXT_OVERFLOW` — refused, **not sent** |
| Real summary text | "1. The user posed 95 synthetic questions numbered 3 through 95. Each question enforced a constraint to keep the output terse and recorded a decision selecting the corresponding option (e.g., option 3, option 4)…" |

Content was synthetic and non-sensitive. No prompt text was logged.

**Two honest limits on the live result.**

1. `agnes-3.0-flash` has **no configured `contextWindow`**, so `limitSource =
   conservative_default` (the 128 000 fallback) applied. Compaction therefore only
   fires on very large conversations, and past the summariser's one-call capacity it
   correctly declines.
2. The live probe's synthetic conversation had **0 rows in `messages`** — the
   reconciler had not persisted the posted history at inspection time. So the live run
   confirms compaction, persistence of the *record*, and durability; it does **not**
   independently demonstrate the user-visible transcript. That half of K1 rests on the
   static finding that compaction issues no SQL against `messages`.

Scratch database and probe scripts were deleted after inspection.

---

## 18. Test audit (Part 19)

| Suite | Result |
|---|---|
| Phase 4 (`src/context/compaction/`) | **105 pass / 0 fail** |
| Phase 1/2/3 context + prune + model-messages + overflow | **285 pass / 0 fail** |
| Approval / lifecycle / resume / detached (`chat-streams`, `chat-runs`, schedulerApproval) | **132 pass / 0 fail** |
| Full suite (`bun run test`) | **3 069 pass / 2 skip / 0 fail** across 234 files |

Baseline at Phase 4 start was 2 964 / 231 files; the previous report closed at
3 065 / 234. The audit adds 4 tests (D9). No regressions at any point.

### Tests specifically covering each critical invariant

| Invariant | Test |
|---|---|
| Trigger is measured, not counted | "scales with the budget rather than a fixed token count" |
| Hysteresis latch is durable | "a released latch is what makes repeat compaction possible at all" |
| Current turn never compacted | "places the cut strictly before the last user message"; "keeps the current user request verbatim" |
| Tool pairs never split | "never splits a tool call from its result"; property test over 4 shapes |
| Approval never removed | "never removes an unresolved approval, because it sits at or after the last user turn"; "keeps an unresolved approval, including its id" |
| No approval resurrection | `input-available` absent after compaction |
| Summary bounded | "rejects an over-budget summary"; "measures the summary with the project's estimator" |
| Empty/malformed summary | "rejects an empty summary" |
| Provenance durable | "states its origin and size in the text the model receives"; round-trip test |
| Reload determinism | "produces the SAME context for the same conversation and record" |
| Durability without re-summarising | "re-applies a stored record on the NEXT turn without summarising again" |
| Branch safety | "refuses after a regenerate that drops covered messages"; "does not apply when covered ids appear in a different order (a rebase)" |
| Failure containment | "a provider error leaves the request exactly as it would be uncompacted" (byte-identical) |
| Timeout enforced | "reports a timeout distinctly from an abort"; "reports an abort distinctly from a timeout" |
| Capacity refusal | "refuses a span larger than one summariser call, before calling the provider" |
| **D9 race loser** | 4 new tests (message retention, colliding ids, unlocatable span, `wonRace`) |
| No provider/cache leakage | "the compaction module names no provider and no cache syntax" |
| Convergence | "repeated assembly of the same conversation never grows the request without bound" |

### Duplicates / vacuous tests — checked

I looked specifically for tests that assert the orchestrator while the bug lives
lower, and for first-compaction-only assertions. **I found one vacuous assertion of my
own making** and fixed it:

> `runtime.test.ts` "never records a span covering a server-injected id" asserted
> through the **orchestrator**, which is handed a good message list by the test and so
> could never observe a seam that passed a bad one. Rewritten to drive a real
> generation-2 compaction through the seam.

That rewrite was itself what made D9 visible.

---

## 19. Negative controls (Part 18) — MANDATORY

Every critical protection was disabled in a temporary working state and the suite
re-checked. Each was then restored and the diff verified.

| Protection disabled | Tests that failed |
|---|---|
| D1 — plan the span over the compacted view | **3** |
| D2 — remove the latch release | **4** |
| D3 — summariser ceiling derived from the budget | **10** |
| D4 — drop the race, keep the advisory abort | **8** |
| D9 — force `wonRace` true | **4** |
| Structural cut allowed to reach the live turn | **9** (incl. approval + live-turn guards) |
| Provenance header stripped from the model-visible block | **2** |

**Methodology warning, recorded because it cost me time.** Three of my scripted
negative-control attempts **silently failed to apply** (CRLF mismatch in
PowerShell string replacement) and reported "no failures", which would have read as
"the test cannot catch this". Every control above was re-run with a tool that reports
whether the substitution applied. A negative control that cannot confirm it modified
the source is not a negative control.

After restoring: `git diff` on the touched files is empty, `tsc` exit 0, 105/105, and
the full suite is green. **No temporary defect or artifact remains** — all probe files
were deleted and verified gone from `git status`.

---

## 20. Git audit (Part 21)

```
git status --porcelain --cached : 0
git log origin/main..HEAD --oneline : 7 Phase 4 commits, nothing pushed
```

| Commit | Subject |
|---|---|
| `6d1c25a` | compaction subsystem — contract, summariser, durable store |
| `32701a6` | compaction in the assembly seam and the chat route |
| `8cb839c` | ADR with an implementation addendum |
| `5cba0a4` | report, roadmap status, Phase 5 handoff |
| `ca56ee5` | trigger must measure the whole request (D7) |
| `2165f4f` | correct the report and ADR after the trigger fix |
| `683fa33` | D9 — race loser must not splice the winner's summary |

Files in Phase 4 commits: 15, all Phase 4.

| Scope check | Result |
|---|---|
| Phase 3 files changed | **none** — `src/context/cache/*` absent from the diff |
| Scheduler changed | **none** — `src/services/scheduler/*`, `src/routes/scheduler.ts` absent |
| Pruner changed | **none** — `src/lib/prune-messages.ts` absent |
| Dependency change | **none** — `package.json` absent from the diff |
| Schema migration deliberate | yes — one additive `CREATE TABLE IF NOT EXISTS`, no `ALTER`/`DROP` |
| Unrelated workstream files | **none committed.** 46 dirty entries remain unstaged and uncommitted (OpenCode V2, tab reconciliation, devtools, e2e helpers, `scripts/`, `docs/decisions.md`, `docs/project_tracker.html`). Verified by `git diff --cached --name-only` before every commit. |
| Docs match reality | **Corrected** in `2165f4f` after the D7 trigger change; D9 and the live result are recorded in this document and the ADR addendum. |
| Push | **Not pushed.** 26 ahead / 0 behind. |

---

## 21. Exit-criteria matrix (Part 22)

Original 22 criteria plus the 5 added by this audit. No criterion forced to PASS.

| # | Criterion | Verdict | Basis |
|---|---|---|---|
| 1 | Measured compaction trigger | **PASS** | Real seam; measured 28 930 vs threshold 18 585; scales with budget |
| 2 | Hysteresis | **PASS** | Durable latch observed clearing and re-arming; D2 pinned |
| 3 | Deterministic retained set | **PASS** | Structural cut, id-located span, byte-identical rendering |
| 4 | System/developer instructions protected | **PASS** | Layer A is never a message; verified absent from Layer C |
| 5 | Current user request protected | **PASS** | `cut < lastUserIndex` in all 7 shapes; live turn in request |
| 6 | Approval lifecycle protected | **PASS** | Structural argument + end-to-end; 9 tests fail if the cut is broken |
| 7 | Tool call/result pairing protected | **PASS** | 7 adversarial shapes, 0 broken pairs; property test over 4 shapes |
| 8 | Partial/in-flight turns protected | **PASS** | Approval pause survives; incomplete calls pruned before compaction |
| 9 | Summary generation bounded | **PASS** | No parameter accepts a conversation; payloads as outcomes |
| 10 | Summary accounted for in budget | **PASS** | Re-measured with the project estimator; in the verdict's measurement |
| 11 | Provenance durable | **PASS** | 14 columns, read back from a live-written row; survives gen 1→2 |
| 12 | Compaction durable | **PASS** | Marker persisted; rollback complete; cascade on conversation delete |
| 13 | Reload deterministic | **PASS** | Byte-identical context across 3 turns |
| 14 | Resume deterministic | **PASS** (indirect) | Same seam; 132-test lifecycle/resume suite green |
| 15 | Detached execution safe | **PASS** (indirect) | No Phase 4 code outside the seam; lifecycle suite green |
| 16 | Branch topology preserved | **PASS** | `parent_id` untouched; declines on absent/reordered ids |
| 17 | Compaction failure safe | **PASS** | Byte-identical to the unwired assembly; 10 failure classes contained |
| 18 | Phase 3 cache invariants preserved | **PASS** | Deterministic output; summary before live turn; capability layer untouched |
| 19 | No new uncontrolled context-growth path | **PASS** | **D9 was exactly such a path; found and fixed.** 60-generation run bounded; 1 row |
| 20 | Regression suite clean | **PASS** | 3 069 / 0 fail, +105 over baseline |
| 21 | Typecheck clean | **PASS** | Backend 0, web 0, re-run independently |
| 22 | Build clean | **PASS** | exit 0 |
| 23 | K1 divergence explicitly handled | **PARTIAL** | Architecturally understood and statically proven; **no user-facing surface exists** (§5). Deliberately not patched — product decision. |
| 24 | K2 oversized-span failure safe | **PASS** | Refused → reject → 0 sent, locally **and live** |
| 25 | K5 semantic summary quality classified | **UNVERIFIED** | Pipeline verified; semantics need an evaluation set. One live sample is not a verdict |
| 26 | Concurrency / single-winner correctness | **PASS** | Generation guard verified on real SQLite; **D9 found and fixed**; race-loser path pinned |
| 27 | Provenance survives persistence | **PASS** | Live-written row read back; survives a subsequent compaction |

**Counts: 24 PASS (2 of them indirect), 1 PARTIAL, 1 UNVERIFIED, 0 FAIL.**

---

## 22. Residual risks

| ID | Risk | Severity | Status |
|---|---|---|---|
| **K1** | User sees full history; model sees a compacted form. **No UI or API surface discloses it.** | Known product consequence | Accepted, not fixed. Needs a thread-ownership decision. |
| **K2** | Single-pass compaction refuses once the conversation outgrows the summariser's one-call capacity. | Known limit | Safely contained — refuses, rejects, never sends. Verified live. |
| **K3** | Semantic summary quality unproven. | Open | Would need an evaluation set + rubric. |
| **F-A** | Phase 2's estimate band allows sending a request whose point estimate is ~1.6× the usable budget. | Pre-existing, real | Reported, not fixed. If the provider disagrees with the estimator the user gets a generic error rather than `CONTEXT_OVERFLOW`. |
| **K4** | Off by default (`TBAI_COMPACTION_ENABLED`), so production use is unproven at scale. | Deliberate | Follows the existing env-flag precedent. |
| **K6** | Convergence is asserted with a 5% tolerance, not exact equality. | Low | Exactness is unreachable through the estimator; stated honestly. |
| **K8** | One row per conversation means a **regenerated branch loses its compaction** and reverts to full history until it re-crosses the trigger. | Low | Safe (no wrong summary applied); a UX consequence. |
| **K9** | Live verification used a model with `limitSource = conservative_default` (no configured `contextWindow`). Compaction only fires on very large conversations. | Low | A configured window would make it fire sooner. Not changed — modifying provider config to manufacture verification is forbidden. |
| **K10** | Two same-generation concurrent writers: first-writer-wins, so a summarisation can be discarded and its cost wasted. | Low | Deterministic and safe post-D9; wastes one provider call. |

**Explicitly not changed:** `pruneStaleMessages`, the Phase 2 seam's ownership, the
Phase 3 capability layer, the Scheduler, `parent_id` semantics, any dependency, and any
provider configuration.

---

## 23. Phase 5 handoff

Carried forward from the previous report, plus what this audit added.

1. **A third origin is still needed.** `CONTEXT_ORIGINS` has exactly
   `["original_user_content", "model_generated_summary"]`. Memory must add its own and
   be distinguishable from a conversation summary. Verified unchanged by this audit.
2. **The same budget, and the whole request.** Memory must be measured into the same
   `combineEstimates` total — D7's rule: never compare one layer against a
   whole-request budget.
3. **Plan over what the client re-posts.** D1 and D9 were both this mistake. It
   applies to any server-derived block.
4. **Concurrency identity must be semantic, never an opaque id.** D9's first fix was
   unsound for exactly this reason.
5. **Verify tests can fail.** Seven negative controls in this audit; three of my
   scripted attempts silently no-opped and would have read as "cannot catch this".
6. **Surface provenance if a memory can change model behaviour.** §5 shows that a
   summary with no user-facing surface is already an accepted-but-invisible
   divergence. A memory block is a larger one.
7. **Do not implement memory injection inside `assembleContext`.** The seam already
   accepts an injected collaborator.

---

## 24. Final position

**CERTIFIED WITH RESIDUAL RISKS.**

The strict standard bars "CERTIFIED" while a known correctness defect remains. One was
found during this audit (**D9**), fixed, and pinned with four tests plus a verified
negative control. No known correctness defect remains open.

Certification rests on: no known correctness defect; compaction cannot silently
increase uncontrolled context (D1, D7, D9 all found and fixed, with a 60-generation
run to confirm); tool/approval invariants preserved (9 tests fail if the structural cut
is broken); storage durable and deterministic (real-SQLite generation guard, cascade
delete, single row); concurrent compaction controlled (D9 fixed, race-loser path
pinned); timeout actually enforced (measured in wall clock against a worst-case model);
failure paths safe (byte-identical to the unwired assembly); **K2 safely contained and
verified live**; **K1 explicitly accepted as an architecture consequence with the
missing user-facing behaviour named**; **K5 honestly classified as UNVERIFIED**;
Phase 3 interaction correct; and live behaviour no longer isolated — it was observed.

The one finding I would not let pass silently: **the previous report's 22/22 claim
was wrong**, because it certified a same-generation race that silently dropped eight
messages with no provenance. It also declared live summarisation unverified when the
existing credential was in fact sufficient. Both are corrected here.

---

IMPLEMENTED — compaction as a durable marker applied at the assembly seam; bounded
summary; structured provenance; single-winner storage; opt-in gate.

VERIFIED — 24 criteria PASS by source, tests, measured runtime, negative controls,
and a live provider run. Compaction live-confirmed: ~86 000 → 14 730 tokens.

LIVE-VERIFIED — real compaction against `custom/agnes-3.0-flash`: fired, summarised
287 tokens, persisted a 14-column record, re-applied on the next turn without
re-summarising, and K2 refusal confirmed live with nothing sent.

UNVERIFIED — semantic summary quality (K5); a regulated branch losing its compaction
(K8) was not live-exercised.

UNKNOWN — nothing material left open that this environment could resolve.

DEFERRED — K1's user-facing disclosure (product decision); F-A's estimate-band
behaviour (pre-existing Phase 2, out of Phase 4's remit); K2's bound (needs chunked
summarisation); K10's wasted-call race.

PHASE 4
Architecture: C — Hybrid explicit context assembly. Unchanged. One Direct context path
(`assembleContext`, one production call site), one compaction trigger
(`runCompactionPhase`, module-private), compaction gated in exactly one place. The
Scheduler's `streamText` was confirmed to be a separate engine that cannot reach the
seam.
Implementation: `src/context/compaction/{contract,summarize,orchestrate,index}.ts`,
`src/services/compaction.ts`, one additive table in `src/db/index.ts`, wiring in
`assemble.ts` / `types.ts` / `routes/chat.ts`. Off by default.
Tests: 105 Phase 4 (contract, runtime, seam) + 4 added by this audit. Full suite
**3 069 pass / 2 skip / 0 fail** across 234 files. Phase 1/2/3 context 285/0;
approval/lifecycle/detached 132/0. Seven negative controls, each verified to fail.
Typecheck: backend exit 0, web exit 0 (re-run independently).
Build: exit 0.
Live verification: **ACHIEVED.** One credential (`agnes`, custom OpenAI-compatible);
no credential or provider configuration modified; a read-only DB copy in a scratch
`DATA_DIR`. Compaction fired, summarised, persisted, and survived a reload; K2 refusal
confirmed with nothing sent.
Certification: **CERTIFIED WITH RESIDUAL RISKS.** 24 PASS (2 indirect), 1 PARTIAL
(K1), 1 UNVERIFIED (K5), 0 FAIL. D9 found, fixed, pinned.
Residual risks: K1 (undisclosed user/model divergence — accepted, not patched), K2
(refuses safely, live-verified), K3/K5 (summary semantics), F-A (pre-existing Phase 2
estimate band), K4 (off by default), K6 (5% tolerance), K8 (branch loses compaction),
K9 (live model has no configured context window), K10 (wasted call on a tie).
Git: 7 commits, 15 files, nothing unrelated committed; 46 unrelated dirty entries left
unstaged; no Phase 3, Scheduler, pruner, or dependency change; one deliberate additive
migration. 26 ahead / 0 behind.
Push: **NOT PUSHED.**

"Phase 4 final certification complete. Phase 5 was not started."
