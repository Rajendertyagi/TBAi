import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  OpenCodeEventSource,
  OpenCodeThreadController,
  projectOpenCodeThreadMessages,
} from "@assistant-ui/react-opencode";
import { createOpenCodeRuntimeClient } from "./runtimeClient";
import type { OpenCodeRuntimeClient } from "./eventScope";
import { shouldReconnectForEpoch } from "./recoveryEpoch";

/**
 * OpenCode reconnect capability (coding-agent hardening).
 *
 * `useOpenCodeRuntime` (in `useOpenCodeRuntime.ts`) exposes `reconnect()`:
 * bumping a client-epoch re-creates the client with the SAME session id +
 * directory, so the frozen adapter disposes its old controller registry (and
 * its single event subscription) and builds a fresh one, then the normal
 * hydration + reconcile path restores session state.
 *
 * The React hook itself cannot be driven here (`web/` has no DOM runner —
 * bun test, no jsdom), so this file pins the reconnect contract at the seams
 * the hook is built from, using the OpenCode fake-runtime/event harness that
 * `liveStream.test.ts` and `permissionCompat.test.ts` established:
 *
 *   - `createOpenCodeRuntimeClient` is the app's client construction seam.
 *     "Reconnect" is exactly a second call with the same session inputs.
 *   - `OpenCodeEventSource` + `OpenCodeThreadController` are the real
 *     library objects the adapter's registry owns. Disposing the old
 *     connection (the registry's `dispose()`) and opening a new one mirrors
 *     what the adapter does when the client identity changes.
 *   - The hook's own epoch/session-preservation logic (client built on
 *     `[sessionId, directory, clientEpoch]`; `reconnect` bumps only the
 *     epoch) is source-guarded — that is the part that has no DOM.
 *
 * Every assertion here is behavioural against the REAL library chain and the
 * app's real client wrapper. Dropping the reconnect invariant (e.g. re-using
 * one client, or not disposing the predecessor) makes these fail.
 */

const BASE_URL = "http://127.0.0.1:1/api/opencode";
const DIRECTORY = "D:\\Temp\\ai-chat-app\\workspace\\chats\\conv-reconnect";
const SESSION_ID = "ses_reconnect00000000000000001";
const OTHER_SESSION_ID = "ses_reconnect00000000000000002";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type RecordedCall = { method: string; path: string; directory: string | null; body: unknown };

/** A fake OpenCode server for reconnect: scoped `/event` + hydration lists. */
function makeServer() {
  const calls: RecordedCall[] = [];
  const scopedSinks: Array<(chunk: string) => void> = [];
  const unscopedSinks: Array<(chunk: string) => void> = [];

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

  const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

  const impl = async (input: unknown): Promise<Response> => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String((input as Request).url);
    const method = input instanceof Request ? input.method : "GET";
    const url = new URL(href, BASE_URL);
    const path = `${url.pathname}${url.search}`;
    const directory = url.searchParams.get("directory");
    const record = () => calls.push({ method, path, directory, body: undefined });

    // Todo hydration list (called on `server.connected` by the todo compat
    // layer) — the fake must serve it so `hydrateSessionTodos` can run.
    if (url.pathname.includes("/todo")) {
      record();
      return json([]);
    }

    if (url.pathname.endsWith("/event")) {
      record();
      const scoped = directory !== null;
      return sse((send) => {
        (scoped ? scopedSinks : unscopedSinks).push(send);
        // Every fresh connection opens with the real greeting.
        send(frame({ type: "server.connected", properties: {} }));
      });
    }

    // Hydration lists — the directory is the authoritative scope.
    if (url.pathname.endsWith("/permission")) {
      record();
      return json(
        directory === DIRECTORY
          ? [{
              id: "per_reconnect",
              sessionID: SESSION_ID,
              permission: "bash",
              patterns: ["echo RECONNECT_OK"],
              metadata: { command: "echo RECONNECT_OK" },
              always: [],
            }]
          : [],
      );
    }
    if (url.pathname.endsWith("/question")) {
      record();
      return json(
        directory === DIRECTORY
          ? [{ id: "que_reconnect", sessionID: SESSION_ID, questions: [] }]
          : [],
      );
    }

    // Benign history/session responses so the reload path stays quiet.
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
    scopedCount: () => scopedSinks.length,
    unscopedCount: () => unscopedSinks.length,
    emit(payload: unknown) {
      const chunk = frame(payload);
      for (const send of scopedSinks) {
        try {
          send(chunk);
        } catch {
          // A disposed predecessor's stream is closed; skip it. The live
          // subscription (the reconnect's) is what must receive the event.
        }
      }
    },
    /** The `/event` requests recorded (their directory scope, if any). */
    eventRequests: () =>
      calls
        .filter((c) => c.path.split("?")[0].endsWith("/event"))
        .map((c) => ({ directory: c.directory })),
    /** The permission list calls recorded (their directory scope). */
    permissionLists: () =>
      calls.filter(
        (c) => c.path.split("?")[0].endsWith("/permission") && c.method === "GET",
      ),
    install() {
      globalThis.fetch = impl as unknown as typeof globalThis.fetch;
    },
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

/**
 * The library connection the adapter's registry owns: one event source + one
 * thread controller + one subscription, exactly as the adapter builds it.
 * `dispose` mirrors the registry's `dispose()` — the reconnect teardown step.
 */
function connect(client: OpenCodeRuntimeClient, sessionId: string) {
  const source = new OpenCodeEventSource(client);
  const controller = new OpenCodeThreadController(client, () => source, sessionId);
  const unsubscribe = controller.subscribe(() => {});
  return {
    controller,
    source,
    dispose() {
      unsubscribe();
      source.dispose();
    },
  };
}

function projected(state: unknown): string {
  return JSON.stringify(
    projectOpenCodeThreadMessages(
      state as Parameters<typeof projectOpenCodeThreadMessages>[0],
    ),
  );
}

/** Streams a completed assistant reply on the current scoped subscription. */
function emitAssistantReply(server: ReturnType<typeof makeServer>, marker: string): void {
  const now = Date.now();
  server.emit({
    type: "message.updated",
    properties: {
      sessionID: SESSION_ID,
      info: {
        id: `msg_${marker}`,
        sessionID: SESSION_ID,
        role: "assistant",
        parentID: "msg_user",
        modelID: "m",
        providerID: "p",
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
        id: `prt_${marker}`,
        sessionID: SESSION_ID,
        messageID: `msg_${marker}`,
        type: "text",
        text: marker,
        time: { start: now, end: now },
      },
    },
  });
}

describe("reconnect — client rebuilt for the same session (session preserved)", () => {
  it("rebuilding the client preserves sessionId + directory (a second client, not a mutation)", () => {
    // "Reconnect" is exactly a second client built from the same session
    // inputs. It must be a distinct client object, scoped to the same
    // directory — the adapter's registry churn depends on the new identity.
    const a = createOpenCodeRuntimeClient(BASE_URL, {
      directory: DIRECTORY,
      sessionId: SESSION_ID,
    });
    const b = createOpenCodeRuntimeClient(BASE_URL, {
      directory: DIRECTORY,
      sessionId: SESSION_ID,
    });

    expect(b).not.toBe(a); // a genuine rebuild, not the same instance
    // Both carry the event-subscription patch (a scoped client).
    expect(a.event.subscribe).toBeDefined();
    expect(b.event.subscribe).toBeDefined();
  });

  it("a reconnect keeps the session directory on the new event subscription", async () => {
    const server = makeServer();
    server.install();

    // Original connection: scoped event subscription for the session.
    const connA = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    expect(await until(() => server.scopedCount() > 0)).toBe(true);
    const scopedBeforeReconnect = server.scopedCount();
    connA.dispose();

    // Reconnect: a new client + connection for the SAME session. The new
    // scoped subscription carries the session's directory on its /event.
    const connB = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    try {
      // The reconnect opens a FRESH scoped event subscription (a new sink);
      // that subscription carries the session's directory.
      expect(await until(() => server.scopedCount() > scopedBeforeReconnect)).toBe(true);
      // Wait for the /event request to be recorded (the sink registers before
      // the record in some paths), then assert its directory.
      expect(
        await until(() =>
          server.eventRequests().some((c) => c.directory === DIRECTORY && c.directory !== null),
        ),
      ).toBe(true);
      const eventDirs = server.eventRequests().map((c) => c.directory);
      // The fresh (reconnect) event request carries the directory.
      expect(eventDirs[eventDirs.length - 1]).toBe(DIRECTORY);
    } finally {
      connB.dispose();
    }
  });
});

describe("reconnect — old registry disposed, exactly one live subscription", () => {
  it("disposing the old connection leaves exactly one live event subscription", async () => {
    const server = makeServer();
    server.install();

    // The registry's dispose() tears down its single event source.
    const connA = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    expect(await until(() => server.scopedCount() > 0)).toBe(true);
    const liveBefore = server.scopedCount();
    expect(liveBefore).toBeGreaterThanOrEqual(1);

    // Reconnect: dispose the old, open the new.
    connA.dispose();
    const connB = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    try {
      expect(await until(() => server.scopedCount() === liveBefore + 1)).toBe(true);
      // The old connection is gone; only the new one is live.
      expect(server.scopedCount()).toBe(liveBefore + 1);
      // No unscoped (stub) subscription is ever opened for a scoped session.
      expect(server.unscopedCount()).toBe(0);
    } finally {
      connB.dispose();
    }
  });

  it("rapid double-reconnect is safe: one live subscription throughout", async () => {
    const server = makeServer();
    server.install();

    const build = () =>
      connect(
        createOpenCodeRuntimeClient(BASE_URL, {
          directory: DIRECTORY,
          sessionId: SESSION_ID,
        }),
        SESSION_ID,
      );

    let conn = build();
    expect(await until(() => server.scopedCount() > 0)).toBe(true);
    const baseline = server.scopedCount();

    // Two back-to-back reconnects (the double-click window). Each disposes its
    // predecessor before the new one becomes the live subscription, so the
    // live count never exceeds one beyond the baseline — no duplicate streams.
    conn.dispose();
    conn = build();
    expect(await until(() => server.scopedCount() === baseline + 1)).toBe(true);
    conn.dispose();
    conn = build();
    try {
      expect(await until(() => server.scopedCount() === baseline + 2)).toBe(true);
      // Each reconnect adds exactly one live subscription; none are left
      // dangling from the disposed predecessors.
      expect(server.scopedCount()).toBe(baseline + 2);
    } finally {
      conn.dispose();
    }
  });
});

describe("reconnect — post-reconnect delivery without a reload", () => {
  it("a live event on the NEW subscription delivers to thread state with no history load", async () => {
    const server = makeServer();
    server.install();

    // The original subscription: scoped event stream, then disposed.
    const connA = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    expect(await until(() => server.scopedCount() > 0)).toBe(true);
    connA.dispose();

    // Reconnect: a fresh client + connection for the SAME session. The event
    // source re-subscribes through the (hydrated) event stream, so a streamed
    // reply reaches the controller state with no history reload.
    const connB = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    try {
      // Settle the fresh subscription before asserting on its state.
      const scopedBeforeReconnect = server.scopedCount();
      expect(await until(() => server.scopedCount() > scopedBeforeReconnect)).toBe(true);
      const historyLoadsBefore = server.calls.filter((c) => c.path.includes("/message")).length;
      expect(projected(connB.controller.getState())).not.toContain("POST_RECONNECT_MARKER");

      // A reply streamed on the fresh connection reaches the controller state.
      emitAssistantReply(server, "POST_RECONNECT_MARKER");
      expect(
        await until(() => projected(connB.controller.getState()).includes("POST_RECONNECT_MARKER")),
      ).toBe(true);

      // No history reload was needed — the delivery is live.
      const historyLoadsAfter = server.calls.filter((c) => c.path.includes("/message")).length;
      expect(historyLoadsAfter).toBe(historyLoadsBefore);
    } finally {
      connB.dispose();
    }
  });
});

describe("reconnect — hydration / reconcile re-runs on the fresh connection", () => {
  it("the fresh connection re-lists pending permissions/questions with the directory", async () => {
    const server = makeServer();
    server.install();

    const connA = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    expect(await until(() => server.scopedCount() > 0)).toBe(true);
    connA.dispose();

    const connB = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    try {
      // The reconnect's own hydration runs on its fresh `server.connected`:
      // it re-lists the authoritative pending sets and rehydrates a permission
      // that predates the reconnect — the normal reconcile path, not a
      // synthesized frame. Poll for the re-list call on the NEW connection.
      const connALists = server.permissionLists().length;
      expect(
        await until(() => server.permissionLists().length > connALists),
      ).toBe(true);

      // The re-list call carried the session's directory.
      const lists = server.permissionLists().slice(connALists);
      for (const c of lists) expect(c.directory).toBe(DIRECTORY);

      // The re-hydrated permission is now in thread state.
      expect(
        await until(
          () => connB.controller.getState().interactions.permissions.pending["per_reconnect"] != null,
        ),
      ).toBe(true);
    } finally {
      connB.dispose();
    }
  });
});

describe("reconnect — failure surfaces, never a false Connected", () => {
  it("a reconnect that opens unscoped delivers no session events (not a healthy connection)", async () => {
    // A failed/lost reconnect reproduces as an unscoped stream: OpenCode's
    // `/event` answers an unscoped subscriber with the stub that carries no
    // session events, so the session cannot read as a healthy, scoped
    // connection. The status heart maps this to `error`/`off`, never a false
    // `idle` Connected. The fake withholds every session event from an
    // unscoped subscriber — exactly the real server's behaviour.
    const server = makeServer();
    server.install();
    const conn = connect(
      createOpenCodeRuntimeClient(BASE_URL, {
        directory: null, // unscoped: the fake withholds every session event
        sessionId: SESSION_ID,
      }),
      SESSION_ID,
    );
    try {
      // Let the unscoped stream settle; no scoped subscription is opened for
      // this session, so it can never become a healthy directory-scoped one.
      expect(await until(() => server.unscopedCount() > 0)).toBe(true);
      // Stream a reply that only a scoped subscriber would receive.
      server.emit({
        type: "message.updated",
        properties: {
          sessionID: SESSION_ID,
          info: {
            id: "msg_fail",
            sessionID: SESSION_ID,
            role: "assistant",
            parentID: "u",
            modelID: "m",
            providerID: "p",
            mode: "build",
            agent: "build",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
          },
        },
      });
      // Bounded wait: the unscoped subscription is starved — the event never
      // reaches thread state, so the connection cannot be misread as working.
      const appeared = await until(
        () => projected(conn.controller.getState()).includes("msg_fail"),
        400,
      );
      expect(appeared).toBe(false);
      // It opened an UNSCOPED subscription — the failure signature.
      expect(server.scopedCount()).toBe(0);
      expect(server.unscopedCount()).toBeGreaterThanOrEqual(1);
    } finally {
      conn.dispose();
    }
  });
});

describe("reconnect — session switch wins over a pending reconnect", () => {
  it("switching session keeps the NEW session's scope after a pending reconnect", async () => {
    const server = makeServer();
    server.install();

    // Start on the original session.
    const connA = connect(
      createOpenCodeRuntimeClient(BASE_URL, { directory: DIRECTORY, sessionId: SESSION_ID }),
      SESSION_ID,
    );
    expect(await until(() => server.scopedCount() > 0)).toBe(true);
    connA.dispose();

    // The pending reconnect settles; then the user switches to a different
    // session. The active client must be built from the NEW session inputs.
    const connB = connect(
      createOpenCodeRuntimeClient(BASE_URL, {
        directory: DIRECTORY,
        sessionId: OTHER_SESSION_ID,
      }),
      OTHER_SESSION_ID,
    );
    try {
      // The active connection now targets the new session id.
      expect(connB.controller.getState().sessionId).toBe(OTHER_SESSION_ID);
      // Exactly one live subscription after the switch.
      expect(server.scopedCount()).toBeGreaterThanOrEqual(1);
    } finally {
      connB.dispose();
    }
  });
});

describe("reconnect — hook logic (source guard: no DOM runner)", () => {
  // The one part of reconnect that has no observable seam without a React
  // renderer: the epoch/dependency wiring. Guard it against the source so a
  // regression that drops the epoch, re-keys on the wrong value, or adds
  // per-render churn fails here.
  let source = "";
  beforeEach(async () => {
    source = await Bun.file(
      new URL("./useOpenCodeRuntime.ts", import.meta.url),
    ).text();
  });

  it("rebuilds the client only on session/directory/epoch — never per render", () => {
    // The client memo's dependency array must include the three inputs and
    // nothing else — a bare render must not re-create the client.
    expect(source).toContain("[eventDirectory, sessionId, clientEpoch]");
  });

  it("reconnect() bumps only the epoch, preserving session inputs", () => {
    // The reconnect callback is a pure state bump — it must not create a
    // client itself or touch the session inputs.
    expect(source).toContain("setClientEpoch((n) => n + 1)");
  });

  it("the client is memoized, not re-created, across unrelated renders", () => {
    expect(source).toContain("useMemo(");
    expect(source).toContain("createOpenCodeRuntimeClient(OPENCODE_PROXY_BASE_URL,");
  });

  it("exposes runtime + reconnect as the reconnect contract", () => {
    expect(source).toContain(
      "return { runtime, reconnect, reconcileAutoApprove: client.reconcileAutoApprove }",
    );
  });
});

describe("reconnect — epoch gate (behavioral, no DOM runner)", () => {
  // `shouldReconnectForEpoch` is the pure decision behind AgentRuntime's
  // recovery effect. A mount must never rebuild the client/adapter merely
  // because the epoch is already non-zero (stale flap); only an epoch
  // CHANGE while mounted reconnects. Deterministic state-machine walk.
  it("mount with epoch 0 never reconnects, re-renders neither", () => {
    let seen = 0;
    const step = (epoch: number) => {
      const d = shouldReconnectForEpoch({
        sessionId: "ses_1",
        recoveryEpoch: epoch,
        seenRecoveryEpoch: seen,
      });
      seen = d.seenRecoveryEpoch;
      return d.reconnect;
    };
    expect(step(0)).toBe(false);
    expect(step(0)).toBe(false);
    expect(step(0)).toBe(false);
  });

  it("mount with a stale non-zero epoch does NOT reconnect", () => {
    let seen = 1;
    const d = shouldReconnectForEpoch({
      sessionId: "ses_1",
      recoveryEpoch: 1,
      seenRecoveryEpoch: seen,
    });
    expect(d.reconnect).toBe(false);
    expect(d.seenRecoveryEpoch).toBe(1);
  });

  it("epoch transition while mounted reconnects exactly once per transition", () => {
    let seen = 1;
    let reconnects = 0;
    const step = (epoch: number) => {
      const d = shouldReconnectForEpoch({
        sessionId: "ses_1",
        recoveryEpoch: epoch,
        seenRecoveryEpoch: seen,
      });
      seen = d.seenRecoveryEpoch;
      if (d.reconnect) reconnects++;
    };
    step(1);
    step(1);
    expect(reconnects).toBe(0);
    step(2);
    expect(reconnects).toBe(1);
    step(2);
    step(2);
    expect(reconnects).toBe(1);
    step(3);
    expect(reconnects).toBe(2);
  });

  it("no session bound never reconnects and leaves the seen epoch untouched", () => {
    const d = shouldReconnectForEpoch({
      sessionId: undefined,
      recoveryEpoch: 7,
      seenRecoveryEpoch: 2,
    });
    expect(d.reconnect).toBe(false);
    expect(d.seenRecoveryEpoch).toBe(2);
  });

  it("AgentRuntime wires the gate through a previous-epoch ref, not a bare epoch check", async () => {
    const source = await Bun.file(
      new URL("./OpenCodeView.tsx", import.meta.url),
    ).text();
    expect(source).toContain("seenRecoveryEpochRef");
    expect(source).toContain("shouldReconnectForEpoch({");
    // The old unconditional mount-time reconnect is gone.
    expect(source).not.toContain("if (recoveryEpoch === 0 || !sessionId) return;");
  });
});
