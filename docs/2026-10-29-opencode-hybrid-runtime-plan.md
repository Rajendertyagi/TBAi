# TBAi OpenCode Hybrid Runtime — Implementation Plan (revision 22, Windows scope)

**Status:** revised proposal for review. **Nothing implemented.** No source, test, config,
dependency, lockfile, or documentation file changes accompany this document beyond the document
itself.

**Date:** 2026-10-31 · **Baseline commit:** `b440e207d1e748e1220f462ceb460a02a1bf9d7a`
(branch `ci/tauri-e2e-verify`) — the designated review baseline. The working tree's `HEAD` while
this revision was written is `f4110fb`, one commit later. That commit touches no backend OpenCode,
config, route or packaging path this plan cites as code evidence; it does touch
`web/src/features/opencode/v2MessageProjection.ts`, a directory the plan names as an extension
surface (§10.2) but from which it cites no line-level evidence. §16.3 records the exact footprint.

**Platform scope:** Windows packaging and CI targets are **VERIFIED (code/config)**:
`tauri.conf.json` targets only `nsis` (Windows installer); CI build matrix (`tauri-build.yml`)
runs only on `windows-latest` with `x86_64-pc-windows-msvc` target. Whether the product
officially supports only Windows at runtime is **INFERRED** from these targets — no explicit
product-support decision document was found. The plan assumes Windows-only scope but labels this
assumption as inferred, not verified.

**Verdict: NOT APPROVED FOR IMPLEMENTATION** — unresolved owner decisions (B1, H3/B3, H5/B2, B7,
H4, and the newly assigned D1–D4) and unresolved technical/evidence blockers (B8 request-context
security invariant, E1 reader/writer evidence gap, **B5 legacy `OPENCODE_DB` evidence gap**,
**G4 unvalidated config-write path**, and the Windows symlink residual labelled UNKNOWN in §2.4).
See §13 (including the blocker-ID crosswalk in §13.4) and §16.1.

---

## 0. Evidence standard used in this document

Every critical claim carries one label:

| Label | Meaning |
|---|---|
| **VERIFIED (code)** | Read from this repository or from `node_modules` on disk during this revision. Line references are to the working tree at the baseline commit. |
| **VERIFIED (probe R4)** | Produced by a command **run during revision 4**, in a disposable temp root, against a process this agent started and stopped itself. |
| **VERIFIED (probe R5)** | Produced by a command **run during revision 5**, in a disposable temp root, against loopback stubs and temp files this agent created and removed itself. |
| **VERIFIED (probe R6)** | Produced by a command **run during revision 6**, in a disposable temp root, against files this agent created and removed itself. |
| **VERIFIED (probe R7)** | Produced by a command **run during revision 7**, in a disposable temp root, against files this agent created and removed itself. |
| **VERIFIED (probe R19)** | Produced by a command **run during revision 19**, in a disposable temp directory under the OS temp root, against files this agent created and removed itself. It measures runtime API surface and path-function behaviour only: it starts no OpenCode process, reads no registration file or database, and touches no credential. |
| **VERIFIED (probe R20)** | Produced by a command **run during revision 20**, in a disposable temp directory under the OS temp root that the script created and removed. It measures file-identity discrimination (`dev`/`ino` for two distinct files, a hard link to one of them, a deterministic path substitution between `lstat` and open, and a no-substitution control) and `FileHandle.write` return and offset behaviour. It starts no OpenCode process, reads no registration file or database, and touches no credential. |
| **VERIFIED (probe R21)** | Produced by a command **run during revision 21**, in a disposable temp directory under the OS temp root that the script created and removed. It measures Windows replace-rename semantics only — replacement of an existing destination, the destination's identity after replacement, rename while a read handle on the destination is open, rename onto a read-only destination, rename from a subdirectory on the same volume, exclusive-create refusal, directory open/sync availability, and a partial temp file left uncommitted. It starts no OpenCode process, reads no registration file or database, touches no credential, and creates no file outside its own temp directory. |
| **VERIFIED (probe R22)** | Produced by a command **run during revision 22**, in a disposable temp directory under the OS temp root that the script created and removed. It measures only: hard-link creation into an absent destination (identity, link count, unlink of the temp), hard-link refusal (`EEXIST`) onto an existing destination, the same refusal when a destination is created after an absence was observed, replacement of a directory entry by `rename` after a substitution, the exported `fs` surface for link/rename/replace, Windows security-descriptor inspection through `icacls` and PowerShell `Get-Acl` (inherited versus explicit ACEs), hard-link shared SDDL, and directory `sync()`. It starts no OpenCode process, reads no registration file or database, touches no credential, and creates no file outside its own temp directory; the only ACL modification was `/inheritance:d` on one disposable file it created. |
| **REPORTED (probe R2/R3)** | Produced during revision 2 or 3 of this plan in this same session and **not rerun**. Treated as reported evidence, never as independently verified. |
| **INFERRED** | Follows from code or from a measured fact but was not measured itself. |
| **UNKNOWN** | Not established. Where it matters, the plan states the conservative behavior it adopts instead of guessing. |

### 0.1 Revision 22 change log against revision 21

Every entry below describes a change that is **in this saved file**. Nothing here is implemented and
**no test was run** to produce it. One capability probe **was** run — `VERIFIED (probe R22)`, §0 — in
a disposable temp directory that the script created and removed. It measured Windows hard-link and
rename behaviour and Windows security-descriptor inspection only; the label is disclosed wherever it
is used and is not evidence about OpenCode. Each entry repairs a mechanism revision 21 specified in
an order its own promises could not hold, or a gap its own text was the only evidence for.

| # | Change | Section |
|---|---|---|
| 1 | **A managed start is reserved, published and waited on before anything can spawn.** Revision 21 registered a waiter by calling `ensureBaseUrl()` and *then* taking or creating a binding and adding the record. That order cannot hold: an async function's synchronous prefix runs before its caller receives the promise, so if `start()` ever reaches `createChild()` before its first `await` the child exists before any binding or waiter does. (Today the first await is `databaseLease.acquire`, so the window is narrow — but the protocol must not depend on that line surviving a refactor.) Acquisition is now `acquireManagedStart(attempt \| null)`: one synchronous block allocates a unique `startId`, creates the deferred, **publishes** it in `this.startReservation` (and `this.readyPromise` as the same object), registers every caller's waiter, and only then schedules `runManagedStart(rec)` as a microtask. Spawn attribution is one synchronous block at `createChild()`'s return: `liveChildren.add`, `childStartId.set`, `rec.child`, `this.child`, `this.port`. A settled cached start is deliverable only while its child is live and has no published stop; otherwise it is withdrawn and a fresh start is created. A failed or superseded start cannot evict or detach a newer one: every mutation is identity-guarded. An execution trace E1–E9 covers first caller, second caller, spawn, supersession, success, failure and shutdown, and **AT15** asserts the binding and waiter records at the spawn injection point. | §3.4, §3.4.1, §3.5 (AT12(c), AT13, AT14, AT15) |
| 2 | **Start failure has one owner and one settlement order.** Revision 21 said `start()`'s failure path "is eligible because that start is over", while its own conditions said an unsettled start and an unreleased waiter refuse cleanup — and the failure handler ran *inside* `start()`, before its promise had settled and before any awaiting attempt's `catch` could release. `settleStart(rec, outcome)` is now the single settlement point: mark settled; on failure release **every** waiter for that `startId` synchronously and remove its abort listener; withdraw the reservation and detach the pointers by identity if it is still current; retry pending obligations; request cleanup once as `{kind:"start-failure", startId}`; deliver `resolve`/`reject` **last**. Attempts never request cleanup for a failed start they cannot receive a child from. A rejected start is therefore cleaned without contradicting a waiter, multiple attempts awaiting it all see `released === true` and a published stop when their `catch` runs, a start with no remaining waiters is retired at settlement, and shutdown joins the stop the protocol already published. **AT14** asserts the settlement and release order itself, not a final count. | §3.2, §3.4, §3.4.1, §3.5 (AT14), §12.5 |
| 3 | **The G4 commit is conditional by operation, not by a check before a by-name rename.** Revision 21 re-read the destination's identity with `lstat` and then called `rename`, which replaces **whatever** occupies the name: a competing process that substitutes a file after the check is replaced by the commit, and one that creates a destination after an initial `ENOENT` is likewise replaced. Probe R22 measured exactly that — after a substitution the rename installed the temp and the substituted file did not survive — and measured that no exported Node/Bun API offers an identity-conditional or no-replace rename (`fs.replaceFile` and `fs.renameat2` are `undefined`; `ReplaceFileW`, which restores the replaced file's metadata, is not exported and is itself by-name). The commit is now an **atomic create-only hard link** — `fs.promises.link(tempPath, validated)` — used **only** when the destination was observed absent; `CreateHardLinkW` refuses an existing name, measured as `EEXIST` on an existing destination and on a destination created after an observed absence, with the invader's bytes intact and `nlink`/`ino` shared after success. A destination that was present at validation is **refused** (`replace_unverified`) and no rename is attempted, so the check-to-rename race exists only for the case the guard does not commit. The guard gains a deterministic `beforeCommit` test hook between the last validation and the commit, tests for creation-after-`ENOENT`, for a substituted existing destination, and a no-substitution control. **G4 remains BLOCKED**; adopted-mode writes stay disabled. | §9.3 step 7, §11 (CT8), §12.3, §12.6, §13.3 |
| 4 | **The ACL and replacement-failure contract is specified, and one sentence is corrected.** Revision 21 required refusal when a destination carries explicit ACEs without saying how the descriptor is read, and asserted that both a permitted and a refused rename preserve the old document. A successful commit installs the new document; only a refused one leaves the previous one. The contract now states, for the only committable case (destination absent): there is no prior security descriptor to preserve; the temp is created by TBAi with no explicit ACEs and inherits the directory's ACEs; the descriptor is read as **SDDL** through PowerShell `Get-Acl` and an ACE is inherited iff its flag field carries `ID`; `icacls`'s `(I)` marker is a cross-check only, because its text is locale-dependent. Probe R22 measured three inherited ACEs on a new file (flags `ID`,`ID`,`ID`), zero after `/inheritance:d` (flags empty; `icacls` `(I)` count 3 → 0), and that a hard-linked destination carries the **identical** SDDL as the temp because it is one object. An inspection failure, or any non-`ID` ACE, refuses the write (`acl_unverifiable` / `acl_explicit_unexpected`). A present destination is not touched and its descriptor is not read. Cross-process handles no longer affect a committed write: a competing creator is converted to an `EEXIST` refusal, and no open destination is replaced. Directory `sync()` remains `EPERM`, so crash durability is still not claimed. | §9.3 step 7, §11 (CT8), §12.3, §12.6 |
| 5 | **Cleanup has one coordinator, one condition table and a future owner for every refusal.** Revision 21 had `requestChildCleanup()` evaluate eligibility and `stopChild()` evaluate it again, and a refusal under "the start is still unsettled" could leave the child alive because every path assumed another would clean it up. `requestChildCleanup(child, cause)` is now the **only** coordinator: lookup-first join; a single condition table (C1 waiter, C2 start, C3 target, with shutdown the only path that skips C1/C2); the withdrawal and publication are one synchronous block; publication is the six-step deferred that revision 21 established. A C2 refusal records a **pending obligation** retried at four named triggers — last-waiter release, start settlement, target installation/clear, shutdown — so a refused request always has a future owner or is deleted when the owner is shutdown/fallback. `onExit` uses `childStops.has(child)` as the authority not to restart a child the manager stopped. Shutdown enumerates `liveChildren` synchronously, including children whose current-child pointer was detached. **AT12** and **AT13** are updated to assert intermediate state and ordering. | §3.2, §3.4, §3.4.1, §3.5 (AT12, AT13), §12.5 |
| 6 | **Counts, the consistency sweep and the citation result are re-derived from the saved file.** The matrix grows from 81 to **83** proposals (AT14 and AT15 added; AT12, AT13 and CT8 changed in content, not count; nothing removed or weakened); findings 83–88 record this revision; §15 gains revision 22; §0's logs are renumbered because revision 22 inserts a new log ahead of revision 21's, and every internal reference to a renumbered log is updated; §12, §13 and §16 are rewritten where the mechanisms changed. The citation-resolution row is now **partial**, not a pass: the exact occurrence and distinct-range counts, the resolved counts, the ambiguous ranges checked by hand, the unresolved upstream citations and the one out-of-range quotation are all retained, with the reason each remains unresolved. | §0, §11, §12, §13, §14, §15, §16 |
| 7 | **Governance and evidence constraints are preserved, and one owner question is added because the design created it.** Baseline, branch, B1, H3/B3, H5/B2, B7, H4 and D1–D4 stay open; B8, B5, E1, G4 and UNKNOWN-1 stay separate blockers; B5 stays separate from E1; no 2.1.x artifact or digest is invented; the composite package/executable identity and the service-image PID rule for LB7 are unchanged; every existing probe label and revision attribution is retained; no test is reported as passing; no correction is reported as implementation; and adopted-mode writes stay disabled until G4 is implemented, measured and reviewed. The new question is **D5**: whether the owner accepts the residual check-to-rename window for *replacing an existing* destination, or funds a native conditional-replacement mechanism. Until D5 is answered, the guard refuses that case. | §13.1, §13.3, §16.1, §16.2 |

**What revision 22 deliberately preserved from revision 21.** Manager-level ownership of a managed
child; the `Subprocess` object as identity and `this.child` as a publication pointer only; the
live-child registry populated at spawn; one memoised stop per child with the promise published before
anything is signalled; the six-step stop construction and the extracted escalation with a second
bounded wait; lookup-before-eligibility; the shared shutdown completion published before `abort()`
and settling by resolution only; the deferral/withdrawal split for condition 2; the identity-guarded
detach of `this.child`/`this.port`/`this.readyAtMs`; the attempt guard's five conditions; the two-read
`beginAttempt()`; deep freezing; the single Basic-auth constructor; G4's absolute-path policy, Windows
form refusals and junction refusal; the transactional temp write with the complete-write loop; the
composite build identity; the service-image PID rule; B5 independent of E1; D4 open with its refusal
a **proposed default**; UNKNOWN-1 still UNKNOWN; and the §13.4 crosswalk. No revision-21 improvement
is removed: the waiter registry, the withdrawal block and the stop publication order are retained and
given one owner each.

### 0.2 Revision 21 change log against revision 20

Every entry below describes a change that is **in this saved file**. Nothing here is implemented and
**no test was run** to produce it. One capability probe **was** run — `VERIFIED (probe R21)`, §0 — in a
disposable temp directory that the script created and removed. It measured Windows replace-rename
behaviour only; the label is disclosed wherever it is used and is not evidence about OpenCode. Each
entry repairs a statement revision 20 made but could not support, or a gap it left where its own text
was the only evidence.

| # | Change | Section |
|---|---|---|
| 1 | **`stopChild()` has one construction, and it publishes before it runs anything.** Revision 20 permitted two shapes and called them equivalent: `new Promise((resolve) => resolve(invokeStopSafely()))` and `Promise.resolve().then(() => invokeStopSafely())`. The first is incompatible with the same section's `WeakMap` publication order, because a Promise executor runs **synchronously inside the constructor**, before the constructor's caller can store the promise — so the stop is invoked before the entry exists, and a synchronous callback inside that invocation that re-entered `stopChild(child)` would find nothing and start a second escalation. The executor alternative is removed. One deferred is created by an executor that does nothing but capture `resolve`, the promise is published in the `WeakMap`, and only then is the operation scheduled as a microtask, where a throw raised before the operation returns is caught and a returned promise's rejection is observed. RC16 fails against the executor pattern, and gains a third injection point: a caller entering after shutdown has already published the child's stop. | §1.9.3.2, §3.4, §1.9.7 (RC15, RC16), §1.9.8, §12.5, §12.7 |
| 2 | **Joining an existing stop is not an eligibility question.** Revision 20 listed "no other path has already claimed it" as the **fourth** condition on whether a cleanup request may start a stop, and in the same section said a later request **joins** the published promise. The two rules disagree for exactly the caller the earlier conditions exist to protect: a request arriving after shutdown has published a stop is ineligible by condition 4 and must still be joined rather than refused. The request algorithm is now ordered and single-valued: look the stop up first and return that identical promise if it exists, whatever the requester; only when none exists evaluate initiation eligibility; a refusal is logged and touches nothing. Condition 4 is gone, replaced by the lookup. AT12(a) and (b) and RC16 assert that a post-shutdown request joins with **zero** further process calls. | §1.9.3.2, §3.4, §3.5 (AT3, AT12, AT13), §1.9.7 (RC16), §1.9.8, §12.5 |
| 3 | **The manager's waiter state is named, owned, and given update rules.** Revision 20 made cleanup eligibility depend on "no active attempt holds a waiter", and never said where a waiter is recorded, who writes it, or when it is removed — so the condition could not be evaluated, and AT12(c) described a state (`no caller can still receive the child`) that the single cached `ensureBaseUrl()` promise makes unreachable while that promise is still handable. §3.4 now specifies a registry keyed by the shared start, attributed to a child at `spawn()`, registered synchronously when an attempt joins a start and released by that attempt's abort signal and by its own completion; a start still in flight refuses cleanup; and the decision that stops an uninstalled child **evicts the cached start binding for that child** and **detaches the current-child pointer by identity** in the same synchronous block, before the stop is published, so no later `ensureBaseUrl()` can hand out a child that is about to be signalled and the stop's exit cannot re-enter the unexpected-exit auto-restart path. AT12(c) establishes the eviction, the detach and the consequent fresh spawn before it claims eligibility; AT13 asserts that an active newer attempt's waiter prevents the stale attempt's stop. | §3.2, §3.4, §3.5 (AT12(c), AT13), §12.5 |
| 4 | **The G4 write is committed by replacement, not by rewriting the destination.** Revision 20 wrote in place (`open` the destination, complete-write loop, `truncate`, `sync`). A partial write followed by zero progress or a rejection therefore leaves the destination **modified**, while CT8 required the previous document to be unchanged; the two statements cannot both be true, and the guarantee was the false one. The write now goes to a sibling temp file created exclusively in the validated directory, and the only mutation of the destination is a replace-rename at a defined **commit point**. A failure before the commit preserves the destination by construction; a failure at the commit preserves it as well, because the rename did not happen. The R21 probe measured what that costs: `rename` over an existing destination **fails `EPERM` while a read handle opened by the same process is on it** (a handle held by a *different* process is unmeasured), fails on a read-only destination, and leaves the destination untouched in both cases; a directory `sync()` is unavailable (`EPERM`), so no directory-durability claim is made; and the replacement's ACL is unmeasured, so no preservation is claimed. CT8 gains deterministic pre-commit and commit failure sequences, each re-reading the destination. | §9.2, §9.3, §11 (CT8), §12.3, §12.6 |
| 5 | **A build row is a package-and-member tuple, not an executable digest.** §2.9.2 said one row per artifact and then keyed the row on the executable digest "because that is what runs". Two different packages can ship byte-identical executables, and one package can ship several members; both cases would collapse into one row. The row identity is now the **four-part** tuple of §2.9.2 — reported version; package artifact **name and SHA-256**; extracted executable **path and SHA-256**; extraction provenance — with a separately stated rule for a bare executable that has no package. No digest is invented for the historical R4 observation. | §2.9.1, §2.9.1.1, §2.9.2, §2.9.4 (LB1), §11, §13.2, §16.2 |
| 6 | **The primary process identity is the service image, not whatever the launcher started.** §2.9.1 called the launcher's created process "the service" and recorded its PID as primary. A `.cmd` shim, an `npm` wrapper, `Start-Process`, `powershell -Command`, or a shell pipeline makes that PID an intermediate: the trace would attribute the database event to a launcher, or find no event at all, and a registration `pid` naming the real service would read as a mismatch. The procedure now resolves the **service image process** through a recorded parent/child chain, records every link's PID, parent, start time, image path and image hash, uses the service image PID for event attribution and for the start time, and treats a registration `pid` that names a launcher as a **finding**, not a pass. Missing registration remains a valid observation. | §2.9.1, §2.9.1.1, §2.9.4 (LB1, LB2, LB3, LB6, LB7), §12.2, §13.2 |
| 7 | **§16.3's byte count was measured on a normalised copy.** Revision 20 reported 3,630 lines and 356,760 bytes, while the review copy of the same text was reported at 360,390 bytes — exactly 3,630 more, one byte per line. The working-tree file is **LF** (`git ls-files --eol` says `i/lf w/lf`, and the file contains zero `CR` bytes) and `core.autocrlf` is `true`, so a CRLF rendering of the same content produces exactly that delta. The distinction is now stated wherever the count is reported, and the copy's byte count is not presented as the file's. | §16.3 |

**What revision 21 deliberately preserved from revision 20.** Manager-level ownership of a managed
child and the live-child registry; one memoised stop per child, published before anything is
signalled; the shared shutdown completion published before `abort()` and settling by resolution only;
the bound on a non-settling stop; the two-read `beginAttempt()`; the attempt guard's five conditions;
the rule that ordinary transitions never revoke a captured context; deep freezing at every level; the
single Basic-auth constructor; G4's absolute-path policy, junction refusal and `dev`/`ino`
identity-substitution test; the OS-observed primary identity as the LB7 attribution — now resolved to the
service image through the recorded process tree (change 6), which narrows it rather than removing it — and
`registration absent` as a recordable outcome; the package/executable digest split; B5 kept separate
from E1 with no 2.1.x artifact named; D4 open with its refusal a **proposed default**; UNKNOWN-1 still
UNKNOWN; and the §13.4 crosswalk. No revision-20 improvement is removed: the four eligibility
conditions become three, and the removed one becomes a lookup that is stronger, not weaker.

### 0.3 Revision 20 change log against revision 19

Every entry below describes a change that is **in this saved file**. Nothing here is implemented and
**no test was run** to produce it. One capability probe **was** run — `VERIFIED (probe R20)`, §0 — in a
disposable temp directory that the script created and removed. It measured file-identity discrimination
and the write API; the label is disclosed wherever it is used and is not evidence about OpenCode.
Each entry repairs a statement revision 19 made but could not support, or a gap it left where its own
text was the only evidence.

| # | Change | Section |
|---|---|---|
| 1 | **A managed child's life no longer depends on which attempt awaited it.** Revision 19 said in §3.2 that a superseded managed attempt "still has to clean up its own child" and that a newer attempt "may already own a different child", and AT12(c) asserted exactly that — attempt A's child X stopped once, the newer attempt's child Y stopped zero times. Those statements cannot hold beside §3.2's own sentence that managed starts are serialised through the single in-flight `ensureBaseUrl()` promise: two attempts awaiting that promise receive **the same** `Subprocess` (`serverManager.ts:309-326`, `:375-376`), so "A's child" and "B's child" can be one object, and a stale attempt's rejection must not stop a child a valid attempt is still waiting on. The lifecycle is now defined at the **manager**, not at the attempt: the manager owns a spawned child from the tick of `spawn()`; attempts are consumers; a stale attempt may request cleanup only under four stated conditions, the decisive one being that no live attempt or unpublished waiter still needs the child; shutdown joins the stop of every child it owns. §3.2, §3.4, §1.5.1 row 8, §12.5 and §1.9.8's sixth criterion are rewritten to that model, AT12 is rewritten for a shared child, and **AT13** asserts the shared case directly. | §3.2, §3.4, §3.5 (AT3, AT12, AT13), §1.5.1, §1.9.8, §12.5, §12.7, §10.1, §11 |
| 2 | **`stopChild()` publishes its promise before it touches the process.** The `WeakMap` memoisation said only that the first caller "performs the escalation"; it did not say when the promise is stored, so a re-entrant caller entering during stop initiation could still start a second signal or escalation. The ordering is now mandatory and stated: check the map; return an existing promise; otherwise construct the promise and **publish it in the map**; only then begin the signal/escalation sequence; resolve the published promise with the documented result. §1.9.3.2's sentence "joining **never starts** a stop" conflated two different operations and is replaced: `stopChild()`'s *first* call starts the stop and later calls join it, while the aggregate `Promise.allSettled` in step 4 only waits for promises that already exist. **RC16** injects a synchronous re-entry into the first stop initiation and asserts one promise, one sequence, one set of process calls. | §1.9.3.2, §3.4, §1.9.7 (RC16), §1.9.8, §10.1, §11, §12.5, §12.7 |
| 3 | **The synchronous-throw boundary is named, not assumed.** Revision 19 wrote the handler as `Promise.resolve(invokeStopSafely()).then(onResolved, onRejected)` and claimed this covered a synchronous throw. It does not cover a throw raised while **evaluating that argument** — the expression is evaluated before `Promise.resolve` runs, so such a throw escapes the handler, rejects nothing, and never reaches the typed result. The operation is now invoked **inside** a promise callback (`new Promise(resolve => resolve(invokeStopSafely()))`, or an explicit `try/catch` returning a rejected promise), so evaluation happens after the promise exists. The three documented outcomes are unchanged, no path rejects the shared completion, and RC14–RC16 assert the three failure shapes. | §1.9.3.2, §1.9.7 (RC14–RC16), §1.9.8, §12.5, §16.2 |
| 4 | **The G4 write is complete, not merely attempted.** §9.3 specified one `FileHandle.write()` call and then `truncate()`. `write()` returns `bytesWritten` and the contract never required the guard to check it, so a short write would have been followed by truncation to the full payload length — producing a file that is the right length and wrong content, reported as a successful configuration update. The write step is now a **complete-write loop**: an explicit offset, a write of the remaining buffer at that offset, advancement by the returned `bytesWritten`, refusal on zero progress or an error, truncation **only after** every byte has been written, then `sync()` and `close()` on the same validated handle. No second path-based open and no `Bun.write` return. CT8 gains a deterministic injected short-write case. | §9.3, §11 (CT8), §12.3, §14.1 |
| 5 | **The `dev`/`ino` evidence now shows discrimination and substitution.** The R19 probe established only that `lstat` and `fstat` agree on one file, which is equally consistent with a constant identity. The R20 probe measured **two distinct files** (different `ino`, same `dev`), a hard link to one of them (identical pair), a **deterministic substitution** performed between the `lstat` and the open (the comparison then differs, and size differs with it), and a no-substitution control (identical). §9.3 step 6 and CT8 now require both the distinguishing case and the substitution case, and the guard's refusal is asserted on the mismatch. This does **not** close UNKNOWN-1, does not close the reparse-point race, and does not claim a Windows filesystem cannot behave differently where the identity pair is coarse; if a measured filesystem cannot discriminate, G4 stays blocked. | §9.3, §11 (CT8), §12.4, §12.6, §16.2 |
| 6 | **LB7 is possible for a build that writes no registration.** §2.9.1 required the traced PID to equal the `pid` in a registration record "written by **this** run" — but B5 exists precisely to measure builds that may not write one, so the requirement made the missing-registration case unrecordable and LB4 untestable against the evidence standard. The primary identity is now an **OS-observed process identity**: the PID and start time of the process the tester's launcher actually started, taken from the launcher's process handle rather than from a file the service may never write. The registration record is still read and its `pid` compared when it exists; when it does not, the record states "registration absent" and keeps the OS-observed identity for the Procmon attribution. A missing registration no longer makes the database-file observation impossible. LB2, LB3, LB4, LB6, LB7 and §2.9.1.1 are updated. The process filter and the attribution checks are not weakened — a mismatch is a finding, not a pass — and a path-only filter remains forbidden. | §2.9.1, §2.9.1.1, §2.9.4 (LB2–LB4, LB6, LB7), §12.2, §13.2 |
| 7 | **The package digest and the executable digest are different fields.** §2.9.1 listed "package artifact name; artifact digest" and then required the running image to hash to "the artifact digest" — an equality between an installer or archive and a file extracted from it, which cannot hold and does not describe the artifact the run used. The build-identity field now states that the measured artifact is either the executable image itself or a package containing it: for an image, the image digest **is** the build digest; for a package, the record carries the package digest **and** the extracted executable digest, the extraction step and the package member path, and **no equality between those two digests is required**. Proves the image the PID runs is the extracted image, and the extracted image came from the recorded package. The evidence table, the three identity checks, the Procmon correlation fields, LB1, and §11's exact-build rule are updated. No digest was invented for the historical R4 observation. | §2.9.1, §2.9.1.1, §2.9.2, §2.9.4 (LB1), §11, §12.2, §13.2 |
| 8 | **`beginAttempt()`'s reading is described as what it does.** Revision 19's docstring said it "reads ONE connection-state snapshot" and its table justified step 1 with "one read; two reads could straddle a shutdown", while step 6 re-read the latch and the step list shows it. The docstring, the table row and the "one snapshot, one slot" bullet now name **two** reads and their different jobs: the **creation snapshot** (step 1), whose `shutdownEpoch` is the only one an attempt ever carries; and the **revalidation snapshot** (step 6), which decides whether a re-entrant callback killed the attempt or began shutdown after the fact. The epoch still comes from the creation snapshot, and a dead attempt is still thrown rather than returned. | §1.9.3.3, §3.1, §3.2, §12.5 |
| 9 | **Counts, findings, history and the verification record were re-derived from the saved file.** The matrix grows from 79 to **81** proposals (AT13 and RC16 added; AT12 and CT8 changed in content, not in count; nothing removed or weakened); findings 69–75 record this revision's corrections; §15 gains revision 20; §16.3 is a check of this file. | §10.1, §11, §14.1, §15, §16 |

**What revision 20 deliberately preserved from revision 19.** `beginAttempt()` as the single
constructor of an attempt and the single epoch source per attempt; the terminal `shutdownStarted` latch
as the authority alongside the `shutdownEpoch` revocation counter; the shared completion published
*before* `abort()`; the rule that ordinary transitions never revoke a captured context; deep freezing
at every level; the single Basic-auth constructor and the `Request`+`init` header handling; the byte
cap on the bytes actually read and the stated `JSON.parse` limitation; G4 as a required gate with
adopted-mode writes disabled and its absolute-path policy; B5 kept separate from E1 with real-build
evidence required and no 2.1.x artifact named; D4 open, with its refusal a **proposed default**;
UNKNOWN-1 still UNKNOWN; the §2.9.1.1 capture procedure; the corrected B1 direction and the §13.4
crosswalk. Nothing in this revision removes a revision-19 improvement.

### 0.4 Revision 19 change log against revision 18, retained as history

Every entry below describes a change that was **in the saved revision-19 file**. It is the log of the
text this revision inherited, not a description of the current text: entry 1's "one snapshot" is
corrected to two reads by §0.3 item 8, and entry 4's `Promise.resolve(invokeStopSafely())` handler
expression is corrected by §0.3 item 3 and removed entirely by §0.2 item 1. Nothing in it was
implemented, and
**no test was run** to produce it. Two capability probes **were** run — `VERIFIED (probe R19)`, §0 —
both in disposable temp directories, the second consolidating and re-checking the facts the first
measured. They examined the Bun file API and `path.win32` behaviour; the `VERIFIED (probe R19)` label
is disclosed wherever it is used and is not evidence about OpenCode. Each entry repairs a statement
revision 18 made but could not support, or a gap it left where its own text was the only evidence.

| # | Change | Section |
|---|---|---|
| 1 | **Attempt creation registers, supersedes, and refuses to hand back a dead attempt.** Revision 18's `beginAttempt()` read one snapshot, refused on the latch, and returned a frozen record — it never recorded the attempt as current and never aborted the one it replaced, so §3.1's supersede rule and `isAttemptActive` condition 1 had no writer. It is now a six-step synchronous operation: read one snapshot; refuse on `shutdownStarted`; allocate the id and build the record; register it as current and take the previous attempt in the same step; abort the previous attempt at most once; then re-read both the current id and the latch, because `abort()` dispatches listeners synchronously and a listener may have created a newer attempt or begun shutdown. In those two cases it **throws** — `OpenCodeAttemptSupersededError` or `OpenCodeNotReadyError` — rather than returning an attempt that is already dead. The registration read and the probe transport check `isAttemptActive` before their first I/O, so a superseded attempt cannot start work merely because its caller still holds it. AT11 asserts the re-entrant case. | §1.9.3.3, §1.9.5, §3.1, §3.2, §3.5, §10.1, §11 |
| 2 | **AT10(c) and TT3 are constructible, or they are not claimed.** Revision 18 asked for a discovery transport "constructed with the current post-shutdown epoch". The production API cannot do that: `createDiscoveryProbeTransport()` takes an attempt, `beginAttempt()` is the only constructor of one, and it refuses after shutdown — so no caller can obtain a post-shutdown epoch through it. The production API is unchanged and gains **no** caller-supplied epoch. The claim is now tested through a **declared test-only state-reader seam** in `connectionState.ts`, which §1.9.5 specifies together with the production invariant the test asserts and the source scan that keeps the seam out of production modules. | §1.9.5, §3.5 (AT10(c)), §11 (TT3, TT6), §16.3 |
| 3 | **Exactly one cleanup per managed child.** Revision 18 said a superseded managed attempt "still has to clean up its own child" (§3.2) and that managed shutdown starts "the managed child's `shutdown()`" (§1.9.3.2) without saying which child either refers to. A published child, a spawned-but-unpublished child, a rejected completion, and a fallback start racing shutdown could therefore each reach a different stop, or the same stop twice. §3.4 now gives every child two things: an identity (the `Subprocess` object, with a live-child registry populated synchronously at `spawn()`) and **one memoised shared stop per child**. Shutdown joins the published child's stop *and* every live unpublished child's stop; a rejected completion awaits **its own** child's shared stop instead of starting one. AT12 asserts the four cases and counts stop invocations per child. | §1.9.3.2, §3.2, §3.4, §3.5, §6.5, §10.1, §11 |
| 4 | **Shutdown completion covers asynchronous rejection, and "settles" has a mechanism.** Revision 18 handled a **synchronous** throw from the child stop and was silent about a returned promise that *rejects*; that rejection would both settle the shared promise by rejection and (if nothing else observed it) surface as an unhandled rejection. §1.9.3.2 now attaches a two-argument handler, resolves the shared promise as `{ok:false, error}` on either failure mode, and never rejects it. "Always settles" is made mechanical rather than assumed: the per-child stop is bounded by a named two-phase escalation, and a stop that cannot confirm termination resolves as a typed `termination_unconfirmed` failure instead of hanging. RC15 asserts the asynchronous case, no unhandled rejection, and caller identity of the shared promise. | §1.9.3.2, §6.5, §1.9.7 (RC15), §1.9.8, §10.1, §11, §12.5, §12.6, §16.2 |
| 5 | **G4's absolute-path policy is stated, and its write API is measured.** Revision 18 computed `relative = path.relative(root, path.resolve(root, document.path))` and then refused when "the relative path … is absolute", which never fires for an absolute input inside the root: `path.relative` rewrites it to a relative path (measured, probe R19). The policy is now explicit — an absolute input **inside** the root is normalised and **permitted**, an absolute input **outside** it is **refused** — and the two refusal rules keep their distinct jobs (`..` prefix for a same-drive escape, absolute result for a cross-drive one). Drive-relative paths, `\\?\` prefixes, UNC targets, alternate data streams and trailing dots each get an explicit rule, because the probe showed the generic containment check accepting an ADS path, and a drive-relative path whose one-argument `path.resolve` lands outside the root while its two-argument form lands inside it. The validated-handle write now names `fs.promises.open` + `FileHandle` and states why `truncate()` is required. | §9.3, §11 (CT5, CT8), §12.3, §12.4, §14.1, §16.3 |
| 6 | **LB7's capture has a procedure.** Revision 18 required "a process-level event" and named Procmon as one possible source without prescribing a filter, a window, an operation set, an export format or a retention rule, so two testers could produce records that do not mean the same thing while both looking compliant. §2.9.1.1 prescribes one mandatory method: a process-name filter recorded **before** launch (a PID cannot be filtered before the PID exists), PID attribution **after** launch, path filters forbidden for attribution, `CreateFile` with `SUCCESS` and a recorded disposition, a named export field list, a hashed trace retained outside the repository, and a reviewer check of the three equalities. It states what the trace establishes and what it does not. | §2.9.1, §2.9.1.1, §2.9.4, §12.2, §13.2, §16.3 |
| 7 | **The 2.2.0 observation left the digest-keyed matrix.** §2.9.2 keys every row on artifact digest, and its 2.2.0 row had none — so the one "measured" row could not satisfy the rule the table imposes on every other row while still appearing to satisfy it. It is moved out of the table into a **historical probe record** that keeps its original R4 label and states explicitly that it does not satisfy the build-identity rule, is not a B5 row, and says nothing about `OPENCODE_DB` or database-path compatibility. `2.0.15` remains an unmeasured placeholder, and no 2.1.x artifact is named. | §2.9.2, §12.2, §14.1, §16.3 |
| 8 | **Counts, findings, history and the verification record were re-derived from the saved file.** The matrix grows from 76 to **79** proposals (RC15, AT11 and AT12 added; nothing removed or weakened); findings 62–68 record this revision's corrections; §15 gains revision 19; §16.3 is a check of this file. | §10.1, §11, §14.1, §15, §16 |

**What revision 19 deliberately preserved from revision 18.** `beginAttempt()` as the single
constructor of an attempt and the creation-time snapshot as an attempt's only epoch source; the
terminal `shutdownStarted` latch as
the authority alongside the `shutdownEpoch` revocation counter; the shared completion published
*before* `abort()`; the rule that ordinary transitions never revoke a captured context; deep freezing
at every level; the single Basic-auth constructor and the `Request`+`init` header handling; the
byte cap on the bytes actually read and the stated `JSON.parse` limitation; G4 as a required gate
with adopted-mode writes disabled; B5 kept separate from E1 with real-build evidence required and no
2.1.x artifact named; D4 open, with its refusal a **proposed default**; UNKNOWN-1 still UNKNOWN; the
corrected B1 direction and the §13.4 crosswalk. Nothing in this revision removes a revision-18
improvement.

### 0.5 Revision 18 change log against revision 17, retained as history

Every entry below describes a change that was **in the saved revision-18 file**. It is the log of
the text this revision inherited, not a description of the current totals: its entry 6 states the
matrix as 76, which revisions 19 and 20 raise to **81**. Nothing in it was implemented, and no test or
probe was run to produce it.

| # | Change | Section |
|---|---|---|
| 1 | **Discovery can start again, and cannot start after shutdown.** Revision 17 said every start path captures a request context first, but capture refuses while the target is `unresolved` — which is exactly the state in which initial discovery runs — and the discovery transport only compared epochs, so a transport built after shutdown could be handed the current epoch and pass. A separate synchronous `beginAttempt()` now owns attempt creation: it reads **one** connection-state snapshot, refuses when `shutdownStarted` is true, and otherwise creates the attempt with its own `attemptId` and that snapshot's `shutdownEpoch` without requiring a request target. The discovery transport is built from the attempt (never from a caller-supplied epoch) and refuses when `shutdownStarted` is true, when the epoch moved, or when the attempt is superseded. AT10 asserts it. | §1.9.2.1, §1.9.3.3, §1.9.4, §1.9.5, §1.9.6, §1.9.7, §1.9.8, §3.1–§3.2, §3.5, §10.1, §11 |
| 2 | **The re-entrant shutdown window is closed.** Revision 17 ordered the first `beginShutdown()` as: publish terminal state → abort the active attempt → start child shutdown → store the completion promise. `AbortController.abort()` dispatches listeners synchronously, so a listener could call `beginShutdown()` again before the completion promise existed. The shared completion is now published **before** the abort or any external callback; every later or re-entrant caller returns that same promise; the child stop is invoked exactly once; and a synchronous throw from it settles the promise instead of leaving it pending. RC14 asserts it in both modes; RC13 remains the sequential/concurrent caller test. | §1.9.3.2, §1.9.7, §1.9.8, §3.1, §12.5, §16.2 |
| 3 | **The evidence matrix no longer contains a range row.** Revision 17's §2.9.2 carried a literal `2.1.x` row while its own prose said `2.1.x` is a range and the revision-17 log claimed no such row existed. The row is removed; the statement that no 2.1.x artifact has been named or measured lives **outside** the table; `2.0.15` stays as an explicitly unmeasured placeholder; each measured 2.1.x artifact gets its own row keyed on version string, artifact and digest. The revision-17 log entry is corrected rather than left contradicting the file. | §2.9.1, §2.9.2, §12.2, §13.2, §14.1, §16.3 |
| 4 | **Database evidence must come from the running process.** "Observed on disk" could be satisfied by a pre-existing file the service never opened. §2.9.1 now requires a **process-level file-activity observation tied to the service's own PID** — PID matched to the registration record, the process's start time, and the image path hashed against the artifact digest — with the operation, timestamp, verbatim `OPENCODE_DB`, working directory, `debug paths db` output and TBAi's ownership resolution recorded separately and compared after Windows canonicalization. LB7 covers unset, absolute and relative configurations; LB2, LB3 and LB6 now require the same evidence. B5 stays blocking. | §2.9.1–§2.9.4, §10.1, §11, §12.2, §13.2, §14.1, §16 |
| 5 | **The declined-B1 alternative is described by the call it would make.** Revision 17 grouped `discover()`, `ensure()` and `stop()` when listing side effects. The plan now names the surface under consideration (Promise `discover()` or Effect `discover()`), states what that call actually does at the installed version — a plain `readFile` + `JSON.parse` with no schema validation, then a probe `GET /api/info` to the **registered** URL carrying the **registered** password — and lists `ensure()`'s and `stop()`'s effects separately rather than attributing them to `discover()`. Whether the alternative would call `ensure()` or `stop()` is a separate design choice, not a property of `discover()`. B1 is still not decided. | §2.10, §4.3, §13.1, §13.4, §14.1 |
| 6 | **Counts, findings, history and the verification record were re-derived from the saved file.** The test matrix grows from 73 to **76** proposals (AT10, RC14 and LB7 added; nothing removed or weakened); findings 57–61 record this revision's corrections; §15 gains revision 18; §16.3 is a check of this file, not of a draft. | §10.1, §11, §14.1, §15, §16 |

**What revision 18 deliberately preserved from revision 17.** Deep defensive copying and runtime
freezing of every level (§1.9.3.1); the four separate values `revision`, `shutdownEpoch`,
`shutdownStarted` and `attemptId`; idempotent shutdown for sequential and concurrent callers; the
rule that ordinary transitions never revoke a captured context; the single Basic-auth constructor and
the `Request`+`init` header handling; the corrected B1 direction and the restored historic blocker
meanings with the §13.4 crosswalk; D4 open, with its refusal a **proposed default**; the byte cap on
the bytes actually read and the stated `JSON.parse` limitation; UNKNOWN-1 still UNKNOWN; B5 kept
separate from E1 with real-build evidence required; relative `OPENCODE_DB` covered; G4 a required
gate with adopted-mode writes disabled; `latest`/`beta`/`next` sharing `service.json`; the 2,000 ms
client probe default; the qualified temp-file-plus-rename reading; Windows packaging VERIFIED with
product scope INFERRED; R2/R3 REPORTED and R4–R7 historical. Nothing in this revision removes a
revision-17 improvement.

### 0.6 Revision 17 change log against revision 16, retained as history

Every entry below describes a change that was **in the saved revision-17 file**. Nothing in it was
implemented, and no test or probe was run to produce it. Entry 6 is corrected here: revision 17
claimed §2.9.2 had no `2.1.x` row and had in fact left a placeholder row behind, which revision 18
removed.

| # | Change | Section |
|---|---|---|
| 1 | **The B1 condition is no longer reversed.** Revision 16 said an approved B1 meant "call `discover()` and wrap it", which is the opposite of what B1 asks. B1 is approval to **depart from** the official lifecycle path and use the custom reader: approval lets the reader proceed; refusal makes the official lifecycle route the *alternative to be evaluated*, with its missing deadline, missing schema validation and spawn/stop side effects accepted first; while open, neither route is approved. Approval never implies `discover()`. | §2.10, §4.3, §13.1, §13.4, §14.1, §16.2 |
| 2 | **The connection state and the credential are deeply immutable.** Revision 16 froze only the outer context and exposed `target.credential` by reference to the caller and to the transport, so a retained caller reference could change the password after install. Installation now copies into owner-controlled objects, every level is frozen at runtime, no caller-owned reference is retained, capture exposes that same frozen credential and the transport binding retains the same instance. RC12 asserts it. | §1.9.2, §1.9.3, §1.9.3.1, §1.9.4, §1.9.7, §1.9.8 |
| 3 | **`beginShutdown()` is idempotent.** Revision 16 said the epoch moves exactly once but described an unconditional replacement, so a second or concurrent call moved it again. A terminal `shutdownStarted` latch is set in the same replacement that first moves the epoch; later calls perform no replacement, do not reject, and await the same child-stop completion. Install, clear and capture refuse on the latch. RC13 asserts it. | §1.9.2.1, §1.9.3, §1.9.3.2, §1.9.6, §1.9.7, §1.9.8, §3.1–§3.4, §12, §16 |
| 4 | **The size cap applies to the bytes actually read.** The reader opens once, `fstat`s that handle, reads incrementally to `registrationFileMaxBytes + 1`, refuses an oversized result, parses only that handle's bytes, and closes the handle in a `finally` on every path. The plan states that `AbortSignal` cannot interrupt `JSON.parse` or shape validation, that the cap is what bounds them, and that an over-budget result is refused by an elapsed-time check after parsing. The required runtime surface is labelled **INFERRED**, with an explicit "requirement unmet, raise it" clause instead of a substitute API. UNKNOWN-1 is unchanged and explicitly not closed by any of this. | §2.4, §2.4.1, §2.8 (BT13–BT16), §12.4, §16 |
| 5 | **D4 is labelled, not resolved.** The missing-password refusal is a **PROPOSED PENDING D4** default; supporting a password-less service would need a separately reviewed authentication design and must never fall back to TBAi's managed password or an empty Basic credential. The rule, the transition table, A1/A2 and BT6 now say so instead of reading as a decided product rule. | §1.3, §1.5, §1.5.1, §1.6, §2.3, §2.8, §4.3, §13.1, §16.2 |
| 6 | **Legacy coverage was extended, but the matrix still carried a placeholder row.** Evidence records require a build identity (version **and** artifact digest), and LB6 records a **relative** `OPENCODE_DB`: the exact working directory, the value as given, the database file actually opened, the `debug paths db` output, and whether TBAi's ownership check resolves to the same file — recorded as observed, never as what a build "should" do. Revision 17 stated that §2.9.2 had no `2.1.x` row and left one in the table; revision 18 removes it and records that no 2.1.x artifact has been named or measured. B5 remained and remains blocking, and shim-only evidence still cannot close it. | §2.9.1–§2.9.4, §10.1, §11, §13.2, §14.1, §16 |
| 7 | **Counts, findings, history and the verification record were re-derived from the saved file.** The test matrix grew from 66 to **73** proposals (RC12, RC13, BT13–BT16, LB6 added; nothing removed); findings 49–56 record that revision's corrections; §15 gained revision 17; §16.3 was a check of that file, not of a draft. | §10.1, §11, §14.1, §15, §16 |

**What revision 17 deliberately preserved from revision 16.** The separate `revision` /
`shutdownEpoch` / `attemptId` roles; the rule that ordinary transitions never revoke a captured
context; the single shutdown policy in both modes; the `Request` + `init` header merge; the single
Basic-auth constructor; the restored historical meanings of B1, H3/B3, H5/B2, B7 and B5 with the
§13.4 crosswalk; B5 kept separate from E1; G4 as a required gate with adopted-mode writes disabled;
`latest`/`beta`/`next` sharing `service.json`; the client's 2,000 ms probe default; the qualified
temp-file-plus-rename reading; Windows packaging VERIFIED with product scope INFERRED; R2/R3
REPORTED and R4–R7 historical. Nothing in revision 17 removed a revision-16 improvement.

**Revision 16 change log against revision 15, retained as history.** It describes the file
revision 17 inherited, not the current state where the seven entries above supersede it.

| # | Change | Section |
|---|---|---|
| 1 | **The B8 generation contradiction is repaired.** Revision 15 used one number for two incompatible jobs: it incremented on ordinary transitions (adoption, fallback, rotation) *and* was the transport's shutdown gate, while RC1 required a captured context to survive an ordinary transition. Revision 16 defines **two separate values** — a `revision` (ordinary; diagnostics only; never consulted by the transport) and a `shutdownEpoch` (increments only when shutdown begins; the sole initiation gate as revision 16 stated it — revision 18 checks the `shutdownStarted` latch at that same gate, §1.9.4 step 2). §1.9.4 lists the mechanism and a seven-row proof of the required properties. | §1.9.2–§1.9.8 |
| 2 | **One shutdown policy.** Revision 15 contradicted itself: §1.5 said managed shutdown left managed state "usable", while §1.9.6 revoked the context and failed new captures. Revision 16 adopts revocation for **both** modes and applies it to §1.5, §1.9.6, §3.2, §3.4, §12, §16, distinguishing managed shutdown, adopted shutdown, in-flight requests, captured-but-not-sent requests, and new captures. | §1.5, §1.9.6, §3.2, §3.4, §12, §16 |
| 3 | **The historical blocker IDs are restored and a crosswalk is added.** Revision 15 had silently reassigned B1, H3/B3, H5/B2, B7, and B5 to different questions. Revision 16 restores their original meanings and assigns **new** IDs (D1–D4, E1) to the displaced questions, with an explicit crosswalk. H1 is folded into H5/B2 and H2 into H3/B3 rather than left as overlapping duplicates. | §4.3, §13, §13.4 |
| 4 | **The legacy database evidence requirement is restored as B5.** A distinct requirement now covers OpenCode **2.0.15–2.1.x** (`OPENCODE_DB` behaviour and database-path compatibility), separate from 2.2.0 registration-writer verification. The 2.2.0 work is reassigned to **E1** and explicitly does **not** close B5. | §2.9, §13.2 |
| 5 | **A lifecycle API boundary is stated (B1).** The custom registration reader does not call the official lifecycle `discover()`, `ensure()`, or `stop()` unless the owner approves that departure. Normal generated API SDK calls are explicitly **not** restricted — the departure is about lifecycle only. | §2.10 |
| 6 | **Credential construction has one owner.** Revision 15 wrote the `base64("opencode:" + password)` formula into the transport contract while A12 claimed construction existed only in `runtime.ts`. The transport now calls the single pure `buildOpenCodeBasicAuthHeader()`; the formula is removed from the contract; a source-scan test asserts the single-constructor invariant. | §1.9.4, §1.8.3, §1.6 (A12), §11 |
| 7 | **The transport is specified for `Request` inputs, not only URL inputs.** Effective headers are the `Request`'s own headers overlaid by `init.headers`, so directory scope and content type survive, caller `Authorization` is removed from either source, method and body are preserved, and redirects are still refused. TT5 and TT6 cover it. | §1.9.4, §11 |
| 8 | **"Fallback (any failure)" is replaced by a ten-case outcome table** stating, per case, whether the previous target is preserved, cleared, or replaced, whether a managed process starts, and whether the adopted process receives a signal. Cases whose outcome depends on an open owner decision say so. | §1.5.1 |
| 9 | **Concrete limits and real cancellation replace "bounded".** A maximum registration-file size, a named read/parse deadline, a discovery-probe deadline, and a revalidation interval are specified, with `AbortSignal`-based cancellation of the read, abort of a superseded probe, and the attempt guard as the install authority. Their relationship to the 30,000 ms managed readiness budget and the client's 2,000 ms probe default is stated without describing either as a client option. | §2.4, §2.6, §3.1, §6.5 |
| 10 | **The config-write gap is classified honestly.** Path validation is now a **required implementation gate** (G4) with a precise root-resolution rule, traversal and symlink handling, and negative tests; and configuration/permission **writes to adopted services are disabled** until that guard is implemented and reviewed. The `0o600` writer argument is stated not to prove the effective Windows ACL. H4 is kept as the separate authorization question and is stated not to resolve path safety. | §9.3, §9.4, §2.4, §2.5 |
| 11 | **Every proposed test group now names a proposed file.** Ten proposed test files (§10.1) are listed with their owner and marked not created or changed, including a separate config path-guard suite (CT5, CT8) and an environment-gated legacy-database evidence suite. The test matrix grows from 55 to 66 proposals — RC11, AT9, CT7–CT8, TT5–TT6, and LB1–LB5 are added; nothing previously proposed was removed. | §10, §11 |
| 12 | **Verdict, register, history, and verification record updated** to describe this saved Revision 16 file, including the blocker crosswalk and the new G4 gate. | §13, §14, §15, §16 |

**Revision 15 change log, retained as history.** It is not a description of the current file. Its
entries described §1.9, §2, and §§3–16 as authored for revision 15; revisions 16 and 17 supersede
those claims where they conflict with the logs above, and the revision-history table (§15) records
all three.

### 0.7 What this revision does **not** do

It does not decide B1, H3/B3, H5/B2, B7, H4, or any of D1–D4 (including D4, whose proposed default
is only labelled as such in §1.3), and does not treat the recommendation in §4 as an approval. It
does not decide B5, E1, B8, G4, or UNKNOWN-1.
It does not implement anything and does not claim that any earlier probe was rerun when it was not
(R2/R3 remain reported).
It does not contact, restart, stop, signal, or otherwise interfere with the user's real OpenCode
service, and does not read, print, reproduce, or log any provider API key, service password,
authorization header, or encoded credential.
It **did** run one capability probe in this revision (§0, `VERIFIED (probe R21)`), in its own
disposable temp directory, and what it measured is stated where it is used. The probes of earlier
revisions (`VERIFIED (probe R20)`, `VERIFIED (probe R19)`, R4–R7) were **not** rerun here and keep
their original labels. The probes together still do not measure everything the plan needs:
cancellation of a read pending on a handle, Windows handle-closure behaviour during an in-flight read,
the reparse-point race of UNKNOWN-1, an effective Windows ACL, whether a handle held by **another**
process affects the commit (R21 measured a same-process handle refusing a rename; R22 measured `link`
onto an existing name failing `EEXIST` but held no open destination handle), whether the commit is
atomic for a concurrent reader, or any behaviour of a reparse point
other than a directory junction are all still **unmeasured**. Nor does any probe show that a *short*
`write()` occurs on this runtime — R20 observed full-length writes only, which is why the
complete-write loop is specified as a guard against a case this environment did not produce.
It does not measure a legacy build, and it does not name a 2.1.x artifact (§2.9.2).
It does not run a process-level file trace: §2.9.1.1 specifies one, and LB7 is a proposal.

**Revision 21 is a document revision only.** The blocking items it repairs were repaired **on
paper**. Repairing a contradiction in a plan is not the same as satisfying its acceptance criteria:
the waiter registry and the eviction rule of §3.4, the publish-before-schedule construction of
`stopChild()`, the join-before-eligibility order, the commit-by-replacement write of §9.3, the
composite build identity of §2.9.2, the service-image attribution of §2.9.1.1, RC15, RC16, AT12, AT13
and the extended CT8 are specifications and proposed tests, not passing ones. B8, B5, E1 and G4 remain
open until the code and the measurements exist. This revision makes no claim beyond internal
consistency plus the source, label and probe checks recorded in §16.3.

---

## 1. Review item 1 — the missing-password path (blocking)

### 1.1 Why `null` was not a cosmetic bug

Three facts, each **VERIFIED (code)**, compose into a credential-disclosure path:

1. `getOpenCodeAuthPassword()` lazily **generates** a password (`randomBytes(32)`,
   `runtime.ts:144-159`) and `getOpenCodeAuthHeaders()` **always** returns a Basic header
   (`runtime.ts:171-177`). There is no code path that returns `{}` today.
2. Every request path obtains its header from that one function: the proxy and the permission
   writer through `configServerTarget()` (`routes/opencode.ts:216-225`), and the native client at
   construction (`client.ts:51-66`) from **eight** production call sites (`capabilities.ts:107,247`,
   `commands.ts:43`, `orphanReconciler.ts:798`, `sessions.ts:462,736,1154,1196` — **VERIFIED (code)**).
3. Revision 3 allowed an adopted mode whose stored password was `null`, expecting "no header".

Composed, the sequence is: adoption succeeds against a service that answered without a credential
→ the adopted origin becomes the base URL → the next proxied request calls
`getOpenCodeAuthHeaders()` → the `null` adopted value falls through to the managed password →
**TBAi's own generated Basic credential is sent to a process the user started outside TBAi.** That
is a leak to a third-party origin, not a 401.

### 1.2 Is an unauthenticated adopted mode needed? Recommendation: no — D4 stays open

**VERIFIED (probe R4)**, on a self-started `opencode serve --service` in a temp root:

```
first={"keys":["id","password","pid","url","version"],"version":"2.2.0","url":"http://127.0.0.1:42075","pid":5492,"hasPassword":true,"pidIsInteger":true}
api_info={"status":200,"bodyPid":5492,"bodyVersion":"2.2.0","pidEquals":true}
api_info_without_auth_status=401
```

In that probe, the registered service wrote a `password` into its registration and **rejected an
unauthenticated `/api/info` with 401**. That is one measured instance, not a universal guarantee; the
plan's conservative rule (§1.3) treats a registration without a non-empty password as unusable, which
is the same conclusion the measurement points to. An unauthenticated adopted mode would be useless
against the very service this feature exists to adopt, so it is removed rather than kept as an
option.

**PROPOSED PENDING D4 — this is a recommendation, not the decision.** Whether a password-less
service must be supported is owner decision **D4** (§4.3, §13.1), and it stays open. One measured 2.2.0 instance supports the
recommendation; it does not answer a product question about every version the gate admits, and it
does not authorise a fallback to TBAi's own credential.

### 1.3 The rule

**PROPOSED PENDING D4 — not a decided product rule.** This is the plan's conservative default, not
an owner decision (§4.3, §13.1). Supporting a service that announces no password would require a
separately reviewed authentication design; it must not be implemented by substituting TBAi's managed
password, an empty Basic credential, or an unauthenticated request.

> A registration with a missing, empty, or whitespace-only `password` is refused as
> `missing_credential` **before any network request and before any header is constructed.**
> Adoption state cannot exist without a credential — this is enforced by the type, not by a
> runtime branch.

Consequences of the refusal are the ordinary fallback: the managed path runs. Nothing is installed,
nothing is sent. If D4 is later answered in favour of password-less adoption, this section changes
with the reviewed design; until then the refusal is what any implementation of this plan must do.

### 1.4 Authentication state, as one value

`src/services/opencode/runtime.ts` is the single source of truth for the **password** (generated or
environment-supplied, §1.4/§1.9.3). The credential shape below is what removes the "`null` means two
things" defect; where the installed credential lives is settled in §1.9.3.

```ts
/** Credential shape only. Installed only after a probe succeeds. */
export type AdoptedCredential = {
  readonly origin: string;   // canonical origin, never a response field
  readonly password: string; // non-empty by construction
};

export function buildOpenCodeBasicAuthHeader(
  password: string,                       // non-empty; no null overload exists
  config: OpenCodeConfig = OPENCODE_CONFIG,
): Record<string, string>;

export function installAdoptedCredential(credential: AdoptedCredential): void;
export function clearAdoptedCredential(): void;
export function getOpenCodeAuthScope(): string | null;   // adopted origin, else null
export function getOpenCodeAuthHeaders(config?: OpenCodeConfig): Record<string, string>;
```

**Superseded in part by §1.9.3.** The credential object below is still the shape of the secret, and
the `null`-elimination argument still holds. What §1.9.3 changes is **where the value is owned**: the
mode, target, origin, and credential move into one connection state owned by
`connectionState.ts`; `runtime.ts` keeps only password generation (and
`buildOpenCodeBasicAuthHeader` stays the one Basic-header constructor). The functions
`installAdoptedCredential` / `clearAdoptedCredential` / `getOpenCodeAuthScope` are replaced by
`installAdoptedTarget` / `clearTarget` / the capture operation, and the construction-time scope check
is replaced by a **per-request** origin check inside the transport (§1.9.4) — checking once when a
client is constructed cannot cover a client that outlives the transition.

- `buildOpenCodeBasicAuthHeader` is **pure** and takes a `string`. There is no `null` parameter and
  no overload that yields `{}`; an empty string throws `OpenCodeCredentialError` (TypeScript cannot
  constrain JSON, so the guard stays, but no caller reaches it because §1.3 refuses first).
- The installed value is one object assigned in one statement, so there is never a moment with a
  password installed and no origin, or an origin with no password. In the final design the whole
  connection state is that one object (§1.9.3), which covers mode, `revision`, and `shutdownEpoch`
  as well.
- In the final design the credential is read **only** through
  `captureOpenCodeRequestContext()`; a direct call to a global header getter at a call site would
  reintroduce the split §1.9 removes. `getOpenCodeAuthHeaders()` remains for the managed readiness
  probe and for tests, not as a second source of truth for proxied requests.
- The origin is enforced on **every** request by the bounded transport (§1.9.4), not once at client
  construction. Acceptance test A10 (scope enforcement) is therefore satisfied by RC8, and its
  construction-time form is not a separate mechanism the final design relies on.

### 1.5 The complete transition trace

| Stage | State (`target` / mode) | Which credential is sent | Failure behavior |
|---|---|---|---|
| Process start | absent / `unresolved` | managed (generated or env) | — |
| Discovery: read + validate | absent | **none yet** — no header constructed | any refusal → absent, unchanged |
| Discovery: candidate probe | absent (header built from the argument, not from state) | the **candidate** password, to the candidate origin only | 401 → `unauthorized`; absent, unchanged |
| Adoption success | `{origin, credential}` installed, mode `adopted` | adopted | — |
| First proxied request | `adopted` | adopted, to the captured origin only | a request to any other origin throws `OpenCodeOriginMismatchError` |
| Fallback (confirmed `lost`, or explicit rejection) | absent | managed, exactly as before — but only if a managed start is the chosen outcome | the pre-call header deep-equals the post-call header; the managed start depends on open decision **D3** (§1.5.1) |
| Revalidation, same password | re-installed after a successful probe | adopted | failure keeps the previous object |
| Revalidation, rotated password | replaced after a successful probe | the new one | failure keeps the **old** one (still valid if the service is merely slow) |
| Shutdown, adopted | cleared; target becomes `unresolved`; `revision` **+1**; `shutdownEpoch` **+1**, first call only | **no new request may be initiated**; a response already on the wire may complete | the adopted process receives **no signal** — TBAi never owned it |
| Shutdown, managed | target becomes `unresolved`; `revision` **+1**; `shutdownEpoch` **+1**, first call only | **no new request may be initiated**; a response already on the wire may complete | the managed child is stopped through the shared per-child stop of §3.4 |

A repeated or concurrent shutdown performs no replacement at all (§1.9.3.2), so these two rows
describe the first call and no later call can move either counter.

**Shutdown policy — one rule, used here, in §1.9.6, §3.2, §3.4, §12, and §16.** After shutdown
begins, no request may be *initiated*, in either mode. A request that was already sent may receive
its response, because bytes on the wire cannot be recalled; that is not a permission to start
another request. A fresh capture throws `OpenCodeNotReadyError` because shutdown publishes
`unresolved` and sets `shutdownStarted`. The transport enforces the initiation rule through the
**`shutdownEpoch`** (§1.9.4 step 2), not through the connection-state `revision`: the epoch changes
only on the first shutdown call, so an ordinary transition cannot revoke a captured context and a
repeated shutdown cannot revoke it twice (§1.9.3.2).

**Why managed shutdown revokes too.** Revision 15 said managed shutdown left the managed state
"unchanged and still usable" while §1.9.6 revoked the context. Those cannot both hold, and leaving
a stopped child's origin capturable would let a request be *initiated* against a process that is
already shutting down. The stricter rule is adopted in both modes. It changes no current observable
behaviour: `captureOpenCodeRequestContext()` does not exist today, so there is no caller whose
existing behaviour depends on a post-shutdown capture succeeding. §3.4 records what happens if the
managed child cannot be restarted.

#### 1.5.1 Discovery and fallback outcomes (replacing "fallback (any failure)")

Revision 15's §1.5 said "Fallback (any failure)". That is wrong in two directions: several failures
do **not** fall back (a transient revalidation failure preserves a working adopted target), and the
fallback itself has more than one outcome. The table below is the precise version. Where an outcome
depends on an open owner decision, the row says so and does not decide it.

| # | Case | Previous target | Managed process | Adopted process receives | Capture after the outcome |
|---|---|---|---|---|---|
| 1 | **No registration on initial startup** | none (`unresolved`) | **starts** — this is today's managed path (§2.1) | nothing (none found) | throws `OpenCodeNotReadyError` until the managed target is published |
| 2 | **Malformed or untrusted registration** (bad JSON, wrong shape, non-loopback URL, bad pid, unsupported version) | preserved if one was installed; otherwise `unresolved` | runs only if the state is `unresolved` and the managed path is the selected mode | **no signal** | the preserved target, or throws if `unresolved` |
| 3 | **Missing credential** (§1.3, **PROPOSED PENDING D4**) | as case 2 | as case 2 | **no signal**, and **zero requests** | as case 2 |
| 4 | **Initial probe failure** (timeout, 401, 5xx, 3xx, pid mismatch) | as case 2 | as case 2 | **no signal**, and no install | as case 2 |
| 5 | **Transient revalidation failure** (slow service, one bad poll) | **preserved** — the working adopted target stays installed | **does not start** | no signal | the preserved adopted target |
| 6 | **Confirmed `lost`** after bounded retries | **cleared** (`revision` +1; `shutdownEpoch` unchanged) | **depends on D3 (open)** — automatic managed start vs explicit user choice | **no signal**; TBAi never kills an adopted process (§3.3) | `unresolved` until a managed target is published, or throws under the "explicit choice" answer |
| 7 | **Explicit user rejection** | **cleared** (`revision` +1) | **depends on D3 (open)** | **no signal** | as case 6 |
| 8 | **Superseded attempt** | **unchanged** — the guard refuses the completion (§3.2) | a child a superseded *managed* attempt awaited is stopped **only if the request is eligible** (§3.4): it first joins any already-published stop; otherwise a child a counted waiter still holds, or whose start is still unsettled, stays alive for that attempt to publish | **no signal** | unchanged |
| 9 | **Managed-server startup failure** | stays or becomes `unresolved` (`revision` +1) | failed; no retry loop in this plan | nothing | throws `OpenCodeNotReadyError`; it does **not** silently restore a just-cleared adopted binding (§3.4) |
| 10 | **Shutdown** | `unresolved`; `revision` +1; `shutdownEpoch` **+1** (first call only; a repeat changes neither) | stopped through the shared per-child stop (§3.4) | **no signal** | throws `OpenCodeNotReadyError`; a captured-but-unsent context throws `OpenCodeContextInvalidatedError` at the transport |

Rows 6 and 7 are the only ones whose **managed-process** column depends on an owner decision; that is
exactly the question recorded as **D3** (historically **B7**, §13.4). No row installs a target from a
failed or superseded attempt, and no row sends a credential to a destination that was not the one it
was validated for.

### 1.6 Acceptance tests

| ID | Test | Assertion |
|---|---|---|
| A1 | **Missing password**, otherwise healthy stub. **PROPOSED PENDING D4** — it asserts the plan's current refusal, not a decided product rule | Outcome `missing_credential`; the stub records **zero** requests; no header is constructed (builder spy); mode `managed` |
| A2 | **Empty / whitespace password**, same D4 label | Same as A1, three fixtures (`""`, `"   "`, key absent) |
| A3 | **Wrong password → 401** | `unauthorized`; `installAdoptedTarget` spy not called; `getOpenCodeAuthHeaders()` deep-equals its pre-call value |
| A4 | **Valid password** | Stub receives `Basic base64("opencode:<registration pw>")`; `installAdoptedTarget` called exactly once; scope equals the canonical origin |
| A5 | **Every failure path preserves the prior credential** | For each of {missing, empty, 401, 500, redirect, timeout, bad body, untrusted URL, oversized, non-regular, replaced, in-place mutation, platform unsupported}: active headers deep-equal their pre-call value |
| A6 | **Subsequent authenticated requests** | After adoption, `configServerTarget()` and `createOpenCodeClient(origin)` send the adopted header; **the managed password value never appears in any request to the stub** (spy on the generated value) |
| A7 | **Revalidation, same password** | One probe, one install, header equals the registration's |
| A8 | **Revalidation, rotated password** | Probe uses the new candidate; success replaces the header; failure keeps the old one |
| A9 | **Shutdown isolation** | Adopted → shutdown → the adopted target is cleared, the managed password is unchanged (never cleared or replaced), and no adopted credential is reachable through any capture (capture throws `OpenCodeNotReadyError`, §1.9.6) |
| A10 | **Scope enforcement** | In adopted mode, `createOpenCodeClient("http://127.0.0.1:1")` throws `OpenCodeAuthScopeError` and performs no request |
| A11 | **Redaction** | Logger spy and every thrown error across A1–A10 contain neither a password nor its base64 form |
| A12 | **Ownership guard** | Source scan: base64 Basic construction for OpenCode auth exists only in `runtime.ts`; `adoption.ts` contains no `base64` and no `Buffer.from` for credentials |
| A13 | **Client created before adoption is not reused** | A client constructed in managed mode and held across an adoption transition is not reused; the next request constructs a fresh client against the adopted origin with the adopted header; the managed password never appears |

A10's construction-time form is superseded by the per-request origin check (§1.9.4); the property it
asserts is retained and re-expressed as RC8. The A-suite as a whole is **proposed**, not implemented
and not run.

### 1.7 Credential scope, end to end (re-check)

Re-evaluated against every request path mapped in §1.8. Where §1.7 and §1.9 differ, §1.9 is
authoritative: the earlier text below described a construction-time scope check and an installed
credential object; the final design moves both into one captured context and one transport (§1.9.3,
§1.9.4). This list is kept because its *credential-scope* claims still hold, and it now names the
mechanism that satisfies each one.

- **Initial probe builds a header from the candidate password without installing it.** The probe calls
  `buildOpenCodeBasicAuthHeader(candidatePassword)` and passes the result as `authHeaders` to the
  discovery probe. `installAdoptedTarget` is called only after the probe returns `ready`. A failed
  probe leaves the installed state untouched (A3, A5).
- **Credentials are associated with the canonical adopted origin.** `AdoptedCredential.origin` is
  the slash-free canonical origin produced by §8.1, never a field read from the registration's
  `url` without canonicalization. The registration's `url` is validated first; only then is the
  origin stored.
- **All later native-client requests are constrained to that origin.** The authoritative check is the
  bounded transport's **per-request** origin comparison (§1.9.4 step 1, §8.4). The construction-time
  scope assertion described in §1.4 is superseded: checking once cannot cover a client that outlives
  a transition, and acceptance test RC8 replaces A10's construction-time form.
- **The proxy and configuration utilities enforce the same destination boundary.** The proxy
  (`routes/opencode.ts`) captures a request context and uses `context.transport`; it no longer
  attaches an upstream `Authorization` header itself and never accepts a destination from the
  browser (§5.2, §1.9.4). Config reads/writes go through `configServerTarget()` → the captured
  context. There is no code path that takes a destination URL from request input and attaches a
  credential to it.
- **A redirect response is handled without following it.** See §1.8.
- **Revalidation with a rotated password.** The reattach loop (§8.2) re-runs discovery against the
  same canonical origin; on success it installs a new adopted target with the new password and a new
  `revision`, so already-captured contexts keep their own origin, credential, and `shutdownEpoch`. On
  failure the previous target remains installed (A8, §1.9.6).
- **Revalidation failure while an older credential is installed.** The old credential stays valid
  for the duration of the failure; it is cleared only on `lost` (§3.4, §1.9.6), never on a transient
  failure.
- **Shutdown clears adopted state without altering the managed credential.** `beginShutdown()`
  replaces the connection state and moves the `shutdownEpoch`; it does not touch
  `authPassword`/`authSource`/`authInitialized` in `runtime.ts`. The managed password is never
  cleared or replaced (A9, §1.9.6).
- **Managed child startup is prevented while an adopted target is installed.** The managed target is
  published only after the adopted one is cleared (§3.4); there is no second "scope is null" check,
  because the connection state itself is the single authority (§1.9.3).
- **Clients created before adoption.** A client that holds a captured context keeps that context's
  origin and credential; it cannot silently retarget, and a redirect is refused. New calls capture a
  new context. There is no long-lived client that could retain stale credentials. This is asserted
  by A6 (managed password never appears in any request after adoption), A13, and RC1.
- **Config transport is mandatory.** `readOpenCodeConfigDocument(baseUrl, headers, transport)`
  requires the transport. There is no default. A caller that omits it is a compile-time error.
  The transport comes from the captured context (`context.transport`), so the credential and origin
  are always paired by construction. See §9 and §1.8.4.

### 1.8 Redirect policy and authenticated request inventory (blocking)

Revision 4 protected only the initial `/api/info` probe. Subsequent requests were not protected.
This section maps every credential-bearing OpenCode request path and states one consistent policy.

#### 1.8.1 Audit of credential-bearing request paths

| # | Path | File:lines | Destination construction | Credential attachment | Redirect policy (proposed target) |
|---|---|---|---|---|---|
| P1 | Adoption probe (`/api/info`) | `serverManager.ts:109-135` | `` `${baseUrl}${path}` `` from canonical origin | `authHeaders` argument (candidate password) | Bounded transport (origin check + manual + 3xx → typed error) |
| P2 | Native client (all methods) | `client.ts:35-66` | `new URL(descriptor.path, baseUrl)` inside `@opencode/client` | `options.headers` (adopted or managed) | Bounded transport as `options.fetch` |
| P3 | Config read | `configDocument.ts:140-144` | `new URL("/api/config", baseUrl)` | `headers` argument | Bounded transport (required parameter) |
| P4 | Config write | `configDocument.ts:584-609` | filesystem (`Bun.write(path, …)`) | none (no HTTP) | n/a — filesystem; the target path is **not validated today** (gap in §9.3) |
| P5 | Proxy (browser → OpenCode) | `routes/opencode.ts:565-666` | `url` built from adopted/managed base URL + request path | `getOpenCodeAuthHeaders()` set onto upstream headers | **Bounded transport** (not a separate `fetch` with `redirect: "manual"`) |
| P6 | Permission writer | `routes/opencode.ts:240-259` | via `configServerTarget()` → P3/P4 | via `configServerTarget()` | fixed via P3 |
| P7 | Version preflight (`--version`) | `serverManager.ts` (binary spawn) | CLI, no HTTP | none | n/a |
| P8 | DB path probe (`debug paths db`) | `ownership.ts:124-178` | CLI, no HTTP | none | n/a |
| P9 | Healthz | `routes/server.ts:108` | `http://127.0.0.1:${port}/healthz` | none | n/a — no credential |
| P10 | Model discovery | `services/modelDiscovery.ts:43` | caller-supplied URL | caller-supplied `init` | **not an OpenCode credential path** — no `getOpenCodeAuthHeaders()`; out of scope, documented as exempt (§1.8.4) |
| P11 | MCP transport | `services/mcp/transport.ts:262` | caller-supplied URL | caller-supplied | **not an OpenCode credential path** — out of scope (§1.8.4) |

**VERIFIED (code)** for P1–P9 locations and credential attachment. P10/P11 confirmed by grep: neither imports `getOpenCodeAuthHeaders` or `runtime.ts`.

**Credential-bearing paths:** P1, P2, P3, and P5 carry OpenCode credentials. P4 is a filesystem write (no HTTP, no credential). P6 inherits from P3/P4. P7, P8, P9 carry no credentials. P10 and P11 do not attach OpenCode credentials (out of scope).

#### 1.8.2 Measured redirect behavior (probe R5)

| Measurement | Result | Label |
|---|---|---|
| `fetch(url, {redirect: "manual"})` to a server returning 302 | status `302`, `Location` readable, target receives **zero** requests | **VERIFIED (probe R5)** (p1) |
| `fetch(url)` (default) to a server returning 302 to a different origin | follows to target; target receives the request; `Authorization` header is **stripped** by Bun on the cross-origin hop | **VERIFIED (probe R5)** (p2) |
| Same-origin 307 with default fetch | follows; target receives the request **with the `Authorization` header and the POST body preserved** | **VERIFIED (probe R5)** (s1) |
| `@opencode/client` with no wrapper | follows the redirect; target receives the request; no error | **VERIFIED (probe R5)** (p4) |
| `@opencode/client` with a forcing wrapper (`redirect: "manual"` + 3xx → throw) | target receives **zero** requests; client throws `ClientError` | **VERIFIED (probe R5)** (p5) |
| The client passes a `URL` object (not a string or `Request`) to fetch | `ctor=URL` | **VERIFIED (probe R5)** (probe3) |
| Thin wrapper preserves POST body | body arrives intact | **VERIFIED (probe R5)** (s2, s3) |
| Proxy passthrough copies `Location` (no hop-by-hop removal of it) | `responseHeaders = new Headers(upstreamHeaders)` includes `Location`; hop list does not contain `location` | **VERIFIED (code)** (`routes/opencode.ts:621-630`) |

Two consequences drive the policy:

1. **Cross-origin redirects strip the credential in this Bun build, but the request still reaches the
   target** — a boundary violation even without credential forwarding, and the stripping is an
   implementation detail, not a contract.
2. **Same-origin redirects forward the credential and the body** — a 307 on an OpenCode endpoint
   would replay an authenticated POST (e.g. a config write) to a different path on the same server
   with the credential attached. Refusing only cross-origin redirects would leave this open.

Therefore the policy is **refuse all redirects**, not "refuse cross-origin redirects."

#### 1.8.3 The policy and the shared enforcement mechanism

> **Every credential-bearing OpenCode request refuses redirects.** No redirect is followed, including
> same-origin redirects. A 3xx response is treated as a failure (`redirect_refused`), never as a
> destination. No credential is attached to any destination other than the validated canonical origin,
> and the origin is checked on every outgoing request, not only when a client is constructed.

**Consistency resolution.** The proxy uses the bounded transport. It does **not**
call `fetch(url, init)` directly, does **not** set `redirect: "manual"` itself, and does **not**
attach an upstream `Authorization` header itself. On `OpenCodeRedirectRefusedError` it returns a
typed 502 (mapped through `openCodeError`) with the `Location` header removed from
`responseHeaders`. It cancels the upstream body. It does not forward the redirect. The credential is
attached by the transport, from the captured context (§1.9.4); the earlier wording that the proxy
"still sets auth headers" is superseded, because a caller-set header is exactly the override the
transport must prevent.

Implementation, through the existing OpenCode feature boundary:

1. **`src/services/opencode/http.ts`** (owner: OpenCode service, backend) exposing
   `createBoundedTransport(binding: { origin, credential, shutdownEpoch })` returning a
   `typeof globalThis.fetch`. The binding shape is the one specified in §1.9.4; this section
   describes the same mechanism and defers to §1.9 for the contract. It:
   - computes `expectedOrigin = canonicalOrigin(binding.origin)` and throws
     `OpenCodeAuthScopeError` if an adopted credential's own origin differs;
   - on every call, derives `targetOrigin` from the input (`Request.url` or the URL/string) and
     throws `OpenCodeOriginMismatchError` before sending if it differs from `expectedOrigin`;
   - refuses initiation by reading one shutdown snapshot and refusing when **either**
     `shutdownStarted` is `true` **or** `binding.shutdownEpoch` is no longer the current epoch
     (§1.9.4 step 2) — the epoch comparison alone is not the gate;
   - removes any caller `Authorization` and sets the value returned by the single
     `buildOpenCodeBasicAuthHeader(binding.credential.password)` helper (§1.9.4 step 3). It does not
     contain a base64 or header-building expression of its own;
   - calls the underlying fetch as `fetch(input, { ...init, headers, redirect: "manual" })`;
   - if the response status is 3xx, cancels the body and throws `OpenCodeRedirectRefusedError`
     (carrying only the status and a stable error code — **no raw `Location`**);
   - otherwise returns the response.
   There is no `credential === null` case in the final design. Managed mode binds a
   `kind: "managed"` credential carrying the managed password (§1.9.2), so the origin check and
   header injection are identical in both modes and a managed client cannot be redirected either.
   An earlier draft of this section allowed a null credential for managed mode; that shape is
   superseded by §1.9.2 and appears here only to record what changed.
2. **`client.ts`** passes the captured context's `transport` as `options.fetch` to `OpenCode.make`,
   instead of `globalThis.fetch`. The observer wrapper composes around it (observe first, then bound,
   or bound then observe — order documented; observation must not swallow the redirect error).
3. **`serverManager.probeOpenCodeInfo`** is routed through a bounded transport so the origin
   check and the 3xx handling are identical. The probe is a **discovery** transport built from the
   candidate's own validated data (§1.9.5), not the installed request context.
4. **`configDocument.readOpenCodeConfigDocument`** takes a `fetch`-compatible transport as a
   **required** parameter and uses it for the request. No default.
5. **The proxy** (`routes/opencode.ts:565-666`) captures a request context
   (`captureOpenCodeRequestContext()`) and uses `context.transport` for the upstream request. It
   stops building an upstream `Authorization` header and stops setting `redirect: "manual"` itself
   (§1.9.4).

#### 1.8.4 Exempt paths and why they are safe

- **P4 (config write)** is a filesystem write (`Bun.write`), not an HTTP request, so it cannot
  redirect. Its target path is supplied by the server's `/api/config` response. **Today there is no
  root or traversal check on that path** (`configDocument.ts` writes the path it was given; VERIFIED
  (code)). The residual — a malicious local server could direct a write outside its own config
  directory — is not removed by this plan's transport work, and §9.3 proposes a validation step that
  is **not implemented**. That is a design gap for the write path, separate from the credential
  problem, and it is not claimed as solved here.
- **P7, P8 (CLI probes)** spawn a local binary with an explicit argv and env; no HTTP, no
  credential. Safe by construction.
- **P9 (healthz)** carries no credential.
- **P10 (model discovery)** and **P11 (MCP transport)** do not attach OpenCode credentials
  (**VERIFIED (code)**: neither imports `getOpenCodeAuthHeaders`). They are out of scope for this
  policy; their redirect behavior is governed by their own callers and is not changed here. If a
  future change makes either attach an OpenCode credential, it must be routed through
  `createBoundedTransport` first — this is a stated invariant, not a current behavior.

#### 1.8.5 Acceptance tests (redirect)

| ID | Test | Assertion |
|---|---|---|
| R1 | **Initial-probe redirect** | Server A returns 302 to server B; B receives **zero** requests; outcome `redirect_refused` |
| R2 | **Native-client redirect** | Adopted server returns 302 to B for a subsequent authenticated API request; B receives **zero** requests; client throws `OpenCodeRedirectRefusedError` |
| R3 | **Configuration-read redirect** | Authenticated config-read path refuses a redirect; B receives **zero** requests |
| R4 | **Configuration-write redirect** | Any authenticated config-write path that performs HTTP refuses a redirect; B receives **zero** requests (the write itself is filesystem; the read that precedes it is covered by R3) |
| R5 | **Proxy redirect** | Proxy returns a typed 502, strips `Location`, cancels the upstream body; a browser-style fetch of the proxy does **not** contact B; **the proxy does not set `redirect: "manual"` itself** (source scan) |
| R6 | **Same-origin redirect** | A 307 on the same origin is also refused (credential + body would otherwise be replayed) |
| R7 | **Origin mismatch** | A request targeting a different origin is rejected **before** sending credentials (spy: zero fetch calls; zero header construction) |
| R8 | **Managed mode regression** | Existing managed requests continue to work through the established path (no redirect, no origin error) |
| R9 | **No secret disclosure** | Neither the password nor its Base64 representation appears in logs, errors, URLs, or test output across R1–R8 |
| R10 | **No raw Location in errors** | A stub's `Location` deliberately contains the candidate password and its Base64; neither value appears in the error message, serialized error details, logs, proxy response, or test output |
| R11 | **Proxy uses shared transport** | Source scan: `routes/opencode.ts` contains no `redirect:` literal; the proxy obtains its fetch function from `createBoundedTransport` (spy confirms) |
| R12 | **Config transport required** | `readOpenCodeConfigDocument` called without a transport is a compile-time error; at runtime, a missing transport throws before any request |

---

## 1.9 Request context contract (blocking design gap)

**Status: PROPOSED. Not implemented, not tested. B8 is open.**

Revision 11–14 treated `AdoptedCredential` as one atomic object, but the surrounding request path
still resolved its inputs independently: `openCodeServerManager.ensureBaseUrl()` supplied the base
URL, `getOpenCodeAuthHeaders()` supplied a header from a second call, and — in the revision 11–14
*proposal* — `createBoundedTransport(baseUrl, credential)` would have been handed a credential
separately, while the proxy and configuration path each rebuilt their own target. Checking a
transport's expected origin against *a* credential object does not prove that a separately
constructed `Authorization` header came from that credential, nor that the base URL and credential
were read from the same runtime state. **`createBoundedTransport` does not exist in the tree; it is
proposed.**

This section specifies a **proposed** single request-context contract. It is not proven safe yet.
B8 remains a blocking design gap until the contract is implemented and its acceptance tests pass.
Revision 15 replaced the independent getters but then used one counter for both ordinary state
changes and shutdown revocation; §1.9.2.1 repairs that and states the mechanism that replaces it.

### 1.9.1 Where the split is (current code, VERIFIED)

For each credential-bearing request, the following values must be captured from the **same**
runtime-state snapshot:

| Path | Base URL source | Canonical origin source | Credential/header source | Transport today | Can values be independently re-read? |
|---|---|---|---|---|---|
| P1 (probe) | `canonicalOrigin(registration.url)` | Same as base URL | `buildOpenCodeBasicAuthHeader(candidatePassword)` from candidate | Raw `fetch`, no origin binding (proposed: discovery transport from candidate data) | **Yes** — base URL and credential are separate variables; must be captured together |
| P2 (native client) | `ensureBaseUrl()` → adopted or managed origin | `canonicalOrigin(baseUrl)` | `getOpenCodeAuthHeaders()` reads `AdoptedCredential` or managed password | `OpenCode.make({fetch: globalThis.fetch})` (proposed: captured context transport) | **Yes** — base URL from manager, credential from runtime; must be captured together |
| P3 (config read) | `configServerTarget().baseUrl` → `ensureBaseUrl()` | `canonicalOrigin(baseUrl)` | `configServerTarget().headers` → `getOpenCodeAuthHeaders()` | Raw `fetch` with a headers argument (proposed: required transport parameter) | **Yes** — base URL and headers from separate calls; must be captured together |
| P5 (proxy) | Manager's adopted/managed base URL + request path | `canonicalOrigin(baseUrl)` | `getOpenCodeAuthHeaders()` set onto upstream headers | Raw `fetch` + `redirect:"manual"` + header set manually (proposed: captured context transport) | **Yes** — base URL from manager, credential from runtime, headers set separately; must be captured together |

**The problem is structural, not a missing `await`.** In every path the base URL and the credential
are obtained from different authorities (the manager vs. the `runtime.ts` module), and the header is
constructed by a third call. `ensureBaseUrl()` is asynchronous and may start a server; every later
read happens after at least one `await` boundary. Between those reads, adoption, revalidation,
rotation, fallback, or shutdown can change the state, so a request can combine a base URL from one
snapshot with a credential from another. Calling the getters back-to-back does not fix this: they
remain separate readings of mutable module state, and the second reading can observe a different
transition. A single value that owns all of the fields is required.

### 1.9.2 Proposed immutable context — both modes, managed password included

```ts
/** One logical request. Immutable. PROPOSED — not implemented. */
export type OpenCodeRequestContext = Readonly<{
  readonly mode: "managed" | "adopted";
  readonly baseUrl: string;                    // slash-free canonical origin
  readonly origin: string;                     // === baseUrl; kept explicit for the transport
  readonly credential: OpenCodeManagedCredential | OpenCodeAdoptedCredential;
  readonly authHeaders: Readonly<Record<string, string>>; // buildOpenCodeBasicAuthHeader() output
  readonly revision: number;                   // DIAGNOSTICS ONLY — never gates a request
  readonly shutdownEpoch: number;              // revocation counter; checked with the latch in §1.9.4 step 2
  readonly transport: OpenCodeTransport;       // bound to origin + credential + shutdownEpoch
}>;

export type OpenCodeManagedCredential = {
  readonly kind: "managed";
  readonly password: string;                   // non-empty by construction
};

export type OpenCodeAdoptedCredential = {
  readonly kind: "adopted";
  readonly origin: string;                     // canonical, slash-free
  readonly password: string;                   // non-empty by construction
};

export type OpenCodeTransport = typeof globalThis.fetch;
```

**`Readonly` is a compile-time property, not a runtime one.** Every `readonly` above stops a
*TypeScript* assignment; none of them prevents a JavaScript assignment to the object at runtime.
Revision 16 froze only the outer request context and then exposed `target.credential` by reference —
to the caller and to the transport — so a caller that kept the object it passed to
`installAdoptedTarget()` could still reassign `password` after installation, making the frozen
`authHeaders` disagree with the credential the transport would send. Revision 17 specifies defensive
ownership instead: installation copies the input into owner-controlled objects, the owner freezes
them at runtime, and no mutable caller-owned reference is retained (§1.9.3.1).

The managed password is **part of the context**, not an implicit fallback inside a global header
getter. In managed mode `credential.kind === "managed"` and `credential.password` is the exact value
used to build `authHeaders`. There is no `credential === null` case, so the context cannot mean
"managed password not represented".

`authHeaders` is derived inside the capture operation (§1.9.3) by the single
`buildOpenCodeBasicAuthHeader(credential.password)` helper and is frozen. It exists because the
official client requires headers at construction. The transport does not trust it: §1.9.4 rebuilds
the header from the credential with the same helper and strips any caller-supplied value.

#### 1.9.2.1 Two numbers, two jobs — the repair of the revision-15 contradiction

Revision 15 had **one** `generation` field and gave it two incompatible jobs:

- it incremented on every ordinary transition (managed → adopted, adopted → managed, rotation);
- the transport used it as the gate that refuses initiation after shutdown.

RC1 and RC4 then cannot both hold. RC1 requires a context captured *before* an ordinary transition to
still send its request afterwards; RC4 requires a context captured *before shutdown* to be refused.
If the gate is "captured generation equals current generation", the first requirement fails on every
ordinary transition, and if the gate is relaxed to satisfy the first, shutdown stops being enforced.
No single comparison satisfies both. Revision 16 therefore separates the two jobs:

| Value | Where it lives | Changes when | Read by the transport at initiation? | Job |
|---|---|---|---|---|
| **`revision`** | connection state | every replacement — adoption, fallback, rotation, clear, shutdown | **No** | Diagnostics only: log correlation, test assertions that "a transition happened". It is an observation counter, never a permission. |
| **`shutdownEpoch`** | connection state | **only** on the first `beginShutdown()`; a second call moves nothing (§1.9.3.2) | **Yes** — equality check (§1.9.4 step 2) | Revocation: a captured-but-unsent context stops being able to initiate. |
| **`shutdownStarted`** | connection state | once, in the same replacement that first moves the epoch; terminal | **Yes** — read from the same snapshot as the epoch (§1.9.4 step 2, §1.9.5 condition 1) | Idempotence latch for the transition itself **and** the authority on whether shutdown happened: install, clear, capture and `beginAttempt()` refuse on it, the transports refuse on it, and a repeated shutdown cannot move the epoch again. |
| **`attemptId`** | attempt record (§3.1) | every attempt created by `beginAttempt()` (§1.9.3.3) | No — read by `isAttemptActive` (§3.2) | Rejecting a superseded completion's right to install or clear, and refusing every completion once shutdown has begun. |

The values are deliberately **not** interchangeable. `revision` tells you the state moved.
`shutdownEpoch` tells you whether the process may still originate requests. `shutdownStarted` tells
you whether shutdown has already been enacted, so a later call cannot enact it again. `attemptId`
tells you which discovery cycle is current. Conflating any two of them is the defect this subsection
records — revision 15 conflated the first two, and revision 16 left the second and third unseparated
in mechanism.

`shutdownEpoch`, `shutdownStarted` and the attempt's epoch baseline are all taken from **one**
snapshot, and the only function that takes them for an attempt is `beginAttempt()` (§1.9.3.3). An
attempt therefore cannot be born holding a stale epoch, and it cannot be born at all once
`shutdownStarted` is true — the two facts that revision 17 asserted for request paths and did not
provide for discovery.

**Exactly one increment for the epoch.** `shutdownEpoch` starts at `0` and is incremented by
`beginShutdown()` exactly once for the life of the process; there is no other writer. Revision 17
makes that a mechanism rather than an assertion: `shutdownStarted` is a terminal latch inside the
same state value, and the first `beginShutdown()` sets it in the same replacement that moves the
epoch, so a second or concurrent call observes it and performs no replacement (§1.9.3.2). A captured
context's `shutdownEpoch` therefore equals the current epoch **iff** shutdown has not begun. Because
the epoch lives *inside* the connection state and `beginShutdown()` performs one state replacement,
there is no window in which a capture could observe a new epoch with an old target or an old epoch
after shutdown was recorded: JavaScript run-to-completion makes the capture body and the
`beginShutdown()` body mutually exclusive (§1.9.3).

**Invariant (proposed, not yet proven):** a request must never send a credential selected from one
runtime-state snapshot to a destination selected from another snapshot; and no request may be
*initiated* after shutdown begins, regardless of when its context was captured.

### 1.9.3 One authoritative owner and one capture operation

**Owner:** `src/services/opencode/connectionState.ts` (OpenCode service). It holds exactly one state
value, constructs and freezes every object it stores, and is the only module allowed to read or
replace it. The manager stops being the authority for the selected target, and `runtime.ts` stops
being a second authority for it. The managed password's *production* stays with `runtime.ts` (§1.4);
the selected mode, target, origin, and credential are read from the connection state.

```ts
type OpenCodeTarget =
  | { readonly mode: "unresolved" }
  | { readonly mode: "managed"; readonly baseUrl: string; readonly origin: string;
      readonly credential: OpenCodeManagedCredential }
  | { readonly mode: "adopted"; readonly baseUrl: string; readonly origin: string;
      readonly credential: OpenCodeAdoptedCredential };

type OpenCodeConnectionState = Readonly<{
  readonly revision: number;         // +1 on EVERY replacement; diagnostics only (§1.9.2.1)
  readonly shutdownEpoch: number;    // +1 on the FIRST beginShutdown() only; the initiation gate
  readonly shutdownStarted: boolean; // terminal; set by that same replacement; never back to false
  readonly target: OpenCodeTarget;
}>;
```

`revision` and `shutdownEpoch` are siblings of `target`, not fields of it, so no code can derive one
from the other and no transition can accidentally couple them. `revision` and `target` are replaced
together on every transition; `shutdownEpoch` is written by exactly one function, once.

`shutdownStarted` is a second, independent signal in the same value. The epoch is a number and could
in principle be moved twice; the flag is a latch that can only be observed going from `false` to
`true`. Idempotence is enforced by reading and setting it inside one synchronous replacement
(§1.9.3.2), and install, clear and capture all refuse while it is `true`.

- `ensureBaseUrl()` publishes `{mode:"managed", baseUrl, origin, credential}` as the new `target`
  through `installManagedTarget(...)` **after** readiness succeeds, and only then resolves. A
  readiness failure publishes nothing. `revision` +1, `shutdownEpoch` unchanged.
- `installAdoptedTarget(...)` replaces the whole value in one assignment after a successful probe.
  `revision` +1, `shutdownEpoch` unchanged.
- `clearTarget()` replaces the value with `target: {mode:"unresolved"}` for fallback and explicit
  rejection. `revision` +1, `shutdownEpoch` unchanged.
- `beginShutdown()` is the **only** writer of `shutdownEpoch` and the only setter of
  `shutdownStarted`. Its **first** call replaces the whole state with
  `{revision: r + 1, shutdownEpoch: e + 1, shutdownStarted: true, target: {mode:"unresolved"}}` in
  one assignment. Every later call observes `shutdownStarted === true` and performs no replacement
  (§1.9.3.2). It replaces revision 15's `invalidateForShutdown()`, which could not be distinguished
  from an ordinary transition because both incremented the same counter.
- `installManagedTarget`, `installAdoptedTarget` and `clearTarget` throw
  `OpenCodeContextInvalidatedError` when `shutdownStarted` is `true`. The attempt guard (§3.2) still
  runs first; this is the second, independent refusal, so a code path that reaches an install without
  the guard cannot resurrect a target after shutdown.
- There is no field setter. A transition is one object replacement; a reader can only observe the
  old value or the new one.

**Capture operation** (synchronous; no `await` inside):

```ts
export function captureOpenCodeRequestContext(): OpenCodeRequestContext {
  const state = readConnectionState();           // ONE reference read
  if (state.shutdownStarted) throw new OpenCodeNotReadyError();   // primary gate
  const target = state.target;
  if (target.mode === "unresolved") throw new OpenCodeNotReadyError(); // independent refusal
  const credential = target.credential;          // frozen at install; never copied again
  return Object.freeze({
    mode: target.mode,
    baseUrl: target.baseUrl,
    origin: target.origin,
    credential,                                  // the SAME frozen object the state holds
    authHeaders: Object.freeze(
      buildOpenCodeBasicAuthHeader(credential.password),
    ),
    revision: state.revision,                    // diagnostics only
    shutdownEpoch: state.shutdownEpoch,          // the gate the transport re-checks
    transport: createBoundedTransport({
      origin: target.origin,
      credential,                                // the SAME frozen object, not a copy
      shutdownEpoch: state.shutdownEpoch,
    }),
  });
}

/**
 * The transport's gate. ONE reference read, both fields from the same snapshot; no other module
 * may decide this. The epoch alone is not enough: a binding built after shutdown would be handed
 * the current epoch (§1.9.4 step 2), so the latch is read from the same snapshot and checked too.
 */
export function readShutdownState(): Readonly<{
  shutdownEpoch: number;
  shutdownStarted: boolean;
}> {
  const state = readConnectionState();
  return Object.freeze({
    shutdownEpoch: state.shutdownEpoch,
    shutdownStarted: state.shutdownStarted,
  });
}

/**
 * The ONLY constructor of an attempt (§1.9.3.3). No target, no credential, no transport.
 * PROPOSED — not implemented.
 */
export function beginAttempt(source: AttemptSource): AdoptionAttempt;
```

`shutdownStarted` is the primary refusal and the `unresolved` check is kept as a second, independent
one: an ordering defect that published `unresolved` without the flag, or the flag without
`unresolved`, would still be refused by the other. Neither test is redundant with the transport gate —
that one compares epochs on every invocation, this one refuses to *build* a context.

**Capture is the request path, not the discovery path.** Capture requires an installed target and
refuses `unresolved` by design. Initial discovery runs *because* the target is unresolved, so it
cannot and must not go through capture; it is initiated by `beginAttempt()` (§1.9.3.3), which reads
the same connection state and never reads the target. Revision 17 claimed every start path captured
a context first; that was untrue for exactly this case and is corrected here.

`credential` is the frozen object the connection state already holds. Capture does not copy it and
does not build a second one, so the context, the auth header source and the transport binding all
read the same instance; there is no second copy that could diverge (§1.9.3.1).

Every field comes from the same `state` value. The caller supplies no URL, no header, no credential,
and no epoch; the previous `capture(baseUrl)` shape is rejected because a caller-supplied URL would
reintroduce the split, and a caller-supplied epoch would let a caller self-issue a long-lived gate.
Because `shutdownEpoch` is read from the same snapshot as `target`, a capture can never pair a
pre-shutdown target with a post-shutdown epoch, or the reverse.

**What the atomicity claim is — and is not.** The design does **not** claim that individual getters
are atomic. It claims that (a) there is one state object, (b) capture performs one reference read
and derives every field — including the epoch — from it, (c) `beginShutdown()` is one assignment,
and (d) any later ordinary transition replaces the object rather than mutating it, without touching
the epoch. JavaScript run-to-completion means the capture body, every transition body, and
`beginShutdown()` cannot interleave with one another. The interleavings that matter are at the
`await` boundaries *before* capture (starting a server, probing, revalidating) and *after* capture
(sending, awaiting a response). §1.9.6 covers those; treating transitions inside the synchronous
capture body as normal concurrency would be wrong.

#### 1.9.3.1 Defensive ownership — copied and frozen at installation

Revision 16 froze the outer context and then handed out `target.credential` by reference. Both the
caller and the transport held a reference to an object the caller still owned, and `Readonly` is
erased at runtime (§1.9.2). A caller that kept the object it passed to `installAdoptedTarget()`
could reassign `password` afterwards; the frozen `authHeaders` would then disagree with the
credential the transport would send, which is the exact pairing defect B8 exists to prevent, moved
one level down the object graph. The rules below replace that with ownership:

1. **Copy at the boundary.** `installManagedTarget()`, `installAdoptedTarget()` and the discovery
   candidate path never store the caller's object. Each reads the fields it accepts **once into
   locals** and constructs a fresh target and a fresh credential from those locals. No spread and no
   `structuredClone`: a spread executes the caller's getters and copies properties the type does not
   declare, while explicit field reads make the accepted surface exactly the declared type.
2. **Freeze every level, not only the outer one.** `Object.freeze` is shallow. The owner freezes the
   credential object, the target object, the `authHeaders` record, the transport binding, the request
   context, and the connection state — in that order, innermost first, so no frozen parent ever holds
   an unfrozen child. Strings are primitives and need no freezing.
3. **Retain no caller-owned reference.** After installation the state holds only objects the owner
   constructed. The caller's object and the caller's credential are unreachable from the owner, so
   mutating them changes nothing that is observed.
4. **Capture exposes only the immutable snapshot.** `captureOpenCodeRequestContext()` returns the
   frozen context, whose `credential` field is the frozen credential the state already holds — not a
   copy and not the install argument (§1.9.3).
5. **The transport binding retains that same snapshot.** `createBoundedTransport` is given the same
   frozen credential instance the context exposes, freezes its own binding object, and closes over
   the credential. It does not copy the password into a mutable local, so there is no second copy to
   drift.
6. **Neither path can be mutated.** A write to any of these objects either throws `TypeError` (ES
   modules are strict mode, which is how this repository's modules run) or, in a non-strict caller,
   is silently ignored. In both cases the owner's value is unchanged; the difference is only whether
   the caller sees the failure.

**Why this is a copy and not a validation.** The copy is not a re-validation of the registration
record — that happened before install (§2.3). It is the boundary at which caller-owned memory stops
being trusted. Reading each field once is also what makes rule 1 hold against a getter that returns
a different value on each access.

**What remains.** This makes mutation *through the object graph* ineffective. It does not make the
string immutable in memory, does not protect against a same-process actor that replaces the module's
internal state reference, and does not defend against a debugging or monkey-patching hook inside the
process — those are out of scope for a local, single-user application and are not claimed here.

#### 1.9.3.2 `beginShutdown()` is idempotent

A process can be asked to shut down more than once and from more than one place: a signal handler, a
Tauri window close, an explicit stop, and a failed-start cleanup can all run in the same process.
Revision 16 said the epoch moves **exactly once** but described `beginShutdown()` as an
unconditional replacement, so a second call moved it again and pushed every captured context — and
every request the transport had already allowed — into a different refusal class for no reason. The
rule is now explicit:

**The first call does the work, in a fixed order.** It reads the state; if `shutdownStarted` is
`false` it performs the following, in one synchronous block and in exactly this order:

1. **one replacement** —
   `{revision: r + 1, shutdownEpoch: e + 1, shutdownStarted: true, target: {mode:"unresolved"}}`;
2. **publish the shared completion** — a deferred is created and stored in a module-private slot
   *before* any external callback can run, so the promise every caller receives exists from the
   moment the latch becomes `true`;
3. **abort the active attempt's controller** (§3.1). `AbortController.abort()` dispatches its
   listeners **synchronously**, and a listener may call `beginShutdown()` again;
4. **join the shared per-child stop of every managed child the manager owns** (§3.4) — the published
   child, any child a live attempt is still waiting on, and any other child still in the manager's
   live-child registry, including one spawned by a start path that has not published yet — and settle
   the published deferred from the joined outcome. This step begins with one synchronous block that
   **clears the cached start binding** and copies the live-child registry, *before* it collects a
   single per-child decision, so no `ensureBaseUrl()` call can hand out a child that is about to be
   signalled and no child can join the set after the join starts. In adopted mode this step joins
   nothing and settles `{ok: true}`.

Steps 1→2→3 are what make the operation re-entrancy-safe. Revision 17 ordered this as replacement →
abort → child stop → *store the promise*, so a listener that called `beginShutdown()` from the abort
found `shutdownStarted === true`, took the "later call" path, and was handed a completion promise
that had not been created yet.

**Every later or re-entrant call returns the same published promise.** It observes
`shutdownStarted === true`, performs no replacement (`revision` and `shutdownEpoch` do not move, the
target stays `unresolved`), starts no abort and no stop, and returns the completion promise stored in
step 2 — the identical object, not an equivalent one. A call made from an abort listener therefore
returns immediately with that promise and cannot re-enter the abort currently dispatching it. Calling
it twice is not an error and is not reported as one.

**The published completion always settles — by mechanism, on every failure mode.** Revision 18
handled a **synchronous** throw and said nothing about a returned promise that **rejects**. That gap
had two consequences: the shared promise would settle by rejection, and a rejection nobody observed
would surface as an unhandled rejection — from a function documented as never rejecting. The mapping
is now total:

| Outcome of step 4 | Shared promise | Failure surfaced how |
|---|---|---|
| Adopted mode (nothing to stop) | resolves `{ok: true}` | — |
| Managed: the joined stop resolves | resolves with its result | — |
| Managed: the invocation throws synchronously, including before it returns a value | resolves `{ok: false, error}` | logged with the child's pid |
| Managed: the invocation returns a promise that **rejects** | resolves `{ok: false, error}` | logged with the child's pid |
| Managed: the stop does not settle within its bound | resolves `{ok: false, reason: "termination_unconfirmed", pid}` | logged as a named failure (§6.5) |

**Where the synchronous throw actually comes from, stated exactly.** Revision 19 wrote the handler as
`Promise.resolve(invokeStopSafely()).then(onResolved, onRejected)` and claimed that this covered a
synchronous throw. It covers only a throw raised *inside a function that has already been called*,
after the chain exists. The argument to `Promise.resolve` is evaluated **before** `Promise.resolve`
runs, so a throw raised while `invokeStopSafely()` is being evaluated — before it returns a value or a
promise — never enters that chain: it propagates out of the expression, leaves the deferred
unresolved, and escapes a function documented as never rejecting.

Revision 20 answered that with two shapes and called them equivalent. They are not, and one of them is
incompatible with the publication order §3.4 requires:

| Shape | Code | What revision 21 found |
|---|---|---|
| Executor invocation — **removed** | `new Promise<ShutdownResult>((resolve) => resolve(invokeStopSafely()))` | A Promise executor runs **synchronously inside the constructor**, so the stop is invoked before the constructor's caller can store the returned promise. §3.4 requires the per-child promise to be in the `WeakMap` before **any** stop activity, because a callback that re-enters `stopChild(child)` must find it. This shape violates that ordering, so it is not an alternative spelling — it is the defect |
| Deferred plus a scheduled invocation — **the only shape** | executor only captures `resolve`; the promise is stored; then `queueMicrotask(run)` where `run` does `try { op = runStopSequence(child) } catch (e) { settle({ok:false,error:e}); return }` and `op.then(settle, (e) => settle({ok:false,error:e}))` | Publication precedes scheduling, scheduling precedes the invocation, a pre-return throw is caught by the `try`, and a returned rejection is observed by the two-argument `then` |

There is therefore **one** construction, and §3.4 owns it: `stopChild()` publishes the deferred, then
schedules the stop as a microtask, then settles the **published** promise from inside that microtask.
The `try/catch` covers the pre-return throw; the two-argument `then` covers an asynchronous rejection;
the two-phase bound inside `runStopSequence()` covers a stop that never settles. Nothing is invoked
before the map holds the promise, so the re-entrancy argument of §3.4 is structural rather than
temporal.

With that ordering fixed, all three failure shapes reach the same typed result: a **synchronous throw**
(whether raised before the operation returned anything or after it returned) and an **asynchronous
rejection** both resolve the deferred as `{ok: false, error}`, and a stop that exceeds its two-phase
bound resolves `{ok: false, reason: "termination_unconfirmed", pid}`. The deferred is only ever
resolved, the shared promise never rejects, and a caller that never awaits it cannot produce an
unhandled rejection. RC14 asserts the synchronous-throw shape, RC15 the asynchronous-rejection,
non-settling and pre-return-throw shapes, and RC16 the re-entrant caller **and** a caller that arrives
after the stop is published (§1.9.7). No path described here — including a throw raised before the
operation returns anything — may reject the shared completion or leave a second stop running.

**One join, and it is a join of promises that already exist.** Step 4 can name more than one managed
child (every entry in the live-child registry, which includes any child an installed target names, §3.4), and two different operations
are involved. They are named separately because revision 19's sentence "joining **never starts** a
stop" described only the second, and read as a description of `stopChild()` it was false:

1. **Obtaining each per-child stop promise.** Step 4 calls
   `stopChild(child, {kind: "shutdown"})` for every child in its synchronous copy and keeps the
   returned `.promise`. For a child that nothing has stopped yet, **that call starts the stop** — it is
   the first caller, and §3.4 requires it to publish the promise before it schedules anything. For a
   child another path already stopped, the same call **returns the identical promise** and invokes no
   process API, because the map lookup happens **before** any eligibility test (§3.4). The shutdown
   cause is never refused, so every child in the copy yields a promise. The first call starts, later
   calls join; that is the whole contract, and RC16 asserts that a caller re-entering during the first
   call's initiation is a later call.
2. **Waiting for them.** The join is `Promise.allSettled` over the promises step 4 collected. *This*
   operation starts nothing: every element was returned by `stopChild()` before `allSettled` is
   reached.

The set is copied **synchronously** in step 4, before any `await`, so no child can join this join after
it begins (§3.4 forbids a spawn after step 4). The shared completion resolves `{ok: true}` only if
every element is ok. Otherwise it resolves `{ok: false, error}` from the first element that threw or
rejected, or `{ok: false, reason: "termination_unconfirmed", pid}` from the first child that hit the
bound. A second child's failure is logged too, so one failing stop does not hide another.

**"Always settles" is bounded, not asserted.** The bound lives inside the per-child stop rather than
in a race around it: `stopChild()` escalates through two named phases (`opencodeChildStopGraceMs`,
then `opencodeChildStopKillMs`, §6.5), so the maximum time between the first `beginShutdown()` and a
settled shared promise is the sum of the two. That holds for several children as well as one, because
step 4 starts all of their stops before awaiting any of them and the join is `Promise.allSettled`
over running promises, not a sequence. What that does **not** claim is that the process is
dead: a stop that cannot confirm termination resolves as `termination_unconfirmed` and the residual is
recorded (§12.6). Asserting "the process was terminated" from a timer expiring would be exactly the
kind of claim this document refuses elsewhere.

**Adopted shutdown sends no signal.** In adopted mode the process is not signalled, waited on, or
reconfigured (§3.3); "completion" means the state replacement has been published and nothing further
is outstanding.

**Why the check, the set and the publication cannot be reordered.** The flag is read, the
replacement performed and the deferred stored in one synchronous block with no `await` between them,
so two callers — including two concurrent `Promise.all([beginShutdown(), beginShutdown()])`
callers — cannot interleave there: the second observes the flag the first set and the promise the
first published. A listener dispatched by the abort in step 3 runs after step 2, so it observes both.
The child stop is reached once because its invocation sits inside the single first-call branch — not
because a promise happened to be created first, which is the reasoning revision 17 relied on.

**Shutdown is terminal for the state machine.** `installManagedTarget`, `installAdoptedTarget` and
`clearTarget` refuse when `shutdownStarted` is true (§1.9.3), so no path can move the target or the
epoch after shutdown; `captureOpenCodeRequestContext()` refuses for the same reason, and so does
`beginAttempt()` (§1.9.3.3) — which is what stops a **new discovery** from starting after shutdown.
An install that was awaiting a probe when shutdown began re-checks `isAttemptActive` **and**
`shutdownStarted` after the await and is refused by both.

**Ordinary transitions never reset it.** Adoption, fallback and rotation refuse after shutdown rather
than reinstating a target, so a transition can never take the epoch back to a previous value or clear
the flag. There is no "restart" transition inside a process.

**A restarted process starts a new epoch space.** The epoch is a per-process counter, not persisted;
a context from the previous process cannot be carried into a new one because contexts are not
persisted either (§12.5). Two processes therefore cannot be compared by epoch, and the design does
not compare them.

#### 1.9.3.3 Attempt initiation — `beginAttempt()`

Revision 17 contained a contradiction at the exact moment discovery begins. `captureOpenCodeRequestContext()`
refuses `unresolved` targets (§1.9.3), which is correct for a request; but initial discovery runs
*while* the target is unresolved, so discovery cannot capture a context first. §3.1 nevertheless
claimed every start path captured one, and needed the claim to justify "an attempt started after
shutdown is impossible". The second half of the problem was in the discovery transport: it compared
a `shutdownEpoch` only, so a transport constructed **after** shutdown could be handed the current,
already-incremented epoch and pass the equality check.

A separate, synchronous operation owns attempt creation **and** the supersession of the attempt it
replaces. Revision 18 specified the snapshot and the refusal and stopped there, so two things its own
prose depended on had no writer: no code recorded an attempt as *current*, and no code aborted the
attempt a new one replaced. §3.1's rule that superseding "records the new current id" and §3.2's
condition 1 (`attempt.attemptId === currentAttemptId()`) were therefore unenforceable as written.

```ts
export type AttemptSource = "startup" | "manual" | "revalidate";

/**
 * Creates one discovery/start attempt and makes it current. Synchronous. Reads the connection state
 * TWICE, for two different jobs: a CREATION snapshot (step 1), whose shutdownEpoch is the only epoch
 * the attempt will ever carry, and a REVALIDATION snapshot (step 6), taken after the abort callbacks
 * have run, which decides whether this attempt survived them. Takes ONE module-private attempt slot.
 * Refuses after shutdown, before any registration-file I/O and before any probe request. Returns only
 * an attempt that is still current and not aborted at the moment of return; otherwise THROWS.
 * PROPOSED — not implemented.
 */
export function beginAttempt(source: AttemptSource): AdoptionAttempt {
  // 1. CREATION snapshot. This is the only read whose shutdownEpoch the attempt will carry, and it
  //    answers the latch before the counter moves. Two fields, one read: an epoch must never be
  //    paired with a latch answer taken across a different transition.
  const state = readConnectionState();

  // 2. Refused before any I/O, before the counter moves and before the slot is touched.
  if (state.shutdownStarted) throw new OpenCodeNotReadyError();

  // 3. Allocate the id and build the record. Freezing covers the fields, not the controller.
  const attempt: AdoptionAttempt = Object.freeze({
    attemptId: nextAttemptId(),
    startedAt: Date.now(),
    shutdownEpochAtStart: state.shutdownEpoch,
    source,
    controller: new AbortController(),
  });

  // 4. Register as current and take the previous attempt in the SAME synchronous step.
  const previous = currentAttempt;   // module-private; no getter exposes the slot
  currentAttempt = attempt;

  // 5. Abort the previous attempt at most once. abort() dispatches listeners SYNCHRONOUSLY,
  //    so a listener below may call beginAttempt() again or call beginShutdown().
  if (previous !== null && !previous.controller.signal.aborted) previous.controller.abort();

  // 6. REVALIDATION snapshot — a second, deliberate read. abort() dispatches listeners
  //    SYNCHRONOUSLY, so by this point a listener may have superseded us or begun shutdown; only a
  //    read taken now can answer that. It does not replace step 1's epoch baseline.
  if (currentAttempt !== attempt) {                    // a nested beginAttempt() superseded us
    if (!attempt.controller.signal.aborted) attempt.controller.abort();
    throw new OpenCodeAttemptSupersededError(attempt.attemptId);
  }
  if (readConnectionState().shutdownStarted) {         // a listener began shutdown
    if (!attempt.controller.signal.aborted) attempt.controller.abort();
    throw new OpenCodeNotReadyError();
  }
  return attempt;
}
```

**The exact order, and why each position is load-bearing.**

| Step | Position is required because |
|---|---|
| 1. creation snapshot | The epoch baseline and the initial latch answer come from **one** read, so no epoch can be paired with a latch answer taken across a different transition. Step 6 cannot reuse it: the callbacks that can invalidate the attempt have not run yet |
| 2. refuse | The latch is checked **before** the counter advances and before the slot changes, so a refused call leaves no trace and consumes no id |
| 3. build | The record is fully formed before it is reachable from the slot, so a reader never observes a half-built attempt |
| 4. register | Currentness is written in the same synchronous step as the read of `previous`; there is no window in which `currentAttempt` is `null` or stale |
| 5. abort previous | Aborting **after** registration means a listener observing `currentAttempt` during the abort already sees the new attempt, not the dying one. The `signal.aborted` guard makes "exactly once" observable rather than incidental |
| 6. revalidation snapshot | `abort()` is synchronous, so both listeners in step 5 have already run. This is the only point at which the function can know whether its own attempt survived, and it is a **second** read on purpose — a cached answer would describe the state before the callbacks it must survive |

- **Owner, two reads with two jobs, one slot.** `connectionState.ts` owns both the attempt counter and
  the current-attempt slot. `beginAttempt()` reads the connection state at step 1 (creation) and again
  at step 6 (revalidation); the first supplies the attempt's `shutdownEpochAtStart` and the second
  supplies nothing to the record — it only decides return-versus-throw. Neither read is a
  reimplementation of the other, and there is no third. The function touches the slot only inside
  this function and inside `beginShutdown()` (which reads it in order to abort it, §1.9.3.2 step 3).
  No other module creates an attempt and no other module supplies an epoch to one.
- **What it returns, stated precisely.** On a normal return the attempt is the current one, its
  controller is not aborted, and the latch was `false` at the final re-read. It does **not** promise
  those things stay true for any length of time — shutdown can begin one tick later — which is what
  `isAttemptActive` is for. It promises only that the caller is not handed an attempt that was
  already dead when the call returned.
- **Re-entrancy gives a throw, never a dead attempt.** If a listener dispatched in step 5 calls
  `beginAttempt()` again, the nested call registers attempt *N+1*, aborts *N* (the attempt the outer
  call is still constructing its return for), and returns normally. The outer call then finds
  `currentAttempt !== attempt` and **throws `OpenCodeAttemptSupersededError`**. It does not return
  *N*, because a caller that received *N* would reasonably start the registration read and the probe
  — the two operations the attempt exists to authorise. If the listener instead calls
  `beginShutdown()`, the outer call finds the latch set on the re-read and throws
  `OpenCodeNotReadyError`. An abort listener that throws is outside this contract: `abort()` reports
  a listener exception rather than propagating it, so step 6 still runs and still decides.
- **A superseded attempt cannot start I/O either way.** Throwing covers the re-entrant case; for the
  ordinary case — attempt *N* returned normally, then superseded by a later call — the two I/O entry
  points check first. `readRegistrationRecord(attempt)` and
  `createDiscoveryProbeTransport(attempt, candidate)` call `isAttemptActive(attempt)` **before** their
  first `lstat`, open, read or fetch, and refuse with `OpenCodeAttemptSupersededError` otherwise. The
  check is repeated before installing (§3.2); starting and installing are two separate decisions and
  both are guarded.
- **Why it is not capture.** It does not read the target, does not require a credential, and does not
  build a transport. A target exists only *after* a successful probe or readiness gate, so requiring
  one here would make the first discovery impossible — the defect revision 17 shipped on paper.
- **Refused after shutdown.** The check is synchronous and precedes every side effect: no
  registration file is opened, read, or even `lstat`ed (§2.4), and no probe request is created
  (§1.9.5). A caller cannot talk it out of this: the function takes a source, never an epoch.
- **A normal initial discovery remains possible.** With `target: {mode:"unresolved"}` and
  `shutdownStarted === false`, `beginAttempt("startup")` succeeds and records the current epoch. This
  is the ordinary first-run path, and it is asserted by AT10 (§3.5).
- **The first shutdown invalidates every earlier attempt.** That call moves the epoch and sets the
  latch in one replacement (§1.9.3.2), so `isAttemptActive` returns `false` on its epoch condition and
  on its latch condition (§3.2), and the current attempt's controller is aborted.
- **No caller-supplied epoch exists to bypass anything.** The epoch a discovery transport compares
  comes from `attempt.shutdownEpochAtStart`, which only `beginAttempt()` writes; the epoch a request
  transport compares comes from capture. Both transports also read `shutdownStarted` from the owner's
  snapshot at initiation (§1.9.4 step 2, §1.9.5). The epoch is a revocation counter; the latch is the
  authority on whether shutdown has happened, and it is never taken from a caller (§1.9.5 states what
  that means for a test that wants to construct the otherwise-unreachable state).

### 1.9.4 Credential-to-origin enforcement — transport-level injection

The transport owns the `Authorization` header. Callers may pass headers, but the transport removes
any `Authorization` (case-insensitive, from either input) and sets its own from the captured
credential. A caller therefore cannot override or contradict the context, and a stale caller-built
header cannot leak a different credential.

**One constructor, one call site.** The transport contains **no** base64 or `Basic` expression. It
calls the single pure helper that exists for this purpose, `buildOpenCodeBasicAuthHeader(password)`
(§1.4), whose result carries exactly one `Authorization` entry. No other module — `http.ts`, the
proxy, `client.ts`, the discovery probe, or adoption code — may construct this header another way.
A12 (§1.6) and TT6 assert it by source scan. Revision 15 wrote the construction formula into this
section while A12 claimed construction existed only in `runtime.ts`; that contradiction is removed
here: the contract names the helper, not the algorithm.

```ts
export function createBoundedTransport(binding: {
  readonly origin: string;
  readonly credential: OpenCodeManagedCredential | OpenCodeAdoptedCredential;
  readonly shutdownEpoch: number;
}): OpenCodeTransport;
```

**Header derivation for both input shapes.** `fetch` accepts a URL/string **or** a `Request`, and a
caller may also pass an `init`. The effective header set is built explicitly rather than by cloning
only one of them:

1. Start from an empty `Headers`.
2. If `input` is a `Request`, copy `input.headers` into it. This preserves the scope header
   (`x-opencode-directory`, §5.3) and `content-type` that the generated client attached to its
   `Request`.
3. If `init?.headers` is present, overlay it — its values win, matching fetch's own precedence.
4. Delete every `authorization` entry case-insensitively, whichever source supplied it.
5. Set the single entry returned by `buildOpenCodeBasicAuthHeader(binding.credential.password)`.

These five header steps are applied at step 3 of the per-invocation sequence below.

`method` and `body` are **not** rewritten. The transport calls
`fetch(input, { ...init, headers, redirect: "manual" })` and lets fetch derive both from the
`Request` when `init` omits them, which is what an unwrapped call would do. Assigning `body`
explicitly would fail on a `Request` whose body has already been consumed; leaving it alone
preserves the original semantics.

On every invocation the transport:

1. Derives the target origin from `Request.url` or the URL/string input. If it differs from
   `binding.origin`, throws `OpenCodeOriginMismatchError` **before** constructing a header or calling
   the underlying fetch.
2. Reads **one** shutdown snapshot with `readShutdownState()` (§1.9.3) and refuses when **either**
   `snapshot.shutdownStarted === true` **or** `snapshot.shutdownEpoch !== binding.shutdownEpoch`,
   throwing `OpenCodeContextInvalidatedError` before any header is constructed and before fetch.
   **This is the only initiation gate.** The epoch comparison alone is not sufficient on its own: it
   is an equality test, so a binding created after shutdown and handed the current epoch would pass
   it. The latch is read from the **same** snapshot, so the two conditions cannot disagree inside one
   gate. The connection-state `revision` is never consulted, so an ordinary transition between
   capture and send cannot stop the request (§1.9.2.1, RC1).
3. Builds the effective headers by the five steps above, so exactly one `Authorization` value is
   present and it comes from `binding.credential.password`.
4. Calls the real `fetch(input, { ...init, headers, redirect: "manual" })`.
5. On a 3xx response, cancels the body and throws `OpenCodeRedirectRefusedError`, carrying only the
   status and a stable code — never the raw `Location`.

**The check is at initiation, and only at initiation.** A response already on the wire is not
aborted: the transport cannot recall bytes sent before shutdown, and claiming otherwise would be
false. RC5 pins this — the pending response completes, but the same context cannot initiate another
request.

**The seven required properties, and the mechanism for each.**

| # | Property | Mechanism |
|---|---|---|
| 1 | An ordinary transition does not invalidate a captured context before its request is sent; the request uses the captured origin and credential, never a mixed pair | The gate reads `shutdownEpoch`, which ordinary transitions do not touch; `origin` and `credential` come from one snapshot; the origin is re-checked per request |
| 2 | Credential rotation never sends an old credential to a different origin | The context freezes the pair; rotation installs a **new** state object; the old context keeps its own origin and credential and the transport still checks `binding.origin` |
| 3 | Shutdown invalidates captured-but-not-yet-sent contexts | `beginShutdown()` increments `shutdownEpoch` once and publishes `unresolved` and `shutdownStarted` in the same replacement; step 2 throws before fetch on either condition |
| 4 | An already-sent request may complete after shutdown | The gate is checked once, before fetch; the transport does not abort an issued request |
| 5 | A context cannot initiate another request after shutdown | Every invocation re-reads the shutdown snapshot, so a second call on the same context is refused too |
| 6 | A fresh capture after shutdown fails | `beginShutdown()` publishes `unresolved`, sets `shutdownStarted`, and capture refuses on either (§1.9.3); a repeated call changes neither |
| 7 | A stale discovery attempt cannot install or clear a newer state | `isAttemptActive` compares `attemptId` (§3.2); the epoch and revision play no part in that decision |

| Requirement | Mechanism |
|---|---|
| Credential belongs to the captured context | Header value is `buildOpenCodeBasicAuthHeader(binding.credential.password)` — the function named in §1.4, not an inline expression |
| Target origin belongs to the same context | `binding.origin` is the capture's origin, checked on every request |
| Caller Authorization cannot override or contradict | Every `authorization` entry is deleted from both the `Request` and `init` before the set |
| Mismatched origin is rejected before sending | Step 1 throws before fetch; no header is constructed |
| Every redirect is refused | `redirect:"manual"` plus a 3xx throw |
| Credentials never cross managed and adopted origins | One state object; a transition replaces it; an old context keeps its own binding |
| Non-auth headers survive | `Request` headers are copied before the overlay; only `authorization` is deleted (§5.3) |

`routes/opencode.ts` must stop setting an upstream `Authorization` and must not set
`redirect: "manual"` itself; it obtains its fetch from the captured context. `client.ts` passes the
context transport as `options.fetch`; `configDocument.readOpenCodeConfigDocument` requires it.
The observing wrapper in `client.ts` composes around the bound transport and must not swallow the
redirect error.

### 1.9.5 Discovery probe separation

The initial probe transport is built from an **attempt**, never from a caller-supplied epoch:

```ts
export function createDiscoveryProbeTransport(
  attempt: AdoptionAttempt,
  candidate: Readonly<{ origin: string; password: string }>,
): OpenCodeTransport;   // PROPOSED — not implemented
```

Its credential is a **candidate**, deliberately not modelled as an `OpenCodeAdoptedCredential`,
because nothing has been installed at this point and the type must not imply otherwise. It is
constructed from validated registration data, is bound to the **candidate's** origin rather than the
installed one, is not the request-context transport, and is never installed.

**Its initiation gate is the attempt, not an epoch the caller passes in.** On every invocation it
reads one snapshot and refuses — before constructing a header or calling fetch — when **any** of the
following holds:

1. `snapshot.shutdownStarted === true`;
2. `snapshot.shutdownEpoch !== attempt.shutdownEpochAtStart`;
3. `attempt.attemptId !== currentAttemptId()` (the attempt was superseded, §3.1).

Conditions 1 and 3 are what a bare epoch comparison could not express. A superseded attempt is refused
by condition 3 whether or not its abort has completed, and an aborted attempt is refused by the
guard's fifth condition (§3.2) for the same reason.

**Revision 18 claimed that "supplying the current post-shutdown epoch does not bypass the refusal".**
That sentence described a call the production API does not accept: no caller can supply an epoch to a
probe transport, because `createDiscoveryProbeTransport()` takes an attempt, `beginAttempt()` is the
only constructor of one, and it throws on the latch before it stamps an epoch into a record. Stated
accurately, the claim is two separate things:

1. **The production invariant.** No production call path can construct a probe transport holding the
   post-shutdown epoch. Condition 1 is therefore live **defence in depth**: it refuses on the latch
   even in a state where condition 2's equality test would pass. That state is not reachable through
   the API, which is exactly why the next paragraph exists.
2. **The seam that makes the state constructible.** `connectionState.ts` declares one module-private
   state-reader binding, `setShutdownStateReaderForTests(reader)`, which `readShutdownState()`
   delegates to and which is the *only* way a test can make the reader report
   `{shutdownEpoch: e, shutdownStarted: true}` while an attempt also carries `shutdownEpochAtStart: e`.
   Without it, AT10(c) and TT3's latch half would be asserting an input the code cannot produce, and a
   test that constructs an impossible input proves nothing about the production gate. The seam is
   required to be: named with a `ForTests` suffix, unreachable from the package's public surface,
   rejected by a source scan that fails if the name appears in any non-test file under `src/` **other
   than this single declaration site**, and never consulted by a production caller — production code
   calls `readShutdownState()`.

**What each test therefore asserts.** AT10(c) and TT3 assert the *latch check* is live: header
construction and fetch are both zero-call under the seam. AT10(a), AT10(b), AT10(e) and §3.2's
conditions 1–5 assert the *production* path, with no seam installed. Neither test stands in for the
other, and no verification claim in this document rests on the seam producing a state that production
could reach.

A probe started before shutdown may still complete on the wire (§12.5) unless its controller is
aborted; it cannot *initiate* anything after shutdown. `installAdoptedTarget` is called only after
trust validation and a `ready` probe; a failed probe leaves the previous state untouched, and the
probe must not read or reuse the installed managed credential. This keeps "validate the candidate"
and "serve requests" as two different credentials with no shared mutable state.

The probe is cancelled when its attempt is superseded (§3.1). Cancellation and installation are
separate controls and both are needed: the `AbortController` stops the wasted network operation, and
`isAttemptActive` (§3.2) is what actually refuses the late completion's right to install.

### 1.9.6 State-transition contract

Every transition replaces the connection state (§1.9.3). A captured context never changes; it keeps
its own origin, credential, `revision`, and `shutdownEpoch`. The two counters are listed separately
because they behave differently on purpose: `revision` moves on every row, `shutdownEpoch` moves on
the first shutdown row only. Every row is one replacement; no row mutates the current value.

| Transition | State replacement | `revision` | `shutdownEpoch` | Already-captured contexts | New captures |
|---|---|---|---|---|---|
| Managed → adopted | Adopted target installed only after validation and a `ready` probe | +1 | unchanged | Keep the managed origin and credential; **may still initiate**; may finish | Adopted origin and credential |
| Adopted → managed fallback (confirmed `lost`, or explicit rejection) | Adopted target cleared after bounded retries or an explicit decision; **transient revalidation failure does not clear it** (§1.5.1 rows 5–7) | +1 | unchanged | Keep the adopted origin and credential; **may still initiate**; responses may finish | Managed target only after `ensureBaseUrl()` publishes it; `unresolved` until then |
| Revalidation, same password | No replacement (same origin, same password) | unchanged | unchanged | Unaffected; may still initiate | Same target |
| Credential rotation | New password installed only after a successful probe | +1 | unchanged | Already-captured contexts keep their **own** pair and may still initiate; an already-sent request may receive 401; the old password is never sent to a new origin | The new password |
| Failed revalidation | No change; the previous credential stays installed | unchanged | unchanged | Unaffected; the old credential remains valid until `lost` | The previous target |
| Shutdown, **managed** | Target → `unresolved`; the managed child is stopped through the shared per-child stop of §3.4 | +1 | **+1** (first call only) | **No new request may be initiated** (transport throws `OpenCodeContextInvalidatedError`); an already-sent response may complete | `capture()` throws `OpenCodeNotReadyError` |
| Shutdown, **adopted** | Target → `unresolved`; the adopted process is **not** signalled | +1 | **+1** (first call only) | Same as managed shutdown | `capture()` throws `OpenCodeNotReadyError` |
| Repeated or concurrent shutdown (§1.9.3.2) | **No replacement.** The stored child-stop promise is awaited; no second abort or stop | unchanged | unchanged | Unaffected; the epoch they hold still differs from the current one | `capture()` still throws `OpenCodeNotReadyError` |
| Late / superseded discovery | No change; `isAttemptActive` rejects the completion | unchanged | unchanged | Unaffected | Unchanged |
| Attempt initiation after shutdown (§1.9.3.3) | **No replacement.** `beginAttempt()` throws `OpenCodeNotReadyError` before any registration-file I/O and before any probe request | unchanged | unchanged | Unaffected; `isAttemptActive` refuses their completions | `capture()` throws `OpenCodeNotReadyError`, and no attempt can be started that would change it |
| In-flight request (any of the above) | None | None | None | Sends only to its captured origin; a redirect is refused; it is not aborted by shutdown | — |

**One shutdown policy, applied everywhere.** After shutdown begins — in **either** mode — no request
may be *initiated*, including one whose context was captured earlier: the transport reads one
snapshot with `readShutdownState()` (§1.9.3), compares `binding.shutdownEpoch` with its `shutdownEpoch`,
and also refuses on its `shutdownStarted` latch, throwing `OpenCodeContextInvalidatedError`
before any header is constructed. A response that is already in flight may complete, because it
cannot be recalled; that is not permission to send another. A fresh capture throws
`OpenCodeNotReadyError` because shutdown publishes `unresolved` and sets `shutdownStarted`. The
policy is stated once and does not depend on how many times `beginShutdown()` is called: the first
call enacts it and later calls change nothing (§1.9.3.2). §1.5, §3.2, §3.4, §12 and §16 state the
same rule. Nothing in this plan permits a new credential-bearing request after shutdown.

**Initiation includes starting an attempt.** Shutdown is not only a request gate: after the first
`beginShutdown()` there is no new discovery either. `beginAttempt()` reads the same snapshot, sees
`shutdownStarted === true`, and throws before the registration file is touched and before a probe
transport is built (§1.9.3.3). This is what makes "no new attempt after shutdown" a mechanism rather
than an inference from capture — the inference revision 17 relied on was wrong, because discovery does
not capture a request context at all.

**Ordinary transitions do not revoke.** A managed → adopted transition, an adopted → managed
fallback, and a credential rotation all increment `revision` and leave `shutdownEpoch` untouched. A
context captured before such a transition therefore still sends, to *its own* origin with *its own*
credential — which is what RC1, RC2 and RC3 assert. This is the property revision 15 could not
express with a single counter.

**Ownership of the transition.** Managed → adopted installs a target only after the candidate's
trust validation and probe succeed; TBAi never kills an adopted process (§3.3). Adopted → managed
clears the target only on confirmed `lost` or explicit user action, never on a transient failure.
Revalidation that rotates the password keeps the old credential on failure; a merely slow service
does not invalidate a working credential. A late completion from a superseded discovery attempt is
rejected by `isAttemptActive` (§3.2) and cannot install, clear, change the mode, or move either
counter.

**What shutdown does not do.** It does not signal, stop, restart, or otherwise touch an adopted
process; it does not rewrite or delete the registration file; it does not clear or replace the
managed password generated by `runtime.ts`. It replaces the target, moves the epoch **once**, and
leaves in-flight work to finish. A second call does none of that a second time.

### 1.9.7 Race-oriented acceptance tests

**PROPOSED ACCEPTANCE TESTS — NOT IMPLEMENTED, NOT RUN.**

Each test interleaves at a real asynchronous boundary: after `ensureBaseUrl()` resolves, between
capture and fetch, while a response is pending, or after a probe resolves. None describes a state
change inside the synchronous capture call as ordinary concurrency. Each test names the value it
depends on, so a test cannot pass by consulting the wrong counter.

| ID | Interleaving | Assertion |
|---|---|---|
| RC1 | Ordinary transition (adoption **or** fallback) completes **after capture, before send** | The request still **initiates** and uses the captured origin and credential; the other origin receives zero requests; `revision` has moved and `shutdownEpoch` has not; no mixed pair |
| RC2 | Transition completes **before capture** | Capture reflects the new state; the previous origin receives zero new requests; the captured `shutdownEpoch` equals the current one |
| RC3 | Credential **rotation** is in progress when capture happens | Capture reads either the old or the new state, never a mix; `authHeaders` equals the captured credential; after install, new captures use the new password; an in-flight old request may receive 401 but never sends the old password to a new origin |
| RC4 | **Shutdown after capture, before fetch** | Transport throws `OpenCodeContextInvalidatedError`; **zero** requests reach either origin; zero header constructions (spy) |
| RC5 | **Shutdown while a response is pending** | The pending response completes (it is not aborted); the same context cannot initiate another request; a fresh capture throws `OpenCodeNotReadyError` |
| RC6 | **Proxy** captures while the runtime state changes during the upstream fetch | The upstream request goes to the captured origin with the captured credential; no redirect is followed; no cross-origin request |
| RC7 | **Native client and configuration read** use the same contract | Both obtain a context from `captureOpenCodeRequestContext()`; both target the same origin with the same credential; the configuration read has no default transport |
| RC8 | **Deliberately mismatched URL/context pair** (URL A, credential for origin B) | Transport throws `OpenCodeOriginMismatchError` before fetch; zero requests; zero header constructions (spy) |
| RC9 | **Credential isolation, both directions** | In adopted mode the managed password never appears in any request; in managed mode the adopted password never appears; a source scan confirms no second Basic-header constructor |
| RC10 | **Stale / superseded discovery completion** | The late completion cannot install or clear a target, cannot change the mode, and moves **neither** `revision` nor `shutdownEpoch`; the newer state remains |
| RC11 | **Mechanism separation, asserted directly** | Drive managed → adopted → fallback → rotation; assert `revision` increased at each step while `shutdownEpoch` stayed constant; then call `beginShutdown()` once and assert `shutdownEpoch` increased by exactly one and never moves again. Fails if any ordinary transition touches the epoch, or if shutdown touches only the revision |
| RC12 | **Mutation resistance** — the caller keeps the exact object it passed to `installAdoptedTarget()` (and the credential inside it), then mutates after install | Attempt `Object.assign` onto the retained install object and the captured context, direct assignment to `credential.password`, and `Object.defineProperty` on each; capture again and send. Every attempt throws `TypeError` (strict mode) or is silently ignored; `readConnectionState()` still reports the installed password; `capture.credential === binding.credential` (one frozen instance, not two); `authHeaders` and the header the transport sends both equal the installed password; **no request can be sent carrying a mutated or mismatched credential**. Fails if any mutation is observable through the owner or the transport |
| RC13 | **Repeated shutdown** — `beginShutdown()` called twice sequentially and twice concurrently (`Promise.all`), in both modes, with an active attempt and an in-flight request | Across the whole sequence `shutdownEpoch` increases by **exactly one** from its pre-shutdown value and `revision` moves on the first replacement only; the second and concurrent calls perform no replacement and do not reject; the active attempt's `AbortController` is aborted once and stays aborted; in managed mode `stopChild()` is entered once for the published child and every caller awaits the same completion; in adopted mode no signal is sent; an install resolving after shutdown is refused by both the attempt guard and `shutdownStarted`; `capture()` throws `OpenCodeNotReadyError`; the captured-but-unsent request is refused at the transport |
| RC14 | **Re-entrant shutdown** — an abort listener registered on the active attempt's controller calls `beginShutdown()` synchronously during the first shutdown call, in both managed and adopted modes | The re-entrant call returns the **same** completion promise object as the outer call (`===`) and does not throw; the promise the listener observes is the one the outer call returns, proving it was published **before** the abort was dispatched; across the sequence `shutdownEpoch` increases by exactly one, `revision` moves on exactly one replacement, `stopChild()` for the published child is entered **exactly once** (one `WeakMap` entry), and in adopted mode no signal is sent; the shared promise settles on every path — no deadlock, no `undefined` promise, no permanently pending placeholder; when the per-child stop throws synchronously on entry it settles as `{ok:false, error}`, and the construction that makes that catch reliable is RC15's third variant |
| RC15 | **Asynchronous child-stop rejection and the settlement bound** — the joined child stop is injected to (i) return a promise that **rejects** asynchronously, and (ii) in a second run, never settle, with two callers awaiting `beginShutdown()` | Every caller receives the **same** promise object (`===`), including a caller that arrives after the failure; the shared promise **resolves** — `{ok:false, error}` for (i), `{ok:false, reason:"termination_unconfirmed"}` for (ii) — and never rejects; a `process.on("unhandledRejection")` listener installed for the test's duration records **zero** events after a macrotask flush; the failure is logged once with the child's pid; in both runs `shutdownEpoch` moved exactly once and the abort happened exactly once; the listener is removed in `finally`. A third variant injects an operation that **throws before returning anything**: the assertion is that `stopChild()` itself **returns normally** — a `{kind:"started"}` result, not a throw — and that the published shared promise resolves `{ok:false, error}` after one microtask flush, because the operation is invoked inside the scheduled callback of §3.4 step 5 rather than in `stopChild()`'s synchronous body. A test that expects `stopChild()` to throw fails against this construction, and that is deliberate: the pre-return throw still reaches the typed result, it just reaches it asynchronously |
| RC16 | **Re-entrant `stopChild()`, one construction** — synchronous callbacks injected at **three** points: (1) inside the stop operation's own initiation, which runs in the scheduled callback of §3.4 step 5; (2) immediately before the first signal; (3) from a caller that arrives **after shutdown has already published** the child's stop | Each inner call returns the **identical** promise object (`===`), performs **zero** process API calls, and starts no second escalation; the outer call's sequence is the only one. Assert: exactly one entry in the per-child `WeakMap`; exactly one `SIGTERM`; at most one `SIGKILL` decision; exactly one settled outcome observed by every caller; a call made after settlement also returns that same promise with zero further process calls. Point (3) is the join-after-shutdown case: the request must join **before** any eligibility test, so a build that evaluates eligibility first and refuses is caught here. **Shape guard:** the suite also runs point (1) against `new Promise((resolve) => resolve(invokeStopSafely()))` and requires it to **fail** — the executor runs inside the constructor, the re-entrant call finds an empty map, and a second escalation starts — which is what makes "publish, then schedule" testable rather than aspirational. Fails if two distinct promises exist for one child, if the re-entrant caller signals anything, if a post-shutdown caller is refused instead of joined, or if two outcomes are observed |

RC12 exists because revision 16 could not pass it: it froze the outer context while leaving
`target.credential` reachable and mutable through the caller's own object. RC13 exists because
revision 16 stated "exactly one increment" while its `beginShutdown()` performed an unconditional
replacement. RC13 covers sequential and concurrent callers; RC14 covers the **re-entrant** caller an
abort listener can produce, which revision 17's ordering admitted by aborting before the completion
promise existed. RC15 covers the failure mode revision 18 still admitted: it specified a synchronous
throw and left an asynchronous rejection to settle the shared promise by *rejection*, which both
violates "resolves rather than rejects" and can surface as an unhandled rejection. RC16 covers the gap
revision 19 left in `stopChild()`: it memoised the per-child promise in a `WeakMap` but did not state
that the entry is published **before** the first signal, so a caller entering from inside that
initiation could miss the memo and start a second escalation. Revision 20 stated the order but still
admitted a construction in which the promise's executor invoked the stop before publication; revision
21 removes that shape, and RC16's shape guard requires the removed shape to **fail**, so the property is
tested against the defect rather than described in prose. RC16 also gains the caller that arrives
**after shutdown has published** the child's stop: it must join before any eligibility test, so a build
that checks eligibility first and refuses is caught. RC16, RC15 and AT12/AT13 together are mechanisms
now (§1.9.3.1, §1.9.3.2, §3.4), not claims.

RC15's second run is the one that keeps "always settles" honest. A promise that never settles is not
a failure the code can detect; it is a failure the **bound** has to end. Injecting a stop that never
resolves and asserting the typed `termination_unconfirmed` result is what turns "the completion
always settles" from an assertion into a property with a mechanism behind it (§6.5).

RC1 and RC4 are the pair that revision 15 could not satisfy simultaneously. If a future change
reintroduces a single counter and checks it in the transport, RC1 and RC4 must disagree; RC11 fails
first, which is why it exists. RC12 and RC13 cover the two properties revision 16 stated but did not
give a mechanism for: that a retained caller reference cannot alter what is sent, and that a
repeated or concurrent shutdown moves the epoch once. RC14 covers the property revision 17 stated
idempotence for but did not make re-entrancy-safe: that a caller arriving from inside the first
shutdown receives a settled, shared completion rather than a promise that does not exist yet. RC16
covers the same property one level down: a caller arriving from inside the first *child* stop receives
the published per-child promise, so the re-entrancy does not multiply the escalation.

A proposed test is not evidence that the invariant works. B8 remains open until these tests are
implemented and pass.

### 1.9.8 Blocking status (B8)

B8 remains a blocking design issue. This revision makes the proposal internally consistent on
paper — it removes the contradiction that made RC1 and RC4 mutually unsatisfiable, the two properties
revision 16 asserted without a mechanism (runtime immutability, §1.9.3.1, and an idempotent shutdown,
§1.9.3.2), the claim revision 17 made that every start path captured a request context before one
existed (§1.9.3.3), three gaps revision 18 left in its own repair: attempt creation that never
registered or superseded anything (§1.9.3.3), a completion contract that covered a synchronous throw
but not an asynchronous rejection (§1.9.3.2), and a child-cleanup rule that did not say which child a
stop belonged to (§3.4), and three gaps revision 19 left: an ownership rule that gave the child to the
attempt that awaited it although `ensureBaseUrl()` shares one in-flight start promise (§3.2, §3.4),
a `stopChild()` contract that memoised the promise without saying it is published before the first
signal (§1.9.3.2), and a handler expression whose argument was evaluated before the promise existed,
so a pre-return throw escaped (§1.9.3.2), and four gaps revision 20 left: two constructions for one
stop, one of which invoked the stop before the promise could be published (§1.9.3.2, §3.4); an
eligibility condition ("no other path has already claimed it") that put the join behind the
eligibility test and therefore contradicted the later-request join (§3.4); an ownership rule that
required a waiter but named no record of one, so its first condition could not be evaluated (§3.4.1);
and a G4 write that promised to preserve the previous document while overwriting it in place (§9.3).
It still does not prove the runtime invariant. Exit criteria:

1. the connection-state owner, the single capture operation, the separate `revision` /
   `shutdownEpoch` writers, and the shared shutdown-completion publication are implemented, with the
   defensive copy and runtime freeze of every level (§1.9.3.1) and no caller-owned reference retained;
2. RC1–RC16 are implemented and pass without weakening their assertions, including RC11's direct
   assertion of the two counters, RC12's mutation attempts against the retained install object,
   RC13's repeated and concurrent shutdown sequence, RC14's re-entrant caller, RC15's asynchronous
   rejection, non-settling stop and pre-return throw (observed as a settled shared promise rather than
   a throw from `stopChild()`), and RC16's re-entrant `stopChild()` — with promise identity, one
   escalation sequence, a **post-shutdown join** that adds no process call, and a shape guard that
   requires the removed executor construction to fail;
3. `beginShutdown()` is idempotent **and re-entrancy-safe** as specified (§1.9.3.2): a second,
   concurrent or re-entrant call performs no replacement, `shutdownEpoch` moves once, and every such
   caller receives the same completion promise — which settles, resolving and never rejecting, when
   the child stop throws **synchronously including before it returns a value** (the throw is caught in
   the scheduled stop callback, so no caller observes `stopChild()` throwing), when it **rejects**,
   and within the two-phase bound when it never settles at all (§6.5);
4. an independent review confirms that the transport, not caller-built headers, supplies the
   credential on every credential-bearing path (P1–P5), and that the transport consults
   `shutdownStarted` and `shutdownEpoch` only — never `revision`;
5. every **request** path obtains its target from a captured context, not from independent getters,
   and every **discovery or start** path obtains its identity from `beginAttempt()` (§1.9.3.3), never
   from a caller-supplied epoch. A path that needs a target before one exists is a defect, not a
   reason to call capture early;
6. every managed child is stopped **exactly once**, through `stopChild()` (§3.4), in all four cases
   AT12 covers **and** in the shared-start-promise case AT13 covers — where the correct outcome is a
   refusal under condition 1 for the stale attempt, with the binding left intact so the live attempt
   can still publish, and one stop at the child's actual shutdown. A cleanup request that arrives
   after a stop is published must **join** it before any eligibility test and add **zero** process
   calls (§3.4), and no path invokes a process-stop API for a child it does not own;

Until all six hold, implementation approval is withheld. B8 is a **security invariant**: a design
that cannot demonstrate credential/origin pairing, cannot make the captured credential immutable at
runtime, or cannot distinguish "the state moved" from "the process may no longer send", is a real
implementation blocker — not a semantic or "non-traditional" safety concern.

---

## 2. Review item 2 — the registration read

**Status: PROPOSED.** TBAi has no registration reader today: `grep -rn "service\.json|XDG_STATE_HOME" src web/src` returns no production reference (**VERIFIED (code)**, 2026-10-30). Everything below
is a proposed read path for the hybrid runtime.

### 2.1 What TBAi does today

The managed path never reads a registration file. `OpenCodeServerManager` selects its own loopback
port (`allocateLoopbackPort()`), spawns `opencode serve --port <port>`, gates readiness on an
authenticated `/api/info` probe, and returns `http://127.0.0.1:<port>` (`serverManager.ts:309-449`).
The proposed adopted path is additive: it may reuse a service the user already started, but it must
never take over the managed path's spawn/readiness responsibility.

### 2.2 Location, channel naming, and the beta correction

**The client's generic fallback path.** `@opencode/client@2.2.0` resolves an unspecified
registration file to:

```ts
join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"),
     "opencode", "service.json")
```

(`dist/chunks/service-timing-8ye1ye6f.js:25-27`, **VERIFIED (code)**). TBAi's proposed lookup uses
the same fallback — `XDG_STATE_HOME` when set, otherwise `%USERPROFILE%\.local\state\opencode\service.json`
on Windows — and does not invent a second search path.

**The CLI's `filename(channel)` selection.** In the exact `v2.2.0` source
(`packages/cli/src/services/service-config.ts:44-47`, **VERIFIED (code) in the revision that read
the OpenCode checkout**):

```ts
export function filename(channel = OPENCODE_CHANNEL) {
  if (channel === "latest" || channel === "beta" || channel === "next") return "service.json"
  return `service-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`
}
```

**On the upstream citations in this document.** Every `service-config.ts` line range cited anywhere
in this document — here, in §2.5 (§2.5's writer citation), and in §2.7 — is a citation to the
OpenCode repository, not to this repository or to `node_modules`. No OpenCode source checkout is
present in this workspace, so those ranges could **not** be re-resolved during the revision-18
re-audit. Their `VERIFIED (code)` label is the label the revision that read the checkout gave them;
it is not a claim that this revision read them, and §16.3 records them as locally unverifiable.
Citations into `node_modules/@opencode/client` and into this repository were all re-resolved.

Therefore:

1. `latest`, `beta`, and `next` **all use `service.json`**. They share one service, port and
   database by design (upstream comment, `service-config.ts:41-43`), so switching between stable
   and beta keeps the same sessions.
2. Other channel values may receive a **sanitized channel-specific filename**:
   `dev` → `service-dev.json`, `local` → `service-local.json`; any other value has every character
   outside `[a-zA-Z0-9._-]` replaced with `-`.
3. The channel also affects the default port (`channelPort`, `service-config.ts:59-64`): the three
   released channels all use `0xc0de`, `local` uses `0xc0df`, `dev` uses `0xc0e0`, and other
   channels hash into `10_000..59_999`; on Windows ports at or above `0x8000` are moved into the
   `0x7000` block (`service-config.ts:49-57`).

**Correction of an earlier contradiction.** An earlier draft said both that `beta` uses
`service.json` and that a dev/beta channel user would not find the registration at the standard
path. The second half is **false for beta**. The correct statement is: a user of `dev` — or of any
other channel that maps to a distinct filename — may not be found by a standard-path-only lookup.
`beta` is not in that statement, because it uses the same `service.json` as `latest` and `next`.
TBAi does not add a beta-specific search.

**The registration record has no channel field.** `Service.Info` is
`{ id?: string; version?: string; url: string; pid: number; password?: string }`
(`dist/effect/service.js:133-139`; `dist/service.d.ts:41-52`, **VERIFIED (code)**). There is no
`channel`, no `release`, and no stable/beta discriminator. The `id` field identifies a process
instance, not a channel.

**TBAi's exact version gate is a version check, not channel detection.** The managed gate is
`>=2.0.15 <2.2.1` (`src/config/opencode.ts:74-75`), applied by
`isSupportedOpenCodeVersion()` (`src/services/opencode/runtime.ts:76-85`). A released beta and a
released stable that report the same numeric version satisfy the same gate. The upstream
`versionBelongsToChannel()` (`service-config.ts:72-84`) is a **migration** helper for prerelease
versions shaped `0.0.0-<channel>-<number>`; it is not a general channel detector and TBAi must not
reimplement it as one.

**Policy limitation if adoption must be stable-only.** If TBAi requires stable-only adoption, the
currently described registration information **cannot reliably distinguish stable from beta** when
both share `service.json` and the same version. That is a policy limitation, not an implementation
detail. It is recorded as owner decision **D2** (§13) — the stable-only half formerly carried under
H5/B2 — and must not be closed by inventing a channel field or a new detection mechanism. The plan's
default is: adopt whatever the registration describes, subject to version and trust checks, and
state the limitation in the UI copy.

### 2.3 Validation before any credential is used

A registration is a **discovery hint**, never an authority. The proposed read validates, in order,
before constructing any header or making any request:

1. the file exists and is a regular file (§2.4);
2. it parses as JSON and matches the `Service.Info` shape (Effect path) rather than any JSON object
   (§2.7);
3. `url` is an absolute `http:`/`https:` URL with no userinfo, path, query, or fragment; TBAi
   canonicalizes it to a slash-free origin (§8.1). Loopback only (`127.0.0.1`, `::1`, `localhost`)
   unless an owner decision admits remote adoption;
4. `pid` is a positive integer;
5. `password` is present, non-empty, and not whitespace-only (§1.3 refuses it before any network
   request). **PROPOSED PENDING D4** — this step asserts the plan's conservative default, not a
   decided product rule, and not a resolved decision. A password-less design would need a separately
   reviewed authentication design; it must never fall back to TBAi's managed password, an empty
   Basic credential, or an unauthenticated request, and this step is not where such a design would
   be decided;
6. `version`, when present, is inside the managed range; an absent version is not trusted, because
   the probe's `/api/info` response is checked against the same gate;
7. the live `/api/info` probe returns 200, the same `pid`, and a supported version. A registration
   that names a different pid than the live service is refused (the client's own `probeResult`
   requires this, `chunks/service-timing-8ye1ye6f.js:52-63`).

Only after all seven does `installAdoptedTarget(...)` run (§1.9.5). A failure at any step leaves
the previous state untouched. The outcome is **not** a blanket fallback: on startup there is no
previous target, so the managed path runs; during revalidation a previous adopted target is
**preserved** unless the service is confirmed `lost`. §1.5.1 states every case.

### 2.4 File trust, symlinks, and the Windows residual

The read is fail-closed, and the size limit is enforced against the **bytes actually read**, not
against a size reported before the open. A file can grow between a check and a read, and a small
file can be replaced by a large one, so a pre-read size is a cheap early refusal and never the
bound. The sequence is:

1. `lstat` the path. Refuse unless it is a regular file; a directory, device, FIFO, or symlink is
   refused. A size reported here is a **hint** that lets the reader refuse an obviously oversized
   file before opening it. It is not the cap.
2. Open the path **once** and keep the resulting handle. Every later step reads from that handle;
   the path is never re-opened and never re-resolved.
3. `fstat` the opened handle and confirm it is a regular file. A path that was swapped for a symlink
   between step 1 and step 2 shows up here as the object actually opened.
4. Read from that handle **incrementally**, stopping at `registrationFileMaxBytes + 1` bytes. If the
   count ever exceeds `registrationFileMaxBytes`, refuse: the file is larger than a registration
   record can be, and the extra bytes are never parsed.
5. Close the handle in a `finally`, on every outcome — success, validation refusal, size refusal,
   timeout, abort, or a read error.
6. Parse **only** the bytes returned by that handle. `JSON.parse` and the `Service.Info` shape check
   receive that buffer; neither opens the file again, and no second read of the same path exists to
   return different content.
7. Check elapsed time after parsing (a synchronous step the signal cannot interrupt, §2.4.1) and
   refuse the result if it exceeded `registrationReadTimeoutMs`.

**The cap is not the same as a stat size.** Steps 3 and 4 are what make step 1 a hint rather than a
guarantee: the handle's own metadata and the actual read are the authoritative size, and they are
observed on the object that is being read.

**The API this requires — now partly measured.** The sequence needs a read surface that exposes the
opened handle, a `fstat` on that handle, reads from that handle, and cancellation of a pending read.
Capability probes run during revision 19 (`VERIFIED (probe R19)`, §0) — Bun 1.4.4, Node 26.3.0,
Windows x64 — established that `fs.promises.open()` returns a `FileHandle` exposing `stat()`,
`read()`, `write()`, `writeFile()`, `truncate()`, `sync()` and `close()`; that `fh.fd` reads `-1`
after `close()` and a write after close fails with `EBADF`; that a handle opened `"r"` refuses a
write with `EBADF`; and that `lstat(path)` and `fh.stat()` report the same `dev`/`ino` pair for the
same file, so a validated identity can be compared across the two.

Two parts of the requirement remain **unmeasured**: (a) whether an `AbortSignal` cancels a read
pending on that handle, or only abandons it; and (b) Windows behaviour when a handle is closed while
a read is in flight. If either is required and unsupported, the requirement is **unmet** and must be
raised as a limitation in the implementation review — it must not be worked around by re-opening the
path, by trusting a pre-read `lstat` size, or by reading the whole file and truncating afterwards.

**UNKNOWN-1 is not closed by any of this.** Steps 1–6 narrow the window in which a same-user
process can substitute the file; they do not prove the substitution is impossible on every Windows
configuration (below).

#### 2.4.1 Concrete read limits, deadlines, and cancellation

Revision 15 said the read was "bounded" without naming a bound, and §6.5 named a timeout without
saying how a timed-out read is cancelled. Both gaps are closed here. Every value below is a
**proposed** constant in `src/config/opencode.ts`; none exists in the tree today.

| Constant | Proposed value | Applies to | Rationale |
|---|---|---|---|
| `registrationFileMaxBytes` | `65_536` (64 KiB) | the **actual bytes read** from the opened handle (§2.4 step 4) | A `Service.Info` record is a few hundred bytes; 64 KiB leaves room for any legitimate formatting and refuses a file that is not a record. It is also the bound that makes the synchronous parse in step 6 cheap |
| `registrationReadTimeoutMs` | `2_000` | `lstat` + open + `fstat` + bounded read + `JSON.parse` + shape validation + the post-parse deadline check | A local file read either completes in milliseconds or the filesystem is not answering; the client's own probe default is also 2,000 ms, so a slower read would not have produced an adoptable candidate anyway |
| `discoveryProbeTimeoutMs` | `5_000` | the candidate's `/api/info` probe | It is a single loopback request to a service that is already running; it is deliberately **below** the 30,000 ms managed readiness budget because it does not spawn a child |
| `adoptionRevalidateIntervalMs` | `30_000` | the periodic revalidation of an installed adopted target | Frequent enough to notice a lost service, cheap enough not to poll a local socket aggressively |

**Cancellation covers the asynchronous steps, and the cap covers the rest.** Each attempt owns an
`AbortController` (§3.1) whose signal cancels the file operations on the open handle and the probe
fetch. The deadline is enforced by `setTimeout(() => controller.abort(), <deadline>)`, cleared on
completion. When it fires, the pending read is aborted, the `finally` closes the handle, and the
operation rejects; the code does not resolve a race while an unobserved read continues.

**`AbortSignal` cannot interrupt `JSON.parse` or schema validation.** Both are synchronous: once
`JSON.parse` starts, no signal, microtask, or timer runs until it returns. The plan does not claim
otherwise. What bounds them is the byte cap — at most 64 KiB is ever parsed — and what catches an
over-budget result is the elapsed-time check **after** parsing (step 7): if the whole operation has
exceeded `registrationReadTimeoutMs` by then, the parsed value is discarded and the attempt is
refused as `registration_read_timeout`. A synchronous step that overruns therefore produces a
**refusal**, never a late install; it cannot be pre-empted, and it is not described as pre-emptible.

**Handle closure is required on every path, and a close error is not success.** The handle is closed
exactly once, in a `finally`. Whether closing a handle while a read is in flight on Windows can block
or return an error is platform behaviour this plan does **not** measure. If it errors, the error is
part of the refusal — it is never converted into a successful read, and the bytes are not used.

**A typed refusal, never an install.** A `DOMException`/`AbortError`, a size refusal, a close error,
or a post-parse deadline overrun maps to a typed refusal (`registration_read_timeout` /
`registration_too_large` / `registration_read_failed`), which leaves the previous state untouched.

**A timed-out or superseded operation cannot install later.** Two independent controls, both
required: the attempt guard `isAttemptActive` (§3.2) is checked **after** every `await` and before
any state replacement, so a completion that arrives late — whether it timed out, was superseded, or
finished after the first `beginShutdown()` — is refused; and the `AbortController` is aborted on
supersede and by that first shutdown (§3.1), so the operation stops rather than running to
completion. The guard is the authority; the abort is the resource control. Neither is sufficient
alone: aborting without the guard still allows a response that was already buffered, and guarding
without aborting wastes a credential-bearing request.

**Relationship to the existing budgets, stated without conflating them.** The managed readiness
budget is 30,000 ms (`startupTimeoutMs`, `src/config/opencode.ts`), paced by a 250 ms poll
(`readyPollMs`); it covers spawning a child and waiting for it to answer. The adoption budgets are
shorter because they cover requests to a service that is already listening. The OpenCode client's
2,000 ms `probeResult` default is a **client** default used by `discover()`; TBAi's
`registrationReadTimeoutMs` is a separate TBAi-side bound on a TBAi-side read. Neither is a client
option, and §6.4 forbids describing either as configurable through `DiscoverOptions`.

**UNKNOWN-1 — Windows registration-file symlink race.** This is not closed by `lstat`, and the
handle-scoped read of §2.4 does not close it either. On Windows, creating a symlink or junction
normally requires Developer Mode or elevation, but a same-user process can replace the registration
path between the check and the open (a classic TOCTOU), and the resulting identity behavior is
filesystem-specific. No source or probe in this plan proves the race is impossible on every Windows
configuration. The plan adopts the conservative behaviour — `lstat`, one open, `fstat` on the opened
handle, a byte-capped read from that handle, and validation of those exact bytes — and records the
residual as **UNKNOWN**, not as solved. It does not claim that opening a path is atomic, that
`lstat` and `open` observe the same object, or that the handle is the file the `lstat` described.

The registration also contains the plaintext service password (written with mode `0o600`,
§2.5). TBAi treats it as a secret: it is read into memory, never logged, never persisted in TBAi's
database, never returned to the browser, and never included in an error message.

**`0o600` is not proof of an effective Windows ACL.** The writer passes `{ mode: 0o600 }` to
`writeFileString` (§2.5). On Windows that argument does not produce a POSIX permission mask; the
file inherits the ACL of its parent directory, and the effective access is whatever that ACL plus
any inherited entries allow. The source proves the **argument**, not the effective protection. TBAi
therefore treats the registration as readable by the local user's session and takes the secrecy
measures above regardless; it does not rely on `0o600` for confidentiality. A Windows ACL
measurement would be a separate, unperformed verification.

### 2.5 Registration writer behavior (source-verified, not over-claimed)

The `v2.2.0` writer (`service-config.ts:172-181`, **VERIFIED (code)**) does:

```ts
const temp = configFile + "." + process.pid + ".tmp"
yield* fs.makeDirectory(path.dirname(configFile), { recursive: true })
yield* fs.writeFileString(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
yield* fs.rename(temp, configFile).pipe(Effect.retry({ times: 20, schedule: Schedule.spaced("10 millis") }))
```

So the source proves a **temp-file-plus-rename** sequence with mode `0o600` and up to 20 retries at
10 ms intervals. It does **not** prove that the rename yields a new inode on every filesystem, nor
that a concurrent reader always observes either the old or the complete new content. Rename
atomicity is a same-volume filesystem property; Windows `MoveFileEx`-style replacement and SMB or
network paths are not covered by this source reading.

Consequences for TBAi:

- The registration is re-read for each discovery attempt; a stale in-memory copy is never reused.
- A read that fails validation is treated as "no usable registration", not as an error to retry
  forever.
- An external in-place modification (a writer that ignores the temp+rename pattern) is an
  **UNKNOWN** residual: TBAi cannot distinguish it from a legitimate update by content alone. The
  live probe and pid/version checks bound the damage, but they do not make the file trustworthy.
- This plan does not claim a universal "rename gives a new inode" guarantee, and does not build a
  file watcher on that assumption.
- **The `0o600` argument is not an effective Windows ACL.** The source shows the mode passed to
  `writeFileString`; on Windows the resulting access is governed by the parent directory's inherited
  ACL, not by a POSIX mask (§2.4). BT11 asserts the argument, not the platform's effective protection,
  and no test claims the latter.

### 2.6 Timing: what the client exposes (correcting the earlier claim)

The client's `DiscoverOptions` exposes only `file?` and `version?`
(`dist/service.d.ts:16-21`, **VERIFIED (code)**). `EnsureOptions` extends it with `command?`,
`env?`, and `onStart?` (`:25-32`); it has **no public timeout or timing-override field**.
`withEnsureTiming(options, overrides)` is a separate exported helper (`service-timing.d.ts:12`) that
is applied to an options object; it is not a field on `DiscoverOptions`/`EnsureOptions`.

`probeResult(info, timeout = defaultEnsureTiming.requestTimeout)` defaults to **2,000 ms**
(`chunks/service-timing-8ye1ye6f.js:31`; `defaultEnsureTiming.requestTimeout = 2000` in
`chunks/service-timing-xgnj2w4v.js:3-5`). `discover()` calls `registered(options.file)` with no
explicit timeout (`effect/service.js:29-38`), so its probe uses that 2,000 ms default. `ensure()`
passes `timing.requestTimeout` (`effect/service.js:74`). The Promise path's `read()` has **no
supplied signal and no full-operation deadline**: only the probe is bounded by
`AbortSignal.timeout(timeout)` (`chunks/service-timing-8ye1ye6f.js:35`), while the file read is a
bare `readFile` (`promise/service.js:122-133`). TBAi must not describe a caller-configurable
discovery timeout; it can impose its own outer bound around the whole operation, but that bound is
TBAi's, not the client's.

### 2.7 Promise-versus-Effect parsing differences

The two client surfaces do not parse a registration identically:

- **Effect path:** `decodeRegistration = Schema.decodeUnknownEffect(Schema.fromJsonString(Service.Info))`
  (`service-config.ts:37`, an upstream citation — see the note in §2.2) and `read()` uses
  `fs.readFileString(...).pipe(Effect.option)`; a shape mismatch yields `undefined` (no
  registration). The installed package shows the same decode at `dist/effect/service.js:140-146`
  (**VERIFIED (code)** here).
- **Promise path:** `read()` does `JSON.parse(text)` and returns the raw object with **no schema
  validation** (`promise/service.js:122-133`); a syntactically valid but shape-invalid object is
  returned as-is and only fails later when a field is used.

TBAi therefore parses and validates the registration itself, with the same schema on both paths,
instead of relying on a client surface that accepts any JSON object. This is a correctness
requirement, not a preference: a `{url:"...",pid:"not-a-number"}` object must be refused before it
reaches a probe.

### 2.8 Acceptance tests (proposed)

| ID | Test | Assertion |
|---|---|---|
| BT1 | Fallback path resolution | With `XDG_STATE_HOME` set and unset, the reader resolves exactly the client's fallback path; no second path is searched |
| BT2 | Released-channel filename | `latest`, `beta`, `next` all resolve `service.json` (source-level table test) |
| BT3 | Other-channel filename | `dev` → `service-dev.json`, `local` → `service-local.json`, an arbitrary channel is sanitized |
| BT4 | Missing file | No adoption; the managed path runs; zero requests to any registration URL |
| BT5 | Malformed JSON / wrong shape | Refused before probe; zero requests; zero header construction |
| BT6 | Missing, empty, whitespace-only password | `missing_credential`; zero requests (§1.6 A1/A2). **PROPOSED PENDING D4** — the test asserts the current refusal, which is a proposed default and not a decided product rule; no path supplies the managed password or an empty Basic credential instead |
| BT7 | pid mismatch with `/api/info` | Refused; no install; previous state unchanged |
| BT8 | Unsupported / absent version | Refused by the exact version gate; no install |
| BT9 | Non-loopback or non-HTTP(S) URL | Refused before any request; no install |
| BT10 | Symlink / non-regular file | Refused at `lstat` and refused again at `fstat` on the opened handle; the Windows race remains **UNKNOWN** (no test claims it is closed) |
| BT11 | Writer sequence | Source/unit assertion: temp path includes the pid, write mode is `0o600`, rename is retried; no new-inode claim |
| BT12 | Stable versus beta | When both share `service.json` and version, the gate cannot distinguish them; the test asserts the documented limitation, not a fabricated detection |
| BT13 | **Byte cap on actual bytes** | A file larger than `registrationFileMaxBytes` is refused as `registration_too_large`; the reader never requests more than `registrationFileMaxBytes + 1` bytes (byte-count spy); zero probe requests; the handle is closed |
| BT14 | **File grows after `lstat`** | `lstat` reports a size under the cap and the file is then appended to or replaced before the read completes: the cap is applied to the **bytes actually read**, so the oversized result is refused, nothing is parsed, nothing is installed, the handle is closed. A file that grew but stayed under the cap is accepted with the bytes actually read |
| BT15 | **One open, handle bytes, close on every path** | Unit/source assertion: the reader opens the path once, `fstat`s that handle, parses only the buffer that handle returned, never re-opens the path, and closes the handle in a `finally` on success, validation refusal, size refusal, timeout and abort. Fails if a second open of the same path exists, or if `JSON.parse` receives anything but the handle's bytes |
| BT16 | **Post-parse deadline, not an abortable parse** | A read that completes under the cap but whose total elapsed time exceeds `registrationReadTimeoutMs` (injected clock) is refused as `registration_read_timeout`; the parsed value is discarded and nothing is installed. A source review confirms nothing claims `AbortSignal` interrupts `JSON.parse` or schema validation |

All BT tests are **proposed**, not implemented or run.

### 2.9 Legacy database-path evidence (B5) — separate from 2.2.0, and still blocking

**Status: OPEN EVIDENCE GAP. BLOCKING. No evidence exists for any 2.0.15–2.1.x build.**

TBAi's managed gate accepts `>=2.0.15 <2.2.1` (`src/config/opencode.ts:74-75`). Every registration
fact in §2.2–§2.5 was verified against **2.2.0 only**. For **2.0.15 through 2.1.x** this plan has no
evidence about four things that decide whether the hybrid runtime behaves as described:

1. whether that build writes a registration file at all, and at which path;
2. which fields the record carries — in particular whether `password` is present;
3. whether and how `OPENCODE_DB` is honoured (set, unset, relative, absolute);
4. where the database file actually lives, and whether `opencode debug paths db` reports it.

**This is B5, and it is restored to its original meaning.** Revision 15 had reassigned B5 to "does
the TBAi reader agree with the 2.2.0 writer". That different question is now **E1** (§13.2). The
2.2.0 work does **not** close B5, and a passing 2.2.0 test must not be reported as closing it.

#### 2.9.1 What counts as evidence, and what does not

**The database file must be observed at the process, not on disk.** A file that exists at a plausible
path is not evidence that the measured service opened it. A default database left by a previous run,
a file another process created, and a path a separate CLI reports without the service touching it all
look identical to a directory listing. For B5, every record must contain a **process-level
file-activity observation tied to the service's own PID**.

**Required capture fields.** Every record — for unset, absolute and relative `OPENCODE_DB` alike —
carries all of the following:

| Field | What it must contain | Why the field is required |
|---|---|---|
| Build identity | version string as the binary reports it; package/installer artifact name; **package digest** (SHA-256 of the downloaded installer or archive); download date. These are parts 1–2 of the §2.9.2 composite key, plus the recorded download date (part 5) | A row is an artifact, not a version (§2.9.2) |
| Executable identity | the extracted executable's **path relative to the extraction root**, its **SHA-256**, and how the package yields it (archive member path, installer product and version, or `bare executable`). These are parts 3–4 of the composite key. A bare build repeats the digest and says `bare executable`; it never leaves a digest blank | Proves the running image is the artifact named above. A **package digest is not required to equal an inner executable's hash** — an installer, archive or compressed container cannot — but the two must be traceably related, which is what the extraction-provenance field records |
| Service PID — primary | the PID of the **OpenCode service image itself**, established from the OS by resolving the process tree of the launched command (§2.9.1.1), recorded together with the capture method that produced it | Ties the observation to this service **even when no registration file exists**, which is a supported outcome for this range (LB4). A launcher's, interpreter's or shell's PID is **not** this field: a wrapper's PID identifies the wrapper |
| Process tree — launcher to service | every process between the launched command and the service image, with each PID, image name, start time and parent PID, so the resolution from launcher to service is reproducible | A launch through `powershell.exe`, `cmd.exe`, a `.cmd` shim or a version-manager shim inserts processes between the command TBAi ran and the service; without the tree a reader cannot tell which PID the record is about |
| Registration `pid` — corroboration only | the `pid` from the registration record written by **this** run, or the literal `registration absent`, or `mismatch` with both values | The registration is evidence *about that writer*, not the only way to identify the process. A missing file must not make a run unrecordable (the revision-19 defect this row repairs) |
| Process start time | the start time of the **primary** PID as the OS reports it | A recycled PID is otherwise indistinguishable from the measured one |
| Image path and digest | the executable path that the primary PID is running, hashed, compared against the **executable identity** field | Links the running image to its own digest; it is checked against the executable digest, never against the package digest |
| Working directory | the exact directory the launcher started the service in | A relative `OPENCODE_DB` resolves against it; it is recorded, never inferred |
| `OPENCODE_DB` | the value **exactly as supplied**, or the literal word `unset` | This is the configuration under test |
| File event | timestamp with timezone; operation (file open or create, e.g. `CreateFile` with disposition `OpenIf`/`Create`); the path **as the event reports it**; result status (`SUCCESS`); the detail fields showing desired access and disposition | This is the observation; everything else describes its context |
| `debug paths db` | the exact command line and its complete output, captured from the **same artifact** | Reported **separately**; it is a report, never a substitute for the event |
| TBAi ownership resolution | the value `resolveOpenCodeDatabasePath()` (`ownership.ts:124`) returns for the same configuration, and the input it consumed | Reported **separately**; whether these agree is the question B5 asks |
| Canonical comparison | the three paths (event, `debug paths db`, TBAi) after Windows canonicalization, with a same/different verdict and the canonical strings | Equality **after** canonicalization is the finding; raw string equality is not |

**How the tester establishes that the event belongs to the measured service.** Five checks are
recorded, and the first is the one that always applies:

1. **the primary PID is the service image's own PID, not an intermediate process's.** It is
   established from the OS by resolving the launched command's process tree (§2.9.1.1): the record
   carries every hop from the command TBAi ran to the process whose image is the OpenCode executable,
   with each hop's PID, image name and parent PID. A `powershell.exe`, `cmd.exe`, `.cmd` shim or
   version-manager shim between the two is *recorded as an intermediate*, never adopted as the primary
   identity. The record names the capture method and shows its output;
2. the traced PID equals that **service-image PID** in Procmon's Process ID column;
3. when a registration file exists, its `pid` equals the service-image PID. When it does not, the
   record says **`registration absent`** and the OS identity stands alone. A **mismatch** is a
   finding, recorded with both values, and that run does not satisfy B5;
4. that PID's process start time equals the start time the OS reported for the service image, so a
   reused PID cannot be substituted;
5. the image path that PID runs hashes to the **executable digest**. It is **not** compared to the
   package digest; if the artifact is an installer or archive, the record also states how the
   executable was extracted, so the two digests are traceably related without being equated.

**A wrapper changes which PID is recorded, never whether one is.** If the launched command is a shell
or a shim, the launcher's PID exists, the service's PID exists, and the two are different. The primary
identity is always the process whose **image path hashes to the executable digest**; a record whose
"service PID" is the PowerShell/`cmd` PID fails check 5 by construction, because that image is not the
OpenCode executable. When the tree cannot be resolved to a single image matching the executable digest
— zero matches, or more than one — the run records the tree, records the ambiguity, and does **not**
produce a B5 row from it.

The trace is filtered **by process**, not by path. §2.9.1.1 prescribes the one mandatory capture
method and the fields it must produce, because "a process-level event" without a prescribed filter,
window and operation set is not reproducible: two testers can both satisfy the words and produce
records that are not comparable. A directory listing, a file modification time, a file that "looks
right", or a separate `opencode debug paths db` invocation is **not** proof of what the running
process opened. Nor is a missing registration file a reason to abandon the run: the OS identity is the
primary source, and the absence is itself one of the four B5 questions.

**Isolation.** Each run uses a disposable root and its own database file name, so a pre-existing
default database cannot be mistaken for the one under test; the record names the root and carries the
build identity above.

#### 2.9.1.1 The prescribed capture method

**Status: PROPOSED PROCEDURE — NOT PERFORMED. B5 stays blocking until it is, on a real build.**

The method below is **mandatory** for LB2, LB3, LB6 and LB7. A record produced another way is not
accepted as B5 evidence. An alternative source may be used only if the record names it, states which
tool and version produced it, and shows that it yields every field in the §2.9.1 table with the same
attribution — the equivalence is argued in the record, not assumed.

**Tool and privilege.** Process Monitor (Procmon), current release, run **elevated**. A non-elevated
capture will not record file events from a process at a higher integrity level, and a missing event is
indistinguishable from "the service did not open that file".

**Filter: process, and set before launch.**

- The mandatory filter is on **process name** — `Process Name is <image name>`, e.g. `opencode.exe`.
  When two builds share an image name, add `Process Path contains <disposable root>`, which is a
  filter on the *executable's* path, not on the file being opened.
- **A path filter is forbidden as an attribution mechanism.** "Any process opened this path" cannot
  distinguish the measured service from a launcher, an editor, or a leftover process from an earlier
  run — which is precisely the error §2.9.1 forbids. A path filter may be added as a *secondary*
  narrowing filter only alongside a process filter, and only if the record quotes both filters.
- **The filter must be in place before the service starts.** The database open happens during
  startup; a capture that begins after launch can miss the only event that matters and still look
  complete.

**PID attribution, after launch.** A PID cannot be filtered before it exists, so the filter is the
image name and the PID is attributed afterwards. The primary source is the **OS**, not the file, and
the identity resolved is the **service image's**, never an intermediate's:

1. **resolve the process tree, then pick the leaf that is the service.** Record every process the
   launched command produced — parent PID, child PID, image name, image path, start time — until the
   service's own image appears. A launch through `powershell.exe`, `cmd.exe`, a `.cmd` shim or a
   version-manager shim yields at least one intermediate hop; those are recorded as hops and are not
   the identity. The **service-image PID** is the process whose image path hashes to the executable
   digest of the artifact under test;
2. record that PID and its start time as the OS reports them, and record how they were obtained (a
   launcher process handle, a `Get-CimInstance Win32_Process` tree walk, or an equivalent that names
   the tool and version);
3. read `pid` from the registration record **if one was written**. If it exists, compare it with the
   service-image PID and record both. If no file was written, record **`registration absent`** and
   continue — the four B5 questions include whether a registration is written at all, so its absence
   is a measurable result, not a failed run;
4. confirm with the OS that a live process holds the service-image PID, that its image path is the
   artifact under test, and that its start time is the launch time;
5. confirm the captured events carry **that PID** in Procmon's Process ID column — not merely the
   right image name, and not an intermediate wrapper's PID. If the tree resolves to no process whose
   image matches the executable digest, or to more than one, the run records the tree and the
   ambiguity and produces no B5 row.

**Capture window.** Start the capture **before** the launch command and stop it **after** the service
has exited. The record states both timestamps with timezone. A capture stopped before the database
open has no evidence, and a record that cannot state its window is rejected.

**Required operations and status.**

- Required: `CreateFile` events with `Result` = `SUCCESS`. `Detail` is recorded and must include the
  **desired access** and the **disposition** — the disposition is what distinguishes "the service
  created the database" from "it opened one that already existed", and those are different findings.
- Corroborating, recorded but not required: `CloseFile`, `ReadFile`, `WriteFile`, `SetEndOfFileInformation`
  for the same PID and path.
- `PATH NOT FOUND`, `NAME COLLISION` and other failures are **not** evidence of use. They are recorded
  as failures and are never folded into a success claim.
- A `CreateFile` on the same path by a **different** PID is recorded as its own row; it does not
  satisfy B5 for the measured service and must not be cited as if it did.

**Exported fields, one row per event.** Time of day (with the capture's timezone), Process Name, PID,
Operation, Path exactly as Procmon reports it, Result, and Detail. Each event row is accompanied by
the correlation columns: the **service-image** PID and how it was resolved, the recorded process tree
from launcher to service, the registration `pid` or the literal `registration absent`, process start
time from the OS, image path and its SHA-256, the **package** digest and the **executable** digest
recorded separately with the extraction relationship between them, the `OPENCODE_DB` value verbatim or
`unset`, and the exact working directory.

**Retention and review.**

- The filtered export (CSV) is retained **outside the repository**, with its SHA-256 recorded in the
  evidence record; the repository holds the record, not the trace.
- The record quotes the Procmon version and the filter string verbatim.
- A reviewer accepts the row only after checking five things: that the quoted filter is a process
  filter; that the event's PID equals the **service-image** PID resolved from the recorded process
  tree (not a wrapper's); that when a registration file exists its `pid` matches that PID, or the row
  says `registration absent`; that the row's composite build key is complete under §2.9.2; and that
  the event's path, after canonicalization, is the file the record compares against `debug paths db`
  and TBAi's resolution. The image hash is checked against the **executable** digest; a reviewer must
  not reject a package artifact because its digest differs from the inner executable's.

**What the trace establishes, and what it does not.**

- It establishes that the process with **this** PID opened or created **this** path, at **this** time,
  with **this** disposition.
- It does **not** establish what the service would do under another configuration, that this is the
  only file it opened, that no later process touched it, or that the reported path is where the
  database "logically" lives. `debug paths db`, TBAi's ownership resolution and the process event are
  three **separate observations** (§2.9.1), compared only after Windows canonicalization, and none of
  them stands in for another.

The remaining rules are about what else is admissible:

- **Counts:** a **real supported build** inside the range, started by the tester in a disposable
  root with an isolated `XDG_STATE_HOME` / `XDG_DATA_HOME` (and, per run, a defined `OPENCODE_DB`),
  with the observed registration path, record fields, the process-level observation above, `debug
  paths db` output, and resulting database-file location recorded before the process is stopped.
- **The build must be identified, not just versioned.** Each record names the version string as the
  binary reports it, the package artifact and its digest, the extracted executable's digest and how
  the package produces it, and the download date. A package digest and an executable digest are two
  different measurements of two different byte sequences; a record that presents one as if it were
  the other is incomplete. "2.1.x" is not a build; a result for one 2.1.x artifact is a result for
  that artifact only.
- **A relative `OPENCODE_DB` needs the working directory.** The record must state the exact
  directory the service was started in, because a relative path resolves against it. A record that
  gives a relative `OPENCODE_DB` without the working directory cannot be reproduced and is
  incomplete.
- **Does not count:** a shim, stub, or hand-written CLI that reproduces the command surface. A shim
  tests TBAi against TBAi's own assumption; it cannot discover that a legacy build writes a
  different file, omits `password`, or resolves `OPENCODE_DB` differently. Shim-only evidence leaves
  B5 **open**, and must be labelled as shim evidence wherever it appears.
- **Does not count:** a file observed on disk, or a path reported by a separate `opencode debug paths
  db` invocation, presented as proof of what the running service opened. Either may be **recorded**
  — and `debug paths db` must be — but only the PID-tied process event above is evidence of the fact
  B5 asks about.
- **Does not count:** an inference from 2.2.0 source, a changelog claim, or "the schema looks the
  same". Those may be recorded as INFERRED, never as evidence for a specific build.

#### 2.9.2 Current evidence matrix — one row per build, never one row per range

| Build (exact identity) | Registration writer | `OPENCODE_DB` behaviour | Database-path compatibility | Label |
|---|---|---|---|---|
| **`2.0.15`** — **placeholder row, unmeasured.** The exact artifact must be named at run time (version string + artifact + digest + download date). **No artifact is named in this document, and none has been run** | **Not measured** | **Not measured** | **Not measured** | **UNKNOWN** |

**No 2.1.x artifact is named or measured in this document, and there is no 2.1.x row.** `2.1.x` is a
version range, not a build, and this table has one row per **artifact**. When a tester measures a
specific 2.1.x artifact, that artifact gets its own row carrying the version string the binary
reports, the package artifact and its digest, the download date, and its own four observations. Until
then every 2.1.x build stays **UNKNOWN**, and a result for one artifact says nothing about any other —
including another build that reports the same version string but has a different digest. Revision 17
left a literal `2.1.x` row in this table while its own prose said the opposite; the row is removed
here and the statement lives outside the table so the two cannot diverge again.

**One build never stands for another, and the key is a tuple, not a digest.** Revision 20 keyed a row
on the **executable digest** "because that is what runs". That is necessary and not sufficient: two
different packages can carry a byte-identical executable — a repack, a re-signed installer, an archive
built twice with different metadata — and keying on the executable digest alone would collapse them
into one row, discarding the package-level difference that a B5 row exists to record. A row is
therefore identified by the **four-part composite key** below; parts 5 and 6 are recorded for every
row and are explicitly **not** identity parts:

| Part | What it is |
|---|---|
| 1. Reported version | the version string the binary itself reports |
| 2. Package artifact | the downloaded package's file name and its **SHA-256** |
| 3. Extracted executable | the path the executable occupies after extraction, expressed **relative to the extraction root**, and its **SHA-256** |
| 4. Extraction provenance | how part 3 came out of part 2: archive member path, installer product and version, or `bare executable` |
| 5. Download date | the date the artifact in part 2 was obtained — recorded for provenance; it is **not** an identity part, so two runs of the same artifact on different dates are one row |
| 6. Isolation of the run | not an identity part either; recorded per row because one artifact may be measured more than once |

**Two packages with the same executable digest are two rows.** They differ in part 2, and the matrix
records both; a reader may then see that the same bytes arrived in two packages, which is a finding,
not a duplicate to be merged. Conversely, two identical packages measured twice are one row with two
runs recorded under part 6. **Part 1 alone is never a key** — two patched rebuilds can report the same
version string (§2.9.1) — and **parts 2+3 together are the minimum** that distinguishes one artifact
from another when the executable digest alone cannot.

**The bare-executable rule is stated separately, and it is not an exception to the tuple.** A build
that ships a single executable with no package has no part 2 in the ordinary sense: the artifact *is*
the executable. Such a row records `package artifact = <file name>` with the **same** SHA-256 as part
3, `extraction provenance = bare executable`, and the package digest field is **explicitly marked as
the executable's**, never left blank and never implied. That keeps the tuple uniform for every row
while making it impossible to read a bare build as a package whose inner digest was never measured.
Revision 20 recorded "the same value in both digest fields" without saying the row is a bare build;
the label now says so, and LB1 rejects a row that duplicates the digests without that label.

The remaining 2.1.x artifacts stay **UNKNOWN** until measured.

**The table above has no measured row.** `2.0.15` is an explicit placeholder. The rows that matter
for B5 — `2.0.15` and every individual 2.1.x artifact — have **no evidence at all**.

**Historical probe record — outside the exact-artifact matrix.** The 2.2.0 observation is preserved
here with its original label, and it is **not** a row of the table above. It records no artifact
digest, so it cannot satisfy the build-identity rule the table imposes on every row, and it must not
be read as if it did: the version string alone does not identify a build (§2.9.1), two patched
rebuilds can report `2.2.0`, and a result for one artifact says nothing about another. Moving it out
of the table is the correction; inventing a digest for it would be the defect.

| Field | Value |
|---|---|
| Historical label | **VERIFIED (probe R4)** — run during revision 4, in a disposable temp root, against a process this agent started and stopped itself |
| Version reported | `2.2.0`, as the build reported it |
| Artifact digest | **Not recorded.** This observation **does not satisfy** the build-identity rule of §2.9.1 and is not a measured matrix row |
| Registration writer | A registration file was written carrying `id`, `password`, `pid`, `url`, `version`; an unauthenticated `/api/info` returned 401 |
| `OPENCODE_DB` | **Not measured** |
| Database-path compatibility | **Not measured.** TBAi consumes `opencode debug paths db` (**VERIFIED (code)**, `ownership.ts:124-178`); the command's output for that build was not recorded |
| What it supports | That **some** 2.2.0 build writes a registration carrying those fields. It identifies no artifact, says nothing about `OPENCODE_DB` or database paths, and is **not** evidence for B5, which covers 2.0.15–2.1.x |
| What it does not close | E1 (no reader exists to agree with the writer) and B5 (no legacy build measured) both stay open; this record closes neither |

The historical entry is kept because deleting a measurement would be worse than labelling it
incompletely: it is the only evidence this document has that the registration writer exists at all at
2.2.0. It is presented as what it is — an incomplete historical observation — rather than as a row
that satisfied a rule it never met.

#### 2.9.3 Why this blocks

- If a supported 2.0.15–2.1.x build **does not write a registration**, adoption can never happen on
  that version. The plan would then be describing a capability that silently degrades to
  managed-only for a supported range, while the UI implies otherwise (§4.1).
- If a legacy build resolves `OPENCODE_DB` differently from `debug paths db`'s report, two processes
  could open the same SQLite file and the ownership lease (`ownership.ts`) would guard the wrong
  path — a data-integrity risk, not a cosmetic one. A **relative** `OPENCODE_DB` is the sharpest case
  of this: it resolves against the service's working directory, which TBAi does not observe unless
  the record captures it (LB6).

Neither risk can be retired by reading 2.2.0 source. Both require the evidence in §2.9.1 — the
database-path risk specifically requires the PID-tied observation, because a file on disk and a
CLI's reported path cannot distinguish "the service opened this" from "this file happens to exist".

#### 2.9.4 Proposed legacy-database tests (LB1–LB7, NOT IMPLEMENTED, NOT RUN)

| ID | Test | Assertion |
|---|---|---|
| LB1 | Evidence-record shape | A recorded observation for a named build must name the build identity as the **composite key** of §2.9.2 — reported version, package artifact name and SHA-256, extracted executable path and SHA-256, extraction provenance (including the literal `bare executable` where it applies) — the isolation root, the registration path and whether a file was written, and the **service-image** PID together with the recorded process tree that resolves it. A record missing any part is rejected. **A version string without a digest is not a build identity, and an executable digest alone is not a key**: two packages that ship byte-identical executables are two rows, so a record that names only the executable digest is rejected as keyed on the wrong thing. So is a record carrying a single digest without saying whether it belongs to the package or the executable, or one that duplicates the two digests without the `bare executable` label |
| LB2 | `OPENCODE_DB` unset | The database file the service's **own PID** opened (process-level event, §2.9.1) is recorded with its operation and timestamp, and its canonical path equals the canonicalized path reported by `opencode debug paths db` for the same isolated root. The primary identity is the **service-image PID**, resolved from the recorded process tree (§2.9.1.1) and not the launcher's; the registration `pid` is recorded beside it where a file exists — a mismatch is a finding — and `registration absent` where it does not. A record carrying only the command's reported path — with no PID-tied event — is rejected |
| LB3 | `OPENCODE_DB` set to an absolute path | The service's own PID opened the **specified** file (process-level event, with the value recorded exactly as supplied), and TBAi's ownership check targets that same file after canonicalization — not a default location. Either equality may fail, and the failure is the finding. The run stays recordable when the build writes no registration: the **service-image PID** (resolved from the recorded process tree) carries the attribution and the record states `registration absent` |
| LB4 | Build in range writes no registration | The hybrid runtime falls back to the managed path (case 1, §1.5.1) and reports the version as "managed only"; no adoption is attempted. The evidence record for the **same** run is still produced, with `registration absent` and the service-image process identity resolved from the recorded tree, so "writes no registration" is a measurable result rather than a rejected run |
| LB5 | Shim rejection | A shim-based run is tagged `shim`; it is not accepted as closing B5 and the suite fails if a shim record is presented as real-build evidence |
| LB6 | **`OPENCODE_DB` set to a relative path** | The record states, for the same disposable root: the **exact working directory** the service was started in; the `OPENCODE_DB` value exactly as given (relative); the database file the service's **own PID** opened or created, taken from the process-level event (§2.9.1) and **not** from a directory listing; the exact `opencode debug paths db` output; and TBAi's ownership resolution. It then records, after Windows canonicalization, whether those identify **the same file**. The primary identity is the service-image PID resolved from the recorded process tree and the registration `pid` is recorded beside it, or `registration absent`, or as a finding on mismatch. The test asserts that the record is complete and internally consistent — it does **not** assert what the legacy build *should* do, because that behaviour is the unknown being measured |
| LB7 | **Process-level database-file observation, all three configurations** | For each of `OPENCODE_DB` unset, absolute and relative, the record contains every field in the §2.9.1 capture table, including the **service-image** PID and how it was resolved from the recorded process tree (with every launcher/shim hop named), the registration `pid` or `registration absent`, the process start time, the image path hashed against the **executable** digest with the package digest recorded separately under the composite key of §2.9.2, and the file event with its operation, timestamp and verbatim value. The test fails if the primary identity is an intermediate `powershell.exe`/`cmd.exe`/shim PID rather than the process whose image hashes to the executable digest, if the tree is not recorded, if the event cannot be tied to the measured PID by the §2.9.1 checks, if the file was only observed on disk, if the only path available came from a separate CLI invocation, if any of the three configurations is missing, or if a complete run is rejected **solely because no registration file was written** — the OS identity is the primary attribution and its absence is a B5 finding, not a record defect |

LB1–LB7 verify the **record and the runtime's response to it**. They cannot manufacture the missing
measurements: until a tester runs them against real builds, every row in §2.9.2 except 2.2.0's
registration presence stays **UNKNOWN**. A relative-path observation is recorded as observed, not
normalised into an expectation: if a build resolves the relative path somewhere other than the
working directory, that is the finding, and the ownership consequence is recorded with it. LB7 exists
because LB2, LB3 and LB6 could otherwise be satisfied by a file that merely existed — the error
revision 17's wording ("observed on disk") invited. LB4 and LB7 exist in their present form because
revision 19's LB7 tied attribution to "the `pid` in the registration record written by this run",
which made B5's own first question — *does this build write a registration at all?* — impossible to
record: the case in which no file exists had no admissible PID. The primary identity is now the OS's
observation of the **service image's own PID**, established by resolving the recorded process tree and
identifying the process whose image hashes to the executable digest (§2.9.1); the PID the launcher
returned is an intermediate hop, not the identity, and a wrapper (`powershell.exe`, `cmd.exe`, a shim)
changes which PID is recorded but never whether one is. The registration `pid` corroborates the
resolved service PID when present, a mismatch is itself a finding, and its absence is recorded as
`registration absent`.

### 2.10 Lifecycle API boundary (B1)

The official package exposes two different kinds of call, and this plan treats them differently:

- **Lifecycle calls** — the `Service` namespace's `discover()`, `ensure()`, and `stop()`. **They are
  not interchangeable and this plan does not lump them together.** `discover()` reads the
  registration and probes the registered URL; `ensure()` reads, probes, and **may start a service or
  take one over**; `stop()` **signals the registered PID and removes the registration file**. §2.10.1
  states each from the installed source.
- **Generated API SDK calls** — the typed client methods for sessions, messages, tools, permissions,
  config, and everything else the OpenCode feature already uses. These are ordinary request calls.

**B1 is the owner decision to depart from the official lifecycle path**: TBAi proposes a custom
registration reader (§2.3–§2.7) instead of calling `Service.discover()`. That departure is not
approved, and this plan does not assume it is.

**The rule while B1 is open.** The custom registration reader does **not** call lifecycle
`discover()`, `ensure()`, or `stop()`:

- `discover()` — on either surface (§2.10.1) — would reintroduce a second registration read with its
  own parsing and timing semantics (§2.6: no caller-configurable deadline and no caller-supplied
  signal; §2.7: the Promise path performs no schema validation) and then issue a **credential-bearing
  probe request to the URL recorded in that file**. Called on a record TBAi has not validated, it
  would send that record's password to that record's destination — the split §1.9 removes — and it
  would make two authorities for one decision;
- `ensure()` does more than read: it **spawns** `opencode serve --service` when the registration is
  missing or the version does not match, and polls until one answers (§2.10.1). Using it for adoption
  would give the client — and through it TBAi — a process lifetime it does not own, which contradicts
  §3.3;
- `stop()` **signals** the recorded PID (`SIGTERM`, then `SIGKILL`) and **removes the registration
  file**, which contradicts §3.3 and §3.4 and is prohibited without owner approval.

**What is not restricted.** Normal generated API SDK calls are unaffected. `client.ts` continues to
use the generated client for sessions, messages, tools, and config; this plan changes only the
transport it is given (§1.8.3 item 2). The lifecycle restriction is narrow on purpose and must not
be read as a general prohibition on `@opencode/client`.

**The managed path is unaffected either way.** It does not use `ensure()` today: `serverManager.ts`
spawns its own `opencode serve` child and gates its own readiness (§2.1, **VERIFIED (code)**). The
restriction above therefore removes no existing behaviour.

#### 2.10.1 The exact `discover()` surface, and what each lifecycle call does

A declined B1 selects a **route to evaluate**, and the first thing that route must state is *which*
`discover()` it means. The installed `@opencode/client@2.2.0` exports two, and they do not parse the
same way (§2.7). Both are **VERIFIED (code)** against `node_modules` at the baseline commit.

| Surface | Where | What that call does | Registration validation | Timing |
|---|---|---|---|---|
| **Promise** `discover(options)` | `dist/promise/service.js:29-38` | `registered(options.file)` → `read()` (`:122-133`: `readFile(file, "utf8")` then `JSON.parse` in a `try`/`catch` that returns `undefined`) → `probeResult2(info)` → returns `found.endpoint` when the service is `ready`, compatible and version-matched, else `undefined` | **None.** Any syntactically valid JSON object is used; a wrong-shaped record fails later, at a field use | Probe bounded by the helper default (2,000 ms); the file read has **no** signal and **no** deadline |
| **Effect** `discover(options)` | `dist/effect/service.js:29-38` | `Effect.fn("service.discover")` over the same `registered(...)` and the same three gates; returns the endpoint or nothing | The Effect path's `read()` decodes through `Schema.fromJsonString(Service.Info)` (§2.7), so a shape mismatch yields `undefined` | Same helper default for the probe; no caller-configurable deadline; interruption is an Effect concern, not an `AbortSignal` |
| `DiscoverOptions` | `dist/service.d.ts:16-21` | `{ file?, version? }` — the only inputs | — | No timeout, no signal, no timing override (§2.6) |

**What `discover()` actually sends, and what it does not do.** Both surfaces call `probeResult2`
(`dist/chunks/service-timing-8ye1ye6f.js:31-63`), which issues `GET /api/info` against `info.url`
with `headers2(endpoint)` — and `headers2` (`:75-81`) builds a Basic `authorization` value from
`info.password`. So `discover()` **sends the password recorded in the file to the URL recorded in the
same file, bounded only by a default timeout**, and accepts the result only when the returned `pid`
and `version` match the record's (`:52-63`). It does **not** spawn, take over, signal, or stop a
process, and it does not write or delete the registration file.

**`ensure()` is a different call with different effects** (`dist/promise/service.js:39-115`;
`dist/effect/service.js:50-126`). It reads and probes like `discover()`, then:

- on a `reuse` decision, returns the endpoint (`:90`);
- on a `version-mismatch` decision, **calls `stop()` internally** (`:96`) and evicts the old PID;
- when nothing answers, **spawns** `opencode serve --service` contenders (`:56`), announces
  `onStart`, and polls until one is ready (§2.4.1's budgets govern TBAi's own spawn, not this).

**`stop()` is a third call** (`dist/promise/service.js:116-121`, Effect `:127-132`). With
`pty: "handoff"` it first makes
credentialed requests to the running service to hand off or shut down its persistent terminals
(`prepare2`), then `terminate()` (`:162-176`) reads the registration, sends `SIGTERM`, waits, sends
`SIGKILL`, and finally **removes the registration file**.

**Whether the alternative would call `ensure()` or `stop()` is a separate design question, not a
property of `discover()`.** A route that only *finds* an already-running service needs `discover()`
and nothing else. `ensure()` adds spawn and take-over; `stop()` adds signalling, terminal handling and
registration removal. Both contradict §3.3 for a service TBAi did not start, and each would have to
be justified on its own. This plan assumes neither, and declining B1 does not authorize either.

**What each answer to B1 means.** B1 asks one thing: may TBAi depart from the official lifecycle path
and read the registration itself? The answer selects a route. It does **not** select "call
`discover()`" by default, and an approved departure does not imply one.

| B1 answer | What may proceed | What must be accepted first |
|---|---|---|
| **Approved** | The custom registration reader of §2.3–§2.7 may proceed as the proposed route. | Nothing further from the client's lifecycle: the reader owns trust validation, the read deadline, the byte cap, and cancellation (§2.4.1). |
| **Declined** | The official lifecycle route becomes the **alternative to be evaluated** — not an implemented design and not an approved one. Its first obligation is to name **which** `discover()` surface it would use (§2.10.1). | For that surface: a registration read TBAi has not validated — with no schema validation on the Promise path (§2.7), and no caller-configurable deadline or caller-supplied signal on either (§2.6) — followed by a probe that **sends that record's password to that record's URL** before any TBAi trust check has run (§2.3). Separately, and only if the alternative chose them: `ensure()`'s spawn/take-over (and its internal `stop()` on version mismatch), and `stop()`'s signalling plus registration removal. Those are not implied by `discover()` and each contradicts §3.3 for an adopted service. |
| **Open** (current state) | Neither route. | Nothing is approved. The reader does not call lifecycle functions, and no `discover()` wrapper is described as designed or implemented. |

**Approval of the departure is not an approval of `discover()`, and declining it is not an approval
of the reader.** They are opposite routes to the same question. A declined B1 does not make
`discover()` safe by default: naming the surface, accepting the read-probe-to-unvalidated-URL
behaviour, and resolving any `ensure()`/`stop()` use against §3.3 would all have to be written into a
revised plan. Conversely, an approved B1 requires no call to `discover()` anywhere. Revision 16's text
had the approval direction backwards; revision 17 corrected it here and in §4.3, §13.1, §13.4, §14
and §16; revision 18 separates the three lifecycle calls so a declined B1 is not read as accepting
spawn, stop or registration removal.

---

## 3. Adoption attempt lifecycle and ownership

Two operations can outlive the moment that started them: starting the managed server, and probing a
candidate for adoption. Both are asynchronous, both can be overtaken by a newer attempt, and both can
finish after shutdown. The plan gives each one an identity and a single place that decides whether
its completion is still allowed to change state.

**Status: PROPOSED. Nothing in this section is implemented or tested.**

### 3.1 One attempt identity per discovery cycle

Every adoption or start cycle receives a monotonically increasing `attemptId` from a module-private
counter owned by `connectionState.ts`, assigned by `beginAttempt()` (§1.9.3.3) — the **only**
constructor of an attempt. An attempt record's own fields are never reassigned, and `beginAttempt()`
freezes the record with `Object.freeze`; freezing the record freezes its properties, not the
`AbortController` it references, so the controller's internal state is the one thing that still
changes — it is aborted on supersede and by the first `beginShutdown()`:

```ts
type AdoptionAttempt = Readonly<{
  readonly attemptId: number;
  readonly startedAt: number;
  readonly shutdownEpochAtStart: number;   // read by beginAttempt() from its CREATION snapshot (§1.9.3.3 step 1)
  readonly source: "startup" | "manual" | "revalidate";
  readonly controller: AbortController;    // aborted on supersede, and by the first beginShutdown()
}>;
```

A new attempt supersedes every attempt with a lower `attemptId`. Superseding does **two** things, and
both are performed by `beginAttempt()` itself in the one synchronous call that creates the new
attempt (§1.9.3.3 steps 4–5) — not by the caller, and not by a later "install" step:

1. it records the new current id in the module-private slot, which is what actually denies a late
   completion the right to install; and
2. it **aborts** the superseded attempt's `AbortController` (once — guarded by
   `signal.aborted`), which cancels the registration read and the probe fetch (§2.4.1) instead of
   leaving them running.

Because registration and abort happen before the creating call returns, a caller can never hold an
attempt that was superseded before it was handed over: in that case `beginAttempt()` throws
`OpenCodeAttemptSupersededError` rather than returning it (§1.9.3.3). A caller can, of course, hold
one that is superseded *later*, which is why the guard, not the abort, remains the authority.

The abort is resource control; `isAttemptActive` is the authority. Aborting alone is insufficient
because a response already buffered can still resolve, and guarding alone is insufficient because a
superseded probe would keep a credential-bearing request open for no reason. Aborting a probe
against a candidate is harmless to that candidate: it cancels a request, it is not a signal to the
process.

**Shutdown aborts the active attempt once.** The first `beginShutdown()` aborts the controller of
the attempt in the same module-private slot `beginAttempt()` writes — "current" means that slot, not
a second list — after its state replacement and after it has published the shared completion promise
(§1.9.3.2), so a listener that re-enters `beginShutdown()` already finds both. Later calls do not
abort again: the repeat does not reach the abort at all. A listener dispatched by that abort that
calls `beginAttempt()` is refused by the latch and throws `OpenCodeNotReadyError`; it does not get an
attempt whose controller is already dead.

**An attempt cannot be started after shutdown, and the reason is `beginAttempt()`.** Revision 17
justified this by saying every start path captures a context first and capture refuses. That was
untrue for initial discovery, which runs *because* the target is `unresolved` and cannot capture.
`beginAttempt()` (§1.9.3.3) is what actually refuses: it reads the same `shutdownStarted` latch and
throws before any registration-file I/O and before any probe transport is built. `isAttemptActive`
would refuse such an attempt's completions anyway, but only `beginAttempt()` stops the work from
starting. Initial discovery while `unresolved` and not shutting down is therefore possible, and
discovery after shutdown is not.

### 3.2 The `isAttemptActive` guard

`isAttemptActive(attempt)` is the one predicate that gates every completion:

```ts
export function isAttemptActive(attempt: AdoptionAttempt): boolean;
```

It returns true only when all of the following hold at the moment it is called:

1. `attempt.attemptId === currentAttemptId()`;
2. the **shutdown epoch** recorded when the attempt started
   (`attempt.shutdownEpochAtStart`, taken by `beginAttempt()` from its creation snapshot, §1.9.3.3
   step 1) equals the current `readShutdownState().shutdownEpoch` (§1.9.2.1) — an ordinary transition
   does **not** make an attempt stale, and shutdown makes every attempt stale;
3. no newer attempt has been recorded since `attempt` started;
4. `shutdownStarted` is `false`;
5. `attempt.controller.signal.aborted === false`.

Condition 4 is not a second copy of condition 2. The epoch is a number and idempotence is what keeps
it honest (§1.9.3.2); the latch is a boolean that a later refactor cannot wrap, decrement, or compare
to the wrong snapshot. Both are read from the same connection-state snapshot in one call, so they
cannot disagree with each other inside a single check. A completion that arrives after shutdown is
refused by either.

Condition 5 is implied by conditions 1 and 4 today — `beginAttempt()` aborts an attempt only on
supersede, and `beginShutdown()` aborts it only while setting the latch — and it is asserted anyway,
for two reasons. It is the direct expression of "an aborted attempt is finished", so a future path
that aborts a controller without superseding or shutting down cannot leave a live attempt behind. And
it makes a **deadline** abort behave correctly: a read or probe that exceeds its own budget aborts
the attempt's controller (§2.4.1, §6.3), and a timed-out attempt should not then be able to install
a result that had already overrun.

**The record cannot be forged into validity.** `attemptId` comes from a module-private counter that
only `beginAttempt()` advances, so a hand-built object fails condition 1 unless it carries the
current id, and fails condition 2 unless it carries the epoch from the snapshot that produced that id.
The guard does not trust the record's provenance; it checks the values that only the owner can mint.

Every mutating completion calls it **after** its own `await` and **before** it touches the state:

| Completion | Guard position | Effect when false |
|---|---|---|
| Managed server became ready | after readiness resolves, before `installManagedTarget` | The readiness result is discarded, and the completion **requests cleanup** of the child it awaited (§3.4). The request is not authority to stop: it first joins any published stop; otherwise, if a counted waiter holds the child, its start is still unsettled, or an installed target names it, the request records a **pending obligation** with that condition's named trigger (T1, T2 or T3), so the child stays alive and the live path or the trigger decides later |
| Adoption probe returned `ready` | after probe resolves, before `installAdoptedTarget` | Nothing is installed; the candidate is left running; no kill |
| Adoption probe failed | after probe resolves, before any state change | Nothing is cleared; the previous target remains |
| Revalidation returned | after revalidation resolves, before any rotation | The previous credential remains; the result is logged as superseded |
| `lost` was observed | before the fallback transition | No fallback is started for a superseded attempt |

Three rules follow:

- **A probe never kills an adopted process.** TBAi did not start it and does not own its lifetime.
- **A superseded managed attempt asks for cleanup; it does not decide it.** The guard prevents
  installation, not the termination of a process this backend spawned. But "its own child" is not
  always a private object: `ensureBaseUrl()` caches one in-flight start promise
  (`serverManager.ts:309-326`), so two attempts created before that promise settles receive **the
  same** `Subprocess` and the same readiness promise. If attempt A goes stale while attempt B — which
  also awaits that promise — is still valid, stopping the child on A's rejection would destroy work B
  is about to publish. The rejected completion therefore calls `requestChildCleanup()` (§3.4), which
  looks up any existing stop first and only then evaluates the three conditions. When a condition
  fails, nothing is signalled and the request is recorded as a **pending obligation** with that
  condition's trigger — at last-waiter release (T1), at the start's settlement (T2) or when the target
  clears (T3) — so the child remains the live path's to publish or stop and the deferred request still
  has an owner; when a stop already exists, the request joins it whatever the conditions would have
  said. AT13 asserts this case, including the obligation it records.
- **The guard is a synchronous read.** It is checked once, immediately before the state replacement,
  and the replacement itself is one assignment (§1.9.3). There is no check-then-await-then-act gap.

**One shared start promise is not the same claim as one child per attempt.** `ensureBaseUrl()` returns
the single in-flight promise to every caller (`serverManager.ts:309-326`) and `start()` publishes the
child it spawned inside that same call (`serverManager.ts:375-376`), so two attempts that begin while a
start is in flight do not race for two spawns — they receive one child. That removes the "two
simultaneous spawns" case from what the guard must cover, and it introduces the case the guard must
**not** decide alone: whether a stale attempt may stop a child another attempt still needs. §3.4
answers that with manager-level ownership, the start reservation and waiter registry (§3.4.1), the
lookup-first single coordinator with its three conditions and four retry triggers (§3.4); the guard
supplies only the attempt half — this attempt is stale, so it may not publish and may only request
cleanup. The
paths that genuinely overlap independently of that promise are adoption versus revalidation, a restart
after an unexpected exit (`onExit` → `ensureBaseUrl()`, `serverManager.ts:483-519`), and any completion
that arrives after shutdown.

### 3.3 Who owns the adopted server after a successful adoption

After `installAdoptedTarget`, TBAi owns **none** of the adopted server's lifetime:

- it does not stop, restart, signal, or reconfigure the process;
- it does not delete or rewrite the registration file;
- it does not treat the process as a child and does not wait on it;
- its only writes are the ones §9 describes, and those are gated by owner decision **H4** (§13) and,
  technically, **disabled until G4 lands** (§9.3).

Ownership here means "TBAi owns the *binding* to the server", not "TBAi owns the server". The binding
ends when the service is observed as `lost`, when validation fails, or on shutdown. Ending the
binding is a state replacement, not a process action: on shutdown the adopted target becomes
`unresolved`, the epoch moves once, and the process is untouched (§1.9.3.2, §1.9.6).

### 3.4 Who owns the managed child after a fallback

The managed child is always TBAi's own process (§1.9.3, §5). On a confirmed fallback (§1.5.1 rows
6–7):

1. the adopted target is cleared — `revision` +1, `shutdownEpoch` **unchanged** (§1.9.6);
2. `ensureBaseUrl()` starts or reuses the managed child;
3. the managed target is published only after readiness **and** the database-ownership verification
   in `ownership.ts` succeed.

If the managed child cannot start, the connection state remains `unresolved` and new captures throw
`OpenCodeNotReadyError`. It does **not** silently revert to the adopted binding that was just
cleared; that would undo the user-visible fallback decision and reintroduce a stale credential into
a new context.

**A managed child belongs to the manager, not to the attempt that awaited it.** Revision 19 wrote
cleanup as a property of the attempt ("A superseded managed attempt still has to clean up its own
child") and then, one paragraph later, observed that managed starts are serialised through a single
in-flight `ensureBaseUrl()` promise. Those two statements cannot both describe the same run. The
installed module makes the second true and the first false: `ensureBaseUrl()` returns the cached
promise to every caller (`serverManager.ts:309-326`), `start()` spawns once and publishes that one
`Subprocess` (`serverManager.ts:375-376`), and a failed start clears the cache only if it is still the
current promise (`serverManager.ts:417-419`). Two attempts created while a start is in flight hold
**the same child**, so an attempt that goes stale while the other is still valid must not stop it. The
lifecycle is defined at the manager, and revision 22 moved the parts that were still implicit —
acquisition, attribution, settlement and the cleanup decision — into the single owners named below.

- **Identity is the `Subprocess` object**, not a field that points at one. `createChild()` returns it
  (`serverManager.ts:338`). The manager's `this.child` (`serverManager.ts:253`) is the
  **current-child pointer**: assigned at spawn (`serverManager.ts:376`) — *before* readiness, so it
  does not mean "usable" — and cleared on readiness failure, unexpected exit, or shutdown
  (`serverManager.ts:419`, `:496`, `:544`). It is neither the set of children that exist nor a record
  that a target was installed. **"Published" in this plan means a target installed by
  `installManagedTarget` that names the child** — which is why AT12(a) begins "after
  `installManagedTarget`" — and never merely "`this.child` points at it". The pointer is the wrong
  thing to key a stop on, and after revision 22 it is never the thing a stop is keyed on.
- **The manager owns a child from the tick of `spawn()`.** Ownership begins when the manager-private
  `liveChildren` registry is populated **synchronously in the same tick as `spawn()`**, before the
  first `await` of the start runs, and ends when the exit handler removes it. The existing
  `childDiagnostics` `WeakMap` (`serverManager.ts:265`) shows the child object is already the module's
  unit of per-child state; the registry makes membership observable instead of inferable. Publication
  is a **separate** event: it says "this child answers requests", not "this child exists" and not
  "this child may be stopped".
- **An attempt is a consumer with a share, not an owner.** While an attempt is active and awaiting a
  child's readiness, it holds a *waiter* on that child's start (§3.4.1). An attempt that returned
  normally and installed the target is a former waiter whose target points at the published child. A
  stale attempt is a consumer that has lost its share: it may not publish, and its only remaining right
  is to **request** cleanup.
- **One function decides whether a child may be stopped.** `requestChildCleanup(child, request)` is
  the only decision point, where `request` is `{ cause, requester }`, `cause` is
  `"shutdown" | "start-failure" | "fallback" | "attempt" | "manager"`, and `requester` is the
  `AdoptionAttempt` that asked, `"shutdown"`, or `"manager"`. Revision 21 gave `requestChildCleanup()`
  and `stopChild()` each their own eligibility test; revision 22 deletes that duplication. `stopChild()`
  remains the only publisher, and it is now **decision-free**: it is entered only by
  `requestChildCleanup()` (step 4 below), by a path that already holds a published promise (RC16's
  re-entrancy points), and by a test; it never evaluates a condition, so the two entry points cannot
  disagree.
- **Joining an existing stop is a different decision from initiating one, and the lookup comes
  first.** Every cleanup request begins with the memoised stop in the manager-private
  `childStops: WeakMap<Subprocess, Promise<ShutdownResult>>` — the map AT12 and AT13 name. A promise
  found there is returned **identically**, before any eligibility test and regardless of what those
  tests would say, because a request that arrives after a stop is published is a joiner by definition.
  It signals nothing, creates no promise, and is never recorded as a deferral.
- **Only when no promise exists** does the coordinator evaluate the three conditions below, in this
  fixed order. **No condition is a silent refusal any more**: a request that cannot initiate records a
  *pending obligation* with a named future trigger (§3.4.1), so a child cannot be left alive because
  every path assumed another would clean it up.

| # | Condition | It fails when | Deferral trigger |
|---|---|---|---|
| C3 | **No installed target names the child — or the requester is the shutdown path** | a target installed by `installManagedTarget` names this child, and no shutdown has begun | T3 — the target is cleared (fallback or shutdown moves the connection state) |
| C2 | **No unsettled start still names the child** | `startRecords.get(childStartId.get(child))` is `pending`, so the start may still hand the child out | T2 — that start settles (fulfillment or rejection) |
| C1 | **No counted waiter holds the child** | a `WaiterRecord` that is unreleased and belongs to an attempt for which `isAttemptActive` is true still exists | T1 — the last counted waiter is released |

The order is C3, C2, C1 because the target test is the cheapest to state and the shutdown override
applies to it; changing the order would not change the outcome, since all three are read from the same
synchronous state and none of them writes. Condition 1 is only decidable because the manager records
its own answer — `waitersFor(child)` is defined in §3.4.1, not inferred from call sites. Condition 2's
two halves are not the same event:

- **Pending → defer.** The start has not been decided; a stop now would fail it. C2 records T2.
- **Settled and still naming this child → withdraw, then proceed.** A successful start leaves its
  promise resolved and permanently handable, so without withdrawal a later `ensureBaseUrl()` would
  answer with a URL for a child that is about to be signalled. The decision therefore calls
  `withdrawReservation(record, child)` — **one synchronous block, before the stop is published** — and
  only after C3 and C1 have already passed. The block marks the record `withdrawn`, clears
  `currentStartId` and `this.readyPromise` **only if they still name this start** (identity, never
  equality of a value), and detaches the current-child pointer by identity:
  `if (this.child === child) { this.child = null; this.port = null; this.readyAtMs = null }`. Three
  consequences are asserted: a later `ensureBaseUrl()` allocates a **fresh** start instead of
  returning the doomed child; the earlier start's own failure path can no longer clear a newer
  promise, because `this.readyPromise === promise` is false by then; and the stopped child's exit
  takes `onExit`'s early return (`serverManager.ts:484`), so it writes no `opencode.restart` event and
  starts no new start.
- **A rejected start needs no withdrawal** because it was never deliverable; its cleanup request still
  goes through the coordinator, and C2 passes because the record is settled.

  Detaching pointers stops no tracking: the child stays in `liveChildren` until it is reaped, so
  shutdown still sees it and a stop that cannot confirm termination stays visible.

- **Shutdown is the one path that stops every child the manager owns.** It copies `liveChildren`
  synchronously — including a child whose current-child pointer was detached by a withdrawal, and one
  spawned by a keep-alive restart that no target names — and requests cleanup for each with
  `requester: "shutdown"`. That requester **overrides C1 and C2** and satisfies C3, so shutdown needs
  no second condition table: the same coordinator, the same lookup, the same publication. It does not
  set `released` on anyone's records, because the latch makes every attempt inactive (§3.2 condition 4)
  and the records are dropped with their starts.
- **A pending obligation is retried at exactly four triggers**, each of which calls the coordinator
  again with the obligation's original `{cause, requester}` and re-evaluates all three conditions from
  current state:
  - **T1 — last counted waiter released.** Fired by `release()` when a start's waiter set becomes
  empty. During `settleStart()`'s forced release the trigger is suppressed and flushed once after the
    settlement's own cleanup request, so releases never interleave with the decision (§3.4.1).
  - **T2 — the start settles.** Fired after the record's state, releases and cleanup request are
    complete, before the shared promise's outcome is delivered.
  - **T3 — the target is cleared.** Fired by the fallback transition and by `beginShutdown()`; an
    *installation* cannot make an obligation eligible, so it fires no retry.
  - **T4 — shutdown begins.** Fired by the enumeration above, which covers every child in
    `pendingCleanup` even if it has already left a start's waiter set for a reason T1 did not observe.

  An obligation is deleted when it is published, when its child leaves `liveChildren`, when shutdown
  covers it, or when a retry finds the target permanently names the child and the manager is not
  shutting down — in that last case the target owner (fallback or shutdown) is the future owner, and a
  later T3 re-creates the obligation if the target clears. **No obligation is ever dropped without a
  named successor.**

**A start has one settlement owner, and the failure path does not assume anything.** Revision 21 left
the rejection path implying that a failed start had already released its waiters and that the
`start()` catch could clean up by killing the child. Neither is true of the installed code: the catch
kills only for three error types (`serverManager.ts:429-441`) and does not wait for a shutdown that is
already running. Revision 22 makes settlement a single function, `settleStart(record, outcome)`, with
this order, all synchronous except the signal wait that `stopChild()` schedules:

1. **Idempotence first** — if the record is not `pending`, return. A second settlement (a readiness
   rejection racing a shutdown cancellation) does nothing.
2. **State** — `state = "fulfilled" | "rejected"`, `baseUrl` / `outcome` recorded, before anything can
   observe the promise's state change.
3. **Releases on rejection only** — every waiter record of this start is released **with triggers
   suppressed** and its abort listener removed, because a rejected start can never publish and no
   record may keep a child alive after it. A fulfilled start releases nothing here: each waiting
   attempt releases at its own completion point, which is what keeps C1 honest between fulfillment and
   the completion microtasks.
4. **Cleanup request on rejection** — if the record has a child in `liveChildren`,
   `requestChildCleanup(child, {cause: "start-failure", requester: record.owner ?? "manager"})`. C1 is
   empty by step 3, C2 is settled by step 2, and C3 holds because a failed start installed no target.
   The request therefore publishes **one** stop; a child that never spawned produces no request. If
   shutdown already published that child's stop, the lookup returns it and this step joins.
5. **Binding eviction by identity** — `if (this.readyPromise === record.deferred.promise)
   this.readyPromise = null`, and `if (this.currentStartId === record.startId) this.currentStartId =
   null`. A newer start that replaced either field is untouched.
6. **Deliver the outcome last** — resolve or reject the shared deferred. Every awaiting caller's
   continuation therefore runs **after** the state is settled, the waiters are released and the stop
   is published, which is what AT14 asserts; a `catch` that then calls `requestChildCleanup` joins the
   published promise instead of racing it.
7. **Flush T1/T2** — obligations for this start's child are retried once, after step 6's scheduling is
   complete.

**Multiple attempts awaiting one failed start.** Because step 3 releases all of them, none can hold
the child; step 4 publishes exactly one stop; each attempt's own failure completion then requests
cleanup and joins that promise, adding no signal. **A failed start with no waiters** — the
manager-owned keep-alive restart (`onExit` → `ensureBaseUrl()`, `serverManager.ts:506-517`) — takes the
same path with `requester: "manager"`; step 3 releases nothing and step 4 still publishes. **A
shutdown joining an already-published stop** takes the lookup branch and adds nothing, whether it
arrives before, during or after the escalation. Ordering, not the final count, is what AT14 and AT13
assert: at the instant `requestChildCleanup` is entered from step 4, `state === "rejected"`, every
waiter is `released`, and the shared promise is still pending.

**One stop per child, and its promise is published before anything is signalled.** `stopChild(child,
cause)` is the only publisher. Its ordering is part of its contract, because a re-entrant caller can
enter through a signal handler, a process-exit callback, or a test's injected observer:

1. **Look up** `childStops` for a promise under this child. If one exists, return the identical
   promise — before anything else, with no process call and no new promise.
2. **Create a promise that runs nothing.** Capture `resolve` in the constructor and put **no executor
   body that calls a process API or any external callback**: an executor runs synchronously, before
   the constructor returns, so anything invoked there would run *before* step 3 could store the
   promise — the publication order would be broken by construction.
3. **Store the promise in the map**, syntactically before any scheduling call, so a caller re-entering
   at any later step finds it.
4. **Only after storage**, schedule the stop with `queueMicrotask(run)` — never by calling it in the
   executor. `run` invokes the extracted escalation and settles the published promise:
   `try { const op = runStopSequence(child); op.then(settle, (e) => settle({ok: false, error: e})) }
   catch (e) { settle({ok: false, error: e}) }`.
5. **Resolve** the published promise with the documented result — `{ok: true}`, or
   `{ok: false, reason: "termination_unconfirmed", pid}` when the second bound expires — and never
   reject it (§1.9.3.2).

`runStopSequence` is `SIGTERM`, a bounded wait, `SIGKILL`, and a second bounded wait — the first three
are today's `shutdown()` (`serverManager.ts:522-544`, which sends `SIGKILL` at `:542` and does **not**
wait after it), and the final wait is the one the start-failure path already performs
(`serverManager.ts:436-440`). Steps 1–3 are synchronous, contain no `await`, and invoke no process API
and no external callback. That is what makes a second caller unable to start a second signal or
escalation, **including a caller that enters re-entrantly during step 4's initiation**: it reaches
step 1, finds the published promise, and joins it. RC16 asserts exactly this, with a synchronous
callback injected into the first stop's initiation, and it fails against both rejected shapes:
`new Promise((resolve) => resolve(invokeStopSafely()))` runs the stop inside the constructor, before
the map write, so the injected callback re-enters with an empty map and starts a second stop; and
`Promise.resolve().then(() => invokeStopSafely())` enqueues the microtask in the same expression that
creates the promise, so "store before schedule" holds only because every current call site happens to
store on the next statement — a property of the call sites, not of the interface.

**The escalation is extracted, not delegated.** Because today's `shutdown()` acts on `this.child`, a
child the pointer does not name cannot be stopped by calling it: `runStopSequence(child)` is extracted
from that method, so no test may assert a `shutdown()` call as the per-child stop. The second bounded
wait is what makes `termination_unconfirmed` a real outcome rather than "we sent a kill and hoped".
"Stop this child" is therefore idempotent by construction rather than by each caller remembering
whether it already did.

#### 3.4.1 Start acquisition, attribution and settlement

Revision 21 registered a waiter *after* calling `ensureBaseUrl()`, which cannot be correct: an async
function's synchronous prefix runs before its caller receives a promise, so if `start()` ever reached
`createChild()` before its first `await`, the child would exist before any binding or waiter did.
Today the first await is `databaseLease.acquire` (`serverManager.ts:369`), so the window is narrow — but
the protocol must not depend on that line surviving a refactor. Acquisition is therefore a
**synchronous reservation**: allocate, publish, register, then schedule.

**Four manager-private structures plus two registries.** They are private members of the
`ServerManager` instance that already owns `this.child` (`serverManager.ts:253`) and `childDiagnostics`
(`serverManager.ts:265`); nothing outside the manager can read or write them, and none is exported, so
no caller can manufacture a waiter, a start or a binding.

| Structure | Type | Written | Cleared |
|---|---|---|---|
| `startRecords` | `Map<number, StartRecord>` | allocation in `acquireManagedStart()` | rejection with no child, at delivery; otherwise when the start's child leaves `liveChildren` |
| `currentStartId` | `number \| null` | allocation; unchanged on fulfillment | withdrawal by a cleanup decision, rejection eviction, shutdown |
| `startWaiters` | `Map<number, Set<WaiterRecord>>` | registration in `acquireManagedStart()` | the whole entry when the last record is released and the start is settled |
| `childStartId` | `WeakMap<Subprocess, number>` | synchronously at `spawn()` | collected with the child |
| `liveChildren` | `Set<Subprocess>` | synchronously at `spawn()` | the exit handler, when the child is reaped |
| `pendingCleanup` | `Map<Subprocess, PendingCleanup>` | a deferral in `requestChildCleanup()` | publication, the child leaving `liveChildren`, shutdown, or a permanent target owner |
| `childStops` | `WeakMap<Subprocess, Promise<ShutdownResult>>` | `stopChild()` step 3 | never explicitly; collected with the child |

`StartRecord` is `{ startId: number; deferred: { promise: Promise<string>; resolve; reject };
owner: AdoptionAttempt | null; waiters: Set<WaiterRecord>; child: Subprocess | null;
state: "pending" | "fulfilled" | "rejected"; withdrawn: boolean; baseUrl: string | null;
outcome: unknown }`. `WaiterRecord` is `{ attempt: AdoptionAttempt; startId: number;
released: boolean; listener: (() => void) | null }`. A record is **counted as a waiter** only when
`released === false` **and** `isAttemptActive(record.attempt)` (§3.2) is true. The double test is
deliberate and mirrors §3.2's division of labour: the release is the *event* (driven by the abort
signal, which fires synchronously), and `isAttemptActive` is the *authority* (a missed release write
cannot leave a record holding a child for an attempt that is already stale). `waitersFor(child)` is
the set of counted records in `startWaiters.get(childStartId.get(child))`; a child with no entry has no
waiters. `childStartId` attributes a start to the `Subprocess` at `spawn()`, which is the same
synchronous point at which `liveChildren` gains the child.

**Acquisition is one synchronous block.** `acquireManagedStart(attempt: AdoptionAttempt | null):
StartHandle`, where `StartHandle = { startId; promise; child(): Subprocess | null; deliverable():
boolean }`:

1. **Refuse before allocating.** If `attempt !== null` and `!isAttemptActive(attempt)`, throw the same
   typed refusal the caller would otherwise receive (`OpenCodeAttemptSupersededError` or
   `OpenCodeNotReadyError`, per §3.2) — no record, no waiter, no spawn.
2. **Join a deliverable start.** If `currentStartId` names a record that is `fulfilled`,
   `!withdrawn`, has `this.child === record.child`, a non-null `this.port`,
   `liveChildren.has(record.child)` and no entry in `childStops`, register this caller's waiter and
   return its handle. This is the "already-ready server returns instantly" path.
3. **Join an in-flight start.** If `currentStartId` names a `pending` record, register this caller's
   waiter and return its handle. No second start is allocated and no second child can spawn.
4. **Otherwise allocate.** Mint a unique `startId` from a module-private counter, create the deferred
   with an executor that captures `resolve`/`reject` and **does nothing else**, publish it in
   `startRecords`, set `currentStartId`, set `this.readyPromise` to the same promise object, register
   this caller's waiter, schedule `runManagedStart(record)` with `queueMicrotask`, and return the
   handle. Everything before the scheduling call is synchronous; no process API, no file read and no
   `await` occurs in it.

**Registration is part of that block, not a later step.** A `WaiterRecord` is added to both
`startWaiters` and the record's own `waiters` set; a one-shot `abort` listener is attached to
`attempt.controller.signal` that calls `release(record)`. A registration made with an already-aborted
controller stores the record `released: true` and attaches no listener — the attempt never waits, so it
never holds. Registration happens **before** `runManagedStart` can run (it is a microtask scheduled
after the return), so every waiter record for a start exists before its `spawn()`; AT15 asserts this at
the `createChild()` injection point.

**Spawn attribution is one synchronous block too.** `runManagedStart()` re-checks the latch, resolves
the binary, creates the home directory, then `await`s `databaseLease.acquire` — the only pre-spawn
await — re-checks the latch, allocates the port, and calls `createChild()`. On its return, and in the
same tick, it performs exactly:
`liveChildren.add(child); childStartId.set(child, record.startId); record.child = child;
this.child = child; this.port = port;` before `drainStreams`, the exit hook, or the first readiness
`await`. **No later code path populates these fields**, so "the child exists" and "the manager knows
whose start it is" cannot be observed apart. The same block asserts the reservation is still
deliverable: if `currentStartId !== record.startId` or `record.withdrawn`, the child is not adopted by
the pointer and the start is settled as rejected with a supersession cause, so a withdrawal that raced
the microtask cannot publish a child it just retired.

**Delivery is checked, not assumed.** `deliverable()` is the synchronous predicate
`state === "fulfilled" && !withdrawn && child !== null && liveChildren.has(child) &&
this.child === child && this.port !== null && !childStops.has(child)`. An attempt's successful
completion evaluates `isAttemptActive(attempt) && handle.deliverable()` **in the same synchronous
block** as `installManagedTarget`, immediately before it. That is the rule that stops a settled cached
start from handing out a child selected for cleanup: withdrawal flips `withdrawn` and the identity
fields *before* the stop is published, so there is no window in which a `deliverable()` call sees the
old values, and a later `acquireManagedStart()` allocates a fresh start instead of returning the
doomed child.

**Release is idempotent, removes its listener once, and fires T1 only when the set empties.**

| Release point | Where | Note |
|---|---|---|
| Readiness **success** | the attempt's completion, **after** `installManagedTarget` returns | the attempt has published the child; publication is tracked by `target`, not by the record |
| Readiness **failure or refusal** | the completion's failure path, **immediately before** it calls `requestChildCleanup` | order matters: an attempt that released after requesting would be counted by C1 against its own request |
| **Supersession** | the abort listener, dispatched inside `beginAttempt()`'s synchronous abort (§3.1) | the new attempt then registers its own record against the same or a new `startId` |
| **Deadline cancellation** | the same listener — the deadline aborts the controller (§2.4.1, §6.3) | no separate hook is added |
| **Start rejection** | `settleStart()` step 3, with triggers suppressed | a rejected start can never publish, so no record may outlive it; the flush follows the settlement's own cleanup request |

Shutdown's abort of the active attempt is the same signal and therefore the same listener; the latch,
not the listener, is what makes the attempt stale (§3.2).

**Why a failed or superseded attempt cannot invalidate a newer start.** Every mutation of shared state
is identity-guarded and every mutation happens in a synchronous block: the withdrawal checks
`currentStartId === record.startId` before clearing it; `settleStart()` checks
`this.readyPromise === record.deferred.promise` and `currentStartId === record.startId`; the child
pointer is detached only under `this.child === child`; `stopChild()`'s map is keyed by the child
object. There is no read-modify-write across an `await` anywhere in this protocol, so a newer start
cannot be evicted, detached, or stopped by the settlement of an older one.

**Execution trace.** Every step marked *sync* runs in one synchronous block; the only awaits are the
start's own.

| # | Event | What exists at the end of the step |
|---|---|---|
| E1 | **First caller** — attempt A calls `acquireManagedStart(A)` | start 1 allocated; deferred pending and published in `startRecords`; `currentStartId = 1`; `this.readyPromise` is the same promise; A's waiter registered with its abort listener; `runManagedStart` scheduled; **no child, zero process calls** |
| E2 | **Second caller** — attempt B calls before the microtask runs | joins record 1 (step 3); B's waiter registered; same promise object; still no child |
| E3 | **Spawn and registration** — the microtask runs | preflight and `databaseLease.acquire` awaited; latch re-checked; `createChild()` returns; *sync*: `liveChildren` gains the child, `childStartId` maps it to 1, `record.child` and `this.child`/`this.port` are set; then the readiness await begins |
| E4 | **Attempt supersession** — `beginAttempt()` aborts A during readiness | A's listener runs synchronously, releases A (listener removed, set shrinks); B, if still active, remains counted; if no counted waiter remains, C1 is satisfied but C2 still defers until E6 or E7 — **nothing is signalled and no obligation is lost** |
| E5 | **Readiness success** | readiness and the database-ownership verification resolve; `settleStart(record, {ok:true, baseUrl})` sets `fulfilled` and resolves the shared promise (waiters untouched); the completion microtask checks `isAttemptActive && deliverable()`, installs the target, releases its waiter; a last release fires T1, whose retry now fails C3 because the target names the child |
| E6 | **Readiness failure** | `settleStart(record, {ok:false, error})`: state `rejected`; all waiters released with triggers suppressed and listeners removed; one cleanup request (C1 empty, C2 settled, C3 no target) withdraws nothing and publishes one stop; binding evicted by identity; shared promise rejected **last**; A's and B's catch handlers run afterwards and join the published stop |
| E7 | **Shutdown racing the start** — `beginShutdown()` between E3 and E5 | latch set, epoch moved, active attempt aborted (E4's release); `liveChildren` copied synchronously, so the child is enumerated even though no target names it; shutdown's request skips C1/C2 and satisfies C3, withdraws the binding by identity and publishes one stop; `waitForHttpReady` then throws `OpenCodeReadinessCancelledError`, `settleStart` rejects, its cleanup request **joins** the published promise, and the attempt's completion is refused by `isAttemptActive` and also joins |
| E8 | **Shutdown before spawn** — between E1 and E3 | the latch is set while `databaseLease.acquire` is pending; `runManagedStart` re-checks after the await and rejects with `OpenCodeReadinessCancelledError` **before `createChild()`**; settlement releases the waiters, requests no cleanup because there is no child, and shutdown's enumeration found nothing |
| E9 | **A later request or a second shutdown** | the lookup returns the identical promise object; zero process calls; a deferral recorded earlier is either published by its trigger or covered by T4 |

**The spawn-injection test seam.** AT15 subclasses `ServerManager` and overrides the existing
`createChild()` seam. At its **entry** the test asserts, through one protected read-only accessor
(`startStateSnapshot(): ManagedStartSnapshot | null`, no production call site, referenced only from
`tests/`): the record for the returned `startId` exists and is `pending`, `currentStartId` equals it,
the deferred is still unsettled, `childStartId` and `liveChildren` are **empty**, and the waiter set
contains every attempt that has called `acquireManagedStart` so far. At its **return** — after the
attribution block — it asserts the inverse for the child fields and that `childStops` has no entry.
Inside the seam it also calls `acquireManagedStart()` for a second attempt synchronously and asserts it
joins the same start, allocates no second id and, after return, produces no second spawn. A control
build that publishes the reservation only after `ensureBaseUrl()` returns (revision 21's shape) fails
the entry assertion, which is what makes the ordering testable rather than aspirational.

### 3.5 Attempt outcomes (proposed acceptance tests)

**PROPOSED — NOT IMPLEMENTED, NOT RUN.**

| ID | Scenario | Assertion |
|---|---|---|
| AT1 | Two discovery attempts overlap; the older resolves last | The older attempt installs nothing; the newer target remains |
| AT2 | Adoption probe resolves after shutdown | The probe is aborted; nothing installed; the candidate process receives no signal |
| AT3 | Managed readiness resolves after shutdown | The readiness result is discarded and the base URL is not published; the completion requests cleanup of that child, which shutdown already claimed, so it **joins** the running stop — asserted by promise identity (the returned object `===` the store's entry) and by **zero** further process calls, with no eligibility evaluation reaching a refusal — and signals nothing itself; capture still throws. The **count** of stop invocations is AT12's assertion and the shared-child case is AT13's, so this row does not claim "exactly once" for it |
| AT4 | Probe fails for a superseded attempt | The current target is unchanged |
| AT5 | Fallback: managed start fails | State stays `unresolved`; no return to the adopted binding |
| AT6 | Adoption success, then a second `lost` observation | Exactly one fallback transition; no double start |
| AT7 | Revalidation completes after a newer attempt started | No rotation; previous credential stays |
| AT8 | Guard is checked before, not after, the state replacement | Source review: no `await` between `isAttemptActive` and the assignment |
| AT9 | Supersede aborts the older attempt | The older attempt's `AbortController.signal.aborted` is true; its in-flight probe rejects rather than resolving; the newer attempt is unaffected |
| AT10 | **Discovery attempt after shutdown**, with `target: {mode:"unresolved"}` | **(a)** While `shutdownStarted === false`, `beginAttempt("startup")` succeeds, becomes the current attempt, and its `shutdownEpochAtStart` equals the current epoch, so a normal initial discovery is possible without a request context. **(b)** After the first `beginShutdown()`, `beginAttempt()` throws `OpenCodeNotReadyError` **before** any registration-file `lstat`, open or read (spy: zero file operations), **before** any probe transport exists or is called (spy: zero fetch calls), and **before** the attempt counter advances (the id it would have taken is still unused). **(c)** **Latch check under a matching epoch, constructed only through the test seam of §1.9.5.** With the state reader replaced so that it reports the *same* epoch the attempt carries **and** `shutdownStarted: true`, the probe transport throws `OpenCodeContextInvalidatedError` before fetch (zero calls) and before any header construction (builder spy: zero calls). The test asserts, in a comment and in an assertion on the seam's registration, that this input is **not** reachable through the production API — the seam is what makes it constructible, and the invariant under test is that the latch, not the epoch equality, is the authority. **(d)** No candidate service receives a request (zero calls recorded against every candidate origin in the run). **(e)** An attempt created before shutdown is refused by `isAttemptActive` on conditions 2, 4 and 5, its controller is aborted, and a registration read or probe begun with it stops rather than starting new work |
| AT11 | **Re-entrant supersession** — a listener registered on attempt A's controller runs synchronously during the abort that a new `beginAttempt()` dispatches. Variant 1: the listener calls `beginAttempt("manual")`. Variant 2: the listener calls `beginShutdown()` | **Variant 1.** The outer call **throws `OpenCodeAttemptSupersededError`** and returns no attempt; the nested attempt (call it B) is the final `currentAttemptId()`; B is not aborted; A and the discarded attempt are both aborted; each signal dispatches its abort listeners **exactly once** (listener counter per signal: A = 1, discarded = 1, B = 0); `isAttemptActive` is false for A and for the discarded attempt and true for B; a completion carrying the discarded attempt installs nothing and starts no registration read or probe (spies: zero). **Variant 2.** The outer call throws `OpenCodeNotReadyError`; `shutdownStarted` is true and `shutdownEpoch` moved by exactly one; no attempt is both current and un-aborted; a subsequent `beginAttempt()` also throws. Both variants assert that the outer caller never receives a usable-looking attempt for work it may no longer do |
| AT12 | **Exactly one cleanup per managed child** — cases (a)–(d), each counting process-stop invocations per child, not per shutdown call | **(a) Published child:** after `installManagedTarget`, `beginShutdown()` stops it once; a concurrent second `beginShutdown()` joins the same promise and performs no second invocation; a readiness completion rejected afterwards requests cleanup, finds the stop already published, joins it and adds none. **(b) Spawned, never published:** shutdown begins between `spawn()` and readiness; the child is not in `target`, is still stopped exactly once, and a rejected readiness completion adds none. **(c) Superseded managed attempt, no shutdown, no counted waiter:** attempt A alone waits on the start in flight, and a newer attempt B supersedes A **without** ever joining that start. Readiness then resolves successfully, so A's completion is refused by `isAttemptActive`. A releases its record (assert `released === true`, `isAttemptActive(A) === false`, `waitersFor(child)` empty) and requests cleanup. The test first **establishes the state the conditions are about**, because the single cached promise is what made revision 20's version of this case unreachable: the start's promise has **settled** and its record still names the child, and `acquireManagedStart()` returns the cached base URL **without a second spawn** — the hazard the decision must remove. The request then passes all three conditions, **withdraws the reservation in the same synchronous block** (assert `currentStartId === null` and `startRecords.get(startId).withdrawn === true` when the request returns, that a handle taken **before** withdrawal now reports `deliverable() === false`, that the current-child pointer was detached by identity — `this.child === null`, `this.port === null`, `this.readyAtMs === null` when the first signal is observed — and that the next `acquireManagedStart()` allocates a **second** start — spawn counter 2, fresh `Subprocess`, a different `startId`), and only then publishes the stop: assert the child has an entry in `childStops` at the moment the first signal is observed, and that exactly **one** escalation runs. The stopped child's exit must take `onExit`'s early return (`serverManager.ts:484`): the final spawn counter stays **2** and no `opencode.restart` event is written, while the child remains in `liveChildren` until it is reaped. A duplicate later request, and a request made after the stop resolves, each receive the **identical promise object** and perform **zero** further process calls. Fails if eligibility is claimed while the promise can still be received, if the reservation is still deliverable after the withdrawal point, if the stop is signalled before its promise is published, or if the fresh start reuses the doomed child. **(d) Fallback start racing shutdown:** a child spawned by the fallback start is registered before its first `await`, is joined by shutdown exactly once, and no second child is spawned afterwards. Every case also asserts that no path invokes a process-stop API for a child it does not own, and that a request refused by an initiation condition logs the failing condition and signals nothing |
| AT13 | **Two attempts share one in-flight managed-start promise; the older goes stale; the newer publishes the same child** | Both attempts join the shared start while it is in flight — each registers a waiter record against the **same** `startId`, and a spawn spy records exactly **one** spawn; both receive the **same** `Subprocess` object (`serverManager.ts:309-326`). B stays active. A is superseded while readiness is pending, so `beginAttempt()`'s synchronous abort fires A's release listener: assert `waitersFor(child)` now contains **only** B's record and A's has `released === true`. Readiness then resolves; the start settles and its record still names the child. A's completion is refused by `isAttemptActive`, releases again (idempotently) and calls `requestChildCleanup()`. Assert the request is **deferred by C1, not C2**: the record's state is **`fulfilled`** at that moment (asserted directly, so C2 cannot be what deferred it) and `waitersFor(child)` holds B's unreleased record whose attempt `isAttemptActive` reports as active. Assert **zero** signal calls and zero `SIGKILL` for that child, **no** entry for it in `childStops`, **no** withdrawal (`currentStartId` still names the start and `withdrawn === false`, so B can still publish it), one deferral log naming C1, and one entry in `pendingCleanup` carrying trigger T1 — a refusal with a named future owner, not a request silently dropped. B's completion then succeeds and the target is installed **once**, carrying B's attempt id — the stale attempt installs nothing, and the child is alive after both completions. B's release fires T1, the retry re-evaluates C3, finds the target names the child, clears the obligation and records the target owner; assert `pendingCleanup` is empty and nothing was signalled. `beginShutdown()` then stops it **exactly once**; a second `beginShutdown()` and a late duplicate cleanup request add no invocation, so the per-child process-stop counter reads exactly **1** for the whole test. **Control variant:** release B's record before A's request (B superseded too) and the same request passes C1 and initiates — so the test proves the waiter is what blocked the stop, not an unrelated condition. Fails if a stale attempt stops a live child, if A installs, if the deferral is not recorded with its trigger, if the reservation is withdrawn under a counted waiter, or if the count is anything but 1. **This is not AT12(c) restated**: AT12(c) is the no-waiter case where the decision must withdraw and initiate; this row is the shared-waiter case, where the correct answer to the stale attempt's request is *not to stop* |
| AT14 | **Start settlement order on failure** — two attempts await one managed start that then fails; a first control fails before `createChild()`, a second has a newer start allocated before the old one rejects, and a third is the manager-owned keep-alive start with no waiters | The suite records an ordered event log and asserts the exact sequence `settle:state=rejected` → `release:A` → `release:B` → `cleanup:entered` → `stop:published` → `reject:shared`; **at `cleanup:entered`** the record's state is `rejected`, both waiter records have `released === true`, `waitersFor(child)` is empty, and the shared promise is **still pending** (a `.then` flag is set only after the rejection is delivered); each caller's `catch` observes the same rejected outcome after `stop:published`, and a cleanup request made from inside either `catch` returns the **identical** promise object with **zero** further process calls and exactly one `SIGTERM` for the child. **Control 1:** failure before `createChild()` leaves `childStops` empty, sends no signal, clears `currentStartId` and `this.readyPromise`, and still releases both waiters. **Control 2:** start 1 rejects after start 2 has been allocated; assert `this.readyPromise` and `currentStartId` still name **start 2** (identity guard), start 2's waiter is untouched, and start 1's child is stopped without evicting start 2. **Control 3:** the manager-owned keep-alive start (requester `"manager"`, no waiters) publishes one stop on failure, and its settlement releases nothing. Fails if any waiter remains unreleased at settlement, if the promise rejects before the stop is published, if the cleanup runs before the releases, or if an older settlement clears a newer start |
| AT15 | **Acquisition ordering at the spawn injection point** — a subclass overrides `createChild()` and inspects the manager through the read-only `startStateSnapshot()` accessor at entry and at return | **At entry** (before `spawn()`): the record for the advertised `startId` exists and is `pending`; `currentStartId` equals that id; the deferred is unsettled; `liveChildren` and `childStartId` are **empty**; `childStops` is **empty**; and the waiter set already contains **every** attempt that has called `acquireManagedStart()` — including a second attempt that joins before the microtask runs and a third that calls the method **synchronously from inside the seam**, which asserts a join (same `startId`, same promise object, no second record) rather than a second start. **At return**: `liveChildren` and `childStartId` name the child, `record.child`, `this.child` and `this.port` are set in the same block, and `childStops` is still empty. A **control build shaped like revision 21** — register the waiter only after `ensureBaseUrl()` returns — fails the entry assertion with an empty waiter set, which is what makes the ordering executable rather than aspirational. A second control makes a fulfilled start's child have a published stop: `acquireManagedStart()` then allocates a fresh `startId`, the spawn counter increases, and a handle taken before the stop reports `deliverable() === false`. Fails if a spawn can precede the record or its waiter, if the child is attributed in a later tick, or if a second attempt can allocate a second start while the first is pending |

---

## 4. Adoption policy and user-visible surface

**Status: PROPOSED. The policy questions below are owner decisions and are not decided here.**

### 4.1 What the user sees

Three states, described in observable terms:

1. **Managed, ready.** Chat and Code work as they do today. Nothing in the surface names a process.
2. **Adopted, ready.** The same Code surface, backed by the OpenCode service the user already runs.
   No new page is created; the existing OpenCode feature surface shows that it is connected.
3. **Unresolved.** Capture throws; the UI shows a single actionable state ("OpenCode is not
   available") on the existing error surface, not a new dialog and not a new route.

### 4.2 Where the surface lives

The surface extends `web/src/features/opencode/`, which already owns OpenCode UI. No new top-level
route, page, or dialog is introduced by this plan (AGENTS.md, "UI changes — extend surfaces"). The
backend exposes state through the existing `/api/opencode` boundary; the browser does not learn the
password, the registration file path, or the probe result body — only a stable status.

### 4.3 Policy questions left to the owner

These are policy questions. Each is recorded in §13 with its owner-decision ID, and §13.4 gives the
crosswalk to the historical IDs that revision 15 had reassigned.

- **D1** — whether adoption ships at all, or the runtime stays managed-only. *(Revision 15 used the
  ID "B1" for this question; B1 now has its historical meaning again.)*
- **H5/B2** — the adoption-default policy for a fresh install: managed, or "adopt an already-running
  service if one is found". Revision 15's **H1** asked the same question; it is folded in here rather
  than kept as a second ID.
- **H3/B3** — the history and database policy for adopted sessions: whether adopted sessions appear
  in the same conversation list as managed sessions, and how persistence and database ownership
  behave. Revision 15's **H2** is a subset of this and is folded in here.
- **H4** — whether TBAi may write configuration or permissions to an adopted service. This is an
  authorisation question; it does not decide the technical path-safety problem (**G4**, §9.3).
- **D3** — fallback behavior when an adopted service is confirmed `lost`: automatic managed start, or
  an explicit user choice. *(Revision 15 used "B7" for this question; B7 now has its historical
  meaning again.)*
- **D4** — which credential an adopted service is expected to use, and what TBAi does when the
  record does not supply one. **Open.** The refusal in §1.3 is a **proposed default pending D4**, not
  a decision; a decision to support a password-less service would require a separately reviewed
  authentication design, never a fallback to TBAi's managed password. *(This was the credential half
  of revision 15's H3/B3.)*
- **D2** — whether adoption is restricted to stable-channel services, given that the registration
  schema has no channel field (§2.2). *(This was the stable-only half of revision 15's H5/B2.)*
- **B1** — whether the owner approves departing from the official lifecycle path
  (`discover()`/`ensure()`/`stop()`) and using the custom registration reader of §2.3–§2.7 (§2.10).
  **Approving B1 does not approve or require `discover()`**; declining B1 makes the official
  lifecycle route the alternative to be evaluated, and that alternative must first say **which**
  `discover()` surface it would use — the Promise one or the Effect one (§2.10.1) — and must not
  borrow the spawn/take-over of `ensure()` or the signalling and registration removal of `stop()`,
  which are separate calls with separate effects. While B1 is open, neither route is approved.
- **B7** — the pin policy: which `@opencode/client` version and which supported OpenCode service
  range the hybrid runtime pins to, and whether a service outside the managed gate may be adopted.

### 4.4 Non-goals

- TBAi does not supervise, restart, or upgrade an adopted service.
- TBAi does not migrate sessions or configuration between an adopted and a managed service.
- TBAi does not offer a UI to edit the registration file.

---

## 5. Transport and routing after adoption

**Status: PROPOSED.**

### 5.1 Route selection is a read of the captured context

Every credential-bearing path obtains its target from one captured context (§1.9.3). There is no
`if (adopted) { url = adoptedUrl } else { url = managedUrl }` branch at a call site, because that is
the split the plan removes: the URL and the credential would then be read at two different moments.

### 5.2 Browser-facing proxy

The proxy keeps its current contract with the browser: the browser sends the OpenCode path, the
backend forwards it. What changes is that the upstream request uses `context.transport`
(§1.9.4), and the proxy no longer constructs an upstream `Authorization` header or sets
`redirect: "manual"` itself. On a refused redirect it returns a typed 502, strips `Location`, and
cancels the upstream body (§1.8.3).

### 5.3 Directory header

The directory header (`x-opencode-directory`) is not a credential and is unchanged in meaning. It is
built from the resolved conversation workspace and attached per call, exactly as today. The bounded
transport deletes only `Authorization`; it must not delete or rewrite the directory header.

### 5.4 What must not change

- Managed mode's existing request shape (same base URL, same auth, same directory scoping).
- The `@opencode/client` version and its call surfaces.
- The proxy's status mapping and error vocabulary.

---

## 6. Timing and deadlines

### 6.1 Managed readiness budget

`startupTimeoutMs` (30,000 ms) bounds readiness; `readyPollMs` (250 ms) paces probes; the probe is
`GET /api/info` with Basic auth. Readiness means "the server answered", not "the catalogue loaded".

### 6.2 Catalogue window

`msSinceReady()` exists because the provider catalogue loads after `/api/info` answers. Consumers
that need the catalogue bound their wait on that clock instead of inventing a startup heuristic.

### 6.3 Adoption probe budget

The adoption probe reuses the same readiness semantics but is a **discovery** transport (§1.9.5):
it is built from candidate data **and from the attempt that created it**, has its own origin binding,
refuses initiation on the attempt's gate rather than on a caller-supplied epoch, and is never
installed. Its budget is `discoveryProbeTimeoutMs` (5,000 ms, §2.4.1, §6.5), enforced with an
`AbortController`. A timeout is a refusal; it does not install, clear, or rotate anything.

### 6.4 What the client exposes (corrected)

An earlier revision claimed callers could configure the discovery timing. They cannot. Source detail
is in §2.6; the conclusion is:

- `DiscoverOptions` exposes only `file` and `version`.
- `EnsureOptions` does not expose a public timeout or timing-override field.
- `withEnsureTiming()` is a separate internal timing helper, not a public option.
- `discover()` calls `registered(options.file)` without an explicit timeout.
- `probeResult()` uses its own default (2,000 ms).
- The Promise-based registration-file read has no supplied signal and no full-operation deadline.

Therefore TBAi must not describe its adoption budget as "configurable through the client options".
Any budget TBAi wants has to be enforced on TBAi's side, around the call — and this plan proposes
exactly that (§6.5), rather than claiming the client provides it.

### 6.5 Proposed TBAi-side bounds

Revision 15 named three bounds without values and without saying how a timeout cancels anything.
§2.4.1 specifies them. The table here is the summary; §2.4.1 is authoritative for cancellation.

| Bound | Proposed value | Constant | Rationale |
|---|---|---|---|
| Registration read + parse | `2_000` ms | `registrationReadTimeoutMs` | Local file I/O; also the client's own probe default, so a slower read would not yield an adoptable candidate |
| Maximum registration size | `65_536` bytes | `registrationFileMaxBytes` | Applied to the **bytes actually read** from the opened handle; a record is hundreds of bytes, so 64 KiB refuses a non-record without rejecting legitimate formatting, and it bounds the synchronous parse |
| Discovery probe | `5_000` ms | `discoveryProbeTimeoutMs` | One loopback request to an already-running service; below the 30,000 ms managed readiness budget, which includes spawning a child |
| Revalidation interval | `30_000` ms | `adoptionRevalidateIntervalMs` | Detects a lost service without polling aggressively |
| Managed readiness (existing) | `30_000` ms | `startupTimeoutMs` | Unchanged; it bounds spawn plus readiness, not a request |
| Managed child stop: grace | `5_000` ms | `opencodeChildStopGraceMs` | Time between `SIGTERM` and the `SIGKILL` decision. The existing `shutdown()` already escalates this way (`serverManager.ts:522-544`) without naming the bound; naming it makes the shared completion's worst case a number (§1.9.3.2) |
| Managed child stop: kill | `5_000` ms | `opencodeChildStopKillMs` | Time allowed after `SIGKILL` before the per-child stop resolves `{ok:false, reason:"termination_unconfirmed"}`. It bounds the **wait**, and explicitly does not claim the process is gone |

All seven are **proposed**; only `startupTimeoutMs` and `readyPollMs` exist in the tree today. Every
deadline is enforced with an `AbortController` whose signal reaches the actual read and the actual
fetch, so a timeout cancels those operations rather than abandoning them (§2.4.1). The synchronous
parse cannot be interrupted by a signal: it is bounded by the byte cap, and an over-budget result is
refused by the elapsed-time check after parsing. None of these is a client option: the client's
`probeResult` default of 2,000 ms is a separate client-side value (§2.6), and TBAi must not describe
its own bounds as configurable through `DiscoverOptions`.

---

## 7. Platform scope

### 7.1 VERIFIED (code/config)

- `src-tauri/tauri.conf.json` declares only the `nsis` target (a Windows installer).
- `.github/workflows/tauri-build.yml` builds only on `windows-latest` with
  `x86_64-pc-windows-msvc`.

### 7.2 INFERRED

- That the **product** supports only Windows at runtime. No explicit product-support decision
  document was found. The packaging and CI evidence is consistent with Windows-only, and the plan
  proceeds on that assumption.

### 7.3 What the plan does not claim

- It does not claim macOS or Linux are unsupported because CI has no job for them. Absent CI is
  absent evidence, not negative evidence.
- It does not claim the Windows-only scope is an approved product decision.

---

## 8. Canonical origin, reattachment, and the bounded transport

### 8.1 Canonical origin rule

An origin is `scheme://host:port`, lower-cased, with no trailing slash and no path. The adopted
target is installed only with a canonical origin derived from the validated registration data, and
every request's target origin is compared against it (§1.9.4 step 1). A trailing slash, a default
port written explicitly, or a case difference is normalized before comparison so a cosmetic
difference cannot produce a false mismatch — and cannot be used to smuggle a different host past the
check.

### 8.2 Reattachment after TBAi restarts

TBAi re-reads and re-validates the registration on startup; it does not persist an adopted password
across restarts. Reattachment therefore goes through the same validation sequence as first adoption
(§2.3), and a stale or unreadable record leaves the runtime `unresolved` rather than falling back to
a remembered credential.

### 8.3 Loopback only

The adopted base URL must resolve to a loopback host. A registration naming a non-loopback host is a
refusal, because the plan's credential handling assumes the server is local and the plan offers no
transport security for a remote one.

### 8.4 One enforcement point

The bounded transport is the only place that decides "may this credential go to this origin, and may
this request be sent at all". Any new credential-bearing path must go through it; §1.8.4 states the
invariant for future paths (P10/P11) rather than assuming they are safe forever.

---

## 9. Configuration transport and file writes

### 9.1 Read

`readOpenCodeConfigDocument` takes a `fetch`-compatible transport as a **required** parameter and
uses it for `/api/config`. No default transport, so a new caller cannot accidentally read
unauthenticated or through an unbounded fetch.

### 9.2 Write

The write path is a filesystem write to a path supplied by the server's config response; it is not an
HTTP request and cannot redirect. It carries no credential. **Today the target is not validated at
all** (§9.3). The proposal replaces `Bun.write(path, …)` with a validated, exclusively created temp
file and a **create-only commit**: `fs.link(temp, destination)` succeeds only when the destination
does not exist and fails `EEXIST` otherwise (probe R22). Revision 21's replace-rename commit is
**withdrawn**: `rename` resolves the destination by name at commit time with no identity
precondition, so the final check-to-rename window cannot be closed with any exported runtime API, and
a design that replaced a present destination would be claiming a guarantee it cannot implement. A
present destination is therefore refused, and the consequences are recorded as owner decision **D5**
and as a limitation of this revision (§13.1, §12.3, §12.6).

### 9.3 Path validation — a required implementation gate (G4)

**Current state (VERIFIED (code)).** The write path takes `document.path` from the server's
`/api/config` response and passes it to `Bun.write(path, nextText)` with **no root or traversal check**
(`configDocument.ts:584-609`).

**Classification.** This is technical blocker **G4**. It must be implemented and reviewed before any
config or permission write is enabled through the hybrid runtime. Revision 15 called it "a separate,
small piece of work"; that framing is withdrawn, because a deferred fix with unspecified acceptance
criteria is not a safety plan. **H4 does not resolve it**: H4 decides *whether* TBAi may write to an
adopted service, while G4 decides whether a write that is allowed can be proven to stay inside the
service's configuration root.

**Required behaviour of the guard (proposed; not implemented).**

1. **Root resolution.** A single function `resolveOpenCodeConfigRoot()` supplies the root. For a
   managed child it is the config directory TBAi passes in that child's environment. For an adopted
   service it is the config directory the **service itself reports**, never one inferred from the
   path the service asked TBAi to write. If no root can be resolved, the write is refused; TBAi does
   not guess a root from a server-supplied path.

2. **The absolute-path policy, stated before the algorithm.** Revision 18 computed
   `relative = path.relative(root, path.resolve(root, document.path))` and then refused "when the
   relative path is empty, is absolute, resolves to the root itself, or begins with `..`". Two of
   those four conditions describe a relative result, so the check could never reject an **absolute
   input inside the root**: `path.relative` rewrites it to a relative path (measured, probe R19:
   `C:\Root` vs `C:\Root\a\b.json` → `a\b.json`). Revision 18's prose said "an absolute path … is
   rejected" while its algorithm allowed exactly that case — a mismatch between the rule and the
   sentence beside it. The policy is now explicit:

   - **An absolute path inside the root is permitted**, after normalisation. The server's own
     `/api/config` response names the document absolutely, so refusing every absolute input would
     disable each legitimate write and make the guard a switch that only says "no".
   - **An absolute path outside the root is refused.**
   - **Both of revision 18's refusal tests are kept, and they are not redundant.** `path.win32.relative`
     returns a `..`-prefixed path for a same-drive escape (measured: `C:\Root\Cfg` vs
     `C:\Root\Cfg\..\..\evil.json` → `..\..\evil.json`) and an **absolute** path for a cross-drive or
     UNC target (measured: `C:\Root` vs `D:\Root\a.json` → `D:\Root\a.json`; vs
     `\\srv\share\a.json` → `\\srv\share\a.json`). Dropping either test loses one of those cases.

3. **Containment, in order.**

   ```
   rootAbs    = path.resolve(resolveOpenCodeConfigRoot())
   input      = document.path                       // verbatim, never pre-normalised by the caller

   // 3a. Forms that are refused outright, before any resolution (step 4)
   // 3b. Absolute-or-not is decided on the ORIGINAL string
   inputAbs   = path.isAbsolute(input) ? path.resolve(input) : path.resolve(rootAbs, input)
   relative   = path.relative(rootAbs, inputAbs)

   // 3c. Refusals — all before any I/O
   relative === ""                                      // the root itself
   path.isAbsolute(relative)                            // different volume, or UNC
   relative === ".." || relative.startsWith(".." + path.sep)   // escapes the root

   // 3d. The path the guard validates, and the only path the write may use
   validated  = path.resolve(rootAbs, relative)
   ```

   The `..` test is segment-aware on purpose: a file legitimately named `..notes.json` produces
   `"..notes.json"`, which starts with the two characters `..` but is not a parent segment, and a
   naive `startsWith("..")` would refuse it. The value every later step uses is `validated`,
   recomputed from the root and the relative result — never the server's raw string — so a difference
   in case or in separator form between the input and the root cannot produce two competing paths.
   `path.win32.relative` is itself case-insensitive (measured: `C:\Root\Cfg` vs
   `c:\root\cfg\a\b.json` → `a\b.json`), but the guard does not rely on that for its decision: the
   containment question is answered by the three refusals, and the case-folded comparison is only
   ever used to ask "is this the root itself".

4. **Windows forms are refused rather than normalised.** Each rule exists because the probe showed
   the generic containment check failing to cover it:

   | Form | Refusal | Why the containment check alone is not enough |
   |---|---|---|
   | Drive-relative `C:foo.json` | refuse on `^[A-Za-z]:(?![\\/])` | `path.win32.isAbsolute` returns **false** for it. What it means then depends on ambient state: `path.win32.resolve("C:foo.json")` resolved against the process's current directory on drive C — **outside** the root (measured), while the two-argument form `resolve("C:\\Root", "C:foo.json")` appends it — **inside** (measured). A path whose containment depends on which overload the guard happens to call has to be refused before resolution, not classified after it |
   | Rooted without drive `\foo` | refuse | it resolves to the current drive's root, not the config root |
   | Extended-length `\\?\…` or `\\.\…` | refuse | `path.win32.resolve` **preserves** the prefix (measured), so it bypasses normalisation and can address a device namespace |
   | UNC `\\server\share\…` | refuse | correct, but must not depend on step 3c's absolute-result test as an accident; a config root is local |
   | `:` after the drive letter | refuse | `path.win32.relative("C:\Root", "C:\Root\a.json:s")` returns **`a.json:s`** — relative, not `..`-prefixed — so the generic check **accepts** an alternate data stream, and `fs.readFileSync` on such a path reads the stream (measured) |
   | Segment ending in `.` or a space | refuse | Windows strips these at the filesystem level while the strings compare as different paths (measured: `resolve("C:\Root\a.json.")` keeps the dot) |
   | Reserved device names (`CON`, `NUL`, `PRN`, `AUX`, `COM1`–`COM9`, `LPT1`–`LPT9`) | refuse any segment equal to one, with or without an extension | a device target is not a file in the root |

5. **Traversal.** A `..` segment that escapes the root is refused before any I/O, because the check
   runs on the resolved path and not on the string the server supplied. A `..` segment that stays
   inside the root is normalised away and accepted (measured: with root `C:\Root`, the input
   `Cfg\sub\..\a.json` resolves to `C:\Root\Cfg\a.json` and the relative result is `Cfg\a.json`).

6. **Symlinks and reparse points.** Every component from the root to the leaf is `lstat`-ed, and a
   symlink, junction, or reparse point **anywhere** on the path is refused. Three measured facts
   shape this step:

   - A directory junction reports `isSymbolicLink() === true` under `lstat` while `stat()` follows it
     (measured), so the walk detects a junction.
   - `fs.promises.open()` on a junction **succeeds** (measured), so the open cannot be relied on to
     refuse the target.
   - `fs.constants.O_NOFOLLOW` and `O_DIRECTORY` are **undefined** in this runtime on Windows
     (measured), so there is no flag-based protection available. The guard passes `O_NOFOLLOW` when
     the platform defines it and claims no protection where it does not.

   An existing leaf is **not writable in this revision**: if the walk finds the leaf present, the write
   is refused with `ConfigWriteError("replace_unverified")` before any temp file is created. The reason
   is the commit's threat model, not caution. `rename` — the only replacement primitive this runtime
   exports — resolves the destination **by name** when it runs, so a file substituted between the final
   identity read and the rename is the file that is replaced; the window is the interval between the
   last observation of the destination and the rename's own name resolution, and it cannot be removed
   by adding another check before it. Probe R22 measured the relevant surface: `fs.replaceFile` and
   `fs.renameat2` are **undefined**, so no exported API offers a no-replace flag or a
   destination-identity precondition, and `fs.rename` over a **substituted** destination replaced the
   substituted file. The only atomic create-only operation available is `fs.link`, which applies to an
   **absent** destination. The guard therefore creates a document that does not exist and refuses to
   replace one that does; **D5** records the owner decision to accept that limit or fund a native
   conditional-replacement mechanism, and G4 stays **BLOCKED** either way.

   The `dev`/`ino` pair is no longer a commit-time guard, because no commit ever crosses an existing
   file. The R20 discrimination evidence is retained as the record of what the pair can prove — two
   distinct files carried **different** `ino` values on the same `dev` (5629499534643254 vs
   6192449488064567, `dev` 1660652331), a hard link reported the **identical** pair, a deterministic
   substitution between two reads produced **`differ = true`**, and a no-substitution control produced
   **`differ = false`** — and it stays relevant to UNKNOWN-1's reparse residual (§12.4), not to this
   write path. R21's further measurement stands as the reason the replacement design was withdrawn: an
   in-place rewrite at the same path keeps the **same** `ino`, so identity cannot detect a lost update
   either (§9.3 step 7i).

   **The initial-ENOENT → create race is a different race, and it is closed.** Between the validation
   `lstat` (which must report `ENOENT` for a writable leaf) and the commit, another process can create
   the destination. `fs.link` answers **`EEXIST`** in exactly that case (probe R22: an observed absence,
   then a created invader, then `link` → `EEXIST`, with the invader intact), so the commit is a
   compare-and-create that succeeds only while the name is still free. There is no check-then-act window
   because there is no separate check: the creation **is** the check.

7. **Write through a validated temp file, and commit by create-only link.** The destination is never
   written in place and never replaced. An in-place write of any kind — `"r+"`, `"w"`, or a
   complete-write loop — cannot preserve the previous document if it fails after the first byte has
   landed, so revision 20's promise that "the previous document remains intact" was not a consequence
   of its algorithm. The write is two files and one atomic **create-only** commit, with a single
   defined commit point:

   - **a. Temp path, constructed and validated.** `tempPath` is `validated` plus a
     `.<random>.tbai-tmp` suffix, in the **same directory** as `validated`. The name is generated by
     TBAI, never supplied by the server, and contains no separator; it is checked against the same
     Windows form rules as step 4 before use. Same-directory placement is required because the commit
     is a hard link and a hard link cannot cross a volume; it also keeps the temp inside the
     containment root that step 5 already validated. (Revision 21's rename-based path measured that a
     rename from a subdirectory of the same volume also succeeded, which is why the restriction was
     stated as a rule rather than inferred from the filesystem's tolerance.) The temp is not a new
     containment question, but it is re-checked as one rather than assumed.
   - **b. Create it exclusively.** `await fs.promises.open(tempPath, "wx")`. Probe R21 measured this
     failing with **`EEXIST`** on an existing path (consistent with R19), so a stale temp cannot be
     silently appended to. `EEXIST` is retried a bounded number of times with a fresh name, then
     fails as `ConfigWriteError("temp_create")`.
   - **c. Write completely, then truncate, then sync, then close — all on the temp handle.** One
     write call is not assumed to write the whole buffer; the loop advances by `bytesWritten` from an
     explicit offset:

     ```
     let offset = 0
     while (offset < buf.length) {
       const { bytesWritten } = await fh.write(buf, offset, buf.length - offset, offset)
       if (bytesWritten <= 0) throw new ConfigWriteError("short_write")  // zero progress is failure
       offset += bytesWritten
     }
     await fh.truncate(buf.length)   // final length is asserted, not implied
     await fh.sync()
     ```

     `bytesWritten === 0`, a short write that never reaches the end, and a rejected write are all
     **failures**, never a shorter document. `truncate(buf.length)` is kept even though a freshly
     created temp should already be exactly that long: it is the assertion that the file's length is
     the document's length, and its failure aborts the write. `sync()` forces the bytes to the volume
     before the commit; its failure aborts too. `close()` runs in a `finally`. **Every failure in this
     stage happens before the destination has been opened, linked, or truncated**, so the previous
     document is preserved by construction rather than by rollback.
   - **d. Confirm absence, then commit by creating the name.** The destination was absent at
     validation, so the pre-commit check is not an identity comparison: `await
     fs.promises.lstat(validated)` must still throw `ENOENT`, and a present destination is
     `ConfigWriteError("destination_appeared")`. Immediately after that check the test seam
     `beforeCommit` runs — a no-op in production, an injection point only in CT8 (§11) — and then the
     commit is `await fs.promises.link(tempPath, validated)`.
     `link` creates a second directory entry for the temp's inode, atomically: it either succeeds or
     fails, and it fails **`EEXIST`** whenever the name exists, whoever created it (probe R22). After
     success the destination names the same `ino`/`dev` as the temp; the temp is then unlinked and the
     destination's link count returns to 1 (probe R22: `nlink` 2 → 1, bytes intact, `ino` stable).
     **That is the commit point.** Before it the destination does not exist and the new bytes exist
     only under the temp name; after it the destination exists with the new document, and the temp
     name is gone. Success is reported **only** after `link` returns. There is no partial state to
     report, because a directory entry is created whole.
   - **e. What the commit guarantees, and what it does not.**
     - A write can create a document that did not exist. It **cannot destroy an existing document**,
       because it never replaces one: the only way to reach an existing name is `EEXIST`, which is a
       typed failure (`ConfigWriteError("destination_appeared")`) and leaves whatever created the name
       byte-identical (probe R22). Revision 21's sentence that "both outcomes of a permitted/refused
       rename preserve the old document" is withdrawn with the replacement path itself: on the
       create path there is no old document to preserve, and on the refusal path the document belongs
       to the concurrent creator and is not touched.
     - A **filesystem that cannot hard-link** — some FAT and network configurations — fails
       `EPERM`, `ENOTSUP` or `EXDEV`, reported as `ConfigWriteError("link_unsupported")`. There is no
       rename fallback, because a fallback would silently restore the unclosable replacement race.
       Whether the config directory of a given installation supports hard links is **UNKNOWN** to this
       plan; the guard fails closed and records the error.
     - The temp is removed best-effort after a successful link (`rm(tempPath, {force: true})`,
       measured to succeed). A cleanup failure is logged with the path and does not turn a success
       into a failure, because the destination is already complete. If the process dies between the
       link and the unlink, the destination is complete and one extra hard link remains under the
       temp name (§7j).
   - **f. The ACL contract for the create path.** Because the destination is new, there is no prior
     security descriptor to preserve. The requirement is to **prove** that the new file's protection
     is exactly what the directory grants, and to fail closed when that cannot be shown:
     1. **Read the descriptor** of the temp file before the link, in SDDL form —
        `(Get-Acl -LiteralPath <temp>).Sddl` through PowerShell — because SDDL is machine-readable and
        locale-independent. `icacls` is used only as a cross-check: its inheritance marker is
        locale-dependent, and probe R22 measured its `(I)` markers disappearing after
        `icacls /inheritance:d` while the underlying SDDL ACE list kept the same three entries with
        their flags changed, so it cannot be the decision source.
     2. **Distinguish explicit from inherited.** Parse the SDDL ACE list and classify each ACE by its
        inherited (`ID`) flag. Probe R22 measured a freshly created temp under a directory with
        inheritance enabled: **3 ACEs, all `ID`**; the same file after inheritance was disabled
        reported 3 ACEs with **no** `ID` flag. The classifier therefore sees the difference rather
        than assuming it.
     3. **Compare with the expected set** — the parent directory's ACEs that carry object/container
        inherit flags, in their propagated form. The temp's set must equal it.
     4. **Any explicit ACE on the temp is a failure** (`ConfigWriteError("acl_explicit_unexpected")`):
        TBAi created the file and it must inherit only. The temp is removed and no destination is
        created.
     5. **An unreadable or ambiguous descriptor is a failure** (`ConfigWriteError("acl_unverifiable")`)
        — PowerShell unavailable, a non-zero exit, unparsable output, or an ACE form the parser does
        not recognise. This is a **fail-closed** requirement: no "log and continue" variant is
        permitted, because the file would carry protection nobody inspected.
     6. **Effective-ACL verification is the comparison in 3.** TBAi does not impersonate the service,
        so "effective" is defined as "the ACE set the directory's inheritance produces". The
        post-commit file is the **same inode** as the temp (a hard link), so the descriptor measured
        in step 1 is the descriptor of the delivered file; the identity is confirmed by asserting
        `lstat(validated).ino === tempIno` and the same `dev` after the link, rather than by
        re-reading the ACL. The ACL read runs after the last write and before the link, so a failure
        leaves the destination absent.
     7. **What this does not claim.** The ACL is **not preserved from a previous document**, because
        this revision performs no replacement. A directory with inheritance disabled can propagate an
        empty set, and an empty set is accepted as a deterministic outcome — the plan does not claim
        such a file is protected. ACLs changed **after** the commit by another process, and any ACL
        effect of the service copying or rewriting the file, are outside the guard. The measurement
        covers one NTFS volume on one machine.
   - **g. Cross-process handles are outside the create path's threat model.** Revision 21's
     replacement could be refused by an open handle on the destination; R21 measured `EPERM` for a
     same-process handle and left a **different** process UNKNOWN. The create-only path never opens,
     truncates, or replaces an existing destination, so an open handle on an existing document cannot
     affect it: the only interaction is `link`'s `EEXIST`, which a handle does not change. The
     UNKNOWN is retained for the withdrawn path — if a later revision reintroduces replacement, both
     the check-to-rename race and the cross-process handle question return with it, and neither is
     measured.
   - **h. No directory durability claim.** Probe R21 measured `open` + `sync` on a **directory**
     failing with **`EPERM`**, so the plan does not claim that the created entry is durable across a
     crash before the parent directory is flushed — it cannot flush it. The commit point is defined
     for observing processes; crash durability of either the link or the unlink is not claimed.
   - **i. What the probes measured, and what they did not.** Under the revision-20 probe, `fh.write`
     returned `bytesWritten` equal to the requested length every time (6 of 6); two successive
     2-byte writes at advancing offsets produced exactly `"abcdef"`; and a write at offset 9 past a
     6-byte file extended it to length 10 with a NUL gap. **No short write occurred in this
     environment**, so the loop guards a case the probe did not produce; that is precisely why CT8
     injects deterministic failures instead of waiting for one (below). Revision 20 also measured
     that `fh.writeFile("xyz")` on `"0123456789"` leaves `"xyz3456789"`, and that `fh.write` followed
     by `fh.truncate(3)` yields `"xyz"` — the reason a complete write needs an explicit truncate
     instead of `writeFile`. Revision 22 measured the commit: `link` into an absent name succeeded
     with identical `dev`/`ino` and `nlink` 2, the destination read the payload after the temp was
     unlinked, and `link` onto an existing name failed **`EEXIST`** with that file intact. R21's
     in-place-rewrite measurement still stands as a limit on what identity could ever prove: an
     overwrite at the same path keeps the **same** `ino`.
   - **j. Stray temp files are a named residue.** A process that dies between (b) and (d) leaves one
     `*.tbai-tmp` file in the config directory. It is not cleaned up by a later write (no directory
     sweep is proposed, because a sweep is another directory-listing path with its own validation
     rules), and it is identifiable by its suffix. On the create path the residue is only ever an
     extra file; it never becomes the destination, because the destination is only ever created by a
     fresh exclusive temp.
   - **k. Label.** The `FileHandle` surface behaves as described on this machine (**VERIFIED (probe
     R19)** for open modes and truncation; **VERIFIED (probe R20)** for `bytesWritten`,
     explicit-offset writes, and the `dev`/`ino` discrimination of step 6; **VERIFIED (probe R22)** for
     `link`'s create-only semantics and `EEXIST`, the identical `dev`/`ino` and link count after the
     link and unlink, the SDDL `ID` classification, `fs.replaceFile`/`fs.renameat2` being absent, and
     `fs.rename` replacing a substituted destination; **VERIFIED (probe R21)** for the historical
     replacement behaviours now withdrawn, `EPERM` for directory sync, refuse-then-keep for a partial
     temp, `ino` stability under an in-place rewrite, and best-effort `rm` of the temp). What is
     **not** established: whether every filesystem TBAi may be installed on supports hard links, the
     ACL behaviour beyond the one measured volume, the crash durability of the link or of the unlink,
     a handle held by a different process (only relevant to the withdrawn replacement path), whether a
     handle can be re-directed after the walk by a reparse-point race (UNKNOWN-1's residual, §12.4),
     and whether `truncate`/`sync` on a file the service itself holds open is safe. Those stay UNKNOWN
     and do not become claims.

**Negative tests** are **CT5 and CT8** (§11). CT5 covers exactly the policy of step 2 and the forms
of step 4: an absolute path **outside** the root, a `..` escape, a drive-relative path, an
extended-length path, an ADS path, a reserved device name, and — as a positive control that the guard
is not simply refusing everything — an absolute path **inside** the root, which must be **accepted**.
An earlier version of CT5 claimed to refuse "an absolute path" generally; that claim was broader than
the rule, and a test may not be broader than the rule it checks. CT8 covers a junction component, the
**transactional write of step 7** with five deterministic pre-commit sequences — a partial write then
**zero progress**; a partial write then a **rejected** write; a **truncate failure**; a **sync
failure**; and a **successful commit** — each one **re-reading the destination after the call
returns** and asserting its exact bytes (absent before the commit, the new bytes after it), its
`dev`/`ino` pair where it exists, and the presence or absence of the temp; plus the **create-only
commit** cases: the `beforeCommit` seam creates the destination between the absence check and the
commit, `link` returns **`EEXIST`**, the creator's bytes and `ino` are unchanged, and the temp is
removed; the **control run** creates nothing and succeeds, with the destination's `dev`/`ino` equal to
the temp's pre-commit pair and `nlink === 1` after the unlink; a destination that already exists at
**validation** is refused `replace_unverified`, including a **content-identical control** that proves
the refusal is structural rather than content-based; and an injected `link` failure reports
`link_unsupported` with no destination created and no rename attempted. It also covers the **ACL
contract** of step 7f: a temp whose ACE set is inherited-only **passes**, and its SDDL ACE set equals
the directory's propagated set (the positive control that the check can succeed); an injected explicit
ACE fails `acl_explicit_unexpected`; an unreadable or unparsable descriptor fails `acl_unverifiable`;
each failure leaves the destination absent and removes the temp. The **identity-substitution** sequence
of step 6 stays a CT8 case for the walk and the reparse-point refusal, so the `dev`/`ino` check cannot
pass by always agreeing. The previously declared "sixth CT8 case, **BLOCKED**" — the destination's ACL
and security descriptor **after replacement** — is **withdrawn with the replacement path**: this
revision performs no replacement, so asserting a preservation property for an operation the design
does not perform would be a claim without an implementation. CT6 (the writer makes no request of its
own) and CT7 (adopted writes are refused while G4 is absent) are separate assertions, not guard
negatives. A guard that cannot fail CT5 and CT8 is not implemented.

**Until G4 is implemented and reviewed, configuration and permission writes to an adopted service
are disabled** and return a typed refusal. The managed path keeps its current behaviour, whose gap is
recorded as finding 38 (§14); this plan does not put a *new* write path onto an unvalidated target.
The reparse-point race remains **UNKNOWN** on the same terms as UNKNOWN-1 (§2.4) — the walk narrows
the window, it does not claim to close it, and if a target filesystem cannot discriminate `dev`/`ino`
the guard must fail closed rather than accept the write. **G4 stays a blocker for five independent
reasons stated above:** (i) **replacement semantics** — a present destination is refused, so the guard
can create a config document but cannot update one, and D5 is unanswered; (ii) the **check-to-rename
race** — avoided by refusing replacement rather than closed, and no exported Node/Bun API closes it
(R22); (iii) **ACL uncertainty** — the create path verifies inheritance but cannot preserve a previous
descriptor, and its behaviour beyond one measured NTFS volume is UNKNOWN; (iv) **cross-process
handles** — a handle held by a different process on an existing document is UNKNOWN, which is harmless
only while replacement is withdrawn and returns as a blocker if it is reinstated; and (v) **crash
durability** — the parent directory cannot be flushed (`EPERM`), so neither the link nor the unlink is
claimed to survive a crash. This section is a specification, CT5 and CT8 are proposals, and no write
path has been changed.

### 9.4 Permission writer

The permission writer goes through `configServerTarget()`, so it inherits **both** the required
transport and the G4 guard. It does not construct its own request. Revision 15 said the writer
"inherits the path validation"; that was wrong, because no path validation existed. It inherits the
guard only once the guard exists, and until then it is subject to the same adopted-write disablement
as §9.3.

**Owner decision H4** still governs whether a permission write to an *adopted* service is allowed at
all. If H4 is decided "no", the write path refuses in adopted mode and the read path is unaffected.
H4 and G4 are independent: H4 may be answered "yes" while writes remain disabled until G4 is
implemented and reviewed.

**What `0o600` does not establish.** The configuration document's own file mode is likewise not proof
of effective protection on Windows (§2.4, §2.5). The guard is about *where* a write may land, not
about what the resulting ACL grants.

---

## 10. File plan (proposed; no file has been created or changed)

| File | Owner | Proposed change | Status today |
|---|---|---|---|
| `src/services/opencode/connectionState.ts` | OpenCode service | New: frozen state, capture, `beginAttempt()`, `beginShutdown()` (idempotent and re-entrancy-safe), attempt guard, install/clear | Not created |
| `src/services/opencode/http.ts` | OpenCode service | New: bounded transport, origin binding, redirect refusal | Not created |
| `src/services/opencode/registration.ts` | OpenCode service | New: locate, open once, byte-capped read, parse and validate the registration record | Not created |
| `src/services/opencode/adoption.ts` | OpenCode service | New: attempt orchestration, probe, install | Not created |
| `src/services/opencode/serverManager.ts` | OpenCode service | Publish managed target after readiness; delegate readiness probe | Unchanged |
| `src/services/opencode/client.ts` | OpenCode service | Pass the context transport as `options.fetch` | Unchanged |
| `src/services/opencode/configDocument.ts` | OpenCode service | Require a transport for the read; add the G4 guard before any write | Unchanged |
| `src/services/opencode/capabilities.ts`, `commands.ts`, `orphanReconciler.ts`, `sessions.ts` | OpenCode service | Obtain a context instead of an independent base URL + header | Unchanged |
| `src/services/opencode/runtime.ts` | OpenCode service | Keep password generation and the single `buildOpenCodeBasicAuthHeader`; stop being a target authority | Unchanged |
| `src/routes/opencode.ts` | Routes | Use the context transport; stop setting upstream auth / manual redirect | Unchanged |
| `src/config/opencode.ts` | Config | Add the named bounds from §2.4.1 and §6.5 | Unchanged |
| `web/src/features/opencode/` | OpenCode feature (frontend) | Surface the three states of §4.1 | Unchanged |

### 10.1 Proposed test-file locations

Every test in this plan is **proposed**. **No test file below has been created or changed**, and no
file listed contains a single case today. Locations follow the repository's hard rule —
`tests/<layer>/<feature>/`, nothing beside the code (AGENTS.md, "Test location").

| Proposed test file | Covers | Layer | Status |
|---|---|---|---|
| `tests/unit/opencode/http-transport.test.ts` | TT1–TT6 — origin normalization, caller-auth removal from `Request` and `init`, shutdown refusal on the epoch **or** the latch, redirect refusal, method/body/header preservation, single-constructor source scan | Unit | **Not created** |
| `tests/integration/opencode/redirect-and-origin.test.ts` | R1–R12 — the redirect matrix and the origin-mismatch paths across probe, client, config read, and proxy | Integration with loopback stubs | **Not created** |
| `tests/integration/opencode/request-context.test.ts` | RC1–RC16 — capture/transition interleavings, shutdown revocation, the direct revision-versus-epoch assertion, mutation resistance of a retained install object, repeated/concurrent shutdown, the re-entrant abort-listener shutdown, asynchronous child-stop rejection with the settlement bound, and the re-entrant `stopChild()` identity case | Integration with injected transports | **Not created** |
| `tests/unit/opencode/adoption-attempts.test.ts` | AT1–AT15 — overlap, supersede abort, guard position, fallback single-transition, discovery initiability before shutdown versus refusal after it, re-entrant supersession, per-child cleanup counts in the four managed-child cases, the shared start-promise case where two attempts await one child, the settlement/release order when that shared start fails, and acquisition ordering at the spawn injection point | Unit | **Not created** |
| `tests/unit/opencode/registration.test.ts` | BT1–BT16 — path resolution, channel filenames, record validation, trust and version gates, the byte cap on actual bytes, single-open/close discipline, post-parse deadline | Unit | **Not created** |
| `tests/integration/opencode/config-transport.test.ts` | CT1–CT4 and CT6–CT7 — required transport, captured origin/credential, redirect refusal, inherited permission writer, adopted-write refusal while G4 is absent | Integration | **Not created** |
| `tests/unit/opencode/config-path-guard.test.ts` | CT5 and CT8 — G4 refusals under §9.3's absolute-path policy: an absolute path **outside** the root, `..` escape, drive-relative and rooted-no-drive forms, `\\?\`/`\\.\`, UNC, `:` alternate data stream, reserved device name, segment trailing dot/space; **plus the positive control** that an absolute path **inside** the root is accepted; CT8 adds the junction component, the create-only link commit with its five deterministic pre-commit sequences and destination-absent cases (each re-reading the destination), the existing-destination and `destination_appeared` refusals, the link-failure path, the `dev`/`ino` identity-substitution case, and the ACL pass/explicit/unverifiable outcomes | Unit | **Not created** |
| `tests/unit/opencode/credential-selection.test.ts` | A1–A13 — the missing-password path and the credential-isolation suite | Unit | **Not created** |
| `tests/unit/opencode/platform.test.ts` | PT1–PT3 — configuration-file assertions about the installer target and CI matrix | Source/config assertion | **Not created** |
| `tests/integration/opencode/legacy-db-compat.test.ts` | LB1–LB7 — legacy `OPENCODE_DB` (unset, absolute, and **relative**) and PID-tied process-level database-file evidence | Integration, **environment-gated** | **Not created** |

**The legacy suite is environment-gated and must fail loudly, not skip silently.** LB1–LB7 require a
real supported OpenCode build started by the tester in a disposable root (§2.9), with the
process-level observation of §2.9.1. When no such binary is configured, the suite reports
`BLOCKED — B5 evidence unavailable` with a non-zero exit; it is not marked skipped and passing,
because a green suite with zero real-build coverage is exactly the false evidence §2.9.1 forbids. It
is not part of the default CI test selection, and its absence from CI is not evidence that B5 is
closed.

`tests/unit/tooling/opencode-auth-constructor.test.ts` is deliberately **not** separate: the
single-constructor scan lives in `http-transport.test.ts` (TT6) so that the invariant is asserted
beside the transport it constrains. If it is ever split out, it belongs under `tests/unit/tooling/`
next to the other source-text guards.

---

## 11. Test matrix (proposed)

**None of these tests exists. None has been run. Counts below are counts of proposals, not results.**
The proposed file for each group is named in §10.1; no such file has been created or changed.

| Group | IDs | Count | Covers | Layer | Proposed file (§10.1) |
|---|---|---|---|---|---|
| Redirect and origin | R1–R12 | 12 | §1.8 | Integration + source scans | `redirect-and-origin.test.ts` |
| Request-context races | RC1–RC16 | 16 | §1.9 | Integration with injected transports | `request-context.test.ts` |
| Adoption attempts | AT1–AT15 | 15 | §3 | Unit + integration | `adoption-attempts.test.ts` |
| Registration/beta | BT1–BT16 | 16 | §2 | Unit | `registration.test.ts` |
| Config transport and path validation | CT1–CT8 | 8 | §9, G4 | Integration + unit | `config-transport.test.ts`, `config-path-guard.test.ts` |
| Transport unit | TT1–TT6 | 6 | §1.9.4 | Unit | `http-transport.test.ts` |
| Platform evidence | PT1–PT3 | 3 | §7 | Source/config assertions | `platform.test.ts` |
| Legacy database compatibility | LB1–LB7 | 7 | §2.9 (B5) | Integration, environment-gated | `legacy-db-compat.test.ts` |
| **Total** | | **83** | | | |

The suite also holds A1–A13 (§1.6, `credential-selection.test.ts`), which are counted separately
because they were not part of the 55-test matrix revision 15 reported. Revision 15's 55 = the first
seven rows before revision 16's additions; revision 16 added RC11, AT9, CT7–CT8, TT5–TT6, and
LB1–LB5, reaching 66; revision 17 added RC12, RC13, BT13–BT16, and LB6, reaching 73; revision 18
adds **AT10** (attempt initiation after shutdown, §1.9.3.3), **RC14** (re-entrant shutdown,
§1.9.7), and **LB7** (process-level database-file observation, §2.9.4), reaching **76**. Revision 19
adds **AT11** (re-entrant supersession inside a synchronous abort listener, §3.5), **AT12**
(exactly one stop per managed child across the four cleanup paths, §3.4/§3.5), and **RC15**
(asynchronous and non-settling child-stop settlement, §1.9.7), reaching **79**. Revision 20 adds
**AT13** (two attempts sharing one in-flight managed-start promise, §3.4/§3.5) and **RC16**
(re-entrant `stopChild()` with promise identity and a single escalation, §1.9.7), reaching **81**.
Revision 21 adds **no** ID: it changes the *content* of RC16 (one construction, three injection
points including a post-shutdown join), AT12 (case c asserts the withdrawn shared-start promise
before eligibility), AT13 (waiter registration, release, and a control variant), CT8 (five
pre-commit/commit sequences, the transactional path and a BLOCKED ACL case), LB1–LB4 and LB6–LB7 (the
composite key and the service-image PID), and §9.3 step 7, so the total remains **81**. Nothing
previously proposed was deleted or weakened; revision 20 changed the *content* of AT12, CT8, LB1–LB4
and LB6–LB7 and the *count* only through the two new IDs. Revision 22 adds **AT14** (start settlement
order on failure, §3.4/§3.5) and **AT15** (acquisition ordering at the spawn injection point,
§3.4.1/§3.5), and changes the *content* of AT12(c), AT13, AT14/AT15's shared neighbours and CT8
(create-only commit, destination-appearance, existing-destination refusal and the ACL contract),
reaching **83**. The arithmetic is 12 + 16 + 15 + 16 + 8 + 6 + 3 + 7 = 83.

PT1–PT3 are assertions about configuration files, not runtime tests:

- PT1: `tauri.conf.json` declares the `nsis` target.
- PT2: the Tauri workflow builds on `windows-latest` with `x86_64-pc-windows-msvc`.
- PT3: neither file claims support for another platform (so the document's INFERRED label stays
  honest).

CT1–CT8 (configuration transport and path validation, proposed):

- CT1: `readOpenCodeConfigDocument` without a transport fails to compile; with a missing transport at
  runtime it throws before any request.
- CT2: the read targets the captured origin with the captured credential.
- CT3: a 3xx on the read is refused and the body is cancelled.
- CT4: an origin mismatch is rejected before the request is sent.
- CT5: the §9.3 policy, asserted in both directions. **Refused**: an absolute path **outside** the
  resolved config root; a relative `..` escape; and each Windows form of step 4 — drive-relative,
  rooted-no-drive, `\\?\` and `\\.\`, UNC, a `:` alternate-data-stream suffix, a trailing dot or
  space on a segment, a reserved device name. **Accepted (positive control)**: an absolute path
  **inside** the root, because the server's `/api/config` names the document absolutely and a guard
  that refused it would refuse every legitimate write. That positive control is what distinguishes
  §9.3's policy from the revision-18 wording, which called every absolute path a negative case while
  its own check silently converted inside-root absolutes to relative paths. **This guard does not
  exist today**; the test is for the proposed G4 guard, not for current behavior.
- CT6: the permission writer performs no request of its own; it inherits CT1–CT4.
- CT7: a configuration or permission **write to an adopted service is refused** while G4 is absent —
  the §9.3 disablement, asserted with a spy that the filesystem write is never attempted.
- CT8: a symlink/junction component anywhere between the root and the leaf is refused; the write opens
  exactly one path — the temp — with `"wx"` (spy on `fsp.open`: one call, the temp beside the
  destination, flags `wx`) and **never opens the destination**; the buffer is written at explicit
  offsets until every byte lands; `fh.truncate(len)` is called only after that; `sync()` is called; and
  the destination is **created only by `link`**, asserted by a spy that records no `rename` on the
  write path. Five deterministic pre-commit sequences, each of which **re-reads the destination after
  the call returns** and asserts its exact bytes (the destination is absent at validation, so
  "preserved" means "still absent"), its `dev`/`ino` where it exists, the typed result, and whether the
  temp still exists:
  1. **partial then zero progress** — an injected `write` reports a small `bytesWritten` for the first
     call and `0` for the second: result `short_write`, destination **still absent**, no temp left;
  2. **partial then rejection** — a small first `bytesWritten` then a rejected `write`: the typed write
     failure, the destination still absent, no temp left;
  3. **truncate failure** — the complete-write loop succeeds and `truncate` rejects: the same
     assertions, no temp left;
  4. **sync failure** — the loop and `truncate` succeed and `sync` rejects: the same assertions, no
     temp left;
  5. **successful commit** — the full sequence runs: the destination holds the new document, its
     `ino` and `dev` equal the temp's pre-link pair, its link count is **1** after the temp is
     unlinked, and the temp path no longer exists (the R22 measurements, §9.3 step 7d).
  Plus the **create-only commit** cases: the `beforeCommit` seam creates the destination between the
  absence check and the link, `link` returns **`EEXIST`**, the creator's bytes and `ino` are unchanged,
  the typed result is `destination_appeared`, and the temp is removed; the **control run** creates
  nothing and succeeds; a destination that already exists at **validation** is refused
  `replace_unverified` **before any temp is created** (the `open` spy records zero calls), including a
  **content-identical control** that proves the refusal is structural; and an injected `link` failure
  reports `link_unsupported` with no destination, no rename attempt and the temp removed. **Identity
  substitution** then covers the create path: two distinct files in the disposable root are `lstat`-ed
  to establish that their `dev`/`ino` pairs differ and that a hard link to one reports the same pair
  (the R20 measurement, §9.3 step 6); a file created between validation and the pre-commit check is
  refused as `destination_appeared` with that file left intact, and the no-substitution control is
  accepted, so the assertion cannot pass by refusing everything. **ACL contract** cases: a temp whose
  ACE set is inherited-only **passes**, and its SDDL ACE set equals the directory's propagated set
  (the positive control); an injected explicit ACE fails `acl_explicit_unexpected`; an injected
  descriptor-read failure fails `acl_unverifiable`; every ACL failure leaves the destination absent.
  **Withdrawn with the replacement path:** the two `EPERM` rename refusals and the BLOCKED
  post-replacement ACL case — no replacement is performed, and the ACL cases above are implementable
  pass/fail assertions in their place. Recording the withdrawal here is deliberate: G4 must not close
  by omission of an untestable claim.

TT1–TT6 (transport unit, proposed):

- TT1: origin comparison normalizes case and a trailing slash, and still rejects a different host.
- TT2: a caller `Authorization` is removed before the transport sets its own — from `init.headers`
  and, in TT5, from the `Request`'s own headers.
- TT3: a captured `shutdownEpoch` that no longer matches the current epoch throws
  `OpenCodeContextInvalidatedError` before the underlying fetch is called (spy: zero calls) **and**
  before any header is constructed (builder spy: zero calls) — driven entirely through the production
  API, no seam. The latch half is a **separate case constructed through the §1.9.5 test seam**: with
  the injected state reader reporting `{shutdownEpoch: e, shutdownStarted: true}` and a context whose
  captured epoch is `e` — a state the production API cannot produce — the transport still throws and
  still makes zero fetch and zero builder calls. That case proves the latch check is live behind the
  epoch equality; it does not claim production can reach the state. Epoch equality alone is not the
  gate (§1.9.4 step 2), and the seam is installed only inside the test process, uninstalled in
  `finally`.
- TT4: a 3xx response is cancelled and surfaced as `OpenCodeRedirectRefusedError` without the raw
  `Location`.
- TT5: a `Request` carrying its own headers (including `x-opencode-directory` and `content-type`)
  plus a separate `init` keeps every non-auth header, loses the caller's `authorization` from
  whichever source supplied it, gains exactly one `Authorization` from the captured credential, and
  preserves method and body unchanged.
- TT6: source scan — the transport module contains no `base64`, `Basic `, or `Buffer.from` expression
  for credentials; `buildOpenCodeBasicAuthHeader` is the only constructor used on every
  credential-bearing path (`http.ts`, proxy, `client.ts`, adoption). It also scans for the §1.9.5
  seam: the name `setShutdownStateReaderForTests` must appear in exactly one file under `src/`
  (`connectionState.ts`, its declaration) and in no other production module, and
  `readShutdownState()` must be the only production reader of the shutdown pair. The scan asserts the
  invariant (one declaration, zero production callers), not the line layout.

LB1–LB7 are specified in §2.9.4. They verify the evidence record and the runtime's response to a
legacy build; they cannot manufacture the missing measurements, and they remain **NOT IMPLEMENTED,
NOT RUN**. LB1–LB6 cover the record and the runtime's response; **LB7** adds the process-level,
PID-tied observation of the database file the service itself opened or created, for each of the
three `OPENCODE_DB` configurations, because a file that merely exists on disk cannot distinguish
"the service opened this" from "this file happens to be here" (§2.9.1). LB7's capture is **not
free-form**: §2.9.1.1 prescribes the tool, the process-name filter set before launch, the PID
attribution after launch, the required `CreateFile` event and its `SUCCESS` result, the export
fields, and the retention of the exported trace. An LB7 result recorded by any other method is not
B5 evidence, and an export that does not carry the process's image path, start time, PID and digest
alongside the file event is not attributable to an artifact.

---

## 12. Risks, unknowns, and evidence gaps

### 12.1 E1 — no runtime verification of the registration read at 2.2.0

TBAi has no registration reader today, so there is no runtime evidence that its reader agrees with
OpenCode 2.2.0's writer. The plan's reader is specified from source (§2), and **E1** stays open until
a reader exists and is exercised against a service **the tester starts themselves in a disposable
root**. This revision did not run such a test (the constraint for this revision forbids it). E1 covers
2.2.0 only; it is not B5 (below) and cannot close it.

### 12.2 B5 — no evidence for legacy database-path behaviour (2.0.15–2.1.x)

The managed gate accepts `>=2.0.15 <2.2.1`, and there is **no evidence at all** for any 2.0.15–2.1.x
build: not for registration presence, not for `OPENCODE_DB`, not for database-path compatibility
(§2.9.2). Shim-based evidence does not close this. B5 stays **BLOCKING** until a tester runs real
supported builds in disposable roots and records the observations listed in §2.9.1. Each measured
artifact is its own row: `2.1.x` is a range with no named members, and **this document contains no
`2.1.x` row and names no `2.1.x` artifact** (§2.9.2) — a result for one artifact says nothing about
another. A relative `OPENCODE_DB` is part of the observation and is recorded with the working
directory the service was started in (LB6). The database file itself is established by the
**service-image-PID-tied process-level observation** of §2.9.1 — the PID resolved from the recorded
process tree, never the launcher's — not by a file appearing on disk and not by a CLI
report of a path; LB7 is the test that requires it for each of the three configurations, and
§2.9.1.1 prescribes how the event is captured and attributed.

**The 2.2.0 observation does not help, and is not a matrix row.** It is kept as a historical probe
record outside the composite-keyed table (§2.9.2) because it names no artifact digest; it says nothing
about any 2.0.15–2.1.x build, says nothing even about `OPENCODE_DB` at 2.2.0, and must not be cited
as if it did. No digest has been invented for it.

### 12.3 G4 — the configuration-write path has no validated root

The write path takes a path from the server's `/api/config` response and passes it to `Bun.write`
with no root or traversal check (§9.3, **VERIFIED (code)**). This is **G4**, a technical blocker: the
guard must be implemented with the containment, traversal, and reparse-point rules of §9.3 and
reviewed before any write enabled by this plan is trusted. Until then, writes to an adopted service
are disabled. Writing this section is not implementing the guard, and H4 does not make it safe.

The commit design leaves five independent gaps, and revision 22 states all of them in §9.3 step 7
rather than leaving them implicit:

1. **Replacement semantics.** The write commits by `fs.link` into an **absent** destination, which is
   atomic and create-only (probe R22). A destination that already exists is refused
   (`replace_unverified`), because `rename` resolves the target by name and no exported Node/Bun API
   offers a no-replace flag or a destination-identity precondition for a present file. The guard can
   therefore create a configuration document but cannot update one; **D5** is the owner decision on
   accepting that limit or funding a native mechanism.
2. **The check-to-rename race.** With replacement withdrawn the race is avoided, not closed: a later
   revision that reinstates replacement inherits a window between the last identity read and the
   rename's name resolution that no check before it can remove.
3. **ACL uncertainty.** A new file inherits the directory's ACEs; the guard verifies (via SDDL `ID`
   flags) that the temp carries only inherited ACEs, and refuses `acl_explicit_unexpected` or
   `acl_unverifiable`. That is **verification of inheritance, not preservation of a previous
   descriptor**, and it is measured on one NTFS volume only.
4. **Cross-process handles.** Whether a handle held by a different process blocks or permits a
   replacement is UNKNOWN (R21 held its own handle). It is harmless only while replacement is
   withdrawn, and it returns as a blocker with the replacement path.
5. **Crash durability.** Opening and syncing a directory fails `EPERM` here, so neither the link nor
   the unlink is claimed to survive a crash before the parent directory is flushed.

None of the five is a reason to write faster; each is a reason the write stays off.

### 12.4 UNKNOWN-1 — Windows registration-file symlink race

Whether the registration path can be swapped for a symlink/junction between validation and read on
Windows was **not measured**. The conservative behaviour adopted instead: `lstat` before the open,
**one** open whose handle is `fstat`ed, a byte-capped and deadline-bounded read from that handle,
and validation of the bytes that handle returned — never a second open of the same path (§2.4).
That narrows the window; it does not prove it closed. Labelled UNKNOWN, not "mitigated". The same
residual applies to the G4 guard's step 4.

### 12.5 Shutdown consequences the plan accepts

- **An ordinary transition never revokes a captured context.** A request captured before adoption,
  fallback, or rotation may still be sent afterwards, to its own origin with its own credential. That
  is intended (RC1, RC2, RC3); the alternative — revoking on every transition — was revision 15's
  defect.
- **A response already on the wire completes after shutdown.** The transport cannot recall bytes it
  has already sent. It refuses *new* initiations (RC4, RC5); it does not claim to cancel the one in
  flight.
- **A managed child a superseded attempt awaited is cleaned up only if it is eligible, and a request
  that is not eligible is deferred with an owner.** The child is TBAi's own process and the manager
  owns it from the tick it was spawned (§3.4), but a shared in-flight start can hand the **same**
  `Subprocess` to a newer attempt: `acquireManagedStart()` returns one start and one promise, so A and
  B may await one child. A stale attempt therefore **requests** cleanup
  (`requestChildCleanup`) rather than deciding it. The request first looks for a published stop and
  joins it if one exists; only if none exists does it evaluate C3 (a target names the child), C2 (an
  unsettled start still names it) and C1 (a counted waiter holds it). Failing any of them records a
  **pending obligation** with that condition's trigger — T1 last-waiter release, T2 settlement, T3
  target clear, T4 shutdown — so the child stays alive and a later event, not an assumption, decides.
  A settled reservation that still advertises an uninstalled child is **withdrawn by the decision**,
  synchronously and before the stop is published, so no later `acquireManagedStart()` hands out a
  child that is about to be signalled; the same block detaches the current-child pointer by identity,
  so the stopped child's exit takes `onExit`'s early return instead of the auto-restart path (§3.4.1).
  AT12 covers the four ordinary cleanup paths; AT13 covers the shared-start case where a stale
  attempt's request is **deferred by C1** and the child is stopped exactly once, at shutdown. A stale
  attempt never stops a child another path can still reach, and never touches a newer attempt's child.
- **Shutdown is a one-way gate within a process.** `shutdownEpoch` never returns to a previous value,
  a second `beginShutdown()` cannot move it again (§1.9.3.2), a restarted TBAi starts a new epoch
  space, and a context from the previous process cannot be carried into it because contexts are not
  persisted.
- **A repeated or concurrent shutdown is a no-op for the transition.** It performs no replacement,
  moves neither counter, and awaits the same child-stop completion; RC13 asserts it.
- **A re-entrant shutdown is the same shutdown.** An abort listener invoked synchronously from the
  first call's `abort()` receives the **same** completion promise object as the outer caller, the
  child stop still runs exactly once, and the promise settles even if that stop throws synchronously on
  entry; RC14 asserts it (§1.9.3.2).
- **A re-entrant child stop joins the published promise.** `stopChild()` publishes its per-child
  promise in the `WeakMap` **before** it signals or awaits anything, so a caller entering from inside
  the first stop's initiation gets the identical promise and starts no second escalation. The same is
  true for a caller that arrives **after** the stop is published, including after shutdown published
  it: the lookup precedes every eligibility test, so such a caller joins and is never refused. RC16
  asserts identity, the single `SIGTERM`, a single outcome, and zero process calls from both kinds of
  late caller; its shape guard requires the removed executor construction to fail.
- **A rejected child stop is the same outcome as a synchronous throw.** There is exactly **one**
  construction: an executor that only captures `resolve`, the promise stored in the `WeakMap`, and then
  `queueMicrotask(run)` where `run` calls the stop inside a `try` and observes a returned promise with a
  two-argument `then` (§1.9.3.2, §3.4 step 5). The rejected alternative — invoking the stop inside the
  executor — is removed because the executor runs synchronously inside the constructor, before the
  promise can be published, and a re-entrant caller inside that invocation would start a second
  escalation. With the specified construction a synchronous throw (including a pre-return one), an
  asynchronously rejected promise, and a normally returned value all reach the documented typed
  failure, all leave the shared completion **resolved** rather than rejected, and every caller — the
  first, a later, and a re-entrant one — receives that same resolved value. `stopChild()` itself
  returns normally; the throw is observed in the scheduled callback. No `unhandledRejection` is
  produced and the failure is logged once. RC15 asserts all three shapes.
- **"Always settles" is bounded, not unconditional.** A child stop that neither resolves nor rejects
  is stopped by the two-phase bound (`opencodeChildStopGraceMs` then `opencodeChildStopKillMs`,
  §6.5) and the completion resolves with `termination_unconfirmed` rather than staying pending. If
  the bound itself cannot run — the event loop is blocked, or the platform never reports exit — the
  guarantee degrades to "pending", which is stated rather than hidden. RC15's third case covers the
  non-settling stop; it cannot cover a blocked event loop.
- **Each managed child is stopped by exactly one shared stop.** The child's `Subprocess` object is
  its identity, `stopChild(child, cause)` publishes one promise per child before it signals anything
  and later callers join that published promise, and the shutdown path, a post-shutdown readiness
  completion, an eligible superseded managed attempt and a fallback all join it after a lookup that
  precedes every eligibility test (§3.4). A completion that is rejected for being stale therefore
  never starts a second independent stop of a child another path already owns — and when two attempts
  share one child, the stale one's cleanup request is refused under condition 1 rather than joining a
  stop that would kill a child the newer attempt is using. AT12 asserts the invocation counts for the
  four ordinary paths, AT13 the shared-promise case, and §3.4's table names which path reaches which
  child.
- **Calling shutdown twice is not an error.** No caller has to coordinate a "first" shutdown; the
  second caller is told nothing and waits for the same completion.

### 12.6 Residual risks carried

- A foreign process that opens the database after TBAi's post-readiness check (documented in
  `ownership.ts` and not enforceable from TBAi).
- An adopted service that changes its password while TBAi holds a captured context: the in-flight
  request may receive 401; no retry with a different credential is attempted.
- A probe that is aborted on supersede may still have reached the candidate; aborting a request is
  not a guarantee that the candidate did not observe it.
- The configuration-write path has no root/traversal check today (§12.3, G4). Writes to adopted
  services are disabled until the guard exists; managed writes keep their current, unvalidated
  behaviour, which is recorded rather than accepted as safe.
- **The G4 write cannot replace an existing document, and the residual is explicit.** The commit is
  `fs.link` into an **absent** destination (probe R22: `EEXIST` on any existing name, with that file
  untouched), so a write cannot destroy a document it did not create; a present destination is refused
  `replace_unverified`, and the create/update asymmetry is owner decision **D5**. The check-to-rename
  race revision 21 tried to narrow is **avoided, not closed**: no exported API in this runtime replaces
  by identity, so reinstating replacement reinstates the window. ACL inheritance is **verified, not
  preserved**, on one measured volume; the effect of a handle held by a different process is UNKNOWN;
  and no directory flush is available (`EPERM`), so neither the link nor the unlink is claimed durable
  across a crash. §9.3 step 7 states all of it, and each is a reason G4 stays open.
- **A `*.tbai-tmp` file can be left behind** if the process dies between creating the temp and the
  commit. Nothing sweeps it; it is identifiable by its suffix (§9.3 step 7j).
- The effective Windows ACL on the registration file is not established by the writer's `0o600`
  argument (§2.4, §2.5).
- **A same-process actor with the owner's internal state reference, or the ability to monkey-patch a
  module binding, can still change what is sent.** The freeze of §1.9.3.1 stops mutation *through the
  object graph the design exposes* — the caller's install argument, the captured context, the
  transport binding — and nothing more. That is the boundary the design claims, and no test in this
  plan claims otherwise.
- **The handle-scoped read's API surface is now measured; two properties of it are not.** The R19
  probe established that `fs.promises.open()` returns a `FileHandle` with `stat()`, `read()`,
  `write()`, `writeFile()`, `truncate()`, `sync()` and `close()`, that close invalidates it (`fd`
  becomes `-1`, writes fail `EBADF`), that an `"r"` handle refuses to write, and that
  `lstat(path)`/`fh.stat()` agree on `dev`/`ino` (§2.4). **Unmeasured**: whether an `AbortSignal`
  cancels a read pending on the handle or only abandons it, and how Windows behaves when a handle is
  closed during an in-flight read. If the deadline holds only on paper, the read bound is unmet and
  must be raised; it must not be replaced by re-opening the path or pre-trusting an `lstat` size.
- **A child stop can end `termination_unconfirmed`.** The two-phase bound (§6.5) resolves the shared
  completion rather than leaving it pending, but it does not prove the process died; the result says
  so. A blocked event loop can still keep the completion pending, and that residual is stated in
  §12.5 rather than papered over.
- **The `dev`/`ino` discrimination is measured on one volume, and no short write occurred here.** The
  R20 probe established distinct files → different `ino`, hard link → identical pair, substitution →
  `differ = true`, control → `differ = false`, on a single NTFS volume on one machine. A filesystem
  that reported one `ino` for distinct files would make the walk's identity evidence vacuous; the
  guard must fail **closed** there (refuse the write), and CT8 asserts the substitution and control
  cases, rather than treating "the check agreed" as success. `fh.write` never returned fewer bytes than
  requested in this environment, so the complete-write loop guards a case the probe did not produce;
  CT8 injects a short write and a zero-progress write deterministically, because a test that waited for
  a natural short write would pass without exercising the loop. Revision 22 adds the corresponding
  unknown for the commit: **whether every filesystem TBAi may be installed on supports hard links** is
  not measured, and the guard fails closed (`link_unsupported`) rather than falling back to a rename.
- **Package and executable digests are two different measurements.** Where the artifact is an
  installer or archive, the evidence record carries both with the extraction relationship between
  them; no equality is required or expected, and none is used to accept or reject a build. A record
  that presents one digest as if it covered both is incomplete (§2.9.1).

### 12.7 Risks the plan does not accept

- Sending a credential to an origin other than the one it was validated for (B8).
- Any redirect being followed on a credential-bearing path (§1.8).
- Installing a target from a superseded attempt (§3.2).
- Initiating a credential-bearing request after shutdown (§1.9.6).
- Starting a discovery attempt after shutdown, or letting a caller-supplied epoch buy one (§1.9.3.3).
- A retained install object, a captured context, or the transport binding changing what is sent
  after installation (RC12, §1.9.3.1).
- A second shutdown or a re-entrant shutdown moving the epoch, stopping the child twice, or leaving the
  shared completion permanently pending (RC13, RC14, §1.9.3.2).
- A rejected or non-settling child stop producing an `unhandledRejection`, rejecting the shared
  promise, or triggering a second independent stop of a child another path already owns (RC15, AT12,
  §3.4).
- A re-entrant `stopChild()` obtaining a second promise, starting a second escalation, or producing a
  second settled outcome for one child — including the shape that invokes the stop inside the promise
  executor, before the promise is published (RC16, §1.9.3.2, §3.4).
- A cleanup request that arrives after a stop is published being **refused** instead of joined, or a
  join that adds a process call (RC16, AT12, §3.4).
- A superseded managed attempt stopping a child a newer attempt can still receive from the shared
  start promise (AT13, §3.4), or stopping an uninstalled child whose settled binding can still hand
  the child out because the withdrawal did not happen before publication, or whose current-child
  pointer was left in place so the stop's exit re-enters the auto-restart path (AT12(c), §3.4.1).
- A waiter record that is registered late, released late, or evaluated by a different rule than
  "unreleased **and** `isAttemptActive`", so that eligibility is decided on state the manager does not
  own (§3.4.1, AT12(c), AT13).
- A spawn that can run before the start's record, deferred and waiter exist, or a child attributed to
  its start in a later tick, so the manager observes a child whose owner it cannot name (AT15, §3.4.1).
- A start settlement that delivers its rejection before releasing its waiters and publishing the
  start-failure stop, that misses a waiter, or that evicts a newer start's binding (AT14, §3.4).
- A cleanup request that cannot initiate being **dropped** instead of recorded as a pending obligation
  with a named trigger, so a child is left alive with no future owner (AT13, §3.4).
- A configuration write reported as successful when the handle wrote fewer bytes than the document,
  a failed write that leaves the previous document destroyed, or a write that replaces an existing
  destination without an identity precondition (CT8, §9.3 step 7, D5).
- A superseded or re-entrantly superseded attempt starting registration-file I/O or a probe after
  `beginAttempt()` has stopped being the current attempt (AT10, AT11, §1.9.3.3, §3.2).

---

## 13. Blocker classification

Three different kinds of work are open. They are separated because they close differently: decisions
need an owner, evidence needs a measurement, and design needs code.

### 13.1 Owner decisions (cannot be closed by an agent)

| ID | Question | Where |
|---|---|---|
| **B1** | Does the owner approve **departing from the official lifecycle path** (`discover()`, `ensure()`, `stop()`) and using the custom registration reader of §2.3–§2.7? Approval permits the custom reader; refusal makes the official lifecycle route the alternative to be evaluated, which must first name the `discover()` surface it means (§2.10.1) and accept that surface's read/probe behaviour — a probe that sends the recorded password to the recorded URL — plus any `ensure()`/`stop()` effects it separately chooses. Approval never means adopting `discover()`. Until answered, the reader does not call those lifecycle functions and no wrapper is designed. | §2.10, §2.10.1, §4.3 |
| **H3/B3** | The history and database policy for adopted sessions: do they share the managed conversation list, and how do persistence and database ownership behave? | §4.3 |
| **H5/B2** | The adoption-default policy for a fresh install: managed, or "adopt an already-running service if one is found"? | §4.3 |
| **B7** | The pin policy: which `@opencode/client` version and which supported OpenCode service range the hybrid runtime pins to, and whether a service outside the managed gate may be adopted. | §2.2, §4.3 |
| **H4** | May TBAi write configuration or permissions to an adopted service? Authorisation only — it does not decide G4. | §4.3, §9.4 |
| **D1** | Does adoption ship at all, or does the runtime stay managed-only? | §4.3 |
| **D2** | Is adoption restricted to stable-channel services, given that the registration schema carries no channel field? | §2.2, §4.3 |
| **D3** | On a confirmed `lost` adopted service: automatic managed start, or an explicit user choice? | §4.3, §1.5.1 |
| **D4** | Which credential should an adopted service use, and what does TBAi do when the record supplies none? **Open.** The §1.3 refusal is a **proposed default pending D4**; supporting a password-less service would need a separately reviewed authentication design and must never fall back to the managed password. | §1.3, §4.3 |
| **D5** | **Configuration-document replacement.** May the runtime write only when the destination does not exist — the §9.3 create-only commit, which cannot update an existing config document — or must the owner fund a native conditional-replacement mechanism (a destination-identity precondition that no exported Node/Bun API provides today)? Until answered, G4 implements the create path only, a present destination is refused `replace_unverified`, and the check-to-rename race stays unclosed rather than accepted. Answering "create-only" accepts a known functional limitation; answering "fund a mechanism" defers G4 further and must name an API and a measurement. | §9.3 steps 6–7, §12.3, §12.6 |

**Retired as duplicates, not dropped.** Revision 15's **H1** ("default for a fresh install") is the
same question as H5/B2 and is folded into it. Revision 15's **H2** ("do adopted sessions share the
managed conversation list") is a subset of H3/B3 and is folded into it. Keeping either as a separate
ID would create two overlapping versions of one decision, which is what this revision removes.

### 13.2 Evidence gaps (need a measurement, not a decision)

| ID | Gap | What closes it | Status |
|---|---|---|---|
| **E1** | No runtime evidence that the TBAi registration reader agrees with the OpenCode **2.2.0** writer | A reader implemented and exercised against a tester-started 2.2.0 service in a disposable root | OPEN — not run in this revision |
| **B5** | No evidence at all for OpenCode **2.0.15–2.1.x**: registration presence, `OPENCODE_DB` behaviour (unset, absolute, **relative**), database-path compatibility | Real supported builds started by the tester in disposable roots, each named by the **composite key** of §2.9.2 (reported version, package artifact name and digest, extracted executable path and digest, extraction provenance) and recorded as its own row, with the observations of §2.9.1 — including the working directory for a relative `OPENCODE_DB` (LB6) and the **process-level file open/create event** for the database tied to the **service-image PID**, resolved from the recorded process tree rather than taken from the launcher (LB7), with the registration `pid` corroborating it or recorded as `registration absent` and a mismatch recorded as a finding. Shim-only evidence does not close it; neither does one measured build for any other. No `2.1.x` artifact is named or measured in this document (§2.9.2) | **OPEN — BLOCKING.** The 2.2.0 work (E1) does not close it |

### 13.3 Technical design and residual blockers (need code and proof)

| ID | Blocker | Kind |
|---|---|---|
| **B8** | Request context: credential and origin were read independently; revision 15 additionally conflated ordinary state changes with shutdown revocation | **Security/implementation blocker** — exit criteria in §1.9.8 |
| **G4** | The configuration/permission write path takes a path from the server with no root, traversal, or reparse-point check | **Technical blocker** — required implementation gate (§9.3); adopted-mode writes are disabled until it lands. Revision 22 narrows the gate to a **create-only** commit (`fs.link` into an absent destination) and refuses replacement (`replace_unverified`) because the check-to-rename race cannot be closed with any exported API; it also requires the complete-write loop, the destination-appearance refusal, and the ACL inheritance contract (CT8). The five reasons it stays blocked — replacement semantics, the race, ACL uncertainty, cross-process handles, crash durability — are listed in §12.3 and **D5** is the owner decision on replacement |
| **UNKNOWN-1** | Windows registration-file symlink/reparse race (and the same residual in G4 step 4) | Residual, labelled UNKNOWN (§2.4, §12.4) |

B8 and G4 are not stylistic or "non-traditional safety" concerns. A design that cannot demonstrate
credential/origin pairing (B8), or that writes to a server-supplied path without containment (G4),
is a security defect, and implementation approval is withheld while either is open.

### 13.4 Blocker-ID crosswalk (historical meaning ↔ current revision)

Revision 15 reassigned several historical IDs without saying so. This table restores the meanings and
shows where each displaced question went. **No historical ID was overwritten**, and the replacement
IDs are new labels, not redefinitions.

| Historical ID | Original meaning — **restored** in revision 16 | What revision 15 used it for | Where that revision-15 question lives now |
|---|---|---|---|
| **B1** | Owner approval to depart from the official lifecycle path with a custom registration reader — approval of the **reader**, never of `discover()` | "Does adoption ship at all?" | **D1** |
| **H3/B3** | History/database policy for adopted sessions | Credential selection | **D4** (the credential half); revision 15's **H2** folded into H3/B3 |
| **H5/B2** | Adoption-default policy for a fresh install | Stable-versus-beta restriction | **D2** (the stable-only half); revision 15's **H1** folded into H5/B2 |
| **B7** | Pin policy for the client and the supported service range | Fallback after service loss | **D3** |
| **B5** | Legacy `OPENCODE_DB` evidence gap (OpenCode 2.0.15–2.1.x) | 2.2.0 reader/writer agreement | **E1** |

Unchanged by this crosswalk: **B8** (request context), **H4** (write authorisation), and
**UNKNOWN-1**. Newly introduced: **D1–D4**, **E1**, and the technical gate **G4**; revision 22 adds
**D5** without redefining any earlier ID. Revision 17
changes no ID and no restored meaning; it corrects only what an **approval** of B1 permits (§2.10).
Revision 18 also changes no ID: it separates the three lifecycle calls so that a **declined** B1 is
read as selecting a route to evaluate — starting with which `discover()` surface — and not as
accepting spawn, stop or registration removal (§2.10.1). **Revision 19 also changes no ID.** It
repairs mechanisms behind B8, G4, B5 and UNKNOWN-1, and adds findings 62–68; it renames no owner
decision, evidence gap or technical blocker, and it retires none. **Revisions 20 and 21 also change
no ID.** They add test proposals (RC16, AT13) and findings 69–82, and repair mechanisms behind B8, G4
and B5; no owner decision, evidence gap or technical blocker is renamed, redefined or retired.
**Revision 22 adds owner decision D5 and no other ID.** It adds test proposals AT14 and AT15, changes
the content of AT12(c), AT13 and CT8, and repairs mechanisms behind B8 (start reservation and
settlement) and G4 (create-only commit); B5, E1, UNKNOWN-1 and the earlier owner decisions are
untouched and keep their meanings.

Readers of an earlier revision should not assume that a quoted "B1" or "B5" from revision 15 means
the same thing here. The crosswalk is the map; the restored meaning is the definition.

---

## 14. Independent-review register

### 14.1 Consistency check of the findings still carried forward

The saved document's register ended before this section, so the numbering below is **this
document's** numbering for the corrections it carries. It is not presented as a verbatim quotation of
an earlier register whose text is no longer present. Each row states the corrected claim, the actual
design, and the status of the fix. Finding 37 is the one the review specifically required to be
carried forward, and it is marked as such.

| Finding | Claim as corrected here | Actual design in this revision | Status |
|---|---|---|---|
| **31** | Credential-bearing network calls are spread across routes and services | The plan routes them through one transport (§1.8) | CORRECTED IN PLAN — NOT IMPLEMENTED |
| **32** | Adoption timing is configurable via client options | The client exposes no such option (§6.4) | CORRECTED IN PLAN — NOT IMPLEMENTED |
| **33** | The registration writer creates a new inode via rename | Source shows temp-file-plus-rename; inode identity is filesystem-specific and was not measured (§2.5) | CORRECTED IN PLAN — NOT IMPLEMENTED |
| **34** | Beta users cannot be found because the filename differs | `latest`, `beta`, and `next` share `service.json`; only `dev`/other channels may use a different filename (§2.2) | CORRECTED IN PLAN — NOT IMPLEMENTED |
| **35** | Windows-only support is confirmed by CI | Packaging/CI targets are VERIFIED; product-wide scope is INFERRED (§7) | CORRECTED IN PLAN — NOT IMPLEMENTED |
| **36** | Adoption can be offered without an owner decision on fallback | Fallback remains an owner decision — now **D3**, the restored meaning of the historical B7 (§13.4) | DESIGN GAP — OPEN |
| **37** | **(required carry-forward)** The request path reads the base URL and the auth header independently; a credential can therefore be paired with a destination from a different snapshot | §1.9 replaces both readings with one capture operation and transport-level injection **on paper** | **DESIGN GAP — CORRECTED IN PLAN, NOT IMPLEMENTED OR VERIFIED** |
| **38** | The config write path validates its target under the config root | There is no root or traversal check today; the path from `/api/config` goes to `Bun.write` unchanged (§9.3). Now classified as technical blocker **G4**, with adopted-mode writes disabled until it lands | DESIGN GAP — NOT IMPLEMENTED |
| **39** | One `generation` number was used both for ordinary state changes and for shutdown revocation, so RC1 (a captured context survives an ordinary transition) and RC4 (shutdown revokes a captured context) could not both hold | Two values: `revision` (ordinary, diagnostics only) and `shutdownEpoch` (shutdown only), with the transport checking the epoch **and** the `shutdownStarted` latch from one snapshot (§1.9.4 step 2); RC11 asserts the separation | CORRECTED IN PLAN — NOT IMPLEMENTED |
| **40** | §1.5 said managed shutdown left managed state usable while §1.9.6 revoked the context and failed new captures | One policy: shutdown in either mode publishes `unresolved`, moves the epoch, refuses initiation, and fails new captures; `revision` and the epoch are both advanced by `beginShutdown()`, and only on its first call (§1.9.3.2) | CORRECTED IN PLAN — NOT IMPLEMENTED |
| **41** | Historical blocker IDs were reassigned without notice (B1, H3/B3, H5/B2, B7, B5 all changed meaning) | Original meanings restored; displaced questions moved to new IDs D1–D4 and E1; explicit crosswalk in §13.4 | CORRECTED IN PLAN |
| **42** | The legacy `OPENCODE_DB` / database-path evidence requirement (2.0.15–2.1.x) had been dropped and replaced by a 2.2.0 reader/writer question | Restored as **B5** (§2.9) with a distinct evidence matrix; 2.2.0 work is **E1** and does not close it | CORRECTED IN PLAN — EVIDENCE STILL MISSING |
| **43** | The transport contract wrote the `base64("opencode:" + password)` formula while A12 claimed the only constructor lived in `runtime.ts` | The transport calls `buildOpenCodeBasicAuthHeader()`; the formula is removed from the contract; TT6 scans for a second constructor | CORRECTED IN PLAN |
| **44** | The transport accepted a `Request` but merged headers only from `init`, so a `Request`-owned scope or content-type header could be lost | Effective headers = `Request` headers overlaid by `init`, then `authorization` removed case-insensitively from both; method and body left to fetch; TT5 covers it | CORRECTED IN PLAN |
| **45** | "Fallback (any failure)" described outcomes that do not all fall back, and did not say what happens to either process | A ten-case outcome table (§1.5.1) states the target, the managed process, the adopted process, and the resulting capture state per case | CORRECTED IN PLAN |
| **46** | The registration read was called "bounded" with no size, no deadline, and no cancellation; a timed-out operation could still install | Concrete size and deadline constants, `AbortSignal`-based cancellation of the read and the probe, abort on supersede, and the attempt guard as the install authority (§2.4.1, §3.1). Revision 17 moved the size limit onto the bytes actually read (§2.4) | CORRECTED IN PLAN — LIMITS NOT IMPLEMENTED |
| **47** | The config-write path gap was called "a separate, small piece of work" with no safety acceptance criteria | Reclassified as required gate **G4** with root resolution, containment, traversal and reparse-point rules plus negative tests CT5 and CT8; adopted-mode writes disabled until reviewed | CORRECTED IN PLAN — GUARD NOT IMPLEMENTED |
| **48** | The test matrix counted 55 proposals but §10 did not say where any of them would live | §10.1 names a proposed file per group and marks every one **not created**; matrix updated to 66 in revision 16, 73 in revision 17, 76 in revision 18, 79 in revision 19 and **81** in revision 20 | CORRECTED IN PLAN — NO TEST FILE EXISTS |
| **49** | Revision 16 claimed the captured context was immutable, but `target.credential` was exposed by reference to the caller and to the transport, so a retained install object could change the password after `authHeaders` was built | Installation copies into owner-controlled objects, every level is frozen at runtime, no caller-owned reference is retained, and the capture and the transport binding share one frozen credential (§1.9.3.1); RC12 asserts it | CORRECTED IN PLAN — **NOT IMPLEMENTED OR VERIFIED** |
| **50** | Revision 16 said `shutdownEpoch` moves "exactly once" while specifying `beginShutdown()` as an unconditional replacement, so a second or concurrent call moved it again | Terminal `shutdownStarted` latch set in the same replacement that first moves the epoch; later calls perform no replacement, do not reject, and await the same child stop (§1.9.3.2); RC13 asserts it | CORRECTED IN PLAN — NOT IMPLEMENTED |
| **51** | The size limit was applied to a size observed before the read, so a file that grew or was replaced could exceed it, and the plan implied cancellation covered the read and the parse | The cap applies to the **bytes actually read** from one open handle, stopping at `max + 1`; only that handle's bytes are parsed; the plan states that `AbortSignal` cannot interrupt `JSON.parse` or shape validation, that the cap bounds them, and that a post-parse elapsed-time check refuses an over-budget result (§2.4, §2.4.1); BT13–BT16 | CORRECTED IN PLAN — LIMITS NOT IMPLEMENTED |
| **52** | Revision 16 described an approved B1 as "call `discover()` and wrap it", which is the opposite of the decision B1 asks for | Approval permits the custom registration reader; refusal makes the official lifecycle route the alternative to be evaluated, with its caveats and side effects accepted first; approval never implies `discover()` (§2.10, §4.3, §13.1, §13.4) | CORRECTED IN PLAN |
| **53** | The missing-password refusal read as a decided product rule although the credential question is owner decision D4 | Labelled **PROPOSED PENDING D4** in every place it appears; a password-less design needs a separately reviewed authentication design and must never fall back to TBAi's managed password (§1.3, §1.5, §1.5.1, §1.6, §2.3, §2.8, §4.3, §13.1) | DESIGN GAP — **D4 OPEN** |
| **54** | The legacy evidence matrix carried one "2.1.x (any build)" row and had no relative-`OPENCODE_DB` observation, so one build could appear to cover a range and the working-directory ambiguity was unmeasured | One row per **named artifact** (version string and digest), no range row, unmeasured builds stay UNKNOWN; LB6 records the working directory, the value as given, the database file actually opened, and the `debug paths db` output (§2.9.1–§2.9.4). The range row was still present in the revision-17 file; finding 59 records that | CORRECTED IN PLAN — EVIDENCE STILL MISSING |
| **55** | Counts and cross-references still described revision 16 inside a revision-17 file (matrix 66, eleven RC rows, four exit criteria) | Re-derived from the saved file at revision 17: matrix **73**, RC1–RC13, **five** exit criteria, a revision-17 history row, and a §16.3 check that is run against this file. Revision 18 raised the matrix to 76 and the range to RC1–RC14; revision 19 raised it to **79**, RC1–RC15 and AT1–AT12, and the exit criteria to **six**; revision 20 raises it to **81**, RC1–RC16 and AT1–AT13. The numbers inside this row's first sentence are a record of what revision 17 contained, not the current totals | CORRECTED IN PLAN |
| **56** | The `Service.Info` type was cited at `dist/service.d.ts:64-82`, a range that does not exist in the installed `@opencode/client@2.2.0` (`service.d.ts` is 52 lines there), although it carried a **VERIFIED (code)** label | Citation corrected to `dist/service.d.ts:41-52`, which is the `Info` type in the installed package; the same `VERIFIED (code)` label now points at a range that exists. The upstream-repository citations (`packages/cli/src/services/service-config.ts`) could not be re-resolved in this workspace because no OpenCode source checkout is present here; they are carried over unchanged from the revision that checked them and are recorded as locally unverifiable in §16.3 | CORRECTED IN PLAN — UPSTREAM CITATIONS NOT RE-RESOLVED HERE |
| **57** | Revision 17 said "every start path captures a context first, and capture refuses after shutdown" while the same section had `captureOpenCodeRequestContext()` refusing `unresolved` — the state initial discovery runs in. It also gated the discovery transport on a `shutdownEpoch` **equality test only**, so a transport built after shutdown and handed the current epoch would have passed | Attempt creation is separated from request capture: `beginAttempt()` reads one snapshot, refuses on the `shutdownStarted` latch before any I/O, and otherwise stamps the attempt with that snapshot's epoch (§1.9.3.3). The discovery transport and the bounded transport both read one snapshot and refuse on the latch **or** an epoch mismatch (§1.9.4 step 2, §1.9.5); the §1.9.2.1 row that said the transport does not read `shutdownStarted` is corrected to say it does, from that same snapshot. AT10 asserts the initial attempt is possible and the post-shutdown one is refused before any file operation or request | CORRECTED IN PLAN — **NOT IMPLEMENTED OR VERIFIED** |
| **58** | `beginShutdown()` stored the shared completion promise **after** calling `AbortController.abort()`, which dispatches listeners synchronously; a listener that called `beginShutdown()` re-entrantly could observe no published promise and start a second transition or a second child stop | The shared completion is published to a module-private slot **before** `abort()` and before any external callback; every later or re-entrant call returns that identical object; the child stop runs in the single first-call branch only; a synchronous throw from the child stop settles the shared promise as `{ok:false, error}` instead of leaving it pending; adopted mode resolves `{ok:true}` without any process API (§1.9.3.2); RC14 asserts it | CORRECTED IN PLAN — **NOT IMPLEMENTED OR VERIFIED** |
| **59** | The revision-17 evidence table still contained a literal `2.1.x` row while the prose beside it said `2.1.x` is a range with no named members, and the revision-17 change log claimed no such row existed | The row is removed. A statement **outside** the table now says no `2.1.x` artifact is named or measured in this document and that there is no `2.1.x` row; `2.0.15` is kept as an explicitly unmeasured placeholder; each measured `2.1.x` artifact gets its own row keyed on digest, and no build stands for another (§2.9.2). The revision-17 log entry in §0.6 is corrected to admit the row and its removal | CORRECTED IN PLAN |
| **60** | The legacy evidence required the database file to be "observed on disk", which a pre-existing file or a CLI-reported path satisfies without showing that the **service** opened it | §2.9.1 now requires a process-level event tied to the measured service: exact path, operation, timestamp, verbatim `OPENCODE_DB`, working directory, `debug paths db` recorded separately, TBAi's ownership resolution recorded separately, and a canonical comparison with a same/different verdict — with the event attributed to the **OS-observed PID** of the process the launcher started, the registration `pid` corroborating it when a file exists or recorded as `registration absent`, the process start time, and the image hash against the **executable** digest (revision 20, findings 74–75; the revision-18 wording made the registration `pid` mandatory, which made a no-registration build unrecordable). A Windows process trace filtered to that PID is the named example. LB7 requires it for unset, absolute and relative `OPENCODE_DB` | CORRECTED IN PLAN — **EVIDENCE STILL MISSING (B5 blocking)** |
| **61** | §2.6 cited `dist/service.d.ts:17-22` for `DiscoverOptions` and `:24-31` for `EnsureOptions`; in the installed `@opencode/client@2.2.0` those types are at **16–21** and **25–32** (`service.d.ts` is 52 lines). The same sweep found four more ranges that stopped short of the declaration they named: `promise/service.js:116-118` for `stop()` (the function runs 116–121), `promise/service.js:124-132` for `read()` (122–133), `effect/service.js:28-37` for `discover()` (29–38), and `promise/service.js:39-113` for `ensure()` (39–115) | Every range corrected to the lines that hold the declaration. Found during the revision-18 re-audit, not reported by a reviewer | CORRECTED IN PLAN — CITATION ONLY |
| **62** | Revision 18's `beginAttempt()` allocated an id and returned the record without **registering** it as the current attempt or aborting the previous one, and `isAttemptActive` compared against state nothing updated. A synchronous abort listener could re-enter `beginAttempt()`, so an older outer invocation could finish last and leave the slot pointing at the older attempt | `beginAttempt()` now takes one snapshot, refuses on the latch, builds the record, registers it as current and takes the previous attempt in the **same** synchronous step, aborts the previous at most once, then re-reads the slot **and** the latch and throws `OpenCodeAttemptSupersededError` or `OpenCodeNotReadyError` rather than returning a dead attempt. A superseded attempt cannot begin registration I/O or a probe because both entry points call `isAttemptActive` before their first `lstat`/open/read/fetch (§1.9.3.3, §3.1, §3.2 condition 5); AT11 and AT10 assert it | CORRECTED IN PLAN — **NOT IMPLEMENTED OR VERIFIED** |
| **63** | AT10(c) required a discovery transport built with a **caller-supplied post-shutdown epoch**, while `createDiscoveryProbeTransport(attempt, candidate)` accepts no epoch and `beginAttempt()` refuses on the latch. The test therefore described an input the production API cannot produce, so the verification claim resting on it was unsupported | The production API keeps no epoch parameter and gains none. §1.9.5 separates the production invariant (no production path can hold a post-shutdown epoch; the latch check is defence in depth) from a declared test-only seam, `setShutdownStateReaderForTests`, that makes the otherwise-unreachable state constructible. AT10(c) and TT3's latch half use the seam and assert only that the latch check is live; AT10(a), (b) and (e) assert the production path with no seam; TT6 scans for the seam's single declaration site | CORRECTED IN PLAN — TEST NOT IMPLEMENTED |
| **64** | "The managed child" could name three different processes — the published `this.child`, a child spawned by an attempt that lost the race, or a child a fallback had just started. Revision 18 assigned cleanup to several paths without stating the child's identity or whether two paths could stop the same process twice, so "clean up its own child" and "the child stop runs exactly once" could not both be read as true | Identity is the `Subprocess` object; `this.child` is only a publication pointer (`serverManager.ts:253`, `:376`, `:418-419`); a live-child registry is populated synchronously at `spawn()`; `stopChild(child)` memoises one promise per child in a `WeakMap`, and the shutdown path, a post-shutdown readiness completion, a superseded managed attempt and a fallback all join that one stop. No completion, rejected or not, starts a second independent stop; a child spawned but never published is still stopped because the registry does not depend on publication (§3.4, §1.9.3.2 step 4); AT12 counts stop invocations per child in all four cases | CORRECTED IN PLAN — **NOT IMPLEMENTED OR VERIFIED** |
| **65** | §1.9.3.2 said the shared shutdown completion "always settles" while the mechanism handled only a **synchronous** throw. An asynchronously rejected child stop would have rejected the shared promise — so every caller receives a rejection rather than the documented typed result — and could surface as an `unhandledRejection`. A stop that never settled left the promise pending with no bound, contradicting the same sentence | Both failure shapes reach one typed `{ok:false}` result, the shared promise **resolves and never rejects**, and all callers — first, later and re-entrant — receive that identical promise. A non-settling stop is bounded by the two-phase `opencodeChildStopGraceMs` / `opencodeChildStopKillMs` and resolves `termination_unconfirmed`; "always settles" is now stated as bounded by that mechanism, with a blocked event loop named as the residual it cannot cover (§1.9.3.2, §12.5, §12.6). Revision 19 used `Promise.resolve(invokeStopSafely()).then(onResolved, onRejected)`, whose argument is evaluated before the promise exists; revision 20 replaces it with invocation inside a promise callback (finding 71), and RC15 gains a pre-return-throw variant. RC15 asserts async rejection, zero `unhandledRejection`, object identity, one log, and the non-settling bound; §1.9.8 criterion 3 states it | CORRECTED IN PLAN — **NOT IMPLEMENTED OR VERIFIED** |
| **66** | G4's containment check computed `path.relative(root, path.resolve(root, document.path))` and then rejected only when that result was absolute. For an absolute path **inside** the root, `path.relative` returns a relative path, so the check accepted it while CT5 declared "absolute path" a negative case: the test was broader than the rule. The write API was also implied but never named or checked | §9.3 now states the policy explicitly (Policy B: an absolute path **inside** the root is accepted, because `/api/config` names the document absolutely; an absolute path **outside** it is refused), with a pre-resolution policy step, a `rootAbs`/`input`/`inputAbs`/`relative` check, a Windows-form refusal table justified by the R19 probe (drive-relative input escapes `path.resolve`; the generic check accepted an alternate-data-stream suffix), a junction test, and write-through-validated-handle with the measured `truncate` requirement. CT5 gains the inside-root positive control so the test and the rule have the same scope (§9.3, §11) | CORRECTED IN PLAN — **G4 STILL BLOCKING** |
| **67** | LB7 required a "process-level" observation but §2.9.1 gave only an example ("a Windows process trace filtered to that PID") with no tool, no filter, no capture window, no required operation or status, no export fields and no retention rule. Two testers would produce incomparable evidence, and a path filter would attribute a file event to a process that never opened it | §2.9.1.1 prescribes one method: the tool and privilege; a **process-name** filter set before launch and a path filter explicitly forbidden for attribution; PID attribution after launch in four steps, the first being the OS-reported process identity (revision 20, finding 74); the capture start/stop boundaries; `CreateFile` with `SUCCESS` and its disposition as the required event, with corroborating operations recorded and failed opens not counted as evidence; the exported fields; retention outside the repository with a SHA-256; and the attribution checks reviewed. What the trace establishes — and what it does not — is stated, and `debug paths db`, TBAi's ownership resolution and the process event remain three separate observations (§2.9.1.1, §12.2). LB7 refuses a result recorded by any other method | CORRECTED IN PLAN — **NO TRACE RUN; B5 STILL BLOCKING** |
| **68** | The 2.2.0 row sat inside the matrix that is keyed on artifact digest, but that row carried no digest, so the table implied an artifact identity that had not been recorded | The row is removed from the matrix; the `2.0.15` unmeasured placeholder remains. The 2.2.0 observation is kept **outside** the exact-artifact matrix as a historical probe record labelled `VERIFIED (probe R4)`, with "Artifact digest: **Not recorded**", stating that it does not satisfy the build-identity rule and closes neither E1 nor B5. No digest was invented for it, and deleting a measurement to tidy the table would have been worse than labelling it (§2.9.2, §12.2) | CORRECTED IN PLAN — E1 AND B5 STILL OPEN |
| **69** | Revision 19 assigned a managed child to the **attempt that awaited it**: §3.2 said a superseded attempt "still has to clean up its own child" and that a newer attempt "may already own a different child", and AT12(c) asserted one stop for A's child and zero for B's. Both statements contradict `ensureBaseUrl()`, which returns one in-flight promise (`serverManager.ts:309-326`), so two attempts can await and receive the **same** `Subprocess`; a stale attempt's cleanup could then stop the child a valid attempt is about to publish and use | Ownership moves to the **manager**: a child is owned from the tick it is spawned and is tracked in the live-child registry independently of `this.child`; attempts are consumers. A superseded attempt **requests** cleanup (`requestChildCleanup`) and the manager refuses unless four conditions hold — no active attempt is waiting, no caller can still receive the child from the shared start promise, the child is unpublished or the requester is shutdown, and it is not already claimed. Shutdown is the one path exempt from the first two. §3.2, §3.4, §3.5, §1.5.1 row 8, §12.5 and §1.9.8 criterion 6 are rewritten; AT12(c) now covers a single waiter and **AT13** asserts the shared-promise case where the stale attempt's request is recorded as refused and the child is stopped exactly once at shutdown | CORRECTED IN PLAN — **NOT IMPLEMENTED OR VERIFIED** |
| **70** | Revision 19's `stopChild()` memoised one promise per child in a `WeakMap` but did not state **when** the entry is created, so a caller entering synchronously during the first stop's initiation — from its own callback, or from an abort listener the signal dispatches — could find no entry and start a second escalation. The same text said "joining never starts a stop", which conflates obtaining a per-child promise with the aggregate wait | The ordering is mandatory and stated: check the map; return the existing promise; otherwise construct it and **publish it in the `WeakMap`**; only then begin the signal/escalation sequence; resolve the published promise with the documented result. A re-entrant caller therefore receives the identical promise and performs no process API call. "First call starts, later calls join" is distinguished from step 4's `Promise.allSettled`, which only waits on promises that already exist (§1.9.3.2, §3.4). **RC16** asserts identity, one `SIGTERM`, at most one `SIGKILL` decision, and one settled outcome at two injection points | CORRECTED IN PLAN — **NOT IMPLEMENTED OR VERIFIED** |
| **71** | Revision 19's handler — `Promise.resolve(invokeStopSafely()).then(onResolved, onRejected)` — claimed to catch a synchronous throw but does not: the call is an **argument**, evaluated before `Promise.resolve` is invoked, so a throw raised before the operation returns anything escapes the chain entirely. That is exactly the shape a stop's first line can produce (a process handle already gone, a synchronous assertion, a throwing stub in a test) | The operation is invoked **inside** a promise callback — `new Promise<ShutdownResult>((resolve) => resolve(invokeStopSafely()))`, or an explicit `try/catch` that returns a rejected promise — so evaluation happens after the promise exists. All three outcomes (value, synchronous throw including a pre-return one, asynchronous rejection) reach the same typed result, the shared completion still resolves and never rejects, and no `unhandledRejection` is created. RC15 gains a third variant that injects an operation throwing before it returns; RC14 and RC16 are reconciled to the same boundary (§1.9.3.2, §12.5) | CORRECTED IN PLAN — **NOT IMPLEMENTED OR VERIFIED** |
| **72** | §9.3's write step was one `FileHandle.write()` followed by `truncate(buf.length)`. `write()` reports `bytesWritten` and nothing required the guard to check it, so a short write would be followed by truncation to the full payload length — a file of the right length with wrong content, reported as a successful configuration update | The write is a **complete-write loop**: explicit offset, write the remaining buffer at that offset, advance by `bytesWritten`, treat zero progress or a rejection as a typed failure (`short_write`), and truncate **only after** every byte has been written; `sync()` and `close()` follow on the same validated handle, with no second path-based open and no `Bun.write`. CT8 injects a deterministic short write and a zero-progress write; a failed write must not be reported as a successful configuration update (§9.3 step 7, §11) | CORRECTED IN PLAN — **NOT VERIFIED** |
| **73** | The `lstat`/`fstat` identity check of §9.3 step 6 rested on a probe that showed only that the two calls **agree for one file** — equally consistent with the pair being constant for every file, in which case the check could never fail | The R20 probe measured discrimination in a disposable directory: two distinct files differ in `ino` on the same `dev`, a hard link reports the identical pair, a deterministic substitution between the validation `lstat` and the open yields `differ = true` with differing size, and a no-substitution control yields `differ = false`. §9.3 step 6 and CT8 now require the distinguishing case, the substitution case, and an accepted control, so a comparison that always agrees fails the test. Measured on **one NTFS volume on one machine**; a filesystem that cannot discriminate must make the guard refuse the write, and G4 stays blocked there. UNKNOWN-1 and the reparse-point race are **not** closed (§9.3, §11 CT8, §12.6) | CORRECTED IN PLAN — **NOT VERIFIED; UNKNOWN-1 STILL UNKNOWN** |
| **74** | §2.9.1 and LB7 required the traced PID to equal "the `pid` in the registration record written by **this** run". B5 exists to measure builds that may write no registration at all, so the requirement made the missing-registration case unrecordable: LB4 could not produce a valid evidence record, and the first B5 question had no admissible answer | The primary identity is the **OS-observed process**: the PID and start time of the process the tester's launcher actually created, taken from the launcher's process handle and recorded with the method that produced it. The registration file is still read and its `pid` compared when it exists; when it does not, the record states **`registration absent`** and the OS identity carries the Procmon attribution. A mismatch is a finding and the run does not satisfy B5. §2.9.1, §2.9.1.1, §2.9.4 (LB1–LB4, LB6–LB7), §12.2 and §13.2 are updated; the process filter is unchanged and a path-only filter stays forbidden | CORRECTED IN PLAN — **EVIDENCE STILL MISSING** |
| **75** | §2.9.1 required the running image to hash to "the artifact digest" in the build-identity field, where that field held the **package** (installer or archive) digest. An installer or archive digest cannot equal the hash of an executable extracted from it, so the identity check as written was unsatisfiable for any packaged build and did not describe which artifact was measured | Two fields, two measurements: the **package digest** (installer/archive) with its name and download date, and the **executable digest** (the file the PID runs) with the extraction relationship — archive member path, or installer product and version; a bare-executable artifact records the same value twice and says so. The image hash is checked against the **executable** digest only; no equality between the two digests is required or expected. §2.9.1's table and identity checks, §2.9.1.1's exported fields and reviewer check, §2.9.2's key, LB1, and §11's exact-build rule are updated. The historical R4 observation still has **no** digest, invented or otherwise | CORRECTED IN PLAN — **EVIDENCE STILL MISSING** |
| **76** | Revision 20 gave `stopChild()` **two** promise constructions and called them equivalent: `new Promise<ShutdownResult>((resolve) => resolve(invokeStopSafely()))` and `Promise.resolve().then(() => invokeStopSafely())`. The first runs its executor **synchronously inside the constructor**, so the stop is invoked before the caller can store the promise in the `WeakMap` — the exact ordering the same section required. A synchronous callback inside `invokeStopSafely()` that re-entered `stopChild(child)` would find no entry and start a second escalation | **One** construction, in six ordered steps: check the per-child `WeakMap`; return an existing promise; otherwise create a promise whose executor runs nothing but capture `resolve` (no process API, no external callback); store it in the map; only then schedule the operation as a microtask — `try { runStopSequence(child).then(settle, (e) => settle({ok:false, error:e})) } catch (e) { settle({ok:false, error:e}) }`; resolve the published promise with the documented result. Steps 1–4 are synchronous and contain no process call. **RC16 fails any implementation shaped as `new Promise((resolve) => resolve(invokeStopSafely()))`** because no promise can be in the map when the stop begins (§1.9.3.2, §3.4, §1.9.7, §12.5, §12.7) | CORRECTED IN PLAN — **NOT IMPLEMENTED OR VERIFIED** |
| **77** | Revision 20 made "no other path has already claimed it" the **fourth condition** on whether a cleanup request may start a stop, while the same section said a later request **joins** the published promise. A request arriving after shutdown had published a stop failed that condition, so the stated rule refused it — while the join contract required it to receive the identical promise. The two rules disagreed for exactly the caller the first conditions exist to protect | The order is now explicit and single-valued: look the stop up **first** and return that identical promise if one exists, whatever the requester and whatever its eligibility; only when none exists evaluate initiation eligibility (three conditions, §3.4); a refusal is logged and touches nothing — no process API, no waiter change, no map entry; a request that joins is **never** recorded as refused. Condition 4 is deleted and replaced by the lookup, which is stronger. AT12(a) and (b) and RC16 assert a post-shutdown request joins with **zero** further process calls (§1.9.3.2, §3.4, §3.5, §1.9.7, §1.9.8) | CORRECTED IN PLAN — **NOT IMPLEMENTED OR VERIFIED** |
| **78** | Revision 20 made cleanup eligibility depend on "no active attempt holds a waiter" without saying where a waiter is recorded, who writes it, or when it is released — so the condition could not be evaluated by an implementer or asserted by a test. AT12(c) then described a state ("no caller can still receive the child") that the single cached `ensureBaseUrl()` promise (`serverManager.ts:309-326`) makes unreachable while that promise is still handable | §3.4.1 names four manager-private structures — `liveChildren Set<Subprocess>`, `startBinding {startId, promise, child, settled}`, `childStartId WeakMap<Subprocess, number>`, and `startWaiters Map<number, Set<WaiterRecord>>` — with `WaiterRecord = {attempt, startId, released}`, the count rule `!released && isAttemptActive(attempt)` ("release is the event, `isAttemptActive` is the authority"), per-start keying, four synchronous registration steps, four release points (readiness success, readiness failure, abort/cancellation, supersession), and an in-flight `readyPromise` that makes a start still running refuse cleanup. Condition 2 has two halves: an **unsettled** start defers; a **settled** start that names the child is **withdrawn by the decision itself** — the cached binding for that child is evicted synchronously before the stop is published, so a later `ensureBaseUrl()` spawns afresh rather than handing out a child about to be signalled; and the current-child pointer is detached by identity in the same block, so the stop's exit takes `onExit`'s early return and cannot auto-restart the service being retired. AT12(c) establishes the eviction, the detach and the fresh spawn **before** claiming eligibility; AT13 asserts the active newer attempt's waiter is the reason the stale stop is refused and carries a control variant that removes it (§3.2, §3.4.1, §3.5, §12.5) | CORRECTED IN PLAN — **NOT IMPLEMENTED OR VERIFIED** |
| **79** | Revision 20 specified the G4 write **in place**: open the destination, complete-write loop, `truncate`, `sync`. A partial write followed by zero progress or a rejection leaves the destination **modified**, which CT8 forbade — the preservation claim and the mechanism could not both be true, and the guarantee was the false one. `Bun.write(path, …)` had been removed for the same class of reason one revision earlier | The write is transactional by replacement: an exclusively created sibling temp file in the **validated** directory, full-path validation and identity checks retained, a complete-write loop, `sync`, then a defined **commit point** — a replace-rename over the destination, the only mutation the destination ever suffers. Failures before the commit (zero progress, short write, rejection, truncate failure, sync failure) delete the temp and leave the destination byte-identical by construction; a rename failure leaves it untouched and the temp intact. No directory `sync()` is claimed, because the R21 probe measured `EPERM` on one. CT8 gains five deterministic sequences — partial-then-zero-progress, partial-then-rejection, truncate failure, sync failure, and a successful commit — each re-reading the destination. Preservation is **not** claimed for a *different* process holding the destination open, ACL inheritance, or crash durability; those are UNKNOWN and keep G4 blocked (§9.2, §9.3, §11, §12.3, §12.6) | CORRECTED IN PLAN — **G4 STILL BLOCKING** |
| **80** | §2.9.2 said one row per measured artifact and then keyed the row on the **executable digest** alone, "because that is what runs". Two different packages can ship byte-identical executables, and one package can ship several members, so distinct observations would collapse into one row — and a bare executable and a packaged one with the same image would be indistinguishable | The row identity is the composite tuple of §2.9.2: reported version, package artifact name **and** digest, extracted executable path/member **and** digest, and extraction provenance (with the literal `bare executable` where it applies). Two packages with the same executable digest are **two rows**. The bare-executable rule is stated separately, and LB1 rejects a record keyed on the executable digest alone, one carrying a single unlabelled digest, or one that duplicates the digests without the label. No digest is invented for the historical R4 observation (§2.9.1, §2.9.2, §2.9.4, §11, §13.2, §16.2) | CORRECTED IN PLAN — **EVIDENCE STILL MISSING** |
| **81** | §2.9.1 called the process the launcher created "the service" and recorded its PID as the primary identity. With a `.cmd` shim, an `npm` wrapper, `Start-Process`, `powershell -Command`, or a shell pipeline that PID is an intermediate process: a database event would be attributed to the launcher, or not found at all, and a registration `pid` naming the real service would read as a mismatch | The primary identity is the **service image's own PID**, established by resolving the recorded process tree and selecting the process whose image hashes to the executable digest; every hop records PID, parent, start time, image path and image hash. That PID supplies the event attribution and the start time; the registration `pid` corroborates it, and a registration naming a launcher is recorded as a **finding**, not a pass. Zero or ambiguous matches produce **no row** rather than a guess, and a missing registration stays a valid observation. A wrapper changes which PID is recorded, never whether one is (§2.9.1, §2.9.1.1, §2.9.4, §12.2, §13.2, §16.2) | CORRECTED IN PLAN — **EVIDENCE STILL MISSING** |
| **82** | §16.3 reported the saved file as 3,630 lines and 356,760 bytes, while the review copy of the same text was reported at 360,390 bytes — exactly 3,630 more, one per line. Neither number said which rendering it measured, so a CRLF copy's byte count could be read as the file's | The working-tree file was measured directly: **LF**, zero `CR` bytes, and `git ls-files --eol` reports `i/lf w/lf`. `core.autocrlf` is `true`, so a checked-out/uploaded CRLF rendering gains exactly one byte per line, which reproduces the reported delta. §16.3 now states the rendering **beside** every count it gives, reports the review copy as REPORTED rather than measured, and does not present a normalised count as the file's (§16.3) | CORRECTED IN PLAN — COUNT ONLY |
| **83** | Revision 21's managed-start path called `ensureBaseUrl()` and only **then** took or created a binding and registered the caller's waiter. Because an async function's synchronous prefix runs before its caller receives the promise, a `start()` that ever reached `createChild()` before its first `await` would spawn a child before any binding or waiter existed. The installed code happens to await `databaseLease.acquire` first, so the window is narrow — but the ordering was a property of one line, not of the protocol | Acquisition is a synchronous **reservation**: `acquireManagedStart(attempt \| null)` allocates a unique `startId`, creates and publishes the deferred in `startRecords` and `this.readyPromise`, registers every joining attempt's waiter with its abort listener, and only then schedules `runManagedStart()` as a microtask. Spawn attribution (`liveChildren`, `childStartId`, `record.child`, `this.child`, `this.port`) is one synchronous block on `createChild()`'s return. Delivery is checked by `deliverable()`, which a withdrawal flips before publishing a stop. **AT15** asserts the record and waiters at the spawn injection point, including a re-entrant join and a revision-21-shaped control that must fail (§3.4.1, §3.5) | CORRECTED IN PLAN — **NOT IMPLEMENTED OR VERIFIED** |
| **84** | Revision 21 left the start-failure path implying that a rejected start had released its waiters and that `start()`'s catch could clean up the child. Neither followed from the code: the catch kills only three error types (`serverManager.ts:429-441`), it does not join a shutdown that is already stopping the child, and nothing released the waiter records | Settlement is one function with a stated order: idempotence, state, **release every waiter on rejection** (triggers suppressed), one cleanup request through the coordinator while C1 is empty and C2 is settled, binding eviction **by identity**, and the shared outcome delivered **last**. A start with no waiters (the manager-owned keep-alive restart) takes the same path; a shutdown that already published the stop is joined. **AT14** asserts the exact sequence and the intermediate state, with controls for pre-spawn failure, a newer start, and the keep-alive case (§3.4, §3.5) | CORRECTED IN PLAN — **NOT IMPLEMENTED OR VERIFIED** |
| **85** | Revision 21 committed a write by `rename` after a final `lstat` identity check. `rename` resolves the destination **by name**, so a file substituted between that check and the rename is what gets replaced; the check-to-rename race was not closable by any check placed before it. The same section's promise that a failed replacement preserves the destination did not cover destruction of the substituted file | The commit is **create-only**: `fs.link(temp, destination)` succeeds only into an absent name and fails `EEXIST` otherwise (probe R22, including an observed absence followed by a created invader). A destination present at validation is refused `replace_unverified` **before any temp is created**; the initial-ENOENT → create race is closed by the link's own atomicity. Replacement is withdrawn rather than claimed, no exported API is asserted to close the identity race (`fs.replaceFile`/`fs.renameat2` undefined; `fs.rename` replaced a substituted file), and **D5** records the owner decision. G4 stays BLOCKED (§9.3 steps 6–7, §13.1, §12.3) | CORRECTED IN PLAN — **G4 STILL BLOCKED** |
| **86** | Revision 21 stated that "both outcomes preserve the old document; only one of them is a successful write" and required an unmeasured ACL-preservation property for a replacement. The sentence described a replacement path that could destroy a substituted file, and the ACL requirement had no implementable test | The sentence is **withdrawn** with the replacement path: on the create path there is no previous document, and on `EEXIST` the creator's file is untouched. The ACL contract is now **verification of inheritance**, implementable as CT8 cases: read the temp's SDDL via PowerShell, classify ACEs by the `ID` flag, compare with the directory's propagated set, refuse `acl_explicit_unexpected` or `acl_unverifiable` (fail closed), and prove the delivered file is the same inode. No preservation claim is made, and the post-replacement ACL case is withdrawn because no replacement occurs (§9.3 step 7f, §11 CT8, §12.3) | CORRECTED IN PLAN — **NOT IMPLEMENTED OR VERIFIED** |
| **87** | Revision 21 had `requestChildCleanup()` and `stopChild()` each evaluate eligibility, and a request that failed a condition was recorded as a refusal with no future owner — so a child could stay alive because every path assumed another would clean it up. `onExit` also keyed its restart decision on the current-child pointer rather than on whether the child's stop was published | There is **one** decision point, `requestChildCleanup(child, request)`, with lookup-first joining; `stopChild()` is publication only and evaluates no condition. A request that cannot initiate records a **pending obligation** retried at four named triggers — last-waiter release (T1), start settlement (T2), target clear (T3), shutdown (T4) — and is deleted only with a named successor. Shutdown copies `liveChildren` synchronously, including detached-pointer children; `onExit` refuses to restart a child in `childStops`. **AT12(c)** and **AT13** assert the intermediate state, the obligation and its retry (§3.4, §3.4.1, §12.5) | CORRECTED IN PLAN — **NOT IMPLEMENTED OR VERIFIED** |
| **88** | The matrix and the verification record were written for revision 21, and §0's log numbering changed when revision 22 inserted a log ahead of it; the citation row also presented a resolution count without saying which citations could not resolve here | The matrix is **83** (AT14, AT15 added; AT12(c), AT13 and CT8 changed in content); §0.1–§0.7 are the current log order and every internal reference was rewritten; §15 gains revision 22; §16.3 is a check of this saved file, reports the citation result as **partial** with exact counts and the reason for each unresolved citation, and states the line-ending/byte rendering it measured (§0, §11, §15, §16.3) | CORRECTED IN PLAN — COUNT AND RECORD ONLY |

Finding 37's acceptance criteria are retained unchanged and are not satisfied by this document:
RC1–RC16 (§1.9.7) must be implemented and pass, and the six exit criteria in §1.9.8 must hold. A
written correction is not a fix — and finding 39 is the reason a written correction was needed twice:
the first correction removed the independent getters but introduced a counter that could not express
both requirements. Finding 49 is the same class of error one level down: revision 16 removed the
split between the getters but left the credential reachable through a reference it did not own.
Findings 57 and 58 are the same class again in revision 17: a prose claim ("every start path
captures first") that the mechanism did not support, and an ordering in which the publication
followed the synchronous callback that could re-enter it. Findings 62–68 are that class a third time
in revision 18's own text: 62 and 64 describe a mechanism whose prose promised a guarantee
(one current attempt, one stop per child) that its steps did not implement; 63 and 67 describe a
verification claim whose described input or procedure did not exist; 65 and 66 describe a guarantee
whose stated scope was wider than the rule behind it; 68 is a table that implied an identity it had
not recorded. Findings 69–75 are that class a fourth time in revision 19's own text: 69 gave a shared
child a single owner that cannot exist; 70 implied an ordering it had not stated; 71 claimed a catch
the expression could not perform; 72 specified a write whose failure mode it never checked; 73 based
an identity test on evidence that could not distinguish its two outcomes; 74 made the evidence
standard exclude the case the evidence exists to measure; 75 required an equality an installer cannot
satisfy. Findings 76–82 are that class a fifth time in revision 20's own text, and this time all
seven were found by reviewing the plan against itself rather than by a reader hitting the defect in
use: 76 offered a construction that violated the publication order stated beside it; 77 wrote a
refusal rule that contradicted the join rule in the same section; 78 named a condition whose state had
no owner; 79 promised preservation from a mechanism that could not preserve; 80 keyed a row in a way
that merged distinct observations; 81 named as "the service" a process a wrapper can make an
intermediary; 82 reported a count without saying which rendering it measured. RC14, RC15, RC16,
AT10–AT13 and the extended CT8 are proposals, not results.

### 14.2 Platform evidence, restated precisely

| Claim | Label |
|---|---|
| The installer target is `nsis` | VERIFIED (code/config) |
| CI builds on `windows-latest` / `x86_64-pc-windows-msvc` | VERIFIED (code/config) |
| The product supports only Windows | INFERRED |
| macOS/Linux are unsupported because no CI job exists | **Not claimed** — absent evidence is not negative evidence |

### 14.3 Historical findings

Findings recorded before the saved document's register was truncated are **historical**. Several
described defects that were real when they were written; they are not current statements about the
code, and none of them is evidence that this revision's proposals work. They are not restated here,
because restating them as if they described today's tree would be the same error this revision
corrects elsewhere: a historical observation presented as a current fact. Where a historical defect
still exists, it appears as a current entry above (§14.1) or as a blocker (§13), not as history.

---

## 15. Revision history

| Revision | What it did |
|---|---|
| 1–3 | Initial survey; R2/R3 probes (reported, not rerun) |
| 4 | Redirect measured (R4); initial redirect policy |
| 5 | Redirect policy extended to all credential paths (R5 measurements) |
| 6 | Registration-file behavior measured (R6) |
| 7 | Adopted-credential handling measured (R7) |
| 8–10 | Earlier findings recorded. Their register was not preserved in the saved document, so this revision does not quote it (see §14.1, §14.3). |
| 11 | Request-context problem identified; carried forward here as finding 37 |
| 12 | Attempt identity and ownership added |
| 13 | Corrections to timing and writer claims |
| 14 | Intended to restore §1.9 and correct §§2.2/2.5/6.4/7/13/14. **The document saved before revision 15 was truncated at §2 and contained no §1.9, no §§3–16, and no corrected §2.2.** Its change log described changes that were not in the file. This revision does not repeat that claim. |
| 15 | Authors, in the saved file: §1.8 consistency fix, §1.9 in full (RC1–RC10), §2 in full (beta correction, writer correction, timing correction, BT1–BT12), §§3–16. Corrects the verdict narrative. Nothing implemented or tested. |
| 16 | Repairs the revision-15 contradictions and restorations listed in revision 16's change log, which this file does not retain: separates `revision` from `shutdownEpoch` and proves the seven B8 properties (§1.9.2.1–§1.9.8); applies one shutdown policy everywhere; restores the historical blocker IDs and adds the crosswalk (§13.4); restores the legacy `OPENCODE_DB` gap as B5 and adds §2.9; adds the lifecycle boundary §2.10 (B1); removes the duplicated Basic-auth formula and specifies `Request`+`init` merging; replaces "fallback (any failure)" with a ten-case table; adds concrete read limits and cancellation; reclassifies the config-write gap as gate G4 and disables adopted writes; names a proposed file per test group and grows the matrix to 66. **Document only: nothing implemented, no test run, no probe rerun.** |
| 17 | Corrects the seven areas listed in §0.6: the reversed B1 condition; deep immutability with RC12; an idempotent `beginShutdown()` with RC13; a size cap applied to the bytes actually read, with BT13–BT16 and the `JSON.parse` limitation stated; D4 labelled **PROPOSED PENDING D4**; the legacy build matrix keyed per named artifact with LB6 for a relative `OPENCODE_DB`; and a re-audit of the whole saved file, taking the matrix to 73 proposals. **Document only: nothing implemented, no test run, no probe rerun.** |
| 18 | Corrects the six areas listed in §0.5: attempt initiation is separated from request capture by `beginAttempt()` and the epoch-only transport gate gains the shutdown latch (AT10); the re-entrant-shutdown publication hole is closed by publishing the shared completion before `abort()` and making it always settle (RC14); the contradictory `2.1.x` row is removed from the evidence matrix and the revision-17 log claim about it corrected; the legacy database evidence requires a PID-tied process-level file event with a ten-field capture (LB7); the declined-B1 alternative is disambiguated into the three official lifecycle calls with the exact `discover()` surface named (§2.10.1); and a full re-audit takes the matrix to **76** proposals, adding finding 61 for two stale `service.d.ts` ranges. **Document only: nothing implemented, no test run, no probe rerun, no real process or credential touched.** |
| 19 | Corrects the seven areas listed in §0.4: `beginAttempt()` now registers the attempt, takes and aborts the previous one once, and re-reads the slot and latch so a re-entrant supersede throws instead of returning a dead attempt (AT11); AT10(c) and TT3's latch half are rebuilt on a declared test-only state-reader seam instead of a caller-supplied epoch, with the production invariant stated separately (no epoch parameter is added); managed-child cleanup gains one identity per child, a live-child registry and a memoised per-child stop so every path joins one stop and a rejected completion never starts a second (AT12); the shutdown completion handles asynchronous rejection as well as a synchronous throw, resolves rather than rejects for every caller, and bounds a non-settling stop instead of asserting it "always settles" (RC15); G4's absolute-path policy is stated and the containment check, the Windows refusal forms and the validated-handle write are made coherent with CT5, which gains an inside-root positive control; LB7 gets a prescribed capture procedure (§2.9.1.1); and the undigested 2.2.0 row leaves the digest-keyed matrix for a labelled historical probe record. A full re-audit takes the matrix to **79** proposals and adds findings 62–68. Two capability probes were run (§0, `VERIFIED (probe R19)`) in disposable temp directories. **Document only: nothing implemented, no test run, no real process, registration file, database or credential touched.** |
| 20 | Corrects the eight areas listed in §0.3: managed-child ownership moves from the awaiting attempt to the manager, with four eligibility conditions for a stale attempt's cleanup request (**AT13** covers two attempts sharing one `ensureBaseUrl()` start promise); `stopChild()` must publish its per-child promise before signalling, so a re-entrant caller joins rather than escalates (**RC16**); the child stop is invoked inside a promise callback so a throw raised before it returns reaches the typed result (RC15 third variant); the G4 write is a complete-write loop with offset advancement and zero-progress failure, not one `write()` plus `truncate()` (CT8); the `dev`/`ino` identity check is backed by a measured discrimination-and-substitution probe (R20, CT8); LB7's primary PID is the OS-observed process identity so a build that writes no registration is recordable; and package and executable digests are separate fields with no required equality. `beginAttempt()`'s description now states its two reads — creation and revalidation — instead of one. A full re-audit takes the matrix to **81** proposals and adds findings 69–75. One capability probe was run (§0, `VERIFIED (probe R20)`) in a disposable temp directory; R4–R7 and R19 were **not** rerun. **Document only: nothing implemented, no test run, no real process, registration file, database or credential touched.** |
| 21 | Corrects the seven areas listed in §0.2: `stopChild()` has **one** construction that publishes its promise in the `WeakMap` before anything is scheduled or signalled, so the synchronous-executor alternative is removed and RC16 fails it; joining an existing stop is separated from eligibility to initiate one, with the lookup unconditional and condition 4 deleted (AT12(a)/(b), RC16 assert zero further process calls on a post-shutdown join); the manager-owned waiter registry is specified — four structures, `WaiterRecord`, one count rule, four synchronous registration steps, four release points, two halves for condition 2, and the synchronous eviction of a settled start binding plus the identity-guarded detach of the current-child pointer before an uninstalled child is stopped, so the stop's exit cannot auto-restart it — with AT12(c) and AT13 asserting registration, release and eviction directly and AT13 carrying a control variant; the G4 write becomes transactional by replacement with a defined commit point, a failure taxonomy that preserves the prior document by construction, and five deterministic CT8 sequences, while ACL inheritance, cross-process handles and crash durability stay UNKNOWN and keep G4 blocked; the exact-build row is keyed on the §2.9.2 composite tuple rather than the executable digest alone, with a separate bare-executable rule; the primary process identity is the resolved **service-image PID** from a recorded process tree, not a launcher, with zero/ambiguous resolution producing no row; and §16.3's counts now state the rendering they measured. The matrix stays at **81** proposals — no ID was added or removed — and findings 76–82 record this revision. One capability probe was run (§0, `VERIFIED (probe R21)`) in a disposable temp directory that the script created and removed; R4–R7, R19 and R20 were **not** rerun. **Document only: nothing implemented, no test run, no real process, registration file, database or credential touched.** |
| 22 | Corrects the seven areas listed in §0.1: managed-start acquisition is a **synchronous reservation** — a unique `startId`, a published deferred, and every joining attempt's waiter all exist before `runManagedStart()` is scheduled, and spawn attribution is one synchronous block (§3.4.1); start settlement has a single owner and a stated order — state, waiter release on rejection, one cleanup request, identity-guarded eviction, and the outcome delivered last (§3.4); cleanup has **one** coordinator with lookup-first joining, three conditions and four named retry triggers, and `stopChild()` is publication only (§3.4); the G4 commit becomes **create-only** (`fs.link` into an absent destination) because no exported API closes the check-to-rename race for a present one, with the destination-appearance race closed by the link's atomicity, an ACL **inheritance-verification** contract, and a `beforeCommit` test hook (§9.2, §9.3); the G4 blockers, D5 and the counts are recorded (§12, §13, §16); AT14 and AT15 are added and AT12(c), AT13 and CT8 rewritten, taking the matrix to **83**; and §16.3 is a check of this saved file with a **partial** citation result. Findings 83–88 record this revision. One capability probe was run (§0, `VERIFIED (probe R22)`) in a disposable temp directory that the script created and removed; R4–R7, R19, R20 and R21 were **not** rerun. **Document only: nothing implemented, no test run, no real process, registration file, database or credential touched.** |

**What "revision 22" means here.** Revisions 15–22 were each checked against the saved file rather
than against a draft, and §16.3 is the check for this one. Revision 22 makes **no** claim that a
contradiction repaired on paper is a defect repaired in code: every corrected item above is listed as
`CORRECTED IN PLAN — NOT IMPLEMENTED` (or, for the evidence gaps, G4, D4 and D5, as still open) in
§14.1 and §13. Findings 57–58, 62–68, 69–75 and 76–82 remain the earlier instances of the same class,
each recorded in §14.1. Findings 83–88 are this revision's cases, and six of them were found by
reading revision 21 against itself rather than by a reader hitting the defect in use: it registered a
waiter *after* the call that can spawn, so the protocol depended on one `await` line; it left the
failure path assuming releases it did not perform; it committed a replace-rename after an identity
check that `rename` does not honour; it wrote an ACL-preservation sentence with no implementable test
and a "both outcomes preserve" claim that a substituted destination falsifies; it duplicated cleanup
eligibility and left refusals with no owner; and it carried counts and a citation result written for
the previous revision. All six are now specified — and all remain unimplemented, with AT14, AT15 and
the rewritten CT8 merely proposed. The seventh finding is the record correction for the counts.

---

## 16. Verdict

### 16.1 Verdict

**NOT APPROVED FOR IMPLEMENTATION.**

Approval is withheld for two different reasons, and both must be resolved:

1. **Unresolved owner decisions** — B1, H3/B3, H5/B2, B7, H4, and D1–D5 (§13.1). These are product
   and policy questions an agent cannot answer. **D5** is new: the guard can create a configuration
   document but cannot replace one, because the replacement race is not closable with an exported
   API, and only the owner can accept that limitation or fund a mechanism.
2. **Unresolved technical and evidence blockers** — B8 (request-context security invariant, §1.9.8),
   G4 (unvalidated configuration-write path, §9.3), E1 (no runtime evidence for the 2.2.0
   registration read, §12.1), **B5** (no evidence at all for 2.0.15–2.1.x database-path behaviour,
   §2.9), and UNKNOWN-1 (Windows symlink/reparse race, §12.4).

Approval is not withheld "for decisions rather than defects": B8 and G4 are security defects in the
design until their exit criteria are met, and B5 and E1 are missing proofs, not missing preferences.
Repairing a contradiction on paper — which is all this revision did for B8 — does not change that.
Neither does specifying immutability, idempotence, attempt initiation and registration, re-entrant
publication, manager-level child ownership, exactly-once child cleanup, asynchronous settlement, the
start reservation and its settlement order, the single cleanup coordinator and its retry triggers, the
G4 path policy and create-only commit, the LB7 capture procedure or the 2.2.0 probe record on paper:
§1.9.3.1, §1.9.3.2, §1.9.3.3, §1.9.5, §3.4, §3.4.1, §9.3 and §2.9.1.1 are specifications an
implementation must satisfy, and RC12–RC16, AT10–AT15, CT5, CT8 and LB7 are proposed tests or
procedures. The design does not have those properties until the code, the tests and the measurements
exist. This revision's own corrections are evidence for that sentence: each one repaired prose that
had promised more than its mechanism delivered, and none of them moved a single line of
implementation.

**NOT APPROVED FOR IMPLEMENTATION. Revision 22 remains a plan-only revision.**

### 16.2 What would change the verdict

- Every owner decision in §13.1 recorded with an explicit answer, including the restored B1, H3/B3,
  H5/B2, and B7 and the newly assigned D1–D5 — **including D4**, whose proposed refusal is labelled,
  not decided, and **D5**, which decides whether the create-only limitation is accepted or a
  conditional-replacement mechanism is funded.
- B8's **six** exit criteria met, with RC1–RC16 implemented and passing — in particular RC11, which
  asserts that ordinary transitions move only `revision` and that shutdown moves `shutdownEpoch`
  exactly once; RC12, which mutates a retained install object and the captured context and asserts
  nothing sent changes; RC13, which calls shutdown repeatedly and concurrently and asserts the epoch
  moved once; RC14, which re-enters `beginShutdown()` from an abort listener and asserts the same
  published promise, one child stop and a settled completion; RC15, which makes the child stop reject
  asynchronously, then never settle, and then throw **before returning anything** from the stop
  operation as invoked by the scheduled callback, asserting that `stopChild()` itself still returns
  normally with its published promise already stored, that the throw is observed and settles that
  promise `{ok: false, error}`, that no `unhandledRejection` occurs, that one log is written, and that
  the two-phase bound ends the non-settling case; RC16, which re-enters `stopChild()` from inside the
  first stop's initiation and after shutdown has published the child's stop, asserting one promise
  object per child, one `SIGTERM`, at most one `SIGKILL` decision and one settled outcome, while also
  **failing any implementation whose promise executor runs a process API synchronously**, because that
  shape publishes the promise after the stop has already begun; AT10, which asserts that a normal
  initial discovery attempt is
  possible while no target exists but that no attempt can start once shutdown has begun, with its
  latch half constructed through the declared test seam and its production half run without one;
  AT11, which re-enters `beginAttempt()` from a synchronous abort listener and asserts the outer call
  throws rather than returning a dead attempt, that the newest attempt is the only current one, and
  that the superseded ones cannot begin I/O; AT12, which counts stop invocations per child across the
  four managed-child cleanup paths and asserts exactly one, and separately (case c) registers no
  waiter for the requesting attempt, establishes that the settled start has been **withdrawn**
  (`currentStartId === null`, the record marked withdrawn, and a pre-withdrawal handle reporting
  `deliverable() === false`), the current-child pointer detached by identity, and a fresh start
  allocatable **before** the request is called eligible, then asserts the stop is published after that
  withdrawal and the stopped child's exit starts no restart (spawn counter stays 2) — the decision
  initiates, it is not refused; AT13, which makes two attempts await one managed start, declares both
  waiters against the same start ID, asserts the stale one's release, and asserts its cleanup request is
  **deferred by C1** with a pending obligation carrying trigger T1 while the newer attempt's waiter is
  still active, and that the obligation is cleared when that attempt installs the target, with the
  child stopped exactly once at shutdown (`1`, not `2`), and a control variant in which removing the
  newer waiter makes the stale stop start, so the waiter is proved to be the cause; **AT14**, which
  fails a start with two waiters and asserts the exact order `rejected` → release → cleanup → publish →
  reject, the intermediate state (every waiter released, the shared promise still pending at
  `cleanup:entered`) and controls for a pre-spawn failure, an older settlement that must not evict a
  newer start, and the manager-owned keep-alive start; and **AT15**, which inspects at the
  `createChild()` seam and asserts that the start record, `currentStartId`, an unsettled deferred and
  every waiter exist **before** `spawn()`, that a re-entrant `acquireManagedStart()` joins rather than
  allocates, and that a revision-21-shaped build fails the assertion.
- G4 implemented and reviewed under the §9.3 policy — an absolute path **inside** the root accepted,
  an absolute path outside it refused, the Windows forms of step 4 refused — with **CT5 and CT8**
  passing, including CT5's inside-root positive control, CT8's junction assertion, and the
  **create-only** write path whose commit point is `fs.link` into an absent destination (§9.3 step 7):
  the **complete-write** loop (an injected short write completes the document; a zero-progress write is
  a typed failure and never a successful update), the truncation assertion that the R19 probe's
  `"xyz3456789"` result makes necessary, the `dev`/`ino` **substitution** case, and five deterministic
  pre-commit sequences — partial then zero progress, partial then rejection, truncate failure, sync
  failure, and a successful commit — each re-reading the destination and asserting that it is **still
  absent** whenever the commit point was not crossed and holds the new bytes after it. The commit
  cases: the `beforeCommit` seam creates the destination and the guard returns `destination_appeared`
  with that file untouched; the control succeeds with the destination's `dev`/`ino` equal to the
  temp's and `nlink === 1`; an existing destination at validation is refused `replace_unverified`
  **before any temp is created**, including a content-identical control; `link_unsupported` fails
  closed with no rename. The ACL contract passes on an inherited-only temp, fails
  `acl_explicit_unexpected` on an injected ACE, and fails `acl_unverifiable` on an unreadable
  descriptor, with the destination absent in every failure. Adopted-mode writes stay disabled until
  this lands, and CT7's refusal lifted only at that point. **D5 must be answered**: while replacement
  is refused the guard cannot update an existing configuration document; the check-to-rename race is
  avoided rather than closed, ACL preservation is **not** claimed, and a handle held by another process
  and crash durability remain UNKNOWN — each keeps G4 blocked even after CT8 passes.
- E1 closed by a reader tested against a 2.2.0 service the tester started themselves.
- **B5 closed by real builds started by the tester in disposable roots** — each named by the composite
  key of §2.9.2 (reported version, package artifact name and digest, extracted executable path and
  digest, extraction provenance), each its own row, `2.0.15` and every individual `2.1.x` artifact
  measured separately — not by a shim, not by 2.2.0 evidence, not by one measured build standing for a
  range, and not by inference from source. Two packages that ship byte-identical executables are two
  rows, so an executable digest alone does not name a row. Each row must carry the process-level
  database-file event of §2.9.1, attributed to the **service-image PID** — the process whose image
  hashes to the executable digest, resolved from the recorded process tree with every
  launcher/shim hop named, never the launcher's own PID (the registration `pid` corroborating it, or
  `registration absent`, and a mismatch recorded as a finding) — captured by the §2.9.1.1 procedure
  (LB7) for unset, absolute and relative `OPENCODE_DB`; a file on disk, a `debug paths db` line, or a
  trace attributed by path rather than by PID is not that evidence. The undigested 2.2.0 observation
  cannot stand in for any row.
- The Windows symlink/reparse residual either measured and mitigated, or accepted in writing as a
  known residual.
- The two file-API properties neither open probe measured — whether an `AbortSignal` cancels a read
  pending on a `FileHandle` or only abandons it, and how Windows behaves when a handle closes during
  an in-flight read — established, or the limitation raised and resolved as a design change before
  implementation, not worked around with a path-based re-open or by pre-trusting an `lstat` size. The
  handle surface itself (open, `stat`, `read`, `write`, `truncate`, `sync`, `close`, `EBADF` after
  close) is already measured; `lstat`/`fstat` `dev`/`ino` **discrimination** (distinct files differ,
  hard link identical, substitution detected, control identical) is measured by R20 on one NTFS
  volume, and a target filesystem that cannot discriminate must make G4 fail closed.

### 16.3 Saved-file verification record (revision 22)

This revision was checked against the saved file, not against an in-memory draft. Each row records a
command or a read that was **actually performed during revision 22** on this file, on the installed
runtime, on the installed `@opencode/client` package, or on the working tree; none of them is a design
claim, and no proposed test is reported as existing or passing. Three rows are self-referential — the
file's own length, this record's own token counts, and the citation scan — so each was measured
against the file **after** the last write that changed it, and the counts below describe **this saved
file**. **Counting convention:** lines is the count of LF-terminated lines; bytes is the file's size
on disk; "CR bytes" is the number of `0x0D` bytes. Replacing a measured number changes the file, so
each was written, re-measured and patched until it stopped moving.

| Check | Result |
|---|---|
| Document title and length | Pass — line 1 reads "(revision 22, Windows scope)"; this saved file is 4331 lines and 468506 bytes, with 0 CR bytes and 4331 LF bytes |
| Rendering and the reported count | Pass — `git ls-files --eol` reports `i/lf w/lf attr/` for this file, `git config core.autocrlf` is `true`, and the file contains 0 `0x0D` bytes, so the index and the working tree are **LF**. Git also prints its own conversion notice for this path — `in the working copy … LF will be replaced by CRLF the next time Git touches it` — observed, not assumed. Revision 20 and 21 byte counts are not restated as this file's |
| Heading integrity | Pass — 1 `#`, 18 `##`, 80 `###`, 18 `####`; 0 duplicated heading texts |
| §1.9 subsections present and ordered | Pass — 12 headings under §1.9: 1.9.1–1.9.8 plus 1.9.2.1, 1.9.3.1, 1.9.3.2, 1.9.3.3 |
| Code fences balanced | Pass — 30 fence lines, 15 blocks |
| Every markdown table has a constant cell count within its block | Pass — 50 contiguous tables scanned; 0 rows differ from their header's cell count. The check strips `\|` before counting separators, because a pipe inside a cell is content: the first pass of this revision reported four mismatches at lines 59, 2751, 4062 and 4301, and all four were escaped pipes rather than real mismatches |
| RC rows | Pass — 16 rows, RC1–RC16, no gap |
| AT rows | Pass — 15 rows, AT1–AT15, no gap; AT10 carries clauses (a)–(e), AT11 two variants, AT12 four cases (a)–(d), AT13 the counted-waiter deferral with its control variant, AT14 the settlement-order event log with three controls, AT15 the spawn-seam entry/return assertions with its re-entrant join and its revision-21-shaped negative control |
| LB rows | Pass — 7 rows, LB1–LB7 |
| Findings register | Pass — 58 rows numbered 31–88 with no gap; 83–88 are this revision's additions |
| Test matrix | Pass — 8 group rows summing 12 + 16 + 15 + 16 + 8 + 6 + 3 + 7 = 83, and the total row reads 83; §11's arithmetic sentence states the same sum, and §10.1's adoption-attempts row now reads AT1–AT15 |
| §10 file plan and §10.1 proposed files | Pass — §10's file plan has 12 rows: 4 marked **Not created** and 8 **Unchanged**; §10.1 has 10 rows, every one marked **Not created**. The `tests/` tree is **not** clean — unrelated work has left 8 modified and 5 untracked test files there (working-tree row); this revision created or modified none of them |
| No `2.1.x` row or artifact | Pass — 0 table rows begin with `2.1.x`; a scan for `2.1.<digit>` returns 0 hits, so no specific `2.1.x` artifact is named anywhere, although the range string occurs 50 times |
| No stale current totals | Pass — the bold-81 token occurs 9 times, and every one is historical or an identifier: the revision-19 change log and §11's revision-19/20 sentences, finding 55's remedy, finding 81's own row number, and §15's revision-20 and revision-21 rows. The revision-20 total has been superseded, so none is a current total. `RC1–RC14`, `RC1–RC15` and `AT1–AT12` occur only in finding 55's historical sentences; `RC1–RC16` and `AT1–AT15` are the current ranges |
| Exit-criteria count | Pass — "five exit criteria" has 0 occurrences outside this row; §1.9.8 lists **six**, §14.1 says "the six exit criteria in §1.9.8 must hold", and §16.2 says "B8's **six** exit criteria met" |
| Probe-count statements | Pass — the R22 probe label occurs 4 times: the §0 label table, the §0.1 intro, §9.3 step 7k, and §15's revision-22 row. The R21 label occurs 5 times: the §0 label table, the §0.2 revision-21 change log, §0.7's disclosure, §9.3 step 7k, and §15's revision-21 row. No text claims any other probe for revision 22, and R4–R7, R19 and R20 were **not** rerun; R21's results are quoted as history, not re-measured |
| Test-seam names | Pass — `setShutdownStateReaderForTests` occurs 4 times: §1.9.5's declaration paragraph, TT6's scan, finding 63, and this row. `startStateSnapshot` occurs 3 times: the §3.4.1 spawn-seam paragraph, AT15, and this row. Both are declared as read-only seams with no production call site; only the first describes a production binding |
| Every proposed test labelled | Pass — §1.9.7, §2.9.4 and §3.5 each carry a NOT IMPLEMENTED / NOT RUN banner; §11's intro says none exists and none has been run; every §10.1 row says **Not created** |
| Verdict | Pass — "NOT APPROVED FOR IMPLEMENTATION" occurs 4 times: the header, §16.1's opening line, §16.1's closing line, and this row. §16.2 lists open items only |
| Baseline and branch | **Disclosed, not a pass.** The brief names baseline `b440e207d1e748e1220f462ceb460a02a1bf9d7a`; the document does **not** exist at that commit (`git show b440e20:docs/2026-10-29-opencode-hybrid-runtime-plan.md` fails with "exists on disk, but not in 'b440e20'"). It enters the index at HEAD `f4110fb7bf5baaced9ce44cb34054fdc43edb028` in its revision-15 form and is modified in the working tree, which carries revisions 15→22 uncommitted (`git diff --numstat` against HEAD: 4073 insertions, 226 deletions). The branch is still `ci/tauri-e2e-verify`. This revision is therefore measured against the working-tree file, and its relationship to the named baseline is the one stated here rather than assumed |
| Probe R22-a — hard-link create, existing name, and substitution | Run: `bun` on a script in a disposable directory under the OS temp root. `link` into an **absent** name succeeded; the destination reported the temp's `dev`/`ino` and `nlink` 2, and after the temp was unlinked the destination still read the payload with `nlink` 1. `link` onto an **existing** name failed `EEXIST` and that file was byte-identical afterwards. With the destination absent, creating a file at the name and then linking again failed `EEXIST` and the creator's bytes survived. `fs.rename` over a **substituted** destination replaced it — the measurement that withdrew the replacement path |
| Probe R22-b — replacement API surface | Run, same conditions. `fs.replaceFile` and `fs.renameat2` are **undefined** on Bun 1.4.4 with `process.versions.node` 26.3.0 on win32 x64, so no exported API offers a no-replace flag or a destination-identity precondition |
| Probe R22-c — security descriptor and directory sync | Run, same conditions. A fresh temp under a directory with inheritance enabled reported 3 SDDL ACEs, all carrying the inherited (`ID`) flag; after `icacls /inheritance:d` the SDDL kept 3 ACEs with no `ID` flag while `icacls`' own `(I)` markers disappeared — which is why SDDL is the decision source and `icacls` only a cross-check. A hard-linked destination's SDDL equalled the temp's. Opening and syncing the **directory** failed `EPERM`, so no directory-durability claim is made |
| What the re-check changed in this document | The G4 commit was **replaced** rather than asserted: §9.2 and §9.3 step 7 now create a sibling temp and commit by **create-only hard link**, refuse an existing destination as `replace_unverified` before the temp is created, report `destination_appeared` and `link_unsupported`, and have no rename fallback. The revision-21 sentence that "both outcomes of a permitted/refused rename preserve the old document" is withdrawn, the ACL requirement is restated as an SDDL inheritance check that fails closed, and owner decision **D5** is added. Five independent G4 blockers remain — replacement semantics, the check-to-rename race on the withdrawn path, ACL uncertainty, cross-process handles, and crash durability — plus the unmeasured file-API properties, so G4 stays **BLOCKED** and adopted-mode writes stay disabled |
| Probe hygiene | Pass — the probe ran under Bun 1.4.4 with `process.versions.node` 26.3.0 on win32 x64 (OS 10.0.26300), in an OS-temp directory the script created; the directory was removed after the measurements. No OpenCode process, registration file, database, API key, password or authorization header was read, started or signalled |
| Citation resolution | **Partial — this is not a clean result.** The scan covers the document **outside §16.3** and finds 90 `file:line` occurrences across 70 distinct ranges. 35 ranges (52 occurrences) resolve to a single repository file whose length covers the cited end line; 0 repository citations are out of range. 3 ranges are ambiguous by basename and were checked by hand against both candidates — `capabilities.ts:107` (356-line `src/services/opencode/capabilities.ts` vs 384-line `src/context/cache/capabilities.ts`) and `runtime.ts:144-159` and `runtime.ts:171-177` (208-line `src/services/opencode/runtime.ts` vs 568-line `web/src/runtime.ts`); the plan's OpenCode-service context identifies the first candidate in each case, and all three are in range, taking repository coverage to 38 ranges / 55 occurrences. 12 ranges (14 occurrences) resolve against the **installed** `@opencode/client` 2.2.0 `dist/` tree. 19 ranges (20 occurrences) do **not** resolve: 6 `service-config.ts` ranges and 1 `packages/cli/src/services/service-config.ts` range (OpenCode-repository sources, and §2.2 records that no OpenCode checkout is present locally), 1 `service-timing.d.ts` range, and 11 unprefixed `promise/service.js`, `effect/service.js` and `chunks/service-timing-*.js` ranges whose `dist/`-prefixed twins exist in the installed package but are cited without the prefix. 1 range is out of range — `dist/service.d.ts:64-82` against the 52-line installed file — and it is quoted inside finding 56 as the superseded range, not cited as evidence. So of the 70 ranges, 50 resolve, 19 do not, and 1 is out of range, with the reasons above; the count is presented as a partial result, not a clean one |
| Anchors this revision relies on | Pass — re-read in the working tree: `src/config/opencode.ts:74-75` (`minimumVersion` `"2.0.15"` / `maximumVersionExclusive` `"2.2.1"`), and in the 552-line `src/services/opencode/serverManager.ts`: `:253` (`private child`), `:265` (`childDiagnostics`), `:309-326` (`ensureBaseUrl`'s single in-flight promise, assigned at `:324`), `:338` (`createChild` returns the `Subprocess`), `:375-376` (`createChild` then `this.child = child`), `:417-419` (the identity guard before clearing), `:436-440` (`SIGKILL` plus `waitForExit`), `:483-513` (`onExit`, early return at `:484`, pointer cleared at `:496-497`, auto-restart at `:499-508`), `:522-548` (`shutdown`, `SIGKILL` at `:542`, pointer cleared at `:544-545`, no wait after the kill). The file is unmodified in `git status` |
| Working tree | **42 entries beyond the index: 33 modified and 9 untracked; this revision wrote to exactly one of them, this document.** The others are unrelated in-flight work — sidebar/desktop/chat-width source, `docs/decisions.md`, 8 modified test files and 5 untracked test files. They were not read as content, edited, staged, reverted or restored |
| No staging, commit, push or branch change | Pass — no `git add`, `git commit`, `git push`, checkout, reset, stash or branch command was run in this revision; `git diff --cached --name-only` is empty and the branch is still `ci/tauri-e2e-verify` |
| No implementation and no test run | Pass — no file under `src/`, `web/`, `tests/`, `scripts/`, `package.json`, a lockfile or CI config was written. The only writes were this document and temporary scan/probe scripts under the OS temp directory, which was removed afterwards |
| No real service touched | Pass — no OpenCode process was started, stopped or signalled; no registration file, database, service password, API key or authorization header was read |

**One sentence of scope.** This document proposes a design, records what it repaired on paper, and
states what is unknown. It does not implement it, does not test it, and does not claim that any owner
has approved it.
