# OpenCode Runtime — Final Evidence and CI Remediation

**Branch:** `ci/tauri-e2e-verify` · **HEAD:** `fa60060fbee796271f88dd328880295fcd5a0234` · **Date:** 2026-10-26

---

## 1. Branch HEAD and commit SHA

```
Branch : ci/tauri-e2e-verify
HEAD   : fa60060fbee796271f88dd328880295fcd5a0234
Title  : fix(g2): fail the dev origin observation when the launched backend failed to start
```

The task started from `36f5f13` (the G1 gsudo fix). The G2 probe defect was fixed in one
additional commit, `fa60060`, which touched only:

- `scripts/observe-dev-webview-origin.ts` — added `backendStartupFailed` to `DevOriginInput`,
  `assessDevOrigin`, and `main()`; recorded the flag in the uploaded `dev.json`.
- `tests/unit/tooling/webview-origin-evidence.test.ts` — added the `backendStartupFailed`
  default to `devInput` and two regression tests.

No G1 implementation was changed. No production modules exercised by the two `verify` test
failures were changed.

---

## 2. GitHub Actions runs and job conclusions

| Run ID | SHA | Trigger | `verify` | `tauri` | `opencode-runtime` | `opencode-g3` | `e2e` | `e2e-full` |
|---|---|---|---|---|---|---|---|---|
| 40294666676 | 36f5f13 | push | **FAIL** (2 tests) | PASS | PASS | PASS | **FAIL** (2 specs) | skipped |
| 40323271013 | fa60060 | push | **PASS** | **FAIL** (G2 step) | PASS | PASS | **FAIL** (2 specs) | skipped |

### Run 40294666676 (at 36f5f13)

- `verify`: FAILED — `memory-wiring.test.ts` "considers at most 50 candidates" exceeded the
  30 s timeout (measured ~40.2 s); `stdin-shutdown.test.ts` "graceful shutdown" measured 3,361 ms
  against a 3,000 ms budget.
- `tauri`: PASSED — G1 and G2 both reported success (G2 is the run this task investigated).
- `opencode-runtime`: PASSED.
- `opencode-g3`: PASSED.
- `e2e`: FAILED — `p2-live-runtime.spec.ts` "A/D/E: streaming follows at the end" and
  `phase-8-tabs-navigation.spec.ts` "deleting the active conversation falls back safely;
  deleted id never active" (120 s click timeout).
- `e2e-full` (G5): skipped (dispatch-only job).

### Run 40323271013 (at fa60060, triggered by pushing the G2 fix)

- `verify`: PASSED — both tests that failed at `36f5f13` passed on this run, confirming
  they are **intermittent, load-sensitive** failures, not code defects.
- `tauri`: FAILED — the `Observe the development WebView origin (G2)` step exited 1.
  This is the expected consequence of the G2 fix: the runner's port 3000 was again in use,
  the `beforeDevCommand` backend logged `startup_failed` (EADDRINUSE), and the corrected
  probe now correctly refuses to report PASS on the foreign API. See §4.
- `opencode-runtime`: PASSED.
- `opencode-g3`: PASSED.
- `e2e`: FAILED — the same two spec failures as at `36f5f13` (pre-existing, not a regression
  from the G2 commit; the G2 commit touched only `scripts/` and one test file).

---

## 3. G1 evidence (accepted, unchanged)

Run 40294666676, `tauri` job, artifact `tauri-webview-origin` (ID `12638461295`):

| Value | Evidence |
|---|---|
| Packaged app launched | G1 step success; driver tree confirmed stopped at teardown |
| Host integrity | `medium`; `elevated: false` |
| Observed WebView origin | `http://app.localhost` |
| In-origin API status | `200` |
| Instance ID (in-origin) | `e760d3cb-e9b1-4282-b43d-838d51769d8c` |
| WebDriver session delete | `200` |
| Temporary root removed | confirmed |
| Both logs written | confirmed |

G1 is **PASS** for run 40294666676. No code was changed.

---

## 4. G2 `EADDRINUSE` log — root cause and disposition

### Causal chain

1. The G2 probe (`scripts/observe-dev-webview-origin.ts`) forces `PORT=3000` into the
   `beforeDevCommand` child's environment so the backend binds the port `devUrl` names
   (`http://localhost:3000`).
2. If port 3000 is already held on the CI runner (a prior TBAi instance, another job's
   leftover process, or runner infrastructure), the launched backend's
   `bindBootPort(3000)` throws `EADDRINUSE`. Because `PORT` is in the environment
   (`isPortEnvLocked()` returns true), the heal-scan is skipped and the error is
   re-thrown: the backend logs `startup_failed` and exits.
3. The Tauri shell (`tauri dev` Rust process) does **not** exit — it continues running.
   The WebView loads `http://localhost:3000` and the CDP endpoint becomes available.
4. The probe's CDP observation finds a page target on `http://localhost:3000` and runs
   the in-page `fetch('/api/server/instance')`. The response comes from **whatever
   server is holding port 3000** — not necessarily the process this run launched.
5. Before the fix, `assessDevOrigin` had no way to detect this: it checked
   `dev.exitedEarly` (the `tauri dev` process, not the backend child) and the CDP/probe
   results. A PASS was recorded even though the observed API belonged to a **foreign
   server** — a false-positive acceptance.

### Disposition

This is a **real defect in the G2 probe**, not an expected architectural consequence.
The fix (commit `fa60060`):

- `main()` now reads the application log (`TBAI_LOG_FILE`, written by the
  `beforeDevCommand` backend, captured **before** the temporary root is removed) and
  computes `backendStartupFailed = /startup_failed/.test(appLogText)`.
- `assessDevOrigin` adds a `dev-start` failure when the flag is set, with the message:
  *"the backend that beforeDevCommand spawned failed to start (startup_failed in the
  application log), so the observed WebView/API belongs to a foreign server on the same
  port, not to this launch."*
- The flag is recorded in the uploaded `dev.json` under `observations.backendStartupFailed`,
  so the artifact makes the attribution failure visible.

### Verification

Run 40323271013 (`fa60060`) `tauri` job: the G2 step **failed with exit code 1**.
This is the correct new behaviour: the runner again had port 3000 occupied, the
`beforeDevCommand` backend logged `startup_failed`, and the probe now correctly refuses
to report PASS. The runner's repeated port 3000 contention is a **test-environment
condition** (not reproducible locally; the port is free locally), and it is now
**correctly surfaced** rather than silently absorbed.

**G2 is HOLD**: the probe is fixed and the fix is committed with regression tests, but
the underlying runner condition (port 3000 already in use when the `tauri` job runs)
is not resolved. G2 cannot produce a clean PASS on a runner where 3000 is occupied.

Regression tests added (`tests/unit/tooling/webview-origin-evidence.test.ts`):
- `dev-start` stage failure when `backendStartupFailed: true` (and the message text).
- Clean PASS when `backendStartupFailed: false`.
- 59 tests pass locally; `bun run typecheck` and `bun run test:locations` exit 0.

---

## 5. `verify` job test failures — root-cause assessment

### "considers at most 50 candidates" (`memory-wiring.test.ts`)

- CI at `36f5f13`: measured ~40.2 s against a 30 s per-test timeout.
- Locally: 3 consecutive runs completed in ~1.3–1.4 s each (well under the budget).
- CI at `fa60060` (run 40323271013): **PASSED**.
- `36f5f13` changed only `.github/workflows/tests.yml` and the G2 unit test — neither
  touches the production memory-assembly modules. The prior passing `verify` run at
  `66f6936` (40292211888) supports that the production code is unchanged.
- **Classification: intermittent, load-sensitive.** Under full CI-suite runner load the
  500-row `assembleContext` call exceeds the 30 s budget. No code defect. No timeout
  relaxation is authorized.

### "graceful shutdown" (`stdin-shutdown.test.ts`)

- CI at `36f5f13`: measured 3,361 ms against a 3,000 ms budget.
- Locally: 4 tests in ~12.7 s total; the shutdown child exits well under 3 s.
- CI at `fa60060` (run 40323271013): **PASSED**.
- **Classification: intermittent, load-sensitive.** The shutdown spine's drain paths
  (scheduler, MCP, chat runs, stream cleanup) are bounded but can exceed 3,000 ms under
  runner load. No code defect. No timeout relaxation is authorized.

Both failures are **supported as intermittent by two independent CI runs**
(40294666676 failed; 40323271013 passed) and by local evidence. No code changes to
those tests were made or authorized.

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

**Provenance check:** `git diff 5f85e53..36f5f13 -- src web` returns no product source
changes. All commits between `5f85e53` and `36f5f13` (and `fa60060`) touch only
`.github/workflows/tests.yml`, `docs/`, `scripts/`, `tests/unit/tooling/`, and
`package.json`. The product source covered by the G5 comparison has **not** been
modified by any subsequent commit.

---

## 7. All unresolved findings

### Unresolved — G2 runner condition

The `tauri` CI runner has port 3000 in use when the G2 `beforeDevCommand` child starts.
This causes the backend to log `startup_failed` and the G2 observation to now (correctly)
fail. The probe fix is committed; the runner's port-3000 contention is not resolved.
G2 evidence from run 40323271013 (`tauri` job, `tauri-webview-origin` artifact, ID
`12650616923`) records the new `backendStartupFailed: true` flag. **G2 cannot produce a
clean PASS until the runner's port 3000 condition is addressed** (e.g. by ensuring the
port is free before the `tauri` job, or by moving the G2 observation to a
non-contented runner).

### Unresolved — pre-existing E2E failures (out of scope)

The following two E2E spec failures are present in both `36f5f13` and `fa60060` runs:

1. `p2-live-runtime.spec.ts` — "A/D/E: streaming follows at the end, and does NOT steal
   position when scrolled away."
2. `phase-8-tabs-navigation.spec.ts` — "deleting the active conversation falls back
   safely; deleted id never active" (120-second click timeout).

Both are **pre-existing** (present in the G5 comparison's 8 common failures). They are
not regressions from the G2 commit. Per the task instruction, they are not expanded into
unrelated E2E repairs.

### Not executed — `verify` re-run at `36f5f13`

The task asked to re-run the `verify` job at `36f5f13` without changing code. This
**could not be executed** because no GitHub Actions authentication token is available in
this environment (`gh` is not logged in; no `GH_TOKEN` or `GITHUB_TOKEN` set;
`POST /rerun-failed-jobs` returns 401).

The equivalent evidence was obtained by **pushing the G2 fix** (commit `fa60060`),
which triggered run 40323271013 — a complete `verify` run at a later SHA on the same
branch. The `verify` job passed in that run, confirming both `36f5f13` failures were
intermittent. This is stronger evidence than a bare re-run at `36f5f13`, because the
G2 commit does not touch the two failing tests.

### Not in scope — Semgrep

`bun run security` (Semgrep) is out of scope per `f50f5f6`. No claim of Semgrep passing
is made.

### G5 `e2e-full` job not re-run at `fa60060`

The `e2e-full` (G5) job is dispatch-only and was not triggered by the `fa60060` push.
The G5 comparison at `40289523595` remains the accepted baseline. A new G5 run would be
required only if the product source it compared (`5f85e53` ↔ `795ca50`) were modified —
which has not happened.

---

## 8. Verdict

**HOLD**

Reasons:

1. **G2 is correctly fixed but the runner condition is unresolved.** The probe no longer
   produces a false-positive PASS. However, the `tauri` job cannot complete a clean G2
   observation while port 3000 is held by a foreign process on the CI runner. This is
   a test-environment condition that requires a runner-side fix or a change to the port
   allocation strategy — not a code defect in the probe itself.
2. **G1 is PASS** (accepted without change, per task instruction).
3. **`verify` test failures are intermittent and confirmed** by two CI runs and local
   evidence. No code changes were made or authorized.
4. **E2E failures are pre-existing** and out of scope for this task.
5. **G5 baseline is preserved** with provenance verified: no product source changed after
   `5f85e53`.

Phase 8 is **not complete** while the G2 runner condition (port 3000 contention) remains
unresolved and the `tauri` job's G2 step continues to fail. All evidence collected in
this task is committed to the branch. The acceptance report above is the current state
of record.
