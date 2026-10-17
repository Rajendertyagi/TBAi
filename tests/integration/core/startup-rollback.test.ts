/**
 * Startup-failure rollback: a failed startServer attempt releases everything
 * it acquired.
 *
 * The defect this pins: `startServer` awaited MCP init (which spawns stdio
 * children fire-and-forget), scheduler recovery, and the listener bind with
 * no rollback path. If any step rejected, `index.ts` set `exitCode = 1` and
 * `shutdownServer` never ran — spawned children and armed timers had no
 * cleanup path.
 *
 * What this proves, through the real public seam (`rollbackPartialStartup`
 * over a real MCP child, real scheduler/Bun.cron timers, a real bound
 * listener, and the real SQLite singleton):
 * - an in-flight MCP connect settles (invalidated, not deadlocked) and its
 *   child is reaped — no reconnect resurrects it afterwards;
 * - scheduler timers are cleared and the gate refuses new work;
 * - the bound listener stops;
 * - background timers stop;
 * - the database closes last.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 *
 * CRITICAL ORDERING CONSTRAINT (same as shutdown-lifecycle.test.ts):
 * This file closes the shared db singleton, which poisons every subsequent
 * test file that touches the DB. It is excluded from `bun test` via
 * package.json's --path-ignore-patterns and only runs through
 * `bun run test:startup-rollback`.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { rollbackPartialStartup } from "@/server.ts";
import { mcpManager } from "@/services/mcp/manager.ts";
import { db } from "@/db";
import { logger } from "@/lib/logger.ts";
import {
  scheduleJob,
  activeTimerCount,
  resetSchedulerShutdown,
  runJobNow,
} from "@/services/scheduler/scheduler.ts";
import type { SchedulerJob } from "@/services/scheduler/schedulerTypes.ts";
import { startChatStreamCleanup, stopChatStreamCleanup } from "@/services/chat-streams/cleanup.ts";
import {
  chatHistoryReconcilerDeps,
  startHistoryReconciliation,
  getHistoryReconciliationState,
} from "@/services/chat-streams/historyReconciler.ts";
import { initListenerFetch, bindBootPort } from "@/services/server-listener.ts";
import { REPO_ROOT } from "../../helpers/repo-root";

// Logger level is global singleton state shared across test files.
beforeEach(() => {
  logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });
});

afterEach(() => {
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
  resetSchedulerShutdown();
});

/** Unique marker path per case, so cases cannot wait on each other's child. */
function markerPath(name: string): string {
  return path.join(REPO_ROOT, "tests/.artifacts", `${name}-marker`);
}

/** Status of one server via the in-memory map (no database access). */
function liveStatusOf(id: string): string {
  return mcpManager.getConnectionStatus(id);
}

/**
 * Wait until `id` reports `want`, or give up.
 *
 * Condition-based rather than a fixed sleep: `connect()` registers its entry
 * before spawning the transport, so "status is connecting" is proof the
 * attempt holds a generation and is parked inside the handshake.
 */
async function waitForStatus(id: string, want: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (liveStatusOf(id) === want) return true;
    await Bun.sleep(20);
  }
  return false;
}

async function waitForMarker(marker: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(marker)) return true;
    await Bun.sleep(20);
  }
  return false;
}

describe("startup-failure rollback", () => {
  it("releases an in-flight MCP connect, timers, listener, and the DB", async () => {
    // 1. An MCP connect parked mid-handshake: the silent child reads the
    // request and never answers, so client.connect() stays pending.
    const requested = markerPath("rollback-requested");
    const spawned = markerPath("rollback-spawned");
    const created = mcpManager.createConfig({
      name: "rollback-silent",
      transport: "stdio",
      command: "bun",
      args: ["run", path.join(REPO_ROOT, "tests/fixtures/silent-mcp-server.ts")],
      env: {
        TBAI_SILENT_MCP_SPAWNED: spawned,
        TBAI_SILENT_MCP_REQUESTED: requested,
      },
      enabled: true,
      autoConnect: false,
    });
    const mcpId = created.id;
    try {
      void mcpManager.connect(mcpId);
      expect(await waitForMarker(requested)).toBe(true);
      expect(await waitForStatus(mcpId, "connecting")).toBe(true);
      expect(mcpManager.hasInflightConnects()).toBe(true);

      // 2. An armed scheduler timer, so the rollback has something to clear.
      const job: SchedulerJob = {
        id: "rollback-job",
        name: "rollback-job",
        description: null,
        enabled: true,
        scheduleType: "cron",
        cronExpression: "* * * * *",
        execAt: null,
        timezone: "UTC",
        providerId: "rollback-provider",
        modelId: "rollback-model",
        thinkingLevel: null,
        workspacePath: "/tmp",
        prompt: "rollback",
        conversationPolicy: "dedicated_thread",
        conversationId: null,
        overlapPolicy: "skip_if_running",
        maxRetries: 0,
        retryDelaySeconds: 60,
        timeoutSeconds: 60,
        missedGraceSeconds: 60,
        nextRunAt: null,
        lastRunAt: null,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      scheduleJob(job);
      expect(activeTimerCount()).toBe(1);

      // 3. Background timers, as startServer would have started them.
      startChatStreamCleanup(db, { runImmediately: false });
      startHistoryReconciliation({
        deps: chatHistoryReconcilerDeps,
        runImmediately: false,
      });
      expect(getHistoryReconciliationState().running).toBe(true);

      // 4. A bound listener, as startServer would have bound it.
      initListenerFetch(() => new Response("ok"));
      const bound = bindBootPort(0);
      const boundPort = bound.server.port;
      expect(boundPort).toBeGreaterThan(0);
      const live = await fetch(`http://127.0.0.1:${boundPort}/healthz`);
      expect(live.status).toBe(200);

      // 5. The failed attempt rolls back.
      const result = await rollbackPartialStartup();
      expect(result.ok).toBe(true);
      expect(result.dbClosed).toBe(true);

      // MCP: the attempt was invalidated and its transport closed. Its
      // promise may dangle — the SDK does not guarantee connect() settles
      // after close() mid-handshake — but it is inert: every connect()
      // mutation is generation-gated and performs no SQLite writes, so a
      // resumed attempt abandons without touching shared state. What proves
      // cleanup is the disconnected entry (read without the closed DB) plus
      // no reconnect resurrection: a fired timer would spawn a new child,
      // which would rewrite the spawned marker the fixture cleared at boot.
      expect(liveStatusOf(mcpId)).toBe("disconnected");
      try {
        if (existsSync(spawned)) rmSync(spawned);
      } catch {
        /* best-effort */
      }
      await Bun.sleep(6000);
      expect(liveStatusOf(mcpId)).toBe("disconnected");
      expect(existsSync(spawned)).toBe(false);

      // Scheduler: timers cleared and the gate refuses new work.
      expect(activeTimerCount()).toBe(0);
      expect(await runJobNow("rollback-job")).toEqual({
        error: "Server is shutting down",
      });

      // Listener: stopped — the port refuses connections.
      let fetchThrew = false;
      try {
        await fetch(`http://127.0.0.1:${boundPort}/healthz`);
      } catch {
        fetchThrew = true;
      }
      expect(fetchThrew).toBe(true);

      // Background timers: stopped.
      expect(getHistoryReconciliationState().running).toBe(false);
      expect(stopChatStreamCleanup()).toBe(false);

      // Database: closed last.
      let threw = false;
      try {
        db.query("SELECT 1").get();
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      try {
        mcpManager.deleteConfig(mcpId);
      } catch {
        /* already cleaned up */
      }
      for (const marker of [requested, spawned]) {
        try {
          if (existsSync(marker)) rmSync(marker);
        } catch {
          /* best-effort */
        }
      }
    }
  }, 30000);
});

/**
 * §7: the deadline path, which the case above never reaches (there, every
 * tracked operation settles).
 *
 * Rollback's classification is deliberately CONSERVATIVE and differs from
 * normal shutdown: a fired bound is terminal, because startup is aborting
 * anyway and closing a database a just-settling write might still touch is the
 * unsafe choice. Normal shutdown instead re-checks outstanding work and closes
 * when the re-check is clean — same sequence, opposite decision. Both halves are
 * pinned: the shutdown half in tests/integration/core/shutdown-escalation.test.ts
 * ("run settles after its bound, before the close decision"), the rollback half
 * here, in a child process because the case closes (or refuses to close) and
 * write-probes the shared database singleton.
 */
describe("startup rollback deadline behaviour", () => {
  interface RollbackDeadlineFixture {
    result: { ok: boolean; dbClosed: boolean; timedOut: boolean };
    elapsedMs: number;
    lateWrite: string;
    unsettledAfterSettle: boolean;
  }

  it("keeps the database open when a run outlives the deadline; the late writer still writes", async () => {
    // The fixture writes to the shared database, so DATA_DIR must be the
    // per-file sandbox. Without it the fixture refuses (exit 3) rather than
    // touch a real install; this assertion fails first, with a clearer reason.
    expect(process.env.DATA_DIR ?? "").toContain("tbai-test");

    const child = Bun.spawn(
      ["bun", path.join(REPO_ROOT, "tests/fixtures/rollback-deadline-child.ts")],
      {
        cwd: REPO_ROOT,
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    const line = stdout.split("\n").find((l) => l.startsWith("ROLLBACK_DEADLINE "));
    if (!line) {
      throw new Error(`fixture produced no result line.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    const payload = JSON.parse(line.slice("ROLLBACK_DEADLINE ".length)) as RollbackDeadlineFixture;

    expect(code).toBe(0);
    // Unsettled at the deadline → not ok, database NOT closed, caller must exit 1.
    expect(payload.result).toEqual({ ok: false, dbClosed: false, timedOut: true });
    // The bound really expired (~10 s): this is the deadline, not an early return.
    expect(payload.elapsedMs).toBeGreaterThanOrEqual(10000);
    expect(payload.elapsedMs).toBeLessThan(25000);
    // The run settled afterwards, so the write probe below is a genuine late write
    // against a database rollback declined to close — not a still-running record.
    expect(payload.unsettledAfterSettle).toBe(false);
    expect(payload.lateWrite).toBe("ok");
    // The terminal branch announces itself on stderr (the caller's cue to exit 1).
    expect(stderr).toContain("startup_rollback_failed");
    expect(stderr).toContain("timedOut");
  }, 40000);
});
