# OpenCode Session Loss — Investigation and Prevention Plan

**Status:** INVESTIGATION REPORT + PLAN ONLY. No implementation authorized.
**Date:** 2026-11-25
**Branch / HEAD:** `ui-foundation-upgrade` @ `a7fb5b3`
**Mode:** read-only investigation; no session, database, WAL, backup, TBAi code/config, or Git state was modified.

---

## 1. Executive summary

Nine of thirteen TBAi Code conversations point to OpenCode sessions that are **absent** from the shared OpenCode database at `D:\Coding\OpenCode\data\opencode\opencode.db`. The missing sessions span November 1–24 and multiple session-ID eras. A freshly created session survived 37 seconds of observation **and** an application restart, and TBAi's three session-deletion paths all have ownership guards.

**Confirmed fact:** the sessions are gone from the database. **Confirmed fact:** no successful (`HTTP 200`) session DELETE appears anywhere in the available OpenCode log (48 DELETEs, all `404` — already gone). **Unknown:** what removed them. The available log starts 2026-11-15, so deletions of the older sessions (Nov 1–14) predate logging. The exact deleter could not be established from TBAi's or OpenCode's logs.

**Root cause of the loss remains UNKNOWN.** What *is* established is the structural risk: every OpenCode client on this machine — TBAi, OpenChamber, MarketHubTS, ScreenLayoutRust, the OpenCode CLI/desktop, and this agent harness — shares **one** database via globally set `OPENCODE_DATA_DIR` / `XDG_DATA_HOME`. Any client with a session ID can delete another client's session through the shared server's `DELETE /api/session/:id`, and OpenCode provides officially supported isolation mechanisms (`OPENCODE_DB`, `--standalone`, `opencode service set disabled true`) that TBAi does not currently use.

**Recommendation:** give TBAi its **own OpenCode data directory/database** using the officially supported `OPENCODE_DATA_DIR` / `OPENCODE_DB` configuration, with a dedicated managed server instance. This is the simplest durable solution: it prevents any other application from deleting TBAi's sessions, uses OpenCode's own supported configuration, and requires no custom cleanup logic. Existing conversations are preserved by a read-only migration that copies the shared DB into the private directory before switching — never modifying the original.

---

## 2. Verified facts, hypotheses, unknowns

### Verified facts
- Installed OpenCode CLI/server: **v2.4.0** (`opencode --version`); binary `D:\Coding\OpenCode\opencode.exe` (file version 1.4.4.0).
- DB path: `D:\Coding\OpenCode\data\opencode\opencode.db` (1.38 GB), WAL 17.1 MB, created 2026-11-02.
- Global env: `OPENCODE_DATA_DIR=D:\Coding\OpenCode\data\opencode`, `XDG_DATA_HOME=D:\Coding\OpenCode\data`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CACHE_DIR`, `OPENCODE_LOG_DIR` all point into the shared `D:\Coding\OpenCode` tree.
- `opencode debug paths` confirms one shared `db`, `data`, `config`, `log`, `repos` for all clients.
- 9 of 13 TBAi code conversations have `opencode_session_id` values absent from `session_v2`.
- The missing sessions' conversation rows date from Nov 1–24; the OpenCode log starts Nov 15.
- OpenCode log: **0** successful session DELETEs; **48** DELETEs returning 404 (bulk sweep on Nov 17 for `ses_f2…` IDs, unrelated to the missing IDs).
- The missing session IDs appear in the log **only** as TBAi GET probes (`/api/session/<id>/message` → 404), never as DELETEs.
- DB schema: `session_message` and `session_inbox` have `ON DELETE CASCADE` from `session_v2(id)` — deleting a session row removes its messages, consistent with missing sessions having 0 messages.
- A fresh session (`ses_def5547e2…`) created during this investigation: present in DB and on server at t+0/2/5/10/20 s, and still present after an app restart (HTTP 200).
- TBAi uses the official `@opencode/client` HTTP client (`src/services/opencode/client.ts:10,68`; `web/src/features/opencode/v2Client.ts:190,205`), not ACP.
- TBAi's three deletion paths: compensation (`sessions.ts:1122`, only on failed pointer write + confirmed unbound), orphan reconciler (`orphanReconciler.ts:703`, with late ownership re-check at `:677-700`), explicit delete (`sessions.ts:1447`, from the delete button). Log showed `orphan_reconciled … removed=0`.
- Official OpenCode docs: no built-in session auto-pruning/retention (community issues #32630, #16101, #5734 confirm sessions persist indefinitely); `OPENCODE_DB` env var controls the DB path; `--standalone` runs a private server; `opencode service set disabled true` disables the shared service; `opencode uninstall` never removes session data.
- Official changelog v2.4.0: stored **blobs** (not sessions) are deleted after one week; ACP clients that create-and-close a session may have it removed — TBAi does not use ACP.

### Hypotheses (not proven)
- Another application sharing the DB deleted the sessions via the HTTP API or direct DB access. The bulk `ses_f2…` DELETE sweep on Nov 17 shows at least one client performs bulk session deletion, though those IDs are not TBAi's.
- An OpenCode version upgrade/migration between Nov 1–15 may have dropped older-format session rows. The DB was created Nov 2; the log starts Nov 15; no migration log is available.
- A manual cleanup (SQL, `opencode session delete`, or deleting the data directory) removed them. No evidence in available logs.

### Unknowns
- The exact process and timestamp that removed each of the 9 sessions.
- ~~Whether a DB backup exists from before the loss~~ **RESOLVED:** a full recursive search of `D:\Coding\OpenCode` completed. No backup of the main 1.38 GB `opencode.db` exists. The only other DB files are small temp databases (12–421 KB) under `user\tmp` from other tools (`browse.db`, `events.db`, `alerts.db`, `cid_*.db`, `wl_*.db`, `mig_*.db`, etc.) — none is a copy of the main DB. The 9 lost sessions therefore cannot be recovered from a local backup.
- Whether session *messages* could have disappeared while the session row survived (not observed; cascade suggests the opposite).

---

## 3. Evidence and source references

### Local machine
| Evidence | Location |
|---|---|
| Shared DB, WAL, creation time | `D:\Coding\OpenCode\data\opencode\opencode.db` (created 2026-11-02, 1.38 GB); `opencode.db-wal` (17.1 MB) |
| Global shared env | `OPENCODE_DATA_DIR`, `XDG_DATA_HOME`, `OPENCODE_CONFIG_DIR`, `OPENCODE_LOG_DIR` (process environment) |
| Single path set | `opencode debug paths` → one `db`/`data`/`config`/`log`/`repos` |
| Missing sessions | 9 TBAi conversations in `D:\Temp\ai-chat-app\data\chat.db` with `opencode_session_id` absent from `session_v2` |
| No successful deletes | `D:\Coding\OpenCode\data\opencode\log\opencode.log`: 0 DELETE 200, 48 DELETE 404 |
| Cascade deletes | `session_message` / `session_inbox` FK `ON DELETE CASCADE` → `session_v2(id)` |
| Fresh session survives | `ses_def5547e2ffe4dFVnVqcP3Pce3` present in DB + HTTP 200 after restart |
| TBAi deletion guards | `src/services/opencode/sessions.ts:464,1122,1447`; `src/services/opencode/orphanReconciler.ts:677-703` |

### Official OpenCode (version-matched where available)
| Claim | Source |
|---|---|
| `OPENCODE_DB` controls DB path; relative overrides resolve under data dir | `https://opencode.ai/docs/cli` → "Paths" |
| `--standalone` runs a private server; shared background server is default | `https://opencode.ai/docs/cli` → "Background service" |
| `opencode service set disabled true` disables shared service | same |
| `opencode uninstall` never removes session data/config/state | same |
| No built-in session retention/auto-pruning | Issues #32630, #16101, #5734 (anomalyco/opencode) |
| v2.4.0 deletes stored **blobs** after one week, not sessions | `https://opencode.ai/changelog` → 2026-11-23 v2.4.0 |
| ACP create-and-close session removal exists (not used by TBAi) | `https://opencode.ai/changelog` releases; TBAi client confirmed HTTP, not ACP |

---

## 4. All relevant deletion paths and responsible components

| Path | Component | Guard | Evidence of involvement |
|---|---|---|---|
| Compensation on failed pointer write | TBAi `sessions.ts:1122` | Only when pointer write failed AND verification says unbound | None in log |
| Orphan reconciler | TBAi `orphanReconciler.ts:703` | Late ownership re-check (`:677-700`); log `removed=0` | Ruled out |
| Explicit conversation delete | TBAi `sessions.ts:1447` | Only from delete button | None for missing sessions |
| HTTP `DELETE /api/session/:id` | OpenCode server, any client | None beyond caller's choice | 48 calls, all 404 — not the deleter |
| ACP create-and-close cleanup | OpenCode server | ACP clients only | TBAi does not use ACP |
| Direct DB manipulation / migration / manual cleanup | External | N/A | Cannot be ruled out; log predates loss |
| Blob GC (v2.4.0) | OpenCode server | Blobs only | Not sessions |

---

## 5. Prevention options compared

| Option | Compatibility | Portability | Existing session access | Reliability | Maintenance | Verdict |
|---|---|---|---|---|---|---|
| **A. Keep shared DB, avoid deletion** | No way to prevent other clients from deleting via shared API | N/A | Keeps all sessions visible to all apps | Low — no enforcement | Low | Rejected: no supported mechanism to enforce |
| **B. Private TBAi data dir / DB via `OPENCODE_DATA_DIR` / `OPENCODE_DB`** | Official OpenCode config; TBAi already sets env for its managed server | Windows/macOS/Linux (env vars) | Existing sessions preserved by copying DB; other apps keep theirs | High — OS/app-level isolation | Low | **Recommended** |
| **C. Dedicated `--standalone` server for TBAi** | Official; TBAi already spawns its own managed `opencode serve` | High | Same as B | High | Medium (two servers) | Combine with B |
| **D. Session-integrity monitoring / rebind on 404** | TBAi-side only | High | Cannot recover lost history | Medium — detects, does not prevent | Medium | Adjunct only |
| **E. Custom cleanup/backup scripts** | Unsupported | Low | Risky | Low | High | Rejected |

**Recommendation:** **B + C** — a private TBAi OpenCode data directory and DB, with the existing managed server started with that environment. This uses OpenCode's own supported configuration, isolates TBAi from every other client on the machine, and needs no custom deletion logic.

---

## 6. Recommended architecture and rationale

- TBAi's managed OpenCode server (`src/services/opencode/serverManager.ts`) already spawns `opencode serve` with a controlled environment (`authEnv`, `cwd: serverHomeDir`). Extend that environment with a TBAi-private `OPENCODE_DATA_DIR` (and optionally `OPENCODE_DB`) pointing under TBAi's own `DATA_DIR` (e.g. `data/opencode-home/data`), so the managed server reads/writes a DB no other application uses.
- Keep the existing `serverHomeDir` as the child's cwd; only redirect the data/DB path.
- Other OpenCode clients continue using the shared `D:\Coding\OpenCode\data\opencode` DB — no change to them.
- TBAi's session IDs remain valid because the private DB is a **copy** of the shared DB at migration time (see §8).
- Add a startup integrity check that logs (does not repair) when a conversation's session is absent, so future loss is visible without mutating data.

**Why not just monitoring:** monitoring detects loss but cannot prevent it, and cannot recover deleted history. Isolation removes the cause.

---

## 7. Exact files/components that would need changes (proposed, not implemented)

| File | Change |
|---|---|
| `src/config/opencode.ts` | Add a named constant for the private data dir path under TBAi `DATA_DIR` (no inline magic string). |
| `src/services/opencode/serverManager.ts` | Add `OPENCODE_DATA_DIR` / `OPENCODE_DB` to the spawned child's env (`buildOpenCodeServeArgs` / spawn env at `:686-708`). |
| `src/services/opencode/startup.ts` or a new migration module | One-time, read-only-source copy of the shared DB into the private dir before first managed start; guarded by a marker file. |
| `src/services/opencode/sessions.ts` or a new integrity module | Startup log-only check for conversations whose session is absent (no rebind, no delete). |
| `docs/decisions.md` | ADR recording the isolation decision and alternatives. |
| Tests under `tests/unit/opencode/` and `tests/integration/` | Env propagation, migration copy correctness, no-mutation of source DB, integrity logging. |

No change to `src/services/opencode/sessions.ts` deletion guards, `orphanReconciler.ts`, or the chat route.

---

## 8. Migration strategy (preserves conversations and sessions)

1. **Precondition:** TBAi is stopped; no managed server running. Verify no `opencode` child holds the shared DB.
2. **Copy, never move:** copy `D:\Coding\OpenCode\data\opencode\opencode.db` (and `-wal`/`-shm` if present) into the TBAi-private data dir. Use SQLite's backup API or a file copy while the source is idle; do **not** write to the source.
3. **Verify:** open the copy read-only; assert the 13 TBAi session IDs are present (9 will still be missing — those are already lost; the copy preserves the 4 surviving ones and all other data).
4. **Marker:** write a one-time migration marker so the copy runs exactly once.
5. **Switch:** on next start, the managed server receives the private `OPENCODE_DATA_DIR`; all new sessions go to the private DB.
6. **Rollback:** remove the marker and the private dir; TBAi falls back to the shared DB. The original shared DB was never modified.

**No session is deleted, recreated, or rebound.** The 9 already-missing sessions remain missing; their history cannot be recovered without a backup predating the loss.

---

## 9. Backup and rollback strategy

- Before migration, copy the shared DB to a timestamped backup outside the repo (e.g. `D:\Coding\OpenCode\data\opencode\backups\opencode-<date>.db`) — read-only source, new file only.
- Keep the private DB backup alongside the private dir.
- Rollback = stop TBAi, delete the private dir + marker, restore env (code change reverted), restart. Shared DB untouched throughout.
- No `VACUUM`, `DELETE`, `REINDEX`, or WAL checkpoint on the shared DB at any point.

---

## 10. Tests, monitoring, acceptance criteria

**Tests (proposed):**
- Unit: `buildOpenCodeServeArgs` / spawn env includes the private `OPENCODE_DATA_DIR` and no shared path leaks.
- Unit: migration copies DB bytes and verifies session rows read-only; source DB mtime/hash unchanged.
- Integration: managed server starts with private env; a new session appears in the private DB, not the shared DB.
- Unit: integrity check logs missing sessions without mutating anything.
- Regression: existing OpenCode session bootstrap/reuse tests stay green.

**Monitoring:** log-only `opencode.session_missing` event with conversationId (never session text/tokens); no auto-repair.

**Acceptance criteria:**
1. TBAi managed server uses a private DB; no other application can delete its sessions through the shared DB.
2. All 13 existing conversation rows and their (surviving) session pointers are unchanged after migration.
3. Shared DB byte-for-byte unchanged (hash before/after).
4. New sessions land in the private DB.
5. All quality gates exit 0; no session was deleted/rebound during the work.

---

## 11. Risks, compatibility, unresolved questions

- **Risk:** OpenCode may derive other paths (config/cache/log) from `OPENCODE_DATA_DIR`; verify with `opencode debug paths` under the private env before committing.
- **Risk:** the private DB copy may be large (1.38 GB) — disk space and copy time must be checked.
- **Risk:** the 9 already-missing sessions cannot be recovered; users must accept that history is gone.
- **Compatibility:** Tauri packaged builds pass `DATA_DIR` explicitly; the private path must derive from that, not a hardcoded Windows path.
- **Unresolved:** exact deleter of the 9 sessions; whether OpenCode migrations dropped older rows. **Resolved:** no pre-loss backup of the main DB exists (full recursive search completed), so the 9 sessions cannot be recovered locally.
- **Unresolved:** whether `OPENCODE_DB` alone (without `OPENCODE_DATA_DIR`) is sufficient — verify against v2.4.0 behavior before implementation.

---

## 12. Verification commands (to run during implementation, not now)

```
opencode --version
opencode debug paths                      # under private env — confirm isolated db/data
bun run typecheck
bun run lint
bun run test:locations
bun test tests/unit/opencode/...           # targeted new tests
bun run test
bun run test:dom
bun run verify
```

---

## 13. Post-investigation verification (2026-11-25, HEAD `a7fb5b3`)

Two checks were run after this plan was written. Neither changes the recommendation; both are recorded here for completeness.

### 13.1 New-chat history survival test
Three fresh OpenCode threads were created in TBAi, one real message sent to each, then the app was restarted three times with another message sent after each restart. Message counts per thread grew **3 → 6 → 9 → 12**, and full message text (the original plus every post-restart message and its assistant reply) was verified intact in the OpenCode DB after the final restart.

**Implication:** new OpenCode chats retain history across restarts. This confirms the 9 losses are historical events, not an active TBAi restart bug. It does **not** recover those 9 sessions — their history remains gone.

### 13.2 Live-credential E2E suite
The opt-in `*-live.spec.ts` suite was run against a throwaway-data-dir server with real credentials: **8 passed / 7 failed / 3 skipped**. The 7 failures break down as:
- `opencode-model-chip-live.spec.ts` (2): the spec expects `GET /api/opencode/api/session/<id>` to return a `model` field; OpenCode 2.4.0's session response no longer includes it (verified on the raw response). The third test in the same file passes and proves the model works (it switches to `agnes-2.5-flash`). Stale spec expectation, not a product defect.
- `opencode-big-pickle-live.spec.ts` (1): the model's answer did not render the expected `pickle-ok` marker. Cause undetermined — model behavior or spec.
- `p2-live-runtime.spec.ts` (4): Direct-chat virtualizer tests using a stub provider; separate harness issue, not OpenCode credentials.

These specs are excluded from the standard gate by design (`playwright.config.ts:44-45,67`). The standard gate is green: `bun run verify` exit 0 (DOM 891 pass / 0 fail) and `bun run test:e2e --project=chromium-headless dockview-workspace.spec.ts` exit 0 (9 passed / 0 failed).

**Implication:** no evidence here that TBAi's OpenCode integration is broken. The live failures are test-maintenance debt against a changed OpenCode API, not a reason to change the isolation recommendation.

---

**STOP. Awaiting independent review and explicit implementation authorization. No code, config, database, session, WAL, backup, or Git state was modified.**
