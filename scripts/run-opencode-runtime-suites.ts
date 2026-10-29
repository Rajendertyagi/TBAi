/**
 * RT-007: the real-binary OpenCode runtime suites that must run on every PR.
 *
 * Run via `bun run test:opencode-runtime` (the `opencode-runtime` CI job).
 *
 * ## Why this is a script and not a loop in YAML
 *
 * The gate is not "the command exited 0". The runtime suites self-skip when
 * the OpenCode binary or the opt-in flag is absent, and a skipped suite exits
 * 0 while proving nothing. This script therefore requires, for every suite in
 * `REQUIRED_SUITES`:
 *
 * - the file exists,
 * - at least one test PASSED,
 * - no test FAILED, and
 * - no test was SKIPPED.
 *
 * It also refuses to run at all - BEFORE the binary is spawned or any suite
 * executes - when the registry itself is invalid:
 *
 * - a runtime suite on disk is neither required nor excluded,
 * - a required or excluded name is stale (no such suite on disk),
 * - a suite is classified as both required and excluded, or
 * - `REQUIRED_SUITES` is empty.
 *
 * That validation is one pure function (`validateRuntimeSuiteRegistry`) so the
 * unit test and the gate cannot disagree about what "valid" means. (This
 * register once said "eight suites" while nine existed.)
 *
 * Every suite runs even after an earlier one fails, so one PR reports the whole
 * picture instead of the first failure.
 *
 * ## The excluded suites, and why
 *
 * `EXCLUDED_SUITES` is not a suppression list; each entry names what would have
 * to change to admit it. One exclusion is a missing credential; the other is a
 * measurement of a real binary, updated when the 2.2.0 pin was measured locally.
 * Neither comes from an assumption about CI time.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root: this file lives at `<root>/scripts/`. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where the real-binary runtime suites live. Exported so the drift test reads the same tree. */
export const SUITE_DIR = path.join("tests", "integration", "opencode");

/** The opt-in switch the harness reads; set here so CI cannot forget it. */
const RUNTIME_ENV_FLAG = "TBAI_OPENCODE_RUNTIME_TESTS";

/**
 * Per-suite ceiling, in milliseconds.
 *
 * The slowest required suite measured 10.3 s on windows-latest; 120 s is
 * headroom for a loaded runner, not a timeout the suites are expected to
 * approach.
 */
const SUITE_TIMEOUT_MS = 120_000;

/** Suites that must pass on every PR, in run order. */
export const REQUIRED_SUITES = [
  "opencode-database-compat",
  "opencode-ownership-runtime",
  "opencode-retry-restart",
  "opencode-retry-runtime",
  "opencode-runtime-auth",
  "opencode-session-idempotency-runtime",
  "opencode-stub-provider-spike",
] as const;

/** Runtime suites that are deliberately not required, each with its reason. */
export const EXCLUDED_SUITES: Readonly<Record<string, string>> = {
  "opencode-context-meter-runtime":
    "needs a real provider credential, which the isolated runner deliberately does not have; live acceptance coverage stays dispatch-only",
  "opencode-native-compaction-conformance":
    "3 of 8 cases failed against 2.1.2 on a clean windows-latest runner (RT-013); all 8 passed against 2.2.0 locally on 2026-10-28, but that has no runner behind it yet, so re-admit after the 2.2.0 pin runs green on CI",
};

type SuiteOutcome = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly elapsedMs: number;
};

type Counts = { pass: number; fail: number; skip: number };

/** Parses bun's per-file summary lines (" 7 pass", " 0 fail", " 1 skip"). */
export function parseCounts(output: string): Counts {
  const counts: Counts = { pass: 0, fail: 0, skip: 0 };
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(pass|fail|skip(?:ped)?)\s*$/.exec(line);
    if (!match) continue;
    const kind = match[2];
    if (kind === "pass") counts.pass += Number(match[1]);
    else if (kind === "fail") counts.fail += Number(match[1]);
    else counts.skip += Number(match[1]);
  }
  return counts;
}

function runSuite(name: string): SuiteOutcome {
  const relative = path.join(SUITE_DIR, `${name}.test.ts`);
  const absolute = path.join(REPO_ROOT, relative);
  if (!existsSync(absolute)) {
    return { name, ok: false, detail: `missing suite file: ${relative}`, elapsedMs: 0 };
  }

  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    ["test", relative, "--timeout", String(SUITE_TIMEOUT_MS)],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, [RUNTIME_ENV_FLAG]: "1" },
    },
  );
  const elapsedMs = Date.now() - startedAt;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const counts = parseCounts(output);
  const summary = `${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip`;

  if (result.status !== 0) {
    return { name, ok: false, detail: `exit ${result.status} (${summary})`, elapsedMs };
  }
  if (counts.fail > 0) return { name, ok: false, detail: summary, elapsedMs };
  if (counts.skip > 0) {
    return {
      name,
      ok: false,
      detail: `${counts.skip} skipped; a skipped required suite proves nothing (${summary})`,
      elapsedMs,
    };
  }
  if (counts.pass === 0) {
    return { name, ok: false, detail: `no test executed (${summary})`, elapsedMs };
  }
  return { name, ok: true, detail: summary, elapsedMs };
}

/**
 * The symbols a suite must import to be a real-binary runtime suite.
 *
 * These are the harness's own opt-in gate, so a file that uses either one
 * self-skips without the binary - which is the failure mode this job exists to
 * catch. `opencode-harness-isolation.test.ts` imports the harness too and is
 * deliberately NOT one of them: it covers the harness helpers that need no
 * binary, and runs in `bun run test`.
 */
const RUNTIME_GATE_IMPORTS = ["runtimeUnavailableReason", "runtimeTestsRequested"] as const;

/** Whether a suite source gates itself on the real-binary harness. */
export function isRuntimeSuiteSource(source: string): boolean {
  return RUNTIME_GATE_IMPORTS.some((symbol) => source.includes(symbol));
}

/**
 * Every real-binary runtime suite on disk, by name, sorted.
 *
 * Exported so `tests/unit/tooling/opencode-runtime-gate.test.ts` asserts
 * against the same discovery this gate uses, rather than a copy of it that can
 * drift.
 */
export function runtimeSuiteNames(): string[] {
  const directory = path.join(REPO_ROOT, SUITE_DIR);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".test.ts"))
    .filter((entry) => isRuntimeSuiteSource(readFileSync(path.join(directory, entry), "utf8")))
    .map((entry) => entry.slice(0, -".test.ts".length))
    .sort();
}

/** One entry of the runtime-suite registry the gate is asked to run. */
export type RuntimeSuiteRegistry = {
  /** The real-binary suites discovered on disk. */
  readonly discovered: readonly string[];
  /** Suites that must run on every PR. */
  readonly required: readonly string[];
  /** Suites deliberately not required, each with its reason. */
  readonly excluded: Readonly<Record<string, string>>;
};

/**
 * A reason the registry must not be executed.
 *
 * `code` is the stable half: tests assert it, so the refusal they prove is the
 * one the gate performs even if the wording changes.
 */
export type RuntimeSuiteRegistryProblem = {
  readonly code: "unclassified" | "stale" | "overlap" | "empty-required";
  readonly message: string;
};

/**
 * Validates the runtime-suite registry against the suites on disk.
 *
 * Pure, and the SINGLE implementation the gate and its unit test both use: a
 * copy of these rules in the test could pass while the gate drifted.
 *
 * @param registry - The discovered suites and the two classification lists.
 * @returns Every defect found, in report order; empty means the gate may run.
 */
export function validateRuntimeSuiteRegistry(
  registry: RuntimeSuiteRegistry,
): RuntimeSuiteRegistryProblem[] {
  const problems: RuntimeSuiteRegistryProblem[] = [];
  const discovered = new Set(registry.discovered);
  const required = new Set(registry.required);
  const excluded = new Set(Object.keys(registry.excluded));

  if (registry.required.length === 0) {
    problems.push({
      code: "empty-required",
      message: "REQUIRED_SUITES is empty; a gate with nothing required proves nothing.",
    });
  }

  const unclassified = registry.discovered.filter(
    (name) => !required.has(name) && !excluded.has(name),
  );
  if (unclassified.length > 0) {
    problems.push({
      code: "unclassified",
      message: `runtime suites exist that are neither required nor excluded: ${unclassified.join(", ")}. Add each one to REQUIRED_SUITES or EXCLUDED_SUITES (with a reason).`,
    });
  }

  const stale = [...required, ...excluded].filter((name) => !discovered.has(name)).sort();
  if (stale.length > 0) {
    problems.push({
      code: "stale",
      message: `classified suites are not runtime suites on disk: ${stale.join(", ")}. Remove each stale name or restore the suite.`,
    });
  }

  const overlap = [...required].filter((name) => excluded.has(name));
  if (overlap.length > 0) {
    problems.push({
      code: "overlap",
      message: `suites are classified as BOTH required and excluded: ${overlap.join(", ")}. A suite is one or the other.`,
    });
  }

  return problems;
}

/** The registry as this repository defines it right now. */
function currentRuntimeSuiteRegistry(): RuntimeSuiteRegistry {
  return {
    discovered: runtimeSuiteNames(),
    required: REQUIRED_SUITES,
    excluded: EXCLUDED_SUITES,
  };
}

/**
 * Runs the gate, refusing an invalid registry BEFORE the binary or any suite.
 *
 * Takes the registry rather than reading the module constants so a test can
 * prove the refusal with synthetic lists.
 *
 * @param registry - The registry to validate and run.
 * @returns The process exit code.
 */
export function runGate(registry: RuntimeSuiteRegistry = currentRuntimeSuiteRegistry()): number {
  const problems = validateRuntimeSuiteRegistry(registry);
  if (problems.length > 0) {
    // Before spawning anything: an invalid registry is a defect in this file,
    // not a suite result, and running a partial list would report it as green.
    console.error("The runtime-suite registry is invalid; refusing to run any suite:");
    for (const problem of problems) console.error(`  - [${problem.code}] ${problem.message}`);
    return 1;
  }

  const version = spawnSync("opencode", ["--version"], { encoding: "utf8" });
  console.log(`OpenCode binary: ${(version.stdout ?? "").trim() || "(not on PATH)"}`);

  const outcomes = registry.required.map((name) => {
    const outcome = runSuite(name);
    const verdict = outcome.ok ? "PASS" : "FAIL";
    console.log(
      `${verdict} ${outcome.name} ${outcome.detail} (${(outcome.elapsedMs / 1000).toFixed(1)}s)`,
    );
    return outcome;
  });

  const failed = outcomes.filter((outcome) => !outcome.ok);
  console.log(
    `\n${outcomes.length - failed.length}/${outcomes.length} required runtime suites passed`,
  );
  return failed.length === 0 ? 0 : 1;
}

// Guarded so `tests/unit/tooling/opencode-runtime-gate.test.ts` can read the
// lists and the validator without executing the gate.
if (import.meta.main) {
  process.exitCode = runGate();
}
