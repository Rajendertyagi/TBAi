/**
 * `mcp_servers.disabled_tools` migration.
 *
 * The column is added by `src/db/index.ts` on boot. None of the properties
 * below is observable in-process — `src/db` binds `DATA_DIR` at import time —
 * so each case runs the REAL migration in an isolated subprocess against a
 * hand-staged database, the same convention as
 * `tests/unit/history/conversation-status-migration.test.ts`.
 *
 * Contracts pinned here:
 *
 *   - a FRESH database gets the column from the `CREATE TABLE`;
 *   - an EXISTING database that predates the column gets it added, with its
 *     rows preserved;
 *   - running the migration again is a no-op, not an error (the column is
 *     added exactly once);
 *   - a persisted filter is still loaded after a restart.
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { $ } from "bun";

const REPO = process.cwd();

/** Run a probe script against `dir` and return its `PROBE:`-tagged JSON line. */
async function runProbe(dir: string, body: string): Promise<any> {
  const script = body.replaceAll("$repo", JSON.stringify(REPO));
  const out = await $`bun -e ${script}`.env({ ...process.env, DATA_DIR: dir }).text();
  const line = out.split("\n").find((l) => l.startsWith("PROBE:"));
  if (!line) throw new Error(`probe produced no result:\n${out}`);
  return JSON.parse(line.slice("PROBE:".length));
}

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tbai-mcp-mig-"));
}

/** Import src/db (running every migration), then report the mcp_servers columns. */
const READ_COLUMNS = `
  const { db } = await import($repo + "/src/db/index.ts");
  const cols = db.query("PRAGMA table_info(mcp_servers)").all().map((c) => c.name);
  console.log("PROBE:" + JSON.stringify({ cols }));
`;

/** Create the full schema, then drop the column to simulate a pre-migration DB. */
const STAGE_LEGACY = `
  const { db } = await import($repo + "/src/db/index.ts");
  db.run("ALTER TABLE mcp_servers DROP COLUMN disabled_tools");
  db.run("INSERT INTO mcp_servers (id, name, transport, url, enabled, auto_connect, created_at, updated_at) VALUES ('legacy-1', 'legacy', 'http', 'http://localhost:1', 1, 0, 1, 1)");
  const cols = db.query("PRAGMA table_info(mcp_servers)").all().map((c) => c.name);
  console.log("PROBE:" + JSON.stringify({ cols }));
`;

/** After the migration, report the columns and the preserved rows. */
const READ_AFTER_MIGRATION = `
  const { db } = await import($repo + "/src/db/index.ts");
  const cols = db.query("PRAGMA table_info(mcp_servers)").all().map((c) => c.name);
  const rows = db.query("SELECT id, name, disabled_tools FROM mcp_servers ORDER BY id").all();
  console.log("PROBE:" + JSON.stringify({ cols, rows }));
`;

/** Persist a filter through the store, then report the new id. */
const PERSIST_FILTER = `
  const { insertConfig } = await import($repo + "/src/services/mcp/store.ts");
  const created = insertConfig({ name: "persist", transport: "http", url: "http://localhost:1", disabledTools: ["echo", "fail"] });
  console.log("PROBE:" + JSON.stringify({ id: created.id }));
`;

/** Reload a persisted filter through the store after a restart. */
const RELOAD_FILTER = `
  const { getConfig } = await import($repo + "/src/services/mcp/store.ts");
  const cfg = getConfig($id);
  console.log("PROBE:" + JSON.stringify({ disabledTools: cfg ? cfg.disabledTools : null }));
`;

/**
 * Stage a `mcp_servers` VIEW that already has `roots` but not `disabled_tools`.
 * `CREATE TABLE IF NOT EXISTS` then no-ops, and the `ALTER TABLE ... ADD COLUMN
 * disabled_tools` fails for a reason that is NOT "the column already exists".
 */
const STAGE_VIEW = `
  const { Database } = await import("bun:sqlite");
  const path = await import("node:path");
  const db = new Database(path.join(process.env.DATA_DIR, "chat.db"));
  db.run("CREATE VIEW mcp_servers AS SELECT 1 AS id, 1 AS roots");
  db.close();
  console.log("PROBE:" + JSON.stringify({ staged: true }));
`;

/** Import src/db and report whether the migration surfaced a genuine failure. */
const IMPORT_AND_REPORT = `
  let error = null;
  try {
    await import($repo + "/src/db/index.ts");
  } catch (e) {
    error = String(e).split("\\n")[0];
  }
  console.log("PROBE:" + JSON.stringify({ error }));
`;

describe("mcp_servers.disabled_tools migration", () => {
  it("a fresh database has the column", async () => {
    const { cols } = await runProbe(freshDir(), READ_COLUMNS);
    expect(cols).toContain("disabled_tools");
  }, 60000);

  it("an existing database without the column gets it added, rows preserved", async () => {
    const dir = freshDir();
    const staged = await runProbe(dir, STAGE_LEGACY);
    expect(staged.cols).not.toContain("disabled_tools");

    const { cols, rows } = await runProbe(dir, READ_AFTER_MIGRATION);
    expect(cols).toContain("disabled_tools");
    expect(rows).toEqual([{ id: "legacy-1", name: "legacy", disabled_tools: null }]);
  }, 60000);

  it("running the migration again is a no-op, not an error", async () => {
    const dir = freshDir();
    await runProbe(dir, READ_COLUMNS);
    const second = await runProbe(dir, READ_COLUMNS);
    expect(second.cols.filter((c: string) => c === "disabled_tools")).toHaveLength(1);
  }, 60000);

  it("a persisted filter is still loaded after a restart", async () => {
    const dir = freshDir();
    const { id } = await runProbe(dir, PERSIST_FILTER);
    const reloaded = await runProbe(dir, RELOAD_FILTER.replace("$id", JSON.stringify(id)));
    expect(reloaded.disabledTools).toEqual(["echo", "fail"]);
  }, 60000);

  it("a genuine migration failure surfaces instead of being swallowed", async () => {
    const dir = freshDir();
    await runProbe(dir, STAGE_VIEW);
    const { error } = await runProbe(dir, IMPORT_AND_REPORT);
    // The old bare `try/catch` reported this as success and left the column
    // missing; `addColumnIfNotExists` lets it fail the boot.
    expect(error).not.toBeNull();
    expect(error).toContain("view");
  }, 60000);
});
