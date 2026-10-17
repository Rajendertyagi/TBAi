/**
 * Desktop stdin shutdown (V3): Tauri writes {"type":"shutdown"} to the
 * sidecar's stdin. The backend reads it (services/desktop-stdin) and runs
 * shutdownServer("STDIN_SHUTDOWN").
 *
 * These tests run in isolated child processes because they start the real
 * server and trigger a real shutdown. The parent asserts the exit code and the
 * log lines. Note the logger splits streams: info/debug go to stdout,
 * warn/error to stderr, so assertions read BOTH.
 *
 * V3c (the Rust-side 3,000 ms kill fallback) cannot be exercised from the
 * backend alone; it is covered by the Rust side, not here.
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "../../helpers/repo-root";

/**
 * Spawn a stdin fixture with a ready marker and wait for the marker before the
 * caller acts — so the server is bound and the reader is live deterministically,
 * never on a fixed sleep.
 */
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

/** Fully-piped child: stdin/stdout/stderr are all pipes (inferred precisely). */
type PipeChild = Awaited<ReturnType<typeof spawnWithReadyMarker>>;

/** Read both piped streams; the logger splits info→stdout, warn/error→stderr. */
async function readOutput(child: PipeChild): Promise<string> {
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return `${out}\n${err}`;
}

describe("desktop stdin shutdown", () => {
  it('graceful: {"type":"shutdown"} on stdin → shutdown_complete, exit 0, promptly', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-stdin-shutdown-"));
    const marker = path.join(dir, "ready");
    const child = await spawnWithReadyMarker(
      "stdin-shutdown-child.ts",
      path.join(dir, "data"),
      marker,
    );

    const sentAt = Date.now();
    child.stdin.write('{"type":"shutdown"}\n');
    child.stdin.end();

    const code = await child.exited;
    const output = await readOutput(child);
    const elapsed = Date.now() - sentAt;

    expect(code).toBe(0);
    expect(output).toContain("STDIN_SHUTDOWN");
    expect(output).toContain("shutdown_complete");
    // Verified against Rust's 3,000 ms SHUTDOWN_TIMEOUT:
    expect(elapsed).toBeLessThan(3000);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 40000);

  it('graceful with stdin pipe left open: {"type":"shutdown"} → reader cancelled, exit 0, < 3000ms', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-stdin-open-pipe-"));
    const marker = path.join(dir, "ready");
    const child = await spawnWithReadyMarker(
      "stdin-shutdown-child.ts",
      path.join(dir, "data"),
      marker,
    );

    const sentAt = Date.now();
    // Tauri does NOT close stdin; it writes the command and leaves the pipe open
    child.stdin.write('{"type":"shutdown"}\n');
    child.stdin.flush();

    const code = await child.exited;
    const output = await readOutput(child);
    const elapsed = Date.now() - sentAt;

    expect(code).toBe(0);
    expect(output).toContain("STDIN_SHUTDOWN");
    expect(output).toContain("shutdown_complete");
    expect(elapsed).toBeLessThan(3000);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 40000);

  it("stuck operation → shutdown_failed, exit 1 (database left open)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-stdin-timeout-"));
    const marker = path.join(dir, "ready");
    const child = await spawnWithReadyMarker(
      "stdin-timeout-child.ts",
      path.join(dir, "data"),
      marker,
    );

    child.stdin.write('{"type":"shutdown"}\n');
    child.stdin.end();

    const code = await child.exited;
    const output = await readOutput(child);

    // The stuck run means the spine cannot complete gracefully: it fails the
    // shutdown and exits non-zero rather than closing the database.
    expect(code).toBe(1);
    expect(output).toContain("STDIN_SHUTDOWN");
    expect(output).toContain("shutdown_failed");
    expect(output).not.toContain("shutdown_complete");
    fs.rmSync(dir, { recursive: true, force: true });
  }, 40000);

  it("EOF on stdin → backend does NOT shut down", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-stdin-eof-"));
    const marker = path.join(dir, "ready");
    const child = await spawnWithReadyMarker("stdin-eof-child.ts", path.join(dir, "data"), marker);

    // Close stdin without sending a shutdown command: EOF must be ignored.
    child.stdin.end();
    await Bun.sleep(1500);
    expect(child.exitCode).toBeNull();

    child.kill();
    await child.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }, 40000);
});
