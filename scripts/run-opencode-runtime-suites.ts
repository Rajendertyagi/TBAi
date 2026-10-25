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
 * It also fails when the directory contains a runtime suite that this file has
 * not classified, so adding a suite without deciding whether it is required is
 * a visible change rather than a silent coverage hole. (This register once said
 * "eight suites" while nine existed.)
 *
 * Every suite runs even after an earlier one fails, so one PR reports the whole
 * picture instead of the first failure.
 *
 * ## The excluded suites, and why
 *
 * `EXCLUDED_SUITES` is not a suppression list; each entry names what would have
 * to change to admit it. Both exclusions come from measurements of the pinned
 * 2.1.2 binary on windows-latest, not from an assumption about CI time.
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
    "3 of 8 cases fail against the pinned 2.1.2 binary on a clean windows-latest runner (RT-013); re-admit once its assertions match 2.1.2",
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

/**
 * Real-binary runtime suites the lists have not classified.
 *
 * `names` defaults to the on-disk tree; the guard test passes a synthetic list
 * so the refusal itself is exercised without installing a second suite file.
 */
export function unclassifiedSuites(names: readonly string[] = runtimeSuiteNames()): string[] {
  const classified = new Set<string>([...REQUIRED_SUITES, ...Object.keys(EXCLUDED_SUITES)]);
  return names.filter((name) => !classified.has(name));
}

function main(): number {
  const unclassified = unclassifiedSuites();
  if (unclassified.length > 0) {
    console.error(
      "Runtime suites exist that this gate has not classified as required or excluded:",
    );
    for (const name of unclassified) console.error(`  - ${name}`);
    console.error("Add each one to REQUIRED_SUITES or EXCLUDED_SUITES (with a reason).");
    return 1;
  }

  const version = spawnSync("opencode", ["--version"], { encoding: "utf8" });
  console.log(`OpenCode binary: ${(version.stdout ?? "").trim() || "(not on PATH)"}`);

  const outcomes = REQUIRED_SUITES.map((name) => {
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
// lists without executing the gate.
if (import.meta.main) {
  process.exitCode = main();
}
