import { describe, it, expect } from "bun:test";
import path from "node:path";
import { REPO_ROOT } from "../../helpers/repo-root";

/**
 * `bun run verify` is the command `AGENTS.md` tells every agent and contributor
 * to run. It shipped calling bare `bun test` instead of the scoped `bun run
 * test` script, and omitting the test-location gate and the DOM suite.
 *
 * Bare `bun test` collects 375 files where `bun run test` collects 290 (measured
 * 2026-10-13): the difference of 85 is the 44 DOM contract files, which need
 * `--preload ./tests/setup/dom-preload.ts`
 * and fail without it, the `shutdown-lifecycle` test that `test`
 * deliberately excludes, and the 40 E2E Playwright specs under `tests/e2e`,
 * which bare `bun test` collects because they are named `*.spec.ts`. It also
 * drops `--isolate`, which is what stops the
 * shared test database cascading "Database has closed" into hundreds of phantom
 * failures.
 *
 * It also shipped running the suites BEFORE the build, while
 * `tests/integration/core/e2e-build-integrity.test.ts` asserts against the real
 * artifact in `dist/`. With no `dist/`, 5 of its tests fail with messages that
 * read as a broken build-stamp contract rather than "you have not built yet".
 *
 * Why the sequence is pinned rather than documented
 * ------------------------------------------------
 *
 * These assertions read the CI workflow's ACTUAL steps and compare them to
 * package.json, sequence included. An earlier version of this file asserted
 * only that a particular comment string still existed in the workflow, which is
 * exactly the kind of check that passes while the thing it names has drifted.
 * A comment is a claim about the steps; the steps are the thing.
 *
 * The CI workflow cannot be executed from here, so this test cannot prove CI is
 * green. What it proves is that the two definitions of "the checks" cannot
 * disagree without this failing.
 */

interface PackageJson {
  scripts: Record<string, string>;
}

const WORKFLOW = ".github/workflows/tests.yml";
const QUALITY_DOC = "docs/engineering-quality.md";
const PACKAGE_JSON = "package.json";

/** The steps both definitions of "the checks" must agree on, in this order. */
const EXPECTED_SEQUENCE = [
  "typecheck",
  "lint",
  "format:check",
  "test:locations",
  "build",
  "test",
  // The three isolated lifecycle suites: each closes the process-wide database
  // singleton, so each needs its own process — locally they are chained
  // scripts, on CI they are separate steps (see docs/engineering-quality.md).
  "test:shutdown",
  "test:startup-rollback",
  "test:lifecycle-integration",
  "test:dom",
  // The OpenCode defect-regression quarantine guard. It is a gate like any
  // other, because a stale quarantine entry means a finding was fixed without
  // its regression test being promoted - a silent loss of coverage, which is
  // the one thing this repository's guards exist to prevent.
  "test:quarantine",
] as const;

async function readRepoFile(relativePath: string): Promise<string> {
  return await Bun.file(path.join(REPO_ROOT, relativePath)).text();
}

async function readPackageJson(): Promise<PackageJson> {
  return (await Bun.file(path.join(REPO_ROOT, PACKAGE_JSON)).json()) as PackageJson;
}

/**
 * Normalise line endings before matching. A git checkout on Windows delivers
 * CRLF and on Linux LF; a parser keyed to "\n  verify:\n" would find the job on
 * one platform and report it missing on the other, which is a false failure
 * about the wrong thing.
 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * The text of the workflow's `verify` job only, up to the next job at the same
 * indent. Throws rather than returning "" so a renamed job fails loudly.
 */
export function verifyJobBlock(workflowText: string): string {
  const workflow = normalizeNewlines(workflowText);
  const start = workflow.indexOf("\n  verify:\n");
  if (start === -1) throw new Error(`${WORKFLOW} has no \`verify:\` job`);
  const rest = workflow.slice(start + 1);
  const nextJob = rest.slice(1).search(/\n {2}[A-Za-z_][\w-]*:\n/);
  return nextJob === -1 ? rest : rest.slice(0, nextJob + 1);
}

/**
 * Remove shell comments from a `run:` body, respecting quoted strings so a `#`
 * inside `Write-Output 'a # b'` is not mistaken for a comment.
 *
 * The workflow's shell is PowerShell, where `#` begins a comment outside quotes
 * and runs to end of line. This is deliberately NOT the same routine as the
 * TypeScript scanner in `no-orphan-modules.test.ts`: that one tracks `//`, `/*`
 * and template literals, this one tracks `#`.
 */
function stripShellComments(body: string): string {
  return body
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i] ?? "";
        if (quote !== null) {
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") {
          quote = ch;
          continue;
        }
        if (ch === "#") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/**
 * The gate a single step actually invokes, or null when it invokes no gate.
 *
 * A gate counts only when a line BEGINS with `bun run <script>`. Two failure
 * modes this rule closes:
 *
 *   - a commented-out command (`# bun run test ...`) would otherwise be read as
 *     the command running, so disabling the suite would look green;
 *   - prose that merely mentions one (`Write-Output 'we could bun run test:dom
 *     here'`) would otherwise be read as invoking it, so an innocuous comment
 *     would fail the gate for the wrong reason.
 *
 * `bun install` is deliberately not a gate: it does not start `bun run`.
 */
function gateFromRunBody(body: string): string | null {
  const stripped = stripShellComments(body);
  for (const line of stripped.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^\s*bun run ([a-z:][\w:-]*)/.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/**
 * The ordered gate names the CI `verify` job runs.
 *
 * Each `- name:` chunk contributes only the text that follows its own `run:`
 * key, so a comment outside a step that happens to mention `bun run test`
 * cannot be mistaken for a step that runs it. Both `run: <cmd>` and the
 * `run: |` block form are handled; a step with only `uses:` contributes
 * nothing.
 */
export function ciGateSequence(job: string): string[] {
  const gates: string[] = [];
  for (const chunk of job.split(/\n {6}- name: /).slice(1)) {
    // Block form (`run: |`). The newline that terminates the `run: |` line is
    // deliberately NOT consumed here - the body group supplies its own leading
    // newline, so eating it here would put the group one line too late.
    const blockBody = /\n {8}run:[ \t]*\|[ \t]*((?:\n {10}[^\n]*)+)/.exec(chunk);
    // Inline form (`run: bun run lint`). Tried only when the block form misses,
    // so a `run: |` line can never be read as the literal command "|".
    const singleLine = /\n {8}run: ([^\n]+)/.exec(chunk);
    const gate = gateFromRunBody(blockBody?.[1] ?? singleLine?.[1] ?? "");
    if (gate !== null) gates.push(gate);
  }
  return gates;
}

/** The ordered gate names `bun run verify` runs. */
export function localGateSequence(pkg: PackageJson): string[] {
  return (pkg.scripts.verify ?? "")
    .split("&&")
    .map((s) => s.trim())
    .map((s) => /\bbun run ([a-z:][\w:-]*)/.exec(s)?.[1])
    .filter((name): name is string => name !== undefined);
}

describe("verify and the CI verify job run the same gates in the same order", () => {
  it("reads a non-empty gate sequence out of CI", async () => {
    // Non-vacuity. A parser that silently matched nothing would make every
    // parity assertion below pass vacuously.
    const workflow = await readRepoFile(WORKFLOW);
    const gates = ciGateSequence(verifyJobBlock(workflow));
    expect(gates.length).toBeGreaterThanOrEqual(EXPECTED_SEQUENCE.length);
  });

  it("runs the expected gates, in the expected order, on CI", async () => {
    const workflow = await readRepoFile(WORKFLOW);
    expect(ciGateSequence(verifyJobBlock(workflow))).toEqual([...EXPECTED_SEQUENCE]);
  });

  it("runs the expected gates, in the expected order, locally", async () => {
    const pkg = await readPackageJson();
    expect(localGateSequence(pkg)).toEqual([...EXPECTED_SEQUENCE]);
  });

  it("has the two definitions agree with each other", async () => {
    // The assertion above states what each side must look like; this one states
    // the relationship directly, so a future edit to either side that breaks
    // parity is reported as a parity break rather than as two unrelated
    // failures.
    const workflow = await readRepoFile(WORKFLOW);
    const pkg = await readPackageJson();
    expect(ciGateSequence(verifyJobBlock(workflow))).toEqual(localGateSequence(pkg));
  });
});

/**
 * Regression tests for the two ways this guard used to be wrong. Both feed a
 * SYNTHETIC workflow through the REAL exported `verifyJobBlock`/`ciGateSequence`
 * above, so these exercise the implementation under review rather than a copy of
 * its regexes.
 *
 * `buildJob` builds a minimal workflow containing the full expected gate
 * sequence, so a fixture differs from the real thing in exactly one respect.
 */
function buildJob(stepOverrides: Record<string, string>): string {
  const steps: Record<string, string> = {
    Typecheck: "      - name: Typecheck\n        run: bun run typecheck\n",
    Lint: "      - name: Lint\n        run: bun run lint\n",
    "Format check": "      - name: Format check\n        run: bun run format:check\n",
    "Test location policy":
      "      - name: Test location policy\n        run: bun run test:locations\n",
    Build: "      - name: Build\n        run: bun run build\n",
    Test: "      - name: Test\n        run: |\n          bun run test 2>&1 | Tee-Object -FilePath test-output.log\n          $code = $LASTEXITCODE\n          if ($code -ne 0) { exit $code }\n",
    "Test (shutdown lifecycle)":
      "      - name: Test (shutdown lifecycle)\n        run: bun run test:shutdown\n",
    "Test (startup rollback)":
      "      - name: Test (startup rollback)\n        run: bun run test:startup-rollback\n",
    "Test (lifecycle integration)":
      "      - name: Test (lifecycle integration)\n        run: bun run test:lifecycle-integration\n",
    "Test (DOM contract)": "      - name: Test (DOM contract)\n        run: bun run test:dom\n",
    "OpenCode quarantine guard":
      "      - name: OpenCode quarantine guard\n        run: bun run test:quarantine\n",
    ...stepOverrides,
  };
  const body = Object.values(steps).join("\n");
  return `name: Verify\non: [push]\njobs:\n  verify:\n    runs-on: windows-latest\n    steps:\n${body}\n  e2e:\n    runs-on: windows-latest\n    steps:\n      - name: E2E\n        run: bun run test:e2e\n`;
}

function gatesFor(stepOverrides: Record<string, string>): string[] {
  return ciGateSequence(verifyJobBlock(buildJob(stepOverrides)));
}

describe("a command that does not actually run is not counted as a gate", () => {
  it("reads the expected sequence from an unmodified fixture (non-vacuity)", () => {
    expect(gatesFor({})).toEqual([...EXPECTED_SEQUENCE]);
  });

  it("D1: ignores a suite command commented out inside a run block", () => {
    // The whole point: disabling the suite this way would leave the step exiting
    // 0 having run nothing, and CI green with no tests run.
    const gates = gatesFor({
      Test: "      - name: Test\n        run: |\n          # bun run test 2>&1 | Tee-Object -FilePath test-output.log\n          $code = $LASTEXITCODE\n          if ($code -ne 0) { exit $code }\n",
    });
    expect(gates).not.toContain("test");
    expect(gates).not.toEqual([...EXPECTED_SEQUENCE]);
  });

  it("D1: ignores a gate commented out on the run line itself", () => {
    const gates = gatesFor({ Build: "      - name: Build\n        run: # bun run build\n" });
    expect(gates).not.toContain("build");
  });

  it("D1: still reports a gate commented out WHILE the real one still runs", () => {
    // The inverse of the above: a comment must not be able to fabricate a gate.
    const gates = gatesFor({
      Build:
        "      - name: Build\n        run: |\n          # bun run build\n          bun run lint\n",
    });
    // `lint` is the command that runs, not `build`.
    expect(gates).toContain("lint");
    expect(gates).not.toContain("build");
  });

  it("D2: prose naming a gate does not count as invoking it", () => {
    const gates = gatesFor({
      Test: "      - name: Test\n        run: |\n          Write-Output 'we could bun run test:dom here'\n          bun run test 2>&1 | Tee-Object -FilePath test-output.log\n",
    });
    expect(gates).toEqual([...EXPECTED_SEQUENCE]);
  });

  it("D2: a comment naming a gate inside a run block does not duplicate it", () => {
    const gates = gatesFor({
      Test: "      - name: Test\n        run: |\n          bun run test 2>&1 | Tee-Object -FilePath test-output.log\n          # consider adding bun run test:dom here one day\n",
    });
    expect(gates).toEqual([...EXPECTED_SEQUENCE]);
  });

  it("a `#` inside a quoted string is not treated as a comment", () => {
    const gates = gatesFor({
      Build:
        "      - name: Build\n        run: |\n          Write-Output 'tag #1'\n          bun run build\n",
    });
    // The real `bun run build` on the next line must still be found.
    expect(gates).toContain("build");
  });

  it("D1/D2: still detects a deleted, renamed, or reordered gate", () => {
    expect(gatesFor({ Test: "" })).not.toContain("test");
    expect(
      gatesFor({ Build: "      - name: Build\n        run: bun scripts/build-web.ts\n" }),
    ).not.toContain("build");

    // Move Build to sit AFTER Test rather than deleting it, so the ordering
    // assertion has both gates present to compare.
    const moved = buildJob({})
      .replace("      - name: Build\n        run: bun run build\n", "")
      .replace(
        "      - name: Test (DOM contract)",
        "      - name: Build\n        run: bun run build\n\n      - name: Test (DOM contract)",
      );
    const gates = ciGateSequence(verifyJobBlock(moved));
    expect(gates).toContain("build");
    expect(gates).toContain("test");
    expect(gates.indexOf("test")).toBeLessThan(gates.indexOf("build"));
    expect(gates).not.toEqual([...EXPECTED_SEQUENCE]);
  });
});

describe("verify runs the suites the way CI must", () => {
  it("uses the scoped test script, never bare `bun test`", async () => {
    const pkg = await readPackageJson();
    const steps = (pkg.scripts.verify ?? "").split("&&").map((s) => s.trim());
    // Matched as a whole command, so `bun run test:locations` cannot satisfy a
    // demand for `bun run test`, and `bun test` cannot satisfy `bun run test`.
    expect(steps).not.toContain("bun test");
    expect(steps).toContain("bun run test");
  });

  it("builds before the suites, because the suites assert on the artifact", async () => {
    const pkg = await readPackageJson();
    const steps = (pkg.scripts.verify ?? "").split("&&").map((s) => s.trim());
    expect(steps.indexOf("bun run build")).toBeLessThan(steps.indexOf("bun run test"));
  });

  it("runs the test-location gate before the suites", async () => {
    // Ordering matters: the policy check is cheap, and a misplaced test file
    // should fail before the multi-minute suites run.
    const pkg = await readPackageJson();
    const steps = (pkg.scripts.verify ?? "").split("&&").map((s) => s.trim());
    expect(steps.indexOf("bun run test:locations")).toBeLessThan(steps.indexOf("bun run test"));
  });

  it("states in CI why the build cannot come from another job", async () => {
    // The build was missing from CI because the build-integrity tests were
    // green against an older version that used fake directories. If this
    // explanation is deleted, the step looks arbitrary and gets "tidied away".
    const workflow = await readRepoFile(WORKFLOW);
    expect(workflow).toContain("FRESH runner");
  });

  it("still warns against bare `bun test` in the workflow", async () => {
    const workflow = await readRepoFile(WORKFLOW);
    expect(workflow).toContain("NOT bare `bun test`");
  });
});

describe("the quality-gate table describes the real script", () => {
  it("quotes each gate's own command in the row that describes it", async () => {
    // The table in docs/engineering-quality.md is the executable description of
    // `verify`. If it drifts from package.json, the next reader trusts the table.
    const doc = await readRepoFile(QUALITY_DOC);
    expect(doc).toContain("| Tests | `bun run test` |");
    expect(doc).toContain("| Test locations | `bun run test:locations` |");
    expect(doc).toContain("| DOM contracts | `bun run test:dom` |");
  });

  it("lists the build before the suites, as the script does", async () => {
    const doc = await readRepoFile(QUALITY_DOC);
    const buildRow = doc.indexOf("| Build | `bun run build` |");
    const testsRow = doc.indexOf("| Tests | `bun run test` |");
    expect(buildRow).toBeGreaterThan(-1);
    expect(buildRow).toBeLessThan(testsRow);
  });
});
