/**
 * MCP server configuration persistence.
 *
 * Extracted verbatim from `manager.ts`. The SQL, the column names, the auth-token
 * handling and the row→config mapping are unchanged: this module owns the
 * database, and the manager owns the connections. Nothing here reaches for a
 * live MCP connection, which is what lets `manager.ts` delegate to it without
 * the two developing a dependency on each other's state.
 *
 * ## Why the row shape is private
 *
 * `McpServerRow` mirrors the table exactly, including SQLite's snake_case and its
 * `number`-as-boolean flags. Callers get `McpServerConfig` instead, so no other
 * module can accidentally depend on the storage shape.
 *
 * ## Why `readRow` is exported
 *
 * Connecting needs the raw row AND the decrypted token, because the token is
 * what builds the transport's auth headers. Returning only a `McpServerConfig`
 * would silently drop it — the config deliberately carries no secret.
 */
import { db } from "../../db";
import type { SQLQueryBindings } from "bun:sqlite";
import { generateId } from "../../lib/utils";
import { encryptSecret, decryptSecret } from "../credentials";
import type { McpServerCreate } from "../../lib/validation";
import type { McpAuthType, McpServerConfig, McpTransport } from "./types";

/** The mcp_servers table, exactly as SQLite returns it. */
export interface McpServerRow {
  id: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string | null;
  url: string | null;
  env: string | null;
  headers: string | null;
  auth_type: string;
  auth_token: string | null;
  enabled: number;
  auto_connect: number;
  notes: string | null;
  roots: string | null;
  created_at: number;
  updated_at: number;
}

/** Parse a JSON column, falling back rather than throwing on corrupt data. */
function jsonParseSafe<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Map a stored row onto the public config shape (no secrets).
 *
 * Exported because `manager.connect` needs the same mapping when it re-reads a
 * row to build a transport - one mapping, so the config it connects with can
 * never drift from the config the settings screen displays.
 */
export function rowToConfig(row: McpServerRow): McpServerConfig {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command ?? undefined,
    args: row.args ? jsonParseSafe<string[]>(row.args, []) : undefined,
    url: row.url ?? undefined,
    env: row.env ? jsonParseSafe<Record<string, string>>(row.env, {}) : undefined,
    headers: row.headers ? jsonParseSafe<Record<string, string>>(row.headers, {}) : undefined,
    authType: (row.auth_type as McpAuthType) || "none",
    enabled: row.enabled === 1,
    autoConnect: row.auto_connect === 1,
    notes: row.notes ?? undefined,
    roots: row.roots ? jsonParseSafe<string[]>(row.roots, []) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Every configured server, oldest first. */
export function loadConfigs(): McpServerConfig[] {
  const rows = db
    .query<McpServerRow, []>("SELECT * FROM mcp_servers ORDER BY created_at ASC")
    .all();
  return rows.map(rowToConfig);
}

/** One server's config by id, or undefined when it does not exist. */
export function getConfig(id: string): McpServerConfig | undefined {
  const row = db.query<McpServerRow, [string]>("SELECT * FROM mcp_servers WHERE id = ?").get(id);
  return row ? rowToConfig(row) : undefined;
}

/**
 * Read a row including its (decrypted) auth token.
 *
 * A token that fails to decrypt is dropped rather than thrown: a corrupt secret
 * must not make an otherwise-valid server unreachable, and `buildHeaders`
 * already treats an absent token as "no auth".
 */
export function readRow(id: string): { row: McpServerRow; authToken?: string } | undefined {
  const row = db.query<McpServerRow, [string]>("SELECT * FROM mcp_servers WHERE id = ?").get(id);
  if (!row) return undefined;
  let authToken: string | undefined;
  if (row.auth_token) {
    try {
      authToken = decryptSecret(row.auth_token);
    } catch {
      authToken = undefined;
    }
  }
  return { row, authToken };
}

/** Insert a new server and return its stored config. */
export function insertConfig(input: McpServerCreate): McpServerConfig {
  const id = generateId();
  const now = Date.now();
  const enabled = input.enabled ?? true;
  const autoConnect = input.autoConnect ?? true;
  const authTokenEnv = input.authToken ? encryptSecret(input.authToken) : null;
  db.run(
    `INSERT INTO mcp_servers
        (id, name, transport, command, args, url, env, headers, auth_type, auth_token, enabled, auto_connect, notes, roots, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      input.transport,
      input.command ?? null,
      input.args ? JSON.stringify(input.args) : null,
      input.url ?? null,
      input.env ? JSON.stringify(input.env) : null,
      input.headers ? JSON.stringify(input.headers) : null,
      input.authType ?? "none",
      authTokenEnv,
      enabled ? 1 : 0,
      autoConnect ? 1 : 0,
      input.notes ?? null,
      input.roots ? JSON.stringify(input.roots) : null,
      now,
      now,
    ],
  );
  return getConfig(id)!;
}

/**
 * Apply a partial update to one server, returning its new config.
 *
 * Only the fields present in `input` are written. The auth token has a three-way
 * contract that callers depend on and that is deliberately NOT simplified here:
 * omitted (`undefined`/`null`) preserves the stored credential, a non-empty
 * string replaces it, and an explicit empty string clears it — the UI sends `""`
 * from its "Remove auth" action.
 */
export function updateConfigRow(
  id: string,
  input: Partial<McpServerCreate>,
): McpServerConfig | undefined {
  const existing = getConfig(id);
  if (!existing) return undefined;
  const now = Date.now();
  const sets: string[] = [];
  const values: SQLQueryBindings[] = [];
  const set = (col: string, value: SQLQueryBindings) => {
    sets.push(`${col} = ?`);
    values.push(value);
  };
  if (input.name !== undefined) set("name", input.name);
  if (input.transport !== undefined) set("transport", input.transport);
  if (input.command !== undefined) set("command", input.command ?? null);
  if (input.args !== undefined) set("args", input.args ? JSON.stringify(input.args) : null);
  if (input.url !== undefined) set("url", input.url ?? null);
  if (input.env !== undefined) set("env", input.env ? JSON.stringify(input.env) : null);
  if (input.headers !== undefined)
    set("headers", input.headers ? JSON.stringify(input.headers) : null);
  if (input.authType !== undefined) set("auth_type", input.authType);
  // Auth token trichotomy: omitted (undefined/null) preserves the stored
  // credential; a non-empty string replaces it; an explicit empty string
  // clears it (persists NULL). The UI sends "" from its "Remove auth" action.
  if (input.authToken !== undefined && input.authToken !== null) {
    if (input.authToken === "") {
      set("auth_token", null);
    } else {
      set("auth_token", encryptSecret(input.authToken));
    }
  }
  if (input.roots !== undefined) set("roots", input.roots ? JSON.stringify(input.roots) : null);
  if (input.enabled !== undefined) set("enabled", input.enabled ? 1 : 0);
  if (input.autoConnect !== undefined) set("auto_connect", input.autoConnect ? 1 : 0);
  if (input.notes !== undefined) set("notes", input.notes ?? null);
  set("updated_at", now);
  db.run(`UPDATE mcp_servers SET ${sets.join(", ")} WHERE id = ?`, [...values, id]);
  return getConfig(id);
}

/** Remove a server's row. Connection teardown is the caller's job. */
export function deleteConfigRow(id: string): void {
  db.run("DELETE FROM mcp_servers WHERE id = ?", [id]);
}

/** Flip a server's enabled flag. Connect/disconnect is the caller's job. */
export function setEnabledRow(id: string, enabled: boolean): void {
  db.run("UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?", [
    enabled ? 1 : 0,
    Date.now(),
    id,
  ]);
}
