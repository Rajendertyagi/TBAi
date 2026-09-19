# Permission Auto-Approval — rebuild plan

Status: **audit complete, rebuild in progress (2026-09-19).**
The previous Shield runtime was unrecoverable (no stash/stage/reflog/dangling
objects). This plan rebuilds it from the surviving repository state.

## Surviving architecture (verified by inspection)

| Concern | Survives? | Where |
|---|---|---|
| Pure policy core | ✅ | `web/src/features/permissions/permissionPolicy.ts` — `PermissionMode`, `AUTO_RESPONSE="once"`, `shouldAutoApprove`, `restoreMode` |
| Approval presentation mapping | ✅ | `web/src/features/permissions/approvalOptionMapping.ts` (unrelated to the Shield; kept) |
| Backend persistence | ✅ (uncommitted) | `opencode_auto_approve` column + type + storage + validation + routes |
| OpenCode permission compat | ✅ | `permissionCompat.ts` — `replyCompat`, directory scope, canonical/fallback, 404→stale |
| V2 payload normalization | ✅ | `permissionPayloadCompat.ts` — `normalizeFrames` (async generator) |
| Initial hydration | ✅ | `initialHydration.ts` — replays pending set on `server.connected` |
| Runtime client composition | ✅ | `runtimeClient.ts` — single construction point |
| Runtime hook | ✅ | `useOpenCodeRuntime.ts` — returns `{ runtime, reconnect }` |
| Code surface | ✅ | `OpenCodeView.tsx` — sessionId + directory state |
| Conversation config read | ✅ | `useOpenCodeConversationConfig.ts` — agent/model/variant only |
| Draft store | ✅ | `welcomeEngine.ts` — engine/agent/model/variant only |
| Composer | ✅ | `Composer.tsx` — OpenCode chip row (Agent/Model/Thinking) |

## Current gaps (must rebuild)

- `sessionAutoPolicy.ts` — session-keyed runtime policy cache (gone).
- `autoAcceptPendingPermissions` / `reconcileAutoApprove` in `permissionCompat.ts` (gone).
- Shared per-runtime `answered` Set in `runtimeClient.ts` (gone).
- Live `permission.asked` auto-reply in `permissionPayloadCompat.ts` (gone).
- Hydration auto-approval in `initialHydration.ts` (gone).
- `useOpenCodeConversationConfig.opencodeAutoApprove` field (gone).
- `welcomeEngine.autoApprove` draft field (gone).
- `remoteThreadListAdapter.initialize()` `opencodeAutoApprove` payload (gone).
- `OpenCodeView` sessionId+config hydration point + runtime context (gone).
- Shield UI chip (gone).

## Chosen implementation

Same architecture as the lost implementation (it was correct and verified):

```
conversation.opencodeAutoApprove (persisted, authoritative)
        ↓
sessionAutoPolicy (session-keyed synchronous runtime cache)
        ↓
permission event-time decision (hydration + live normalizeFrames)
        ↓
autoAcceptPendingPermissions → existing patched client.permission.reply (replyCompat)
        ↓
OpenCode reply("once")
```

Keyed by the **OpenCode sessionId** (the live boundary has sessionId + directory,
never reliably conversationId). No conversationId/sessionId mapping invented.
Fail closed: unknown/absent session ⇒ manual. Questions untouched.

## Phases (each committed when green)

| Phase | Work | Commit |
|---|---|---|
| 1 | `sessionAutoPolicy.ts` + unit tests | `phase1-session-auto-policy` |
| 2 | Persistence (verify surviving backend) + `opencodeAutoApprove` read/draft/materialize + session hydration | `phase2-persistence-hydration` |
| 3 | `autoAcceptPendingPermissions` + shared `answered` Set + reconcile | `phase3-permission-responder` |
| 4 | Hydration/reconnect auto-approval | `phase4-hydration-reconnect` |
| 5 | Live `permission.asked` reply-before-yield | `phase5-live-permission` |
| 6 | Immediate OFF→ON reconciliation (`persistAutoApprove`) | `phase6-enable-reconcile` |
| 7 | Remove obsolete React getter path (verify none remains) | `phase7-remove-obsolete` |
| 8 | Shield UI (chip + context + composer wiring) | `phase8-shield-ui` |
| 9 | Browser verification | — |

## Tests

- Phase 1: `sessionAutoPolicy.test.ts` — fail-closed, session isolation, hydrate.
- Phase 3: `permissionAutoAccept.test.ts` — success/failure/dedupe/retry/isolation.
- Phase 4/5: `autoApproveLive.test.ts` — hydration + live, deterministic async
  control (deferred promises, no sleeps).
- Phase 8: `openCodeShield.test.ts` — static render + toggle logic + source guards.
- Backend: surviving `conversation-engine-storage.test.ts` /
  `conversation-engine-routes.test.ts` already cover persistence.

## Gates per phase

`bun run typecheck` · `bun run lint` · focused tests · `bun run build`.
Commit only intended files (the working tree carries unrelated agents' changes;
stage per-file, never `git add -A`).

## Completion record (2026-09-19)

All phases committed and green:

| Phase | Commit | Work |
|---|---|---|
| 1 | `61895bb` | `sessionAutoPolicy.ts` + 8 tests |
| 2 | `7d7f8e4` | persistence (verified surviving backend) + config read + draft + materialize + session hydration |
| 3 | `c2e8cbd` | `autoAcceptPendingPermissions` + `reconcileAutoApprove` + 12 tests |
| 4 | `705caad` | hydration/reconnect auto-approval + 4 tests |
| 5 | `731379e` | live `permission.asked` reply-before-yield + 9 deterministic tests |
| 6 | `f236416` | `persistAutoApprove` + immediate OFF→ON reconciliation + 5 tests |
| 7 | `c119c72` | verified no obsolete React getter path remains |
| 8 | `766f226` | Shield UI (chip + context + composer wiring) + 16 tests |

### Browser verification (observed, real OpenCode server)

- Draft Shield renders OFF, toggles ON immediately, persists across reload.
- Draft ON materialized into `conversation.opencodeAutoApprove=true`.
- Bound Shield renders from conversation config; toggles OFF/ON immediately;
  backend persists; reload preserves.
- **Shield ON → live permission auto-approved "once"** (directory-scoped reply,
  tool ran, no card).
- **Shield OFF → manual approval card** (Allow/Always allow/Deny), no auto-reply;
  manual Allow works.
- **Pending permission reconciles immediately after enabling** (PATCH → list →
  reply 200).
- **Session isolation**: conv1=True, conv2=False.
- Environmental note: the `deepseek-v4-flash-free` model produced no output
  (agent stuck at "Working"); switching to `opencode/big-pickle` worked. The
  bash tool itself reports "OpenCode session is not bound to a Paseo agent"
  (server-side limitation, unrelated to the Shield).

### Lint cleanup (2026-09-19)

`bun run lint` was clean except 6 pre-existing `noUnusedVariables` warnings and
1 Biome config deprecation. All fixed (dead code removed, unused vars dropped,
`recommended` → `preset` in `biome.json`): `progress-tracker.test.ts`,
`mcp/manager.ts`, `todos.ts`, `chat-runs.test.ts`, `db.test.ts`,
`startup-prefs.test.ts`, `biome.json`. Lint now reports **0 warnings / 0 info**.