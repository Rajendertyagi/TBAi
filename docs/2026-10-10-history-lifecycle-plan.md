# History Lifecycle Plan — stale publication, recovery liveness, deletion cleanup

**Date:** 2026-10-10
**Status:** DESIGN COMPLETE. **S and L APPROVED AT SOURCE-REVIEW LEVEL, 2026-10-11 (§15.7). NOT committed.** P2 remains HOLD on the commit boundary, not on S/L.
**Scope:** Direct-chat conversation history lifecycle only.
**Predecessor:** `docs/2026-10-10-history-window-and-test-relocation-handoff.md` (Part A2/A3 remain accurate except where noted in §11).
**Evidence gate (2026-10-10): NOT MET.** Read **§15 before acting on §0–§14**. Two reported blockers are refuted by executed evidence, and two open questions are recorded there that §0 and §13 do not yet reflect.
**Implementation status (2026-10-11): S and L APPROVED AT SOURCE-REVIEW LEVEL, working tree, NOT committed** (§15.7). Defect **X remains open and deliberately out of that scope**, as does **D3** (§15.8).

**What the approval is, precisely.** Reviewer read the submitted S/L source across four
rounds and found no remaining source-level blocker. Reviewer **did not run the test
commands**, so the results in §15.7 remain agent-reported, not independently
confirmed. The test-first deviation stands recorded (§15.7).

**Commit boundary — do NOT commit the review patch as one unit.** That artifact mixes
S/L with 429 insertions / 3 deletions of unrelated concurrent storage work, and
includes whole untracked files that have no committed baseline. S/L, **X**, **D3**,
and the concurrent storage work must stay separable.

---

## 0. Summary

Three defects, one root pattern: **module-level derived state has a write path that outlives and bypasses the resource that owns it, and no invalidation token.**

| ID | Defect | Severity |
|---|---|---|
| **S** | A load completing after its controller was dropped republishes UI state for a discarded controller → visible "Load earlier" that silently no-ops | Silent failure to load history |
| **L** | Invalidation of the *active* conversation's controller is terminal — no re-creation path exists | Conversation permanently unpageable |
| **X** | Conversation deletion performs no client-side cleanup; deleted conversations retain controller/UI state and can be resurrected by a late load | Leaked state + resurrection |

Fixes: **D1** (enforce the pair invariant), **D2** (recovery liveness), **D3** (observability), **D4** (boot settle is not recovery), plus **5B** (deletion cleanup).

---

## 1. Diagnosis

### 1.1 The proven chain

A history load captures controller `C1` into a **local variable** and awaits before publishing:

- `web/src/adapters/threadHistoryAdapter.ts:299` — `controller = ensureWindowController(remoteId, …)`
- `:310` — `await controller.loadTip()`
- `:320` — `publishWindowUi(remoteId, controller)` ← uses the **local**, not a map lookup

Availability recovery deletes the registration mid-flight:

- `web/src/features/availability/recovery.ts:44` — `invalidateHistoryCache()`
- `threadHistoryAdapter.ts:99` — `clearAllWindowControllers()`
- `useDirectHistoryWindow.ts:204-208` → `dropWindowController` per id
- `:194` `controllers.delete(id)` · `:196` `uiSnapshots.delete(id)`

`publishWindowUi` then resurrects the UI snapshot:

- `useDirectHistoryWindow.ts:449` — signature takes `controller` **as a parameter**
- `:450-476` — the body reads and writes `uiSnapshots` and **never reads `controllers`**
- `:453` — `hasEarlier: controller.hasMoreBefore` (the dropped object is still fully functional in memory)

Click path: `:185-187` `windowControllerFor` returns `null` → `:568-571` `loadEarlier` returns silently. The only log (`history.page_load_failed`, `:589`) sits **behind** the guards.

### 1.2 Trigger

`availabilityStore.ts:142` `const wasOnline = previousStatus === "online"`; `:162` `if (status === "online" && !wasOnline)`. On a healthy boot `previousStatus === "unknown"`, so **recovery fires on every boot** with nothing to recover.

Measured race window (instrumented E2E, passing runs): recovery at **t=459 ms**, `controller.created` at **t=494 ms** — a **35 ms** window.

### 1.3 What is proven vs unproven

| Claim | Status |
|---|---|
| The mechanism is reachable and produces a dead control | **PROVEN** — unit probe and forced E2E interleaving |
| The dropper is availability recovery | **PROVEN** — explicit marker in `recovery.ts:44`, `scope:"ALL"` |
| It occurs in the real E2E path | **PROVEN** (widened race) |
| Natural failure rate | **UNVERIFIED** — not required to act |
| A naturally observed failure had this exact signature | **UNVERIFIED** |

A deterministic reproduction proves possibility, not causation of any specific observed failure. Neither establishes a rate. **The invariant is missing regardless of frequency.**

---

## 2. Official contract compliance

Verified against docs accessed 2026-10-10 and installed `@assistant-ui/react@0.15.26`, `@assistant-ui/ai-sdk@0.0.12`, `@assistant-ui/core@0.3.25`, `@assistant-ui/store@0.3.18`, `@tanstack/react-virtual@3.14.13` / `virtual-core@3.17.11`.

| Contract | Source | Verdict |
|---|---|---|
| Adapter reference stable across renders (module scope or `useMemo`) | threads.mdx | **COMPLIANT** — `web/src/app/adapter.ts:8` module-scope `const` |
| `unstable_Provider` preferred; `unstable_useAdapters` fallback | persistence.mdx | **COMPLIANT** — both exported from one hook, the docs' own example |
| Provider renders `children` on first commit | persistence.mdx | **COMPLIANT** — `remoteThreadListAdapter.tsx:160-167` |
| Lazy `threadListItem` per adapter call | persistence.mdx | **COMPLIANT** — `createThreadHistoryAdapter(() => auiRef.current)` |
| Stable hook count; memoized return | persistence.mdx | **COMPLIANT** |
| `withKey` on the store-entry `thread` factory | persistence.mdx / threads.mdx | **NOT APPLICABLE** — scoped to `RemoteThreadList({thread})`; TBAi uses `runtimeHook`. **Do not add.** |
| `reloadMainThread()` promise meaning | threads.mdx | **REJECTED as D2 vehicle** — see §3 |
| Host owns the message array (`ai-sdk` → `ExternalStoreRuntime`) | architecture.mdx | **COMPLIANT** |

**No documented API contract is violated.** The defect is TBAi-side.

### 2.1 Upstream PR triage — applicability

| PR | Merged | Package | Verdict |
|---|---|---|---|
| #6071 | 2026-08-18 | `ai-sdk`, `core` | **APPLIES** — `useExternalHistory` waits for `remoteId`; confirmed at `useExternalHistory.js:96-101` |
| #7380 | 2026-09-15 | `react-a2a` only | **NOT APPLICABLE** |
| #7506 | 2026-09-15 | `react-a2a` only | **NOT APPLICABLE** |
| #6203 | 2026-08-25 | `core` (thread-**list** `list()` snapshot) | **NOT APPLICABLE** |
| #7027 | 2026-09-08 | `core`, `store`, `ai-sdk` | **ADJACENT** — cancels a torn-down thread's in-flight request |
| #7033 | 2026-09-08 | `core`, `store`, `ai-sdk` | **ADJACENT** — cancels in-flight work on host unmount |
| #4947 | 2026-07-26 | `react-ai-sdk` | **RELEVANT, DIFFERENT** — defers resume until history settles; TBAi has `ResumableThreadRuntime` |

**Decisive:** installed `useExternalHistory.js` contains **no `AbortSignal`/`abort`/`signal`**; `load()` takes no options. There is **no cancellation plumbing** in the installed version. Upstream ships no mechanism for "reject a completed load whose subject was invalidated."

**The required invariant must be derived locally. It cannot be imported.**

---

## 3. D2 vehicle selection — `reloadMainThread()` rejected

`refetchThread` is **not declared by `@assistant-ui/ai-sdk@0.0.12`**; it appears only in `RemoteThreadList*` / `InMemoryThreadList` / `external-store-*` *consumer* cores.

Per threads.mdx, a remote thread list **without** the capability takes the **remount** path: it *"re-runs `load()` at the cost of discarding unsent composer input, and resolves once the new runtime attaches."*

Rejected because it (a) discards composer drafts, (b) returns a promise that does not mean history is loaded — the exact trap the audit was warned about, and (c) is effectively the unconditional runtime remount that is out of scope.

**D2 is therefore TBAi-internal and reactive: no remount, no `reloadMainThread()`, no new unstable API.**

---

## 4. Design

### D1 — A discarded controller may not publish UI state

`useDirectHistoryWindow.ts:449`. Before writing `uiSnapshots`, require:

```
controllers.get(conversationId)?.controller === controller
```

Otherwise return without writing and emit the D3 refusal. **One site, one condition.** This is the only point at which the pair invariant can be broken.

### D2 — The active conversation regains a populated window

**Why `ensureWindowController` alone is insufficient:** it returns an **empty** controller (`:154-181`). Paging correctness requires committed rows and a known tip. Population is mandatory.

**Why no module-level decoder registry:** see §5.2.

**Shape — driven by the format-adapter scope, where `decode` and `remoteId` are already in closure, and where lifetime = the thread runtime's mount:**

1. Inside the `withFormat` scope, subscribe to `recoveryEpoch`; **ignore epoch 0** (matches `useConversationsList.ts:67-72`).
2. On wake, apply the **self-gating condition** — repopulate only if `windowControllerFor(cid) === null`. The epoch is a **wake signal only**; this makes D2 correct regardless of whether D4 is applied.
3. Guard: not already repopulating (D2's **own** in-flight set — see §4.2) and no live run.
4. Capture `token = { cid, epoch }`.
5. `ensureWindowController` → **`await loadTip()`** (server fetch, fail-closed commit) → **return the controller; publish nothing**.
6. Caller validates the token **before** publishing, then calls `publishWindowUi`.

**D1's identity check is the authoritative gate**; the token prevents wasted work and cross-conversation publication.

The promise settles only after `loadTip()` settles — **no timers, no polling, no sleeps**.

### D2.1 — Single-flight must be a dedicated guard

`beginHistoryReload` (`:406`) is **not** reusable:

- claimed **only** by the user Retry (`DirectViewportBridge.tsx:187`)
- released by **any** load settle — `markHistoryLoadFailed` (`:313`), `clearHistoryLoadFailed` (`:327`)
- released by `dropWindowController` (`:193`) ← the very event that triggers D2
- **never claimed** by the adapter's initial `load()` (`threadHistoryAdapter.ts:309-311`)

D2 therefore uses its **own** in-flight set, released only in D2's `finally`. `beginHistoryReload` keeps its Retry-only semantics unchanged.

> **Recorded, out of scope:** a drop can release another owner's Retry latch. Pre-existing latent issue; not fixed silently.

### D2.2 — Deferred recovery must resume

No timers. A `pendingRecovery: Set<conversationId>` plus event-driven resume:

1. Epoch wake with a live run → `pendingRecovery.add(cid)`; do not repopulate.
2. Subscribe to the thread's run-settle transition (existing runtime subscription).
3. On settle, for each still-current pending id: re-apply the §4 step-2 condition, then repopulate.
4. Cleanup on unmount / conversation change; remove ids for changed or deleted conversations.

If a run never settles the id stays pending; the condition is re-checked at that point, so a controller re-created meanwhile is not disturbed.

### D3 — Make refused paging observable

Log at the `loadEarlier` guards (`:568-571`) with the failing condition (`no_conversation_id` / `no_controller` / `no_chat` / `busy` / `no_more_before`). Log event and copy constants in `web/src/config/history.ts`.

This completes decision A2 (handoff Part A2), which fixed the **failure** half and left the **refusal** half silent. It also covers clicks during an active run, which are currently dropped with no feedback.

### D4 — Boot settle is not recovery

`availabilityStore.ts:66-88` listeners are `() => …` and carry **no transition context**. Add it, then in `recovery.ts` skip **only** `invalidateHistoryCache()` when the transition was `unknown → online`. Thread-list invalidation, provider reload and tab-mirror reconciliation run **unchanged**.

**The state machine supports this:** `unknown` is a distinct initial state, so `unknown → online` is uniquely identifiable and distinguishable from `degraded|offline → online`.

**D4 is exposure reduction, not a fix.** With a slow probe the boot settle still lands after a conversation loads. **D1 and D2 remain necessary.**

---

## 5. The two resolved design questions

### 5.1 — 5A: ID space

`assistant-cloud@0.2.1/dist/ai-sdk/index.js`:

```js
const aiSDKV6FormatAdapter = {
  format: "ai-sdk/v6",
  encode: ({ message: { id: _id, ...message } }) => message,
  decode: (stored) => ({ parentId: stored.parent_id, message: { id: stored.id, ...stored.content } }),
  getId: (message) => message.id
};
```

**Exact identity round-trip on `message.id`.** Therefore persisted row id ⟷ decoded `message.id` ⟷ `getId` are the **same namespace**.

**Positive finding, to be recorded in `docs/decisions.md`:** for `format: "ai-sdk/v6"`, server row id and decoded `message.id` are the same namespace by construction. This closes a previously open question and supersedes any contrary assumption.

> The `lastInnerIdMap` at `useAISDKRuntime.js:507-509` exists because a runtime message may **wrap several** inner AI SDK messages. That wrapping does not occur in TBAi's persisted-row flow.

**Tip-agreement check: DROPPED.** Not because the mapping is unknown — it is proven — but because the only *provably* same-namespace anchor is `lastGoodHistory` (populated at `threadHistoryAdapter.ts:321`), and **that is destroyed by `invalidateHistoryCache` at `threadHistoryAdapter.ts:95`** — the very call that triggers repopulation. The remaining leg, runtime-converter id preservation (`toThreadMessages`), is unverified. Inventing that assumption to keep the check is excluded.

**Consistency is argued structurally instead:** every controller row is server-derived (guaranteed by the window route + fail-closed `checkWindowInvariants` at commit), and **D2 never writes to the runtime**. D2 therefore cannot itself create divergence. Divergence requires an out-of-band server write between the old load and the repopulation, which recovery does not cause. It remains a named residual risk owned by the existing reload/Retry path — **out of P2 scope**.

### 5.2 — 5B: deletion and the rejected decoder registry

**Decoder registry: REJECTED.** `threadHistoryAdapter.load()` shadows `formatAdapter` with the **MessageFormatAdapter** parameter of `withFormat` — a shadowed closure that D2 cannot reach from outside. Capturing it would require a module-level `Map<remoteId, RowDecoder>`.

Deletion tracing showed conversation deletion performs **no client-side window cleanup at all** (§6), so no verified boundary exists at which such a registry could be released. TBAi already retains `controllers`/`uiSnapshots` for deleted conversations; adding a registry compounds an existing gap.

**Resolution: no registry. D2 runs inside the format-adapter scope** (§4, step 1), where `decode` and `remoteId` are already in closure. **Lifetime = the thread runtime's mount; unmount cleanup is automatic; zero new retained state.** This applies the audit's central lesson — derived state belongs to the resource that owns it — rather than adding a third module-global map.

---

## 6. Deletion lifecycle

The docs distinguish `RemoteThreadListAdapter.delete()` (thread metadata) from `ThreadHistoryAdapter.delete()` (messages). **The actual integration bypasses both.**

| Path | Location | Client window cleanup |
|---|---|---|
| `RemoteThreadListAdapter.delete()` | `remoteThreadListAdapter.tsx:321-333` | **none** |
| `ThreadHistoryAdapter.delete(items)` | `threadHistoryAdapter.ts:256-270` | `invalidateHistoryCache(remoteId)` ✓ |
| **Actual conversation deletion** | `deleteConversation.ts:96` | **none** |

All three UI sites (`ChatHeader.tsx:66`, `SidebarThreadRow.tsx:80/287`, `FolderConversationRow.tsx:125`) call `useDeleteConversation` → `deleteConversation(ref)` → a direct `DELETE /api/conversations/:ref`. `RemoteThreadListAdapter.delete()` has **no caller in `web/src`**. `ThreadHistoryAdapter.delete()` is reached only via the runtime's `deleteMessage` capability, which has **no direct caller in `web/src`**, and its responsibility is messages, not the conversation.

**Verified lifecycle boundary: `deleteConversation.ts:100-103`** — the server has confirmed removal (2xx, or 404 as already-gone).

**Change:** call the existing `dropWindowController(ref)` there, after confirmation, and log `history.conversation_dropped`. This also makes D1 reject any late publication.

### 6.1 — Reachability of `RemoteThreadListAdapter.delete()`: RESOLVED

**Determined genuinely unreachable.** Two-sided check:

**TBAi-side:** `threadListItem.delete()` has **zero callers**. Across all 30 `threadListItem.*` usages in `web/src` the methods used are `getState()`, `initialize()` (once — `threadHistoryAdapter.ts:131`), `updateCustom()` (three), plus state reads (`.custom`, `.id`, `.remoteId`, `.externalId`).

**Library-side:** `RemoteThreadList.js:229` passes `onDelete: () => handleThreadListAction("delete", () => onDelete(data_0.id))` into `ThreadListItemClient` — a **store-entry action**, not internal behaviour. It becomes reachable only if something calls `aui.threadListItem.delete()`. No library-internal automatic deletion exists; the other `.delete(` occurrences in `@assistant-ui/core` are `Map`/`Set` deletes and *other adapters'* own implementations (`LocalStorageThreadListAdapter.js:513`, `InMemoryThreadList.js`).

**Decision (maintainer ruling, 2026-10-10):** unreachable ⇒ **document the dead implementation; keep cleanup out of it.**

- **P2 touches `deleteConversation.ts` only.** `remoteThreadListAdapter.tsx` is **explicitly out of P2 scope** (§9).
- **Recorded in `docs/decisions.md` as part of the D1–D4 entry:**
  1. `RemoteThreadListAdapter.delete()` (`:321-333`) is unreachable — no caller in `web/src`; the live path is `deleteConversation.ts:96`.
  2. It performs **no client-side window cleanup**. Correct today only because nothing calls it.
  3. **Hazard:** adopting `aui.threadListItem.delete()` is a natural-looking refactor — the method exists and looks idiomatic — and it would delete server-side with **zero** client cleanup, silently reintroducing defect X. Any such adoption must add `dropWindowController` at that boundary **first**.

**No enforcement test is added, by decision (maintainer, 2026-10-10).** A test forbidding `threadListItem.delete()` would encode an implementation detail as policy rather than assert behaviour, and would permanently block a legitimate future migration that implements the required lifecycle correctly. Reachability is therefore **mitigation by record, not by enforcement** — which is acceptable *because* the requirement below is stated as a precondition rather than left implicit.

**Precondition on future adoption:** any change that makes `aui.threadListItem.delete()` reachable **must add equivalent `dropWindowController` cleanup at that boundary first**, and must prove it with the §10 case-8 test against that path. Adopting it without the cleanup reintroduces defect X silently — the server row disappears while the client keeps a controller, a UI snapshot, and a window that a late load can still publish into.

Scope is one call plus one log. **No cache refactor.**

---

## 7. Ownership and invalidation rules

SQLite remains the sole authority for persisted history. Clients are derived, disposable, reconstructible from `/api/conversations/:id/messages/window?anchorId=…`, which accepts any anchor.

| Rule | Enforcement |
|---|---|
| A controller not currently registered may not publish | **D1** — `publishWindowUi` |
| One repopulation per conversation at a time | D2's dedicated in-flight set |
| Repopulation never runs during a live run | `isRunning` guard |
| A superseded repopulation never publishes | token check + **D1** |
| A deleted conversation leaves no client history state | **5B** — `deleteConversation.ts` |
| Boot settle performs no history invalidation | **D4** |
| D2 acts only when its own controller is absent | self-gating condition (§4 step 2) |

---

## 8. Failure behaviour

| Situation | Behaviour |
|---|---|
| Repopulation `loadTip()` fails | no publish; existing `markHistoryLoadFailed` → Retry row; control stays hidden until Retry |
| Repeated availability transitions | epoch advances; in-flight set collapses to one; next epoch retries |
| Conversation deleted mid-repopulation | deletion drops the controller → **D1 rejects the publish** (correct by construction) |
| Thread switch mid-repopulation | token check discards; no cross-conversation publish |
| Streaming run active | deferred via `pendingRecovery`; resumes on run settle (§4.2) |
| Empty conversation | `loadTip()` returns empty; `hasEarlier:false`; nothing published — unchanged |
| Out-of-band server change | named residual risk; owned by the existing reload/Retry path, out of scope |

---

## 9. Files in scope

| File | Change |
|---|---|
| `web/src/features/chat/history/useDirectHistoryWindow.ts` | **D1** identity check; **D3** refusal log |
| `web/src/adapters/threadHistoryAdapter.ts` | **D2** repopulation inside the `withFormat` scope; no registry |
| `web/src/features/chat/state/deleteConversation.ts` | **5B** `dropWindowController` after server confirmation |
| `web/src/features/availability/availabilityStore.ts` | **D4** transition context to listeners (`:66`, `:162`) |
| `web/src/features/availability/recovery.ts` | **D4** skip `invalidateHistoryCache()` on boot settle (`:44`) |
| `web/src/config/history.ts` | refusal reason constants + log event names (no hardcoded strings) |
| `docs/decisions.md` | record D1–D4, 5A id-space finding, 5B deletion boundary; **correct the unsound A3 step 3** |
| `docs/2026-10-10-history-window-and-test-relocation-handoff.md` | annotate A3 step 3 (§11) |
| `tests/**` | regression set (§10) — test agent owns |

**Explicitly out of P2 scope** (recorded so an implementer does not "helpfully" add cleanup to dead code): `web/src/adapters/remoteThreadListAdapter.tsx` — see §6.1.

**Out of scope:** `withKey`; stale-controller fallback; runtime remount; `reloadMainThread()`; module-level decoder registry; TanStack Virtual; right-hand workspace; approval gates; tests J/K; the reverted `ensureWindowController` publish and `ensureRemoteId` experiments; general cache refactor.

---

## 10. Regression plan

**No existing healthy-path assertion is weakened.** The healthy-paging requirement stands unchanged.

| # | Scenario | Layer | Negative control |
|---|---|---|---|
| 1 | Normal load publishes (live controller) | unit | — |
| 2 | Empty conversation, no publish | unit | — |
| 3 | Invalidate **before** controller creation | unit | — |
| 4 | **Invalidate during in-flight load → no publication** | integration | **fails on current code** (currently publishes) |
| 5 | Stale load failure after invalidation | integration | — |
| 6 | **Recovery liveness: active conversation regains a controller with committed rows and a known tip, and paging works** | integration | **fails without D2** — asserts populated state, not mere existence |
| 7 | Recovery while an unrelated conversation is active | DOM | — |
| 8 | **Deletion via the real path (`deleteConversation.ts`) with a pending history load that completes afterwards → no controller and no UI state is recreated** | integration | **fails on current code** (currently retains and can resurrect). Anchored to `deleteConversation.ts` so it exercises the live path, **not** the dead `remoteThreadListAdapter.delete()` |
| 9 | Thread switch with pending repopulation | integration | — |
| 10 | Overlapping page requests, stale page completion | integration | — |
| 11 | New controller after invalidation **is** publishable | unit | — |
| 12 | Boot settle: no invalidation, no repopulation | unit | — |
| 13 | `degraded/offline → online`: invalidation occurs | unit | — |
| 14 | Deferred recovery repopulates on run settle | integration | — |
| 15 | No dead control renders | DOM | — |
| 16 | Stable IDs / branch authority | unit | — |
| 17 | Bounded recovery + explicit retry unchanged | unit | — |
| 18 | **Healthy paging: button appears and paging issues a request** | E2E | **existing — not relaxed** |
| 19 | Prepend stability, live tail, composer draft preserved across recovery | E2E | — |

Cases **4, 6, 8** are load-bearing; each must fail against current code for its stated reason. Every test asserts the **expected final state for its lifecycle** — "hidden-or-logged" is not an acceptable criterion.

Discovery: `scripts/run-e2e.ts:246-253` fails closed on zero specs. Every reported result must carry real discovery counts.

---

## 11. Correction to the existing record

`docs/2026-10-10-history-window-and-test-relocation-handoff.md:100-105` (Part A3) states:

> 2. `lastGoodHistory` and the window controller are **populated and dropped together** …
> 3. **Therefore** … the fetch is skipped and the catch can never run.

**Step 3 does not follow from step 2.** Step 2 is a static claim about the call graph, established by grepping which functions call `dropWindowController`. It does not establish that no asynchronous operation is in flight across a drop — and one always is (`threadHistoryAdapter.ts:301` captures, `:310` awaits, `:320` publishes).

The conclusion was drawn from evidence that could not carry it. **The record is annotated, not deleted** — the deletion of `retainedHistory` remains behaviour-preserving; only the reasoning is unsound.

**Related precedent:** `docs/decisions.md:1666` records for tab-mirror reconciliation that it is **removal-only** and *"Resurrection is therefore impossible by construction."* That principle was never applied to the window controller, which does have a resurrection write path.

---

## 12. Acceptance criteria

1. **D1** — publication from a non-registered controller is impossible. Case 4 passes; current code fails it.
2. **D2** — after genuine recovery the **active** conversation has a **server-populated** window: committed rows and a known tip. Case 6 passes.
3. **D3** — every silent guard emits a structured refusal naming its condition.
4. **D4** — `unknown → online` performs no history invalidation; `degraded|offline → online` does.
5. **5B** — deleted conversations leave no controller or UI-snapshot state, and a late load cannot resurrect them. Case 8 passes, **exercising `deleteConversation.ts`**.
6. **5B documentation** — the `docs/decisions.md` entry records that `RemoteThreadListAdapter.delete()` is unreachable dead code, that `deleteConversation.ts` is the live deletion path, and that **any future adoption of `aui.threadListItem.delete()` must add equivalent cleanup and prove it with case 8 first**.
7. Unchanged and proven by existing suites: SQLite authority, single writer, paging integrity, branch authority, recovery budget, scroll and live-tail behaviour.
8. `bun run typecheck` (root, backend, web) and `bun run build` exit 0.
9. `bun run test`, `bun run test:dom`, `bun run test:locations` green with **actual** discovery counts.
10. Composer drafts and in-flight runs survive availability recovery.

---

## 13. Open decisions

| # | Question | Recommendation |
|---|---|---|
| 1 | ~~`remoteThreadListAdapter.delete()` — cleanup or dead code?~~ | **RESOLVED 2026-10-10 — genuinely unreachable (§6.1).** Documented as dead in `docs/decisions.md`; cleanup kept out of it; **P2 touches `deleteConversation.ts` only.** Guard test **rejected by decision** — it would forbid a correct future migration (§6.1). |
| 2 | Confirm `toThreadMessages` preserves `message.id` (would allow a future tip-agreement check) | Deferred — check dropped, no need to answer now |
| 3 | Pre-existing: a drop can release another owner's Retry latch (`:193`) | Out of scope; record only |
| 4 | Pre-existing: deleted conversations retain controller/UI state beyond 5B's new cleanup | Fixed by 5B; confirm no residual path |
| 5 | ~~Can production actually reach the stale-publish interleaving?~~ | **RESOLVED 2026-10-11 — reachability DEMONSTRATED (§15.6).** A browser-level test forces availability recovery during an in-flight window load and observes a visible "Load earlier" that issues **zero** requests. Defect **S** is real, not theoretical |
| 6 | ~~The Direct history fetch has no timeout and no abort.~~ | **RESOLVED 2026-10-11 — FIXED AND VERIFIED (§15.7).** `fetchWindowSliceBounded` bounds the window request at `HISTORY_WINDOW_FETCH_TIMEOUT_MS` (15 000) with a scoped `AbortSignal`; timeout is raised as `HistoryWindowTimeoutError`, logged as `history.load_timeout` separately from `history.load_failed`, and Retry recovers. Mechanism note retained below, because the earlier "holds the lock" wording was wrong: a hung fetch blocks recovery because the load never **settles**, so `loadFailed` is never set and `thread.isLoading` never clears — the reload latch is never claimed by the initial load |

---

## 14. Evidence index

| Claim | Location |
|---|---|
| Controller captured locally, awaited, then published | `threadHistoryAdapter.ts:299`, `:310`, `:320` |
| Recovery invalidation | `recovery.ts:44` → `threadHistoryAdapter.ts:99` |
| Pair deletion | `useDirectHistoryWindow.ts:194`, `:196`, `:204-208` |
| Publish never validates liveness | `useDirectHistoryWindow.ts:449-476` |
| Boot recovery trigger | `availabilityStore.ts:142`, `:162` |
| Context-free recovery listeners | `availabilityStore.ts:66-88` |
| Silent guards | `useDirectHistoryWindow.ts:568-571`; log at `:589` |
| Reload latch release paths | `useDirectHistoryWindow.ts:193`, `:313`, `:327`, `:406` |
| Adapter `load()` does not claim the latch | `threadHistoryAdapter.ts:309-311` |
| Adapter identity is module-scope | `web/src/app/adapter.ts:8` |
| Dual provider export (docs' canonical shape) | `remoteThreadListAdapter.tsx:169-171` |
| Deletion path bypasses both adapters | `deleteConversation.ts:96`; `remoteThreadListAdapter.tsx:321` |
| `threadListItem.delete()` has zero callers in `web/src` | 30 `threadListItem.*` usages: `getState`/`initialize`/`updateCustom`/state reads only |
| Adapter `delete` is a store-entry action, not internal behaviour | `RemoteThreadList.js:229` → `ThreadListItemClient({ onDelete })` |
| `refetchThread` not declared by ai-sdk | absent from `@assistant-ui/ai-sdk@0.0.12/dist` |
| No cancellation in history load | no `AbortSignal`/`abort`/`signal` in `useExternalHistory.js` |
| id round-trip identity | `assistant-cloud@0.2.1/dist/ai-sdk/index.js` |
| removal-only precedent | `docs/decisions.md:1666` |
| unsound step | handoff `:100-105` |

---

## 15. Evidence gate — 2026-10-10

Verification pass over the working tree. **No production code, dependency, or plan
outside this file was changed.** Two blockers previously reported as current are
refuted; the actual unresolved question is narrower than "three defects".

### 15.1 Verified by execution

| Claim | Method | Result |
|---|---|---|
| Stale publication after invalidation is unguarded and resurrects a dropped snapshot | `tests/dom/history/direct-history-stale-publication.test.ts` | **3 pass / 0 fail** |
| Recovery invariants | `tests/e2e/history/p2-history-load-recovery.spec.ts` | **9 pass / 0 fail** (46.9 s) |
| DOM history layer | `tests/dom/history/` | **41 pass / 0 fail** |
| Window controller unit | `tests/unit/web/history/` | **46 pass / 0 fail** |
| Storage slice boundary | `tests/integration/history/direct-history-window-slice.test.ts` | **20 pass / 0 fail** |

The stale-publication tests establish three things, and deliberately not a fourth:

1. `publishWindowUi` accepts a controller that was **never registered**.
2. A snapshot deleted by `dropWindowController` / `clearAllWindowControllers`
   **comes back** carrying the dropped controller's paging state when the
   in-flight load settles.
3. The stale window is **bounded** — the next publish replaces it.
4. **Not established:** that a browser reaches this ordering. The test injects a
   locally-built `WindowController` because `ensureWindowController` binds the real
   HTTP fetcher and cannot be given a deferred one. This is the gap in §13 #5.

### 15.2 Refuted — remove these from any status report

- **"An empty conversation returns `contiguous: false`."** False on disk.
  `src/services/storage/index.ts:668` returns `contiguous: true` for a
  message-less conversation, and boundary tests already cover it in **four**
  places — including the negative control that a **stale anchor** stays
  `contiguous: false`. The `:622` citation pointed at a **doc comment**, and at a
  state that exists nowhere in the tree.
- **"Recovery satisfies 1 of 5 invariants."** No five-invariant set exists in the
  repository. The authoritative set is **K-I1…K-I8** in
  `tests/e2e/history/p2-history-load-recovery.spec.ts` (9 cases), and **all 9 pass**.
  The 1/5 figure has no basis in code or executed output.
- **`getWindowSlice` did not exist at `HEAD`.** `git show HEAD:src/services/storage/index.ts`
  contains **0** occurrences of `getWindowSlice` and of `contiguous`; the file grew
  605 → 967 lines. The window API is **new uncommitted work, not a repair**, so
  there is no "HEAD behaviour" to compare against.

### 15.3 Scope of the storage diff — unrelated work is mixed in

`src/services/storage/index.ts` is **429 insertions / 3 deletions**. The 3
deletions are all in `upsert` **message ownership**, unrelated to the history
window and separately tested (`tests/integration/history/message-ownership.test.ts`):
a widened `SELECT conversation_id, order_seq, parent_id`, a new
`MessageOwnershipError` for cross-conversation ids, parent preservation, and
`ON CONFLICT … WHERE messages.conversation_id = excluded.conversation_id`.

There is no clean boundary to commit separately. Nothing was committed or reverted.
The whole feature — `web/src/features/chat/history/`, this document,
`VirtualizedTranscript.tsx`, `config/virtualization.ts` — is **untracked**.

### 15.4 Gate status (superseded by §15.7)

**NOT MET** as of the 2026-10-10 pass. Met: boundary evidence (15.1), refutation of both stale blockers (15.2), diff scope (15.3). Outstanding then: §13 #5 (production reachability) and §13 #6 (no fetch timeout). **Both were subsequently closed** — see §15.6 and §15.7.

### 15.5 The timeout gap — corrected mechanism, and how the three states differ

**An earlier statement in this document was too strong and is withdrawn.** It said a
hung fetch "holds the per-conversation lock". **It does not.**

`historyReloadsInFlight` (`useDirectHistoryWindow.ts:394`) is claimed by exactly one
caller: `beginHistoryReload` at **`DirectViewportBridge.tsx:187`**, which is the
**explicit user Retry**. The initial `load()` path never claims it. The latch is not
what a hung fetch holds.

**What actually blocks recovery and Retry** is that the load never *settles*:

| Step | Location | Effect of a hung fetch |
|---|---|---|
| fetch never resolves | `useDirectHistoryWindow.ts:119` → `platform.ts:80` | — |
| success branch never runs | `threadHistoryAdapter.ts:319` `clearHistoryLoadFailed` | `loadFailed` never cleared |
| catch branch never runs | `threadHistoryAdapter.ts:328` `markHistoryLoadFailed` | **`loadFailed` never set** |
| automatic recovery | `DirectViewportBridge.tsx:114` `if (!loadFailed)` | returns early — **never fires** |
| Retry handler | `DirectViewportBridge.tsx:186` `isHistoryLoading` | `thread.isLoading` stays true — **cannot fire** |

So recovery and Retry *are* blocked, but by **an absent failure signal and an
uncleared in-flight signal**, not by a held lock. The remedy is the same one the
missing timeout implies: make the load settle.

**The three states, kept distinct:**

- **Reproduced.** The stale-publish sequence, with an injected controller (§15.1).
  Unguarded publish, snapshot resurrection, bounded lifetime.
- **Reachability — now DEMONSTRATED in production (§15.6).** Superseded 2026-10-11.
- **Known gap.** No timeout and no abort on the window fetch (§13 #6). Confirmed by
  source; its user-visible consequence follows from the table above and is
  independent of the stale-publication question.

### 15.6 Reachability demonstrated — defect S is real

`tests/e2e/history/p2-stale-publication-reachability.spec.ts` — **2 pass / 0 fail**
(13.2 s). It forces the ordering through the real lifecycle; nothing is injected.

| Step | Mechanism exercised |
|---|---|
| Hold the window response | the thread's `load()` is in flight against the real adapter |
| `/readyz` → 503, then pass through | `availabilityStore.ts:162` fires recovery on `degraded → online` |
| Recovery runs | `recovery.ts:44` → `clearAllWindowControllers()` |
| Release the held response | the ORIGINAL load completes and publishes from the dropped controller |
| Observe | "Load earlier" is **visible**; clicking it issues **zero** window requests |

```
[reach] readyzHits=2 held=1 controlVisible=true
[reach] clicked Load earlier; window requests issued = 0
```

**Why the click is a silent no-op:** `DirectViewportBridge.tsx:206` renders the
control purely from `hasEarlier`, which the stale publish supplied, while
`onLoadEarlier` (`:134`) returns immediately because `controller` is null after the
drop. Visible control, no request — defect **S** in the §0 summary table.

**The control test is what makes this evidence.** Without it, "zero requests" could
mean the button never worked. `controlVisible` is proven reachable on an
uninvalidated thread: the first test clicks "Load earlier" on a healthy load and
polls for a strictly greater request count.

**What this does not establish:** how often the ordering occurs naturally. The test
forces it deliberately. A boot-time race between the availability poll and a thread
load is still unmeasured — but it no longer needs to be, because the consequence is
now demonstrated and the trigger is unconditional.

### 15.7 S and L — fixed, and approved at source-review level (not committed)

**Approved 2026-10-11** after four review rounds. Each round was a source review that
found a real gap the previous round missed: superseded side effects beyond the
snapshot; navigation writing live state; the deadline not bounding a pre-`fetch`
hang; and an orphaned failure path publishing for an unregistered controller. The
source-level blocker is closed. **No test command was independently re-run by the
reviewer**, so the counts below remain agent-reported.

Accepted 2026-10-11. **Nothing here is committed.** Defect **X is untouched and stays
out of this scope.**

**Defect S.** `publishWindowUiFor(conversationId, controller)` replaces the
unconditional publish on every call site that holds a controller across an await
(`useDirectHistoryWindow.ts` ×4, `threadHistoryAdapter.ts` ×2). The behaviour must
stay explicit, and this is the accepted trade-off:

- a **superseded** controller (a different one is registered) is **rejected** — a
  late completion never clobbers newer state;
- an **orphan** (recovery dropped it, no replacement exists) is **re-adopted**, so
  the transcript is not left populated but permanently unpageable;
- `publishWindowUi` itself is unchanged, so the K-I6 contract is untouched.

Re-adoption deliberately lets a window fetched just before an invalidation survive
it. That is the accepted bounded fix, not an oversight.

**Defect L.** `fetchWindowSliceBounded` bounds one window request at
`HISTORY_WINDOW_FETCH_TIMEOUT_MS` (15 000, `web/src/config/history.ts`) with a
per-request `AbortSignal` threaded `fetchWindow → readWindowSlice → apiFetch`. The
timer is cleared in `finally` on every settlement path; a timeout raises
`HistoryWindowTimeoutError`, logged as `history.load_timeout` with `timeoutMs`,
distinct from `history.load_failed`. **No change to `platform.ts`** — `apiFetch`
already forwarded `init`.

| Suite | Result |
|---|---|
| `tests/dom/history/` | **51 pass / 0 fail** (41 pre-existing, 5 deadline, 2 superseded, 1 orphan-failure, 2 navigation) |
| `tests/unit/web/history/` | **46 pass / 0 fail** |
| `tests/unit/web/adapters/` | **49 pass / 0 fail** |
| `tests/integration/history/direct-history-window-slice.test.ts` | **20 pass / 0 fail** |
| `tests/e2e/history/p2-history-load-recovery.spec.ts` | **9 passed** (45.8 s) |
| `tests/e2e/history/p2-stale-publication-reachability.spec.ts` | **3 passed** (43.5 s) |
| `bun run typecheck` | 0 errors in all touched files |
| `bun run build` | exit 0 |
| `bun run test:locations` | OK |

**Recorded deviation — tests were written AFTER implementation.** The brief
required test-first. The timeout tests and the browser-level Retry test were
authored against the implemented behaviour, so their meaningfulness rests on
construction (without the deadline `loadTip()` never settles and the assertions
would hang; the cross-conversation test asserts the healthy request's signal is
never aborted) rather than on an observed pre-fix failure. Reverting production code
to recreate the original failure was deliberately not done.

**Regression coverage added or updated:** `direct-history-stale-publication.test.ts`
rewritten for the guard's three branches; `history-window-timeout.test.ts` added
(never-resolves, cleanup on success, cleanup on error, cross-conversation
isolation); the reachability spec now asserts the **corrected** behaviour — the
paging control must exist *and* issue a request — so a naive "hide the button"
fix cannot pass. The healthy-load control is preserved.

**Remaining gate:** review of the actual combined diff before any commit.

### 15.7b Review round 3 — orphaned failure path, and navigation coverage

**The orphaned failure path published for a controller that did not exist.** The
failure branch classified only `superseded` as stale, so an **orphaned** controller
— dropped, with nothing put back — reached the normal branch, which published
through the **raw** publish. That put a snapshot on screen for a controller that
was not registered: the ownership inconsistency the supersession guard exists to
prevent, on the failure path. The branch now uses the guarded publish, which
**re-adopts** the orphan, so the failure state and the controller that owns it stay
consistent and Retry still resolves one.

**Navigation coverage.** The `applyWindow` guard was correct in the source but had
no test. The live-state install is now an exported function, `applyWindowToChat`,
called by both `goHistorical` and `restoreTip`, so the guard is exercised as the
production function rather than a re-implementation of it.

**A test description corrected.** The deadline test was labelled as simulating the
`apiFetch` Tauri preflight. It does not: it stubs `fetch` and exercises a
never-settling request at the fetch stage. The preflight — `ensureApiBaseUrl()`
awaited before `fetch`, and not wired to the signal — is covered by the **same**
mechanism (the deadline rejects a race rather than waiting for the request) but is
**not simulated**, and the test now says so. It is not evidence for that path.

### 15.7a Review round 2 — two correctness gaps closed

Both were found by source review of the previous patch, not by a failing test.

**Navigation could still mutate live state.** `goHistorical` and `restoreTip` each
`await` the controller and then call `applyWindow`, which writes the live chat
state. The publish guard could not undo that. The currency check now lives inside
`applyWindow` — the single point where a navigation result becomes live state — so
both operations, and any future caller, are covered by one check.

**The deadline did not bound every request.** `fetchWindowSliceBounded` only
rejected as a timeout if the request itself rejected. But `apiFetch` can be parked
in its Tauri preflight (`ensureApiBaseUrl()`) **before** `fetch` is ever called, and
that preflight is not wired to the abort signal, so such a request can neither be
aborted nor reject — the load stayed pending past the deadline, which is the exact
liveness failure the bound exists to remove. The deadline now **rejects a race**
rather than waiting for the request to notice the abort, so the load settles at the
deadline wherever the request is parked; the abort is still issued so an in-flight
request is genuinely cancelled. `platform.ts` is unchanged.

Also in this round: `loadEarlier`'s error path now checks currency **before**
logging, so a superseded request's failure is no longer attributed to a healthy
replacement; and the superseded regression now seeds **C2 with distinguishable
rows**, so "returned the owning window" is distinguishable from "returned []".

### 15.8 Still open — NOT closed by §15.7

**Defect X (deletion cleanup) is untouched and remains a real residual risk.**

The accepted orphan policy re-adopts a dropped controller whenever no replacement
is registered. `dropWindowController` is reached from BOTH coordinated recovery
**and** conversation deletion, and the standing check does not distinguish them. A
late operation on a **deleted** conversation can therefore re-adopt its window and
re-publish UI state for a conversation the user has removed.

This is a consequence of the accepted bounded fix, not an oversight, and it is
**not** evidence that the history lifecycle is safe. Closing it requires the drop to
carry a reason (recovery vs deletion), which is scope beyond the S/L boundary and is
left for the X work.

**Paging observability — a narrower answer than "every window request".** The
timeout applies to every window request, so the deadline is uniform. Logging is
not: `loadEarlier` distinguishes it (`history.page_load_timeout`), but
`goHistorical` and `restoreTip` have **no failure log site at all** — their
failures are swallowed by the bridge's silent catches. Adding observability there
is a behaviour change beyond "distinguish timeout from transport error", so it is
reported rather than silently done. It is the same class of silent failure as plan
defect **D3**, and should be closed with it.