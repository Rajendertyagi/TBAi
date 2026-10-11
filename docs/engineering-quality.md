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
| Tests | `bun run test` | Unit and integration behaviour |
| Build | `bun run build` | Anything that compiles but does not bundle |

Two more, not part of `verify` because they need extra setup:

| Gate | Command | Notes |
| --- | --- | --- |
| DOM contracts | `bun run test:dom` | hermetic; no browser, network or live server |
| Test locations | `bun run test:locations` | hard gate; see below |
| E2E | `bun run test:e2e` | needs a browser and spawns a server |

### CI

`.github/workflows/tests.yml` runs typecheck, lint, format check, the test-location
policy, the unit/integration suite and the DOM suite in one fast job. The E2E job is
separate and deliberately has no `needs:` on it, so an E2E failure cannot be misread
as a backend or typecheck failure.

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
