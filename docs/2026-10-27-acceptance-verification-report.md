# Runtime robustness and acceptance re-certification - 2026-10-27

**Branch:** `ci/tauri-e2e-verify` **Code HEAD:** `8bbe5a6d89c7f07e9f0038c649529c298f7e7b3e` (CI runs 40491928882 and 40498931974) **Date:** 2026-10-27

**Verdict: PASS at `8bbe5a6`, for the scope stated in section 8.** CI run [40491928882](https://github.com/Rajendertyagi/TBAi/actions/runs/40491928882) at that SHA is green on all five required jobs: `verify`, `tauri`, `e2e`, `opencode-g3`, `opencode-runtime`. Every blocker from the independent review is root-caused, fixed, and covered by a test that fails without the fix; the two gaps the earlier HOLD named - the uncompiled Rust handshake and the absence of any CI run describing the tree - are both closed with artifacts, not assertions. What PASS does **not** mean is listed in section 8: three E2E spec files still fail locally and identically at baseline `5f85e53`, and Semgrep is out of scope. The G5 comparison was re-issued at the certified SHA on 2026-10-27 - run [40498931974](https://github.com/Rajendertyagi/TBAi/actions/runs/40498931974), both projects `ok: true`, no test removed (section 5) - so no artifact now describes a revision other than the certified one. This verdict edit itself changes no source, test, or configuration file.

---

## 1. State under test

`git rev-parse HEAD` = `8bbe5a6d89c7f07e9f0038c649529c298f7e7b3e`, the SHA the certification run tested; the F3 readiness fix (section 2, D3b) is `3ce8d8c`.

The work of this session is **committed and pushed** as 14 commits, one concern each, `9120246..8bbe5a6`:

| | Count | Detail |
|---|---|---|
| Files in range | 29 | 1644 insertions, 115 deletions (includes this document) |
| Commits | 14 | pushed to `origin/ci/tauri-e2e-verify`, no force-push |
| Branch switches / resets / stashes / cleans | 0 | the only history rewrite was three local commits rewritten before the push, to strip a BOM PowerShell had added to their subjects |
| After the first push | 2 more commits | `3ce8d8c` (the D3b test fix), `8bbe5a6` (the report as certified) |
| After certification | 4 docs-only commits | `b8ba7db` (the verdict edit carrying this PASS), `8fb8d64` (two stale lines in it corrected), `cd3356e` (the plan reconciliation), and this G5-evidence edit. None changes a source, test, or configuration file |

Consequence: run 40491928882 at `8bbe5a6` describes the certified tree. Run 40480496977 at `7e79b30` describes everything except the D3b fix; section 7 reads both, and section 8 states the scope of the PASS.

---

## 2. What was actually broken, per concern

Each entry names the symptom as it appeared, the root cause as measured, the fix, and the test that now holds it. Symptoms that looked like timing problems were not treated as timing problems unless the measurement said so.

| # | Symptom | Confirmed root cause | Fix | Proof |
|---|---|---|---|---|
| A | `tauri dev` attached to **any** server answering `:3000` | attach accepted any instance id; the port cannot distinguish a stale/foreign backend | per-launch identity: minted by the launcher, recorded, required to match exactly | `cargo test` in CI (six tests) + G2 artifact `devInstanceIdMatched: true` |
| B | `/api/opencode/config` failed with `opencode.config_read_error` | the `2,000 ms` string was only `Bun.spawnSync --version` in `runtime.ts`; a cold large binary on a loaded runner blew it | named `versionProbeTimeoutMs: 10_000` + an actionable message that names the phase and the binary | 13 pass x5 |
| C | suspected OpenCode endpoint incompatibility | none: `/api/info` + `/api/config` are correct for the pinned range | documentation of the measured 2.1.4 surface + one guard test | 34 pass |
| D1 | `memory-wiring` "considers at most 50 candidates" timed out (~33-40 s on CI) | 500 individual inserts = **1,307.7 ms** locally under `journal_mode=delete`/`synchronous=2`; the same 500 inside one transaction = **3.0 ms** | seed the fixture inside a transaction | 31 pass x5 |
| D2 | `stdin-shutdown` measured **3,361 ms** against a `< 3,000 ms` bound | the stopwatch ran past `child.exited` through a post-exit pipe drain; real shutdown is **13-17 ms** | time to `child.exited`, report the drain separately in the message | 4 pass x5 |
| D3 | `mcp-v2` F3 "transport loss" failed at **5,735 ms** | the 50 x 100 ms window expired at the same instant as the 5 s retry delay (`reconnect` at ~5,015 ms), so a slow close detection left no observation time | one 30 s deadline loop polling at 50 ms, observing log and status together | 2 pass x5 |
| D3b | the same F3 case still failed **in CI**, at `mcp-v2.test.ts:265` (`tools[toolName]` undefined) | the case waited for `status === "connected"`, but `runConnect()` publishes that status **before** capability discovery; a read 290 ms later found `totalTools=0` while the reconnect was still succeeding. The `superseded-during-discovery` log 2 ms after that was the case's own `finally` disconnect bumping the generation, not a cause | wait for the capability the case asserts (`status.tools` contains `echo`), not for the transport flag | 8/10 failing before vs 0/10 after, 2x-oversubscribed; full file 3/3 failing before vs 0/2 loaded + 2/2 clean after; 3 full `verify` |
| E1 | `p2-live-runtime`: "streaming must not force the viewport to the end while scrolled away" | the run-start layout effect armed `stickyRef` unconditionally and jumped to the end | only jump when the reader is already following (`stickyRef.current`) | 4 passed x5 |
| E2 | `phase-8`: timeout clicking the row menu | the `...` trigger is **not** a sibling of the title button; the old locator looked beside it | resolve the row from the title button, then `getByRole("button").last()` | 8 passed x5 |
| E3 | `composer-bar`: Send/Stop displaced by **291.640625 px** | a **false** `reply_lost` notice: a status poll at `finalizedAgeMs: 4` answered `endsWithReply: false`, while the same conversation answered `true` at 96 ms with the message already in SQLite. The reply is written by the browser | withhold a `completed` run's loss verdict inside `REPLY_SETTLEMENT_MS` (5 s) and re-take it on the existing bounded chain; `failed`/`cancelled`/`interrupted` still publish at once | 34 pass + 3 passed x5 |
| G3 | both cases read the host's global config (`malformed: true`) and cleanup reported a survivor | an ambient `OPENCODE_CONFIG_DIR` **outranks** `XDG_CONFIG_HOME` inside `opencode serve`; and `pid 18848` was `MicrosoftEdgeUpdate` on a **recycled** parent id | the driver sets `OPENCODE_CONFIG_DIR` inside its temp root; cleanup believes a parent edge only when `child.createdAt >= parent.createdAt` and terminates pid by pid instead of `taskkill /T` | 33 pass x5; 2 real-binary runs green |
| flake | ownership suite failed **2 of 28** isolated runs | `writeFileSync` creates the file before writing bytes; readers poll for existence then read once, seeing `""` (3 of 40 starts) | `tests/helpers/atomic-record.ts`: sibling file then rename, so existence implies completeness | 0 of 40 after; 20 of 20 runs |

### D3b - the second F3 failure, which only CI could surface

D3's fix removed the wall-clock coincidence. The CI run at `7e79b30` then failed the same case 5.7 s in, at the same assertion (line 265, `expect(tools[toolName]).toBeDefined()`), with a log that looked like a contradiction:

```
09:31:47.595  reconnect started (attempt=1)
09:31:47.865  stdio stderr: EVERYTHING SERVER UP
09:31:47.902  mcp.filter_applied totalTools=0 exposedTools=0      <- the case read tools here
09:31:47.904  superseded-during-discovery op=connect outcome=abandoned
```

Connect succeeded but zero tools, and ownership was lost 2 ms later. It is not "flaky"; there are two separate facts.

**Fact 1 - transport readiness is not capability readiness.** `runConnect()` sets `conn.status = "connected"` right after `client.connect()` resolves, and only then awaits `discoverCapabilities()`, which talks to a freshly spawned child. The case's wait loop broke on the status flag and read `getAiTools()` in that gap; under load the gap was 290 ms in CI and up to **8 s** here with the machine 2x oversubscribed. The tools were never missing - the read was early.

**Fact 2 - the abandonment is a consequence, not a cause.** A failing assertion runs the case's `finally { await mcpManager.disconnect(id) }`, and `disconnect()` invalidates the generation synchronously. Reproduced locally at 8 of 10 under load, then instrumented (temporary, `TBAI_MCP_DIAG`) to capture the caller of every `nextGeneration()`:

```
--- gen 2 ...  at runConnect <- connect        (the 5 s retry timer, manager.ts:834)
--- gen 3 ...  at invalidate <- disconnect     (tests/integration/mcp/mcp-v2.test.ts:269 = the finally)
```

So the `superseded-during-discovery` line that looked like the bug is the test tearing itself down after its own failed assertion.

**Fix.** The loop waits for the tool the case needs, not for the transport flag:

```ts
const st = mcpManager.getStatuses().find((s) => s.id === id);
toolsReady = st?.tools.some((t) => t.name === "echo") ?? false;
if (started && st?.status === "connected" && toolsReady) break;
```

**What was deliberately not changed.** Publishing `connected` only after discovery would not close the real window: `getAiTools()` reads `conn.tools`, which stays empty until discovery finishes either way, and it would change `refresh()`'s branch (`status !== "connected"` currently means "connect instead of re-discover"). So the product still has a bounded window - a chat turn issued between transport connect and capability discovery sees no MCP tools for that turn. That is recorded in section 9, not papered over, and not claimed as fixed.

*(The earlier hypothesis - a double reconnect timer or an external invalidate landing inside discovery - is disproved by the stacks above: the only bump during discovery was the test's own disconnect.)*

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

All commands from the repository root at code revision `3ce8d8c`; the certified tree `8bbe5a6` differs from it only by this document.

| Command | Exit | Result | Repeats | Elapsed |
|---|---|---|---|---|
| `bun run verify` | 0 | **5041 pass / 66 skip / 0 fail** (5107 tests, 378 files); DOM 577 pass; quarantine OK; `dist/tbai-server.exe` compiled | 3 | 406.7 s / 403.0 s / 403.6 s |
| `bun test tests/integration/context/memory-wiring.test.ts` | 0 | 31 pass / 0 fail | 5 | - |
| `bun test tests/integration/core/stdin-shutdown.test.ts` | 0 | 4 pass / 0 fail | 5 | - |
| `bun test tests/integration/mcp/mcp-v2.test.ts -t F3`, unloaded | 0 | 2 pass / 0 fail | 5 | - |
| `bun test tests/integration/mcp/mcp-v2.test.ts -t F3`, **2x oversubscribed, before D3b** | 1 | **8 of 10 fail**, all at `mcp-v2.test.ts:265` (`Received: undefined`) | 10 | 15-25 s each |
| same, **after D3b** | 0 | **0 of 10 fail** | 10 | 15-25 s each |
| `bun test tests/integration/mcp/mcp-v2.test.ts`, 2x oversubscribed | 1 -> 0 | **3 of 3 failed before D3b** (28 cases, same assertion); **0 of 2 after** (28 pass / 0 fail) | 3 + 2 | 272 s / 273 s |
| `bun test tests/integration/mcp/mcp-v2.test.ts`, unloaded | 0 | 28 pass / 0 fail | 2 | 69 s / 69 s |
| `bun run typecheck`, `bun run lint` | 0 | backend + web + tests tsconfigs; Biome `--error-on-warnings`, 1051 files | 1 | - |
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

The last full `verify` was started after the final code edit (the D3b test change and its comment), so the 5041/66/0 figure describes the bytes of `3ce8d8c`; the two before it completed on the same source tree with only that test file's comment wording differing.

G3's two cases were also re-run against the real binary with cleanup verified by process table, not by assumption: `method: taskkill /F per recorded pid`, zero leftover temp roots.

---

## 4. What the fixes cost, and what they deliberately do not weaken

- **E3 does not delay a real loss indefinitely.** It suppresses the verdict for `completed` runs inside 5 s and re-takes it on the existing bounded chain; the first re-read is at 1.5 s and a genuine loss publishes once past the window. Both guards were proven to fail with the fix disabled (`false && isAwaitingReplyWrite`) - they are not comments.
- **D2 does not raise the bound.** The 3,000 ms contract is unchanged; only the interval being measured changed, from "exit plus pipe drain" to "exit".
- **D3 does not retune a timing.** The old window was arithmetically equal to the retry delay; the new one is a deadline with the same assertion.
- **E1 and E2 do not skip or relax anything.** E1 fixes a product bug (the view stealing position), E2 fixes a locator that was structurally wrong.
- **D3b does not weaken the assertion.** The case still requires the recovered connection to execute a real tool call through the AI SDK wrapper; only the readiness condition changed, from "transport says connected" to "the tool this case asserts is listed". The failing assertion is untouched, and `expect(toolsReady).toBe(true)` makes a genuine discovery failure report itself instead of surfacing as `undefined`.
- **No timeout was increased anywhere**, no assertion was weakened, no test was deleted, and no diagnostic was suppressed.

---

## 5. G5 - inventory and comparison at the certified bytes

Artifacts `g5-e2e-full-chromium-headless` and `g5-e2e-full-edge-headless` from run [40498931974](https://github.com/Rajendertyagi/TBAi/actions/runs/40498931974), dispatched with `e2e_full=true` and `final_sha=8bbe5a6d89c7f07e9f0038c649529c298f7e7b3e`. Every number below is read from the two `comparison.json` files, not from a summary. The job derives its baseline as the final commit's first parent, so the baseline is `3ce8d8c` (the F3 readiness fix).

| | chromium `3ce8d8c` | chromium `8bbe5a6` | edge `3ce8d8c` | edge `8bbe5a6` |
|---|---|---|---|---|
| tests | 120 | 120 | 120 | 120 |
| passed | 115 | 115 | 115 | 115 |
| failed | 4 | 4 | 4 | 4 |
| flaky | 0 | 0 | 0 | 0 |
| skipped | 1 | 1 | 1 | 1 |
| spec files | 39 | 39 | 39 | 39 |
| digest | `ed0df068...1addaf42` | `ed0df068...1addaf42` | `9357dfa3...09c9a09cb3` | `9357dfa3...09c9a09cb3` |

Both projects report `ok: true`, and `baselineOnlyFailures`, `finalOnlyFailures`, `removedWhileFailing`, `specsRemoved`, `testsRemoved`, `unexplainedRemoval`, `settingsDivergence` and `unexplainedDivergence` are all empty. The four failures common to both revisions are exactly the three spec files named in section 8's scope: `components/context-menu-spellcheck` (copy selected text), `core/phase-ua-d` D1, and both cases of `tools/tool-body-budget`.

**What this comparison covers, and what it does not.** It is `3ce8d8c` -> `8bbe5a6`, a one-commit delta (a test change plus this documentation), because the workflow fixes the baseline at `final^1`. It therefore certifies that the certified bytes removed no test, changed no settings and introduced no new failure relative to the revision they built on. It is **not** a comparison against the branch point, so it says nothing about the whole 15-commit code delta as a unit.

The earlier comparison remains the record for that code delta: artifact `g5-e2e-full-chromium-headless` (`12636579995`) from run `40289523595` at `dd51334`, baseline `2c444cc` -> final `7bd4975`, **109 pass / 8 fail / 3 skip** at both revisions with an identical digest and `ok: true`. Comparing its failure list with today's names what changed between the two comparisons:

| Case | `7bd4975` | `8bbe5a6` | Fix |
|---|---|---|---|
| `components/composer-bar` - send/stop share one slot | failed | **passes** | E3 (the false `reply_lost` verdict) |
| `history/p2-live-runtime` A/D/E - streaming does not steal a scrolled-up position | failed | **passes** | E1 (the unconditional sticky arm) |
| `history/phase-8-tabs-navigation` - deleting the active conversation | failed | **passes** | E2 (the `...` locator) |
| `virtualizer/scroll-anchoring-regressions` R2 - append while scrolled up | failed | **passes** | E1 is the only scroll-position change in between; R2's spec was not re-run in isolation, so its pass is recorded rather than attributed to E1 |
| `context-menu-spellcheck`, `phase-ua-d` D1, `tool-body-budget` x2 | failed | failed | none - pre-existing at `5f85e53` |

**This is "no regression in the specified comparison", not "E2E passes".** Four cases still fail at both revisions, and they are the pre-existing set this report has never de-scoped. The `dd51334` artifact is kept for its inventory and its failure list, but it is no longer the comparison of record for the certified tree.


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

## 7. CI evidence at `8bbe5a6`

Run [40491928882](https://github.com/Rajendertyagi/TBAi/actions/runs/40491928882) at `8bbe5a6` is the certification run:

| Job | Result | What it runs |
|---|---|---|
| `verify` | **pass** | typecheck, lint, format, test-location policy, build, the full Bun suite (including the shutdown, startup-rollback and lifecycle integration steps), DOM contract, quarantine guard |
| `tauri` | **pass** | `cargo check`, **`cargo test`** (the six handshake tests), `tauri build`, packaged smoke test, G1 + G2 observations |
| `e2e` | **pass** | 7/7 spec files, including `p2-live-runtime.spec.ts` and `phase-8-tabs-navigation.spec.ts` |
| `opencode-g3` | **pass** | both override cases against the pinned real binary |
| `opencode-runtime` | **pass** | the OpenCode runtime gate |
| `e2e-full`, `e2e-big-pickle` | skipped | manual-dispatch only (`workflow_dispatch` inputs), not withheld by a failure |

Run [40480496977](https://github.com/Rajendertyagi/TBAi/actions/runs/40480496977) at `7e79b30` is the run that **exposed** the second F3 defect, and its evidence is kept below because it is what made D3b visible. That run is the first one that contains every fix in this session, and the first that compiled the Rust handshake:

| Job | Result | Evidence it carries |
|---|---|---|
| `tauri` | **pass** | `cargo check`; step 12 **`cargo test`** (the six handshake tests); `tauri build`; packaged smoke test; G1 + G2 observations |
| `e2e` | **pass** | `[e2e] spec files ok: 7, failed: 0`, including `p2-live-runtime.spec.ts` and `phase-8-tabs-navigation.spec.ts` - the two that were red at `9120246` |
| `opencode-g3` | pass | both cases against the real binary |
| `opencode-runtime` | pass | |
| `verify` | **fail** | typecheck, lint, format check, test-location policy and build all pass; **Test** fails on `mcp-v2` F3 |

Read from the artifact, not from the job colour (`tauri-webview-origin`, id `12722859652`):

- `dev/dev.json`: `beforeDevCommand: "bun run dev:shell"`, launch markers include the preload, and **`devInstanceIdMatched: true`** with one identity - `ef125d92-…` - in the launch record, the probe body, `observedInstanceId` and `backendStartup.booted[0].instanceId`. Teardown: `method: "taskkill /F per recorded pid"`, 12 descendants, `survivors: []`, `confirmed: true`, `tempRootRemoved: true`.
- `packaged/packaged.json`: `originMatchesExpected: true`, in-origin `/api` 200, **`instanceMatchesApp: true`**, portable `TBAi.exe` launched from the uploaded artifact.

The red job fails on exactly one case, and it is **not** the one D3 fixed:

```
(fail) F3 - unexpected session/transport loss > transitions to error and
       reconnects when transport closes unexpectedly [5756.70ms]
error: expect(received).toBeDefined()   tests/integration/mcp/mcp-v2.test.ts:265
```

with the log sequence quoted in section 2 (D3b). That is root-caused and fixed in the commit after this run; it was not re-run until it went green.

For contrast, the previous run [40360945274](https://github.com/Rajendertyagi/TBAi/actions/runs/40360945274) at `9120246` had `verify` green but `e2e` red on the two specs, no compiled Rust, and a G3 artifact whose `method` was still `taskkill /T /F`. Neither artifact describes the fixes it predates.

### The G5 re-issue at the same SHA

Run [40498931974](https://github.com/Rajendertyagi/TBAi/actions/runs/40498931974) was dispatched on 2026-10-27 with `e2e_full=true` and the full `final_sha`, and is green on every job it ran: `verify`, `tauri`, `e2e`, `opencode-g3`, `opencode-runtime`, and **both** `e2e-full` legs (chromium-headless 25m40s, edge-headless 26m10s). `e2e-big-pickle` was skipped because `live_opencode` was not requested, which is its documented dispatch-only behaviour. It therefore also re-runs the whole certification job set at the certified SHA, and its comparison artifacts are the ones section 5 reads.

One earlier dispatch of the same work, run `40498782366`, was **invalid and cancelled**: it passed the abbreviated revision `8bbe5a6` as `final_sha`, and `actions/checkout` resolves `ref` as a branch or tag, so both G5 legs failed at checkout within seconds (`A branch or tag with the name '8bbe5a6' could not be found`). It produced no evidence, is recorded here rather than hidden, and the re-dispatch uses the 40-character SHA.

---

## 8. Criteria - passed, failed, unverified

| Criterion | Status | Basis |
|---|---|---|
| Dev backend identity cannot attach to a stale/foreign server | **passed** | CI `tauri` step 12 `cargo test` green (the six `classify_dev_instance`/attach tests executed); G2 artifact `devInstanceIdMatched: true`, with the launch record `ef125d92-…` equal to the probe body, the observed id and the booted backend's id |
| Packaged startup, sidecar ownership, recovery, shutdown preserved | **passed** | same run: packaged smoke test, G1 observation (`instanceMatchesApp: true`), teardown `survivors: []`, `tempRootRemoved: true` |
| `2,000 ms` config-read failure explained and fixed at the right layer | passed | origin proven by reading the call path; 13 pass x5 |
| OpenCode contract correct for the pinned range | passed | measured 2.1.4 table + 34 pass, real binary |
| D1, D2, D3 root-caused and fixed | passed | measurement + 5x each, then three full `verify` |
| D3b root-caused and fixed | passed | 8/10 -> 0/10 under 2x load; full file 3/3 -> 0/2 loaded and 2/2 clean; the failing run's generation stacks prove the abandonment was the case's own `finally`; `verify` green at `8bbe5a6` with this case in it |
| Full `verify` at the final tree | passed | 5041 pass / 66 skip / 0 fail (5107 tests, 378 files) three times; DOM 577 pass; quarantine OK |
| Ordinary E2E suite | **failed on 3 pre-existing spec files** | identical at baseline `5f85e53`; not fixed here |
| G3 both cases against the real binary | passed | CI job green at `7e79b30` and `8bbe5a6`, plus 2 local runs; artifact records `method: taskkill /F per recorded pid`, no survivors |
| G5 comparison | **passed at the certified SHA** | run `40498931974`: both projects `ok: true`, 120 tests / 115 pass / 4 fail / 1 skip at baseline `3ce8d8c` and at `8bbe5a6`, identical digests, nothing removed (section 5) |
| `e2e` job at `8bbe5a6` | **passed** | 7/7 spec files, including the two red at `9120246` |
| CI green on the final bytes | **passed** | run 40491928882 at `8bbe5a6`: all five required jobs green; `verify` ran the whole chain (steps 12-16), `e2e` 7/7 |
| Whole CI set re-run at the same SHA | **passed** | run 40498931974, dispatched only to re-issue G5: `verify`, `tauri`, `e2e`, `opencode-g3`, `opencode-runtime` and both `e2e-full` legs green; `e2e-big-pickle` skipped by dispatch policy |

### Scope of this PASS

Three things are explicitly outside it, and none of them is a regression introduced here:

1. **Three spec files fail locally on every run** (`tool-body-budget` x2, `phase-ua-d` D1, `context-menu-spellcheck`). They fail identically at baseline `5f85e53`; the CI `e2e` job does not run them, so CI cannot see them either way. Not fixed here, not de-scoped silently.
2. **The G5 comparison at the certified bytes is `3ce8d8c` -> `8bbe5a6`**, a one-commit delta, because the workflow fixes the baseline at `final^1`. It proves the certified bytes removed nothing and introduced no failure relative to that parent; the wider code delta is described by the `dd51334` comparison, which is kept for its inventory and failure list (section 5).
3. **Semgrep is out of scope** per the 2026-10-26 ADR. No claim is made about it.

The two gaps the earlier HOLD named are closed by artifacts: `cargo test` ran in the `tauri` job and passed, and the G2 artifact records `devInstanceIdMatched: true` with the identity it observed equal to the one this launch minted.

---

## 9. Unresolved and known limitations

- **A chat turn issued inside the reconnect's discovery window sees no MCP tools.** `runConnect()` publishes `connected` after `client.connect()` and before `discoverCapabilities()`, and `getAiTools()` reads `conn.tools`, which is empty until discovery finishes. Measured 290 ms in CI and up to ~8 s on a 2x-oversubscribed runner. Closing it needs a capability-ready signal that the timer-driven reconnect path can await; publishing `connected` later does **not** close it, because `conn.tools` would still be empty. Left open deliberately, with the test waiting for the capability it asserts (D3b) instead of masking this.
- **`mcp-v2` F3 no longer fails under load, but the load itself is a tool, not a gate.** The 8/10-before, 0/10-after evidence comes from a manual 2x-oversubscribed run; no CI job reproduces that load, so the fix is evidenced by measurement plus three clean full `verify` runs, not by a permanent stress gate.
- **One early `verify` failure is unidentified.** A run early in the session exited non-zero with 5025 pass / 1 fail; the failing test's name was not captured and the log was overwritten by the next run. It never reproduced across the 15 completed runs logged before today's fix (`verify-run2` through `verify-run17`, excluding `verify-run6`, which aborted earlier at the lint gate) or in the three full runs after it. This is recorded as unresolved, not as "intermittent" and not as "harmless".
- **Three spec files fail locally on every run** (`tool-body-budget` x2, `phase-ua-d` D1, `context-menu-spellcheck`) and fail identically at baseline `5f85e53`. Out of scope; not de-scoped silently.
- **`virtualizer/scroll-anchoring-regressions` R2** failed in the `dd51334` comparison and passes at both revisions of the certified one. It was not re-run in isolation, so its pass is recorded rather than attributed; E1 is the only scroll-position change in between.
- **`run-start-scroll.spec.ts` remains `test.fixme`** with its stale docblock intact. Not changed here.
- **One `verify` run exited non-zero on a Biome formatting diff** mid-session (the formatter disagreed with a hand-wrapped expression). Fixed by running the formatter, not by loosening a rule; all three final runs include the format check.
- **Semgrep is out of scope** per the 2026-10-26 ADR. No claim is made about it.
- **A live GitHub token was pasted into this session's chat** and should be rotated.

---

## 10. Residual items, carried forward (not blockers)

1. **Done 2026-10-27** - the G5 comparison was re-issued at the certified SHA (run `40498931974`, section 5). Its baseline is that commit's first parent, so a comparison spanning the whole code delta still rests on the earlier `dd51334` artifact.
2. The three pre-existing E2E spec files stay red until someone fixes them; they are outside this session's scope and identical at the baseline.
3. The bounded MCP discovery window in section 9 needs a capability-ready signal the timer-driven reconnect can await, if a chat turn losing MCP tools for one turn is judged worth closing.
4. Rotate the GitHub token pasted into this session's chat.

The certification itself does not depend on any of these. What it does depend on - every required CI job green at the pushed SHA, with the Rust tests and the two repaired E2E specs actually executed - is recorded in sections 7 and 8.
