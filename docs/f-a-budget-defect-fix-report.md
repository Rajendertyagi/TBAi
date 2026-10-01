# F-A — Budget Defect Investigation and Fix Report

**Date:** 2026-10-01
**Scope:** TBAi only (`D:\Temp\ai-chat-app`). Phase 2 (`src/context`) with one Phase 4
seam adjustment. Phase 5 NOT started.
**Baseline for every comparison:** `ad00a2b` (Phase 4 final PM certification).
**Commits:** `83d4cf2`, `0f36e08`, `c9dfe7f` — local only, **nothing pushed**.

---

## 0. Summary of the finding

F-A was recorded in the Phase 4 audit as a *residual risk*: "Phase 2's estimate band
allows sending a request whose point estimate is ~1.6× the usable budget."

**That classification was wrong, and it was wrong for a reason the Phase 4 audit could
not see from its numbers.** `decideBudget` returned a `"reduce"` verdict that **no
consumer acted on**. Every consumer — `assemble.ts:279`, `chat.ts:439`,
`budget.ts:246` — branched on `"reject"` alone. So:

- a `"reduce"` verdict **meant "send it anyway"**, while
- it *claimed* a reduction had happened, and
- the categories it claimed came from a hardcoded six-item list in `budget.ts` while
  `reduce.ts` only ever reduces three.

The verdict was not a deliberate policy about the estimate band. It was an **unhandled
state** that no type or test constrained. That is a defect, not a risk.

**Classification:** IMPLEMENTED · VERIFIED · RE-CLASSIFIED

---

## 1. Independent reproduction

Reproduced with the **real assembly seam** (`assembleContext`), the real estimator and
the real budget, before any code was changed. A temporary harness drove the actual
pipeline; it has been deleted.

```
usable budget = 23232   (32 000-token window, maxOutputTokens 1024,
                         SAFETY_MARGIN_FRACTION 0.25, compaction NOT wired)

chars=60000: point=30790 low=18474 high=36948 usable=23232 verdict=reduce sent=21
chars=70000: point=34129 low=20477 high=40954 usable=23232 verdict=reduce sent=25
chars=80000: point=37466 low=22480 high=44959 usable=23232 verdict=reduce sent=28   <-- straddle
chars=90000: point=40803 low=24482 high=48964 usable=23232 verdict=reject sent=0
```

At **80 000 characters**: point estimate **37 466** vs usable **23 232** — **61% over
budget** — with `reduction: null` (nothing reducible) and compaction never offered.
Verdict `"reduce"`. **28 model messages produced and sent.**

### The full truth table of `decideBudget` as it stood

Enumerated directly against the pre-fix function:

| Scenario | Verdict | Consumer acts? |
|---|---|---|
| `usable` undefined | `reduce` | no |
| `high ≤ usable` | `accept` | send |
| reduced + `point ≤ usable` | `accept` | send |
| `low > usable` | `reject` | **block** |
| NOT reduced + `point ≤ usable` | `reduce` | no |
| reduced + `point > usable` | `reduce` | no |
| NOT reduced + `point > usable` | `reduce` | no |

**`"reduce"` was returned in 4 of 7 scenarios. None had a consumer.** The only branch
that ever stopped a request was `low > usable` — i.e. only when the request was
provably over at *every* plausible tokenisation.

### The diagnostic lie, reproduced

`decideBudget` on a request where **nothing had been reduced** returned
`reduced: ["mcp_results","tool_results","reasoning","data_parts","attachments","assistant_text"]`.
`reduce.ts` only ever touches the first three. Production logs claimed reductions of
`data_parts`, `attachments` and `assistant_text` that nothing performed.

**Classification:** IMPLEMENTED · VERIFIED

---

## 2. Root cause

Three distinct causes, only one of which is the estimate band itself.

1. **An unhandled verdict.** `"reduce"` was in the `BudgetDecision` union, returned in
   the majority of decision paths, and consumed by nobody. TypeScript cannot catch this:
   a consumer is free to ignore a union member. Nothing asserted that every member had
   a consumer.

2. **A boolean where a state was needed.** The only reduction signal reaching the gate
   was `reducedAlready: boolean`. It cannot distinguish *"nothing left to try"* from
   *"nothing was offered"* — and cannot say *which* mechanism was involved, or why
   another one did not run. For an assistant-text-only request it was `false`, which the
   gate could only interpret as "reduction did not happen, therefore …?" — and the
   answer it settled for was "send it".

3. **A duplicated source of truth.** `REDUCIBLE_CATEGORIES` (6 items, `budget.ts`) and
   `REQUEST_REDUCIBLE_CATEGORIES` (3 items, `reduce.ts`). `reduce.ts` exported its list
   with the comment *"so `budget.ts` and the diagnostics agree with what `reduce.ts`
   actually touches"* — and had no importer.

**Why the Phase 4 audit classified it as a residual risk:** it measured the
*consequence* (requests sent over budget) without noticing that the verdict producing
that behaviour was dead code. A table of numbers cannot distinguish "we decided to be
permissive" from "nobody read our decision".

**Classification:** VERIFIED

---

## 3. Mechanism-aware policy

### The governing distinction

> **nothing left to try** vs **nothing was offered**

Encoded as a two-member discriminated union — not a bag of booleans, so "exhausted AND
withheld" is **unrepresentable**:

```ts
export type MechanismOutcome =
  | { readonly kind: "exhausted"; readonly reason: ReductionReason }
  | { readonly kind: "withheld";  readonly reason: ReductionReason };
```

- **`exhausted`** — done for this request. It applied and is now at its cap, or it was
  applicable and has nothing left to take. *Nothing safe remains.*
- **`withheld`** — could have helped and was deliberately not used: the hysteresis latch
  (releases on a later turn) or a failure. *Sent deliberately.*

### The final matrix — every row resolved, none left as "policy-defined"

| Reduction state | `point` vs `usable` | Verdict | Reason |
|---|---|---|---|
| Fits at the pessimistic end | `high ≤ usable` | **accept** | — |
| Certain over-limit | `low > usable` | **reject** | `over_limit` |
| Nothing needed, band straddles | `point ≤ usable` | **accept** | usable budget already holds back the safety margin |
| **Case B** — reduction applied, still over | `point > usable` | **reject** | `reduction_exhausted` |
| **Case C** — all mechanisms exhausted | `point > usable` | **reject** | `reduction_exhausted` |
| **Case D** — mechanism withheld | `point > usable` | **accept** | — |
| Case D + certain over-limit | `low > usable` | **reject** | `over_limit` (Case D does not weaken this) |
| No enforceable ceiling | `usable` undefined | **accept** | `budget.enforceable === false` |
| Invalid reduction result | — | **impossible** | discriminated union; `unknown` for an unrecognised *reason* |

### The judgement call, stated because it is debatable

`not_attempted` → **`exhausted` / reason `disabled`**, *not* `withheld`.

With compaction off, the configured policy **is** "reduce tool output only". Exhausting
tool-output reduction is therefore nothing left to try *under that policy*, so the
request fails fast with an actionable `CONTEXT_OVERFLOW` instead of shipping oversized
and failing opaquely. The `disabled` reason stays visible in the verdict and in
diagnostics, so the operator can see compaction was never offered.

`above_release_but_within_hysteresis` → **`withheld`**. That conversation was already
compacted once and will compact again; rejecting it would fail a conversation one turn
from recovery.

**This is a deliberate policy choice and the maintainer's Case D wording admits
`disabled` as a Case D example.** Treating `disabled` as Case D would leave F-A's
primary reproduction unfixed, so the reading chosen is the one that both fixes the
defect and preserves Case D for the case that genuinely is transient (hysteresis).
**If you disagree, flip one mapping in `src/context/compaction/outcome.ts`** — it is a
`case` label, not a structural change.

### Estimator-band semantics (retained, documented)

The band is **not** provider truth and is never treated as such.

| Situation | What the system does |
|---|---|
| Band fits at the dense end | Trusts the *high* end — the number that could actually be sent |
| Band proves over at the dense end | Rejects. Certain, so no reduction needed |
| Band straddles, point fits | Trusts the point estimate: the usable budget already subtracts `SAFETY_MARGIN_FRACTION` (0.25) for the estimator's documented pessimism (3 chars/token vs a ~4 prose rule) |
| Band straddles, point over, exhausted | Rejects — does not send and hope |
| Band straddles, point over, withheld | Sends. Explicitly permissive, and the withhold is logged |

**Classification:** IMPLEMENTED · VERIFIED

---

## 4. Implementation

| File | Change |
|---|---|
| `src/context/types.ts` | `ReductionReason`, `MechanismOutcome`, `ReductionRecord` added. `BudgetDecision` reduced to **two** variants; `"reduce"` **removed**. Both variants carry `reduction`. |
| `src/context/budget.ts` | `decideBudget` takes `reduction: ReductionRecord` (required — no defaulting). Five ordered branches per §3. `hasWithheldMechanism` is the single place Case D is decided. `REDUCIBLE_CATEGORIES` now derived from `reduce.ts`. Diagnostics emit per-mechanism disposition, reason, and `reductionWithheld`. |
| `src/context/compaction/outcome.ts` | **New.** `describeCompactionOutcome` maps every reachable `CompactionReport.reason` to a disposition. Owns Phase 4 vocabulary so `budget.ts` stays Phase 2. |
| `src/context/reduce.ts` | `describeToolResultReduction`. Always `exhausted` — the pass always runs and always caps in one go; `applied` vs `no_reducible_content` distinguished. |
| `src/context/assemble.ts` | Builds `ReductionRecord` from both mechanisms before the verdict. |
| `src/context/index.ts` | Exports the new types and `describeCompactionOutcome`. |

**Ownership respected:** each mechanism classifies its own outcome in the module that
owns its vocabulary. `budget.ts` never learns a Phase 4 reason string. No framework,
no registry, no second context system.

### `catch {}` at the compaction boundary (Finding 8)

Containment was correct and is **unchanged** — a failed compaction must not leave the
conversation worse. What was wrong was the silence: a bare `catch {}` made every
failure indistinguishable from "compaction was never offered", so a summariser failing
on every turn looked exactly like a build with the feature off. Now:

```ts
} catch (error) {
  logger.warn("context", "compaction_error", {
    errorType: error instanceof Error ? error.name : typeof error,
  });
```

**Only the error type.** A summariser or storage error can quote the span it was
handed, so the message and stack are never logged. Asserted in tests.

### `runId` on `buildToolLayer` (Finding 9)

Declared, passed at the call site, **never read**. Removed rather than wired up,
because the only place it could honestly go is the returned layer — and a per-run id in
the serialized Layer B makes the cacheable prefix differ on every request, destroying
Layer C's cacheability in exactly the way that function exists to prevent. A doc comment
records this so it is not re-added.

**Classification:** IMPLEMENTED · VERIFIED

---

## 5. `REDUCIBLE_CATEGORIES` cleanup

**Decision:** derive, do not merge, do not delete.

```ts
export const REDUCIBLE_CATEGORIES: readonly ContextCategory[] = REQUEST_REDUCIBLE_CATEGORIES;
```

**Why not merge the two lists:** they were never two layers. The six-item list named
`data_parts`, `attachments` and `assistant_text`, which `reduce.ts` **never
implemented**. It was an aspiration, not a layer definition. Merging would have
promised three reduction targets that do not exist.

**Reduction semantics are unchanged** — the same three categories are reduced, in the
same order, with the same pairing guarantees.

Two tests pin it: `toEqual(REQUEST_REDUCIBLE_CATEGORIES)`, and a loop asserting every
named category is one `reduce.ts` implements. A future divergence is a test failure,
not a lie in a production log.

**Classification:** IMPLEMENTED · VERIFIED

---

## 6. Error handling / `runId` cleanup

See §4. Both are `IMPLEMENTED · VERIFIED`, with `runId` additionally confirmed dead by
grep across `src/`, `web/src/` and `tests/` (4 test call sites updated; no other
consumer).

---

## 7. Tests

### `src/context/budget-oversize.test.ts` — NEW, 14 cases

**Rule enforced in this file:** every assertion states the **exact** verdict.
`expect(verdict).not.toBe("accept")` is banned — it passes for the dead `"reduce"` and
proves nothing (demonstrated as NC4). Each test also asserts what happened to the
messages, because "not accept" and "not sent" are the property that matters.

Through the **real** `assembleContext` seam:

| Test | Asserts |
|---|---|
| REJECTS it — before the fix this shipped 61% over budget | `reject` / `reduction_exhausted` / `overBy > 0`, `modelMessages` length 0, **and** the preconditions (`point > usable`, `low ≤ usable`, `reduction === null`) |
| names the cause | `reduction` record + `toolResultReductionReason` / `compactionReductionReason` / `reductionWithheld` in diagnostics |
| REJECTS when tool-result reduction APPLIED and still over (Case B) | `reject` / `reduction_exhausted`, `toolResults: exhausted/applied`, 0 messages |
| REJECTS when every applicable mechanism is exhausted (Case C) | `reject` / `over_limit` |
| ACCEPTS once reduction brings it inside | `reducedParts > 0`, `accept`, messages sent |
| ACCEPTS an ordinary small conversation | `accept` |
| logs compaction_error with an error type | exactly **1** entry, `level: warn`, `scope: context`, `errorType: TypeError`; assembly still succeeds |
| records the error TYPE only | no `message`, no `stack`, serialized entry omits the thrown text |
| summariser failure is withheld, not a silent success | `summarize_failed:*`, `reduction.compaction === { withheld, failed }`, `reductionWithheld: true` |
| maps every reachable compaction reason | 14 (reason → disposition → reason) triples |
| decodes a re-applied record's embedded reason | `record_applied_no_new_compaction:…hysteresis` → `withheld/hysteresis` |
| falls back to `unknown` rather than dropping a reason | unrecognised reason → `exhausted/unknown` |
| both tool-reduction outcomes are exhausted, distinctly | `applied` vs `no_reducible_content` |
| BudgetDecision has exactly two variants, both reachable | 4 branches pinned to exact verdicts |

### `src/context/budget.test.ts` — decision block rewritten

The four old decision tests, one of which asserted `not.toBe("accept")` on a request
that **was** sent, replaced by:

- the mechanism-aware matrix, including **five distinct withhold reasons** each
  accepting an over-budget request (Case D, parameterised);
- a certain over-limit still rejecting **even when something was withheld**;
- a one-token-over case rejecting (no special-casing near the boundary);
- `high ≤ usable` accepting on the honest high-end headroom;
- unenforceable budgets accepting rather than claiming a reduction they cannot perform;
- both verdicts carrying the full record;
- diagnostics asserting `reducedCategories` is now **absent** (the Finding 1 lie);
- `REDUCIBLE_CATEGORIES` parity.

### Contract test updated, not weakened

`compaction/seam.test.ts` asserted `attempted.decision.action === untouched.decision.action`.
That held only because the gate was uniformly permissive. It now asserts the deliberate
difference — request still byte-identical, plus **both directions**:

```
attempted (summarize_failed) → withheld/failed    → accept
untouched (not_attempted)    → exhausted/disabled → reject
```

### Test totals

| Suite | Result |
|---|---|
| `src/context` (Phase 1/2/3/4) | **297 pass / 0 fail** / 9 files |
| `budget-oversize.test.ts` + `budget.test.ts` | **58 pass / 0 fail** |
| Phase 1/2 invariants, isolated (6 suites) | **65 pass / 0 fail** |

**Before this work the same context directory held 297 tests across 9 files; the 4 old
decision tests were replaced by 13, and 14 new F-A tests were added → net +23.**

**Classification:** VERIFIED

---

## 8. Adversarial negative controls

Each control was applied with the edit tool, **confirmed applied by grep**, run, then
reverted and confirmed reverted. No control silently failed to apply.

| # | Injected defect | Caught by | Applied? |
|---|---|---|---|
| **NC1** | Case B/C sends again (`if (true)` for the withhold check) | **6 tests** | YES |
| **NC2** | Certain over-limit no longer rejects (`low > usable && false`) | **4 tests** | YES |
| **NC3** | Dead `"reduce"` verdict reintroduced | **2 tests** | YES |
| **NC4** | Assistant-text-only assertion weakened to `not.toBe("accept")` | **test PASSED while the defect was live** | YES |
| **NC5** | Reduction claims `applied` when nothing was reduced | **2 tests** | YES |

### NC4 is the important one

It did not "fail" — it **passed**, which is the point. With the exact verdict assertion
replaced by `not.toBe("accept")` and the `modelMessages` guard removed, the test
**passed while the dead `"reduce"` verdict was live and an oversized request was being
sent.** That is a direct demonstration that the assertion shape the review flagged
cannot detect F-A, and it is why the shipped tests state exact verdicts and also assert
the message count.

### NC3 initially caught by only 1 test — a real gap in my test

The first "no dead verdicts" test exercised only the `high ≤ usable` and `over_limit`
branches, so the straddle branch — the one the dead verdict came from — hid behind
them. The test was **strengthened** to pin all four decision branches to exact
verdicts, and NC3 was re-run to confirm it is now caught by 2 tests. Recording this
because a negative control that passes on the first attempt proves nothing.

**All temporary defects removed and confirmed absent by grep. Final state: 297 pass /
0 fail, both typechecks clean, build exit 0.**

**Classification:** VERIFIED

---

## 9. Phase 1/2/3/4 regression

### Pre-existing suite failures — an important finding

The full suite reports **2835 pass / 2 skip / 285 fail**. **These 285 failures are not
mine.** Established by experiment, not assumption:

| Tree | pass | fail | files |
|---|---|---|---|
| clean `ad00a2b` (all work stashed) | 2712 | **283** | 255 |
| with the F-A work | 2835 | **285** | 261 |

The **unique failing-test set is byte-identical: 259 before, 259 after. Zero newly
failing, zero fixed.** They are cross-file SQLite contention in the parallel
full-suite run — confirmed by `tests/unit/db.test.ts` passing 6/6 in isolation while
failing in the suite, and `approval-secret-integrity.test.ts` passing 3/3 in isolation
while importing nothing this change touches.

### Invariants re-run, each suite in isolation

| Invariant | Result |
|---|---|
| `prune-messages` (lifecycle repair) | 15 / 0 |
| Approval lifecycle | 8 / 0 |
| Conversation lifecycle | 12 / 0 |
| Detached history finalization | 26 / 0 |
| Shutdown lifecycle | 1 / 0 |
| Approval secret integrity | 3 / 0 |
| **Total** | **65 / 0** |

### `pruneStaleMessages` byte-unchanged — verified

```
git diff --stat ad00a2b..HEAD -- src/lib/prune-messages.ts   →   (empty)
```

`src/lib/prune-messages.ts` and `src/lib/model-messages.ts` are **not in the commit
set at all.** Not read, not modified, not repurposed to solve F-A.

### Phase 3 / 4 / scheduler / storage untouched — verified

`git diff --name-only ad00a2b..HEAD` returns **14 files, all under `src/context/` and
`docs/`**. Explicitly verified clean: `src/context/cache`, `src/services/scheduler`,
`src/services/opencode`, `src/services/storage`, `src/db`, `src/routes/scheduler.ts`,
`src/routes/conversations.ts`, `src/lib/prune-messages.ts`, `package.json`, `web/`.

Phase 3 cache capability logic, Phase 3 provider options, the Phase 4 compaction
architecture, the D9 race fix, provenance storage and the Scheduler are untouched.
The single Phase 4 adjustment is a **compatibility** one: `seam.test.ts` updated for
the new verdict, and a new `compaction/outcome.ts` translating Phase 4 reason strings
into the Phase 2 vocabulary. Compaction still never overrides the budget — it only
reports.

**Classification:** VERIFIED

---

## 10. Provider fallback behaviour

| Scenario | Behaviour |
|---|---|
| Locally rejected for context overflow | Provider is **not** called. `modelMessages` is empty (asserted), so `chat.ts:439` returns `CONTEXT_OVERFLOW` pre-flight |
| Deliberately allowed under Case D | Provider **is** called and **may still reject it.** Local estimation does not eliminate provider disagreement, and is not claimed to |
| Provider rejects it for context | The existing `context_overflow` classifier in `errors.ts` still produces the actionable error where pattern matching supports it (unchanged, and pinned by 8 pre-existing tests) |

**Honest limitation:** Case D deliberately keeps requests that may be oversized. A
provider that counts tokens differently than the estimator can still fail those with a
generic error. That is the pre-existing trade-off the mechanism-aware policy preserves,
now made explicit rather than accidental. It is *observable* — `reductionWithheld:
true` and the withholding reason are in every diagnostic line.

**Classification:** IMPLEMENTED · VERIFIED

---

## 11. Residual risks

| # | Risk | Severity | Status |
|---|---|---|---|
| **R1** | With compaction **off**, an over-budget tool-free conversation now **rejects** where it previously sent (and usually worked, thanks to the pessimistic estimator). The user gets `CONTEXT_OVERFLOW` instead of a possibly-successful send | **Medium — deliberate** | The fix's purpose. Enable `TBAI_COMPACTION_ENABLED=1` or switch model. Diagnostics say `compactionReductionReason: disabled` |
| **R2** | The same applies to coding chats whose tool-result reduction applies but is insufficient | **Medium** | Previously sent-and-maybe-worked; now fails fast. Quantified: a reduced result caps at 65 536 chars ≈ 21 845 tokens |
| **R3** | `disabled → exhausted` is a judgement call; the maintainer's Case D wording admits `disabled` | **Low** | One `case` label in `compaction/outcome.ts`. Stated in §3 |
| **R4** | The estimator can still disagree with a provider in Case D | Pre-existing | Preserved deliberately; observable |
| **R5** | 285 pre-existing full-suite failures from cross-file DB contention | **Pre-existing, out of scope** | Proven not caused by this change (§9) |
| **R6** | `pruneStaleMessages` unchanged, so an over-budget history is still repaired only for *lifecycle* validity, never for size | Pre-existing | By design (G17) |

**DEFERRED:** K1's user-facing disclosure (product decision, unchanged). Finding 7 of
the code review (touches a security boundary; current behaviour is safe).

**Classification:** DEFERRED (R3 reviewable) · documented (R1–R6)

---

## 12. Documentation changes

| File | Change |
|---|---|
| `docs/phase-2-final-certification.md` | **Dated ADDENDUM** to §8 stating this certification could not see the defect (its overflow path is only reached on `reject`). New **F-A row in the §13 residual table**, classified a confirmed Phase 2 **defect**. Original text untouched |
| `docs/phase-4-final-certification.md` | **Dated SUPERSEDED note** under F-A giving the two facts that reclassify it. §843 summary row now points at the reclassification. **Original measurement and wording left intact** |
| `docs/TBAi-context-subagent-roadmap.md` | Status header corrected (Phases 2–4 certified, with evidence links); Phase 5's "Blocked by Phase 2" → **NOT BLOCKED**, not started by decision; Execution Order Phase 2/3/4 markers corrected |
| `docs/f-a-budget-defect-fix-report.md` | This document |

**No historical audit was rewritten to appear as though it knew a later finding.** Every
correction is additive and dated.

**Classification:** IMPLEMENTED · VERIFIED

---

## 13. Git state

```
Branch:   main, 31 ahead of origin/main, 0 behind
Commits:  83d4cf2  fix(context): independent cleanup
          0f36e08  fix(context): F-A - mechanism-aware budget decision
          c9dfe7f  test(context): F-A regression suite
          eb7349d  docs(context): F-A report (this file)
          eb7349d (HEAD)
Pushed:   NOTHING
```

| Commit | Contents | Verified in isolation |
|---|---|---|
| `83d4cf2` | `REDUCIBLE_CATEGORIES` derivation; recorded compaction errors; `runId` removed; 3 docs | **269 pass / 0 fail**, typecheck clean |
| `0f36e08` | `ReductionRecord` / `MechanismOutcome`; `decideBudget`; `compaction/outcome.ts`; `describeToolResultReduction`; wiring; contract tests | with commit 3 |
| `c9dfe7f` | `budget-oversize.test.ts` (14 tests) | **14 pass / 0 fail** |
| `eb7349d` | This report | — |

`assemble.ts` and `budget.ts` carry both commit-1 and commit-2 changes, so they were
**split by content**: the commit-1 blob was built from HEAD plus only the commit-1
edits, staged, committed, and then **verified green in isolation by stashing the
remaining work** (269 pass / 0 fail) — not merely asserted to be valid.

### Final verification, all re-run independently

| Check | Command | Result |
|---|---|---|
| Backend typecheck | `bun x tsc --noEmit -p tsconfig.json` | **exit 0**, no errors |
| Web typecheck | `cd web && bun x tsc --noEmit` | **exit 0**, no errors |
| Production build | `bun run build` | **exit 0**, `✓ built in 17.80s` |
| Context suite | `bun test src/context` | **297 pass / 0 fail** / 9 files |
| Phase 1/2 invariants | 6 suites, isolated | **65 pass / 0 fail** |
| Full suite | `bun test` | 2835 pass / 2 skip / **285 fail — all 285 pre-existing** (§9) |
| Newly failing vs `ad00a2b` | set comparison | **0** |

### Diff audit

14 files, all `src/context/` + `docs/`. Staged: **empty**. No scratch, probe, `.mjs`,
`.orig` or `.rej` files committed. No CRLF corruption in committed content. No unrelated
workstream file entered any commit.

**Classification:** VERIFIED

---

## 14. Acceptance criteria

| # | Criterion | Result |
|---|---|---|
| 1 | F-A independently reproducible before the fix | **PASS** — 37 466 vs 23 232, 28 messages sent |
| 2 | Assistant-text-only path has an exact regression test | **PASS** — exact verdict + exact reason + message count |
| 3 | Case B cannot send when reduction was attempted and remains over | **PASS** — NC1 caught by 6 tests |
| 4 | Case C cannot send when all applicable mechanisms are exhausted | **PASS** — NC2 caught by 4 tests |
| 5 | Case D does not become an accidental blanket rejection | **PASS** — 5 withhold reasons accept; certain over-limit still rejects |
| 6 | `"reduce"` no longer a dead/ignored verdict | **PASS** — removed from the union; NC3 proves it cannot return |
| 7 | Reduction state represented explicitly | **PASS** — `ReductionRecord`, exhaustive `ReductionReason` |
| 8 | `REDUCIBLE_CATEGORIES` has one authoritative source | **PASS** — derived; 2 parity tests |
| 9 | `catch {}` no longer silently discards the error | **PASS** — type only; NC-free, asserted |
| 10 | `runId` removed or meaningfully used | **PASS** — removed, with the reason recorded |
| 11 | F-A documented as a confirmed defect | **PASS** — dated addenda; history not rewritten |
| 12 | Phase 1/2/3/4 regressions remain green | **PASS** — 297 + 65 pass, 0 fail; zero newly failing |
| 13 | Typecheck passes | **PASS** — backend and web, exit 0 |
| 14 | Build passes | **PASS** — exit 0 |
| 15 | Negative controls fail when protections are reintroduced | **PASS** — NC1–NC5, each confirmed applied and reverted |
| 16 | No unrelated workstream files enter commits | **PASS** — 14 files, all context + docs |
| 17 | No push occurs | **PASS** — 30 ahead, nothing pushed |

**LIVE-VERIFIED:** none. This change is budget policy over already-live seams; no
provider call was made and no credential was touched. The reproduction used the real
assembly seam with synthetic content, and the estimator/budget figures are derived from
the real `measure.ts` and `computeBudget`.

**UNKNOWN:** whether real providers reject the Case D requests the estimator lets
through. Unchanged by this work and not measurable without live traffic.

---

F-A defect investigation and fix complete. Phase 5 was not started.