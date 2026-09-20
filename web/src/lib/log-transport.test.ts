/**
 * Client log transport: payload flattening, batching, bounds, and — most
 * importantly — failure isolation. A logging transport that can throw, block,
 * or retry-loop is worse than no transport, so those are the cases pinned here.
 *
 * Delivery is injected through the transport's own seam (`setTransportFetchForTests`)
 * rather than by replacing the global `fetch`: test files share one process, so
 * a global stub races every other file that stubs it.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  BATCH_SIZE,
  CLIENT_LOG_ENDPOINT,
  MAX_QUEUE,
  clientTransportStats,
  enqueueClientEvent,
  flushClientEvents,
  resetClientTransportForTests,
  setTransportFetchForTests,
  toScalarFields,
  type ClientLogEvent,
} from "./log-transport";

let calls: Array<{ url: string; init: RequestInit | undefined }> = [];
let responder: () => Promise<Response> = async () => new Response("{}", { status: 200 });

/** One event-loop turn: lets a fire-and-forget flush settle. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function installStub(): void {
  setTransportFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : String(input), init });
    return responder();
  }) as typeof fetch);
}

function event(overrides: Partial<ClientLogEvent> = {}): ClientLogEvent {
  return {
    level: "info",
    scope: "chat",
    event: "send.start",
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

function sentEvents(index: number): ClientLogEvent[] {
  const body = JSON.parse(String(calls[index]?.init?.body ?? "{}")) as {
    events: ClientLogEvent[];
  };
  return body.events;
}

beforeEach(() => {
  resetClientTransportForTests();
  calls = [];
  responder = async () => new Response("{}", { status: 200 });
  installStub();
});

afterEach(() => {
  resetClientTransportForTests();
});

describe("toScalarFields", () => {
  it("keeps flat scalars and drops nested values", () => {
    const out = toScalarFields({
      status: 200,
      ok: true,
      reason: null,
      engine: "opencode",
      nested: { a: 1 },
      list: [1, 2],
      missing: undefined,
    });
    expect(out).toEqual({ status: 200, ok: true, reason: null, engine: "opencode" });
  });

  it("drops reserved keys and non-finite numbers", () => {
    const out = toScalarFields({
      event: "x",
      message: "y",
      operationId: "z",
      ts: 1,
      good: 1,
      bad: Number.NaN,
    });
    expect(out).toEqual({ good: 1 });
  });

  it("truncates long strings and caps the field count", () => {
    const many: Record<string, unknown> = { long: "a".repeat(900) };
    for (let i = 0; i < 40; i++) many[`k${i}`] = i;
    const out = toScalarFields(many)!;
    expect(String(out.long).length).toBe(500);
    expect(Object.keys(out).length).toBe(24);
  });

  it("returns undefined when nothing survives", () => {
    expect(toScalarFields({ nested: {}, list: [] })).toBeUndefined();
  });
});

describe("batching", () => {
  it("flushes a full batch to the ingest endpoint", async () => {
    for (let i = 0; i < BATCH_SIZE; i++) enqueueClientEvent(event({ event: `e${i}` }));
    await tick();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(CLIENT_LOG_ENDPOINT);
    expect(sentEvents(0).length).toBe(BATCH_SIZE);
    expect(clientTransportStats().sent).toBe(BATCH_SIZE);
  });

  it("carries correlation fields through unchanged", async () => {
    enqueueClientEvent(
      event({
        operationId: "op_abc",
        threadId: "t1",
        conversationId: "c1",
        message: "hello",
        fields: { status: 200, nested: { drop: true } },
      }),
    );
    await flushClientEvents();
    const sent = sentEvents(0)[0] as ClientLogEvent;
    expect(sent.operationId).toBe("op_abc");
    expect(sent.threadId).toBe("t1");
    expect(sent.conversationId).toBe("c1");
    // Nested values are flattened away at the boundary.
    expect(sent.fields).toEqual({ status: 200 });
  });

  it("does nothing when the queue is empty", async () => {
    await flushClientEvents();
    expect(calls.length).toBe(0);
  });
});

describe("bounds", () => {
  it("sheds the oldest events once the queue cap is reached", () => {
    // A stalled delivery holds the in-flight slot so the queue can actually grow.
    responder = () => new Promise<Response>(() => {});
    const total = MAX_QUEUE + BATCH_SIZE + 10;
    for (let i = 0; i < total; i++) enqueueClientEvent(event({ event: `e${i}` }));
    const stats = clientTransportStats();
    expect(stats.queued).toBe(total);
    // Exactly the overflow beyond the cap is dropped, and it is counted.
    expect(stats.dropped).toBe(total - BATCH_SIZE - MAX_QUEUE);
  });
});

describe("failure isolation", () => {
  it("never throws and drops (does not retry) a rejected batch", async () => {
    responder = async () => {
      throw new Error("backend down");
    };
    for (let i = 0; i < 3; i++) enqueueClientEvent(event());
    await flushClientEvents();
    const stats = clientTransportStats();
    expect(stats.failures).toBe(1);
    expect(stats.dropped).toBe(3);
    expect(stats.sent).toBe(0);
    // The queue is drained: a failing transport must not accumulate work.
    expect(stats.queued).toBe(3);
  });

  it("treats a non-OK response as a dropped batch", async () => {
    responder = async () => new Response("nope", { status: 503 });
    enqueueClientEvent(event());
    await flushClientEvents();
    const stats = clientTransportStats();
    expect(stats.failures).toBe(1);
    expect(stats.dropped).toBe(1);
    expect(stats.sent).toBe(0);
  });

  it("recovers once the backend answers again", async () => {
    responder = async () => {
      throw new Error("down");
    };
    enqueueClientEvent(event());
    await flushClientEvents();
    responder = async () => new Response("{}", { status: 200 });
    enqueueClientEvent(event());
    await flushClientEvents();
    expect(clientTransportStats().sent).toBe(1);
    expect(clientTransportStats().failures).toBe(1);
  });
});
