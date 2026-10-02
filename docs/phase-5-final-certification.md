# Phase 5 - Final Certification

Authority for this document: `docs/phase-5-execution-brief.md` (PART 33 exit criteria,
"Final report" section template, and "Strict certification").

This record was produced by an independent audit pass over the repository. Every number and
code observation below was measured in that pass. Where a claim originates with the implementer
and was **not** independently reproduced, it is labelled as such and is not counted as evidence.

## Identifiers

| Item | Value |
|---|---|
| Certified tree (HEAD) | `1b4604cf1e76e6bd3adfc110186f30f8685d85a1` |
| Phase 5 Part 5 target commit | `68027b27ef7f9eaa3993736b4151c79b206bc2bc` |
| Pre-Part-5 baseline | `61e87eb62db12f26db1161bb461b91012c5d1b40` |
| Test-infrastructure follow-up | `8fe02f8`, `230f033` |
| Post-Part-5 fixes (unrelated to memory) | `15ffcef`, `1b4604c` |

First-parent ancestry, verified with `git merge-base --is-ancestor`:

```
1b4604c  fix(chat): require a replayable input SHAPE, not mere presence (Generation-400)
15ffcef  fix(chat): drop unreplayable tool-call history before provider conversion
230f033  test(opencode): make the ./client module mocks complete enough to stand alone
8fe02f8  test(harness): isolate each test file's sandbox, database and module registry
68027b2  feat(context): Phase 5 Part 5 - activate memory in the Direct chat lifecycle
61e87eb  fix(context): Phase 5 Part 4 follow-up - enforce the candidate ceiling in TBAi
```

`68027b2` and `61e87eb` are both ancestors of `1b4604c` (both returned success).

**Measurement caveat, stated once and applied throughout.** All test counts in this document were
produced by running `bun run test` (and targeted subsets) against the **working tree**, which
carried 56 uncommitted maintainer paths at audit time, including untracked test files
(`src/context/memory-chat-wiring.test.ts`, `tests/integration/conversation-reconcile.test.ts`).
Counts therefore describe the working tree, not a pristine checkout of `1b4604c`.

---

# 1. Independent baseline

The baseline was measured, not inherited. A detached worktree at `61e87eb` was created and
`bun run test` was executed in it (its `package.json` at that commit contains no `--isolate`):

| Tree | pass | skip | fail | tests / files | exit |
|---|---|---|---|---|---|
| `61e87eb` pre-Part-5 | 3090 | 2 | **2** | 3094 / 236 | 1 |

The two failing tests, by name:

- `src/context/budget-oversize.test.ts` - "logs compaction_error with an error type instead of
  discarding it"
- `src/context/budget-oversize.test.ts` - "records the error TYPE only - never the message, the
  stack, or any content"

Root cause, established by direct experiment rather than inference: `compaction_error` is emitted
at `warn` (`src/context/assemble.ts:561`), while `budget-oversize.test.ts` never configures the
logger. Any earlier file leaving `logger.configure({ level: "error" })` in the shared process
therefore suppresses the event. A direct probe of the logger confirmed the mechanism:
`COUNT_AT_ERROR=0`, `COUNT_AT_DEBUG=1`.

This baseline is what makes section 20's "did Part 5 break anything" answer falsifiable.

# 2. Architecture decisions

| Decision | Location | Status |
|---|---|---|
| One assembly seam; the route decides only participation | `src/routes/chat.ts` | VERIFIED |
| Memory enablement is a pure, injectable, off-by-default predicate | `src/context/memory/enablement.ts` | VERIFIED |
| SQLite remains the single authoritative store for memory | `src/context/memory/provider.ts` | VERIFIED |
| Shipped retrieval statement is the tested statement | `createMemoryQueryRunner` | VERIFIED |
| No multi-user / workspace memory scope in Phase 5 | not introduced | VERIFIED |

# 3. Data model

Memory rows are the CRUD-owned `memories` table; `localMemoryProvider` reads the same table and
no second store was introduced (the entire `provider.ts` change in `68027b2` is the query-runner
extraction, which is behaviour-preserving). **Status: VERIFIED (inherited from Part 3, unchanged by
Part 5).** Part 5's diff contains no DDL and no migration.

# 4. Retrieval

Independently read at `src/context/memory/provider.ts:69`:

```sql
SELECT id, content, created_at, updated_at FROM memories
ORDER BY created_at DESC, id ASC LIMIT ?
```

`id` is the primary key, so `(created_at DESC, id ASC)` is a **total order**: two rows can never
tie, and identical table state yields a byte-identical result set on every call and in every
process. Retrieval is read fresh per request, so a create/edit/delete is visible on the next turn.
**Status: VERIFIED.**

Candidate consideration is bounded by `MEMORY_MAX_CANDIDATES = 50`
(`src/context/memory/contract.ts:41`).

# 5. Ranking

Ranking and the delivery ceiling live in the Part 4 seam, not the route: `MEMORY_MAX_SELECTED = 8`
(`contract.ts:38`). Independently confirmed that `src/routes/chat.ts` references memory in exactly
two executable places - the imports at lines 38-39 and the seam argument at lines 417-418 - with
no assembly, truncation, ordering or rendering of memory text in the route.
**Status: VERIFIED (ranking inherited from Part 4; Part 5 adds no second ranking algorithm).**

# 6. Staleness/conflict handling

Implemented in the Part 4 seam (`src/context/memory/safety.ts`, `contract.ts` staleness
classification). `68027b2` modifies neither file.
**Status: VERIFIED (inherited; unchanged by Part 5). Not independently re-derived in this pass.**

# 7. Budget

Constants read directly: `MEMORY_BUDGET_FRACTION = 0.1`, `MEMORY_BUDGET_CEILING_TOKENS = 16_000`
(`contract.ts:29,32`), plus a per-memory delivery cap.

The structural guarantee that matters was verified by reading `src/context/assemble.ts`:
`runMemoryPhase(...)` is invoked at line 287 with `usableInputTokens: budget.usableInputTokens`,
and `combineEstimates([... measureMessages(layerC) ...])` runs **after** the memory block has been
placed into `layerC.messages`. The injected block is therefore inside the very measurement the
budget gate judges. A context source that bypassed the budget would be exactly the Phase 2 defect;
this ordering is what prevents it. **Status: VERIFIED.**

# 8. Provenance

`src/context/types.ts:320` carries `readonly memory?: MemoryReport` on the assembled provenance
record, and `types.ts:588` carries `readonly memory?: MemorySeam` on the assembly input. The
id sets (`currentTurnIds`, `retainedIds`) are deliberately **not** recomputed after injection, which
keeps memory out of `retainedMessageIds` so a changed selection moves only the dynamic suffix.
**Status: VERIFIED.**

# 9. Assembly integration

`src/routes/chat.ts:362` is the single `assembleContext` call. A grep across all production
`src/**` (test files excluded) found exactly one invocation; every other match was a type
declaration, a re-export, or a comment. The memory seam is composed at lines 417-418 inside that
one call. **Status: VERIFIED.**

# 10. Compaction interaction

Ordering in `assemble.ts` is: Phase 4 compaction, then memory, then measurement. Because
compaction computes its span from the client's own messages, an injected block can never fall
inside a compactable span, and the invariant holds without modifying Phase 4.
`68027b2` touches neither `src/context/compaction/**` nor the compaction call site.
**Status: VERIFIED (inherited; unchanged by Part 5).**

# 11. Cache interaction

Memory is placed in the dynamic suffix and excluded from `retainedMessageIds`, so a different
selection does not perturb the cacheable prefix. `68027b2` touches no file under
`src/context/cache/**`.
**Status: VERIFIED (inherited; unchanged by Part 5).**

# 12. User inspection/control

`web/src/components/MemoryPanel.tsx` and `MemoryPanel.safety.test.tsx` are untouched by Part 5 -
`git show --name-only 68027b2` contains **zero** files under `web/`. The panel suite was executed
in this pass: **12 pass / 0 fail**. **Status: VERIFIED.**

# 13. Security/isolation

Memory is read from SQLite by conversation id only; nothing about the selected set is accepted from
the browser, and no selected-memory state is cached across requests or conversations. Enablement
requires an explicit operator opt-in, so stored content does not become model-visible by upgrade.

One scoping decision is recorded here rather than buried: `src/services/scheduler/schedulerExecution.ts`
calls `streamText` directly and does not use `assembleContext`, so unattended scheduled jobs do
**not** receive memory. Part 5's reasoning is that brief PART 11 forbids appending memory after
assembly, so wiring it would either violate that rule or require refactoring unattended execution.
This is a deliberate, disclosed scope boundary - memory is absent there, not leaking there.
**Status: VERIFIED with disclosed scope boundary.**

# 14. Concurrency

`assembleContext` runs once per run; follow-up turns re-enter `POST /api/chat` and therefore
re-derive memory from authoritative state; auto-continue, tool approval and detached runs inherit
the already-assembled `modelMessages` without re-assembly, so no duplicate injection is possible.
Part 5's suite exercises concurrent reads over the real seam.
**Status: VERIFIED (inherited design + Part 5 coverage).**

# 15. Failure handling

Part 5's suite covers provider failure (memory seam failure yields a request identical to the
no-memory request) and malformed rows. Failures inside the phase are contained rather than
propagated into the request. **Status: VERIFIED (Part 5 coverage, observed green in this pass).**

# 16. Tests

Executed in this pass:

| Suite | Result |
|---|---|
| `bun run test` (full CI scope) - run 1 | **3377 pass / 2 skip / 0 fail**, 3379 tests / 248 files, 211.5s, exit **0** |
| `bun run test` (full CI scope) - run 2 | **3377 pass / 2 skip / 0 fail**, 3379 tests / 248 files, 210.4s, exit **0** |
| `./src/context` | **397 pass / 0 fail**, 13 files |
| `src/context/memory-wiring.test.ts` (Part 5) | **31 pass / 0 fail** |
| `src/context/memory-chat-wiring.test.ts` | **13 pass / 0 fail** |
| `web/src/components/MemoryPanel.safety.test.tsx` | **12 pass / 0 fail** |

The full gate was run twice independently with identical results; a single green run was not
treated as sufficient. `bun run typecheck` exit **0**; `bun run lint` exit **0**;
`bun run build` exit **0**.

Part 5 introduced **31** test cases and **zero** production-adjacent regressions: the pre-Part-5
pass count 3090 rose to 3121 at `68027b2`, a delta of exactly **+31**, matching the new cases,
while the failing set stayed at the same two test names.

No test was disabled, retried, slept around, or had its assertions weakened as part of this work.

# 17. Negative controls

Two distinct families, with different provenance:

**(a) Independently reproduced in this pass** - test-harness contamination controls:

- Two generated probe files under the real `bun run test` flags received **2 distinct `DATA_DIR`
  values**; the same probes without `--isolate` received **1**. The isolation is real and the flag
  is load-bearing.
- Whole-suite control: same commit, `--isolate` removed -> **2 failures reappear** (0 fail becomes
  2 fail). The contamination the harness fix removes is reproducible on demand.
- `process.env` set by one file is observed as `undefined` by the next file -> no environment
  leakage under `--isolate`.
- The fallback path was exercised directly (locally, no provider involved): with a non-test
  `argv[1]` the preload emits
  `[test-sandbox] REFUSING per-file isolation: ...`, and emits nothing under a correct harness.
- `tests/unit/test-sandbox-isolation.test.ts` carries 18 cases including an end-to-end real-harness
  case that pins each file's `DATA_DIR` to `resolveTestDataDir(<that file's path>, <that file's
  pid>)`, plus a control demonstrating those probes fail without `--isolate`.

**(b) Reported by the implementer, NOT independently reproduced here** - Part 5's own injected-defect
controls (remove the seam -> 2 tests fail; add a second `assembleContext` path -> 1 test fails;
drop the retrieval `ORDER BY` -> 2 tests fail; disable the safety screen -> 1 test fails).
Reproducing these requires temporarily editing production source, which this closing pass is
explicitly forbidden to do. They are therefore recorded as **reported, not re-verified**, and are
not relied on for any PASS in section 20.

# 18. Live verification

**NOT PERFORMED. No live-provider verification is claimed anywhere in this document.**

No real provider credential or quota was spent, by instruction. Consequently the implementer's
reported live checks A-H (safe memory reaching model context, four unsafe classes withheld,
prefix/suffix stability across differing selections, memory outside the compactable span,
delete/update visibility, provider-failure equivalence, disabled-equals-no-memory, production
`data/chat.db` untouched) are **UNVERIFIED** in this record. They are not counted as evidence.

Indirect evidence that does exist: the working tree's real `data/chat.db` was last written
2026-10-01 22:07, i.e. before this audit session, so the test harness did not touch the real
install; and no scratch database exists anywhere in the repository outside that install.

# 19. Residual risks

| # | Risk | Severity | Note |
|---|---|---|---|
| R1 | `bun run verify` runs bare `bun test` | Medium | Does not exercise the certified harness. Decision recorded in section 22. |
| R2 | `process.argv[1]` is Bun behaviour, not a documented API | Low | Degradation is refused *and reported* on stderr, so a semantic change is loud, not silent. |
| R3 | Scheduler unattended runs carry no memory | Low, disclosed | Deliberate scope boundary (section 13); memory absent, never leaking. |
| R4 | `--isolate` costs ~4.7% wall clock | Low | Measured at a fixed commit and file set: 211.0s with, 201.5s without. |
| R5 | Part 5's own injected-defect controls not re-run here | Low | Section 17(b). Would require temporary production edits. |
| R6 | PART 32 documentation deliverables absent | Low | `docs/phase-5-memory-context-report.md` and `docs/adr-2026-10-01-memory-to-context.md` do not exist. `docs/TBAi-context-subagent-roadmap.md` exists and does use the required status vocabulary. Recorded in section 23. |
| R7 | Counts reflect a dirty working tree | Low | Stated at the top; no committed-path conclusion depends on it. |

**Correction of a superseded claim.** An earlier report asserted a ~17% runtime overhead for
`--isolate`. That figure compared different trees with different file counts and is withdrawn. The
correct figure, measured at one commit with one file set, is **~4.7%**.

# 20. Exit-criteria matrix

Per PART 33: evaluate independently; use exactly PASS / PARTIAL / FAIL / UNVERIFIED / UNKNOWN /
DEFERRED; do not force PASS.

| # | Exit criterion | Evidence | Status |
|---|---|---|---|
| 1 | Memory definition/taxonomy | Part 3/4 seam; untouched by Part 5 | PASS (inherited) |
| 2 | Durable storage boundary | Single `memories` table; no DDL in `68027b2` | PASS |
| 3 | Deterministic retrieval | Total order `created_at DESC, id ASC`; 31/31 Part 5 tests | PASS |
| 4 | Deterministic ranking | `MEMORY_MAX_SELECTED = 8`; routing contains no ranking | PASS |
| 5 | Staleness handling | `safety.ts` / `contract.ts`; not modified by Part 5 | PASS (inherited) |
| 6 | Contradiction handling | Part 4 seam; not modified by Part 5 | PASS (inherited) |
| 7 | Scope isolation | Per-conversation read; no workspace/multi-user scope introduced | PASS |
| 8 | Per-memory bound | Delivery cap in the Part 4 seam | PASS (inherited) |
| 9 | Total memory budget | 10% / 16 000 tokens; measured inside `combineEstimates` | PASS |
| 10 | Current user task priority | Inserted at `currentTurnStartIndex(...)`, i.e. before the current turn | PASS |
| 11 | Provenance | `provenance.memory?: MemoryReport` | PASS |
| 12 | Provenance durability | Provenance module untouched by Part 5 | PASS (inherited) |
| 13 | Integration through `assembleContext` | `chat.ts:417-418` inside the single call | PASS |
| 14 | No hidden second context path | Exactly one `assembleContext` call in production; scheduler path disclosed | PASS |
| 15 | Compaction compatibility | Order: compaction -> memory -> measurement | PASS (inherited) |
| 16 | Reload compatibility | SQLite re-read per request | PASS (inherited) |
| 17 | Resume compatibility | Resume handler carries no memory logic | PASS |
| 18 | Cache invalidation correctness | Memory excluded from retained id sets | PASS (inherited) |
| 19 | User inspection/control | MemoryPanel untouched; 12/12 pass | PASS |
| 20 | Failure containment | Provider-failure and malformed-row coverage green | PASS |
| 21 | Concurrency correctness | Single assembly per run; concurrent-read coverage | PASS |
| 22 | Security isolation | Explicit opt-in; browser is non-authoritative; scheduler boundary disclosed | PASS |
| 23 | Adversarial negative controls | Harness controls independently reproduced; Part 5's injected-defect controls not re-run | PARTIAL |
| 24 | Regression suite | 0 fail at HEAD, twice; no new failure vs baseline | PASS |
| 25 | Typecheck | exit 0 | PASS |
| 26 | Build | exit 0 | PASS |
| 27 | Live verification | Not performed; no credential or quota spent | **UNVERIFIED** |

**23 = PARTIAL** and **27 = UNVERIFIED** are recorded as measured. Neither was promoted to PASS.

# 21. Git audit

| Commit | Files | Production files |
|---|---|---|
| `68027b2` Part 5 | `src/context/index.ts`, `src/context/memory/enablement.ts` (new), `src/context/memory/index.ts`, `src/context/memory/provider.ts`, `src/routes/chat.ts`, `src/context/memory-wiring.test.ts` (new) | 4, all in approved Part 5 scope |
| `8fe02f8` harness | `package.json`, `tests/setup.ts`, `tests/test-sandbox.ts` (new), `tests/unit/test-sandbox-isolation.test.ts` (new) | **0** |
| `230f033` mocks | `src/services/opencode/sessions.test.ts`, `src/services/opencode/sessions-concurrency.test.ts` | **0** (both are test files) |
| `15ffcef` | maintainer's; unrelated to memory | n/a |
| `1b4604c` | maintainer's; unrelated to memory | n/a |

Findings:

- Part 5's production diff is 4 files and touches no compaction, cache, budget, safety, provider,
  scheduler, panel, or route/page/dialog code. No Part 4 decision was reopened.
- `8fe02f8` changed exactly **one** line of `package.json` (adding `--isolate` to the `test`
  script). The maintainer's concurrent `build:web:profile` / `profile:web` lines are absent from the
  commit and remain unstaged in the working tree.
- File-set overlap: `8fe02f8` and `230f033` share no file, and neither shares a file with `15ffcef`.
- No concurrent dirty work was committed. 56 maintainer paths remained dirty and uncommitted
  throughout; `git stash list` is empty.
- **Nothing has been pushed.** `origin/main` predates this entire line of work, so
  `1b4604c`, `15ffcef`, `230f033`, `8fe02f8` and `68027b2` are all local-only.

History note: the commit previously identified as `78101a8` was rewritten to `15ffcef` when the two
OpenCode mock repairs were split into their own commit (`230f033`). The rewrite preserved the tree
byte-for-byte and the maintainer's author, committer, dates and message; the prior combined commit
`b49691d` remains a readable object in the reflog.

# 22. Final certification

**`bun run test` is the sole authoritative and sanctioned test gate for CI and for certification.**

**`bun run verify` is a convenience wrapper and is non-authoritative.** It currently invokes bare
`bun test`, which (a) does not carry the `--isolate` flag and therefore does not exercise the
certified per-file-isolated harness, and (b) is documented in `.github/workflows/tests.yml` as
double-collecting suites. CI runs `bun run test` (`tests.yml:71`), which is the certified gate.
This is an explicit scope decision: `verify` is **not** being redesigned or changed, and its
behaviour is accepted as-is for certification purposes. A developer using `verify` is knowingly
running a weaker harness; that is now documented rather than silent.

Phase 5 Part 5 status, in the brief's vocabulary: **CERTIFIED WITH RESIDUAL RISKS.**

The strict-certification conditions were each checked against evidence rather than against a green
suite: no known correctness defect remains in Part 5's scope; memory is structurally incapable of
bypassing the budget; staleness/contradiction screening lives in the seam and was not weakened;
provenance is carried and durable; retrieval is a total order; scope isolation is per conversation
with a disclosed scheduler boundary; compaction ordering is unchanged and deterministic; the
current user turn is never displaced because memory is inserted immediately before it and capped;
exactly one Direct context path exists; and the critical harness controls were shown non-vacuous
by independent reproduction.

Two items are **not** closed by this document and are recorded as such: live-provider verification
(27, UNVERIFIED) and full re-execution of Part 5's injected-defect controls (23, PARTIAL).

# 23. Future work

Not in scope for this certification, listed so the record is complete:

1. Live-provider verification A-H, when a credential and quota budget are approved (closes exit
   criterion 27).
2. Re-run Part 5's four injected-defect negative controls under a procedure that permits temporary
   production edits (closes the PARTIAL on exit criterion 23).
3. PART 32 documentation deliverables not present in the repository:
   `docs/phase-5-memory-context-report.md` and `docs/adr-2026-10-01-memory-to-context.md`.
   `docs/TBAi-context-subagent-roadmap.md` is present and already distinguishes implemented /
   tested / live-verified / unverified / deferred / known limitations.
4. Optional, maintainer discretion: align `bun run verify` with `bun run test`, or leave it as an
   explicitly non-authoritative wrapper as decided in section 22.
5. Out of scope by the brief's own stop conditions, and not begun: subagent context isolation,
   subagent lifecycle, subagent result compression, project/file context, RAG platform work.

---

```
PHASE 5
Architecture: One assembly seam (src/routes/chat.ts:362); memory composed only at that seam;
               enablement is an off-by-default pure predicate; SQLite stays authoritative.
Implementation: COMPLETE and VERIFIED. Part 5 target 68027b2; 4 production files, no out-of-scope
               edits. Test-infrastructure follow-ups 8fe02f8 and 230f033 carry zero production files.
Tests: 3377 pass / 2 skip / 0 fail across 3379 tests in 248 files, exit 0, run twice independently.
       Part 5 suite 31/31; src/context 397/397; MemoryPanel 12/12.
Typecheck: exit 0 (backend and web).
Build: exit 0.
Live verification: NOT PERFORMED. No provider credential or quota was spent; no live evidence is
                  claimed. Exit criterion 27 is UNVERIFIED.
Certification: CERTIFIED WITH RESIDUAL RISKS (brief vocabulary), at tree
               1b4604cf1e76e6bd3adfc110186f30f8685d85a1.
Residual risks: R1 verify runs bare bun test (decision recorded, section 22); R2 argv[1] reliance
               (loud, not silent); R3 scheduler carries no memory (disclosed); R4 ~4.7% overhead;
               R5 Part 5 injected-defect controls not re-run; R6 two PART 32 docs absent;
               R7 counts taken against a dirty working tree.
Git: nothing pushed; all six commits local-only. No concurrent maintainer work was committed.
Push: NOT PERFORMED. No remote operation was attempted by this work.
```