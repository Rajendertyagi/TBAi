import fs from "fs";
import path from "path";
import { db } from "../db";
import { resolveDataDir } from "./server-port";

const START_MIN_KEY = "server.startMinimized";
const START_MIN_FILE = "start-minimized";

/**
 * Start-minimized preference (boot straight to tray, no window). Persisted in
 * app_settings like the port, with a one-line mirror file (`1`/`0`) the
 * Tauri shell reads before spawning — same rendezvous pattern, same reason:
 * Rust cannot practically query SQLite at startup.
 */
export function getPersistedStartMinimized(): boolean {
  try {
    const row = db
      .query("SELECT value FROM app_settings WHERE key = ?")
      .get(START_MIN_KEY) as { value: string } | undefined;
    if (!row) return false;
    const parsed: unknown = JSON.parse(row.value);
    return parsed === true;
  } catch {
    return false;
  }
}

export function persistStartMinimized(on: boolean): void {
  db.run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [START_MIN_KEY, JSON.stringify(on), Date.now()],
  );
  try {
    fs.mkdirSync(resolveDataDir(), { recursive: true });
    fs.writeFileSync(path.join(resolveDataDir(), START_MIN_FILE), on ? "1\n" : "0\n");
  } catch {
    /* mirror is advisory; the DB owns the value */
  }
}

/** Mirror-file read for the launcher (explicit dir so tests can isolate). */
export function readStartMinimizedMirror(dataDir: string = resolveDataDir()): boolean {
  try {
    return fs.readFileSync(path.join(dataDir, START_MIN_FILE), "utf8").trim() === "1";
  } catch {
    return false;
  }
}
