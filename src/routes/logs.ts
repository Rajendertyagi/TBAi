import { Hono } from "hono";
import fs from "fs";
import path from "path";
import {
  defaultLogFilePath,
  listLogFiles,
  logger,
  retentionInfo,
  type LogEntry,
} from "../lib/logger";
import {
  logFileNameSchema,
  logRecentQuerySchema,
  logSettingsSchema,
} from "../lib/validation";
import {
  getPersistedLogSettings,
  isLogFileEnvLocked,
  isLogLevelEnvLocked,
  persistLogSettings,
} from "../services/log-settings";
import { disableIdleTimeout } from "./shared";

const app = new Hono<{ Variables: { requestId: string } }>();

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");

const LEVEL_RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function entryText(e: LogEntry): string {
  return [e.event ?? "", e.message ?? "", e.scope ?? ""].join(" ").toLowerCase();
}

// Capture settings (level + per-scope overrides + file sink). The env owns
// the level when TBAI_LOG_LEVEL is set and the sink path when TBAI_LOG_FILE
// is set — the UI locks those controls in that case.
app.get("/settings", (c) => {
  const sink = logger.fileSink;
  return c.json({
    level: logger.level,
    targets: logger.targets,
    env_locked: isLogLevelEnvLocked(),
    file: {
      enabled: sink.enabled,
      maxMb: sink.maxMb,
      keepFiles: sink.keepFiles,
      maxTotalMb: sink.maxTotalMb,
      retentionHours: sink.retentionHours,
    },
    file_locked: isLogFileEnvLocked(),
    throttle: { throttled: logger.getWriteStats().throttled },
  });
});

app.put("/settings", async (c) => {
  const parsed = logSettingsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid log settings", issues: parsed.error.issues }, 400);
  }
  logger.configure({ level: parsed.data.level, targets: parsed.data.targets });
  if (parsed.data.file && !isLogFileEnvLocked()) {
    const f = parsed.data.file;
    logger.configure({
      file: f.enabled ? (logger.fileSink.file ?? defaultLogFilePath()) : null,
      fileEnabled: f.enabled,
      maxBytes: Math.floor(f.maxMb * 1024 * 1024),
      keepFiles: Math.max(1, Math.floor(f.keepFiles)),
      maxTotalBytes: Math.floor(f.maxTotalMb * 1024 * 1024),
      retentionMs: Math.floor(f.retentionHours * 3600 * 1000),
    });
  }
  try {
    persistLogSettings({
      level: parsed.data.level,
      targets: parsed.data.targets,
      file: parsed.data.file,
    });
  } catch {
    return c.json({ error: "Could not persist log settings" }, 500);
  }
  return c.json({ ok: true, level: logger.level, targets: logger.targets });
});

// Recent buffered entries (post-redaction). `since` = last seen seq;
// `limit`/`minLevel`/`search` narrow the snapshot (live tail filters client-side).
app.get("/recent", (c) => {
  const parsed = logRecentQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) {
    return c.json({ error: "Invalid query", issues: parsed.error.issues }, 400);
  }
  const { since, limit, minLevel, search, from, until } = parsed.data;
  let entries = logger.getRecentEntries(since);
  if (minLevel) {
    const rank = LEVEL_RANK[minLevel] ?? 0;
    entries = entries.filter((e) => (LEVEL_RANK[e.level] ?? 0) >= rank);
  }
  const q = search?.trim().toLowerCase();
  if (q) entries = entries.filter((e) => entryText(e).includes(q));
  if (from !== undefined || until !== undefined) {
    entries = entries.filter((e) => {
      const t = Date.parse(e.time.replace(" ", "T"));
      if (Number.isNaN(t)) return true;
      if (from !== undefined && t < from) return false;
      if (until !== undefined && t > until) return false;
      return true;
    });
  }
  if (entries.length > limit) entries = entries.slice(entries.length - limit);
  return c.json({ entries, lastSeq: logger.lastSeq, bootId: logger.bootId });
});

// Live stream (SSE): backlog first, then new entries as they occur.
app.get("/stream", (c) => {
  const encoder = new TextEncoder();
  let lastSentSeq = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Quiet SSE counts as idle: keep it alive indefinitely (plus the 5s
      // comment heartbeat below for proxy insurance).
      disableIdleTimeout(c);
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const drain = () => {
        const entries = logger.getRecentEntries(lastSentSeq);
        if (entries.length === 0) return;
        lastSentSeq = (entries[entries.length - 1] as LogEntry & { seq: number }).seq;
        send("entries", { entries, lastSeq: logger.lastSeq, bootId: logger.bootId });
      };
      drain(); // backlog
      const unsubscribe = logger.subscribe(drain);
      // Heartbeat keeps the idle connection alive. Must beat Bun.serve's
      // default ~10s idle timeout: a quiet stream (capture off, filtered
      // scopes) with a slower ping gets killed mid-chunk and the browser
      // reports ERR_INCOMPLETE_CHUNKED_ENCODING. A comment frame is ~7 bytes.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, 5000);
      const abort = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      c.req.raw.signal.addEventListener("abort", abort);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// On-disk logs: the logger's own rotated JSON-lines sink (data/tbai.log*).
// Listing and naming policy live in lib/logger — this serves opaque bytes and
// retention metadata without parsing log content. Empty when file logging is
// off (development default).
app.get("/files", (c) => {
  const files = listLogFiles(DATA_DIR).map(({ name, size_bytes }) => ({
    name,
    size_bytes,
  }));
  const sink = logger.fileSink;
  const writer = logger.getWriteStats();
  return c.json({
    files,
    retention: retentionInfo(DATA_DIR, {
      retentionHours: sink.retentionHours,
      maxTotalMb: sink.maxTotalMb,
    }),
    writer: { queued: writer.queued, dropped: writer.dropped },
  });
});

app.get("/files/:name", (c) => {
  const parsed = logFileNameSchema.safeParse(c.req.param("name"));
  if (!parsed.success) return c.json({ error: "Unknown log file" }, 404);
  const filePath = path.join(DATA_DIR, parsed.data);
  let body: Buffer;
  try {
    body = fs.readFileSync(filePath);
  } catch {
    return c.json({ error: "Unknown log file" }, 404);
  }
  // Rotated sinks are JSON-lines UTF-8 text; serve decoded.
  return c.text(body.toString("utf-8"));
});

export default app;
