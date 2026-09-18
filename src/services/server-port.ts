import fs from "fs";
import path from "path";
import { db } from "../db";

export const DEFAULT_WEB_PORT = 3000;
const PORT_SETTING_KEY = "server.port";
const PORT_FILE_NAME = "port";

/** Data dir shared with db/index.ts (DATA_DIR env or ./data). Single place. */
export function resolveDataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), "data");
}

/** True when the environment owns the port (UI locks editing, like log env locks). */
export function isPortEnvLocked(): boolean {
  const raw = process.env.PORT;
  return raw !== undefined && raw.trim() !== "";
}

function parsePortText(raw: string): number | null {
  const port = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/** Port persisted in app_settings, or null when never saved (or corrupt). */
export function getPersistedPort(): number | null {
  try {
    const row = db
      .query("SELECT value FROM app_settings WHERE key = ?")
      .get(PORT_SETTING_KEY) as { value: string } | undefined;
    if (!row) return null;
    const parsed: unknown = JSON.parse(row.value);
    if (typeof parsed === "number") return parsePortText(String(parsed));
    if (typeof parsed === "string") return parsePortText(parsed);
    return null;
  } catch {
    return null;
  }
}

/**
 * Effective configured port: explicit PORT env wins, then the persisted
 * setting, then the default. The env lock is reported separately so the UI
 * can disable editing instead of fighting the operator.
 */
export function resolveConfiguredPort(): { port: number; envLocked: boolean } {
  if (isPortEnvLocked()) {
    return { port: parsePortText(process.env.PORT as string) ?? DEFAULT_WEB_PORT, envLocked: true };
  }
  return { port: getPersistedPort() ?? DEFAULT_WEB_PORT, envLocked: false };
}

/**
 * Mirror the configured port to a tiny text file in the data dir. This is the
 * cross-process contract the Tauri shell reads at startup (before SQLite is
 * practical to open from Rust): one line, the port number. Best-effort —
 * a mirror failure never breaks the running server; the DB is the source of
 * truth and the mirror is rewritten on every boot and every persist.
 */
export function writePortFile(port: number): void {
  try {
    fs.mkdirSync(resolveDataDir(), { recursive: true });
    fs.writeFileSync(path.join(resolveDataDir(), PORT_FILE_NAME), `${port}\n`);
  } catch {
    /* mirror is advisory; the DB owns the value */
  }
}

/** Persist the configured port (DB source of truth + Tauri mirror file). */
export function persistConfiguredPort(port: number): void {
  db.run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [PORT_SETTING_KEY, JSON.stringify(port), Date.now()],
  );
  writePortFile(port);
}
