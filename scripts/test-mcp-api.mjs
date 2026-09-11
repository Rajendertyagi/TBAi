// Exercises the live MCP REST API on a running TBAi server (default :3100).
const BASE = process.env.BASE || "http://localhost:3100";
const BUN = "C:\\Users\\RTPC\\.bun\\bin\\bun.exe";
const SCRIPT = "D:\\Temp\\ai-chat-app\\scripts\\minimal-mcp-server.mjs";

async function main() {
  // 1) List (should be empty array initially)
  let r = await fetch(`${BASE}/api/mcp/servers`);
  let list = await r.json();
  console.log("[api] GET /servers ->", r.status, "count:", list.length);
  if (!Array.isArray(list)) throw new Error("expected array");

  // 2) Create a STDIO server config (enabled -> auto-connects)
  r = await fetch(`${BASE}/api/mcp/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "api-test-stdio",
      transport: "stdio",
      command: BUN,
      args: [SCRIPT],
      enabled: true,
      autoConnect: true,
    }),
  });
  const created = await r.json();
  console.log("[api] POST /servers ->", r.status, "id:", created.id);
  if (r.status !== 201) throw new Error("create failed: " + JSON.stringify(created));

  // 3) Poll until connected with tools discovered
  let status = null;
  for (let i = 0; i < 20; i++) {
    r = await fetch(`${BASE}/api/mcp/servers`);
    list = await r.json();
    status = list.find((s) => s.id === created.id);
    if (status && status.status === "connected" && status.toolCount >= 3) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  console.log(
    "[api] status:",
    status?.status,
    "tools:",
    status?.toolCount,
    "resources:",
    status?.resourceCount,
    "prompts:",
    status?.promptCount,
  );
  if (status?.status !== "connected") throw new Error("not connected: " + JSON.stringify(status));
  if (status.toolCount < 3) throw new Error("tool discovery failed");

  // 4) Test connection (one-off, no persist) over HTTP
  r = await fetch(`${BASE}/api/mcp/servers/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "api-test-http", transport: "http", url: "http://localhost:8787/mcp" }),
  });
  const test = await r.json();
  console.log("[api] POST /servers/test (http) ->", r.status, "ok:", test.ok, "tools:", test.toolCount);

  // 5) Web app is served
  r = await fetch(`${BASE}/`);
  const html = await r.text();
  console.log("[api] GET / ->", r.status, "has #root:", html.includes("root"));

  // 6) Disable (disconnect) then delete (cleanup)
  await fetch(`${BASE}/api/mcp/servers/${created.id}/enable`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  r = await fetch(`${BASE}/api/mcp/servers/${created.id}`, { method: "DELETE" });
  console.log("[api] DELETE ->", r.status);

  console.log("[api] PASS");
}

main().catch((e) => {
  console.error("[api] FAIL", e);
  process.exit(1);
});
