import { describe, expect, it } from "bun:test";
import {
  createOpenCodeV2Client,
  type OpenCodeV2Client,
  type OpenCodeV2Generation,
} from "@web/features/opencode/v2Client.ts";

const SESSION_ID = "ses_v2_client_test";
const OTHER_SESSION_ID = "ses_v2_client_other";
const DIRECTORY = "D:\\workspace\\project one%20";
const ABSOLUTE_ORIGIN = "https://app.example";
const RELATIVE_ORIGIN = "/relative-origin";
const SESSION_HEADER = "x-tbai-session";
const DIRECTORY_HEADER = "x-opencode-directory";
const PROXY_PATH = "/api/opencode";
const SERVER_INFO = {
  version: "2.0.16",
  pid: 1,
  urls: [],
  paths: { tmp: "v2-client-test" },
} as const;
const EMPTY_HISTORY = {
  data: [],
  cursor: {},
} as const;
const CONNECTED_EVENT = { type: "server.connected", data: {} } as const;

const SCOPE = {
  sessionId: SESSION_ID,
  directory: null,
} as const;

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
};

type CapturedRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
};

type EventBehavior = "manual" | "closed" | "error" | "non-marker";
type RestBehavior = "immediate" | "deferred";

type FixtureOptions = {
  readonly event?: EventBehavior;
  readonly rest?: RestBehavior;
  /** Status the history (`/message`) route answers with, for error-path tests. */
  readonly historyStatus?: number;
  /** Body the history route answers with when `historyStatus` is set. */
  readonly historyBody?: unknown;
};

type Fixture = {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: readonly CapturedRequest[];
  readonly eventRequest: Promise<CapturedRequest>;
  readonly restRequest: Promise<CapturedRequest>;
  readonly sendEvent: (event: unknown) => void;
  /** Enqueues an arbitrary chunk, for frames that carry no event (keepalives). */
  readonly sendRaw: (chunk: string) => void;
  readonly releaseRest: () => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function eventFrame(event: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const eventBehavior = options.event ?? "manual";
  const restBehavior = options.rest ?? "immediate";
  const requests: CapturedRequest[] = [];
  const eventRequest = deferred<CapturedRequest>();
  const restRequest = deferred<CapturedRequest>();
  const restRelease = deferred<void>();
  let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;

  const fetch = Object.assign(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = new Request(input, init);
      const captured: CapturedRequest = {
        url: request.url,
        method: request.method,
        headers: request.headers,
      };
      requests.push(captured);

      const url = new URL(request.url);
      if (url.pathname.endsWith("/event")) {
        eventRequest.resolve(captured);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            eventController = controller;
            if (eventBehavior === "closed") {
              controller.close();
            } else if (eventBehavior === "error") {
              controller.error(new Error("pre-marker event failure"));
            } else if (eventBehavior === "non-marker") {
              controller.enqueue(eventFrame({ type: "server.heartbeat", data: {} }));
              controller.close();
            }
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }

      restRequest.resolve(captured);
      if (restBehavior === "deferred") {
        await restRelease.promise;
      }
      if (url.pathname.endsWith("/api/info")) {
        return Response.json(SERVER_INFO);
      }
      if (url.pathname.endsWith("/message")) {
        if (options.historyStatus !== undefined) {
          return Response.json(options.historyBody ?? {}, { status: options.historyStatus });
        }
        return Response.json(EMPTY_HISTORY);
      }
      if (url.pathname.includes("/session/")) {
        return Response.json({ id: SESSION_ID });
      }
      return Response.json({}, { status: 404 });
    },
    { preconnect: globalThis.fetch.preconnect },
  );

  return {
    fetch,
    requests,
    eventRequest: eventRequest.promise,
    restRequest: restRequest.promise,
    sendEvent: (event) => {
      if (!eventController) {
        throw new Error("event stream has not started");
      }
      eventController.enqueue(eventFrame(event));
    },
    sendRaw: (chunk) => {
      if (!eventController) {
        throw new Error("event stream has not started");
      }
      eventController.enqueue(new TextEncoder().encode(chunk));
    },
    releaseRest: () => restRelease.resolve(undefined),
  };
}

function makeSignals(onActivity: () => void = () => undefined): {
  readonly connectionSignal: AbortSignal;
  readonly lifecycleSignal: AbortSignal;
  readonly onActivity: () => void;
} {
  return {
    connectionSignal: new AbortController().signal,
    lifecycleSignal: new AbortController().signal,
    onActivity,
  };
}

async function connectAfterMarker(
  client: OpenCodeV2Client,
  fixture: Fixture,
): Promise<OpenCodeV2Generation> {
  const connection = client.connect(makeSignals());
  await fixture.eventRequest;
  fixture.sendEvent(CONNECTED_EVENT);
  return await connection;
}

function restRequests(fixture: Fixture): readonly CapturedRequest[] {
  return fixture.requests.filter((request) => !new URL(request.url).pathname.endsWith("/event"));
}

function requestForPath(fixture: Fixture, pathSuffix: string): CapturedRequest | undefined {
  return fixture.requests.find((request) => new URL(request.url).pathname.endsWith(pathSuffix));
}

describe("createOpenCodeV2Client", () => {
  it("rejects a relative origin", () => {
    expect(() => createOpenCodeV2Client(SCOPE, RELATIVE_ORIGIN)).toThrow();
  });

  it("accepts a valid absolute origin", () => {
    expect(() => createOpenCodeV2Client(SCOPE, ABSOLUTE_ORIGIN)).not.toThrow();
  });

  it("exposes only connect as a method and no raw client property", () => {
    const client = createOpenCodeV2Client(SCOPE, ABSOLUTE_ORIGIN);
    const methods = Object.entries(client)
      .filter(([, value]) => typeof value === "function")
      .map(([key]) => key);

    expect(methods).toEqual(["connect"]);
    expect(client).not.toHaveProperty("client");
  });

  it("waits for server.connected before resolving connect", async () => {
    const fixture = makeFixture();
    const client = createOpenCodeV2Client(SCOPE, ABSOLUTE_ORIGIN, {
      fetch: fixture.fetch,
    });
    let settled = false;
    const connection = client.connect(makeSignals()).then((generation) => {
      settled = true;
      return generation;
    });

    await fixture.eventRequest;
    expect(settled).toBe(false);
    expect(restRequests(fixture)).toHaveLength(0);

    fixture.sendEvent(CONNECTED_EVENT);
    const generation = await connection;
    try {
      expect(settled).toBe(true);
      expect(generation.generationId).toBe(1);
    } finally {
      await generation.events.close();
    }
  });

  it("reports keepalive-only traffic as activity, so silence means bytes", async () => {
    // The 2.1.2 server, where this was measured, keeps an idle stream alive
    // with a bare SSE comment every 15 seconds. Those chunks carry no event but
    // they are the proof the connection is alive, so the client must report
    // them as activity or an idle session is indistinguishable from a dead one.
    const fixture = makeFixture();
    const client = createOpenCodeV2Client(SCOPE, ABSOLUTE_ORIGIN, {
      fetch: fixture.fetch,
    });
    let activity = 0;
    const connection = client.connect(makeSignals(() => (activity += 1)));
    await fixture.eventRequest;
    fixture.sendEvent(CONNECTED_EVENT);
    const generation = await connection;

    try {
      // Activity is reported as chunks are READ, so keep a read outstanding.
      const pending = generation.events.next();
      let readSettled = false;
      const observed = pending.then(
        () => {
          readSettled = true;
        },
        () => {
          readSettled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      const before = activity;
      fixture.sendRaw(": heartbeat\n\n");
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(activity).toBeGreaterThan(before);
      // The keepalive is not an event: the read is still waiting.
      expect(readSettled).toBe(false);

      await generation.events.close();
      // Closing the generation ends the read; the handler above absorbs the
      // close error so the test does not leak a rejection.
      await observed;
    } finally {
      await generation.events.close();
    }
  });

  it("rejects a non-marker first event before starting REST work", async () => {
    const fixture = makeFixture({ event: "non-marker" });
    const client = createOpenCodeV2Client(SCOPE, ABSOLUTE_ORIGIN, {
      fetch: fixture.fetch,
    });

    await expect(client.connect(makeSignals())).rejects.toThrow();
    expect(restRequests(fixture)).toHaveLength(0);
  });

  it("rejects an event stream failure before server.connected", async () => {
    const fixture = makeFixture({ event: "error" });
    const client = createOpenCodeV2Client(SCOPE, ABSOLUTE_ORIGIN, {
      fetch: fixture.fetch,
    });

    await expect(client.connect(makeSignals())).rejects.toThrow();
    expect(restRequests(fixture)).toHaveLength(0);
  });

  it("rejects an event stream that closes before server.connected", async () => {
    const fixture = makeFixture({ event: "closed" });
    const client = createOpenCodeV2Client(SCOPE, ABSOLUTE_ORIGIN, {
      fetch: fixture.fetch,
    });

    await expect(client.connect(makeSignals())).rejects.toThrow();
    expect(restRequests(fixture)).toHaveLength(0);
  });

  it("names the session and never a directory on both event and REST requests", async () => {
    const fixture = makeFixture();
    const client = createOpenCodeV2Client(
      { sessionId: SESSION_ID, directory: DIRECTORY },
      ABSOLUTE_ORIGIN,
      { fetch: fixture.fetch },
    );
    const generation = await connectAfterMarker(client, fixture);

    try {
      await generation.operations.serverInfo();
      const eventRequest = requestForPath(fixture, "/event");
      const restRequest = requestForPath(fixture, "/api/info");

      expect(eventRequest?.url).toBe(`${ABSOLUTE_ORIGIN}${PROXY_PATH}/api/event`);
      expect(restRequest?.url).toBe(`${ABSOLUTE_ORIGIN}${PROXY_PATH}/api/info`);
      expect(eventRequest?.headers.get(SESSION_HEADER)).toBe(SESSION_ID);
      expect(restRequest?.headers.get(SESSION_HEADER)).toBe(SESSION_ID);
      // The browser's directory is display-only. The backend resolves the
      // workspace, so the browser must not choose one.
      expect(eventRequest?.headers.get(DIRECTORY_HEADER)).toBeNull();
      expect(restRequest?.headers.get(DIRECTORY_HEADER)).toBeNull();
      expect(eventRequest?.headers.get("authorization")).toBeNull();
      expect(restRequest?.headers.get("authorization")).toBeNull();
    } finally {
      await generation.events.close();
    }
  });

  it("names the session even when the scope directory is null", async () => {
    const fixture = makeFixture();
    const client = createOpenCodeV2Client(SCOPE, ABSOLUTE_ORIGIN, {
      fetch: fixture.fetch,
    });
    const generation = await connectAfterMarker(client, fixture);

    try {
      await generation.operations.serverInfo();
      const eventRequest = requestForPath(fixture, "/event");
      const restRequest = requestForPath(fixture, "/api/info");

      expect(eventRequest?.headers.get(SESSION_HEADER)).toBe(SESSION_ID);
      expect(restRequest?.headers.get(SESSION_HEADER)).toBe(SESSION_ID);
      expect(eventRequest?.headers.get(DIRECTORY_HEADER)).toBeNull();
      expect(restRequest?.headers.get(DIRECTORY_HEADER)).toBeNull();
    } finally {
      await generation.events.close();
    }
  });

  it("rejects stale operation, history, and event-reader access after close", async () => {
    const fixture = makeFixture();
    const client = createOpenCodeV2Client(SCOPE, ABSOLUTE_ORIGIN, {
      fetch: fixture.fetch,
    });
    const generation = await connectAfterMarker(client, fixture);
    await generation.events.close();
    const requestCount = fixture.requests.length;

    await expect(generation.operations.serverInfo()).rejects.toThrow();
    await expect(generation.operations.sessionGet({ sessionID: SESSION_ID })).rejects.toThrow();
    await expect(generation.history.list({ sessionID: SESSION_ID })).rejects.toThrow();
    await expect(generation.events.next()).rejects.toThrow();
    expect(fixture.requests).toHaveLength(requestCount);
  });

  it("rejects an operation response that arrives after the generation closes", async () => {
    const fixture = makeFixture({ rest: "deferred" });
    const client = createOpenCodeV2Client(SCOPE, ABSOLUTE_ORIGIN, {
      fetch: fixture.fetch,
    });
    const generation = await connectAfterMarker(client, fixture);
    const operation = generation.operations.serverInfo();

    await fixture.restRequest;
    await generation.events.close();
    fixture.releaseRest();

    await expect(operation).rejects.toThrow();
  });

  it("rejects an operation and history request for a different session before I/O", async () => {
    const fixture = makeFixture();
    const client = createOpenCodeV2Client(SCOPE, ABSOLUTE_ORIGIN, {
      fetch: fixture.fetch,
    });
    const generation = await connectAfterMarker(client, fixture);
    const requestCount = fixture.requests.length;

    try {
      await expect(
        generation.operations.sessionGet({ sessionID: OTHER_SESSION_ID }),
      ).rejects.toThrow();
      await expect(generation.history.list({ sessionID: OTHER_SESSION_ID })).rejects.toThrow();
      expect(fixture.requests).toHaveLength(requestCount);
    } finally {
      await generation.events.close();
    }
  });

  it("exposes only the approved flat operations and no raw client", async () => {
    const fixture = makeFixture();
    const client = createOpenCodeV2Client(SCOPE, ABSOLUTE_ORIGIN, {
      fetch: fixture.fetch,
    });
    const generation = await connectAfterMarker(client, fixture);
    const operationNames = [
      "serverInfo",
      "sessionGet",
      "switchAgent",
      "switchModel",
      "prompt",
      "compact",
      "interrupt",
      "inboxList",
      "inboxCancel",
      "revertStage",
      "revertCommit",
      "revertClear",
      "formList",
      "formReply",
      "formCancel",
      "permissionList",
      "permissionReply",
    ];

    try {
      expect(Object.keys(generation).sort()).toEqual([
        "events",
        "generationId",
        "history",
        "operations",
      ]);
      expect(Object.keys(generation.operations).sort()).toEqual(operationNames.sort());
      expect(generation.operations).not.toHaveProperty("create");
      expect(generation.operations).not.toHaveProperty("fork");
      expect(generation).not.toHaveProperty("client");
      expect(generation.operations).not.toHaveProperty("client");
      expect(generation.history).not.toHaveProperty("client");
      expect(generation.events).not.toHaveProperty("client");
    } finally {
      await generation.events.close();
    }
  });

  it("loses the transport status when the client declares it", async () => {
    // PINNED AGAINST THE INSTALLED @opencode/client, not against TBAi code.
    //
    // `message.list` declares 400/401/404/500, so the client answers any of
    // them with `declared(body)` - a plain `Error` carrying the parsed body -
    // and the transport status is gone. `docs/decisions.md` (2026-10-21) uses
    // exactly this to justify why the reconnect policy has no permanent-4xx
    // shortcut: a deleted session and a transient 500 arrive indistinguishable.
    //
    // This is the drift guard for that claim. If a future client version starts
    // exposing the status, it fails, and the shortcut can be reinstated with
    // evidence instead of a guess.
    const fixture = makeFixture({
      historyStatus: 404,
      historyBody: { message: "session not found" },
    });
    const client = createOpenCodeV2Client(SCOPE, ABSOLUTE_ORIGIN, {
      fetch: fixture.fetch,
    });
    const generation = await connectAfterMarker(client, fixture);

    try {
      let thrown: unknown;
      try {
        await generation.history.list({ sessionID: SESSION_ID });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const failure = thrown as { message?: unknown; status?: unknown };
      expect(failure.message).toBe("session not found");
      expect(failure.status).toBeUndefined();
    } finally {
      await generation.events.close();
    }
  });

  it("aborts inbox/history HTTP requests via extra per-request signal and generation connection signal", async () => {
    const requests: Array<{ url: string; signal: AbortSignal }> = [];
    const pending: Array<{
      resolve: () => void;
      reject: (e: unknown) => void;
      signal: AbortSignal;
    }> = [];
    let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetch = Object.assign(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname.endsWith("/event")) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              eventController = controller;
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        requests.push({ url: request.url, signal: request.signal });
        return await new Promise<Response>((resolve, reject) => {
          const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
          request.signal.addEventListener("abort", onAbort, { once: true });
          pending.push({
            resolve: () => {
              request.signal.removeEventListener("abort", onAbort);
              if (url.pathname.endsWith("/message")) resolve(Response.json(EMPTY_HISTORY));
              else if (url.pathname.includes("/inbox")) resolve(Response.json([]));
              else if (url.pathname.endsWith("/api/info")) resolve(Response.json(SERVER_INFO));
              else resolve(Response.json({}));
            },
            reject: (e) => {
              request.signal.removeEventListener("abort", onAbort);
              reject(e);
            },
            signal: request.signal,
          });
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const client = createOpenCodeV2Client(SCOPE, ABSOLUTE_ORIGIN, { fetch });
    const connectionController = new AbortController();
    const connection = client.connect({
      connectionSignal: connectionController.signal,
      lifecycleSignal: new AbortController().signal,
      onActivity: () => undefined,
    });
    await new Promise((r) => setTimeout(r, 0));
    eventController?.enqueue(eventFrame(CONNECTED_EVENT));
    const generation = await connection;

    try {
      const extra = new AbortController();
      const inboxPromise = generation.operations.inboxList(
        { sessionID: SESSION_ID },
        { signal: extra.signal },
      );
      await new Promise((r) => setTimeout(r, 0));
      const inboxReq = requests.find((r) => r.url.includes("/inbox"));
      expect(inboxReq).toBeDefined();
      extra.abort();
      await expect(inboxPromise).rejects.toThrow();

      const historyPromise = generation.history.list({ sessionID: SESSION_ID });
      await new Promise((r) => setTimeout(r, 0));
      const historyReq = requests.find(
        (r) => r.url.endsWith("/message") || r.url.includes("/message?"),
      );
      expect(historyReq).toBeDefined();
      connectionController.abort();
      await expect(historyPromise).rejects.toThrow();
    } finally {
      for (const p of pending) p.resolve();
      await generation.events.close().catch(() => undefined);
    }
  });

  it("handles already-aborted and near-simultaneous abort signals without leaking listeners", async () => {
    const requests: Array<{ url: string; signal: AbortSignal }> = [];
    let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetch = Object.assign(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname.endsWith("/event")) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              eventController = controller;
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        requests.push({ url: request.url, signal: request.signal });
        if (request.signal.aborted) throw new DOMException("Aborted", "AbortError");
        return await new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const client = createOpenCodeV2Client(SCOPE, ABSOLUTE_ORIGIN, { fetch });
    const connectionController = new AbortController();
    const connection = client.connect({
      connectionSignal: connectionController.signal,
      lifecycleSignal: new AbortController().signal,
      onActivity: () => undefined,
    });
    await new Promise((r) => setTimeout(r, 0));
    eventController?.enqueue(eventFrame(CONNECTED_EVENT));
    const generation = await connection;

    try {
      const aborted = new AbortController();
      aborted.abort();
      await expect(
        generation.operations.inboxList({ sessionID: SESSION_ID }, { signal: aborted.signal }),
      ).rejects.toThrow();

      const extra = new AbortController();
      const p = generation.history.list({ sessionID: SESSION_ID }, { signal: extra.signal });
      await new Promise((r) => setTimeout(r, 0));
      extra.abort();
      connectionController.abort();
      await expect(p).rejects.toThrow();

      // Successful completion removes listeners from extra/connection signals.
      const extra2 = new AbortController();
      const conn2 = new AbortController();
      let adds = 0;
      let removes = 0;
      const origAdd = extra2.signal.addEventListener.bind(extra2.signal);
      const origRemove = extra2.signal.removeEventListener.bind(extra2.signal);
      (extra2.signal as any).addEventListener = (type: string, listener: any, options?: any) => {
        if (type === "abort") adds += 1;
        return origAdd(type, listener, options);
      };
      (extra2.signal as any).removeEventListener = (type: string, listener: any, options?: any) => {
        if (type === "abort") removes += 1;
        return origRemove(type, listener, options);
      };

      // New generation/client for clean success path
      let eventController2: ReadableStreamDefaultController<Uint8Array> | undefined;
      const fetch2 = Object.assign(
        async (input: URL | RequestInfo, init?: RequestInit) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (url.pathname.endsWith("/event")) {
            const stream = new ReadableStream<Uint8Array>({
              start(c) {
                eventController2 = c;
              },
            });
            return new Response(stream, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            });
          }
          if (url.pathname.includes("/inbox")) return Response.json([]);
          if (url.pathname.endsWith("/message") || url.pathname.includes("/message?"))
            return Response.json(EMPTY_HISTORY);
          if (url.pathname.endsWith("/api/info")) return Response.json(SERVER_INFO);
          return Response.json({});
        },
        { preconnect: globalThis.fetch.preconnect },
      );
      const client2 = createOpenCodeV2Client(SCOPE, ABSOLUTE_ORIGIN, { fetch: fetch2 });
      const gen2 = await (async () => {
        const c = client2.connect({
          connectionSignal: conn2.signal,
          lifecycleSignal: new AbortController().signal,
          onActivity: () => undefined,
        });
        await new Promise((r) => setTimeout(r, 0));
        eventController2?.enqueue(eventFrame(CONNECTED_EVENT));
        return await c;
      })();
      await gen2.operations.inboxList({ sessionID: SESSION_ID }, { signal: extra2.signal });
      await gen2.history.list({ sessionID: SESSION_ID }, { signal: extra2.signal });
      expect(adds).toBeGreaterThan(0);
      expect(removes).toBe(adds);
      await gen2.events.close();
    } finally {
      await generation.events.close().catch(() => undefined);
    }
  });

  it("preserves session-scope and generation-ownership protections for inbox/history with extra signals", async () => {
    const fixture = makeFixture();
    const client = createOpenCodeV2Client(SCOPE, ABSOLUTE_ORIGIN, { fetch: fixture.fetch });
    const generation = await connectAfterMarker(client, fixture);
    const requestCount = fixture.requests.length;
    const extra = new AbortController();

    try {
      await expect(
        generation.operations.inboxList({ sessionID: OTHER_SESSION_ID } as any, {
          signal: extra.signal,
        }),
      ).rejects.toThrow();
      await expect(
        generation.history.list({ sessionID: OTHER_SESSION_ID }, { signal: extra.signal }),
      ).rejects.toThrow();
      expect(fixture.requests).toHaveLength(requestCount);

      await generation.events.close();
      await expect(
        generation.operations.inboxList(
          { sessionID: SESSION_ID },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow();
      await expect(
        generation.history.list(
          { sessionID: SESSION_ID },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow();
    } finally {
      await generation.events.close().catch(() => undefined);
    }
  });
});
