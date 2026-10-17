/**
 * Descendant-process cleanup, characterized (§5).
 *
 * Tauri stops the sidecar in two ways (src-tauri/src/main.rs `quit_owned`):
 * a graceful handshake — write `{"type":"shutdown"}\n` to its stdin and wait up
 * to 3000 ms — and, if that does not settle, `child.kill()`.
 *
 * The open question §5 asked: with `child.kill()` no cleanup code runs in the
 * sidecar, so do the processes the sidecar spawned (MCP stdio children today;
 * the managed OpenCode child when it is used) survive it as orphans?
 *
 * Measured (2026-10-17, Windows, Bun 1.4.3): they do NOT. Both cases below hold:
 *
 *   - graceful: `mcpManager.disconnectAll()` closes the transport and the child
 *     dies with it — the shipped shutdown path;
 *   - forced:   the sidecar stand-in is terminated with no cleanup at all, and
 *     the child it spawned dies anyway.
 *
 * The mechanism is that Bun binds a spawned child to its parent's lifetime and
 * a child opts out only with `detached: true`. Nothing in `src/` spawns detached
 * on Windows (`services/opencode/serverManager.ts` sets `detached` for POSIX
 * only; the MCP SDK's stdio transport does not set it at all), so the sidecar's
 * children cannot outlive it. An external `taskkill /F` of the parent reproduces
 * the same result as Bun's own `kill()`, which is why it applies to the Rust
 * fallback and not only to Bun-to-Bun kills.
 *
 * Consequence recorded in docs/decisions.md (2026-10-17): no Windows Job Object
 * or process-tree termination is needed for the sidecar's children, and adding
 * one in the Rust shell would be unverifiable from here. The case is still worth
 * pinning: a `detached` spawn added to either engine would turn the orphan into a
 * real leak, and this test is what fails when that happens.
 *
 * Nothing here touches the repository database: DATA_DIR is the per-file test
 * sandbox, and the child fixture refuses to run without it.
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "../../helpers/repo-root";

const FIXTURE = "tests/fixtures/sidecar-descendant-child.ts";
const PROBE_SERVER = path.join(REPO_ROOT, "tests/fixtures/descendant-probe-server.ts");

async function waitForFile(file: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await Bun.sleep(20);
  }
  return false;
}

/** A live descendant answers on the port it reported; a dead one cannot. */
async function descendantAlive(port: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return res.ok && (await res.text()) === "alive";
  } catch {
    return false;
  }
}

/** Last resort cleanup so a failed case cannot leave an orphan behind. */
async function killDescendant(pid: string): Promise<void> {
  try {
    process.kill(Number(pid));
  } catch {
    /* already gone */
  }
  if (process.platform === "win32") {
    try {
      Bun.spawnSync(["taskkill", "/F", "/PID", pid], { stdout: "ignore", stderr: "ignore" });
    } catch {
      /* best-effort */
    }
  }
}

/** Spawn the sidecar stand-in and wait until its MCP child reports itself. */
async function startSidecarStandIn(mode: string): Promise<{
  child: ReturnType<typeof Bun.spawn>;
  dir: string;
  marker: string;
  ready: string;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-descendant-"));
  const marker = path.join(dir, "grandchild");
  const ready = path.join(dir, "ready");
  const child = Bun.spawn(["bun", path.join(REPO_ROOT, FIXTURE)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TBAI_DESCENDANT_MARKER: marker,
      TBAI_DESCENDANT_READY: ready,
      TBAI_DESCENDANT_PROBE: PROBE_SERVER,
      TBAI_DESCENDANT_MODE: mode,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const spawned = await waitForFile(marker);
  const announced = await waitForFile(ready);
  expect({ spawned, announced }).toEqual({ spawned: true, announced: true });
  return { child, dir, marker, ready };
}

describe("descendant-process cleanup", () => {
  it("graceful shutdown (disconnectAll) takes the spawned MCP child with it", async () => {
    // The shipped path: the sidecar receives the stdin shutdown command and
    // runs its own cleanup, which closes every MCP transport.
    const { child, dir, marker } = await startSidecarStandIn("graceful");
    const [pid, port] = fs.readFileSync(marker, "utf8").trim().split(":");

    expect(await descendantAlive(port)).toBe(true);
    const code = await child.exited;
    expect(code).toBe(0);

    try {
      // The transport closed, so the child it spawned is gone.
      expect(await descendantAlive(port)).toBe(false);
    } finally {
      await killDescendant(pid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  // Windows only, and deliberately so: the measurement below is Bun's
  // Windows parent-lifetime binding (a job object), which is what makes the
  // sidecar's children die with it. Nothing has been measured on POSIX, where
  // that binding may not exist and the detached OpenCode child is a separate
  // design — asserting an unmeasured result there would be worse than scoping
  // the claim to where it was observed. CI runs this suite on windows-latest.
  it.skipIf(process.platform !== "win32")(
    "a forced kill (Child::kill) ALSO takes the spawned MCP child with it — no orphan",
    async () => {
      const { child, dir, marker } = await startSidecarStandIn("wait");
      const [pid, port] = fs.readFileSync(marker, "utf8").trim().split(":");
      expect(await descendantAlive(port)).toBe(true);

      try {
        // Exactly what Tauri's 3000 ms fallback does: terminate the sidecar with
        // no chance to run cleanup.
        child.kill();
        await child.exited;

        // The safety property §5 asked about: the sidecar's spawned child does
        // not survive it. Fails if a `detached` spawn is ever introduced (header).
        expect(await descendantAlive(port)).toBe(false);
      } finally {
        await killDescendant(pid);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    30000,
  );
});
