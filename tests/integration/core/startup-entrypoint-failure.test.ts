/**
 * Entry-point failure mapping (§3 of the lifecycle hardening work).
 *
 * `src/index.ts` maps a failed `startServer()` to a terminal exit:
 *   ok  -> process.exitCode = 1   (natural exit, nothing unsafe remains)
 *   !ok -> process.exit(1)        (explicit, because unsafe work may remain)
 *
 * This test exercises the REAL production mapping: it runs `src/index.ts` as a
 * child process with `PORT` pointed at a port this test already holds, so
 * `startServer()` rejects at `bindBootPort` and the entry point's `.catch`
 * runs `rollbackPartialStartup()` and applies the mapping. Nothing here copies
 * that logic — the child is the actual entry point, and the parent only
 * observes its exit code and log output.
 *
 * `PORT` is a normal production input (explicit env wins), so forcing the
 * failure needs no test-only seam in the application.
 */
import { describe, it, expect } from "bun:test";
import path from "node:path";
import { REPO_ROOT } from "../../helpers/repo-root";

describe("entry point maps a failed boot to a terminal exit", () => {
  it("exits 1 and logs startup_failed when startServer rejects", async () => {
    // Hold a loopback port so the child's bindBootPort throws EADDRINUSE.
    const holder = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("occupied"),
    });
    const port = holder.port;

    const child = Bun.spawn(["bun", path.join(REPO_ROOT, "src/index.ts")], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutP = new Response(child.stdout).text();
    const stderrP = new Response(child.stderr).text();

    const code = await Promise.race([child.exited, Bun.sleep(30000).then(() => "TIMEOUT")]);
    if (code === "TIMEOUT") {
      child.kill();
      await child.exited;
    }
    holder.stop(true);

    const logs = (await stdoutP) + (await stderrP);
    expect(code).toBe(1);
    // Proves the .catch ran (not an uncaught crash or a hang).
    expect(logs).toContain("startup_failed");
  }, 40000);
});
