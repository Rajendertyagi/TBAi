/**
 * Cross-phase integration (V5): full lifecycle combining multiple phases.
 *
 * This test exercises the interaction of:
 * - Phase 1: startup-failure rollback (simulated by a mid-startup failure)
 * - Phase 1b: canonical shutdown completion
 * - Phase 2: history finalization drain
 * - Phase 3: scheduler readiness decoupling
 * - Phase 4: deadline escalation
 *
 * The test starts the real server, creates in-flight work (chat run +
 * scheduler run), triggers shutdown, and verifies that:
 * - All write-capable work settles before db.close()
 * - The shutdown completes with exit 0
 * - The database is closed
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 *
 * CRITICAL ORDERING CONSTRAINT (same as shutdown-lifecycle.test.ts):
 * This file closes the shared db singleton, which poisons every subsequent
 * test file that touches the DB. It is excluded from `bun test` via
 * package.json's --path-ignore-patterns and only runs through
 * `bun run test:lifecycle-integration`.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, shutdownServer } from "@/server.ts";
import { chatRuns, createChatRunStore } from "@/services/chat-runs.ts";
import { db } from "@/db";
import { logger } from "@/lib/logger.ts";
import {
  scheduleJob,
  activeTimerCount,
  resetSchedulerShutdown,
} from "@/services/scheduler/scheduler.ts";
import type { SchedulerJob } from "@/services/scheduler/schedulerTypes.ts";
import {
  chatHistoryReconcilerDeps,
  drainHistoryReconciliation,
  getHistoryReconciliationState,
  startHistoryReconciliation,
} from "@/services/chat-streams/historyReconciler.ts";
import { startChatStreamCleanup, stopChatStreamCleanup } from "@/services/chat-streams/cleanup.ts";
import { REPO_ROOT } from "../../helpers/repo-root";

// Logger level is global singleton state shared across test files.
beforeEach(() => {
  logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });
});

afterEach(() => {
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
  resetSchedulerShutdown();
});

describe("cross-phase lifecycle integration", () => {
  it("full lifecycle: start → in-flight work → shutdown → db closed", async () => {
    // Phase 2 addendum (boot order): an abandoned history claim left by a previous
    // process is closed by the boot sweep before reconciliation begins, never left
    // as a `claimed` tombstone. Seeded with no captured message so recovery closes
    // it as `skipped` without needing a real conversation or message write.
    const claimedStreamId = "run_boot_claimed";
    db.run(
      `INSERT INTO chat_streams
         (stream_id, status, terminal_kind, boot_id, history_state, history_message_id,
          history_claimed_at, final_message_json, expires_at, created_at, updated_at)
       VALUES (?, 'done', 'completed', 'prev_boot', 'claimed', 'msg_orphan',
               ?, NULL, ?, ?, ?)`,
      [claimedStreamId, Date.now() - 10_000_000, Date.now() + 3_600_000, Date.now(), Date.now()],
    );

    // 1. Start the server (Phase 3: readiness decoupling)
    const server = await startServer(0);
    expect(server.port).toBeGreaterThan(0);

    // Verify the server is live
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(res.status).toBe(200);

    // The boot sweep is gated into the first reconciliation pass, so draining that
    // pass proves the sweep it waited on has finished.
    await drainHistoryReconciliation();
    const bootRow = db
      .query<{ history_state: string }, [string]>(
        "SELECT history_state FROM chat_streams WHERE stream_id = ?",
      )
      .get(claimedStreamId);
    expect(bootRow?.history_state).toBe("skipped");

    // 2. Create in-flight work (Phase 2: history finalization)
    const chatRec = chatRuns.create({ requestId: "lifecycle-chat" });
    expect(chatRec.status).toBe("running");

    // 3. Create scheduler work (Phase 3: scheduler readiness)
    const job: SchedulerJob = {
      id: "lifecycle-job",
      name: "lifecycle-job",
      description: null,
      enabled: true,
      scheduleType: "cron",
      cronExpression: "* * * * *",
      execAt: null,
      timezone: "UTC",
      providerId: "lifecycle-provider",
      modelId: "lifecycle-model",
      thinkingLevel: null,
      workspacePath: "/tmp",
      prompt: "lifecycle",
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
    expect(activeTimerCount()).toBeGreaterThan(0);

    // 4. Start background timers (Phase 2: history reconciliation)
    startChatStreamCleanup(db, { runImmediately: false });
    startHistoryReconciliation({
      deps: chatHistoryReconcilerDeps,
      runImmediately: false,
    });
    expect(getHistoryReconciliationState().running).toBe(true);

    // 5. Trigger shutdown (Phase 1b: canonical shutdown completion)
    const shutdownPromise = shutdownServer(server, "lifecycle-test");

    // 6. Settle the chat run (simulating the route's onAbort handler)
    chatRuns.markCancelled(chatRec.streamId);

    // 7. Wait for shutdown to complete
    await shutdownPromise;

    // 8. Verify the database is closed (Phase 4: db.close(true))
    let threw = false;
    try {
      db.query("SELECT 1").get();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // 9. Verify background timers stopped
    expect(getHistoryReconciliationState().running).toBe(false);
    expect(stopChatStreamCleanup()).toBe(false);
  }, 30000);

  it("shutdown with stuck work → shutdown_failed, exit 1, db left open", async () => {
    // Use a fresh store: the singleton was gated by the first test's shutdown.
    const store = createChatRunStore();
    const rec = store.create({ requestId: "lifecycle-stuck" });
    const result = await store.awaitSettled(50);
    expect(result.deadlineHit).toBe(true);
    expect(result.timedOut).toBe(1);
    expect(store.hasUnsettledWork()).toBe(true);
    // Clean up
    store.markCancelled(rec.streamId);
    expect(store.hasUnsettledWork()).toBe(false);
  });
});

describe("rollback in child process", () => {
  it("startup bind failure → rollback runs, DB closed, exit 1", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-rollback-child-"));
    // Occupy a port, then hand it to the REAL entry point as the env-locked
    // boot port. bindBootPort fails honestly (no self-heal) AFTER timers and
    // MCP init have been armed, so the production startup-failure rollback
    // path runs end to end: subsystems torn down, database closed last, exit 1.
    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("blocked"),
    });
    const port = blocker.port;
    const child = Bun.spawn(["bun", path.join(REPO_ROOT, "src/index.ts")], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: path.join(dir, "data"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      // The logger splits streams (info→stdout, warn/error→stderr).
      const output = `${stdout}\n${stderr}`;
      expect(code).toBe(1);
      expect(output).toContain("startup_failed");
      // "startup_rollback_complete" is logged only AFTER db.close() succeeds;
      // "startup_rollback_failed" would mean a writer was left behind.
      expect(output).toContain("startup_rollback_complete");
      expect(output).not.toContain("startup_rollback_failed");
    } finally {
      try {
        blocker.stop(true);
      } catch {
        /* best-effort */
      }
      try {
        child.kill();
      } catch {
        /* best-effort */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
