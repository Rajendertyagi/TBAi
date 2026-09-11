import { db } from "../src/db/index.ts";
const res = db.run("DELETE FROM mcp_servers WHERE name = 'minimal-test'");
console.log("deleted rows:", res);
const rows = db.query("SELECT id, name FROM mcp_servers").all();
console.log("remaining mcp_servers:", JSON.stringify(rows));
