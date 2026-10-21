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
| `eventPipeline.ts` | The lifecycle of the event stream: the read loop, the ordinal, the buffer that holds events arriving during a history read, the retry timer and the retry budget | `attempt`, `config` (constants) | domain state; it never settles the readiness gate itself | `createEventPipeline` → `consume` / `scheduleReconnect` / `nextOrdinal` / `currentOrdinal` / `buffer` / `bufferedSince` / `clearBuffer` / `resetAttempt` / `cancelReconnect` |
| `sessionMessageLoader.ts` | The mechanics of the history read and the commit of its projection | `v2History`, `v2Types` | domain state; it commits through the reducer | `createSessionMessageLoader` → `read` / `commit` |

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
| The permanent-4xx shortcut | — | D2 | 3 | **not implemented**: the official client discards the status for every declared one (`docs/decisions.md`, 2026-10-21) |
| Snapshot ↔ live-event precedence, and the overlay of events observed during a read | a new `recoverySnapshots.ts` | H2, M5 | 4 | pending |
| The unadmitted-prompt registry's idempotent release | `promptsInFlight.ts` | M3 | 5 | pending |
| A bounded readiness gate with a typed failure | `startupGate.ts` | M3, M4 | 5 | pending |
| The commit mode (replace or merge) | `sessionMessageLoader.ts` | H2 | 4 | pending |

A module that exists only to be filled in later is not created: an empty
module has no owner, and the orphan-module gate would report it. The
`recoverySnapshots.ts` row above is therefore a promise for Phase 4, not a
file today.

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
