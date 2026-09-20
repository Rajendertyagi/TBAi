/**
 * Browser event ingest (`POST /api/logs/client`) through the real Hono sub-app.
 *
 * This boundary is where untrusted client data enters the backend logging
 * pipeline, so it is pinned on every axis: acceptance, correlation attribution,
 * scope registry enforcement, payload shape, and hard bounds.
 *
 * DB isolation comes from tests/setup.ts (DATA_DIR redirected to tmp).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { logger } from "../../src/lib/logger";
import logsApp from "../../src/routes/logs";

const app = new Hono();
app.route("/api/logs", logsApp);

const jsonHeaders = { "Content-Type": "application/json" };

function post(body: unknown, extra: Record<string, string> = {}) {
  return app.request("/api/logs/client", {
    method: "POST",
    headers: { ...jsonHeaders, ...extra },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function clientEvent(overrides: Record<string, unknown> = {}) {
  return {
    level: "info",
    scope: "chat",
    event: "send.start",
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  logger.resetLossCounters();
  logger.resetThrottleStates();
  logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });
});

afterEach(() => {
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
});

describe("client log ingest", () => {
  it("accepts a batch and lands the events in the shared ring", async () => {
    const since = logger.lastSeq;
    const res = await post({
      events: [
        clientEvent({
          operationId: "op_1",
          threadId: "t1",
          conversationId: "c1",
          message: "hello",
          fields: { trigger: "submit", status: 200 },
        }),
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1 });

    const entry = logger.getRecentEntries(since).find((e) => e.event === "send.start")!;
    expect(entry.scope).toBe("chat");
    expect(entry.level).toBe("info");
    // Provenance and both clocks are explicit.
    expect(entry.plane).toBe("client");
    expect(entry.clientTs).toBe(1_700_000_000_000);
    expect(typeof entry.ts).toBe("number");
    expect(entry.operationId).toBe("op_1");
    expect(entry.threadId).toBe("t1");
    expect(entry.conversationId).toBe("c1");
    expect(entry.trigger).toBe("submit");
    expect(entry.status).toBe(200);
  });

  it("attributes each event to its own operation, not the ingest request's", async () => {
    const since = logger.lastSeq;
    const res = await post(
      {
        events: [
          clientEvent({ event: "with_op", operationId: "op_event" }),
          clientEvent({ event: "without_op", scope: "app" }),
        ],
      },
      { "x-tbai-operation-id": "op_ingest_request" },
    );
    expect(res.status).toBe(200);
    const entries = logger.getRecentEntries(since);
    // The event's own id wins; a queued batch may span operations.
    expect(entries.find((e) => e.event === "with_op")!.operationId).toBe("op_event");
    // An event with no operation must NOT inherit the flush's operation.
    expect(entries.find((e) => e.event === "without_op")!.operationId).toBeUndefined();
  });

  it("accepts a registered hierarchical client scope", async () => {
    const res = await post({
      events: [clientEvent({ scope: "opencode.runtime" })],
    });
    expect(res.status).toBe(200);
  });

  it("rejects an unregistered scope and names it", async () => {
    const res = await post({ events: [clientEvent({ scope: "not_a_real_scope" })] });
    expect(res.status).toBe(400);
    expect((await res.json()).scopes).toEqual(["not_a_real_scope"]);
  });

  it("rejects nested field values (flat scalars only)", async () => {
    const res = await post({
      events: [clientEvent({ fields: { nested: { a: 1 } } })],
    });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed event name", async () => {
    const res = await post({ events: [clientEvent({ event: "has spaces" })] });
    expect(res.status).toBe(400);
  });

  it("rejects an empty batch and an oversized batch", async () => {
    expect((await post({ events: [] })).status).toBe(400);
    const tooMany = { events: Array.from({ length: 201 }, () => clientEvent()) };
    expect((await post(tooMany)).status).toBe(400);
  });

  it("rejects invalid JSON", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
  });

  it("rejects a payload over the byte cap", async () => {
    const huge = JSON.stringify({
      events: [clientEvent({ message: "x".repeat(300 * 1024) })],
    });
    const res = await post(huge);
    expect(res.status).toBe(413);
  });

  it("rejects a backend-only scope the browser does not own", async () => {
    // `scheduler` is registered, but on the BACKEND plane. The client registry
    // is deliberately narrower, so the browser cannot inject lines into a
    // backend subsystem and make a scope query lie about their origin.
    const res = await post({ events: [clientEvent({ scope: "scheduler" })] });
    expect(res.status).toBe(400);
    expect((await res.json()).scopes).toEqual(["scheduler"]);
  });
});

describe("loss visibility through the API", () => {
  it("exposes every loss counter from GET /api/logs/files", async () => {
    logger.configure({ level: "error" });
    logger.info("chat", "filtered-away");
    const res = await app.request("/api/logs/files");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      writer: { loss: Record<string, number> };
    };
    expect(Object.keys(body.writer.loss).sort()).toEqual([
      "fileQueueDropped",
      "ioFailures",
      "levelFiltered",
      "ringSpliced",
    ]);
    expect(body.writer.loss.levelFiltered).toBeGreaterThanOrEqual(1);
  });
});
