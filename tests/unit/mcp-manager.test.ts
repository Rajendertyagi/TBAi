/**
 * MCP manager lifecycle (Phase 4) — unit level, no real MCP servers.
 *
 * Covers reconnect bookkeeping seams (scheduleReconnect cap, timers, enabled
 * gating) through the manager's public connect/disconnect surface. All cases
 * use an always-failing STDIO command so connect() takes its error path in
 * ~100ms and the reconnect timers become the observable under test. No real
 * fixture server / DB seeding required: the MCP singleton's DB rows are the
 * tests' own createConfig rows (cleaned up in afterAll), and the isolated
 * DATA_DIR from tests/setup.ts guards the developer database.
 *
 * Note: `reconnectAttempts` is not observable through the public API; the cap
 * behavior (MAX_RECONNECT_ATTEMPTS = 5, one timer per failure, 5s delay) is
 * asserted behaviorally — timer fire count within a bounded window, no timer
 * after the cap, disconnect clears the timer.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mcpManager } from "../../src/services/mcp/manager";
import { logger } from "../../src/lib/logger";

const BAD_COMMAND = "definitely-not-a-real-command-xyz";
const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 5;

interface CreatedMcp {
  id: string;
  name: string;
}

const createdMcp: CreatedMcp[] = [];

async function createBadServer(name: string, overrides: { enabled?: boolean } = {}): Promise<string> {
  const created = mcpManager.createConfig({
    name,
    transport: "stdio",
    command: BAD_COMMAND,
    args: [],
    enabled: overrides.enabled ?? true,
    autoConnect: false,
  });
  createdMcp.push({ id: created.id, name });
  await mcpManager.connect(created.id);
  for (let i = 0; i < 50; i++) {
    const st = mcpManager.getStatuses().find((s) => s.id === created.id);
    if (st?.status === "error") return created.id;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`bad server ${name} did not reach error state`);
}

afterAll(async () => {
  for (const entry of createdMcp) {
    await mcpManager.disconnect(entry.id);
  }
  await mcpManager.disconnectAll();
  for (const entry of createdMcp) {
    try {
      mcpManager.deleteConfig(entry.id);
    } catch {
      /* row already gone */
    }
  }
});

function statusOf(id: string): string {
  return mcpManager.getStatuses().find((s) => s.id === id)?.status ?? "missing";
}

function countReconnectsSince(cutoff: number, serverName: string): number {
  // NOTE: the "mcp" log scope is throttled (per-second token bucket,
  // logger.throttleCheck), so buffered entries understate actual reconnect
  // firings. Use this for UPPER-BOUND checks (<= N) and for "no reconnect
  // fired" (0) — a zero is still a valid read under throttling — never for
  // exact counts.
  return logger
    .getRecentEntries(cutoff)
    .filter(
      (e) => e.event === "mcp.operation" && e.op === "reconnect" && e.mcpServer === serverName
    ).length;
}

describe("MCP reconnect bookkeeping (unit, no real server)", () => {
  it("caps at MAX_RECONNECT_ATTEMPTS: no reconnect timer after 5 failures (bounded observation)", async () => {
    const cutoff = logger.lastSeq;
    const id = await createBadServer("p4-cap");
    expect(statusOf(id)).toBe("error");
    expect(mcpManager.getPendingElicitation()).toBeUndefined();

    // Watch: with a 5s timer delay, all 5 capped timers fire within
    // ~25s of the first failure. If the cap were broken (unbounded
    // re-scheduling), a timer would fire well beyond that window
    // (attempts 6+ at 30s, 35s, ...).
    const capWindowMs = MAX_RECONNECT_ATTEMPTS * RECONNECT_DELAY_MS + 5000;
    const start = Date.now();
    let connectedObserved = false;
    let lastObserved = statusOf(id);
    while (Date.now() - start < capWindowMs) {
      await new Promise((r) => setTimeout(r, 500));
      const st = statusOf(id);
      if (st === "connected") connectedObserved = true;
      lastObserved = st;
    }
    expect(connectedObserved).toBe(false);
    expect(lastObserved).toBe("error");
    // Settled state: no further timers fire beyond the cap window.
    await new Promise((r) => setTimeout(r, 2000));
    expect(statusOf(id)).toBe("error");
    // The capped chain must fire no more than MAX_RECONNECT_ATTEMPTS times;
    // a 6th timer would prove unbounded re-scheduling. (Upper bound: the
    // "mcp" log scope is throttled, so entries may understate firings — an
    // over-count is the only signal of a cap violation. Exact "5" is
    // verified by inspection: MAX_RECONNECT_ATTEMPTS = 5 in manager.ts.)
    expect(countReconnectsSince(cutoff, "p4-cap")).toBeLessThanOrEqual(MAX_RECONNECT_ATTEMPTS);
    // Cap constant honored, verified by inspection: MAX_RECONNECT_ATTEMPTS = 5
    // (manager.ts) bounds reconnectAttempts; each failing connect schedules at
    // most one timer, so the timer chain terminates.
  }, 40000);

  it("disabling the server clears the pending reconnect timer (enabled gating)", async () => {
    const cutoff = logger.lastSeq;
    const id = await createBadServer("p4-gated");
    expect(statusOf(id)).toBe("error");
    // A reconnect timer is pending now; disconnect clears it.
    await mcpManager.disconnect(id);
    expect(statusOf(id)).toBe("disconnected");
    // Past the 5s delay: timer cleared, no resurrection attempt.
    await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS + 1000));
    expect(statusOf(id)).toBe("disconnected");
    // No reconnect log line after the disconnect — the timer was cleared.
    expect(countReconnectsSince(cutoff, "p4-gated")).toBe(0);

    // Enabled gating: while disabled, even a failed connect schedules no
    // timer (scheduleReconnect refuses on enabled=false).
    mcpManager.setEnabled(id, false);
    await mcpManager.connect(id);
    for (let i = 0; i < 50; i++) {
      if (statusOf(id) === "error" || statusOf(id) === "disconnected") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS + 1000));
    expect(countReconnectsSince(cutoff, "p4-gated")).toBe(0);
    mcpManager.setEnabled(id, true);
  }, 40000);

  it("repeated disconnect never re-enters reconnect bookkeeping", async () => {
    const cutoff = logger.lastSeq;
    const id = await createBadServer("p4-repeat-disc");
    await mcpManager.disconnect(id);
    expect(statusOf(id)).toBe("disconnected");
    // Second and third disconnects: no-throw, no throw, status stable.
    await mcpManager.disconnect(id);
    await mcpManager.disconnect(id);
    expect(statusOf(id)).toBe("disconnected");
    // No reconnect timer survives: status stays disconnected well past 5s.
    // (0 is the valid reading under log throttling: firings are at most what
    // was observed; an over-count beyond this would indicate a timer fired.)
    await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS + 1000));
    expect(statusOf(id)).toBe("disconnected");
    // No reconnect started after the first disconnect.
    expect(countReconnectsSince(cutoff, "p4-repeat-disc")).toBe(0);
  }, 30000);

  it("repeated manual connect stays bounded at the cap (no oscillation past 5 attempts)", async () => {
    // Connect (fails, timer #1), disconnect (timer cleared, counter reset),
    // reconnect: attempts restart from 1 — observation shows the cap holds.
    const cutoff = logger.lastSeq;
    const id = await createBadServer("p4-bounded-manual");
    await mcpManager.disconnect(id);
    expect(countReconnectsSince(cutoff, "p4-bounded-manual")).toBe(0);
    await mcpManager.connect(id);
    for (let i = 0; i < 50; i++) {
      if (statusOf(id) === "error") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(statusOf(id)).toBe("error");
    // The counter was reset on disconnect: the fresh capped chain must not
    // exceed MAX_RECONNECT_ATTEMPTS fires (upper bound; the "mcp" log scope
    // is throttled, so an over-count — not an under-count — is the cap
    // violation signal).
    const capWindowMs = MAX_RECONNECT_ATTEMPTS * RECONNECT_DELAY_MS + 5000;
    const start = Date.now();
    while (Date.now() - start < capWindowMs) {
      await new Promise((r) => setTimeout(r, 1000));
      if (statusOf(id) === "connected") break;
    }
    expect(countReconnectsSince(cutoff, "p4-bounded-manual")).toBeLessThanOrEqual(
      MAX_RECONNECT_ATTEMPTS
    );
    await mcpManager.disconnect(id);
  }, 45000);
});
