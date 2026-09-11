import { Database } from "bun:sqlite";
import path from "path";
import fs from "fs";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "chat.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

const sqlite = new Database(DB_PATH);

// Enable WAL mode for better concurrency
sqlite.run("PRAGMA journal_mode=WAL");

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
addColumnIfNotExists("conversations", "provider_id", "TEXT");
addColumnIfNotExists("messages", "parent_id", "TEXT");
addColumnIfNotExists("messages", "order_seq", "INTEGER NOT NULL DEFAULT 0");
addColumnIfNotExists("messages", "status", "TEXT");
addColumnIfNotExists("messages", "format", "TEXT");
addColumnIfNotExists("messages", "updated_at", "INTEGER NOT NULL DEFAULT 0");

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
    attempt INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE(job_id, occurrence_id)
  )
`);

sqlite.run("CREATE INDEX IF NOT EXISTS idx_scheduler_runs_job ON scheduler_runs(job_id, started_at DESC)");
sqlite.run("CREATE INDEX IF NOT EXISTS idx_scheduler_runs_status ON scheduler_runs(status)");
sqlite.run("CREATE INDEX IF NOT EXISTS idx_scheduler_jobs_next ON scheduler_jobs(enabled, next_run_at)");

export const db = sqlite;
