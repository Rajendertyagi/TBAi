/**
 * E2E runner: one fresh server + database PER SPEC FILE.
 *
 * Why this exists: every spec used to share a single long-lived server and
 * database for the whole run. Specs that leave a conversation behind therefore
 * accumulate, and the sidebar fills with look-alike "New Conversation" rows
 * until a later spec can no longer find the conversation it just created.
 *
 * Measured, not assumed. `newchat-flow` passes ALONE, and passes with any single
 * other spec, but fails as soon as the first four run before it — the failure is
 * cumulative data, not a product bug. Bisected to exactly that.
 *
 * Restarting per file is the fix that needs no spec changes and drops no
 * coverage: each file gets an empty database, so ordering stops mattering. The
 * cost is one server start per file, which is a few seconds each.
 *
 * `*-live` specs need real credentials and are skipped unless TBAI_E2E_LIVE=1.
 *
 * This is the target of the repository's `bun run test:e2e`, so the Playwright
 * CLI has to keep working through it: `--project=` is owned here (it decides
 * which project each per-file run uses), and every other `--flag` is forwarded
 * verbatim to the inner Playwright invocation. Positional arguments are spec
 * file names. Nothing is silently dropped, because a swallowed flag would look
 * like the flag was honoured.
 *
 * ## JSON mode (`TBAI_E2E_JSON_DIR`) — the G5 evidence path
 *
 * A comparison between two revisions needs machine-readable per-test results,
 * not a parse of the `line` reporter's text. Setting `TBAI_E2E_JSON_DIR` switches
 * the runner into JSON mode, and that mode has ONE reporter mechanism:
 *
 *   - the runner passes `--config=playwright.json-reporter.config.ts`, a harness
 *     file that declares the reporter; it adds **no** `--reporter` flag itself;
 *   - a caller-supplied `--reporter*` in this mode is a hard error rather than a
 *     second, competing configuration;
 *   - every child writes to an ABSOLUTE path in `TBAI_E2E_JSON_FILE`, computed
 *     before the first spawn, unique case-insensitively;
 *   - a missing, empty or unparseable report fails that spec file. It is never
 *     read as "zero failures".
 *
 * The leg also records `inventory.json` — the spec list the runner itself
 * enumerated and executed — plus `reports/index.json`, the spec-to-report map.
 * Aggregation (`scripts/aggregate-e2e-reports.ts`) therefore compares against
 * what ran, not against a second, hand-maintained discovery.
 *
 * Usage:
 *   bun run test:e2e                                  # chromium, every spec
 *   bun run test:e2e --project=edge-headed
 *   bun run test:e2e phase-ua-d.spec.ts
 *   bun run test:e2e --grep="running dot"             # forwarded to Playwright
 *   TBAI_E2E_JSON_DIR=tests/.artifacts/e2e/run bun run test:e2e
 */
import { spawn, type Subprocess } from "bun";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWebAndStamp, runWebBuild } from "./build-web";
import { assessWebBuild, describeBuildFreshness } from "./web-build-provenance";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// E2E specs live in the canonical test tree, not under web/. One root for every
// test file in the repository - see the AGENTS.md test-location section.
const E2E_DIR = path.join(REPO_ROOT, "tests", "e2e");
const E2E_DATA_DIR = path.join(REPO_ROOT, "tests", ".artifacts", "e2e-data");
const WEB_ROOT = path.join(REPO_ROOT, "web");
const WEB_DIST = path.join(REPO_ROOT, "dist", "web");
const PLAYWRIGHT_CLI = path.join(WEB_ROOT, "node_modules", "@playwright", "test", "cli.js");
const E2E_PORT = process.env.TBAI_E2E_PORT ?? "3101";
const READY_URL = `http://localhost:${E2E_PORT}/readyz`;

/** Set to an absolute directory to collect per-spec JSON reports for this leg. */
const JSON_DIR_ENV = "TBAI_E2E_JSON_DIR";
/** The JSON reporter config the runner selects in JSON mode (relative to `web/`). */
const JSON_REPORTER_CONFIG = "playwright.json-reporter.config.ts";

export interface RunnerArgs {
  /** Playwright project name; the runner owns this flag. */
  project: string;
  /** Positional arguments, mapped to `<name>.spec.ts` when needed. */
  explicit: string[];
  /** Flags this runner does not own, forwarded to Playwright untouched. */
  forwarded: string[];
  /** Absolute JSON evidence directory, or null when JSON mode is off. */
  jsonDir: string | null;
}

/**
 * Split the CLI arguments, resolving JSON mode once.
 *
 * Pure so the argument contract can be tested without spawning anything: the
 * failure this guards against is a flag being swallowed, which would make a run
 * look like it honoured something it ignored.
 */
export function parseRunnerArgs(
  argv: readonly string[],
  options: { repoRoot?: string; jsonDirEnv?: string } = {},
): RunnerArgs {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const rawJsonDir = options.jsonDirEnv;
  const projectArg = argv.find((a) => a.startsWith("--project="));
  return {
    project: projectArg ? projectArg.slice("--project=".length) : "chromium-headless",
    explicit: argv.filter((a) => !a.startsWith("--")),
    forwarded: argv.filter((a) => a.startsWith("--") && !a.startsWith("--project=")),
    jsonDir:
      rawJsonDir && rawJsonDir.trim().length > 0 ? path.resolve(repoRoot, rawJsonDir.trim()) : null,
  };
}

/**
 * Why JSON mode cannot accept a caller-supplied reporter.
 *
 * Two reporter mechanisms would produce either competing output files or a run
 * with no report at all; both look like evidence and neither is. `null` means no
 * conflict.
 */
export function reporterConflict(
  forwarded: readonly string[],
  jsonDir: string | null,
): string | null {
  if (!jsonDir) return null;
  const supplied = forwarded.find((a) => a.startsWith("--reporter"));
  if (!supplied) return null;
  return (
    `${JSON_DIR_ENV} selects the JSON reporter config, but ${supplied} was also passed. ` +
    "JSON mode has exactly one reporter mechanism: drop the --reporter flag."
  );
}

/** Every `*.spec.ts` under the E2E root, recursively, as POSIX relative paths. */
export function collectSpecFiles(dir: string, rootDir = dir): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSpecFiles(full, rootDir));
    } else if (entry.name.endsWith(".spec.ts")) {
      found.push(path.relative(rootDir, full).split(path.sep).join("/"));
    }
  }
  return found;
}

/**
 * The spec files this leg will run, in a deterministic order.
 *
 * This MUST be recursive. Specs are bucketed into subdirectories (`history/`,
 * `core/`, `tools/`, ...), so a flat `readdirSync` returns directories, the
 * `.spec.ts` filter matches nothing, and the runner reports "0 spec file(s)" and
 * EXITS 0 - a green gate that ran no tests at all. That is the exact
 * silent-coverage-loss the AGENTS.md test-location rule exists to prevent,
 * reintroduced by the runner that was meant to serve it.
 *
 * Explicit positional arguments win over discovery. They are returned in the
 * POSIX form Playwright matches literally: Playwright treats positionals as
 * REGEXES against each file's path, and an absolute Windows path is full of
 * backslashes, which are regex escapes, so every pattern would fail to match.
 */
export function resolveSpecFiles(
  explicit: readonly string[],
  options: { e2eDir?: string; runLive?: boolean } = {},
): string[] {
  const e2eDir = options.e2eDir ?? E2E_DIR;
  if (explicit.length > 0) {
    return explicit.map((f) => (f.endsWith(".spec.ts") ? f : `${f}.spec.ts`));
  }
  const runLive = options.runLive ?? process.env.TBAI_E2E_LIVE === "1";
  return collectSpecFiles(e2eDir)
    .filter((f) => runLive || !f.endsWith("-live.spec.ts"))
    .sort();
}

/** Filesystem-safe, deterministic report file name for one spec. */
export function reportFileName(specFile: string): string {
  const safe = specFile.replace(/[^A-Za-z0-9._-]/g, "_");
  // The sanitised name alone can collide (`a/b.spec.ts` and `a_b.spec.ts`), so
  // the digest of the exact relative path is appended. The runner used
  // `file.replace(/[\\/]/g, "_")` for server logs, which is the collision class
  // this has to survive.
  const digest = createHash("sha256").update(specFile).digest("hex").slice(0, 12);
  return `${safe}-${digest}.json`;
}

export interface JsonReportPlan {
  /** One entry per spec file, in run order. */
  entries: { specFile: string; reportPath: string }[];
  /** Entries that name a file an earlier entry already named. */
  duplicateSpecs: string[];
}

/**
 * Specs that name the same file more than once. Case is folded on Windows, where
 * `A.spec.ts` and `a.spec.ts` are one file; elsewhere they are two.
 */
export function duplicateSpecs(specFiles: readonly string[]): string[] {
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const specFile of specFiles) {
    const key = fold(specFile);
    if (seen.has(key)) duplicates.add(specFile);
    else seen.add(key);
  }
  return [...duplicates].sort();
}

/**
 * Compute every report path before the first child spawns.
 *
 * The paths cannot collide on their own — `reportFileName` appends a digest of
 * the exact spec path — so the only way two children can target one report is to
 * be given one file twice. That is refused before any test runs, because it
 * would execute a spec an extra time and leave the inventory claiming a second
 * spec existed.
 */
export function planJsonReports(specFiles: readonly string[], jsonDir: string): JsonReportPlan {
  return {
    entries: specFiles.map((specFile) => ({
      specFile,
      reportPath: path.join(jsonDir, "reports", reportFileName(specFile)),
    })),
    duplicateSpecs: duplicateSpecs(specFiles),
  };
}

/** The leg's inventory: the spec list this runner enumerated and executed. */
export function buildInventory(
  specFiles: readonly string[],
  args: Pick<RunnerArgs, "project" | "explicit">,
  runLive: boolean,
) {
  return {
    project: args.project,
    live: runLive,
    explicitArgs: [...args.explicit],
    specFiles: [...specFiles],
    count: specFiles.length,
  };
}

/**
 * Read one child's JSON report.
 *
 * The three failures are distinct on purpose — missing, empty and unparseable
 * all mean "no evidence", and collapsing them would let a leg report success
 * from a file it never read.
 */
export function readReportFile(
  reportPath: string,
): { ok: true; report: unknown } | { ok: false; problem: string } {
  let text: string;
  try {
    text = fs.readFileSync(reportPath, "utf8");
  } catch {
    return { ok: false, problem: "report-missing" };
  }
  if (text.trim().length === 0) return { ok: false, problem: "report-empty" };
  try {
    return { ok: true, report: JSON.parse(text) };
  } catch {
    return { ok: false, problem: "report-unparseable" };
  }
}

async function waitForServer(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(READY_URL)).ok) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://localhost:${port}/readyz`, {
        signal: AbortSignal.timeout(500),
      });
      if (!res.ok) return;
    } catch {
      return; // connection refused: port is free
    }
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Build the bundle the suite is about to serve, or refuse to run at all.
 *
 * The suite serves `dist/web`, a build output. Leaving that to the operator made
 * a source edit followed by `bun run test:e2e` exercise the PREVIOUS bundle and
 * report a confident, wrong result — a test suite that does not fail but lies.
 * So the build is enforced HERE, once, before any server is spawned:
 *
 *   - a failed build exits non-zero immediately, before the first spawn, so a
 *     stale artifact cannot be reached even by accident;
 *   - it runs ONCE for the whole run rather than per spec file. The artifact is
 *     read-only to the suite, so repeating it would only add minutes; the
 *     server re-verifies provenance per file regardless.
 *
 * `TBAI_E2E_SKIP_BUILD=1` skips the rebuild for someone iterating on spec code
 * with a freshly built bundle already in place. It is an opt-in, never a default,
 * and it cannot reintroduce the hazard on its own: `start-e2e-server.ts`
 * independently refuses any artifact whose stamp does not match the source.
 * The two gates are deliberately redundant — the rebuild is the convenience, the
 * stamp check is the guarantee.
 */
function ensureFreshWebBuild(): boolean {
  if (process.env.TBAI_E2E_SKIP_BUILD === "1") {
    const freshness = assessWebBuild(WEB_ROOT, WEB_DIST);
    console.log(`[e2e] TBAI_E2E_SKIP_BUILD=1 — ${describeBuildFreshness(freshness)}`);
    // Still fatal when stale. Skipping the rebuild is a legitimate shortcut;
    // serving an artifact that does not match the source is not.
    return freshness.status === "current";
  }

  console.log("[e2e] building the web bundle the suite will serve…");
  if (!buildWebAndStamp(runWebBuild, (message) => console.log(`[e2e] ${message}`))) {
    console.error(
      "[e2e] build FAILED — refusing to run E2E against a stale or unstamped bundle. " +
        "Fix the build and re-run.",
    );
    return false;
  }

  const freshness = assessWebBuild(WEB_ROOT, WEB_DIST);
  console.log(`[e2e] ${describeBuildFreshness(freshness)}`);
  return freshness.status === "current";
}

async function main(): Promise<number> {
  const args = parseRunnerArgs(process.argv.slice(2), {
    jsonDirEnv: process.env[JSON_DIR_ENV],
  });
  const conflict = reporterConflict(args.forwarded, args.jsonDir);
  if (conflict) {
    console.error(`[e2e] reporter-conflict — ${conflict}`);
    return 1;
  }

  const runLive = process.env.TBAI_E2E_LIVE === "1";
  const files = resolveSpecFiles(args.explicit, { runLive });

  // Compute every JSON path BEFORE the first spawn, so a duplicate is a startup
  // failure rather than one spec running twice and reporting under two names.
  let plan: JsonReportPlan | null = null;
  if (args.jsonDir) {
    plan = planJsonReports(files, args.jsonDir);
    if (plan.duplicateSpecs.length > 0) {
      console.error(
        `[e2e] duplicate-spec — this spec list names the same file more than once: ` +
          `${plan.duplicateSpecs.join(", ")}`,
      );
      return 1;
    }
    fs.mkdirSync(path.join(args.jsonDir, "reports"), { recursive: true });
    fs.writeFileSync(
      path.join(args.jsonDir, "inventory.json"),
      `${JSON.stringify(buildInventory(files, args, runLive), null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(args.jsonDir, "reports", "index.json"),
      `${JSON.stringify({ entries: plan.entries }, null, 2)}\n`,
      "utf8",
    );
  }

  if (!ensureFreshWebBuild()) return 1;

  console.log(
    `[e2e] ${files.length} spec file(s), project=${args.project}, live=${runLive}` +
      (args.jsonDir ? `, json=${args.jsonDir}` : ""),
  );

  let passed = 0;
  let failed = 0;
  const failedFiles: string[] = [];

  for (const [index, file] of files.entries()) {
    await waitForPortFree(Number(E2E_PORT), 20_000);
    // The launcher wipes its own data dir, so each file starts from empty.
    const server: Subprocess = spawn(
      [process.execPath, path.join(REPO_ROOT, "scripts", "start-e2e-server.ts")],
      { cwd: REPO_ROOT, stdout: "ignore", stderr: "ignore" },
    );

    if (!(await waitForServer(60_000))) {
      console.log(`[e2e] ${file}: server never became ready — counted as failed`);
      failed += 1;
      failedFiles.push(file);
      server.kill();
      continue;
    }

    const reportEntry = plan?.entries[index];
    // In JSON mode the harness config owns the reporter, so no `--reporter`
    // flag is added here; the default `line` reporter stays in the config.
    const reporterDefault =
      plan || args.forwarded.some((a) => a.startsWith("--reporter")) ? [] : ["--reporter=line"];
    const configArgs = plan ? [`--config=${JSON_REPORTER_CONFIG}`] : [];

    const run = spawn(
      [
        process.execPath,
        PLAYWRIGHT_CLI,
        "test",
        file,
        `--project=${args.project}`,
        ...configArgs,
        ...reporterDefault,
        ...args.forwarded,
      ],
      {
        cwd: WEB_ROOT,
        stdout: "inherit",
        stderr: "inherit",
        // The runner owns the server lifecycle; the config must not start a second.
        env: {
          ...process.env,
          TBAI_E2E_EXTERNAL_SERVER: "1",
          ...(reportEntry ? { TBAI_E2E_JSON_FILE: reportEntry.reportPath } : {}),
        },
      },
    );
    // Bun's Subprocess resolves `exited` to the exit code; there is no Node-style
    // 'exit' event on it.
    const code = await run.exited;

    // Preserve the spawned server's log (including the frontend's redacted
    // client-plane events that land in tbai.log) so a failed run can be
    // diagnosed after the data dir is wiped for the next spec. Never contains
    // secrets: the backend logger redacts them, and only the log file is copied.
    const serverLog = path.join(E2E_DATA_DIR, "tbai.log");
    const logDir = path.join(REPO_ROOT, "tests", ".artifacts", "e2e-server-logs");
    if (fs.existsSync(serverLog)) {
      fs.mkdirSync(logDir, { recursive: true });
      const safeName = file.replace(/[\\/]/g, "_");
      fs.copyFileSync(serverLog, path.join(logDir, safeName));
      if (code !== 0) {
        const tail = fs.readFileSync(serverLog, "utf8").split(/\r?\n/).slice(-50).join("\n");
        console.log(`[e2e] --- tail of ${file} server log ---`);
        console.log(tail);
        console.log(`[e2e] --- end tail ---`);
      }
    }

    server.kill();
    await waitForPortFree(Number(E2E_PORT), 20_000);

    // A child that exits 0 but wrote no report produced no evidence. Both are
    // failures, and the report problem is named so it cannot be mistaken for a
    // test failure.
    let reportProblem: string | null = null;
    if (reportEntry) {
      const read = readReportFile(reportEntry.reportPath);
      // `"problem" in read`, not `!read.ok`: this script is also compiled by
      // tests/tsconfig.backend.json, which turns `strictNullChecks` off, and a
      // boolean-literal discriminant does not narrow in that mode.
      if ("problem" in read) {
        reportProblem = read.problem;
        console.error(`[e2e] ${file}: ${reportProblem} (${reportEntry.reportPath})`);
      }
    }

    if (code === 0 && reportProblem === null) {
      passed += 1;
      console.log(`[e2e] ${file}: ok`);
    } else {
      failed += 1;
      failedFiles.push(file);
      console.log(`[e2e] ${file}: FAILED`);
    }
  }

  console.log(`\n[e2e] spec files ok: ${passed}, failed: ${failed}`);
  if (failedFiles.length) console.log(`[e2e] failing files:\n  - ${failedFiles.join("\n  - ")}`);

  // Fail closed on a run that collected nothing. `failed === 0` is not evidence of
  // a healthy suite when no spec was ever executed - a bad `testDir`, a filter that
  // matched nothing, or specs that stopped being discovered all produce exactly
  // this state, and `failed === 0 ? 0 : 1` reported all of them as a green gate.
  // The E2E job depends on this exit code, so a zero-spec run must be red.
  if (passed === 0 && failed === 0) {
    console.error(
      "[e2e] no spec files were executed. This is not a passing run: discovery " +
        "matched nothing, so the suite reported success while testing nothing. " +
        "Check playwright.config.ts testDir against tests/e2e and the spec paths " +
        "passed as arguments.",
    );
    return 1;
  }
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main());
}
