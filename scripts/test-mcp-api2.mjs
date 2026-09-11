// Live REST API check for the new resource/prompt/elicit endpoints.
const BASE = "http://localhost:3100";
const BUN = "C:\\Users\\RTPC\\.bun\\bin\\bun.exe";
const SCRIPT = "D:\\Temp\\ai-chat-app\\scripts\\minimal-mcp-server.mjs";

async function main() {
  // Create + connect a minimal STDIO server.
  let r = await fetch(`${BASE}/api/mcp/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "api2", transport: "stdio", command: BUN, args: [SCRIPT], enabled: true, autoConnect: true }),
  });
  const srv = await r.json();
  console.log("[api2] created", r.status, srv.id);

  // Wait for connected + discovery.
  let st;
  for (let i = 0; i < 20; i++) {
    const list = await (await fetch(`${BASE}/api/mcp/servers`)).json();
    st = list.find((s) => s.id === srv.id);
    if (st && st.status === "connected" && st.resourceCount >= 1 && st.promptCount >= 1) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  console.log("[api2] status", st.status, "res", st.resourceCount, "prompts", st.promptCount);

  // Read resource via REST.
  const uri = st.resources[0].uri;
  r = await fetch(`${BASE}/api/mcp/servers/${srv.id}/resource/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uri }),
  });
  const rr = await r.json();
  console.log("[api2] resource/read ->", r.status, JSON.stringify(rr.contents));

  // Get prompt via REST.
  r = await fetch(`${BASE}/api/mcp/servers/${srv.id}/prompt/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: st.prompts[0].name, arguments: { text: "hello" } }),
  });
  const pr = await r.json();
  console.log("[api2] prompt/get ->", r.status, JSON.stringify(pr.messages));

  // Elicit pending should be null (no server asking).
  r = await fetch(`${BASE}/api/mcp/elicit/pending`);
  const pend = await r.json();
  console.log("[api2] elicit/pending ->", r.status, pend);

  // Cleanup.
  await fetch(`${BASE}/api/mcp/servers/${srv.id}`, { method: "DELETE" });
  console.log("[api2] PASS");
}
main().catch((e) => { console.error("[api2] FAIL", e); process.exit(1); });
