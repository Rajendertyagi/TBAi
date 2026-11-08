# Tool-approval persistence — plan (Direct, `requires-action` pause)

**Status:** PHASE 2 DONE, P0/P0b DONE (2026-11-06) — the resume-before-history
ordering race is measured and fixed with an interim read gate; PHASE 1 for the
route-level `toolApproval` carrier is OPEN. The dependency move was explicitly
authorized and executed. Original text follows: read-only audit, Phase 1 starts only
on an explicit go-ahead.
**Date:** 2026-11-06
**Owner:** Chat / Direct persistence
**Depends on:** nothing in flight. Independent of `docs/2026-10-29-assistant-ui-train-upgrade-plan.md`,
which it references but does not supersede.
**Related:** `docs/architecture.md` §File ownership, `docs/decisions.md`, `docs/engineering-quality.md`.

### Phase 2 execution record (2026-11-06)

Installed after the move: `@assistant-ui/react` 0.15.32, `core` 0.3.32, `store` 0.3.22, `tap` 0.9.24,
`ai-sdk` 0.0.16, `react-markdown` 0.14.24, `react-devtools` 1.2.26, `assistant-stream` 0.3.55,
`assistant-cloud` 0.2.9, `zustand` 5.1.0, `ai` 7.0.145 (direct). Manifest edits are in
`package.json` and `web/package.json`; the `react` and `zustand` floors had to move together with
`ai-sdk` because 0.0.16 requires `core ^0.3.32` and `react-markdown`/`zustand` ranges follow the
0.15.32 train — with the old floors the DOM suite threw "Multiple copies of @assistant-ui/core".
`bun run verify` exit 0. F5-1/2/3 in `tests/e2e/history/p2-tool-result-persistence.spec.ts` pass,
and F5-3 carries no `F5-unreachable-in-production` annotation: on the `needsApproval` carrier the
approval card *does* survive a reload and resume.

**What the move did not change:** the persistence gate in `useExternalHistory` is the same
condition in 0.0.16 as in 0.0.14 (`isTerminal || (isAwaitingToolApproval && adapter.update)`).
0.0.16 adds unanswered-run telemetry, a write-failure short-circuit, cancel handling, artifacts as
Maps, `providerMetadata` passthrough, a `createdAtCache`, and `resumeStreamIsReplay` — none of which
resolves the route-level `toolApproval` carrier. Phases 0–1 are still required.

### P0/P0b execution record — resume-before-history race (2026-11-06)

A second, independent cause of the same symptom is now measured and fixed: a
pending stream id plus a slow history `load()` let the library's auto-resume fire
before the conversation's rows were imported, and the arriving history clobbered
the resumed reply.

- `tests/dom/history/p0b-resume-race.test.tsx` drives the real runtime. Defect
  measurement: the thread reported `isLoading === false` before
  `withFormat().load()` started, the resume fired at ~59 ms against a load that
  resolved at ~308 ms, and the resumed row was never written.
- Fix: thread-addressed resumable reads are suppressed until the adapter's
  `finally` calls `markDirectHistorySettled(threadId)`; writes and the transport's
  unnamed bookkeeping read stay open. With the gate, load resolves ~305 ms, resume
  ~325 ms, row appended ~503 ms under parent `a0` with the approval.
- Coverage: `tests/dom/history/resume-history-gate.test.ts` (real adapter opens the
  gate after 200 and after 500) and
  `tests/unit/web/chat/resumable-stream.test.ts` (reads suppressed, writes not,
  one notification per thread).
- **This is an interim application-side guard, flagged for removal** when an
  installed assistant-ui release guarantees the ordering. Decision, alternatives
  and the removal procedure: `docs/decisions.md`, 2026-11-06.

It does **not** close Phase 1: the route-`toolApproval` carrier still has to
satisfy the library's `requires-action` persistence gate, and the resume ordering
was only one of the two ways the incident's approval could be lost.

---

## 1. What this plan is — and is not

It is a fix for one behaviour: **a Direct run that pauses on a tool approval must survive a reload,
with its approval card intact, and resume without `AI_UIMessageStreamError`.**

It is **not** a second persistence path. The library already contains the logic that persists a
paused message (`isAwaitingToolApproval` in `@assistant-ui/ai-sdk`); the work is to find out which
precondition that logic is failing on this app's messages and to satisfy it at the layer that owns
the mismatch. No application-owned approval store, no custom encoder, no decoder patch.

It is also **not** the dependency upgrade. The upgrade described in the original report (`^1.4.0`)
does not exist, and the released fix for the cited issue is already installed (§2). Phase 2 below
records what a move would and would not buy, and is deliberately separable.

## 2. Verified state (2026-11-06, read-only)

Installed values are read from `node_modules` on disk; published values from the npm registry
metadata; upstream facts from the GitHub API.

### 2.1 Versions

| Package | Installed | Latest stable | Notes |
|---|---|---|---|
| `@assistant-ui/ai-sdk` | **0.0.14** (published 2026-10-19) | **0.0.16** (2026-10-28) | 16 versions total, **all `0.0.x`** |
| `@assistant-ui/react` | 0.15.30 | 0.15.32 | not required to move for this work |
| `@assistant-ui/core` | 0.3.32 | 0.3.32 | already latest; satisfies 0.0.16's `^0.3.32` |
| `@assistant-ui/store` | 0.3.22 | 0.3.22 | already latest; satisfies `^0.3.22` |
| `assistant-stream` | 0.3.53 | 0.3.55 | 0.0.16 requires `^0.3.55` |
| `ai` | 7.0.145 | — | `@assistant-ui/ai-sdk` peer is `^7.0.101` |

**There is no `@assistant-ui/ai-sdk` 1.x line.** The registry lists 0.0.1 through 0.0.16 and nothing
else, and 0.0.14 already declares `peerDependencies.ai: ^7.0.101` — it is already on the AI SDK v7
line. The reported target `^1.4.0` does not name any version of this package.

### 2.2 The reported root causes do not hold

**Issue #5046 / PR #5051 — already shipped.** #5046 was closed on 2026-07-19 by PR #5051
("fix(react-ai-sdk): persist history for pending tool approvals", 3 files, merged 2026-07-19,
`useExternalHistory.ts`). This package's first publish was **2026-08-18**, a month later, so every
release of it contains that fix. Confirmed on disk in the installed 0.0.14:

- `node_modules/@assistant-ui/ai-sdk/dist/runtime/useExternalHistory.js:32` — `isAwaitingToolApproval`
- `node_modules/@assistant-ui/ai-sdk/dist/runtime/useExternalHistory.js:324` — the gate that uses it

The 0.0.16 source carries the same predicate and the same gate
(`src/runtime/useExternalHistory.ts:650-654`). **Moving versions cannot fix #5046 here; it is fixed.**

**PR #6154 — closed, never merged.** GitHub reports `state: closed`, `merged: false`, titled
"fix(assistant-stream): decode AI SDK v6 tool chunks in UIMessageStreamDecoder". It also targets
`assistant-stream`, while the observed error name comes from `ai`: the string
`AI_UIMessageStreamError` does not appear anywhere in the installed `assistant-stream` dist. It is
not a shipped fix and not on this app's decode path.

### 2.3 0.0.14 → 0.0.16 has no public API change

`dist/runtime/useAISDKRuntime.d.ts` and `dist/index.d.ts` are byte-identical between the two
releases. No migration guide exists: the assistant-ui docs migration index lists only v0-15, v0-14,
v0-12, v0-11, toolkit-tools, react-langgraph-v0-7, react-compatibility and deprecation-policy.

The real deltas are internal and are relevant only as risk, not as the fix:

- a write-failure short-circuit — once an append fails, no later row in that pass is written
  ("Rows are stored parent first, so nothing after a failed append can be stored in this pass")
- `markRunCancelled`, wired into abort
- `statusCode` carried into error conversion
- immutable tool-artifact / tool-interaction maps instead of epoch counters
- telemetry additions: `persistenceError`, `userMessageId`

### 2.4 The adapter already implements `update`

PR #5051's gate is `isTerminal || (isAwaitingToolCalls && adapter.update !== undefined)`. Both adapter
surfaces in this repo define `update`:

- `web/src/adapters/threadHistoryAdapter.ts:235` (base)
- `web/src/adapters/threadHistoryAdapter.ts:294` (`withFormat`)

Both delegate to `appendStored` → `POST /api/conversations/:id/messages` → `upsertStoredSync`, i.e.
`update` exists and is idempotent by message id. **This precondition is satisfied today**, so the
missing write is not an adapter-shape problem.

## 3. Where the evidence points

### 3.1 This app has two approval carriers, and only one is covered

| Carrier | Declared at | Tools |
|---|---|---|
| Per-tool `needsApproval` | `src/tools/index.ts:350` | `scheduler` (mutating actions) |
| Route `toolApproval` map | `src/routes/chat/execute-direct-stream.ts:450-457` | `write_file`, `edit_file`, `delete_file`, `run_command`, `process_kill`, `browser_action` |

The existing e2e spec covers the **first** carrier and hard-asserts that it persists: after the
approval card appears it polls stored rows with the failure message
"the awaiting-approval tool was never persisted"
(`tests/e2e/history/p2-tool-result-persistence.spec.ts:343-348`). Whether that spec passes on the
current tree was not re-run in this audit.

The reported incident used the **second** carrier (`write_file`), which has no equivalent assertion.
The same spec reaches the reload and then records — rather than asserts — whether the gate survived:

```
F5-unreachable-in-production — "an awaiting-approval tool does not survive a reload, so no
settled message can mutate with empty run boundaries"
```
(`tests/e2e/history/p2-tool-result-persistence.spec.ts:374-384`)

So the general claim "approval does not persist" is too broad. The narrow, testable claim is: **the
route-`toolApproval` carrier fails a precondition that the `needsApproval` carrier satisfies.**

### 3.2 What the incident's own data shows

Thread `l3a3wajur7egicyihwszccn3` ("SpellCheck"), read from a copy of the live database taken outside
the repo:

- stream `qt0qlv20nkvtmegl3u945bv3`, 2099 chunks, ends with `finish-step`, `finish`
  (`finishReason: "tool-calls"`) and `[DONE]` — a **completed** run, not a failed one
- chunk 2093 is a genuine `tool-approval-request` for `call_21dea224ea9f468682c5e426` (`write_file`)
- the stream row is `status=done`, `terminal_kind=completed`, `history_state=pending`,
  `history_message_id=null` — the finalizer never wrote a message for it
- the only row the browser wrote is a **new** assistant message containing one
  `data-tbai-progress` part and no tools, parented to the previous assistant message
- across the 400 most recent assistant rows whose serialized content contains no text part, exactly
  **one** has only `data-tbai-progress` parts, and it is this row

Client side, the three observed log lines map to: `send.failed` and `stream_error_recovery_check`
at `web/src/runtime.ts:485-506`, and `history.recovery_skipped` at
`web/src/features/chat/history/DirectViewportBridge.tsx:127` (the "history loaded fine" branch — it is
not part of this defect).

### 3.3 The gate, stated precisely

From the 0.0.16 source, a paused message is written only when all of the following hold:

1. `isTerminalMessage(message)` is false **and**
   `message.status?.type === "requires-action"` with
   `status.reason === "tool-calls"`, **or** `status.reason === "interrupt"` together with an
   unanswered approval on a `tool-call` part (`part.approval != null`, `approved === undefined`,
   `resolution === undefined`)

   The library's own comment: *"Core reports a run paused on an unanswered approval as an interrupt,
   not as tool calls."*
2. `adapter.update !== undefined` — satisfied (§2.4)
3. `persistSettled` ran with the thread not running. For an **update** of an already-written row it
   additionally requires `durationMs !== undefined`; a **first** append has no such condition

Because a first append has no timing precondition, a paused message that is absent from storage
points at (1) or (3), not at the update path. That is the discriminator Phase 0 must settle.

## 4. Plan

### Phase 0 — discriminate (read-only, no production change)

1. Add a DOM test that mounts the real `useAISDKRuntime` with a recording history adapter (harness
   exists: `tests/dom/components/p2-runtime-integration.test.tsx`), and feed it one pause produced
   through `needsApproval` and one produced through the `toolApproval` map.
2. Assert, for each, the live `ThreadMessage`'s `status.type`, `status.reason`, and whether any
   `tool-call` part carries `approval`. This is the measurement that decides the fix; it is also the
   regression test that must be able to fail.
3. Confirm whether `persistSettled` runs at all for the route-`toolApproval` pause, by asserting on
   recorded `append`/`update` calls rather than on rendered output.
4. Cross-check in the browser on a reproduction thread whether the paused message ever reaches
   `requires-action`, or is already `incomplete`/`error` when the reader throws — the two are
   different bugs with different owners.

**Exit:** a named failing precondition for the route-`toolApproval` carrier, plus a test that fails
because of it.

### Phase 1 — fix at the owning layer

- If Phase 0 shows a **status or part-shape** mismatch: fix the conversion/status mapping that feeds
  the library's gate, so a route-`toolApproval` pause is reported the same way a `needsApproval`
  pause already is. That is configuring an existing library contract, not adding persistence.
- If Phase 0 shows the gate **passes** and the write still does not land: the defect is in the
  library. Reproduce against 0.0.16 to see whether the write-failure short-circuit is implicated,
  and take it upstream. Do not implement application-side approval persistence.
- If Phase 0 shows `persistSettled` never runs: the suspend path is the owner, not the history hook.

**Explicitly out of scope for Phase 1:** any new stored shape, any second store, any decoder change,
any change to `src/services/storage/messages.ts` or to the `validateFinalMessage` rules.

### Phase 2 — dependency move (separate commit, gated)

Executed by `docs/2026-10-29-assistant-ui-train-upgrade-plan.md` §5, not by a second manifest edit
here. That document already plans this exact move (0.15.30/0.0.14 → 0.15.32/0.0.16) and is gated on
lifting the `AGENTS.md` train freeze.

It buys: the failed-append short-circuit, abort telemetry, immutable tool maps. It does **not** buy
the reported fix (§2.2). Take it or leave it on those merits alone.

### Phase 3 — verification

`bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run test:locations`,
`bun run build`, isolated `bun run test`, `bun run test:dom`, plus the e2e cases in §5. Report exit
codes and real pass/fail/skip counts. A green typecheck is not evidence that the card survives a
reload.

## 5. Test plan

| # | Case | Placement |
|---|---|---|
| 1 | A `toolApproval`-gated tool (`write_file`) **persists** the approval card before the pause — asserted against stored rows, not the DOM | new e2e case modeled on F5-3 |
| 2 | **Reloading mid-approval restores** the approval card (Approve/Deny visible) | promote the existing `F5-unreachable-in-production` annotation (`p2-tool-result-persistence.spec.ts:374-384`) into a hard assertion |
| 3 | Approving after the reload resumes with **no `AI_UIMessageStreamError`**, and mutates the same assistant row in place (no second row, no id change) | existing F5-3 tail, extended to the `toolApproval` carrier |
| 4 | DOM unit case pinning the live status/part shape for **each** carrier, so the gate cannot silently regress | `tests/dom/` |
| 5 | Guard-can-fail proof: revert the Phase 1 change, watch 1–2 fail, restore | local, recorded in the report |

Case 3's "no second row" half is load-bearing: a result satisfied by writing a new record would mask
a dropped update rather than reveal one — the reason the existing spec forbids a row-count or id
change.

## 6. Version report and exact manifest change

- **Before:** `@assistant-ui/ai-sdk` 0.0.14, `@assistant-ui/react` 0.15.30, `ai` 7.0.145.
- **After (Phase 2 only):** `@assistant-ui/ai-sdk` 0.0.16; transitives `assistant-stream`
  0.3.53 → 0.3.55, `@ai-sdk/react` → ≥ 4.0.157, `assistant-cloud` → 0.2.9. `react`, `core` and
  `store` do not need to move.
- **Exact edit:** `package.json:63`, `"@assistant-ui/ai-sdk": "^0.0.14"` → `"^0.0.16"`. A caret range
  on `0.0.x` admits only that patch, so this is effectively an exact pin; state that in the commit
  message rather than leaving it to be rediscovered.

## 7. Open questions

1. **Why did `write_file` produce an approval request at all?** `src/tools/index.ts` declares no
   `needsApproval` for it; the route's `toolApproval` map does. Which `status.reason` (`tool-calls`
   or `interrupt`) `ai` reports for that carrier is exactly what Phase 0 measures, and the fix
   depends on the answer.
2. **Which side lost the message in the incident?** The server never finalized it
   (`history_state=pending`) and the browser wrote a progress-only row instead. Phase 0 step 3
   settles whether the browser's write pass ran and skipped the paused message, or never ran.
3. **Is the stray progress-only row a symptom or an independent defect?** It is unique in the sample
   (1 of 400), so it is not a general client behaviour; it should be explained before it is closed.

## 8. Evidence status of this document

**Verified today (2026-11-06, read-only):** installed versions from `node_modules` and Bun's resolved
paths; published versions and publish dates from the npm registry metadata; PR #5051 and #6154 state,
file lists and merge status from the GitHub API; issue #5046 state; the `isAwaitingToolApproval`
predicate and the gate in both 0.0.14 and 0.0.16; the byte-identical public `.d.ts` surface; the
absence of a migration guide; the adapter `update` implementations; both approval carriers; the
existing e2e assertions and annotation; and the incident's stream, message rows and chunk sequence
from an off-repo copy of the live database.

**Not verified — nothing here is claimed:** whether F5-3 currently passes on this tree; the live
`ThreadMessage` status for either carrier (Phase 0 measures it); the cause of
`AI_UIMessageStreamError` in the incident; and the install, resolved tree, gates and CI of any future
change.
