import { Database } from "bun:sqlite";
import path from "path";
import fs from "fs";
import { logger } from "../lib/logger";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "chat.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

const sqlite = new Database(DB_PATH);

// Enable WAL mode for better concurrency
sqlite.run("PRAGMA journal_mode=WAL");

// Phase 5: brief busy-wait so a contended lock retries internally instead of
// throwing SQLITE_BUSY immediately. Defensive only — the single synchronous
// bun:sqlite connection cannot self-contend; this covers a second process
// (inspector/script) touching the same file. Not a shutdown mechanism:
// ordered settlement (Phase 3) is what keeps writes ahead of db.close().
const SQLITE_BUSY_TIMEOUT_MS = 5000;
sqlite.run(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`);

// Create tables
sqlite.run(`
  CREATE TABLE IF NOT EXISTS provider_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('openai', 'anthropic', 'google', 'ollama', 'custom')),
    encrypted_api_key TEXT,
    credential_version INTEGER,
    endpoint TEXT,
    model TEXT NOT NULL,
    is_active INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

// Local data-encryption key (DEK) for provider credentials. A random 32-byte key is
// generated once and stored here; it lives in the same SQLite file as the app data so
// the portable app folder remains self-contained. Secrets themselves are encrypted in
// provider_configs.encrypted_api_key.
sqlite.run(`
  CREATE TABLE IF NOT EXISTS credential_key (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    key_hex TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

// Durable key/value app settings (runtime log capture level/overrides, ...).
// Single-row-per-key; values are JSON. Read at boot, written by settings APIs.
sqlite.run(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

sqlite.run(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    provider_id TEXT,
    system_prompt TEXT,
    status TEXT NOT NULL DEFAULT 'regular' CHECK(status IN ('regular', 'archived')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

// Per-conversation durable to-do notepad (model-driven, user-owned). Cascade
// deletes with the parent conversation so abandoned threads leave no orphans.
sqlite.run(`
  CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES conversations(id) ON DELETE CASCADE
  )
`);
sqlite.run("CREATE INDEX IF NOT EXISTS idx_todos_thread ON todos(thread_id, position)");

const CREATE_MESSAGES = `
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT,
    content TEXT NOT NULL,
    parent_id TEXT,
    order_seq INTEGER NOT NULL DEFAULT 0,
    status TEXT,
    format TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  )
`;

sqlite.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    parent_id TEXT,
    order_seq INTEGER NOT NULL DEFAULT 0,
    status TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  )
`);

// Idempotent migrations for existing databases (add columns introduced for
// assistant-ui thread history persistence). The content column already exists;
// it now stores the serialized assistant-ui storage format (JSON) instead of a
// plain string. Old string-format rows are incompatible, so clear them.
function addColumnIfNotExists(table: string, column: string, definition: string) {
  const columns = sqlite.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    sqlite.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const messagesColumns = sqlite.query("PRAGMA table_info(messages)").all() as Array<{ name: string; notnull: number }>;
const messagesHadOrderSeq = messagesColumns.some((c) => c.name === "order_seq");
const roleIsNotNull = (messagesColumns.find((c) => c.name === "role")?.notnull ?? 0) === 1;

addColumnIfNotExists("conversations", "status", "TEXT NOT NULL DEFAULT 'regular'");
// Rebuild `conversations` unless it already carries the binary status CHECK
// (`IN ('regular', 'archived')`). SQLite cannot ALTER a CHECK constraint, so
// any older CHECK (legacy binary-with-wrong-default or the interim 4-status
// model) is replaced by a table rebuild: copy all columns (mapping every
// known status into the binary model in SQL), preserve ids (FKs from
// messages/todos and conv_fts rows stay valid), recreate indexes; the FTS
// trigger block below recreates the dropped triggers. Idempotent: no-op once
// the binary CHECK is present. Never crashes startup: failure rolls back
// and logs.
try {
  const def = sqlite.query("SELECT sql FROM sqlite_master WHERE name = 'conversations'").get() as
    | { sql: string }
    | undefined;
  const needsRebuild =
    !!def?.sql &&
    !/CHECK\s*\(\s*status\s+IN\s*\(\s*'regular'\s*,\s*'archived'\s*\)/i.test(def.sql);
  if (needsRebuild) {
    const before = (sqlite.query("SELECT COUNT(*) AS c FROM conversations").get() as { c: number }).c;
    sqlite.run("PRAGMA foreign_keys=OFF");
    try {
      sqlite.run("BEGIN");
      sqlite.run("DROP TRIGGER IF EXISTS trg_conv_fts_ai");
      sqlite.run("DROP TRIGGER IF EXISTS trg_conv_fts_au");
      sqlite.run("DROP TRIGGER IF EXISTS trg_conv_fts_ad");
      sqlite.run(`
        CREATE TABLE conversations_new (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          provider_id TEXT,
          system_prompt TEXT,
          status TEXT NOT NULL DEFAULT 'regular' CHECK(status IN ('regular', 'archived')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          title_source TEXT CHECK(title_source IN ('auto', 'user')),
          model_id TEXT,
          reasoning_level TEXT,
          workspace_mode TEXT NOT NULL DEFAULT 'simple',
          workspace_folder_id TEXT
        )
      `);
      sqlite.run(`
        INSERT INTO conversations_new (id, title, provider_id, system_prompt, status, created_at, updated_at, title_source, model_id, reasoning_level, workspace_mode, workspace_folder_id)
        SELECT id, title, provider_id, system_prompt,
          CASE status
            WHEN 'archived' THEN 'archived'
            WHEN 'completed' THEN 'archived'
            WHEN 'cancelled' THEN 'archived'
            ELSE 'regular'
          END,
          created_at, updated_at, title_source, model_id, reasoning_level, workspace_mode, workspace_folder_id
        FROM conversations
      `);
      sqlite.run("DROP TABLE conversations");
      sqlite.run("ALTER TABLE conversations_new RENAME TO conversations");
      sqlite.run("CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC)");
      sqlite.run("CREATE INDEX IF NOT EXISTS idx_conversations_title ON conversations(title)");
      sqlite.run("COMMIT");
    } catch (e) {
      try {
        sqlite.run("ROLLBACK");
      } catch { /* already rolled back */ }
      throw e;
    } finally {
      sqlite.run("PRAGMA foreign_keys=ON");
    }
    const after = (sqlite.query("SELECT COUNT(*) AS c FROM conversations").get() as { c: number }).c;
    logger.info("db", "conversations_status_check_rebuilt", {
      message: `conversations=${before}->${after}`,
    });
  }
} catch (err) {
  logger.error("db", "conversations_rebuild_failed", {
    message: err instanceof Error ? err.message : String(err),
  });
}
addColumnIfNotExists("conversations", "provider_id", "TEXT");
addColumnIfNotExists("messages", "parent_id", "TEXT");
addColumnIfNotExists("messages", "order_seq", "INTEGER NOT NULL DEFAULT 0");
addColumnIfNotExists("messages", "status", "TEXT");
addColumnIfNotExists("messages", "format", "TEXT");
addColumnIfNotExists("messages", "updated_at", "INTEGER NOT NULL DEFAULT 0");
addColumnIfNotExists("conversations", "title_source", "TEXT CHECK(title_source IN ('auto', 'user'))");
// Per-conversation AI configuration (conversation default, SQLite source of truth).
addColumnIfNotExists("conversations", "model_id", "TEXT");
addColumnIfNotExists("conversations", "reasoning_level", "TEXT");
// Two-mode workspace model (codeg-aligned): a conversation is either a Simple Chat
// (disposable per-conversation workspace) or a Project Chat attached to a
// registered folder. The folder ID is the canonical identity; the path is
// resolved server-side. Legacy conversations default to 'simple'.
addColumnIfNotExists("conversations", "workspace_mode", "TEXT NOT NULL DEFAULT 'simple'");
addColumnIfNotExists("conversations", "workspace_folder_id", "TEXT");
// OpenCode agent mode: the OpenCode session id bound to this conversation.
// Kept separate from normal chat messages; TBAi owns the conversation, OpenCode
// owns its session/events. Null until Code mode is first opened.
addColumnIfNotExists("conversations", "opencode_session_id", "TEXT");
// Engine selection (Direct chat vs OpenCode agent mode) and the OpenCode
// agent/model chosen at creation. Nullable: legacy conversations are Direct and
// carry no OpenCode selection.
addColumnIfNotExists("conversations", "engine", "TEXT");
addColumnIfNotExists("conversations", "opencode_agent", "TEXT");
addColumnIfNotExists("conversations", "opencode_model", "TEXT");
// OpenCode thinking level (model variant) chosen at creation, e.g. "low"/"high".
// Null = Default (omit the variant field on prompt_async).
addColumnIfNotExists("conversations", "opencode_variant", "TEXT");
// Per-conversation Auto Approval shield (Phase 6D-B). 0 = manual (ask), 1 = auto
// (accept once). Fail-closed: absent rows read manual.
addColumnIfNotExists("conversations", "opencode_auto_approve", "INTEGER NOT NULL DEFAULT 0");

// The original messages table had `role TEXT NOT NULL` and stored a plain-text
// content format incompatible with the assistant-ui storage format we now
// persist. Recreate the table with a nullable role (no longer used) and the new
// `format` column, dropping any old message rows.
if (roleIsNotNull) {
  sqlite.run("DROP TABLE messages");
  sqlite.run(CREATE_MESSAGES);
} else if (!messagesHadOrderSeq) {
  // Existing message rows used a plain-text content format incompatible with the
  // assistant-ui storage format we now persist. Drop them on migration.
  sqlite.run("DELETE FROM messages");
}

// Migrate away from plaintext API keys: drop the legacy api_key column (if present
// from an earlier schema) and ensure the encrypted columns exist. Existing plaintext
// keys are intentionally not carried over — they must be re-entered (secure by design).
const providerColumns = sqlite
  .query("PRAGMA table_info(provider_configs)")
  .all() as Array<{ name: string }>;
if (providerColumns.some((c) => c.name === "api_key")) {
  sqlite.run("ALTER TABLE provider_configs DROP COLUMN api_key");
}
addColumnIfNotExists("provider_configs", "encrypted_api_key", "TEXT");
addColumnIfNotExists("provider_configs", "credential_version", "INTEGER");
addColumnIfNotExists("provider_configs", "models", "TEXT");
addColumnIfNotExists("provider_configs", "thinking", "TEXT");
addColumnIfNotExists("provider_configs", "api_protocol", "TEXT");

sqlite.run(`
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

// MCP server registry (generic MCP client configuration). Stored locally; auth
// tokens are encrypted under the same local DEK used for provider credentials.
sqlite.run(`
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    transport TEXT NOT NULL CHECK(transport IN ('stdio', 'http', 'sse')),
    command TEXT,
    args TEXT,
    url TEXT,
    env TEXT,
    headers TEXT,
    auth_type TEXT NOT NULL DEFAULT 'none',
    auth_token TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    auto_connect INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    roots TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

// Idempotent migration: add the `roots` column if an older DB lacks it.
try {
  sqlite.run("ALTER TABLE mcp_servers ADD COLUMN roots TEXT");
} catch {
  // Column already exists; ignore.
}

// Create indexes
sqlite.run("CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)");
sqlite.run("CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC)");
sqlite.run("CREATE INDEX IF NOT EXISTS idx_conversations_title ON conversations(title)");
sqlite.run("CREATE INDEX IF NOT EXISTS idx_messages_conv_content ON messages(conversation_id, content)");

// Full-text search sidecar (additive; existing DBs keep all rows). FTS5 is
// bundled with bun:sqlite. Triggers keep the index in sync; backfill runs once.
sqlite.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS conv_fts USING fts5(
    conversation_id UNINDEXED,
    title,
    content,
    tokenize='unicode61 remove_diacritics 2'
  )
`);
sqlite.run(`
  CREATE TRIGGER IF NOT EXISTS trg_conv_fts_ai AFTER INSERT ON conversations BEGIN
    INSERT INTO conv_fts (conversation_id, title, content)
    VALUES (new.id, new.title, '');
  END
`);
sqlite.run(`
  CREATE TRIGGER IF NOT EXISTS trg_conv_fts_au AFTER UPDATE OF title ON conversations BEGIN
    UPDATE conv_fts SET title = new.title WHERE conversation_id = new.id;
  END
`);
sqlite.run(`
  CREATE TRIGGER IF NOT EXISTS trg_conv_fts_ad AFTER DELETE ON conversations BEGIN
    DELETE FROM conv_fts WHERE conversation_id = old.id;
  END
`);
sqlite.run(`
  CREATE TRIGGER IF NOT EXISTS trg_msg_fts_ai AFTER INSERT ON messages BEGIN
    UPDATE conv_fts SET content = coalesce(content, '') || ' ' || new.content
    WHERE conversation_id = new.conversation_id;
  END
`);
// One-time backfill for pre-existing rows (no-op once populated).
try {
  const ftsCount = (sqlite.query("SELECT COUNT(*) as c FROM conv_fts").get() as { c: number }).c;
  if (ftsCount === 0) {
    sqlite.run(`
      INSERT INTO conv_fts (conversation_id, title, content)
      SELECT c.id, c.title, coalesce(group_concat(m.content, ' '), '')
      FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
      GROUP BY c.id
    `);
  }
} catch {
  // FTS unavailable or already populated; title/message LIKE fallback still works.
}

// ---- Folders / workspace registry (codeg-aligned two-mode model) ----
// Registered project folders the user can attach a Project Chat to, plus folder
// links (authorization records for allowed/linked paths) and folder groups. The
// folder ID is the canonical identity; paths are resolved server-side.
sqlite.run(`
  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    alias TEXT,
    color TEXT NOT NULL DEFAULT '#6b7280',
    group_id TEXT,
    is_open INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'regular' CHECK(kind IN ('regular', 'chat')),
    last_opened_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )
`);

sqlite.run(`
  CREATE TABLE IF NOT EXISTS folder_links (
    id TEXT PRIMARY KEY,
    folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    target_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

sqlite.run(`
  CREATE TABLE IF NOT EXISTS folder_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'inherit',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

sqlite.run("CREATE INDEX IF NOT EXISTS idx_folders_group ON folders(group_id)");
sqlite.run("CREATE INDEX IF NOT EXISTS idx_folders_sort ON folders(sort_order)");
sqlite.run("CREATE INDEX IF NOT EXISTS idx_folder_links_folder ON folder_links(folder_id)");
sqlite.run("CREATE INDEX IF NOT EXISTS idx_folder_groups_sort ON folder_groups(sort_order)");

// ---- Quick messages (user-saved reusable snippets) ----
// Title + content + manual sort order. No seeds: empty until the user
// creates entries on the Quick Messages settings page.
sqlite.run(`
  CREATE TABLE IF NOT EXISTS quick_messages (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);
sqlite.run("CREATE INDEX IF NOT EXISTS idx_quick_messages_sort ON quick_messages(sort_order)");

// ---- Built-in scheduler (TBAi cron) — additive tables, existing data untouched ----
sqlite.run(`
  CREATE TABLE IF NOT EXISTS scheduler_jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    schedule_type TEXT NOT NULL CHECK(schedule_type IN ('once', 'cron')),
    cron_expression TEXT,
    exec_at INTEGER,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    thinking_level TEXT,
    workspace_path TEXT NOT NULL,
    prompt TEXT NOT NULL,
    conversation_policy TEXT NOT NULL DEFAULT 'dedicated_thread',
    conversation_id TEXT,
    overlap_policy TEXT NOT NULL DEFAULT 'skip_if_running',
    max_retries INTEGER NOT NULL DEFAULT 0,
    retry_delay_seconds INTEGER NOT NULL DEFAULT 60,
    timeout_seconds INTEGER NOT NULL DEFAULT 600,
    missed_grace_seconds INTEGER NOT NULL DEFAULT 600,
    next_run_at INTEGER,
    last_run_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

sqlite.run(`
  CREATE TABLE IF NOT EXISTS scheduler_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES scheduler_jobs(id) ON DELETE CASCADE,
    occurrence_id TEXT NOT NULL,
    request_id TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    status TEXT NOT NULL DEFAULT 'scheduled',
    error TEXT,
    output_excerpt TEXT,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    conversation_id TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE(job_id, occurrence_id)
  )
`);

// Additive migration: add conversation_id to scheduler_runs if this column was
// introduced after the table was first created.
try {
  sqlite.run("ALTER TABLE scheduler_runs ADD COLUMN conversation_id TEXT");
} catch {
  /* column already exists; ignore */
}

sqlite.run("CREATE INDEX IF NOT EXISTS idx_scheduler_runs_job ON scheduler_runs(job_id, started_at DESC)");
sqlite.run("CREATE INDEX IF NOT EXISTS idx_scheduler_runs_status ON scheduler_runs(status)");
sqlite.run("CREATE INDEX IF NOT EXISTS idx_scheduler_jobs_next ON scheduler_jobs(enabled, next_run_at)");

// One-time repair: scheduler runs used to persist every message with
// parent_id NULL, building a forest of disconnected roots the thread view
// could not render (messages stored but invisible). Chain orphan rows after
// the first chronological message within scheduler-job threads only.
// Content is untouched; user-typed messages (already chained) are untouched;
// re-running is a no-op since repaired rows are no longer NULL.
export function repairSchedulerThreadChains(database: Database = sqlite): void {
  database.run(
    `
  UPDATE messages SET parent_id = (
    SELECT m2.id FROM messages m2
    WHERE m2.conversation_id = messages.conversation_id
      AND m2.order_seq < messages.order_seq
    ORDER BY m2.order_seq DESC LIMIT 1
  )
  WHERE parent_id IS NULL
    AND conversation_id IN (SELECT conversation_id FROM scheduler_jobs WHERE conversation_id IS NOT NULL)
    AND EXISTS (
      SELECT 1 FROM messages m0
      WHERE m0.conversation_id = messages.conversation_id
        AND m0.order_seq < messages.order_seq
    )
  `,
  );
}

repairSchedulerThreadChains();

export const db = sqlite;
