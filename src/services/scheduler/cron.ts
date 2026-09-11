/**
 * Minimal cron utilities for the built-in scheduler.
 *
 * Matches Bun.cron's documented surface: 5 fields
 * (minute hour day-of-month month day-of-week), no seconds.
 * Timezone handling uses Intl only; DST follows the IANA database
 * implicitly (no custom DST math). Actual firing DST behavior is
 * Bun.cron's; `computeNextRun` is a preview + bookkeeping value.
 */

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 both mean Sunday)
];

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function parseToken(
  token: string,
  min: number,
  max: number,
  names?: Record<string, number>,
): number {
  const lower = token.toLowerCase();
  if (names && lower in names) return names[lower]!;
  const n = Number(token);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Value "${token}" out of range ${min}-${max}`);
  }
  return n;
}

function parseField(
  field: string,
  index: number,
  names?: Record<string, number>,
): Set<number> {
  const [min, max] = FIELD_RANGES[index]!;
  const out = new Set<number>();
  const chunks = field.split(",");
  if (chunks.length === 0) throw new Error("Empty cron field");
  for (const chunk of chunks) {
    if (!chunk) throw new Error("Empty cron list element");
    // step: <base>/<n>
    const slash = chunk.split("/");
    if (slash.length > 2) throw new Error(`Bad step in "${chunk}"`);
    const base = slash[0]!;
    const step = slash.length === 2 ? Number(slash[1]) : 1;
    if (!Number.isInteger(step) || step < 1 || step > max) {
      throw new Error(`Bad step in "${chunk}"`);
    }
    let rangeMin = min;
    let rangeMax = max;
    if (base === "*" || base === "") {
      // whole range
    } else if (base.includes("-")) {
      const [a, b] = base.split("-");
      if (a === undefined || b === undefined || a === "" || b === "") {
        throw new Error(`Bad range in "${chunk}"`);
      }
      rangeMin = parseToken(a, min, max, names);
      rangeMax = parseToken(b, min, max, names);
      if (rangeMin > rangeMax) throw new Error(`Reversed range in "${chunk}"`);
    } else {
      rangeMin = rangeMax = parseToken(base, min, max, names);
      if (slash.length === 2) {
        // e.g. "5/15" means 5-max step 15
        rangeMax = max;
      }
    }
    for (let v = rangeMin; v <= rangeMax; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error("Empty cron field result");
  return out;
}

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
}

/** Validate + parse a 5-field cron expression. Throws on invalid input. */
export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron expression: expected 5 fields (minute hour day month weekday), got ${fields.length}`,
    );
  }
  return {
    minute: parseField(fields[0]!, 0),
    hour: parseField(fields[1]!, 1),
    dom: parseField(fields[2]!, 2, undefined),
    month: parseField(fields[3]!, 3, MONTH_NAMES),
    dow: parseField(fields[4]!, 4, DOW_NAMES),
  };
}

/** True when `expression` is a valid 5-field cron. */
export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

function validateTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`Invalid IANA timezone: "${tz}"`);
  }
}

const tzPartFormatterCache = new Map<string, Intl.DateTimeFormat>();

function tzParts(date: Date, tz: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
} {
  let fmt = tzPartFormatterCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false,
      weekday: "short",
    });
    tzPartFormatterCache.set(tz, fmt);
  }
  const parts = fmt.formatToParts(date);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  // "24" hour can appear at midnight in some locales; normalize.
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  const wd = get("weekday").toLowerCase().slice(0, 3);
  const weekday = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[wd] ?? 0;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    weekday,
  };
}

/**
 * Offset of `tz` at `instant` in minutes (local - UTC).
 * Uses a locale round-trip; no custom DST math.
 */
export function tzOffsetMinutes(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(instant);
  const get = (t: string): number =>
    Number(parts.find((p) => p.type === t)?.value ?? 0);
  let hour = get("hour");
  if (hour === 24) hour = 0;
  const asUTC = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return Math.round((asUTC - instant.getTime()) / 60000);
}

/**
 * Convert a wall-clock time in `tz` to a UTC epoch.
 * Interprets the fields as local time in `tz` (iterative offset fix-up,
 * converges for normal + DST-transition walls).
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMinutes(new Date(guess), tz);
    const next = Date.UTC(year, month - 1, day, hour, minute, 0) - off * 60000;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Next UTC epoch (ms) strictly after `fromMs` matching `expression` in `tz`.
 * Searches forward minute-by-minute up to 366 days; throws if none found.
 */
export function computeNextRun(
  expression: string,
  timezone: string,
  fromMs: number = Date.now(),
): number {
  const cron = parseCron(expression);
  validateTimezone(timezone);
  // Start at the next minute boundary (strictly after fromMs).
  const startUtc = Math.floor(fromMs / 60000) * 60000 + 60000;
  const startParts = tzParts(new Date(startUtc), timezone);
  // Anchor a naive local calendar walk at the start wall time.
  let y = startParts.year;
  let mo = startParts.month;
  let d = startParts.day;
  let h = startParts.hour;
  let mi = startParts.minute;
  const advance = (): void => {
    mi += 1;
    if (mi > 59) {
      mi = 0;
      h += 1;
      if (h > 23) {
        h = 0;
        d += 1;
        if (d > daysInMonth(y, mo)) {
          d = 1;
          mo += 1;
          if (mo > 12) {
            mo = 1;
            y += 1;
          }
        }
      }
    }
  };
  // Cap: 366 days of minutes.
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const utc = zonedTimeToUtc(y, mo, d, h, mi, timezone);
    if (utc >= startUtc) {
      const p = tzParts(new Date(utc), timezone);
      const dowMatch =
        cron.dow.has(p.weekday) || (p.weekday === 0 && cron.dow.has(7));
      if (
        cron.minute.has(p.minute) &&
        cron.hour.has(p.hour) &&
        cron.dom.has(p.day) &&
        cron.month.has(p.month) &&
        dowMatch
      ) {
        return utc - (utc % 60000);
      }
    }
    advance();
    // Wall-clock sanity: stop if we walked past a year.
    if (y > startParts.year + 2) break;
  }
  throw new Error("No matching cron occurrence within 366 days");
}

/** Next `count` run times (UTC ms) after `fromMs`. */
export function computeNextRuns(
  expression: string,
  timezone: string,
  fromMs: number = Date.now(),
  count = 3,
): number[] {
  const out: number[] = [];
  let cursor = fromMs;
  for (let i = 0; i < count; i++) {
    const next = computeNextRun(expression, timezone, cursor);
    out.push(next);
    cursor = next;
  }
  return out;
}

/** Assert a timezone string is a valid IANA identifier. */
export function assertValidTimezone(tz: string): void {
  validateTimezone(tz);
}

/** Occurrence id for a cron slot (UTC minute the slot was due). */
export function cronOccurrenceId(slotUtcMs: number): string {
  return `cron-${Math.floor(slotUtcMs / 60000) * 60000}`;
}

/** Stable occurrence id for a one-time job. */
export function onceOccurrenceId(): string {
  return "once";
}

/** Occurrence id for a manual "Run now" trigger. */
export function manualOccurrenceId(): string {
  return `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- Preset builders (GUI "Repeat" options → cron) ----

export function presetEveryNMinutes(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 59) {
    throw new Error("Minutes interval must be an integer 1-59");
  }
  return n === 1 ? "* * * * *" : `*/${n} * * * *`;
}

export function presetHourly(minute = 0): string {
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("Minute must be 0-59");
  }
  return `${minute} * * * *`;
}

export function presetDaily(hour: number, minute: number): string {
  assertHourMinute(hour, minute);
  return `${minute} ${hour} * * *`;
}

export function presetWeekdays(hour: number, minute: number): string {
  assertHourMinute(hour, minute);
  return `${minute} ${hour} * * 1-5`;
}

export function presetWeekly(
  weekday: number,
  hour: number,
  minute: number,
): string {
  assertHourMinute(hour, minute);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new Error("Weekday must be 0 (Sun) - 6 (Sat)");
  }
  return `${minute} ${hour} * * ${weekday}`;
}

export function presetMonthly(day: number, hour: number, minute: number): string {
  assertHourMinute(hour, minute);
  if (!Number.isInteger(day) || day < 1 || day > 28) {
    throw new Error("Month day must be 1-28");
  }
  return `${minute} ${hour} ${day} * *`;
}

function assertHourMinute(hour: number, minute: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("Hour must be 0-23");
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("Minute must be 0-59");
  }
}

/** Short human-readable description for common cron shapes. */
export function describeCron(expression: string): string {
  let cron: ParsedCron;
  try {
    cron = parseCron(expression);
  } catch {
    return "Invalid schedule";
  }
  const nums = (s: Set<number>): number[] => [...s].sort((a, b) => a - b);
  const minutes = nums(cron.minute);
  const hours = nums(cron.hour);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const at = (h: number, m: number): string => `${p2(h)}:${p2(m)}`;

  const dailyTime =
    minutes.length === 1 && hours.length === 1
      ? at(hours[0]!, minutes[0]!)
      : null;
  const isEveryDay =
    cron.dom.size === 31 && cron.month.size === 12;

  if (!isEveryDay) {
    if (cron.dom.size === 1 && cron.month.size === 12 && dailyTime) {
      const dows = nums(cron.dow).filter((d) => d !== 7);
      if (dows.length === 5 && dows[0] === 1 && dows[4] === 5) {
        return `Weekdays at ${dailyTime}`;
      }
      if (dows.length === 1) {
        const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        return `Weekly on ${names[dows[0]!]!} at ${dailyTime}`;
      }
      if (cron.dow.size === 7 || cron.dow.size === 8) {
        return `Monthly on day ${nums(cron.dom)[0]} at ${dailyTime}`;
      }
    }
    return `Custom: ${expression}`;
  }
  // isEveryDay path: check weekdays before falling through to "Daily".
  if (dailyTime) {
    const dows = nums(cron.dow).filter((d) => d !== 7);
    if (dows.length === 5 && dows[0] === 1 && dows[4] === 5) {
      return `Weekdays at ${dailyTime}`;
    }
    if (dows.length === 1) {
      const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      return `Weekly on ${names[dows[0]!]} at ${dailyTime}`;
    }
    return `Daily at ${dailyTime}`;
  }
  if (minutes.length === 1 && hours.length === 24) {
    return `Hourly at :${p2(minutes[0]!)}`;
  }
  if (hours.length === 24 && cron.minute.size < 60) {
    // Evenly spaced minute steps → "Every N minutes".
    const step = minutes.length > 1 ? minutes[1]! - minutes[0]! : 60;
    const even =
      minutes.length > 1 &&
      minutes.every((m, i) => (i === 0 ? m === 0 : m === minutes[i - 1]! + step)) &&
      60 % step === 0;
    if (even) return `Every ${step} minutes`;
  }
  if (minutes.length === 60 && hours.length === 24) return "Every minute";
  return `Custom: ${expression}`;
}
