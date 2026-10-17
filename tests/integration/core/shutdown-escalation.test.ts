/**
 * Shutdown escalation (V1): the spine distinguishes three outcomes —
 * shutdown_complete (all write-capable work stopped within the deadline),
 * shutdown_deadline_expired (stopped afterward but before database closure),
 * and shutdown_failed (work may still be active: no close, exit 1).
 *
 * The classification itself is a pure function (fully deterministic). The
 * failed path is proven end-to-end in an isolated child process, because it
 * terminates its own process. This file never closes the shared db singleton
 * and runs in the default suite with no exclusion.
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatRuns } from "@/services/chat-runs.ts";
import { classifyShutdownCompletion } from "@/server.ts";
import { REPO_ROOT } from "../../helpers/repo-root";

describe("shutdown outcome classification", () => {
  it("truth table", () => {
    expect(
      classifyShutdownCompletion({
        deadlineHit: false,
        writeCapableActive: false,
        cleanupFailed: false,
      }),
    ).toBe("complete");
    expect(
      classifyShutdownCompletion({
        deadlineHit: true,
        writeCapableActive: false,
        cleanupFailed: false,
      }),
    ).toBe("deadline_expired");
    expect(
      classifyShutdownCompletion({
        deadlineHit: false,
        writeCapableActive: true,
        cleanupFailed: false,
      }),
    ).toBe("failed");
    expect(
      classifyShutdownCompletion({
        deadlineHit: true,
        writeCapableActive: true,
        cleanupFailed: false,
      }),
    ).toBe("failed");
    expect(
      classifyShutdownCompletion({
        deadlineHit: false,
        writeCapableActive: false,
        cleanupFailed: true,
      }),
    ).toBe("failed");
    expect(
      classifyShutdownCompletion({
        deadlineHit: true,
        writeCapableActive: true,
        cleanupFailed: true,
      }),
    ).toBe("failed");
  });

  // `cleanupFailed: false` below is the value the real spine must supply for
  // late-settling work; "our run settles after its bound" in the child-process
  // suite proves the spine does, rather than assuming it here.
  it("deadline fires, work settles late, re-check is clean → deadline_expired", async () => {
    const rec = chatRuns.create({ requestId: "late-settle" });
    const result = await chatRuns.awaitSettled(100);
    expect(result.deadlineHit).toBe(true);
    expect(result.timedOut).toBe(1);
    // Settles "afterward": after the bound fired, before any database closure.
    chatRuns.markCancelled(rec.streamId);
    expect(chatRuns.hasUnsettledWork()).toBe(false);
    expect(
      classifyShutdownCompletion({
        deadlineHit: result.deadlineHit,
        writeCapableActive: chatRuns.hasUnsettledWork(),
        cleanupFailed: false,
      }),
    ).toBe("deadline_expired");
  });

  it("deadline fires, work still active → failed", async () => {
    const rec = chatRuns.create({ requestId: "stuck-in-process" });
    const result = await chatRuns.awaitSettled(100);
    expect(result.deadlineHit).toBe(true);
    expect(chatRuns.hasUnsettledWork()).toBe(true);
    expect(
      classifyShutdownCompletion({
        deadlineHit: result.deadlineHit,
        writeCapableActive: chatRuns.hasUnsettledWork(),
        cleanupFailed: false,
      }),
    ).toBe("failed");
    chatRuns.markCancelled(rec.streamId);
    expect(chatRuns.hasUnsettledWork()).toBe(false);
  });

  it("all stopped within deadline → complete", async () => {
    const rec = chatRuns.create({ requestId: "v1a-clean" });
    chatRuns.markCancelled(rec.streamId);
    const result = await chatRuns.awaitSettled(1000);
    expect(result.deadlineHit).toBe(false);
    expect(result.timedOut).toBe(0);
    expect(chatRuns.hasUnsettledWork()).toBe(false);
    expect(
      classifyShutdownCompletion({
        deadlineHit: result.deadlineHit,
        writeCapableActive: chatRuns.hasUnsettledWork(),
        cleanupFailed: false,
      }),
    ).toBe("complete");
  });

  it("scheduler stuck → failed", async () => {
    const { setSetupDelayHook, abortAllRuns, hasPendingRuns, runJobNow } = await import(
      "@/services/scheduler/scheduler.ts"
    );
    const { schedulerStore } = await import("@/services/scheduler/schedulerStore.ts");
    // Never resolves: the setup phase hangs forever
    setSetupDelayHook(() => new Promise(() => {}));
    try {
      const job = schedulerStore.create({
        name: "stuck-job",
        enabled: true,
        scheduleType: "cron",
        cronExpression: "* * * * *",
        timezone: "UTC",
        providerId: "test-provider",
        modelId: "test-model",
        workspacePath: "/tmp",
        prompt: "test",
        conversationPolicy: "dedicated_thread",
      });
      // runJobNow will hang on the setup delay hook — don't await it
      void runJobNow(job.id);
      // Give it a moment to start and get stuck
      await Bun.sleep(100);
      // Now abort with a short timeout
      const result = await abortAllRuns(50);
      expect(result.deadlineHit).toBe(true);
      expect(result.timedOut).toBeGreaterThan(0);
      expect(hasPendingRuns()).toBe(true);
      expect(
        classifyShutdownCompletion({
          deadlineHit: result.deadlineHit,
          writeCapableActive: hasPendingRuns(),
          cleanupFailed: false,
        }),
      ).toBe("failed");
    } finally {
      setSetupDelayHook(null);
    }
  });
});

describe("shutdown escalation in a child process", () => {
  it("stuck run → shutdown_failed, exit 1, database left open", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-escalation-"));
    const marker = path.join(dir, "db-state");
    const child = Bun.spawn(
      ["bun", path.join(REPO_ROOT, "tests/fixtures/shutdown-failed-child.ts")],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DATA_DIR: path.join(dir, "data"),
          TBAI_SHUTDOWN_MARKER: marker,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).toContain("shutdown_failed");
    expect(stderr).not.toContain("shutdown_complete");
    expect(fs.readFileSync(marker, "utf8")).toBe("open");
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30000);

  // The V1 re-check exists for exactly this case: a bound fired (so the run was
  // running when the deadline expired) and the run then stopped before the
  // close decision. Stamping the bound as a cleanup failure would make this
  // indistinguishable from the case above — same exit code, same open database —
  // which is what the fixture's own park makes observable rather than likely.
  it("run settles after its bound, before the close decision → deadline_expired, exit 0, database closed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-late-settle-"));
    const marker = path.join(dir, "db-state");
    const child = Bun.spawn(
      ["bun", path.join(REPO_ROOT, "tests/fixtures/shutdown-late-settle-child.ts")],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DATA_DIR: path.join(dir, "data"),
          TBAI_SHUTDOWN_MARKER: marker,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(code).toBe(0);
    expect(stderr).toContain("shutdown_deadline_expired");
    expect(stderr).not.toContain("shutdown_failed");
    expect(stdout).not.toContain("shutdown_complete");
    expect(fs.readFileSync(marker, "utf8")).toBe("closed");
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60000);
});
