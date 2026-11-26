# OpenCode Session Loss — Investigation and Future-Reliability Plan (Revised)

**Status:** IMPLEMENTED AND PUSHED. The plan in §7 was authorized and implemented; this report is now a record of the investigation, the approved design, and its verification.
**Date:** 2026-11-26 (implementation and verification record added)
**Report revision:** `ui-foundation-upgrade` @ `ef13dba` (implementation tip; this report update is committed on top of it).
**Source-code review baseline:** `42ce23c` — the commit whose implementation was audited when the plan was written. The implementation range is `0b603b6..ef13dba` (12 commits).
**Mode:** documentation and investigation only for this report update. No database, session, WAL, or backup state was modified. Database reads used `bun:sqlite` with `{ readonly: true, strict: true }`; the credential query selected metadata columns only and never read or printed the secret value.

**Verification record (agent-reported, not hosted CI):** `bun run verify` exit 0 — **6160 pass / 88 skip / 0 fail** (unit+integration, 6248 tests across 484 files), DOM 891 pass / 0 fail; typecheck, lint, format:check, test:locations and build green. `bun run test:e2e --project=chromium-headless dockview-workspace.spec.ts` 9 passed / 0 failed; `phase-ua-d.spec.ts` 4 passed / 0 failed. GitHub returned no hosted status checks or workflow runs for the tip commit, so these results are local agent-reported evidence, not independently verified by CI.

> **Architecture correction (owner direction, mandatory).** The previous revision recommended a private TBAi OpenCode database via `OPENCODE_DB`, a `VACUUM INTO` snapshot, and isolation from other clients. **That direction is reversed.** TBAi must continue using the **shared OpenCode database** so that conversations created by OpenCode CLI, desktop, and other clients remain discoverable and importable. No private DB, no `OPENCODE_DB` override, no database copy/migration, and no disabling of other OpenCode clients. Historical recovery is out of scope. This document preserves the historical investigation as background evidence and replaces the prevention plan with a **future session-storage, discovery, import, and lifecycle reliability plan** on the shared database.

---

## 1. Executive summary

Nine TBAi Code conversations point to OpenCode sessions that are absent from the shared OpenCode database. The historical loss remains **unexplained** — no successful session DELETE appears in the available log, no pre-loss backup exists, and no legacy session rows remain. Recovery is **out of scope** and is not proposed.

The product requirement is the opposite of isolation: TBAi must keep sharing the OpenCode database so external sessions can be discovered and imported. The reliability work is therefore about **how TBAi touches that shared database**, not about separating it.

**The single durable rule is: TBAi does not automatically delete sessions from the shared OpenCode database.** TBAi can create, read, import and interact with sessions; it leaves remote session deletion to the user in OpenCode. This removes the need for cleanup claims, leases, state machines, and cross-process deletion coordination.

- **Session persistence** — TBAi's own sessions survive restarts, crashes, and normal shared-DB activity.
- **External discovery** — unarchived sessions created by any OpenCode client appear in `/api/opencode/importable`.
- **Import reliability** — importing binds a TBAi conversation to the existing session without copying, duplicating, or modifying its messages.
- **Ownership safety** — visibility or importability never implies ownership; service-owner checks gate every history read.
- **Deletion safety** — **conversation deletion unlinks sessions; it does not delete them.** One ordinary SQLite transaction removes TBAi's local conversation and messages; no remote OpenCode request is part of that operation.
- **Failed creation** — the remote session is kept and logged as an orphan; no compensating remote DELETE.
- **Orphan reconciliation** — diagnostic only; never issues a remote DELETE.
- **Automatic cleanup** — disabled. Orphan sessions remain in OpenCode and appear in TBAi's existing importable list; the user can import or remove them in OpenCode.
- **Upgrade compatibility** — official V2 schema/migration handling is used; no V1 compatibility is retained by TBAi.

This is deliberately smaller than a claim-based design. We accept a small possibility of orphan accumulation rather than risk losing shared conversations; there is no evidence that accumulation is currently a practical problem. No new database tables or migrations are proposed.

---

## 2. Evidence categories (per `docs/PROJECT_MANAGER_PROTOCOL.md` §7)

| Category | Content in this report |
|---|---|
| **Independently verified through GitHub** | Remote branch HEAD `ef13dba` matches local HEAD (`git ls-remote`). The implementation is pushed; this report update is committed on top of it. The source-code review baseline is the earlier `42ce23c`. |
| **Verified through repository implementation (this session)** | All `src/...`, `web/src/...` and `tests/...` file/line references in §4–§8 were read directly from the checkout at `42ce23c`; the later implementation commits are listed in the implementation range above. |
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

### 4.5 Deletion safety — complete audit of all destructive paths

A full-tree search found exactly **two** `client.session.remove(...)` call sites, reached by **four** distinct flows. All four must be changed; fixing only conversation deletion would leave automatic remote deletion elsewhere.

| # | Flow | Call chain | Current behavior |
|---|---|---|---|
| 1 | Conversation deletion | `routes/conversations.ts:510-560` → `conversationDeletion.ts:58-189` → `terminateSessionForConversationDeletion` (`sessions.ts:525-573`) → `removeAndConfirm` (`:565`, `:487`) | Deletes the remote session. `opencodeImported` is absent from the entry snapshot (`:525-529`), so imported external sessions are deleted too. |
| 2 | Orphan reconciliation | `orphanReconciler.ts:703` → `removeUnboundSession` (`sessions.ts:464-472`) → `removeAndConfirm` (`:487`) | Deletes a session whose conversation no longer points at it. |
| 3 | Failed-create compensation | `sessions.ts:1123` → `removeUnboundSession` (`:464-472`) → `removeAndConfirm` (`:487`) | Deletes a session whose pointer write failed verification. |
| 4 | Explicit terminate | `routes/opencode.ts:214` → `terminateOpenCodeSession` (`sessions.ts:1447-1497`) → `client.session.interrupt` (`:1469`) then `client.session.remove` (`:1477`) | Interrupts then deletes the remote session and clears the pointer. **Under the lean policy only `session.remove` is removed; `session.interrupt` is retained** because stopping active work on explicit request is an allowed interaction, not a lifecycle deletion. |

**Confirmed defect in flow 1:** `opencodeImported` is never read anywhere in the deletion chain. An imported conversation — whose session was created by an external OpenCode client and whose messages remain in OpenCode — is terminated exactly like a TBAi-created session.

**Official API caveat (verified in v2.4.0 source):** `DELETE /api/session/{sessionID}` deletes the session **and its child sessions**. `packages/server/src/handlers/session.ts` `session.remove` calls `session.remove(ctx.params.sessionID)` with **no conditional parameters**. `packages/core/src/session.ts` `Session.remove` reads `store.list({ parentID: sessionID })` at delete time and recursively removes every child (`Effect.forEach(children, (child) => result.remove(child.id), { concurrency: 1 })`). There is **no atomic "delete only if no children" operation**. TBAi's import path allows child sessions to be imported independently (`import.ts:274-275`), so deleting a parent can remove an externally created child that TBAi also references.

**Conclusion:** because no atomic conditional-delete exists and all four flows share the same destructive primitive, the only lean and durable safeguard is to **remove remote deletion from all four flows**. The browser cannot reach `session.remove` through the proxy (`proxyRoutes.ts:105-205` has no delete-session route); the risk is entirely backend cleanup.

**Frontend pre-delete step (fifth path, verified):** `web/src/features/chat/state/deleteConversation.ts:61-105` performs, in order: `cancelActiveRun(ref)` (`:62`), `POST /api/opencode/session/terminate` (`:66`), then `DELETE /api/conversations/:id` (`:89`). The terminate endpoint is flow 4 above (`routes/opencode.ts:214` → `sessions.ts:1477`), so **conversation deletion still makes a remote OpenCode request before the local delete**, contradicting the "no remote request" rule. Under the lean policy this pre-delete terminate call must be **removed from the frontend deletion flow**. Stopping active work stays as `cancelActiveRun` (a separate, explicit operation); the shared OpenCode session is not touched by deleting a TBAi conversation.

### 4.6 Orphan reconciliation — `src/services/opencode/orphanReconciler.ts`
- A bare 404 never clears a risk-bearing row; an absence horizon (24 h) bounds retention (`orphanReconciler.ts:97-107`, `156-165`).
- Ownership is re-checked immediately before removal, so a pointer that appeared during the probe wins (`orphanReconciler.ts:65-67`, `276-318`).
- Delete markers are settled as audit rows, not silently dropped (`orphanReconciler.ts:334-363`).
- **Under the lean policy the reconciler becomes diagnostic-only:** it may probe and log, but must never call `removeUnboundSession` / `removeAndConfirm` (`orphanReconciler.ts:703`). The risk/horizon machinery can remain as detection logic; its destructive branch is removed.

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

Every safeguard claimed above is tied to a file/line and an existing test. These were read directly from the source-code review baseline `42ce23c`; **no test was executed for this documentation task**, so they are evidence of coverage, not a claim that the suite passed now.

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

### 4.12 Ownership terminology — five distinct concepts

The report and code must not collapse these into "owner":

| Concept | What it means | Where it lives | Does it grant delete authority? |
|---|---|---|---|
| **Session creator** | The client that called `session.create` — TBAi's managed server or an external OpenCode client | OpenCode session record; not stored by TBAi | No |
| **Shared OpenCode service identity** | Which service scope the history is addressed through (`local` vs `remote:<origin>`) | `conversations.opencodeServiceOwner`; resolved by `historyBoundary.ts:262-289` | **No** — it is a routing/scope key, not proof of exclusive ownership |
| **TBAi conversation association** | A TBAi row points at a session ID (`opencodeSessionId`) | `conversations` table | No — association is not ownership |
| **Permission to interact** | A compatible service owner + an associated conversation allow TBAi to read history and send supported operations | `assertSameHistoryOwner` (`historyBoundary.ts:332-346`), proxy authorization (`routes/opencode.ts:790-822`) | No — interaction permission is narrower than delete authority |
| **Authority to delete** | Verified, exclusive control over the session's lifetime | **Not established by any of the above.** Requires an explicit, separately authorized decision | Only this grants deletion, and the current shared-DB design does not establish it for imported sessions |

**Correction:** `opencodeServiceOwner` must not be treated as proof of exclusive session ownership. It identifies the service scope used to reach the history (`historyBoundary.ts:1-24`, `:220-223`). Two different TBAi conversations, or an external client, can legitimately address the same shared session under the same owner. The previous report's phrases "TBAi owns it" and "exclusively owned" are replaced by the precise concepts above.

### 4.13 Shared-session mutation — allowed vs protected operations

TBAi intentionally interacts with imported sessions; import is a live binding, not a read-only snapshot. The browser's reach is defined by the proxy allowlist (`src/services/opencode/proxyRoutes.ts:105-205`), which is checked against the real client by drift tests.

**Allowed on imported sessions** (content interaction and reads, all already in the allowlist):
- reads: `session.get`, `message.list`, `session.inbox.list`, `session.form.list`, `permission.list`, `event.subscribe`;
- interaction: `session.prompt`, `session.compact`, `session.interrupt`, `session.inbox.cancel`, `session.revert.stage/commit/clear`, `session.form.reply/cancel`, `permission.reply`, `session.switchModel`, `session.switchAgent`.

These mutate the shared session's history or configuration by design. They are permitted because the user imported the session into TBAi to work with it, and OpenCode remains the history owner.

**Protected lifecycle operations** — must not be initiated by TBAi conversation deletion, cleanup, reconciliation, or compensation:
- `session.remove` (delete), `session.move`, `session.fork`, `session.archive`/`unarchive`, `session.update` (title/metadata), `session.environment`, `session.export`, and any bulk deletion.

None of these are in the proxy allowlist today. The only backend caller of `session.remove` from a user-facing flow is the conversation-deletion path (§4.5); the other callers are compensation and orphan cleanup for sessions TBAi itself created (`sessions.ts:487`, `:1477`). The plan keeps protected operations out of the conversation-deletion path for **all** OpenCode sessions (§5, §7).

### 4.14 Why the claim protocol is rejected

The previous revision proposed a durable cleanup claim to coordinate reconciliation, unlinking, and importing. That protocol is logically sound but **unnecessary complexity**: it exists solely to make automatic remote deletion safe. Removing automatic remote deletion removes every race it was designed to solve:

- No remote DELETE means no time-of-check/time-of-use window between validation and deletion.
- No claim table, state machine, expiry, or crash-recovery probing is needed.
- No import or unlink coordination is needed — nothing can delete a session behind their back.
- No journal-retirement hazard — an unresolved row is only a log entry, never an actionable deletion obligation.
- No child-cascade problem — TBAi never calls `session.remove` from cleanup.

The earlier finding that an unresolved `phase='delete'` row is actionable by `runOrphanReconciliationOnce()` (`orphanReconciler.ts:703`) remains verified and is the strongest argument for this simplification: rather than build a protocol around an actionable journal, remove the action.

**Decision:** no new tables, no migrations, no claims, no leases, no cross-process deletion coordination. One ordinary SQLite transaction handles local conversation and message deletion; no remote OpenCode request is part of that operation.

---

## 5. Risks and safeguards for the eight reliability requirements

| # | Requirement | Current safeguard | Gap / proposed safeguard |
|---|---|---|---|
| 1 | Session persistence | Durable intent before create; idempotent caller-supplied ID; verified reuse; imported sessions never recreated | Add a regression test for restart-after-import and OpenCode restart while TBAi is running (§8) |
| 2 | External discovery | `/importable` lists all unarchived shared-DB sessions via `session.list()` | Document explicitly that external sessions are intentionally visible; test that a session created outside TBAi appears (§8) |
| 3 | Import reliability | `sourceRef` freshness, duplicate check, authoritative `session.get()`, no message copy, UNIQUE race handling | Test re-import and message-history preservation explicitly (§8) |
| 4 | Ownership safety | `assertSameHistoryOwner`, owner-filtered recovery, proxy authorization | Test that a visible/importable session is not treated as owned before import (§8) |
| 5 | Deletion safety | Entry snapshot and rebind guard remain useful for local row integrity (§4.5, §4.11) | **Four destructive flows found** (§4.5): conversation deletion, orphan reconciliation, failed-create compensation, explicit terminate. All share `client.session.remove`, which also deletes children and has no atomic conditional form. **Policy:** remove remote deletion from all four flows. TBAi never automatically deletes a session from the shared DB; local conversation/message deletion is one ordinary SQLite transaction. No claims, leases, or coordination protocol. |
| 6 | Concurrency | Per-conversation singleflight; atomic journal settlement; idempotent IDs | Test concurrent use by multiple OpenCode clients against the shared DB (§8) |
| 7 | Restart recovery | Durable intents, orphan records, owner-filtered recovery passes | Test interrupted import and DB write failure (§8) |
| 8 | Upgrade compatibility | Capability probing, wire validation, official V2 migration | Test V2 schema migration without breaking discovery/import (§8) |

---

## 6. Lifecycle rules (proposed, to be confirmed)

| Session state | Rule |
|---|---|
| Created by TBAi | Durable intent before create; pointer + service owner written atomically. TBAi has interaction permission, **not** exclusive delete authority — the session still lives in the shared DB (§4.12) |
| Created externally | Not associated with TBAi; visible in `/importable`; never probed, modified, or deleted by TBAi until imported |
| Imported into TBAi | Bound by a TBAi conversation with `opencodeImported: true`; messages remain in OpenCode; interaction operations in §4.13 are allowed; a missing session is reported, never recreated |
| Linked to multiple TBAi conversations | **Not supported today** — the UNIQUE constraint on `(serviceOwner, sessionId)` rejects a second import. Keep this rule; do not add multi-link without an explicit decision |
| Becomes unavailable or deleted externally | Imported conversation reports `OpenCodeImportedSessionMissingError`; native conversation with a stale pointer recreates only if not imported; no auto-repair of imported history |
| TBAi conversation deleted by user | **Local-only deletion:** one ordinary SQLite transaction deletes TBAi's conversation and messages. The OpenCode session and all its children remain untouched. No remote OpenCode request is part of the operation. Rebind still yields 409. The user manages the shared session in OpenCode if they want it deleted |
| Failed session creation | Keep the remote session; **retain the unresolved intent/orphan record** so durable diagnostics survive. No compensating remote DELETE and no `discardCreateIntent` on the retained path (`sessions.ts:1123`, `:1141`) |
| Orphan reconciliation | Diagnostic only: probe and log, never issue a remote DELETE (`orphanReconciler.ts:703`) |
| Explicit terminate | On explicit request, call `session.interrupt` to stop active work (`sessions.ts:1469`) — this is allowed. **Never call `client.session.remove`** (`sessions.ts:1477`); the shared session and its messages remain in OpenCode. "Local-only" in this row means no deletion, not no remote request |

**Non-destructive default:** a disappearing TBAi reference never authorizes deleting a shared OpenCode session. This **changes existing behavior** in all four flows in §4.5, which today call `session.remove`. The impact is that OpenCode sessions outlive their TBAi conversation rows and remain visible in TBAi's importable list; the user can import or remove them in OpenCode. We accept a small possibility of orphan accumulation rather than risk losing shared conversations; there is no evidence accumulation is currently a practical problem.

---

## 7. Implementation tasks (completed and pushed)

1. **Document the shared-DB architecture decision** in `docs/decisions.md`: no private DB, no `OPENCODE_DB` override, no snapshot, no disabling other clients; external import is a required capability.
2. **Remove remote deletion from all four backend flows** (§4.5): conversation deletion (`conversationDeletion.ts:107` / `sessions.ts:565`), orphan reconciliation (`orphanReconciler.ts:703`), failed-create compensation (`sessions.ts:1123`), and explicit terminate (`sessions.ts:1477`). Delete only TBAi's local conversation and messages in one ordinary SQLite transaction; no remote OpenCode request in that operation. **Exception for explicit terminate:** keep `session.interrupt` (`sessions.ts:1469`) so an explicit request still stops active work; remove only `session.remove`.
3. **Remove the frontend pre-delete terminate** (§4.5): delete the `POST /api/opencode/session/terminate` call from `web/src/features/chat/state/deleteConversation.ts:66-87`. Keep `cancelActiveRun` as the separate, explicit way to stop active work. Deleting a conversation must not touch the shared OpenCode session.
4. **Retain failed-create journal records** (§6): on the retained-session path, do not call `discardCreateIntent` (`sessions.ts:1141`); keep the unresolved intent/orphan row so the diagnostic survives. The reconciler may probe and log but must never call `removeUnboundSession`/`removeAndConfirm` (§4.6, §4.14). No new tables, migrations, claims, leases, or state machines.
5. **Ownership terminology** (§4.12): document the five distinct concepts in the owning module and stop describing `opencodeServiceOwner` as proof of exclusive ownership. No runtime behavior change.
6. **Shared-session mutation policy** (§4.13): document allowed interaction operations and protected lifecycle operations, grounded in the proxy allowlist. No runtime behavior change.
7. **Regression tests** from §8, written before any behavior change where practical, each proven able to fail against the defect it guards.
8. **Log-only integrity signal** for imported sessions that 404 (no repair, no rebind, no delete), using the existing logger contract.
9. **Verification** of the full gate (`bun run verify`, `test:locations`, `test:dom`, targeted e2e) with exact commands and exit codes recorded.

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
| TBAi conversation deletion (imported) | The TBAi row is deleted and the pointer cleared, but the externally created OpenCode session is **still present** with identical messages; no `session.remove` call is made; unrelated shared sessions unchanged |
| TBAi conversation deletion (TBAi-created) | Same non-destructive unlink: the OpenCode session remains in the shared DB; no `session.remove` call is made; a rebound pointer still yields 409 |
| Preservation of child sessions | Seed a parent with one or more children; delete the TBAi conversation; every child session and its messages remain present and unmodified |
| Concurrent child creation during deletion | Start a deletion, create a child of the target session while it is in flight, then finish; the child still exists afterward. This proves the design does not depend on a racy child-list preflight |
| Orphan reconciliation never deletes | Seed an unresolved `intent`/`orphan`/`delete` row, run `runOrphanReconciliationOnce()` repeatedly (including past the absence horizon); the reconciler logs but never calls `session.remove`; the session survives |
| Failed-create compensation keeps the remote session and its journal record | Force a pointer-write failure with confirmed unbound verification; the remote session remains in OpenCode; `discardCreateIntent` is not called and the unresolved intent/orphan row survives for diagnostics; no compensating DELETE |
| Frontend deletion makes no remote OpenCode request | Drive `deleteConversation(ref)` with a mocked API; assert no `POST /api/opencode/session/terminate` occurs, `cancelActiveRun` still runs, and only `DELETE /api/conversations/:id` is issued; the shared session remains in OpenCode |
| Explicit terminate interrupts but never removes | Call `POST /api/opencode/session/terminate`; assert `session.interrupt` **is** called (active work stops) and `session.remove` is **never** called; the session and its messages remain in OpenCode |
| Genuine incomplete TBAi-created session recovery still works | Seed an unresolved `intent`/`orphan` row for a session TBAi created but never bound; the reconciler still detects and logs it under the existing risk/horizon rules — removing deletion must not disable detection |
| No new database structures | Assert the schema has no cleanup-claim table and no migration adding one; local deletion uses one ordinary SQLite transaction with no remote OpenCode request |
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
5. **Source preservation:** TBAi performs no snapshot, copy, `VACUUM`, `DELETE`, `REINDEX`, or WAL checkpoint on the shared DB. TBAi **can interact with shared sessions** — prompts, reads, compacts, interrupts, model/agent switches and the other operations in §4.13 are intentional and allowed on imported sessions. It must not assume **exclusive authority over their lifecycle or deletion**: no `session.remove`, move, fork, archive, or bulk deletion from conversation deletion, cleanup, reconciliation, or compensation for an imported or unlinked session. Concurrent external writes are normal shared-DB activity; no global service is disabled and no other application is stopped.
6. **Migration idempotency:** no TBAi-side migration exists to make idempotent. OpenCode's official V2 migration remains authoritative; TBAi adds no V1 tables or compatibility path.
7. **Rollback:** no persistent data contract changes, so rollback is reverting the code change only; there is no copied database or marker to remove and no shared-DB state to restore.
8. **Imported-session deletion:** deleting an imported TBAi conversation clears the TBAi pointer and removes the TBAi row but leaves the original OpenCode session and all its messages intact; no `session.remove` call is made from the conversation-deletion path for any OpenCode session.
9. **Child preservation:** parent and child sessions survive conversation deletion, including when a child is created concurrently with the deletion; no design claim relies on a child-list preflight as a safety guarantee.
10. **Ownership terminology:** `opencodeServiceOwner` is documented and used only as a service-scope key, never as proof of exclusive session ownership; the five concepts in §4.12 are distinguished in the owning module.
11. **Shared-session mutation:** allowed interaction operations and protected lifecycle operations are documented per §4.13; no protected lifecycle operation is reachable from conversation deletion, cleanup, reconciliation, or compensation for an imported session.
12. **No automatic remote deletion:** none of the four backend flows in §4.5 calls `client.session.remove`, and the frontend `deleteConversation` flow makes no `/api/opencode/session/terminate` request. Conversation deletion is one ordinary SQLite transaction with no remote OpenCode request. Failed-create compensation keeps the remote session **and its unresolved journal record**; orphan reconciliation is diagnostic-only. **Explicit terminate retains `session.interrupt`** to stop active work on request but never calls `session.remove`.
13. **No new coordination machinery:** no cleanup-claim table, lease, state machine, migration, or cross-process deletion protocol is added. Orphan sessions remain in OpenCode and appear in the existing importable list; the user removes them there.
14. **Reliability:** all tests in §8 pass, including the "unrelated sessions untouched" assertion; all quality gates exit 0; no session was deleted, rebound, or duplicated by the work.

---

## 10. Independent-review finding resolution map

| Finding | Resolution |
|---|---|
| **Importable sessions** — false claim that unrelated sessions are not exposed | §4.1 corrects it: all unarchived shared-DB sessions are intentionally importable; §9.1 and §8 tests cover it |
| **Credential handling** — one credential row; never print the secret | §9.2 records metadata only, no copy, and requires owner approval for the treatment |
| **Filesystem permissions** — do not claim owner-only without evidence | §9.3 states the verified `mkdirSync` fact and declines to claim owner-only; no new directory is proposed |
| **Snapshot integrity** — distinguish TBAi writes from concurrent external writes | §9.5: no snapshot; TBAi may interact with shared sessions but has no exclusive lifecycle/deletion authority; external writes are normal; no service disabling |
| **Final acceptance criteria** | §9 includes all seven requested categories plus reliability |
| **Mandatory shared-DB architecture** | §1, §5, §7, §9.4 — no private DB, no `OPENCODE_DB`, no copy, no disabling other clients |
| **No historical recovery** | §3.3 decision; §7 contains no recovery task |
| **Eight reliability requirements** | §5 table |
| **Lifecycle rules** | §6 |
| **Required regression tests** | §8 |
| **Substantiate every safeguard with code paths and tests** | §4.11 maps each claim to `src/...:line` and an existing test with its assertion; §4.11 also records two documented restart limitations and the test-only nature of `OPENCODE_DB` in the DB-compat spec |
| **Imported-session deletion** — external session deleted with its TBAi conversation | §4.5 complete path audit proves `opencodeImported` is absent from the entry snapshot; §5/§6/§7 make unlinking the default; §8 and §9.8 cover it |
| **Parent-child cascade** — preflight has a TOCTOU race | §4.5 verifies v2.4.0 `Session.remove` reads children at delete time with no conditional API; §5/§7 reject the preflight-as-guarantee and adopt non-destructive unlinking; §8 concurrent-child test |
| **Ownership terminology** — five distinct concepts | §4.12 table; `opencodeServiceOwner` explicitly not proof of exclusive ownership; §9.10 |
| **Shared-session mutation** — allowed vs protected operations | §4.13 grounded in `proxyRoutes.ts:105-205`; §9.11 |
| **Durable deletion marker / background reconciler** — unresolved `delete` row remains actionable after unlink | §4.14 records the verified path; the lean policy removes the destructive branch entirely rather than building a protocol around it |
| **Ownership statement in §9.5** — "writes only sessions it owns" | §9.5 corrected: interaction with shared sessions is allowed; exclusive lifecycle/deletion authority is not assumed |
| **All four destructive flows** | §4.5 audits conversation deletion, orphan reconciliation, failed-create compensation, and explicit terminate; §7 task 2 removes remote deletion from all four; §8 and §9.12 cover it |
| **Claim protocol rejected** | §4.14: no new tables, migrations, claims, leases, or cross-process coordination; orphan accumulation accepted as a small, unproven risk |
| **Executive summary** | §1 states the single rule: TBAi does not automatically delete sessions from the shared OpenCode database |
| **Stale report metadata** | report revision now `ef13dba` (implementation tip) separated from source-code review baseline `42ce23c`; removed "local and uncommitted" and "Git state not modified" claims |
| **Frontend pre-delete terminate** | §4.5 verifies `deleteConversation.ts:66` calls `/api/opencode/session/terminate` before the local delete; §7 task 3 removes it; §8 and §9.12 cover it |
| **Failed-create journal retention** | §6 and §7 task 4 require keeping the unresolved intent/orphan row and not calling `discardCreateIntent` on the retained path; §8 and §9.12 cover it |
| **Explicit termination clarified** | §4.5, §6, §7 task 2, §8 and §9.12: `session.interrupt` is retained on explicit request; only `session.remove` is removed; the regression test asserts interrupt is called and removal is never called |
| **Branch/HEAD reference** | implementation tip `ef13dba`; source-code review baseline `42ce23c` |

---

## 11. Remaining risks and unresolved questions

- **Exact deleter of the nine sessions** — unknown; historical recovery out of scope.
- **Child-session deletion risk** — resolved by implementation. TBAi no longer calls `session.remove` in any flow, so a parent conversation deletion cannot remove child sessions. A regression test seeds parent and child sessions and asserts all survive (`tests/integration/opencode/conversation-deletion.test.ts`).
- **Orphan accumulation** — accepted. Sessions that fail to bind remain in OpenCode and appear in TBAi's importable list. There is no evidence accumulation is currently a practical problem; revisit only with measurements.
- **Behavior change** — local-only deletion means OpenCode sessions outlive their TBAi conversation rows. This is intentional for a shared history store and was approved by the owner before implementation.
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

**STATUS: IMPLEMENTED.** The §7 tasks were completed in commits `650b1ef..ef13dba` and pushed to `origin/ui-foundation-upgrade`. Two independent reviews found no Critical issues; all Important findings (atomic deletion, engine-in-transaction comparison, stale e2e spec, route 409 coverage, reconciler coverage) were fixed and verified. The remaining deferred minors are recorded in §11. No database, session, WAL, or backup state was modified at any point.
