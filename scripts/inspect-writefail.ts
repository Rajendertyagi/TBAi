// SCRATCH: inspect recent write_file tool parts (states + errors).
import { Database } from "bun:sqlite";
const db = new Database("data/chat.db", { readonly: true });
const rows = db
  .query(
    "SELECT conversation_id, id, content FROM messages WHERE content LIKE '%write_file%' ORDER BY rowid DESC LIMIT 4",
  )
  .all() as { conversation_id: string; id: string; content: string }[];
for (const r of rows) {
  const m = JSON.parse(r.content);
  console.log("=== msg", r.id, "conv", r.conversation_id, "role=" + m.role);
  for (const p of m.parts || []) {
    if (!String(p.type || "").includes("tool")) continue;
    console.log("  part:", p.type, "| state:", p.state, "| tc:", p.toolCallId);
    if (p.error !== undefined) console.log("    error:", String(p.error).slice(0, 250));
    if (p.errorText !== undefined) console.log("    errorText:", String(p.errorText).slice(0, 250));
    if (p.output !== undefined)
      console.log("    output:", JSON.stringify(p.output).slice(0, 250));
    if (p.input !== undefined)
      console.log(
        "    input keys:",
        Object.keys(p.input || {}).join(","),
        "| content len:",
        String(p.input?.content ?? "").length,
      );
    if (p.approval) console.log("    approval:", JSON.stringify(p.approval).slice(0, 140));
  }
}
