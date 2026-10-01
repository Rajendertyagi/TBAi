# ADR: Context compaction is a durable marker applied at assembly, never a history rewrite

**Date:** 2026-10-01 · **Status:** accepted · **Phase:** 4

---

## The decision

**Compaction persists a compaction record (a boundary marker plus a bounded
summary) and applies it inside the existing `assembleContext` seam. Stored
history is never rewritten.**

The compaction record is a new additive table. Originals stay exactly as they
are, byte for byte.

---

## Why: rewriting stored history is provably inert here

This is not a preference between two reasonable designs. Under architecture C,
**rewriting stored messages cannot work at all.**

Verified from source (`src/context/divergence.ts:5-11`, Phase 1 finding F8):

> the server never re-reads messages for a request

The browser POSTs the entire `messages` array on every turn, and that array —
not SQLite — is what `assembleContext` consumes. `hasStoredMessage` is
existence-only; the divergence report compares ID sets and **deliberately never
merges**. `listThreadMessages` is not consulted for assembly at all.

So if compaction rewrote `messages.content`, the next request would arrive
carrying the client's own uncompacted history and the rewrite would have **no
effect on what the model sees**. The feature would appear to work in the
database and do nothing at request time. Option B is not worse than Option A —
it is inert.

A marker is the only representation that can affect the request, because the
server is the component that assembles it.

---

## Options considered

| | A. Rewrite history | **B. Marker + summary (chosen)** | C. Client-side compaction |
|---|---|---|---|
| Affects the request? | **No — inert** | Yes | Yes |
| Auditability | Originals destroyed | Originals intact | n/a |
| Rollback | Impossible without backup | Delete one row | n/a |
| Repeated compaction | Lossy and compounding | Bounded, marker-to-marker | n/a |
| Reload / resume / detached | Diverges from what the model saw | Same path, same result | n/a |
| Phase 2 seam | Unchanged | Unchanged — one more stage | Would need a second path |
| Branch topology | Silently flattened | Preserved (originals untouched) | n/a |
| Storage growth | Shrinks | Grows slowly | n/a |
| Cache stability | Destroys the prefix | Resets the prefix **once, deterministically** | n/a |

---

## The honest cost of the chosen design

**The user-visible transcript keeps its full history while the model sees a
compacted form.** Under architecture C the browser owns thread state, so the
server cannot compact what the user sees without a second authority.

This is a real divergence and is recorded as a **KNOWN LIMITATION**, not
smoothed over. It is also arguably better than the alternative: nothing is
deleted from the user's view, and the reduction applies where it matters — the
model's context window, which is the thing that actually overflows.

The *model's* context is deterministic and durable: the marker is persisted, so
reload, resume, detached completion and the next turn all assemble the identical
compacted form. That is the durability requirement, and it holds.

---

## What compaction is for

**Converting the hard `CONTEXT_OVERFLOW` rejection into graceful degradation.**

Verified: `chat.ts:412` rejects an over-budget request with HTTP 400 and
`code: "CONTEXT_OVERFLOW"`. Today that is a dead end for the user — start a new
chat or switch model. After Phase 4 the same pressure triggers compaction, and
only a request that still does not fit is rejected.

Compaction is **not** a cost optimisation, not a cache optimisation, and not a
message-deletion policy. Those would each need their own evidence.

---

## Boundaries this design preserves

1. **`pruneStaleMessages` is untouched.** Lifecycle repair stays lifecycle
   repair. Compaction runs on the ALREADY-PRUNED history, as a separate later
   stage, so a size decision can never resurrect a stale tool part or an expired
   approval.
2. **One assembly path.** Compaction is a stage inside `assembleContext`, not a
   second context system.
3. **No provider-specific orchestration.** The summariser uses the existing
   `getModel`; no provider branches.
4. **Scheduler untouched.** It never reaches this seam.
5. **Provenance is structural where it must be durable, and explicit where it
   must be model-visible.** The durable record lives in its own table with
   provenance columns — that is the authoritative representation, not text
   hidden in a summary. The model-visible rendering is a **deterministic text
   header** stating the block's origin and size.

   ⚠️ **A custom `data-tbai-*` UIMessage part was evaluated and REJECTED.** It was
   assumed to survive into the model request. It does not: `convertToModelMessages`
   handles a data part **only** when `options.convertDataPart` is supplied, and
   without it the part is silently dropped and the message converts to empty
   content. Verified against the installed SDK by capturing the real Anthropic
   request body — the provenance did not appear in it. Using it would have meant
   adding an option to `prepareModelMessages`, a Phase 2 file, for no benefit:
   the durable table plus a typed `AssemblyProvenance` field give stronger
   guarantees than a part the SDK would discard.

---

## Reversibility

Deleting the compaction record restores the uncompacted behaviour exactly,
because originals were never touched. There is no migration to reverse and no
data loss path.

---

## Rejected alternative: compaction as "truncation"

Dropping the oldest N messages is not compaction. It silently destroys user
content with no representation, no provenance, and no reversibility. It is
explicitly rejected.

---

# Addendum — what implementation proved

The decision above survived implementation. Four things did not, and each is
recorded because the reasoning is reusable.

## A1. The summariser's input ceiling is CAPACITY, not budget

**Assumed:** the summariser can read what the turn may send, so deriving its
ceiling from `budget.usableInputTokens` is close enough.

**Proved wrong by measurement.** A conversation large enough to *need*
compaction is by definition larger than the budget, so a budget-derived ceiling
rejected essentially every real compaction with `summary_exceeds_budget`. The
phase could never fire.

The two are different quantities. `budget.usableInputTokens` is what a **turn**
may send after the safety margin and the turn's output reservation.
`limit.maxInputTokens` is what the **model** can accept. The summariser reserves
far less output than a turn, so it can legitimately read more. See
`resolveSummarizerInputTokens`.

## A2. Hysteresis must be DURABLE state, never derived from usage

**Assumed:** "don't compact again until usage falls below the release fraction"
is a comparison on the current measurement.

**Proved wrong by construction.** The condition can only clear *below* `release`,
which is also below `trigger`, so the below-trigger branch always won and a
conversation that had ever been compacted could **never** be compacted again. It
would grow to rejection with a perfectly good span sitting there uncompacted.

Hysteresis is therefore a `latched` column on the durable record, set on
compaction and cleared only when the seam *observes* usage below the release
fraction. Derived state cannot express "since last time".

## A3. The plan must be computed over the CLIENT's messages

**Assumed:** planning over the already-compacted view is convenient and
equivalent.

**Proved wrong, and this was the most serious defect in the phase.** The compacted
view contains a server-injected `tbai-compaction:*` block whose id the client has
never seen. Planning over it produced a second compaction whose covered ids
included that injected id — so on the next request the record was unlocatable,
compaction silently stopped applying, and the conversation reverted to full
history and grew without bound, with no error anywhere.

Every covered id must be one the client will re-post. That is what makes the
record durable, and it is now asserted directly.

A repeat compaction additionally receives the **previous summary**, because the
new span covers strictly more of the conversation while the messages between the
two spans survive only inside the old one.

## A4. Advisory aborts are not bounds

**Assumed:** `AbortController` plus a timer bounds the summarisation call.

**Proved wrong twice, both by capturing the SDK's actual behaviour.**
`generateText` passes the signal down and does not race the call itself, so a
provider that ignores it completes late — a slow model returned `ok: true` after
the full timeout. And the signal the model receives can be **already aborted** on
entry, so a provider that only subscribes to the `abort` event never learns about
it.

The call is now raced against both the deadline and the caller's abort. TBAi's own
bounds are authoritative, independent of provider behaviour.

## K2. KNOWN LIMITATION — single-pass compaction has a hard size bound

Once a conversation outgrows the summariser's one-call input capacity, its span
can no longer be summarised in a single pass, and compaction **declines** with
`span_exceeds_summarizer_capacity`. The pre-existing budget machinery then decides.

This is deliberate. Both alternatives were rejected: summarising a *prefix* of the
span and presenting it as the whole span would be a fabrication, and summarising
the summaries is precisely the recursive context-growth path the phase forbids. The
check runs at plan time, before any provider call, so declining costs nothing and
reports a precise reason.

Lifting the bound would need chunked summarisation with a bounded combining step —
real work, and a product decision rather than an implementation detail.