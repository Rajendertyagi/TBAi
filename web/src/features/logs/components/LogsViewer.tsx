import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { maxSeq, mergeLogEntries, serializeLogEntries } from "@/lib/log-entries";
import { apiFetch, resolveApiUrl } from "@/lib/platform";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Calendar as CalendarIcon,
  ChevronsDown,
  ChevronsUp,
  Download,
  Filter,
  HardDrive,
  Pause,
  Play,
  Search,
  Sliders,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { detailEntries, LogRow } from "./LogRow";
import { LogFilesDialog } from "./LogFilesDialog";
import { LogSettingsDialog } from "./LogSettingsDialog";
import { RangeCalendar } from "./RangeCalendar";
import type {
  CaptureLevel,
  DateRange,
  FileSettings,
  LogBatch,
  LogEntry,
  LogFileInfo,
  LogLevel,
  RetentionInfo,
  ScopeTarget,
  ThrottleInfo,
} from "../types";

const ALL_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

// Scope paths are dot-separated idents; an override matches its scope and
// everything below it. Rows failing this are excluded from saves.
const SCOPE_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

function validTargets(targets: ScopeTarget[]): ScopeTarget[] {
  return targets
    .map((t) => ({ ...t, scope: t.scope.trim() }))
    .filter((t) => SCOPE_RE.test(t.scope));
}

function defaultFileSettings(): FileSettings {
  return {
    enabled: false,
    maxMb: 5,
    keepFiles: 20,
    maxTotalMb: 100,
    retentionHours: 24,
  };
}

export function LogsViewer() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [streamState, setStreamState] = useState<"live" | "reconnecting">("live");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedLevel, setSelectedLevel] = useState<LogLevel | "all">("all");
  const [selectedScope, setSelectedScope] = useState<string>("all");
  const [dateRange, setDateRange] = useState<DateRange>({ from: null, to: null });
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  // Dialog states
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);

  // Settings & retention remote data
  const [captureLevel, setCaptureLevel] = useState<CaptureLevel>("info");
  const [targets, setTargets] = useState<ScopeTarget[]>([]);
  const [envLocked, setEnvLocked] = useState(false);
  const [fileSettings, setFileSettings] = useState<FileSettings | null>(null);
  const [fileLocked, setFileLocked] = useState(false);
  const [throttled, setThrottled] = useState<ThrottleInfo["throttled"]>([]);
  const [retentionInfo, setRetentionInfo] = useState<RetentionInfo | null>(null);
  const [logFiles, setLogFiles] = useState<LogFileInfo[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Tracking state refs for SSE streaming / safe persistence
  const entriesRef = useRef<LogEntry[]>([]);
  entriesRef.current = entries;
  const bootIdRef = useRef<string | null>(null);
  const lastSeqRef = useRef<number>(0);
  const parentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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
  // Serialize writes so out-of-order async resolution can't lose an update.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const inFlightRef = useRef(0);

  const applyIncoming = useCallback((incoming: LogEntry[], nextBootId: string) => {
    if (incoming.length === 0 && bootIdRef.current === nextBootId) return;
    const merged = mergeLogEntries(entriesRef.current, incoming, bootIdRef.current, nextBootId);
    entriesRef.current = merged.entries;
    bootIdRef.current = merged.bootId;
    // After a server restart the cursor must restart too: old seqs are larger
    // than anything the new boot will emit, and `since` would hide everything.
    lastSeqRef.current = merged.reset
      ? maxSeq(merged.entries)
      : Math.max(lastSeqRef.current, maxSeq(merged.entries));
    if (merged.reset) {
      setExpandedIds(new Set());
    }
    setEntries(merged.entries);
  }, []);

  // Fetch initial buffer
  const fetchRecentLogs = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/logs/recent?since=${lastSeqRef.current}`);
      if (res.ok) {
        const data = (await res.json()) as LogBatch;
        applyIncoming(data.entries ?? [], data.bootId ?? "");
      }
    } catch {
      // Ignore network errors on init/refresh
    }
  }, [applyIncoming]);

  // Fetch runtime settings
  const fetchSettings = useCallback(async () => {
    try {
      const res = await apiFetch("/api/logs/settings");
      if (res.ok) {
        const data = (await res.json()) as {
          level?: CaptureLevel;
          targets?: ScopeTarget[];
          env_locked?: boolean;
          file?: FileSettings;
          file_locked?: boolean;
          throttle?: ThrottleInfo;
        };
        const nextLevel = data.level ?? "info";
        const nextTargets = data.targets ?? [];
        const nextFile = data.file ?? null;
        setCaptureLevel(nextLevel);
        setTargets(nextTargets);
        setEnvLocked(data.env_locked ?? false);
        setFileSettings(nextFile);
        setFileLocked(data.file_locked ?? false);
        setThrottled(data.throttle?.throttled ?? []);
        settingsRef.current = { level: nextLevel, targets: nextTargets, file: nextFile };
      }
    } catch {
      // Ignore
    }
  }, []);

  // Fetch file retention info
  const fetchRetention = useCallback(async () => {
    setFilesLoading(true);
    try {
      const res = await apiFetch("/api/logs/files");
      if (res.ok) {
        const data = (await res.json()) as {
          files?: LogFileInfo[];
          retention?: RetentionInfo;
        };
        if (data.retention) setRetentionInfo(data.retention);
        if (Array.isArray(data.files)) setLogFiles(data.files);
      }
    } catch {
      // Ignore
    } finally {
      setFilesLoading(false);
    }
  }, []);

  // SSE Stream (named `entries` event; backend contract). Pausing closes the
  // stream; resuming reconnects and recent fetch catches up.
  useEffect(() => {
    void fetchRecentLogs();
    void fetchSettings();

    if (isPaused) {
      setStreamState("live");
      return;
    }

    let closed = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      const since = lastSeqRef.current;
      const url = resolveApiUrl(`/api/logs/stream${since > 0 ? `?since=${since}` : ""}`);
      const source_ = new EventSource(url);
      source = source_;

      source_.onopen = () => {
        if (!closed) setStreamState("live");
      };

      source_.addEventListener("entries", (ev) => {
        try {
          const payload = JSON.parse((ev as MessageEvent).data) as LogBatch;
          applyIncoming(payload.entries ?? [], payload.bootId ?? "");
        } catch {
          // Ignore parse errors
        }
      });

      source_.onerror = () => {
        source_?.close();
        if (source === source_) source = null;
        if (!closed) {
          setStreamState("reconnecting");
          retryTimer = setTimeout(connect, 2000);
        }
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, [fetchRecentLogs, fetchSettings, isPaused, applyIncoming]);

  // Hotkey '/' to focus search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "TEXTAREA"
      ) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Collect unique scopes from visible buffer
  const availableScopes = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      if (e.scope) set.add(e.scope);
    }
    return Array.from(set).sort();
  }, [entries]);

  // Filtered log entries
  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const fromTime = dateRange.from ? new Date(dateRange.from).getTime() : null;
    const toTime = dateRange.to ? new Date(dateRange.to).getTime() : null;

    return entries.filter((item) => {
      if (selectedLevel !== "all" && item.level !== selectedLevel) return false;
      if (selectedScope !== "all" && item.scope !== selectedScope) return false;

      if (fromTime || toTime) {
        const itemTime = new Date(item.time).getTime();
        if (!Number.isNaN(itemTime)) {
          if (fromTime && itemTime < fromTime) return false;
          if (toTime && itemTime > toTime) return false;
        }
      }

      if (query) {
        const inScope = item.scope?.toLowerCase().includes(query);
        const inEvent = item.event?.toLowerCase().includes(query);
        const inMessage = item.message?.toLowerCase().includes(query);
        const details = detailEntries(item);
        const inFields = details.some(
          (d) => d.key.toLowerCase().includes(query) || d.value.toLowerCase().includes(query),
        );
        return inScope || inEvent || inMessage || inFields;
      }

      return true;
    });
  }, [entries, selectedLevel, selectedScope, dateRange, searchQuery]);

  // Dynamic row height estimation
  const getItemSize = useCallback(
    (index: number) => {
      const entry = filteredEntries[index];
      if (!entry) return 29;
      const isExpanded = expandedIds.has(entry.seq);
      if (!isExpanded) return 29;
      const count = detailEntries(entry).length;
      return 29 + Math.max(1, count) * 28 + 24;
    },
    [filteredEntries, expandedIds],
  );

  const rowVirtualizer = useVirtualizer({
    count: filteredEntries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: getItemSize,
    overscan: 20,
  });

  // Auto-scroll to bottom if live
  const isAutoScrollRef = useRef(true);
  const handleScroll = () => {
    if (!parentRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = parentRef.current;
    isAutoScrollRef.current = scrollHeight - (scrollTop + clientHeight) < 50;
  };

  useEffect(() => {
    if (isAutoScrollRef.current && !isPaused && filteredEntries.length > 0) {
      rowVirtualizer.scrollToIndex(filteredEntries.length - 1, { align: "end" });
    }
  }, [filteredEntries.length, isPaused, rowVirtualizer]);

  // Handlers
  const handleToggleExpand = useCallback((seq: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }, []);

  const handleExpandAll = () => {
    const all = new Set<number>();
    for (const e of filteredEntries) {
      if (detailEntries(e).length > 0) all.add(e.seq);
    }
    setExpandedIds(all);
  };

  const handleCollapseAll = () => {
    setExpandedIds(new Set());
  };

  const handleClear = () => {
    entriesRef.current = [];
    lastSeqRef.current = 0;
    bootIdRef.current = null;
    setEntries([]);
    setExpandedIds(new Set());
  };

  const handleExport = () => {
    const content = serializeLogEntries(filteredEntries);
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tbai-logs-export.log";
    a.click();
    URL.revokeObjectURL(url);
  };

  const refreshThrottle = useCallback(async () => {
    try {
      const res = await apiFetch("/api/logs/settings");
      if (!res.ok) return;
      const data = (await res.json()) as { throttle?: ThrottleInfo };
      setThrottled(data.throttle?.throttled ?? []);
    } catch {
      /* best-effort */
    }
  }, []);

  const queueSave = useCallback(() => {
    inFlightRef.current += 1;
    setSaving(true);
    saveChainRef.current = saveChainRef.current.then(async () => {
      try {
        const body: Record<string, unknown> = {
          level: settingsRef.current.level,
          targets: validTargets(settingsRef.current.targets),
        };
        if (settingsRef.current.file) body.file = settingsRef.current.file;
        const res = await apiFetch("/api/logs/settings", {
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
        if (inFlightRef.current === 0) setSaving(false);
      }
    });
  }, [refreshThrottle]);

  const handleCaptureLevelChange = useCallback(
    (level: CaptureLevel) => {
      settingsRef.current = { ...settingsRef.current, level };
      setCaptureLevel(level);
      queueSave();
    },
    [queueSave],
  );

  const handleTargetsChange = useCallback((next: ScopeTarget[]) => {
    settingsRef.current = { ...settingsRef.current, targets: next };
    setTargets(next);
  }, []);

  const handleFileSettingsChange = useCallback(
    (patch: Partial<FileSettings>) => {
      const next: FileSettings = settingsRef.current.file
        ? { ...settingsRef.current.file, ...patch }
        : { ...defaultFileSettings(), ...patch };
      settingsRef.current = { ...settingsRef.current, file: next };
      setFileSettings(next);
      queueSave();
    },
    [queueSave],
  );

  const handleDownloadFile = async (file: LogFileInfo) => {
    try {
      const res = await apiFetch(`/api/logs/files/${encodeURIComponent(file.name)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const content = await res.text();
      const blob = new Blob([content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(`Could not download ${file.name}`);
    }
  };

  // Quick Date Chips (local day boundaries)
  const setPresetToday = () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    setDateRange({ from: start.toISOString(), to: end.toISOString() });
    setCalendarOpen(false);
  };

  const setPreset24h = () => {
    const now = new Date();
    const past = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    setDateRange({ from: past.toISOString(), to: now.toISOString() });
    setCalendarOpen(false);
  };

  const setPreset7d = () => {
    const now = new Date();
    const past = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    setDateRange({ from: past.toISOString(), to: now.toISOString() });
    setCalendarOpen(false);
  };

  const clearDateRange = () => {
    setDateRange({ from: null, to: null });
    setCalendarOpen(false);
  };

  const hasDateFilter = Boolean(dateRange.from || dateRange.to);

  return (
    <div className="flex flex-col h-full bg-background text-foreground select-none">
      {/* Sticky Top Header & Toolbar */}
      <div className="shrink-0 border-b border-border bg-card/40 backdrop-blur-xs p-3 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h1 className="font-semibold text-sm tracking-tight text-foreground">Runtime Logs</h1>
            <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-mono text-3xs">
              {filteredEntries.length} / {entries.length}
            </span>
            <div
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-3xs font-medium ${
                isPaused
                  ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                  : streamState === "reconnecting"
                    ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                    : "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isPaused || streamState === "reconnecting"
                    ? "bg-amber-400"
                    : "bg-emerald-400 animate-pulse"
                }`}
              />
              {isPaused ? "PAUSED" : streamState === "reconnecting" ? "RECONNECTING" : "LIVE"}
            </div>
            {saving && <span className="text-3xs text-muted-foreground">Saving…</span>}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setIsPaused(!isPaused)}
              className={`h-7 px-2 rounded-md border text-xs font-medium flex items-center gap-1 transition-colors ${
                isPaused
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
                  : "bg-muted/50 border-border text-foreground hover:bg-muted"
              }`}
            >
              {isPaused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
              {isPaused ? "Resume" : "Pause"}
            </button>

            <button
              type="button"
              onClick={handleClear}
              title="Clear current log buffer"
              className="h-7 px-2 rounded-md border border-border bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted text-xs font-medium flex items-center gap-1 transition-colors"
            >
              <Trash2 className="w-3 h-3" />
              Clear
            </button>

            <button
              type="button"
              onClick={handleExport}
              title="Export visible logs"
              className="h-7 px-2 rounded-md border border-border bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted text-xs font-medium flex items-center gap-1 transition-colors"
            >
              <Download className="w-3 h-3" />
              Export
            </button>

            <button
              type="button"
              onClick={() => {
                void fetchRetention();
                setFilesOpen(true);
              }}
              title="Disk log files & retention"
              className="h-7 px-2 rounded-md border border-border bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted text-xs font-medium flex items-center gap-1 transition-colors"
            >
              <HardDrive className="w-3 h-3" />
              Files
            </button>

            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              title="Configure log capture levels and overrides"
              className="h-7 px-2 rounded-md border border-border bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted text-xs font-medium flex items-center gap-1 transition-colors"
            >
              <Sliders className="w-3 h-3" />
              Settings
            </button>
          </div>
        </div>

        {captureLevel === "off" && (
          <p className="text-2xs text-amber-500">
            Capture is off — showing buffered history; new entries are not recorded.
          </p>
        )}
        {throttled.length > 0 && (
          <p className="text-2xs text-amber-500">
            Throttling {throttled.map((t) => `${t.scope} (${t.dropped} shed)`).join(", ")} — over
            the 1/sec info budget. Quiet the source or raise its capture level.
          </p>
        )}

        {/* Filter Toolbar */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search logs... (Press '/' to focus)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-7.5 pl-8 pr-7 rounded-md border border-border bg-background font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-hidden focus:ring-1 focus:ring-ring"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <select
            value={selectedLevel}
            onChange={(e) => setSelectedLevel(e.target.value as LogLevel | "all")}
            className="h-7.5 px-2 rounded-md border border-border bg-background font-mono text-xs text-foreground focus:outline-hidden focus:ring-1 focus:ring-ring"
          >
            <option value="all">ALL LEVELS</option>
            {ALL_LEVELS.map((lvl) => (
              <option key={lvl} value={lvl}>
                {lvl.toUpperCase()}
              </option>
            ))}
          </select>

          <select
            value={selectedScope}
            onChange={(e) => setSelectedScope(e.target.value)}
            className="h-7.5 px-2 max-w-[150px] truncate rounded-md border border-border bg-background font-mono text-xs text-foreground focus:outline-hidden focus:ring-1 focus:ring-ring"
          >
            <option value="all">ALL SCOPES</option>
            {availableScopes.map((sc) => (
              <option key={sc} value={sc}>
                {sc}
              </option>
            ))}
          </select>

          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={`h-7.5 px-2.5 rounded-md border text-xs font-medium flex items-center gap-1.5 transition-colors ${
                  hasDateFilter
                    ? "bg-primary/10 border-primary/30 text-primary"
                    : "bg-background border-border text-foreground hover:bg-muted"
                }`}
              >
                <CalendarIcon className="w-3.5 h-3.5" />
                {hasDateFilter ? "Filtered Date" : "Date Range"}
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={6}
              className="p-0 z-50 rounded-lg border border-border bg-popover text-popover-foreground shadow-md"
            >
              <div className="p-2 border-b border-border/60 flex items-center justify-between gap-1 text-2xs">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={clearDateRange}
                    className="px-2 py-1 rounded hover:bg-muted font-medium text-muted-foreground hover:text-foreground"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={setPresetToday}
                    className="px-2 py-1 rounded hover:bg-muted font-medium text-muted-foreground hover:text-foreground"
                  >
                    Today
                  </button>
                  <button
                    type="button"
                    onClick={setPreset24h}
                    className="px-2 py-1 rounded hover:bg-muted font-medium text-muted-foreground hover:text-foreground"
                  >
                    Last 24h
                  </button>
                  <button
                    type="button"
                    onClick={setPreset7d}
                    className="px-2 py-1 rounded hover:bg-muted font-medium text-muted-foreground hover:text-foreground"
                  >
                    Last 7d
                  </button>
                </div>
                {hasDateFilter && (
                  <button
                    type="button"
                    onClick={clearDateRange}
                    className="p-1 rounded text-rose-400 hover:bg-rose-500/10"
                    title="Clear date filter"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <RangeCalendar
                range={dateRange}
                onChange={setDateRange}
                onClose={() => setCalendarOpen(false)}
              />
            </PopoverContent>
          </Popover>

          <div className="flex items-center gap-0.5 border border-border rounded-md bg-muted/20">
            <button
              type="button"
              onClick={handleExpandAll}
              title="Expand all details"
              className="h-7 px-2 rounded-l-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
            >
              <ChevronsDown className="w-3 h-3" />
            </button>
            <div className="w-px h-4 bg-border" />
            <button
              type="button"
              onClick={handleCollapseAll}
              title="Collapse all details"
              className="h-7 px-2 rounded-r-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
            >
              <ChevronsUp className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      {/* Main Virtualized Log Table */}
      <div ref={parentRef} onScroll={handleScroll} className="flex-1 overflow-y-auto bg-background">
        {filteredEntries.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground/60 p-6 space-y-2">
            <Filter className="w-8 h-8 opacity-40" />
            <span className="text-xs font-mono">No matching log entries found.</span>
            {(searchQuery ||
              selectedLevel !== "all" ||
              selectedScope !== "all" ||
              hasDateFilter) && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery("");
                  setSelectedLevel("all");
                  setSelectedScope("all");
                  setDateRange({ from: null, to: null });
                }}
                className="text-xs text-primary hover:underline font-mono"
              >
                Reset filters
              </button>
            )}
          </div>
        ) : (
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const entry = filteredEntries[virtualRow.index];
              return (
                <div
                  key={entry.seq}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <LogRow
                    entry={entry}
                    searchQuery={searchQuery}
                    isExpanded={expandedIds.has(entry.seq)}
                    onToggleExpand={() => handleToggleExpand(entry.seq)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <LogSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        captureLevel={captureLevel}
        onCaptureLevelChange={handleCaptureLevelChange}
        envLocked={envLocked}
        fileSettings={fileSettings}
        fileLocked={fileLocked}
        onFileSettingsChange={handleFileSettingsChange}
        targets={targets}
        onTargetsChange={handleTargetsChange}
        onSave={queueSave}
      />

      <LogFilesDialog
        open={filesOpen}
        onOpenChange={setFilesOpen}
        retentionInfo={retentionInfo}
        logFiles={logFiles}
        isLoading={filesLoading}
        onRefresh={fetchRetention}
        onDownloadFile={handleDownloadFile}
      />
    </div>
  );
}
