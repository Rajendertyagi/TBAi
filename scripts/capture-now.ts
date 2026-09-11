// SCRATCH: recapture outbound Gemini body for current thread state.
import { Database } from "bun:sqlite";
import fs from "fs";

const OUT = process.argv[2] ?? "D:\\Temp\\gemini-capture-now.json";
const CONV = process.argv[3] ?? "v00fcvlb8cdis6pz8xwtl8ox";
const PROVIDER = process.argv[4] ?? "nmzvxe6kliikxg92mtsyyb2z";

const captured: { url: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (url.includes("generativelanguage.googleapis.com")) {
    let body: unknown = null;
    try {
      body = JSON.parse(init?.body ?? "{}");
    } catch {
      body = String(init?.body ?? "").slice(0, 200);
    }
    captured.push({ url, body });
    return new Response('{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}\n', {
      status: 400,
      headers: { "content-type": "text/event-stream" },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

const { default: app } = await import("../src/routes/index");
const { db: appDb } = await import("../src/db/index");
const { registry } = await import("../src/config/providers");
const { credentialStore } = await import("../src/services/credentials");
await registry.loadFromDb(appDb);
credentialStore.initialize();

const db = new Database("data/chat.db", { readonly: true });
const rows = db
  .query("SELECT content FROM messages WHERE conversation_id = ? ORDER BY rowid")
  .all(CONV) as { content: string }[];
const messages = rows
  .map((r) => {
    try {
      return JSON.parse(r.content);
    } catch {
      return null;
    }
  })
  .filter(Boolean);
console.log(`loaded ${messages.length} messages for ${CONV}`);

const res = await app.request("/api/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ providerId: PROVIDER, messages }),
});
console.log("route status:", res.status);
console.log("route body:", (await res.text()).slice(0, 300));
console.log(`captured ${captured.length} outbound call(s)`);
fs.writeFileSync(OUT, JSON.stringify(captured, null, 1));
console.log("wrote", OUT, fs.statSync(OUT).size, "bytes");
