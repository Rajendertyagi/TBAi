/**
 * Signal-driven shutdown integration tests.
 *
 * Verifies that SIGINT and SIGTERM trigger clean graceful shutdown through the
 * canonical spine, terminate the child process with exit 0 (or signal code),
 * and complete well within the 3,000 ms Rust shutdown bound.
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "../../helpers/repo-root";

async function spawnWithReadyMarker(
  fixture: string,
  dataDir: string,
  marker: string,
  timeoutMs = 20000,
) {
  const child = Bun.spawn(["bun", path.join(REPO_ROOT, "tests/fixtures", fixture)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      TBAI_READY_MARKER: marker,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(marker)) return child;
    if (child.exitCode !== null) {
      throw new Error(`fixture ${fixture} exited before ready (code ${child.exitCode})`);
    }
    await Bun.sleep(25);
  }
  child.kill();
  throw new Error(`fixture ${fixture} did not become ready within ${timeoutMs}ms`);
}

describe("signal shutdown lifecycle", () => {
  it("SIGINT triggers graceful shutdown, exit, and completes < 3000ms", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-signal-sigint-"));
    const marker = path.join(dir, "ready");
    const child = await spawnWithReadyMarker(
      "stdin-shutdown-child.ts",
      path.join(dir, "data"),
      marker,
    );

    const sentAt = Date.now();
    child.kill("SIGINT");

    const code = await child.exited;
    const elapsed = Date.now() - sentAt;

    expect([0, 130]).toContain(code ?? -1);
    expect(elapsed).toBeLessThan(3000);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 40000);

  it("SIGTERM triggers graceful shutdown, exit, and completes < 3000ms", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-signal-sigterm-"));
    const marker = path.join(dir, "ready");
    const child = await spawnWithReadyMarker(
      "stdin-shutdown-child.ts",
      path.join(dir, "data"),
      marker,
    );

    const sentAt = Date.now();
    child.kill("SIGTERM");

    const code = await child.exited;
    const elapsed = Date.now() - sentAt;

    expect([0, 143]).toContain(code ?? -1);
    expect(elapsed).toBeLessThan(3000);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 40000);
});
