# Phase 5: Memory → Model Context — Execution Brief

**Status:** SAVED, NOT STARTED
**Saved:** 2026-10-01
**Source:** maintainer instruction, verbatim
**Project scope:** TBAi only (`D:\Temp\ai-chat-app`)

> This file is the authoritative task specification for Phase 5. It is preserved
> verbatim so that the brief, the implementation, and the final certification can be
> checked against each other rather than against anyone's memory of the conversation.
>
> Nothing in this file has been executed yet. No Phase 5 code exists in the tree.

---

## Certified baseline this brief operates from

- Phase 1 — COMPLETE
- Phase 2 — CERTIFIED WITH RESIDUAL RISKS
- R1 — COMPLETE
- Phase 3 — CERTIFIED WITH RESIDUAL RISKS
- Phase 4 — CERTIFIED WITH RESIDUAL RISKS
- Phase 5 — **NOT STARTED**

Architecture: **C — Hybrid explicit context assembly**

Precedent for distrusting green suites (each of these survived normal testing):

| Phase | Defect that a green suite missed |
|---|---|
| Phase 2 | dead `"reduce"` verdict + budget enforcement hole |
| R1 | provenance conflation |
| Phase 3 | incorrect cache verification protocol; provider-control namespace bug |
| Phase 4 | concurrency data loss; hysteresis; timeout; summarizer-capacity; vacuous tests |
| F-A fix | a dead verdict with no consumer — reclassified risk → defect |

---

## Authoritative documents (evidence, not unquestionable truth)

- `docs/TBAi-context-subagent-roadmap.md`
- `docs/context-architecture-audit.md`
- `docs/adr-2026-10-01-direct-context-assembly.md`
- `docs/phase-2-final-certification.md`
- `docs/r1-context-limit-decision.md`
- `docs/r1-context-limit-implementation-report.md`
- `docs/phase-3-provider-prompt-caching.md`
- `docs/phase-3-closure-report.md`
- `docs/phase-4-compaction-report.md`
- `docs/phase-4-final-certification.md`
- `docs/adr-2026-10-01-context-compaction.md`
- `docs/f-a-budget-defect-fix-report.md`

---

## Objective

Implement controlled persistent-memory retrieval into the Direct model context.

```
memory store
    ↓
retrieval
    ↓
deterministic ranking
    ↓
memory eligibility / conflict filtering
    ↓
same Phase 2 budget system
    ↓
provenance-bearing memory blocks
    ↓
Phase 4 compaction compatibility
    ↓
Phase 2 assembleContext
    ↓
model
```

Memory must **NOT**:

- bypass the context budget
- become hidden system instructions
- override the current user task
- silently change model context without provenance
- depend on retrieval-engine iteration order
- be injected directly by the browser
- create a parallel model-message assembly path

---

## Scope

**In scope (1–11):** memory retrieval · deterministic ranking/selection · relevance
filtering · stale/conflicting handling · memory budget allocation · provenance · durable
injected-context identity · integration into `assembleContext` · user inspection/control ·
compaction interaction · regression/live verification.

**Out of scope — do not expand:** subagent context isolation · subagent
lifecycle/resource management · project/file retrieval · generic RAG platform · new MCP
functionality · Scheduler redesign · provider-specific memory behavior · unrelated
memory-store redesign.

---

## PART 1 — Independent pre-implementation audit

Before coding, inspect the current tree and determine the actual state of:

`memories` table · MemoryService / ICM boundary · MemoryPanel · memory CRUD APIs ·
memory fields · categories/types · timestamps · update/delete semantics · existing
indexing · existing search/retrieval · deduplication · conflict handling · provenance
fields · compaction provenance representation · context assembly · budget APIs ·
UI/runtime access to memory.

Search repository-wide for:

```
memory · MemoryService · memories · retrieve · search · embedding · relevance
similarity · provenance · injected · context block
```

**Do not assume "no retrieval exists" without checking.**

Produce an independent baseline: storage · service · API · UI · context integration ·
retrieval · provenance.

---

## PART 2 — ICM boundary

The roadmap references ICM as the durable memory engine behind MemoryService. Verify
whether that architecture actually exists in the current tree.

Determine: what owns durable memory · what owns retrieval · whether Phase 5 may change
MemoryService · whether retrieval belongs in an existing abstraction · whether a
context-side adapter is needed.

**Do not bypass an established memory-service boundary. Do not build a second memory
store.** If the tree contradicts the roadmap's ICM description: **document the
contradiction — do not silently redesign around it.**

---

## PART 3 — Memory data model

Inspect the actual schema. Determine which fields exist today. At minimum investigate
whether the model can distinguish:

stable identity · content · category/type · creation time · update time · validity/status ·
source/origin · user-confirmed vs inferred · contradiction/supersession · project/conversation scope.

**Do not invent fields merely because they would be convenient.** If additional fields are
required: design before implementing · determine migration impact · preserve existing
data · keep migration additive where practical · define rollback implications.

**Provenance must be structurally representable. Do not put critical provenance only
inside free-form summary text.**

---

## PART 4 — Define what qualifies as memory

Roadmap candidates: user preference · user fact · project fact · decision · instruction ·
temporary context. These are starting points, not automatically the final taxonomy.

Inspect the actual memory implementation and determine what categories already exist,
then define the Phase 5 retrieval contract. For every category specify:

eligibility for automatic retrieval · default priority · expiration behavior · conflict
behavior · whether user confirmation is required · whether it can influence future
answers · whether it is suitable for persistent storage.

**Do not make semantic claims the data model cannot support.**

---

## PART 5 — Retrieval strategy

Determine the smallest retrieval mechanism supported by the current project. Evaluate:
lexical search · structured filtering · full-text search · embeddings · vector similarity ·
hybrid retrieval.

**Do not add embeddings/vector infrastructure unless actual repository requirements
justify it.**

The retrieval contract must be deterministic · explainable · bounded · query-dependent ·
stable across identical input.

> Same query + same memory set + same state → same selected memory IDs

**Do not use nondeterministic iteration as ranking.**

---

## PART 6 — Relevance / ranking

Define a deterministic ranking function. Possible signals: lexical relevance · category
priority · recency · explicit user confirmation · scope · validity · supersession state.

**Do not invent arbitrary weights without evidence.** If weighting is necessary: document
every weight · test deterministic outcomes · preserve ties deterministically. Use a stable
tie-breaker such as durable memory ID when justified.

**Do not allow database row order to become ranking order accidentally.**

---

## PART 7 — Staleness / invalidation

Core correctness requirement. Define states: valid · stale · superseded · contradicted ·
expired · deleted. Determine how each affects retrieval.

> A memory contradicted by the current conversation MUST NOT be injected as current fact.

Test: memory `"user uses framework X"` vs conversation `"user switched to framework Y"` →
excluded, downgraded, or otherwise handled per explicit policy. **It must not silently
override the current conversation.**

**Do not pretend an LLM semantic contradiction detector is authoritative unless the
project actually has one and its behaviour is verified. Prefer deterministic evidence.**

---

## PART 8 — Memory vs current task

The current user request always has priority. Memory competes for the same context budget
as conversation history · tool outputs · MCP content · other model-visible context.

Define: total memory budget · per-memory bound · min/max selected memories · what happens
at the ceiling · whether memory can displace historical context · what happens when memory
itself cannot fit.

At the ceiling:

```
CURRENT USER REQUEST
  > required active/tool/approval state
    > memory
```

consistent with established Phase 2/4 contracts. **Do not let memory crowd out the current
task.**

---

## PART 9 — Provenance (mandatory)

Every injected memory block must have durable provenance sufficient to answer:

- which memory record produced this block?
- what version/state did it represent?
- when was it retrieved?
- why was it selected?
- is the same memory still present after compaction?
- which context assembly inserted it?

Provenance must survive persistence · reload · resume · compaction · subsequent turns.

**Do NOT copy OpenChamber's exact cursor mechanism.** Only preserve the invariant:
*externally injected context must remain knowable after compaction.* Determine the
smallest TBAi-native representation.

---

## PART 10 — Memory context representation

Define exactly where memory appears in the request, using the established request-layer
contract. Memory must be an explicit model-visible block inside the existing context
assembly system.

Do **not**: turn memory into hidden system instructions · put arbitrary memory text
directly into `conversation.systemPrompt` · make memory a browser-authored message · create
another `streamText` request.

Define deterministic placement relative to Layer A (instructions) · Layer B (tools) ·
Layer C (messages).

The roadmap reserves memory between tool definitions and conversation history. **Verify
that placement against the current Phase 2/3/4 implementation.**

---

## PART 11 — Assembly integration

Integrate through the existing `assembleContext(...)` seam:

```
request → identify conversation/user/task → retrieve candidates
  → validate/reject stale/conflicting → rank deterministically → budget
  → create provenance-bearing memory context → combine → measure again
  → compact/reduce if required → final request
```

**There must be ONE Direct assembly path. Do not allow memory to be appended later in
`chat.ts` after assembly.**

---

## PART 12 — Compaction interaction (mandatory)

Verify: memory injected → compaction runs → summary created → request continues.

Determine: do selected memories survive compaction · do unselected memories remain known
as unselected · does injected memory provenance survive · can memory be silently
summarized away · is memory re-evaluated after compaction.

Key invariant: **after compaction, TBAi must be able to answer "Is this memory still
model-visible?"** If not — rebuild/reinject per the final contract, or explicitly mark it
absent. **Do not let the UI believe the memory is present when the model no longer
receives it.**

---

## PART 13 — K1 interaction

Phase 4 left K1 unresolved: user-visible history ≠ model-visible compacted history.

**Do not silently solve K1 as part of Phase 5.** But Phase 5 adds another model-visible
layer the user may not see as ordinary conversation history. The UI must let the user
inspect memory context. **Do not expose hidden memory injection with no explanation.**

If K1 creates a product decision that blocks a safe memory UI/context explanation —
**document the conflict and stop before inventing behavior.**

---

## PART 14 — User inspection / control

Determine existing MemoryPanel/API capabilities. Implement a clear mechanism for the user
to see: which memories were selected · memory identity/title/content as appropriate · why
they were selected (at least at a useful category/signal level) · which memories were
excluded when useful · stale/conflicting state where relevant.

Do not expose internal scoring numbers unless meaningful. Avoid cluttering the
conversation transcript with synthetic user-visible messages merely to display memory
metadata. **Use the existing UI architecture where practical.**

---

## PART 15 — Memory creation / extraction boundary

**Do NOT automatically invent a full "memory extraction AI agent."** Determine whether
Phase 5 actually owns memory creation. If memories are already created via user action /
MemoryPanel / MemoryService / another established path, Phase 5 should focus on
retrieval/context integration unless the roadmap explicitly requires extraction.

**Do not expand scope into a generic autonomous memory-writing system.**

---

## PART 16 — Scope / security

Memory can be sensitive. Verify conversation/user scoping · authorization · cross-user
isolation · project isolation where applicable · no memory from unrelated users/threads
reaches the model · no client-supplied memory IDs bypass authorization.

**Do not assume IDs are authorization. Test cross-scope retrieval isolation.**

---

## PART 17 — Memory budgeting

Memory must use the same Phase 2 budget machinery. **Do NOT introduce a second
tokenizer/budget calculation.**

Budget must account separately for: selected memory · conversation history · tools ·
MCP/tool results · current user request · output reservation.

At minimum expose: memory candidate count · memory selected count · memory estimated size ·
memory budget · memory excluded count · exclusion reason where useful.

**Do not leak memory content into logs.**

---

## PART 18 — Individual memory size

Apply request-side bounding consistent with Phase 2 tool-result handling. Test: tiny
memory · large memory · exact-boundary memory · oversized memory · many small memories ·
one large + many small.

Determine whether the system truncates safely / excludes / compacts / rejects. **Do not let
one malformed/giant memory bypass the overall budget.**

---

## PART 19 — Deterministic selection

Critical, because memory participates in the stable request prefix.

> Same conversation + same current request + same memory DB state
> → identical selected memory IDs → identical ordering → identical serialized memory block

Check: database ordering · ties · recency · updates · concurrent writes · deletion during
retrieval. **Do not claim determinism from a single test.**

---

## PART 20 — Concurrency

Test: two simultaneous requests retrieving memory · one request while a memory is deleted
· one while memory is updated · memory write during compaction · two tabs retrieving the
same memory set · auto-continue after memory injection.

Determine whether stale memory reaches the model · inconsistent versions are mixed ·
provenance points to the wrong version · ranking changes nondeterministically.

**Do not introduce global locks unless required.**

---

## PART 21 — Provider agnosticism

Memory retrieval and selection must be provider-agnostic. Do not add OpenAI- /
Anthropic- / Gemini-specific memory branches or formatting. Provider-specific
serialization may already exist at the adapter layer. **Memory itself should be independent
of provider.**

---

## PART 22 — Cache interaction

Phase 3 is certified with residual risks. Memory changes the cacheable request prefix.

Verify: memory unchanged → prefix can remain stable · memory added/removed/changed →
prefix identity invalidates appropriately · memory selection is deterministic.

**Do not claim cache improvements. Do not use untrusted context limits to size
memory/cache experiments. Do not modify Phase 3 provider capability logic unless a genuine
compatibility defect is proven.**

---

## PART 23 — Compaction / memory order

Define what happens when memory is present **and** compaction is required. Ensure
deterministic ordering.

The model must not receive:

```
memory
summary of history
memory again
```

unless duplication is explicitly intended. **Test duplicate/injected-memory reappearance
after compaction.**

---

## PART 24 — Failure handling

Test: memory retrieval failure · database timeout · malformed memory record · ranking
failure · provenance creation failure · memory budget calculation failure · compaction after
memory selection failure.

**Do not make memory failure destroy an otherwise valid user request unless policy
explicitly requires it. Memory is supporting context. The current user request remains
primary. Fail safely and observably.**

---

## PART 25 — Test design

Create permanent tests. Do not rely on broad end-to-end tests alone.

| Area | Required coverage |
|---|---|
| Storage | memory CRUD · version/state handling · scope isolation |
| Retrieval | deterministic selection · relevance · recency · tie-breaking · stale exclusion · contradiction handling · scope filtering |
| Budget | per-memory limit · total memory budget · current-task priority · memory excluded at ceiling · oversized individual memory |
| Provenance | durable identity · survives persistence · survives reload · survives compaction · removed memory detectable as absent |
| Assembly | exactly one Direct path · memory inside existing seam · memory not in system prompt · deterministic ordering · no duplicated memory |
| Compaction | survives/reappears per contract · no duplicate after compaction · correct provenance after compaction |
| Cache | unchanged memory → stable prefix · changed memory → invalidation · no untrusted limit used for cache sizing |
| Concurrency | deletion/update races · retrieval/compaction races · duplicate selection · stale version handling |
| Security | cross-user isolation · cross-conversation isolation |

---

## PART 26 — Adversarial / negative-control testing

**Do not trust a green memory suite.** Intentionally reintroduce minimal defects into a
temporary working state and verify tests fail. Minimum set:

1. reverse ranking order
2. remove scope filtering
3. drop provenance
4. inject stale memory
5. exceed memory budget
6. duplicate memory after compaction
7. bypass `assembleContext`
8. allow memory into system instructions
9. make deterministic tie-breaking nondeterministic
10. use row order rather than explicit ordering
11. allow deleted memory to survive retrieval
12. allow memory to crowd out current user request

Every control: confirm the substitution actually occurred · run targeted tests · confirm
tests fail · restore implementation · confirm clean final diff.

**Do NOT repeat the Phase 4 CRLF mistake. Verify that every temporary mutation actually
applied before treating the control as meaningful.**

---

## PART 27 — Live verification

**Live verification must be separated from test verification.** Use the real local storage
and real TBAi assembly. Where credentials are available: perform a real memory-assisted
model request · verify memory appears in the actual provider request · verify provenance ·
verify compaction interaction · verify reload behavior.

**Do not require a special provider feature for memory. Do not modify production
configuration. Use synthetic, non-sensitive memory content.**

If live provider verification is impossible: verify the complete local seam and clearly
mark model/provider behaviour **UNVERIFIED**.

**Never claim memory reaches the model merely because the MemoryPanel displays it.**

---

## PART 28 — User experience verification

Verify the user can distinguish: ordinary conversation history · memory context ·
compaction summary/context.

**Do not expose internal architectural terminology unless necessary.** Check: selected
memory visibility · exclusion/stale indication where useful · user correction/deletion path ·
no accidental hidden persistent behavior.

**Do not automatically add prominent UI if the existing application architecture has
another established inspection surface.**

---

## PART 29 — Phase 5 architecture decisions

Before implementation, explicitly decide:

- **A1** Memory taxonomy
- **A2** Retrieval mechanism
- **A3** Ranking policy
- **A4** Staleness/contradiction policy
- **A5** Memory budget
- **A6** Provenance representation
- **A7** Memory placement in assembly
- **A8** Compaction interaction
- **A9** User inspection mechanism

**Do not silently choose.** For every decision document: evidence · alternatives ·
consequences · reversibility.

**If a decision requires a product choice not established by existing roadmap/project
docs: STOP that decision and report it rather than guessing.**

---

## PART 30 — Implementation sequence

**Do not immediately edit `chat.ts`.** Preferred order:

1. independent audit
2. architecture/data-model decisions
3. retrieval contract
4. deterministic ranking
5. provenance model
6. memory budget integration
7. `assembleContext` integration
8. compaction integration
9. user inspection
10. tests
11. adversarial controls
12. live verification
13. documentation
14. final certification

Keep responsibilities separated.

---

## PART 31 — Git

Known other-workstream modifications may exist. **Only commit Phase 5 changes.** Before
each commit: `git status` · `git diff` · changed-file audit · targeted tests.

**Do not stage unrelated files. Do not push.**

---

## PART 32 — Final documentation

Create:
- `docs/phase-5-memory-context-report.md`
- `docs/adr-2026-10-01-memory-to-context.md`

Update:
- `docs/TBAi-context-subagent-roadmap.md`

**Do not rewrite historical audit reports.** The roadmap must accurately distinguish:
implemented · tested · live-verified · unverified · deferred · known limitations.

---

## PART 33 — Phase 5 exit criteria

Evaluate independently:

1. Memory definition/taxonomy
2. Durable storage boundary
3. Deterministic retrieval
4. Deterministic ranking
5. Staleness handling
6. Contradiction handling
7. Scope isolation
8. Per-memory bound
9. Total memory budget
10. Current user task priority
11. Provenance
12. Provenance durability
13. Integration through `assembleContext`
14. No hidden second context path
15. Compaction compatibility
16. Reload compatibility
17. Resume compatibility
18. Cache invalidation correctness
19. User inspection/control
20. Failure containment
21. Concurrency correctness
22. Security isolation
23. Adversarial negative controls
24. Regression suite
25. Typecheck
26. Build
27. Live verification

For each use exactly: **PASS · PARTIAL · FAIL · UNVERIFIED · UNKNOWN · DEFERRED**

**Do not force PASS.**

---

## Strict certification

Phase 5 may be certified only if:

- no known correctness defect remains
- memory cannot bypass the context budget
- stale/contradicted memory cannot silently reach the model
- provenance is durable
- retrieval is deterministic
- scope isolation is proven
- compaction interaction is deterministic
- current user task always wins at the budget ceiling
- no second Direct context path exists
- adversarial controls prove the critical tests are not vacuous
- all live limitations are isolated

Possible statuses: **CERTIFIED · CERTIFIED WITH RESIDUAL RISKS · NOT CERTIFIED**

**Do not use "CERTIFIED" merely because the full suite is green.**

---

## Mandatory self-audit

Before final certification:

1. Read your own Phase 5 implementation report.
2. Treat every claim as potentially wrong.
3. For every major claim locate independent evidence.
4. Search specifically for: second memory injection paths · hidden system-prompt injection ·
   scope leaks · nondeterministic ranking · stale memory resurrection · provenance loss
   after compaction · duplicate memory after reload · current-task displacement · budget
   bypass · race conditions · user-visible memory mismatch · cache-prefix instability
5. Re-run the critical negative controls after final changes.
6. Inspect the final production diff manually.
7. Verify all committed files are Phase 5.
8. **Do not trust the final test count without targeted evidence.**

---

## Final report

Create/update `docs/phase-5-final-certification.md` with sections:

```
# 1.  Independent baseline
# 2.  Architecture decisions
# 3.  Data model
# 4.  Retrieval
# 5.  Ranking
# 6.  Staleness/conflict handling
# 7.  Budget
# 8.  Provenance
# 9.  Assembly integration
# 10. Compaction interaction
# 11. Cache interaction
# 12. User inspection/control
# 13. Security/isolation
# 14. Concurrency
# 15. Failure handling
# 16. Tests
# 17. Negative controls
# 18. Live verification
# 19. Residual risks
# 20. Exit-criteria matrix
# 21. Git audit
# 22. Final certification
# 23. Future work
```

Final status must explicitly distinguish: **IMPLEMENTED · VERIFIED · LIVE-VERIFIED ·
UNVERIFIED · UNKNOWN · DEFERRED.**

Then provide:

```
PHASE 5
Architecture:
Implementation:
Tests:
Typecheck:
Build:
Live verification:
Certification:
Residual risks:
Git:
Push:
```

---

## Stop conditions

**STOP and report if:**

- the current memory service contradicts the roadmap materially
- provenance requires a destructive migration
- memory scope/authorization cannot be proven
- contradiction handling cannot be made deterministic
- compaction cannot preserve memory provenance
- the budget cannot guarantee current-task priority
- user inspection requires a major UI architecture redesign
- implementation requires changing Phase 2 architecture
- Phase 3 or Phase 4 must be redesigned to make memory safe

**Do not patch around these.**

**Do not start:** subagent context isolation · subagent lifecycle · subagent result
compression · project/file context · RAG platform work.

---

## Final stop

If Phase 5 is certifiable → **STOP.** Do not begin the next workstream automatically.

If Phase 5 is not certifiable → **stop and report the exact blocker.**

**No push.**

Final line:

> "Phase 5 execution complete. Subagent and project/file context work were not started."