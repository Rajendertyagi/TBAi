// Integration test for the generic MCP client (manager) against the minimal
// STDIO test server. Exercises connect -> capability discovery -> tool execution.
// Run: bun run scripts/test-mcp.ts
import { credentialStore } from "../src/services/credentials";
import { mcpManager } from "../src/services/mcp/manager";

const BUN = "C:\\Users\\RTPC\\.bun\\bin\\bun.exe";
const SCRIPT = "D:\\Temp\\ai-chat-app\\scripts\\minimal-mcp-server.mjs";
const HTTP_SCRIPT = "D:\\Temp\\ai-chat-app\\scripts\\minimal-mcp-http.mjs";

async function main() {
  credentialStore.initialize();

  console.log("[test] creating + connecting minimal STDIO server...");
  const cfg = mcpManager.createConfig({
    name: "minimal-test",
    transport: "stdio",
    command: BUN,
    args: [SCRIPT],
    enabled: true,
    autoConnect: false,
  });

  await mcpManager.connect(cfg.id);

  const statuses = mcpManager.getStatuses();
  const status = statuses.find((s) => s.id === cfg.id)!;
  console.log("[test] status:", status.status);
  console.log("[test] tools:", status.tools.map((t) => t.name));
  console.log("[test] resources:", status.resources.map((r) => r.uri));
  console.log("[test] prompts:", status.prompts.map((p) => p.name));
  console.log("[test] capabilities:", JSON.stringify(status.serverCapabilities));

  if (status.status !== "connected") {
    console.error("[test] FAIL: not connected:", status.error);
    process.exit(1);
  }
  if (status.toolCount < 3) {
    console.error("[test] FAIL: expected >=3 tools, got", status.toolCount);
    process.exit(1);
  }

  // Exercise tool execution through the AI SDK tool bridge.
  const tools = mcpManager.getAiTools();
  const echoKey = Object.keys(tools).find((k) => k.endsWith("__echo"));
  if (!echoKey) {
    console.error("[test] FAIL: echo tool not found in getAiTools()");
    process.exit(1);
  }
  const echoResult = await tools[echoKey].execute({ text: "hello mcp" } as any);
  console.log("[test] echo execute ->", JSON.stringify(echoResult));
  if (typeof echoResult !== "string" || !echoResult.includes("hello mcp")) {
    console.error("[test] FAIL: echo result unexpected");
    process.exit(1);
  }

  const addKey = Object.keys(tools).find((k) => k.endsWith("__add"));
  const addResult = await tools[addKey!].execute({ a: 2, b: 3 } as any);
  console.log("[test] add execute ->", JSON.stringify(addResult));
  if (!String(addResult).includes("5")) {
    console.error("[test] FAIL: add result unexpected");
    process.exit(1);
  }

  // Error-result tool should throw.
  const failKey = Object.keys(tools).find((k) => k.endsWith("__fail_on_purpose"));
  let threw = false;
  try {
    await tools[failKey!].execute({ msg: "x" } as any);
  } catch (e) {
    threw = true;
    console.log("[test] fail_on_purpose threw as expected:", (e as Error).message);
  }
  if (!threw) {
    console.error("[test] FAIL: error tool did not throw");
    process.exit(1);
  }

  // Read a discovered resource and insert its text (the "Insert into chat" path).
  if (status.resourceCount > 0) {
    const uri = status.resources[0].uri;
    const resRead = await mcpManager.readResource(cfg.id, uri);
    console.log("[test] readResource ->", JSON.stringify(resRead.contents));
    if (!resRead.contents?.[0]?.text) {
      console.error("[test] FAIL: resource read returned no text");
      process.exit(1);
    }
  }

  // Retrieve a discovered prompt (the "Use prompt" path).
  if (status.promptCount > 0) {
    const pname = status.prompts[0].name;
    const resPrompt = await mcpManager.getPrompt(cfg.id, pname, { text: "hello world" });
    console.log("[test] getPrompt ->", JSON.stringify(resPrompt.messages));
    if (!resPrompt.messages?.length) {
      console.error("[test] FAIL: prompt get returned no messages");
      process.exit(1);
    }
  }

  // Test the one-off connection test path.
  const testResult = await mcpManager.testConnection({
    name: "minimal-test",
    transport: "stdio",
    command: BUN,
    args: [SCRIPT],
    enabled: true,
    autoConnect: false,
  });
  console.log("[test] testConnection ok:", testResult.ok, "tools:", testResult.toolCount);
  if (!testResult.ok) {
    console.error("[test] FAIL: testConnection failed:", testResult.error);
    process.exit(1);
  }

  // Cleanup.
  mcpManager.deleteConfig(cfg.id);
  console.log("[test] PASS: all STDIO checks succeeded");

  // ---- Streamable HTTP transport check ----
  console.log("[test] starting minimal HTTP MCP server...");
  const httpServer = Bun.spawn([BUN, HTTP_SCRIPT], { stdout: "pipe", stderr: "pipe" });
  await new Promise((r) => setTimeout(r, 1500));

  const httpTest = await mcpManager.testConnection({
    name: "minimal-http",
    transport: "http",
    url: "http://localhost:8787/mcp",
    enabled: true,
    autoConnect: false,
  });
  console.log("[test] HTTP testConnection ok:", httpTest.ok, "tools:", httpTest.toolCount);
  if (!httpTest.ok) {
    console.error("[test] FAIL: HTTP testConnection:", httpTest.error);
    httpServer.kill();
    process.exit(1);
  }
  httpServer.kill();
  console.log("[test] PASS: all checks succeeded (STDIO + HTTP)");
  process.exit(0);
}

main().catch((e) => {
  console.error("[test] ERROR", e);
  process.exit(1);
});
