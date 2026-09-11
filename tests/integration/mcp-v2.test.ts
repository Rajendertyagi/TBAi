import { describe, it, expect, afterAll } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  WebStandardStreamableHTTPServerTransport,
  McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { mcpManager } from "../../src/services/mcp/manager";
import { createFixtureServer } from "../fixtures/everything-server";

// DB isolation guard: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
describe("test isolation", () => {
  it("uses an isolated DATA_DIR, never the developer database", () => {
    expect(process.env.DATA_DIR ?? "").toContain("tbai-test");
  });
});

describe("v2 client over InMemoryTransport (era negotiation)", () => {
  it("connects, negotiates legacy era, discovers tools/resources/prompts", async () => {
    const server = createFixtureServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client(
      { name: "tbai-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" }, capabilities: { roots: { listChanged: true } } }
    );
    await client.connect(clientTransport);

    expect(client.getProtocolEra()).toBe("legacy");
    const caps = client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
    expect(caps?.resources).toBeDefined();
    expect(caps?.prompts).toBeDefined();

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("echo");

    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain("fixture://config");

    const read = await client.readResource({ uri: "fixture://config" });
    const block = read.contents[0];
    expect(block && "text" in block ? block.text : "").toBe("v1");

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toContain("greeting");

    const prompt = await client.getPrompt({ name: "greeting", arguments: { name: "World" } });
    expect(prompt.messages.length).toBeGreaterThan(0);

    await client.close();
    await server.close();
  });

  it("executes tools and surfaces tool-level errors as isError", async () => {
    const server = createFixtureServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "tbai-test", version: "1.0.0" });
    await client.connect(clientTransport);

    const ok = await client.callTool({ name: "echo", arguments: { text: "hello" } });
    expect(JSON.stringify(ok)).toContain("hello");

    const bad = await client.callTool({ name: "fail", arguments: {} });
    expect(bad.isError).toBe(true);

    await client.close();
    await server.close();
  });

  it("answers roots/list and sends roots list-changed without error", async () => {
    const server = createFixtureServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "tbai-test", version: "1.0.0" },
      { capabilities: { roots: { listChanged: true } } }
    );
    client.setRequestHandler("roots/list", () => ({
      roots: [{ uri: "file:///tmp" }],
    }));
    await client.connect(clientTransport);
    await client.sendRootsListChanged();
    await client.close();
    await server.close();
  });
});

describe("Streamable HTTP round-trip (real Bun server)", () => {
  it("connects, negotiates and calls a tool over HTTP", async () => {
    const server = new McpServer({ name: "fixture-http", version: "1.0.0" });
    server.registerTool(
      "ping_tool",
      { description: "Returns pong." },
      async () => ({ content: [{ type: "text" as const, text: "pong" }] })
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    const httpServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/mcp") return transport.handleRequest(req);
        return new Response("nf", { status: 404 });
      },
    });
    try {
      const client = new Client(
        { name: "tbai-test", version: "1.0.0" },
        { versionNegotiation: { mode: "auto" } }
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://localhost:${httpServer.port}/mcp`))
      );
      expect(client.getProtocolEra()).toBe("legacy");
      const result = await client.callTool({ name: "ping_tool", arguments: {} });
      const block = Array.isArray(result.content) ? result.content[0] : undefined;
      expect(block && "text" in block ? block.text : "").toBe("pong");
      await client.close();
    } finally {
      httpServer.stop(true);
      await server.close();
    }
  }, 20000);
});

const createdIds: string[] = [];
afterAll(async () => {
  for (const id of createdIds) {
    try {
      mcpManager.deleteConfig(id);
    } catch {
      /* ignore */
    }
  }
});

async function createStdioFixture(name: string) {
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
  // connect() is async fire-and-record; poll for terminal state.
  for (let i = 0; i < 100; i++) {
    const st = mcpManager.getStatuses().find((s) => s.id === created.id);
    if (st?.status === "connected" || st?.status === "error") return created.id;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`fixture ${name} never reached terminal state`);
}

describe("canonical manager lifecycle over STDIO (v2)", () => {
  it("connects with auto era negotiation and snapshots capabilities", async () => {
    const id = await createStdioFixture("v2-stdio-1");
    const st = mcpManager.getStatuses().find((s) => s.id === id);
    expect(st?.status).toBe("connected");
    expect(st?.protocolEra).toBe("legacy");
    expect(st?.tools.some((t) => t.name === "echo")).toBe(true);
    expect(st?.resources.some((r) => r.uri === "fixture://config")).toBe(true);
    expect(st?.prompts.some((p) => p.name === "greeting")).toBe(true);
    await mcpManager.disconnect(id);
    expect(mcpManager.getStatuses().find((s) => s.id === id)?.status).toBe("disconnected");
  }, 30000);

  it("bridges server tools to AI SDK tools with namespacing; errors throw", async () => {
    const id = await createStdioFixture("v2-stdio-2");
    try {
      const tools = mcpManager.getAiTools();
      const name = `mcp__${id}__echo`;
      expect(tools[name]).toBeDefined();
      const out = await tools[name].execute({ text: "bridge-works" }, {});
      expect(String(out)).toContain("bridge-works");
      try {
        await tools[`mcp__${id}__fail`].execute({}, {});
        expect(true).toBe(false); // should have thrown
      } catch (e: any) {
        expect(e.message).toBe("intentional failure");
      }
    } finally {
      await mcpManager.disconnect(id);
    }
  }, 30000);

  it("routes server elicitation to the pending map and resolves via UI action", async () => {
    const id = await createStdioFixture("v2-stdio-3");
    try {
      const tools = mcpManager.getAiTools();
      const pending = tools[`mcp__${id}__ask_user`].execute(
        {},
        { toolCallId: "t-elicit", messages: [] }
      );
      let info;
      for (let i = 0; i < 100; i++) {
        info = mcpManager.getPendingElicitation();
        if (info?.serverId === id) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(info?.serverId).toBe(id);
      expect(info?.message).toContain("project name");
      const ok = mcpManager.resolveElicitation(id, info!.elicitationId, "accept", {
        projectName: "TBAi",
      });
      expect(ok).toBe(true);
      const result = await pending;
      expect(String(result)).toContain("TBAi");
      expect(mcpManager.getPendingElicitation()).toBeUndefined();
    } finally {
      await mcpManager.disconnect(id);
    }
  }, 30000);

  it("pushes roots list-changed on roots-only updates without reconnect", async () => {
    const id = await createStdioFixture("v2-stdio-4");
    try {
      const ok = await mcpManager.notifyRootsChanged(id);
      expect(ok).toBe(true);
      mcpManager.updateConfig(id, { roots: ["file:///tmp"] });
      // Roots-only edit must not tear the connection down.
      await new Promise((r) => setTimeout(r, 500));
      expect(mcpManager.getStatuses().find((s) => s.id === id)?.status).toBe("connected");
      const ok2 = await mcpManager.notifyRootsChanged(id);
      expect(ok2).toBe(true);
    } finally {
      await mcpManager.disconnect(id);
    }
  }, 30000);

  it("supports two concurrent servers with distinct namespaced tools", async () => {
    const a = await createStdioFixture("v2-multi-a");
    const b = await createStdioFixture("v2-multi-b");
    try {
      const tools = mcpManager.getAiTools();
      expect(tools[`mcp__${a}__echo`]).toBeDefined();
      expect(tools[`mcp__${b}__echo`]).toBeDefined();
      expect(await tools[`mcp__${a}__echo`].execute({ text: "A" }, {})).toContain("A");
      expect(await tools[`mcp__${b}__echo`].execute({ text: "B" }, {})).toContain("B");
    } finally {
      await mcpManager.disconnect(a);
      await mcpManager.disconnect(b);
    }
  }, 60000);

  it("records error status for bad commands and survives enable/disable round-trip", async () => {
    const created = mcpManager.createConfig({
      name: "v2-bad",
      transport: "stdio",
      command: "definitely-not-a-real-command-xyz",
      args: [],
      enabled: true,
      autoConnect: false,
    });
    createdIds.push(created.id);
    await mcpManager.connect(created.id);
    for (let i = 0; i < 50; i++) {
      const st = mcpManager.getStatuses().find((s) => s.id === created.id);
      if (st?.status === "error") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(
      mcpManager.getStatuses().find((s) => s.id === created.id)?.status
    ).toBe("error");

    const id = await createStdioFixture("v2-toggle");
    mcpManager.setEnabled(id, false);
    // disconnect() is fire-and-forget; poll for terminal state.
    for (let i = 0; i < 50; i++) {
      if (mcpManager.getStatuses().find((s) => s.id === id)?.status === "disconnected") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(mcpManager.getStatuses().find((s) => s.id === id)?.status).toBe("disconnected");
    mcpManager.setEnabled(id, true);
    for (let i = 0; i < 100; i++) {
      if (mcpManager.getStatuses().find((s) => s.id === id)?.status === "connected") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(mcpManager.getStatuses().find((s) => s.id === id)?.status).toBe("connected");
    await mcpManager.disconnect(id);
  }, 60000);

  it("tool execution settles (never hangs) when the abort signal is already fired", async () => {
    const id = await createStdioFixture("v2-abort");
    try {
      const tools = mcpManager.getAiTools();
      const controller = new AbortController();
      controller.abort();
      const settled = await Promise.race([
        tools[`mcp__${id}__echo`]
          .execute({ text: "x" }, { abortSignal: controller.signal })
          .then(
            () => "resolved" as const,
            () => "rejected" as const
          ),
        new Promise((r) => setTimeout(() => r("timeout" as const), 15000)),
      ]);
      expect(settled).not.toBe("timeout");
    } finally {
      await mcpManager.disconnect(id);
    }
  }, 30000);
});

// z usage guard: fixture + tests exercise zod v4 runtime under Bun.
describe("zod v4 runtime", () => {
  it("validates basic schemas", () => {
    const s = z.object({ text: z.string() });
    expect(s.parse({ text: "ok" })).toEqual({ text: "ok" });
  });
});
