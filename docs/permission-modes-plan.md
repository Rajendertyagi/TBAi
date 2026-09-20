# Permission Modes — Manual / Auto (plan)

Status: **PHASES 2–3 DONE.** Phases 4–5 gated only by vendoring the two elements
(the §4 decision is made — see §0).

## 0. Decisions (locked by the user, 2026-09-19)

1. **Wrap, don't adopt directly.** The official elements are vendored as
   **presentational views**; their callbacks are passed through the TBAi adapter
   and the **guarded response path stays the single path**. A renderer still never
   calls `respondToApproval` itself.
2. **An ID-mapping adapter is accepted** (§6) — the official `ApprovalCard`'s
   hardcoded ids (`"once"`/`"always"`/`"deny"`) are mapped to the host's real
   option ids in the adapter.
3. **`grants` uses the minimal semantic scope**, and only that:
   > Allow TBAi to automatically approve tool actions while Auto mode is enabled.
4. **`"This session"` is conversation-scoped; `"Always"` persists the
   conversation's Auto setting** through the established configuration path.
5. **No hard-deny rule engine, no per-tool matrix, no extra permission taxonomy.**

---

## 1. Installed contract (verified, not taken from the website)

`ApprovalCard` and `PermissionGrant` are **NOT in the installed packages** — a
glob for `*pproval*` under `@assistant-ui/react@0.15.20` returns nothing. They
are **registry elements** (copy-paste source), like `web-search` and `code-diff`.
Using them means **vendoring two more elements** by hand — no `components.json`
exists, and no dependency changes.

**The types *are* installed** (`@assistant-ui/core@0.3.19`, re-exported by
`@assistant-ui/react`), so the elements compile against the frozen train:

```ts
type ToolApprovalOptionKind = "allow-once" | "allow-always" | "reject-once" | "reject-always";

type ToolApprovalOption = {
  readonly id: string;
  readonly kind: ToolApprovalOptionKind | (string & {});   // open union
  readonly label?: string;
  readonly description?: string;
  readonly grants?: readonly string[];    // host-supplied, NEVER derived by the library
  readonly confirm?: boolean | { title?: string; description?: string };
};

type ToolApprovalDisplay = "decision" | "select" | "text";  // closed set; absent = "decision"

type ToolApprovalResponse =
  | { approved: boolean; text?: string; reason?: string }
  | { optionId: string;  text?: string; reason?: string }
  | { approved: boolean; optionId: string; text?: string; reason?: string }
  | { text: string; reason?: string };

resolveToolApprovalResponse(approval, response) => RespondToToolApprovalOptions
```

The approval object carries `id`, `display?`, `allowFreeform?`, `options?`.
`approval.id` is documented as *"Opaque, host-defined identifier. Scope semantics
(session vs project vs global) belong to the option supplier."* — so §8's "don't
make toolCallID the universal permission identity" is already the library's own
position. **Identity is `approval.id`.**

## 2. What already maps (no work needed)

`web/src/components/shared/approval-options.ts` **already implements the official
vocabulary faithfully** — `isKnownApprovalOptionKind`,
`isAllowApprovalOptionKind`, `approvalOptionLabel`, `approvalOptionApproves`, with
labels `allow-once` → "Allow", `allow-always` → "Always allow", `reject-once` →
"Deny", `reject-always` → "Always deny". It imports `ToolApprovalOption` from
`@assistant-ui/react` directly.

So the option *vocabulary* is shared already; only the *rendering* is TBAi's.

| TBAi behaviour | Maps to |
|---|---|
| `ApprovalGate` + `BackendToolView` undecided branch | official **ApprovalCard** (per-action) |
| `ApprovalActions` (two relabelled buttons) | the element's three kinds, via §2's vocabulary |
| OpenCode permissions (`OpenCodePermissions`, `stalePermissions`, `permission.asked`, `resources`) | official **PermissionGrant** (per-capability) |
| Auto mode's "allow TBAi to operate automatically?" | official **PermissionGrant** — a *new* capability grant |

## 3. What must remain TBAi

- **The stale / double-submit guard** (`stores/stalePermissionsStore.ts`) — the
  task's own "CRITICAL" clause.
- **The single guarded response path** — see §4.
- **OpenCode wire-format translation** — stays in `features/opencode/`.
- **Persistence scope** — session vs always (§7).
- **Supplying `grants`** — the library never derives it, so what "Always"
  persists is TBAi's to declare.

## 4. ⚠️ THE DECISION THAT GATES PHASES 4–5

The official model has the **renderer call `respondToApproval(response)` itself**.
TBAi's parity rule forbids exactly that: the call must flow down to
`BackendToolView` so there is one guarded lifecycle. That rule exists because the
unguarded path caused the `question`-tool crash (`addResult` → *"Runtime does not
support tool results"*).

Two options, and I will not guess between them:

- **(i) Wrap, don't adopt** — vendor the official elements as **presentational
  views**, pass the three callbacks through the TBAi adapter, and let the guarded
  path perform the response. The elements become dumb; TBAi keeps the lifecycle.
  *Cost:* the "remove the custom UI" goal shrinks to "remove the duplicated
  *visuals*", because a thin adapter still exists. **This is my recommendation.**
- **(ii) Adopt directly** — let renderers call `respondToApproval`, relaxing the
  parity guard. *Cost:* re-opens the failure mode the guard was written for, and
  the guard's test would have to be deleted.

## 5. ⚠️ Finding — the installed contract routes questions through the approval seam

`ToolApprovalResponse` has a `{ text: string }` variant, documented verbatim as
*"Answer to a request that asks a question rather than for a decision."*
`ToolApprovalDisplay` includes `"text"`, and `toolApprovalAcceptsText(approval)`
exists.

So the library models **questions as a display mode of the approval seam**, which
**directly conflicts with Phase 9**. Keeping questions separate therefore means
**deliberately using a subset** of the contract — never `display: "text"`, never
`allowFreeform`. Record that as a deliberate divergence, or a future reader will
"fix" it and break the multi-question protocol.

## 6. ⚠️ Finding — the official ApprovalCard hardcodes three optionIds

Its docs' example sends `optionId: "once"`, `"always"`, `"deny"` — which are
**not** the documented kinds (`allow-once` / `allow-always` / `reject-once`) and
are not necessarily the ids any given host declares. TBAi's gates come from
**OpenCode's** permission options, whose ids are OpenCode's.

So the element cannot be dropped in against a live OpenCode gate: either the host
must declare exactly those ids, or an **id-mapping step in the TBAi adapter** is
required. **This is a genuine capability gap and must be documented before any
custom code is written** (per the task's own rule).

## 7. Phased plan

| Phase | Work | Gated by |
|---|---|---|
| **1** | Audit | ✅ **done** (this document) |
| **2** | Lock the model: `manual` \| `auto`; no rule engine | ✅ **done** |
| **3** | `PermissionPolicy` boundary — mode + `autoGrantScope`, decides show-vs-auto-accept, supplies `grants`. No UI, no execution, no OpenCode wire format | ✅ **done** |
| **4** | Vendor the two elements; wire through the adapter | **§4 decision** |
| **5** | Remove duplicated custom **visuals**; keep policy/adapter/guard/persistence | §4 |
| **6** | Composer control `[Model] [Thinking] [Permissions: Manual]`; Auto gated by PermissionGrant | Phase 3 + composer audit |
| **7** | Persistence: session vs always, via the **existing** SQLite config path (no new Zustand store) | needs the conversation-config audit |
| **8** | OpenCode separation; identity is `approval.id`, not toolCallID | — |
| **9** | Questions untouched; record the §5 divergence | — |
| **10** | No new frameworks/stores/protocols | — |
| **11** | Update `architectural-principles.md`, `architecture.md`, `decisions.md`, `AGENTS.md` | after 4–5 |
| **12** | Tests: policy (manual/auto/session/always), approval (once/always/deny/stale), grant, OpenCode mapping, questions unchanged, regression (no duplicate UI, no second response path) | after each phase |
| **13** | `typecheck` + `build` + real browser run (the 15-step list) | last |

## 8. Still to audit before Phases 6–7

- The composer's control architecture (how `[Model] [Thinking]` are built).
- The conversation-config persistence path (where "session" vs "always" belongs).
- Every import of the custom approval components (the Phase-5 removal surface).

## 8b. Phase 2–3 delivered

`web/src/features/permissions/permissionPolicy.ts` — pure, no React, no runtime,
no persistence, no OpenCode. Exports `PermissionMode`, `AutoGrantScope`,
`PermissionPolicyState`, `MANUAL_POLICY`, `AUTO_GRANT_REACH`, `isAutoActive`,
`shouldAutoApprove`, `grantAuto`, `revokeAuto`, `restorePolicy`.

**No consumers yet — expected.** Phase 6 (composer) and Phase 4/7 (adapter +
persistence) wire it; until then it is inert. Deliberate: it was kept free of UI
and persistence so those phases can change without touching it.

Verified by a temporary harness (deleted; **not** a test file) — **20/20 checks**:
manual requires approval; auto auto-approves; revoke resumes manual; session and
always scopes recorded; **`restorePolicy("auto", null)` falls back to Manual so a
persisted mode flag can never silently grant Auto**; a stale scope under `manual`
stays manual; garbage scope rejected; `MANUAL_POLICY` never mutated.

**Test-agent handover (Phase 12 policy rows):** the 20 checks above are the
requirements — they were run once by a throwaway script, not committed as tests.

Gates after Phase 2–3: `bun run typecheck` **exit 0**, `bun run build` **exit 0**.

## 8c. Phase 4 delivered — the element and the ID-mapping adapter

**Vendored:** `web/src/components/assistant-ui/elements/approval-card.tsx` — the
official element, one adaptation (the four lucide icons are aliased, because
`lucide-react@0.469.0` exports only un-suffixed names; `terminal-block.tsx`
documents the same). No dependency added; `surfaces.tsx` already exports
`paper` / `field` / `inkButton`.

**The mechanism that makes "hide the unmappable button" possible without a fork:**
the element renders each button **only when its callback is supplied**. Not
passing `onAlwaysAllow` *is* hiding the Always button — no prop added, no fork.

**Adapter:** `web/src/features/permissions/approvalOptionMapping.ts` — pure.

| Host kind | Presentation |
|---|---|
| `allow-once` | `"once"` |
| `allow-always` | `"always"` |
| `reject-once` / `reject-always` | `"deny"` |
| anything else (custom kind) | **not mapped** |

`bindApprovalOptions(options)` → `{ presentation, host, unmappable }`, where
`presentation` is derived from the options the request **actually carries**:

```
allow-once + reject-once                → once, deny
allow-once + allow-always + reject-once → once, always, deny
reject-once only                        → deny
```

**The element's ids never become authoritative.** `hostResponseFor(binding, id)`
returns `{ optionId: <the HOST's id>, approved }` — so `"once"` is only ever a
button name, and the wire carries OpenCode's own id. `approved` travels with it
because the runtime rejects a mismatch (choosing a reject option while claiming
approval throws); the value comes from the shared `approvalOptionApproves`.

Verified by a throwaway harness (**22/22**, deleted — not a test file): all three
cases above, the round trip for each button, `reject-always → deny` with
`approved:false`, an unbound button returning `null` rather than a guess, and
`undefined` options binding nothing.

### Two capability gaps, reported rather than papered over

1. **A custom `kind` has no button.** `kind` is an open union, and the element has
   three buttons. Such an option is returned in `unmappable` so the caller can
   fall back to the generic renderer — it is **never** silently dropped and never
   given an invented button.
2. **Two options can claim one button** (e.g. `reject-once` + `reject-always` both
   → `deny`). First claimant wins; the second is reported in `unmappable`. The
   element has one button per id, so this is a real ambiguity the caller must
   resolve, not something the adapter should hide.

**Still not wired.** The adapter and element have no consumers yet — deliberate,
so the gate rewiring (which touches the single guarded response path) is reviewed
on its own, together with Phase 5's removal. Gates after Phase 4:
`typecheck` **0** / `build` **0**.

## 8d. Phase 5 audit — the custom approval UI is NOT a duplicate

**Phase 5's rule 8 ("remove the custom ApprovalCard shell and ApprovalActions if
they are no longer required") resolves to: they ARE still required.** The
evidence is unambiguous — the vendored **official** `ToolFallback` element is
**built on** them:

| Import in `components/assistant-ui/elements/tool-fallback.tsx` | Line | Used at |
|---|---|---|
| `ApprovalActions` | 30 | 672 |
| `ApprovalCard` | 31 | 540, 604, 652, 670 |
| `useApprovalExit` | 32 | 379 |

So `ApprovalCard` / `ApprovalActions` / `useApprovalExit` are the **shared shell
that the generic renderer sits on**, not a parallel reimplementation of the
official elements. Deleting them would break `ToolFallback.Approval` — which is
precisely the "existing generic assistant-ui approval renderer" that rule 3 names
as the fallback for unmappable options. Removing them would remove the fallback.

`stores/stalePermissionsStore.ts:119` says the same from the guard's side: the
stale guard covers **both** `ToolFallbackApproval` (generic) and the rich
`ApprovalGate`. Both are live surfaces.

### What is genuinely duplicated

Narrower than rule 8 assumed: only the **request-state presentation** — the
three-button strip plus the per-state status line — which the official
`ApprovalCard` element now provides and `ApprovalGate` currently draws itself.

### Phase 5's real scope

1. Wire `ApprovalGate`'s **request state** to the official `ApprovalCard`, fed by
   `bindApprovalOptions` / `hostResponseFor`, with the response still flowing
   through the **single guarded path** (rule 7).
2. Keep `ApprovalCard` / `ApprovalActions` / `useApprovalExit` — they are the
   substrate for `ToolFallback`, not duplicates.
3. When `unmappable` is non-empty, render the **existing generic
   `ToolFallbackApproval`** — rule 3 is satisfied by a renderer that already
   exists, so **no new fallback is written** (rules 3 and 4).
4. Never collapse a custom option into generic Approve/Deny (rule 5), and never
   synthesise "always" (rule 6) — both are enforced in
   `approvalOptionMapping.ts` already.

**Not yet done:** the `ApprovalGate` rewiring itself. It changes the single
guarded response path, so it needs its own increment with `typecheck` + `build` +
the parity guard re-run (`approvalParity.test.ts` asserts `ui.tsx` contains no
`ApprovalActions`, which the rewiring must not disturb).

## 8e. Phase 5 — inspection complete, edit specified, NOT applied

**`ApprovalGate` (`tools/filesystem/ui.tsx:83`) was read in full. The guarded
response path is already exactly what the adapter needs, so the rewire is a
presentation-only change:**

```
answer(response)                     // :176  the SINGLE guarded path —
  if (busy) return                   //        busy guard
  runWithExit(async () => {          //        exit fade
    await respondToApproval(response)//        the one send
  })                                 //        + reportGone backstop
chooseOption(option) =               // :200  ← IDENTICAL to hostResponseFor:
  answer({ approved: approvalOptionApproves(option), optionId: option.id })
```

`chooseOption` already produces precisely what `hostResponseFor` returns, so the
official element's callbacks can call `chooseOption(binding.host[id])` and the
guarded path is **unchanged**. Nothing about `busy`, `runWithExit`,
`respondToApproval`, `reportGone` or `useStaleApprovalGuard` needs to move.

**Request-state JSX today** (`:300-371`): declared options render one generic
`Button` each (`:302-320`, with `confirm` handling); a freeform input renders when
`display === "text" || allowFreeform` (`:324-342`); `ApprovalActions` renders when
there are no declared options (`:363-371`).

**The edit:** in the request state, when the request is a plain decision —
`bindApprovalOptions(approval.options)` yields a non-empty `presentation`, an
empty `unmappable`, and the display is not `text`/freeform — render the official
`ApprovalCard` instead of the generic button strip, wiring
`onAllowOnce`/`onAlwaysAllow`/`onDeny` to `chooseOption(binding.host[…])`. Every
other case keeps the existing rendering, which **is** the audited fallback
(§8d): custom kinds, duplicate claimants, and freeform/text requests.

**Why it is not applied yet.** It changes the one surface every tool approval
flows through, and the phase requires `typecheck` + `build` + the
`approvalParity` guard re-run + the approval unit/integration tests + a browser
pass (allow once / always-when-offered / deny / no-always / unmappable →
fallback / ambiguous → fallback / stale double-submit). Shipping the edit without
running those would leave the permission path unverified, which is the one thing
this whole design exists to prevent. It is a single contained increment.

**Constraint to respect when it lands:** `approvalParity.test.ts:60` asserts
`tools/opencode/ui.tsx` contains no `ApprovalActions` — the rewire is in
`filesystem/ui.tsx` and must not pull `ApprovalActions` into the OpenCode
renderers.

## 8f. Phase 5 — BLOCKED by a real capability gap in the official element

**The rewire cannot be done faithfully.** The official `ApprovalCard` takes three
**strings** and has no slot for TBAi's gate content:

```ts
ApprovalCard({ state, command, title, subtitle, onAllowOnce?, onAlwaysAllow?, onDeny? })
```

`ApprovalGate` renders `{prompt ? <p>{prompt}</p> : details}` (`filesystem/ui.tsx:260`),
where **`details` is a `ReactNode`** — the rich argument preview built per tool
(`editPreview(args)` for `edit`, the command for `bash`, the path for `read`, …).

| Gate content | Element slot | Fit |
|---|---|---|
| `title` (string) | `title` | ✅ |
| `approval.prompt` (string, optional) | `subtitle` | ✅ |
| `details` (**ReactNode**) | `command` (**string**) | ❌ **no representation** |
| the outside-workspace warning, `error`, confirm step | — | ❌ no slot |

So a faithful mapping does not exist. The three possible fills for `command` are
all wrong:

- `command=""` → the element renders an **empty monospace box** — visibly broken.
- `command={title}` → duplicates the title in two slots.
- stringify `details` → lossy, and defeats the point of a rich preview.

And the element has **no slot** for the outside-workspace warning, the inline
error, or the `confirm` step — all of which are live in the current gate.

**Per the task's own rule** ("If a real capability gap exists, document it before
introducing custom code"; and Phase 5's "use the official ApprovalCard only when
… without semantic loss"), the correct action is **not to ship this swap**.
Shipping it would silently drop the argument preview from every approval card —
the exact class of loss rules 2 and 5 forbid.

### What *is* faithful, and already works

Everything in `approvalOptionMapping.ts` — the id mapping, derived visibility, the
round trip, the unmappable/ambiguous reporting. The gap is purely in the
**element's prop surface**, not in the adapter.

### Options, for the user to choose

1. **Keep `ApprovalGate`'s rendering, adopt the adapter's semantics.** Map the
   options through `bindApprovalOptions` and render with the existing shell, so
   the *decision vocabulary* is official while the *card* stays TBAi's. Gains the
   consistency without losing the preview.
2. **Fork the element** to add a `children`/`details` slot and an optional
   `warning`/`error` region — a documented fork, which Phase 10 permits only when
   "the installed component genuinely cannot satisfy a TBAi requirement". This is
   that case, but it is a fork, and forks drift.
3. **Restyle the official element's slot usage** — pass `details` as `children`
   via composition *outside* the card (render the preview above it, as today) and
   accept an empty `command`. Rejected: an empty monospace box is a visible defect.

**Recommendation: option 1.** It delivers the interoperability that Phase 5 was
actually after (one option vocabulary, one guarded path, no synthesised options)
without a fork and without dropping the preview. It also means rule 8's "remove
the custom shell" stays void, consistently with §8d.

### Decision: option 1, shipped

**Keep `ApprovalGate`'s rendering; adopt the adapter's semantics.** The official
element cannot represent this gate (§8f), so the card stays TBAi's — but the
*decision vocabulary* is now shared, and the binding supplies the official
presentation order.

`ApprovalGate` (`tools/filesystem/ui.tsx`):
- `bindApprovalOptions(approval.options)` → `binding`.
- **Used for presentation order only, never for filtering.** When a request maps
  cleanly, its buttons render in the official order (once → always → deny) with
  the allow-once action emphasised (`variant="default"`), matching the official
  element's arrangement.
- A custom `kind` or a duplicate claimant is **never collapsed or dropped**:
  `unmappable` sends the request back to **host order with neutral styling**, so
  every option the host declared still renders.

Preserved verbatim: the `details` ReactNode, the outside-workspace warning, the
inline error, the confirm step, `useStaleApprovalGuard`, and the single
`answer() → runWithExit → respondToApproval` path (`chooseOption` at `:201` is
untouched). `approval.isAutomatic` unchanged. No fork, no `PermissionGrant`, no
second renderer, no Auto/composer work.

Verification: `typecheck` **0**, `build` **0**, and **58 pass / 0 fail** across
`approvalParity` · `stalePermissionsStore` · `tool-fallback` · `opencode/ui`.
**Browser verification NOT RUN** — not performed in this environment, and not
claimed.

**Removability of `ApprovalCard` / `ApprovalActions`:** still required (§8d) — the
official `ToolFallback` is built on them, so they stay.

## 8g. Phase 6A audit — complete

### Q4 — where conversation/session config persists

**On the conversation record, via the existing `/api/conversations` path.**
`features/opencode/OpenCodeChipShared.tsx:32-34` reads a bound conversation's
picks as `config?.opencodeAgent` / `config?.opencodeModel` / `config?.opencodeVariant`.
Writes go through `remoteThreadListAdapter` (POST `/api/conversations`, PATCH
`/api/conversations/{id}`). **No new persistence mechanism is needed** — the Auto
flag belongs in the same per-conversation config object.

### Q5 — how a draft becomes a real OpenCode session

The existing pattern, documented in `OpenCodeChipShared.tsx:20-41`:

```
draft (no bound conversation)
  → picks live in the WELCOME-ENGINE store (welcomeAgent / welcomeModel / welcomeVariant)
  → on materialization the conversation is bound
  → picks are read from conversation config (config.opencode*)
```

So **the Auto flag must follow that same route** — a welcome-store value while
drafting, conversation config once bound. **Do not create another draft store**:
the mechanism already exists and the spec forbids a second one.

### Q6 — does the installed runtime expose session lineage?

**Yes.** `@opencode-ai/sdk@1.18.31`, `types.gen.d.ts:71`: the session type carries
`parentID?: string` (alongside `projectID`, `workspaceID`, `directory`, `path`).
So parent/child lineage **is** part of the installed contract, and inheritance is
therefore *permissible* rather than blocked.

**But two caveats before relying on it:**
1. It is **optional** — a session may have no `parentID`, so any inheritance rule
   must define the no-parent case explicitly rather than assume a tree.
2. Whether **TBAi's adapter surfaces it** to the client is **not verified**. That
   check comes before any inheritance logic — **do not infer lineage from ids or
   naming.**

### Carried from the earlier audit (§8f/6A)

`approval.isAutomatic` is **runtime-provided**, not TBAi-set — it cannot be the
Auto switch. And there is **no backend permission subscription**: permissions
arrive through the client-side `permissionCompat` path, which is where Auto-accept
belongs.

### ⚠️ Phase 6B–6F were not received

The specification was truncated **twice at the same point** — mid-Phase-6B at
`type PermissionMode = "manual" | "auto";` — so the corrected model and phases
6C–6F are unknown. **Implementation has not started, by design: guessing a
permission model is exactly the kind of assumption this plan exists to prevent.**
Send 6B–6F in a separate message and the work can proceed against the audit above.

## 8h. Phase 6B delivered — the corrected Auto model

`web/src/features/permissions/permissionPolicy.ts` rewritten to the final model:

```ts
type PermissionMode = "manual" | "auto";     // OFF = ask, ON = accept once
MANUAL · AUTO · AUTO_RESPONSE = "once"
isAutoActive(mode) · shouldAutoApprove(mode) · toggleAuto(mode) · restoreMode(value)
```

**Auto is session-scoped. `AutoGrantScope`, `grantAuto(scope)`,
`restorePolicy(mode, scope)` and `AUTO_GRANT_REACH` are deleted** — verified:
the only remaining mention of those names anywhere in `web/src` is the comment
in the new file recording their absence.

`restoreMode` **fails closed**: anything that is not exactly `"auto"` becomes
`manual`, so a corrupted or absent value can never start auto-accepting.

`AUTO_RESPONSE = "once" as const` exists so "never send `always`" is enforced in
one place rather than remembered at each call site.

Gates: `typecheck` **0**, `build` **0**. The module still has **no consumers** —
6C wires it into `permissionCompat`.

### 6C–6M — the remaining plan (not started)

| Phase | Work | Notes from the audit |
|---|---|---|
| 6C | Auto branch inside the **existing** `permissionCompat` path | no backend SSE subscriber, no second listener, no second response path; response goes through the existing OpenCode boundary, not invented HTTP in a component |
| 6D | Reuse the **existing** reconciliation/hydration path | answer pending requests once on enable and once after reconnect; no polling, no `setTimeout` to hide races, never answer an already-resolved request twice; identity comes from the existing compat layer |
| 6E | Composer shield (`aria-pressed`, tooltip, existing visual language) | copy goes in `config/composer.ts`; reuse the existing per-session permission state, no second Zustand store |
| 6F | Draft + live session | draft flag survives materialization (Q5 route: welcome store → conversation config); per-session, never global |
| 6G | Lineage | **contract exposes `session.parentID?: string`** (Q6) — permissible, but first verify TBAi's adapter surfaces it, and define the no-parent case |
| 6H | Manual mode unchanged | `ApprovalGate`, rich previews, `bindApprovalOptions`, freeform, stale guard, `isAutomatic` all untouched |
| 6I | `approval.isAutomatic` stays a **runtime decision**, never the user preference | already runtime-provided; do not overload |
| 6J | Persist via the Q4 conversation-config path | no new DB, no new Zustand persistence, no localStorage, no global setting |
| 6K | Delete dead Phase-2 code | 6B's deletions done; re-audit after 6C wires the real consumer |
| 6L/6M | Tests + verification | browser verification must be reported **NOT RUN** unless actually performed |

## 8i. Phase 6C/6D — the insertion point is identified; not implemented

`permissionCompat.ts` was read in full. It is a **scope-patching layer**: it wraps
`permission.list` / `permission.reply` to add the authoritative session directory
(the V1-shaped adapter omits it, which is why an unscoped list answers `[]` and an
unscoped reply 404s), plus one named fallback for a build whose canonical route is
absent, fired only on `isRouteUnsupported` — never on a 404.

**`replyCompat` (line 186) is the single response boundary** — it maps the reply
value through `toPermissionReplyValue`, applies `withDirectory`, tries the
canonical route then the fallback, and normalizes errors through
`normalizePermissionReplyError`. **The Auto branch must call this, not invent an
HTTP request** — which is exactly what the spec's "no direct renderer-level
OpenCode HTTP permission calls" requires.

### The shape 6C/6D should take

```ts
// in permissionCompat.ts — the ONE response path, reused
export async function autoAcceptPendingPermissions(
  client, scope,
  pending: readonly { id: string }[],
  mode: PermissionMode,
  alreadyAnswered: ReadonlySet<string>,
): Promise<number>
```

- Returns early when `!shouldAutoApprove(mode)` → **manual is untouched** (6H).
- Skips ids in `alreadyAnswered` → never answers a request twice (6D).
- Replies with `AUTO_RESPONSE` only — imported from `permissionPolicy.ts`, never
  a second `"once"` literal, and `"always"` is unreachable by construction.
- Goes through the patched `client.permission.reply`, so directory/session
  handling and the fallback are inherited rather than re-implemented.

Reconciliation point (6D): the **existing** hydration path, which already lists
pending permissions — no polling, no timers, no second cache.

### ⚠️ Blocker — there is no per-session Auto state source yet

6E/6F create it (composer shield + draft/live session state); 6C/6D are specified
as consuming it. So this increment can only land as a **parameterised capability**
(`mode` passed in) with tests — which is legitimate and is what the spec's
"verify the existing permission layer can consume a per-session Auto state"
asks for. It was **not implemented**: it changes the live permission lifecycle,
and shipping it without running the permission/OpenCode/approval/stale/question
tests would leave the manual path unverified. That is the one thing 6H forbids.

## 8j. Phase 6C/6D delivered — the Auto branch

`web/src/features/opencode/permissionCompat.ts` gained one exported helper:

```ts
autoAcceptPendingPermissions(client, pending, mode, alreadyAnswered): Promise<number>
```

**It reuses the single response boundary by construction.** It calls
`client.permission.reply`, which — once `applyPermissionCompat` has run — **is**
the patched `replyCompat`. So the automatic path inherits the authoritative
directory scope, the canonical-route-then-fallback behaviour and the 404→stale
normalisation rather than re-deriving any of them. **No HTTP is issued in the
helper, and no OpenCode protocol detail is duplicated.**

**`scope` is deliberately not a parameter.** The patch closed over it, so the
session identity and directory are already applied; accepting them again would be
a second source of truth for the same fact. (The spec invited adapting the
signature rather than copying it.)

- `mode !== "auto"` → returns `0`, sends nothing — **manual is untouched**.
- Replies with `AUTO_RESPONSE` only, imported from `permissionPolicy.ts`; no
  second `"once"` literal exists at the call site.
- **`"always"` is unreachable** — verified by searching the helper body: the word
  does not appear in the path at all.
- `alreadyAnswered` ids are skipped, so repeated reconciliation (enable, then
  reconnect) answers each request **once**.
- A failing reply is not counted and does not stop the others; classification
  stays with the shared stale guard rather than being duplicated here.

**Tests:** `web/src/features/opencode/permissionAutoAccept.test.ts` — 10 focused
cases (manual no-op, auto answers, reply is `AUTO_RESPONSE`, never `"always"`,
alreadyAnswered skipped, three reconciliation passes answer each id once, multiple
pending each once, a failure doesn't stop the rest, malformed modes → manual,
request identity passed through verbatim).

### 6D — the hydration integration is NOT wired, and why

The helper is delivered and tested, but it is **not yet called from the existing
reconciliation path**. That path needs a **per-session `mode` source**, and none
exists until 6E/6F (composer shield + draft/live session state) — which this
increment is explicitly forbidden to build. Wiring it now would mean passing a
hardcoded `"manual"` (dead code) or inventing a state source (forbidden).

This matches the spec's own allowance: *"the permission layer may accept the mode
as an explicit parameter. That is intentional. 6E/6F will provide the actual
per-session source."*

**Remaining for 6E+:** the mode source, then one call site in the existing
hydration path — plus the `alreadyAnswered` set, which must live with that path
rather than in a second cache.

Gates: `typecheck` **0**, `build` **0**, and **77 pass / 0 fail** across
`permissionAutoAccept` · `permissionCompat` · `stalePermissionsStore` ·
`approvalParity` · `tool-fallback` · `toolLinkedQuestion` (questions unchanged).

## 9. Open questions for the user

1. **§4 — (i) wrap or (ii) adopt?** Everything in Phases 4–5 depends on it.
2. **§6 — accept an id-mapping adapter**, or restrict Auto grants to host-declared
   ids only?
3. **Auto's `grants` text** — what exactly does "Always" persist, in words? The
   library will not invent it.
