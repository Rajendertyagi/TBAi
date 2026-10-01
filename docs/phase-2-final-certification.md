# Phase 2 Final Certification

**Date:** 2026-10-01 · **Certifier scope:** repository-level independent audit
**Status:** CERTIFIED WITH RESIDUAL RISKS

Audited from the repository, not from the Phase 2 report or commit messages.
Every count below was re-derived from git, a fresh test run, and a fresh build.

---

## 1. Repository state

| | |
|---|---|
| Branch | `main` |
| HEAD | `2221c5f` `docs(context): Phase 2 evidence trail and roadmap status` |
| `origin/main` | `6ed88ff` (unchanged by this work) |
| Ahead / behind | **4 ahead / 0 behind** |
| Staged | **0** |
| Unstaged modified | 30 (all pre-existing, other workstreams) |
| Untracked | 16 (all other workstreams) |
| Total `git status --short` entries | 46 |

---

## 2. Commit reconciliation

**The reported discrepancy is resolved: there are 4 commits, not 3. No history
was rewritten.**

`git reflog` shows a clean linear sequence with four `commit:` entries and no
`rebase`, `squash`, `amend`, or `merge`:

```
2221c5f HEAD@{0}: commit: docs(context): Phase 2 evidence trail and roadmap status
230e538 HEAD@{1}: commit: test(context): Phase 2 regression coverage
3f384cd HEAD@{2}: commit: feat(context): one Direct assembly seam...
0fb6f61 HEAD@{3}: commit: docs(context): ADR - Direct context assembly...
6ed88ff HEAD@{4}: commit: feat(tools): cards for `patch` and `execute`...
```

**Cause of the discrepancy:** the Phase 2 implementation report was written
*before* commit `2221c5f` was created, so its "three commits / 3 ahead" was true
when written and is stale now. That document has been corrected in place with a
dated note; the historical finding is not erased.

| SHA | Files | Scope |
|---|---|---|
| `0fb6f61` | 1 (+98) | ADR |
| `3f384cd` | 11 (+1808/−14) | implementation |
| `230e538` | 4 (+797/−9) | tests |
| `2221c5f` | 7 (+5181) | evidence trail |

**Exact Phase 2 file set — 23 files, `git diff --name-status origin/main...HEAD`:**

- *Phase 2 implementation (13):* `src/context/{types,measure,limits,budget,reduce,divergence,assemble,index}.ts`, `src/lib/errors.ts` (M), `src/lib/redact.ts` (M), `src/routes/chat.ts` (M)
- *Phase 2 tests (4):* `src/context/{budget,assemble}.test.ts`, `src/lib/context-overflow.test.ts`, `web/src/components/ChatWindow.tool-output-once.test.ts` (M)
- *Documentation / evidence trail (8):* the ADR, roadmap, Phase 1 audit, 2.1b contract, 2.1c validation, U25/U30 investigation, OpenChamber study, implementation report

---

## 3. Changed-file audit

| Check | Result |
|---|---|
| Unrelated modified file committed | **None.** All 23 files are Phase 2 |
| Unrelated untracked file added | **None** |
| Another workstream's docs included | **None** — `subagent-management-plan.md`, `performance-optimization-masterlist.md`, `project_tracker.html`, `tool-ui-tracker.md` all verified absent from all four commits |
| `docs/decisions.md` committed | **No.** Verified by `git log origin/main..HEAD --name-only` |
| Shared-file line-ending corruption | **None.** `decisions.md` is 1671 CRLF / 0 bare LF, consistent with `core.autocrlf=true` |

### `docs/decisions.md` integrity — independently re-verified

The intended protection was that this shared file be left as found.

| Check | Result |
|---|---|
| Contains any Phase 2 text | **0** matches for `Direct context assembly`, `assembleContext`, `context_overflow`, `CHARS_PER_TOKEN`, `budget.ts` |
| Other workstream's ADRs intact | **25** `## ADR:` headings present |
| Ends where the other stream left it | Last line is *"Deliberately unchanged: the server's 404…"* |
| Trailing newline | Present |
| Line endings | 1671 CRLF, 0 bare LF |
| Working-tree size | 232,406 bytes vs HEAD 180,910 — the other stream's ~51 KB of uncommitted ADRs, **untouched** |

---

## 4. Architecture certification

Verified against the actual pipeline, not the report.

```text
POST /api/chat                                        chat.ts:148
  → validation + server-ownership refusals             chat.ts:152-258
  → assembleContext(...)  ← THE SEAM                   chat.ts:329
       ├ Layer A  buildInstructionsLayer               assemble.ts:174
       ├ Layer B  buildToolLayer (sorted)              assemble.ts:178
       ├ lifecycle repair  pruneStaleMessages           assemble.ts:185
       ├ request-side reduction  reduceToolResults      assemble.ts:196
       ├ reconciliation  reconcileWithStoredHistory     assemble.ts:208
       ├ measure  (3 per-layer estimates)               assemble.ts:213
       ├ limit + budget + decide                       assemble.ts:220-225
       └ convert  prepareModelMessages                 assemble.ts:230
  → pre-flight rejection on `reject`                   chat.ts:371
  → streamText(...)                                    chat.ts:568
```

| Check | Result |
|---|---|
| `prepareModelMessages` call sites | **2 total**: the definition (`model-messages.ts:14`) and **one** production call (`assemble.ts:230`). `chat.ts` references it only as a **type** |
| `assembleContext(` call sites | **1 production** (`chat.ts:329`); the other is a test |
| `streamText(` production sites | **2**: `chat.ts:568` (Direct) and `schedulerExecution.ts:344` (Scheduler) |
| Second Direct assembly path | **None** |
| Route bypass | **None** |
| Hidden context mutation after assembly | **None.** `modelMessages` is declared `chat.ts:326`, assigned `chat.ts:350` (from the seam), read at `:570`. `chat.ts:429` is a **read** inside `sanitizeAiRequest` for the `AI_DEBUG_REQUESTS` diagnostic — it does not assemble or send |
| Scheduler separate | **Yes.** No `prepareModelMessages`, no pruner, `messages: [{role:"user", content: fullPrompt}]` (`schedulerExecution.ts:346`), `stepCountIs(10)`, no `toolApproval`. Documented as an explicit Direct-only boundary in the ADR |

---

## 5. Context assembly certification

Verified at the **actual provider request boundary** (`chat.ts:568-599`):

| Layer | Argument | Confirmed |
|---|---|---|
| A — instructions | `...assembled.context.layerA.toStreamTextOptions()` (`:577`) | Separate `streamText` property |
| B — tool definitions | `tools` (`:578`) | Separate `streamText` property |
| C — messages | `messages: modelMessages` (`:570`) | Separate `streamText` property |

- **A and B are not inserted into `ModelMessage[]`.** The route names neither the
  `instructions` key nor any tool-definition key; the literal `instructions:`
  exists **once** in the whole Direct path, inside `src/context/assemble.ts`, and
  is asserted at zero occurrences in the route by
  `ChatWindow.tool-output-once.test.ts`.
- **Absence of Layer A handled correctly.** `toStreamTextOptions()` returns `{}`
  when there is no system prompt, so no `instructions` argument is sent at all.
  Phase 1 found `systemPrompt` NULL for all 47 conversations, so this is the
  normal case; a test asserts `source: "absent"`.
- **Deterministic relationship.** Layer B is built in sorted key order, so the
  serialized prefix depends on the tool *set*, not on MCP connection order.

---

## 6. Measurement and budget certification

| Criterion | Implementation | Verified |
|---|---|---|
| Limit source | `resolveContextLimit` (`limits.ts:54`) returns `model_reported \| configured \| default` | Yes — **with one finding below** |
| Unknown-limit behaviour | Conservative ceiling, reported as `default`, describes itself `default_conservative(128000)` | Yes |
| Input measurement | `measure.ts` — pessimistic chars/3, per-category, range stated | Yes |
| Estimation semantics documented | Error model in the module header; error is **biased toward over-counting** | Yes |
| Output reservation | Reserved **before** input; `maxOutputTokens` at `chat.ts:587` | Yes |
| Safety margin | 25% of post-output headroom (`SAFETY_MARGIN_FRACTION`) | Yes |
| Usable-input calculation | `ceiling − reserve − margin`, clamped ≥ 0 | Yes |
| Per-category accounting | `byCategory` / `charsByCategory` including `mcp_results` separate from `tool_results` | Yes |
| Deterministic overflow | `decideBudget` on `range.high`; `reject` when `range.low > usable` | Yes |
| Estimate never presented as usage | `measurementKind: "estimate_pre_request"`; provider `usage` path untouched | Yes |
| Display numbers not reused as enforcement | The 128k **display** default is deliberately not imported; a separate constant with its own provenance is used | Yes |

### ⚠️ FINDING — `model_reported` is unreachable in production

`resolveContextLimit` accepts `model` and `configuredContextWindow`, but the only
production caller (`assemble.ts:220-223`) passes **neither**. Every request
therefore resolves to `source: "default"`.

This is **safe and honest** — nothing is misrepresented, and the budget is
conservative everywhere — but the `model_reported` branch is dead in production
and is only exercised by unit tests. `ProviderConfig.models?: ModelOption[]` is
already available to the seam, so wiring it is a small change.

**Deliberately NOT changed during certification.** Supplying a real
`contextWindow` would tighten enforcement and could reject requests that
currently pass — a user-visible behaviour change that belongs in a deliberate,
separately-reviewed decision rather than a certification pass. Recorded as
residual risk **R1**.

---

## 7. Tool/MCP request protection

Four limits verified distinct:

| Layer | Present? | Bound |
|---|---|---|
| Render | Yes | `BoundedBody` — unchanged, display only |
| Stored-data | **Deliberately absent** | Out of scope; a separate decision |
| **Request-serialization** | **Yes** | `REQUEST_TOOL_RESULT_MAX_CHARS = 64 KiB` (`reduce.ts:48`) |
| Model-context budget | Yes | Phase 2 budget |

- **Reduces before provider serialization.** Order confirmed: `reduceToolResults`
  at `assemble.ts:196` runs on repaired messages; `prepareModelMessages` →
  `convertToModelMessages` at `:230` runs afterwards. MCP/native reduction
  therefore lands on the `output` field before conversion.
- **Pairing remains valid.** Reduction touches results only; `toolCallId`, part
  `type`, and `input` are never modified. Pinned by a test that asserts
  `toolCallId`/`type`/`input` survive on a reduced part, and by the full Phase 1
  pairing suites.
- **Truncation is observable.** Every reduction appends a `[truncated by TBAi
  context budget: …]` marker (`reduce.ts:51`) so the model is not misled about
  completeness. Verified in code, not assumed from passing tests.

---

## 8. Overflow handling

| Check | Verified |
|---|---|
| Preflight detection | `chat.ts:371` `if (assembled.decision.action === "reject")` |
| Run marked failed before returning | `chatRuns.markFailed` precedes the 400 |
| Actionable response | `code: "CONTEXT_OVERFLOW"` + a message naming both remedies |
| Provider-side classification | New `context_overflow` category in `errors.ts`, matched **ahead** of the 4xx/config branch (an overflow arrives as 400) and ahead of `rate_limit`, **behind** auth |
| Non-retryable | `retryable` is false for the category; `DIRECT_MAX_RETRIES = 0`, `DIRECT_STREAM_RETRIES = 0` (`chat.ts:55-56`) — **no retry loop** |
| Does not swallow neighbours | 8 tests pin that 401, bare 401, 429, quota, cancel, invalid-model, and invalid-request still classify as before |
| Sanitization | `redact.ts` case returns the actionable message and asserts it does **not** advise a retry |

---

## 9. Invariant preservation

| Invariant | Status | Evidence |
|---|---|---|
| Tool-call/result pairing | **PRESERVED** | `prune-messages` 15/15, `direct-hardening` 20/20, Phase 2 pairing test |
| Approval lifecycle | **PRESERVED** | `approval-lifecycle` 8/8; new test asserts size pressure cannot drop an unexpired decision |
| Stale incomplete tool-call removal | **PRESERVED** | `prune-messages` 15/15; new test asserts a dead call is dropped and its message retained |
| Empty assistant-turn handling | **PRESERVED** | `prune-messages` 15/15 |
| Same-role merge rules | **PRESERVED** | `prune-messages` 15/15 |
| Server-owned system/tools/config | **PRESERVED + strengthened** | 400s intact; the system-prompt guard now also asserts zero `instructions:` keys in the route |
| Deterministic persisted ordering | **PRESERVED** | `storage/index.ts` untouched |
| Detached run behaviour | **PRESERVED** | `detached-history-finalization` 26/26 |
| No partial-output → server-message conversion | **PRESERVED** | `phantom-assistant-shell` 12/12 |

### `pruneStaleMessages` was NOT repurposed — verified

- `git diff origin/main...HEAD -- src/lib/prune-messages.ts` → **empty**.
- `src/lib/model-messages.ts` → **empty**.
- A search of `prune-messages.ts` for
  `token|budget|maxChars|truncat|estimate|context limit` → **0 matches**.
- The only reference from `src/context/` is `assemble.ts:185`, labelled
  *"lifecycle repair of Layer C (pruneStaleMessages — NOT size management)"*.

---

## 10. Test verification

**Single authoritative run — no counts summed across duplicate runs.**

| | |
|---|---|
| **Full suite** | **2853 pass / 2 skip / 0 fail**, 2855 tests across 228 files (~204s) |
| **Backend typecheck** | **exit 0** |
| **Web typecheck** | **exit 0** |
| **Production build** | **exit 0**, web built in 17.79s |

**Independently re-run suites** (each run on its own, reported separately — these
are *contained within* the 2853, not added to it):

| Suite | Result |
|---|---|
| `prune-messages` | 15 / 0 |
| `approval-lifecycle` | 8 / 0 |
| `phantom-assistant-shell` | 12 / 0 |
| `detached-history-finalization` | 26 / 0 |
| `direct-hardening` | 20 / 0 |
| `streamRecovery` | 30 / 0 |
| `resumable-stream` | 4 / 0 |
| `transport-errors` | 7 / 0 |
| `scheduler` | 65 / 0 |
| `context/budget` | 30 / 0 |
| `context/assemble` | 23 / 0 |
| `context-overflow` | 16 / 0 |
| `ChatWindow.tool-output-once` (changed guard) | 3 / 0 |

**Count reconciliation:** the previously reported 2853 / 2 / 0 is **confirmed
exactly**. One earlier miscount exists in the implementation report, which said
"54 new tests"; the true Phase 2 total is **69** (30 + 23 + 16). The report's
figure was a partial sum. Corrected here.

---

## 11. Live verification

Independently repeated against the project's configured local provider
(`agnes`, a `custom` endpoint). **No secrets logged or exposed**; no production
data touched.

| Claim | Result |
|---|---|
| **A — normal request** | **HTTP 200**, 4.86s, **49 SSE frames**, model returned the requested text. Confirms a real streaming round trip |
| **B — oversized request** | **HTTP 400 in 13 ms**, `code: CONTEXT_OVERFLOW`, actionable message |
| **B — no provider invocation** | `chat_request_received` appears **exactly once** across both requests (the accepted one). The oversized request never reached `streamText` |
| Diagnostic completeness | `context_assembled` and `context_overflow_rejected` both emitted with every field populated, e.g. `overBy=713520 unit=tokens windowLimit=128000 limitSource=default_conservative(128000) usableInput=92928` |

### Known limitations — explicitly NOT claimed as verified

- **Near-boundary acceptance** (a request that fits only after reduction) — unit-tested only.
- **No live MCP server configured.** `mcpToolCount=0` and `mcpServerCount=0` on this install; the `mcp_servers` table is empty. The MCP reduction path is unit-tested, never exercised live.
- **Detached divergence** (`missing_from_submission`) — unit-tested only; not reproduced against a real detached run.
- **A live `model_reported` limit** — impossible on this install (see R1).

---

## 12. External dependency assumptions

Phase 2's U25/U30 closures rest on three **library** behaviours that TBAi does
not own. Regression coverage was searched for directly:

| Assumption | Where | TBAi regression test? |
|---|---|---|
| Resume `start` chunk restores the original message id | `ai:7551-1552`; `chat.ts:720` | **NONE** — 0 hits across `tests/`, `web/src/`, `src/` |
| `aiSDKV6FormatAdapter` structural round-trip | `assistant-cloud@0.2.1` `dist/ai-sdk/index.js:6` | **NONE** — the only encode/decode hits are `conversation-config-contract.test.ts` (a different subject) |
| Approval ID matching fails closed | `ai:2937-2941` | **PARTIAL** — `approval-lifecycle.test.ts` exercises approval parts through TBAi's own pruner and converter; the SDK's ID-match path itself is not directly asserted |

**What Phase 2 *does* test at its own boundary:** that an approval-paused tool
part survives assembly whole (`assemble.test.ts:127`) — i.e. the TBAi-side
assumption, not the dependency's implementation. That is the correct boundary.

⚠️ **Recorded as residual risk R2.** A dependency upgrade could change any of
the three and nothing in TBAi would fail. No dependency internals were vendored
or duplicated, and no dependency was upgraded.

---

## 13. Residual risks / unknowns

| # | Risk | Severity | Status |
|---|---|---|---|
| **R1** | `model_reported` limit is **unreachable in production** — `assemble.ts:220` passes neither `model` nor `configuredContextWindow`, so every request uses the 128k conservative default | **Low-medium.** Safe (conservative) and honestly reported, but the budget is looser than intended on large-context models | Deliberately not fixed at certification. `ProviderConfig.models` already carries `contextWindow`, so the fix is small; it must be a deliberate decision because it **tightens** enforcement |
| **R2** | No regression test for the U25 resume-id or U30 storage-round-trip library assumptions | **Low-medium.** Silent failure mode on dependency upgrade | Documented. Correct boundary coverage exists for the TBAi side |
| **R3** | Three external invariants unverifiable from the repo | Low | `AI_InvalidToolApprovalSignatureError` was observed in the test run, proving a verification path exists; **semantics not mapped**, so G6 does not rely on it (**U26**) |
| **R4** | Divergence compares **ID sets, not content** | Low | Deliberate. Content comparison would mean interpreting opaque `z.unknown()` elements (G4) and would false-positive on a fresher client copy. Consistent with the ADR |
| **R5** | `parent_id` is client-supplied; detached parentage derives from in-memory state (`chat.ts:658`) | Low | Not enforced. `order_seq` ordering **is** server-defined. **U27** |
| **R6** | Provenance storage has no field in the persisted message shape | Low | A **Phase 4 prerequisite**, not Phase 2. Adding one is a schema change |
| **R7** | Near-boundary acceptance, live MCP reduction, and live detached divergence unverified | Low | Stated as unverified, not claimed |
| **R8** | Duplicate `approvalId` across two parts — SDK scan keeps the last write | Very low | **U34**. Ids are SDK-generated |

### Unknowns carried forward

U14, U26 (partial — R3), U27 (R5), U32, U34 (R8), U35. **None blocks Phase 3.**

---

## 14. Phase 2 exit criteria matrix

| # | Criterion | Result | Basis |
|---|---|---|---|
| 1 | Context ownership decision recorded | **PASS** | ADR, Option C, with A/B rejection reasoning |
| 2 | Assembly contract behind one path | **PASS** | 1 production `assembleContext` call; 1 Direct `streamText` |
| 3 | Measurement for model-visible categories | **PASS** | 11 categories, per-category tokens and chars |
| 4 | Documented measurement limitations | **PASS** | Error model in `measure.ts`; pessimistic direction stated and tested |
| 5 | Hard budget | **PASS** | `computeBudget`; output reserved first |
| 6 | Output reservation | **PASS** | Computed, inspectable, applied at `chat.ts:587` |
| 7 | Safety margin | **PASS** | 25%, derived from the stated error band |
| 8 | Unknown-limit behavior | **PASS** | Conservative ceiling, `default` provenance, described as such. **See R1** — the *known*-limit branch is unreachable, which this criterion does not require |
| 9 | Distinct actionable overflow | **PASS** | Own category, non-retryable, actionable message, pre-flight |
| 10 | Deterministic assembly | **PASS** | Layer B sorted; tool-map key order stable; persisted order server-defined |
| 11 | Stable prefix foundation | **PASS** | Deterministic + cache-ready. *Caching itself is Phase 3, correctly excluded* |
| 12 | Request-side tool/MCP limits | **PASS** | 64 KiB/result, before serialization, pairing intact |
| 13 | Phase 1 invariants preserved | **PASS** | Pruner byte-untouched; all 9 invariant suites green |

**12 PASS · 0 PARTIAL · 0 FAIL · 0 NOT APPLICABLE.**

---

## 15. Final status

# CERTIFIED WITH RESIDUAL RISKS

**IMPLEMENTED** — one Direct assembly seam with three separated layers;
measurement, budget, output reservation, limit provenance; deterministic Layer B;
request-side tool/MCP reduction; distinct overflow handling; divergence
reconciliation; content-free observability.

**VERIFIED** — 2853 pass / 2 skip / 0 fail; backend + web typecheck exit 0;
production build exit 0; 13 Phase 1 invariant suites re-run green; 23-file commit
set audited with zero unrelated inclusion.

**LIVE-VERIFIED** — normal request HTTP 200 with 49 SSE frames and a real reply;
oversized request HTTP 400 in 13 ms with `CONTEXT_OVERFLOW` and **no provider
invocation**; both diagnostic lines complete.

**UNVERIFIED** — near-boundary acceptance; live MCP reduction (no MCP server
configured); live detached divergence; a live `model_reported` limit.

**DEFERRED** — Phase 3 caching, Phase 4 compaction, Phase 5 memory,
stored-data truncation, provenance storage, Scheduler integration.

**RESIDUAL RISK** — R1 (unreachable `model_reported` branch), R2 (no regression
test for two library assumptions), R3–R8 as tabulated.

Certification is granted with these documented, non-blocking residuals. **R1 is
the one item worth a decision before Phase 3**, because it makes the Phase 3
cache-prefix reasoning operate against a 128k ceiling regardless of the actual
model.

---

## Push readiness

| | |
|---|---|
| Current HEAD | `2221c5f` |
| `origin/main` HEAD | `6ed88ff` |
| Commits ahead | **4** |
| Commits behind | **0** |
| Staged files | **0** |
| Unstaged files | 30 (other workstreams) |
| Untracked files | 16 (other workstreams) |
| Phase 2 commit set | `0fb6f61`, `3f384cd`, `230e538`, `2221c5f` |

**Technically ready for push: YES.** All four commits are self-contained — the
ADR and commit messages reference documents that are now committed in
`2221c5f`, so no citation dead-ends. The working tree is *not* clean, but that is
entirely other workstreams' uncommitted work, none of it staged, and `git push`
transmits commits only. `0 behind` means a push would be a clean fast-forward.

**Not pushed.** No force would be required; no rebase, squash, or history rewrite
is involved.

---

Phase 2 certification complete. Phase 3 was not started.
