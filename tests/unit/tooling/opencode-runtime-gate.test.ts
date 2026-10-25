/**
 * RT-007: the real-binary runtime-suite gate is itself guarded.
 *
 * `scripts/run-opencode-runtime-suites.ts` is the thing that decides which
 * OpenCode suites must pass on every PR, so a wrong answer there is a coverage
 * hole reported as green. Three ways that happens, each with a test below:
 *
 * 1. **A suite exists that the gate never heard of.** The register in
 *    `docs/opencode-runtime-audit-final.md` once said "eight suites" while nine
 *    existed on disk. The gate refuses to run when a real-binary suite is
 *    neither required nor excluded; this test fails at `bun run test` if that
 *    refusal is ever relaxed.
 * 2. **The CI job stops running the gate.** A step commented out, renamed, or
 *    pointed at a different command leaves the job exiting 0 having checked
 *    nothing — the exact defect `verify-script.test.ts` was written for, on the
 *    other job.
 * 3. **The counts are parsed wrong.** `pass`/`fail`/`skip` come from bun's own
 *    summary tail. A parser that reads nothing would make "0 pass" look like a
 *    green suite, and this gate treats a zero-pass required suite as a failure.
 *
 * Why this test imports the script instead of copying its lists
 * ------------------------------------------------------------
 *
 * The assertions below use the script's exported `REQUIRED_SUITES`,
 * `EXCLUDED_SUITES` and `runtimeSuiteNames()`. A copy of the lists here would
 * pass while the gate's own lists drifted, which is the failure mode the test
 * exists to catch. What the test ADDS is the relationship between the lists and
 * the tree — a relationship the gate checks at run time, which only happens on
 * a runner that has the binary installed. `bun run test` has no binary, so this
 * is the only place the classification is checked cheaply and on every commit.
 *
 * The workflow parser here is deliberately narrow and local. `ciGateSequence()`
 * lives inside `verify-script.test.ts`; test files are not this repository's
 * module tree for shared code, and this job needs three facts about one block,
 * not a full step-sequence parse. If a third job-gate test appears, the parser
 * moves to `tests/helpers/`.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  EXCLUDED_SUITES,
  REQUIRED_SUITES,
  SUITE_DIR,
  isRuntimeSuiteSource,
  parseCounts,
  runtimeSuiteNames,
  unclassifiedSuites,
} from "../../../scripts/run-opencode-runtime-suites";
import { REPO_ROOT } from "../../helpers/repo-root";

const WORKFLOW = ".github/workflows/tests.yml";
const GATE_SCRIPT = "scripts/run-opencode-runtime-suites.ts";
const GATE_NPM_SCRIPT = "test:opencode-runtime";

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * The text of one job in the workflow, from its own header to the next job at
 * the same indent. Throws when the job is absent, so a renamed job fails loudly
 * instead of producing an empty block that every assertion below matches.
 */
function jobBlock(workflowText: string, jobName: string): string {
  const workflow = normalizeNewlines(workflowText);
  const start = workflow.indexOf(`\n  ${jobName}:\n`);
  if (start === -1) throw new Error(`${WORKFLOW} has no \`${jobName}:\` job`);
  const rest = workflow.slice(start + 1);
  const nextJob = rest.slice(1).search(/\n {2}[A-Za-z_][\w-]*:\n/);
  return nextJob === -1 ? rest : rest.slice(0, nextJob + 1);
}

/**
 * Lines of a job block that are not comments, so a step disabled with `#`
 * cannot be counted as running.
 */
function activeLines(job: string): string[] {
  return normalizeNewlines(job)
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
}

const runtimeSuites = runtimeSuiteNames();
const required = new Set<string>(REQUIRED_SUITES);
const excluded = new Set(Object.keys(EXCLUDED_SUITES));

describe("every real-binary runtime suite is classified", () => {
  it("finds the suites on disk (non-vacuity)", () => {
    // Without this, a discovery function that returned [] would make every
    // assertion below pass while checking nothing.
    expect(runtimeSuites.length).toBeGreaterThanOrEqual(9);
    for (const name of runtimeSuites) {
      expect(existsSync(path.join(REPO_ROOT, SUITE_DIR, `${name}.test.ts`))).toBe(true);
    }
  });

  it("has required ∪ excluded cover the whole tree", () => {
    expect(unclassifiedSuites(runtimeSuites)).toEqual([]);
  });

  it("names no suite that is not on disk", () => {
    // The mirror of the above: a stale entry in either list reads as coverage
    // for a file that was deleted or renamed.
    const onDisk = new Set(runtimeSuites);
    const stale = [...REQUIRED_SUITES, ...Object.keys(EXCLUDED_SUITES)].filter(
      (name) => !onDisk.has(name),
    );
    expect(stale).toEqual([]);
  });

  it("never classifies one suite as both required and excluded", () => {
    const both = [...required].filter((name) => excluded.has(name));
    expect(both).toEqual([]);
  });

  it("gives every exclusion a reason that names a condition", () => {
    for (const reason of Object.values(EXCLUDED_SUITES)) {
      expect(reason.length).toBeGreaterThanOrEqual(40);
      // A reason is only useful if it says what would have to change to admit
      // the suite. Both current entries do ("needs a real provider credential",
      // "re-admit once its assertions match 2.1.2"); an entry that decays to
      // "flaky" is a suppression, not a classification. The vocabulary below is
      // a floor that catches that decay, not a proof that a reason is sound —
      // the soundness itself is the measurement cited in the reason.
      expect(reason).toMatch(/\b(needs|because|until|once|re-admit|fail[a-z]*)\b/i);
    }
  });
});

describe("the runtime-suite predicate matches the harness gate, not the file name", () => {
  it("recognises a suite that self-skips without the binary", () => {
    expect(isRuntimeSuiteSource(`import { runtimeUnavailableReason } from "./harness";`)).toBe(
      true,
    );
    expect(isRuntimeSuiteSource(`const wanted = runtimeTestsRequested();`)).toBe(true);
  });

  it("does not treat every harness consumer as a runtime suite", () => {
    // `opencode-harness-isolation.test.ts` imports the harness helpers but needs
    // no binary, so it belongs to `bun run test`. Crediting it to this gate
    // would mean the nine-suite register is wrong again.
    const isolation = path.join(REPO_ROOT, SUITE_DIR, "opencode-harness-isolation.test.ts");
    expect(existsSync(isolation)).toBe(true);
    expect(isRuntimeSuiteSource(readFileSync(isolation, "utf8"))).toBe(false);
  });

  it("refuses a suite the lists never mention", () => {
    // The gate's own refusal, driven with a synthetic name: an unknown runtime
    // suite must be reported, not run and not skipped.
    expect(unclassifiedSuites([...runtimeSuites, "opencode-brand-new"])).toEqual([
      "opencode-brand-new",
    ]);
    expect(unclassifiedSuites()).toEqual([]);
  });
});

describe("parseCounts reads bun's real summary tail", () => {
  it("reads a clean suite from the exact text bun prints", () => {
    // Verbatim tail from `bun test <suite>` on windows, 2026-10-24.
    const output = [
      "(pass) real OpenCode: caller-supplied session ids are idempotent > honours the supplied id [4.64ms]",
      "",
      " 5 pass",
      " 0 fail",
      " 29 expect() calls",
      "Ran 5 tests across 1 file. [694.00ms]",
      "",
    ].join("\n");
    expect(parseCounts(output)).toEqual({ pass: 5, fail: 0, skip: 0 });
  });

  it("counts a skipped case, which is what makes a self-skipped suite fail the gate", () => {
    const output = [" 0 pass", " 0 fail", " 1 skip"].join("\n");
    expect(parseCounts(output)).toEqual({ pass: 0, fail: 0, skip: 1 });
  });

  it("accepts both spellings of the skip label", () => {
    expect(parseCounts(" 3 skipped").skip).toBe(3);
  });

  it("ignores totals that are not a count label", () => {
    // "29 expect() calls" and "Ran 5 tests across 1 file" must not be read as
    // counts; matching them would invent passes and hide absences.
    expect(parseCounts(" 29 expect() calls\nRan 5 tests across 1 file. [694.00ms]")).toEqual({
      pass: 0,
      fail: 0,
      skip: 0,
    });
  });

  it("returns zeros for empty output instead of treating it as success", () => {
    expect(parseCounts("")).toEqual({ pass: 0, fail: 0, skip: 0 });
  });
});

describe("the gate is reachable from the command the CI job runs", () => {
  it("package.json maps the script onto the gate", async () => {
    const pkg = (await Bun.file(path.join(REPO_ROOT, "package.json")).json()) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts[GATE_NPM_SCRIPT]).toContain(GATE_SCRIPT);
  });

  it("the gate itself is inside the test-location policy's script directory", () => {
    expect(existsSync(path.join(REPO_ROOT, GATE_SCRIPT))).toBe(true);
  });
});

describe("the opencode-runtime CI job actually runs the gate", () => {
  const workflow = () => Bun.file(path.join(REPO_ROOT, WORKFLOW)).text();

  it("has a job that runs `bun run test:opencode-runtime` uncommented", async () => {
    const job = jobBlock(await workflow(), "opencode-runtime");
    expect(activeLines(job)).toContain(`        run: bun run ${GATE_NPM_SCRIPT}`);
  });

  it("installs the pinned OpenCode binary before running it", async () => {
    // The suites self-skip when the binary is missing and still exit 0, so a
    // job without the install step reports success having proven nothing.
    // The `${{ env.* }}` inputs are matched as regexes: in a plain string
    // literal that sequence is a template placeholder, which Biome rightly
    // reports as a bug.
    const job = jobBlock(await workflow(), "opencode-runtime");
    expect(job).toContain("./.github/actions/install-opencode");
    expect(job).toMatch(/\bversion:\s*\$\{\{\s*env\.OPENCODE_VERSION\s*\}\}/);
    expect(job).toMatch(/\bsha512:\s*\$\{\{\s*env\.OPENCODE_CLI_SHA512\s*\}\}/);
  });

  it("stays independent of the other jobs", async () => {
    // Deliberate: a runtime-suite failure must not read as a typecheck or E2E
    // failure, and it must not delay them either.
    const job = jobBlock(await workflow(), "opencode-runtime");
    expect(normalizeNewlines(job)).not.toMatch(/\n {4}needs:/);
  });

  it("names the binary version it measured in the workflow env", async () => {
    const text = normalizeNewlines(await workflow());
    expect(text).toMatch(/OPENCODE_VERSION:\s*"2\.1\.2"/);
  });

  it("is listed in the header comment that enumerates the jobs", async () => {
    const text = normalizeNewlines(await workflow());
    const header = text.slice(0, text.indexOf("\njobs:"));
    expect(header).toContain("opencode-runtime");
  });
});
