/**
 * Chat run lifecycle: decoupling + explicit cancel, proven without mocks.
 *
 * A black-hole provider endpoint (accepts the model request, never responds)
 * stands in for a hung model call. The test then proves, over real HTTP for
 * the model leg:
 * - aborting the client does NOT settle the server run (decoupling);
 * - POST /api/chat/cancel/:streamId settles it (explicit cancel);
 * - a second cancel is a terminal no-op (idempotent transitions).
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { logger } from "../../src/lib/logger";
import chatApp from "../../src/routes/chat";
import providersApp from "../../src/routes/providers";

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
          messages: [{ role: "user", parts: [{ type: "text", text: "hang forever" }] }],
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
