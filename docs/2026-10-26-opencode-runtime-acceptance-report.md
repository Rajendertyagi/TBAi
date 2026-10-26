# OpenCode Runtime — Final Evidence and CI Remediation

**Branch:** `ci/tauri-e2e-verify` · **Code HEAD under test:** `0458faa4e441aa90a369e12e6a8ee3446e59f66c` · **Report started at:** `ab9406ae2c7d26f6982bc3fa0edb68b2d2508cb2` · **Date:** 2026-10-26

---

## 1. Branch HEAD and commits

```
Branch : ci/tauri-e2e-verify
Code   : 0458faa4e441aa90a369e12e6a8ee3446e59f66c   (the code under test)
Docs   : ab9406a, c621fb0, and later — this document only
```

Four commits carry the work, in the order they were pushed:

| Commit | Subject | Touches |
|---|---|---|
| `e279daf` | `fix(tauri): development attaches to the beforeDevCommand backend instead of spawning a sidecar` | `src-tauri/src/main.rs`, `docs/architecture.md`, `docs/decisions.md` |
| `0efbd11` | `fix(g2): attribute backend startup by instance, and log the instance id` | `src/server.ts`, `src/index.ts`, `scripts/observe-dev-webview-origin.ts`, its unit test, `docs/logging.md` |
| `0458faa` | `refactor(g2): name the attribution's unconsumed lines for what they are` | the same script and test (`nonLogLines` → `otherLines`, comment corrected) |
| `ab9406a` | `docs(opencode): correct the G2 root cause, record the ownership fix, and report the CI evidence` | this report, one ADR sentence |

The task started from `ae41ff6`. No G1 implementation was changed, and no E2E spec,
acceptance criterion, timeout or assertion was relaxed.

This document was refined afterwards in docs-only commits (`ab9406a`, `c621fb0`, and the
commit that carries the text you are reading). A docs-only commit cannot change what a
job executes — `git diff 0458faa..c621fb0 -- src web src-tauri` is empty — so every claim
below cites the run whose SHA it names rather than "the current head": the runs that carry
the fix are `0efbd11` and `0458faa`, plus `ab9406a` and `c621fb0`, whose trees differ from
`0458faa` only in `docs/`. A later edit to this file neither re-runs them nor inherits
their conclusions.

---

## 2. GitHub Actions runs and job conclusions

| Run ID | SHA | `verify` | `tauri` | G1 | G2 | `opencode-g3` | `opencode-runtime` | `e2e` |
|---|---|---|---|---|---|---|---|---|
| 40294666676 | 36f5f13 | **FAIL** (2 tests) | PASS | PASS | **PASS (false positive)** | PASS | PASS | **FAIL** (2 specs) |
| 40323271013 | fa60060 | PASS | **FAIL** | PASS | **FAIL** | PASS | PASS | **FAIL** |
| 40329107636 | 6624227 | PASS | **FAIL** | PASS | **FAIL** | PASS | PASS | **FAIL** |
| 40332084934 | ae41ff6 | PASS | **FAIL** | PASS | **FAIL** | PASS | PASS | **FAIL** |
| 40350649628 | 0efbd11 | **FAIL** (1 flaky test) | **PASS** | PASS | **PASS** | PASS | PASS | **FAIL** |
| 40351287342 | 0458faa | **PASS** | **PASS** | PASS | **PASS** | **FAIL** | PASS | **FAIL** |
| 40353996209 | ab9406a (docs-only) | **PASS** | **PASS** | PASS | **PASS** | **PASS** | PASS | **FAIL** |
| 40357762624 | c621fb0 (docs-only) | **FAIL** (1 flaky test) | **PASS** | PASS | **PASS** | **PASS** | PASS | **FAIL** |

`e2e-full` (G5) and `e2e-big-pickle` are dispatch-only and were skipped in every run.

The rows that matter for this task are `0efbd11`, `0458faa`, `ab9406a` and `c621fb0`:
**G2 passed in all four**, G1 passed in all four, and the `tauri` job — Rust typecheck,
Rust tests, `tauri build`, the packaged smoke test, G1, G2 and both uploads — is green in
all four. `opencode-g3` is green in three of the four. `verify` is green in two of the
four, and its two failures are different tests: `0efbd11` failed `memory-wiring`, and
`c621fb0` — a commit that changes **only this Markdown file** — failed a `mcp-v2`
transport-loss case. Neither failure is reachable from the code in those commits; §5 and
§7 record them.

### The `36f5f13` G2 "PASS" was a false positive

At `36f5f13` the probe had no startup-failure signal at all: it checked the `tauri dev`
process and the CDP observation. The origin and the API it read were genuine, but the
job went green while the process the shell itself spawned was hitting `EADDRINUSE` on
every retry — so no endpoint was ever verified by the shell, and the window was served
by the other backend the launch started. A `tauri` job that passes is read as "the
desktop launch works"; at `36f5f13` that reading was false. That pass is why the check
was investigated, and it is **not** evidence that the development launch was healthy.
See §3.

---

## 3. G2 — verified root cause, the ownership fix, and the attribution rule

### 3.1 Root cause (proven, not inferred)

A single `tauri dev` launch started **two backends** and let one of them fail:

1. `tauri.conf.json` sets `build.beforeDevCommand: "bun run dev"` and
   `build.devUrl: "http://localhost:3000"`. The Tauri CLI starts `beforeDevCommand`
   and **waits for `devUrl` to answer before it builds and launches the Rust app** —
   `tauri dev` documents `--no-dev-server-wait` as "Skip waiting for the frontend dev
   server to start before building the tauri application"
   (<https://v2.tauri.app/reference/cli/#dev>; the flag exists only because waiting is
   the default). So the `beforeDevCommand` backend bound :3000 first and owned it.
2. The G2 driver forces `PORT=3000` into the `tauri dev` process, so the dev backend
   binds the port the window loads instead of self-healing upward. With an explicit
   `PORT`, `bindBootPort` treats the port as authoritative and does not scan
   (`src/services/server-listener.ts`).
3. The Rust shell then ran `attempt()`, which spawned the packaged `tbai-server`
   sidecar. `tauri-plugin-shell` starts that child with the parent environment plus
   the explicit `.env()` calls, so it inherited `PORT=3000`, `DATA_DIR` and
   `TBAI_LOG_FILE`.
4. The sidecar's `bindBootPort(3000)` threw `EADDRINUSE` — again with no heal scan,
   because `PORT` was set — `startServer` rejected, `src/index.ts` logged
   `server.startup_failed`, and the child exited. The Rust shell's crash window then
   retried it (up to 3 times in 30s) while the window kept loading the first backend.
5. Both processes wrote to the **same** application log, because both inherited
   `TBAI_LOG_FILE` from the launch.

Evidence that the failing process was the sidecar and not the frontend's backend: the
log carried the compiled sidecar's own stack frames, the `tauri dev` process tree
stayed up (`dev.exitedEarly: false`), and the in-page API answered `200` with an
instance id (`96158112-9204-42d3-a94a-c4ee24ea5048` in artifact `12650616923`) while
the failure was being logged. A process that has failed to bind cannot serve that
answer; two processes were present, and the log did not say which one spoke.

**This corrects §4 of the previous revision of this report.** That revision read the
same `startup_failed` line as "the `beforeDevCommand` backend failed and a foreign
server held port 3000". The ordering above (Tauri waits for `devUrl` first) and the
stack trace make that attribution wrong: the intended backend was serving the page the
whole time, and the redundant sidecar was the process that died.

### 3.2 The fix — one owner per launch

`src-tauri/src/main.rs`:

- `attempt()` now branches on `tauri::is_dev()` (`!cfg!(feature = "custom-protocol")`,
  the CLI's own build-time switch: true for `tauri dev`, false for release **and**
  `--debug` packaged builds). In development it calls `attach_dev_backend()` and
  returns before any sidecar code runs — no spawn, no port mirror, no shell job, no
  crash recovery, no stdin handshake, because there is no child.
- `attach_dev_backend()` reads the port from `build.devUrl` (never `PORT`, never the
  mirror) and polls `GET /api/server/instance` until an answer **carrying an instance
  id** arrives, then publishes the endpoint and emits `backend-ready`. A static page
  or a non-TBAi server on the same port answers without `instanceId` and is not
  accepted. `retry_startup` re-enters the same path.
- `quit_owned()` is unchanged: with no child it has nothing to handshake with and
  exits immediately.

Packaged startup, crash recovery, the named kill-on-close job and the graceful
shutdown handshake are untouched. `tauri build` and the packaged smoke test passed in
both new runs, which is the observable proof that the packaged branch still works.

### 3.3 The attribution rule — a record names its process

- `server.started` now logs `port` and `instanceId`; `server.startup_failed` logs
  `instanceId`. `instanceId` is exactly what `GET /api/server/instance` returns
  (`TBAI_INSTANCE_ID`, or a fresh UUID).
- `scripts/observe-dev-webview-origin.ts#attributeBackendLog()` parses the log's JSON
  lines, keeps only `scope: "server"` lifecycle records, and groups starts and failures
  by the instance that wrote them. Entries with no instance id are kept as
  `unattributedFailures` rather than credited to somebody.
- `assessDevOrigin()` accepts an observation only when the instance that answered the
  in-page API is the instance the log records as having **started on the configured
  port**. The failure matrix is: own failure → `dev-start` failure; no start record for
  the answering instance → `dev-start` failure; bound-port mismatch → `dev-start`
  failure. A `startup_failed` from a **different** instance becomes a `note`, printed as
  `[g2] note: …` and recorded in `dev.json`, and does not fail the run.
- The evidence file records `observations.observedInstanceId`, a derived
  `observations.backendStartupFailed` (true only for the answering instance) and the
  full `backendStartup` attribution.

This is the rule that was missing: a shared log file must not turn one process's crash
into another process's failed evidence, and a failure from one process must not be
reported as another's.

### 3.4 What a G2 PASS asserts

`main()` returns 0 only when **all** of the following hold, and the step conclusion is
that exit code:

- the web bundle was built by this run;
- `tauri dev` started and did not exit early;
- the CDP endpoint answered and a `page` target exists on the configured origin;
- `Runtime.evaluate` reported `location.origin === "http://localhost:3000"` — the
  observed origin, never the configured value;
- the in-page `GET /api/server/instance` returned `200` with a non-empty instance id;
- that instance has a `server.started` record whose `port` is 3000;
- teardown: the dev process tree was confirmed terminated, the temporary root removed,
  and no teardown error was recorded;
- the evidence file was written.

G2 succeeded in **all four** runs that carry the fix (`0efbd11`, `0458faa`, and the
docs-only commits `ab9406a` and `c621fb0`), and G1 succeeded in the same four. Artifact
`tauri-webview-origin`:

| Run | Artifact ID | Bytes |
|---|---|---|
| 40350649628 (`0efbd11`) | `12664382195` | 11,169 |
| 40351287342 (`0458faa`) | `12664332072` | 11,244 |
| 40353996209 (`ab9406a`) | `12666271026` | 11,144 |
| 40357762624 (`c621fb0`) | `12667533914` | 11,247 |

The artifact contents (`dev.json`, the sanitized logs) could **not** be downloaded from
this environment: GitHub requires authentication for artifact zips and step logs
(`/actions/artifacts/<id>/zip` answers `401` with no token available). Everything in
this section therefore rests on the step conclusions — which are the exit code of the
assertions above — plus the unit tests that pin each of those assertions. The literal
observed instance id and origin string are inside `dev.json` and were not read back.

### 3.5 Why this is not a false positive

For a `PASS` to be wrong, a **foreign** TBAi backend on :3000 would have to answer the
in-page probe with an instance id that also appears in a `server.started` record in
*this run's* application log. The log is a fresh file in a fresh temporary root
(`TBAI_LOG_FILE` under `mkdtemp`), inherited only by this launch's own children, and
the instance id is a per-boot UUID. A second, unrelated instance cannot write into it.
The accepted answer and the accepted start record therefore belong to the same process
the launch started.

### 3.6 What G2 does not assert

G2 does **not** assert that no other process in the launch failed. That is deliberate:
making another instance's failure fatal would restore exactly the misattribution this
work removed. The absence of the redundant sidecar is a property of the source
(`tauri::is_dev()` returns before any sidecar code), and its compiled reality is the
green `cargo check --all-targets`, `cargo test` and `tauri build` steps — not a G2
observation.

---

## 4. G1 evidence (accepted, unchanged)

G1 was not touched. In all four runs that carry the work (`0efbd11`, `0458faa`,
`ab9406a`, `c621fb0`) the packaged observation step succeeded, together with the packaged
build, the portable-folder assembly and the packaged smoke test. The accepted G1 evidence
remains run `40294666676`, artifact
`tauri-webview-origin` (ID `12638461295`): origin `http://app.localhost`, in-origin API
`200`, instance `e760d3cb-e9b1-4282-b43d-838d51769d8c`, WebDriver session delete `200`,
temporary root removed, both logs written. No G1 code changed.

---

## 5. `verify` job — results and three intermittent failures

| Run | Result | Detail |
|---|---|---|
| 40294666676 (`36f5f13`) | FAIL | `memory-wiring.test.ts` "considers at most 50 candidates" ~40.2 s vs 30 s; `stdin-shutdown.test.ts` "graceful shutdown" 3,361 ms vs 3,000 ms |
| 40323271013, 40329107636, 40332084934 | PASS | all tests pass |
| 40350649628 (`0efbd11`) | FAIL | **1** test: `memory-wiring.test.ts` "considers at most 50 candidates" **33,537 ms** vs 30 s; totals 5,026 pass / 64 skip / 1 fail |
| 40351287342 (`0458faa`) | PASS | — |
| 40353996209 (`ab9406a`) | PASS | — |
| 40357762624 (`c621fb0`, docs-only) | FAIL | **1** test: `mcp-v2.test.ts` "F3 — unexpected session/transport loss > transitions to error and reconnects when transport closes unexpectedly" **5,735.87 ms**; totals 5,026 pass / 64 skip / 1 fail |

Three different tests have now failed intermittently on this branch, each on a tree where
the same suite passed elsewhere, and the last one on a commit that changes **only this
Markdown file** (`git diff 0458faa..c621fb0 -- src web src-tauri` is empty). That is the
clearest evidence available that these are environmental timings, not regressions: the
inputs of the passing and failing `verify` jobs are byte-identical in every file a test
compiles.

- `memory-wiring.test.ts` "considers at most 50 candidates": ~1.3–1.4 s per run locally in
  three consecutive runs, 33.5–40.2 s against a 30 s budget in CI. The 500-row
  `assembleContext` call is load-sensitive under full-suite runner load.
- `stdin-shutdown.test.ts` "graceful shutdown": 3,361 ms against a 3,000 ms budget in CI,
  well under 3 s locally; the drain paths it waits on are bounded but load-sensitive.
- `mcp-v2.test.ts` F3: 28 pass / 0 fail twice locally (`69.84 s` and `69.18 s` for the
  whole file). The case is built on two wall-clock waits — a 5 s poll for the `onclose`
  error transition, then the manager's 5 s `RECONNECT_DELAY_MS` retry timer — so a
  5,735.87 ms failure is consistent with either assertion group (the error transition not
  logged within its 5 s budget, or the reconnect assertions after the timer fired). Which
  one it was is **not observed**: step logs are not readable from here (§7). No assertion
  was relaxed to explain it.

**No timeout was relaxed and no test was skipped or removed.**

---

## 6. G5 baseline findings (preserved, not re-run)

G5 comparison run `40289523595` (at `dd51334`, dispatch-triggered):

| Field | Value |
|---|---|
| Run ID | 40289523595 |
| Head SHA | `dd5133437f4497e8ebac993f008a9e40403e18c0` |
| `final_sha` | `5f85e53` ("feat(e2e): compare the full suite at two revisions") |
| `harness_sha` | `5f85e53` (the revision that owns the pinned-harness manifest) |
| `baseline_sha` | `795ca50` (`5f85e53^1`) |
| Chromium tests / passed | 120 / 109 |
| Edge tests / passed | 120 / 109 |
| Common failures (both) | 8 |
| Skipped | 3 |
| Spec files | 39 |
| Final-only failures | 0 |
| Removed tests | 0 |

**What G5 establishes:** no regression between `baseline_sha` and `final_sha` in the
specified comparison — **not** that the E2E suite is fully passing. The 8 common
failures are pre-existing and are not addressed by this task.

**Provenance check:** `git diff 5f85e53..0458faa --name-status -- src web` reports exactly
two backend files, `src/index.ts` and `src/server.ts`, and **no** file under `web/`.
Both changes add one field to a log record (`instanceId` on `server.started` and on
`server.startup_failed`); neither changes request handling, chat streaming, tool
execution, the OpenCode runtime or any rendered behaviour. The other commits after
`5f85e53` touch `.github/workflows/tests.yml`, `docs/`, `scripts/`,
`tests/unit/tooling/`, `src-tauri/src/main.rs` (desktop shell only) and
`package.json`. The product surface the G5 comparison covered (backend chat/OpenCode
runtime + web app) is therefore unchanged, so a new two-revision G5 run would compare
the same behaviour.

**Disclosure:** the numbers above are from the original G5 dispatch run. Its report
files live in that run's artifacts, which this environment cannot download (§7); the
provenance claim was re-checked here with `git diff` against the code head.

---

## 7. All unresolved findings and limitations

### Unresolved — `opencode-g3` failed once in four runs

Run 40351287342 (`0458faa`): the `Override-notice evidence (G3)` step exited 1. The
same job passed in run 40350649628 (`0efbd11`), four minutes earlier, and passed again in
runs 40353996209 (`ab9406a`) and 40357762624 (`c621fb0`). `git diff
0efbd11..0458faa --name-only` is exactly `scripts/observe-dev-webview-origin.ts` and
its unit test; the G3 driver (`scripts/run-g3-override-evidence.ts`) imports neither,
and no product source differs between those runs. The job's own inputs were therefore
identical and its outcomes differed — an intermittent failure, not a regression from
this work.

Its cause was **not observed**: step logs and the `g3-override-evidence` artifacts
require authentication to read. The one observable difference is size —
`12664081214` (failing run) is 13,995 bytes against 20,095, 20,091 and 20,108 bytes in
the three passing runs, which is consistent with the failing run stopping before both
cases wrote their evidence. The failure is recorded as unresolved, not explained away,
and it is not being called green: a red job occurred at a commit that carries this work.

### Unresolved — `verify` is intermittent, and one failure landed on a docs-only commit

Three of the eight runs in §2 have a red `verify` — `36f5f13` (two tests), `0efbd11`
(`memory-wiring`) and `c621fb0` (a `mcp-v2` transport-loss case) — and `c621fb0` is the
commit that changes **only this Markdown file**, so its tree differs from the passing
`ab9406a` in `docs/` alone. The per-test timings are in §5. This is an unresolved property
of the suite under runner load, not of the change: the same compiled inputs passed and
failed. No timeout was relaxed and no test was skipped, so the job can still be red for
reasons this task did not cause and does not fix. The honest consequence is that
"`verify` is green" is true of `0458faa` and `ab9406a` only, and is not a stable property
of the branch.

### Unresolved — pre-existing E2E failures (out of scope)

The `e2e` job failed in **every** run of this branch, including the base commit
`ae41ff6`, where it failed with the same two specs that the G5 comparison records among
its 8 common failures:

1. `p2-live-runtime.spec.ts` — "A/D/E: streaming follows at the end, and does NOT steal
   position when scrolled away."
2. `phase-8-tabs-navigation.spec.ts` — "deleting the active conversation falls back
   safely; deleted id never active" (120-second click timeout).

No E2E spec, acceptance criterion or timeout was modified. **Disclosure:** the per-spec
failure list for the new runs could not be re-read (step logs require authentication);
what is known is that the job exited 1 exactly as it did at the base commit, and that
nothing in this task touches `web/`.

### Limitation — artifact and log contents are not readable from here

No GitHub token is available in this environment: `gh` is not logged in, `GH_TOKEN` and
`GITHUB_TOKEN` are unset, artifact zips answer `401`, and step logs are not
downloadable. What *is* readable unauthenticated — run and job conclusions, per-step
conclusions, artifact names/IDs/sizes, and check-run annotations — is quoted above with
its run and artifact identifiers. The literal values quoted for G1 (§4) and for the
`fa60060` launch (§3.1) were recorded when those artifacts were first inspected earlier
in this work; they were **not** re-read for this revision, and no G2 `dev.json` was
opened. Those passes rest on the step exit codes plus the unit tests that pin each
assertion. Step *logs* are readable only as the annotations GitHub exposes, which is how
the failing test names and counts in §5 were obtained; the assertion that fired inside
`mcp-v2.test.ts` F3 was not among them.

### Limitation — the Rust change was compiled only in CI

There is no Rust toolchain on this machine (`cargo`, `rustc` and `rustup` are absent;
no Visual Studio build tools). The `src-tauri` change could not be compiled or tested
locally. It is verified by the CI steps `Type-check the Rust shell` (`cargo check
--all-targets`), `Run Rust tests` (`cargo test`), `Build Tauri (compile, no bundle)`
and `Smoke test the packaged desktop app`, all green in the three runs that carry it.

### Not executed — a re-run of `verify` at `36f5f13`

Re-running a job and dispatching a workflow both require authentication, which is
unavailable. The equivalent evidence is the complete `verify` run at `0efbd11`,
`0458faa` and `ab9406a` on the same branch.

### Not in scope — Semgrep

`bun run security` (Semgrep) is out of scope per `f50f5f6`. No claim of Semgrep passing
is made.

---

## 8. Local verification (this machine)

Every command below was run against `0458faa` and its real exit code is reported:

| Command | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun run lint` (Biome, `--error-on-warnings`) | exit 0 |
| `bun run format:check` | exit 0 |
| `bun run test:locations` | exit 0 |
| `bun run build` (backend compile + web build) | exit 0 |
| `bun test tests/unit/tooling/webview-origin-evidence.test.ts` | exit 0 — **67 pass**, 0 fail |
| `bun run test` (full unit + integration) | run 1: 2 failures, **names not captured before the output was truncated**; run 2: **5,025 pass / 66 skip / 0 fail**, exit 0 |
| `bun run test:shutdown` | exit 0 — 1 test, 0 fail |
| `bun run test:startup-rollback` | exit 0 — 2 tests, 0 fail |
| `bun run test:lifecycle-integration` | exit 0 — 3 tests, 0 fail |
| `bun run test:dom` | exit 0 — **577 pass**, 0 fail |
| `bun run test:quarantine` | exit 0 |
| `bun test tests/integration/mcp/mcp-v2.test.ts` | exit 0 twice — **28 pass**, 0 fail (`69.84 s`, `69.18 s` for the file) |

Several entries were re-run while composing this revision, against the same code tree
(`docs/` changes do not affect any of them): `bun run format:check`, `bun run lint`,
`bun run test:locations`, `bun run build`, the focused 67-case suite, the full
`bun run test` (5,025 pass / 66 skip / 0 fail), the three lifecycle suites, `test:dom`
(577 pass) and `test:quarantine`, all exit 0 — the same results as recorded above. The
`mcp-v2` file was run twice specifically because CI failed it at `c621fb0`: it passed
both times locally.

The two local failures in the first full run were not captured with their names; the
second full run of the identical tree was clean, and CI's `verify` was clean at `0458faa`
and `ab9406a` and red at `c621fb0` (docs-only). They are recorded here rather than
omitted.

### Tests that cover this work

`tests/unit/tooling/webview-origin-evidence.test.ts` (67 cases) now includes:

- the intended backend failing → `dev-start` failure, naming the instance and its reason;
- a **different** instance failing while the page's backend started cleanly → `ok: true`
  with a `note`, never a failure;
- a shared/interleaved log (two instances, one start, one failure, one non-JSON line)
  → the right instance decides the verdict and is the only one named in the notes;
- no start record for the answering instance → `dev-start` failure;
- the answering instance bound another port → `dev-start` failure;
- `attributeBackendLog` boundaries: grouping, an id-less failure staying unattributed,
  wrong scope, a start with no id, malformed JSON;
- `instanceIdFromProbe` boundaries: 200 with and without an id, 404, HTML, whitespace;
- `portOfOrigin` boundaries: explicit port, default 80/443, non-URL, null;
- the pre-existing matrix (build, CDP, target list, evaluate, probe, packaged origin,
  artifact set, sanitized uploads) unchanged.

---

## 9. Verdict

**G2: PASS.** The development window is served by the backend that owns the configured
port, the failure attribution is per process, and the observation passed four times with
the fix in place (`0efbd11`, `0458faa` and the docs-only commits `ab9406a` and `c621fb0`)
while G1 and the packaged smoke test stayed green in the same jobs. The previous HOLD
rested on a misattributed failure; that attribution is corrected in §3 and the competing
backend it described no longer exists in a development launch.

**Overall acceptance: HOLD**, for reasons that are not the G2 defect:

1. `opencode-g3` failed in one of the four runs that carry this work (`0458faa`), with
   no observable cause, against inputs identical to runs that passed immediately before
   and after it. One red job at a commit carrying the work is not a pass.
2. The two pre-existing E2E spec failures remain, as they did at the base commit, and
   were explicitly out of scope.
3. `verify` is intermittent across three distinct tests, and at `c621fb0` it failed on a
   tree that differs from a green run only in `docs/`. That is a suite-under-load problem
   this task did not introduce and did not fix, and it is not being called green.

Each is disclosed rather than absorbed, and none is caused by this work.

What is **not** claimed: that the `e2e` job's per-spec failures were re-read for the new
runs, that the G2 artifact's literal values were read back, that the exact assertion
inside `mcp-v2.test.ts` F3 is known, or that `opencode-g3` and `verify` are fixed. No gate
was made green by weakening it.
