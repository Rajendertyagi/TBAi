# The `sync/` layer — what owns what

The OpenCode V2 frontend runtime used to live in one file:
`web/src/features/opencode/v2ThreadController.ts`. It carried the event loop,
the hydration, the prompt admission, the permission and form replies, the
cancellation, the reconnect, the compaction and the revert recovery — and
several of the plan's findings live in that one file.

This directory is the extracted **lifecycle** layer. The controller still
owns the **domain state**; the layer owns the **lifecycle** around it. This
page is the contract: one responsibility, one owner, and a statement of what
each module may depend on and must not touch.

## The rule

> Each lifecycle has exactly **one** owner. A module that appears in two rows
> below is doing two jobs, and that is a defect — not a style question.

The rules that follow from it:

1. **A promise is owned by the thing that can settle it.** Each attempt creates
   its own startup gate and is the only thing that can settle it. The event
   pipeline may *report* a failure, but it reports it through the host, and the
   host settles the gate — on **the attempt the failure came from**.
2. **The retry counter lives with the scheduler.** The event pipeline owns the
   reconnect budget and the backoff timer. It is charged when a retry is
   scheduled and reset only by the controller, after an attempt reports a
   completed hydration. The counter is deliberately *not* attempt-scoped: the
   ceiling belongs to the runtime, but only a completed, still-live attempt may
   reset it.
3. **Waiting state is presentation, not lifecycle.** Nothing in this layer
   renders; the composer renders the controller's state.
4. **A module that cannot settle something must not pretend to.** The loader
   cannot decide what a message means; it dispatches the projection and the
   reducer decides.

## The modules

| Module | Owns (exactly this, nothing else) | May depend on | Must not mutate | Interface |
|---|---|---|---|---|
| `optimistic.ts` | The local identity of a prompt (its message id and how it travels with assistant-ui's append metadata) and the optimistic transcript record shown while the prompt is in flight | `v2MessageProjection`, `v2Types` | anything | `createV2MessageId`, `attachV2PromptMessageId`, `isLocalV2MessageId`, `optimisticMessage` |
| `promptsInFlight.ts` | The admission state of a prompt: whether the server took it, what it was admitted as, and the waiters blocked on that answer | — | admission verdicts it did not receive | `createPromptsInFlight` → `create` / `settle` / `markAmbiguous` / `awaitAdmission` / `get` / `disposeAll` |
| `startupGate.ts` | The readiness promise of ONE connection attempt and the handles that settle it | — | the connection, the error classification, whether the attempt is still live | `createStartupGate` → `open` / `resolve` / `reject` / `pending` |
| `attempt.ts` | One connection attempt: its id, its own readiness gate, its connection signal, the generation it adopted, the load promise in flight, and whether it is still hydrating or has been settled (superseded or terminally failed) | `startupGate`, `v2Client` (types) | domain state, the retry budget | `createAttempt(id, lifecycleSignal)` → `gate` / `signals` / `generation` / `hydrating` / `retired` / `adopt` / `beginHydration` / `projectionCommitted` / `endHydration` / `markReady` / `fail` / `retire` / `load` / `setLoad` |
| `eventPipeline.ts` | The lifecycle of the event stream: the read loop, the ordinal, the buffer that holds events arriving during a history read, the read boundary a held event is dated against, the retry timer, the retry budget and whether that budget is spent | `attempt`, `config` (constants) | domain state; it never settles the readiness gate itself | `createEventPipeline` → `consume` / `scheduleReconnect` / `nextOrdinal` / `beginHistoryRead` / `buffer` / `bufferedEntries` / `clearBuffer` / `resetAttempt` / `isExhausted` / `cancelReconnect` |
| `sessionMessageLoader.ts` | The mechanics of the history read and the commit of its projection | `v2History`, `v2Types` | domain state; it commits through the reducer | `createSessionMessageLoader` → `read` / `commit` |
| `historyReplay.ts` | Which held events may be replayed onto a committed snapshot: the parts the snapshot already carries text for, and the rule that follows from it | `v2Types` (types only) | domain state; it decides, the controller applies | `deltaPartId` / `coveredTextPartIds` / `shouldReplayBuffered` |

The controller (`v2ThreadController.ts`) owns **domain state, dispatch and
policy** and delegates the rest. It is the only module that touches the
reducer's state.

## The mechanism table — what each phase added, and where

The layer was extracted **behaviour-preserving** in Phase 2, so it started with
no mechanism of its own. Each finding the plan closes later needs one, and each
gets it here, in the module that owns it:

| Mechanism | Module it lives in | Finding | Phase | Status |
|---|---|---|---|---|
| Attempt-scoped readiness, load promise, generation and abort signals | `attempt.ts` | M1, M2, L4 | 3 | **delivered** |
| The retry reset driven by a completed, still-live attempt | `v2ThreadController.ts` (the only caller of `resetAttempt`) | M1 | 3 | **delivered** |
| The delay policy: foreground cap, configured ceiling | `eventPipeline.ts` | D2 | 3 | **delivered** (see `docs/decisions.md`) |
| The spent budget refusing incidental reconnects; explicit recovery via `retry()` | `eventPipeline.ts` (`isExhausted`) + `v2ThreadController.ts` | D2 | 3 | **delivered** (see `docs/decisions.md`) |
| The permanent-4xx shortcut | — | D2 | 3 | **not implemented**: the official client discards the status for every declared one (`docs/decisions.md`, 2026-10-21) |
| The buffer's read boundary, and the coalescing gated on it | `eventPipeline.ts` (`beginHistoryRead` / `buffer`) | M5 | 4 | **delivered** |
| What a held event may be replayed onto: the snapshot's own per-part text decides, not the ordinal | `historyReplay.ts` | H2 (follow-up, 2026-10-22) | 4 | **delivered** |
| Snapshot ↔ live-event precedence, and the overlay of events observed during a read | `v2Events.ts` (the `history_loaded` reducer) + `v2ThreadController.ts` (`beginHistoryReadScope` / `historyMerge` / `noteLiveMutation`) | H2 | 4 | **delivered** (see `docs/decisions.md`) |
| The reconciling commit (held ids + touched ids; there is no replace mode) | `sessionMessageLoader.ts` | H2 | 4 | **delivered** |
| Per-kind availability of the auxiliary reads, and the one line that names the sets whose read failed | `v2Events.ts` (the three `*_hydrated` reducers) + `auxiliaryNotice.ts` | M10 | 4 | **delivered** |
| The unadmitted-prompt registry's idempotent release | `promptsInFlight.ts` | M3 | 5 | pending |
| A bounded readiness gate with a typed failure | `startupGate.ts` | M3, M4 | 5 | pending |

A module that exists only to be filled in later is not created: an empty
module has no owner, and the orphan-module gate would report it. Phase 4 is why
there is no `recoverySnapshots.ts` in the tree: the snapshot/live reconciliation
turned out to be a property of the commit's inputs, so it lives where the
reducer and the controller already were rather than in a module of its own.

## Adding to this layer

1. **One responsibility.** If the name needs an "and", it is two modules.
2. **State has one home.** A piece of mutable state belongs to the module
   that can settle it, and it is reachable only through that module's
   handle.
3. **The controller keeps the domain.** A module that needs to change
   domain state dispatches an action; it does not hold a reference to the
   state and mutate it.
4. **Dependencies go through narrow interfaces.** The event pipeline takes a
   narrow host interface of small, named members, not the controller itself. A
   module that needs the whole controller is a module that has not found its
   seam yet.
5. **The tests must not move.** A relocation updates the imports, and it
   updates any source-text guard that named the old path — after reading the
   guard, not by weakening it.
