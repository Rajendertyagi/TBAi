import { Hono } from "hono";
import { logger, type LogEntry } from "../lib/logger";

const app = new Hono<{ Variables: { requestId: string } }>();

// Recent buffered entries (post-redaction). `since` = last seen seq.
app.get("/recent", (c) => {
  const since = Number(c.req.query("since") ?? 0) || 0;
  return c.json({ entries: logger.getRecentEntries(since), lastSeq: logger.lastSeq });
});

// Live stream (SSE): backlog first, then new entries as they occur.
app.get("/stream", (c) => {
  const encoder = new TextEncoder();
  let lastSentSeq = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
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
        send("entries", { entries, lastSeq: logger.lastSeq });
      };
      drain(); // backlog
      const unsubscribe = logger.subscribe(drain);
      // Heartbeat keeps proxies from closing the idle connection.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, 15000);
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

export default app;
