## ADR: Direct context assembly is a hybrid explicit seam (2026-10-01)

**Status:** Accepted. Phase 2.1d. Evidence: docs/context-architecture-audit.md, docs/context-assembly-contract-2.1b.md, docs/context-contract-validation-2.1c.md, docs/context-ownership-unknowns-u25-u30.md.

### The decision

Direct-engine model context is assembled by **one** server-side boundary, ssembleContext(...), with this authority split:

- **Authoritative:** server-owned Layer A (instructions) and Layer B (tool definitions); the **context budget and every enforcement decision**; the **context window limit and its provenance**; the persisted message ordering (order_seq).
- **Submitted, not authoritative:** the browser-posted messages array. It is the *content input* for Layer C, and the server treats it as a **claim about history, not a record of it**.
- **Reconciled, never silently merged:** stored history (SQLite) is compared against the submitted claim on every request. The comparison is recorded as provenance, logged, and used to classify the request. It never rewrites stored history and never discards client state.

This is **Option C**, chosen on evidence. It is not a preference between B and C; B was rejected because it cannot detect a false claim, and A was rejected because it requires capabilities TBAi does not have.

### Why not A (server-authoritative)

A was rejected on a hard, verified constraint, not on cost.

**TBAi owns no server-side record of client-produced tool results or approval decisions.** Verified in 2.1a and re-verified in the U25/U30 investigation: there is no approval table, column, or endpoint (src/routes/ exposes only /api/chat, /api/chat/resume, /api/chat/stream-status, /api/chat/cancel, /api/tools/*); 	oolApproval (chat.ts:525-532) is a static map with no per-request state; and client-side tool results exist only in Chat.state.messages (i:19034 
eplaceMessage) until the client persists them.

Under A the server would therefore be blind to state that demonstrably exists. Making it non-blind requires **two new server write paths** (tool results, approval decisions) plus a frontend transport change to stop sending history. That is a larger change than Phase 2, it touches the approval security boundary, and it converts a working path (U30 **CLOSED**: approval survives persistence and is honored after reload) into one that must be re-proven end to end.

**Choosing A would be inventing a persistence mechanism to justify the architecture.** That is explicitly out of bounds.

### Why not B (browser-authoritative + server-enforced, no reconciliation)

B's enforcement is real - the server measures and bounds what it receives, so an oversized request cannot be sent. But B cannot distinguish three different situations that all look like "a messages array arrived":

1. a faithful history,
2. a history missing turns the client never received (e.g. a server-finalized detached reply - the client is gone in that case, so it cannot be re-sent),
3. a claim that is simply wrong.

B bounds all three identically and reports none. That makes the budget a **ceiling on a number the client supplied**, which is the weakest form of enforcement available: the client still decides the content, so the server can only cap damage, never know the truth.

B was rejected because reconciliation is cheap (one indexed read TBAi already performs at load time) and turns an unbounded claim into an observable one.

### How server-side enforcement is authoritative anyway

This is the crux, and it holds under C. Enforcement authority does **not** come from trusting the client's content - it comes from the fact that **the client does not decide**:

- The **budget** is computed server-side from the assembled request and enforced server-side. A request above the ceiling is refused or reduced before streamText. The client cannot override this, because the client is not in that path.
- The **limit** and its **provenance** are resolved server-side. A missing limit is an explicit unknown state with documented conservative behavior, never a silent 128k. (Amended by R1: the provenance is now a four-state resolved vocabulary — `provider_reported`, `configured`, `conservative_default`, `unknown` — and the standing 128k is reported as `conservative_default`, i.e. explicitly as TBAi's assumption rather than as a model fact.)
- The **output reservation** is applied server-side to the request. (Amended by R1: the reservation held back from *input* and the *generation cap* sent as `maxOutputTokens` are now separate quantities. The pre-R1 code used one value for both, which capped generation at the 4,096-token reserve regardless of what a model documented. The invariant the sharing implied — `input + output <= ceiling` — is now guaranteed explicitly by clamping the cap to the room left in the window.)
- Layer A and Layer B are **not accepted from the client at all** (chat.ts:191-201, :252-258).

So the worst a dishonest client can achieve is a *wrong* history, which the budget still caps and the reconciliation still reports. It cannot make the server send an oversized request, and it cannot widen the window. That is what "authoritative" means here: the client can lie about *what the history is*, never about *whether it is allowed to be this large*.

### The three layers (normative)

A model request is **three** things, not one flat context. A and B are streamText arguments and are **not** ModelMessage entries:

`	ext
MODEL REQUEST
â”œâ”€â”€ Layer A - instructions / developer context   (streamText instructions, server-owned)
â”œâ”€â”€ Layer B - tool definitions                    (streamText 	ools, server-owned; B.1 native, B.2 MCP)
â””â”€â”€ Layer C - messages[]                          (streamText messages)
      â”œâ”€â”€ C.1 retained conversation history
      â””â”€â”€ C.2 current user turn
`

The provider's cacheable prefix is the **concatenation** A -> B -> C, so a change in Layer B invalidates Layer C's cacheability exactly as reordering history would. This is why tool-definition ordering is a correctness concern and not cosmetic. (Phase 3 owns the caching itself; Phase 2 makes the request *cache-ready* by making it deterministic.)

### Corrected guarantees

Four guarantees from 2.1b were restated after 2.1c validation. The corrections are part of this decision:

- **G4 (revised).** The request **envelope** is closed - chatRequestSchema is .strict() (alidation.ts:53), so an unknown top-level key fails validation, and the four server-owned directive fields are rejected (chat.ts:191-201). The message **payload** is open: messages is z.array(z.unknown()).min(1) with **no .max()** (alidation.ts:41), and chatMessageMetadataSchema is deliberately opaque (alidation.ts:4-8). The schema is **not** semantically strict and must not be described as such.
- **G6 (revised).** The **primary** approval-replay protection is the AI SDK's current-array approval-ID match, which fails closed (i:2937-2941, throws InvalidToolApprovalError). The pruner's expiry rule (prune-messages.ts:142-148) is secondary. The per-run secret is a third mechanism whose verification site remains **unknown** (U26) and is not relied on.
- **G7 (split).** *Persisted message ordering* is server-defined and provable (order_seq assigned in storage/index.ts:485-494, read ordered at :515). *Tool-definition and MCP ordering* is **not** deterministic today (getAiTools iterates 	his.connections, manager.ts:1027-1061) and is a Phase 2 deliverable. The two must not be conflated.
- **G13 (withdrawn as stated).** The old wording claimed a resume-triggered auto-continue is distinguishable. It is not: the server reads 	rigger **zero times**, and the SDK **replaces** "resume-stream" with "submit-message" before the POST leaves the client (i:19311-19319). The request enum also does not accept "resume-stream" (alidation.ts:42), so forwarding it would be a 400.

**Q2 resolution (smallest consistent treatment):** keep the enum as-is and **do not** extend it. Instead, resume origin is derived from **server/run state**, not from the client: the server already receives the GET /api/chat/resume/:streamId call (chat.ts:850-897) with the streamId, and chatRuns / chat_streams hold that run's state. 	rigger stays a client-side concern only, and TBAi does not read it. This is the smallest treatment that is architecture-consistent: it needs no frontend change, adds no field, and does not pretend the client is honest about cause.

**Q10 resolution:** ssembleContext(...) is **async**. SQLite (listThreadMessages, getThreadTip, hasStoredMessage - all sync in storage/index.ts), memory retrieval (storage/index.ts:580), and model-metadata lookup (modelDiscovery.ts:158, a network fetch) all require it; MCP tool assembly (getAiTools is synchronous) and token measurement do not. prepareModelMessages is already sync (model-messages.ts:14) and is already awaited at chat.ts:341, so this is **non-breaking**.

### Reversibility

**C -> A is expensive. A -> C is trivial.** That asymmetry is itself a reason to choose C: it keeps the cheap direction cheap.

To move toward A later, the seam must be able to satisfy Layer C from storage alone. Two changes are required, and both are additive rather than structural: (1) a server write path for client-produced tool results, and (2) a server write path for approval decisions. Nothing about the seam's shape has to change - only which input fills Layer C. Conversely, moving C down to B is a **deletion** (remove the reconciliation read); moving it up toward A is additive. There is no rewrite in either direction.

### Scheduler boundary

**Scheduler stays separate and out of Phase 2.** Verified: it does not call prepareModelMessages, does not run the pruner, sends messages: [{ role: "user", content: fullPrompt }] (schedulerExecution.ts:346) with no history at all, uses stepCountIs(10) against Direct's 20 (:348 vs chat.ts:523), and carries **no** 	oolApproval - so gated tools are unavailable to unattended runs (U32, possibly intentional, undocumented). It shares only getModel + streamText with Direct.

A Direct-only ssembleContext is therefore legitimate, provided it is recorded as a **boundary** rather than left implicit: if a later phase needs unattended context (scheduled jobs reasoning over a conversation), this scope becomes a gap rather than a deferral. No second generalized framework is created for theoretical reuse.

### Dependency-owned invariants (recorded, not owned by TBAi)

Three behaviors this decision relies on are **library invariants**, not TBAi guarantees:

1. **Resume id restoration** - i:7551-7552 overwrites the placeholder id with the replayed start chunk's id. U25 **CLOSED** on this basis. chat.ts:720 wraps the response body from byte 0, so the replay always carries that chunk (empirically verified).
2. **Storage round-trip fidelity** - iSDKV6FormatAdapter.encode is a rest-spread stripping only id (ssistant-cloud@0.2.1, dist/ai-sdk/index.js:6). U30 **CLOSED** on this basis (empirically verified: pproval.id, 
equestReason, 	oolCallId, and part state all survive verbatim).
3. **Approval id matching** - i:2937-2941 fails closed.

None of the three is enforced by TBAi code, and a dependency upgrade could change any of them. Regression tests are added **at the TBAi boundary** so a change is detected rather than assumed.

### R1 amendment — provenance is a required field, not a convention (2026-10-01)

This decision's authority split says the limit and its provenance are resolved
server-side. R1 found that half of that sentence was not implementable as
written: a provider-discovered figure and a human-typed figure were written to the
same field, so provenance was lost at write time and **unrecoverable afterwards**.
Wiring the metadata (the one-line change the decision implied) would therefore have
logged a number the user invented as `provider_reported`.

The amendment makes the contract true rather than weakening it:

1. A numeric limit is stored together with the stance of whoever asserted it
   (`ModelOption.contextWindowSource`). Only two stances are storable —
   `provider_reported` and `configured` — because only two kinds of writer exist.
   `conservative_default` and `unknown` are resolver outcomes, never persisted
   facts about a model.
2. The two writers go through dedicated helpers, so **a user-entered value cannot
   be labelled `provider_reported`** by construction rather than by discipline.
3. A pre-R1 row (value, no stance) resolves as `configured` — the label that
   **fails closed**. Over-claiming a number nobody verified could authorise a
   cache experiment; under-claiming only denies Phase 3 eligibility.
4. When a provider figure and a configured figure conflict, the **configured**
   value wins and the losing figure is recorded on `divergentValue`. Rationale: a
   published window is model-wide while limits may follow a per-account
   entitlement, so the operator can be closer to the truth than the listing; and
   silently overriding an explicit human setting is worse than honouring it.

**Binding Phase 3 constraint added by this amendment.** A `conservative_default`
or `unknown` ceiling may bound safety, but must never size a cache prefix, choose
a cache breakpoint, segment an experiment, claim cache effectiveness, or
interpret cache hit/read/write results. This is enforced in code by
`isPhase3ExperimentEligible` and surfaced on every request as
`phase3ExperimentEligible`, rather than left to prose — the failure it prevents is
silent, producing a confidently wrong conclusion about whether caching helps.

Full reasoning and the alternatives rejected: `docs/r1-context-limit-decision.md`
§13–15. Implementation record: `docs/r1-context-limit-implementation-report.md`.
