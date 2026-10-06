# Code Review — Context Subsystem Findings

**Review date:** 2026-10-01
**Reviewer:** separate agent, read-only
**Scope reviewed:** `src/context/**`, `src/routes/chat.ts` integration, `docs/TBAi-context-subagent-roadmap.md`
**Working tree at time of review:** commit `2165f4f` ("docs(context): correct the Phase 4 report and ADR after the trigger fix")

> **Read this first.** Another agent was actively working when this review was taken. Re-verify
> every finding against the current file before acting — anything below may already be fixed.
> Line numbers were correct at the commit named above and will drift.

**No production code, test, or configuration was changed to produce this document.**

---

## Summary

The context subsystem is well-factored and several genuinely hard decisions were got right
(see "What is correct — do not regress"). Seven findings, ranked by severity:

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | **Real defect** | Budget claims to reduce 3 categories nothing can reduce | `budget.ts:48` vs `reduce.ts:201` |
| 2 | **Real defect** | The `"reduce"` verdict is never executed by any caller | `chat.ts:439` |
| 3 | Documentation | Roadmap status header contradicts its own phase statuses | roadmap `:3`, `:1540` |
| 4 | **RETRACTED** | ~~Character corruption in roadmap~~ — verified as a non-issue, see below | roadmap `:3`, `:49`, `:1299` |
| 5 | Minor | `catch {}` discards the error without logging it | `assemble.ts:498` |
| 6 | Minor | Unused `runId` parameter | `assemble.ts:123` |
| 7 | Design | Logger redaction regex too broad; forces field renames | `logger.ts` / `budget.ts:177-187` |

**Findings 1 and 2 combine into one user-visible hole** and should be treated as a single fix.

---

## What needs to happen — the short version

**Yes, two things need fixing. Both are small. Everything else is optional tidying.**

| | What it is | Does it affect me? | Urgency |
|---|---|---|---|
| **Fix A** | The size-checker keeps a list of 6 things it thinks it can shrink. The shrinking code can only shrink 3. The 3 extras — including the assistant's own long replies — are on the list but nothing can act on them. | **Yes, sometimes.** See below. | Before your next really long chat |
| **Fix B** | When the check decides "too big, I should shrink it," **nothing shrinks it.** The message is sent anyway. | Same as Fix A — they're one hole. | Same |
| Fix C | The roadmap's top line says Phases 3–5 are unstarted. They are done. | No — paperwork only | Low |
| Fix D | An error handler throws problems away without recording them, so a repeating fault is invisible | No, but you can't diagnose it later | Low |
| Fix E | One unused variable | No | Whenever |
| Fix F | The logger treats any field name containing "token" as a secret, so honest counters get odd names | No — workaround is safe and documented | Only if it causes confusion later |

### When Fix A/B will actually bite you

Be precise, because this matters for how urgent it is:

- **Likely fine:** long coding sessions. Those produce file reads and command output, and that
  output *is* shrunk successfully. This is the common case and it works.
- **Can still fail:** a long chat with **no tool use at all** — pure conversation, like your
  personal-assistant side, or a long written discussion. Nothing in that chat can be shrunk by
  the size-checker, so it goes out too large and the AI provider rejects it. You get the old
  confusing error.
- **Partial safety net:** the new Phase 4 summarising feature *may* rescue those chats by
  summarising old messages. But summarising only triggers on a size threshold, and the size
  check that fails is the last gate before sending — so a chat can reach that gate still too big.

So: **not urgent, but a real gap that will show up eventually**, most likely in a long
tool-free conversation.

### What to hand the agent

1. Fix A and Fix B together — they are the same hole. Ask for a test using an oversized
   **assistant-text-only** conversation; that case has no coverage today.
2. Fix D — one line.
3. Fix C — update the header, and note Phase 5 is unblocked.
4. Fix E — fold into any open commit.

### One good piece of news

**Phase 5 is ready to start.** The roadmap lists it as blocked by Phase 2. Phase 2 is finished,
so nothing is standing in the way of the memory work.

---

## Plain-language summary

For the maintainer, who is not a developer:

- The app now measures every chat before sending it, and refuses anything too long. That works.
- But there are **two different lists** of "what can be made smaller." One list is what the
  shrinking code actually does. The other is what the size-checker *believes* it can do. They
  do not match — the checker's list has three extra items, including **the assistant's own
  long replies**, that the shrinking code has no ability to touch.
- On top of that: when the check decides "this is too big, I should shrink it," **nothing
  actually shrinks it.** The message is sent anyway.
- **Net effect:** a long chat with **no tool use** — pure conversation — still has no way to be
  shrunk, and can still fail with the confusing "too long" error. Long coding chats full of
  file reads and command output are handled correctly.
- Separately, the roadmap's top line still says Phases 3–5 are unstarted when they are done, and
  lists Phase 5 as blocked when it is ready.

---

## Finding 1 — Budget claims to reduce categories nothing reduces

**Severity: real defect.** This is precisely the failure the code's own comment was written to prevent.

`src/context/reduce.ts:197-199` states:

> *"Exported so `budget.ts` and the diagnostics agree with what `reduce.ts` actually touches.
> Keeping one list prevents the budget from claiming to reduce a category nothing reduces."*

The list was exported. `budget.ts` never imported it and declared its own instead.

| Constant | Contents | Meaning |
|---|---|---|
| `reduce.ts:201-205` — `REQUEST_REDUCIBLE_CATEGORIES` | `mcp_results`, `tool_results`, `reasoning` | What reduction **actually does** |
| `budget.ts:48-55` — `REDUCIBLE_CATEGORIES` | those 3 **plus** `data_parts`, `attachments`, `assistant_text` | What the budget **claims** it can reduce |

Evidence the shared list is dead code:

- `REQUEST_REDUCIBLE_CATEGORIES` is exported at `reduce.ts:201` and re-exported at `index.ts:45`.
- A repo-wide search finds **no importer**. `budget.ts:15` imports only from `./limits`.
- `budget.ts:155` returns `reduced: [...REDUCIBLE_CATEGORIES]` — asserting a reduction of
  `data_parts`, `attachments` and `assistant_text` that never happened.

### Suggested fix

Delete `REDUCIBLE_CATEGORIES` from `budget.ts:48` and import `REQUEST_REDUCIBLE_CATEGORIES`
from `./reduce`. If any of the three extra categories genuinely should be reducible, implement
reduction for them in `reduce.ts` first — then the single list stays truthful.

### Regression guard worth adding

A test asserting the two lists are identical would have caught this and will catch the next
divergence:

```ts
// the budget must never name a category reduce.ts does not touch
expect(REDUCIBLE_CATEGORIES).toEqual(REQUEST_REDUCIBLE_CATEGORIES);
```

---

## Finding 2 — The `"reduce"` verdict is never executed

**Severity: real defect.**

`decideBudget` returns one of three actions, but only two have any effect.

Pipeline order in `assemble.ts`:

```text
:204  reduceToolResults(...)   ← the ONLY reduction pass, runs first
:268  measure
:274  decideBudget(...)        ← may return "reduce"
:279  modelMessages = decision.action === "reject" ? [] : prepareModelMessages(...)
```

`reduce.ts` runs **before** the budget decides, and there is no second reduction pass after it.
A repo-wide search for `decision.action` finds only:

- `chat.ts:439` — `if (assembled.decision.action === "reject")`
- `assemble.ts:279` — the `reject` ternary above

Nothing acts on `"reduce"`. The verdict is recorded in diagnostics
(`budget.ts:232`, `reducedCategories`) and then ignored; the oversized request is sent.

### The reachable hole

`"reduce"` is returned from two places:

- `budget.ts:136` — when `usableInputTokens === undefined` (no enforceable ceiling)
- `budget.ts:155` — when `estimate.range.low <= usable < estimate.range.high`
  (the uncertainty band straddles the budget)

The `accept` path at `budget.ts:143-145` already covers the case *"reduction happened **and** the
point estimate fits"*. So the unguarded case is: **nothing was reducible** (`reducedAlready === false`,
because `reduce.ts` found no tool results / MCP output / reasoning to shrink) **and** the band
straddles the budget. The verdict is `"reduce"`, nothing reduces, and the request goes out.

### Consequence

A conversation that is oversized because of **assistant text** has no reduction path in this
module. Be precise about how far that goes:

- `reduce.ts` only shrinks tool results, MCP output and reasoning. Assistant prose is never
  shrunk by any path in the budget.
- The affected request is therefore **not rejected** either — `action` is `"reduce"`, and only
  `"reject"` stops the send (`chat.ts:439`). So it goes out oversized and fails at the provider,
  which is the pre-Phase-2 behaviour this work existed to remove.
- **Scope limit, stated honestly:** the trigger requires `reducedAlready === false`, i.e. a chat
  with *nothing* reducible in it. A coding session almost always has tool results, so it takes
  the `accept` path at `budget.ts:143-145` and is fine. The realistic victim is a long chat with
  **no tool use at all** — a personal-assistant conversation, or a long written discussion.
- **Partial mitigation already in place:** Phase 4 compaction can summarise old messages
  regardless of type, so some of these chats will be rescued before they reach the failing gate.
  It triggers on a threshold, though, so a chat can still arrive at the budget gate too large.

### Suggested fix — pick one and make it honest

Either:

1. **Perform the reduction.** Add a second reduction pass after the decision, scoped to
   `REQUEST_REDUCIBLE_CATEGORIES`, then re-measure and re-decide (bounded, e.g. one retry);
   **or**
2. **Stop pretending.** Where the intent is "the point estimate fits, so send it," return
   `action: "accept"` with the real headroom rather than `"reduce"` with a `reduced` list that
   describes work nobody did.

Option 2 is the smaller change and is correct for the `reducedAlready === true` case. Option 1 is
required for the `reducedAlready === false` case. **If option 2 alone is taken, the
`reducedAlready === false` path must be made explicit** — either reject, or document that such
requests rely on provider-side enforcement.

Either way, add a test that constructs an oversized **assistant-text-only** conversation and
asserts what actually happens. That case has no coverage today.

---

## Finding 3 — Roadmap status header is stale

**Severity: documentation.**

`docs/TBAi-context-subagent-roadmap.md:3` reads:

> `**Status:** Phase 1 complete · Phase 2 implemented · Phases 3-5 not started`

This contradicts the file's own phase sections:

| Phase | Header says | Phase section says | Line |
|---|---|---|---|
| 3 | not started | `CERTIFIED WITH RESIDUAL RISKS`, closed 2026-10-01 | `:599` |
| 4 | not started | `CERTIFIED WITH RESIDUAL RISKS` | `:1040` |
| 5 | not started | `NOT STARTED` | `:1301` — correct |

The Execution Order table is stale too: `:1540` still shows
`Phase 2  Context Foundation   NOT STARTED`, and the surrounding block (`:1556`, `:1562`) carries
`NOT STARTED` markers that no longer match the phase sections.

**Also note — Phase 5's blocker is satisfied.** `:1301` reads *"NOT STARTED. **Blocked by Phase 2**
(measurement + budget)"*. Phase 2 is now implemented and certified, so **Phase 5 (Memory → Model
Context) is unblocked and ready to begin.**

---

## Finding 4 — RETRACTED: apparent character corruption is a console artifact

**This finding was raised and then withdrawn. Do not spend time on it.**

The review initially reported that the roadmap had lost its `✅`, its `→` and its `·` separators,
based on reading the file through a console that does not render UTF-8:

```
## Phase 1 - Context Architecture Audit ? COMPLETE     ← looked like a lost ✅
## Phase 5 - Memory  Model Context                      ← looked like a lost →
```

Checked at the byte level, **the file is fine**:

| Line | Contains | Codepoint |
|---|---|---|
| `:3` | middle dot separators | `U+00B7` |
| `:49` | check mark + em dash | `U+2705`, `U+2014` |
| `:1299` | rightwards arrow + em dash | `U+2192`, `U+2014` |

The substitution happens in the terminal, not the file. Recorded here for the same reason the
OpenChamber study recorded the `<task_result>` envelope as "looks like a bug and is not" — so the
next reader does not re-chase it.

**If you read these docs through a non-UTF-8 console and see `?` or `�`, that is the console.**
Read with explicit UTF-8 (`Get-Content -Encoding UTF8`, `less`, or any editor) before believing
a character was lost.

---

## Finding 5 — `catch {}` discards the error without recording it

**Severity: minor.** `assemble.ts:498`.

```ts
} catch {
  // Contained. The conversation proceeds uncompacted ...
  return { ..., report: { ...base, reason: "compaction_error" } };
}
```

The failure is contained by design and that is correct. But the caught value is discarded entirely,
so a compaction that fails on every request is indistinguishable in production from one that never
ran — both produce `reason: "compaction_error"` with no diagnostic.

`AGENTS.md` §3: *"Error handling: catch at the boundary, surface a typed result or throw a domain
error. No silent `catch {}` swallows."*

### Suggested fix

```ts
} catch (cause) {
  logger.warn("context", "compaction_error", {
    conversationId: input.conversationId,
    errorType: cause instanceof Error ? cause.name : typeof cause,
  });
  ...
}
```

Log the **type**, never the message or payload — this matches the existing convention in
`assemble.ts:346` and elsewhere, and keeps the no-content-in-logs rule intact.

---

## Finding 6 — Unused `runId` parameter

**Severity: minor.** `assemble.ts:123`.

`buildToolLayer`'s input declares `runId: string`, and `assemble.ts:184` passes
`runId: input.runId`. The function body reads only `toolSignal`, `terminalTap` and `extraTools`.
Dead parameter — remove it, or use it (the tool layer is a natural place for a per-run correlation
id in diagnostics).

---

## Finding 7 — Logger redaction pattern is too broad

**Severity: design note. Not a defect — the workaround is correct and well documented.**

`budget.ts:177-187` documents this well and deserves credit for noticing it: the logger redacts
any field whose key matches `.*token.*`, because keys like `authToken` really are secrets. The
consequence is that honest counts cannot be logged under honest names, so fields became
`usableInput` (not `usableInputTokens`) and `charsPerUnit` (not `charsPerToken`), carrying
`unit: "tokens"` to stay unambiguous.

That is the right call **at the log boundary**, and relaxing the security regex would have been
the wrong move. But the underlying problem is in `src/lib/logger.ts`: `.*token.*` will redact any
future field containing that substring, and the cost is a permanent naming tax at every call site
plus a permanent re-reading hazard for anyone reading a log line.

### Suggested fix, at the source

Replace the broad pattern with the specific secret names it is actually protecting
(`authToken`, `refreshToken`, `apiKey`, `api_key`, `authorization`, …), then restore the honest
field names. Do this as its own change with its own review — it touches a security boundary, and
the current behaviour is safe. Only worth doing if the naming tax is becoming a real problem.

---

## What is correct — do not regress

These were hard calls and they were made properly. Listed so a later pass does not "simplify" them.

| Decision | Location | Why it matters |
|---|---|---|
| **Deterministic tool ordering** — sorted keys for native, extra and MCP tools | `assemble.ts:140-147` | `getAiTools` iterates connections in connect order, so the same logical tool set serialized differently per request. Since the cacheable prefix is `A → B → C`, unstable Layer B silently destroys Layer C's cacheability. This was the prerequisite for Phase 3 and was correctly built in Phase 2. |
| **Output reserved before input is computed** | `budget.ts:97` | Computing input from a limit that has not had output subtracted is the classic arithmetic error that lets a request fill the whole window. The comment names it. |
| **Accept decided on the pessimistic end of the band** | `budget.ts:131` | Under-estimating input lets an oversized request escape; over-estimating only rejects slightly early. Correct direction. |
| **Lifecycle repair kept separate from size management** | `assemble.ts:41-44`, `budget.ts:1-12` | The pruner removes what is *invalid*; reduction bounds what is *large*. Merging them would let a size decision drop an unexpired approval decision. `pruneStaleMessages` correctly stayed a pruner. |
| **Summariser capacity separated from turn budget** | `assemble.ts:332-356` | Deriving the summariser's ceiling from the turn budget undershot real capacity by roughly the safety margin, so every real compaction was refused with `summary_exceeds_budget` and the phase could never fire. Caught by testing. |
| **Compaction planned over client messages, not the re-applied view** | `assemble.ts:422-432` | `applyExistingCompaction` injects a server-side block whose id the client has never seen, so planning over it produced a non-durable record and the conversation grew without bound. Also caught by testing. |
| **Diagnostics never carry content** | `assemble.ts:300-327` | Counts, categories and fingerprints only. The `compactionSummarySize` / `compactionReclaimedSize` rename dodges the `.*token.*` redaction honestly rather than bypassing it. |
| **Honest error model in the estimator** | `measure.ts:10-27` | Deliberately pessimistic 3 chars/token vs the ~4 prose rule, states the 2.5–5 band, and says plainly that *"neither the point estimate nor the range is a guarantee."* |
| **Scheduler deliberately excluded from the assembly seam** | `assemble.ts:46-49` | Unattended, no submitted history, own synthetic prompt. Recorded in the ADR rather than left implicit. |

---

## Suggested order of work

1. **Findings 1 + 2 together** — they are one user-visible hole. Add the assistant-text-only test first.
2. **Finding 5** — one line, removes a blind spot in production diagnostics.
3. **Finding 3** — documentation. Note in the header that Phase 5 is unblocked.
4. **Finding 6** — trivial cleanup, fold into whichever commit is open.
5. **Finding 7** — separate change, own review, only if the naming tax is causing real confusion.

---

## What this review did not cover

- **Runtime behaviour.** No AI request was made and no test suite was executed for this review.
  All findings are from reading code and searching the working tree. Findings 1 and 2 are
  structural and provable by reading; they should be confirmed with a test before and after the fix.
- **Phase 3 cache verification** (`src/context/cache/**`) — read at a high level only. The closure
  report marks it `CERTIFIED WITH RESIDUAL RISKS` with per-block markers deferred; that judgement
  was not re-litigated here.
- **Phase 5 (Memory → Model Context)** — not started, nothing to review.
- **Uncommitted work in the tree.** At review time the working tree also contained unrelated
  in-flight changes (tab reconciliation, context menu, devtools gate, several root-level scratch
  test files `p2.test.ts` … `p1314.test.ts`, `audit-harness.ts`). None were reviewed and none
  should be assumed intentional.