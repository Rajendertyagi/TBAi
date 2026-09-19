import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  OpenCodeEventSource,
  OpenCodeThreadController,
} from "@assistant-ui/react-opencode";
import { createOpenCodeRuntimeClient } from "./runtimeClient";
import type { OpenCodeRuntimeClient } from "./eventScope";
import { setAutoPolicy, clearAllAutoPolicies } from "./sessionAutoPolicy";

/**
 * Hydration/reconnect auto-approval.
 *
 * A pending permission that predates the page mount is replayed by initial
 * hydration. When the session's Auto shield is on, hydration must answer it
 * "once" through the patched replyCompat BEFORE replaying the frame; when off,
 * it must replay normally (manual). The policy is session-keyed, so a reconnect
 * for the same session re-hydrates with the same policy.
 */

const BASE_URL = "http://127.0.0.1:1/api/opencode";
const DIRECTORY = "D:\\Temp\\ai-chat-app\\workspace\\chats\\conv-hydrate";
const SESSION_ID = "ses_hydrate0000000000000000001";

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

function makeServer() {
  const calls: RecordedCall[] = [];
  const scopedSinks: Array<(chunk: string) => void> = [];
  const pending: Record<string, unknown> = {};

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
      if (directory !== DIRECTORY) return new Response(null, { status: 404 });
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
        patterns: ["echo HYD"],
        metadata: { command: "echo HYD" },
        always: [],
      };
    },
    scopedCount: () => scopedSinks.length,
    install() {
      globalThis.fetch = impl as unknown as typeof globalThis.fetch;
    },
    replyCalls: () => calls.filter((c) => /\/permission\/[^/]+\/reply$/.test(c.path)),
    listCalls: () =>
      calls.filter((c) => c.path.endsWith("/permission") && c.method === "GET"),
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

describe("hydration — Auto ON", () => {
  it("answers a pending permission 'once' through the scoped replyCompat", async () => {
    setAutoPolicy(SESSION_ID, true);
    const server = makeServer();
    server.seed("per_hyd_1");
    server.install();
    const conn = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    try {
      expect(await until(() => server.replyCalls().length > 0)).toBe(true);
      const reply = server.replyCalls()[0];
      expect(reply.path).toBe(`/api/opencode/permission/per_hyd_1/reply`);
      expect(reply.directory).toBe(DIRECTORY);
      expect(reply.body).toEqual({ reply: "once" });
    } finally {
      conn.dispose();
    }
  });

  it("a reconnect for the same session re-hydrates with the same policy", async () => {
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
    } finally {
      connB.dispose();
    }
  });
});

describe("hydration — Auto OFF", () => {
  it("replays the pending permission normally with no reply", async () => {
    const server = makeServer();
    server.seed("per_manual");
    server.install();
    const conn = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    try {
      expect(
        await until(
          () => conn.controller.getState().interactions.permissions.pending["per_manual"] != null,
        ),
      ).toBe(true);
      expect(server.replyCalls()).toEqual([]);
    } finally {
      conn.dispose();
    }
  });
});

describe("hydration — missing session id", () => {
  it("never auto-replies without a session id (fail closed)", async () => {
    const server = makeServer();
    server.seed("per_nosession");
    server.install();
    const conn = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: undefined }),
      SESSION_ID,
    );
    try {
      // No directory scope either (the patch is skipped), so the list is empty
      // and nothing is hydrated or replied.
      expect(await until(() => server.calls.some((c) => c.path.endsWith("/event")))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(server.replyCalls()).toEqual([]);
    } finally {
      conn.dispose();
    }
  });
});