export type LogLevel = "debug" | "info" | "warn" | "error";

export type CaptureLevel = "off" | "error" | "warn" | "info" | "debug";

export interface LogEntry {
  seq: number;
  time: string;
  level: LogLevel;
  scope: string;
  event?: string;
  message?: string;
  [key: string]: unknown;
}

export interface ScopeTarget {
  scope: string;
  level: CaptureLevel;
}

export interface FileSettings {
  enabled: boolean;
  path?: string;
  maxMb: number;
  keepFiles: number;
  maxTotalMb: number;
  retentionHours: number;
}

export interface LogFileInfo {
  name: string;
  size_bytes: number;
}

export interface RetentionInfo {
  retentionHours: number;
  maxTotalMb: number;
  totalBytes: number;
  fileCount: number;
  oldestMs: number | null;
  newestMs: number | null;
}

export interface LogBatch {
  entries: LogEntry[];
  bootId: string;
  reset?: boolean;
}

export interface ThrottleInfo {
  throttled: Array<{ scope: string; dropped: number }>;
}

export interface DateRange {
  from: string | null;
  to: string | null;
}
