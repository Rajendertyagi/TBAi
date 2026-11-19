# TBAi OpenCode Restart Recovery — Plan (revised after idle-signal review, 2026-11-17)

**Status: IMPLEMENTED — production implementation authorized and completed (2026-11-17).**
**Branch:** `review/managed-opencode-hardening-2026-11-15` · original implementation commit chain
`2ef39c5` → `0a37700` → `27dee28` → `3636bb5` → `9502943` (all pushed). The fourth focused pass
(retry-exhaustion outcome handling) is commit `9502943`, pushed.
**Subsequent hardening (2026-11-18/19):** `3b32598`, `15c3ca0`, `3dfa9bf`, `8b27424`, `15bf5f8`
(all pushed) added per-candidate failure isolation, lifecycle-scoped pass-stop, and two independent
audit rounds. Current status and final verification are tracked in
`docs/2026-11-18-opencode-subsystem-audit.md`; the commit chain above is the original implementation
history, not the current branch tip.
**Pinned runtime:** OpenCode / `@opencode/client` 2.2.6 (binary `D:\Coding\OpenCode\opencode.exe`, v2.2.6).
**Scope:** one backend-owned recovery service under `src/services/opencode/`, config in
`src/config/opencode-recovery.ts`, wiring in `src/server.ts`, and read-only candidate enumeration in
`src/services/storage/conversations.ts`. No schema, migration, dependency, launch-config, or protected-path change.

> **Why this revision exists.** Independent review found that the prior plan omitted the projected
> `idle` message — a durable, ordered turn-boundary marker that survives restart even though plain
> `opencode serve` does not persist raw events. This revision makes the ordered projected message
> timeline the primary recovery signal, removes an unsafe standalone completion rule, resolves
> pending-user vs pending-synthetic behavior explicitly, corrects the ordering proposal, narrows the
> P0 evidence claim, and completes the operational details. The trigger architecture is unchanged.

---

## 0. Revision summary

| # | Prior issue | Correction | Section |
|---|---|---|---|
| 1 | `idle` message signal missing | Ordered projected timeline (`user`/`synthetic`/`assistant`/`idle`/`compaction`) is the primary durable signal | §5, §6.A |
| 2 | Completion = `time.idle` set + terminal `outcome` + empty inbox | Removed; completion is relative to the ordered idle boundary and latest relevant input | §8 |
| 3 | "Re-submitting a user prompt drains the inbox including synthetics" | Unsafe; explicit cancel-before-wake rules for every pending ordering | §7.4, §10 |
| 4 | `last_observed_user_message_id` + timestamps "solve ordering" | Wrong; redesigned as a monotonic intent revision with explicit external-producer limits | §7.5 |
| 5 | "Seven P0 tests validate the classifier" | Narrowed to the exact behaviors tested; full classifier unvalidated | §2.2 |
| 6 | Operational details incomplete | Grace, retries, dedup, budget, timeouts, cancellation/draining specified | §12 |
| 7 | 404 read as "different service owner" | Changed to "session absent on the current target" | §8, §12 |
| 8 | Oldest-first scan with a 2,000-message cap and no truncation rule | Newest-first (`order: "desc"`) scan; indeterminate-on-truncation → no auto-resume | §6.A, §12 |
| 9 | Enqueue order treated as authoritative across delivery modes | Delivery-mode-aware promotion order (steer before queue); enqueue order only within a mode | §5, §7.1, §7.4, §10 |
| 10 | No rule for a completed assistant with no idle marker | Explicit indeterminate rule: no auto-resume from that signal alone | §6.A, §8 |
| 11 | Completed compaction, state-specific grace, retry counts vague | Completed-compaction boundary rule; per-state grace table; exact attempt/retry counts | §6.D, §8, §12 |
| 12 | Completed compaction treated as turn completion | Compaction is a context boundary only; `Compacted` continues the runner loop; preserve prior intent + idle evidence | §6.A.9, §6.D, §8 |
| 13 | Inbox promotion described as plain enqueue order | Precise `promote()` model: steer reordering, control barriers, first-queued, re-fetch, race-dependent cases | §5, §7.1, §7.4 |
| 14 | `time.completed` implied whole-turn completion | It marks one assistant step; conservative no-auto-resume retained with false-negative cost | §6.D, §8 |
| 15 | Projected-user / pending-after-idle / retryable-failure classes underspecified | Dedicated grace row, pending-next-turn wake rule, per-class retry table | §8, §12 |
| 16 | Only TBAi recovery synthetics recognised | All projected synthetics are work-bearing; native continuation synthetics reuse their original ID/metadata via same-ID reconcile | §5, §6.A, §8, §13.2 |
| 17 | Completed-assistant vs completed-compaction precedence unclear | Explicit precedence paragraph; compaction never overrides ambiguous completed-assistant/no-idle | §6.A, §8, §13.2 |

---

## 1. Goal and design in one paragraph

When TBAi's managed OpenCode child dies mid-task and restarts, or TBAi's backend hard-restarts, TBAi
should reconnect and **try** to continue the interrupted turn — best-effort, OpenChamber-style. One
backend recovery service, triggered whenever a new managed target is published, enumerates the
conversations TBAi knows that carry a bound `opencodeSessionId`, and reconstructs recovery intent from
the **ordered projected message timeline** returned by `session.message.list` — `user`, recovery
`synthetic`, `assistant`, `idle`, and `compaction` messages — together with typed pending inbox items
and session projection (`time.busy`/`time.idle`/`outcome`) as supporting evidence. It does **not** use
`session.log`, `session.active()`, or any process-local/frontend state. A turn is considered closed when
the latest relevant input is followed by an `idle` marker; otherwise a pending user prompt is
re-submitted by its original ID, a pending recovery synthetic is re-posted by its stable ID, and an
unfinished turn with no pending input gets a recovery synthetic created or reused from durable history.
Where inbox order proves a user message supersedes a pending synthetic, the synthetic is cancelled
**before** the user prompt is woken. Ordering is asserted only where the public API guarantees it;
mixed projected/pending states use a conservative user-wins fallback. The same path runs for both
restart scenarios.

---

## 2. P0 findings and evidence (recorded, not assumed)

### 2.1 Exact commands and results

All commands were run from `D:\Temp\ai-chat-app` with `TBAI_OPENCODE_RUNTIME_TESTS=1` against the real
OpenCode v2.2.6 binary, using a scratch XDG tree and stub provider.

| Command | Result | Evidence |
|---|---|---|
| `bun test tests/integration/opencode/opencode-restart-reconstruction-p0.test.ts` (first, log-based design) | **4 pass / 3 fail**, 20 `expect()` calls, 64.96 s | captured output `D:\Coding\OpenCode\user\tmp\tbai-p0-run.txt` |
| same command (revised test, durable signals) | **7 pass / 0 fail**, 26 `expect()` calls, 5.99 s | `tbai-p0-run2.txt`, `tbai-p0-run3.txt` |
| `bun run test:locations` | exit 0 — `[test:locations] OK — every test file lives under ./tests` | `tbai-p0-loc.txt` |
| `bun run lint` | exit 0 — `Checked 1254 files … No fixes applied` | `tbai-p0-lint2.txt` |
| `bun run format:check` | exit 0 — `Checked 1254 files … No fixes applied` | `tbai-p0-fmt.txt` |
| `bun run typecheck` | exit 0 (no diagnostics) | `tbai-p0-tcfull.txt` |

**Evidence status.** Pass/fail counts, `expect()` counts, timings, and failure messages were
**independently verified by reading the captured output files**. Exit codes were reported in the prior
turn and are consistent with the files (0 failures ⇒ exit 0); they were **not re-run in this phase**.
The first run's three failures all traced to one root cause: no durable events in `session.log`.

### 2.2 Narrowed P0 conclusion

The seven passing P0 tests verified **only** these behaviors: (a) a completed vs interrupted session
is distinguishable from `time.busy`/`time.idle` and an empty `session.log` with a non-empty event
sequence; (b) a pending user prompt re-submitted with its original ID produces no duplicate; (c) a
recovery synthetic ID found in durable history re-posts with no duplicate; (d) a superseded pending
synthetic can be cancelled using a DB-only `enqueued_seq` diagnostic; (e) a missing session returns 404
and is skipped. They did **not** exercise the idle-marker timeline, the full decision table (§8), the
grace/retry machinery, pagination beyond one page, or any production wiring. **The full classifier is
not validated by P0.** All such tests are listed as proposed in §13.2.

**Decision rule from the prior §8:** the tested assertions pass ⇒ no new persistent state is required
for those behaviors. No table, column, or migration is proposed here. One ordering ambiguity remains
(§7.5) with a conservative fallback and an unapproved proposal.

---

## 3. Deployment-specific event-persistence limitation (unchanged)

All facts verified against the pinned 2.2.6 source tree at
`D:\Coding\OpenCode\user\tmp\opencode\diag-src-v2.2.6-1794773000`.

- `packages/core/src/bus.ts:193,214,909` — `configured(options?)`, `persist = options?.persist ?? false`,
  default `node = configured()`; events are **not** persisted by default.
- `bus.ts:405-416` advances `EventSequenceTable` unconditionally; `:417-431` inserts into `EventTable`
  only when `persist`. A surviving sequence number is **not** recoverable history.
- `bus.ts:772-785` replay reads `EventTable`; with no rows, only the `log.synced` marker (`:858-863`)
  is returned — not proof of replay.
- `packages/server/src/routes.ts:127` passes `options.events?.persist`; `packages/server/src/workerd.ts:73`
  sets `events: { persist: true }` (Cloudflare only).
- TBAi launches plain `serve`: `src/services/opencode/serverManager.ts:79-96` returns
  `[binary, "serve", "--port", "0", "--hostname", "127.0.0.1"]` — no `--service`, no Workerd,
  `options.events` unset ⇒ `persist = false`.

| Deployment | `events.persist` | `session.log` after restart |
|---|---|---|
| TBAi managed plain `serve` | false (default) | no historical events; `log.synced` only |
| `opencode serve --service` | false unless configured | native sweep uses `time_suspended`, not the log |
| Workerd / Cloudflare | true (`workerd.ts:73`) | full durable event replay |

**Plan rules:** never use `session.log` as a durable source; never treat `event_sequence` or `log.synced`
as history proof; never assume public `durable.seq` exists after restart. The **projected message
timeline** is durable in all deployments because it is written to `session_message`, not `EventTable`.

---

## 4. Reference implementations (behavioral only)

- **OpenCode 2.2.6 native sweep** (`restart.ts:44,78-100,221-259`): service-mode only; uses core-internal
  `time_suspended`. Semantics copied, not code.
- **`openchamber-ref` @ `ec491bb`** (`session-runtime.js:408-434,436-524`): resume mechanics
  (`session.synthetic` with `metadata.notice`, stable ID, bounded retries, cancel on new user message).
  In-memory only; detection source not copied.
- **`D:\Temp\openchamber` @ `0056bf6`**: detection-only; no auto-resume.

---

## 5. Verified public API facts

- **Projected `idle` message (NEW, primary signal).** `packages/schema/src/session-message.ts:291-302`
  defines `Idle` with `type: "idle"`, `outcome: "succeeded" | "failed" | "interrupted"`, optional
  `error`, `metadata`, and `time.created`. Its doc states: "Marks the Session going idle: every step
  since the previous marker belongs to one turn, including prompts steered in while it was busy. A
  shutdown does not record one, since the resumed execution continues the same turn."
  `packages/core/src/session/message-updater.ts:70-84` appends the `Idle` message via
  `adapter.appendMessage` (writes to the durable `session_message` store); `:149-153` maps
  `execution.succeeded → idle("succeeded")`, `execution.failed → idle("failed", error)`,
  `execution.interrupted` with `reason === "shutdown"` → `clearCurrentRetry` only (**no idle marker**),
  and any other interruption → `idle("interrupted")`. `packages/protocol/src/groups/message.ts:20,65`
  includes `idle` in `MessageTypes` and `PublicSessionMessage`, so it is returned by public
  `session.message.list`. **Because it is a projected message, it survives restart even when raw
  events are not persisted** — this is why it remains useful in plain `serve`.
- `session.message.list` (`protocol/src/groups/message.ts:23-42,102-117`; handler
  `server/src/handlers/message.ts:34-63`) returns the durable message store with opaque cursors,
  `limit <= 200`, `order` (`asc`/`desc`, default `desc`), and optional `type` filter. Messages expose
  `id`, `time.created`, `metadata`, `type`; assistant messages expose optional `time.completed` and
  `time.streamed` (`session-message.ts:221-246`). **No message `seq` is exposed.**
- `session.synthetic({ id, text, resume: true, delivery: 'steer', metadata: { notice: 'opencode-restart' } })`
  reconciles by ID (`session.ts:311-323`, `inbox.ts:178-190`): same ID returns the existing admission or
  promoted message (HTTP 200, no duplicate); 409 on type/session mismatch; 404 when session missing.
- **All projected synthetic messages are work-bearing timeline entries (NEW).** OpenCode 2.2.6 writes
  ordinary synthetic continuation messages in addition to TBAi recovery synthetics: `runner/llm.ts:38-42`
  defines `CONTINUE_AFTER_INCOMPLETE_STREAM` and `CONTINUE_AFTER_OUTPUT_LIMIT`, published via
  `SessionEvent.Synthetic` at `:379` and `:410`; `message-updater.ts:167-178` projects every
  `session.synthetic` event into a `SessionMessage.Synthetic` with `text`, `description`, `metadata`,
  and `id = SessionMessage.ID.fromEvent(event.id)` (a `msg_`-prefixed ID). Classify by role:
  - **TBAi recovery synthetic:** synthetic with `metadata.notice === "opencode-restart"`.
  - **Native OpenCode continuation synthetic:** synthetic **without** the TBAi recovery marker (runner-owned
    continuation).
  - **User input:** existing user message.
  Same-ID reconciliation was verified against the pinned 2.2.6 client and real server (P0-c, §2): a
  synthetic re-post with an existing ID returns 200 with no duplicate. Native continuation synthetics
  use the same `session.synthetic` reconcile path, so when one is the latest work-bearing input with no
  later idle marker, recovery **reuses its original message ID** and preserves its `text`, `description`,
  and `metadata` — it does **not** create a second synthetic or convert it into a TBAi recovery marker.
  If a native synthetic's state is ambiguous (e.g. its ID cannot be confirmed as a valid `msg_` ID or
  reconcile outcome is unclear), use the conservative no-auto-resume fallback and record the limitation;
  do not guess.
- **Same-ID `session.prompt` works for both pending and already-projected user messages.**
  `session.ts:155-188` calls `admission.reconcile({ id, sessionID, type: "user", delivery })`;
  `inbox.ts:184-189` checks `find()` (pending inbox row) **or** `promotedFromMessage()`
  (`inbox.ts:126-166`, a `user`/`synthetic` row in `SessionMessageTable` with matching session). If
  found, the existing item is returned (no new admission) and `execution.wake()` runs unless
  `resume === false`. A **pending** user message is still in the inbox and is delivered on wake; an
  **already-projected** user message is in history and re-submitting its ID wakes execution to
  continue that turn — both reconcile without duplication. If the ID belongs to a different session
  or a non-user/synthetic message (assistant, idle, compaction), `promotedFromMessage` returns a
  `LifecycleConflict` ⇒ HTTP 409.
- `session.inbox.cancel` deletes an **undelivered** inbox item; unavailable items are a no-op
  (`protocol/src/groups/session.ts:554-563`). It cannot cancel an already-delivered/projected item.
- `session.inbox.list()` returns typed items — `user`/`synthetic`/`compaction`/`move` — in enqueue
  order, **without exposing `enqueued_seq`** (`protocol/src/groups/session.ts:540-551`).
- **Delivery mode and inbox promotion — precise model (CORRECTED).** `schema/session-inbox.ts:11`
  defines `Delivery = ["steer", "queue"]`. `core/src/session/inbox.ts` `promote()` (`:569-591`) is
  serialized per session and behaves as follows:
  - `pendingSteers()` (`:610-627`) selects all `steer` rows ordered by `enqueued_seq` ascending, **then
    reorders**: if the first control (`compaction`/`move`) is at index > 0 **and is a compaction**, that
    compaction is moved to the front (`:623-624`) so earlier steers stay verbatim after the checkpoint.
    A `move` is **not** pulled forward (the condition requires `type === "compaction"`); it remains a
    barrier. So pending steers are **not** always promoted in raw enqueue order.
  - `beforeControl()` (`:595-598`) truncates the list at the first control item — a barrier. If the
    first steer is a control, `promote()` returns `undefined` (the runner must handle the control first,
    `:580`).
  - If no steer is pending (and scope is `"input"`), `firstQueued()` (`:600-608`) takes the **single
    earliest `queue` row** by `enqueued_seq`; a control at its head defers promotion (`:586`).
  - After promoting one queued row, `promote()` **re-fetches** `pendingSteers()` and promotes those
    before control (`:588`) — so a steer that arrived during the queued promotion can be picked up in
    the same call.
  - `nextPromotable()` (`:471-481`) mirrors this: first steer (post-reorder), else first queued for
    `"input"` scope. `execution.ts:155-167` confirms a steer-scoped drain never promotes queued
    next-turn prompts — they stay parked.
  - **Predictable from one inbox snapshot:** within `steer`, relative order after the compaction
    reorder and control barriers; that all promotable steers precede the single queued item; that only
    one queued item is promoted per call. **Race-dependent:** a steer/queue item arriving concurrently
    with an in-flight promotion — whether it is promoted in the current call (via the `:588` re-fetch)
    or the next is timing-dependent. No global total order is guaranteed; do not invent one.
  The recovery synthetic is posted with `delivery: 'steer'`; a pending user prompt may be either mode.
  Supersession uses the predictable promotion order only where it is deterministic (§7.4, §10);
  race-dependent cases fall back to the conservative rule.
- `session.get` exposes `time.busy`, `time.idle`, `outcome` (`schema/session.ts:42-55`); `idle` and
  `outcome` are optional, and `outcome` is the outcome of the **last completed** execution (`:44`).
- `session.active()` is process-local and lost on restart — never a recovery source. No global
  suspended-list API; detection is per known session.

---

## 6. Durable candidate detection

### A. Ordered projected message timeline — PRIMARY signal

Scan `session.message.list` **unfiltered, newest-first**: `order: "desc"` on the first page, then
follow `cursor.next` until absent, `limit <= 200`, no `type` filter. Newest-first is required because
recovery cares about the **latest** turn boundary; it finds the latest relevant input and any newer
idle marker without reading the whole history. The ordered timeline is the authoritative turn
structure because it is durable in plain `serve` and the API guarantees stable order across cursors.
Do **not** compare `time.created` values to manufacture an ordering guarantee — position in the
ordered scan is the order. Do not combine `cursor` with `order` on a follow-up page (the handler
rejects that, `server/src/handlers/message.ts:38-39`); the cursor encodes the order.

**Safe truncation.** The scan is bounded (§12). If the budget is exhausted **before the decision
inputs are established** — specifically before finding the latest relevant input and determining
whether an idle marker is newer than it — the result is **indeterminate: do not auto-resume**. Log a
bounded-truncation event and skip the session. Never fall back to `time.busy`/`time.idle` or to
timestamps to manufacture a decision the truncated timeline cannot support. A completed turn whose
idle marker is found within budget is safe to skip; an unfinished turn whose latest input and absence
of a newer idle are both within budget is safe to act on. Only the truncated/indeterminate case is a
no-op.

Relevant message types: `user`, **every** `synthetic` (TBAi recovery marker in `metadata.notice`, or
native continuation without it — both are work-bearing), `assistant` (optional `time.completed`),
`idle` (turn boundary with `outcome`), `compaction` (boundary when `status === "completed"`).
**"Latest work-bearing input" is defined unambiguously:** it is the **first** `user` or **any**
`synthetic` encountered when traversing the descending (newest-first) scan — i.e. the most recent by
timeline position. If an implementation instead reconstructs chronological order before classification,
it must take the **last** such item in that reconstructed order; the two definitions are equivalent.
Do not mix the two conventions. Turn-boundary logic (applied in §8):

1. Latest relevant input followed by an `idle` marker → turn reached a terminal boundary; **do not
   auto-resume**, regardless of `outcome` value.
2. Latest user input after the last `idle` marker with **no assistant message** → crash-before-
   assistant-creation window; re-submit that user message by its original ID (works whether pending
   or projected, §5).
3. Latest user input followed by an incomplete assistant (`time.completed` absent) with no later
   `idle` → current turn unfinished; evaluate recovery after grace (§12).
4. An incomplete assistant followed by a later user message → the older assistant is superseded; it
   must not override the newer user intent. Treat the later user message as the latest relevant input.
5. An incomplete assistant followed by an `idle` marker → **do not** treat missing `time.completed`
   as proof of a crashed execution; the idle marker closes the turn, so no recovery.
6. Shutdown interruption produces **no idle marker** (`message-updater.ts:152-153`). It is distinguished
   from a completed turn by the absence of an idle marker after the latest relevant input. Because a
   shutdown resume continues the same turn, the grace period (§12) must elapse before acting, and the
   timeline is re-checked at expiry.
7. A **TBAi recovery synthetic** (`metadata.notice === "opencode-restart"`) is the latest work-bearing
   input → recover and reuse its existing stable ID (§9).
7b. A **native OpenCode continuation synthetic** (synthetic without the TBAi marker) is the latest
   work-bearing input and no later idle marker closes the turn → reuse its **original message ID** via
   `session.synthetic` reconciliation, preserving its `text`, `description`, and `metadata`; do not
   create a second synthetic or add a TBAi recovery marker (§5). If its state is ambiguous, apply the
   conservative no-auto-resume fallback and record the limitation.
8. **Completed assistant with no subsequent idle marker** (`time.completed` present, no later `idle`):
   the provider response ended but the terminal event was not projected — a crash window between
   assistant completion and idle projection. This is **indeterminate**: do **not** auto-resume from
   this signal alone. The assistant is complete, so there is no incomplete assistant to continue, and
   re-posting a synthetic would duplicate a completed turn. Act only if independent evidence exists
   (a pending input, or a later incomplete assistant in the same post-idle window); otherwise skip and
   log the case. This is the mirror of case 5 (incomplete assistant + idle → closed).
9. **Completed compaction is NOT turn completion.** `runner/llm.ts:413-416` shows the `Compacted`
   outcome only resets `assistantMessageID` and returns no `completed` value, so the runner loop
   **continues**; a completed compaction does not prove the execution settled. Compaction is a
   **history/context boundary only** — it bounds the incomplete-assistant scan (§6.D) but must **not**
   by itself cause recovery to be skipped. Determine recovery from the **preceding** user or recovery-
   synthetic intent and the **absence or presence of a subsequent idle marker**, looking past the
   compaction. A compaction-only inbox is still not an independent trigger (§6.E).
   - **Crash window:** user projected → compaction completes → no later assistant message → no idle
     marker → process dies. The prior user intent is unfinished and no idle boundary exists. **Safe
     action:** re-submit that user message by its original ID via `session.prompt` (same-ID reconcile,
     no duplicate), using the **projected-user grace** (§12, 5 s) and re-checking the timeline and inbox
     at expiry. Do not mint a recovery synthetic while the original user intent is still the latest
     input. A proposed real-runtime test covers this exact window (§13.2).

**Classifier precedence (completed assistant vs completed compaction).** When several boundary-like
records coexist, apply this order — a completed compaction never overrides an ambiguous completed-
assistant/no-idle state:
1. A **later idle marker** after the latest work-bearing input closes the turn → no recovery (decisive).
2. A **newer synthetic continuation** (TBAi recovery or native) or a **newer incomplete assistant**
   after the latest relevant input is **separate evidence of further work** → evaluate recovery for that
   current turn (cases 3, 7, 7b).
3. A **completed assistant without a later idle marker** is an ambiguous completed-step state
   (case 8). If there is **no** newer continuation synthetic, no newer incomplete assistant, and no
   idle marker after it, retain the conservative **indeterminate / no-auto-resume** decision — even if a
   completed compaction also appears. A completed compaction must **not** be read as turn completion
   that would suppress this ambiguity or, conversely, as proof that work continues.
4. A **completed compaction** is only a context/history boundary (case 9). The specific window
   `user → completed compaction → no assistant after compaction → no idle` remains recoverable through
   the original user ID after projected-user grace (case 9 crash window). But `user → completed
   assistant → completed compaction → no later continuation/idle` is **not** auto-resumed: the completed
   assistant is the latest work-bearing state and no stronger continuation evidence exists.
The accepted false-negative risk is explicit: an execution that needs another assistant step after a
completed step may not be auto-resumed; this is preferred over duplicating a finished turn.

### B. Session projection (supporting only)

`projector.ts:1062-1066` sets `time_busy = event.created` on `Execution.Started`; `projectIdle()`
(`:838-861`) sets `time_idle`/`idle_outcome` on terminal events, with `Interrupted(shutdown)` returning
early at `:847`. These fields survive restart in `session_v2` but are **supporting** information only —
never authoritative ordering (see §6.C and §8).

### C. Timestamp collision — false-negative analysis

`projectIdle()` advances idle monotonically (`max(event.created, coalesce(time_idle + 1, event.created))`,
`projector.ts:857`) while `Execution.Started` writes the raw `event.created` to `time_busy` (`:1064`).
A same-millisecond terminal + next start can make `time.busy <= time.idle` while a turn is running;
cross-process clock skew can invert it further. Therefore `time.busy > time.idle` is a weak prefilter
only. The ordered idle boundary (§6.A), not the timestamp comparison, decides completion.

### D. Incomplete assistant messages (supporting only)

`incompleteAssistants()` (`history.ts:356-380`) selects assistant rows with `time.completed is null`,
bounded below by the latest completed compaction seq (`:364,373`). In the public timeline this is an
assistant message with `time.completed` absent after the latest completed `compaction`. It is
supporting evidence: an incomplete assistant can result from a user interrupt, inactivity, or provider
error, and an idle marker can close the turn even when `time.completed` is absent (§6.A.5). It never
creates recovery work by itself.

**`time.completed` marks a step, not the whole execution.** `session-message.ts:240-245` places
`completed` on the assistant message's `time`; `runner/llm.ts:355-420` shows a step can end with
`needsContinuation` (Continue / OutputLimit) or `Compacted`, each starting a **new** assistant step
(`assistantMessageID = SessionMessage.ID.create()`). Therefore a completed assistant message does
**not** prove the turn has completed — another assistant step may be required. The conservative
no-auto-resume rule for "completed assistant, no idle" (§6.A.8) is retained because the signal is
ambiguous, but its **false-negative cost is explicit**: an execution that needs another assistant step
will not be auto-resumed from this signal alone. Stronger evidence (a pending input, a later incomplete
assistant, or a `needsContinuation` marker exposed publicly) would be required to override it; none is
assumed available today.

**Completed-compaction boundary semantics.** A `compaction` message with `status === "completed"`
(`history.ts:34-38,364-373`) is the lower bound for incomplete-assistant evaluation: only assistant
messages **after** the latest completed compaction count as current-turn work. It is a context
boundary, **not** proof of settlement (§6.A.9): the runner continues after `Compacted`. An incomplete
(`status !== "completed"`) compaction is control work and does not qualify either. `settleStaleCompactions`
(`runner/llm.ts:428-453`) shows a process death can leave a `running` compaction orphaned, so compaction
status alone is never a completion signal.

### E. Typed inbox (supporting)

`session.inbox.list()` is classified by type: pending `user` → re-submit by original ID; pending
recovery `synthetic` (`metadata.notice === 'opencode-restart'`) → re-post same ID; `compaction`/`move`-
only → does not independently qualify. Inbox order is authoritative **within the inbox** (§7.1).

---

## 7. Ordering guarantees and limitations

### 7.1 What the public API can and cannot order

| Comparison | Possible? | Basis |
|---|---|---|
| Message A before B in projected history | **Yes** | `session.message.list` fixed `order`, stable across cursors |
| Inbox item A enqueued before B **within the same delivery mode** | **Yes** | `session.inbox.list` returns enqueue order |
| Inbox promotion order across delivery modes | **Yes** (deterministic cases) | `promote()` promotes promotable steers before the single queued item (§5); enqueue order alone is not promotion order |
| Steer order with a compaction/move control | **Partly** | Compaction may be pulled ahead of earlier steers; controls are barriers (§5); race-dependent on concurrent arrival |
| Projected message vs pending inbox item | **No** | No shared public sequence; timestamps are not a total order |
| Any internal `seq` / `enqueued_seq` | **No** | Not exposed; `session.log` has no events in plain `serve` |

### 7.2 Timestamps are not a total order

`time.created` can collide within a millisecond and skew across processes sharing the DB. Timestamps
may break ties heuristically but must never be the sole basis for a recovery decision.

### 7.3 Mixed projected/pending states

When one record is projected and the other pending, relative order cannot be proven. Example: a
recovery synthetic is pending while a newer user message is already projected. Re-posting the synthetic
would deliver a stale continuation after the user's newer turn.

### 7.4 Conservative fallback and explicit supersession

1. **Promotion order, not raw enqueue order, decides inbox precedence — only where deterministic
   (§5).** Within one delivery mode with no control reordering, enqueue order applies; across modes,
   a promotable `steer` precedes the single `queue` item. But compaction reordering, control barriers,
   and concurrent arrival make some orderings race-dependent (§5). Apply the supersession rules below
   only when the single-snapshot promotion order is deterministic; otherwise use the conservative
   fallback (item 4).
2. **User supersedes a pending synthetic** when the user item is promoted first (same mode and later
   enqueue, or user is `steer` while synthetic is `queue`): **cancel the synthetic via
   `session.inbox.cancel` BEFORE re-submitting the user prompt by ID**. Do not rely on inbox draining
   to discard stale work.
3. **Synthetic precedes the user** when the synthetic is promoted first (same mode and earlier
   enqueue, or synthetic is `steer` while user is `queue`): re-post the synthetic by ID and do not
   cancel the user input — a `queue` user prompt is a parked next-turn input that a steer-scoped drain
   never promotes (§5, `execution.ts:155-167`).
4. **Projected vs pending is unorderable.** Retain the conservative **user-wins** fallback: if a user
   message exists that is newer than, or unorderable relative to, a pending synthetic, cancel the
   pending synthetic (only if still pending) and do not re-post it. Accepted false-negative cost: a
   synthetic that was actually newest may be cancelled, losing one automatic continuation; the user
   can always send a new message. This is a best-effort, non-correctness loss.
5. **Never two pending recovery synthetics.** Keep only the one OpenCode would promote first (§5
   promotion order); cancel the rest.
6. A projected synthetic cannot be cancelled through `session.inbox.cancel`; do not claim otherwise.
   A newer user message starts a new lineage (§9).

### 7.5 Application-owned ordering proposal (CORRECTED — unauthorized)

The prior proposal (`last_observed_user_message_id` + scan-time timestamps) is **invalid**: an ID is
not an ordering value, and a new user message can arrive after the scan. It is withdrawn.

**Redesigned proposal (PROPOSAL ONLY — NOT authorized, NOT implemented):** a single monotonically
increasing `intent_revision` stored on the TBAi conversation row, updated **transactionally by every
user-input ingestion path** (Direct chat send, Code-mode prompt, recovery-synthetic creation), with
each recovery synthetic tied to the revision it supersedes. Recovery would compare revisions instead
of timestamps. **External-producer limitation:** OpenChamber, CLI, or desktop processes sharing the
same OpenCode DB do not update TBAi's revision, so cross-process ordering remains unprovable even with
this record. Consequently the conservative fallback (§7.4) remains the operative design for
cross-process cases. This record requires explicit owner approval and a schema change; none is made
here. If declined, the fallback stands permanently.

---

## 8. Recovery behavior decision table (CORRECTED)

Completion is defined by the ordered idle boundary and latest relevant input — **not** by
`time.idle`/`outcome` alone. `time.busy`, `time.idle`, and `outcome` are supporting information only.

| Durable evidence (ordered timeline + inbox) | Interpretation | Recovery behavior | Guard |
|---|---|---|---|
| Latest relevant input followed by `idle` marker | Turn closed at terminal boundary | No recovery | `outcome` value does not change this; idle marker is decisive |
| Latest user input after last `idle`, no assistant | Crash before assistant creation | Re-submit user by original ID (pending or projected) after the **projected-user grace** (§12); re-check history + inbox at expiry | No synthetic layered on user input; original ID available for same-ID reconcile |
| Latest user input + incomplete assistant, no later `idle` | Current turn unfinished | Evaluate recovery after grace; create/reuse stable-ID synthetic | Corroborate with session state; no single-signal work |
| Incomplete assistant followed by later user message | Older assistant superseded | Treat later user as latest input; ignore older assistant | Older assistant never overrides newer intent |
| Incomplete assistant followed by `idle` marker | Turn closed despite missing `time.completed` | No recovery | Missing `time.completed` alone is not proof of crash |
| **Completed assistant (`time.completed` present), no later `idle`** | Crash window between assistant completion and idle projection | **Indeterminate — no auto-resume from this signal alone**; act only with independent pending input or a later incomplete assistant (§6.A.8) | Assistant already complete; re-post would duplicate a finished turn |
| **Completed compaction as newest projected record** | Context boundary only — NOT turn completion (`Compacted` continues the runner loop, `llm.ts:413-416`) | Look past it to the preceding user/recovery-synthetic intent and the absence/presence of a later idle marker; act on that (§6.A.9) | Never skip recovery solely because a completed compaction is newest |
| **Crash window: user projected → compaction completes → no later assistant → no idle → process dies** | Prior user intent unfinished, no idle boundary | Re-submit the user message by original ID via `session.prompt` after projected-user grace; re-check at expiry (§6.A.9) | No synthetic while original user intent is latest input |
| Shutdown interruption (no idle marker after latest input) | Same turn may resume | Wait the state-specific grace (§12), re-check timeline; act only if no progress | No idle marker ≠ completed turn |
| Recovery synthetic is latest relevant input | Prior continuation queued | Re-post same stable ID | Only if no newer user intent (§7.4) |
| **Native continuation synthetic (no TBAi marker) is latest work-bearing input, no later idle** | Runner-owned continuation unfinished | Reuse its **original message ID** via `session.synthetic` reconcile, preserving text/description/metadata (§5, §6.A.7b) | No second synthetic; no TBAi marker added; ambiguous state → no-auto-resume |
| **Native continuation synthetic followed by a later user input** | User supersedes continuation | Treat later user as latest input; re-submit user by original ID | Older continuation never overrides newer user intent |
| **Native continuation synthetic followed by an idle marker** | Turn closed | No recovery | Idle marker decisive regardless of synthetic role |
| **Completed assistant → completed compaction → no later continuation/idle** | Ambiguous completed-step state; compaction is only a boundary | Conservative **no-auto-resume** (§6.A precedence) | Compaction must not override the ambiguity; accepted false-negative |
| Only pending user prompt | User input not delivered | Re-submit by original ID | No synthetic on top |
| **Previous projected turn has idle marker + a pending `queue` user prompt remains** | Prior turn closed; next-turn input parked | Do **not** recover the prior turn; wake the pending user input by original ID, **preserving its `queue` delivery mode and order** (§10) | Never silently discard parked input; do not convert `queue` to `steer` |
| Only pending recovery synthetic | Continuation queued | Re-post same ID | Unless superseded by newer projected user intent |
| User promoted before synthetic (same mode later enqueue, or user `steer` / synthetic `queue`) | User supersedes synthetic | Cancel synthetic via `session.inbox.cancel` **before** waking user by ID | Cancellation only while pending; promotion order per §5 |
| Synthetic promoted before user (same mode earlier enqueue, or synthetic `steer` / user `queue`) | Synthetic is current turn; user may be parked next-turn | Re-post synthetic by ID; do not cancel parked `queue` user input | Promotion order per §5; `execution.ts:155-167` |
| Pending synthetic + newer projected user | Mixed, unorderable | Conservative user-wins: cancel pending synthetic, do not re-post | Accepted false-negative (§7.4.3) |
| Projected synthetic + newer user (pending or projected) | Synthetic already delivered | Do not claim cancellation; mint fresh ID for new lineage if needed | `inbox.cancel` cannot touch projected items |
| `compaction`/`move`-only inbox | Control work | No recovery | Control items never qualify alone |
| Busy/idle collision (`time.busy <= time.idle`) | Comparison unreliable | Decide from idle boundary, not comparison | Weak prefilter only |
| **History scan budget exhausted before boundary established** | Indeterminate timeline | **No auto-resume**; log bounded-truncation and skip (§6.A) | Never manufacture a decision from timestamps or session projection |
| Session absent / HTTP 404 | Session not present on the current target | Skip; no retry | 404 does **not** prove a different service owner |
| Conflicting synthetic ID / HTTP 409 | ID/type/session mismatch | Stop retries; do **not** mark recovered | 409 is not success |
| Network failure / timeout; HTTP 408, 429, 5xx | Transient | Retry per the per-class table (§12), same stable ID | Bounded to the 3-call maximum |
| Permanent 4xx (400/401/403/422, etc.) | Non-retryable | Stop immediately; no retry | Do not retry permanent errors |

Avoid creating recovery work solely because one signal is present; require the guard column.

---

## 9. Stable recovery ID lifecycle

- Mint `msg_` IDs only when creating a new recovery synthetic; set `metadata: { notice: 'opencode-restart' }`.
- Recover the ID from durable history: scan the ordered `session.message.list` (type `synthetic`) and
  typed `session.inbox.list()` for the most recent item carrying the marker; reuse its `id`.
- Same-ID re-post reconciles to the existing admission/message (HTTP 200, no duplicate) and wakes
  execution — safe across repeated crashes.
- **Renewal:** a genuine new user message after the last recovery synthetic starts a new lineage →
  mint a fresh ID. Ordering limits are in §7.
- **HTTP semantics:** 200 = reconcile hit (confirm wake via session state, not assumed); 409 = ID
  conflict, stop but do not mark recovered; 404 = session absent on the current target, stop.

---

## 10. Pending-prompt and synthetic cancellation behavior

Explicit behavior for every pending state. **Precedence is promotion order (§5): `steer` before
`queue`, enqueue order only within a mode** — not raw enqueue order:

| Pending state | Behavior |
|---|---|
| Only a pending user prompt | Re-submit by original ID; no synthetic |
| **Idle marker on prior turn + pending `queue` user prompt** | Prior turn is closed — do not recover it. Wake the pending user input by original ID via `session.prompt`, **passing `delivery: "queue"` to preserve its mode and order**; never silently discard it and never convert it to `steer` |
| Only a pending recovery synthetic | Re-post same ID unless superseded by newer projected user intent |
| User promoted before synthetic (same mode later enqueue, or user `steer` / synthetic `queue`) | User supersedes → cancel synthetic via `session.inbox.cancel` **before** waking user by ID |
| Synthetic promoted before user (same mode earlier enqueue, or synthetic `steer` / user `queue`) | Synthetic is current turn → re-post synthetic; do not cancel a parked `queue` user input |
| Pending synthetic + newer projected user | Mixed/unorderable → conservative user-wins: cancel pending synthetic, do not re-post |
| Projected synthetic + newer user (pending or projected) | Cannot cancel projected synthetic; do not claim cancellation; mint fresh ID for new lineage if needed |

- Cancellation is best-effort; unavailable items are a no-op. Never rely on inbox draining to discard
  stale work — cancel explicitly before waking.
- Prevent two pending recovery synthetics from being delivered as competing continuations (§7.4.4).

---

## 11. Architecture and component ownership (unchanged trigger)

- **Trigger:** `subscribeRuntimeTargetChanges()` in `connectionState.ts`. `serverManager.ts` remains
  byte-identical. Recovery logic lives in a new recovery service under `src/services/opencode/`, not in
  `connectionState.ts`. No additional polling framework.
- Subscription requirements (retained, not implemented now):
  - Subscribe before initial managed target publication (`startOpenCodeRuntime()` at `server.ts:205`).
  - Read and handle an already-installed target via `readRuntimeTargetChange()` (late-subscriber snapshot).
  - Process only valid managed target identities (`mode === "managed"`, `targetId !== null`).
  - Deduplicate by backend instance and target ID (`installManagedTarget` assigns a fresh ID per install).
  - Cancel pending grace timers when the target becomes `unresolved`.
  - Unsubscribe and drain during shutdown (`runShutdown` and `rollbackPartialStartup`); skip when
    `readShutdownState()` reports shutdown started.
- Candidate enumeration: one new read-only query over TBAi conversations with non-null
  `opencodeSessionId` and `engine='opencode'`; no schema change.
- Reuse existing stream-reconnect/honest-state infrastructure; no second recovery framework, no new
  polling loop, no frontend recovery action. Backend owns recovery; frontend shows honest state only.

---

## 12. Operational details

- **Grace period — when it starts:** at the moment a candidate unfinished turn is first detected
  during a target-publication pass (the actual crash time is unknowable). One timer per `(targetId,
  sessionId)`; at expiry the newest-first timeline and inbox are re-checked before any resume. If a
  new idle marker or newer user input appeared, cancel the attempt. Timers are unref'd so they do not
  hold the process open.
- **State-specific grace durations:** the wait is chosen by the detected state, not one global value:
  | Detected state | Grace before acting | Rationale |
  |---|---|---|
  | Shutdown interruption (no idle marker, same turn may resume) | 60 s (mirrors `ec491bb`) | A shutdown resume continues the same turn; allow it to settle |
  | Incomplete assistant, no later idle | 30 s | Allow an in-flight successor to appear before resuming |
  | Pending user prompt / pending recovery synthetic | 5 s | Input is already durable; only a brief settle window is needed |
  | **Projected user input after last idle, no assistant yet (original ID available)** | **5 s** — same brief settle window as pending user input | The user message is already projected and its ID is available for same-ID `session.prompt`; only a short window is needed for a successor to appear. At expiry re-check the newest-first history and inbox; if an assistant or idle marker appeared, cancel |
  | **Crash window: user → compaction completes → no assistant → no idle** | **5 s** (projected-user grace) | Original user intent is still latest; re-check at expiry before re-submitting by ID (§6.A.9) |
  | Completed assistant without idle / truncated scan | none — no auto-resume | Indeterminate; grace does not apply |
  | Completed compaction alone (no prior unfinished intent) | none — no auto-resume | Context boundary only; no unfinished turn to resume |
  These are starting values to be tuned by the proposed tests (§13.2), not measured constants.
- **Bounded retries/backoff — exact counts:** each resume operation makes **at most 3 HTTP calls
  total**: 1 initial call plus at most 2 retries. Backoff is **15 s before retry 1 and 30 s before
  retry 2** (there is no third backoff and no fourth call). Per-call timeout is 15 s. A retry reuses
  the same stable ID, so a 200 from a prior attempt is harmless. No unbounded retry loop.
- **Retryable-failure classes — exact behavior:**
  | Result class | Retry? | Behavior |
  |---|---|---|
  | 200 (reconcile hit) | No | Success path; confirm wake via session state, not assumed |
  | 404 (session absent on current target) | No | Stop; skip session |
  | 409 (ID/type/session conflict) | No | Stop; **do not** mark recovered — a conflict is not success |
  | Network failure / timeout (incl. the 15 s per-call timeout) | Yes | Retry with backoff (15 s, then 30 s), within the 3-call cap |
  | HTTP 408 (request timeout), 429 (rate limited), 5xx | Yes | Retry with backoff (15 s, then 30 s), within the 3-call cap |
  | Permanent 4xx (400/401/403/422, etc.) | No | Stop immediately; never retry a permanent error |
  A class that exhausts its retries (transient still failing after 3 calls) is logged and skipped for
  this pass; a later target publication may retry. Permanent errors and conflicts are never counted as
  recovery success.
- **Deduplication:** per target by `(backendInstanceId, targetId)` (§11); per session by `(targetId,
  sessionId)` — at most one in-flight recovery per session. An in-memory `attempted` synthetic ID is
  lost on a second backend crash, but the durable marker makes a redundant re-post harmless (200).
- **Scan concurrency/budget:** cap concurrent session scans (e.g. 4), cap candidates per pass (e.g. 50),
  cap history pages per session (e.g. 10 pages × 200 = 2000 messages) on the **newest-first** scan.
  Bounded so a large workspace cannot stall boot. If the budget is exhausted before the latest
  relevant input and its idle-boundary status are established, the session is **indeterminate → no
  auto-resume** (§6.A, §8); never extend the budget unboundedly or fall back to timestamps.
- **Timeouts:** per HTTP call 15 s; overall pass budget e.g. 5 min; grace timers unref'd.
- **Cancellation/draining:** on target replacement or shutdown, cancel all grace timers, abort in-flight
  HTTP via `AbortController`, await in-flight passes with a bounded drain (e.g. 10 s), then unsubscribe.
  No new work starts after `stop()`.
- **404 interpretation:** "session absent on the current target" — do **not** claim a different service
  owner caused it. Import origin is never used as an ownership lock.

---

## 13. Scenario test matrix

### 13.1 Already run during P0 (verified — see §2)

- P0-a: completed vs interrupted session distinguishable from `time.busy`/`time.idle`; `session.log`
  empty with non-empty event sequence (decisive finding).
- P0-b: pending user prompt re-submitted with original ID, no duplicate.
- P0-c: recovery synthetic ID found in durable history and reused on re-post, no duplicate.
- P0-d: superseded pending synthetic cancelled using a DB-only `enqueued_seq` diagnostic.
- P0-e: missing session returns 404 and is skipped.

### 13.2 Proposed for a later implementation phase (NOT run)

> **Execution status (2026-11-19).** Two real-runtime scenarios from this matrix
> are now EXECUTED and passing via the shared recovery service — see
> `docs/2026-11-18-opencode-subsystem-audit.md` §15:
> - **Scenario 4** (crash after `Execution.Started` before assistant creation) —
>   executed as the abrupt managed-child crash E2E (`opencode-recovery-crash.spec.ts`),
>   3/3 passing. This exposed a genuine defect: re-posting an already-projected
>   user id reconciles but creates no inbox work in OpenCode 2.2.6, so the wake
>   goes idle without an assistant. Fixed by posting a fresh recovery synthetic
>   for projected+shutdown-interruption users (§15.1 of the audit).
> - **Scenario 3** (shutdown interruption, no idle marker) — executed as the
>   orderly-shutdown E2E (`opencode-recovery-shutdown.spec.ts`), 3/3 passing.
>
> The remaining items below are still PROPOSED / not run unless the audit says
> otherwise. The §5/§8 claim that same-id re-post "works whether pending or
> projected" is corrected for 2.2.6 in audit §15.1: it works for PENDING users;
> PROJECTED users need a fresh synthetic to create promotable inbox work.

1. Idle messages surviving a hard restart while historical `session.log` remains empty.
2. Success, failure, and non-shutdown interruption producing idle markers.
3. Shutdown interruption not producing an idle marker.
4. Crash after `Execution.Started` but before assistant-message creation (§6.A.2).
5. Incomplete assistant followed by a newer projected user message (§6.A.4).
6. Incomplete assistant followed by an idle marker (§6.A.5).
7. A projected user prompt being re-submitted by its original ID (§5).
8. Both pending user/synthetic inbox orderings (§10).
9. Busy/idle timestamp collision — recovery must not classify from comparison alone (§6.C).
10. **More than 2,000 messages** with cursor pagination across user, assistant, synthetic, compaction,
    and idle records: demonstrate **both** (a) successful detection of the latest input + idle boundary
    within the scan budget, and (b) safe refusal (indeterminate → no auto-resume) when the required
    boundary lies beyond the budget (§6.A, §12).
11. Empty historical `session.log` with non-empty event sequence (regression guard for §3).
12. Session recovery with `time.idle` absent (first-ever execution).
13. Compaction/move-only inbox — no resume scheduled.
14. Superseded pending synthetic cancellation via public API only.
15. Supersession when the previous synthetic is already projected — no false cancel claim (§8).
16. Mixed projected/pending records with ambiguous ordering — conservative fallback (§7.4).
17. Completed and unmatched sessions — no resume call.
18. Missing sessions (404) and conflicting IDs (409) — stop semantics.
19. Backend shutdown and managed-target replacement — subscription lifecycle (§11, §12).
20. Newest-first pagination: the latest relevant input is the first matching user/recovery-synthetic
    encountered traversing descending order; a required boundary beyond the scan budget yields
    indeterminate → no auto-resume (§6.A, §12).
21. Delivery-mode ordering: `steer` synthetic vs `queue` user and `steer` user vs `queue` synthetic —
    precedence follows deterministic promotion order, not raw enqueue order (§5, §7.4, §10).
22. Completed assistant (`time.completed` present) with no subsequent idle marker — indeterminate, no
    auto-resume from that signal alone (§6.A.8, §8).
23. **Completed compaction is not turn completion:** user projected → compaction completes → no later
    assistant → no idle → process dies; recovery re-submits the original user ID after projected-user
    grace (§6.A.9). Also verify a completed compaction alone (no prior unfinished intent) is a no-op.
24. State-specific grace durations and exact retry counts (3 calls total: 1 + 2 retries; backoff 15 s
    then 30 s) — verify no fourth call and early stop on 200/404/409 (§12).
25. **Inbox promotion — two user/synthetic items both `steer`:** promoted in enqueue order (no control
    present) (§5).
26. **Inbox promotion — two items both `queue`:** only the earliest is promoted per `promote()` call
    (§5, `firstQueued`).
27. **Inbox promotion — compaction between steered inputs:** compaction is pulled ahead of earlier
    steers; earlier steers promoted after the checkpoint (§5, `pendingSteers` `:623-624`).
28. **Inbox promotion — move between steered inputs:** move is a barrier and is NOT pulled forward;
    steers after it are not promoted across it (§5).
29. **Inbox promotion — queued control at the head of the queue:** promotion is deferred (`undefined`),
    runner handles the control first (§5, `:586`).
30. **Inbox promotion — steer arriving while a queued item is being promoted:** verify the `:588`
    re-fetch picks it up in the same call where deterministic, and that race-dependent cases fall back
    to the conservative rule (§5, §7.4).
31. **Completed assistant step with `needsContinuation` and no subsequent idle marker:** verify the
    conservative no-auto-resume and its false-negative cost (§6.D, §8).
32. **Projected user after last idle, no assistant, original ID available:** 5 s grace, re-check history
    and inbox at expiry, then same-ID `session.prompt` (§8, §12).
33. **Idle marker on prior turn + pending `queue` user prompt:** prior turn not recovered; pending input
    woken by original ID with `delivery: "queue"` preserved (§8, §10).
34. **Retryable-failure classes:** network/timeout, 408/429/5xx retried within the 3-call cap; permanent
    4xx, 404, 409 not retried; 409 not counted as success (§12).
35. **Native continuation synthetic after a completed assistant step, before the next assistant step:**
    classified as work-bearing; no later idle → recovery reuses its original ID (§5, §6.A.7b).
36. **Process crash after a native continuation synthetic is projected:** recovery reuses that synthetic's
    original ID via same-ID reconcile (§6.A.7b).
37. **Repeated crash + same-ID reconciliation of a native continuation synthetic:** no duplicate synthetic
    is created; text/description/metadata preserved (§5, §6.A.7b).
38. **Native continuation synthetic followed by a later user input:** user supersedes; re-submit user by
    original ID (§8).
39. **Native continuation synthetic followed by an idle marker:** no recovery (§8).
40. **Precedence — user → completed compaction → no assistant after compaction → no idle:** recover via
    original user ID after projected-user grace (§6.A precedence, case 9).
41. **Precedence — user → completed assistant → completed compaction → no later continuation/idle:**
    conservative no-auto-resume; compaction does not override the ambiguous completed-assistant state
    (§6.A precedence).

All §13.2 tests are **proposed, not passed**, EXCEPT scenarios 3 and 4, which
were executed and passed in 2026-11-19 (see the execution-status note at the top
of this section and `docs/2026-11-18-opencode-subsystem-audit.md` §15).

---

## 14. Acceptance criteria

1. Both restart scenarios continue an interrupted turn (best-effort) via ONE shared durable path.
2. Detection uses the ordered projected message timeline (including `idle` and **all** synthetic
   messages — TBAi recovery and native continuation) as primary, with typed inbox and session projection
   as supporting evidence; `session.log`, `session.active()`, and process-local/frontend state are never
   recovery sources.
3. Completion is decided by the ordered idle boundary and latest relevant input, never by
   `time.idle`/`outcome` alone, and never by a completed compaction (the runner continues after
   `Compacted`).
4. The recovery synthetic ID is recovered from durable history and reused; a native continuation
   synthetic reuses its original ID/metadata via same-ID reconcile; 404/409 handling, per-class bounded
   retries, and explicit cancel-before-wake prevent duplicate/repeated continuation. A pending `queue`
   input after an idle marker is woken with its mode preserved, not discarded and not recovered as the
   prior turn.
5. Finished, unmatched, control-only, and user-continued sessions are left alone.
6. No new tables, schema migrations, proxy cloning, sequence bookkeeping, imported-chat exclusion,
   `--service`, dependency change, or second recovery framework — unless the owner approves the §7.5
   record after a demonstrated failure.
7. Ordering is asserted only where the public API guarantees it: newest-first timeline position,
   promotion order within/across delivery modes, and the §7.4 fallback for mixed states. Truncated
   scans and completed-assistant-without-idle are indeterminate → no auto-resume.
8. Backend owns recovery; frontend shows honest state only.
9. All eight protected working-tree paths remain byte-identical (§16).

---

## 15. Unresolved risks (explicit)

- **Cross-state ordering (§7.5):** pending synthetic vs projected user message cannot be ordered via
   public API; conservative fallback may forgo a valid continuation. The redesigned intent-revision
   record is unapproved and cannot cover external producers.
- **Incomplete-assistant ambiguity (§6.D):** an unfinished assistant may be a user interrupt, inactivity,
   or provider error, and an idle marker can close the turn despite missing `time.completed`; supporting
   evidence only.
- **Completed-assistant false negative (§6.D, §8):** `time.completed` marks one assistant step, not the
   whole execution; an execution needing another step (e.g. `needsContinuation`) is not auto-resumed
   from that signal alone — accepted to avoid duplicating a finished turn. A completed compaction never
   overrides this ambiguity (§6.A precedence).
- **Native synthetic ambiguity (§5, §6.A.7b):** a native continuation synthetic is reused by original ID
   only when its state is unambiguous; ambiguous state falls back to no-auto-resume rather than guessing.
- **Compaction crash window (§6.A.9):** a completed compaction does not prove settlement; recovery looks
   past it to prior intent and idle evidence, with a proposed real-runtime test (§13.2 #23).
- **Inbox promotion races (§5, §7.4):** compaction reordering, control barriers, and concurrent arrival
   make some promotion orders race-dependent; those cases use the conservative fallback, accepting a
   possible missed continuation.
- **Timestamp collision (§6.C):** busy/idle comparison can produce false negatives; idle boundary decides.
- **Truncated history (§6.A, §12):** a required turn boundary beyond the newest-first scan budget is
  indeterminate; the session is skipped, so a genuinely unfinished turn past the budget is not resumed.
- **Completed assistant without idle (§6.A.8):** a crash between assistant completion and idle
  projection is not auto-resumed from that signal alone; accepted to avoid duplicating a finished turn.
- **Cross-process collision:** OpenCode 2.2.6 has no cross-process execution lock; two clients resuming
   the same session may duplicate side effects. Accepted; import origin is not a fake lock.
- **Best-effort, not exactly-once:** a command that succeeded just before a crash but was not durably
   recorded may be re-run.
- **Native sweep unavailable:** plain `serve` does not run it; no global suspended-list API.
- The original UI-driven "0 provider requests" stall was never reproduced and is a separate issue;
   this plan does not claim to fix it.

---

## 16. Protected-file preservation

The following eight pre-existing working-tree paths must remain byte-identical. Hashes were verified
at the start of this revision and all matched:

| Path | SHA-256 (worktree) |
|---|---|
| `docs/opencode-context.md` | `A12572D2A49EC3753220CDED390FF736B7E6E22E8CC4BEAC6761763C1788777C` |
| `src/services/opencode/serverManager.ts` | `0983684C389F1A6516C30BA9D057F65C85DD2EF529ADC0C56AA7BAC5511AEE10` |
| `tests/harness/opencodeRuntimeHarness.ts` | `AB32E09CCAEB51C85451ABCCCAF6BF6AD1B4A9FAAC549471F757F34F5DB9B06A` |
| `tests/integration/opencode/opencode-ownership-runtime.test.ts` | `1BC30A08E1C67D0E4356970BD87281D24CA8F61BBF75D9D357FE971A0C1D85F0` |
| `tests/integration/opencode/serverManager.test.ts` | `A5F00C727411D5BE0390CE4C2303029D60F1FE2B70460D31E36F3D748031E544` |
| `tests/unit/opencode/managed-lifecycle.test.ts` | `A72E31187AB21BA69B0596BF0793BCF6230EFCDB3115BF93949AD5E18031DE18` |
| `tests/e2e/opencode/opencode-managed-restart-recovery.spec.ts` | `5ED8ACE10EA8780B9770E6952DA837D7A80322ECC87BF6F7D1003F6154D532FC` (updated 2026-11-19: two smallest-justified changes — (1) wait for the Send button to be enabled and the composer to hold the prompt before clicking, fixing a UI timing flake that dropped the prompt; (2) wait for the SETTLED transcript (assistant `finish`/`completed` + `idle` marker) before snapshotting, removing a before/after comparison race. Both strengthen determinism; no acceptance assertion, timeout budget, or transcript-persistence check was weakened.) |
| `verify-output.txt` | `DA2685EF3311677F59FB5F1F4967E07B5D14AC3F61DF0387A3ECA33E3EEFD278` |

The P0 test file `tests/integration/opencode/opencode-restart-reconstruction-p0.test.ts` is preserved
unchanged by this revision.

---

## 17. Implementation status and verification (2026-11-17)

**IMPLEMENTED.** The owner authorized implementation; the feature was implemented, committed
(`2ef39c5`), and pushed to `origin/review/managed-opencode-hardening-2026-11-15`. Correctness passes
`0a37700` (stable synthetic id, pending-input-after-idle, projected-synthetic vs pending-user, ownership
filtering, presence-based shutdown grace, shared retry budget), `27dee28` (cancel budget reservation,
per-call timeout enforcement, grace recalculation, managed-target replacement cancellation), and
`3636bb5` (projected-user vs different-pending-user precedence, real timeout assertions, explicit
read-vs-resume timeout policy), and `9502943` (retry-exhaustion outcome handling) were all pushed. The
complete chain is `2ef39c5` → `0a37700` → `27dee28` → `3636bb5` → `9502943`.

### Implemented modules
- `src/config/opencode-recovery.ts` — all recovery constants.
- `src/services/opencode/recoveryClassifier.ts` — pure decision-table classifier.
- `src/services/opencode/recovery.ts` — subscription, dedup, newest-first scan, grace, bounded retries,
  ownership filtering, cancellation/draining.
- `src/services/storage/conversations.ts` — read-only `listOpenCodeRecoveryCandidates()`.
- `src/server.ts` — start before `startOpenCodeRuntime()`; stop/drain in rollback and normal shutdown
  before OpenCode/DB teardown.
- `scripts/run-opencode-runtime-suites.ts` — P0 suite classified as required (registry drift guard).

### Second correction pass (commit `27dee28`, pushed)
- **Cancel budget reservation:** `runStep(run, reserveCalls)` reserves one call for the prompt, so a
  cancellation that succeeds on its last allowed retry still leaves a call to wake the user input.
- **Per-call timeout enforcement:** `withTimeout()` wraps every client call (message list, inbox list,
  session get, and resume actions) with a real abort after `perCallTimeoutMs` (15 s), combined with the
  lifecycle signal.
- **Grace recalculation:** `actWithGrace()` re-evaluates the required grace after each reclassification
  and waits any additional period (bounded to 3 cycles) before acting; a state that keeps escalating is
  skipped conservatively.
- **Managed-target replacement:** `onTargetChange()` aborts in-flight work for any other target when a
  new managed target is published directly, without relying on an intervening unresolved state.

### Third correction pass (commit `3636bb5`, pushed)
- **Projected user vs different pending user:** a pending user whose id differs from the projected user
  is newer intent; the classifier re-submits THAT user by its own id and delivery mode (steer or queue),
  never the older projected request and never borrowing the new user's delivery mode for the old id.
- **Timeout policy made explicit and tested:** `withTimeout()` throws a distinct `RecoveryTimeoutError`.
  Resume operations (prompt / cancel / synthetic) treat it as transient and retry within the 3-call
  budget. Read operations (message list / inbox list / session get) do **not** retry: a read timeout skips
  the candidate for the pass because durable state is unproven. The timeout test now asserts the request
  signal was actually aborted and that the pass settled within a bounded time (not via the drain's 10 s
  bound), plus a separate test asserts resume timeouts retry up to 3 calls.

### Fourth correction pass (commit `9502943`, pushed) — retry-exhaustion outcomes
- **Defect:** `runStep()` returned `"transient"` when all retry attempts were exhausted, but `terminal()`
  did not treat it as terminal. A failed cancellation therefore proceeded to the prompt, and exhausted
  prompt/synthetic retries could still be reported as `"recovered"`.
- **Fix:** `runStep()` now returns a distinct `StepResult` that never leaks `"transient"`. An exhausted
  retry sequence (all attempts transient, or no budget left) becomes the explicit terminal `"exhausted"`
  outcome. `failureOutcome()` maps it to `"failed"`. Cancellation proceeds to the prompt **only** after
  `session.inbox.cancel()` actually succeeds; prompt and synthetic return `"recovered"` **only** when the
  underlying call succeeds. 404 / 409 / permanent errors keep their existing non-success outcomes. The
  shared 3-call budget and reserved prompt call are unchanged; the synthetic id is still minted once and
  reused on every attempt.
- **Test seam:** `getOpenCodeRecoveryState().lastOutcome` records the final `performAction` outcome for
  test-only inspection (no internal functions exposed).

### Verification actually run (exact results)
- `bun run typecheck` → exit 0; `bun run lint` → exit 0; `bun run format:check` → exit 0;
  `bun run test:locations` → exit 0.
- Targeted recovery tests (`recoveryClassifier` + `recoveryService`) → **54 pass / 0 fail** (includes
  regressions for the second, third and fourth correction passes).
- P0 reconstruction test (real v2.2.6 binary, unchanged) → **7 pass / 0 fail**, 26 expects.
- `bun run test:opencode-runtime` → **10/10 required suites passed**.
- `bun run build` → exit 0.
- `bun run verify` → exit 0; **5970 pass / 88 skip / 0 fail** (unit+integration), 802 DOM pass,
  shutdown/rollback/lifecycle pass, quarantine OK.
- `bun run test:e2e opencode/opencode-v2-code-route.spec.ts` → 1 passed.

### Dedicated managed-restart E2E — baseline comparison (not a regression)
The unchanged spec `opencode-managed-restart-recovery.spec.ts` (a protected path, not modified) was run
via the isolated external-server runner against three states, each in its own isolated temp root:
- Parent commit `2ef39c5` (detached worktree): **1 failed** — `expect(page).toHaveURL(/#\/chat\/new$/)`
  received `/#/code` (navigation assertion in the `openCodeDraft` helper).
- Corrected commit `0a37700` (detached worktree): **1 failed** — the same `toHaveURL` navigation error.
- Working tree (`0a37700` + uncommitted second-pass fixes): **1 failed** — `timeout waiting for distinct
  assistant response persisted in OpenCode session history`.

The spec fails at **all three states**, so the E2E is **not green at the parent commit** and its failure is
**not a regression** from either recovery commit. Precision: this comparison establishes only that the
spec already failed at `2ef39c5` (at the earlier navigation assertion). It does **not** establish that the
specific transcript-timeout defect existed at the parent, because the parent runs failed earlier and never
reached that assertion. The differing failure modes (navigation vs transcript) indicate the spec is flaky
in this environment.

The transcript-completeness defect is documented in the **local working-tree** copy of
`docs/opencode-context.md` (a protected, uncommitted path) at lines 190–197 and 250: persisted 2.2.6
message-list contains only the user prompt `msg_pending_*`, no distinct assistant response. Those line
references are **not** present in the version of that file committed on this branch, because the local
file carries additional uncommitted documentation. The E2E spec is a protected path and was not modified.

### Remaining risks
- Cross-state ordering (§7.5) uses the conservative fallback; the intent-revision record is unapproved.
- Native synthetic ambiguity falls back to no-auto-resume.
- Shutdown grace is presence-based (`busy` set, `idle` absent), never a timestamp comparison; a session
  with both markers present uses the shorter state-specific grace.
- Cross-process collision and best-effort (not exactly-once) semantics remain accepted (§15).
- `verify:full`/Semgrep remains environment-blocked (pre-existing).

No schema, migration, dependency, launch-config, protected-path, commit, push, merge, or branch change was
made in this third correction pass. The §7.5 intent-revision record remains a proposal only. The two
temporary detached worktrees used for the E2E baseline comparison live outside the repository under
`D:\Coding\OpenCode\user\tmp\opencode\` and do not affect the working tree.
