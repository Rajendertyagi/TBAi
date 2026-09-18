import { describe, it, expect, afterEach } from "bun:test";
import {
  OpenCodeEventSource,
  OpenCodeThreadController,
  projectOpenCodeThreadMessages,
} from "@assistant-ui/react-opencode";
import { createScopedOpenCodeClient } from "./eventScope";
import { createOpenCodeRuntimeClient } from "./runtimeClient";
import {
  normalizePermissionReplyError,
  toPermissionReplyValue,
} from "./permissionCompat";
import { isPermissionGone } from "@/stores/stalePermissionsStore";

/**
 * Regression tests for the OpenCode tool-permission hang.
 *
 * Root cause (measured live on the managed 1.18.31 server): the frozen adapter
 * calls the permission routes **without a location**, and OpenCode's pending
 * permission store is **directory-scoped** — the unscoped list answers `[]` and
 * the unscoped reply 404s, so a `write`/`edit`/`bash` tool sat at `running`
 * forever.
 *
 * The fake server reproduces that exactly: it only returns the request / accepts
 * the reply when the session's `directory` is present, and it rejects the
 * unscoped call the way the real server does. A test that passes here proves the
 * compatibility layer supplied the directory — drop it and the assertions fail.
 *
 * It also covers the two edges that must NOT be confused: a 404 (request gone →
 * the stale guard retires the card, no fallback) and a route-unsupported
 * response (the one condition the named legacy fallback exists for).
 */

const BASE_URL = "http://127.0.0.1:1/api/opencode";
const DIRECTORY = "D:\\Temp\\ai-chat-app\\workspace\\chats\\conv-perm";
const SESSION_ID = "ses_permission00000000000001";
const OTHER_SESSION_ID = "ses_permission00000000000002";
const PERMISSION_ID = "per_aaa111222333";
const TOOL_RESULT = "V2_PERMISSION_APPROVED";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type RecordedCall = { method: string; path: string; directory: string | null; body: unknown };

type Server = ReturnType<typeof makeServer>;

function makeServer() {
  const calls: RecordedCall[] = [];
  const scopedSinks: Array<(chunk: string) => void> = [];
  /** Force the canonical reply route to answer with the SPA fallback. */
  let routeUnsupported = false;
  /** Force the canonical reply route to fail with a bare status. */
  let replyStatus: number | null = null;

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

  /** The V1 permission shape the adapter's `toPermissionRequest` reads. */
  const permission = {
    id: PERMISSION_ID,
    sessionID: SESSION_ID,
    permission: "bash",
    patterns: ["echo V2_UI_APPROVE_OK"],
    metadata: { command: "echo V2_UI_APPROVE_OK" },
    always: ["echo *"],
    tool: { messageID: "msg_tool_1", callID: "call_tool_1" },
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

    // Canonical permission reply: POST /permission/{rid}/reply?directory=<dir>
    if (/\/permission\/[^/]+\/reply$/.test(path)) {
      record();
      if (routeUnsupported) {
        return new Response("<!doctype html><html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (replyStatus !== null) return new Response(null, { status: replyStatus });
      if (directory !== DIRECTORY) return new Response(null, { status: 404 });
      return json(true);
    }

    // Legacy compatibility fallback: POST /session/{sid}/permissions/{pid}
    const respond = path.match(/\/session\/([^/]+)\/permissions\/([^/]+)$/);
    if (respond) {
      record();
      if (respond[1] !== SESSION_ID || respond[2] !== PERMISSION_ID) {
        return new Response(null, { status: 404 });
      }
      return json(true);
    }

    // Canonical permission list: GET /permission?directory=<dir>
    if (path.endsWith("/permission")) {
      record();
      return json(directory === DIRECTORY ? [permission] : []);
    }

    // Benign history responses so the adapter's reconnect reload stays quiet.
    if (/\/session\/[^/]+\/message$/.test(path)) {
      record();
      return json([]);
    }
    if (/\/session\/[^/]+$/.test(path)) {
      record();
      return json({ id: SESSION_ID, directory: DIRECTORY });
    }

    // Questions use the same scoping rule.
    if (/\/question\/[^/]+\/(reply|reject)$/.test(path)) {
      record();
      return directory === DIRECTORY ? json(true) : new Response(null, { status: 404 });
    }
    if (path.endsWith("/question")) {
      record();
      return json(
        directory === DIRECTORY
          ? [{ id: "que_1", sessionID: SESSION_ID, questions: [] }]
          : [],
      );
    }

    return json({}, 404);
  };

  return {
    calls,
    failReply(status: number) {
      replyStatus = status;
    },
    makeRouteUnsupported() {
      routeUnsupported = true;
    },
    scopedCount: () => scopedSinks.length,
    emit(payload: unknown) {
      const chunk = frame(payload);
      for (const send of scopedSinks) send(chunk);
    },
    install() {
      globalThis.fetch = impl as unknown as typeof globalThis.fetch;
    },
    permissionCalls: () => calls.filter((c) => c.path.includes("/permission")),
    canonicalReplies: () => calls.filter((c) => /\/permission\/[^/]+\/reply$/.test(c.path)),
    fallbackReplies: () => calls.filter((c) => /\/permissions\//.test(c.path)),
  };
}

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function permissionAskedEvent() {
  return {
    type: "permission.asked",
    properties: {
      id: PERMISSION_ID,
      sessionID: SESSION_ID,
      permission: "bash",
      patterns: ["echo V2_UI_APPROVE_OK"],
      metadata: { command: "echo V2_UI_APPROVE_OK" },
      always: ["echo *"],
      tool: { messageID: "msg_tool_1", callID: "call_tool_1" },
    },
  };
}

function emitToolCompleted(server: Server): void {
  const now = Date.now();
  server.emit({
    type: "message.updated",
    properties: {
      sessionID: SESSION_ID,
      info: {
        id: "msg_tool_1",
        sessionID: SESSION_ID,
        role: "assistant",
        parentID: "msg_user_1",
        modelID: "union-alpha",
        providerID: "opencode",
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
        id: "prt_tool_1",
        sessionID: SESSION_ID,
        messageID: "msg_tool_1",
        callID: "call_tool_1",
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "echo V2_UI_APPROVE_OK" },
          output: TOOL_RESULT,
          time: { start: now, end: now },
        },
      },
    },
  });
}

async function until(check: () => boolean, budgetMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

function connect(client: ReturnType<typeof createScopedOpenCodeClient>) {
  const source = new OpenCodeEventSource(client);
  const controller = new OpenCodeThreadController(client, () => source, SESSION_ID);
  const unsubscribe = controller.subscribe(() => {});
  return {
    controller,
    dispose() {
      unsubscribe();
      source.dispose();
    },
  };
}

async function seedPendingPermission(server: Server, conn: ReturnType<typeof connect>) {
  expect(await until(() => server.scopedCount() > 0)).toBe(true);
  server.emit(permissionAskedEvent());
  expect(
    await until(
      () => conn.controller.getState().interactions.permissions.pending[PERMISSION_ID] != null,
    ),
  ).toBe(true);
}

const compat = (sessionId: string | undefined = SESSION_ID) =>
  createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId });

describe("permission compatibility — directory scope", () => {
  it("lists with the authoritative directory and returns the real request", async () => {
    const server = makeServer();
    server.install();
    const client = compat();

    const response = await client.permission.list(undefined, { throwOnError: true });

    expect(response.data?.[0]?.id).toBe(PERMISSION_ID);
    const call = server.permissionCalls()[0];
    expect(call?.method).toBe("GET");
    expect(call?.path).toBe("/api/opencode/permission");
    expect(call?.directory).toBe(DIRECTORY);
  });

  it("replies with the authoritative directory and the mapped decision", async () => {
    const server = makeServer();
    server.install();
    const client = compat();

    await client.permission.reply({ requestID: PERMISSION_ID, reply: "once" }, { throwOnError: true });

    expect(server.canonicalReplies()).toEqual([
      {
        method: "POST",
        path: `/api/opencode/permission/${PERMISSION_ID}/reply`,
        directory: DIRECTORY,
        body: { reply: "once" },
      },
    ]);
    expect(server.fallbackReplies()).toEqual([]);
  });

  it("maps deny to reject and keeps 'always' only because the server accepts it", async () => {
    const server = makeServer();
    server.install();
    const client = compat();

    await client.permission.reply({ requestID: PERMISSION_ID, reply: "reject" }, { throwOnError: true });
    expect(server.canonicalReplies()[0]?.body).toEqual({ reply: "reject" });

    expect(toPermissionReplyValue("once")).toBe("once");
    expect(toPermissionReplyValue("always")).toBe("always");
    expect(toPermissionReplyValue("reject")).toBe("reject");
    expect(() => toPermissionReplyValue("approve")).toThrow();
    expect(() => toPermissionReplyValue(undefined)).toThrow();
  });

  it("uses the configured session id on the fallback and never a fixed one", async () => {
    const server = makeServer();
    server.makeRouteUnsupported();
    server.install();
    const client = createOpenCodeRuntimeClient(BASE_URL, {
      directory: DIRECTORY,
      sessionId: OTHER_SESSION_ID,
    });

    // The fallback is per-session, so the fake only resolves SESSION_ID; the
    // request must still carry the configured id.
    await client.permission.reply({ requestID: PERMISSION_ID, reply: "once" }, { throwOnError: true }).catch(() => undefined);

    const fallback = server.fallbackReplies();
    expect(fallback.length).toBe(1);
    expect(fallback[0]?.path).toContain(OTHER_SESSION_ID);
    expect(fallback[0]?.path).not.toContain(SESSION_ID);
  });

  it("an unsupported response value fails clearly and sends nothing", async () => {
    const server = makeServer();
    server.install();
    const client = compat();

    let thrown: unknown;
    try {
      await client.permission.reply({ requestID: PERMISSION_ID, reply: "approve" as never }, { throwOnError: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Unknown OpenCode permission reply");
    expect(server.canonicalReplies()).toEqual([]);
  });

  it("a gone permission follows the shared stale path and does NOT use the fallback", async () => {
    const server = makeServer();
    server.failReply(404);
    server.install();
    const client = compat();

    let thrown: unknown;
    try {
      await client.permission.reply({ requestID: PERMISSION_ID, reply: "once" }, { throwOnError: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(isPermissionGone(thrown)).toBe(true);
    expect(server.fallbackReplies()).toEqual([]);
  });

  it("an ordinary failure stays retryable and does NOT use the fallback", async () => {
    const server = makeServer();
    server.failReply(500);
    server.install();
    const client = compat();

    let thrown: unknown;
    try {
      await client.permission.reply({ requestID: PERMISSION_ID, reply: "once" }, { throwOnError: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(isPermissionGone(thrown)).toBe(false);
    expect(normalizePermissionReplyError(thrown)).toBe(thrown);
    expect(server.fallbackReplies()).toEqual([]);
  });

  it("uses the named fallback only when the canonical route is unsupported", async () => {
    const server = makeServer();
    server.makeRouteUnsupported();
    server.install();
    const client = compat();

    await client.permission.reply({ requestID: PERMISSION_ID, reply: "once" }, { throwOnError: true });

    expect(server.canonicalReplies().length).toBe(1);
    expect(server.fallbackReplies()).toEqual([
      {
        method: "POST",
        path: `/api/opencode/session/${SESSION_ID}/permissions/${PERMISSION_ID}`,
        directory: null,
        body: { response: "once" },
      },
    ]);
  });

  it("leaves the call unscoped (previous behaviour) without a session id", async () => {
    const server = makeServer();
    server.install();
    // Built directly (not via `compat`) so the session id is genuinely absent.
    const client = createOpenCodeRuntimeClient(BASE_URL, {
      directory: DIRECTORY,
      sessionId: undefined,
    });

    const response = await client.permission.list(undefined, { throwOnError: true });

    // The patch is skipped, so the SDK's own unscoped call runs — which is
    // exactly the pre-fix behaviour, reproduced rather than guessed.
    const call = server.permissionCalls()[0];
    expect(call?.directory).toBeNull();
    expect(response.data).toEqual([]);
  });
});

describe("question compatibility — directory scope", () => {
  it("lists, replies and rejects with the authoritative directory", async () => {
    const server = makeServer();
    server.install();
    const client = compat();

    const listed = await client.question.list(undefined, { throwOnError: true });
    expect(listed.data?.[0]?.id).toBe("que_1");
    await client.question.reply({ requestID: "que_1", answers: [] }, { throwOnError: true });
    await client.question.reject({ requestID: "que_1" }, { throwOnError: true });

    const scoped = server.calls.filter((c) => c.path.includes("/question"));
    expect(scoped.length).toBe(3);
    for (const call of scoped) expect(call.directory).toBe(DIRECTORY);
    expect(scoped[1]?.path).toBe("/api/opencode/question/que_1/reply");
    expect(scoped[2]?.path).toBe("/api/opencode/question/que_1/reject");
  });
});

describe("initial hydration — a request that predates the page mount", () => {
  it("hydrates a pending permission on first connect with NO permission.asked event", async () => {
    const server = makeServer();
    server.install();
    const conn = connect(compat());
    try {
      // The fake server never emits `permission.asked` — the scoped list is the
      // only source, so the state below can only have come from hydration.
      expect(
        await until(
          () => conn.controller.getState().interactions.permissions.pending[PERMISSION_ID] != null,
        ),
      ).toBe(true);

      const listCall = server.permissionCalls().find((c) => c.method === "GET");
      expect(listCall?.directory).toBe(DIRECTORY);
    } finally {
      conn.dispose();
    }
  });

  it("hydrates a pending question too", async () => {
    const server = makeServer();
    server.install();
    const conn = connect(compat());
    try {
      expect(
        await until(
          () => conn.controller.getState().interactions.questions.pending["que_1"] != null,
        ),
      ).toBe(true);
      const listCall = server.calls.find((c) => c.path.endsWith("/question"));
      expect(listCall?.directory).toBe(DIRECTORY);
    } finally {
      conn.dispose();
    }
  });

  it("does not hydrate without a directory (nothing authoritative to read)", async () => {
    const server = makeServer();
    server.install();
    const conn = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: null, sessionId: SESSION_ID }),
    );
    try {
      // No directory => the event request is unscoped, so wait for the request
      // itself rather than for a scoped sink.
      expect(await until(() => server.calls.some((c) => c.path.endsWith("/event")))).toBe(true);
      // Give hydration a chance to (incorrectly) run.
      await new Promise((r) => setTimeout(r, 300));
      expect(conn.controller.getState().interactions.permissions.pending[PERMISSION_ID]).toBeUndefined();
      expect(conn.controller.getState().interactions.questions.pending["que_1"]).toBeUndefined();
    } finally {
      conn.dispose();
    }
  });
});

describe("permission compatibility — the wedge regression", () => {
  it("reproduces the failure without the scope: the unscoped reply 404s and the tool stays pending", async () => {
    const server = makeServer();
    server.install();
    // The pre-fix client: event scope only, no permission mapping.
    const client = createScopedOpenCodeClient(BASE_URL, DIRECTORY);
    const conn = connect(client);
    try {
      await seedPendingPermission(server, conn);

      let thrown: unknown;
      try {
        await conn.controller.replyToPermission(PERMISSION_ID, "once");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeDefined();
      // Without the patch the SDK's raw transport error propagates — it is NOT
      // the canonical "permission request not found" wording, so the stale guard
      // cannot retire the card. That is exactly why the tool stayed wedged.
      expect(isPermissionGone(thrown)).toBe(false);
      const canonical = server.canonicalReplies()[0];
      expect(canonical?.path).toBe(`/api/opencode/permission/${PERMISSION_ID}/reply`);
      expect(canonical?.directory).toBeNull();
      expect(conn.controller.getState().interactions.permissions.pending[PERMISSION_ID]).toBeDefined();
    } finally {
      conn.dispose();
    }
  });

  it("fixes it with the scope: the directory reply succeeds, resolves, and the tool completes", async () => {
    const server = makeServer();
    server.install();
    const conn = connect(compat());
    try {
      await seedPendingPermission(server, conn);

      await conn.controller.replyToPermission(PERMISSION_ID, "once");

      const canonical = server.canonicalReplies();
      expect(canonical.length).toBe(1);
      expect(canonical[0]?.directory).toBe(DIRECTORY);
      expect(canonical[0]?.body).toEqual({ reply: "once" });
      expect(server.fallbackReplies()).toEqual([]);

      const state = conn.controller.getState();
      expect(state.interactions.permissions.pending[PERMISSION_ID]).toBeUndefined();
      expect(state.interactions.permissions.resolved[PERMISSION_ID]?.reply).toBe("once");

      emitToolCompleted(server);
      expect(
        await until(() =>
          JSON.stringify(projectOpenCodeThreadMessages(conn.controller.getState())).includes(
            TOOL_RESULT,
          ),
        ),
      ).toBe(true);
    } finally {
      conn.dispose();
    }
  });

  it("reconnect re-lists with the directory and rehydrates a missed permission", async () => {
    const server = makeServer();
    server.install();
    const conn = connect(compat());
    try {
      expect(await until(() => server.scopedCount() > 0)).toBe(true);
      const listGets = () => server.permissionCalls().filter((c) => c.method === "GET");
      const before = listGets().length;

      // The stream drops and reconnects; the adapter's own reconnect path
      // re-lists. The list is directory-scoped, so it returns the request.
      server.emit({ type: "stream.reconnected", properties: {} });

      expect(await until(() => listGets().length > before)).toBe(true);
      for (const call of listGets()) expect(call.directory).toBe(DIRECTORY);
      expect(conn.controller.getState().interactions.permissions.pending[PERMISSION_ID]).toBeDefined();
    } finally {
      conn.dispose();
    }
  });
});
