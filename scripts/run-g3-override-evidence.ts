/**
 * G3: evidence that the override notice is rendered from the REAL managed
 * OpenCode configuration, not from a mocked response or a fixture the page
 * never reads.
 *
 * ## What this proves that the existing live spec cannot
 *
 * `opencode-config-live.spec.ts` runs against the maintainer's own OpenCode
 * configuration, so it can only observe whatever rules happen to be in that
 * file. The override notice ("Never applies" / "Partly overridden") needs a
 * known rule ORDER to exist at all, and the maintainer's policy is neither
 * guaranteed to contain one nor safe to rewrite for a test.
 *
 * So each case here owns a fixture, a temp root, an app process and a managed
 * `opencode serve` child. The fixture is supplied through `OPENCODE_CONFIG`,
 * which the app passes to the child through `process.env`; `GET /api/config`
 * then reports that exact path, and the spec asserts both the reported path and
 * the rendered notice. Nothing about the maintainer's configuration, database
 * or credentials is read or written.
 *
 * ## Two independent runs, never one shared fixture
 *
 * The two cases need DIFFERENT file contents, and "write case B's file, then
 * case A's expectations" would make the second case's meaning depend on nothing
 * it can observe. Each case therefore gets its own fixture/server pair, and each
 * writes its own evidence file.
 *
 * ## The approved cleanup order, because a hash can otherwise prove nothing
 *
 *   1. wait for the Playwright child to exit;
 *   2. stop the TBAi process tree and CONFIRM every recorded pid is gone;
 *   3. capture `observedHash`, restore the original bytes, capture `restoredHash`;
 *   4. preserve the app log outside the temp root, remove the root, and write
 *      evidence LAST.
 *
 * The server is stopped before the fixture is hashed because a live server can
 * still touch the file. `observedHash === originalHash` is the claim that the
 * bytes matched at the moment of observation; `restoredHash === originalHash` is
 * a separate claim that restoration reproduced them. Neither is used to prove
 * the other. Every cleanup step records its own failure, so a cleanup error can
 * never replace the Playwright failure that the run is actually about.
 *
 * ## What this is not
 *
 * There is no filesystem sandbox. The app and its child run with the invoking
 * user's privileges, exactly as they do in production. Isolation comes from
 * `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, per-run `DATA_DIR`/`WORKSPACE_DIR`
 * and the XDG roots, and the evidence records every one of those paths so the
 * isolation is inspectable rather than asserted.
 *
 * `OPENCODE_CONFIG_DIR` is part of that set because it is NOT derived from
 * `XDG_CONFIG_HOME` inside `opencode serve`: a host shell that is itself hosted
 * by OpenCode exports it, and it then wins over the XDG roots, which made the
 * managed server read the host's global document ahead of the fixture (measured
 * 2026-10-26; see `g3AppEnvironment`).
 *
 * Usage:
 *   bun run test:opencode-g3
 *   bun run test:opencode-g3 --project=edge-headless --out=<dir>
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureFreshWebBuild } from "./lib/web-build";
import {
  allocateFreePort,
  errorMessage,
  sleep,
  stopProcessTree,
  type ProcessStopResult,
} from "./lib/process";
import { readBuildStamp, type BuildStamp } from "./web-build-provenance";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_ENTRY = path.join(REPO_ROOT, "src", "index.ts");
const WEB_ROOT = path.join(REPO_ROOT, "web");
const WEB_DIST = path.join(REPO_ROOT, "dist", "web");
const PLAYWRIGHT_CLI = path.join(REPO_ROOT, "web", "node_modules", "@playwright", "test", "cli.js");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "tests", ".artifacts", "g3");
const SPEC_FILE = "opencode/opencode-config-override-live.spec.ts";
const DEFAULT_PROJECT = "chromium-headless";
const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 200;
const PLAYWRIGHT_TIMEOUT_MS = 300_000;
const CONFIG_SNAPSHOT_TIMEOUT_MS = 60_000;
/** A `--version` probe, and any other short shell query, must not hang a run. */
const PROBE_TIMEOUT_MS = 30_000;

export type G3CaseName = "full" | "partial";
export type G3Effect = "allow" | "ask" | "deny";

export interface G3Rule {
  readonly action: string;
  readonly resource: string;
  readonly effect: G3Effect;
}

export interface G3CaseDefinition {
  readonly rules: readonly G3Rule[];
  readonly expectedKind: "full" | "partial";
  readonly expectedNotice: string;
  readonly expectedTitle: string;
}

/**
 * The two rule orders, and the notice each must produce.
 *
 * The copies are asserted against `web/src/features/opencode/configCopy.ts` by
 * `tests/unit/tooling/g3-override-evidence.test.ts`, so this table cannot drift
 * from the product copy on its own.
 */
export const G3_CASES: Record<G3CaseName, G3CaseDefinition> = {
  full: {
    rules: [
      { action: "shell", resource: "git status", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
    ],
    expectedKind: "full",
    expectedNotice: "Never applies — row 2 wins for every request.",
    expectedTitle:
      "OpenCode resolves the last matching rule, and row 2 matches everything this rule matches, so this rule is never the one that decides.",
  },
  partial: {
    rules: [
      { action: "shell", resource: "*", effect: "allow" },
      { action: "shell", resource: "git status *", effect: "deny" },
    ],
    expectedKind: "partial",
    expectedNotice: "Partly overridden — row 2 wins for the resources it matches.",
    expectedTitle:
      "OpenCode resolves the last matching rule, and row 2 is narrower, so it wins for the resources it matches and this rule still applies to the rest.",
  },
};

export const G3_CASE_NAMES: readonly G3CaseName[] = ["full", "partial"];

/** The fixture document for one case, in the shape OpenCode's V2 config reads. */
export function fixtureDocument(caseName: G3CaseName): {
  $schema: string;
  permissions: readonly G3Rule[];
} {
  return { $schema: OPENCODE_SCHEMA_URL, permissions: G3_CASES[caseName].rules };
}

/** The fixture's file text: two-space indent and one trailing newline. */
export function serializeFixture(caseName: G3CaseName): string {
  return `${JSON.stringify(fixtureDocument(caseName), null, 2)}\n`;
}

export function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** SHA-256 of a file's bytes. Throws when the file cannot be read. */
export function hashFile(filePath: string): string {
  return hashBytes(fs.readFileSync(filePath));
}

/**
 * Writes `bytes` over `filePath` and flushes them to disk before returning, so a
 * hash taken immediately afterwards observes the restored bytes, not a cached
 * copy.
 */
export function restoreFileBytes(filePath: string, bytes: Buffer): void {
  const fd = fs.openSync(filePath, "w");
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Whether two reported paths name the same file.
 *
 * The server reports Windows paths with backslashes, and the orchestrator may
 * have built the fixture path through a different spelling. Comparison is
 * therefore resolved (not string-equal) and case-insensitive on Windows only,
 * where the filesystem is.
 */
export function pathsReferToSameFile(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export interface G3EvidenceHashes {
  readonly original: string | null;
  readonly observed: string | null;
  readonly restored: string | null;
}

export interface G3AssessmentInput {
  readonly runId: string;
  readonly caseName: G3CaseName;
  readonly fixturePath: string;
  readonly readinessFailure: string | null;
  readonly playwright: {
    readonly exitCode: number | null;
    readonly spawnError: string | null;
    readonly timedOut: boolean;
  };
  readonly observation: {
    readonly runId: string;
    readonly case: string;
    readonly reportedPath: string;
  } | null;
  readonly notices: {
    readonly row1: string | null;
    readonly row1Title: string | null;
    readonly row2: string | null;
  } | null;
  readonly hashes: G3EvidenceHashes;
  readonly appStop: Pick<ProcessStopResult, "attempted" | "confirmed">;
  readonly cleanup: {
    readonly logPreserved: boolean;
    readonly tempRootRemoved: boolean;
    readonly errors: readonly string[];
  };
}

export interface G3Assessment {
  readonly ok: boolean;
  readonly failures: readonly string[];
}

/**
 * Every reason this run is not evidence of the thing it claims.
 *
 * Pure, so the failure matrix is testable without spawning anything. Cleanup
 * failures are APPENDED to the test's own failures: a run whose Playwright child
 * failed still reports that failure even when every cleanup step also failed.
 */
export function assessG3Evidence(input: G3AssessmentInput): G3Assessment {
  const failures: string[] = [];
  const definition = G3_CASES[input.caseName];

  if (input.readinessFailure) failures.push(input.readinessFailure);
  if (input.playwright.spawnError) {
    failures.push(`Playwright could not be started: ${input.playwright.spawnError}`);
  }
  if (input.playwright.timedOut) {
    failures.push(`Playwright did not exit within ${PLAYWRIGHT_TIMEOUT_MS} ms`);
  }
  if (input.playwright.exitCode !== 0) {
    failures.push(
      input.playwright.exitCode === null
        ? "Playwright produced no exit code"
        : `Playwright exited with ${input.playwright.exitCode}`,
    );
  }

  if (!input.observation) {
    failures.push("the spec wrote no observation file");
  } else {
    if (input.observation.runId !== input.runId) {
      failures.push("the observation belongs to a different run");
    }
    if (input.observation.case !== input.caseName) {
      failures.push(
        `the observation records case "${input.observation.case}", not "${input.caseName}"`,
      );
    }
    if (!pathsReferToSameFile(input.observation.reportedPath, input.fixturePath)) {
      failures.push(
        `the server reported "${input.observation.reportedPath}", not the fixture "${input.fixturePath}"`,
      );
    }
  }

  if (!input.notices) {
    failures.push("the observation does not record the rendered notices");
  } else {
    if (input.notices.row1 !== definition.expectedNotice) {
      failures.push(
        `row 1 rendered ${JSON.stringify(input.notices.row1)}, expected ${JSON.stringify(definition.expectedNotice)}`,
      );
    }
    if (input.notices.row1Title !== definition.expectedTitle) {
      failures.push("row 1 does not carry the notice's explanatory title");
    }
    if (input.notices.row2 !== null) {
      failures.push(
        `row 2 rendered a notice (${JSON.stringify(input.notices.row2)}); it is the rule that wins`,
      );
    }
  }

  if (input.hashes.original === null) {
    failures.push("the original fixture hash could not be captured");
  }
  if (input.hashes.observed === null) {
    failures.push("the fixture's bytes could not be hashed after the run");
  } else if (input.hashes.original !== null && input.hashes.observed !== input.hashes.original) {
    failures.push("the fixture's bytes changed during the run");
  }
  if (input.hashes.restored === null) {
    failures.push("the restored fixture could not be hashed");
  } else if (input.hashes.original !== null && input.hashes.restored !== input.hashes.original) {
    failures.push("restoring the original bytes did not reproduce the original hash");
  }

  if (input.appStop.attempted && !input.appStop.confirmed) {
    failures.push("the TBAi process tree did not terminate");
  }
  if (!input.cleanup.logPreserved) failures.push("the application log was not preserved");
  if (!input.cleanup.tempRootRemoved) failures.push("the temporary root was not removed");
  for (const error of input.cleanup.errors) failures.push(`cleanup: ${error}`);

  return { ok: failures.length === 0, failures };
}

export interface G3Observation {
  readonly runId: string;
  readonly case: string;
  readonly fixture: string;
  readonly reportedPath: string;
  readonly discoveredPaths: readonly string[];
  readonly permissions: readonly G3Rule[];
  readonly expectedNotice: string;
  readonly expectedTitle: string;
  readonly pageOrigin: string;
  readonly row1: {
    readonly action: string;
    readonly resource: string;
    readonly effect: string;
    readonly notice: string | null;
    readonly noticeTitle: string | null;
  };
  readonly row2: {
    readonly action: string;
    readonly resource: string;
    readonly effect: string;
    readonly notice: string | null;
  };
}

interface G3Options {
  readonly project: string;
  readonly outDir: string;
}

interface G3BuildInfo {
  readonly stamp: BuildStamp | null;
}

interface G3OpenCodeInfo {
  readonly binary: string;
  readonly version: string | null;
}

interface G3CaseResult {
  readonly caseName: G3CaseName;
  readonly ok: boolean;
  readonly evidencePath: string | null;
  readonly failures: readonly string[];
}

function parseArgs(argv: readonly string[]): G3Options | null {
  let project = DEFAULT_PROJECT;
  let outDir = DEFAULT_OUT_DIR;
  for (const arg of argv) {
    if (arg.startsWith("--project=")) {
      project = arg.slice("--project=".length).trim();
    } else if (arg.startsWith("--out=")) {
      outDir = path.resolve(arg.slice("--out=".length).trim());
    } else {
      console.error(`[g3] unknown argument: ${arg}`);
      return null;
    }
  }
  if (project.length === 0) {
    console.error("[g3] --project= must name a Playwright project");
    return null;
  }
  return { project, outDir };
}

function readOpenCodeVersion(binary: string): string | null {
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
    timeout: PROBE_TIMEOUT_MS,
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? "").trim() || null;
}

async function waitForServer(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/readyz`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) return false;
    await sleep(READY_POLL_MS);
  }
}

interface PlaywrightOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError: string | null;
  readonly timedOut: boolean;
}

/**
 * The environment the spec reads.
 *
 * Exported so the unit test can hold the spec file to every `G3_*` name here: a
 * renamed variable would otherwise surface only as a skipped live spec, which
 * reads as a pass in the runner's summary.
 */
export function specEnvironment(input: {
  readonly caseName: G3CaseName;
  readonly definition: G3CaseDefinition;
  readonly fixturePath: string;
  readonly baseUrl: string;
  readonly observationPath: string;
  readonly runId: string;
}): Record<string, string> {
  return {
    // The orchestrator owns the server; the config must not start another.
    TBAI_E2E_EXTERNAL_SERVER: "1",
    TBAI_E2E_BASE_URL: input.baseUrl,
    // Live specs are opt-in in the config, and this one is live by design.
    TBAI_E2E_LIVE: "1",
    G3_CASE: input.caseName,
    G3_RUN_ID: input.runId,
    G3_FIXTURE: input.fixturePath,
    G3_EXPECTED_NOTICE: input.definition.expectedNotice,
    G3_EXPECTED_TITLE: input.definition.expectedTitle,
    G3_OBSERVATION_OUT: input.observationPath,
  };
}

/**
 * The environment the TBAi process (and therefore its managed `opencode serve`
 * child) runs with.
 *
 * ## Why the OpenCode config directory is set explicitly
 *
 * MEASURED on this machine, 2026-10-26: the host shell that starts the evidence
 * run can itself be hosted by OpenCode, whose ambient environment carries
 * `OPENCODE_CONFIG_DIR` (`D:\Coding\OpenCode\.config\opencode`). That variable
 * **outranks** `XDG_CONFIG_HOME` inside `opencode serve`: with only `XDG_*`
 * redirected, `GET /api/config` reported the host's global
 * `D:\...\.config\opencode\opencode.json` FIRST — ahead of the fixture — and that
 * file is JSONC, so the API correctly answered `malformed: true`, `editable:
 * false`. Both G3 cases then failed on an assertion that had nothing to do with
 * the fixture: the run's isolation claim ("the fixture is the only document
 * read") was simply false.
 *
 * Verified by direct probe (three variants, one real 2.1.4 server each):
 *
 * | Redirected | Documents carrying permissions |
 * |---|---|
 * | `XDG_*` only | host global (9 rules) **and** fixture (2) → host wins |
 * | `XDG_*` + `HOME`/`USERPROFILE` | unchanged → not a home-directory lookup |
 * | `XDG_*` + `OPENCODE_CONFIG_DIR` | fixture only |
 *
 * So the run directs OpenCode's own config directory into its temp root. That is
 * isolation of the harness, not a product behaviour: in production the managed
 * server is SUPPOSED to read the user's real global config, and refusing to edit
 * a JSONC file is the documented, tested behaviour of the reader.
 *
 * Exported so the unit test can hold this contract: an ambient OpenCode config
 * directory must not be able to pull a host file into a run.
 */
export function g3AppEnvironment(input: {
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly dataDir: string;
  readonly workspaceDir: string;
  readonly port: number;
  readonly applicationLogPath: string;
  readonly fixturePath: string;
  readonly openCodeConfigDir: string;
  readonly xdg: {
    readonly config: string;
    readonly data: string;
    readonly cache: string;
    readonly state: string;
  };
}): Record<string, string | undefined> {
  return {
    ...input.baseEnv,
    DATA_DIR: input.dataDir,
    WORKSPACE_DIR: input.workspaceDir,
    PORT: String(input.port),
    NODE_ENV: "production",
    TBAI_LOG_FILE: input.applicationLogPath,
    XDG_CONFIG_HOME: input.xdg.config,
    XDG_DATA_HOME: input.xdg.data,
    XDG_CACHE_HOME: input.xdg.cache,
    XDG_STATE_HOME: input.xdg.state,
    // Outranks XDG_CONFIG_HOME inside `opencode serve`; see the doc comment.
    OPENCODE_CONFIG_DIR: input.openCodeConfigDir,
    OPENCODE_CONFIG: input.fixturePath,
  };
}

function runPlaywright(input: {
  readonly caseName: G3CaseName;
  readonly definition: G3CaseDefinition;
  readonly fixturePath: string;
  readonly baseUrl: string;
  readonly observationPath: string;
  readonly runId: string;
  readonly project: string;
}): Promise<PlaywrightOutcome> {
  const child = spawn(
    process.execPath,
    [PLAYWRIGHT_CLI, "test", SPEC_FILE, `--project=${input.project}`, "--reporter=line"],
    {
      cwd: WEB_ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        ...specEnvironment({
          caseName: input.caseName,
          definition: input.definition,
          fixturePath: input.fixturePath,
          baseUrl: input.baseUrl,
          observationPath: input.observationPath,
          runId: input.runId,
        }),
      },
    },
  );

  return new Promise((resolve) => {
    let settled = false;
    let spawnError: string | null = null;
    let timedOut = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(afterKillTimer);
      resolve({ exitCode, signal, spawnError, timedOut });
    };
    const afterKillTimer = setTimeout(() => finish(null, null), PLAYWRIGHT_TIMEOUT_MS + 10_000);
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PLAYWRIGHT_TIMEOUT_MS);
    child.on("error", (error) => {
      spawnError = errorMessage(error);
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

function readObservation(observationPath: string): {
  observation: G3Observation | null;
  error: string | null;
} {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(observationPath, "utf8"));
    if (parsed === null || typeof parsed !== "object") {
      return { observation: null, error: "the observation file is not a JSON object" };
    }
    return { observation: parsed as G3Observation, error: null };
  } catch (error) {
    return {
      observation: null,
      error: `could not read the observation file: ${errorMessage(error)}`,
    };
  }
}

async function fetchConfigSnapshot(baseUrl: string): Promise<unknown> {
  try {
    const response = await fetch(`${baseUrl}/api/opencode/config`, {
      signal: AbortSignal.timeout(CONFIG_SNAPSHOT_TIMEOUT_MS),
    });
    const body = await response.text();
    if (!response.ok) return { status: response.status, error: body.slice(0, 2_000) };
    return JSON.parse(body) as unknown;
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

function copyIfExists(source: string, destination: string): boolean {
  if (!fs.existsSync(source)) return false;
  fs.copyFileSync(source, destination);
  return true;
}

async function runCase(
  caseName: G3CaseName,
  options: G3Options,
  build: G3BuildInfo,
  openCode: G3OpenCodeInfo,
): Promise<G3CaseResult> {
  const definition = G3_CASES[caseName];
  const runId = `${new Date().toISOString()}-${randomBytes(4).toString("hex")}`;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `tbai-g3-${caseName}-`));
  const dataDir = path.join(tempRoot, "data");
  const workspaceDir = path.join(tempRoot, "workspace");
  const xdgDirs = {
    config: path.join(tempRoot, "xdg-config"),
    data: path.join(tempRoot, "xdg-data"),
    cache: path.join(tempRoot, "xdg-cache"),
    state: path.join(tempRoot, "xdg-state"),
  };
  // `OPENCODE_CONFIG_DIR` is the directory OpenCode resolves its global
  // `opencode.json` from, and it outranks `XDG_CONFIG_HOME`. Keeping it inside
  // the temp root is what makes "the fixture is the only config document" true
  // (see `g3AppEnvironment`).
  const openCodeConfigDir = path.join(xdgDirs.config, "opencode");
  for (const dir of [dataDir, workspaceDir, ...Object.values(xdgDirs), openCodeConfigDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const fixturePath = path.join(tempRoot, "opencode.json");
  const fixtureBytes = Buffer.from(serializeFixture(caseName), "utf8");
  fs.writeFileSync(fixturePath, fixtureBytes);

  const observationPath = path.join(options.outDir, `${caseName}-observation.json`);
  const evidencePath = path.join(options.outDir, `${caseName}.json`);
  const consoleLogPath = path.join(tempRoot, "app-console.log");
  fs.mkdirSync(options.outDir, { recursive: true });
  // A stale file from an earlier run must never be read as this run's result.
  fs.rmSync(observationPath, { force: true });
  fs.rmSync(evidencePath, { force: true });

  const originalHash = hashBytes(fixtureBytes);
  const applicationLogPath = path.join(dataDir, "tbai.log");

  let app: ChildProcess | null = null;
  let appConsoleFd: number | null = null;
  let appStop: ProcessStopResult = {
    attempted: false,
    method: null,
    descendants: [],
    survivors: [],
    confirmed: true,
    errors: [],
  };
  let playwright: PlaywrightOutcome = {
    exitCode: null,
    signal: null,
    spawnError: null,
    timedOut: false,
  };
  let observation: G3Observation | null = null;
  let observationError: string | null = null;
  let notices: G3AssessmentInput["notices"] = null;
  let serverSnapshot: unknown = null;
  let readinessFailure: string | null = null;
  let port: number | null = null;
  const baseUrl = { value: null as string | null };

  try {
    port = await allocateFreePort();
    const url = `http://127.0.0.1:${port}`;
    baseUrl.value = url;

    appConsoleFd = fs.openSync(consoleLogPath, "a");
    app = spawn(process.execPath, [APP_ENTRY], {
      cwd: REPO_ROOT,
      env: g3AppEnvironment({
        baseEnv: process.env,
        dataDir,
        workspaceDir,
        port,
        applicationLogPath,
        fixturePath,
        openCodeConfigDir,
        xdg: xdgDirs,
      }),
      stdio: ["ignore", appConsoleFd, appConsoleFd],
      windowsHide: true,
    });

    if (await waitForServer(url, READY_TIMEOUT_MS)) {
      playwright = await runPlaywright({
        caseName,
        definition,
        fixturePath,
        baseUrl: url,
        observationPath,
        runId,
        project: options.project,
      });
      const read = readObservation(observationPath);
      observation = read.observation;
      observationError = read.error;
      notices = observation
        ? {
            row1: observation.row1?.notice ?? null,
            row1Title: observation.row1?.noticeTitle ?? null,
            row2: observation.row2?.notice ?? null,
          }
        : null;
      serverSnapshot = await fetchConfigSnapshot(url);
    } else {
      readinessFailure = `the app did not answer /readyz within ${READY_TIMEOUT_MS} ms`;
    }
  } catch (error) {
    readinessFailure = `the run failed before Playwright could report: ${errorMessage(error)}`;
  }

  // Cleanup runs on BOTH paths — success and caught failure — without a `finally`
  // block, because returning from `finally` would override the control flow of
  // the `try` and turn a future throw into a silently swallowed one.
  //
  // Approved order: the process tree is stopped and confirmed BEFORE the
  // fixture is hashed. Every step below records its own failure.
  const cleanupErrors: string[] = [];
  if (app?.pid !== undefined) {
    try {
      appStop = stopProcessTree(app.pid);
      cleanupErrors.push(...appStop.errors);
    } catch (error) {
      appStop = {
        attempted: true,
        method: null,
        descendants: [],
        survivors: [],
        confirmed: false,
        errors: [errorMessage(error)],
      };
      cleanupErrors.push(`stopping the app failed: ${errorMessage(error)}`);
    }
  }
  if (appConsoleFd !== null) {
    try {
      fs.closeSync(appConsoleFd);
    } catch (error) {
      cleanupErrors.push(`closing the app console log failed: ${errorMessage(error)}`);
    }
    appConsoleFd = null;
  }

  let observedHash: string | null = null;
  let restoredHash: string | null = null;
  try {
    observedHash = hashFile(fixturePath);
  } catch (error) {
    cleanupErrors.push(`hashing the fixture after the run failed: ${errorMessage(error)}`);
  }
  try {
    restoreFileBytes(fixturePath, fixtureBytes);
  } catch (error) {
    cleanupErrors.push(`restoring the fixture failed: ${errorMessage(error)}`);
  }
  try {
    restoredHash = hashFile(fixturePath);
  } catch (error) {
    cleanupErrors.push(`hashing the restored fixture failed: ${errorMessage(error)}`);
  }

  let logPreserved = false;
  let consoleLogPreserved = false;
  try {
    logPreserved = copyIfExists(
      applicationLogPath,
      path.join(options.outDir, `${caseName}-tbai.log`),
    );
  } catch (error) {
    cleanupErrors.push(`preserving the application log failed: ${errorMessage(error)}`);
  }
  try {
    consoleLogPreserved = copyIfExists(
      consoleLogPath,
      path.join(options.outDir, `${caseName}-console.log`),
    );
  } catch (error) {
    cleanupErrors.push(`preserving the console log failed: ${errorMessage(error)}`);
  }

  let tempRootRemoved = false;
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRootRemoved = !fs.existsSync(tempRoot);
  } catch (error) {
    cleanupErrors.push(`removing the temporary root failed: ${errorMessage(error)}`);
  }

  const hashes: G3EvidenceHashes = {
    original: originalHash,
    observed: observedHash,
    restored: restoredHash,
  };
  const assessment = assessG3Evidence({
    runId,
    caseName,
    fixturePath,
    readinessFailure,
    playwright: {
      exitCode: playwright.exitCode,
      spawnError: playwright.spawnError,
      timedOut: playwright.timedOut,
    },
    observation,
    notices,
    hashes,
    appStop,
    cleanup: { logPreserved, tempRootRemoved, errors: cleanupErrors },
  });

  const evidence = {
    schemaVersion: 1 as const,
    runId,
    case: caseName,
    generatedAt: new Date().toISOString(),
    definition,
    fixture: {
      path: fixturePath,
      /** Paths the app was given, recorded so isolation is inspectable. */
      dataDir,
      workspaceDir,
      xdgConfigHome: xdgDirs.config,
      xdgDataHome: xdgDirs.data,
      xdgCacheHome: xdgDirs.cache,
      xdgStateHome: xdgDirs.state,
      /**
       * OpenCode's own config directory, redirected into the temp root. Without
       * this an ambient `OPENCODE_CONFIG_DIR` on the host outranks
       * `XDG_CONFIG_HOME` and the run reads the host's global document.
       */
      openCodeConfigDir,
      openCodeConfigEnv: fixturePath,
    },
    app: {
      entry: APP_ENTRY,
      port,
      baseUrl: baseUrl.value,
      pid: app?.pid ?? null,
    },
    openCode,
    build: { stamp: build.stamp },
    playwright: {
      project: options.project,
      spec: SPEC_FILE,
      exitCode: playwright.exitCode,
      signal: playwright.signal,
      spawnError: playwright.spawnError,
      timedOut: playwright.timedOut,
    },
    observation,
    observationError,
    serverSnapshot,
    hashes,
    appStop,
    cleanup: { logPreserved, consoleLogPreserved, tempRootRemoved, errors: cleanupErrors },
    assessment,
  };

  let evidenceWritten = false;
  try {
    fs.mkdirSync(options.outDir, { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    evidenceWritten = true;
  } catch (error) {
    console.error(`[g3] ${caseName}: could not write evidence — ${errorMessage(error)}`);
  }

  const failures = evidenceWritten
    ? assessment.failures
    : [...assessment.failures, "the evidence file could not be written"];
  const ok = evidenceWritten && assessment.ok;
  console.log(
    `[g3] ${caseName}: ${ok ? "PASS" : "FAIL"} — ${
      evidenceWritten ? evidencePath : "no evidence file"
    }`,
  );
  for (const failure of failures) console.error(`[g3]   ${failure}`);
  return {
    caseName,
    ok,
    evidencePath: evidenceWritten ? evidencePath : null,
    failures,
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: bun run test:opencode-g3 [--project=<playwright project>] [--out=<directory>]",
    );
    return 0;
  }
  const options = parseArgs(argv);
  if (!options) return 1;

  if (!ensureFreshWebBuild("g3").ok) return 1;

  const openCode: G3OpenCodeInfo = {
    binary: process.env.OPENCODE_BINARY ?? "opencode",
    version: readOpenCodeVersion(process.env.OPENCODE_BINARY ?? "opencode"),
  };
  console.log(`[g3] OpenCode: ${openCode.binary} (${openCode.version ?? "version unavailable"})`);
  const build: G3BuildInfo = { stamp: readBuildStamp(WEB_DIST) };

  const results: G3CaseResult[] = [];
  for (const caseName of G3_CASE_NAMES) {
    console.log(`[g3] case ${caseName}: starting an isolated app + managed server`);
    try {
      results.push(await runCase(caseName, options, build, openCode));
    } catch (error) {
      console.error(`[g3] case ${caseName}: the run failed — ${errorMessage(error)}`);
      results.push({
        caseName,
        ok: false,
        evidencePath: null,
        failures: [errorMessage(error)],
      });
    }
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n[g3] cases ok: ${results.length - failed.length}, failed: ${failed.length}`);
  return failed.length === 0 ? 0 : 1;
}

// Guarded so `tests/unit/tooling/g3-override-evidence.test.ts` can read the
// cases and the pure helpers without executing the run.
if (import.meta.main) {
  process.exitCode = await main();
}
