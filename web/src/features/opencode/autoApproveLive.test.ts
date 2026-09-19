import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  OpenCodeEventSource,
  OpenCodeThreadController,
} from "@assistant-ui/react-opencode";
import { createOpenCodeRuntimeClient } from "./runtimeClient";
import type { OpenCodeRuntimeClient } from "./eventScope";
import { setAutoPolicy, getAutoPolicy, clearAllAutoPolicies } from "./sessionAutoPolicy";

/**
 * Live `permission.asked` auto-approval.
 *
 * The Auto shield must cover a NEW permission while connected, not just requests
 * already pending at hydration. These tests drive the real library chain (the
 * app's client wrapper + the library's own event source and thread controller)
 * against a fake OpenCode server.
 *
 * The decision is made at event time from the session-keyed policy cache, the
 * reply goes through the already-patched `replyCompat` (directory-scoped), and
 * the shared per-runtime `answered` set dedupes against hydration.
 * Reply-before-yield is pinned deterministically by BLOCKING the reply with a
 * deferred promise and proving the event is not yielded until it completes — no
 * sleeps, no arbitrary timeouts.
 */

const BASE_URL = "http://127.0.0.1:1/api/opencode";
const DIRECTORY = "D:\\Temp\\ai-chat-app\\workspace\\chats\\conv-live";
const SESSION_ID = "ses_live0000000000000000000001";
const PERMISSION_ID = "per_live_1";

const realFetch = globalThis.fetch;

beforeEach(() => {
  clearAllAutoPolicies();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearAllAutoPolicies();
});

type RecordedCall = { method: string; path: string; directory: string | null; body: unknown };

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function permissionAskedEvent(id: string) {
  return {
    type: "permission.asked",
    properties: {
      id,
      sessionID: SESSION_ID,
      permission: "bash",
      patterns: ["echo LIVE"],
      metadata: { command: "echo LIVE" },
      always: [],
    },
  };
}

function makeServer() {
  const calls: RecordedCall[] = [];
  const scopedSinks: Array<(chunk: string) => void> = [];
  const pending: Record<string, unknown> = {};
  let replyStatus: number | null = null;
  let gate: Promise<void> | null = null;
  let releaseGate: (() => void) | null = null;

  const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), {
      status,
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
    const method = input instanceof Request ? input.method : "GET";
    const url = new URL(href);
    const path = url.pathname;
    const directory = url.searchParams.get("directory");
    const body =
      input instanceof Request
        ? await input
            .clone()
            .text()
            .then((text) => (text ? JSON.parse(text) : undefined))
            .catch(() => undefined)
        : undefined;
    const record = () => calls.push({ method, path, directory, body });

    if (path.endsWith("/event")) {
      record();
      const scoped = directory !== null;
      return sse((send) => {
        if (scoped) scopedSinks.push(send);
        send(frame({ type: "server.connected", properties: {} }));
      });
    }

    if (/\/permission\/[^/]+\/reply$/.test(path)) {
      record();
      if (replyStatus !== null) return new Response(null, { status: replyStatus });
      if (directory !== DIRECTORY) return new Response(null, { status: 404 });
      if (gate) await gate;
      const id = path.match(/\/permission\/([^/]+)\/reply$/)?.[1];
      if (id) delete pending[id];
      return json(true);
    }

    if (path.endsWith("/permission")) {
      record();
      return json(directory === DIRECTORY ? Object.values(pending) : []);
    }

    if (path.endsWith("/question")) {
      record();
      return json([]);
    }
    if (path.includes("/todo")) {
      record();
      return json([]);
    }
    if (/\/session\/[^/]+\/message$/.test(path)) {
      record();
      return json([]);
    }
    if (/\/session\/[^/]+$/.test(path)) {
      record();
      return json({ id: SESSION_ID, directory: DIRECTORY });
    }

    return json({}, 404);
  };

  return {
    calls,
    seed(id: string) {
      pending[id] = {
        id,
        sessionID: SESSION_ID,
        permission: "bash",
        patterns: ["echo LIVE"],
        metadata: { command: "echo LIVE" },
        always: [],
      };
    },
    failReply(status: number) {
      replyStatus = status;
    },
    blockReply() {
      gate = new Promise((resolve) => {
        releaseGate = resolve;
      });
    },
    releaseReply() {
      releaseGate?.();
      releaseGate = null;
    },
    scopedCount: () => scopedSinks.length,
    emit(payload: unknown) {
      const chunk = frame(payload);
      for (const send of scopedSinks) {
        try {
          send(chunk);
        } catch {
          // A disposed predecessor's stream is closed; skip it.
        }
      }
      // Mirror the server's pending store: a `permission.asked` event reflects
      // a request the server holds, so a later list call must return it.
      const outer = payload as {
        type?: unknown;
        properties?: { id?: unknown };
        payload?: { type?: unknown; properties?: { id?: unknown } };
      };
      const record = outer.payload ?? outer;
      if (record?.type === "permission.asked" && typeof record.properties?.id === "string") {
        pending[record.properties.id] = {
          id: record.properties.id,
          sessionID: SESSION_ID,
          permission: "bash",
          patterns: ["echo LIVE"],
          metadata: { command: "echo LIVE" },
          always: [],
        };
      }
    },
    install() {
      globalThis.fetch = impl as unknown as typeof globalThis.fetch;
    },
    replyCalls: () => calls.filter((c) => /\/permission\/[^/]+\/reply$/.test(c.path)),
  };
}

async function until(check: () => boolean, budgetMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

function connect(client: OpenCodeRuntimeClient, sessionId: string) {
  const source = new OpenCodeEventSource(client);
  const controller = new OpenCodeThreadController(client, () => source, sessionId);
  const unsubscribe = controller.subscribe(() => {});
  return {
    controller,
    dispose() {
      unsubscribe();
      source.dispose();
    },
  };
}

const pendingOf = (conn: ReturnType<typeof connect>, id: string) =>
  conn.controller.getState().interactions.permissions.pending[id];

describe("live permission.asked — Auto OFF", () => {
  it("flows to the manual UI with no reply", async () => {
    const server = makeServer();
    server.install();
    const conn = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    try {
      expect(await until(() => server.scopedCount() > 0)).toBe(true);
      server.emit(permissionAskedEvent(PERMISSION_ID));
      expect(await until(() => pendingOf(conn, PERMISSION_ID) != null)).toBe(true);
      expect(server.replyCalls()).toEqual([]);
    } finally {
      conn.dispose();
    }
  });
});

describe("live permission.asked — Auto ON", () => {
  it("replies 'once' through the patched replyCompat (directory-scoped)", async () => {
    setAutoPolicy(SESSION_ID, true);
    const server = makeServer();
    server.install();
    const conn = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    try {
      expect(await until(() => server.scopedCount() > 0)).toBe(true);
      server.emit(permissionAskedEvent(PERMISSION_ID));

      expect(await until(() => server.replyCalls().length > 0)).toBe(true);
      const reply = server.replyCalls()[0];
      expect(reply.path).toBe(`/api/opencode/permission/${PERMISSION_ID}/reply`);
      expect(reply.directory).toBe(DIRECTORY);
      expect(reply.body).toEqual({ reply: "once" });

      // The event still continued through the normal pipeline.
      expect(await until(() => pendingOf(conn, PERMISSION_ID) != null)).toBe(true);
    } finally {
      conn.dispose();
    }
  });

  it("replies BEFORE the event is yielded (deterministic, blocked reply)", async () => {
    setAutoPolicy(SESSION_ID, true);
    const server = makeServer();
    server.install();
    const conn = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    try {
      expect(await until(() => server.scopedCount() > 0)).toBe(true);
      server.blockReply();
      server.emit(permissionAskedEvent(PERMISSION_ID));

      // The reply request is in-flight and blocked.
      expect(await until(() => server.replyCalls().length > 0)).toBe(true);
      // The frame has NOT been yielded yet — the controller cannot have it.
      expect(pendingOf(conn, PERMISSION_ID)).toBeUndefined();

      // Only once the reply completes does the frame flow through.
      server.releaseReply();
      expect(await until(() => pendingOf(conn, PERMISSION_ID) != null)).toBe(true);
    } finally {
      conn.dispose();
    }
  });

  it("a failed auto reply still yields the event (manual handling remains)", async () => {
    setAutoPolicy(SESSION_ID, true);
    const server = makeServer();
    server.failReply(500);
    server.install();
    const conn = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    try {
      expect(await until(() => server.scopedCount() > 0)).toBe(true);
      server.emit(permissionAskedEvent(PERMISSION_ID));

      expect(await until(() => server.replyCalls().length > 0)).toBe(true);
      // The failed reply did not suppress the event.
      expect(await until(() => pendingOf(conn, PERMISSION_ID) != null)).toBe(true);
    } finally {
      conn.dispose();
    }
  });

  it("the same permission is not answered twice (live dedupe)", async () => {
    setAutoPolicy(SESSION_ID, true);
    const server = makeServer();
    server.install();
    const conn = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    try {
      expect(await until(() => server.scopedCount() > 0)).toBe(true);
      server.emit(permissionAskedEvent(PERMISSION_ID));
      expect(await until(() => server.replyCalls().length > 0)).toBe(true);

      // A duplicate frame for the same request id.
      server.emit(permissionAskedEvent(PERMISSION_ID));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(server.replyCalls().length).toBe(1);
    } finally {
      conn.dispose();
    }
  });

  it("Auto turning ON affects the NEXT permission, not an earlier manual one", async () => {
    const server = makeServer();
    server.install();
    const conn = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    try {
      expect(await until(() => server.scopedCount() > 0)).toBe(true);
      // Auto OFF: the first request lands in the manual UI.
      server.emit(permissionAskedEvent("per_off"));
      expect(await until(() => pendingOf(conn, "per_off") != null)).toBe(true);
      expect(server.replyCalls()).toEqual([]);

      // Auto turns ON before the next event reaches the reply decision.
      setAutoPolicy(SESSION_ID, true);
      server.emit(permissionAskedEvent("per_on"));
      expect(await until(() => server.replyCalls().length > 0)).toBe(true);
      expect(server.replyCalls()[0]?.body).toEqual({ reply: "once" });
      // The earlier manual request was not retroactively answered.
      expect(server.replyCalls().length).toBe(1);
    } finally {
      conn.dispose();
    }
  });
});

describe("hydration + live path share one answered set", () => {
  it("a request auto-answered at hydration is not answered again live", async () => {
    setAutoPolicy(SESSION_ID, true);
    const server = makeServer();
    server.seed(PERMISSION_ID);
    server.install();
    const conn = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    try {
      // Hydration auto-answers the seeded pending permission.
      expect(await until(() => server.replyCalls().length > 0)).toBe(true);
      expect(server.replyCalls().length).toBe(1);

      // A live permission.asked for the SAME id arrives — the shared set skips it.
      server.emit(permissionAskedEvent(PERMISSION_ID));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(server.replyCalls().length).toBe(1);
    } finally {
      conn.dispose();
    }
  });
});

describe("reconnect / hydration restores the policy", () => {
  it("a fresh client for the same session re-hydrates with the same policy", async () => {
    setAutoPolicy(SESSION_ID, true);
    const server = makeServer();
    server.seed("per_first");
    server.install();

    const connA = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    try {
      expect(await until(() => server.replyCalls().length > 0)).toBe(true);
      expect(server.replyCalls()[0]?.body).toEqual({ reply: "once" });
    } finally {
      connA.dispose();
    }

    // A NEW pending permission appears; a fresh client for the SAME session
    // re-hydrates and — because the policy is session-keyed — auto-answers it.
    server.seed("per_second");
    const connB = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    try {
      expect(await until(() => server.replyCalls().length > 1)).toBe(true);
      expect(server.replyCalls()[1]?.body).toEqual({ reply: "once" });
      expect(getAutoPolicy(SESSION_ID)).toBe(true);
    } finally {
      connB.dispose();
    }
  });
});

describe("missing session id", () => {
  it("never auto-replies without a session id (fail closed)", async () => {
    const server = makeServer();
    server.install();
    const conn = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: undefined }),
      SESSION_ID,
    );
    try {
      expect(await until(() => server.scopedCount() > 0)).toBe(true);
      server.emit(permissionAskedEvent(PERMISSION_ID));
      expect(await until(() => pendingOf(conn, PERMISSION_ID) != null)).toBe(true);
      expect(server.replyCalls()).toEqual([]);
    } finally {
      conn.dispose();
    }
  });
});