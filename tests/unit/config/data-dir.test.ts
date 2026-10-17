/**
 * Data-directory resolution — the EPERM that started this file.
 *
 * `dist/tbai-server.exe` (a `bun build --compile` binary) crashed at module init
 * with `EPERM: operation not permitted, mkdir '\'` because the default data
 * directory was anchored to `path.resolve(import.meta.dir, "../..")`, and inside
 * a compiled bundle `import.meta.dir` is Bun's VIRTUAL filesystem
 * (`B:\~BUN\root`), so `../..` collapsed to a drive root. `src/db/index.ts` then
 * `mkdirSync`d `B:\data`, which cannot be created.
 *
 * The packaged branch cannot be exercised by importing the module (it depends on
 * `import.meta.dir` being virtual), which is exactly why the resolution was
 * split into a pure function: both branches are pinned here, in process.
 *
 * The module-level assertions run against this checkout (the branch a test run
 * takes), with `tests/setup.ts` pointing `DATA_DIR` at a per-file sandbox — the
 * override must win without moving the default.
 */
import { describe, it, expect } from "bun:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DATA_DIR,
  DB_PATH,
  DEFAULT_DATA_DIR,
  LOG_PATH,
  resolveDefaultDataDir,
} from "@/config/data-dir.ts";
import { REPO_ROOT } from "@/config/install-root.ts";
import { REPO_ROOT as TEST_REPO_ROOT } from "../../helpers/repo-root";

// ── resolveDefaultDataDir: the two branches ─────────────────────────────────

describe("resolveDefaultDataDir — source checkout", () => {
  it("anchors to <anchor>/data and ignores execPath", () => {
    const anchor = path.join("C:", "work", "ai-chat-app");
    expect(
      resolveDefaultDataDir({
        anchor,
        anchorIsCheckout: true,
        execPath: path.join("C:", "bun", "bun.exe"),
      }),
    ).toBe(path.join(anchor, "data"));
  });
});

describe("resolveDefaultDataDir — packaged binary", () => {
  it("anchors to <dirname(execPath)>/data and ignores the virtual anchor", () => {
    const execPath = path.join("D:", "app", "tbai-server.exe");
    // The anchor is Bun's virtual FS root: it MUST NOT be used.
    expect(
      resolveDefaultDataDir({
        anchor: path.parse(process.cwd()).root,
        anchorIsCheckout: false,
        execPath,
      }),
    ).toBe(path.join(path.dirname(execPath), "data"));
  });

  it("never resolves to a filesystem root (the original defect)", () => {
    const execPath = path.join("D:", "app", "tbai-server.exe");
    const resolved = resolveDefaultDataDir({
      anchor: path.parse(process.cwd()).root,
      anchorIsCheckout: false,
      execPath,
    });
    expect(resolved).not.toBe(path.parse(process.cwd()).root);
    expect(path.basename(resolved)).toBe("data");
  });
});

// ── This process is a checkout ──────────────────────────────────────────────

describe("module-level resolution in a checkout", () => {
  it("REPO_ROOT matches the test helper's independent walk-up", () => {
    expect(REPO_ROOT).toBe(TEST_REPO_ROOT);
  });

  it("the default data dir is <repo>/data", () => {
    expect(DEFAULT_DATA_DIR).toBe(path.join(REPO_ROOT, "data"));
  });

  it("DATA_DIR, DB_PATH and LOG_PATH are absolute and derived from the data dir", () => {
    expect(path.isAbsolute(DATA_DIR)).toBe(true);
    expect(DB_PATH).toBe(path.join(DATA_DIR, "chat.db"));
    expect(LOG_PATH).toBe(path.join(DATA_DIR, "tbai.log"));
  });
});

// ── The env override wins without moving the default ────────────────────────
//
// `DATA_DIR` is read once at module load, so this cannot be probed in the
// importing process — it needs a child that sees the env at its own import time.

describe("DATA_DIR env override", () => {
  it("overrides DATA_DIR while DEFAULT_DATA_DIR stays on the checkout", async () => {
    const override = path.join(REPO_ROOT, "tests", ".artifacts", "data-dir-override");
    const moduleUrl = pathToFileURL(path.join(REPO_ROOT, "src", "config", "data-dir.ts")).href;
    const script = `const m = await import(${JSON.stringify(moduleUrl)});
console.log(JSON.stringify({ dataDir: m.DATA_DIR, def: m.DEFAULT_DATA_DIR }));`;

    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATA_DIR: override },
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
    const out = JSON.parse(stdout.trim()) as { dataDir: string; def: string };
    expect(out.dataDir).toBe(override);
    expect(out.def).toBe(path.join(REPO_ROOT, "data"));
  });
});
