/**
 * E2E server launcher — the one place the Playwright suite's server is defined.
 *
 * Why this exists: `web/playwright.config.ts` used to have no `webServer` at all,
 * so every spec attached to whatever server happened to be running — typically
 * the maintainer's live app, on the live database. Two consequences, both
 * observed: runs polluted real conversations, and specs interfered with each
 * other because they shared one mutable database.
 *
 * What it guarantees, in one reviewed place rather than scattered shell strings:
 *  - a private `DATA_DIR`, so the SQLite database, the port mirror and the
 *    OpenCode home are the suite's own;
 *  - a private `WORKSPACE_DIR`, so scratch folders and `workspace/chats` never
 *    touch the real workspace;
 *  - a fixed `PORT`, so `baseURL` is deterministic instead of following the port
 *    file the live server keeps rewriting;
 *  - a clean slate on every start, so a run cannot inherit the previous run's
 *    conversations (the cross-run folder accumulation that made `phase-ua-d` D2
 *    fail for a reason unrelated to the code under test).
 *
 * Opt out with `TBAI_E2E_BASE_URL`, which points the suite at a server you
 * manage yourself. Nothing here runs in that case.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedStubProvider, startStubProvider } from "./e2e-stub-provider";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const E2E_DATA_DIR = path.join(REPO_ROOT, ".e2e-data");
const E2E_WORKSPACE_DIR = path.join(REPO_ROOT, ".e2e-workspace");
const E2E_PORT = process.env.TBAI_E2E_PORT ?? "3101";
/** Fixed, and off the app's own port space, so it never collides. */
const STUB_PORT = Number(process.env.TBAI_E2E_STUB_PORT ?? 3199);

/** The frontend the server serves. Built output, never a dev server. */
// The SPA ships into the same `dist/` that holds the compiled server, so the e2e
// suite exercises the layout that actually ships rather than a parallel one.
const WEB_DIST = path.join(REPO_ROOT, "dist", "web");

function fail(message: string): never {
  process.stderr.write(`[e2e-server] ${message}\n`);
  process.exit(1);
}

// A clean slate is the point: an inherited database is the cross-run
// interference this script exists to remove. Removed wholesale rather than
// row-by-row, so there is no partial state to reason about.
fs.rmSync(E2E_DATA_DIR, { recursive: true, force: true });
fs.rmSync(E2E_WORKSPACE_DIR, { recursive: true, force: true });
fs.mkdirSync(E2E_DATA_DIR, { recursive: true });
fs.mkdirSync(E2E_WORKSPACE_DIR, { recursive: true });
// OpenCode writes its global state on first boot; create the roots so it never
// falls back to the maintainer's real home.
for (const dir of ["xdg-config", "xdg-data", "xdg-cache", "xdg-state"]) {
  fs.mkdirSync(path.join(E2E_DATA_DIR, dir), { recursive: true });
}

if (!fs.existsSync(path.join(WEB_DIST, "index.html"))) {
  fail(`dist/web is missing. Run \`bun run build:web\` before \`bun run test:e2e\`.`);
}

const stub = startStubProvider(STUB_PORT);

const child = spawn(process.execPath, [path.join(REPO_ROOT, "src", "index.ts")], {
  cwd: REPO_ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    DATA_DIR: E2E_DATA_DIR,
    WORKSPACE_DIR: E2E_WORKSPACE_DIR,
    PORT: E2E_PORT,
    NODE_ENV: process.env.NODE_ENV ?? "production",
    // The managed OpenCode server resolves its GLOBAL config, credentials and
    // database from XDG locations, NOT from DATA_DIR. Without these the e2e run
    // reads — and can write — the maintainer's real ~/.config/opencode and
    // ~/.local/share/opencode, which is the same class of leak this whole script
    // exists to prevent. Pointed inside the disposable dirs.
    XDG_CONFIG_HOME: path.join(E2E_DATA_DIR, "xdg-config"),
    XDG_DATA_HOME: path.join(E2E_DATA_DIR, "xdg-data"),
    XDG_CACHE_HOME: path.join(E2E_DATA_DIR, "xdg-cache"),
    XDG_STATE_HOME: path.join(E2E_DATA_DIR, "xdg-state"),
  },
});

/**
 * Seed the baseline provider once the app answers. Without it the suite has no
 * model at all, and every spec that only needs a model to exist fails for a
 * reason that has nothing to do with what it is testing.
 */
const seedBaseline = async (): Promise<void> => {
  const base = `http://localhost:${E2E_PORT}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const ready = await fetch(`${base}/readyz`);
      if (ready.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      process.stderr.write("[e2e-server] app never became ready; skipping baseline seed\n");
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    await seedStubProvider(base, stub);
    process.stdout.write("[e2e-server] baseline provider seeded\n");
  } catch (error) {
    process.stderr.write(`[e2e-server] baseline seed failed: ${String(error)}\n`);
  }
};
void seedBaseline();

const stop = (signal: NodeJS.Signals): void => {
  stub.stop();
  if (!child.killed) child.kill(signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
child.on("exit", (code, signal) => {
  stub.stop();
  process.exit(signal ? 1 : (code ?? 0));
});
