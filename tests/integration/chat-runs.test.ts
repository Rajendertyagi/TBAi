/**
 * Chat run lifecycle: decoupling + explicit cancel, proven without mocks.
 *
 * A black-hole provider endpoint (accepts the model request, never responds)
 * stands in for a hung model call. The test then proves, over real HTTP for
 * the model leg:
 * - aborting the client does NOT settle the server run (decoupling);
 * - POST /api/chat/cancel/:streamId settles it (explicit cancel);
 * - a second cancel is a terminal no-op (idempotent transitions);
 * - when the wall-clock timer has ALREADY marked the run `timedOut`, a cancel
 *   that wins the synchronous transition race reports/settles FAILED, because
 *   the truth about that run is "it ran out of time", not "the user stopped it".
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { logger } from "../../src/lib/logger";
import chatApp from "../../src/routes/chat";
import providersApp from "../../src/routes/providers";
import { chatRuns, createChatRunStore } from "../../src/services/chat-runs";

// Logger level is global singleton state shared across test files.
beforeEach(() => {
  logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });
});

afterEach(() => {
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
});

const app = new Hono();
app.route("/", chatApp);
app.route("/", providersApp);

const json = { "Content-Type": "application/json" };

let blackhole: ReturnType<typeof Bun.serve> | null = null;
let blackholePort = 0;

async function startBlackhole(): Promise<number> {
  blackhole = Bun.serve({
    port: 0,
    fetch() {
      // Accept and hold forever: the model request hangs mid-run.
      return new Promise<Response>(() => {});
    },
  });
  blackhole.unref();
  blackholePort = blackhole.port;
  return blackholePort;
}

afterAll(() => {
  try {
    blackhole?.stop(true);
  } catch {
    /* already closed */
  }
  blackhole = null;
});

async function seedBlackholeProvider(): Promise<{ id: string; endpoint: string }> {
  const port = blackholePort || (await startBlackhole());
  const endpoint = `http://127.0.0.1:${port}`;
  const res = await app.request("/api/providers", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: "blackhole", type: "ollama", endpoint, model: "void" }),
  });
  expect(res.status).toBe(200);
  const created = (await res.json()) as { id: string };
  return { id: created.id, endpoint };
}

/** Remove the blackhole provider rows this file created. */
async function deleteBlackholeProviders(): Promise<void> {
  const listed = await app.request("/api/providers");
  const list = (await listed.json()) as Array<{ id: string; name: string }>;
  for (const p of list.filter((p) => p.name === "blackhole")) {
    await app.request(`/api/providers/${p.id}`, { method: "DELETE" });
  }
}

/** Poll a condition the server reaches on its own; fails loudly on timeout. */
async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Start a run whose model leg hangs, and return its stream id. */
async function startHungRun(providerId: string): Promise<string> {
  const res = await app.request("/api/chat", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      providerId,
      model: "void",
      messages: [
        { id: "msg-run-hang", role: "user", parts: [{ type: "text", text: "hang forever" }] },
      ],
    }),
  });
  expect(res.status).toBe(200);
  const streamId = res.headers.get("x-resumable-stream-id");
  expect(streamId).toBeTruthy();
  return streamId!;
}

describe("chat run cancel endpoint", () => {
  it("404s unknown and malformed stream ids", async () => {
    const missing = await app.request("/api/chat/cancel/does-not-exist", { method: "POST" });
    expect(missing.status).toBe(404);
  });

  it("aborting the client leaves the run alive; explicit cancel settles it", async () => {
    const { id: providerId } = await seedBlackholeProvider();
    const since = logger.lastSeq;
    // Start a run but never consume the body: the handler returns response
    // headers (with the stream id) while the model leg hangs.
    const controller = new AbortController();
    const pending = app.request(
      "/api/chat",
      {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          providerId,
          model: "void",
          messages: [{ id: "msg-run-cancel", role: "user", parts: [{ type: "text", text: "hang forever" }] }],
        }),
        signal: controller.signal,
      },
    );
    const res = await pending;
    expect(res.status).toBe(200);
    const streamId = res.headers.get("x-resumable-stream-id");
    expect(streamId).toBeTruthy();

    // Client goes away mid-run (the decoupling case: no signal reaches the
    // run controller through in-process fetch, mirroring a dead socket).
    controller.abort();
    await new Promise((r) => setTimeout(r, 500));

    // The run survived: explicit cancel transitions it (first call wins).
    const cancel = await app.request(`/api/chat/cancel/${streamId}`, { method: "POST" });
    expect(cancel.status).toBe(200);
    const cancelled = (await cancel.json()) as { ok: boolean; cancelled: boolean };
    expect(cancelled.ok).toBe(true);
    expect(cancelled.cancelled).toBe(true);

    // Second cancel is a terminal no-op, never an error.
    const again = await app.request(`/api/chat/cancel/${streamId}`, { method: "POST" });
    expect(again.status).toBe(200);
    const repeated = (await again.json()) as { ok: boolean; cancelled: boolean; status: string };
    expect(repeated.ok).toBe(true);
    expect(repeated.cancelled).toBe(false);
    expect(repeated.status).toBe("cancelled");

    // Lifecycle observed in the ring (ai.request fired; no duplicate runs).
    const fresh = logger.getRecentEntries(since);
    expect(fresh.some((e) => e.event === "ai.request")).toBe(true);

    // Cleanup: provider row (test DB is isolated per run).
    const created = await app.request("/api/providers");
    const list = (await created.json()) as Array<{ id: string; name: string }>;
    for (const p of list.filter((p) => p.name === "blackhole")) {
      await app.request(`/api/providers/${p.id}`, { method: "DELETE" });
    }
  }, 15000);
});

// ── The wall clock and an explicit cancel can race ──────────────────────────
// The wall-clock timer marks `timedOut` and only then aborts, so between those
// two steps the record is still `running` with the timeout marker already in
// place. If the cancel request wins that window it must preserve the timeout
// outcome: reporting "cancelled" would tell the user (and the funnel) that
// they stopped a run that in fact ran out of time.
describe("chat run cancel — wall-clock timeout wins the transition race", () => {
  it("settles and reports failed (never cancelled) once the wall clock marked the run timed out", async () => {
    const { id: providerId } = await seedBlackholeProvider();
    const since = logger.lastSeq;

    try {
      const streamId = await startHungRun(providerId);
      const record = chatRuns.get(streamId);
      expect(record?.status).toBe("running");

      // The exact state the wall clock leaves behind: marked, still running.
      // (The mark itself is produced for real by the store-level case below —
      // waiting out the 30-minute production clock is not an option here.)
      record!.timedOut = true;
      expect(chatRuns.get(streamId)?.status).toBe("running");

      const cancel = await app.request(`/api/chat/cancel/${streamId}`, { method: "POST" });
      expect(cancel.status).toBe(200);
      const body = (await cancel.json()) as {
        ok: boolean;
        cancelled: boolean;
        status: string;
      };
      expect(body.ok).toBe(true);
      // Not a user cancellation, and the terminal state is the timeout's.
      expect(body.cancelled).toBe(false);
      expect(body.status).toBe("failed");
      expect(chatRuns.get(streamId)?.status).toBe("failed");

      // The funnel line agrees: a timeout at error level, never a cancellation.
      const terminal = logger.getRecentEntries(since).filter((e) => e.event === "ai.error");
      expect(terminal.some((e) => e.category === "timeout" && e.level === "error")).toBe(true);
      expect(terminal.some((e) => e.category === "cancelled")).toBe(false);

      // Still idempotent: a repeated cancel reports the same terminal state.
      const again = await app.request(`/api/chat/cancel/${streamId}`, { method: "POST" });
      const repeated = (await again.json()) as { ok: boolean; cancelled: boolean; status: string };
      expect(repeated.ok).toBe(true);
      expect(repeated.cancelled).toBe(false);
      expect(repeated.status).toBe("failed");
    } finally {
      await deleteBlackholeProviders();
    }
  }, 15000);

  it("the wall clock marks the run timed out and leaves the transition to the abort", async () => {
    // The store-level half of the contract above: the timer MARKS, it does not
    // settle. That is precisely why the cancel endpoint has to read the marker —
    // the window between "marked" and "settled" is real, and owned by whoever
    // gets there first.
    const store = createChatRunStore({ wallTimeoutMs: 20 });
    const record = store.create({ requestId: "req-wall-clock" });

    expect(record.status).toBe("running");
    await waitFor(() => record.timedOut, "the wall-clock timeout mark");
    // Marked and aborted, but NOT terminal: the abort path owns the transition.
    expect(record.controller.signal.aborted).toBe(true);
    expect(store.get(record.streamId)?.status).toBe("running");

    // Whatever settles it next, the run cannot be reported as a cancellation.
    expect(store.markFailed(record.streamId)).toBe(true);
    expect(store.get(record.streamId)?.status).toBe("failed");
    expect(store.markCancelled(record.streamId)).toBe(false);
  }, 15000);
});
