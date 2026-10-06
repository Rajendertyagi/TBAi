import fs from "node:fs";
import path from "node:path";

/**
 * Run the renderer CPU profile against the SYMBOLICATED build.
 *
 * The suite's server serves web/dist by default, which is minified - so every
 * application function reports as a one-letter name and the profile says
 * nothing about which code is hot. This runner builds (or reuses) the
 * unminified artifact in web/dist-profile and points the server at it through
 * WEB_DIST_DIR, leaving web/dist untouched.
 *
 * Kept as a script rather than a Playwright project because the artifact is
 * served by the backend, not by the browser runner, and because building it is
 * a separate concern from running the specs. Reuses an existing build only
 * when one is already present, so an ordinary `bun run test:e2e` never pays
 * for it.
 *
 * Usage:
 *   bun run scripts/profile-web.ts          # build if needed, then run
 *   bun run scripts/profile-web.ts --rebuild
 *   bun run scripts/profile-web.ts --project=msedge
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = path.join(REPO_ROOT, "web");
const PROFILE_DIST = path.join(WEB_DIR, "dist-profile");

const argv = process.argv.slice(2);
const rebuild = argv.includes("--rebuild");
const projectArg = argv.find((a) => a.startsWith("--project="));
const project = projectArg?.split("=")[1];

function fail(message: string): never {
  process.stderr.write(`[profile-web] ${message}\n`);
  process.exit(1);
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string = REPO_ROOT,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: { ...process.env, ...env },
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? "signal"}`)),
    );
  });
}

if (rebuild || !fs.existsSync(path.join(PROFILE_DIST, "index.html"))) {
  process.stdout.write("[profile-web] building the unminified profiling artifact\n");
  // Unminified output is NOT shippable, which is why it lands in a separate
  // directory. See web/vite.config.ts.
  await run("bun", ["run", "build:web:profile"], { TBAI_PROFILE_BUILD: "1" });
}

if (!fs.existsSync(path.join(PROFILE_DIST, "index.html"))) {
  fail("web/dist-profile/index.html is missing after the build");
}

process.stdout.write(`[profile-web] serving ${PROFILE_DIST}\n`);

const playwrightArgs = ["test", "renderer-cpu-profile", "--reporter=line"];
if (project) playwrightArgs.push(`--project=${project}`);

// Run from web/, because that is where playwright.config.ts lives: launched
// from the repo root Playwright finds no config at all and reports zero
// projects, which reads as "no such project" rather than "wrong directory".
//
// WEB_DIST_DIR reaches the server through start-e2e-server.ts, which forwards
// the environment to the app process, and src/routes/index.ts reads it in place
// of web/dist. No other seam is involved: the Playwright config's own
// webServer still starts, so nothing about the suite's isolation changes.
// The local Playwright CLI, invoked directly with the current runtime. Both
// halves matter: `bunx --bun playwright` from web/ resolves against the wrong
// root and tries to reinstall the package as a git dependency, and handing
// the CLI to `node` fails the same way when the runtime is bun.
const playwrightCli = path.join(REPO_ROOT, "node_modules", "playwright", "cli.js");
await run(process.execPath, [playwrightCli, ...playwrightArgs], { WEB_DIST_DIR: PROFILE_DIST }, WEB_DIR);
