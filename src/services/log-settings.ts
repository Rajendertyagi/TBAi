import { db } from "../db";
import {
  defaultLogFilePath,
  logger,
  type LogLevelFilter,
  type LogTargetDirective,
} from "../lib/logger";
import { logSettingsSchema } from "../lib/validation";

const KEY = "log.settings";

export interface PersistedFileSettings {
  enabled: boolean;
  maxMb: number;
  keepFiles: number;
  maxTotalMb: number;
  retentionHours: number;
}

export interface PersistedLogSettings {
  level: LogLevelFilter;
  targets: LogTargetDirective[];
  file?: PersistedFileSettings;
}

/** True when the environment owns the capture level (UI controls lock). */
export function isLogLevelEnvLocked(): boolean {
  return process.env.TBAI_LOG_LEVEL !== undefined && process.env.TBAI_LOG_LEVEL !== "";
}

/** True when the environment owns the sink path (file toggle locks). */
export function isLogFileEnvLocked(): boolean {
  return process.env.TBAI_LOG_FILE !== undefined && process.env.TBAI_LOG_FILE !== "";
}

/** Persisted capture settings, or null when never saved (or corrupt). */
export function getPersistedLogSettings(): PersistedLogSettings | null {
  try {
    const row = db
      .query("SELECT value FROM app_settings WHERE key = ?")
      .get(KEY) as { value: string } | undefined;
    if (!row) return null;
    const parsed = logSettingsSchema.safeParse(JSON.parse(row.value));
    if (!parsed.success) return null;
    return {
      level: parsed.data.level,
      targets: parsed.data.targets,
      file: parsed.data.file,
    };
  } catch {
    return null;
  }
}

export function persistLogSettings(settings: PersistedLogSettings): void {
  db.run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [KEY, JSON.stringify(settings), Date.now()],
  );
}

function applyFileSettings(file: PersistedFileSettings | undefined): void {
  if (isLogFileEnvLocked() || !file) return;
  logger.configure({
    file: file.enabled ? defaultLogFilePath() : null,
    fileEnabled: file.enabled,
    maxBytes: Math.floor(file.maxMb * 1024 * 1024),
    keepFiles: Math.max(1, Math.floor(file.keepFiles)),
    maxTotalBytes: Math.floor(file.maxTotalMb * 1024 * 1024),
    retentionMs: Math.floor(file.retentionHours * 3600 * 1000),
  });
}

/** Apply persisted capture settings at boot. Never throws: env owns the
 *  level when TBAI_LOG_LEVEL is set, otherwise stored settings win. */
export function applyPersistedLogSettings(): void {
  try {
    const stored = getPersistedLogSettings();
    if (!stored) return;
    if (!isLogLevelEnvLocked()) {
      logger.configure({ level: stored.level, targets: stored.targets });
    }
    applyFileSettings(stored.file);
  } catch {
    /* boot continues with env defaults */
  }
}
