/**
 * Regression: `conversations.status` must end up binary
 * (`IN ('regular','archived')`). SQLite cannot ALTER a CHECK constraint, so
 * any older CHECK (legacy binary-with-old-default or the interim 4-status
 * model) requires a table rebuild — value-only migration leaves the stale
 * constraint in place and every new-vocabulary INSERT fails.
 *
 * Runs the real `src/db` migration in isolated subprocesses against
 * hand-built legacy databases (subprocess isolation: src/db binds DATA_DIR
 * at import time, so in-process testing cannot stage a legacy file first).
 */
import { describe, it, expect } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { Database } from "bun:sqlite";
import { $ } from "bun";

function conversationsDDL(statusFragment: string): string {
  return `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    provider_id TEXT,
    system_prompt TEXT,
    status ${statusFragment},
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    title_source TEXT CHECK(title_source IN ('auto', 'user')),
    model_id TEXT,
    reasoning_level TEXT,
    workspace_mode TEXT NOT NULL DEFAULT 'simple',
    workspace_folder_id TEXT
  )
`;
}

function stageDb(
  dir: string,
  ddl: string,
  convRows: Array<[string, string, string]>,
): void {
  const db = new Database(path.join(dir, "chat.db"));
  db.run(ddl);
  db.run(
    "CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT, content TEXT NOT NULL, parent_id TEXT, order_seq INTEGER NOT NULL DEFAULT 0, status TEXT, format TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE)",
  );
  for (const [id, title, status] of convRows) {
    db.run(
      "INSERT INTO conversations (id, title, status, created_at, updated_at, workspace_mode) VALUES (?, ?, ?, 1, 1, 'simple')",
      [id, title, status],
    );
  }
  db.run(
    "INSERT INTO messages (id, conversation_id, role, content, created_at, updated_at) VALUES ('m1', 'c-keep', 'user', 'hi', 1, 1)",
  );
  db.close();
}

const PROBE = `
  const { db } = await import($repo + "/src/db/index.ts");
  const { conversationService } = await import($repo + "/src/services/storage/index.ts");
  const def = db.query("SELECT sql FROM sqlite_master WHERE name = 'conversations'").get();
  const rows = db.query("SELECT id, title, status FROM conversations ORDER BY id").all();
  const msgs = db.query("SELECT COUNT(*) AS c FROM messages").get();
  const idx = db.query("SELECT name FROM sqlite_master WHERE tbl_name = 'conversations' AND type = 'index' AND sql IS NOT NULL").all();
  const fk = db.query("PRAGMA foreign_key_check").all();
  let created = null;
  let createError = null;
  try {
    created = await conversationService.create({ title: "probe", providerId: null, modelId: null, reasoningLevel: null, systemPrompt: null, workspaceMode: "simple", workspaceFolderId: null });
  } catch (e) {
    createError = String(e);
  }
  console.log(JSON.stringify({ def: def.sql, rows, msgs: msgs.c, idx: idx.map((i) => i.name), fk: fk.length, createdId: created && created.id, createdStatus: created && created.status, createError }));
`;

interface ProbeResult {
  def: string;
  rows: Array<{ id: string; title: string; status: string }>;
  msgs: number;
  idx: string[];
  fk: number;
  createdId: string | null;
  createdStatus: string | null;
  createError: string | null;
}

async function runMigration(
  ddl: string,
  convRows: Array<[string, string, string]>,
): Promise<ProbeResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-legacy-"));
  stageDb(dir, ddl, convRows);
  const repo = process.cwd();
  const out =
    await $`bun -e ${PROBE.replaceAll("$repo", JSON.stringify(repo))}`
      .env({ ...process.env, DATA_DIR: dir })
      .text();
  return JSON.parse(out.trim().split("\n").pop() as string) as ProbeResult;
}

const BINARY_CHECK = "CHECK(status IN ('regular', 'archived'))";

describe("conversations binary status migration", () => {
  it("legacy binary CHECK: values preserved, creation succeeds", async () => {
    const result = await runMigration(
      conversationsDDL("TEXT NOT NULL DEFAULT 'regular' CHECK(status IN ('regular', 'archived'))"),
      [
        ["c-keep", "Keep me", "regular"],
        ["c-old", "Keep me too", "archived"],
      ],
    );
    expect(result.def).toContain(BINARY_CHECK);
    expect(result.rows).toEqual([
      { id: "c-keep", title: "Keep me", status: "regular" },
      { id: "c-old", title: "Keep me too", status: "archived" },
    ]);
    expect(result.msgs).toBe(1);
    expect(result.idx).toContain("idx_conversations_updated_at");
    expect(result.idx).toContain("idx_conversations_title");
    expect(result.fk).toBe(0);
    expect(result.createError).toBeNull();
    expect(result.createdId).toBeTruthy();
    expect(result.createdStatus).toBe("regular");
  }, 60000);

  it("interim 4-status CHECK: rebuilt to binary, values mapped, creation succeeds", async () => {
    const result = await runMigration(
      conversationsDDL(
        "TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'pending_review', 'completed', 'cancelled'))",
      ),
      [
        ["c-keep", "Keep me", "in_progress"],
        ["c-old", "Keep me too", "completed"],
      ],
    );
    expect(result.def).toContain(BINARY_CHECK);
    expect(result.def).not.toContain("'in_progress', 'pending_review'");
    expect(result.rows).toEqual([
      { id: "c-keep", title: "Keep me", status: "regular" },
      { id: "c-old", title: "Keep me too", status: "archived" },
    ]);
    expect(result.msgs).toBe(1);
    expect(result.idx).toContain("idx_conversations_updated_at");
    expect(result.idx).toContain("idx_conversations_title");
    expect(result.fk).toBe(0);
    expect(result.createError).toBeNull();
    expect(result.createdId).toBeTruthy();
    expect(result.createdStatus).toBe("regular");
  }, 60000);
});
