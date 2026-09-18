# Phases — Single Tracker (Index)

One row per phase across all tracks. This file is the **index only**: status +
owner + evidence. Detail lives in the linked doc — never copied here.

Update protocol: whoever finishes a phase flips its row in the same change
(coding agent for implementation, test agent for verification). Rows move
forward only on evidence (actual test/build numbers, observed live behavior),
never on intent.

## Track A — Lifecycle hardening

Source: `docs/superpowers/plans/2026-09-17-lifecycle-hardening.md`.
Ordering is load-bearing (plan l.604–614): Phases 2–5 independent of each
other; Phase 1 wires them; Phase 6 independent; Phase 7 always last.

| Phase | Scope | Status | Owner | Evidence / done-criteria |
|---|---|---|---|---|
| 0 | Lifecycle contract + target shutdown sequence | Done | — | Plan §0 (invariant + `server.stop()` semantics runtime-verified) |
| 1 | Shutdown spine (`src/server.ts` rewrite) | Implemented, **verification in progress** | Test agent (`0611a4b`, agnes-3.0-flash) | `tests/integration/shutdown-lifecycle.test.ts`; known test-isolation issue (DB handle vs scheduler tests) being fixed test-side only |
| 2 | OpenCode process lifecycle | Done, **live-verified** | — | typecheck 0, build 0, `bun test` 743 pass / 0 fail (745 tests, 77 files), `bun run test:shutdown` 1/0 (plan l.635) |
| 3A | Chat `abortAll()` + settlement + gate | **COMPLETE** (implemented + live-verified + suite-reconciled) | — | Live SIGINT settled=1/timedOut=0; targeted 20/0; full suite zero Phase-3 failures; T3-L01–L04 |
| 3B | Scheduler `abortAllRuns()` + tracking + gate | **COMPLETE** (implemented + live-verified + suite-reconciled) | — | Live SIGINT aborted=1/settled=1/timedOut=0; targeted 65/0; T3-L05–L10 |
| 4 | MCP `disconnectAll()` + elicitation cancel + bounded reconnect | **COMPLETE** (implemented + live-verified + suite-reconciled 2026-09-17; re-verified 2026-09-18) | — | All-states disconnect, `{action:"cancel"}` on disconnect + connect-replacement, dead close-handler removed, timers bounded; T3-L14/L15 |
| 5 | SQLite `busy_timeout=5000` (defensive; not a shutdown fix) | **COMPLETE** (implemented + suite-reconciled) | — | db.test.ts 6/0; full suite zero Phase-5 failures; T3-D03 |
| 6 | Conversation DELETE → terminate OpenCode session (engine-gated, warn-and-continue) | **COMPLETE** (implemented + live-verified + suite-reconciled) | — | Real interrupt+remove observed live; engine-guards 5 new cases; T3-C01–C05 |
| 7 | Dead-code cleanup (plan list only) | **COMPLETE** (removed + suite-reconciled) | — | 5 files + 4 code sites gone; typecheck + build green; zero new failures; T3-P7-01–03 |

## Track B — Code-mode tool rendering

Source: `docs/opencode-block-rendering-plan.md`. Live-verification handover:
`docs/handover-phase-3d-verification.md`.

| Phase | Scope | Status | Owner | Evidence / done-criteria |
|---|---|---|---|---|
| 2 | Block structure (flatten group tree, one surface per block) | Implemented + tested | — | Unit/render tests + mutation checks (handover §3) |
| 3A | Stale-permission guard parity | Implemented + tested | — | Parity test locks it in (plan §4.4.3) |
| 3B | Argument/result normalization (read/glob/grep/…) | Implemented + tested | — | Same as above |
| 3C | Permission-gated tools (bash/edit/write + rich mappings) | Implemented + tested | — | Same as above |
| 4 | Diff routing (`edit` patch via message metadata) | Implemented, gated | — | `openCodePatchFromParts` + `useOpenCodeEditPatch` |
| 3D | Live verification in a real Code conversation | **Partial** | Coding agent (live run) | `bash` completed → terminal output **verified live**; `read` body, `edit` diff, approval approve/deny + no-wedge **not verified**. Wedge root cause resolved 2026-09-17 (directory-scoped permission/question routes; handover §8.1). Blocker was the `POST /session/{id}/message` 500/hang — repair/restart server, then run write+edit with gate approval |

## Track C — OpenCode V2 client migration

Source: `docs/opencode-v2-backend-migration-report.md`, decisions.md.

| Phase | Scope | Status | Owner | Evidence / done-criteria |
|---|---|---|---|---|
| V2-p1 | Migrate to official `@opencode/client@2.0.4` (agent/model/session create+get) | Done | — | Verified live vs OpenCode 1.18.29; `as unknown as X` casts removed |
| V2-p2 | `session.interrupt` / `session.remove` | **Blocked by server, not our code** | — | interrupt: server returns 204, client hard-codes 200; remove: no DELETE route on 1.18.x. Revisit on newer server |

## Queued (decided or studied, not started)

| Item | Scope | Status | Source |
|---|---|---|---|
| Web Service panel | Separate LAN-exposure server + settings page (Option A, auto-start yes, QR no) | Decided, fully spec'd, **prompt never issued** — next single bounded task | `docs/pm-notes.md` §7–8 |
| Heartbeat chip | CodeG-style connection heart in `OpenCodeStatus.tsx` (extend only) | Study done; **2 open decisions** (inline text, action scope) need maintainer call | `docs/pm-notes.md` §9 |
| Roadmap Next | Provider-switching UI, `/api/chat` smoke test, SSE live-test, Desktop Commander E2E, sampling/elicitation E2E | Open | `docs/roadmap.md` §Next |
| Latent gap | Stored `systemPrompt` never sent to model | Flagged, unscoped | `docs/pm-notes.md` §5 |

## Deferred (do not build until basic path confirmed)

RAG / retrieval, file uploads, advanced persistent memory, auth/multi-user,
deployment hardening (`docs/roadmap.md` §Deferred).
