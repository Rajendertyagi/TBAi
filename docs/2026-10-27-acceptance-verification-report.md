# Runtime robustness and acceptance re-certification - 2026-10-27

**Branch:** `ci/tauri-e2e-verify` **Code HEAD:** `91202465a3ddd7d05bdcde9ba85b9ed7afb20d1e` (unchanged all session) **Date:** 2026-10-27

**Verdict: HOLD, not PASS.** Every gate that can run on this machine is green on the current working tree. One acceptance criterion is **not verified**: the development identity handshake has a Rust half that has never been compiled, because this machine has no `cargo`/`rustc` and no CI run exists for an uncommitted tree. Details in section 8.

---

## 1. State under test

`git rev-parse HEAD` = `91202465a3ddd7d05bdcde9ba85b9ed7afb20d1e`; `git rev-list --left-right --count origin/ci/tauri-e2e-verify...HEAD` = `0 0`.

All work in this session is **uncommitted**: 24 modified files, 4 new source files, and this report.

| | Count | Detail |
|---|---|---|
| Modified | 24 | `git diff --stat` = 1220 insertions, 114 deletions |
| New | 4 source + this report | `scripts/dev-instance-preload.ts`, `scripts/dev-launch-record.ts`, `tests/helpers/atomic-record.ts`, `tests/unit/tooling/atomic-record.test.ts` |
| Commits / pushes / resets / branch switches | 0 | none performed; nothing was stashed, cleaned, or force-pushed |

Consequence, stated up front: **no CI run can describe this tree.** Every CI citation in section 7 is about committed HEAD `9120246`, which predates today's fixes. Where an artifact proves only the older behaviour, section 8 says so.

---

## 2. What was actually broken, per concern

Each entry names the symptom as it appeared, the root cause as measured, the fix, and the test that now holds it. Symptoms that looked like timing problems were not treated as timing problems unless the measurement said so.

| # | Symptom | Confirmed root cause | Fix | Proof |
|---|---|---|---|---|
| A | `tauri dev` attached to **any** server answering `:3000` | attach accepted any instance id; the port cannot distinguish a stale/foreign backend | per-launch identity: minted by the launcher, recorded, required to match exactly | TS half proven; **Rust half uncompiled** |
| B | `/api/opencode/config` failed with `opencode.config_read_error` | the `2,000 ms` string was only `Bun.spawnSync --version` in `runtime.ts`; a cold large binary on a loaded runner blew it | named `versionProbeTimeoutMs: 10_000` + an actionable message that names the phase and the binary | 13 pass x5 |
| C | suspected OpenCode endpoint incompatibility | none: `/api/info` + `/api/config` are correct for the pinned range | documentation of the measured 2.1.4 surface + one guard test | 34 pass |
| D1 | `memory-wiring` "considers at most 50 candidates" timed out (~33-40 s on CI) | 500 individual inserts = **1,307.7 ms** locally under `journal_mode=delete`/`synchronous=2`; the same 500 inside one transaction = **3.0 ms** | seed the fixture inside a transaction | 31 pass x5 |
| D2 | `stdin-shutdown` measured **3,361 ms** against a `< 3,000 ms` bound | the stopwatch ran past `child.exited` through a post-exit pipe drain; real shutdown is **13-17 ms** | time to `child.exited`, report the drain separately in the message | 4 pass x5 |
| D3 | `mcp-v2` F3 "transport loss" failed at **5,735 ms** | the 50 x 100 ms window expired at the same instant as the 5 s retry delay (`reconnect` at ~5,015 ms), so a slow close detection left no observation time | one 30 s deadline loop polling at 50 ms, observing log and status together | 2 pass x5 |
| E1 | `p2-live-runtime`: "streaming must not force the viewport to the end while scrolled away" | the run-start layout effect armed `stickyRef` unconditionally and jumped to the end | only jump when the reader is already following (`stickyRef.current`) | 4 passed x5 |
| E2 | `phase-8`: timeout clicking the row menu | the `...` trigger is **not** a sibling of the title button; the old locator looked beside it | resolve the row from the title button, then `getByRole("button").last()` | 8 passed x5 |
| E3 | `composer-bar`: Send/Stop displaced by **291.640625 px** | a **false** `reply_lost` notice: a status poll at `finalizedAgeMs: 4` answered `endsWithReply: false`, while the same conversation answered `true` at 96 ms with the message already in SQLite. The reply is written by the browser | withhold a `completed` run's loss verdict inside `REPLY_SETTLEMENT_MS` (5 s) and re-take it on the existing bounded chain; `failed`/`cancelled`/`interrupted` still publish at once | 34 pass + 3 passed x5 |
| G3 | both cases read the host's global config (`malformed: true`) and cleanup reported a survivor | an ambient `OPENCODE_CONFIG_DIR` **outranks** `XDG_CONFIG_HOME` inside `opencode serve`; and `pid 18848` was `MicrosoftEdgeUpdate` on a **recycled** parent id | the driver sets `OPENCODE_CONFIG_DIR` inside its temp root; cleanup believes a parent edge only when `child.createdAt >= parent.createdAt` and terminates pid by pid instead of `taskkill /T` | 33 pass x5; 2 real-binary runs green |
| flake | ownership suite failed **2 of 28** isolated runs | `writeFileSync` creates the file before writing bytes; readers poll for existence then read once, seeing `""` (3 of 40 starts) | `tests/helpers/atomic-record.ts`: sibling file then rename, so existence implies completeness | 0 of 40 after; 20 of 20 runs |

### A - the identity handshake, in full

The gap: `attach_dev_backend` verified "an instance id answered", not "**this launch's** backend answered". A backend left over from a previous run, or another checkout's, satisfies that.

The design, because `tauri dev` and `beforeDevCommand` are separate processes with different working directories:

1. `beforeDevCommand` is now `bun run dev:shell` = `bun --preload ./scripts/dev-instance-preload.ts src/index.ts`.
2. The preload mints a UUID **before** the server module evaluates, writes `<DATA_DIR>/dev-instance-id`, and exports it as `TBAI_INSTANCE_ID` (which the existing `GET /api/server/instance` already served).
3. `attach_dev_backend` reads the same record (path from `TBAI_DEV_INSTANCE_FILE`, else `DATA_DIR`, else `<repo>/data`) and accepts only an exact match.
4. `classify_dev_instance` is pure, so all six outcomes are testable without a window: exact match -> attach; foreign id, no instance endpoint -> **reject immediately** (a listening port that is not ours cannot become ours); nothing listening, unusable answer -> retry until `STARTUP_TIMEOUT`.

Packaged startup, port discovery, sidecar ownership, crash recovery and the shutdown handshake are untouched: the whole path is behind `tauri::is_dev()`.

---

## 3. Verification actually run (this machine)

All commands from the repository root on the current working tree.

| Command | Exit | Result | Repeats | Elapsed |
|---|---|---|---|---|
| `bun run verify` | 0 | **5041 pass / 66 skip / 0 fail** (5107 tests, 378 files); DOM 577 pass; quarantine OK; `dist/tbai-server.exe` compiled | 3 | 402.5 s / 402.1 s / 455.9 s |
| `bun test tests/integration/context/memory-wiring.test.ts` | 0 | 31 pass / 0 fail | 5 | - |
| `bun test tests/integration/core/stdin-shutdown.test.ts` | 0 | 4 pass / 0 fail | 5 | - |
| `bun test tests/integration/mcp/mcp-v2.test.ts -t F3` | 0 | 2 pass / 0 fail | 5 | - |
| `bun test tests/unit/opencode/runtime.test.ts` | 0 | 13 pass / 0 fail | 5 | - |
| `bun test .../g3-override-evidence.test.ts .../atomic-record.test.ts .../streamRecovery.test.ts` | 0 | 69 pass / 0 fail | 5 | - |
| `bun run test:e2e history/p2-live-runtime.spec.ts` | 0 | 4 passed | 5 | 29.4-50.8 s |
| `bun run test:e2e history/phase-8-tabs-navigation.spec.ts` | 0 | 8 passed | 5 | 9.5-10.7 s |
| `bun run test:e2e components/composer-bar.spec.ts` | 0 | 3 passed, dx = 0 (was 291.640625, x4) | 5 | - |
| `bun run test:e2e` (whole ordinary suite) | 1 | 36 spec files ok / 3 failed; 4 failing cases, all pre-existing at `5f85e53`; `composer-bar`, `p2-live-runtime` and `phase-8` all **ok** | 2 | 611.3 s / 679.0 s |
| `bun test tests/integration/opencode/serverManager.test.ts` (real 2.1.4) | 0 | 34 pass / 0 fail | 1 | 1.1 s |
| OpenCode runtime gate (7 suites, real 2.1.4) | 0 | 7 / 7 suites, **0 skipped** | 1 | 28.2 s |
| `bun run test:opencode-g3` (real 2.1.4 binary, both cases) | 0 | both PASS, `survivors: []`, `confirmed: true`, `tempRootRemoved: true` | 2 | 16.8 s / 17.0 s |

The full-suite E2E red is named precisely rather than waved through: `tools/tool-body-budget.spec.ts` (2 cases), `core/phase-ua-d.spec.ts` (D1), `components/context-menu-spellcheck.spec.ts`. All four fail identically at baseline `5f85e53`, so they are pre-existing and **not fixed here**. The second full run was made deliberately after the last source edit, so the suite this table describes is the tree that exists now, not an earlier one: the three specs that were red in CI at `9120246` (`components/composer-bar`, `history/p2-live-runtime`, `history/phase-8-tabs-navigation`) report `ok`.

G3's two cases were also re-run against the real binary with cleanup verified by process table, not by assumption: `method: taskkill /F per recorded pid`, zero leftover temp roots.

---

## 4. What the fixes cost, and what they deliberately do not weaken

- **E3 does not delay a real loss indefinitely.** It suppresses the verdict for `completed` runs inside 5 s and re-takes it on the existing bounded chain; the first re-read is at 1.5 s and a genuine loss publishes once past the window. Both guards were proven to fail with the fix disabled (`false && isAwaitingReplyWrite`) - they are not comments.
- **D2 does not raise the bound.** The 3,000 ms contract is unchanged; only the interval being measured changed, from "exit plus pipe drain" to "exit".
- **D3 does not retune a timing.** The old window was arithmetically equal to the retry delay; the new one is a deadline with the same assertion.
- **E1 and E2 do not skip or relax anything.** E1 fixes a product bug (the view stealing position), E2 fixes a locator that was structurally wrong.
- **No timeout was increased anywhere**, no assertion was weakened, no test was deleted, and no diagnostic was suppressed.

---

## 5. G5 - inventory and comparison at HEAD

Artifact `g5-e2e-full-chromium-headless` (`12636579995`) from run `40289523595` at `dd5133437f4497e8ebac993f008a9e40403e18c0`. Numbers below are read from `comparison.json` and `*.aggregate.json`, not from a summary.

| | Baseline `2c444cc` | Final `7bd4975` |
|---|---|---|
| tests | 120 | 120 |
| passed | 109 | 109 |
| failed | 8 | 8 |
| flaky | 0 | 0 |
| skipped | 3 | 3 |
| spec files | 39 | 39 |
| digest | `ed0df068...1addaf42` | `ed0df068...1addaf42` |

`ok: true` with `baselineOnlyFailures: []`, `finalOnlyFailures: []`, `removedWhileFailing: []`, `testsRemoved: []`, `settingsDivergence: []`.

**This is "no regression in the specified comparison", not "E2E passes".** Eight cases fail at both revisions; three of them (`composer-bar`, `p2-live-runtime` A/D/E, `phase-8` delete-active) are fixed in the uncommitted tree, so the artifact no longer describes current behaviour. One case in that list, `virtualizer/scroll-anchoring-regressions` R2, did **not** fail in today's local full run; it is untouched by this work and its status is unchanged, not improved.

---

## 6. Files changed, and why each belongs where it is

| File | Owner | Why there |
|---|---|---|
| `src-tauri/src/main.rs` | Tauri shell | identity verification belongs to the process that owns the window |
| `scripts/dev-instance-preload.ts`, `scripts/dev-launch-record.ts` | `scripts/` (launch tooling) | minting/recording is development launcher work, not product code |
| `src-tauri/tauri.conf.json`, `package.json` | configuration | one-line change of the dev command, plus the script it names |
| `src/config/opencode.ts`, `src/services/opencode/runtime.ts` | OpenCode service | the preflight budget is service configuration |
| `web/src/components/VirtualizedTranscript.tsx` | shared UI | the scroll contract is generic, not chat-feature state |
| `web/src/features/chat/state/streamRecovery.ts` | chat feature state | the loss verdict is chat-feature policy |
| `scripts/lib/process.ts` | script library | process-tree truth for the evidence drivers |
| `scripts/run-g3-override-evidence.ts`, `scripts/observe-dev-webview-origin.ts` | evidence drivers | harness isolation and identity assertions |
| `tests/helpers/atomic-record.ts` | test helper | publication contract shared by three fixtures |
| tests under `tests/` | their layers | no test lives outside `tests/` |

`src/services/opencode/runtime.ts` and `src/config/opencode.ts` were changed together on purpose: the literal was replaced at its only use site and named at its owner. `docs/decisions.md` carries the E3 decision with its rejected alternatives; `docs/development-rules.md` carries the atomic-publication rule; `docs/opencode-v2-contract.md` carries the measured 2.1.4 table. No architectural boundary moved and no schema changed.

---

## 7. CI evidence at committed HEAD `9120246`

Run [40360945274](https://github.com/Rajendertyagi/TBAi/actions/runs/40360945274):

| Job | Result | Elapsed |
|---|---|---|
| `tauri` | pass | 13m23s |
| `opencode-g3` | pass | 2m19s |
| `verify` | pass | 10m1s |
| `opencode-runtime` | pass | 3m1s |
| `e2e` | **fail** | 6m12s |

The only red job fails on exactly the two specs fixed today: `p2-live-runtime` ("streaming must not force the viewport to the end while scrolled away") and `phase-8` ("click: Test timeout of 120000ms exceeded"). Artifacts: `tauri-webview-origin` `12668613107`, `tbai-windows-x64-portable` `12668393664`, `g3-override-evidence` `12667723224`.

Read from the artifacts, not from the job colour:

- `g2/dev`: `originMatchesConfigured: true`, in-page `/api` 200, observed instance `0597ad58-...` == booted instance, `backendStartupFailed: false`, teardown confirmed across 12 descendants.
- `g2/packaged`: `originMatchesExpected: true`, in-page 200, `instanceMatchesApp: true`.
- `g3/full` and `g3/partial`: both `ok: true`, `survivors: []`, `confirmed: true`, `tempRootRemoved: true`.

---

## 8. Criteria - passed, failed, unverified

| Criterion | Status | Basis |
|---|---|---|
| Dev backend identity cannot attach to a stale/foreign server | **unverified end to end** | the Rust requirement is written and carries six tests that have **never been executed**; TS half proven (`/api/server/instance` matches the record) |
| Packaged startup, sidecar ownership, recovery, shutdown preserved | **unverified for today's tree** | code path untouched and CI-green at `9120246`, but that run predates the change |
| `2,000 ms` config-read failure explained and fixed at the right layer | passed | origin proven by reading the call path; 13 pass x5 |
| OpenCode contract correct for the pinned range | passed | measured 2.1.4 table + 34 pass, real binary |
| D1, D2, D3 root-caused and fixed | passed | measurement + 5x each, then three full `verify` |
| Three clean full `verify` runs | passed | 5041/66/0 three times at the final tree; the third log records its own `VERIFY_EXIT=0` |
| Ordinary E2E suite | **failed on 3 pre-existing spec files** | identical at baseline `5f85e53`; not fixed here |
| G3 both cases against the real binary | passed | 2 runs, cleanup verified, no survivors |
| G5 comparison at HEAD | passed as specified | identical failure sets at both revisions |
| CI green on this tree | **not possible** | nothing is committed; no run describes it |

### The two gaps, spelled out

1. **`src-tauri/src/main.rs` has never been compiled.** This machine has no `cargo` and no `rustc`. The six unit tests exist (`dev_attach_accepts_the_instance_this_launch_minted`, `dev_attach_rejects_a_stale_or_foreign_backend`, `dev_attach_rejects_a_server_without_an_instance_endpoint`, `dev_attach_retries_while_nothing_listens`, `dev_attach_retries_an_unusable_answer`, `dev_launch_record_is_required_and_trimmed`) but have not run. They are reviewed, not executed. Do not read this document as evidence that they pass.
2. **The CI artifacts prove the previous generation of two fixes.** `g3-override-evidence` records `method: taskkill /T /F`, i.e. the pid-by-pid termination is local-only. `tauri-webview-origin/dev.json` has no `devInstanceIdMatched` field, i.e. the identity handshake is local-only. Both are green locally; neither is green in CI, because neither exists in any commit.

---

## 9. Unresolved and known limitations

- **One early `verify` failure is unidentified.** A run early in the session exited non-zero with 5025 pass / 1 fail; the failing test's name was not captured and the log was overwritten by the next run. It never reproduced across the 15 completed full runs logged afterwards (`verify-run2` through `verify-run17`, excluding `verify-run6`, which aborted earlier at the lint gate). This is recorded as unresolved, not as "intermittent" and not as "harmless".
- **Three spec files fail locally on every run** (`tool-body-budget` x2, `phase-ua-d` D1, `context-menu-spellcheck`) and fail identically at baseline `5f85e53`. Out of scope; not de-scoped silently.
- **`virtualizer/scroll-anchoring-regressions` R2** fails in the G5 comparison and passed locally today. Untouched.
- **`run-start-scroll.spec.ts` remains `test.fixme`** with its stale docblock intact. Not changed here.
- **One `verify` run exited non-zero on a Biome formatting diff** mid-session (the formatter disagreed with a hand-wrapped expression). Fixed by running the formatter, not by loosening a rule; all three final runs include the format check.
- **Semgrep is out of scope** per the 2026-10-26 ADR. No claim is made about it.
- **A live GitHub token was pasted into this session's chat** and should be rotated.

---

## 10. What is needed to close HOLD

1. `cargo test` + `tauri build` on a machine with a Rust toolchain, or a CI run of the `tauri` job, against these bytes.
2. A commit and push so a run can exist, then `tauri`, `opencode-g3`, `opencode-runtime`, `verify` and the ordinary `e2e` job re-read at the new SHA.
3. Only after 1 and 2: re-issue the G5 comparison so the three fixed specs leave the failure set.

Nothing below that line is claimed as done. The local evidence is strong and reproducible; it is not the same thing as a certified build.
