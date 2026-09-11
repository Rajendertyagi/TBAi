import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, ScrollText, Trash2, Search } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Live application log viewer (local-only).
 *
 * Streams the server's in-memory log ring buffer over SSE
 * (`/api/logs/stream`, backlog + live push). Client-side filters: level,
 * scope, free text (matches event/message/requestId/...). Auto-scrolls while
 * following; pauses when the user scrolls up. Entries are already redacted
 * server-side — this view never receives secrets.
 */

interface LogEntry {
  seq: number;
  time: string;
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  event?: string;
  message?: string;
  requestId?: string;
  [key: string]: unknown;
}

const LEVELS = ["all", "debug", "info", "warn", "error"] as const;
type LevelFilter = (typeof LEVELS)[number];

const LEVEL_STYLES: Record<string, string> = {
  debug: "text-muted-foreground",
  info: "text-foreground",
  warn: "text-yellow-500",
  error: "text-destructive",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString();
}

function entryText(e: LogEntry): string {
  const extras = Object.entries(e)
    .filter(
      ([k, v]) =>
        !["seq", "time", "level", "scope", "event", "message"].includes(k) && v !== undefined,
    )
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return [e.event ?? "", e.message ?? "", ...extras].join(" ");
}

export function LogsPanel() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [scopeFilter, setScopeFilter] = useState("");
  const [textFilter, setTextFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  // Buffer entries that arrive while paused; flush on resume.
  const pausedBufferRef = useRef<LogEntry[] | null>(null);

  // ---- Live stream (SSE) with polling fallback ----
  useEffect(() => {
    let closed = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let lastSeq = 0;
    let source: EventSource | null = null;

    const apply = (incoming: LogEntry[]) => {
      if (incoming.length === 0) return;
      lastSeq = Math.max(lastSeq, ...incoming.map((e) => e.seq));
      const pending = pausedBufferRef.current;
      if (pending === null) {
        setEntries((prev) => [...prev, ...incoming].slice(-2000));
      } else {
        pending.push(...incoming);
      }
    };

    const startPolling = () => {
      if (pollTimer || closed) return;
      pollTimer = setInterval(async () => {
        try {
          const res = await fetch(`/api/logs/recent?since=${lastSeq}`);
          if (!res.ok) return;
          const data = (await res.json()) as { entries: LogEntry[] };
          apply(data.entries ?? []);
          setConnected(true);
        } catch {
          setConnected(false);
        }
      }, 2000);
    };

    const connect = () => {
      if (closed) return;
      try {
        source = new EventSource("/api/logs/stream");
        source.addEventListener("entries", (ev) => {
          const data = JSON.parse((ev as MessageEvent).data) as { entries: LogEntry[] };
          apply(data.entries ?? []);
          setConnected(true);
        });
        source.addEventListener("backlog", (ev) => {
          const data = JSON.parse((ev as MessageEvent).data) as { entries: LogEntry[] };
          apply(data.entries ?? []);
          setConnected(true);
        });
        source.onerror = () => {
          setConnected(false);
          source?.close();
          source = null;
          // SSE failed (e.g. proxy) — degrade to polling.
          startPolling();
        };
      } catch {
        startPolling();
      }
    };

    connect();
    return () => {
      closed = true;
      source?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, []);

  // Flush paused buffer on resume.
  useEffect(() => {
    if (!paused && pausedBufferRef.current) {
      const buffered = pausedBufferRef.current;
      pausedBufferRef.current = null;
      if (buffered.length > 0) {
        setEntries((prev) => [...prev, ...buffered].slice(-2000));
      }
    }
  }, [paused]);

  const togglePause = useCallback(() => {
    setPaused((p) => {
      if (!p) pausedBufferRef.current = []; // start buffering
      return !p;
    });
  }, []);

  const clear = useCallback(() => {
    setEntries([]);
    pausedBufferRef.current = paused ? [] : pausedBufferRef.current;
  }, [paused]);

  const filtered = useMemo(() => {
    const scope = scopeFilter.trim().toLowerCase();
    const text = textFilter.trim().toLowerCase();
    return entries.filter((e) => {
      if (level !== "all" && e.level !== level) return false;
      if (scope && !e.scope.toLowerCase().includes(scope)) return false;
      if (text && !entryText(e).toLowerCase().includes(text) && !e.scope.toLowerCase().includes(text))
        return false;
      return true;
    });
  }, [entries, level, scopeFilter, textFilter]);

  // Auto-scroll while following.
  useEffect(() => {
    if (autoScroll && !paused && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [filtered, autoScroll, paused]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-1 px-4 pb-2 pt-4">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <ScrollText className="h-5 w-5" /> Logs
        </h1>
        <p className="text-xs leading-5 text-muted-foreground">
          Live application log stream. Entries are redacted server-side —
          this view never receives secrets.
        </p>
      </div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <span className="flex items-center gap-1.5 font-medium">
          <span
            className={cn(
              "inline-block size-2 rounded-full",
              connected ? "bg-success" : "bg-destructive animate-pulse",
            )}
          />
          {connected ? "Live" : "Reconnecting…"}
        </span>

        <div className="flex gap-1">
          {LEVELS.map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              className={cn(
                "rounded px-2 py-1 capitalize transition-colors",
                level === l
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {l}
            </button>
          ))}
        </div>

        <input
          value={scopeFilter}
          onChange={(e) => setScopeFilter(e.target.value)}
          placeholder="scope…"
          className="w-28 rounded-md border border-border bg-transparent px-2 py-1 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <input
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
            placeholder="filter or req_…"
            className="w-44 rounded-md border border-border bg-transparent pl-6 pr-2 py-1 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        <div className="ml-auto flex items-center gap-1">
          <span className="mr-1 text-muted-foreground">
            {filtered.length}/{entries.length}
          </span>
          <button
            onClick={togglePause}
            className={cn(
              "flex items-center gap-1 rounded px-2 py-1 hover:bg-muted",
              paused && "bg-muted text-foreground",
            )}
          >
            {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            onClick={clear}
            className="flex items-center gap-1 rounded px-2 py-1 text-muted-foreground hover:bg-muted"
            title="Clear view (server buffer keeps last 1000)"
          >
            <Trash2 className="size-3" /> Clear
          </button>
        </div>
      </div>

      {/* Log lines */}
      <div
        ref={listRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto bg-background/60 px-3 py-2 font-mono text-[11px] leading-4"
      >
        {filtered.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            No entries match the current filters.
          </div>
        ) : (
          filtered.map((e) => (
            <div
              key={e.seq}
              className="flex gap-2 border-b border-border/40 py-0.5"
            >
              <span className="shrink-0 text-muted-foreground/70">{formatTime(e.time)}</span>
              <span className={cn("w-11 shrink-0 uppercase", LEVEL_STYLES[e.level])}>
                {e.level}
              </span>
              <span className="w-24 shrink-0 truncate text-sky-500">[{e.scope}]</span>
              <span className="min-w-0 break-all">
                <span className="font-medium">{e.event ?? ""}</span>
                {e.message ? <span className="text-muted-foreground"> {e.message}</span> : null}
                {entryText(e) !== (e.event ?? "") + " " + (e.message ?? "") && (
                  <span className="text-muted-foreground/80">
                    {" "}
                    {entryText(e)
                      .split(" ")
                      .filter(
                        (t) =>
                          t &&
                          t !== e.event &&
                          !(e.message && e.message.includes(t) && t.length > 4),
                      )
                      .join(" ")}
                  </span>
                )}
              </span>
            </div>
          ))
        )}
      </div>

      {!autoScroll && !paused && (
        <button
          onClick={() => {
            setAutoScroll(true);
            const el = listRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          className="border-t border-border py-1 text-xs text-muted-foreground hover:bg-muted"
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}
