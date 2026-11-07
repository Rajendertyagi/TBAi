import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Check, ChevronRight, Copy } from "lucide-react";
import React, { useMemo, useState } from "react";
import type { LogEntry, LogLevel } from "../types";

export interface LogRowProps {
  entry: LogEntry;
  searchQuery?: string;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

const LEVEL_STYLES: Record<LogLevel, { badge: string; text: string }> = {
  debug: {
    badge: "bg-slate-500/15 text-slate-400 border-slate-500/30",
    text: "text-slate-400",
  },
  info: {
    badge: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    text: "text-blue-400",
  },
  warn: {
    badge: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    text: "text-amber-400",
  },
  error: {
    badge: "bg-rose-500/15 text-rose-400 border-rose-500/30",
    text: "text-rose-400",
  },
};

export function detailEntries(
  record: LogEntry,
): Array<{ key: string; value: string; isError?: boolean }> {
  const result: Array<{ key: string; value: string; isError?: boolean }> = [];
  const standardKeys = new Set(["seq", "time", "level", "scope", "event", "message"]);

  for (const [k, v] of Object.entries(record)) {
    if (standardKeys.has(k) || v === undefined) continue;
    if (k === "fields" && v && typeof v === "object") {
      for (const [fk, fv] of Object.entries(v as Record<string, unknown>)) {
        const strVal = typeof fv === "object" ? JSON.stringify(fv, null, 2) : String(fv);
        result.push({ key: fk, value: strVal });
      }
    } else if (k === "err" || k === "error") {
      const errStr =
        v instanceof Error
          ? `${v.name}: ${v.message}\n${v.stack || ""}`
          : typeof v === "object"
            ? JSON.stringify(v, null, 2)
            : String(v);
      result.push({ key: "error", value: errStr, isError: true });
    } else {
      const strVal = typeof v === "object" ? JSON.stringify(v, null, 2) : String(v);
      result.push({ key: k, value: strVal });
    }
  }
  return result;
}

export const LogRow = React.memo(function LogRow({
  entry,
  isExpanded,
  onToggleExpand,
}: LogRowProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const style = LEVEL_STYLES[entry.level] || LEVEL_STYLES.info;
  const details = useMemo(() => detailEntries(entry), [entry]);
  const hasDetails = details.length > 0;

  const rawJson = useMemo(() => {
    return JSON.stringify(entry, null, 2);
  }, [entry]);

  const handleCopy = (e: React.MouseEvent, key: string, val: string) => {
    e.stopPropagation();
    navigator.clipboard.writeText(val);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey(null);
    }, 1500);
  };

  const formattedTime = useMemo(() => {
    if (!entry.time) return "";
    const d = new Date(entry.time);
    if (Number.isNaN(d.getTime())) return entry.time;
    return `${d.toTimeString().split(" ")[0]}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  }, [entry.time]);

  return (
    <Collapsible
      open={isExpanded}
      onOpenChange={onToggleExpand}
      className="border-b border-border/40 font-mono text-2xs hover:bg-muted/30 transition-colors group"
    >
      <div className="flex items-start gap-2.5 px-3 py-1.5 select-text">
        <div className="flex items-center gap-1 shrink-0 pt-0.5">
          {hasDetails ? (
            <CollapsibleTrigger asChild>
              <button
                type="button"
                aria-label="Toggle details"
                aria-expanded={isExpanded}
                className="p-0.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground transition-transform"
              >
                <ChevronRight
                  className={`w-3.5 h-3.5 transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}
                />
              </button>
            </CollapsibleTrigger>
          ) : (
            <span className="w-4.5" />
          )}

          <span
            className={`px-1.5 py-0.2 rounded border text-3xs font-semibold uppercase tracking-wider shrink-0 ${style.badge}`}
          >
            {entry.level}
          </span>
        </div>

        <span className="text-muted-foreground/70 shrink-0 text-3xs pt-0.5">{formattedTime}</span>

        <span className="text-primary font-medium shrink-0 max-w-[120px] truncate pt-0.5">
          [{entry.scope}]
        </span>

        {entry.event && (
          <span className="text-foreground/90 font-medium shrink-0 pt-0.5">{entry.event}</span>
        )}

        {entry.message && (
          <span className="text-muted-foreground truncate flex-1 min-w-0 pt-0.5">
            {entry.message}
          </span>
        )}

        {/* Hover quick copy for whole raw log JSON */}
        <button
          type="button"
          onClick={(e) => handleCopy(e, "raw-json", rawJson)}
          title="Copy raw JSON"
          aria-label="Copy raw log JSON"
          className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground transition-opacity shrink-0 ml-auto"
        >
          {copiedKey === "raw-json" ? (
            <Check className="w-3 h-3 text-emerald-400" />
          ) : (
            <Copy className="w-3 h-3" />
          )}
        </button>
      </div>

      <CollapsibleContent className="px-9 pb-2 pt-0.5">
        <div className="rounded-md bg-muted/40 p-2 text-3xs border border-border/50 space-y-1.5">
          {details.map((item) => {
            const isCopied = copiedKey === item.key;
            return (
              <div
                key={item.key}
                className="flex items-start justify-between gap-2 group/field hover:bg-muted/60 p-1 rounded transition-colors"
              >
                <div className="flex-1 min-w-0 break-all">
                  <span
                    className={
                      item.isError
                        ? "text-rose-400 font-semibold"
                        : "text-muted-foreground font-semibold"
                    }
                  >
                    {item.key}:
                  </span>{" "}
                  <span className={item.isError ? "text-rose-300" : "text-foreground"}>
                    {item.value}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(e) => handleCopy(e, item.key, item.value)}
                  title={`Copy ${item.key}`}
                  aria-label={`Copy ${item.key}`}
                  className="opacity-0 group-hover/field:opacity-100 p-0.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground transition-opacity shrink-0"
                >
                  {isCopied ? (
                    <Check className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});
