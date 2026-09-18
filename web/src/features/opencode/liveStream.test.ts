import { describe, it, expect, afterEach } from "bun:test";
import {
  OpenCodeEventSource,
  OpenCodeThreadController,
  projectOpenCodeThreadMessages,
} from "@assistant-ui/react-opencode";
import { createScopedOpenCodeClient } from "./eventScope";

/**
 * Regression test for the "AI reply is not visible until you refresh" bug.
 *
 * The failure was not in the runtime's event handling or in React rendering: it
 * was in the **scope** of the event subscription. OpenCode keys its event
 * stream on a directory, so an unscoped `GET /event` answers with a stub that
 * carries only `server.connected` + heartbeats. The runtime subscribes unscoped
 * (`client.event.subscribe(undefined, …)`), received no session events at all,
 * and therefore never learned a reply was streaming — the assistant bubble sat
 * on a running timer and the finished reply only appeared after a history
 * reload. Because the stub stream never drops, the runtime's own
 * reconnect-and-reload path never fired either, so it could not self-heal.
 *
 * These tests drive the **real** library chain — the same client wrapper the
 * app builds, the library's own `OpenCodeEventSource` and
 * `OpenCodeThreadController`, and the library's own projection — against a fake
 * server that reproduces the stub/scoped split measured on the real one. So
 * "the reply becomes visible" here means: a streamed server event reached the
 * controller and the thread state now projects that assistant text, with **no
 * history load, no remount and no reload**.
 *
 * The first test fails on the pre-fix code (the client sent an unscoped
 * `/event`, the fake withheld the session events, and the text never appeared).
 * The second test pins down *why*: it asserts the fixture really does withhold
 * session events from an unscoped subscriber, so a future change to the fixture
 * cannot silently turn the first test into a tautology.
 */

const BASE_URL = "http://127.0.0.1:1/api/opencode";
const DIRECTORY = "D:\\Temp\\ai-chat-app\\workspace\\chats\\conv-live";
const SESSION_ID = "ses_live0000000000000000000000";
const ASSISTANT_MESSAGE_ID = "msg_asst_live";
const TEXT_PART_ID = "prt_text_live";
/** Stands in for the model's answer text; the assertion target. */
const MARKER = "LIVE_STREAM_MARKER_7c41";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Encodes one SSE frame in the V1 `{type, properties}` envelope. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

type Server = ReturnType<typeof makeServer>;

/**
 * Fake OpenCode server that reproduces the measured behaviour of the real one:
 * `/event` yields session events **only** when a `directory` scope is present,
 * and yields the connection stub otherwise. Session history endpoints are
 * counted so a test can prove no history reload happened.
 */
function makeServer() {
  const eventRequests: string[] = [];
  const sessionGets: string[] = [];
  const messageGets: string[] = [];
  const scopedSinks: Array<(chunk: string) => void> = [];
  const unscopedSinks: Array<(chunk: string) => void> = [];

  const json = (data: unknown): Response =>
    new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const sse = (register: (send: (chunk: string) => void) => void): Response => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        register((chunk) => controller.enqueue(encoder.encode(chunk)));
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const impl = async (input: unknown): Promise<Response> => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String((input as Request).url);
    const url = new URL(href);
    const path = `${url.pathname}${url.search}`;

    if (url.pathname.endsWith("/event")) {
      eventRequests.push(path);
      const scoped = url.searchParams.get("directory") !== null;
      return sse((send) => {
        (scoped ? scopedSinks : unscopedSinks).push(send);
        // Both connections open with the same greeting the real server sends.
        send(frame({ type: "server.connected", properties: {} }));
      });
    }
    if (url.pathname.includes("/message")) {
      messageGets.push(path);
      return json([]);
    }
    if (url.pathname.includes("/session/")) {
      sessionGets.push(path);
      return json({ id: SESSION_ID });
    }
    return json(null);
  };

  return {
    eventRequests,
    sessionGets,
    messageGets,
    scopedCount: () => scopedSinks.length,
    unscopedCount: () => unscopedSinks.length,
    /**
     * Pushes a session event to the **scoped** subscribers only. This is the
     * behaviour under test: the real server delivers session events to a
     * directory-scoped `/event` subscriber and withholds them from an unscoped
     * one, which is why an unscoped subscription sees a reply only after a
     * history reload.
     */
    emit(payload: unknown) {
      const chunk = frame(payload);
      for (const send of scopedSinks) send(chunk);
    },
    install() {
      globalThis.fetch = impl as unknown as typeof globalThis.fetch;
    },
    /** Total history fetches (session record + message list). */
    historyLoads: () => sessionGets.length + messageGets.length,
  };
}

/** The assistant text the thread state currently projects. */
function projected(state: unknown): string {
  return JSON.stringify(
    projectOpenCodeThreadMessages(
      state as Parameters<typeof projectOpenCodeThreadMessages>[0],
    ),
  );
}

/** Polls until `check` passes or the budget runs out. */
async function until(check: () => boolean, budgetMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

/**
 * Wires the app's client wrapper to the library's real event source and
 * controller, exactly as `useOpenCodeRuntime` does internally (one registry,
 * one event source, one controller, one subscription).
 */
function connect(directory: string | null) {
  const client = createScopedOpenCodeClient(BASE_URL, directory);
  const source = new OpenCodeEventSource(client);
  const controller = new OpenCodeThreadController(client, () => source, SESSION_ID);
  const unsubscribe = controller.subscribe(() => {});
  return {
    controller,
    client,
    dispose() {
      unsubscribe();
      source.dispose();
    },
  };
}

/** The two events the real server sends while an assistant reply streams. */
function emitStreamingReply(server: Server): void {
  const now = Date.now();
  server.emit({
    type: "message.updated",
    properties: {
      sessionID: SESSION_ID,
      info: {
        id: ASSISTANT_MESSAGE_ID,
        sessionID: SESSION_ID,
        role: "assistant",
        parentID: "msg_user_live",
        modelID: "test-model",
        providerID: "test-provider",
        mode: "build",
        agent: "build",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now },
      },
    },
  });
  server.emit({
    type: "message.part.updated",
    properties: {
      sessionID: SESSION_ID,
      part: {
        id: TEXT_PART_ID,
        sessionID: SESSION_ID,
        messageID: ASSISTANT_MESSAGE_ID,
        type: "text",
        text: MARKER,
        time: { start: now, end: now },
      },
    },
  });
}

describe("live streaming — the reply must arrive without a refresh", () => {
  it("scopes the event subscription, applies streamed events, and needs no history reload", async () => {
    const server = makeServer();
    server.install();
    const conn = connect(DIRECTORY);
    try {
      // The subscription must carry the session's directory. This is the exact
      // failing boundary: an unscoped request reaches OpenCode's stub.
      expect(await until(() => server.scopedCount() > 0)).toBe(true);
      const eventUrl = new URL(server.eventRequests[0]!, BASE_URL);
      expect(eventUrl.pathname.endsWith("/event")).toBe(true);
      expect(eventUrl.searchParams.get("directory")).toBe(DIRECTORY);
      expect(server.unscopedCount()).toBe(0);

      // Nothing is visible before the server streams the reply.
      expect(projected(conn.controller.getState())).not.toContain(MARKER);

      emitStreamingReply(server);

      // The streamed reply reaches thread state and becomes visible — with no
      // refresh, no remount and no second history load.
      expect(await until(() => projected(conn.controller.getState()).includes(MARKER))).toBe(
        true,
      );
      expect(projected(conn.controller.getState())).toContain("assistant");
      expect(server.historyLoads()).toBe(0);
    } finally {
      conn.dispose();
    }
  });

  it("an unscoped subscription really is starved of session events (why the fix is the scope)", async () => {
    const server = makeServer();
    server.install();
    const conn = connect(null);
    try {
      expect(await until(() => server.unscopedCount() > 0)).toBe(true);
      // Unscoped: no directory on the request, and the fake — like the real
      // server — withholds every session event from it.
      const eventUrl = new URL(server.eventRequests[0]!, BASE_URL);
      expect(eventUrl.searchParams.get("directory")).toBeNull();
      expect(server.scopedCount()).toBe(0);

      emitStreamingReply(server);

      // Bounded wait: the reply never arrives. This is the reported bug.
      const appeared = await until(
        () => projected(conn.controller.getState()).includes(MARKER),
        400,
      );
      expect(appeared).toBe(false);
    } finally {
      conn.dispose();
    }
  });

  it("scopes only the event stream — history and session requests are untouched", async () => {
    const server = makeServer();
    server.install();
    const client = createScopedOpenCodeClient(BASE_URL, DIRECTORY);
    try {
      await client.session.get({ sessionID: SESSION_ID });
      await client.session.messages({ sessionID: SESSION_ID });

      expect(server.sessionGets.length).toBe(1);
      expect(server.messageGets.length).toBe(1);
      // Widening the scope to every request would also rewrite history and
      // permission calls against a server that does not expect it. It must not.
      for (const path of [...server.sessionGets, ...server.messageGets]) {
        expect(new URL(path, BASE_URL).searchParams.get("directory")).toBeNull();
        expect(new URL(path, BASE_URL).searchParams.get("location[directory]")).toBeNull();
      }
    } finally {
      server.install(); // no-op, keeps the shape symmetrical with other tests
    }
  });
});
