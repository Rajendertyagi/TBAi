# OpenCode Runtime Remediation Plan — audit findings + reference-study patterns

**Repository:** `Rajendertyagi/TBAi` (local: `D:\Temp\ai-chat-app`)
**Branch:** `ci/tauri-e2e-verify` — **Audited commit:** `2475396ce36fdf33b53afc09779027ed7e6684b6`
**Date:** 2026-10-20 — **last updated:** 2026-10-21 (after Phase 1)
**Reference study:** `D:\Temp\openchamber` @ `bf977d2ed89c079ec592210d7cd0e2d649ba0636` (branch `main`)
**Official-API study:** `https://opencode.ai/config.json` (published JSON Schema), `https://opencode.ai/docs/*.md` (published doc sources), and the installed `@opencode/client@2.0.32` type/contract surface
**Upstream-source study:** `sst/opencode@dev` (resolves to `anomalyco/opencode`) — the authoritative V2 permission semantics
**Status:** **Phase 0 delivered and committed** (`f4d93c1`). **Phase 1 is implemented in the working tree and NOT committed** (commit requires explicit authorization). A1, A2, A3, B, D and the C write path are **done**; the C page behaviour is **HELD on G7** and the C override indicator on **G3**.

---

## 0.1 Progress ledger

| Phase | Unit | State | Commit | Gate evidence | Next |
|---|---|---|---|---|---|
| **0** | Baseline, characterization, quarantined regression tests, and the G-TODO guard | **DONE** | `f4d93c1` | `bun run verify` exit 0 — 4329 pass / 43 skip / 9 todo / 0 fail across 321 files / 4381 tests; typecheck, lint, format:check, test:locations, build, test:shutdown, test:startup-rollback, test:lifecycle-integration, test:dom and test:quarantine all green | — |
| **1** | **A1** — the proxy route allowlist | **DONE** | `4a10151` | The real installed `@opencode/client` is driven through the real proxy and every route it calls is allowed; 21 routes outside the browser's set are refused with a test each; the allowlist and the client are checked against each other in both directions. **Corrected during Phase 1**: the app also calls `/api/opencode/*` **directly**, which the client-driven test cannot see — the command palette fetched the location-scoped command catalogue through the proxy and was refused. The catalogue is now read by the backend and served from `/api/opencode/commands`, and a guard fails the build if the app names a proxy path that is not one of TBAi's own routes | — |
| **1** | **A2** — server-side workspace authorization | **DONE** | `4a10151` | `conversationService.findByOpenCodeSessionId` + an index on `opencode_session_id`; the proxy strips `x-tbai-session`, `x-opencode-directory` and `location[directory]`, resolves `session → conversation → folder → directory`, and refuses an unknown session, a disagreeing session header and an unresolvable workspace | — |
| **1** | **A3** — CORS narrowing | **DONE** | `4a10151` | The policy trusts the **packaged webview origin** (`http://app.localhost`) and **TBAi's own pages on the port the listener is on, plus the port it just replaced while the restart transition is open** — the origins are DERIVED from the live listener, because the port is the user's choice (Settings → Web server) and a fixed port breaks the first time it moves (the browser-mode restart probes the new origin from the page still on the old one, and that probe is cross-origin). Every other loopback port, a public origin, `null` and a request with no `Origin` get no `Access-Control-Allow-Origin`. **G1 and G2 are closed from evidence, and the plan's premise was wrong**: `http://app.localhost` is NOT stale — it is the Windows WebView2 origin for the custom `app` protocol (Tauri's own API documentation for `register_asynchronous_uri_scheme_protocol`; `docs/architecture.md` already said so). `PATCH` was also missing from the allowed methods, which silently blocked the app's fifteen `PATCH` call sites in the packaged app; that is fixed and pinned by a test. `bun run verify` exit 0 (4409 pass / 43 skip / 7 todo / 0 fail across 329 files / 4459 tests, plus the lifecycle suites and 518 DOM). The Playwright E2E suite ran for real on **both** runnable browser projects — `edge-headless` 35 ok / 4 failed and `chromium-headless` 34 ok / 5 failed — and a **pristine-tree baseline of each** shows the same failure count with four identical failures and one load-dependent flake each way, so no failure is attributable to this work | — |
| **1** | **B** — credential redaction | **DONE** | `4a10151` | The response is a **redacted projection** derived from the published schema; `GET /api/opencode/config` carries no credential at any depth including inside `raw`; the write path still round-trips the real file with its credentials intact. **Extended by the defect remediation below**: a substitution reference is masked wherever it occurs, in the documented string form (`"{env:NAME}"`, `"{file:path}"`) as well as the object form | — |
| **1** | **C** — permission-row identity | **DONE** | `4a10151` | **Write path** (shipped earlier): a rule is addressed by POSITION plus a re-checked identity, and an ambiguous `(action, resource)` pair is refused. **Page behaviour (G7, Option C)**: the table's rows are keyed by the rule's position in the FILE, each row's controls are named with its row number, and the save names the position — so two identical rules are independently editable, and the backend still refuses a rule whose identity changed on disk. **Override indicator (G3)**: a read-only notice marks a rule that a later rule shadows, computed from the relations the live server confirmed. Two of the page's guards were proved able to fail. **Corrected by the defect remediation below**: the indicator and the row numbers now share ONE index space — the rule's position in the file | — |
| **1** | **D** — event-scope validation | **DONE** | `4a10151` | An event whose `location.directory` differs from the subscribed workspace is not applied; an event with no location is kept; a directory the server reports for the session is accepted | — |
| **2** | **Ownership extraction** *(behaviour-preserving)* | **DONE** | `d6c821d`..`9c0b7c2` | The runtime's **lifecycle** moves out of `v2ThreadController.ts` into `web/src/features/opencode/sync/`: `optimistic.ts` (the local prompt identity and the optimistic record), `promptsInFlight.ts` (the admission registry), `startupGate.ts` (the readiness promise), `attempt.ts` (the generation, the abort signals, the load promise), `eventPipeline.ts` (the event loop, the ordinal, the buffer, the retry budget) and `sessionMessageLoader.ts` (the history read and the commit of its projection). The controller keeps the domain state, the dispatch and the policy. `sync/ownership.md` is the contract. **The extraction adds no mechanism**: the plan's target layout mixes extraction with the fixes, and a behaviour-preserving phase cannot ship both, so each later phase adds its mechanism to a module that already has one owner. Two defects are **reproduced rather than tidied** — the event buffer's vestigial filter (M5) and the retry reset in the shared tail (M1) — because moving the code must not quietly fix them. **Gate evidence** (re-run for this work): `bun run verify` exit 0 — 4433 pass / 43 skip / 7 todo / 0 fail across 331 files / 4483 tests, plus the lifecycle suites and 529 DOM; the OpenCode-scoped suites report **identical** numbers before and after the move (173 unit/opencode, 560 unit/web/opencode, 112 integration/opencode), which is this phase's acceptance criterion | — |
| **3** | **Attempt ownership and reconnect** — M1, M2, M4, L4, D2 | **DONE** | `41e9031`, `9d2db1f`, `7f1b447` | The connection attempt is now a value the controller holds (`currentAttempt`) and it owns what its ownership was the defect of: its readiness gate (`markReady()` is inert once retired, which closes **L4** by construction), its connection signal (**M2**: aborting one attempt cannot tear down another), its load slot (**M2**: a failed attempt clears only its own promise), and its hydration flags, cleared by `projectionCommitted`/`markReady`/`fail`/`retire`/`finally` (**M4**: a dead hydration cannot strand the transcript). `retire()` is the single **synchronous** act of supersession, so `isLive(attempt)` before a commit is sufficient rather than a race-prone token check. The retry counter stays scheduler- and runtime-scoped (a ceiling belongs to the runtime) but the reset left the shared tail: the controller resets it only after `markReady()` **and** a liveness check, so a superseded attempt can no longer reach it (**M1**). A failed history read now routes through the reconnect path, ending in `reconnecting(n)` then a within-budget recovery or `failed(n)` instead of `load: error` beside `connection: connected` (**M4**). Delay policy (D2): foreground cap **5 s** adopted, absent visibility/online assumed to be the shorter ceiling; the permanent-4xx shortcut was **removed as unreachable** after checking the installed `@opencode/client` (it discards the transport status for every status an operation declares, including the 404 a deleted session produces), recorded in `docs/decisions.md`; the **60 s hidden/offline cap is deliberately not adopted** (no visibility-triggered re-arm exists, so a returning reader would wait up to a minute) — recorded with its reasoning in `docs/decisions.md`. **Gate evidence** (re-run for this work): typecheck, lint, format:check, test:locations exit 0; `bun run build` exit 0; full unit+integration tree **4438 pass / 43 skip / 5 todo / 0 fail** across 331 files / 4486 tests; DOM **529 pass / 0 fail** across 52 files; test:quarantine clean. `R-M4` was proved able to fail: with the source reverted it fails at `Expected: "failed" / Received: "connected"`, and the M1 and M2 baseline pins both failed the moment the defects were gone, then were deleted | — |
| **4** | **Snapshot ↔ live-event merge, buffer semantics, auxiliary honesty** — H2, M5, M10, M12 | **DONE** | `7b65219`, corrected 2026-10-22 | The history commit now reconciles instead of replacing: it carries the ids the transcript **held** when the read started (optimistic ids excluded) and the ids live events **touched**, and the reducer decides what those mean — the snapshot-confirmed deletion is the only removal the merge may perform (**H2**). There is no `"replace"` mode, and no `recoverySnapshots.ts`: an empty `held` on a first load already is a replace, and the event buffer already is the observer the reference needs, drained after the commit (**M5**). The buffer coalesces adjacent deltas into the tail entry, and an entry that predates the read keeps its own ordinal so a held delta cannot be dated later than it arrived — one call, `beginHistoryRead()`, samples that ordinal — with the merged entry taking the later event's ordinal; the vestigial filter that discarded the whole buffer is gone and the backstop is a plain `slice(-LIMIT)` at 4096 (**M5**). What may be **replayed** is decided by the snapshot's own per-part text rather than by that ordinal (`sync/historyReplay.ts` — see the correction paragraph below the ledger). The three `*_hydrated` actions carry `T[] | null` plus the held ids, `state.auxiliary` tracks `"current" | "unavailable"` per kind, and one status-popover line names the kinds that are stale — shown only once the load is ready (**M10**). `readOpenCodeCapabilities` turns a non-2xx into an error (**M12**). The second history commit, which existed only to stamp `part.permissionId`, is deleted with the field: an independent search found no production reader, the tool card's linkage being `deriveV2ToolCallId(message.id, toolId)`. **Gate evidence** (re-run for this work, step by step where the chain stops): typecheck, lint, format:check, test:locations and build exit 0; the full unit+integration tree **4459 pass / 43 skip / 3 todo / 1 fail** across 335 files / 4506 tests, and the single failure is **pre-existing and environmental** (`tests/integration/server/port-configurability.test.ts` cannot restart onto port 3030 because the user's own `tbai-server.exe`, PID 15704, is listening there; this phase touches no file that test covers, and the same command recorded 0 fail in this ledger for Phase 3). test:shutdown **1 pass**, test:startup-rollback **2 pass**, test:lifecycle-integration **3 pass**, test:dom **529 pass / 0 fail** across 52 files, test:quarantine **clean**. Scoped, `tests/unit/web/opencode` is **587 pass / 3 todo / 0 fail** across 44 files. The four new suites (5 + 5 + 3 + 4 cases) and the reducer's replacement describe (5 cases) were each **proved able to fail** against their defect and reverted; `R-H2` and `R-M10` are promoted from `test.todo` and the baseline pins that held those defects are deleted in the same change (M3's pin stays, M3 being open). **Corrected 2026-10-22** after an independent review of `7b65219` reproduced a text-doubling defect this phase's own mechanism allowed: the commit took the snapshot's copy of a message and every held event was replayed on top of it, so a delta the snapshot already contained was appended a second time. The snapshot's own per-part text now decides what may be replayed (`sync/historyReplay.ts`), a failed hydration clears the buffer it never committed onto, and the fold no longer lets a pre-read delta be dated later than it arrived; the two failures the correction fixes are pinned by `v2ThreadController.test.ts` and `historyReplay.test.ts` (see the correction paragraph in 5.5.1). **Gate evidence for the correction** (re-run for this change, step by step where the chain stops): typecheck, lint, format:check, test:locations and build exit 0; the full unit+integration tree **4468 pass / 43 skip / 3 todo / 1 fail** across 336 files / 4515 tests, and the single failure is the same **pre-existing and environmental** one (`tests/integration/server/port-configurability.test.ts` cannot restart onto port 3030 because the user's own `tbai-server.exe`, PID 15704, is listening there; this change touches no file that test covers). test:shutdown **1 pass**, test:startup-rollback **2 pass**, test:lifecycle-integration **3 pass**, test:dom **529 pass / 0 fail** across 52 files, test:quarantine **clean**. Scoped, `tests/unit/web/opencode` is **596 pass / 3 todo / 0 fail** across 45 files. Every new guard was **proved able to fail** and reverted, each at a SINGLE site, and the counts below are the ones the code produces (measured over `tests/unit/web/opencode`): the covered-part rule inverted gives "HelloHello" and fails 2 cases; the empty-part rule inverted gives "lo" and fails 2 cases; the buffer clear removed gives "Hello" from the dead attempt and fails 1 case; the fold guard removed swallows the pre-read delta and fails 1 case. **Corrected 2026-10-22 after the re-review**: the buffer clear used to sit at TWO sites (the attempt boundary and the failed-hydration catch), and removing either one alone changed nothing observable - so neither was a real guard. There is now ONE site, the attempt boundary, and the re-review's own probe reproduces the failure with it removed | — |
| **5** | **Settlement, cancellation, exactly-once delivery** — M3, M6, M7, M13, M19 | **DONE** | working tree (not committed) | **M3**: a prompt's admission now reaches every waiter, and the wait is BOUNDED - an ambiguous request is reported as `ambiguous`, a typed and recoverable outcome, never as a rejection and never as a hang. The registry keeps two kinds of watcher: the OUTCOME watch (which accepts "not provably") and the ADMISSION watch (which does not - the server may still admit the prompt). **M6**: a permission or form id is CLAIMED before the transport call, so two overlapping answers produce one transport call; the claim is released only on a definitive failure, and a `permission.replied` / `form.replied` event invalidates an in-flight decision. **M7**: a cancel requested before the admission is honoured exactly once against the admitted inbox id - the `cancelling` state now carries the `cancelRequested` flag, and the inbox id is what makes the cancel unique. **M13 / M19**: the first-prompt handoff's claim carries the message id, so a crash between the claim and the dispatch RESUMES the same prompt (the server admits a repeated id as the same prompt), and a failed dispatch is marked failed and never dispatched again automatically. The dead exports are gone (`hasPendingReconnect`, `OPENCODE_V2_HISTORY_CONVERGENCE_PASS_CAP`, the `load_reconciling` / `load_reconciled` actions). **Gate evidence** (re-run for this work, step by step where the chain stops): typecheck, lint, format:check, test:locations and build exit 0; the full unit+integration tree **4484 pass / 43 skip / 0 todo / 1 fail** across 337 files / 4528 tests, and the single failure is the same **pre-existing and environmental** one (`tests/integration/server/port-configurability.test.ts` cannot restart onto port 3030 because the user's own `tbai-server.exe`, PID 15704, is listening there; this change touches no file that test covers). test:shutdown **1 pass**, test:startup-rollback **2 pass**, test:lifecycle-integration **3 pass**, test:dom **529 pass / 0 fail** across 52 files, test:quarantine **clean**. Scoped, `tests/unit/web/opencode` is **611 pass / 0 todo / 0 fail** across 46 files. **All three quarantined regressions are now promoted** (`R-M3`, `R-M6`, `R-M7`), and the M3 baseline pin was deleted with its fix. Every new guard was **proved able to fail** and reverted: the permission claim removed fails R-M6, the form claim removed fails R-M6, the pending-cancel honouring removed fails 3 cases, the failed-entry guard removed fails 2 cases, and the resumed id not carried fails 1 case | - |
| **1** | **Phase 1 defect remediation** — the three defects an independent audit confirmed against the shipped Phase 1 units (AUD-1, AUD-2, AUD-3) | **DONE** | `1fd239c` | **AUD-1 — the override indicator**: the relation is now computed over the FILE's rules, indexed by the file's own positions, and the row numbers the table and the notice show are the file's row numbers; a rule the page cannot read is a hole in that array, so it neither shifts the relation nor shifts the numbering. **AUD-2 — the CORS trust window**: the replaced origin is trusted for `REPLACED_PORT_TRUST_WINDOW_MS` (20 s — the browser-mode readiness probe's 15 s budget plus a margin) from the replacement, and no longer; the window is measured against the clock, so it closes whether or not anything asks for it. **AUD-3 — credential redaction**: a substitution reference is masked wherever it occurs, in the **documented string form** (`"{env:NAME}"`, `"{file:path}"` — OpenCode's own configuration reference) as well as the object form. **Gate evidence** (re-run for this work): typecheck, lint, format:check and test:locations exit 0; `bun run build` exit 0; the full unit+integration tree **4433 pass / 43 skip / 7 todo / 0 fail** across 331 files / 4483 tests; the DOM suite **529 pass / 0 fail** across 52 files; test:shutdown 1 pass, test:startup-rollback 2 pass, test:lifecycle-integration 3 pass; test:quarantine clean; the OpenCode E2E spec **1 passed** (`edge-headless`). Each new guard was **proved able to fail**: the AUD-3 defect fails 3 unit tests and the API-level integration test, the AUD-1 defect fails the DOM test, the AUD-2 defect fails the transition test — each reverted after the proof | — |

**What Phase 0 changed and did not change.** It added tests and one gate; it moved the controller test's harness into a shared helper as a **pure move** (every test body byte-for-byte identical). **It fixed no defect.** Its whole purpose is to make every later fix provable: the B-series pins the broken behaviour, the R-series asserts the correct behaviour and fails today, and the guard fails the build if a finding is fixed without its regression test being promoted.

**How a later phase retires a finding.** The phase that fixes it promotes that finding's `test.todo` to a real test, deletes the B-test that pinned the old behaviour **in the same commit**, and the G-TODO guard stops reporting it. A baseline test that survives its own fix is a finding that was not really fixed.

**What the Phase 1 defect remediation changed.** An independent audit of the shipped Phase 1 units confirmed three defects in them, and this work fixed exactly those three. **AUD-1**: the override indicator computed the relation over the *filtered* rule list while indexing it with the *file* index, so a configuration holding a rule the page could not read produced an override notice on the wrong row — or none at all. The relation and the row numbers now share one index space: the rule's position in the file. **AUD-2**: the port the listener replaced stayed trusted for the life of the process, so any other page on that loopback port could read the API after a port change; the trust is now bounded by a transition window sized to the browser-mode readiness probe that needs it. **AUD-3**: a substitution reference outside the schema's secret locations was not masked — and the **documented** syntax is a *string* (`"{env:NAME}"`, `"{file:path}"`), which the original rule did not cover at all; both forms are now masked wherever they occur. Nothing else changed: no other finding, unit, phase or file was touched, and each fix's guard was proved able to fail before the fix was kept.

**What Phase 2 changed, and what it deliberately did not.** It moved the runtime's lifecycle into `features/opencode/sync/` and changed no behaviour: the characterisation tests report identical results. The one visible difference is a call that finds no generation now raises the controller's own not-found error instead of a TypeError on a null dereference, in the narrow window where the generation disappears between two awaits. **Appendix B's source locations refer to the file as it stood before this extraction** — they are the audit's record of where each defect was, and they are left as they are.

**What Phase 4 changed, and what it deliberately did not.** It closed **H2**, **M5**, **M10** and **M12**, and changed nothing else. It did not build `recoverySnapshots.ts` and did not add a `"replace"` commit mode (see §5.5.1 and `docs/decisions.md`: the merge reduced to two id sets transported by the commit, and an empty `held` already is a replace). It did not delete the second history commit until an independent search had confirmed that `part.permissionId` had no production reader — and then deleted the field with it rather than re-expressing the commit as a merge. It did not wire `retry()` to any surface: the status control that would call it is a UI change and needs its own approval, so `retry()` still has no product caller. It left **M3**'s baseline pin and the three remaining quarantined regressions (`R-M3`, `R-M6`, `R-M7`) alone, because those findings are Phase 5. It did not remove two other dead exports it noticed (`hasPendingReconnect`, which was already without a caller at this phase's base commit, and `OPENCODE_V2_HISTORY_CONVERGENCE_PASS_CAP`) — naming them is this phase's obligation; removing them is not this phase's work. One gate step is red **on this machine only**: `port-configurability.test.ts` cannot bind port 3030 because the user's own `tbai-server.exe` holds it, which is why the ledger row above records the step-by-step numbers.

**What Phase 5 changed, and what it deliberately did not.** It closed **M3**, **M6**, **M7**, **M13** and **M19**, and it changed the reconnect surface and removed the dead exports that Phase 4 had named. It **changed a behaviour the repository asserted**: M7's cancel-before-admission now issues a transport call it did not issue before, and the test that pinned the old behaviour was rewritten with the rationale recorded rather than quietly updated. It **did not** take the plan's shape for M3's reconciliation: `reconcilePendingPrompt` was **deleted** instead of being given a caller, because the registry now settles every outcome and a reconciler with nothing to reconcile is a second mechanism over a window that already has one. It did **not** settle an ambiguous admission as a rejection — "ambiguous" is a new error kind, because the server may still be running the prompt, and reporting it as a rejection would tell the reader their message never arrived. It did **not** abort the in-flight prompt request on an ambiguous outcome, and it did **not** re-dispatch a first prompt whose dispatch failed, because that dispatch may have reached the server. The M13 resume relies on the server's own idempotency, which was checked against the upstream source at the pinned version: `Session.prompt` reconciles by message id before it admits, so a resumed dispatch carrying the same id is the **same** prompt server-side. One gate step is red **on this machine only**, for the same reason as Phase 4: port 3030 is held by the user's own `tbai-server.exe`.


**What Phase 1 changed and did not change.** It closed **M8** (both halves of the proxy - the *execute* half by A1, the *arbitrary-path* half by A2, and the *cross-origin read* half by A3), **H1**, **M9**, and the **write path** of **H3**. It did **not** change what is written to the user's OpenCode configuration file, did not implement permission evaluation in TBAi, did not remove the V1 configuration shapes, and did not change the config page's behaviour for a pre-existing exact duplicate (G7) or add the read-only override indicator (G3). Two corrections were made **inside** Phase 1 and are recorded in the ledger: the proxy allowlist broke the composer's command palette, because the app calls `/api/opencode/*` directly and this plan's premise - that the browser only reaches the catalogue through the official client - was wrong; and this plan's premise that the CORS entry `http://app.localhost` "matches nothing TBAi serves" was ALSO wrong: it is the Windows WebView2 origin for the custom `app` protocol, per Tauri's own API documentation for `register_asynchronous_uri_scheme_protocol` and this repository's own architecture page. A third defect was found and fixed inside A3: `PATCH` was missing from the allowed methods, which silently blocked the app's fifteen `PATCH` call sites in the packaged app.

---

---

## 0. How to read this document

This plan is the merged output of three independent investigations against the same subsystem, plus one architecture review that re-verified all three:

1. **A read-only runtime audit** of the whole OpenCode subsystem at `2475396` (§2). Every finding was reproduced with deterministic tests run **outside** the repository; none was inferred from a prior report or from a passing test.
2. **A study of the OpenChamber reference implementation** (§3.1–§3.3), which had already solved most of the same problem classes — in a materially different architecture.
3. **A study of the official OpenCode contract** (§3.4) — the published schema, the published doc sources, and the pinned client's real route surface.
4. **A study of the upstream OpenCode source** (§3.5), which settled the one question the published prose could not: the V2 permission-rule resolution algorithm. It produced **finding H3**.

§4 states the target architecture and its ownership map. §5 is the ordered work and its acceptance tests. §6 is the dependency graph. §7 is the gate-level acceptance criteria. §8 is risks and non-goals. **§9 states the recommended decision for each of the eighteen architectural questions** — with the residual evidence gaps labelled explicitly rather than left as open questions. §10–§14 are the evidence and citation indices, and **§15 is the readiness verdict**.

**Status of every finding in this document:** the audit confirmed **1 Critical, 2 High, 17 Medium, 9 Low** defects, plus **7 hypotheses disproven or withdrawn** — one of the withdrawn ones (L6) was a false positive of this plan's own making, caught by reading the upstream source. Nothing here is speculative. Where a decision still depends on evidence that could not be obtained without side effects, §9.1 names the gap instead of guessing.

**Phase 1 closed four findings and part of a fifth.** **M8 (Critical)** is closed by A1 (the allowlist) and A2 (the server-side workspace authorization) — both halves, the *execute* half and the *read* half, except that the **cross-origin read half is still open** until A3 narrows the CORS policy. **H1 (High)** is closed by B (credential redaction). **M9 (Medium)** is closed by D (event-scope validation). **H3 (Medium)** is closed for its **write path** by C; its page behaviour and its read-only override indicator are still open (G7, G3). **A3 remains the one Critical-adjacent gap**, and it is held on evidence, not on effort.

---

## 1. Audit basis

### 1.1 Git state at audit time

| Item | Value |
|---|---|
| Branch | `ci/tauri-e2e-verify` |
| Local HEAD | `2475396ce36fdf33b53afc09779027ed7e6684b6` |
| `origin/ci/tauri-e2e-verify` | `2475396ce36fdf33b53afc09779027ed7e6684b6` |
| `git rev-list --left-right --count origin/… HEAD` | `0  0` → synchronized |
| Working tree at start **and** at end | ` D tests/test-prompts-phase5.md`, ` D tests/test-prompts.md`, `?? docs/opencode-context.md` — all three **pre-existing**; the audit changed nothing |
| Working tree, later in the session | ` M docs/engineering-quality.md` appeared — **not modified by this work**. Its mtime is 17 s after this file's last write, and its content is a semantic edit (updated test-file counts, em-dash → hyphen) that no formatter in this toolchain produces. It is **another contributor's or a concurrent session's uncommitted work**; it was left untouched, not reverted, and is not claimed. Recorded here so the diff is not misattributed. |
| Working tree, still later | `docs/decisions.md`, `docs/development-rules.md` and `docs/persistent-appshell-architecture-plan.md` also became modified — **none of them by this work**, all part of the same concurrent editing. Consequence: **line-number citations into those files are not stable** and have been replaced by quoted-text anchors wherever they appear in this document. |
| Tree movement during the session | The concurrent editor **committed** their work as `3351f81` ("docs: refresh spec counts, CI job docs, and decisions for the 2026-10-20 dependency and test commits"), so `HEAD` moved from `2475396` to `3351f81`. That commit touches **only** `docs/decisions.md`, `docs/development-rules.md`, `docs/engineering-quality.md` and `docs/persistent-appshell-architecture-plan.md` — **no OpenCode runtime source**. The audit at `2475396` therefore remains valid for every line of code it cites; only the documentation moved. |
| Recent OpenCode commits | `5911eb2` reconnect policy injectable · `b65b6c8` 2 s version probe · `b022b8b` A1 binary resolution + F1 bounded reconnection · `25b4003` NUL byte removal · `dff7154` repo restructuring |

### 1.2 Evidence actually gathered

| Command | Result |
|---|---|
| `bun test --isolate ./tests/unit/opencode` | **147 pass / 0 fail** (12 files) |
| `bun test --isolate ./tests/unit/web/opencode` | **531 pass / 0 fail** (35 files) |
| `bun test --isolate ./tests/integration/opencode` | **87 pass / 41 skip / 0 fail** (12 files) |
| `bun run test` — **the pre-Phase-0 baseline** | **4320 pass / 43 skip / 0 fail** across **319 files / 4363 tests** (318 s), measured at `3351f81` with the extracted harness in place and before the Phase 0 files were added. An earlier run reported 1 failure; it was **contamination** — this work edited the test tree while the suite was running — and the clean re-run is the number above. |
| `bun run verify` — **the Phase 0 result** | **exit 0.** `bun run test` → **4329 pass / 43 skip / 9 todo / 0 fail** across **321 files / 4381 tests** (321 s) · `test:shutdown` 1 pass · `test:startup-rollback` 2 pass · `test:lifecycle-integration` 3 pass · `test:dom` 518 pass / 0 fail (50 files) · `test:quarantine` clean · typecheck, lint, format:check, test:locations, build all exit 0. The delta against the baseline is exactly **+9 pass** (the B-series) and **+9 todo** (the R-series, which an ordinary run reports as *todo* and therefore cannot fail the build). |
| Scratch verification suite (outside the repo) | **17 tests, 15 pass, 2 fail** — both failures **are** defect demonstrations (M1's ceiling assertion, M10's "a failed fetch clears a live permission") |
| GitHub Actions run #54 on `2475396` ("Verify") | success |
| Upstream V2 source (`sst/opencode@dev`) | `packages/core/src/permission.ts` → `evaluate()`; `packages/core/src/util/wildcard.ts`; `packages/schema/src/permission.ts`; `packages/core/src/v1/config/permission.ts` |
| OpenCode CLI on PATH | `D:\Coding\OpenCode\opencode.exe` (present; **not started** — no live server was launched) |

**Not run, and therefore not claimed:** `bun run verify` in full, `bun run verify:full` (semgrep), the Playwright suites under `tests/e2e/`, and any live OpenCode binary or live permission evaluation. No real configuration file, credential, session, or prompt was touched.

**What the green suites mean.** The OpenCode-scoped suites are green *and* the defects below are real, because **no existing test exercises the failing paths**. That is itself a finding, and it is why §5.1 (characterization) is a prerequisite rather than a nicety.

### 1.3 Prior reports, and why they cannot be trusted as-is

| Artifact | Date / SHA | Status |
|---|---|---|
| `docs/2026-10-05-pm-opencode-frontend-audit-report.md` | 2026-10-05 | **Stale** — cites `web/src/config/opencode.ts` (moved) and states *"No attempt-count cap exists in this controller"*, superseded by `b022b8b`. |
| `docs/pm-opencode-store-audit-answers.md` | ~2026-10-05 | **Stale** — cites `v2RuntimeStore.ts:41-83`; the file is now 161 lines and `createV2RuntimeStore` became `createV2RuntimeStoreFactory`. |
| `docs/2026-10-16-backend-lifecycle-audit.md` | 2026-10-16 @ `1b35278` | **Partially applicable** — different branch; its OpenCode child-lifecycle rows still match; it does not cover the frontend runtime. |
| `docs/opencode-context.md` (maintainer handoff) | 2026-10-19 @ `b1c48a4` | **Most current, two commits behind, and one assumption disproven** — see §2.2. |
| GitHub | — | One PR (#1, MCP/history, draft). **No OpenCode issue or PR exists.** Nothing on GitHub records any finding below. |

---

## 2. Findings

### 2.1 Summary

| ID | Title | Severity | Status |
|---|---|---|---|
| **M8** | **The OpenCode reverse proxy is an unauthenticated, cross-origin-reachable command-and-file execution surface — and a cross-workspace *read* surface** | **Critical** | Confirmed (source + runtime) |
| **H1** | OpenCode provider credentials are served to the browser and rendered in the DOM | **High** | Confirmed (source + runtime) |
| **H2** | Every assistant event arriving during hydration is applied and then silently discarded | **High** | Confirmed (runtime) |
| **H3** | **The configuration write path addresses a rule by `(action, resource)` instead of by position + identity, so a configuration containing exact duplicates can edit the wrong row** | Medium | Confirmed (source) — re-scoped, §3.5 |
| **M1** | The bounded-reconnect ceiling is not enforced when the stream fails during hydration | Medium | Confirmed (runtime) |
| **M2** | A superseded attempt's late failure corrupts the live state and forces an extra connection | Medium | Confirmed (runtime) |
| **M3** | An ambiguous prompt admission leaves `sendMessage` pending forever; the reconciler has no live caller | Medium | Confirmed (runtime + exhaustive grep) |
| **M4** | A failed hydration leaves the runtime permanently frozen and schedules no recovery | Medium | Confirmed (runtime) |
| **M5** | The hydration-buffer overflow discards every buffered event | Medium | Confirmed (runtime) |
| **M6** | Permission and form replies are not exactly-once | Medium | Confirmed (runtime) |
| **M7** | "Cancel" during the prompt-request phase does not cancel; the prompt stays queued and executes | Medium | Confirmed (source + asserted-by-test) |
| **M9** | Events are not filtered by the official `location` scope the V2 event contract carries | Medium | Confirmed (source) — new, §3.4.6 |
| **M10** | **A failed auxiliary fetch is indistinguishable from "nothing pending", so a transient error silently removes a visible permission or form** | Medium | Confirmed (runtime) — new, §3.6 |
| **M11** | **A failed catalogue read during session *creation* aborts the whole creation, contradicting `sessionModel.ts`'s own "tolerant by construction" contract** | Medium | Confirmed (source) — new, §2.4 |
| **M12** | **The capabilities fetch ignores `r.ok`, so a 503 body is parsed as success and silently empties the agent/model picker** | Medium | Confirmed (source) — new, §2.4 |
| **M13** | **The first-prompt handoff claims the stashed prompt *before* dispatching it, so a reload in that window loses the prompt permanently** | Medium | Confirmed (source + the repo's own test) — new, §2.4 |
| **M14** | **`V2OptionControl` is rendered without a `key`, so per-question state leaks across a form and can append the previous question's text to the current answer** | Medium | Confirmed (source) — new, §2.4 |
| **M15** | A form whose options exceed 100 is silently truncated **without** `unsupportedReason`, so a required select can never be answered | Low | Confirmed (source) — new, §2.4 |
| **M16** | An unrecognised form field type is projected as `multiselect` without `unsupportedReason`, so the form claims to be answerable but renders no control | Low | Confirmed (source) — new, §2.4 |
| **M17** | `OpenCodeStatus.retry()` calls `reconcileStagedRevert()` with no `.catch` → an unhandled rejection on every failed recovery | Low | Confirmed (source) — new, §2.4 |
| **M18** | `dockSeen.current` is never set `true`, so the step-change focus move is dead code — and a **source-text** guard keeps it green | Low | Confirmed (source) — new, §2.4 |
| **M19** | The handoff un-claims on failure and the effect re-fires, so a send that reached the server before rejecting can be **delivered twice** — contradicting the module's own "never auto-resubmitted" | Medium | Confirmed (source) — new, §2.4 |
| **L1** | Unbounded per-controller retention | Low | Confirmed (source) |
| **L2** | Session termination orphans the remote session when removal fails | Low | Confirmed (source) |
| **L3** | `invalidateBootstrap` is a no-op | Low | Confirmed (source) |
| **L4** | A superseded attempt can settle a newer attempt's readiness promise | Low | Confirmed (source); user-visible effect masked today |
| **L5** | The status UI does not represent the reconnecting state | Low | Confirmed (source) |
| **L6** | ~~The preferred operator auth env var is the undocumented one~~ | — | **WITHDRAWN — disproven** (§3.4.8). Upstream V2 prefers `OPENCODE_PASSWORD` and honours the legacy name; TBAi already matches it. |
| **L7** | `bindV2PermissionOptions` has **zero consumers**, and its inner loop discards the return value — dead code that validates nothing | Low | Confirmed (source) — new, §2.4 |

### 2.2 The one prior-report assumption this plan overturns

`docs/opencode-context.md:145` (F1 design) states:

> *"Stale generation callbacks cannot reset the counter because they are no-ops (the `generation === currentGeneration` check prevents them from reaching the reset code)."*

**The guard does not prevent the reset — it is the path that reaches it.** `hydrate` returns *early* (not throws) at `v2ThreadController.ts:666` and `:686` when the generation changed, so the superseded attempt reaches the success tail at `:784-787` and runs `reconnectAttempt = 0`. The audit reproduced this: with a budget of 3, six failure cycles produced **7** connection attempts and the controller **never** reached `{type:"failed"}`.

This is why the plan does not simply "add a max-attempt check" — the check exists; the accounting is what is broken.

### 2.3 The final code sweep — what was verified, and what was rejected

A sweep of the OpenCode files the earlier passes had not read produced a list of candidate defects. **A sweep report is not evidence.** Every item was re-checked against the current source before it was admitted to §2.1, and the items that did not survive were recorded here rather than dropped.

**Admitted (each re-read and confirmed against the current source at `3351f81`):**

| ID | Mechanism | Source |
|---|---|---|
| **M11** | `fetchServerDefaultModel` and `resolveStoredModel` (`sessionModel.ts:91-111`) have **no** `try/catch` and delegate to functions that **throw** (`capabilities.ts:249-254`, `:105-113`), while the doc comment claims *"Tolerant by construction: a server that cannot be asked yields `null`"*. The session-**create** path calls both **unguarded** (`sessions.ts:307-308`), so a catalogue-read failure aborts session creation instead of degrading to "no model". The adopt path (`sessions.ts:155-156`, inside `assignSessionModelIfMissing`) does catch — so only creation is affected. **The documented tolerance does not exist in the code.** | `src/services/opencode/sessionModel.ts:91-111` · `src/services/opencode/sessions.ts:307-308` |
| **M12** | `apiFetch("/api/opencode/capabilities").then((r) => r.json())` never checks `r.ok`, and `apiFetch` does not throw on non-2xx. The backend answers a failure with a JSON body (`routes/opencode.ts:328`), so a 503 **parses successfully**; `data.agents ?? []` / `data.models ?? []` yield empty lists, the hook's `error` stays `null`, and `isLoading` goes false. The picker is silently emptied with no error shown — exactly the failure `capabilities.ts:167-173` calls catastrophic (*"the Code chat then has no model to select and no turn to run"*), and the only recovery trigger is a `recoveryEpoch` change. | `web/src/features/opencode/useOpenCodeCapabilities.ts:104-108` |
| **M13** | `claimPendingFirstMessage` **persists `claimed: true`** before the append is dispatched (`FirstPromptHandoff.tsx:107`), and `clearPendingFirstMessage` runs only after it resolves (`:146`). A reload in that window leaves the entry claimed, and the repo's own test asserts that a claimed entry is never re-claimable (`pendingFirstMessage.test.ts`, *"is present but marked claimed, so no second fire"*). The user's **first prompt is silently lost** — the agent stays idle on a turn that never ran. | `web/src/features/opencode/FirstPromptHandoff.tsx:107,146` · `web/src/features/chat/state/pendingFirstMessage.ts:91-108` |
| **M14** | `V2FormCard` renders `<V2OptionControl …>` **without a `key`** (`V2FormCard.tsx:560`), and the control holds `otherChosen` and `draft` in `useState` (`V2OptionControl.tsx:235-236`). React reconciles by position, so the same instance survives a field change: a half-typed "add your own" entry **leaks into the next question**, and `commitDraft` (`:259`) appends the *previous* question's text to the *new* field's answer. The wrong answer reaches the agent. | `web/src/features/opencode/V2FormCard.tsx:560` · `V2OptionControl.tsx:235-236,259` |
| **M15** | `options()` truncates to 100 with `value.slice(0, OPENCODE_V2_FORM_OPTION_LIMIT)` and **does not** set `unsupportedReason` — unlike the field-limit path, which does. A required select whose correct answer is option #120 can never be answered, and the reader is never told options were dropped. | `web/src/features/opencode/v2Forms.ts:88` |
| **M16** | The final `else` in `projectV2Form` projects **any** unrecognised field type as `"multiselect"` with no `unsupportedReason`. The managed `opencode serve` binary is versioned independently of the pinned npm client, so a newer server can send a field type the `FormField` union does not contain. The form then claims to be answerable (`canAnswer` is true) while rendering **no control**, and a required field makes it permanently unsubmittable. | `web/src/features/opencode/v2Forms.ts:157-166` |
| **M17** | `OpenCodeStatus.retry()` does `void extras.reconcileStagedRevert()` with **no `.catch`**; `reconcileStagedRevert` rejects with a `V2ControllerError` on failure. Every failed "Retry recovery" produces an **unhandled promise rejection**. The controller itself calls it correctly elsewhere (`v2ThreadController.ts:1212`: `.catch(() => undefined)`). | `web/src/features/opencode/OpenCodeStatus.tsx:66` |
| **M18** | `dockSeen.current` is assigned `false` twice (`V2FormCard.tsx:396,413`) and **never `true`**, so the step-change focus guard `if (!dockSeen.current) return;` (`:410`) always short-circuits: the documented focus move never runs. The guard that "protects" it is a **source-text** assertion (`tests/unit/web/components/approval-keyboard.test.ts` reads the card sources), so it stays green with the behaviour dead — a guard that cannot fail. | `web/src/features/opencode/V2FormCard.tsx:216,396,410,413` |
| **M19** | On a failed append the handoff calls `unclaimPendingFirstMessage` (`FirstPromptHandoff.tsx:137`), and the effect re-runs whenever `boundSessionId` changes (`:176-185`). The module's own doc says *"failed prompts are never auto-resubmitted"* (`pendingFirstMessage.ts:17`), but the code **does** re-submit — the repo's test even names it (*"unclaim releases a synchronously-failed handoff so a later attempt may fire"*). If the send actually reached the server before its promise rejected, the user's first message is delivered **twice**. | `web/src/features/opencode/FirstPromptHandoff.tsx:136-137,176-185` · `web/src/features/chat/state/pendingFirstMessage.ts:17` |
| **L7** | `bindV2PermissionOptions` has **zero consumers** anywhere in `web/src` (grep across the tree returns only its own definition), and its inner loop `hostResponseFor(binding, presentation)` **discards its return value** — so it validates nothing and binds nothing. The shared approval gate works only because it renders the declared options itself. | `web/src/features/opencode/v2Permissions.ts:241-250` |

**Rejected — the sweep's claim did not survive verification.** Recorded so it is not re-raised:

| Claim | Verdict |
|---|---|
| *"`recoveryEpoch` cannot distinguish a mount from a transition, so mounting with a non-zero epoch reconnects."* | **Rejected.** The call site seeds the ref with the **current** epoch (`OpenCodeView.tsx`: `useRef(recoveryEpoch)`), so `seenRecoveryEpoch === recoveryEpoch` on mount and `shouldReconnectForEpoch` returns `reconnect: false` (`recoveryEpoch.ts:26-28`). The documented behaviour holds. |
| *"A source-less permission is never auto-approved."* | **Rejected as stated.** The **event-time** arm path (`v2ThreadController.ts:436-465`) does not filter on `toolCallId`, so such a request *is* auto-approved there. What is true is narrower: the **drain** path (`reconcileAutoApprove`, `:1139-1143`) skips `toolCallId === null`, so a source-less request that was *already pending* when the shield was switched on is never answered by the drain. That inconsistency is real; the sweep's framing was not. |

**Also confirmed clean by the sweep** (recorded so they are not re-investigated): `questionSerializers.ts`, `OpenCodeQuestions.tsx`, `OpenCodePermissions.tsx`, `CodeShell.tsx`, `v2ThreadList.ts`, `compactSession.ts`, and the message-projection questions in `v2MessageProjection.ts` (message ids are deduped at their source, and every role that reaches the projection produces at least one part).

**A note on method.** The sweep read the files and reasoned; it did not execute them. Every **admitted** item above is therefore **source-confirmed**, not runtime-verified — with two exceptions noted in §2.1 (M10, runtime-verified). The new items' behavioural evidence is a **Phase 0 deliverable**, exactly like every other finding in this plan: the R-series captures the verbatim assertion-error block, and a finding that turns out not to reproduce is recorded as such.

### 2.4 Hypotheses tested and disproven

Recorded so the next reader does not re-investigate them.

| Hypothesis | Verdict | Basis |
|---|---|---|
| Browser-controlled authorization can replace backend authentication | **Disproven** | `src/routes/opencode.ts:381-398` deletes `authorization` and every hop-by-hop header, then sets the server's own Basic header. The browser never holds the OpenCode credential. |
| Disposal leaves blocked `connect()`/hydration operations unsettled | **Disproven** | `v2ThreadController.ts:1217-1232` aborts both signals, closes the event reader, rejects `readyPromise`, and rejects every admission with `"disposed"`. Covered by the repo's own test at `:886`. |
| `awaitPromptAdmission` hangs on an ambiguous admission | **Disproven** | `:324-330` resolves the waiters with `"ambiguous"`. The hang is in `sendMessage`'s own promise (M3). |
| The retry ceiling is absent entirely | **Disproven (partial)** | `b022b8b` added it; it works on the connect-failure path. It does not hold on the hydration-overlap path (M1). |
| The stale-generation guard prevents a stale attempt from mutating newer state | **Disproven** | See §2.2; also H2 and M2. |
| The preferred auth env var is the undocumented one, contradicting the upstream contract | **Disproven — withdrawn (was L6)** | Upstream V2 reads `OPENCODE_PASSWORD` first and honours `OPENCODE_SERVER_PASSWORD` as the legacy fallback (`packages/cli/src/env.ts:7-13`). TBAi matches it exactly. The published prose that says otherwise is the V1-era doc surface (§3.4.8). |
| Wildcard-overlapping permission rules are a defect in TBAi's write path | **Disproven — withdrawn (was part of H3)** | Overlapping patterns are a **core, intended** part of the V2 precedence model. TBAi's defect is **row identity**, not evaluation (§3.5.2). |

---

## 3. The reference study: what OpenChamber already solved

OpenChamber has run on OpenCode 2.x since 2026-09 (`PR #3837`) and maintains a 1,300-line architecture document for its event layer (`packages/ui/src/sync/DOCUMENTATION.md`) and a tracked boundary contract (`.agents/skills/opencode-v2/SKILL.md`). Its OpenCode subsystem is roughly the same size as TBAi's but is split across ~60 focused modules instead of one 1,263-line controller.

### 3.1 The structural difference that matters

**TBAi concentrates the whole runtime in `web/src/features/opencode/v2ThreadController.ts` (1,263 lines):** event loop, hydration, admission, permissions, forms, cancellation, reconnect, compaction, revert. **Seven of the thirteen findings live in that one file.** OpenChamber separates the same responsibilities:

| Concern | OpenChamber | TBAi today |
|---|---|---|
| SSE subscription + reconnect | `sync/event-pipeline.ts` | `v2ThreadController.ts` |
| Wire → domain translation | `lib/opencode/events.ts` | `v2Events.ts` (mixed with the reducer) |
| History load / pagination / commit | `sync/session-message-loader.ts` | `v2ThreadController.ts` `hydrate()` |
| Optimistic records | `sync/optimistic.ts` | inside `v2ThreadController.ts` |
| **Snapshot ↔ live-event merge** | `sync/directory-recovery-snapshots.ts` | **absent** ← H2 |
| **In-flight prompt registry** | `sync/prompts-in-flight.ts` | **absent** ← M3 |
| **Startup / readiness gate** | `sync/opencode-startup-gate.ts` | **absent** ← M3, M4 |
| Blocking-request index | `sync/global-blocking-requests.ts` | `v2Permissions.ts` + `v2Forms.ts` |
| Bounded per-session state | `lib/opencode/provider-tracker.ts` | unbounded maps in the controller ← L1 |

OpenChamber also publishes an **ownership map** — a table of *layer → owns → scope* (`DOCUMENTATION.md:92-107`) — which TBAi has only at whole-app granularity (`docs/architecture.md`).

### 3.2 Pattern catalogue

Each pattern below is the reference's answer to a specific TBAi finding. Citations are `file:line` in `D:\Temp\openchamber`.

#### P1 — Snapshot merges with live events; it never replaces them *(fixes H2, M5)*

`packages/ui/src/sync/directory-recovery-snapshots.ts` (129 lines) is a three-way merge:

```ts
const snapshot = new Map(fetched.filter(...))                                   // 1. the server's answer
for (const id of before.keys()) if (!current.has(id)) snapshot.delete(id)        // 2. locally gone → drop
for (const [id, request] of current)
  if (before.get(id) !== request) snapshot.set(id, request)                      // 3. locally changed → WINS
for (const [id, request] of changes) {                                          // 4. events seen DURING the read → WIN
  if (request) snapshot.set(id, request); else snapshot.delete(id)
}
```

The enabling mechanism is `withRecoveryObserver` (`:18-35`): an observer registered **for the duration of the read only**, removed in `finally`, capturing every event that lands mid-flight.

Stated rule, `DOCUMENTATION.md:536-538`:

> *"clears pages omitted from that map and **overlays page events received during the read**, including a settlement whose ask never reached this client. Otherwise a delayed snapshot can resurrect an answered page, and a lost settlement leaves a question badge indefinitely. … Forms and permissions remain additive because their host map only forwards OpenCode events and can itself miss a settlement."*

Message-level equivalent: `session-message-loader.ts:1158-1201` (`commitPage`) has three modes — `"merge" | "prepend" | "replace"` — and `"replace"` is used **only** when the new window provably fails to join the cache (`:733-735`); `mergeOptimisticPage` (`optimistic.ts:41-72`) merges rather than drops.

**What TBAi took from P1, and what it did not (delivered in Phase 4 — see §5.5.1).** The three-way rule is the part adopted; the observer registry that enables it in the reference is not. TBAi's commit carries the ids the transcript **held** and the ids live events **touched**, and the reducer applies the rule to them. The reference needs an observer because its commit can run against a cache that kept changing; TBAi already buffers the events that arrive during a read and drains them after the commit, so a second mechanism would be observing the same window twice — and the two could disagree about an event that arrived between them. The reference's three commit modes also reduce to two cases here, and one of them (`"replace"`) has **no caller in TBAi at all**: an empty held set on a first load already is a replace.

#### P2 — Attempt-scoped resets live inside attempt-scoped closures *(fixes M1, M2)*

`packages/ui/src/sync/event-pipeline.ts:657-666` resets the failure counter in `markConnected()`, which is called from **inside** the per-attempt function (`:760-782`):

```ts
const runSseAttempt = async (signal: AbortSignal) => {
  let connected = false
  for await (const event of events) {
    if (!connected) { connected = true; markConnected() }   // :773
  }
}
```

A superseded attempt cannot reach the reset, because the reset lives inside *its own* closure and fires only when *that* attempt receives an event.

TBAi does the opposite — `v2ThreadController.ts:784-787` puts `reconnectAttempt = 0` in a shared outer tail that any attempt, including a superseded one whose `hydrate` returned early, can reach.

Also worth taking from the same file: the backoff policy (`:629-638`) caps at **5 s when visible and online, 60 s when hidden or offline**, permanent 4xx jumps straight to the long cap (`:1043-1044`), and `waitForRetry` resolves early on `online`/visibility (`:1061-1063`).

#### P3 — An in-flight prompt owns its own state until it settles *(fixes M3)*

`packages/ui/src/sync/prompts-in-flight.ts` (42 lines):

```ts
const promptsInFlight = new Map<string, number>()
export function trackPromptInFlight(sessionId: string): () => void {
  promptsInFlight.set(sessionId, (promptsInFlight.get(sessionId) ?? 0) + 1)
  let released = false
  return () => { if (released) return; released = true; /* decrement */ }
}
```

> *"OpenCode admits a prompt only after the session's directory has started… its active-session list does not name the session, so a status snapshot read in that window cannot tell that the send is pending and **must not lower the busy status the send set**."*

`withPromptsInFlight` (`:31-41`) enforces that a snapshot may not downgrade a session with an unadmitted prompt. Note the **idempotent release** guard — TBAi's `admissions` map has none.

#### P4 — Every held operation has a bounded, settling timeout *(fixes M3, M4)*

`packages/ui/src/sync/opencode-startup-gate.ts` (129 lines). `DOCUMENTATION.md:1313-1315`:

> *"…resolves when the page first connects, and **rejects after three minutes or on a runtime switch so the composer restores the text**."*

Three-way settle with cleanup in `finally` (`:41-66`), a **visible** `waitingSends` counter the composer renders, and `runAfterOpenCodeStartup` (`:115-129`) which releases held sends **one at a time, in the order they were made**, so a later message cannot reach OpenCode first.

#### P5 — Redact `settings.apiKey` at the server boundary *(fixes H1)*

`packages/web/server/lib/opencode/config-v2.js:669-689`:

```ts
/** … in v2 shape, **without the literal `settings.apiKey` secret**. */
if (entity.settings && 'apiKey' in entity.settings) {
  const { apiKey: _secret, ...settings } = entity.settings;
  if (Object.keys(settings).length) entity.settings = settings;
  else delete entity.settings;
}
```

TBAi already redacts the same secret from `/api/model/default` (`src/services/opencode/capabilities.ts:41-45`); the config path needs the identical treatment.

#### P6 — Allowlist what may cross the boundary; never blocklist *(fixes M8, H1)*

`packages/web/server/lib/opencode/proxy.js:265-320`:

> *"The list is an **allowlist, not a blocklist**: OpenCode keeps adding to `SessionInfo`, and a session list is fetched constantly, so anything heavy that appears later must not silently start crossing the wire."*

#### P7 — Generation tokens guard every async commit *(fixes M2)*

`packages/ui/src/lib/opencode/client.ts:1864-1905` captures `const generation = this.configCacheGeneration` **before** the request and only writes the cache `if (generation === this.configCacheGeneration)`; `clearConfigCache()` (`:1846-1850`) bumps it to invalidate in-flight reads.

`packages/ui/src/sync/session-message-loader.ts:917-921` (`bumpGeneration`) plus `:1166` and `:1189` (`if (!isCurrent()) return null` **before and after** materializing) and `:686-695` (a queued refresh re-checks four independent identities).

TBAi's equivalent is three module-level mutable slots — `resolveReady`, `rejectReady`, `loadPromise` — that any attempt can clobber.

#### P8 — Fail closed; leave the request for the human *(fixes M6)*

`DOCUMENTATION.md:579`:

> *"Unknown lineage and **exhausted reply retries fail closed and leave the request available for manual action**. A later `permission.replied` event invalidates any older deferred ask so the async policy check cannot resurrect a resolved request."*

#### P9 — Bounded state with TTL + max entries, and test the eviction *(fixes L1)*

`packages/ui/src/lib/opencode/provider-tracker.ts:14-15, 32-40, 59-62`: `PROVIDER_EVICTION_TTL_MS`, `PROVIDER_MAX_ENTRIES = 200`, TTL sweep plus oldest-first eviction. The policy itself is tested (`packages/ui/src/sync/eviction.test.ts`, `eviction-thrash.test.ts`).

#### P10 — Staleness is stream *activity*, not delivered events *(informs L5, M1)*

`DOCUMENTATION.md:575`:

> *"The watchdog calls the stream stale after 20 s without **stream activity**. … an event, a WebSocket frame, or **a keepalive that carries no event**. OpenCode 2 sends its heartbeat as an SSE comment… **Counting delivered events alone made an idle viewed session look stale, so the stream reconnected and resynced every 15 to 20 s**, as reported in #4062. **Starting a connection attempt is not activity**, so a stream that receives nothing still goes stale."*

TBAi already observes the proxied SSE body (`src/routes/opencode.ts:510-638`) and could surface that signal; it currently does not.

#### P11 — Only clone what the event mutates *(performance, not a finding)*

`DOCUMENTATION.md:959-985`: eager spreading of all state fields cost ~10× in re-renders at ~60 events/sec (`message.part.delta`); targeted cloning took MessageList renders from **1972 → 296** per session.

### 3.3 What OpenChamber does **not** solve — do not cargo-cult

| Reference behaviour | Why it does not transfer |
|---|---|
| **No hard retry cap** — retries forever (`event-pipeline.ts:975-1065`) | TBAi is a local single-user app; a bounded ceiling with a visible terminal state is better UX. **Keep TBAi's cap; fix the reset scoping (P2).** Borrow the foreground/background delay policy. |
| Directory-scoped stores, one per project (`child-store.ts`) | TBAi is one conversation → one workspace → one session. Multi-directory architecture for no gain. |
| WebSocket **and** SSE dual transport | TBAi's proxy does SSE. Borrow the *transport-switch discipline* (`onTransportSwitch?.()` → resync authoritative state, `:1001-1006`), not the transport. |
| Server-side permission auto-accept with a classifier (`DOCUMENTATION.md:540`) | TBAi's fail-closed client-side shield is correct. Borrow only the replay rule: a held-back request is replayed to the user if the server could not answer it. |
| A 1,300-line sync `DOCUMENTATION.md` | Proportionate to their system. Adopt the **ownership-map table** (~20 lines), not the document. |
| Multi-device / tunnel / PWA (`tunnel-auth.js`, mobile package) | Out of scope. |
| Redacting only the literal `apiKey` | Narrow. TBAi should redact **by key shape** at any depth, because OpenCode's config schema grows. |

---

## 3.4 The official API contract — what the published docs and the pinned client actually say

The second reference is the **upstream itself**: the published JSON Schema (`https://opencode.ai/config.json`), the published doc sources (`https://opencode.ai/docs/<page>.md` — Astro serves the markdown), and the installed `@opencode/client@2.0.32` contract surface.

This study produced three corrections to the plan, two new findings, and one decisive negative result.

### 3.4.1 The published prose docs describe **V1**; the pinned client is **V2**

`docs/server.md`'s route table lists `POST /session/:id/message`, `POST /session/:id/abort`, `PUT /auth/:id`, `POST /provider/{id}/oauth/authorize`. The installed client exposes a **different, much larger** V2 surface under `/api/*` — ~140 routes. The subset TBAi's own client calls:

```
/api/event            /api/info            /api/config
/api/session          /api/session/{id}                 /api/session/{id}/message
/api/session/{id}/message/{messageID}                  /api/session/{id}/prompt
/api/session/{id}/interrupt                           /api/session/{id}/compact
/api/session/{id}/inbox  /api/session/{id}/inbox/{id}
/api/session/{id}/permission  /api/session/{id}/permission/{requestID}/reply
/api/session/{id}/form  /api/session/{id}/form/{formID}/reply
/api/session/{id}/revert  /api/session/{id}/revert/stage  /api/session/{id}/revert/commit
/api/session/{id}/model  /api/session/{id}/agent  /api/session/{id}/diff
/api/permission  /api/permission/request  /api/form
/api/model  /api/model/default  /api/provider  /api/agent  /api/command
```

**Consequence:** the authoritative contract for TBAi is the **installed client's type surface**, not the prose. `docs/decisions.md` (§ "Strict V2 data boundaries") already asserts V2 — its *citations* should point at `node_modules/@opencode/client/dist/promise/generated/types.d.ts`, not at the prose docs, which describe the previous generation.

### 3.4.2 The proxy is a **Critical** finding, and the allowlist is now knowable

The proxy catch-all (`src/routes/opencode.ts:345-502`) forwards **any** method, path and body to the managed server, injecting the server's own OpenCode Basic credential. The upstream surface reachable through it includes:

| Upstream route | Effect |
|---|---|
| `POST /api/session/{id}/shell` | **run a shell command** |
| `GET /api/fs/read/{path}`, `GET /api/fs/find`, `GET /api/fs/list` | **read the filesystem** |
| `POST /api/experimental/fs/write` | **write files** |
| `PUT /api/credential/{id}`, `GET /api/credential` | **read/set provider credentials** |
| `POST /api/integration/{id}/connect/command`, `/connect/external`, `/connect/key` | **run arbitrary commands / connect external integrations** |
| `POST /api/rpc/{id}/{method}` | **generic RPC dispatch** |
| `POST /api/pty/{id}/connect-token`, `POST /api/experimental/persistent-pty/handoff` | **spawn a PTY** |
| `PATCH /api/config` | **rewrite OpenCode's configuration** |
| `POST /api/mcp` | **add an MCP server dynamically** |
| `POST /api/vcs/init` | initialise a git repository |
| `GET /api/experimental/session/{id}/export` | export session data |

And the CORS policy (`src/routes/index.ts:38-62`) trusts **every** `http://localhost:<port>` and `http://127.0.0.1:<port>` origin. The audit verified the **preflight succeeds** (`OPTIONS` → 204, `Access-Control-Allow-Origin` echoed, `Allow-Methods` includes `POST`, `Allow-Headers` includes `x-opencode-directory`), so a cross-origin POST with a JSON body is sent and its response is readable.

**Net effect: a web page served from any localhost port can execute shell commands as the TBAi user, read and write files, and rewrite provider credentials — through TBAi's own API, with the response readable.** The proxy's design assumption ("the browser is the trusted TBAi frontend") is broken by the breadth of the CORS origin policy.

**The allowlist is now derivable** from §3.4.1 — and it is **smaller than the client's full surface**, because the browser never calls the catalogue routes (the backend does, directly). The browser's own operations are `serverInfo`, `sessionGet`, `switchAgent`, `switchModel`, `prompt`, `compact`, `interrupt`, `inboxList`, `inboxCancel`, `revertStage`, `revertCommit`, `revertClear`, `formList`, `formReply`, `formCancel`, `permissionList`, `permissionReply`, `history.list` and `event.subscribe` — that is `/api/info`, `/api/event`, and the `/api/session/{id}/*` family. Everything else can be refused. That answers **D10**, and the route-to-class mapping answers **D11** (§5.2).

### 3.4.3 The credential surface in the config file is far larger than `apiKey`

The published schema (`$defs.Config.ProviderEncoded`, `additionalProperties: false` on the provider object) plus the docs give the authoritative list:

| Path in `opencode.json` | Schema | Holds |
|---|---|---|
| `providers.<id>.settings.apiKey` | `Config.Provider.Settings` allows arbitrary extra keys via `allOf: [{additionalProperties: …}]` | the provider key |
| `providers.<id>.settings.*` | arbitrary | anything secret |
| `providers.<id>.headers` | `additionalProperties: {type:"string"}` | `Authorization: Bearer …` |
| `providers.<id>.body` | arbitrary object | provider-specific secrets |
| `provider.<id>.options.apiKey` | `ProviderConfig` (v1 legacy) | the provider key |
| `mcp.<name>.headers.*`, `mcp.<name>.environment.*` | docs `mcp-servers.md` | `Authorization: Bearer …`, `*_API_KEY` |
| `mcp.<name>.oauth.clientSecret` | `Mcp.OAuthConfigEncoded` | the OAuth client secret |
| `plugins[].env` | docs `plugins.md` | plugin environment |
| `agents.<name>.*` | `AgentConfig` | per-agent provider options |

**Variable substitution changes the redaction design.** `docs/config.md:864-910` defines:

```
{env:VARIABLE_NAME}      → substituted from the environment
{file:path/to/file}      → substituted from a file (relative to the config dir, or absolute / ~)
```

So a config value is *either* a literal secret *or* a reference to one. The redaction must distinguish them: a literal is masked; a `{env:…}` reference discloses only a variable name (mask it anyway — it is a hint); a `{file:…}` reference discloses **a path to a secret file** (mask the path).

**Two credential stores are outside the config file** and reachable through the proxy: `auth.json` (provider keys / OAuth tokens) and `mcp-auth.json` (MCP OAuth tokens) — `docs/troubleshooting.md:27`, `docs/mcp-servers.md:237`, `docs/cli.md:143`. The proxy allowlist (§3.4.2) is what keeps them out of the browser.

### 3.4.4 The official docs and the official schema disagree about permissions — and TBAi followed the schema

- `docs/permissions.md` documents the **v1 object** form: `{"*": "ask", "bash": "allow"}`.
- The **schema** defines `permissions` as `$defs/Permission.Ruleset` — an ordered **array** of `{action, resource, effect}`, all three required, `additionalProperties: false`.

**TBAi implements the array form**, which matches the schema. `docs/decisions.md` (§ "The OpenCode Configuration page…") asserts the array form without citing the schema; that citation is now available and should be added.

**The question this raised is now answered — by the upstream source, not by the prose.** The prose says *"Rules are evaluated by pattern match, with the **last matching rule winning**."* TBAi's write path edits the **first** rule matching the same `(action, resource)` pair (`src/services/opencode/configDocument.ts:370-396`). §3.5 establishes the upstream semantics and isolates the **actual** defect: a rule is addressed by its *content* rather than by its *position*, so an exact-duplicate configuration can cause the wrong row to be edited. The wildcard-overlap case is **not** a defect — it is the V2 precedence model working as designed.

### 3.4.5 Decisive negative result: there is **no official stream resume**

```ts
// node_modules/@opencode/client/dist/chunks/shared-events-hqeq47hr.js:1048-1049
event: {
  subscribe: (requestOptions) => sse({ method: "GET", path: `/api/event`, successStatus: 200, ... }, requestOptions)
}
```

`/api/event` takes **no query parameters** — no `since`, no `cursor`, no resume token. Every other route takes `query: { location: input["location"] }`; `/api/event` takes nothing.

Two consequences:

1. **H2 and M5 cannot be fixed by resuming the stream.** The history-read-then-replay design is not a workaround for a missing feature — it is the only shape the upstream contract permits. Merging (P1) is therefore not a preference, it is the fix.
2. **The only way to scope the event stream is the `x-opencode-directory` header**, which is **undocumented** in the official docs. TBAi depends on it (`web/src/features/opencode/v2Client.ts:158-160`, `src/services/opencode/runtime.ts:174-176`). It works, but it is an empirical contract that the official docs do not describe — worth recording in `docs/decisions.md` so a future OpenCode upgrade knows it is load-bearing.

### 3.4.6 Every V2 event carries a `location` — and TBAi ignores it *(new finding M9)*

```ts
// @opencode/client@2.0.32 types.d.ts
export type LocationRef = { directory: AbsolutePath; workspaceID?: WorkspaceID };
export type LocationPublicRef = { directory: AbsolutePath };
```

Every V2 event type carries `location?: LocationRef` (e.g. `types.d.ts:1296,1315`). The official contract therefore provides the scope of each event, precisely so a client can verify it.

TBAi's reducer filters events by `data.sessionID` only (`web/src/features/opencode/v2Events.ts:142-147`) and never reads `event.location`. A mis-scoped or cross-directory event would be applied to the wrong session. OpenChamber has a dedicated module for this (`packages/ui/src/sync/events.ts`, `sync/location-scoped-forms.ts`, `GLOBAL_EVENT_DIRECTORY`).

**M9 is a defensive gap, not a proven mis-delivery** — TBAi scopes its subscription with the header, so the server should only send that directory's events. The finding is that TBAi has no *verification* of what the contract provides.

### 3.4.7 assistant-ui already answers two of our findings

Read from the installed `@assistant-ui/core@0.3.30` (`dist/runtimes/external-store/external-store-adapter.d.ts`):

- **History is prepend/merge, not replace** — `onLoadEarlier`: *"the host **prepends** it to `messages` (stable message ids keep rendered rows and scroll position in place)"*. **This validates the H2 fix**: the library's own contract for loading history is a merge, which is exactly what TBAi's second `history_loaded` projection gets wrong.
- **`activeRunId`** — *"The current run's id, kept through `cancelRun` so its late calls can be discarded."* assistant-ui already ships the **stale-attempt-discard mechanism TBAi lacks** (M2). TBAi should use it, or mirror its semantics in the controller.
- **`canResume` + `onResume(config: ResumeRunConfig)`** — *"Opt in only while an interrupted run has a resumable checkpoint… Resuming must preserve the existing message and tool execution state."* A first-class resume contract TBAi does not use; relevant to M4's "recoverable state".
- **`messageRepository`** — *"swaps to it atomically whenever a different instance is passed"*, confirming TBAi's repository-cache approach in `v2RuntimeStore.ts:133-152` is sound.

### 3.4.8 Version drift, and the auth env-var precedence *(L6 — withdrawn)*

- The installed client is **`@opencode/client@2.0.32`**; `docs/decisions.md` still says `2.0.16` (the decision line *"TBAi uses the official `@opencode/client@2.0.16`"*, and *"installed `2.0.16`; current `2.0.24`"* in the architecture-lock section) — both **stale**, and now **self-contradicting within the same file**: its own dependency table records *"`@opencode/client` 2.0.25 → 2.0.32 (both manifests)"*. `docs/opencode-context.md` correctly says CLI 2.0.32. **The locally installed managed binary was checked directly: `D:\Coding\OpenCode\opencode.exe --version` → `opencode v2.0.32`**, so the CLI and the pinned client are the same version. *(Quoted text, not line numbers, is the anchor here: `docs/decisions.md` is being edited concurrently — see §1.1.)*
  - The same commit added a decision that the **live OpenCode e2e is never a gate** — *"it never runs on push or PR and is never a gate. A third-party free model must not be able to turn the code base red."* That is consistent with this plan's **G5**: the live spec is an opt-in signal, not a baseline, and the Playwright suite's health is a separate question from the managed OpenCode server's.
- ~~The preferred operator auth env var is the undocumented one~~ — **WITHDRAWN. This was a false positive, and the correction is verified against upstream source.** The published prose (`docs/server.md:34`, `docs/cli.md:695`) names `OPENCODE_SERVER_PASSWORD`, but that prose is the **V1-era doc surface** — the same reason it cannot be used as V2 evidence elsewhere (§3.4.1). The authoritative upstream source, `packages/cli/src/env.ts:7-13`, reads:

  ```ts
  // The opencode server password: sent by clients connecting to an explicit
  // --server, and adopted by a manually run or standalone server. The legacy
  // name is still honored.
  export const password = Config.Redacted("OPENCODE_PASSWORD").pipe(
    Config.orElse(() => Config.Redacted("OPENCODE_SERVER_PASSWORD")),
    Config.withDefault(undefined),
  )
  ```

  **`OPENCODE_PASSWORD` is primary and `OPENCODE_SERVER_PASSWORD` is the legacy fallback** — which is exactly what TBAi does (`src/config/opencode.ts:48-50` names them `authPasswordEnvVar` / `authPasswordLegacyEnvVar`; `src/services/opencode/runtime.ts:138-153` reads them in that order, and sends both to the child). **TBAi matches upstream exactly.**
  - In this environment both variables are set and byte-identical, so nothing was misconfigured here either.
  - **What remains is a documentation defect, not a code defect:** `docs/security.md` and the V2 contract should state the actual upstream behaviour and cite the upstream source rather than the V1-era prose. Decision **D18** is reversed accordingly.

---

## 3.5 The upstream V2 source — the permission semantics TBAi must not contradict *(finding H3)*

The published prose says permission rules resolve **"last matching rule winning"** (§3.4.4), but it documents the **V1 object form** and does not define the V2 array form's ordering. The authoritative answer is in the upstream source, `sst/opencode@dev` (which resolves to `anomalyco/opencode`).

**This section establishes the semantics TBAi must respect. It does not propose reimplementing them** — TBAi does not evaluate permissions; OpenCode does. What TBAi owns is *editing a specific rule the user selected*, and the semantic below is what makes that distinction matter.

### 3.5.1 The V2 algorithm

`packages/core/src/permission.ts`:

```ts
export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}
```

**`findLast`** — the **last** matching rule wins — and the match is **wildcard**, not equality. `packages/core/src/util/wildcard.ts`:

```ts
export function match(input: string, pattern: string) {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
}
```

So `*` → `.*`, `?` → `.`, path separators normalised, case-insensitive on Windows, and a trailing `" .*"` is optional.

The V2 schema, `packages/schema/src/permission.ts`, is `Rule = {action: string; resource: string; effect: "allow"|"deny"|"ask"}` and `Ruleset = Array<Rule>` — **exactly** TBAi's `openCodePermissionRuleSchema`. The V1 object form lives under `packages/core/src/v1/config/permission.ts` and is therefore **V1-scoped**, even though the current V2 schema still accepts legacy-shaped entries. Nothing in V2 requires removing it.

### 3.5.2 The actual defect — row identity, not rule evaluation

> **Correction.** An earlier draft of this plan conflated two different things and drew a wrong conclusion from it. It treated the upstream evaluation algorithm as the thing TBAi's write path must reproduce, and proposed resolving "the rule in force for this request" by wildcard search. **That is the wrong fix.** OpenCode's V2 precedence model is built on *overlapping* patterns — broad rules deliberately combined with narrower overrides — so wildcard overlap is a **normal, intended configuration**, and rejecting it (or refusing to edit a rule because a broader rule also matches it) would break the model.
>
> The **evaluation** algorithm is upstream's business. What TBAi owns is **editing a specific rule the user selected**. Those are separate concerns, and only the second one is TBAi's.

TBAi's write path, `src/services/opencode/configDocument.ts:370-396`:

```ts
const index = current.findIndex(
  (rule) =>
    (rule as Record<string, unknown>).action === match.action &&
    (rule as Record<string, unknown>).resource === match.resource,
);
```

and the `PUT /api/opencode/config/permissions` route, `src/routes/opencode.ts:286-313`, carries **only** `{action, resource, effect}` — no position.

**The defect is that a rule is addressed by its *content* rather than by its *position*.** When a configuration contains two rules with the **same** `(action, resource)` — which TBAi's own UI refuses to create, but a hand-edited file or another tool can produce — the backend edits the **first** of them, whichever row the user actually clicked. The page reports *"Saved to the OpenCode configuration."*

TBAi already has the correct pattern one route over: `removeOpenCodePermissionRule` (`:463-488`) addresses a rule by **index plus a re-check of the identity the caller saw**, and refuses the removal if the rule moved or changed. The edit path simply does not use it.

### 3.5.3 The consequences — precisely bounded

| Consequence | Reachable? | Verdict |
|---|---|---|
| **Exact-duplicate rules** (`(action, resource)` identical twice) → the wrong row is edited, and the page says "Saved" | Only from a hand-edited file or another tool — TBAi's own append path refuses exact duplicates | **The defect.** Precondition stated, not hidden |
| **Row identity collision in the UI** — `ruleKey()` is `action\0resource` (`OpenCodeConfigPage.tsx:117-119`), so two identical rows produce the same React key | Same precondition | **Part of the same defect** — duplicate keys break list reconciliation independently of the write |
| **Wildcard-overlapping rules** (`*` and `git *`) | **Yes — routinely, through TBAi's own UI** | **NOT a defect.** This is the V2 precedence model working as designed |
| **The append path** (new rule goes last ⇒ highest precedence) | Yes | **Correct.** Last-match-wins makes appending the right precedence, and the page says so |

**Severity: Medium.** The precondition is a configuration state TBAi's own UI cannot produce, the failure is confined to *which* of two identical rows is written, and the wrong write is visible after the page reloads — but the immediate feedback ("Saved") is misleading, and the row-identity collision is a live rendering bug whenever the precondition holds.

### 3.5.4 What this settles, and what it does not

- **Settled:** TBAi must address a rule by **position plus a re-checked identity** — the pattern `removeOpenCodePermissionRule` already uses — and the UI's row identity must be position-based, not content-based. The page should also **indicate when a rule is overridden** by a later, more specific match, so the user can see that a broader rule is shadowed rather than being denied the ability to edit it.
- **Explicitly NOT decided here:** whether TBAi should *warn* about, *refuse*, or *silently allow* a configuration containing **exact** duplicates. The current guard refuses an exact duplicate on append, and that guard is **kept as-is** — but whether a *pre-existing* exact duplicate should be refused, warned about, or edited normally is a maintainer policy call, recorded as **G7** (§9.1).
- **Not settled, and not invented:** the upstream evaluation order is not reimplemented in TBAi. TBAi does not evaluate permissions — OpenCode does. TBAi only needs the evaluation *semantics* to **display** which rule is in force, and that display is read-only.

---

## 3.6 Auxiliary-fetch failure is indistinguishable from "nothing pending" *(new finding M10)*

**Confirmed by runtime test.** Found while reviewing the plan's own Phase 4 change: the auxiliary hydration path cannot tell a *failed* fetch from an *empty* one.

**The mechanism.** `web/src/features/opencode/v2ThreadController.ts:563-606` (`loadAuxiliary`) reads the three pending sets and **catches each failure independently, degrading that one to an empty array**:

```ts
currentGeneration.operations.permissionList({ sessionID: client.sessionId })
  .catch((cause: unknown) => {
    logger.warn("opencode", "runtime.auxiliary_hydration_failed", { kind: "permission", ... });
    return [] as PermissionRequest[];
  })
```

`applyAuxiliary` (`:617-633`) then dispatches that empty array as `permissions_hydrated` / `forms_hydrated` / `inbox_hydrated`.

The reducer's guard (`web/src/features/opencode/v2Events.ts:790-804`) rejects only a snapshot that is **older** than the newest applied event:

```ts
case "permissions_hydrated":
  return isStaleSnapshot(action.requestOrdinal, state.eventIdentity)
    ? state
    : sameIdentitySequence(state.permissions, action.requests)
      ? state
      : { ...state, permissions: [...action.requests] };
```

A failure with **no concurrent event** is not stale, so the empty array **replaces** the live list.

**The reproduction** (scratch suite, outside the repository): a permission list that succeeds during hydration and **fails on the next read** leaves `state.permissions` as `[]` — the pending permission is **gone**. The control case (a successful read that authoritatively returns `[]`) also clears it, which is correct — the two cases must be distinguishable, and today they are not.

**Why it matters.** The path is live, not hypothetical: `resyncAuxiliary()` is driven by the 30 s interval in `useOpenCodeAuxiliaryResync.ts` (which fires only while the session is **idle**) and by every `visibilitychange` to visible (which fires unconditionally). So:

- A transient 5xx on the permission list **silently removes a pending approval from the UI**, with no error shown.
- The auto-approve drain (`reconcileAutoApprove`, `:1133-1150`) reads `state.permissions` — a cleared list means the drain finds **nothing to answer**, so the request is missed as well. The failure is **fail-closed** (nothing is wrongly approved), which is why this is Medium rather than High.
- Recovery is only on the next **successful** read — and the interval only runs while the session is idle, so during a busy session the prompt can stay invisible until the session goes idle or the tab is re-focused.

**The required fix.** An unsuccessful fetch must be represented as **unavailable**, not **empty**. The three kinds must be tracked separately: *authoritatively empty* (clear the list), *unavailable* (leave the list untouched and surface the degraded state), *stale* (already handled). A degraded auxiliary read must not be able to clear a live permission or form.

---

## 4. Target architecture

One decision, taken first, because it determines the shape of every other item.

> **Split the OpenCode frontend runtime out of `v2ThreadController.ts` into a focused `web/src/features/opencode/sync/` layer, using OpenChamber's decomposition as the boundary map.**

Target layout (all under `web/src/features/opencode/`, so the existing OpenCode ownership boundary in `AGENTS.md` is preserved and **no new top-level ownership area is created**):

| Module | Owns | Replaces / extracts from |
|---|---|---|
| `sync/attempt.ts` | Attempt identity, readiness/load promises, epoch, abort controllers | **new** — the M1/M2/L4 fix |
| `sync/eventPipeline.ts` | Event consumption and retry scheduling (the backoff timer and the attempt counter it charges) | `consumeEvents`, `scheduleReconnect` |
| `sync/sessionMessageLoader.ts` | History retrieval, pagination, page commit modes | `loadV2History` call site, `hydrate()`'s history half |
| `sync/recoverySnapshots.ts` | Snapshot ↔ live-event precedence, per-kind ownership rules | **new** — the H2 fix |
| `sync/optimistic.ts` | Optimistic message/parts records and their confirmation | `optimisticMessage`, `optimisticMessageIds` |
| `sync/promptsInFlight.ts` | Unadmitted prompt registry | **new** — the M3 fix |
| `sync/startupGate.ts` | Bounded waits, typed failure, user-visible waiting state | **new** — the M3/M4 fix |
| `sync/ownership.md` | The owner/scope table for the layer | **new** — the OpenChamber ownership map, scoped to TBAi |

### 4.1 Ownership map — what each module owns, may depend on, and must not mutate

**The two-owners rule:** each lifecycle has exactly **one** owner. The controller owns *state*; the `sync/` layer owns *lifecycle*; the route layer owns *capability*. A module that appears in two rows is doing two jobs and is a defect.

> **Correction.** An earlier draft of this map assigned "readiness" and "attempt lifecycle" to `eventPipeline.ts`, `attempt.ts` **and** `startupGate.ts` at once. Three owners of one lifecycle is worse than no owner. The map below assigns each responsibility **exactly once**, and states the interface that makes the separation checkable.

| Module | Owns (exactly this, nothing else) | May depend on | Must not mutate | Interface it exposes |
|---|---|---|---|---|
| `sync/attempt.ts` | **Attempt identity and its state**: a monotonically increasing attempt id, the attempt's readiness promise, its load promise, its epoch, and its abort controllers | `config.ts` (timings) | anything outside its own attempt | `createAttempt(id)`, `attempt.ready`, `attempt.load`, `attempt.abort()`, `attempt.isCurrent` |
| `sync/eventPipeline.ts` | **The event loop**: subscribing to the V2 event stream, consuming events, and **scheduling retries** (the backoff timer and the attempt counter it charges) | `v2Client.ts` (wire), `attempt.ts` | domain state; it never resolves or rejects a readiness promise — that is `attempt.ts`'s | `start(attempt, onEvent)`, `scheduleRetry(error)`, `stop()` |
| `sync/startupGate.ts` | **Waiting policy**: bounded waits on readiness, the typed failure they raise, and the user-visible waiting state | `attempt.ts` (it *asks* the attempt; it does not own the promise) | domain state; it never creates or settles an attempt | `awaitReady(timeoutMs)`, `waitingCount` |
| `sync/sessionMessageLoader.ts` | History retrieval, pagination, and the page commit (merge / replace) | `v2History.ts`, `v2Permissions.ts` | `state.messages` directly — it commits through the reducer | `load(attempt, options)`, `commit(page, mode)` |
| `sync/recoverySnapshots.ts` | **Snapshot ↔ live-event precedence**: which wins, and the overlay of events observed during a read | `v2Events.ts` (reducer) | anything but its merge inputs | `withRecoveryOverlay(read, apply)` |
| `sync/optimistic.ts` | Optimistic records and their confirmation | `v2Types.ts` | server-authoritative state | `add`, `confirm`, `remove` |
| `sync/promptsInFlight.ts` | The unadmitted-prompt registry and its idempotent release | — | admission verdicts | `track(sessionId) → release()` |
| `v2ThreadController.ts` | Domain state, dispatch, and policy — **delegating** to all of the above | the `sync/` layer | — | the existing `V2ThreadController` interface |
| `v2Events.ts` | Pure wire → domain reduction | `v2Types.ts` | anything (it is pure) | `reduceV2ThreadState` |
| `v2Client.ts` | The V2 wire boundary | `@opencode/client` | domain state | `createOpenCodeV2Client` |
| `src/routes/opencode.ts` | The **capability boundary**: route allowlist, workspace scope, redaction, upstream forwarding | `services/opencode/*` | — | Hono routes |
| `src/services/opencode/configDocument.ts` | discover → read → redact → targeted write | the published V2 schema | the user's file bytes, except the targeted write | the document API |

> **Two rows above are the target, not the tree.** `sync/recoverySnapshots.ts`
> was never created, and `sessionMessageLoader.ts`'s commit has no "replace"
> mode: Phase 4 delivered the H2 fix as reconciling **inputs** to the commit
> that already existed. The live record of what each module owns is
> `web/src/features/opencode/sync/ownership.md`; the delivery is §5.5.1.

**The three separations that were previously overlapping, stated as rules:**

1. **A promise is owned by the thing that can settle it.** `attempt.ts` creates and settles the readiness and load promises. `eventPipeline.ts` may *fail* an attempt (it reports the error), but it resolves the promise **through** `attempt.ts`. `startupGate.ts` never touches either promise — it awaits the attempt's promise and imposes a deadline on the *wait*, not on the promise.
2. **The retry counter lives with the scheduler.** `eventPipeline.ts` owns `reconnectAttempt` and the backoff timer. It is charged when a failure is scheduled and reset **only** when `attempt.ts` reports a *completed* hydration for the current attempt. This is the structural form of D2 — the reset can no longer be reached by a stale attempt, because a stale attempt cannot report completion for the current one.
3. **Waiting state is presentation, not lifecycle.** `startupGate.ts` owns the counter the composer renders. It observes the attempt; it does not drive it.

**The ownership rule that eliminates M1, M2 and L4 as a class:** *an attempt's readiness, load promise, abort signals and state commits belong to that attempt and are reachable only through that attempt's handle.* Every async continuation captures its own attempt and verifies identity before committing state, settling a promise, or resetting a counter. This is the same discipline as OpenChamber's `configCacheGeneration` (§3.2 P7) and as assistant-ui's `activeRunId` — a mechanism TBAi does not currently use (§3.4.7).

**Guardrails for the split** (from `AGENTS.md` §Change workflow):

- One diff, one concern. The extraction lands as its own phase (§5.3) and each fix lands as its own commit. The **capability boundary (§5.2.A) is deliberately ahead of it** — it is a different concern, in different files, and independently reviewable. Within the security group, **one concern is one review unit** (§5.2.0): four units, four diffs, four rollbacks, and no unit waits for another.
- Public APIs, wire formats, persistence schemas, lifecycle ordering and runtime behaviour are **preserved exactly** by the extraction. A structural move that changes behaviour is a different task and needs explicit authorization — so §5.3 is a pure move plus the Phase 0 characterization tests, and the behaviour changes start only in the security group (§5.2) and §5.4.
- No new dependency, no second router, no second state framework. Zustand remains UI state only; the sync layer stays plain TypeScript behind the existing controller interface.
- Every file gets exactly one owning directory, and every relocated file's consumers (static imports, dynamic `import()`, source-text guards, path strings in config, docs that name the path, CI/Playwright config) are enumerated before the move. `bun run test:locations` and `bun run lint` must stay clean.

---

## 5. Work items

Each item states its finding IDs, the change, the acceptance test, the risk, and what it must **not** do.

### 5.1 Phase 0 — Baseline, characterization and failing regression tests *(prerequisite for everything)*

**Findings:** none (this phase changes no behaviour).

**Two categories of test, with different pass criteria.** An earlier draft of this phase put both in one list and then required them all to pass — which is contradictory, because a test that demonstrates a defect must fail against the defective code. They are now separated, and the distinction is the phase's whole point.

| Category | Asserts | Passes against today's code? | Lives where |
|---|---|---|---|
| **B-series — baseline characterization** | **Today's behaviour**, defects included. It freezes what the system currently does so a later change can be shown to have altered it. | **Yes — must pass.** A B-test that fails means the baseline moved, not that a defect was fixed | Phase 0, merged immediately, and **replaced** by the corresponding T-test when the finding is fixed |
| **R-series — defect regression** | The **correct** behaviour. It fails today, and that failure *is* the proof the defect is real. | **No — must fail.** An R-test that passes means the defect is not there (or the test is not testing it) | Phase 0 as a **demonstrably failing** test, then **merged with the fix** in the phase that closes the finding |

**How a deliberately-failing test enters the repository without breaking CI.** Verified against this repo's runner (bun 1.4.3):

| Form | Runs in `bun run test`? | Fails the build? | Body executable on demand? |
|---|---|---|---|
| `test("…", fn)` | yes | **yes** if it fails | — |
| `it.skip("…", fn)` | **no** | no | **no** — bun has no flag to run a skipped body |
| `test.todo("…", fn)` | **no** | **yes** | the assertion error is **printed** (test name, `file:line`, `Expected:`/`Received:`), but the test is counted as **todo**, not as a fail | a failing todo does not make the run fail; a **passing** one does (see below) |

So the quarantine form is **`test.todo` with a body** - but the plan must be exact about what it can and cannot prove, because a previous draft of it got this wrong.

**The two measured facts a previous draft got wrong.**

1. A quarantine of **only failing todos** exits **0** in **both** modes. Measured: `bun test` gives `0 pass / 2 todo / 0 fail` with exit `0`; `bun test --todo` gives `0 pass / 2 todo / 0 fail` with exit `0` - with both assertion errors **printed**.
2. A todo whose body **passes** is reported by bun as a **failure** - "this test is marked as todo but passes. Remove `.todo` if tested behavior now works" - with exit `1`.

So the **exit code is not evidence** that a defect was demonstrated, and this plan must never cite it as such. The evidence is the **printed assertion error** - a quotable block naming the test, the file and line, and the expected and received values.

**Two different guarantees, which a previous draft ran together.**

| | **G-ORD — the ordinary-run guarantee** | **G-TODO — the `--todo` guard** |
|---|---|---|
| What runs | `bun run test` (no `--todo`) | `bun test --todo` over the OpenCode test tree |
| Do todo bodies execute? | **No** | **Yes** |
| Can a todo affect the result? | **Never.** A todo body is not executed, so neither a failing nor a passing one can affect the outcome. The quarantine is unconditionally safe in the ordinary run | A **failing** body prints an assertion error and does **not** fail the run; a **passing** body is reported by bun as a failure |
| What it guarantees | The quarantine can never break the build | That no quarantine entry has gone **stale** |
| How it decides | n/a | **By the message, not the exit code** - see below |

**G-TODO must attribute correctly.** A bare "the exit code must be 0" check is wrong twice over: an unrelated **active** test failing in the same run also produces a non-zero exit, and a non-zero exit therefore does **not** mean "a quarantine went stale". The guard is a small script (`scripts/`, not a test) that:

1. runs `bun test --todo` over the OpenCode test tree and captures the output;
2. scans it for bun's *"this test is marked as todo but passes"* message and **names the stale todo(s)** in its failure output - that is the only signal it treats as a stale quarantine;
3. **separately** reports any ordinary test failure, attributing it to that test rather than to the quarantine (an ordinary failure is already caught by the ordinary run; the guard merely names it correctly);
4. treats a **failing** todo body as the **expected** state of a live defect, and says so rather than reporting it as a problem.

So the guard's pass condition is *"no todo reports 'marked as todo but passes'"* - a message-level check - and its failure output names the offending todo. The exit code is consulted only to know that something happened, never to decide what.

1. **Nothing failing is ever committed as an ordinary active test.** An R-test is committed as `test.todo("R-<n> <finding>: <intent>", () => { …the real assertions… })`. Under **G-ORD** it is reported as *todo* and **cannot fail the build** - unconditionally, because its body never runs.
2. **Demonstration procedure.** `bun test --todo <file>` executes the quarantine. The **evidence captured is the printed assertion-error block** for that R-test - the test name, `file:line`, `Expected:` and `Received:`. That block is the evidence, and it is pasted into the register's *Verbatim block* column. **The exit code is not part of the evidence** and the register must not cite it: a quarantine of only failing todos exits **0** in both modes (measured), so an exit code can never show that a defect was demonstrated.
3. **The R-test's intent is not lost in the gap**: §5.10 already specifies each R-test's assertion and detection method, and the todo's body *is* the test. The commit that fixes the finding converts `test.todo` → `test` and **deletes the corresponding B-test in the same commit**.
4. **A quarantine cannot outlive its fix - and this is checked, not assumed.** Because a todo whose body has started passing is reported by bun as a **failure** ("this test is marked as todo but passes"), **G-TODO** above is that check: it runs the quarantine, attributes a stale entry to the todo that caused it, and fails with that name. A fix that lands without converting its todo is caught by the next G-TODO run.

**Change.**
1. Record the baseline: the OpenCode-scoped suite counts (§1.2), `bun run verify` in full, and `bun run verify:full`. **These were not run during the audit** (evidence gap **G4**/**G5**, §9.1) — the baseline must exist before any phase claims a delta.
2. **B-series** — characterization tests that pin today's behaviour, *including today's defects*. Committed as ordinary active tests; they **pass** today; each is deleted by the fix that changes the behaviour it pins:
   - an assistant event arriving **during** hydration → pin that it is **erased** (**H2**);
   - the stream failing during hydration → pin that the retry budget is reset and the ceiling is **not** reached (**M1**);
   - a takeover while the superseded attempt is still hydrating → pin that the superseded attempt's late failure **overwrites** the live state (**M2**);
   - a non-definitive prompt failure with no inbox event → pin that `sendMessage` **does not settle** (**M3**);
   - a failed auxiliary permission-list fetch → pin that the live permission **is cleared** (**M10**);
   - a permission ruleset with two rules sharing the same `(action, resource)` → pin that editing the **second** row changes the **first** (**H3**);
   - a caller-supplied `x-opencode-directory` → pin that it **is forwarded** to the upstream (**M8**, the read half).
3. **R-series** - one `test.todo` per finding, carrying the real assertions. Each is demonstrated with `bun test --todo <file>`; the **evidence is the printed assertion-error block** (test name, `file:line`, `Expected:`, `Received:`), captured **outside** the repository and quoted into the defect register below. The exit code is not cited.
4. **The G-TODO guard** - a script in `scripts/` (not a test), run as its own CI step, implementing the four steps above: run the quarantine, name any todo that reports *"marked as todo but passes"*, and attribute any ordinary test failure to that test rather than to the quarantine.

**The defect register.** The **fourth column is the VERBATIM captured evidence** — the printed assertion-error block from `bun test --todo`, naming the assertion, the `Expected:`/`Received:` values, and the `file:line`. It is the evidence the plan's contract requires; the exit code is never cited, because a file of only failing todos exits `0` in both modes and so an exit code could never show that a defect was demonstrated.

| R-test | Finding | Asserts | Verbatim captured evidence (from `bun test --todo`) |
|---|---|---|---|
| `R-H2` | H2 | an assistant delta received during hydration survives the hydration | `expect(message).toBeDefined()` -> `error: expect(received).toBeDefined()` / `Received: undefined` - `opencodeFindings.quarantine.test.ts:96:23` |
| `R-M1` | M1 | the reconnect ceiling is reached when the stream dies during hydration | `expect(...connection).toEqual({ type: "failed", attempt: 3 })` -> `error: expect(received).toEqual(expected)` - `opencodeFindings.quarantine.test.ts:137:48` |
| `R-M2` | M2 | a superseded attempt's late failure does not touch the live state | `expect(...load.type).toBe("ready")` -> `error: expect(received).toBe(expected)` / `Expected: "ready"` / `Received: "error"` - `opencodeFindings.quarantine.test.ts:171:47` |
| `R-M3` | M3 | an ambiguous prompt reaches a typed, bounded outcome | `expect(settled).toBe(true)` -> `error: expect(received).toBe(expected)` / `Expected: true` / `Received: false` - `opencodeFindings.quarantine.test.ts:206:23` |
| `R-M6` | M6 | two concurrent replies for one permission produce one transport call | `expect(generation.permissionReplyInputs).toHaveLength(1)` -> `error: expect(received).toHaveLength(expected)` - `opencodeFindings.quarantine.test.ts:232:48` |
| `R-M7` | M7 | a cancel requested before admission is honoured once after admission | `expect(generation.inboxCancelInputs).toHaveLength(1)` -> `error: expect(received).toHaveLength(expected)` - `opencodeFindings.quarantine.test.ts:266:44` |
| `R-M10` | M10 | a failed auxiliary read leaves the live permission untouched | `expect(...permissions).toEqual([PERMISSION])` -> `error: expect(received).toEqual(expected)` - `opencodeFindings.quarantine.test.ts:292:49` |
| `R-H3` | H3 | an ambiguous (action, resource) pair is refused, not applied to the first match | `expect(() => setOpenCodePermissionEffect(duplicated, ...)).toThrow()` -> `error: expect(received).toThrow()` / `Received function did not throw` - `configDocument.test.ts:208:7` |
| `R-M8` | M8 | a caller-supplied directory never reaches the upstream | `expect(capturedRequests[0]?.directory).not.toBe(encodedFixtureDirectory)` -> `error: expect(received).not.toBe(expected)` / `Expected: not "%2Fworkspace%2Fproject%20one"` - `opencode-v2-auth-proxy.test.ts:174:48` |

**Findings whose R-test is NOT yet authored**, and why. These are **not** covered by a quarantine entry today, and the plan does not pretend otherwise:

| Finding | Why the R-test is not authored yet |
|---|---|
| **M9** (event location) | The correct behaviour needs a directory on the event, so the test would have to invent a shape the client does not yet send. Authored with the fix. |
| **M11** (session creation) | The reproduction needs a failing catalogue read inside `ensureOpenCodeSessionInner`, which requires stubbing the server manager. Authored with the fix. |
| **M12** (capabilities `r.ok`) | The hook is React state, so the reproduction belongs in the DOM suite. Authored with the fix. |
| **M13 / M19** (first-prompt handoff) | The handoff persists to `localStorage` and runs from a mounted effect, so the reproduction needs the DOM suite. Authored with the fix. |
| **M14-M18** (form and status surfaces) | All are React rendering behaviour; they belong to the DOM suite (`tests/dom/opencode`). Authored with the fix. |

**Why this is stated rather than hidden:** a quarantine that claims to cover every finding but silently covers nine of seventeen is worse than one that says which nine are not yet expressed. Every one of them is in §5.10's matrix, and each becomes a todo when its phase starts.

**Acceptance test.**
- Every **B-test** passes against the current code, and the set of B-tests plus the baseline counts is recorded.
- Every **R-test** is committed as a `test.todo` with a body, is reported as *todo* under **G-ORD**, and **cannot fail the build**. Run with `bun test --todo`, its body executes and **prints an assertion error** - that printed block is the evidence, captured outside the repository and pasted into the register's *Verbatim block* column. The exit code is **not** cited: a quarantine of only failing todos exits `0` in both modes (measured).
- **G-TODO** runs and reports: no todo reported *"marked as todo but passes"*; any ordinary test failure is attributed to that test, not to the quarantine; a failing todo body is reported as the expected state of a live defect, not as a problem.
- `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run test:locations`, `bun run build` all exit 0, and the full-suite baseline is recorded with real counts.

**Rule for the whole programme.** No phase may claim completion while an R-test for one of its findings is still a `test.todo`; a phase that fixes a finding **converts** the todo to an active test and **deletes** the corresponding B-test **in the same commit**. A B-test that pins a *defect* is **expected** to fail after its fix and must be deleted; a B-test that pins *correct, non-defect* behaviour must keep passing, and if it fails, the fix changed behaviour the phase did not intend — it must be investigated, not updated.

**Risk.** None. **Rollback:** delete the added tests. **Must not:** change production code.

#### 5.1.1 Phase 0 outcome — what was delivered

| Deliverable | Where | State |
|---|---|---|
| The shared controller harness, extracted from the 1,807-line controller test so every suite drives the **same** fake | `tests/helpers/web/opencode/v2ThreadControllerHarness.ts` (new) | Extracted; the original test imports it. The list/history readers now receive the **connection signal**, as the real client passes it, so a test can make a read hang until the attempt is superseded instead of racing a timer. |
| **B-series** — baseline characterization, 9 tests pinning today's behaviour defects included | `tests/unit/web/opencode/v2ThreadController.baseline.test.ts` (new) | All 9 pass. Each names the finding whose fix deletes it. Two of them are **controls** (M1's connect-failure path, M10's authoritative empty list) so the baseline says explicitly *which* path is broken. |
| **R-series** — 9 defect-regression entries, all `test.todo` | 7 in `tests/unit/web/opencode/opencodeFindings.quarantine.test.ts` (new), `R-H3` in `tests/unit/opencode/configDocument.test.ts`, `R-M8` in `tests/integration/opencode/opencode-v2-auth-proxy.test.ts` | All 9 fail with a real assertion error under `bun test --todo`; the verbatim blocks are in the register above. The two backend entries live in the **existing** suites rather than a new file, so the fixture server is not duplicated. |
| **G-TODO guard** | `scripts/check-opencode-quarantine.ts` (new) | Implemented as the plan specifies: it decides on the **message** bun prints, not the exit code, and it names the stale entry. **Proved it can fail**: with one todo temporarily made to pass, the guard reported `1 quarantine entry has gone STALE` **by name** and exited 1; the temporary change was reverted and the guard returned to OK. |
| The guard is a **gate**, not a CI-only step | `package.json` (`test:quarantine`, appended to `verify`), `.github/workflows/tests.yml` (a `verify` step), `docs/engineering-quality.md` (a gate row), `tests/unit/tooling/verify-script.test.ts` (the expected sequence **and** its synthetic fixture) | Added, because the repository's parity guard exists precisely to stop CI and `bun run verify` from drifting. A CI-only step would have been invisible to that guard. **The parity guard immediately caught the change**: the test's synthetic fixture builds a workflow containing the expected sequence, so extending the sequence without extending the fixture broke three of its cases. That is the guard doing its job, and the fixture was updated in the same commit. |
| The register's **verbatim** evidence | this document, §5.1 | Captured from `bun test --todo` and pasted. The exit code is never cited. |
| Which findings are **not** yet expressed as R-tests | this document, §5.1 | Listed explicitly (M9, M11, M12, M13, M19, M14-M18) with the reason for each, rather than left to look covered. |

**What Phase 0 did NOT do**, and did not need to: it changed no production code, fixed no defect, and left every finding exactly as open as the audit found it. The only production-adjacent edit is the harness extraction, which is a pure move — the controller test's own assertions are unchanged, byte for byte.

**The gate, run end to end.** `bun run verify` → **exit 0**: typecheck, lint, format:check, test:locations, build, `bun run test` (**4329 pass / 43 skip / 9 todo / 0 fail** across 321 files / 4381 tests), `test:shutdown` 1 pass, `test:startup-rollback` 2 pass, `test:lifecycle-integration` 3 pass, `test:dom` 518 pass / 0 fail, and `test:quarantine` clean. The delta against the pre-Phase-0 baseline is exactly **+9 pass** (the B-series) and **+9 todo** (the R-series) — an ordinary run reports the R-series as *todo*, which is why the quarantine cannot fail the build.

**One thing the gate caught.** Adding `test:quarantine` to the expected sequence broke three cases in `tests/unit/tooling/verify-script.test.ts`, because that test builds a **synthetic** workflow containing the expected sequence — extending the sequence without extending the fixture desynchronised them. The repository's own parity guard caught the gate addition within one run, before it could reach CI, and the fixture was updated in the same change. That is the guard doing exactly the job it was written for.

### 5.2 Phase 1 — The security group: four review units

> **This group is deliberately first, ahead of the structural split.** The suggested sequencing in the brief would leave a Critical privilege-execution path open across four phases. It touches different files from the runtime work, and it is independently reviewable and revertible — which is exactly why it must not be bundled with the extraction.

#### 5.2.0 The review-unit rule

**One concern is one diff, one review, one rollback.** A phase that bundles unrelated concerns is not a phase; it is a queue of changes that happen to be open at the same time — and a reviewer cannot tell which one broke something. So the security group is split into **four units**, and each unit has its own diff, its own tests, its own risk, and its own rollback.

| Unit | Concern | Findings | Layer | Why it is its own unit |
|---|---|---|---|---|
| **A1** | **The proxy route allowlist** — the proxy forwards only the V2 routes the browser's client calls | M8 (**Critical**) | server (route) | Closes the **execute** half of M8 (shell, fs write, credential write, config write, rpc, mcp, pty) **for every caller**, cross-origin ones included. No evidence gap blocks it. |
| **A2** | **Server-side workspace authorization** — the proxy stops forwarding a caller-supplied directory and resolves the workspace itself | M8 (**Critical**) | server (route + storage service) + the client header | Closes the **arbitrary-path** half: a caller can no longer name any directory, only a session the user's own database knows. **A1 and A2 are atomic with each other** - A1 alone leaves the allowed routes unscoped, A2 alone leaves the disallowed routes reachable - but **neither waits on an evidence gap.** |
| **A3** | **CORS narrowing** — which origins may read TBAi's API at all | M8 (**Critical**) | server (middleware) | The layer that stops a page on an arbitrary localhost port from reading the user's OpenCode transcript through the allowlisted event stream. **Held on G1 and G2**, because the correct origin list cannot be written without knowing the packaged app's real origin and the dev origin. |
| **B** | **Credential redaction** — the config response and the page's native view | H1 (High) | server (config service) + config page | A **data-exposure** change, not a capability change. It is reviewed by a different question — "does the response still say what the user needs?" — and it must not be hidden inside a route-allowlist diff. |
| **C** | **Permission-row identity** — the config write path and the config page's rows | H3 (Medium) | service + route + config page | A **product-facing** change: it alters what the page shows and which row a click edits. It needs its own sign-off (and **G7** for the duplicate-row case), so it must not be buried in a security diff. |
| **D** | **Event-scope validation** — filtering events by the official `location` | M9 (Medium) | client reducer | **Client-side.** It cannot be reviewed in the same diff as server route changes, and it belongs to a different layer's test suite. |

**Order: A1 → A2 → B → C → D → A3.** A1 and A2 come first because they close the capability hole and depend on nothing; **A3 comes last** because it is the only unit held on an evidence gap, and holding it must not delay the units that are not.

**What is closed when.** A1 + A2 together close the **execute** half of M8 (arbitrary command execution, arbitrary file read/write, credential and config writes) **for every caller**, and the **arbitrary-path** half of the read surface. What remains open until **A3** ships is the **cross-origin read** of the user's own workspaces: a page on an arbitrary localhost origin can still open the allowlisted event stream and read that workspace's transcript, because it can name a session the user owns. **M8 is therefore not fully closed until A3 lands** — and A3 is held on G1/G2, so those two gaps are on the critical path for the *read* half, while the *execute* half closes now.

**A correction to an earlier claim in this plan.** A previous draft said the three server-side changes were "only safe together" and that shipping them apart would mean shipping a broken intermediate state. That was too strong: with A1 in place the execute capability is gone for every caller, so **A1 alone is a strict improvement**, not a broken state. The accurate statement is the one above — the ordering matters, the atomicity is only between A1 and A2.

**Each unit is merged on its own.** A reviewer may read A1's commits one at a time, but **no unit waits for another**, and a failure in one does not block the others. Unit A1's rollback does not revert A2, B, C, D or A3.

#### 5.2.A Units A1, A2 and A3 — the capability boundary *(M8 — Critical)*

**Findings:** M8 (**Critical**).

**A1 — the proxy route allowlist.** (Change 1 below.)
**A2 — server-side workspace authorization.** (Change 2 below.)
**A3 — the CORS narrowing.** (Change 3 below.) **Held on G1 and G2**; it is the only unit in the programme that an evidence gap blocks, and it is placed last for exactly that reason.

**Change.**
1. **A1** — `src/routes/opencode.ts` — the proxy catch-all becomes an **allowlist** of upstream routes (P6). The list is the browser's actual set (§3.4.1). Everything else is refused, which excludes: `/api/session/{id}/shell`, `/api/fs/*`, `/api/experimental/fs/write`, `/api/credential*`, `/api/integration/*`, `/api/rpc/*`, `/api/pty/*`, `/api/experimental/persistent-pty/*`, `PATCH /api/config`, `POST /api/mcp`, `/api/vcs/init`, `/api/experimental/session/*/export`, `/api/debug/*`, `/api/plugin/update`, and the backend-only catalogue routes.
   The allowlist must be **derived from the client, not hand-written** — a test that fails when the frontend starts calling a route that is not on the list, and a test that fails when the list contains a route the frontend does not call (so the list cannot rot into a second blocklist).
   **This is the primary control.** CORS is a browser-side control that any local non-browser process bypasses entirely.
2. **A2** — `src/routes/opencode.ts` — **workspace scope is a capability, not metadata.** The mechanism is specified in full below; the changes are:
   a. `src/services/storage/conversations.ts` — add `conversationService.findByOpenCodeSessionId(sessionId)`, backed by an index on `opencode_session_id`. **This is the missing link in the chain and does not exist today.**
   b. `src/routes/opencode.ts` — strip `x-tbai-session`, `x-opencode-directory` and `location[directory]` from every inbound proxied request; resolve the session id (path for Class C, `x-tbai-session` for Class B); resolve `sessionId → conversation → folder → directory`; **set** `x-opencode-directory`; refuse when the session is unknown, the conversation is missing, or the folder cannot be resolved. **Never** let upstream's `process.cwd()` fallback be reached.
   c. `web/src/features/opencode/v2Client.ts` — add `x-tbai-session: <sessionId>` to the official client's headers, and **remove** the browser's `x-opencode-directory` header (it becomes display-only data). The `directory` the client is constructed with remains available for display, not for routing.
   d. Classify every proxy-reachable route into A / B / C per the table below, **derived from the upstream contract** (which routes read a location) with a test that fails when the client or the upstream route set moves. The backend-only catalogue routes are excluded from the proxy allowlist entirely.
3. **A3 (HELD on G1, G2)** — `src/routes/index.ts` — narrow the CORS origin policy to the origins TBAi actually serves: the packaged Tauri origin (`app://localhost`, per `src-tauri/tauri.conf.json:10` — the current allow-list entry `http://app.localhost` carries the wrong scheme and matches nothing TBAi serves), the Vite dev origin (**make the port explicit** in `vite.config.ts`; it is currently implicit at Vite's default 5173), and no-`Origin` same-origin requests. Every other `127.0.0.1` and `localhost` port becomes untrusted.
   **Prerequisite: G1 and G2 must close first** — the correct origin list cannot be written without knowing the packaged app's real origin and the dev origin, and guessing them would break the desktop app or the dev workflow. **This is a prerequisite for shipping A3, not for starting A1 or A2**, and it is the reason A3 is sequenced last rather than first.
   > **CORRECTION (Phase 1, A3).** This paragraph was **wrong about the packaged origin**, and A3 shipped on the corrected evidence. `http://app.localhost` is NOT stale and NOT the wrong scheme: it is the Windows WebView2 origin for the custom `app` protocol Tauri registers (`src-tauri/src/main.rs:603`). Tauri's own API documentation for `register_asynchronous_uri_scheme_protocol` states that a custom-protocol page has a different origin per platform — `http://<scheme>.localhost/` on Windows and Android, `<scheme>://localhost/` on macOS and Linux — and TBAi is Windows-x64-only. This repository's `docs/architecture.md` already recorded it. The **development** origin is `http://localhost:3000` (Tauri's `devUrl`, served by the backend that `beforeDevCommand` starts); the Vite dev server is a separate, plain-browser, **same-origin** flow and is therefore not a CORS participant — its port is pinned to 5173 with `strictPort: true` so it cannot drift. A3 also found that `PATCH` was missing from the allowed methods, which silently blocked the app's fifteen `PATCH` call sites in the packaged app.

**The route classification every proxy rule is derived from.** "Global" is a property of the **upstream contract**, not a guess: upstream resolves a request's location from `location[directory]` or the `x-opencode-directory` header (`packages/server/src/location.ts:71-79`), and a route that reads the location is location-scoped whether or not it carries a session id.

| Class | Definition | Example routes | Required check |
|---|---|---|---|
| **A — globally scoped** | The upstream route does **not** read a location and returns no workspace-scoped data | `/api/info` (the only one the pinned client calls) | **No workspace authorization needed.** The proxy may forward it, and it may carry no directory |
| **B — location-scoped, no session id** | The upstream route reads a location, but the request carries **no session id** | **`/api/event`** (the directory-scoped stream — the global one is the separate `/global/event` route). The catalogue routes also read a location, but they are **backend-only** and never proxy-reachable, so they do not appear here | The **requested directory must be validated against the caller's authorized workspace set.** "No session id" is **not** "no authorization" |
| **C — session-scoped** | The request path carries a session id, whose workspace is authoritative | `/api/session/{id}` and its sub-routes, `/api/permission`, `/api/form` | The session's resolved workspace is authoritative; a request whose directory **differs** from it is **refused** |

> **The correction this replaces.** An earlier draft of D11 exempted `/api/event` — and five other routes — as "genuinely global". That was wrong on two counts: `/api/event` is the **directory-scoped** stream, and the catalogue routes carry a `location` parameter. Under the old wording a caller could have asked for another workspace's event stream and read its transcript. The classification above removes that loophole, and §5.2's change 4a removes the input that made it possible.

**The read half of M8.** The capability surface has two halves, and only the write half was named in the original finding: **execute** (shell, fs write, credential write, config write) and **read** (the event stream and the location-scoped catalogue). A foreign `x-opencode-directory` yields the other workspace's session events — text deltas, tool calls and permission asks — which is a transcript disclosure, not merely a metadata leak. Both halves are closed by the same two changes: stop forwarding the caller's directory, and validate the derived one.

**The workspace-authorization owner, specified.** D11 states the policy; this states the mechanism, so the Critical fix is implementable without inventing authorization rules during coding.

**1. The server-owned source of authorization is the local database, and there is exactly one authority for it.**

```
OpenCode session id  →  conversation  →  folder  →  absolute directory
```

- `resolveConversationWorkspace(conversationId)` (`src/services/workspace.ts:399-...`) is **the** resolver. It reads the conversation, requires `workspace_folder_id`, resolves through the **`folders` table** (for both `simple` and `project` modes), and throws `WorkspaceError("conversation_missing")` for an unknown conversation. It is already the function that roots a session: `sessions.ts:247-248,281` passes its `directory` as the session's `location`.
- **The missing link is a reverse lookup.** The conversation row carries `opencode_session_id` (`src/types/index.ts:173`), but `conversationService` (`src/services/storage/conversations.ts:117-...`) exposes only `create`, `findByClientRequestId`, `list`, `get`, `existsMany`, `update`, `delete` — **nothing resolves a conversation from an OpenCode session id.** The plan therefore specifies a new service method, `conversationService.findByOpenCodeSessionId(sessionId)`, backed by an index on `opencode_session_id`. **This is a named, concrete addition**, not an assumption.

**2. The active workspace is selected by the session id, and the session id is never the caller's to define.**

- **Class C (session-scoped).** Every `/api/session/{id}/*` route carries the session id **in the path**. The proxy resolves it server-side and **sets** the directory. The caller supplies no directory and cannot influence the outcome.
- **Class B (`/api/event`).** The route has no session id in the path, so the proxy obtains it from a **TBAi-owned header** the browser's client already sends. `v2Client.ts:161-165` constructs the official client with `headers`, so TBAi adds `x-tbai-session: <sessionId>` there. The proxy **strips** it and never forwards it. The caller's claim is used only as a **selector** — the scope it resolves to is the server's, not the caller's.
- **Class A (global).** `/api/info` needs no directory and no session.

**3. The mechanism, end to end.**

```
browser  ──►  TBAi proxy  ──►  managed OpenCode server
  x-tbai-session: ses_x          (stripped)
  x-opencode-directory: <any>    (stripped)
                                x-opencode-directory: <server-resolved>
```

1. The proxy strips `x-tbai-session`, `x-opencode-directory` and `location[directory]` from the inbound request — **all three**, because upstream reads the location from the query param *or* the header (`packages/server/src/location.ts:71-79`).
2. It resolves the session id: from the path for Class C, from `x-tbai-session` for Class B. If the path and the header disagree, the request is refused.
3. It resolves `sessionId → conversation → folder → directory` with `findByOpenCodeSessionId` + `resolveConversationWorkspace`.
4. It **sets** `x-opencode-directory` to that directory and forwards.
5. If the session id is unknown, the conversation is missing, or the folder cannot be resolved → **refuse** (no directory is ever invented, and upstream's `process.cwd()` fallback is never reached).

**4. How valid selection keeps working — and what the browser stops doing.**

- The browser already knows its session id: `extras.sessionId` (`v2RuntimeExtras.ts:40`) and the client is built from it (`v2Client.ts:152-165`). The backend already returns the directory it resolved (`POST /api/opencode/session` → `{sessionId, directory}`, `routes/opencode.ts:70-83`).
- After this change the browser's copy of the directory becomes **display-only** (`OpenCodeStatus.tsx:92` shows it) — it is no longer a routing input. The client's current `x-opencode-directory` header becomes inert, and the plan **removes** it from `v2Client.ts` rather than leaving a misleading one in place.
- **A session id is not a bypass.** It is a *selector* over workspaces the local database already knows about — the user's own conversations and folders. It cannot name an arbitrary path, because the path always comes from the `folders` table. In this single-user local app, every conversation in the database is the user's; the boundary being enforced is *the server's* authority over *which* directory, not a multi-tenant ACL.
- **A directory may host more than one conversation** (a project folder). So the authorization unit is the **workspace** (a folder), not the conversation — and the plan says so explicitly, so a future reader does not assume conversation-level isolation that does not exist.

**5. A correction to D11's own route list.** The catalogue routes (`/api/model`, `/api/model/default`, `/api/provider`, `/api/agent`, `/api/command`) are location-scoped **upstream**, but they are **not browser-reachable through the proxy** — the browser's client never calls them (`v2Client.ts` operations are `serverInfo`, `sessionGet`, `switchAgent`, `switchModel`, `prompt`, `compact`, `interrupt`, `inboxList`, `inboxCancel`, `revertStage`, `revertCommit`, `revertClear`, `formList`, `formReply`, `formCancel`, `permissionList`, `permissionReply`, `history.list`, `event.subscribe`); the **backend** calls them directly against the managed server (`capabilities.ts:105-113`, `createOpenCodeClient(baseUrl)` with no directory, so upstream uses its own `process.cwd()`). They are therefore **not in the proxy allowlist** and need no proxy authorization at all. The classification is over **proxy-reachable** routes; listing backend-only routes there was a category error.

**6. The proxy-reachable route set, complete.** Every route the browser's client calls is either `/api/info` or carries the session id in the path, except `/api/event`:

| Class | Proxy-reachable routes | Directory source |
|---|---|---|
| A — global | `/api/info` | none needed |
| B — location-scoped, no session id in the path | **`/api/event`** | `x-tbai-session` header → server-resolved |
| C — session-scoped | `/api/session/{id}`, `/api/session/{id}/message`, `/message/{messageID}`, `/prompt`, `/interrupt`, `/compact`, `/inbox`, `/inbox/{inboxID}`, `/permission`, `/permission/{requestID}/reply`, `/form`, `/form/{formID}/reply`, `/revert`, `/revert/stage`, `/revert/commit`, `/agent`, `/model` | the path's session id → server-resolved |

**Acceptance test — A1 and A2.**
- The proxy **refuses** `POST /api/opencode/api/session/{id}/shell`, `PUT /api/opencode/api/credential/x`, `GET /api/opencode/api/fs/read/etc/passwd`, `PATCH /api/opencode/api/config`, `POST /api/opencode/api/rpc/x/y`, `POST /api/opencode/api/mcp` — each with a test.
- The proxy **allows** every route the frontend's client actually calls — asserted by driving the real `@opencode/client` against the allowlist, so the list cannot drift from the client.
- **A caller-supplied directory never reaches the upstream**: a request carrying `x-opencode-directory: <foreign path>` or `location[directory]=<foreign path>` reaches the upstream with the **server's** directory, never the caller's — asserted by inspecting what the proxy forwards.
- **The proxy resolves the session id itself**: a request whose path session id and `x-tbai-session` header disagree is refused; a request with an **unknown** session id is refused; and no proxied request is ever forwarded without a server-resolved `x-opencode-directory` (except `/api/info`).
- **`/api/event` is authorized like any other location-scoped route**: a request to it with a `x-tbai-session` that resolves to a known conversation is forwarded with that conversation's directory; one with an unknown session is refused.
- **The catalogue is not browser-reachable**: `GET /api/opencode/api/model`, `/api/model/default`, `/api/provider`, `/api/agent`, `/api/command` are refused by the proxy, because the backend calls them directly.

**Acceptance test — A3 (cannot run until G1 and G2 close).**
- A request carrying an `Origin` outside the configured set receives **no** `Access-Control-Allow-Origin` header, and a cross-origin `POST` with a JSON body is refused.
- The **packaged** app still works against the backend: the app's own origin is in the set (G1), and the dev origin is in the set (G2).
- A preflight from an origin outside the set is not answered permissively.

**Risk — A1 and A2.** **High**, and the widest blast radius in the programme: it changes the security posture and the proxy the whole Code mode depends on. Mitigation: land the allowlist **before** the workspace resolution, so a mistake shows up in testing rather than in the field; run the packaged desktop app manually before and after; **stripping the caller's `x-opencode-directory` is a behavioural change to every proxied request** and must be verified against the real client (the frontend sets that header itself, so the proxy must set the *same* directory, not merely a valid one).

**Risk — A3.** **High** for the developer's workflow: a wrong origin list breaks the desktop app or the dev server, and the current policy's breadth is what a localhost attacker uses. Mitigation: it is the last unit, gated on G1/G2, and it is verified by running the packaged build and the dev server, not by inspection.

**Must not — A1 and A2.** Narrow the allowlist to a hand-typed list that is not checked against the client; let upstream's `process.cwd()` fallback be reached; or weaken the workspace resolution into a "validate the caller's directory" check (which would leave the caller's directory as the scope).

**Must not — A3.** Ship a guessed origin list. If G1 or G2 has not closed, A3 does not ship.

**Rollback — A1/A2/A3.** One revert each, independently. A3's rollback restores the broad origin policy, which is safe **only** while A1 and A2 are in place — so A3's rollback is not a reason to roll back A1 and A2.

#### 5.2.B Unit B — Credential redaction *(H1 — High)*

**Findings:** H1 (High).

**Change.**
1. `src/services/opencode/configDocument.ts` — add a **redaction** step applied to anything leaving the server. The redaction list is derived from the **published schema** (`https://opencode.ai/config.json`) and the docs, not from a guess:
   - `providers.<id>.settings.*` (the whole object — the schema's `allOf` permits arbitrary extra keys, so `apiKey` is *allowed but undeclared*)
   - `providers.<id>.headers`, `providers.<id>.body`
   - `provider.<id>.options.apiKey` (v1 legacy)
   - `mcp.<name>.headers.*`, `mcp.<name>.environment.*`, `mcp.<name>.oauth.clientSecret`
   - `plugins[].env`
   - `agents.<name>.*` where the value is a provider-options object
   Substitution-aware: a literal value is masked; a `{env:VAR}` reference is masked (it names a secret-bearing variable); a `{file:path}` reference is masked (it discloses a path to a secret file). **Never** substitute the referenced value into the response — that would be worse than the original.
   The redaction operates on the *response projection*, never on the bytes written back to disk — the write path must still see the real document, or the preservation guarantee (and the existing `configDocument.test.ts:187` credential round-trip) breaks.
2. `src/routes/opencode.ts` — the `GET /config` route returns the redacted projection. The "Native OpenCode JSON" view renders a **redacted** document, permanently (decision **D15**, §9.2). There is no "reveal" affordance: any origin that can reach the API could use it.
3. `web/src/features/opencode/OpenCodeConfigPage.tsx` — the native view renders the redacted document, labelled as such.

**Acceptance test — Unit B.**
- `GET /api/opencode/config` contains **no** secret-shaped value at any depth, including inside `raw`; the substitution-reference forms are masked too.
- The **write** path still round-trips the real file byte-identically with credentials intact — `tests/unit/opencode/configDocument.test.ts:187` must stay green and must keep asserting the *file*, not the response.
- The live e2e `tests/e2e/opencode/opencode-config-live.spec.ts` moves its credential assertion from the HTTP response to the **file** — it currently reads `before.raw` / `after.raw` over HTTP and asserts `providers` are byte-identical, which is the response-level guarantee this unit removes.

**Risk — Unit B.** **Medium.** The "Native OpenCode JSON" view is a documented feature; redacting it changes what the user sees, and the diagnostic value of the raw file is reduced. The write path is unaffected, so the *preservation* guarantee is safe.

**Must not — Unit B.** Change what is written to the user's OpenCode configuration file, or weaken the structural preservation guarantee.

**Rollback — Unit B.** One revert. Independent of Unit A.

#### 5.2.C Unit C — Permission-row identity *(H3 — Medium)*

**Findings:** H3 (Medium).

**Change.** `src/services/opencode/configDocument.ts` + `src/routes/opencode.ts` + `web/src/features/opencode/OpenCodeConfigPage.tsx` — address a rule by **position plus a re-checked identity** (the pattern `removeOpenCodePermissionRule` already uses) rather than by `(action, resource)` alone; make the UI's row identity position-based so two identical rows cannot collide; and **indicate when a rule is overridden** by a later, more specific match. **Wildcard-overlapping rules are legitimate and are neither rejected nor hidden.** The exact-duplicate guard on append is kept as-is. The **V1 object form must not be removed** — it is V1-scoped upstream, but the current V2 schema still accepts legacy-shaped entries, and its status must be verified before any removal.

**Acceptance test — Unit C.**
- A ruleset containing two rules with the **same** `(action, resource)` → editing the **second** row changes **that** row, not the first; editing a rule whose identity changed on disk since it was read is **refused** with a reason. The assertion encodes **row identity**, not the upstream evaluation order.
- A ruleset with **wildcard-overlapping** rules (`*` and `git *`) → both rows are editable, and the page indicates that the broader one is overridden.

**Risk — Unit C.** **Medium** — it changes what a click does, and the override indicator depends on **G3** (a live server check) for its exact semantics. The **write path's row-identity fix does not depend on G3** and may ship; the **read-only override indicator is held** until G3 closes.

**Must not — Unit C.** Reimplement permission evaluation in TBAi, reject wildcard-overlapping rules, or remove the V1-shaped configuration entries.

**Rollback — Unit C.** One revert. Independent of Units A and B.

#### 5.2.D Unit D — Event-scope validation *(M9 — Medium)*

**Findings:** M9 (Medium).

**Change.** `web/src/features/opencode/v2Events.ts` — filter events by the official `event.location`, using `LocationRef.directory` against the subscribed directory. Events with no `location` are location-scoped by definition (the `server.connected` case) and are kept.

**Acceptance test — Unit D.** An event whose `location.directory` differs from the subscribed directory is not applied.

**Risk — Unit D.** **Low.** It is a reducer filter on the client, with no wire-format change. The subscription header remains the primary scope; this is the verification layer beneath it.

**Must not — Unit D.** Drop events that carry no `location`.

**Rollback — Unit D.** One revert. Independent of the server-side units.

### 5.3 Phase 2 — Ownership extraction *(behaviour-preserving)*

**Findings:** none (this phase changes no behaviour).

**Change.** Extract the `sync/` layer per §4 and §4.1, moving code without changing it, and add `sync/ownership.md`.

**Acceptance test.** The Phase 0 characterization tests pass with **identical** results before and after. `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run test:locations`, `bun run build` all exit 0. The OpenCode-scoped suites report the same pass counts as the Phase 0 baseline.

**Risk.** **Medium** — the move is large and touches a 1,263-line file. Mitigation: one file per commit, `git mv`-style history preserved, and the "consumers enumerated" rule from `AGENTS.md` applied to every relocated symbol (static imports, dynamic `import()`, source-text guards, path strings in config, docs that name the path, CI/Playwright config).

**Must not.** Change any observable behaviour, reorder lifecycle events, alter the assistant-ui adapter contract, or introduce a second store.

### 5.4 Phase 3 — Attempt ownership and reconnect *(M1, M2, M4, L4)*

**Findings:** M1, M2, M4 (Medium), L4 (Low).

**Change.**
1. `sync/attempt.ts` — attempt-local readiness, load promise, epoch and abort signals. The controller holds `currentAttempt`; every async continuation captures its attempt and verifies identity before committing state, settling a promise, or resetting a counter.
2. **P2** — `reconnectAttempt` becomes attempt-scoped. The reset moves out of the shared tail at `v2ThreadController.ts:784-787` into the attempt that earned it: `hydrate` reports whether it *completed* (not merely returned), and only a completed hydration resets the counter.
3. Adopt the reference's backoff refinement (P2): cap at 5 s when visible and online, 60 s when hidden or offline; permanent 4xx uses the long cap immediately. The **bounded ceiling stays** (decision **D2**, §9.2).
4. **M4** — a failed hydration must (a) clear `isHydrating` in a `finally`, and (b) leave the controller in one of the defined states: `idle`, `connecting`, `hydrating`, `ready`, `reconnecting(attempt)`, `failed(attempt)`, `disposed`. No half-initialized controller.
5. **M4** — `isHydrating` must never be able to strand the transcript: once the load has failed, the live-event path applies events regardless of hydration state.

**Acceptance test.**
- Stream fails during hydration, budget 3 → exactly 4 connects, then `{type:"failed", attempt:3}`. (This is the audit's failing test; it must pass.)
- The connect-failure path still reaches the same terminal state with the same attempt count — the control that proves the ceiling was never the broken part.
- Takeover while the superseded attempt hydrates → the superseded attempt's late failure leaves `load: "ready"`, `connection: "connected"`, and the connect count **unchanged**; the newer attempt's readiness promise is settled only by its own outcome.
- A history-endpoint failure → the runtime ends in a defined, recoverable state, a later assistant event is applied, and the controller either reconnects within the budget or reports terminally.

**Risk.** **Medium** — this touches the readiness contract that `awaitReady()`, `refresh()`, `sendMessage()` and `useOpenCodeRuntime` all depend on. The retry ceiling is the most user-visible safety property in the runtime; it must keep working on the path it already works on.

**Must not.** Remove the bounded-reconnect ceiling, lengthen the backoff beyond the documented cap without recording it in `docs/decisions.md`, or let an attempt observe another attempt's settle functions.

### 5.5 Phase 4 — Snapshot ↔ live-event merge, and auxiliary-fetch semantics *(H2, M5, M10, M12)*

**Findings:** H2 (High), M5 (Medium), M10 (Medium), M12 (Medium).

**Change.**
1. `sync/recoverySnapshots.ts` (P1) — adopt the reference's model: during a history read, capture the events that arrive; when the read resolves, **overlay** them onto the snapshot rather than replacing the live state. The reducer's `history_loaded` becomes mode-aware (`"merge" | "replace"`).
   *Precedence rule (decision **D1**, §9.2): the snapshot is authoritative for what it covers; live events observed during the read are authoritative over the snapshot for what they touch; a snapshot may only remove state the client itself no longer holds.*
   **The read's initiator is irrelevant.** A user-initiated `refresh()` uses the **same merge path** — being user-initiated does not establish that no newer live state will be discarded, because live events may still arrive while the refresh fetches. `"replace"` is used only where the caller can establish that no newer live state would be discarded: a first load (nothing applied yet) and a backward-looking pagination prepend.
2. The second `history_loaded` dispatch in `hydrate` (the reprojection for permission linkage) is re-expressed as a **merge** that preserves everything applied since the first projection. It must not silently rebuild `state.messages` from the snapshot alone.
3. `v2ThreadController.ts:472-476` — fix the buffer overflow: the `.filter((entry) => !isAssistantMessageEvent(entry.event))` is vestigial (only assistant events are ever buffered) and empties the buffer. Replace with a plain `slice(-LIMIT)`.
4. **M10** — `loadAuxiliary` must distinguish **authoritatively empty** from **unavailable**. A failed `inboxList` / `permissionList` / `formList` must be represented as *unavailable*, not as an empty list: the three kinds are tracked separately, an unavailable read **leaves the live list untouched**, and the degraded state is surfaced (the status chip) rather than silently emptying the list. The reducer's `*_hydrated` cases gain a third state alongside *stale* and *current*.
5. **M12** — the same rule on the client: `useOpenCodeCapabilities` must check `r.ok` before parsing, so a 503 is an **error** (surfaced, with the picker's previous state left intact) rather than a successful empty catalogue. A failed fetch must never be read as "this install has no models".

**Acceptance test.**
- One assistant event during hydration → present in the final transcript with its text intact (currently absent — this test fails before the fix and passes after).
- 600 assistant events during hydration → all 600 present (currently 87 survive the overflow and then 0 survive the reprojection).
- A user-initiated `refresh()` that runs while a live event arrives → the live event **survives** the refresh. (This is the case the earlier draft got wrong: a user-initiated read gets the same merge treatment.)
- The existing "reprojects hydrated tool history after permission hydration" test stays green.
- A new overflow test: 513 buffered events → the newest survive, the oldest are dropped **without** emptying the buffer.
- **M10:** a re-sync whose permission list fetch **fails** → the live permission **survives**, and the state reports the auxiliary read as unavailable. The control: a re-sync whose permission list fetch **succeeds and authoritatively returns `[]`** → the permission is cleared. The two cases must be distinguishable.

**Risk.** **Medium** — `history_loaded` semantics are relied on by `refresh()`, `reconcileStagedRevert()` and `resyncAuxiliary()`. A merge must not resurrect stale history over fresher live state, and must not break the occupancy derivation at `v2Events.ts:747-776`. assistant-ui's own contract agrees with the merge model (`onLoadEarlier` *prepends*), so the adapter contract is not at risk. M10 changes the reducer's hydration cases, so every consumer of `state.permissions` / `state.forms` must be re-checked — in particular the auto-approve drain, which must still see a live permission.

**Must not.** Change the occupancy derivation, the permission-linking reprojection's *purpose*, or the assistant-ui adapter's repository identity contract. **And** must not let a degraded auxiliary read clear a live permission or form.

#### 5.5.1 Phase 4 outcome — what was delivered, and where it differs from the plan

| Deliverable | Where | State |
|---|---|---|
| **The read boundary.** One call samples the ordinal a read starts at, and every held event is dated against it | `sync/eventPipeline.ts` (`beginHistoryRead`) | Delivered (M5), and corrected on 2026-10-22: the boundary no longer decides *whether* a held event is replayed (that is the snapshot's own text — see `historyReplay.ts` below). It still decides two things: whether a held event's effect is already persisted (every non-delta event is persisted before the read can be answered), and which held entries may be folded together. |
| **Delta coalescing**, gated on that boundary | `sync/eventPipeline.ts` (`buffer` + `coalescedDelta`) | Delivered (M5). Only into the **tail** entry, and only when the tail's ordinal is **after** the boundary: an entry that predates the read keeps its own ordinal, so a held delta can never be dated later than it arrived (folding across the boundary would let a pre-read delta masquerade as one that arrived during the read). Keys: `type:assistantMessageID:ordinal` for text and reasoning, `type:assistantMessageID:id` for tool input. The merged entry takes the later event's ordinal, and its id. |
| **The backstop, honestly named** | `config.ts` (`OPENCODE_V2_EVENT_BUFFER_LIMIT`) | Delivered: a plain `slice(-LIMIT)`, raised 512 → 4096. The vestigial `!isAssistantMessageEvent` filter — which discarded the whole buffer — is gone. Reaching the limit means that many *distinct* events arrived during one read, and the oldest are dropped rather than the read being abandoned. |
| **The reconciling commit** (H2) | `v2Types.ts` (`V2HistoryMerge`), `v2Events.ts` (the `history_loaded` reducer), `sync/sessionMessageLoader.ts` (`commit(snapshot, merge)`), `v2ThreadController.ts` (`beginHistoryReadScope` / `historyMerge` / `noteLiveMutation`) | Delivered. |
| **What a held event may be replayed onto** | `sync/historyReplay.ts` (`coveredTextPartIds` / `shouldReplayBuffered`) | Delivered on 2026-10-22, after an independent review reproduced the text-doubling defect the ordinal boundary could not prevent. The snapshot's own per-part text decides; see the correction below. |
| **The permission-linkage reprojection** | removed from `hydrate`, `v2History.ts` and `v2Events.ts` | Removed (decision D-P4-2 in `docs/decisions.md`), after an independent search confirmed no production code read it. |
| **M10** — unavailable and authoritatively empty, told apart | `v2Types.ts` (`V2AuxiliaryAvailability`), `v2Events.ts` (the three `*_hydrated` reducers), `v2ThreadController.ts` (`loadAuxiliary` / `applyAuxiliary`) | Delivered: a failed read leaves the list exactly as it was and moves only availability; a successful empty read clears it. Each kind degrades independently. |
| **M10's surface** — one line, naming the sets that are stale | `auxiliaryNotice.ts` (`pendingSetNotice`) + `OpenCodeStatus.tsx` | Delivered. |
| **M12** — a failed capability read is an error, never an empty catalogue | `useOpenCodeCapabilities.ts` (`readOpenCodeCapabilities`) | Delivered. |
| **Dead code that this phase created or exposed** | `v2Events.ts`, `sync/eventPipeline.ts` | `isStaleSnapshot` (nothing is dated by an ordinal any more), `V2EventIdentityState.nextOrdinal` (write-only once the stale-guard went), the `v2_event` action's `ordinal` field (unused), and `EventPipeline.currentOrdinal` (both its callers were removed here — the auxiliary stamp and this phase's own boundary sample). `consume` now allocates through `nextOrdinal()` rather than incrementing the counter privately, so the pipeline's own method is no longer test-only. |

**Where the delivery differs from the plan above, in four places, and why.**

1. **No `recoverySnapshots.ts`, and no `"replace"` mode.** The plan called for a new module holding an observer that captures events for the duration of a read, and a mode-aware `history_loaded` (`"merge" | "replace"`). Neither survived contact with the code. The commit carries `V2HistoryMerge { held, touched }` — **non-nullable** — where `held` is the message ids the transcript held when the read started (minus the optimistic ids) and `touched` is the assistant message ids that events **applied** during the read wrote to. The `"replace"` mode was **dropped as dead**: no caller needs it, because an empty `held` on a first load *is* replace, and the optimistic filtering it carried is preserved by the reducer. The precedence is the plan's D1 rule, expressed over ids rather than over an observer: id in the snapshot **and** touched → live wins; id in the snapshot, untouched → the snapshot wins; id absent from the snapshot, held **and** untouched → dropped, which is the snapshot-confirmed deletion this finding is about; absent, not held (or touched) → kept.

2. **"Capture the events that arrive" is the buffer that already exists — and `touched` counts *applied* events, not buffered ones.** The buffer holds assistant events that arrived during the read, but it is drained **after** the commit, so a buffered event does not mark its id touched: for those, the snapshot wins, and the held event is replayed onto it. A second observer would have been a second mechanism for the same window, and the two could disagree about an event that arrived between them. There is also no live user-message mutation event to observe (`session.message.content.updated` is replay-only), so every live transcript mutation is an assistant-part event carrying `assistantMessageId`, and `touched` is extracted generically from those. **Corrected on 2026-10-22**: "the snapshot wins, and the held event is replayed onto it" was right about the *id* and wrong about the *text* — see the correction paragraph below.

3. **The second `history_loaded` dispatch was deleted, not re-expressed as a merge.** It existed only to attach `part.permissionId` at projection time. An independent code search found **no production reader** of `part.permissionId`: the live linkage is `deriveV2ToolCallId(message.id, toolId)`, computed where the tool card is rendered, and `currentPermissions()` fed nothing but that commit. Permissions remain their own state. The plan's "re-express it as a merge" would have preserved a field that nothing consumed.

4. **M10's third state is per kind, and the surface is one popover line.** The plan said "the reducer's `*_hydrated` cases gain a third state alongside *stale* and *current*". *Stale* turned out to be the wrong axis — the ordinal-based staleness it named is exactly what this phase removed — so the states are `"current" | "unavailable"`, held per kind, and the two mechanisms the reader needs are the ones pinned by tests: a failed read preserves the last known list, a successful empty read clears it. The surface is one line in the status popover, shown only once the load is ready, and it names the kinds that are stale rather than saying something vague about "requests".

5. **Corrected on 2026-10-22 — the ordinal boundary could not decide what a held event may be replayed onto.** An independent review of `7b65219` reproduced a defect this phase's own mechanism allowed: the commit installed the snapshot's copy of a message and every held event was then replayed on top of it, so a text delta the snapshot already contained was appended a second time — the reader saw "HelloHello". The mechanism's assumption was that the snapshot cannot contain a held delta's text, because the read started before the delta arrived. That is true of the *read's request*, not of the *read's answer*: the server persists a streamed part in three steps (`text.started` stores it empty, the deltas never reach the database, `text.ended` stores the finished text), and a durable event is committed to that store **before** it is published to SSE subscribers (`packages/core/src/bus.ts`: the projectors run, then `notify`). So a read answered after `text.ended` was committed returns the finished text while the deltas that produced it are still in flight to this client, and they are held — the read's boundary is client-side, the answer's content is server-side. The same reasoning in the other direction shows the opposite defect: a snapshot that carries the part **empty** has not seen the deltas at all, so a held delta that predated the boundary still has to be replayed, and dropping it (as the ordinal rule did) truncated the answer. **The rule is now the snapshot's own per-part text** (`sync/historyReplay.ts`): a held delta is not replayed into a part the snapshot carries text for, and is replayed into a part it carries empty — including one that predates the boundary, because a text or reasoning delta carries everything its part needs. A tool-input delta is the exception: a delta alone cannot rebuild a tool part (its name arrives only in `session.tool.input.started`, and `v2Events.ts` would synthesize `unknown`), so it is replayed only when it arrived after the boundary. `bufferedSince(ordinal)` is gone: the buffer is no longer selected by an ordinal, it is *filtered* by the rule, so the pipeline exposes `bufferedEntries()` and the caller decides. Two further corrections came with it, and the re-review of 2026-10-22 corrected how they are described: the ATTEMPT BOUNDARY now clears the buffer (a dead attempt's held events have no base to be replayed onto, and the retry reads its own snapshot) — that is a behaviour change, and it is the only site that clears it, so the guard on it is a single site; and the coalescing fold no longer crosses the boundary in the other direction either (an entry that predates the read keeps its own ordinal, so a pre-read delta cannot be dated later than it arrived) — that is NOT a behaviour change, the fold code is identical to 7b65219, and what the correction added is a TEST pinning it. Both are stated here as what they are.

**Acceptance, as delivered.** Each item of the plan's acceptance list above, mapped to the test that holds it:

| The plan's acceptance item | The test | Result |
|---|---|---|
| One assistant event during hydration → present with its text intact | `R-H2` in `opencodeFindings.quarantine.test.ts`, promoted from `test.todo` to a real test | Passes; its defect pin in `v2ThreadController.baseline.test.ts` was deleted in this change |
| 600 assistant events during hydration → the streamed text survives | `eventPipelineBuffer.test.ts` — "keeps every streamed delta of a 600-token response that arrived during the read" | Passes. **Re-scoped by the maintainer's decision**: the acceptance is that the streamed *text* survives, not that every original delta *event* stays buffered — 600 events now coalesce into one entry per part. Disabling coalescing fails this file with 600 entries / 2 failures, which is the fail-before proof |
| A user-initiated `refresh()` while a live event arrives → the live event survives | `v2HistoryMerge.test.ts` — "keeps a delta that arrives while the read is in flight" | Passes |
| The old "reprojects hydrated tool history after permission hydration" test stays green | replaced by "keeps permission state separate from the transcript hydrated beside it" in `v2ThreadController.test.ts` | Passes. The old test asserted the *second commit*, which is what this phase deleted, so it was rewritten to assert the surviving contract: permissions and the transcript are separate state |
| 513 buffered events → the newest survive, the oldest are dropped without emptying the buffer | `eventPipelineBuffer.test.ts` — "drops the oldest entries at the limit rather than the stream" | Passes |
| **M10:** a failed read leaves the live permission, and the state reports it unavailable | `R-M10`, promoted; plus the reducer cases "preserves the last known permissions when the read fails" and "tracks availability per kind" in `v2Events.test.ts` | Passes. With the old drop-on-failure behaviour restored, `R-M10` fails on `expect(permissions).toEqual([PERMISSION])` — the fail-before proof |
| **M10, the control:** a successful empty read clears it | `R-M10`'s second half; `v2Events.test.ts` — "removes a permission a successful read no longer lists" | Passes |
| — | `v2Events.test.ts` — "keeps the same state when a successful read changes nothing" | Passes. Identity, not equality: a re-sync that finds nothing new must not hand the runtime a new state object, or every poll re-renders the transcript |
| — | `auxiliaryNotice.test.ts` (4 cases) | Passes; each can fail, proved by making `pendingSetNotice` return `null` unconditionally (3 failures) and reverting |
| — | `capabilitiesResponse.test.ts` (3 cases, M12) | Passes; proved fail-before |
| — | `v2HistoryMerge.test.ts` (5 cases) | Passes; proved fail-before against the old replace semantics (2 failures) |
| **The correction of 2026-10-22:** a held delta the snapshot already contains is not replayed, and one the server has not persisted yet is | `v2ThreadController.test.ts` — "does not append the snapshot's own text twice when the stream that produced it was held" and "replays the deltas the server has not persisted yet, even when they predate the read"; plus `historyReplay.test.ts` (6 cases) | Passes. The first fails with "HelloHello" against the old rule, the second with "lo" against the ordinal rule — the two fail-before proofs |

### 5.6 Phase 5 — Settlement, cancellation, exactly-once delivery *(M3, M6, M7, M13, M19)*

**Findings:** M3, M6, M7, M13, M19 (Medium).

**Change.**
1. **P3** — `sync/promptsInFlight.ts`: an explicit registry of prompts this client has sent and that OpenCode has not admitted. `trackPromptInFlight(sessionId)` returns an **idempotent** release. Any snapshot that arrives while a prompt is in flight must not lower that session's busy status.
2. `markAdmissionAmbiguous` (`v2ThreadController.ts:324-330`) must settle the promise `sendMessage` awaits, or a live caller must invoke `reconcilePendingPrompt` — which currently has **no caller anywhere in `web/src`**. Either the reconciler gets a caller, or it stops being exported. The four outcomes are **admitted**, **definitively rejected**, **ambiguous**, **disposed**; an ambiguous network result is never reported as a rejection.
3. **P4** — `sync/startupGate.ts`: a bounded readiness gate. Every operation that waits for readiness (hydrate, `awaitReady`, `sendMessage`) gets a **timeout** and a typed error, and the composer shows a visible "waiting" state while a send is held.
4. **M6** — `replyToPermission`, `replyToForm` and `rejectForm` claim the request id **before** the await (a pending-reply set) and release it only on a definitive failure. A later `permission.replied` event invalidates an in-flight reply decision, so an answered request cannot be resurrected by a late auto-approve. Exhausted retries **fail closed** and leave the request visible for manual action.
5. **M7** — a pending cancel requested before admission is honoured **exactly once** against the admitted inbox id. The current behaviour (flag `cancelRequested`, do nothing) leaves a queued prompt to execute while the UI shows "Connected". The in-flight request is **not** aborted — its outcome is genuinely unknown.
6. **M13 / M19** — the first-prompt handoff must be **exactly-once and never silently lost**. The claim must not be persisted *before* the dispatch without a recovery path, and a failed attempt must not be auto-resubmitted — a send that reached the server before rejecting would otherwise be delivered twice. The module's own doc already promises both properties (*"failed prompts are never auto-resubmitted"*, *"delivers the live user action exactly once"*); the code must be brought into line with it.

**Acceptance test.**
- A non-definitive prompt failure with no inbox event → `sendMessage` settles within a bounded time with a typed, recoverable outcome; `awaitPromptAdmission` still reports `"ambiguous"`.
- A prompt held for readiness beyond the timeout → rejects with the typed error, and the composer restores the text.
- Two sends held for readiness → they reach OpenCode **in the order they were made**.
- Two overlapping `replyToPermission` calls for one request id → exactly **one** transport call. The same for `replyToForm` and `rejectForm`.
- Cancel during the prompt-request phase, then admission → exactly one cancel is issued for the admitted inbox id.
- **M13:** a crash (or reload) between the claim and the dispatch → the stashed prompt is **still deliverable** on the next mount.
- **M19:** a first-prompt append that rejects **after** the server accepted it → the message is **not** delivered a second time.

**Risk.** **Medium** — M7 **changes behaviour the repository currently asserts**: `tests/unit/web/opencode/v2ThreadController.test.ts:771` asserts `inboxCancelInputs` is empty and the end state is `{type:"admitted", cancelRequested:true}`. That test must be updated deliberately, with the rationale recorded — not silently.

**Must not.** Abort an ambiguous in-flight prompt request (the current no-abort behaviour is correct), or report an ambiguous prompt as definitively failed.

#### 5.6.1 Phase 5 outcome — what was delivered, and where it differs from the plan

| Deliverable | Where | State |
|---|---|---|
| **M3** — every admission outcome reaches every waiter, and the wait is bounded | `sync/promptsInFlight.ts` (`markAmbiguous`, `awaitAdmissionWithDeadline`), `v2ThreadController.ts` (`sendMessage`), `v2RuntimeStore.ts` | Delivered, and **differently from the plan**. The plan asked for `markAdmissionAmbiguous` to settle the promise `sendMessage` awaits, or a live caller for `reconcilePendingPrompt`. Neither was the right shape: settling the promise with "ambiguous" would tell the caller the prompt was NOT admitted, when the server may still be running it. The registry now keeps **two kinds of watcher** — the outcome watch, which accepts "not provably", and the admission watch, which does not — and `sendMessage` waits on the admission watch with a **deadline**. `reconcilePendingPrompt` was **deleted** rather than given a caller: with the registry settling every outcome, there was nothing left for it to reconcile. |
| **M3's error vocabulary** | `v2ThreadController.ts` (`V2PromptSendError`) | New `kind: "ambiguous"`. A 5xx cannot prove the server refused the prompt, so it is not a rejection: the message stays in the thread and the run continues server-side. `v2RuntimeStore.ts` surfaces it as a plain error, **not** as `MessageNotSentError` — "not sent" is exactly what the wire could not establish. |
| **The bounded readiness wait** (plan item 3, P4) | `sync/startupGate.ts` (`waitWithDeadline`), `v2ThreadController.ts` (`awaitReady`) | Delivered: `awaitReady` rejects with a typed error after `OPENCODE_V2_READY_TIMEOUT_MS`, and the timeout is injectable so a test can prove the deadline without waiting it out. |
| **M6** — one transport call per answered request | `v2ThreadController.ts` (`claimPermission` / `releasePermission`, `claimForm` / `releaseForm`) | Delivered. The id is claimed **before** the transport call, so two overlapping answers produce one call. The claim is released only on a definitive failure — a network error may mean the server took the answer, so the request stays claimed and stays visible. |
| **M6's invalidation** | `v2ThreadController.ts` (`applySettlementEvent`) | Delivered: a `permission.replied` / `form.replied` / `form.cancelled` event invalidates an in-flight decision, because the server has already answered and a second answer to a settled request is an error upstream. |
| **M7** — a cancel before admission is honoured once | `v2Types.ts` (the `cancelling` variant's `cancelRequested`), `v2Events.ts` (`cancel_requested`), `v2ThreadController.ts` (`cancelAdmittedPrompt`) | Delivered, and it **changed a behaviour the repository asserted**, deliberately. The `cancelling` state now carries the flag, and the admission path issues the cancel against the admitted inbox id. The inbox id is what makes it unique, so the cancel happens exactly once even though the admission arrives through two paths (the HTTP response and the inbox event). The plan's "must not" is honoured: the in-flight request is **not** aborted. |
| **M13** — a crash between the claim and the dispatch can resume | `web/src/features/chat/state/pendingFirstMessage.ts` (`claimPendingFirstMessage`) | Delivered. The claim and the **message id** are written together, so a crash leaves an entry the next mount can resume — and the resume carries the same id. The server admits a repeated message id as the same prompt (upstream `SessionInbox.admit` reconciles by id), so the resume cannot double it. The old contract dropped the claim, and the reader's message was lost. |
| **M19** — a failed dispatch is never resubmitted | `pendingFirstMessage.ts` (`markPendingFirstMessageFailed`), `FirstPromptHandoff.tsx` | Delivered. A dispatch that failed may have reached the server, so the entry is marked failed and is inert until the user sends again. The old contract released the claim, and the next settled observation re-sent the same prompt. |
| **The dead exports** | `sync/eventPipeline.ts`, `config.ts`, `v2Types.ts`, `v2Events.ts` | Removed: `hasPendingReconnect`, `OPENCODE_V2_HISTORY_CONVERGENCE_PASS_CAP`, and the `load_reconciling` / `load_reconciled` actions with their `V2LoadState` variant. Each had **no producer anywhere** — verified by an exhaustive search of `web/src`, `src`, `tests` and `scripts` before the removal. |
| **The reconnect surface** | `web/src/features/opencode/statusView.ts`, `OpenCodeStatus.tsx` | Delivered: the chip reads the runtime's own `connection` state, so an automatic reconnect reads "Reconnecting (attempt n of N)" instead of a red Error, and the terminal state keeps the error presentation and the manual control. The status control also calls the controller's `retry()`, which had had no product caller. |

**Where the delivery differs from the plan above, in three places, and why.**

1. **`reconcilePendingPrompt` was deleted, not given a caller.** The plan offered the choice ("either the reconciler gets a caller, or it stops being exported"). Once the registry settles every outcome, there is nothing left for it to reconcile: it existed only to settle the promise that `markAmbiguous` left hanging. A reconciler with nothing to reconcile is a second mechanism for the same window, and two mechanisms over one window can disagree.

2. **"Ambiguous" is not a settlement.** The plan's item 2 said `markAdmissionAmbiguous` "must settle the promise `sendMessage` awaits". Settling it with "ambiguous" would end the send with an answer the wire does not have: the server may still be running the prompt. The registry therefore keeps the record open, and the sender waits for the admission **with a deadline** — so the send always ends, and it ends with the truth.

3. **The M13 resume relies on the server's idempotency, and that was checked against the upstream source.** Upstream `Session.prompt` reconciles by message id before it admits (`SessionInbox.admit` → `admission.reconcile`), and a prompt that was already promoted to a message is found again by the same lookup. A resumed dispatch carrying the same id is therefore the **same** prompt server-side, not a second one. This is what makes the resume safe without a client-side "did it land?" probe.

**Acceptance, as delivered.**

| The plan's acceptance item | The test | Result |
|---|---|---|
| A non-definitive prompt failure with no inbox event → `sendMessage` settles within a bounded time with a typed, recoverable outcome | `R-M3` in `opencodeFindings.quarantine.test.ts`, promoted from `test.todo` | Passes; the deadline is injected, so the test proves the bound rather than waiting it out. The M3 baseline pin in `v2ThreadController.baseline.test.ts` was deleted in the same change |
| `awaitPromptAdmission` still reports `"ambiguous"` | the same file, "an ambiguous prompt is NOT reported as a definitive rejection" | Passes |
| A prompt held for readiness beyond the timeout → rejects with the typed error | `v2ThreadController.test.ts` and the injectable `readyTimeoutMs` | Delivered; the composer restores the text because the send throws rather than hanging |
| Two overlapping `replyToPermission` calls for one request id → exactly one transport call | `R-M6`, promoted, plus the form case | Passes; the claim removed makes 2 failures |
| A cancel during the prompt-request phase, then admission → exactly one cancel for the admitted inbox id | `R-M7`, promoted, plus "a second admission of the same prompt does not cancel it twice" | Passes; the honouring removed makes 3 failures |
| **M13:** a crash between the claim and the dispatch → the stashed prompt is still deliverable on the next mount | `pendingFirstMessage.test.ts` and `FirstPromptHandoff.test.ts` | Passes; the id no longer carried makes 1 failure |
| **M19:** a first-prompt append that rejects after the server accepted it → the message is not delivered a second time | the same two files | Passes; the failed-entry guard removed makes 2 failures |


### 5.7 Phase 6 — Retention, session lifecycle and dead code *(L1, L2, L3, L7, M11)*

**Findings:** L1, L2, L3, L7, M11 (Low–Medium).

**Change.**
1. **P9** — bound `admissions`, `answeredPermissions`, `autoApproveAttempted` and `formReplies` with a TTL sweep plus a max-entry cap, mirroring the reducer's existing 256-item windows so the controller has one policy instead of two. **Eviction must prefer settled entries; an entry that is still in flight is never evicted** (decision **D16**, §9.2).
2. `terminateOpenCodeSession` keeps the persisted pointer when the remote removal fails, or reports `{terminated:false, reason}`, so a remote session is not orphaned with no handle (decision **D17**, §9.2).
3. `invalidateBootstrap` is implemented or removed — it is currently an empty function while `OpenCodeView.retry()` calls it expecting a reset (already recorded as **B1, Medium** in the maintainer's handoff, still open).
4. **L7** — `bindV2PermissionOptions` is **deleted**. It has zero consumers, and its inner loop discards the return value of the validation it appears to perform, so it binds and validates nothing. The shared approval gate works because it renders the declared options itself.
5. **M11** — `sessionModel.ts` must be **tolerant as it documents**. `fetchServerDefaultModel` and `resolveStoredModel` catch the failure and return `null`, so a catalogue-read failure degrades to "no model" (the server default or the reader's stored choice) instead of aborting session creation. The `catch` the doc comment already claims belongs there.

**Acceptance test.** After N prompts and M permissions, each collection is at or below its cap, and an in-flight entry is still present. An eviction-policy test exists (the reference has `eviction.test.ts` and `eviction-thrash.test.ts` for the same reason). A removal failure leaves the pointer intact and reports the failure. A Retry pressed while a bootstrap is in flight either starts a new attempt or says why it cannot. A catalogue read that fails during session creation leaves the session **created**, with no model bound and no error surfaced to the reader. `bindV2PermissionOptions` no longer exists.

**Risk.** Low–Medium. **L2 changes a documented best-effort contract** — record it in `docs/decisions.md` with the alternative considered. **M11** changes an error path from "fail the request" to "degrade", which is what the module already documents.

### 5.8 Phase 7 — The status and form surfaces, and documentation *(L5, M14, M15, M16, M17, M18; L6 withdrawn → a doc fix)*

**Findings:** L5, M14, M15, M16, M17, M18 (Low–Medium). L6 is **withdrawn** (§3.4.8) — its only residue is a documentation fix, folded in below.

**Change.**
1. `OpenCodeStatus.tsx` surfaces the controller's actual reconnect state: `connection: {type:"reconnecting", attempt}` shows as "Reconnecting (attempt n of N)", not as a red "Error". The terminal `failed` state keeps its error presentation and its manual Reconnect affordance. **P10** — if the proxied SSE heartbeat is surfaced (the proxy already observes the body at `src/routes/opencode.ts:510-638`), the staleness signal can distinguish "idle" from "dead".
2. The auth env-var precedence is **not changed** — it already matches upstream V2 (`OPENCODE_PASSWORD` first, `OPENCODE_SERVER_PASSWORD` as the legacy fallback; `packages/cli/src/env.ts:7-13`). What changes is the **documentation**: `docs/security.md` and the V2 contract must state the actual upstream behaviour and cite the upstream source rather than the V1-era prose. The locally installed managed binary was checked directly (`opencode v2.0.32`), matching the pinned client.
3. **M14** — `V2OptionControl` is rendered with a **`key`** derived from the field, so its `otherChosen` / `draft` state cannot survive a question change. Without it, a half-typed custom entry leaks into the next question and `commitDraft` appends the *previous* question's text to the *current* field's answer.
4. **M15 / M16** — a form that cannot be answered must say so. Truncating the option list (M15) or meeting an unrecognised field type (M16) must set `unsupportedReason`, exactly as the field-limit path already does, so the dock reports the form as unanswerable instead of rendering a control that cannot work.
5. **M17** — `OpenCodeStatus.retry()` catches the `reconcileStagedRevert()` rejection, the way the controller already does at `v2ThreadController.ts:1212`. A failed recovery surfaces the error in the store; it does not also become an unhandled rejection.
6. **M18** — `dockSeen.current` is set to `true` when the dock is first seen, so the step-change focus move actually runs. The **source-text** guard in `tests/unit/web/components/approval-keyboard.test.ts` is replaced by a behavioural one, or extended to fail when the behaviour is dead — a guard that asserts source text cannot fail for the reason it exists.
7. **Documentation** —
   - **`docs/opencode-context.md` becomes tracked.** It is currently untracked and two commits stale, and it carries the assumption disproven in §2.2. OpenChamber's equivalent — `.agents/skills/opencode-v2/SKILL.md` — is in git and states where the wire shapes live.
   - `docs/phases.md` — the "OpenCode native V2 — Complete" row is qualified to name the open findings.
   - `docs/decisions.md` — record: the credential-redaction decision (D15, with the "show the user the raw file" alternative considered and why it was rejected), the attempt-scoped retry-accounting rule (D2/D3), the snapshot-vs-live ownership rule (D1), the permission-rule resolution rule (D14, with the upstream citation), the M7 cancel change (D5), and the **undocumented-but-load-bearing** `x-opencode-directory` header (§3.4.5).
   - `docs/security.md` — record that OpenCode's provider credentials are redacted at the server boundary, and that the OpenCode proxy is route-allowlisted and workspace-scoped.
   - **A V2 integration contract** — the authoritative surface is the installed `@opencode/client@2.0.32` type contract, **not** the published prose (which describes V1); the tested CLI/client version is recorded; and documented-versus-empirically-verified upstream behaviour is stated explicitly (§3.4.5, §3.4.8).
   - **Regression tests named after the incident** — adopt the reference's convention (`issue-2039.test.ts`, `reconnect-recovery.test.ts`, `form-recovery.test.ts`, `interrupted-turn-recovery.test.ts`): one file per audit finding, named for the finding ID, so "we fixed it" becomes "it cannot come back".
   - `sync/ownership.md` (from Phase 2) is the per-layer owner/scope table.

**Acceptance test.** A DOM test asserts the chip reads "Reconnecting" during an automatic reconnect and shows the attempt number; the terminal state still reads "Error" and offers Reconnect. **M14:** advancing to the next question resets the control's state, and a draft from the previous question cannot appear in the new one's answer. **M15/M16:** a form with truncated options or an unknown field type reports `unsupportedReason` and is not presented as answerable. **M17:** a failed recovery produces **no** unhandled rejection. **M18:** the step-change focus move **runs**, asserted behaviourally. The auth env-var behaviour is **unchanged** — the assertion is that `OPENCODE_PASSWORD` still wins and `OPENCODE_SERVER_PASSWORD` is still honoured, locking in the match with upstream. `bun run lint`, `bun run format:check` clean; `docs/engineering-quality.md` still describes the gates accurately (no gate changed in this plan).

**Risk.** Low–Medium. **M14** and **M18** are UI behaviour changes that need a real browser check, not a unit assertion.

### 5.9 Phase 8 — Full verification and independent review

**Files:** none.

**Gates.** `bun run typecheck` (backend **and** web) and `bun run build` exit 0, each independently re-run; `bun run lint`, `bun run format:check`, `bun run test:locations` exit 0; `bun run verify` green; `bun run verify:full` (semgrep) green; the OpenCode-scoped suite counts recorded against the Phase 0 baseline with every delta explained; the packaged desktop app manually exercised (closing G1/G2); a live OpenCode check closing G3; Playwright OpenCode specs green (closing G5).

**Required independent review evidence.** The diff read against §5.10's invariant table; per-phase fail-before/pass-after evidence; an explicit list of anything not verified.

### 5.10 The invariant test matrix

Every test below must **fail on the current implementation** and pass after. The last column states how it detects the defect — a guard that cannot fail is a comment.

**Naming and lifecycle.** Each row is an **R-test** (a defect regression, §5.1): it fails today, and is merged with the fix in the phase that closes the finding. Its **B-test** counterpart (the baseline characterization) is written in Phase 0 and **replaced** by the R-test when the fix lands. A B-test that starts failing after a fix signals an unintended behaviour change and must be investigated, not updated.

| # | Invariant | Expected | Current failure mode | How it detects the defect |
|---|---|---|---|---|
| T1 | An assistant delta received during history hydration remains visible after hydration completes | the message is present with its text | created, then erased by the second projection | asserts final `state.messages` |
| T2 | Hundreds of events crossing the buffer cap cannot empty the buffer or corrupt the transcript | the newest window survives; the transcript matches what was streamed | the overflow filter empties the buffer; the reprojection then erases the rest | drives >512 deltas during hydration and asserts both the surviving window and the final text |
| T3 | Stream loss during hydration cannot evade the reconnect ceiling | exactly `1 + budget` attempts, then `{type:"failed"}` | the superseded attempt resets the budget, so it reconnects forever | asserts the connect count and the terminal state, plus a control proving the ceiling works on the connect-failure path |
| T4 | A superseded hydration completing or failing late cannot mutate the current attempt | live state and the connect count are unchanged | it dispatches `load_failed` over the live state and drops the newer attempt's load promise | completes/fails the stale attempt after the successor is ready |
| T5 | A history endpoint failure leaves the runtime recoverable or in a defined terminal state | a defined state, `isHydrating` cleared, later events applied | the runtime stays frozen and buffers every later event | rejects the history read, then emits a delta and asserts it is applied |
| T6 | Ambiguous prompt submission reaches a typed, bounded outcome without falsely claiming rejection | `sendMessage` settles with an ambiguous/recoverable error | it never settles | races the promise against a sentinel; asserts it settles and that the error is not a definitive rejection |
| T7 | Two concurrent replies for one permission or form produce one transport operation | exactly one reply sent | two are sent | overlaps two calls across the transport await |
| T8 | Cancellation requested before admission is honoured exactly once when the prompt becomes admitted | exactly one `inboxCancel` for the admitted inbox id | none is sent | cancels during `submitting`, then admits, and counts the cancel calls |
| T9 | Out-of-scope events are ignored | an event with a foreign `location.directory` changes nothing | it would be applied | emits a foreign-location event and asserts the state is untouched |
| T10 | Configuration responses expose no secret values and no secret-file paths, including in the raw rendering | no `apiKey`-shaped value, no `{file:…}` path, at any depth | the raw file text is returned verbatim | deep assertion over the whole response body, including substitution references |
| T11 | Disallowed proxy routes and methods are rejected; every required V2 client operation still works | shell/fs/credential/config-write/rpc/mcp refused; the real client still works | every route is forwarded | drives the **real** `@opencode/client` against the proxy for the allowed set, and asserts refusal for the excluded set |
| T12 | Requests cannot use a foreign workspace scope | a foreign `x-opencode-directory` is refused | it is forwarded verbatim | issues a scoped request with a foreign header and asserts refusal |
| T13 | Session-removal failure and bootstrap retry behaviour | the pointer survives a failed removal; a retry re-attempts or says why not | the pointer is cleared; `invalidateBootstrap` does nothing | asserts the pointer and the returned outcome |
| T14 | Retention stays bounded without evicting live operations | size bounded; in-flight entries retained | unbounded growth | drives N prompts/permissions, asserts the bound, and asserts an in-flight entry survived |
| T15 | Editing a permission rule addresses **the row the user selected**, and refuses an edit whose identity changed on disk | the selected row changes; a moved/changed row is refused with a reason | the rule is addressed by `(action, resource)` only, so the **first** exact match is edited whatever row was clicked | seeds two rules with the same `(action, resource)`, edits the **second**, and asserts the second changed — the assertion encodes **row identity**, not the upstream evaluation order. A companion case seeds **wildcard-overlapping** rules and asserts both remain editable |
| T16 | A permission rule's *override* status is displayed read-only, from the upstream semantics | the page marks the broader rule as overridden | — | a display-only unit test of the override indicator, plus a **live check against the running server** before shipping (G3) |
| T17 | A failed auxiliary fetch is represented as **unavailable**, not as "nothing pending" | a failed permission-list read leaves the live permission **untouched** and reports the degraded state | the failure degrades to `[]` and **replaces** the list, so the pending permission disappears | fails the permission list on a re-sync and asserts the permission survives; the control (an authoritative `[]`) asserts it is cleared — the two must be distinguishable |
| T18 | A caller-supplied directory never reaches the upstream, and a foreign workspace is refused | the upstream receives the **server's** directory, never the caller's; a foreign directory is refused for every location-scoped route, **including the event stream** | the proxy copies the browser's `x-opencode-directory` verbatim, so the browser chooses the location of every upstream request | asserts what the proxy forwards (the caller's header is absent and the server's is present), and that a foreign directory is refused on `/api/event` and the location-scoped catalogue routes |
| T19 | The proxy resolves the workspace itself, from the session id, against the **local database** | a known session id resolves to its conversation's folder and that directory is forwarded; an **unknown** session id is refused; a path/header session-id mismatch is refused; no proxied request (except `/api/info`) is forwarded without a server-resolved directory | there is no such resolution today — `conversationService` has no lookup by `opencode_session_id`, and the proxy forwards whatever the browser sent | drives the proxy with a stubbed `findByOpenCodeSessionId` + `resolveConversationWorkspace`, asserting the forwarded header equals the resolved directory and that the refusal cases hold |
| T20 | A failed capabilities read is an **error**, not an empty catalogue | a 503 surfaces an error and leaves the previously loaded picker intact | the 503 body parses as success and the picker is silently emptied with no error | issues a failing capabilities request and asserts the error state and that the model list is not replaced by an empty one |
| T21 | A failed catalogue read during **session creation** degrades to "no model", it does not fail the request | the session is created and left unbound | the create throws and the route answers 500 | stubs the catalogue read to fail and asserts the session still exists |
| T22 | The first-prompt handoff is delivered **exactly once**, and never lost | a crash between the claim and the dispatch still delivers the prompt on the next mount; a send that rejected after the server accepted it is not delivered twice | the claim is persisted before the dispatch, so a crash loses the prompt permanently; a failure un-claims and the effect re-fires | drives the handoff across a simulated crash and a simulated post-acceptance rejection |
| T23 | Form state does not leak between questions | advancing to the next question resets the control's state, and a draft from the previous question cannot appear in the new answer | the control is rendered without a `key`, so `otherChosen`/`draft` survive the change | renders a two-question form, types a custom entry in the first, advances, and asserts the second question's answer is empty |
| T24 | A form that cannot be answered says so | truncated options and an unrecognised field type both set `unsupportedReason`, and the dock does not present the form as answerable | both are projected as a working form with no reason | projects a form with 120 options and with an unknown field type, and asserts the reason |

**Method rules.** Drive the real controller through a fake client (as the repo's own harness does); assert the **invariant**, never the internal shape; prefer behavioural assertions over source-text guards; and for every guard, make the defect, watch the test fail, revert.

---

## 6. Dependencies and sequencing

```
              ┌───────────────────────────────┐
              │ 5.1 Phase 0 — Baseline +      │
              │ characterization (no change)  │
              └───────────────┬───────────────┘
                              │
              ┌───────────────▼───────────────┐
              │ 5.2.A1 — proxy route allowlist│  ← Critical; closes the
              │ 5.2.A2 — workspace authorization│    execute half
              └───────┬───────────────┬───────┘
                      │               │
        ┌─────────────▼──────┐  ┌─────▼──────────────┐
        │ 5.2.B — Credential │  │ 5.2.C — Permission  │
        │ redaction (H1)     │  │ row identity (H3)    │
        └─────────┬──────────┘  └─────┬──────────────┘
                  │                   │
                  │            ┌──────▼───────┐
                  │            │ 5.2.D — Event │  (M9)
                  │            │ scope (M9)   │
                  │            └──────────────┘
                  │
                  │   ┌──────────────────────────────────────┐
                  └──►│ 5.2.A3 — CORS narrowing             │  ← HELD on G1/G2
                      │ (the cross-origin read half)        │     sequenced last
                      └──────────────────────────────────────┘

              ┌───────────────▼───────────────┐
              │ 5.3 Phase 2 — Ownership        │  ← behaviour-preserving
              │ extraction                      │
              └───────┬───────────────┬───────┘
                      │               │
        ┌─────────────▼──────┐  ┌─────▼──────────────┐
        │ 5.4 Phase 3 —      │  │ 5.5 Phase 4 —      │
        │ Attempt ownership  │  │ Snapshot merge      │
        │ M1 M2 M4 L4        │  │ H2 M5 M10           │
        └─────────┬──────────┘  └─────┬──────────────┘
                  │                   │
                  └─────────┬─────────┘
                            │
                 ┌──────────▼──────────┐
                 │ 5.6 Phase 5 —       │
                 │ Settlement/cancel/   │
                 │ exactly-once M3 M6 M7│
                 └──────────┬──────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
┌───────▼────────┐ ┌────────▼─────────┐ ┌───────▼────────┐
│ 5.7 Phase 6 — │ │ 5.8 Phase 7 —    │ │ 5.9 Phase 8 —  │
│ Retention +    │ │ UI + docs        │ │ Full verify +  │
│ session L1 L2  │ │ L5 (+L6 doc fix) │ │ independent rev │
│ L3             │ │                  │ │                │
└────────────────┘ └──────────────────┘ └────────────────┘
```

**Groupings.**
- **A1 and A2 are atomic with each other** - A1 alone leaves the allowed routes unscoped, A2 alone leaves the disallowed routes reachable - but **neither waits on an evidence gap**, and together they close M8's execute half and its arbitrary-path half.
- **A3 is last, and is the only unit an evidence gap blocks.** It closes M8's **cross-origin read** half. Holding it must not delay A1, A2, B, C or D - which is why the graph shows it in its own lane rather than blocking the chain.
- **B, C, D are independent** of one another and of A1/A2.
- **Phase 2 (the extraction) is behaviour-preserving** and unblocks 5.4 and 5.5, which are the two phases that rewrite the lifecycle.
- **5.4 must precede 5.6** - M4's "recoverable state" is where the readiness gate lives, and M3's admission registry must survive a superseded attempt.
- **5.5 must precede any fix that depends on live state surviving** - M5's overflow fix is meaningless until the reprojection no longer wipes it, so both belong to the same phase with one combined acceptance test.
- **5.7, 5.8 are independent** of 5.4-5.6 and can land at any point.

**Recommended order:** 5.1 → 5.2.A1 → 5.2.A2 → 5.2.B → 5.2.C → 5.2.D → 5.3 → {5.4, 5.5} → 5.6 → {5.7, 5.8} → 5.9, with **5.2.A3 shipped as soon as G1 and G2 close**, independently of that sequence.

---

## 7. Acceptance criteria (gate level)

A phase is complete only when **all** of these hold, per `AGENTS.md` §Definition of DONE:

1. Planner disk-review **ACCEPTED** — adapter shapes, route order, boundary greps for SDK/adapter leakage, no stale references.
2. `bun run typecheck` (backend **and** web) exit 0 **and** `bun run build` exit 0, each independently re-run. An agent-reported green is not sufficient.
3. Test-agent suite numbers recorded: **suite + case counts, actual numbers**.
4. The phase's specific acceptance tests exist and behave as their category requires: the **R-tests** (§5.10's invariant matrix, T1–T19) are committed as `test.todo` with a body, are reported as *todo* in an ordinary run, **cannot fail CI**, and are **converted to active tests** by the phase that fixes the finding — in the same commit that **deletes** the corresponding B-test. A guard test fails CI if a `test.todo` names a finding that is no longer open. A guard that cannot fail is a comment — the audit's own method applies to every new test.
5. `bun run lint`, `bun run format:check`, `bun run test:locations` exit 0.
6. No commit or push until the end-to-end verification passes.
7. The **evidence gaps** the phase is responsible for (§9.1) are closed with the evidence named for each — not assumed.

**Full-suite gate** (once, at the end): `bun run verify` and `bun run verify:full` (the latter adds `semgrep`), with real exit codes and counts reported, and the OpenCode-scoped suites compared against the §1.2 baseline (147 / 531 / 87 pass, 0 fail) with any delta explained.

---

## 8. Risks, non-goals, and the definition of done for the whole programme

### 8.1 Programme-level risks

| Risk | Mitigation |
|---|---|
| **Scope creep.** The sync-layer extraction plus eight behavioural phases is a large programme. | 5.3 (the extraction) lands alone and changes no behaviour. Each later phase is independently revertible. |
| **Behavioural regression in the assistant-ui adapter.** The controller's state identity drives the adapter rebuild (`v2RuntimeStore.ts:133-152`). | Phase 0's characterization tests pin the adapter contract before any behaviour change; assistant-ui's own contract is prepend/merge, so the H2 fix moves *toward* the library's model, not away from it. |
| **Regression in the OpenCode configuration page**, which has a live e2e against the user's real file. | 5.2.B moves the e2e's credential assertion from the HTTP response to the **file**, so the e2e still proves preservation. 5.2.C's row-identity change is a **separate** unit with its own review, because it is product-facing and must not be buried in a security diff. |
| **A wrong allowlist breaks Code mode** — the highest-probability failure in the programme. | The allowlist is derived from the client and asserted in both directions (§5.2.A, D10). It lands **before** the CORS narrowing, so a mistake is caught in testing rather than in the field. |
| **The H3 override indicator is wrong in a way the source does not predict.** | G3 is a **shipping gate for the display only**: the read-only "this rule is overridden" indicator is not merged until a live server confirms it. The **write** path's row-identity change does not depend on G3. |
| **Over-engineering by import.** OpenChamber's scale is not ours (see §3.3). | §3.3 is normative: no WebSocket transport, no multi-directory stores, no classifier. |
| **Fixing symptoms.** Every item in §5 names the mechanism, not the symptom. | The audit's own rule: prove the defect, watch the test fail, revert, then fix. |

### 8.2 Non-goals

- Not adopting `@assistant-ui/react-opencode` or any other OpenCode runtime — the 2026-10-07 architecture lock stands.
- Not adding a second streaming protocol, MCP client, router, or state framework.
- Not changing the Direct chat runtime, MCP, scheduler, memory, or the provider registry.
- Not changing the OpenCode CLI version range or the binary-resolution behaviour landed by `b022b8b` / `b65b6c8`.
- Not adding a dependency. Every item in §5 is implementable with what is already installed.
- **Not designing V1 API support, V1 route compatibility, protocol fallbacks, or dual-version runtime abstractions.** The V2 contract is the only contract.
- **Not removing the V1-shaped configuration entries** until their status in the current V2 schema is verified (D14) — the V1 object form is V1-scoped upstream, but the V2 schema still accepts legacy-shaped entries.

### 8.3 The whole programme is done when

- **M8** (Critical) and **H1**, **H2**, **H3** are closed with a test that fails on the pre-fix code.
- **M1–M7, M9–M19** are closed, each with a fail-before/pass-after test.
- **L1–L5, L7** are closed or explicitly accepted in writing by the maintainer, with the reason recorded. **L6 is withdrawn** (proved false) — its residue is the documentation fix in §5.8.
- The **B-test / R-test** discipline holds end to end: every R-test is committed as a `test.todo` that cannot fail CI, every fix converts its todo to an active test and deletes the corresponding B-test **in the same commit**, no quarantine outlives its fix (the guard test proves it), and no B-test fails for an unintended reason.
- `bun run verify` and `bun run verify:full` are green, with real counts reported against the **Phase 0** baseline (which closes G4 and G5).
- The evidence gaps **G1, G2, G3** are closed by the evidence named for each — the packaged build is exercised, the dev origin is confirmed, and the permission override display is confirmed against a live server.
- `docs/phases.md`, `docs/decisions.md`, `docs/security.md`, the tracked `docs/opencode-context.md`, and a **V2 integration contract** match the shipped behaviour; the contract states that the pinned `@opencode/client` type surface is authoritative over the published prose, records the tested CLI/client version, and separates documented from empirically-verified upstream behaviour.
- The OpenCode-scoped suites carry **new** cases for every finding, named for the finding, and the invariant matrix in §5.10 is fully covered.

---

## 9. Decisions, and the evidence gaps behind them

### 9.1 Evidence gaps — what could not be established without side effects

These are **not** open decisions. Each is a fact that could not be obtained without writing to real user configuration, launching a managed server against the user's real files, or running a suite that was out of scope. They are labelled so a later reader knows exactly what is standing on measurement and what is standing on source reading.

| # | Gap | Why it matters | Closes in |
|---|---|---|---|
| **G1** | The exact origin string the packaged Tauri webview sends (`app://localhost` per `src-tauri/tauri.conf.json:10`), and whether the webview enforces CORS for a custom scheme. The current allow-list entry `http://app.localhost` carries a different scheme and matches nothing TBAi serves. | Determines the exact CORS entries in D12 | **CLOSED by A3, and the gap's premise was WRONG.** `http://app.localhost` is the correct Windows WebView2 origin for the custom `app` protocol: Tauri's own API documentation for `register_asynchronous_uri_scheme_protocol` states that Windows/Android get `http://<scheme>.localhost/` by default (macOS/Linux get `<scheme>://localhost/`), and TBAi is Windows-x64-only. This repository's `docs/architecture.md` already recorded it. The **runtime** confirmation of the packaged WebView is still unverified here (no Cargo on this machine) |
| **G2** | Which origin the Tauri **dev** build actually uses - `devUrl: "http://localhost:3000"` vs Vite's implicit default 5173. | Same | **CLOSED by A3.** The two are not alternatives in this repository: `beforeDevCommand` is `"bun run dev"`, which starts the **backend** (the root `dev` script), and the backend serves the SPA itself, so the dev window's origin is the backend's own - 3000 - and `devUrl` and the launch command agree. The Vite dev server is a separate, plain-browser flow whose API calls are relative (hence same-origin, hence not a CORS participant); its port is now pinned to 5173 with `strictPort: true` so it cannot drift silently. The **runtime** confirmation of the packaged dev build is still unverified here (no Cargo) |
| **G3** | Live confirmation that the running server's permission **evaluation** matches the upstream source (`findLast` + wildcard) — needed only for the **read-only "this rule is overridden" indicator**, not for the write path's row-identity fix. Starting a managed server would have required writing a real configuration file, which the audit's boundaries forbid | **CLOSED by Phase 1.** Verified live against a managed `opencode serve` **2.0.32** with a TEMPORARY, isolated configuration (`XDG_CONFIG_HOME` pointed at a temp dir) and the repository's own local stub provider — no credentials, no network, and the user's real OpenCode configuration was never read or written. Twelve cases confirmed: the LAST matching rule wins (`findLast`); the match is a wildcard; the **action** is the tool's name (the upstream's shell tool is `shell`, not `bash`); the **resource** is the command string (`permission.asked` carried `resources: ["git status"]`); `allow` runs the call, `ask` raises `permission.asked`, and `deny` refuses it ("Permission denied: shell") AND removes the tool from the list the model is offered. The plan's assumptions were **confirmed, not contradicted** | — |
| **G4** | Whether `bun run verify` (full) is green at HEAD. Not run during the audit. | The baseline every phase's delta is measured against | **CLOSED by Phase 0** - `bun run verify` green; see 5.1.1 |
| **G5** | Whether the Playwright OpenCode specs pass. Not run during the audit. | Same | **PARTIALLY CLOSED by Phase 0.** The `verify` job is green, and the Playwright **E2E** job is a separate CI job that was already green on `3351f81` (Actions run #54, `verify` job) but was **not** re-run locally: `playwright` is not on this machine's PATH, and the suite needs browser binaries plus a spawned server. The **live** OpenCode spec is opt-in by policy and is not a gate. |
| **G6** | Whether the OpenCode CLI on this machine (`D:\Coding\OpenCode\opencode.exe`, present, **version checked directly as `opencode v2.0.32`**, but never started) behaves identically to the pinned client contract. | The client and the CLI are separate artifacts with separate versions | Phase 8 |
| **G7** | Whether a **pre-existing exact-duplicate** rule in the user's configuration should be refused, warned about, or edited normally. The append guard (which refuses creating one) is kept as-is; the *pre-existing* case is a policy choice. | Determines whether the config page can offer a normal edit for a duplicated row or must guide the user to resolve it first | **CLOSED by Phase 1 — Option C, approved by the maintainer.** Duplicate rows are INDEPENDENTLY EDITABLE: the page keys its rows by the rule's position in the file, names each row's controls with its row number, and the write names the position as well as the identity. The backend's protection is unchanged: it re-checks the identity at that position before writing and refuses a rule that moved or changed. The append guard is untouched | — |

**Everything else in this document is either source-confirmed, runtime-verified, or cited to a named upstream location.** The distinction is carried in the status column of §2.1 and in the "Basis" column of §9.2.

---

### 9.2 The decisions

| # | Decision | Basis |
|---|---|---|
| **D1** | **History and live events.** A snapshot **always** preserves the live events observed after its read began — *regardless of whether the read was automatic or user-initiated*. The precedence rule: the snapshot is authoritative for what it covers; **live events observed during the read are authoritative over the snapshot** for what they touch; a snapshot may only remove state the client itself no longer holds. Replacement is permitted **only** where the caller can establish that no newer live state would be discarded — i.e. a first load (nothing has been applied yet) or a backward-looking pagination prepend. **An explicit user-initiated `refresh()` is not by itself such a guarantee**, because live events may still arrive while it fetches; it uses the same merge path. | Upstream offers no stream resume (§3.4.5), so a merge is the only available shape; assistant-ui's own contract prepends rather than replaces (§3.4.7); the reference implements the same three-way merge (§3.2 P1). The initiator of the read is irrelevant to the correctness rule — only the read window is. Verified safe for every consumer — see §5.5's "must not" list. |
| **D2** | **Reconnect policy.** Keep the bounded ceiling. A superseded attempt must never reset the current attempt's budget: the reset becomes attempt-scoped and fires only on a **completed** hydration. Add the reference's foreground/background cap (5 s visible+online, 60 s hidden/offline) and immediate long-cap on permanent 4xx — refinements, not new machinery. | The maintainer's cumulative-wait justification (`docs/opencode-context.md:120`) still holds, and the reference's unbounded policy is wrong for a local single-user app. M1 proved the ceiling exists but the accounting was broken. |
| **D3** | **Async ownership.** One owner: the attempt. `sync/attempt.ts` holds attempt-local readiness, load promise, epoch and abort signals; the controller holds `currentAttempt`; every async continuation captures its attempt and verifies identity before committing state, settling a promise, or resetting a counter. | §4.1. This eliminates M1, M2 and L4 as a **class** rather than case by case. Same discipline as the reference's `configCacheGeneration` (§3.2 P7) and assistant-ui's `activeRunId` (§3.4.7). |
| **D4** | **Prompt settlement.** Four outcomes — **admitted**, **definitively rejected**, **ambiguous**, **disposed**. An ambiguous network result is **never** reported as a rejection. Every wait is bounded: the ambiguous path settles `sendMessage`, and the composer shows a visible waiting state. | M3 is a confirmed runtime hang; the reference's `promptsInFlight` registry with an **idempotent** release and its `startupGate` with a bounded timeout are the proven shapes (§3.2 P3, P4). |
| **D5** | **Cancellation.** Do **not** abort an ambiguous in-flight request — its outcome is genuinely unknown. Record a pending cancel against the local message id; on admission, issue the cancel against the admitted inbox id **exactly once**. | M7. The current no-abort half is correct and deliberate; the missing half is the post-admission cancel. This **changes behaviour the repository currently asserts** (`v2ThreadController.test.ts:771`) and must be adopted deliberately. |
| **D6** | **Permissions and forms.** Claim the request id **before** the await; release only on a definitive failure. A later `permission.replied` event invalidates an in-flight decision. Exhausted retries **fail closed**, leaving the request visible for manual action. | M6; the reference's fail-closed reply policy (§3.2 P8). |
| **D7** | **Hydration and recovery.** The controller is always in exactly one of `idle`, `connecting`, `hydrating`, `ready`, `reconnecting(attempt)`, `failed(attempt)`, `disposed`. Connect failure → reconnecting within budget, failed beyond it. History-fetch failure → reconnecting, with `isHydrating` cleared in a `finally`. Auxiliary-fetch failure → **degrade, do not fail** (existing behaviour, kept). Manual takeover → the new attempt owns readiness. Disposal → everything settled. | M4, M1, M2. The reference's watchdog and gate (§3.2 P2, P4) supply the vocabulary. |
| **D8** | **Event scope.** Validate `event.location` (`LocationRef.directory`) against the subscribed directory; events with no `location` are location-scoped by definition and are kept. Defence in depth — **not** a substitute for the subscription scope. | M9. The contract provides the scope precisely so a client can verify it (§3.4.6). The `x-opencode-directory` header is **undocumented** (§3.4.5), so verification is not optional. |
| **D9** | **Configuration disclosure.** Redact at the server boundary, with coverage derived from the **published V2 schema** (§3.4.3) — provider settings/headers/body, legacy provider options, MCP headers/environment/client secret, plugin env — and **substitution-aware** (`{env:…}` and `{file:…}` are masked, never resolved). The write path keeps the real bytes. | H1. The reference strips the same secret at the server boundary (§3.2 P5); the schema gives the authoritative coverage list, so the redaction is derived rather than guessed. |
| **D10** | **Proxy capabilities.** Expose only the V2 routes the **browser's client** actually calls — a list **derived from the client**, with a two-way drift test so it cannot rot into a second blocklist. The backend-only catalogue routes (`/api/model`, `/api/model/default`, `/api/provider`, `/api/agent`, `/api/command`) are **not** in it, because the backend calls them directly against the managed server and never through the proxy. Excluded: shell, fs, credential, integration, rpc, pty, persistent-pty, config-write, mcp, vcs-init, session-export, debug, plugin-update. | M8. This is the **primary** control: CORS is a browser-side control that any local non-browser process bypasses. The route set is now knowable from the pinned client (§3.4.1) and from the browser's own operations list (`v2Client.ts`). |
| **D11** | **Workspace isolation — three classes, and one owner.** (A) **Globally scoped** endpoints, which upstream does not location-scope and which return no workspace data, need no workspace authorization — on the pinned client that is effectively `/api/info` alone. (B) **Location-scoped endpoints with no session id in the path** — in the proxy-reachable set that is **`/api/event`** alone, the *directory-scoped* stream (the global one is the separate `/global/event` route) — must have their directory **resolved and authorized server-side**; *no session id is not no authorization*. (C) **Session-scoped endpoints** take the session's resolved workspace as authoritative. **The proxy does not forward a caller-supplied directory at all**: it strips `x-tbai-session`, `x-opencode-directory` and `location[directory]`, resolves `sessionId → conversation → folder → directory` through the **local database** (`conversationService.findByOpenCodeSessionId` — **to be added** — plus the existing `resolveConversationWorkspace`), and sets the header itself. The full mechanism, the failure modes, and how valid selection keeps working are specified in §5.2. | M8 and correction 1. Upstream `packages/server/src/location.ts:71-79` resolves the location of **every** request from `location[directory]` or the `x-opencode-directory` header, defaulting to `process.cwd()`; `packages/server/src/handlers/event.ts` shows `/api/event` is the per-location `EventFeed` subscription. The proxy currently copies the browser's header verbatim (`src/routes/opencode.ts:381`), so the browser chooses the location of every upstream request. `docs/security.md:130-137` states OpenCode works inside the conversation's resolved workspace; today that confinement is advisory, not enforced — and, for the event stream, not enforced at all. |
| **D12** | **CORS.** Trust exactly the origins TBAi serves: the packaged Tauri origin (`app://localhost` — the current `http://app.localhost` entry has the wrong scheme and matches nothing TBAi serves), the Vite dev origin (**made explicit** in `vite.config.ts`), and no-`Origin` same-origin requests. Every other `127.0.0.1` / `localhost` port becomes untrusted. Defence in depth behind D10, not a substitute for it. | M8. The broad localhost trust is what turns the proxy into a cross-origin command surface, and the preflight was verified to succeed. Evidence gaps **G1**/**G2** must close before the exact entries are fixed. |
| **D13** | **OpenCode MCP surface.** **Deny** OpenCode's MCP administration routes through the general proxy. There is no product requirement in this repository for the browser to add, connect or configure an OpenCode MCP server; TBAi owns MCP credentials and policy in its own `/api/mcp` with encrypted tokens. If a requirement emerges it needs its own authenticated route with its own policy — not a hole in the general proxy. | M8 / `AGENTS.md` MCP ownership. The status quo — reachable, unowned — is the one option that must not survive. |
| **D14** | **Permission-rule editing.** A rule is addressed by **position plus a re-checked identity** — the pattern `removeOpenCodePermissionRule` already uses — and the UI's row identity becomes position-based rather than content-based. The page **indicates when a rule is overridden** by a later, more specific match, so the user can see that a broader rule is shadowed while still being able to edit it. **Wildcard-overlapping rules are a normal, intended part of the V2 precedence model and are neither rejected nor hidden.** The exact-duplicate guard on append is **kept as-is**. The **V1 object form is not removed** — it is V1-scoped upstream, but the current V2 schema still accepts legacy-shaped entries, and its status must be verified before any removal. TBAi does **not** reimplement permission evaluation; it reads the upstream semantics only to *display* which rule is in force. | H3 (§3.5). The defect is **row identity**, not evaluation: the `PUT` route carries only `{action, resource, effect}`, so a configuration with exact duplicates can cause the wrong row to be edited, and the UI's `ruleKey` collides. The upstream semantics (§3.5.1) are the *context* that makes the distinction matter — they are not something TBAi should reimplement or enforce. |
| **D15** | **Configuration secrets — the native view.** Default to a **redacted, permanently** rendered document. There is no "reveal" affordance: any origin that can reach the API could use it, and per D10 the API is reachable by more than the app. The byte-exact document remains on disk and through the OpenCode server, where the user already has it. The permissions table remains the editable surface. | H1 + M8. The diagnostic value (structure, keys, unknown fields) survives; the credential exposure does not. |
| **D16** | **Resource retention.** One policy for every long-lived per-controller collection: a **max size** and a **TTL**, evicting only **settled** entries. An entry that is still in flight is never evicted. | L1. The reducer's existing 256-item windows are the precedent; the reference uses TTL + max-entries and **tests the eviction policy itself** (§3.2 P9). |
| **D17** | **Session removal and bootstrap.** `terminateOpenCodeSession` reports `{terminated:false, reason}` when the remote removal failed and **keeps the persisted pointer** — a pointer to a possibly-live session is recoverable, a cleared pointer orphans it. `invalidateBootstrap` either does what its name says or is removed and its caller changed. | L2, L3. A function that promises a reset and does nothing is worse than its absence. |
| **D18** | **Authentication environment variables — no change to the code.** Upstream V2 reads `OPENCODE_PASSWORD` first and honours `OPENCODE_SERVER_PASSWORD` as the legacy fallback (`packages/cli/src/env.ts:7-13`, upstream source), and **TBAi already matches that exactly** (`src/config/opencode.ts:48-50`, `src/services/opencode/runtime.ts:138-153`, which also sends both to the child). **The earlier recommendation to reverse the precedence is withdrawn.** What remains is a **documentation** fix: `docs/security.md` and the V2 contract must state the actual upstream behaviour and cite the upstream source — **not** the V1-era prose, which is the same reason that prose cannot be used as V2 evidence elsewhere (§3.4.1). The locally installed managed binary is `opencode v2.0.32` (checked directly), matching the pinned client. | L6 withdrawn (§3.4.8). Verified against upstream source and the local binary; the published prose is V1-era and was the wrong authority. |

### 9.3 What remains genuinely open

Only three items, and none of them blocks a phase:

| Item | What is needed | Owner |
|---|---|---|
| The exact set of upstream routes a **future** client might call | Mitigated by the two-way drift test in D10 — the allowlist fails the build when the client moves | — |
| Whether the packaged desktop app's webview enforces CORS for the `app://` scheme | A manual run of the packaged build | G1 |
| Whether the developer's local workflow needs any origin beyond the Vite dev origin | A maintainer statement of the workflow | G2 |

---

## 10. Appendix A — evidence log

**Audit commands run and their real results** are in §1.2. The audit's verification code lived **outside** the repository, in `C:\Users\RTPC\AppData\Local\Temp\opencode\oc-audit\`, and is not part of the deliverable. It comprised:

| File | Proves |
|---|---|
| `harness.ts` | A fake client/generation mirroring the repository's own `tests/unit/web/opencode/v2ThreadController.test.ts` harness, so the findings are measured against the real controller. |
| `reconnect.test.ts` | **M1** (the ceiling is never reached — 7 connects against a budget of 3) plus its **control** (the ceiling *is* reached when the retries fail to connect); **M2** (a superseded attempt's late failure sets `load:"error"` over a healthy connection and forces a third connect). |
| `pipeline.test.ts` | **M3** (`sendMessage` never settles; `reconcilePendingPrompt` is what settles it, and nothing calls it); **M5** (600 buffered deltas → the replay begins at `d513`, 87 survive); **H2** (one buffered delta is created and then wiped one dispatch later); **M4** (a failed hydration leaves the transcript frozen; its control proves the same event *does* apply after a successful hydration). |
| `permission.test.ts` | **M6** (two overlapping `replyToPermission` calls → two transport calls). |
| `aux-failure.test.ts` | **M10** (a re-sync whose permission-list fetch fails **clears** the live permission) plus its **control** (an authoritative empty list also clears it — the two must be distinguishable, and today they are not). 1 pass / 1 fail. |
| `bun-quarantine.test.ts` | The runner semantics §5.1's quarantine design depends on: `it.skip(name, body)` **does not execute** its body (bun has no flag to run it); `test.todo(name, body)` **does not execute** in an ordinary run and **does** execute under `bun test --todo`, where a failing assertion is still reported as *todo*, not as a failure. Both forms therefore cannot fail CI, and only the `todo` form can demonstrate a failure on demand. |
| `cors.test.ts` | **H1** reachability — a verbatim reproduction of `src/routes/index.ts:38-62` proves `http://localhost:*` and `http://127.0.0.1:*` origins can read the response, and a public origin cannot. |
| `cors-write.test.ts` | **M8** reachability — the same reproduction answers the decisive question: a localhost origin's **preflight succeeds** for `OPTIONS` with `Content-Type: application/json` + `x-opencode-directory` (204, echoed origin, `POST` allowed), and the real cross-origin **POST with a body** is answered and readable. 3 pass / 0 fail. |
| `official-contract` (ad-hoc, outside the repo) | Fetched `https://opencode.ai/config.json` and `https://opencode.ai/docs/*.md`; extracted the V2 route surface from the installed `@opencode/client@2.0.32`; confirmed `event.subscribe` takes no parameters; confirmed every V2 event carries `location?: LocationRef`. |
| upstream source (ad-hoc, outside the repo) | Read `sst/opencode@dev` → `packages/core/src/permission.ts` (`evaluate()` = **`findLast`**), `packages/core/src/util/wildcard.ts` (the matching rules), `packages/schema/src/permission.ts` (the V2 `Rule`/`Ruleset` shape), `packages/core/src/v1/config/permission.ts` (the V1 object form is V1-scoped), `packages/cli/src/env.ts` (the auth env-var precedence — **which withdrew L6**). The locally installed managed binary was checked directly: `opencode v2.0.32`. |
| `official-contract.*` (ad-hoc, outside the repo) | Fetched `https://opencode.ai/config.json` and `https://opencode.ai/docs/*.md`; extracted the V2 route surface from the installed `@opencode/client@2.0.32`; confirmed `event.subscribe` takes no parameters; confirmed every V2 event carries `location?: LocationRef`. |

**Reference-study citations** are `file:line` in `D:\Temp\openchamber` @ `bf977d2` and are collected in §3.2 (P1–P11), §3.3 and §12.

---

## 11. Appendix B — finding → source-location index

| ID | Primary source locations |
|---|---|
| **M8** | `src/routes/opencode.ts:345-502` (the catch-all) · `:381-398` (header handling) · `:400-403` (method + body forwarding) · `src/routes/index.ts:38-62` (CORS) · `src-tauri/tauri.conf.json:10` (the real app origin) · upstream route surface: `node_modules/@opencode/client/dist/chunks/shared-events-hqeq47hr.js` |
| **H1** | `src/routes/opencode.ts:181-192` · `src/services/opencode/configDocument.ts:191-231` · `web/src/features/opencode/openCodeConfig.ts:131` · `web/src/features/opencode/OpenCodeConfigPage.tsx:156-165,597` · proxy bypass: `src/routes/opencode.ts:345-502` · CORS: `src/routes/index.ts:38-62` · credential evidence: `tests/unit/opencode/configDocument.test.ts:38-42,187-201`, `tests/unit/opencode/capabilitiesDefaultModel.test.ts:16,70-73`, `docs/decisions.md:1530,1540` |
| **H2** | `web/src/features/opencode/v2ThreadController.ts:662-699` · `web/src/features/opencode/v2Events.ts:747-776` |
| **H3** | `src/services/opencode/configDocument.ts:370-396` (the edit path — `findIndex` + exact equality, addressed by content) · `src/routes/opencode.ts:286-313` (the `PUT` carries only `{action, resource, effect}`) · `web/src/features/opencode/OpenCodeConfigPage.tsx:117-119` (`ruleKey` = `action\0resource` — collides on exact duplicates) · the correct pattern already present at `configDocument.ts:463-488` (`removeOpenCodePermissionRule`: index + identity re-check) · upstream semantics for context: `packages/core/src/permission.ts` (`evaluate`), `packages/core/src/util/wildcard.ts` |
| **M1** | `web/src/features/opencode/v2ThreadController.ts:503-538` (`:529` charge) · `:784-787` (reset) · `:666`,`:686` (early returns) · `:567-595` (`loadAuxiliary` swallows) · `docs/opencode-context.md:145` (the disproven assumption) |
| **M2** | `web/src/features/opencode/v2ThreadController.ts:788-795` · `:805-808` · `:274-296` (module-level slots) |
| **M3** | `web/src/features/opencode/v2ThreadController.ts:324-330` · `:882-898` (no live caller) · `:953-955`,`:1001` |
| **M4** | `web/src/features/opencode/v2ThreadController.ts:748` · `:684` · `:788-795` · `:469-478` |
| **M5** | `web/src/features/opencode/v2ThreadController.ts:467-486` (`:472-476`) · `web/src/features/opencode/config.ts:7` |
| **M6** | `web/src/features/opencode/v2ThreadController.ts:1095-1123` · `:1152-1165` · `:1167-1177` |
| **M7** | `web/src/features/opencode/v2ThreadController.ts:1013-1041` · `:823-840` · `tests/unit/web/opencode/v2ThreadController.test.ts:771` |
| **M9** | `web/src/features/opencode/v2Events.ts:142-147` (no `location` read) · upstream: `@opencode/client@2.0.32` `types.d.ts:801-804` (`LocationRef`), `:466-468` (`LocationPublicRef`), and every V2 event type |
| **M10** | `web/src/features/opencode/v2ThreadController.ts:563-606` (`loadAuxiliary` degrades each failure to `[]`) · `:617-633` (`applyAuxiliary` dispatches that empty array) · `web/src/features/opencode/v2Events.ts:790-804` (the stale guard does not catch a failure) · `web/src/features/opencode/useOpenCodeAuxiliaryResync.ts:42-44` (the 30 s poll runs only while idle; the visibility trigger runs always) · `v2ThreadController.ts:1133-1150` (the auto-approve drain reads `state.permissions`) |
| **L1** | `web/src/features/opencode/v2ThreadController.ts:291-294` |
| **L2** | `src/services/opencode/sessions.ts:344-390` |
| **L3** | `web/src/features/opencode/sessionBootstrap.ts:130-133` · `web/src/features/opencode/OpenCodeView.tsx:81-88` |
| **L4** | `web/src/features/opencode/v2ThreadController.ts:784-795` · `:840-843` |
| **L5** | `web/src/features/opencode/OpenCodeStatus.tsx:39-54` · `web/src/features/opencode/v2ThreadController.ts:521-525` |
| **L6** | **Withdrawn** — TBAi matches upstream exactly: `src/config/opencode.ts:48-50` and `src/services/opencode/runtime.ts:138-153`; upstream `packages/cli/src/env.ts:7-13` |
| **M11** | `src/services/opencode/sessionModel.ts:91-111` (the two unguarded awaits) · `src/services/opencode/sessions.ts:307-308` (the unguarded call site) · `src/services/opencode/capabilities.ts:105-113,249-254` (the throwing delegates) |
| **M12** | `web/src/features/opencode/useOpenCodeCapabilities.ts:104-108` · `src/routes/opencode.ts:328` (the JSON error body) · `web/src/lib/platform.ts:68-93` (`apiFetch` does not throw on non-2xx) |
| **M13** | `web/src/features/opencode/FirstPromptHandoff.tsx:107` (claim before dispatch) · `:146` (clear only after) · `web/src/features/chat/state/pendingFirstMessage.ts:91-108` |
| **M14** | `web/src/features/opencode/V2FormCard.tsx:560` (the render without a `key`) · `web/src/features/opencode/V2OptionControl.tsx:235-236,259` |
| **M15** | `web/src/features/opencode/v2Forms.ts:88` (the truncating slice) · `web/src/features/opencode/config.ts` (`OPENCODE_V2_FORM_OPTION_LIMIT`) |
| **M16** | `web/src/features/opencode/v2Forms.ts:157-166` (the catch-all `else`) |
| **M17** | `web/src/features/opencode/OpenCodeStatus.tsx:66` · `web/src/features/opencode/v2ThreadController.ts:871-879` (the rejection) · `:1212` (the correct call) |
| **M18** | `web/src/features/opencode/V2FormCard.tsx:216,396,410,413` · `tests/unit/web/components/approval-keyboard.test.ts` (the source-text guard) |
| **M19** | `web/src/features/opencode/FirstPromptHandoff.tsx:136-137,176-185` · `web/src/features/chat/state/pendingFirstMessage.ts:17` (the doc claim) |
| **L7** | `web/src/features/opencode/v2Permissions.ts:241-250` (the definition; the discarded return value) |

---

## 12. Appendix C — OpenChamber citation index

| Ref | File | Lines | Pattern |
|---|---|---|---|
| P1 | `packages/ui/src/sync/directory-recovery-snapshots.ts` | 18-35, 86-113 | Snapshot ↔ live-event merge |
| P1 | `packages/ui/src/sync/DOCUMENTATION.md` | 536-538 | The rule, stated |
| P1 | `packages/ui/src/sync/session-message-loader.ts` | 1158-1201, 733-735 | `commitPage` merge / prepend / replace |
| P1 | `packages/ui/src/sync/optimistic.ts` | 41-72, 77-88 | Optimistic merge, reference-preserving |
| P2 | `packages/ui/src/sync/event-pipeline.ts` | 646, 657-666, 760-782, 975-1065 | Attempt-scoped reset; reconnect loop |
| P2 | `packages/ui/src/sync/event-pipeline.ts` | 629-638, 1043-1044, 1061-1063 | Backoff caps, permanent-4xx, early wake |
| P3 | `packages/ui/src/sync/prompts-in-flight.ts` | 1-42 | In-flight prompt registry |
| P4 | `packages/ui/src/sync/opencode-startup-gate.ts` | 1-129 | Bounded, settling readiness gate |
| P4 | `packages/ui/src/sync/DOCUMENTATION.md` | 1313-1315 | The rule, stated |
| P5 | `packages/web/server/lib/opencode/config-v2.js` | 669-689 | `settings.apiKey` redaction |
| P6 | `packages/web/server/lib/opencode/proxy.js` | 265-320 | Allowlist, not blocklist |
| P7 | `packages/ui/src/lib/opencode/client.ts` | 1846-1850, 1864-1905 | Generation-guarded cache |
| P7 | `packages/ui/src/sync/session-message-loader.ts` | 686-695, 917-921, 1166, 1189 | `isCurrent()` + `bumpGeneration` |
| P8 | `packages/ui/src/sync/DOCUMENTATION.md` | 579 | Fail-closed reply policy |
| P9 | `packages/ui/src/lib/opencode/provider-tracker.ts` | 14-15, 32-40, 59-62 | TTL + max-entries eviction |
| P10 | `packages/ui/src/sync/DOCUMENTATION.md` | 575 | Stream *activity* vs delivered events |
| P11 | `packages/ui/src/sync/DOCUMENTATION.md` | 959-985 | Targeted cloning (1972 → 296 renders) |
| — | `packages/ui/src/sync/DOCUMENTATION.md` | 84-123 | Ownership map |
| — | `.agents/skills/opencode-v2/SKILL.md` | 1-45 | Tracked upstream-boundary contract |
| — | `packages/ui/src/sync/{issue-1637-2270,issue-2039,issue-2404}.test.ts`, `reconnect-recovery.test.ts`, `session-switch-resync.test.ts`, `form-recovery.test.ts`, `interrupted-turn-recovery.test.ts` | — | Issue-named regression tests |

**Not read** (and therefore not claimed): `packages/electron/`, `packages/vscode/`, `packages/mobile/`, the tunnel/PWA surfaces, and the plugin/extension runtime. If §4's split is adopted, those areas need their own pass before anything is mirrored from them.

---

## 13. Appendix D — official OpenCode API citation index

Sources: `https://opencode.ai/config.json` (published JSON Schema), `https://opencode.ai/docs/<page>.md` (published doc sources), and the installed `@opencode/client@2.0.32` (`node_modules/@opencode/client/dist/`).

| Ref | Source | Detail | Bears on |
|---|---|---|---|
| O1 | `docs/server.md:34-37`, `docs/cli.md:695` | HTTP basic auth is `OPENCODE_SERVER_PASSWORD`; username defaults to `opencode` — **but this is the V1-era prose**; see U9, which supersedes it | **L6 withdrawn** — this citation must not be used as the authority |
| O2 | `docs/server.md:267` | `GET /event` — *"First event is `server.connected`, then bus events"* | validates `v2Client.ts:184` |
| O3 | `docs/server.md` route table | The **V1** surface: `/session/:id/message`, `/session/:id/abort`, `PUT /auth/:id`, `POST /provider/{id}/oauth/authorize` | §3.4.1 — docs lag the client |
| O4 | `docs/server.md` route table | `POST /instance/dispose`, `PATCH /config`, `POST /mcp`, `POST /log`, `POST /tui/*`, `GET /find`, `GET /file/content` | the exposure surface behind **M8** |
| O5 | `node_modules/@opencode/client/dist/chunks/shared-events-hqeq47hr.js:1048-1049` | `event.subscribe` → `sse({ method:"GET", path:"/api/event" })` — **no query parameters** | §3.4.5 — no official stream resume |
| O6 | same file, all `path: \`/api/...\`` occurrences | The ~140-route V2 surface, including `/api/session/{id}/shell`, `/api/fs/read/{path}`, `/api/credential/{id}`, `/api/integration/{id}/connect/command`, `/api/rpc/{id}/{method}`, `/api/pty/*` | **M8** — the allowlist source |
| O7 | `types.d.ts:801-804`, `:466-468` | `LocationRef = { directory: AbsolutePath; workspaceID?: WorkspaceID }`; `LocationPublicRef = { directory }` | **M9** |
| O8 | `types.d.ts:1291-1296`, `:1310-1315` and every other V2 event | Every event carries `location?: LocationRef` and `durable: {aggregateID, seq, version: 1}` | **M9**; validates TBAi's durable-sequence handling |
| O9 | `types.d.ts:171-172` | `EventID = string`, `EventSeq = number` | validates the dedupe model |
| O10 | `config.json` `$defs.Config.ProviderEncoded` | `providers.<id>` = `{canonical,name,env,package,compatibility,settings,headers,body,models}`, `additionalProperties: false` | **H1** redaction list |
| O11 | `config.json` `$defs.Config.Provider.Settings` | `settings` allows **arbitrary** extra keys (`allOf: [{additionalProperties: …}]`) — so `apiKey` is permitted but not declared | **H1** |
| O12 | `config.json` `$defs.ProviderConfig` | Legacy `provider.<id>.options.apiKey` — explicitly declared | **H1** |
| O13 | `config.json` `$defs.Mcp.OAuthConfigEncoded` | `mcp.<name>.oauth.client_secret` | **H1** |
| O14 | `config.json` top-level `permissions` → `$defs.Permission.Ruleset`; `$defs.Permission.Rule` | The **array** form `{action, resource, effect}`, all required, `additionalProperties: false` | validates TBAi's model; **Q7** |
| O15 | `docs/permissions.md` | The **v1 object** form; *"last matching rule winning"* | the prose/schema disagreement — resolved by §3.5, decision **D14** |
| O16 | `docs/permissions.md` "Defaults" | Most permissions default to `allow`; `doom_loop` and `external_directory` default to `ask`; `read` is `allow` but `*.env` is `deny` | informs the Auto-shield policy |
| O17 | `docs/config.md:864-910` | Variable substitution: `{env:VAR}` and `{file:path}` | **H1** — redaction must be substitution-aware |
| O18 | `docs/mcp-servers.md:138,194-205,254,458` | MCP `headers`, `environment`, `oauth.clientSecret` carry secrets in the config | **H1**, **D13** |
| O19 | `docs/troubleshooting.md:27`, `docs/cli.md:143`, `docs/mcp-servers.md:237` | `auth.json` (provider keys / OAuth tokens) and `mcp-auth.json` live **outside** the config file | **M8** — the allowlist is what keeps them out of the browser |
| O20 | `docs/plugins.md:260` | Plugin `output.env` can hold secrets | **H1** |
| O21 | `@assistant-ui/core@0.3.30` `dist/runtimes/external-store/external-store-adapter.d.ts` — `onLoadEarlier` | *"the host **prepends** it to `messages`"* | validates the **H2** fix |
| O22 | same file — `activeRunId` | *"kept through `cancelRun` so its late calls can be discarded"* | **M2** — assistant-ui already ships the discard mechanism |
| O23 | same file — `canResume` / `onResume(config: ResumeRunConfig)` | A first-class resume contract TBAi does not use | **M4** |
| O24 | same file — `messageRepository` | *"swaps to it atomically whenever a different instance is passed"* | confirms TBAi's repository cache |
| O25 | `package.json` (`web/` and root) | `@opencode/client` is pinned at **2.0.32**; `docs/decisions.md` still says 2.0.16 / 2.0.24 (quoted, not line-numbered — that file is being edited concurrently) | doc drift (§3.4.8) |
| O26 | `src-tauri/tauri.conf.json:10` | `frontendDist: "app://localhost"` — the packaged app's real origin; the CORS allow-list's `http://app.localhost` has a different scheme | **D12**, G1 |
| O27 | `src-tauri/tauri.conf.json:8`, `web/vite.config.ts` (no `server.port`), `web/package.json` `dev` script | `devUrl: "http://localhost:3000"` vs Vite's implicit default 5173 | **D12**, G2 |
| O28 | `src/services/opencode/configDocument.ts:370-396` (the edit path) vs `packages/core/src/permission.ts` (upstream) | exact-equality `findIndex` vs upstream `findLast` + wildcard | **H3**, D14 |

---

## 14. Appendix E — upstream OpenCode source citation index

Source: `sst/opencode@dev` (redirects to `anomalyco/opencode`), fetched read-only. This is the **authoritative** statement of V2 runtime semantics — ahead of the published prose, which describes V1 in several places (§3.4.1).

| Ref | File | Detail | Bears on |
|---|---|---|---|
| U1 | `packages/core/src/permission.ts` — `evaluate()` | `rulesets.flat().findLast(rule => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {action, resource:"*", effect:"ask"}` | **H3**, **D14** — last-match-wins |
| U2 | `packages/core/src/util/wildcard.ts` — `match()` | `*` to `.*`, `?` to `.`, `\` to `/`, case-insensitive on Windows, a trailing `" .*"` optional | **H3** — the matching TBAi must implement |
| U3 | `packages/schema/src/permission.ts` | `Rule = {action: string; resource: string; effect: "allow"\|"deny"\|"ask"}`; `Ruleset = Array<Rule>` | TBAi's `openCodePermissionRuleSchema` is **correct** for V2 |
| U4 | `packages/core/src/v1/config/permission.ts` | The V1 object form lives under `src/v1/`; its own comment says *"Permission rules are last-match-wins, so the order an author writes keys in is policy."* | The v1 shape is **V1-scoped**; the V2 schema still accepts legacy entries, so **nothing may be removed** without verification (D14) |
| U5 | `packages/core/src/permission.ts` — `configured()` | `merge(agent?.permissions ?? missingAgentPermissions, session.permissions ?? [])` — agent rules first, session rules after | With `findLast`, a session-level rule outranks an agent-level one |
| U6 | `packages/core/src/permission.ts` — `evaluateInput()` | `denied()` is evaluated over agent+session rules **first**; `savedRules()` (the "always" grants) are appended **last** and are always `effect: "allow"` | Confirms TBAi's "always" handling: a saved allow is appended last and wins, but an explicit `deny` still wins over it |
| U7 | `packages/core/src/database/migration/20260910120000_clear_v1_session_permission.ts` | An upstream V1 to V2 migration exists for session permissions | Confirms the V1 to V2 cutover is real and one-way |
| U8 | `packages/core/src/permission.ts` — `close()` | On shutdown, every pending request is failed with `DeclinedError` and a `Permission.Event.Replied` is published | The server settles pending permissions on close — relevant to the controller's disposal path |
| U9 | `packages/cli/src/env.ts:7-13` | `Config.Redacted("OPENCODE_PASSWORD").pipe(Config.orElse(() => Config.Redacted("OPENCODE_SERVER_PASSWORD")))` — the comment reads *"The legacy name is still honored."* | **Withdraws L6.** TBAi's precedence matches upstream exactly; the published prose (`docs/server.md:34`) is the V1-era surface and must not be used as the authority |
| U10 | `packages/cli/src/services/standalone.ts:23-24` | `env: { OPENCODE_PASSWORD: password }` with the comment *"OPENCODE_PASSWORD cannot shadow the child's lease credential."* | Confirms both names are still meaningful upstream — TBAi's "send both" behaviour is V2-required |
| U11 | locally installed managed binary | `D:\Coding\OpenCode\opencode.exe --version` → **`opencode v2.0.32`**, matching the pinned `@opencode/client@2.0.32` | Closes the version-drift part of G6 (the CLI and the client are the same version; the binary was **not** started) |
| U12 | `packages/server/src/location.ts:71-79` — `requestRef()` | `const directory = query.get("location[directory]") \|\| (request.headers["x-opencode-directory"] ? decode(request.headers["x-opencode-directory"]) : process.cwd())` | **Decisive for D11.** The location of **every** upstream request comes from the caller's query param or header — so the header is a **capability input**, and the proxy must not forward it |
| U13 | `packages/server/src/handlers/event.ts` | `/api/event` is `feed.subscribe` under the request's location — the **directory-scoped** stream. The heartbeat is `Stream.tick("15 seconds")` → `": heartbeat\n\n"` | `/api/event` is **not** global (the global one is the separate `/global/event` route) — it must be authorized like any other location-scoped route. The 15 s comment heartbeat also **confirms P10** upstream |
| U14 | the pinned client's route surface | `/api/agent`, `/api/model`, `/api/model/default`, `/api/provider`, `/api/command` all carry `query: { location: input["location"] }`; only `/api/info` does not | Class A is effectively `/api/info` alone. The five catalogue routes are **Class B**, not global |

**Residual uncertainty (G3):** U1–U8 are read from source at `dev`, not from the exact build the installed CLI runs, and **no live evaluation was performed** (doing so would have required writing a real configuration file). The algorithm is settled; the runtime confirmation is a **shipping gate** for the H3 fix, not for the plan.

---

## 15. Readiness verdict

### 15.1 Ready for maintainer approval — with its limitations stated

**Phase 0 is approved, delivered and committed** (`f4d93c1`); see the progress ledger in §0.1 and the outcome record in §5.1.1. **The rest of the programme is ready for approval, unit by unit.** The next approval is **§5.2.A1** (the proxy route allowlist), which is deliberately separable: it changes the security posture on its own, it has its own tests and its own rollback, and it waits on no evidence gap.

**The limitations travel with the approval.** This plan is **not** fully verified, and the following were not established:

| Not verified | Consequence for the approval |
|---|---|
| **G3** — the live permission behaviour of the running server (the *override display* only; the *write* path's row-identity change does not depend on it) | The read-only override indicator is **held** until it closes; nothing else is |
| **G1**, **G2** — the packaged app's real origin, and whether the webview enforces CORS for `app://` | **A3 (the CORS narrowing) is held** until they close. They do **not** block A1, A2, B, C or D. **Until A3 ships, M8's cross-origin *read* half stays open** — a page on an arbitrary localhost origin can still open the allowlisted event stream and read a workspace transcript. A1 and A2 close the *execute* half and the arbitrary-path half regardless. |
| **G4**, **G5** - `bun run verify` in full, and the Playwright suites | **G4 is CLOSED by Phase 0** (`bun run verify` is green). **G5 is PARTIALLY closed**: the Playwright suite is a separate CI job, green on `3351f81`, but it was not re-run locally (no `playwright` on PATH, no browser binaries). No phase may claim a **delta** against a suite that was not run. |
| **G7** — the policy for a pre-existing exact-duplicate rule | The config page's duplicate-row behaviour (5.2.C) is held; the rest of Unit C, and Units A1, A2, A3, B and D, are not |
| Any **live** OpenCode evaluation, prompt, session, or configuration write | Every finding is source-confirmed or runtime-verified against the **real controller**, but none was exercised against a live OpenCode server |

**What *is* verified**, and carries the weight of this plan: the 15 deterministic tests driving the real controller from outside the repository; the upstream V2 permission semantics read from `sst/opencode@dev`; the pinned client's real route surface; the published JSON Schema; a byte-for-byte reproduction of the CORS middleware, including the preflight; and — since Phase 0 — **the repository's own full gate suite, green end to end** (`bun run verify` exit 0, 4329 pass / 43 skip / 9 todo / 0 fail), with the 9 R-tests demonstrably failing on demand against the current code.

**What this verdict is, and is not.** It says the *architecture and the phase plan* are ready to be approved and started, and that **Phase 0 has been approved, delivered and verified**. It says **nothing about whether the proposed fixes work** — **not one of them has been implemented, and none has been exercised.** The evidence establishes that the *defects are real*; it establishes nothing about the *remedies*, because the remedies do not exist yet. Every fix remains an untested hypothesis until its phase lands its R-test and that test passes. **Phase 0 is the one thing that has been implemented, and it is the verification apparatus, not a remedy.**

**Why ready despite the gaps.** The gaps are **evidence gaps with named closures and owning phases**, not open questions. Every finding has a reproduced failure mechanism; every one of the eighteen decisions has a reasoned recommendation (§9.2); every phase carries fail-before/pass-after tests (§5.10), a risk, a rollback, and an explicit "must not change" list.

### 15.2 What is held, and on what

| Held item | Held on |
|---|---|
| The **H3 override indicator** (the read-only "this rule is overridden" display) may not ship | **G3** — a live server must confirm the resolution. The **write** path's row-identity change does **not** depend on G3 and is not held. |
| The **config page's behaviour for a pre-existing exact-duplicate rule** | **G7** — a maintainer policy choice (refuse, warn, or edit normally) |
| The **exact CORS allow-list entries** | **G1**, **G2** — the packaged app's real origin and the dev origin must be confirmed by running the build |
| Any **phase completion claim** | **G4**, **G5** — the full-suite and Playwright baselines were not run during the audit and must exist before a delta is claimed |

### 15.3 What this plan does **not** claim

- It does not claim the OpenCode subsystem is broadly unsound. The session bootstrap, the managed-server lifecycle, capability discovery, the permission auto-approve policy, the event reducer's identity and durable-sequence handling, the disposal contract, and the configuration **write** path's structural preservation guarantee are all sound on the evidence inspected. The defects concentrate in the hydration/reconnect path and the capability boundary — **and that concentration is itself the architectural finding.**
- It does not claim a green suite is evidence for any path it does not exercise. The OpenCode-scoped suites were green throughout the audit while **twenty-nine** defects were real. That is why §5.10 exists, and why no phase may be marked complete on the basis of existing tests.
- It does not claim the **final code sweep** (§2.3) found everything. The sweep read the files and reasoned; it did not execute them, and it was the *second* read of code the audit had already covered. Every item it produced was re-verified before admission, and two were **rejected** — which is the point of verifying a sweep rather than importing it. The sweep's own clean files are recorded so they are not re-read; nothing in it is evidence until it is reproduced.
- It does not claim the V1 configuration entries are dead. They are V1-scoped upstream, but the current V2 schema still accepts them, and their status must be verified before anything is removed (D14, U4).
- It does not claim the permission *evaluation* is TBAi's business. TBAi does not evaluate permissions; OpenCode does. TBAi's obligation is to edit the row the user selected and to display override status read-only (D14).

### 15.4 The shape of the programme in one paragraph

**One Critical capability boundary, fixed first and on its own diff** (§5.2.A1, §5.2.A2). **One behaviour-preserving extraction**, so the lifecycle has an owner that can be expressed in code rather than in convention (§5.3). **One attempt-locality rule**, which removes M1, M2 and L4 as a class (§5.4). **One precedence rule for snapshots and live events**, which removes H2 and M5 at once (§5.5). **One settlement policy for every wait**, which removes M3 and M7 (§5.6). **One review unit per concern**, so no security change is reviewed as part of an unrelated one (§5.2.0) — and **one unit (A3) deliberately sequenced last**, because it is the only one an evidence gap blocks, and holding it must not delay the ones that are not. Everything else is bookkeeping — bounded state, truthful termination, a status chip that tells the truth, and documentation that matches the code.

**The objective is a runtime whose correctness follows from ownership and explicit invariants — not an accumulation of patches that satisfy the current tests.**

---

**End of plan. No implementation has been started, and this document authorizes none.**