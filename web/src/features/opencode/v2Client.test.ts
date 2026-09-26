import { describe, expect, it } from "bun:test";
import {
  createOpenCodeV2Client,
  type OpenCodeV2Client,
  type OpenCodeV2Generation,
} from "./v2Client";

const SESSION_ID = "ses_v2_client_test";
const OTHER_SESSION_ID = "ses_v2_client_other";
const DIRECTORY = "D:\\workspace\\project one%20";
const ABSOLUTE_ORIGIN = "https://app.example";
const RELATIVE_ORIGIN = "/relative-origin";
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
};

type Fixture = {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: readonly CapturedRequest[];
  readonly eventRequest: Promise<CapturedRequest>;
  readonly restRequest: Promise<CapturedRequest>;
  readonly sendEvent: (event: unknown) => void;
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
    releaseRest: () => restRelease.resolve(undefined),
  };
}

function makeSignals(): {
  readonly connectionSignal: AbortSignal;
  readonly lifecycleSignal: AbortSignal;
} {
  return {
    connectionSignal: new AbortController().signal,
    lifecycleSignal: new AbortController().signal,
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

function requestForPath(
  fixture: Fixture,
  pathSuffix: string,
): CapturedRequest | undefined {
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

  it("adds the encoded directory header to both event and REST requests", async () => {
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
      const encodedDirectory = encodeURIComponent(DIRECTORY);

      expect(eventRequest?.url).toBe(`${ABSOLUTE_ORIGIN}${PROXY_PATH}/api/event`);
      expect(restRequest?.url).toBe(`${ABSOLUTE_ORIGIN}${PROXY_PATH}/api/info`);
      expect(eventRequest?.headers.get(DIRECTORY_HEADER)).toBe(encodedDirectory);
      expect(restRequest?.headers.get(DIRECTORY_HEADER)).toBe(encodedDirectory);
      expect(eventRequest?.headers.get("authorization")).toBeNull();
      expect(restRequest?.headers.get("authorization")).toBeNull();
    } finally {
      await generation.events.close();
    }
  });

  it("omits the directory header for a null scope directory", async () => {
    const fixture = makeFixture();
    const client = createOpenCodeV2Client(SCOPE, ABSOLUTE_ORIGIN, {
      fetch: fixture.fetch,
    });
    const generation = await connectAfterMarker(client, fixture);

    try {
      await generation.operations.serverInfo();
      const eventRequest = requestForPath(fixture, "/event");
      const restRequest = requestForPath(fixture, "/api/info");

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
    await expect(
      generation.operations.sessionGet({ sessionID: SESSION_ID }),
    ).rejects.toThrow();
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
});
