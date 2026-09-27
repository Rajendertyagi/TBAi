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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const E2E_DIR = path.join(REPO_ROOT, "web", "e2e");
const E2E_PORT = process.env.TBAI_E2E_PORT ?? "3101";
const READY_URL = `http://localhost:${E2E_PORT}/readyz`;

const args = process.argv.slice(2);
const projectArg = args.find((a) => a.startsWith("--project="));
const project = projectArg ? projectArg.split("=")[1] : "chromium-headless";
const explicit = args.filter((a) => !a.startsWith("--"));

/** Flags the runner does not own, passed through to Playwright untouched. */
const forwarded = args.filter(
  (a) => a.startsWith("--") && !a.startsWith("--project="),
);
// A caller-chosen reporter must win outright rather than race the default, so
// the default is only added when the caller did not ask for one.
const reporterDefault = forwarded.some((a) => a.startsWith("--reporter"))
  ? []
  : ["--reporter=line"];

const runLive = process.env.TBAI_E2E_LIVE === "1";

function specFiles(): string[] {
  if (explicit.length > 0) {
    return explicit.map((f) => (f.endsWith(".spec.ts") ? f : `${f}.spec.ts`));
  }
  return fs
    .readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".spec.ts"))
    .filter((f) => runLive || !f.endsWith("-live.spec.ts"))
    .sort();
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
process.exit(failed === 0 ? 0 : 1);
