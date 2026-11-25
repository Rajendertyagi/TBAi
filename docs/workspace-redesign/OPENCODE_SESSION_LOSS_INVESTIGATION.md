# OpenCode Session Loss — Investigation and Prevention Plan (Revised)

**Status:** INVESTIGATION REPORT + PLAN ONLY. No implementation authorized.
**Date:** 2026-11-25 (revised after independent review)
**Branch / HEAD:** `ui-foundation-upgrade` @ `2151ced`
**Mode:** read-only investigation. This revision changed only this report file. No session, database, WAL, backup, TBAi source/config, or Git state was modified. All database queries used `bun:sqlite` with `{ readonly: true, strict: true }`; the one snapshot experiment used a throwaway database in `D:\Coding\OpenCode\user\tmp\opencode`.

> **Correction notice.** The previous revision recommended `OPENCODE_DATA_DIR` as an officially supported OpenCode setting. That was **wrong**: OpenCode v2.4.0 does not read that variable. This revision corrects the environment contract from version-matched source and official docs (§3, §6), completes the legacy-table check (§2, §3), fixes the database-path flow (§6, §7), and reworks the migration strategy (§8, §9). The original investigation findings are preserved. The shared database is **not** presented as the proven cause of the historical losses.

---

## 1. Executive summary

Nine TBAi Code conversations point to OpenCode sessions that are **absent** from the shared OpenCode database at `D:\Coding\OpenCode\data\opencode\opencode.db`. The missing sessions span November 1–24 and multiple session-ID eras. A freshly created session survived 37 seconds of observation **and** an application restart, and TBAi's three session-deletion paths all have ownership guards.

**Confirmed fact:** the nine sessions are gone from every session/message table in the current database, including the legacy tables (§2). **Confirmed fact:** no successful (`HTTP 200`) session DELETE appears anywhere in the available OpenCode log (48 DELETEs, all `404` — already gone). **Unknown:** what removed them. The available log starts 2026-11-15, so deletions of the older sessions (Nov 1–14) predate logging. The exact deleter could not be established from TBAi's or OpenCode's logs.

**Root cause of the loss remains UNKNOWN.** What *is* established is a structural risk: every OpenCode client on this machine — TBAi, OpenChamber, MarketHubTS, ScreenLayoutRust, the OpenCode CLI/desktop, and this agent harness — shares **one** database. Any client with a session ID can delete another client's session through the shared server's `DELETE /api/session/:id`. This is a risk, **not** a proven cause of these nine losses.

**Recommendation (corrected):** give TBAi's **managed server** a private database via the officially supported `OPENCODE_DB` environment variable, set to an absolute path under TBAi's own `DATA_DIR`. Do **not** set `OPENCODE_DATA_DIR` (not a real OpenCode variable), do **not** redirect the XDG roots (that would hide the user's global provider config/credentials from TBAi), and do **not** disable the user's global OpenCode service. TBAi already spawns its own `opencode serve`; only the database path needs redirecting. Existing conversations are preserved by a **WAL-safe `VACUUM INTO` snapshot** of the shared DB into the private path before switching — the source is opened read-only and never modified (§8).

---

## 2. Verified facts, hypotheses, unknowns

### Verified facts
- Installed OpenCode CLI/server: **v2.4.0** (`opencode --version`); binary `D:\Coding\OpenCode\opencode.exe` (file version 1.4.4.0).
- DB path: `D:\Coding\OpenCode\data\opencode\opencode.db` — **1428.98 MB**, WAL **17.11 MB**, SHM 0.06 MB.
- Global env: `XDG_DATA_HOME=D:\Coding\OpenCode\data`, plus `OPENCODE_CONFIG_DIR`, `OPENCODE_CACHE_DIR`, `OPENCODE_LOG_DIR` pointing into the shared `D:\Coding\OpenCode` tree. `OPENCODE_DATA_DIR` is set in the process environment but is **not read by OpenCode v2.4.0** (§3).
- `opencode debug paths` confirms one shared `db`, `data`, `config`, `log`, `repos` for all clients.
- **Current re-check:** 12 TBAi conversations carry an `opencode_session_id`; **9** are absent from `session_v2`, `session_message`, `session_part`, `session_inbox`, and `event_sequence`. The original report counted 13 conversations; one conversation present then is no longer in the table. The nine missing IDs are unchanged and listed in §3.
- The missing sessions' conversation rows date from Nov 1–24; the OpenCode log starts Nov 15.
- OpenCode log: **0** successful session DELETEs; **48** DELETEs returning 404 (bulk sweep on Nov 17 for `ses_f2…` IDs, unrelated to the missing IDs).
- The missing session IDs appear in the log **only** as TBAi GET probes (`/api/session/<id>/message` → 404), never as DELETEs.
- DB schema: `session_message` and `session_inbox` have `ON DELETE CASCADE` from `session_v2(id)` — deleting a session row removes its messages, consistent with missing sessions having 0 messages.
- A fresh session (`ses_def5547e2…`) created during this investigation: present in DB and on server at t+0/2/5/10/20 s, and still present after an app restart (HTTP 200).
- TBAi uses the official `@opencode/client` HTTP client (`src/services/opencode/client.ts:10,68`; `web/src/features/opencode/v2Client.ts:190,205`), not ACP.
- TBAi's three deletion paths: compensation (`sessions.ts:1122`, only on failed pointer write + confirmed unbound), orphan reconciler (`orphanReconciler.ts:703`, with late ownership re-check at `:677-700`), explicit delete (`sessions.ts:1447`, from the delete button). Log showed `orphan_reconciled … removed=0`.
- Official docs: no built-in session auto-pruning/retention (community issues #32630, #16101, #5734 confirm sessions persist indefinitely); `OPENCODE_DB` controls the DB path; `--standalone` runs a private server; `opencode service set disabled true` disables the shared service; `opencode uninstall` never removes session data.
- Official changelog v2.4.0: stored **blobs** (not sessions) are deleted after one week; ACP clients that create-and-close a session may have it removed — TBAi does not use ACP.
- **Legacy-table check (new):** the current DB has **no** `session`, `message`, or `part` tables and no `opencode-next.db`. The `kv` table has no `migration.v1-v2` key; the `migration` table contains only schema migrations. All nine IDs are absent from every V2 session/message/part table. No recoverable history for those IDs remains in this database (§3).
- **Snapshot technique (new):** `VACUUM INTO '<dest>'` succeeds from a `{ readonly: true }` source connection — verified on a throwaway DB. It produces a consistent snapshot without modifying the source (§8).

### Hypotheses (not proven)
- Another application sharing the DB deleted the sessions via the HTTP API or direct DB access. The bulk `ses_f2…` DELETE sweep on Nov 17 shows at least one client performs bulk session deletion, though those IDs are not TBAi's.
- An OpenCode version upgrade/migration between Nov 1–15 may have dropped older-format session rows. The DB was created Nov 2; the log starts Nov 15; no migration log is available. The legacy tables are now absent, so this cannot be confirmed or refuted from the current DB alone.
- A manual cleanup (SQL, `opencode session delete`, or deleting the data directory) removed them. No evidence in available logs.

### Unknowns
- The exact process and timestamp that removed each of the 9 sessions.
- ~~Whether a DB backup exists from before the loss~~ **RESOLVED:** a full recursive search of `D:\Coding\OpenCode` completed. No backup of the main 1.38 GB `opencode.db` exists. The only other DB files are small temp databases (12–421 KB) under `user\tmp` from other tools — none is a copy of the main DB. The 9 lost sessions therefore cannot be recovered from a local backup.
- Whether session *messages* could have disappeared while the session row survived (not observed; cascade suggests the opposite).
- Whether the legacy tables were dropped by a completed V1→V2 migration or never existed in this DB. Either way, no legacy data is present now.

---

## 3. Evidence and source references

### The nine missing session IDs (read-only re-check, current HEAD)
| Conversation | Session ID | `session_v2` | `session_message` | `session_part` |
|---|---|---|---|---|
| `oesuw589pu4637t85eagalwb` | `ses_e6a2dcc10ffeL5io2REP8c3Hb9` | 0 | 0 | 0 |
| `eai85ln115h78enpw8puwdf5` | `ses_e7c1461feffeZgaFNds078D78U` | 0 | 0 | 0 |
| `xl1k0nqaa6i5684ij078j6h4` | `ses_e82cfac81ffeUGix3f2NBQoC5v` | 0 | 0 | 0 |
| `sx82n8y7aoomkcr02njhfn8o` | `ses_jiksokgbv3byazpyk4a22r3c` | 0 | 0 | 0 |
| `n2f61g5wd3lo2jf25c5q1jzw` | `ses_df135d5f7ffeAyttFTnmv8Kzrk` | 0 | 0 | 0 |
| `wyehlzn5ep2ve8ohituiiwn8` | `ses_e3b895177ffemRx7qgr0yapUDc` | 0 | 0 | 0 |
| `bqkb1bzyvv3i3eb75r1mey6e` | `ses_e3b845bfcffe7L1pyeSTp91No1` | 0 | 0 | 0 |
| `yz22unniiw0mjpmsrlhi2g3s` | `ses_df3801325ffeybzeyGemiD0952` | 0 | 0 | 0 |
| `czbaorxu0374et6rx1yehmra` | `ses_df135f049ffefJM0Rx0yJhx1Fh` | 0 | 0 | 0 |

The three surviving sessions (`ses_df38257b6…`, `ses_df3999ad…`, `ses_df3827d8c…`) are present in `session_v2`; one also has 3 messages and 1 part. `session_inbox` and `event_sequence` contain no rows for any of the nine.

### Local machine
| Evidence | Location |
|---|---|
| Shared DB, WAL, creation time | `D:\Coding\OpenCode\data\opencode\opencode.db` (1428.98 MB), `opencode.db-wal` (17.11 MB) |
| Global shared env | `XDG_DATA_HOME`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CACHE_DIR`, `OPENCODE_LOG_DIR` (process environment) |
| Single path set | `opencode debug paths` → one `db`/`data`/`config`/`log`/`repos` |
| Missing sessions | 9 TBAi conversations in `D:\Temp\ai-chat-app\data\chat.db` with `opencode_session_id` absent from all V2 tables |
| No successful deletes | `D:\Coding\OpenCode\data\opencode\log\opencode.log`: 0 DELETE 200, 48 DELETE 404 |
| Cascade deletes | `session_message` / `session_inbox` FK `ON DELETE CASCADE` → `session_v2(id)` |
| Fresh session survives | `ses_def5547e2ffe4dFVnVqcP3Pce3` present in DB + HTTP 200 after restart |
| TBAi deletion guards | `src/services/opencode/sessions.ts:464,1122,1447`; `src/services/opencode/orphanReconciler.ts:677-703` |
| Legacy tables absent | `sqlite_master`: no `session`, `message`, `part`; no `opencode-next.db`; `kv` has no `migration.v1-v2` key |
| DB contents (full copy scope) | `session_v2` 1369, `session_message` 157049, `session_part` 30152, `session_inbox` 38, `project` 225, `credential` 1, `account`/`account_state`/`control_account` 0 |

### Official OpenCode v2.4.0 — exact source references
| Claim | Source |
|---|---|
| Global roots use `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`; **no `OPENCODE_DATA_DIR`** | `packages/util/src/global-roots.ts` lines 5–17 (`https://github.com/anomalyco/opencode/blob/v2.4.0/packages/util/src/global-roots.ts#L5-L17`) |
| DB filename comes from `OPENCODE_DB`; relative overrides resolve under the data dir; `:memory:` verbatim | `packages/cli/src/database-path.ts` lines 5–12 (`.../blob/v2.4.0/packages/cli/src/database-path.ts#L5-L12`) |
| Official docs confirm: "The database path respects the release channel and `OPENCODE_DB`; relative database overrides resolve under the data directory" | `https://opencode.ai/docs/cli/` → "Paths" |
| V1 migration reads legacy `session`/`message`/`part` only when a `session` table exists (`hasLegacySessions`), copies into `session_v2` with `INSERT OR IGNORE`, records state under KV key `migration.v1-v2` | `packages/core/src/database/v1-migration.bun.ts` (`.../blob/v2.4.0/packages/core/src/database/v1-migration.bun.ts#L610-L695`) |
| `--standalone` runs a private server; shared background server is default | `https://opencode.ai/docs/cli/` → "Background service" |
| `opencode service set disabled true` disables shared service | same |
| `opencode uninstall` never removes session data/config/state | same |
| No built-in session retention/auto-pruning | Issues #32630, #16101, #5734 (anomalyco/opencode) |
| v2.4.0 deletes stored **blobs** after one week, not sessions | `https://opencode.ai/changelog` → 2026-11-23 v2.4.0 |
| ACP create-and-close session removal exists (not used by TBAi) | `https://opencode.ai/changelog`; TBAi client confirmed HTTP, not ACP |

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
| **A. Keep shared DB, avoid deletion** | No way to prevent other clients deleting via shared API | N/A | All sessions visible to all apps | Low — no enforcement | Low | Rejected: no supported enforcement |
| **B. Private DB via `OPENCODE_DB` (absolute path under TBAi `DATA_DIR`)** | Official v2.4.0 config; TBAi already controls its managed server's env | Windows/macOS/Linux (env var) | Existing sessions preserved by a WAL-safe snapshot; other apps keep theirs | High — DB-level isolation | Low | **Recommended** |
| **C. Redirect XDG roots (`XDG_DATA_HOME` etc.)** | Official, but hides global config/credentials from TBAi's managed server | High | Would break provider config unless copied | High but disruptive | Medium | Rejected: unnecessary; changes more than the DB |
| **D. Dedicated `--standalone` server** | Official; TBAi already spawns its own managed `opencode serve` | High | Same as B | High | Medium | Already effectively in place; no extra change needed |
| **E. Disable global service (`opencode service set disabled true`)** | Official, but affects every OpenCode client on the machine | High | Unrelated | High | High | Rejected: disrupts the user's global service unnecessarily |
| **F. Session-integrity monitoring / rebind on 404** | TBAi-side only | High | Cannot recover lost history | Medium — detects, does not prevent | Medium | Adjunct only |
| **G. Custom cleanup/backup scripts** | Unsupported | Low | Risky | Low | High | Rejected |

**Recommendation:** **B + F** — a private database for TBAi's managed server via `OPENCODE_DB`, plus a log-only integrity check. Do not touch the XDG roots or the global service.

---

## 6. Corrected architecture and rationale

### 6.1 The actual v2.4.0 environment contract
- `global-roots.ts` derives `data`, `cache`, `config`, `state` from `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` (with `~/.local/share`, `~/.cache`, `~/.config`, `~/.local/state` fallbacks). There is **no `OPENCODE_DATA_DIR`** read anywhere in this implementation.
- `database-path.ts` computes the DB filename from `OPENCODE_DB` (or the release-channel default) and returns `path.resolve(data, filename)`. An **absolute** `OPENCODE_DB` is therefore used verbatim; a relative one resolves under `XDG_DATA_HOME/opencode`.
- Official docs confirm the same contract.

### 6.2 Chosen isolation: database-only via `OPENCODE_DB`
- Set `OPENCODE_DB` to an absolute path under TBAi's own `DATA_DIR`, e.g. `<DATA_DIR>/opencode/opencode.db`, **only in the environment of TBAi's managed `opencode serve` child**.
- Leave `XDG_*` untouched: TBAi's managed server must keep seeing the user's global provider config and credentials, which live in the shared config tree. Redirecting XDG roots would hide them and break OpenCode sessions.
- Do **not** run `opencode service set disabled true`: that would disable the user's global OpenCode service for every client. TBAi already spawns its own server, so it is already independent of the shared service; only the DB path is shared.
- Other OpenCode clients continue using the shared DB — no change to them.
- TBAi's session IDs remain valid because the private DB is a **snapshot** of the shared DB at migration time (§8).
- Add a startup integrity check that **logs only** (never repairs, rebinds, or deletes) when a conversation's session is absent, so future loss is visible without mutating data.

### 6.3 The database-path flow defect (finding 3)
Two different environments are currently used for the same question — "which DB does OpenCode use?":

| Call | Code | Environment used |
|---|---|---|
| Actual managed server | `serverManager.ts:679-708` `createChild()` → `spawn(..., env: { ...process.env, ...authEnv })` at `:698` and `:707` | process env + auth password |
| DB path diagnostic | `serverManager.ts:858` `databaseLease.acquire(binary, serverHomeDir)` → `ownership.ts:157-162` → `resolveOpenCodeDatabasePath()` → `spawn(..., env: { ...process.env })` at `ownership.ts:68` | process env only |

If `OPENCODE_DB` is added only to `createChild`, the diagnostic will report the **shared** DB while the server actually uses the **private** DB. The check and the server would disagree.

**Required fix:** build one child-environment object and pass it to both paths.
1. Add `buildOpenCodeChildEnv(config)` (owner: `src/config/opencode.ts` or a new `src/services/opencode/childEnv.ts`) returning `{ ...process.env, ...authEnv, OPENCODE_DB: <absolute private path> }`. No inline path strings.
2. `createChild()` uses that object for both spawn branches (`:698`, `:707`).
3. Extend `OpenCodeDatabaseOwnershipDeps.resolveDatabasePath` and `resolveOpenCodeDatabasePath(binary, cwd, env, timeoutMs)` to accept the env and spawn `opencode debug paths db` with it (`ownership.ts:68`).
4. Extend `OpenCodeDatabaseLease.acquire(binary, cwd, env)`; pass the same object at `serverManager.ts:858`. `verifyChild` is currently a no-op but should receive the same resolved path for consistency (`:963`).
5. Tests must assert the **same env object** reaches both the server spawn and the diagnostic spawn (§10).

---

## 7. Exact files/components that would need changes (proposed, not implemented)

| File | Change |
|---|---|
| `src/config/opencode.ts` | Named constants for the private DB path and the `OPENCODE_DB` env var name (no inline magic strings). |
| `src/services/opencode/childEnv.ts` (new, or extend `serverManager.ts`) | Single `buildOpenCodeChildEnv(config)` used by both spawn paths. |
| `src/services/opencode/serverManager.ts` | Use `buildOpenCodeChildEnv` in `createChild` (`:698`, `:707`); pass it to `databaseLease.acquire` (`:858`). |
| `src/services/opencode/ownership.ts` | Thread the env through `resolveDatabasePath` / `resolveOpenCodeDatabasePath` (`:53-69`, `:129-132`, `:157-162`). |
| `src/services/opencode/startup.ts` or a new migration module | One-time, read-only-source `VACUUM INTO` snapshot into the private DB path before first managed start; guarded by a marker file. |
| `src/services/opencode/sessions.ts` or a new integrity module | Startup log-only check for conversations whose session is absent (no rebind, no delete). |
| `docs/decisions.md` | ADR recording the isolation decision, the rejected XDG/global-service options, and alternatives. |
| Tests under `tests/unit/opencode/` and `tests/integration/` | Env propagation to both spawn paths, snapshot correctness, source non-mutation, integrity logging. |

No change to `src/services/opencode/sessions.ts` deletion guards, `orphanReconciler.ts`, or the chat route.

---

## 8. Migration strategy (WAL-safe, source read-only)

### 8.1 What a full copy contains — and why it is still the safer choice
The shared DB is 1428.98 MB and contains **1369 sessions**, **157049 messages**, **30152 parts**, **38 inbox rows**, **225 projects**, and **1 stored credential row** (`account`, `account_state`, `control_account` are empty). A full snapshot therefore duplicates every OpenCode client's session history and one credential into TBAi's `DATA_DIR`.

- **Consequence:** ~1.4 GB extra disk, and credential material plus unrelated sessions are present on disk under TBAi's data dir. This is the **same machine and same OS user** — no new trust boundary — but it is real duplication and must be disclosed, not hidden.
- **Why not a selective copy:** TBAi's 12 session pointers reference rows in `session_v2`, with dependent rows in `session_message`, `session_part`, `session_inbox`, `event_sequence`, and `project`. Reconstructing those foreign-key relationships by hand risks breaking referential integrity for the 3 surviving sessions. A full, consistent snapshot is simpler and preserves integrity exactly.
- **How TBAi avoids exposing unrelated sessions:** the private DB lives under TBAi's `DATA_DIR` with owner-only permissions; TBAi exposes no API that lists or serves arbitrary sessions from it — only sessions referenced by TBAi conversations are used. Unrelated rows are present on disk but not surfaced. Pruning them is **not** recommended (integrity risk); the trade-off is documented here.

### 8.2 Consistent snapshot method
1. **Precondition:** TBAi is stopped; no managed server running. Verify no `opencode` child holds the shared DB.
2. **Open source read-only:** `new Database(sharedDb, { readonly: true, strict: true })`.
3. **Snapshot:** `VACUUM INTO '<temp-dest>'`. Verified on a throwaway DB that this works from a readonly source. It produces a consistent, compacted image including committed WAL content and **does not modify the source**. Do **not** raw-copy `opencode.db` + `-wal` + `-shm` while the source is live — that can yield a torn/inconsistent image.
4. **Destination:** must not already exist; write to a unique temp name, then atomically rename to the final private DB path. A crash mid-copy cannot leave a half file that looks complete.
5. **Verify the copy read-only:** assert the 3 surviving session IDs and their message counts are present; assert the 9 missing IDs are still absent (expected — they are already lost).
6. **Source integrity:** hash the source DB before and after; assert unchanged. No `VACUUM`, `DELETE`, `REINDEX`, or WAL checkpoint on the shared DB at any point.
7. **Marker:** write `<privateDir>/.migration-complete` only after verification succeeds. If the marker exists, skip. If a partial copy exists without the marker, delete and retry.
8. **Switch:** on next start, the managed server receives `OPENCODE_DB=<absolute private path>`; all new sessions go to the private DB.
9. **Rollback:** stop TBAi, remove the marker and private dir, revert the env change, restart. The shared DB was never modified.

**No session is deleted, recreated, or rebound.** The 9 already-missing sessions remain missing; their history cannot be recovered without a backup predating the loss.

---

## 9. Backup and rollback strategy

- Before migration, take a timestamped `VACUUM INTO` backup of the shared DB outside the repo (e.g. `D:\Coding\OpenCode\data\opencode\backups\opencode-<date>.db`) — read-only source, new file only.
- Keep a backup of the private DB alongside the private dir.
- Rollback = stop TBAi, delete the private dir + marker, restore env (code change reverted), restart. Shared DB untouched throughout.
- No `VACUUM`, `DELETE`, `REINDEX`, or WAL checkpoint on the shared DB at any point.

---

## 10. Tests, monitoring, acceptance criteria

**Tests (proposed):**
- Unit: `buildOpenCodeChildEnv` includes `OPENCODE_DB` with an absolute private path and leaks no shared path.
- Unit: the **same env object** is passed to `createChild`'s spawn and to `resolveOpenCodeDatabasePath`'s spawn (injectable deps; assert both received `OPENCODE_DB`). This is the regression guard for finding 3.
- Unit: `resolveOpenCodeDatabasePath` returns the private path under the injected env, not the shared path.
- Unit: snapshot copies DB bytes consistently; source DB hash/mtime unchanged; marker written only after verification.
- Unit: integrity check logs missing sessions without mutating anything.
- Integration: managed server starts with private env; a new session appears in the private DB, not the shared DB.
- Regression: existing OpenCode session bootstrap/reuse tests stay green.

**Monitoring:** log-only `opencode.session_missing` event with conversationId (never session text/tokens); no auto-repair.

**Acceptance criteria:**
1. TBAi's managed server uses a private DB via `OPENCODE_DB`; no other application can delete its sessions through the shared DB.
2. The DB-path diagnostic and the actual server report the **same** path under the injected env.
3. All 12 existing conversation rows and their (surviving) session pointers are unchanged after migration.
4. Shared DB byte-for-byte unchanged (hash before/after).
5. New sessions land in the private DB.
6. All quality gates exit 0; no session was deleted/rebound during the work.

---

## 11. Risks, compatibility, unresolved questions

- **Risk:** `VACUUM INTO` on a 1.38 GB DB needs ~1.4 GB free disk and measurable time; check capacity before implementation.
- **Risk:** the private DB duplicates one credential row and 1369 unrelated sessions on disk under TBAi's `DATA_DIR`; permissions and non-exposure must be verified (§8.1).
- **Risk:** `OPENCODE_DB` is read by both the server and `opencode debug paths db`; any code path that spawns OpenCode without the shared env object will silently use the shared DB. The env-threading test (§10) is the guard.
- **Compatibility:** Tauri packaged builds pass `DATA_DIR` explicitly; the private path must derive from that, not a hardcoded Windows path.
- **Unresolved:** exact deleter of the 9 sessions; whether OpenCode migrations dropped older rows. **Resolved:** no pre-loss backup exists, and no legacy tables or legacy rows remain in the current DB, so the 9 sessions cannot be recovered locally (§2, §3).
- **Resolved:** `OPENCODE_DATA_DIR` is not a v2.4.0 setting; the correct mechanism is `OPENCODE_DB` (absolute path) with XDG roots untouched (§6.1).
- **Resolved:** database-only isolation is appropriate; redirecting XDG roots or disabling the global service is unnecessary and disruptive (§5, §6.2).

---

## 12. Verification commands (to run during implementation, not now)

```
opencode --version
opencode debug paths db                 # under the private env — must print the private DB path
bun run typecheck
bun run lint
bun run test:locations
bun test tests/unit/opencode/...         # targeted new tests
bun run test
bun run test:dom
bun run verify
```

---

## 13. Post-investigation verification (2026-11-25, HEAD `a7fb5b3`)

Two checks were run after the original investigation was written. Neither changes the recommendation; both are recorded here for completeness.

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

## 14. Independent review — resolution map

| # | Blocking finding | Where resolved |
|---|---|---|
| 1 | `OPENCODE_DATA_DIR` is not a v2.4.0 setting; use XDG vars and `OPENCODE_DB`; justify DB-only vs full profile isolation; do not disable global service | §3 (source refs), §5 (options C/E rejected), §6.1–6.2, §11 |
| 2 | Check legacy `session`/`message`/`part` tables and V1 migration state for all nine IDs before claiming unrecoverable | §2 (verified facts), §3 (per-ID table, legacy absence, KV/migration state) |
| 3 | `serverManager.ts` resolves DB path before spawn while `ownership.ts` uses `process.env`; thread one child env to both | §6.3, §7, §10 (env-threading regression test) |
| 4 | Full DB copy duplicates other apps' sessions and credentials; choose a WAL-safe snapshot; source integrity, idempotency, rollback, non-exposure | §8.1–8.2, §9, §10 |

---

**STOP. Awaiting independent review and explicit implementation authorization. No code, config, database, session, WAL, backup, or Git state was modified by this revision.**
