import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  OpenCodeEventSource,
  OpenCodeThreadController,
} from "@assistant-ui/react-opencode";
import { createOpenCodeRuntimeClient } from "./runtimeClient";
import type { OpenCodeRuntimeClient } from "./eventScope";
import { persistAutoApprove } from "./autoApproveWrite";
import { getAutoPolicy, clearAllAutoPolicies } from "./sessionAutoPolicy";

/**
 * The Auto shield's single write path and the immediate OFF→ON reconciliation.
 *
 * `persistAutoApprove` is ONE application-level operation: persist the setting
 * through the existing conversation PATCH, update the runtime policy cache
 * synchronously, and — when enabling — reconcile any already-pending permission
 * through the existing responder. The UI never calls permission APIs directly.
 */

const BASE_URL = "http://127.0.0.1:1/api/opencode";
const DIRECTORY = "D:\\Temp\\ai-chat-app\\workspace\\chats\\conv-write";
const SESSION_ID = "ses_write0000000000000000000001";
const PERMISSION_ID = "per_write_1";

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
        patterns: ["echo WRITE"],
        metadata: { command: "echo WRITE" },
        always: [],
      };
    },
    scopedCount: () => scopedSinks.length,
    emit(payload: unknown) {
      const chunk = frame(payload);
      for (const send of scopedSinks) {
        try {
          send(chunk);
        } catch {
          // disposed predecessor
        }
      }
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
          patterns: ["echo WRITE"],
          metadata: { command: "echo WRITE" },
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

describe("persistAutoApprove — the write operation", () => {
  it("persists, then updates the cache immediately (no reload needed)", async () => {
    const patched: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      patched.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as typeof fetch;

    await persistAutoApprove("conv_1", SESSION_ID, true);

    expect(getAutoPolicy(SESSION_ID)).toBe(true);
    expect(patched).toEqual([
      { url: "/api/conversations/conv_1", body: { opencodeAutoApprove: true } },
    ]);
  });

  it("turning Auto OFF updates the cache to false", async () => {
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as typeof fetch;

    await persistAutoApprove("conv_1", SESSION_ID, false);
    expect(getAutoPolicy(SESSION_ID)).toBe(false);
  });

  it("a failed PATCH throws and leaves the cache unchanged", async () => {
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    }) as typeof fetch;

    let thrown: unknown;
    try {
      await persistAutoApprove("conv_1", SESSION_ID, true);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(getAutoPolicy(SESSION_ID)).toBe(false);
  });

  it("enabling calls the reconcile seam; disabling does not", async () => {
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as typeof fetch;

    const reconciles: boolean[] = [];
    await persistAutoApprove("conv_1", SESSION_ID, true, async () => {
      reconciles.push(true);
      return 1;
    });
    await persistAutoApprove("conv_1", SESSION_ID, false, async () => {
      reconciles.push(true);
      return 1;
    });

    expect(reconciles).toEqual([true]);
  });
});

describe("OFF → ON immediate reconciliation", () => {
  it("reconciles an already-pending permission without another permission.asked", async () => {
    const server = makeServer();
    server.install();
    const client = createOpenCodeRuntimeClient(BASE_URL, {
      directory: DIRECTORY,
      sessionId: SESSION_ID,
    });
    const conn = connect(client, SESSION_ID);
    try {
      expect(await until(() => server.scopedCount() > 0)).toBe(true);
      // Auto OFF: the request lands in the manual UI.
      server.emit({
        type: "permission.asked",
        properties: {
          id: PERMISSION_ID,
          sessionID: SESSION_ID,
          permission: "bash",
          patterns: ["echo WRITE"],
          metadata: { command: "echo WRITE" },
          always: [],
        },
      });
      expect(
        await until(
          () => conn.controller.getState().interactions.permissions.pending[PERMISSION_ID] != null,
        ),
      ).toBe(true);
      expect(server.replyCalls()).toEqual([]);

      // The single application-level toggle: persist + cache + reconcile.
      // Only the conversation PATCH is stubbed; the reconcile's permission
      // list/reply calls must still reach the fake OpenCode server.
      const serverFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).startsWith("/api/conversations/") && init?.method === "PATCH") {
          return { ok: true, status: 200, json: async () => ({}) } as Response;
        }
        return serverFetch(url as Parameters<typeof fetch>[0], init);
      }) as typeof fetch;
      await persistAutoApprove("conv_1", SESSION_ID, true, client.reconcileAutoApprove);

      expect(server.replyCalls().length).toBe(1);
      expect(server.replyCalls()[0]?.body).toEqual({ reply: "once" });
    } finally {
      conn.dispose();
    }
  });
});