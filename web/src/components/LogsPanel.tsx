import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Download,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCw,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Virtualizer } from "virtua";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { maxSeq, mergeLogEntries, serializeLogEntries } from "../lib/log-entries";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

/**
 * Runtime log settings + live viewer (local-only).
 *
 * Three cards: capture level (what the server records, with per-scope
 * overrides), live viewer (SSE tail of the in-memory ring), and on-disk log
 * files (the server's own rotated sink — read-only here, never a new writer).
 * Entries are redacted server-side; this view never receives secrets.
 */

type CaptureLevel = "off" | "error" | "warn" | "info" | "debug";

interface ScopeTarget {
  scope: string;
  level: CaptureLevel;
}

interface FileSettings {
  enabled: boolean;
  maxMb: number;
  keepFiles: number;
  maxTotalMb: number;
  retentionHours: number;
}

interface LogEntry {
  seq: number;
  time: string;
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  event?: string;
  message?: string;
  [key: string]: unknown;
}

interface LogFileInfo {
  name: string;
  size_bytes: number;
}

interface RetentionInfo {
  retentionHours: number;
  maxTotalMb: number;
  totalBytes: number;
  fileCount: number;
  oldestMs: number | null;
  newestMs: number | null;
}

// Capture levels offered in the level dropdown (controls what the backend
// records). `off` disables capture entirely.
const CAPTURE_LEVELS: CaptureLevel[] = ["off", "error", "warn", "info", "debug"];

// View filter: minimum severity to display (client-side). "all" keeps every
// record currently in the buffer.
const VIEW_LEVELS = ["all", "error", "warn", "info", "debug"] as const;

// Scope paths are dot-separated idents; an override matches its scope and
// everything below it. Rows failing this are flagged and excluded from saves.
const SCOPE_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

const CURATED_SCOPES = [
  "http",
  "chat",
  "ai.provider",
  "mcp",
  "tools",
  "storage",
  "server",
  "scheduler",
  "memory",
  "workspace",
  "conversations",
];

const LEVEL_RANK: Record<string, number> = {
  error: 4,
  warn: 3,
  info: 2,
  debug: 1,
};

const MIN_RANK: Record<string, number> = {
  all: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

function validTargets(targets: ScopeTarget[]): ScopeTarget[] {
  return targets
    .map((t) => ({ ...t, scope: t.scope.trim() }))
    .filter((t) => SCOPE_RE.test(t.scope));
}

function matchesFilter(
  e: LogEntry,
  minLevel: string,
  search: string,
  range?: { from: number | null; until: number | null },
): boolean {
  if ((LEVEL_RANK[e.level] ?? 0) < (MIN_RANK[minLevel] ?? 0)) return false;
  const q = search.trim().toLowerCase();
  if (q) {
    // Correlation ids are searchable: a requestId from a UI error pastes
    // straight in here (deviation from Codeg's message+target-only search).
    const haystack = [
      e.event ?? "",
      e.message ?? "",
      e.scope,
      e.requestId ?? "",
      e.conversationId ?? "",
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  if (range && (range.from !== null || range.until !== null)) {
    const t = new Date(e.time.replace(" ", "T")).getTime();
    if (!Number.isNaN(t)) {
      if (range.from !== null && t < range.from) return false;
      if (range.until !== null && t > range.until) return false;
    }
  }
  return true;
}

function levelBadgeClasses(level: string): string {
  switch (level) {
    case "error":
      return "text-red-400";
    case "warn":
      return "text-amber-400";
    case "info":
      return "text-sky-400";
    case "debug":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground/70";
  }
}

function formatTime(time: string): string {
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return time;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const millis = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${millis}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Structured extra fields for the expandable detail grid (excludes core columns). */
function detailEntries(e: LogEntry): Array<[string, string]> {
  return Object.entries(e)
    .filter(
      ([k, v]) =>
        !["seq", "time", "level", "scope", "event", "message"].includes(k) && v !== undefined,
    )
    .map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
}

// One log line. Memoized because the list re-renders often during a live tail;
// rows only re-render when their record/expanded state changes.
const LogRow = memo(function LogRow({
  record,
  expanded,
  onToggle,
}: {
  record: LogEntry;
  expanded: boolean;
  onToggle: (seq: number) => void;
}) {
  const fieldEntries = detailEntries(record);
  const hasDetail = fieldEntries.length > 0;

  return (
    <div className="border-b border-border/40 hover:bg-muted/40">
      <div className="flex gap-2 px-2 py-1">
        {hasDetail ? (
          <button
            type="button"
            onClick={() => onToggle(record.seq)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
            aria-label="Toggle details"
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {formatTime(record.time)}
        </span>
        <span className={`w-12 shrink-0 font-semibold uppercase ${levelBadgeClasses(record.level)}`}>
          {record.level}
        </span>
        <span
          className="shrink-0 truncate text-muted-foreground/80"
          style={{ maxWidth: "12rem" }}
          title={record.scope}
        >
          {record.scope}
        </span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-foreground/90">
          {[record.event ?? "", record.message ?? ""].filter(Boolean).join(" ")}
        </span>
      </div>
      {expanded && hasDetail && (
        <div className="space-y-1 px-2 pb-2 pl-7 text-3xs text-muted-foreground">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {fieldEntries.map(([k, v]) => (
              <Fragment key={k}>
                <span className="text-muted-foreground/60">{k}</span>
                <span className="break-all text-foreground/80">{v}</span>
              </Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export function LogsPanel() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingLevel, setSavingLevel] = useState(false);

  const [captureLevel, setCaptureLevel] = useState<CaptureLevel>("info");
  const [targets, setTargets] = useState<ScopeTarget[]>([]);
  const [envLocked, setEnvLocked] = useState(false);
  const [fileSettings, setFileSettings] = useState<FileSettings | null>(null);
  const [fileLocked, setFileLocked] = useState(false);
  const [throttled, setThrottled] = useState<Array<{ scope: string; dropped: number }>>([]);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [search, setSearch] = useState("");
  const [viewLevel, setViewLevel] = useState<string>("all");
  const [fromInput, setFromInput] = useState("");
  const [untilInput, setUntilInput] = useState("");
  const [liveTail, setLiveTail] = useState(true);
  const [streamState, setStreamState] = useState<"live" | "reconnecting">("live");

  const [logFiles, setLogFiles] = useState<LogFileInfo[]>([]);
  const [retention, setRetention] = useState<RetentionInfo | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  const listRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const lastSeqRef = useRef(0);
  // Mirror of entries for merge decisions outside setState updaters, plus the
  // server boot the rows belong to (seqs restart at 0 on every boot).
  const entriesRef = useRef<LogEntry[]>([]);
  const bootIdRef = useRef<string | null>(null);

  interface LogBatch {
    entries: LogEntry[];
    bootId?: string;
  }
  // Guards the scroll-to-newest on open: set once content is first shown, and
  // re-armed only on a true reset (records emptied via Clear), so a search
  // that merely filters every row out does NOT re-arm.
  const didInitialScrollRef = useRef(false);
  // Authoritative {level, targets, file}, updated synchronously by every save
  // handler so a queued write always reads the freshest combined state.
  const settingsRef = useRef<{
    level: CaptureLevel;
    targets: ScopeTarget[];
    file: FileSettings | null;
  }>({
    level: "info",
    targets: [],
    file: null,
  });
  // Serialize writes so out-of-order async resolution can't lose an update; an
  // in-flight counter drives the saving spinner until the queue drains.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const inFlightRef = useRef(0);

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const toggleExpanded = useCallback((seq: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }, []);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    wasNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const applyIncoming = useCallback((incoming: LogEntry[], bootId: string) => {
    if (incoming.length === 0) return;
    const merged = mergeLogEntries(entriesRef.current, incoming, bootIdRef.current, bootId);
    entriesRef.current = merged.entries;
    bootIdRef.current = merged.bootId;
    // After a server restart the cursor must restart too: old seqs are larger
    // than anything the new boot will emit, and `since` would hide everything.
    lastSeqRef.current = merged.reset
      ? maxSeq(merged.entries)
      : Math.max(lastSeqRef.current, maxSeq(merged.entries));
    setEntries(merged.entries);
  }, []);

  const clearLogs = useCallback(() => {
    entriesRef.current = [];
    setEntries([]);
  }, []);

  const refreshLogs = useCallback(async () => {
    try {
      const res = await fetch(`/api/logs/recent?since=${lastSeqRef.current}`);
      if (!res.ok) return;
      const data = (await res.json()) as LogBatch;
      applyIncoming(data.entries ?? [], data.bootId ?? "");
    } catch {
      /* stream stays authoritative; refresh is best-effort */
    }
  }, [applyIncoming]);

  // Initial load: capture settings + backlog + on-disk files.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [settingsRes, recentRes, filesRes] = await Promise.all([
          fetch("/api/logs/settings"),
          fetch("/api/logs/recent"),
          fetch("/api/logs/files"),
        ]);
        if (!settingsRes.ok || !recentRes.ok || !filesRes.ok) {
          throw new Error("Could not load log settings.");
        }
        const settings = (await settingsRes.json()) as {
          level: CaptureLevel;
          targets: ScopeTarget[];
          env_locked: boolean;
          file?: FileSettings;
          file_locked?: boolean;
          throttle?: { throttled: Array<{ scope: string; dropped: number }> };
        };
        const recent = (await recentRes.json()) as LogBatch;
        const files = (await filesRes.json()) as {
          files: LogFileInfo[];
          retention?: RetentionInfo;
        };
        if (cancelled) return;
        setCaptureLevel(settings.level);
        setTargets(settings.targets ?? []);
        setFileSettings(settings.file ?? null);
        settingsRef.current = {
          level: settings.level,
          targets: settings.targets ?? [],
          file: settings.file ?? null,
        };
        setEnvLocked(settings.env_locked);
        setFileLocked(settings.file_locked ?? false);
        setThrottled(settings.throttle?.throttled ?? []);
        applyIncoming(recent.entries ?? [], recent.bootId ?? "");
        setLogFiles(files.files ?? []);
        setRetention(files.retention ?? null);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Could not load logs.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyIncoming]);

  // Live tail over SSE (the only transport — the old polling fallback is
  // retired; SSE auto-reconnects natively and our since+bootId resume makes
  // every redelivery idempotent). Pausing closes the stream (no buffering);
  // resuming reconnects and the backlog drain catches up on everything missed.
  // A dropped stream reconnects with backoff; failures surface as a
  // "Reconnecting…" indicator instead of silent degradation.
  useEffect(() => {
    if (!liveTail) return;
    setStreamState("live");
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let source: EventSource | null = null;

    const connect = () => {
      if (closed) return;
      const source_ = new EventSource("/api/logs/stream");
      source = source_;
      source_.onopen = () => {
        setStreamState("live");
      };
      source_.addEventListener("entries", (ev) => {
        const data = JSON.parse((ev as MessageEvent).data) as LogBatch;
        applyIncoming(data.entries ?? [], data.bootId ?? "");
      });
      source_.onerror = () => {
        source_.close();
        if (source === source_) source = null;
        if (closed) return;
        setStreamState("reconnecting");
        retryTimer = setTimeout(() => {
          if (!closed) connect();
        }, 2000);
      };
    };

    connect();
    return () => {
      closed = true;
      source?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [liveTail, applyIncoming]);

  const range = useMemo(() => {
    const parse = (v: string): number | null => {
      if (!v) return null;
      const t = new Date(v).getTime();
      return Number.isNaN(t) ? null : t;
    };
    return { from: parse(fromInput), until: parse(untilInput) };
  }, [fromInput, untilInput]);

  const visible = useMemo(
    () => entries.filter((e) => matchesFilter(e, viewLevel, search, range)),
    [entries, viewLevel, search, range],
  );

  // Follow new records to the bottom while live-tailing, but only when the
  // reader is already near the bottom — never yank someone reading history.
  const latestSeq = entries.length > 0 ? entries[entries.length - 1].seq : null;
  const seenSeqRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = seenSeqRef.current;
    seenSeqRef.current = latestSeq;
    if (latestSeq == null || prev == null || latestSeq <= prev) return;
    if (!liveTail || !wasNearBottomRef.current) return;
    scrollToBottom();
  }, [latestSeq, liveTail, scrollToBottom]);

  // A true reset (records emptied via Clear) re-arms the open-scroll so the
  // next records to arrive snap to the newest.
  useEffect(() => {
    if (entries.length === 0) didInitialScrollRef.current = false;
  }, [entries.length]);

  // Open at the newest record once the list mounts with content.
  useEffect(() => {
    if (didInitialScrollRef.current || visible.length === 0) return;
    didInitialScrollRef.current = true;
    scrollToBottom();
  }, [visible.length, scrollToBottom]);

  // Refresh only the throttle snapshot after saves (never level/targets —
  // those may hold unsaved edits).
  const refreshThrottle = useCallback(async () => {
    try {
      const res = await fetch("/api/logs/settings");
      if (!res.ok) return;
      const data = (await res.json()) as {
        throttle?: { throttled: Array<{ scope: string; dropped: number }> };
      };
      setThrottled(data.throttle?.throttled ?? []);
    } catch {
      /* best-effort */
    }
  }, []);

  const queueSave = useCallback(() => {
    inFlightRef.current += 1;
    setSavingLevel(true);
    saveChainRef.current = saveChainRef.current.then(async () => {
      try {
        const body: Record<string, unknown> = {
          level: settingsRef.current.level,
          targets: validTargets(settingsRef.current.targets),
        };
        if (settingsRef.current.file) body.file = settingsRef.current.file;
        const res = await fetch("/api/logs/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) toast.error("Could not save log settings.");
        else void refreshThrottle();
      } catch {
        toast.error("Could not save log settings.");
      } finally {
        inFlightRef.current -= 1;
        if (inFlightRef.current === 0) setSavingLevel(false);
      }
    });
  }, [refreshThrottle]);

  const handleLevelChange = useCallback(
    (value: string) => {
      const level = value as CaptureLevel;
      settingsRef.current = { ...settingsRef.current, level };
      setCaptureLevel(level);
      queueSave();
    },
    [queueSave],
  );

  // Update targets in the authoritative ref (synchronously) and React state.
  // Whether to save is the caller's choice (not while a scope is being typed).
  const updateTargets = useCallback((next: ScopeTarget[]) => {
    settingsRef.current = { ...settingsRef.current, targets: next };
    setTargets(next);
  }, []);

  const handleAddTarget = useCallback(() => {
    // Local-only blank row; persisted once it holds a valid scope (on blur).
    updateTargets([...settingsRef.current.targets, { scope: "", level: "debug" }]);
  }, [updateTargets]);

  const handleFileToggle = useCallback(
    (enabled: boolean) => {
      const next: FileSettings = settingsRef.current.file
        ? { ...settingsRef.current.file, enabled }
        : { enabled, maxMb: 5, keepFiles: 20, maxTotalMb: 100, retentionHours: 24 };
      settingsRef.current = { ...settingsRef.current, file: next };
      setFileSettings(next);
      queueSave();
    },
    [queueSave],
  );

  const handleExport = useCallback(() => {
    const blob = new Blob([serializeLogEntries(visible)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "tbai-logs-export.log";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [visible]);

  // Keyboard: "/" focuses search, "End" jumps to latest. Never hijacks typing.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        ev.isComposing
      ) {
        return;
      }
      if (ev.key === "/") {
        ev.preventDefault();
        document.getElementById("log-search")?.focus();
      } else if (ev.key === "End") {
        scrollToBottom();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scrollToBottom]);

  const handleDownload = useCallback(async (file: LogFileInfo) => {
    try {
      const res = await fetch(`/api/logs/files/${encodeURIComponent(file.name)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const content = await res.text();
      const blob = new Blob([content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Could not download log file.");
    }
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="w-full space-y-4 p-3 md:p-4">
        <section className="space-y-1">
          <h1 className="text-sm font-semibold">Logs</h1>
          <p className="text-xs text-muted-foreground">
            View and configure runtime logs. Entries are redacted server-side —
            this view never receives secrets.
          </p>
        </section>

        {loadError && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
            {loadError}
          </div>
        )}

        {/* Capture level */}
        <section className="space-y-3 rounded-xl border bg-card p-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">Log level</h2>
            <p className="text-xs leading-5 text-muted-foreground">
              Controls what the server records. Lower levels include everything above them.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Level</span>
            <Select value={captureLevel} onValueChange={handleLevelChange} disabled={envLocked}>
              <SelectTrigger className="h-8 w-40 text-xs" disabled={savingLevel || envLocked}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CAPTURE_LEVELS.map((level) => (
                  <SelectItem key={level} value={level} className="text-xs capitalize">
                    {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {savingLevel && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
          {envLocked && (
            <p className="text-2xs text-amber-500">
              Controlled by TBAI_LOG_LEVEL — unset it to manage levels here.
            </p>
          )}
          {throttled.length > 0 && (
            <p className="text-2xs text-amber-500">
              Throttling {throttled.map((t) => `${t.scope} (${t.dropped} shed)`).join(", ")} —
              over the 1/sec info budget. Quiet the source or raise its capture level.
            </p>
          )}

          <div className="flex items-center justify-between gap-2 border-t pt-3">
            <div className="space-y-0.5">
              <h3 className="text-xs font-semibold">File sink</h3>
              <p className="text-2xs leading-4 text-muted-foreground">
                Append JSON lines to tbai.log for history beyond the memory buffer.
              </p>
            </div>
            <Switch
              checked={fileSettings?.enabled ?? false}
              onCheckedChange={handleFileToggle}
              disabled={fileLocked || fileSettings === null}
              aria-label="Toggle file sink"
            />
          </div>
          {fileLocked && (
            <p className="text-2xs text-amber-500">
              Controlled by TBAI_LOG_FILE — unset it to manage the sink here.
            </p>
          )}

          {/* Per-scope overrides */}
          <div className="space-y-2 border-t pt-3">
            <div className="flex items-center justify-between gap-2">
              <div className="space-y-0.5">
                <h3 className="text-xs font-semibold">Per-scope overrides</h3>
                <p className="text-2xs leading-4 text-muted-foreground">
                  Raise or silence individual scopes. An override matches its scope and
                  everything below it.
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={handleAddTarget} disabled={envLocked}>
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            </div>
            {targets.length > 0 && (
              <div className="space-y-1.5">
                {targets.map((row, i) => {
                  const trimmed = row.scope.trim();
                  const invalid = trimmed !== "" && !SCOPE_RE.test(trimmed);
                  return (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={row.scope}
                        onChange={(e) =>
                          updateTargets(
                            settingsRef.current.targets.map((r, j) =>
                              j === i ? { ...r, scope: e.target.value } : r,
                            ),
                          )
                        }
                        onBlur={queueSave}
                        placeholder="mcp"
                        list="tbai-log-scopes"
                        disabled={envLocked}
                        className={`h-8 flex-1 text-xs ${invalid ? "border-red-500/60" : ""}`}
                      />
                      <Select
                        value={row.level}
                        onValueChange={(v) => {
                          updateTargets(
                            settingsRef.current.targets.map((r, j) =>
                              j === i ? { ...r, level: v as CaptureLevel } : r,
                            ),
                          );
                          queueSave();
                        }}
                        disabled={envLocked}
                      >
                        <SelectTrigger className="h-8 w-28 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CAPTURE_LEVELS.map((level) => (
                            <SelectItem key={level} value={level} className="text-xs capitalize">
                              {level}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 shrink-0"
                        onClick={() => {
                          updateTargets(settingsRef.current.targets.filter((_, j) => j !== i));
                          queueSave();
                        }}
                        disabled={envLocked}
                        aria-label="Remove override"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  );
                })}
                <datalist id="tbai-log-scopes">
                  {CURATED_SCOPES.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </div>
            )}
          </div>
        </section>

        {/* Viewer */}
        <section className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">Recent logs</h2>
              <p className="text-xs leading-5 text-muted-foreground">
                Live tail of the server log buffer.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {liveTail && streamState === "reconnecting" && (
                <span className="text-xs text-amber-500">Reconnecting…</span>
              )}
              <Button size="sm" variant={liveTail ? "default" : "outline"} onClick={() => setLiveTail((v) => !v)}>
                {liveTail ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                {liveTail ? "Pause" : "Live"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void refreshLogs()}>
                <RotateCw className="h-3.5 w-3.5" />
                Refresh
              </Button>
              <Button size="sm" variant="outline" onClick={clearLogs}>
                <Trash2 className="h-3.5 w-3.5" />
                Clear
              </Button>
              <Button size="sm" variant="outline" onClick={handleExport}>
                <Download className="h-3.5 w-3.5" />
                Export
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="log-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search message or target…"
              className="h-8 max-w-xs text-xs"
            />
            <Select value={viewLevel} onValueChange={setViewLevel}>
              <SelectTrigger className="h-8 w-32 text-xs" aria-label="Filter by level">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VIEW_LEVELS.map((level) => (
                  <SelectItem key={level} value={level} className="text-xs capitalize">
                    {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-2xs text-muted-foreground">
              {visible.length} / {entries.length} shown
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="datetime-local"
              value={fromInput}
              onChange={(e) => setFromInput(e.target.value)}
              aria-label="Show entries from"
              className="h-8 w-44 text-xs"
            />
            <Input
              type="datetime-local"
              value={untilInput}
              onChange={(e) => setUntilInput(e.target.value)}
              aria-label="Show entries until"
              className="h-8 w-44 text-xs"
            />
            {(fromInput || untilInput) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setFromInput("");
                  setUntilInput("");
                }}
              >
                Clear range
              </Button>
            )}
          </div>

          {captureLevel === "off" && (
            <p className="text-2xs text-amber-500">
              Capture is off — showing buffered history; new entries are not recorded.
            </p>
          )}

          <div className="h-[30rem] rounded-md border bg-background/50 font-mono text-2xs leading-5">
            {visible.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                No entries match the current filters.
              </div>
            ) : (
              <div
                ref={listRef}
                onScroll={onScroll}
                className="h-full overflow-y-auto overflow-x-hidden"
              >
                <Virtualizer scrollRef={listRef} itemSize={28}>
                  {visible.map((e) => (
                    <LogRow
                      key={e.seq}
                      record={e}
                      expanded={expanded.has(e.seq)}
                      onToggle={toggleExpanded}
                    />
                  ))}
                </Virtualizer>
              </div>
            )}
          </div>
        </section>

        {/* On-disk files: the logger's own rotated sink, read-only here */}
        <section className="space-y-3 rounded-xl border bg-card p-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">Log files</h2>
            <p className="text-xs leading-5 text-muted-foreground">
              On-disk history beyond the memory buffer. Empty while file logging is off
              (the development default).
            </p>
            {retention && (
              <p className="text-2xs text-muted-foreground">
                {retention.fileCount} files · {formatBytes(retention.totalBytes)} total ·{" "}
                {retention.retentionHours}h retention · {retention.maxTotalMb} MB cap
              </p>
            )}
          </div>
          {logFiles.length === 0 ? (
            <p className="text-2xs text-muted-foreground">No log files yet.</p>
          ) : (
            <div className="space-y-1">
              {logFiles.map((file) => (
                <div
                  key={file.name}
                  className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5"
                >
                  <span className="truncate font-mono text-xs">{file.name}</span>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-2xs text-muted-foreground">
                      {formatBytes(file.size_bytes)}
                    </span>
                    <Button size="sm" variant="outline" onClick={() => void handleDownload(file)}>
                      Download
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
