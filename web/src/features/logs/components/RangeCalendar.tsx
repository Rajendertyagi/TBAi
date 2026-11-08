import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { DateRange } from "../types";

export interface RangeCalendarProps {
  range: DateRange;
  onChange: (range: DateRange) => void;
  onClose?: () => void;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function formatYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function RangeCalendar({ range, onChange, onClose }: RangeCalendarProps) {
  const initialDate = useMemo(() => {
    if (range.from) {
      const parsed = new Date(range.from);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return new Date();
  }, [range.from]);

  const [viewYear, setViewYear] = useState<number>(initialDate.getFullYear());
  const [viewMonth, setViewMonth] = useState<number>(initialDate.getMonth());

  const daysGrid = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1);
    const startWeekday = firstDay.getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const daysInPrev = new Date(viewYear, viewMonth, 0).getDate();

    const cells: Array<{ date: string; isCurrentMonth: boolean; dayNum: number }> = [];

    // Leading days
    for (let i = startWeekday - 1; i >= 0; i--) {
      const d = daysInPrev - i;
      const prevDate = new Date(viewYear, viewMonth - 1, d);
      cells.push({
        date: formatYMD(prevDate),
        isCurrentMonth: false,
        dayNum: d,
      });
    }

    // Current month
    for (let d = 1; d <= daysInMonth; d++) {
      const curr = new Date(viewYear, viewMonth, d);
      cells.push({
        date: formatYMD(curr),
        isCurrentMonth: true,
        dayNum: d,
      });
    }

    // Trailing days to fill 42 cells (6 rows)
    let nextDay = 1;
    while (cells.length < 42) {
      const nextDate = new Date(viewYear, viewMonth + 1, nextDay);
      cells.push({
        date: formatYMD(nextDate),
        isCurrentMonth: false,
        dayNum: nextDay,
      });
      nextDay++;
    }

    return cells;
  }, [viewYear, viewMonth]);

  const handlePrevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const handleSelectDay = (ymd: string) => {
    if (!range.from || (range.from && range.to)) {
      // Start fresh selection
      onChange({ from: `${ymd}T00:00:00.000Z`, to: null });
    } else {
      // Complete range
      const fromTime = new Date(range.from).getTime();
      const selectedTime = new Date(`${ymd}T23:59:59.999Z`).getTime();
      if (selectedTime < fromTime) {
        onChange({
          from: `${ymd}T00:00:00.000Z`,
          to: range.from,
        });
      } else {
        onChange({
          from: range.from,
          to: `${ymd}T23:59:59.999Z`,
        });
      }
    }
  };

  const fromDateStr = range.from ? range.from.slice(0, 10) : null;
  const toDateStr = range.to ? range.to.slice(0, 10) : null;

  return (
    <div className="p-3 w-64 select-none">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-foreground">
          {MONTH_NAMES[viewMonth]} {viewYear}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handlePrevMonth}
            aria-label="Previous month"
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleNextMonth}
            aria-label="Next month"
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center mb-1">
        {WEEKDAYS.map((wd) => (
          <span key={wd} className="text-3xs font-medium text-muted-foreground">
            {wd}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {daysGrid.map((cell) => {
          const isSelectedStart = cell.date === fromDateStr;
          const isSelectedEnd = cell.date === toDateStr;
          const isInRange =
            fromDateStr && toDateStr && cell.date > fromDateStr && cell.date < toDateStr;

          let bg = "hover:bg-muted text-foreground";
          if (!cell.isCurrentMonth) {
            bg = "text-muted-foreground/40 hover:bg-muted/50";
          }
          if (isSelectedStart || isSelectedEnd) {
            bg = "bg-primary text-primary-foreground font-semibold";
          } else if (isInRange) {
            bg = "bg-primary/15 text-foreground";
          }

          return (
            <button
              key={cell.date}
              type="button"
              onClick={() => handleSelectDay(cell.date)}
              className={`h-7 w-7 rounded text-2xs flex items-center justify-center transition-colors ${bg}`}
            >
              {cell.dayNum}
            </button>
          );
        })}
      </div>

      <div className="mt-3 pt-2 border-t border-border flex items-center justify-between text-2xs text-muted-foreground">
        <span>
          {fromDateStr
            ? toDateStr
              ? `${fromDateStr} → ${toDateStr}`
              : `From: ${fromDateStr}`
            : "No range set"}
        </span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-primary hover:underline font-medium"
          >
            Done
          </button>
        )}
      </div>
    </div>
  );
}
