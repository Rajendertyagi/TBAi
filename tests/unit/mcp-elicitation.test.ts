/**
 * MCP manager elicitation lifecycle (Phase 4) — integration level, real
 * fixture server.
 *
 * Covers the elicitation settlement seams that require a live connection:
 * pending → disconnect settles as cancelled (slot cleared, tool promise does
 * not hang); already-answered → disconnect is harmless; repeated cancel
 * (double settlement) is safe. Uses the ask_user tool from the STDIO fixture
 * (same pattern as mcp-v2.test.ts) and the manager's public surface only.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mcpManager } from "../../src/services/mcp/manager";

const createdIds: string[] = [];
afterAll(async () => {
  await mcpManager.disconnectAll();
  for (const id of createdIds) {
    try {
      mcpManager.deleteConfig(id);
    } catch {
      /* row already gone */
    }
  }
});

async function createStdioFixture(name: string): Promise<string> {
  const created = mcpManager.createConfig({
    name,
    transport: "stdio",
    command: "bun",
    args: ["run", "tests/fixtures/everything-server.ts", "stdio"],
    enabled: true,
    autoConnect: false,
  });
  createdIds.push(created.id);
  await mcpManager.connect(created.id);
  for (let i = 0; i < 100; i++) {
    const st = mcpManager.getStatuses().find((s) => s.id === created.id);
    if (st?.status === "connected" || st?.status === "error") return created.id;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`fixture ${name} never reached terminal state`);
}

/**
 * Start the ask_user tool (which triggers a server elicitation) and wait
 * for the manager's pending-elicitation slot. Returns the elicitation id
 * and the tool-level promise (so the test can prove it settled).
 */
async function startPendingElicitation(
  id: string,
  toolCallId: string
): Promise<{ elicitationId: string; pending: Promise<unknown> }> {
  const tools = mcpManager.getAiTools();
  const pending = tools[`mcp__${id}__ask_user`].execute(
    {},
    { toolCallId, messages: [] }
  );
  let info;
  for (let i = 0; i < 100; i++) {
    info = mcpManager.getPendingElicitation();
    if (info?.serverId === id) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!info?.elicitationId) {
    // Drain the dangling promise so the test never hangs.
    await pending.catch(() => {});
    throw new Error(`no pending elicitation for ${id}`);
  }
  return { elicitationId: info.elicitationId, pending };
}

describe("MCP elicitation settlement (Phase 4)", () => {
  it("pending → disconnect settles as cancelled (no hang, slot cleared)", async () => {
    const id = await createStdioFixture("p4-elicit-disc");
    const { elicitationId, pending } = await startPendingElicitation(id, "t-elicit-disc");
    try {
      expect(mcpManager.getPendingElicitation()?.serverId).toBe(id);

      // disconnect() cancels the elicitation slot before closing the
      // transport. The tool-level promise must settle — it either resolves
      // with the server's "(declined)" branch (cancel propagated through the
      // SDK before close) or rejects with the SDK close error. Either way,
      // it must not hang.
      const drained = pending.catch(() => {});
      await mcpManager.disconnect(id);
      expect(mcpManager.getPendingElicitation()).toBeUndefined();
      expect(mcpManager.getStatuses().find((s) => s.id === id)?.status).toBe(
        "disconnected"
      );
      // The tool-level promise settled (not hung): awaited with a bounded
      // race so a regression (transport close without elicitation cancel)
      // surfaces as a failure instead of a hang.
      const settled = await Promise.race([
        drained.then(() => "settled" as const),
        new Promise<"hung">((r) => setTimeout(() => r("hung"), 10000)),
      ]);
      expect(settled).toBe("settled");
      // No elicitation bookkeeping remains: a late UI answer for the same
      // elicitation finds no slot (the cancel path cleared it).
      expect(mcpManager.resolveElicitation(id, elicitationId, "cancel")).toBe(false);
    } finally {
      await mcpManager.disconnect(id);
    }
  }, 30000);

  it("already answered → disconnect is harmless (slot already cleared)", async () => {
    const id = await createStdioFixture("p4-elicit-answered");
    const { elicitationId, pending } = await startPendingElicitation(id, "t-elicit-answered");
    try {
      const answered = mcpManager.resolveElicitation(id, elicitationId, "accept", {
        projectName: "TBAi",
      });
      expect(answered).toBe(true);
      expect(mcpManager.getPendingElicitation()).toBeUndefined();
      // The tool-level promise now carries the answered content.
      const result = await pending;
      expect(String(result)).toContain("TBAi");

      // disconnect() on a server with no pending elicitation: no throw,
      // no double settlement (cancelPendingElicitation is a no-op here).
      await mcpManager.disconnect(id);
      expect(mcpManager.getPendingElicitation()).toBeUndefined();
      expect(mcpManager.getStatuses().find((s) => s.id === id)?.status).toBe(
        "disconnected"
      );
    } finally {
      await mcpManager.disconnect(id);
    }
  }, 30000);

  it("repeated cancel (disconnect twice) is safe — no duplicate settlement", async () => {
    const id = await createStdioFixture("p4-elicit-dbl");
    const { elicitationId, pending } = await startPendingElicitation(id, "t-elicit-dbl");
    const drained = pending.catch(() => {});
    try {
      // First disconnect cancels the slot.
      await mcpManager.disconnect(id);
      expect(mcpManager.getPendingElicitation()).toBeUndefined();
      // Second disconnect (and a disconnectAll that includes it): the slot
      // is already cleared, so cancelPendingElicitation is a no-op — no
      // throw, no duplicate settlement.
      await mcpManager.disconnect(id);
      await mcpManager.disconnectAll();
      expect(mcpManager.getPendingElicitation()).toBeUndefined();
      expect(mcpManager.getStatuses().find((s) => s.id === id)?.status).toBe(
        "disconnected"
      );
      // The cancellation path settled the tool promise: no hang.
      await drained;
      // The cancellation path settles with { action: "cancel" } semantics:
      // a late UI answer for the same elicitation finds no slot.
      expect(mcpManager.resolveElicitation(id, elicitationId, "accept")).toBe(false);
    } finally {
      await mcpManager.disconnect(id);
    }
  }, 30000);
});
