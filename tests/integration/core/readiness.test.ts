/**
 * Scheduler readiness decoupling: the HTTP listener binds before overdue
 * one-time job execution, and scheduler-dependent routes wait for essential
 * recovery.
 *
 * Two contracts, two cases:
 * - (a) A slow (blackhole) overdue job must not delay the bind: the listener
 *   becomes reachable well before startServer resolves.
 * - (b) Scheduler routes 503 until essential recovery completes, so no request
 *   observes partially initialized scheduler state.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 * This file never closes the shared db singleton and stops only the listener
 * afterwards, so it runs in the default suite with no exclusion.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { Hono } from "hono";
import { startServer } from "@/server.ts";
import { getActiveServer } from "@/services/server-listener.ts";
import { isSchedulerReady, setSchedulerReady } from "@/services/scheduler/scheduler.ts";
import { schedulerStore } from "@/services/scheduler/schedulerStore.ts";
import { getWorkspaceDir } from "@/services/tools.ts";
import { logger } from "@/lib/logger.ts";
import providersApp from "@/routes/providers.ts";
import schedulerApp from "@/routes/scheduler.ts";

const providerApp = new Hono();
providerApp.route("/", providersApp);

logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });

// Black-hole provider endpoint: accepts the model request, never responds.
let blackhole: ReturnType<typeof Bun.serve> | null = null;
let blackholePort = 0;

async function startBlackhole(): Promise<number> {
  blackhole = Bun.serve({
    port: 0,
    fetch() {
      return new Promise<Response>(() => {});
    },
  });
  blackhole.unref();
  blackholePort = blackhole.port;
  return blackholePort;
}

afterAll(() => {
  try {
    blackhole?.stop(true);
  } catch {
    /* already closed */
  }
  blackhole = null;
});

async function seedBlackholeProvider(): Promise<string> {
  const port = blackholePort || (await startBlackhole());
  const endpoint = `http://127.0.0.1:${port}`;
  const res = await providerApp.request("/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "blackhole-ready", type: "ollama", endpoint, model: "void" }),
  });
  expect(res.status).toBe(200);
  const created = (await res.json()) as { id: string };
  return created.id;
}

describe("scheduler readiness", () => {
  it("scheduler routes 503 until essential recovery completes", async () => {
    setSchedulerReady(false);
    expect(isSchedulerReady()).toBe(false);
    const gated = await schedulerApp.request("/jobs");
    expect(gated.status).toBe(503);
    setSchedulerReady(true);
    expect(isSchedulerReady()).toBe(true);
    const open = await schedulerApp.request("/jobs");
    expect(open.status).toBe(200);
  });

  it("listener becomes reachable before overdue job execution completes", async () => {
    const providerId = await seedBlackholeProvider();
    // Overdue by 60s: inside the 600s grace window, so recovery executes it
    // (slowly, against the blackhole) instead of marking it missed.
    schedulerStore.create({
      name: "readiness-overdue",
      scheduleType: "once",
      execAt: Date.now() - 60_000,
      timezone: "UTC",
      providerId,
      modelId: "void",
      workspacePath: getWorkspaceDir(),
      prompt: "readiness",
      maxRetries: 0,
      timeoutSeconds: 5,
      missedGraceSeconds: 600,
    });

    const started = startServer(0);
    // Poll until the listener answers: the bind must not wait on the
    // overdue execution still running inside startServer. getActivePort
    // reports the requested port (0 here), so read the bound port off the
    // live server object instead.
    let reachableAt = 0;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const port = getActiveServer()?.port ?? 0;
      if (port > 0) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/healthz`);
          if (res.status === 200) {
            reachableAt = Date.now();
            break;
          }
        } catch {
          /* not up yet */
        }
      }
      await Bun.sleep(50);
    }
    expect(reachableAt).toBeGreaterThan(0);

    // startServer resolves only after the overdue execution settles (the
    // blackhole hangs until the 5s job timeout aborts it).
    await started;
    const resolvedAt = Date.now();
    expect(resolvedAt - reachableAt).toBeGreaterThan(2000);

    // Stop only the listener: the DB stays open so the suite is unaffected.
    try {
      await getActiveServer()?.stop(true);
    } catch {
      /* already stopped */
    }
  }, 30000);
});
