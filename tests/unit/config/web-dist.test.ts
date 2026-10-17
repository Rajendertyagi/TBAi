/**
 * Served-SPA resolution — the standalone binary's 404.
 *
 * `dist/tbai-server.exe` answered `GET /` with 404 whenever it was not launched
 * from the repository root: the served directory defaulted to
 * `process.cwd()/dist/web`, so running the binary from inside `dist/` looked for
 * `dist/dist/web` while the UI sat in `dist/web` beside it.
 *
 * The packaged branch cannot be exercised by importing the module (it depends on
 * `import.meta.dir` being a virtual path), which is exactly why the resolution
 * was split into a pure function: both branches are pinned here, in process.
 * `resolveInstallRoot` (the shared anchor) is pinned transitively — every case
 * below is a statement about it, and `data-dir.test.ts` states the same two
 * branches through the other consumer.
 *
 * The `process.cwd()` case needs a child, because this test process's own
 * working directory IS the repository root, where the old and new defaults
 * coincide. It is the one case that can tell the two apart.
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_WEB_DIST_DIR, WEB_DIST_DIR, resolveDefaultWebDistDir } from "@/config/web-dist.ts";
import { REPO_ROOT } from "@/config/install-root.ts";
import { REPO_ROOT as TEST_REPO_ROOT } from "../../helpers/repo-root";

const WEB_DIST_MODULE_URL = pathToFileURL(
  path.join(REPO_ROOT, "src", "config", "web-dist.ts"),
).href;

/** Import the real module in a child process and report what it resolved. */
async function resolveInChild(
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<{ web: string; def: string }> {
  const script = `const m = await import(${JSON.stringify(WEB_DIST_MODULE_URL)});
console.log(JSON.stringify({ web: m.WEB_DIST_DIR, def: m.DEFAULT_WEB_DIST_DIR }));`;
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (value !== undefined) childEnv[key] = value;
  }
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  return JSON.parse(stdout.trim()) as { web: string; def: string };
}

// ── resolveDefaultWebDistDir: the two branches ──────────────────────────────

describe("resolveDefaultWebDistDir — source checkout", () => {
  it("anchors to <anchor>/dist/web and ignores execPath", () => {
    const anchor = path.join("C:", "work", "ai-chat-app");
    expect(
      resolveDefaultWebDistDir({
        anchor,
        anchorIsCheckout: true,
        execPath: path.join("C:", "bun", "bun.exe"),
      }),
    ).toBe(path.join(anchor, "dist", "web"));
  });
});

describe("resolveDefaultWebDistDir — packaged binary", () => {
  it("anchors to <dirname(execPath)>/web, beside the executable", () => {
    const execPath = path.join("D:", "app", "tbai-server.exe");
    // The anchor is Bun's virtual FS root: it MUST NOT be used.
    expect(
      resolveDefaultWebDistDir({
        anchor: path.parse(process.cwd()).root,
        anchorIsCheckout: false,
        execPath,
      }),
    ).toBe(path.join(path.dirname(execPath), "web"));
  });

  it("never resolves to a nested dist/dist/web (the reported defect)", () => {
    const execPath = path.join("D:", "app", "dist", "tbai-server.exe");
    const resolved = resolveDefaultWebDistDir({
      anchor: "D:\\",
      anchorIsCheckout: false,
      execPath,
    });
    expect(resolved).toBe(path.join("D:", "app", "dist", "web"));
    expect(resolved).not.toBe(path.join("D:", "app", "dist", "dist", "web"));
  });

  it("never resolves to a filesystem root", () => {
    const execPath = path.join("D:", "app", "tbai-server.exe");
    const resolved = resolveDefaultWebDistDir({
      anchor: path.parse(process.cwd()).root,
      anchorIsCheckout: false,
      execPath,
    });
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).not.toBe(path.parse(process.cwd()).root);
    expect(path.basename(resolved)).toBe("web");
  });
});

// ── This process is a checkout ──────────────────────────────────────────────

describe("module-level resolution in a checkout", () => {
  it("REPO_ROOT matches the test helper's independent walk-up", () => {
    expect(REPO_ROOT).toBe(TEST_REPO_ROOT);
  });

  it("the default served directory is <repo>/dist/web", () => {
    expect(DEFAULT_WEB_DIST_DIR).toBe(path.join(REPO_ROOT, "dist", "web"));
  });

  it("WEB_DIST_DIR is the env override when set, the anchored default otherwise", () => {
    expect(WEB_DIST_DIR).toBe(process.env.WEB_DIST_DIR ?? DEFAULT_WEB_DIST_DIR);
  });
});

// ── The working directory must not move the served directory ────────────────
//
// WEB_DIST_DIR is read once at module load, so a child is the only way to see
// the default from a different working directory.

describe("the served directory is anchored to the install, not the working directory", () => {
  it("launched from an unrelated directory, still resolves the install's dist/web", async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-webdist-cwd-"));
    try {
      const out = await resolveInChild({ WEB_DIST_DIR: undefined }, elsewhere);
      expect(out.def).toBe(path.join(REPO_ROOT, "dist", "web"));
      expect(out.web).toBe(path.join(REPO_ROOT, "dist", "web"));
      // The old `process.cwd()/dist/web` default is exactly this, and it is not
      // what a checkout resolves to from anywhere.
      expect(out.def).not.toBe(path.join(elsewhere, "dist", "web"));
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("an explicit WEB_DIST_DIR override wins without moving the default", async () => {
    const override = path.join(REPO_ROOT, "tests", ".artifacts", "web-dist-override");
    const out = await resolveInChild({ WEB_DIST_DIR: override }, REPO_ROOT);
    expect(out.web).toBe(override);
    expect(out.def).toBe(path.join(REPO_ROOT, "dist", "web"));
  });
});
