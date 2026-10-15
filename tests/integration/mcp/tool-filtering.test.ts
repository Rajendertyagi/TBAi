/**
 * Per-tool filtering through `mcpManager.getAiTools()` (Phase 1 — the bridge
 * half: `disabledTools` decides which of a server's discovered tools reach
 * the AI SDK).
 *
 * A connected server is the precondition, and the manager's `connections`
 * map is private, so the fixture is a REAL stdio MCP server —
 * `tests/fixtures/everything-server.ts` spawned over stdio, exactly the
 * createStdioFixture pattern from tests/integration/mcp/mcp-v2.test.ts. The
 * fixture exposes three tools: `echo`, `fail`, `ask_user`.
 *
 * Contracts pinned here:
 *
 *   - filtering is per-server and applied to the DISCOVERED tool list at
 *     getAiTools() time, against `conn.config.disabledTools` (a denylist);
 *   - matching is case-sensitive Set membership ("Echo" does not disable
 *     "echo");
 *   - stale entries (a disabled name no server tool matches) are ignored,
 *     never fatal, and logged once each as `mcp.filter_unknown_entry`;
 *   - a server whose tools are ALL disabled exposes zero keys and logs
 *     `mcp.filter_empty`;
 *   - the exposed count is the number of keys returned under the
 *     `mcp__<serverId>__*` namespace, NOT total − disabledTools.length
 *     (stale entries in the denylist must not subtract from the count);
 *   - a server with no live connection exposes nothing, no matter what its
 *     disabledTools say.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { Hono } from "hono";
import { mcpManager } from "@/services/mcp/manager.ts";
import { logger } from "@/lib/logger.ts";
import mcpApp from "@/routes/mcp.ts";
import type { McpServerCreate } from "@/lib/validation.ts";

const FIXTURE_ARGS = ["run", "tests/fixtures/everything-server.ts", "stdio"] as const;
/** The fixture's discovered tool names, in registration order. */
const FIXTURE_TOOLS = ["echo", "fail", "ask_user"] as const;

const createdIds: string[] = [];
const connectedIds: string[] = [];

function track(id: string): string {
  createdIds.push(id);
  return id;
}

async function connectServer(name: string, extra: Partial<McpServerCreate> = {}): Promise<string> {
  const created = mcpManager.createConfig({
    name,
    transport: "stdio",
    command: "bun",
    args: [...FIXTURE_ARGS],
    enabled: true,
    autoConnect: false,
    ...extra,
  });
  const id = track(created.id);
  await mcpManager.connect(id);
  for (let i = 0; i < 100; i++) {
    const st = mcpManager.getStatuses().find((s) => s.id === id);
    if (st?.status === "connected") {
      connectedIds.push(id);
      return id;
    }
    if (st?.status === "error") throw new Error(`fixture ${name} failed to connect: ${st.error}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`fixture ${name} never reached connected state`);
}

async function disconnectAndDelete(id: string): Promise<void> {
  await mcpManager.disconnect(id);
  try {
    mcpManager.deleteConfig(id);
  } catch {
    /* row already gone */
  }
  const c = connectedIds.indexOf(id);
  if (c !== -1) connectedIds.splice(c, 1);
}

afterAll(async () => {
  for (const id of [...connectedIds]) {
    await mcpManager.disconnect(id);
  }
  for (const id of createdIds) {
    try {
      mcpManager.deleteConfig(id);
    } catch {
      /* row already gone */
    }
  }
});

/** The keys getAiTools() returns for one server. */
function exposedNames(id: string): string[] {
  const prefix = `mcp__${id}__`;
  return Object.keys(mcpManager.getAiTools())
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
}

/** Warn-level log entries emitted after `cutoff` (warns are never throttled). */
function warnEvents(cutoff: number, event: string) {
  return logger.getRecentEntries(cutoff).filter((e) => e.event === event && e.level === "warn");
}

/** The real MCP REST sub-app, mounted exactly as `src/routes/index.ts` mounts it. */
const app = new Hono();
app.route("/api/mcp", mcpApp);

/** PUT a payload through the real route (Zod validation + manager + store). */
async function putServer(id: string, body: Record<string, unknown>) {
  const res = await app.request(`/api/mcp/servers/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/**
 * The payload the settings form sends for a stdio server, mirroring
 * `McpPanel.buildPayload`: the WHOLE draft, so the unchanged connection fields
 * (`command`, `args`, `transport`) travel alongside the edited filter.
 */
function uiStdioPayload(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    transport: "stdio",
    command: "bun",
    args: [...FIXTURE_ARGS],
    authType: "none",
    enabled: true,
    autoConnect: false,
    disabledTools: [],
    ...overrides,
  };
}

/** Poll until the connection is re-established with a NEW lastConnectedAt. */
async function waitForReconnect(
  id: string,
  previousConnectedAt: number | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = mcpManager.getStatuses().find((s) => s.id === id);
    if (st?.status === "connected" && st.lastConnectedAt !== previousConnectedAt) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe("getAiTools() — filtering by disabledTools (fixture: 3 tools)", () => {
  it("exposes every discovered tool when nothing is disabled", async () => {
    const id = await connectServer("tf-none");
    try {
      expect(exposedNames(id)).toEqual([...FIXTURE_TOOLS]);
    } finally {
      await disconnectAndDelete(id);
    }
  }, 30000);

  it("exposes an empty list when no server is connected (nothing to expose)", async () => {
    // A server row that was never connected has no entry in the manager's
    // connections map, so getAiTools() returns no keys for it — the
    // disabledTools value is irrelevant without a live connection.
    const created = mcpManager.createConfig({
      name: "tf-disconnected",
      transport: "stdio",
      command: "bun",
      args: [...FIXTURE_ARGS],
      enabled: false,
      autoConnect: false,
      disabledTools: ["echo"],
    });
    const id = track(created.id);
    try {
      expect(exposedNames(id)).toEqual([]);
    } finally {
      try {
        mcpManager.deleteConfig(id);
      } catch {
        /* row already gone */
      }
      const c = createdIds.indexOf(id);
      if (c !== -1) createdIds.splice(c, 1);
    }
  }, 30000);

  it("exposes nothing for a server whose tools were all disabled, then logged it", async () => {
    const id = await connectServer("tf-all-disabled", { disabledTools: [...FIXTURE_TOOLS] });
    try {
      const cutoff = logger.lastSeq;
      expect(exposedNames(id)).toEqual([]);
      const empty = warnEvents(cutoff, "mcp.filter_empty");
      expect(empty.length).toBe(1);
      expect(empty[0].mcpServer).toBe("tf-all-disabled");
      expect(empty[0].totalTools).toBe(3);
      expect(empty[0].disabledCount).toBe(3);
    } finally {
      await disconnectAndDelete(id);
    }
  }, 30000);

  it("still exposes a tool when a stale denylist entry is present (count = exposed, not total-minus-disabled)", async () => {
    const id = await connectServer("tf-stale", { disabledTools: ["echo", "no-such-tool"] });
    try {
      // 2 exposed: "fail" and "ask_user". If the count were
      // total − disabledTools.length it would be 1 — the stale entry must
      // not subtract.
      const cutoff = logger.lastSeq;
      // One getAiTools() pass: assert the exposed set and the warnings it
      // emitted, captured against the pre-call sequence.
      expect(exposedNames(id)).toEqual(["fail", "ask_user"]);
      const unknown = warnEvents(cutoff, "mcp.filter_unknown_entry");
      expect(unknown.map((e) => e.entry).sort()).toEqual(["no-such-tool"]);
      expect(unknown.every((e) => e.mcpServer === "tf-stale")).toBe(true);
      // And no "everything disabled" claim for a server that still exposes.
      expect(warnEvents(cutoff, "mcp.filter_empty").length).toBe(0);
    } finally {
      await disconnectAndDelete(id);
    }
  }, 30000);

  it("treats an empty array the same as none disabled", async () => {
    const id = await connectServer("tf-empty-array", { disabledTools: [] });
    try {
      expect(exposedNames(id)).toEqual([...FIXTURE_TOOLS]);
    } finally {
      await disconnectAndDelete(id);
    }
  }, 30000);

  it('matches tool names case-sensitively: disabling "Echo" does not disable "echo"', async () => {
    const id = await connectServer("tf-case", { disabledTools: ["Echo"] });
    try {
      // "Echo" is not a discovered tool name, so "echo" stays exposed and the
      // unknown-entry warning is logged for the case-mismatched entry.
      const cutoff = logger.lastSeq;
      expect(exposedNames(id)).toContain("echo");
      expect(warnEvents(cutoff, "mcp.filter_unknown_entry").map((e) => e.entry)).toEqual(["Echo"]);
    } finally {
      await disconnectAndDelete(id);
    }
  }, 30000);
});

describe("getAiTools() — multiple servers filter independently", () => {
  it("applies each server's own denylist to its own discovered tools", async () => {
    const a = await connectServer("tf-multi-a", { disabledTools: ["echo"] });
    const b = await connectServer("tf-multi-b", { disabledTools: ["fail"] });
    try {
      expect(exposedNames(a)).toEqual(["fail", "ask_user"]);
      expect(exposedNames(b)).toEqual(["echo", "ask_user"]);
    } finally {
      await disconnectAndDelete(a);
      await disconnectAndDelete(b);
    }
  }, 60000);
});

/**
 * The LIVE update path: `PUT /api/mcp/servers/:id` → `mcpManager.updateConfig`
 * → the live connection's in-memory config → `getAiTools()`.
 *
 * The settings form re-sends the whole draft on every save, so the payload
 * carries the unchanged connection fields (`command`, `args`, `transport`)
 * alongside the edited filter. A filter edit must therefore apply to the live
 * connection IN PLACE — no reconnect — or the tool list would only change after
 * a full teardown, and a healthy transport would be torn down for a checkbox.
 */
describe("getAiTools() — live filter updates through PUT /api/mcp/servers/:id", () => {
  it("disabling a tool on a connected server removes it immediately, without reconnecting", async () => {
    const id = await connectServer("tf-live-disable");
    try {
      expect(exposedNames(id)).toEqual([...FIXTURE_TOOLS]);
      const before = mcpManager.getStatuses().find((s) => s.id === id)!;
      const connectedAt = before.lastConnectedAt;
      const eventCount = before.events.length;

      const res = await putServer(
        id,
        uiStdioPayload("tf-live-disable", { disabledTools: ["echo"] }),
      );
      expect(res.status).toBe(200);

      // The filter is live the moment the request returns. No reconnect has had
      // a chance to run, so this can only pass if updateConfig applied the new
      // denylist to the live connection in place.
      expect(exposedNames(id)).toEqual(["fail", "ask_user"]);

      // And the transport was not torn down: a reconnect replaces the
      // connection, stamping a fresh lastConnectedAt and appending a
      // "disconnected" event.
      await new Promise((r) => setTimeout(r, 500));
      const after = mcpManager.getStatuses().find((s) => s.id === id)!;
      expect(after.status).toBe("connected");
      expect(after.lastConnectedAt).toBe(connectedAt);
      expect(after.events.length).toBe(eventCount);
    } finally {
      await disconnectAndDelete(id);
    }
  }, 30000);

  it("re-enabling every tool with disabledTools: [] restores it immediately, without reconnecting", async () => {
    const id = await connectServer("tf-live-reenable", { disabledTools: ["echo"] });
    try {
      expect(exposedNames(id)).toEqual(["fail", "ask_user"]);
      const before = mcpManager.getStatuses().find((s) => s.id === id)!;
      const connectedAt = before.lastConnectedAt;
      const eventCount = before.events.length;

      const res = await putServer(id, uiStdioPayload("tf-live-reenable", { disabledTools: [] }));
      expect(res.status).toBe(200);

      expect(exposedNames(id)).toEqual([...FIXTURE_TOOLS]);

      await new Promise((r) => setTimeout(r, 500));
      const after = mcpManager.getStatuses().find((s) => s.id === id)!;
      expect(after.status).toBe("connected");
      expect(after.lastConnectedAt).toBe(connectedAt);
      expect(after.events.length).toBe(eventCount);
    } finally {
      await disconnectAndDelete(id);
    }
  }, 30000);

  it("a genuine connection change (env) still reconnects", async () => {
    const id = await connectServer("tf-live-env");
    try {
      const connectedAt = mcpManager.getStatuses().find((s) => s.id === id)!.lastConnectedAt;

      const res = await putServer(
        id,
        uiStdioPayload("tf-live-env", { env: { TBAI_TEST_ENV: "1" } }),
      );
      expect(res.status).toBe(200);

      // `env` is passed to the child process, so it cannot be applied in place:
      // the connection must be rebuilt, which stamps a new lastConnectedAt.
      expect(await waitForReconnect(id, connectedAt, 15000)).toBe(true);
      expect(mcpManager.getStatuses().find((s) => s.id === id)?.status).toBe("connected");
    } finally {
      await disconnectAndDelete(id);
    }
  }, 30000);
});
