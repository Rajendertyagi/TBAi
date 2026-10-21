# Engineering Quality

The mandatory checks for this repository, what each one catches, and what it
means to pass them. `AGENTS.md` and `docs/development-rules.md` state the rules;
this file is the executable form of them.

## The gates

Run everything locally with:

```
bun run verify
```

which is, in order:

| Gate | Command | Catches |
| --- | --- | --- |
| Types | `bun run typecheck` | Type errors across all four configured projects |
| Lint | `bun run lint` | Unused bindings, broken React hooks, unsafe optional chaining, regex defects, real a11y errors |
| Format | `bun run format:check` | Formatting drift |
| Test locations | `bun run test:locations` | A test file or test-only asset outside `tests/` |
| Build | `bun run build` | Anything that compiles but does not bundle |
| Tests | `bun run test` | Unit and integration behaviour |
| Shutdown lifecycle | `bun run test:shutdown` | The shutdown spine, in its own process (it closes the DB singleton) |
| Startup rollback | `bun run test:startup-rollback` | Failed-boot rollback, in its own process |
| Lifecycle integration | `bun run test:lifecycle-integration` | Entry-point boot/shutdown wiring, in its own process |
| DOM contracts | `bun run test:dom` | Contracts that need a mounted React tree |
| OpenCode quarantine | `bun run test:quarantine` | A defect-regression entry left in the quarantine after its finding was fixed — i.e. a finding closed without its regression test being promoted |

Not part of `verify`, because it needs a browser and a spawned server:

| Gate | Command | Notes |
| --- | --- | --- |
| E2E | `bun run test:e2e` | see below |
| Security | `bun run security` | `verify:full` runs it after `verify` |

### The build runs before the tests, in CI and locally

`tests/integration/core/e2e-build-integrity.test.ts` asserts against the real
artifact in `dist/` — it proves the E2E server refuses a build whose provenance
stamp does not match the source. With no `dist/` present it fails **5 tests**,
and the messages ("REFUSES a missing artifact", "writes a stamp only after a
successful build") read as a broken build-stamp contract rather than as "you have
not built yet".

So `bun run test` has an **undeclared dependency on a prior `bun run build`**.
Both `bun run verify` and the CI `verify` job therefore run `bun run build`
**before** the suites.

This was a real CI gap, not a local-only ordering preference. The CI `verify` job
ran the suites with no `dist/` present, so those 5 tests were failing there too.
The last green run of that job predates the current version of those tests, which
at that time used temporary fake directories rather than the real artifact, so it
does **not** prove the current version is safe without a build. Adding the build
to a different job would not help: every GitHub-hosted job gets a fresh runner, so
one job's `dist/` does not exist in the next job's filesystem. The build has to
happen in the job that runs the suites.

If you ever move the build step, re-measure rather than assuming it is free:
delete `dist/`, run `bun run test`, and count the failures.
`tests/unit/tooling/verify-script.test.ts` reads the workflow's real steps and
compares them to `package.json`, sequence included, so removing or reordering the
step fails that suite.

### `verify` must use the scoped test script, not bare `bun test`

`verify` runs `bun run test`. It must never run bare `bun test`, and the reason
is not stylistic:

- `bun run test` scopes discovery to `./tests/unit ./tests/integration`, drops
  `shutdown-lifecycle.test.ts` (it has its own script), passes `--isolate` and
  sets `--timeout=30000`.
- Bare `bun test` collects **417** files instead of **319** (measured 2026-10-20).
  `bun run test` scopes to `./tests/unit ./tests/integration` and excludes the
  three lifecycle test files (`shutdown-lifecycle`, `startup-rollback`,
  `lifecycle-integration`), giving 319. Bare `bun test` collects all 322
  unit/integration files, plus the 50 DOM contract files, plus the 45 E2E
  Playwright specs in `tests/e2e`: 322 + 50 + 45 = 417.
  The DOM files need `--preload ./tests/setup/dom-preload.ts` and fail
  without it (measured: 18 fail, 8 errors). The E2E specs are named
  `*.spec.ts`, which bare `bun test` collects; they are the 45 on disk
  (39 non-live + 6 `*-live`).
  The totals move as tests are added; the argument rests on the named
  groups, not on a fixed difference.
- Without `--isolate` the shared test database cascades "Database has closed",
  reporting hundreds of phantom failures instead of real ones.

CI states this in `.github/workflows/tests.yml` next to the step it runs. A gate
that does not do what the repository says it does is worse than no gate, because
it is trusted: it was reachable from one command (`bun run verify`) and every
agent is told to run it.

The same is why `verify` runs `test:locations` and `test:dom`. Both are enforced
by the CI `verify` job; a local `verify` that omits them reports green for a
regression CI would have caught.

**If you change what `verify` runs, change this table in the same commit.** The
table is the executable description of the script, and the drift between the two
is the defect this section exists to prevent.

### CI

The `verify` job in `.github/workflows/tests.yml` runs, in order: typecheck, lint,
format check, the test-location policy, **build**, the unit/integration suite, the
three isolated lifecycle suites, and the DOM suite. That is the same sequence
`bun run verify` runs locally, and the two are kept in step deliberately: a local
gate that runs less than CI hides exactly the regressions CI exists to catch.

The three lifecycle suites (`test:shutdown`, `test:startup-rollback`,
`test:lifecycle-integration`) each close the process-wide database singleton, so
they cannot run inside `bun run test` — the suite script excludes them by path for
exactly that reason, and it is why each needs its own `bun test` process. `verify`
chains them as three scripts and the CI job runs them as three steps, so closing
the singleton in one cannot poison another, and a failure names the suite that
failed. Both sides are covered automatically; before this they were run by no gate
at all, so a change to the shutdown or rollback spine was covered only when
someone remembered to invoke them by hand.

The parity is enforced rather than asserted. `tests/unit/tooling/verify-script.test.ts`
parses the workflow's actual `run:` steps and compares the resulting gate sequence
— order included — against `package.json`. An earlier version of that test only
checked that a particular comment still existed in the workflow, which is exactly
the kind of check that passes while the thing it names has drifted.

The E2E job is separate and deliberately has no `needs:` on it, so an E2E failure
cannot be misread as a backend or typecheck failure. Because jobs do not share a
filesystem, that job builds for itself rather than relying on the `verify` job's
artifact. **The `e2e` job is scoped to seven specs**, listed explicitly in
`.github/workflows/tests.yml` (the file that owns the list):
`p2-history-load-recovery.spec.ts`, `p2-direct-history-window.spec.ts`,
`p2-paging.spec.ts`, `p2-live-runtime.spec.ts`, `p2-tool-result-persistence.spec.ts`,
`phase-8-tabs-navigation.spec.ts` and `opencode/opencode-v2-code-route.spec.ts`.
The first six are the conversation-history and tool-persistence specs, where a
silent stale-bundle run does the most damage. The Code-mode spec is the only
browser-level coverage of the OpenCode runtime: it drives the real managed
server and the real V2 runtime and asserts that a reload reaches READY from a
real hydration. It needs the pinned CLI, so the job installs it with the same
`./.github/actions/install-opencode` composite action `verify` uses; the version
and its integrity hash live once, in the workflow's `env`. The spec needs no
model credentials - a runner without them exercises the refusal surface instead
of the model.
The remaining specs on disk are pre-existing work in progress and are not gated
here; widening this list is a deliberate decision, not an oversight. The
scoped list is **not** the full E2E suite: 45 specs live on disk
(39 non-live + 6 `*-live`), and the `e2e` job runs only the seven above.

A fourth CI job, **`e2e-big-pickle`**, is dispatch-only: it runs only when
triggered via `workflow_dispatch` with the `live_opencode` boolean input set to
`true` (`gh workflow run tests.yml --ref <branch> -f live_opencode=true`).
It is **never a gate**: the answer comes from a real third-party model
(`opencode/big-pickle` on the OpenCode free tier), so a quota change or an
outage would turn a green code base red for a reason the code cannot fix.
What it proves: the managed `opencode serve` process starts, a real session is
bound to `opencode/big-pickle`, the composer sends the prompt, the SSE stream
delivers the answer, the rendered transcript shows it, and the same answer
survives a page reload from persisted history. Artifacts (Playwright
screenshots and the E2E server log) are uploaded to a `big-pickle-live`
artifact on every run. Rerun command:
`gh workflow run tests.yml --ref ci/tauri-e2e-verify -f live_opencode=true`.

`bun run lint` uses `--error-on-warnings`. **A warning is a failure.** A rule that
reports a genuine defect must not be able to pass CI by being downgraded to a
warning — that is the exact configuration that made this gate inert before it was
repaired (see `docs/decisions.md`).

## Tooling is pinned, not resolved at run time

`@biomejs/biome` is an **exact** devDependency (`2.5.15`) and the lockfile records
the platform packages with their integrity hashes. `bun install --frozen-lockfile`
reproduces it. The scripts call the local binary; there is no `bunx` download at
lint time, because a tool that resolves "whatever is newest" is a gate whose verdict
can change without a commit.

When you change the Biome version, change it in `package.json` AND update the
`$schema` in `biome.jsonc` so the config and the tool cannot drift apart.

## What the lint configuration does, and why

`biome.jsonc` uses Biome's **recommended** preset as the baseline. Every rule turned
off is named in that file with the reason it is wrong here. The test for adding one
is simple: *the rule produces false positives, or it fights a deliberate convention
in this repository.* "We do not like it" is not a reason, and a rule that could be
fixed should be fixed instead — the broken role usages in the OpenCode chips were
corrected by changing the role, not by silencing the rule.

### Suppressions

`biome-ignore` is allowed, and every use must state why. Three patterns recur and
all three are legitimate:

- **A dependency that is not read in the body on purpose.** `recoveryEpoch`,
  `refreshTrigger`, `clientEpoch`, `value`, `count`, `order`, `pathname`: these are
  re-trigger counters. The effect must re-run when they change even though it never
  reads them. Removing them as "unused" silently breaks the re-run.
- **An ordering dependency.** `virtualizer` in the logs layout effect is not read;
  it is there so the effect runs after `useVirtualizer` has attached the scroll
  element. Naming it is the correct fix for an ordering dependency.
- **A genuine false positive.** Biome cannot narrow a ternary `role`, and does not
  match a nested member expression (`a.b.c`) against itself.

**Use a range suppression when the formatter can move the line.** A line
suppression anchors to the expression on the next line, so if formatting re-wraps
that expression the suppression silently detaches and the rule starts reporting
again. Two a11y suppressions failed exactly that way. When in doubt, use
`biome-ignore-start` / `biome-ignore-end`.

The linter reports a suppression that has no effect. A suppression nobody needs is
noise that trains people to ignore the file, so `bun run lint` fails on it.

## Rules that are not negotiable

1. **No feature work until the gates pass.** A red gate is the work.
2. **Read before you write.** Investigate unfamiliar or concurrently-modified code
   before changing it. `git status` is part of reading.
3. **A reproducible defect or a clear requirement precedes a production change.**
4. **Tests cover meaningful behaviour**, including failure paths and how features
   interact.
5. **Fix the root cause.** No suppression, no retry, no weakened assertion standing
   in for a fix.
6. **Never delete a test to make a check pass.** Deleting is only correct with
   evidence that the test is obsolete, duplicated, invalid, or superseded — and the
   evidence goes in the commit message.
7. **Never weaken TypeScript or lint settings to get a green check.** No `any`, no
   `as unknown as`, no `@ts-ignore`, no `@ts-nocheck`, no relaxing `strict`, no
   excluding a file from a project, no downgrading a rule to `warn`.
8. **A gate must be able to fail.** A check whose reported result and exit code
   disagree is broken, not noisy, and is fixed before it is trusted.
9. **A test that passes intermittently hides a real race.** Find the race. Do not
   retune the timing.
10. **Review the whole diff** for unintended changes before submitting.
11. **Report exact commands and real numbers**, including skips and unresolved
    failures. "Should be fine" is not a result.
12. **Compilation is not completion.** A green build and a passing count are
    necessary, not sufficient.

## Source-text guards

Many tests assert on the **text** of a source file, because the contract is
structural and cannot be mounted under `bun test`. These are a legitimate pattern in
this repository (`tests/README.md` documents them), but they have one sharp edge:
they break when a formatter re-wraps the line they match.

**Assert the invariant, not the layout.** A pattern like `/}, \[field\]\);/` pins
both the dependency AND the wrapping; `/\}, \[field\]\);/` failing because the
formatter collapsed the call onto one line says nothing about the contract. Match
the tokens with `\s*` between them, and match on the *set* of dependencies rather
than a literal array.

When you change one of these guards, **prove it still fails** for the defect it
guards: make the defect, run the test, see it fail, revert. A guard that cannot fail
is worse than no guard, because it is trusted.

## The test-location policy

Every test file and test-only asset lives under `tests/`. `bun run test:locations` is
a **hard gate**, not a lint warning, and it runs in CI twice — once in the fast job
and once in the E2E job, which does not depend on the first.

It is a gate rather than a convention because every runner scopes discovery to
`tests/`: `bun run test` to `./tests/unit ./tests/integration`, `test:dom` to
`./tests/dom`, Playwright to `../tests/e2e`. A test written anywhere else is collected
by **none** of them. It does not fail; it silently never runs, and the suite stays
green while quietly losing coverage.

## Pre-existing failures

A failure is classified before it is fixed, and the classification is reported:

- **Regression** — introduced by this change. Fix it.
- **Pre-existing** — present before it. Root-cause it or report it as unresolved.
  Do not hide it by deleting or relaxing a test, and do not hide it by re-running
  until it passes.

Verify a suspected regression by running the single file in isolation before
believing or dismissing it.
