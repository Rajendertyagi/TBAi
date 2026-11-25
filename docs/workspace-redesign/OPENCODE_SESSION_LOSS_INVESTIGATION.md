# OpenCode Session Loss — Investigation and Future-Reliability Plan (Revised)

**Status:** INVESTIGATION + PLAN ONLY. No implementation authorized.
**Date:** 2026-11-25 (revised after independent review and owner architecture direction)
**Branch / HEAD:** `ui-foundation-upgrade` @ `430c102` (local HEAD matches `git ls-remote origin refs/heads/ui-foundation-upgrade`)
**Mode:** documentation and investigation only. No source code, configuration, database, session, WAL, backup, or Git state was modified by this revision. Database reads used `bun:sqlite` with `{ readonly: true, strict: true }`; the credential query selected metadata columns only and never read or printed the secret value.

> **Architecture correction (owner direction, mandatory).** The previous revision recommended a private TBAi OpenCode database via `OPENCODE_DB`, a `VACUUM INTO` snapshot, and isolation from other clients. **That direction is reversed.** TBAi must continue using the **shared OpenCode database** so that conversations created by OpenCode CLI, desktop, and other clients remain discoverable and importable. No private DB, no `OPENCODE_DB` override, no database copy/migration, and no disabling of other OpenCode clients. Historical recovery is out of scope. This document preserves the historical investigation as background evidence and replaces the prevention plan with a **future session-storage, discovery, import, and lifecycle reliability plan** on the shared database.

---

## 1. Executive summary

Nine TBAi Code conversations point to OpenCode sessions that are absent from the shared OpenCode database. The historical loss remains **unexplained** — no successful session DELETE appears in the available log, no pre-loss backup exists, and no legacy session rows remain. Recovery is **out of scope** and is not proposed.

The product requirement is the opposite of isolation: TBAi must keep sharing the OpenCode database so external sessions can be discovered and imported. The reliability work is therefore about **how TBAi touches that shared database**, not about separating it:

- **Session persistence** — TBAi's own sessions survive restarts, crashes, and normal shared-DB activity.
- **External discovery** — unarchived sessions created by any OpenCode client appear in `/api/opencode/importable`.
- **Import reliability** — importing binds a TBAi conversation to the existing session without copying, duplicating, or modifying its messages.
- **Ownership safety** — visibility or importability never implies ownership; service-owner checks gate every history read.
- **Deletion safety** — only the exact session a request observed can be removed, with a durable marker and late ownership re-check.
- **Concurrency safety** — singleflight, caller-supplied idempotent IDs, and atomic journal operations prevent races.
- **Restart recovery** — durable intents, orphan records, and recovery passes settle interrupted work.
- **Upgrade compatibility** — official V2 schema/migration handling is used; no V1 compatibility is retained by TBAi.

The current implementation already contains most of these safeguards. The plan is to **verify them with targeted regression tests and close the specific gaps identified below**, not to redesign the storage layer.

---

## 2. Evidence categories (per `docs/PROJECT_MANAGER_PROTOCOL.md` §7)

| Category | Content in this report |
|---|---|
| **Independently verified through GitHub** | Remote branch HEAD `430c102` matches local HEAD (`git ls-remote`). The pushed report at that commit is the review source of truth. |
| **Verified through repository implementation (this session)** | All `src/...` and `tests/...` file/line references in §4–§8 were read directly from the checkout at `430c102`. |
| **Agent-reported workstation evidence (not independently re-checked by the owner)** | The nine missing session IDs, DB file sizes, log counts, credential metadata, and legacy-table absence in §3. These were measured on this workstation by the agent; the owner has not independently re-run the queries. |
| **Verified through CI results** | None in this revision. No tests were run for this documentation task. |
| **Not verified / unresolved** | Exact deleter of the nine sessions; historical recoverability; live-credential E2E failures; Tauri zoom on the owner's machine. |

Nothing in this report claims a test passed based on source inspection alone, and nothing claims historical loss is explained.

---

## 3. Historical investigation (background evidence — recovery out of scope)

### 3.1 Verified facts (agent-reported workstation evidence)
- Installed OpenCode CLI/server: **v2.4.0**; binary `D:\Coding\OpenCode\opencode.exe`.
- Shared DB: `D:\Coding\OpenCode\data\opencode\opencode.db` — 1428.98 MB, WAL 17.11 MB, SHM 0.06 MB.
- Global env: `XDG_DATA_HOME=D:\Coding\OpenCode\data`, plus `OPENCODE_CONFIG_DIR`, `OPENCODE_CACHE_DIR`, `OPENCODE_LOG_DIR`. `OPENCODE_DATA_DIR` is set in the process environment but is **not read by OpenCode v2.4.0** (`packages/util/src/global-roots.ts` lines 5–17). `OPENCODE_DB` controls the DB filename (`packages/cli/src/database-path.ts` lines 5–12; official docs "Paths").
- `opencode debug paths` reports one shared `db`/`data`/`config`/`log`/`repos` set for all clients.
- **Current re-check:** 12 TBAi conversations carry an `opencode_session_id`; **9** are absent from `session_v2`, `session_message`, `session_part`, `session_inbox`, and `event_sequence`. The original report counted 13; one conversation is no longer present. The nine missing IDs are unchanged:

| Conversation | Session ID |
|---|---|
| `oesuw589pu4637t85eagalwb` | `ses_e6a2dcc10ffeL5io2REP8c3Hb9` |
| `eai85ln115h78enpw8puwdf5` | `ses_e7c1461feffeZgaFNds078D78U` |
| `xl1k0nqaa6i5684ij078j6h4` | `ses_e82cfac81ffeUGix3f2NBQoC5v` |
| `sx82n8y7aoomkcr02njhfn8o` | `ses_jiksokgbv3byazpyk4a22r3c` |
| `n2f61g5wd3lo2jf25c5q1jzw` | `ses_df135d5f7ffeAyttFTnmv8Kzrk` |
| `wyehlzn5ep2ve8ohituiiwn8` | `ses_e3b895177ffemRx7qgr0yapUDc` |
| `bqkb1bzyvv3i3eb75r1mey6e` | `ses_e3b845bfcffe7L1pyeSTp91No1` |
| `yz22unniiw0mjpmsrlhi2g3s` | `ses_df3801325ffeybzeyGemiD0952` |
| `czbaorxu0374et6rx1yehmra` | `ses_df135f049ffefJM0Rx0yJhx1Fh` |

- OpenCode log: **0** successful session DELETEs; **48** DELETEs returning 404 (bulk sweep on Nov 17 for `ses_f2…` IDs, unrelated to the missing IDs). The missing IDs appear only as TBAi GET probes returning 404.
- The current DB has **no** legacy `session`, `message`, or `part` tables, no `opencode-next.db`, and no `migration.v1-v2` KV key. The `migration` table contains only schema migrations. No legacy rows exist for the nine IDs.
- No pre-loss backup of the main DB exists (full recursive search of `D:\Coding\OpenCode` completed earlier).
- A fresh session survived 37 seconds of observation and an application restart; a later test grew three threads from 3 → 6 → 9 → 12 messages across three restarts with full text intact.

### 3.2 Hypotheses (not proven)
- Another application sharing the DB deleted the sessions via the HTTP API or direct DB access. The bulk `ses_f2…` sweep shows at least one client performs bulk deletion, but those IDs are not TBAi's.
- An OpenCode version upgrade/migration between Nov 1–15 dropped older-format rows. The legacy tables are now absent, so this cannot be confirmed or refuted from the current DB.
- Manual cleanup removed them. No evidence in available logs.

### 3.3 Unknowns
- The exact process and timestamp that removed each of the nine sessions.
- Whether the legacy tables were dropped by a completed V1→V2 migration or never existed in this DB.

**Decision:** historical recovery, backup restoration, and V1 compatibility are **out of scope**. The shared DB stays in the current supported V2 format and OpenCode's official migration mechanism is left to OpenCode.

---

## 4. Current implementation audit (verified repository evidence)

### 4.1 External session discovery — `src/routes/opencode.ts:671-697`, `src/services/opencode/import.ts:166-267`
`GET /api/opencode/importable` calls `listImportableOpenCodeSessions`, which:
- resolves the active runtime target and its history owner (`import.ts:169-171`);
- calls `client.session.list()` (`import.ts:204-208`) — the official `GET /api/session` endpoint, which lists sessions across the shared DB;
- filters out archived sessions and sessions already imported for the active service owner (`import.ts:211-216`);
- enriches results with project names, first-prompt previews, and VCS branches (`import.ts:182-231`);
- returns cursor pagination (`import.ts:259-266`).

**Corrected claim:** the previous report stated that unrelated sessions are "present on disk but not surfaced." That is **false**. Every unarchived, not-yet-imported session from **every** OpenCode client on the shared DB is deliberately surfaced as importable. This is the required product behavior, not a leak. Future external sessions appear automatically because TBAi remains on the shared DB — no snapshot or re-scan is needed.

### 4.2 Import — `src/services/opencode/import.ts:277-363`
`importOpenCodeSession`:
- validates `sourceRef` freshness (mode, origin, target instance) (`import.ts:282-297`);
- rejects duplicates via `findByOpenCodeSession(serviceOwner, sessionId)` (`import.ts:302-308`);
- fetches authoritative session metadata with `client.session.get()` and maps 404 to `OpenCodeImportedSessionMissingError` (`import.ts:310-324`);
- rejects archived sessions (`import.ts:326-328`);
- creates a TBAi conversation with `opencodeImported: true`, the recorded service owner, directory, agent, and model (`import.ts:336-348`);
- **does not copy message history** — the conversation binds to the existing session, so original messages are untouched;
- handles a concurrent-import UNIQUE violation by looking up the winner and returning `OpenCodeSessionAlreadyImportedError` (`import.ts:350-361`).

### 4.3 Session persistence — `src/services/opencode/sessions.ts:846-1362`
- `ensureOpenCodeSession` uses a per-conversation singleflight map so concurrent callers share one ensure and merge permissions most-restrictively (`sessions.ts:850-876`).
- A live stored session is reused; its directory and compatible service owner are refreshed, and a missing model is repaired (`sessions.ts:910-951`).
- An imported conversation whose session is gone throws `OpenCodeImportedSessionMissingError` and **never** silently creates a replacement (`sessions.ts:954-972`).
- A non-imported stale pointer is logged and recreated (`sessions.ts:957-964`).
- Creation mints a caller-supplied ID, writes a durable intent **before** `session.create` (fail-closed), and relies on OpenCode's verified idempotency for that ID (`sessions.ts:989-1055`, `1192-1361`).
- A persist failure is verified before any compensation: `bound` keeps the session, `unknown` records an orphan without deleting, `unbound` compensates only after confirmation (`sessions.ts:1071-1180`).

### 4.4 Ownership safety — `src/services/opencode/historyBoundary.ts`
- Two scopes: `local` and `remote:<canonical-origin>` (`historyBoundary.ts:1-24`).
- `assertSameHistoryOwner` refuses a history read when the recorded owner differs from the active one (`historyBoundary.ts:332-346`).
- `filterRecoveryCandidatesByOwner` skips remote-owned, incompatible, and unreadable owner records — they are never probed through the managed client (`recovery.ts:240-259`).
- The proxy authorizes every session-scoped request against the local DB before forwarding (`src/routes/opencode.ts:790-822`).

### 4.5 Deletion safety — `src/services/opencode/conversationDeletion.ts`, `sessions.ts:525-573`
- A durable delete marker is armed **before** the first decision read (`conversationDeletion.ts:67-94`).
- `terminateSessionForConversationDeletion` refuses before any remote call unless the row still matches the exact session observed at entry (`sessions.ts:540-545`).
- A rebind during the request yields `409 session_rebound` and preserves the row (`conversationDeletion.ts:98-100`, `215-227`).
- Removal is confirmed by a follow-up lookup; `session_not_found` counts as already gone (`sessions.ts:486-508`).
- Unconfirmed removal keeps the durable marker and still deletes the conversation (documented Option A) (`conversationDeletion.ts:157-188`).
- **Official API caveat:** `DELETE /api/session/{sessionID}` deletes the session **and its child sessions** (`https://opencode.ai/docs/api/` → `session.remove`). TBAi's import path allows child sessions to be imported independently (`import.ts:274-275`), so deleting a parent conversation can remove an externally created child session that TBAi also references. This is a real risk requiring a safeguard (§5, §7).

### 4.6 Orphan reconciliation — `src/services/opencode/orphanReconciler.ts`
- A bare 404 never clears a risk-bearing row; an absence horizon (24 h) bounds retention (`orphanReconciler.ts:97-107`, `156-165`).
- Ownership is re-checked immediately before removal, so a pointer that appeared during the probe wins (`orphanReconciler.ts:65-67`, `276-318`).
- Delete markers are settled as audit rows, not silently dropped (`orphanReconciler.ts:334-363`).

### 4.7 Restart recovery — `src/services/opencode/recovery.ts`
- Recovery candidates are owner-filtered before any managed-client probe (`recovery.ts:240-259`).
- Durable state distinguishes unfinished from completed sessions; pending prompts are re-submitted with original IDs; synthetic IDs are reused; sessions that 404 are skipped safely (tests in `tests/integration/opencode/opencode-restart-reconstruction-p0.test.ts:239-400`).

### 4.8 Concurrency — `tests/unit/opencode/sessions-concurrency.test.ts:144-189`
- Two concurrent first-session calls create exactly one session and share its ID.
- Different permission shapes merge to the most restrictive set, including permissions merged after the initial snapshot.

### 4.9 Upgrade compatibility — `src/services/opencode/compatibility.ts`
- Capability probing, version classification, and wire-structure validation gate essential capabilities (`compatibility.ts:111-147`, `221-304`, `356-374`, `421-465`).
- `tests/integration/opencode/opencode-database-compat.test.ts:135-198` proves a real session and history survive a snapshot/reopen on the same binary with no destructive migration.
- TBAi retains no V1 tables or V1 compatibility code; OpenCode's official V2 migration is authoritative.

### 4.10 Proxy boundary — `src/routes/opencode.ts:755-993`
- An allowlist (`services/opencode/proxyRoutes.ts`) forwards only routes the browser client calls; shell, filesystem, credentials, config writes, RPC, MCP, and PTY are refused before any upstream request (`opencode.ts:774-788`).
- Caller-supplied directory and session headers are stripped; the server's own directory scope is injected (`opencode.ts:824-878`).

### 4.11 Verification evidence — code paths and tests

Every safeguard claimed above is tied to a file/line and an existing test. These were read directly from the checkout at `430c102`; **no test was executed for this documentation task**, so they are evidence of coverage, not a claim that the suite passed now.

| Safeguard | Code path | Existing test (assertion) |
|---|---|---|
| Concurrent first-session dedupe | `sessions.ts:850-876` (per-conversation singleflight) | `tests/unit/opencode/sessions-concurrency.test.ts:145-158` — `createCalls` is 1 and both callers share the ID; comment records "RED before fix: 2" |
| Most-restrictive permission merge | `sessions.ts:858-863`, `1231-1239` | `sessions-concurrency.test.ts:162-184` — one create, `edit`/`shell` effects `deny` |
| Late permission merge before dispatch | `sessions.ts:1231-1239` | `sessions-concurrency.test.ts:189-204` — restrictions joined after snapshot are present at create |
| Durable intent before create (fail-closed) | `sessions.ts:1045-1055`, `585-626` | `tests/unit/opencode/rt001RiskLifecycle.test.ts`, `tests/unit/opencode/session.test.ts` |
| Idempotent caller-supplied ID / retry | `sessions.ts:989-990`, `1192-1361` | `tests/integration/opencode/opencode-session-idempotency-runtime.test.ts` |
| Persist failure verified before compensation | `sessions.ts:1071-1180` | `tests/unit/opencode/session.test.ts`, `tests/unit/opencode/rt001RiskLifecycle.test.ts` |
| External session discovery | `import.ts:166-267`, `routes/opencode.ts:671-697` | `tests/unit/opencode/import.test.ts:335-398` — a session created outside TBAi is discovered, imported, identity/metadata preserved, `storedMessages` is `[]`, and it disappears from the importable list after import |
| Duplicate import rejected | `import.ts:302-308`, `350-361` | `import.test.ts:434-459`; `tests/integration/opencode/session-import-e2e.test.ts:284-327` (409 + conversationId) |
| Imported session 404 never recreated | `sessions.ts:954-972` | `session-import-e2e.test.ts:482-508` — throws `OpenCodeImportedSessionMissingError`, pointer unchanged |
| Native stale pointer still recreates | `sessions.ts:957-964` | `session-import-e2e.test.ts:510-535` |
| Deletion marker armed before first read | `conversationDeletion.ts:67-94` | `tests/integration/opencode/conversation-deletion.test.ts:193-228` — trigger clears pointer on arm; result 200, `sessionCleanup: "retained"`, no remote call |
| Entry-snapshot match / rebind refusal | `sessions.ts:540-545`, `conversationDeletion.ts:98-100` | `conversation-deletion.test.ts:245-306` — engine change and pointer change both yield 409, row preserved, no remote call |
| Journal failure preserves row | `conversationDeletion.ts:81-93` | `conversation-deletion.test.ts:308-332` — 503, nothing deleted, no remote call |
| Unconfirmed removal retains marker | `conversationDeletion.ts:157-188` | `conversation-deletion.test.ts:361-389` — 200, marker retained, session still present |
| Rebind during in-flight removal | `conversationDeletion.ts:215-227` | `conversation-deletion.test.ts:391-411` — 409 after a real create rebinds S2 |
| Late ownership re-check | `orphanReconciler.ts:276-318` | `tests/unit/opencode/orphanReconciler.test.ts:353-370`, `371-423`, `424-484` — a pointer written during the probe prevents removal; current durable risk wins |
| Bare 404 not terminal for risk-bearing rows | `orphanReconciler.ts:97-107`, `156-165` | `orphanReconciler.test.ts:607-682` — risk-free intent cleared on 404, risk-bearing retained until the 24 h horizon |
| Owner-filtered restart recovery | `recovery.ts:240-259` | `tests/integration/opencode/opencode-restart-reconstruction-p0.test.ts:309-326` (unfinished vs completed), `328-345` (same-ID repost, no duplicate), `347-370` (synthetic ID reused), `400-403` (404 sessions skipped) |
| V2 DB compatibility across restart | official V2 migration; no TBAi V1 code | `tests/integration/opencode/opencode-database-compat.test.ts:135-196`, `198-258` — same session ID, identical message content, no table removed, no row vanished |

**Two documented limitations found in the restart tests (not defects introduced by this plan):**
- `opencode-restart-reconstruction-p0.test.ts:320-325` — plain `opencode serve` does not persist lifecycle events; after restart `session.log` replays no durable events except the synced marker. Recovery relies on durable session/inbox state, not an event log.
- `opencode-restart-reconstruction-p0.test.ts:372-387` — `session_inbox.enqueued_seq` exists in the DB but is not exposed by the public inbox schema; the test reads it directly to prove ordering. The production service cannot use that column through the public API.

**Test-harness note:** `opencode-database-compat.test.ts:136-140,199-203` sets `XDG_DATA_HOME` and `OPENCODE_DB` to isolate a disposable test server. That is test isolation only; it does **not** imply TBAi should use a private DB in production.

---

## 5. Risks and safeguards for the eight reliability requirements

| # | Requirement | Current safeguard | Gap / proposed safeguard |
|---|---|---|---|
| 1 | Session persistence | Durable intent before create; idempotent caller-supplied ID; verified reuse; imported sessions never recreated | Add a regression test for restart-after-import and OpenCode restart while TBAi is running (§8) |
| 2 | External discovery | `/importable` lists all unarchived shared-DB sessions via `session.list()` | Document explicitly that external sessions are intentionally visible; test that a session created outside TBAi appears (§8) |
| 3 | Import reliability | `sourceRef` freshness, duplicate check, authoritative `session.get()`, no message copy, UNIQUE race handling | Test re-import and message-history preservation explicitly (§8) |
| 4 | Ownership safety | `assertSameHistoryOwner`, owner-filtered recovery, proxy authorization | Test that a visible/importable session is not treated as owned before import (§8) |
| 5 | Deletion safety | Entry snapshot, durable marker, late ownership re-check, confirmed removal (§4.5, §4.11) | **Gap confirmed:** no TBAi code checks `parentID` before `session.remove` — the only `parentID` uses are in import listing (`import.ts:26,214,241,252`). Official `session.remove` deletes the session **and its children**. **Fail-safe policy (owner direction):** TBAi must **refuse deletion** whenever the OpenCode operation could remove any child session that is not **exclusively owned by the TBAi conversation being deleted**. "Exclusively owned" means the child is bound to that same conversation and to no other TBAi conversation and no external owner. On refusal, the conversation row and all shared sessions are preserved and the user receives an explicit error; no partial teardown is attempted. |
| 6 | Concurrency | Per-conversation singleflight; atomic journal settlement; idempotent IDs | Test concurrent use by multiple OpenCode clients against the shared DB (§8) |
| 7 | Restart recovery | Durable intents, orphan records, owner-filtered recovery passes | Test interrupted import and DB write failure (§8) |
| 8 | Upgrade compatibility | Capability probing, wire validation, official V2 migration | Test V2 schema migration without breaking discovery/import (§8) |

---

## 6. Lifecycle rules (proposed, to be confirmed)

| Session state | Rule |
|---|---|
| Created by TBAi | TBAi owns it; durable intent before create; pointer + service owner written atomically; may be terminated only on explicit conversation deletion with entry-snapshot match |
| Created externally | Not owned by TBAi; visible in `/importable`; never probed, modified, or deleted by TBAi until imported |
| Imported into TBAi | Bound by a TBAi conversation with `opencodeImported: true`; messages remain in OpenCode; a missing session is reported, never recreated |
| Linked to multiple TBAi conversations | **Not supported today** — the UNIQUE constraint on `(serviceOwner, sessionId)` rejects a second import. Keep this rule; do not add multi-link without an explicit decision |
| Becomes unavailable or deleted externally | Imported conversation reports `OpenCodeImportedSessionMissingError`; native conversation with a stale pointer recreates only if not imported; no auto-repair of imported history |
| TBAi conversation deleted by user | Durable marker armed first; only the exact observed session is removed; rebind yields 409; unconfirmed removal retains the marker. **Fail-safe child rule:** if the session has any child not exclusively owned by this conversation, refuse the deletion entirely — preserve the row and every shared session, return an explicit error, and attempt no partial teardown (§5) |

**Non-destructive default:** a disappearing TBAi reference never authorizes deleting a shared OpenCode session. Any intentional deletion requires verified ownership and the documented user-facing behavior above. Existing deletion semantics are **not changed** by this plan except for the child-session fail-safe, which is a refusal rule (§5/§7) and is not implemented here.

---

## 7. Proposed implementation tasks (dependency order — not authorized)

1. **Document the shared-DB architecture decision** in `docs/decisions.md`: no private DB, no `OPENCODE_DB` override, no snapshot, no disabling other clients; external import is a required capability.
2. **Child-session deletion fail-safe** (§5 gap): before any `session.remove`, determine whether the target session has children (official `GET /api/session` supports `parentID`). If any child is not exclusively owned by the TBAi conversation being deleted, **refuse the deletion** — preserve the conversation row and all shared sessions, return an explicit error, and attempt no partial teardown. Add a regression test that seeds an externally created child and proves the refusal leaves both parent and child untouched. This is a fail-safe rule, not a confirmation prompt; no owner decision on alternative behavior is pending.
3. **Regression tests** from §8, written before any behavior change where practical, each proven able to fail against the defect it guards.
4. **Log-only integrity signal** for imported sessions that 404 (no repair, no rebind, no delete), using the existing logger contract.
5. **Verification** of the full gate (`bun run verify`, `test:locations`, `test:dom`, targeted e2e) with exact commands and exit codes recorded.

No change to the shared DB path, no new database, no credential handling, no filesystem-permission change, and no change to the Direct/OpenCode runtime boundary.

---

## 8. Regression-test strategy (required)

Each test must verify both the expected behavior **and** that unrelated shared sessions remain untouched.

| Test | Assertion |
|---|---|
| Import an externally created session never opened in TBAi | Appears in `/importable`; import creates a conversation bound to the same session ID; message count and text unchanged |
| Import the same session again | `409 OpenCodeSessionAlreadyImportedError` with the existing conversation ID; no second conversation; no message duplication |
| Restart TBAi after importing | Imported conversation still resolves to the same session; history loads through the proxy; no replacement session created |
| Restart OpenCode while TBAi is running | Stale-pointer path logs and recreates only for non-imported conversations; imported conversation reports missing, never recreates |
| Concurrent use by multiple OpenCode clients | Both clients' sessions remain visible and independent; TBAi's singleflight creates exactly one session for one conversation; no cross-deletion |
| TBAi conversation deletion | Only the exact observed session is removed; a rebound pointer yields 409; unrelated shared sessions unchanged. **Fail-safe child test:** seed an externally created child of the target session; deletion is refused, the conversation row remains, and both parent and child sessions are still present and unmodified |
| External session deletion | Imported conversation reports missing; no auto-recreate; other sessions untouched |
| Interrupted import / DB write failure | Durable intent/orphan record retained; no half binding; reconciler settles without deleting unrelated sessions |
| Stale session references and reconciliation | Late ownership re-check wins; a bare 404 does not clear a risk-bearing row; unrelated sessions untouched |
| OpenCode upgrades and V2 schema migration | Discovery and import still work after an official V2 migration; no V1 compatibility code in TBAi; no destructive migration performed by TBAi |

Existing coverage to extend rather than duplicate: `tests/unit/opencode/import.test.ts`, `tests/unit/services/opencode/import-preservation.test.ts`, `tests/integration/opencode/session-import-e2e.test.ts`, `tests/integration/opencode/conversation-deletion.test.ts`, `tests/unit/opencode/sessions-concurrency.test.ts`, `tests/unit/opencode/orphanReconciler.test.ts`, `tests/integration/opencode/opencode-restart-reconstruction-p0.test.ts`, `tests/integration/opencode/opencode-database-compat.test.ts`.

---

## 9. Acceptance criteria

1. **Import-list behavior:** `/api/opencode/importable` returns unarchived, not-yet-imported sessions from all OpenCode clients on the shared DB; archived and already-imported sessions are excluded; future external sessions appear without any TBAi-side rescan or snapshot.
2. **Credential handling:** no database copy is performed, so no credential is copied, exposed, or modified by TBAi. The single shared-DB credential row was inspected by metadata only (`integration_id=opencode`, `label=RT`, `connector_id=null`, `method_id=null`, `active=1`); the secret value was never read or printed. **Owner approval is required** for this "no copy, no credential change" treatment before implementation.
3. **Filesystem permissions:** no new private database or directory is created, so no new ACL/permission requirement arises. Verified fact: TBAi creates `DATA_DIR` with `fs.mkdirSync(DATA_DIR, { recursive: true })` and **no explicit mode** (`src/db/index.ts:23`), so owner-only protection is **not** currently asserted. Any future private storage would require an explicit mode/ACL and a verification test; none is proposed here.
4. **Environment consistency:** TBAi does not set `OPENCODE_DB` or redirect XDG roots; the managed server and `opencode debug paths db` use the same inherited environment. No environment change is proposed.
5. **Source preservation:** TBAi performs no snapshot, copy, `VACUUM`, `DELETE`, `REINDEX`, or WAL checkpoint on the shared DB. TBAi's only writes are session APIs on session IDs it owns. Concurrent external writes are normal shared-DB activity and are not treated as TBAi writes; no global service is disabled and no other application is stopped.
6. **Migration idempotency:** no TBAi-side migration exists to make idempotent. OpenCode's official V2 migration remains authoritative; TBAi adds no V1 tables or compatibility path.
7. **Rollback:** no persistent data contract changes, so rollback is reverting the code change only; there is no copied database or marker to remove and no shared-DB state to restore.
8. **Reliability:** all ten tests in §8 pass, including the "unrelated sessions untouched" assertion; all quality gates exit 0; no session was deleted, rebound, or duplicated by the work.

---

## 10. Independent-review finding resolution map

| Finding | Resolution |
|---|---|
| **Importable sessions** — false claim that unrelated sessions are not exposed | §4.1 corrects it: all unarchived shared-DB sessions are intentionally importable; §9.1 and §8 tests cover it |
| **Credential handling** — one credential row; never print the secret | §9.2 records metadata only, no copy, and requires owner approval for the treatment |
| **Filesystem permissions** — do not claim owner-only without evidence | §9.3 states the verified `mkdirSync` fact and declines to claim owner-only; no new directory is proposed |
| **Snapshot integrity** — distinguish TBAi writes from concurrent external writes | §9.5: no snapshot; TBAi writes only owned sessions; external writes are normal; no service disabling |
| **Final acceptance criteria** | §9 includes all seven requested categories plus reliability |
| **Mandatory shared-DB architecture** | §1, §5, §7, §9.4 — no private DB, no `OPENCODE_DB`, no copy, no disabling other clients |
| **No historical recovery** | §3.3 decision; §7 contains no recovery task |
| **Eight reliability requirements** | §5 table |
| **Lifecycle rules** | §6 |
| **Required regression tests** | §8 |
| **Substantiate every safeguard with code paths and tests** | §4.11 maps each claim to `src/...:line` and an existing test with its assertion; §4.11 also records two documented restart limitations and the test-only nature of `OPENCODE_DB` in the DB-compat spec |
| **Fail-safe child-session policy** | §5 row 5, §6 lifecycle rule, §7 task 2, §8 deletion test — refuse deletion when any child is not exclusively owned by the conversation being deleted |

---

## 11. Remaining risks and unresolved questions

- **Exact deleter of the nine sessions** — unknown; historical recovery out of scope.
- **Child-session deletion risk** — `session.remove` deletes children and no TBAi code checks `parentID` today. The fail-safe refusal policy is specified in §5/§6/§7/§8; it is **not implemented** and must be tested before any deletion behavior changes.
- **Restart-recovery limitations** — plain `opencode serve` persists no lifecycle events beyond the synced marker, and `session_inbox.enqueued_seq` is not exposed by the public inbox schema (§4.11). Recovery relies on durable session/inbox state, not an event log.
- **Live-credential E2E failures** — 8 pass / 7 fail / 3 skip against OpenCode 2.4.0; failures are stale spec expectations and a stub-provider harness issue, not verified product defects. Not part of the standard gate.
- **Tauri zoom** — cannot be reproduced on this workstation; awaiting owner machine test.
- **Owner confirmation required** — the no-copy credential treatment (§9.2) and the overall plan before any implementation. The child-session behavior is now fixed by the fail-safe rule above and is no longer an open decision.

---

## 12. Verification commands (for implementation, not now)

```
git ls-remote origin refs/heads/ui-foundation-upgrade   # confirm review source
bun run typecheck
bun run lint
bun run test:locations
bun test tests/unit/opencode/... tests/integration/opencode/...
bun run test:dom
bun run verify
```

---

**STOP. Awaiting independent review and explicit implementation authorization. No source code, configuration, database, session, WAL, backup, or Git state was modified by this revision.**
