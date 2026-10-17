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
 * Usage:
 *   bun run test:e2e                                  # chromium, every spec
 *   bun run test:e2e --project=edge-headed
 *   bun run test:e2e phase-ua-d.spec.ts
 *   bun run test:e2e --grep="running dot"             # forwarded to Playwright
 */
import { spawn, type Subprocess } from "bun";
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
const E2E_PORT = process.env.TBAI_E2E_PORT ?? "3101";
const READY_URL = `http://localhost:${E2E_PORT}/readyz`;

const args = process.argv.slice(2);
const projectArg = args.find((a) => a.startsWith("--project="));
const project = projectArg ? projectArg.split("=")[1] : "chromium-headless";
const explicit = args.filter((a) => !a.startsWith("--"));

/** Flags the runner does not own, passed through to Playwright untouched. */
const forwarded = args.filter((a) => a.startsWith("--") && !a.startsWith("--project="));
// A caller-chosen reporter must win outright rather than race the default, so
// the default is only added when the caller did not ask for one.
const reporterDefault = forwarded.some((a) => a.startsWith("--reporter"))
  ? []
  : ["--reporter=line"];

const runLive = process.env.TBAI_E2E_LIVE === "1";

/**
 * Every `*.spec.ts` under the E2E root, recursively.
 *
 * This MUST be recursive. Specs are bucketed into subdirectories
 * (`history/`, `core/`, `tools/`, ...), so a flat `readdirSync` returns
 * directories, the `.spec.ts` filter matches nothing, and the runner reports
 * "0 spec file(s)" and EXITS 0 - a green gate that ran no tests at all. That is
 * the exact silent-coverage-loss the AGENTS.md test-location rule exists to
 * prevent, reintroduced by the runner that was meant to serve it.
 */
function collectSpecFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSpecFiles(full));
    } else if (entry.name.endsWith(".spec.ts")) {
      found.push(full);
    }
  }
  return found;
}

function specFiles(): string[] {
  if (explicit.length > 0) {
    return explicit.map((f) => (f.endsWith(".spec.ts") ? f : `${f}.spec.ts`));
  }
  return (
    collectSpecFiles(E2E_DIR)
      .filter((f) => runLive || !f.endsWith("-live.spec.ts"))
      // Playwright treats positional arguments as REGEXES matched against each
      // test file's path. An absolute Windows path is full of backslashes, which
      // are regex escapes, so every pattern fails to match and the run reports
      // "No tests found" for every file. Relative POSIX paths from the E2E root
      // match literally.
      .map((f) => path.relative(E2E_DIR, f).split(path.sep).join("/"))
      .sort()
  );
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

if (!ensureFreshWebBuild()) {
  process.exit(1);
}

const files = specFiles();
console.log(`[e2e] ${files.length} spec file(s), project=${project}, live=${runLive}`);

let passed = 0;
let failed = 0;
const failedFiles: string[] = [];

for (const file of files) {
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

  const run = spawn(
    [
      process.execPath,
      path.join(REPO_ROOT, "web", "node_modules", "@playwright", "test", "cli.js"),
      "test",
      file,
      `--project=${project}`,
      ...reporterDefault,
      ...forwarded,
    ],
    {
      cwd: path.join(REPO_ROOT, "web"),
      stdout: "inherit",
      stderr: "inherit",
      // The runner owns the server lifecycle; the config must not start a second.
      env: { ...process.env, TBAI_E2E_EXTERNAL_SERVER: "1" },
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
      const tail = fs
        .readFileSync(serverLog, "utf8")
        .split(/\\r?\\n/)
        .slice(-50)
        .join("\\n");
      console.log(`[e2e] --- tail of ${file} server log ---`);
      console.log(tail);
      console.log(`[e2e] --- end tail ---`);
    }
  }

  server.kill();
  await waitForPortFree(Number(E2E_PORT), 20_000);

  if (code === 0) {
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
  process.exit(1);
}
process.exit(failed === 0 ? 0 : 1);
