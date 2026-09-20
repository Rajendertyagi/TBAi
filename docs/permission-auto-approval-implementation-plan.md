# Permission auto-approval — implementation plan

Status: **audit complete, plan chosen, Phase 2 implemented (2026-09-19).**
Written 2026-09-19 after reading the real repository (not the earlier proposals).

---

## 1. Current architecture (verified by inspection)

| Concern | Where it actually lives |
|---|---|
| **Authoritative value** | `conversation.opencodeAutoApprove` — SQLite, read/written through `/api/conversations` |
| Draft value | `useWelcomeEngineStore.autoApprove` (`features/chat/state/welcomeEngine.ts`), localStorage-backed |
| Materialization | `remoteThreadListAdapter.initialize()` → POST body (`:198/:215/:231`) |
| Read path | `useOpenCodeConversationConfig(conversationId)` — **fetches once per id** |
| Live getter | `OpenCodeView.tsx:226-240` — `useRef` + `useCallback` → `useOpenCodeRuntime` → `runtimeClient` → `initialHydration` |
| Auto helper | `permissionCompat.ts` — `autoAcceptPendingPermissions(client, pending, mode, answered)` |
| Reply boundary | `permissionCompat.ts` `replyCompat` — directory scope, canonical-then-fallback, 404→stale |
| Live event path | `permissionPayloadCompat.ts` `normalizeFrames` (`:213`) — an async generator |
| Dedupe | a `Set` **inside `applyInitialHydration`'s closure** — not shared |
| Runtime ownership | **client-owned.** `createOpenCodeRuntimeClient` is built in a React memo in `useOpenCodeRuntime` |

### The three real defects

1. **Live permissions are not covered.** `permissionPayloadCompat.ts` has **zero**
   references to auto-approve (grep-verified). Auto fires only on hydration /
   reconnect, so a NEW `permission.asked` while connected falls to the manual UI.
   *This is the headline gap: the shield would half-work.*
2. **The dedupe set is not shared.** Hydration owns it; a live path cannot see it,
   so the same request could be answered twice.
3. **Possible staleness.** `useOpenCodeConversationConfig` fetches once per
   `conversationId`, so a bound-session toggle may not reach the getter until
   remount. **Unverified.**

### What does NOT exist (so must not be invented)

- **No backend permission funnel.** `grep 'permission\.asked|permission\.replied|
  permission\.updated'` over `src/` returns **nothing**. All permission handling is
  client-side.
- **No server-side permission responder** of any kind.
- Lineage: `session.parentID?: string` **is** exposed by `@opencode-ai/sdk@1.18.31`
  (`types.gen.d.ts:71`), but TBAi does not surface it anywhere yet.

## 2. Chosen architecture

**Keep the client-owned runtime. Do not build a backend subsystem.**

The preference order in the brief says to prefer a server-owned funnel *if one
exists*. It does not — verified. Creating one would mean a new event pipeline, a
new transport and a new lifecycle alongside the working client one, which the
brief itself forbids ("do not create a new backend subsystem if an existing TBAi
permission/event service can own this cleanly"). The existing service **is** the
client compatibility layer.

So the architecture becomes:

```
shield toggle
  → conversation config (existing persistence, authoritative)
        ↓
  per-conversation policy store  (new, tiny, module-level, synchronous)
        ↑ hydrated from the config read; written on toggle
        │
  ┌─────┴──────────────────────────────┐
  │                                    │
initialHydration                  normalizeFrames (live)
  pending permissions               permission.asked
  → policy? → reply "once"          → policy? → reply "once"
  └────────────── shared per-session `answered` set ───────┘
                     ↓
            patched replyCompat → OpenCode
```

### Why this is safer than the current client-getter approach

1. **One policy read, synchronous, at event time.** A module-level store keyed by
   conversation id cannot be stale between render and event, and does not depend
   on React having re-rendered. The brief's core lesson — *the decision must use
   current authoritative state at event time* — is satisfied structurally rather
   than by hoping a ref was refreshed.
2. **One responder.** Both paths call the **same** helper, which calls the
   **same** patched reply boundary. No second transport, no second cache.
3. **The dedupe set becomes shared** rather than duplicated — the race the brief
   calls out is eliminated by ownership, not by synchronisation.
4. **No new subsystem.** The store is ~30 lines; the funnel already exists.

### Rejected alternatives

- **Backend responder** — would duplicate a working client path and add a second
  authority. Rejected per §15.
- **React context / Zustand** — the decision must be readable outside React (the
  event generator is not a component). A module store is the right shape; a
  component-scoped source is what makes the current approach fragile.
- **Reactive hook into the getter** — cannot reach the event generator, which runs
  outside the React tree.

## 3. Files expected to change

| File | Change |
|---|---|
| `features/permissions/sessionAutoPolicy.ts` | **new** — the per-conversation policy store: `set(id, bool)`, `get(id)`, hydrate from config. The single source for the decision. |
| `runtimeClient.ts` | create the `answered` set here (single per-session owner); pass it to both patches |
| `initialHydration.ts` | take `answered` as a parameter; delete the local `Set`; read policy from the store |
| `permissionPayloadCompat.ts` | hook `normalizeFrames` for `permission.asked`; **reply before yield**; always yield |
| `OpenCodeView.tsx` | replace the ref/getter with the store (hydrate it from the config read) |
| `useOpenCodeRuntime.ts` | drop the getter parameter (the store removes the need) |

## 4. Code that becomes obsolete

- The `getAutoApprove` getter chain (`OpenCodeView` ref → `useOpenCodeRuntime` →
  `runtimeClient` → `initialHydration`) — replaced by the store read.
- The local `answered` set inside `applyInitialHydration`.
- Any 6C/6D comments describing the getter as the live mechanism.

**Not obsolete, keep:** `autoAcceptPendingPermissions` (the single responder),
`replyCompat`, `permissionCompat`, the materialization chain (6D-D), the
`opencodeAutoApprove` field, and the Phase-5 `ApprovalGate`/`approvalOptionMapping`
substrate.

## 5. Behavioural notes settled by inspection

- **Auto-reply failure cannot suppress the event.** `autoAcceptPendingPermissions`
  wraps **each request** in its own `try/catch` and returns a count — **it never
  throws**. So `await`-then-`yield` already satisfies requirement 9 with no extra
  code. *(Verified in the source; do not add error handling.)*
- **Ordering: reply-before-yield** in both paths, per the user's decision.
- **`applyPermissionPayloadCompat` is applied last**, so `replyCompat` is already
  patched when it runs — the auto reply inherits directory scope, the
  canonical/fallback route and stale normalisation for free.

## 6. Gates to run

`bun run typecheck` · `bun run build` · then the focused suites:
`permissionAutoAccept` · `initialHydration` · `permissionCompat` · `liveStream` ·
`reconnect` · `stalePermissionsStore` · `approvalParity` · `tool-fallback` ·
`toolLinkedQuestion` · `welcomeEngine` · `remoteThreadListAdapter`.

Behavioural checks (per §12): manual stays manual · auto replies `"once"` · enabling
Auto reconciles pending · a failed reply still yields · toggle effective without
reload · ON→OFF returns to manual · reload persists · session isolation · questions
unaffected · no double reply.

## 7. Assumptions that must be verified before relying on them

1. **Bound-session freshness (defect 3).** Does `updateCustom({opencodeAutoApprove})`
   reach the getter without a remount? **Unverified.** The policy store fixes it by
   construction, but confirm the write path actually persists the field.
2. **Whether `permission.asked` frames reach `normalizeFrames` for V1-shaped events**
   (not only the V2 names it remaps). It sees every frame, so this should hold — verify.
3. **Lineage (§9 of the brief).** `parentID` exists in the SDK but TBAi does not
   surface it. Implementing inheritance requires exposing it first — **do not guess
   a tree**. Recommend deferring until the store exists and the parent link is
   actually readable.
4. **Request identity for the live path** is `properties.id` on the normalized
   frame — not `toolCallId`, not `messageID`.

## 7b. VERIFIED FINDINGS (2026-09-19, Phase 2)

### ✅ Assumption 1 — the live auto-reply DOES reach `replyCompat`. **Proven.**

Mechanically, not by file order:

1. `applyPermissionCompat` (`runtimeClient.ts:52`) runs **first** and **mutates the
   client in place**: `permission.reply = replyCompat` (`permissionCompat.ts:209`).
2. `applyPermissionPayloadCompat` (`:61`) runs **last**, but it only wraps the
   **stream** (`event.subscribe`). It never touches `client.permission`.
3. Therefore, at event time, `client.permission.reply` **is** `replyCompat` — and
   `autoAcceptPendingPermissions` reads that property **at call time**, so it
   receives the patched implementation, inheriting directory scoping, the
   canonical route, the narrow fallback and the 404→stale normalisation.

**One caveat worth knowing:** `applyPermissionCompat` **returns early when there
is no session id** (`if (!sessionId) return;`). Without a session, `reply` stays
the raw SDK method — unscoped. The auto path must therefore only ever run for a
session that has one, which is already true of hydration.

### ❌ Assumption 2 — `conversationId` is **NOT available** at the live boundary.

`normalizeFrames(stream)` and `applyPermissionPayloadCompat(client)` receive **no
conversation id**, and the client carries only the **OpenCode `sessionId`** and
`directory`. There is no conversation id in that scope.

**Per the brief, that part STOPS rather than inventing a mapping.**

**The safe resolution — key the cache by the identity the runtime actually has:**

| Option | Verdict |
|---|---|
| Invent a conversation-id lookup inside the event generator | ❌ forbidden, and fragile |
| Reuse the React getter | ❌ that is the thing being replaced |
| **Key `sessionAutoPolicy` by OpenCode `sessionId`** | ✅ the runtime scope genuinely has it, and it is already the identity the permission routes are scoped by |

So the cache should be **session-keyed, not conversation-keyed**, and
`hydrateAutoPolicy` must be called with the **sessionId** — which means the
hydrate call needs the session id, available where the runtime is built
(`OpenCodeView` has `sessionId` *and* the config read). **This is a change to
Phase 2-A's read half, not a workaround.**

## 8. Next atomic step

Create `sessionAutoPolicy.ts` and switch the **read** to it (hydrate from
`useOpenCodeConversationConfig`, write on toggle), leaving both call sites
unchanged in behaviour — then verify with typecheck + build. That is a safe,
self-contained increment that makes the later two edits mechanical.

## 9. Phase 2 implementation record (2026-09-19)

### New architectural finding — the write path had NO backend persistence

Tracing the mutation path for `conversation.opencodeAutoApprove` (STEP 2)
revealed the field was **frontend-only**: the DB schema, `Conversation` type,
storage service and both Zod schemas had no `opencode_auto_approve`, so the
POST/PATCH bodies the frontend sent were silently stripped by Zod. The write
path is now real end-to-end:

- `src/db/index.ts` — `opencode_auto_approve INTEGER NOT NULL DEFAULT 0`
  (idempotent `addColumnIfNotExists`, same pattern as `opencode_agent`).
- `src/types/index.ts` — `Conversation.opencodeAutoApprove?: boolean`.
- `src/services/storage/index.ts` — row type, `mapConversation`
  (`=== 1`), create INSERT, update branch.
- `src/lib/validation.ts` — `z.boolean().optional()` on create + update.
- `src/routes/conversations.ts` — create pass-through (`?? false`); PATCH
  already spreads `...parsed`.

### What was wired (all session-keyed, per the chosen architecture)

| Concern | Where |
|---|---|
| Policy hydration | `OpenCodeView.tsx` `AgentRuntime` — `useEffect` on `[sessionId, conversationConfig]` calls `hydrateAutoPolicy(sessionId, config.opencodeAutoApprove)`; when Auto is on it also calls `reconcileAutoApprove()` so a request pending before the config arrived is accepted |
| Write path | `autoApproveWrite.ts` `persistAutoApprove(conversationId, sessionId, enabled, reconcile?)` — PATCH → `setAutoPolicy` → (on enable) reconcile. One operation; cache updated only after a successful PATCH |
| Shared answered Set | `createOpenCodeRuntimeClient` (`runtimeClient.ts`) — one `Set` per runtime, passed to `applyInitialHydration`, `applyPermissionPayloadCompat` and the reconcile closure. `autoAcceptPendingPermissions` now records **successful** replies into it (a failed reply stays retryable) |
| Live `permission.asked` | `permissionPayloadCompat.ts` `normalizeFrames` — `getAutoPolicy(sessionId)` → `autoAcceptPendingPermissions(client, [{id}], "auto", answered)` **before** `yield`; always yields |
| Hydration/reconnect | `initialHydration.ts` — after `readPending`, `getAutoPolicy(scope.sessionId)` → auto-answer pending permissions before replaying them |
| OFF→ON reconciliation | `permissionCompat.ts` `reconcileAutoApprove(client, sessionId, answered)` — list via existing scoped API → `autoAcceptPendingPermissions` → `replyCompat`. Exposed as `client.reconcileAutoApprove` and returned by `useOpenCodeRuntime` |
| Missing session id | fail closed by construction: `getAutoPolicy(undefined)` → false, so the live path never auto-replies and `applyPermissionCompat` never patches `reply` |
| Obsolete getter chain | removed: `OpenCodeView` ref/getter, `useOpenCodeRuntime` `getAutoApprove` param, the `runtimeClient` option spread |

### Lineage (STEP 10)

Still deferred. `session.parentID` exists in `@opencode-ai/sdk@1.18.31` but TBAi
does not surface it anywhere; no reliable parent-session relationship is
available, so no inheritance was invented. Documented, not faked.

### Gates (Phase 2)

- `bun run typecheck` exit 0 (backend + web).
- `bun run build` exit 0.
- Focused suites: opencode dir + adapter + welcomeEngine + stalePermissions +
  tools/opencode **233 pass / 0 fail**; backend conversation suites
  **18 pass / 0 fail**; new `sessionAutoPolicy` + `autoApproveLive`
  **25 pass / 0 fail**.
- Full suite: handed to the test agent (not run by the coding agent).

## 10. Phase 3 — Shield UI implementation record (2026-09-19)

### What was built

The user-facing Auto Approval Shield toggle, rendered in the OpenCode composer
chip row (bound Code surface and the OpenCode welcome draft).

| Concern | Where |
|---|---|
| Runtime context | `opencodeRuntimeContext.ts` — `OpenCodeRuntimeContext` provides `{ sessionId, reconcileAutoApprove }` from `AgentRuntime`; the composer (deep inside the runtime provider) reads it without threading props through `ChatWindow` |
| Shield chip | `OpenCodeShieldChip.tsx` — `OpenCodeShieldButton` (presentational, statically renderable) + `OpenCodeShieldChip` (hooks) + `runShieldToggle` (pure toggle logic) |
| Copy | `welcomeConfig.copy` — `shieldOffLabel`/`shieldOnLabel`/`shieldOffTitle`/`shieldOnTitle`/`shieldAria` |
| Wiring | `OpenCodeView.tsx` `AgentRuntime` wraps the runtime in `OpenCodeRuntimeContext.Provider`; `Composer.tsx` mounts `<OpenCodeShieldChip />` in the OpenCode chip row |

### Design decisions

- **UI state source of truth** is `conversation.opencodeAutoApprove` (bound) or
  the welcome-engine draft store (draft). The chip never reads
  `sessionAutoPolicy` (the runtime cache) and never calls
  `permission.reply`/`list`/`autoAcceptPendingPermissions`.
- **Write path** is the single existing `persistAutoApprove(conversationId,
  sessionId, enabled, reconcileAutoApprove)` — no second PATCH helper, no direct
  DB write, no direct cache update from the UI.
- **Local mirror**: the chip keeps a `useState` mirror initialized from the
  authoritative config and updated only after a successful write, so the button
  reflects the new state immediately without a config refetch. A failed write
  leaves the mirror (and the UI) on the old state — never a false ON.
- **Draft**: no session exists, so the chip uses `setAutoApprove` on the
  welcome-engine store (the existing draft mechanism), which materializes into
  `conversation.opencodeAutoApprove` at conversation creation.
- **No session**: bound conversations need the config loaded AND a real
  sessionId before the toggle is enabled; the draft needs neither. Without a
  session id `runShieldToggle` throws rather than inventing one.
- **Accessibility**: a real `<button>` with `aria-pressed`, `aria-label` and a
  `title` tooltip; keyboard accessible; disabled state while busy/unavailable.

### `createConversation` gap (inspected, not a Shield blocker)

`remoteThreadListAdapter.createConversation` declares `opencodeAutoApprove` in
its input type but does not send it in the POST body. It is only used by the
"New Project Chat" dialog, which has no Shield toggle; a conversation created
there defaults to manual (correct). The Shield's draft path materializes through
`initialize()`, which does send the field. Not a functional gap for the Shield —
left untouched per "no unrelated cleanup".

### Gates (Phase 3)

- `bun run typecheck` exit 0 (backend + web).
- `bun run build` exit 0.
- New `openCodeShield.test.ts` **16 pass / 0 fail** (static render, toggle
  logic, source guards).
- Focused suites: opencode dir + adapter + welcomeEngine + stalePermissions +
  tools/opencode **249 pass / 0 fail**.
- Browser verification: see the Phase 3 report (draft + bound toggle,
  persistence, reconcile, session isolation observed; permission-triggering
  blocked by an OpenCode server model error, not a Shield defect).
