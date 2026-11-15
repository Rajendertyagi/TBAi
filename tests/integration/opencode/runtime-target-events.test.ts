import { afterEach, describe, expect, it } from "bun:test";
import {
  beginShutdown,
  clearTarget,
  installManagedTarget,
  readBackendInstanceId,
  resetConnectionStateForTests,
  subscribeRuntimeTargetChanges,
  type OpenCodeRuntimeTargetChange,
} from "@/services/opencode/connectionState.ts";
import { getOpenCodeAuthPassword } from "@/services/opencode/runtime.ts";

const { default: openCodeApp } = await import("@/routes/opencode.ts");

afterEach(() => {
  resetConnectionStateForTests();
});

async function readSseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
  state: { buffer: string },
): Promise<string[]> {
  const decoder = new TextDecoder();
  const events: string[] = [];
  while (events.length < count) {
    let idx = state.buffer.indexOf("\n\n");
    while (idx !== -1) {
      const raw = state.buffer.slice(0, idx);
      state.buffer = state.buffer.slice(idx + 2);
      if (raw.trim().length > 0) events.push(raw);
      idx = state.buffer.indexOf("\n\n");
      if (events.length >= count) return events;
    }
    const { value, done } = await reader.read();
    if (done) break;
    state.buffer += decoder.decode(value, { stream: true });
  }
  return events;
}

function parseSseData(events: string[], eventName: string): unknown[] {
  const out: unknown[] = [];
  for (const raw of events) {
    const lines = raw.split("\n");
    let name = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (name !== eventName) continue;
    if (dataLines.length === 0) continue;
    out.push(JSON.parse(dataLines.join("\n")));
  }
  return out;
}

describe("OpenCode runtime target lifecycle notifications", () => {
  it("publishes target identity changes on install, replace, clear and shutdown", async () => {
    const seen: OpenCodeRuntimeTargetChange[] = [];
    const unsubscribe = subscribeRuntimeTargetChanges((change) => seen.push(change));
    const backendInstanceId = readBackendInstanceId();
    try {
      const managedId = installManagedTarget({
        baseUrl: "http://127.0.0.1:4096",
        password: getOpenCodeAuthPassword(),
      });
      expect(seen.at(-1)).toEqual({
        backendInstanceId,
        mode: "managed",
        targetRevision: 1,
        targetId: managedId,
      });

      clearTarget();
      expect(seen.at(-1)).toEqual({
        backendInstanceId,
        mode: "unresolved",
        targetRevision: 2,
        targetId: null,
      });

      const restoredId = installManagedTarget({
        baseUrl: "http://127.0.0.1:4097",
        password: getOpenCodeAuthPassword(),
      });
      expect(seen.at(-1)).toEqual({
        backendInstanceId,
        mode: "managed",
        targetRevision: 3,
        targetId: restoredId,
      });

      await beginShutdown();
      expect(seen.at(-1)).toEqual({
        backendInstanceId,
        mode: "unresolved",
        targetRevision: 4,
        targetId: null,
      });
    } finally {
      unsubscribe();
    }
  });

  it("streams current target and lifecycle changes over /runtime/events", async () => {
    const backendInstanceId = readBackendInstanceId();
    const response = await openCodeApp.request("http://localhost/runtime/events");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    if (!response.body) throw new Error("missing SSE body");

    const reader = response.body.getReader();
    const state = { buffer: "" };
    try {
      const initial = await readSseEvents(reader, 1, state);
      expect(parseSseData(initial, "opencode.runtime_target")[0]).toEqual({
        backendInstanceId,
        mode: "unresolved",
        targetRevision: 0,
        targetId: null,
      });

      const managedId = installManagedTarget({
        baseUrl: "http://127.0.0.1:4096",
        password: getOpenCodeAuthPassword(),
      });
      clearTarget();
      const restoredId = installManagedTarget({
        baseUrl: "http://127.0.0.1:4097",
        password: getOpenCodeAuthPassword(),
      });

      const changes = await readSseEvents(reader, 3, state);
      expect(parseSseData(changes, "opencode.runtime_target")).toEqual([
        { backendInstanceId, mode: "managed", targetRevision: 1, targetId: managedId },
        { backendInstanceId, mode: "unresolved", targetRevision: 2, targetId: null },
        { backendInstanceId, mode: "managed", targetRevision: 3, targetId: restoredId },
      ]);
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  it("cleans up listener and heartbeat on enqueue failure and remains stable for repeated failures", async () => {
    const OriginalReadableStream = globalThis.ReadableStream;
    let failNextEnqueue = false;
    let enqueueCalls = 0;
    let closeCalls = 0;
    class FailingReadableStream<T> extends OriginalReadableStream<T> {
      constructor(underlyingSource?: UnderlyingSource<T>, strategy?: QueuingStrategy<T>) {
        if (underlyingSource && typeof underlyingSource.start === "function") {
          const originalStart = underlyingSource.start.bind(underlyingSource);
          underlyingSource.start = (controller: ReadableStreamDefaultController<T>) => {
            const originalEnqueue = controller.enqueue.bind(controller);
            const originalClose = controller.close.bind(controller);
            controller.enqueue = ((chunk: T) => {
              enqueueCalls += 1;
              if (failNextEnqueue) {
                failNextEnqueue = false;
                throw new Error("synthetic enqueue failure");
              }
              return originalEnqueue(chunk);
            }) as typeof controller.enqueue;
            controller.close = (() => {
              closeCalls += 1;
              return originalClose();
            }) as typeof controller.close;
            return originalStart(controller);
          };
        }
        super(underlyingSource as any, strategy);
      }
    }

    (globalThis as any).ReadableStream = FailingReadableStream;
    try {
      for (let i = 0; i < 3; i++) {
        enqueueCalls = 0;
        closeCalls = 0;
        failNextEnqueue = true; // fail initial snapshot enqueue
        const response = await openCodeApp.request("http://localhost/runtime/events");
        expect(response.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(enqueueCalls).toBeGreaterThanOrEqual(1);
        expect(closeCalls).toBeGreaterThanOrEqual(1);

        const managedId = installManagedTarget({
          baseUrl: `http://127.0.0.1:${4100 + i}`,
          password: getOpenCodeAuthPassword(),
        });
        clearTarget();

        const followup = await openCodeApp.request("http://localhost/runtime/events");
        if (!followup.body) throw new Error("missing SSE body");
        const reader = followup.body.getReader();
        const state = { buffer: "" };
        try {
          const initial = await readSseEvents(reader, 1, state);
          const initialData = parseSseData(initial, "opencode.runtime_target")[0] as any;
          expect(initialData.mode).toBe("unresolved");
          expect(initialData.backendInstanceId).toBe(readBackendInstanceId());
          const nextId = installManagedTarget({
            baseUrl: `http://127.0.0.1:${4200 + i}`,
            password: getOpenCodeAuthPassword(),
          });
          const changes = await readSseEvents(reader, 1, state);
          expect(parseSseData(changes, "opencode.runtime_target")[0]).toEqual({
            backendInstanceId: readBackendInstanceId(),
            mode: "managed",
            targetRevision: initialData.targetRevision + 1,
            targetId: nextId,
          });
          expect(typeof managedId).toBe("number");
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
    } finally {
      (globalThis as any).ReadableStream = OriginalReadableStream;
    }
  });

  it("cleans up heartbeat timer and unsubscribes on heartbeat enqueue failure without listener accumulation", async () => {
    const OriginalReadableStream = globalThis.ReadableStream;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let heartbeatCallback: (() => void) | null = null;
    let heartbeatClears = 0;
    let closeCalls = 0;
    let failPing = false;

    (globalThis as any).setInterval = ((cb: () => void) => {
      heartbeatCallback = cb as () => void;
      return 12345 as any;
    }) as typeof setInterval;
    (globalThis as any).clearInterval = ((id: any) => {
      if (id === 12345) heartbeatClears += 1;
      return originalClearInterval(id);
    }) as typeof clearInterval;

    class HeartbeatFailingReadableStream<T> extends OriginalReadableStream<T> {
      constructor(underlyingSource?: UnderlyingSource<T>, strategy?: QueuingStrategy<T>) {
        if (underlyingSource && typeof underlyingSource.start === "function") {
          const originalStart = underlyingSource.start.bind(underlyingSource);
          underlyingSource.start = (controller: ReadableStreamDefaultController<T>) => {
            const originalEnqueue = controller.enqueue.bind(controller);
            const originalClose = controller.close.bind(controller);
            controller.enqueue = ((chunk: T) => {
              if (failPing) {
                const text =
                  typeof chunk === "string"
                    ? chunk
                    : new TextDecoder().decode(chunk as unknown as Uint8Array);
                if (text.includes(": ping")) {
                  throw new Error("synthetic heartbeat enqueue failure");
                }
              }
              return originalEnqueue(chunk);
            }) as typeof controller.enqueue;
            controller.close = (() => {
              closeCalls += 1;
              return originalClose();
            }) as typeof controller.close;
            return originalStart(controller);
          };
        }
        super(underlyingSource as any, strategy);
      }
    }

    (globalThis as any).ReadableStream = HeartbeatFailingReadableStream;
    try {
      for (let i = 0; i < 3; i++) {
        heartbeatCallback = null;
        heartbeatClears = 0;
        closeCalls = 0;
        failPing = false;

        const response = await openCodeApp.request("http://localhost/runtime/events");
        expect(response.status).toBe(200);
        if (!response.body) throw new Error("missing SSE body");
        const reader = response.body.getReader();
        const state = { buffer: "" };
        const initial = await readSseEvents(reader, 1, state);
        expect((parseSseData(initial, "opencode.runtime_target")[0] as any).backendInstanceId).toBe(
          readBackendInstanceId(),
        );
        expect(typeof heartbeatCallback).toBe("function");

        failPing = true;
        heartbeatCallback?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(heartbeatClears).toBeGreaterThanOrEqual(1);
        expect(closeCalls).toBeGreaterThanOrEqual(1);

        heartbeatCallback?.();
        heartbeatCallback?.();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const followup = await openCodeApp.request("http://localhost/runtime/events");
        if (!followup.body) throw new Error("missing SSE body");
        const reader2 = followup.body.getReader();
        const state2 = { buffer: "" };
        try {
          const snap = await readSseEvents(reader2, 1, state2);
          const snapData = parseSseData(snap, "opencode.runtime_target")[0] as any;
          const nextId = installManagedTarget({
            baseUrl: `http://127.0.0.1:${4400 + i}`,
            password: getOpenCodeAuthPassword(),
          });
          const changes = await readSseEvents(reader2, 1, state2);
          const changeData = parseSseData(changes, "opencode.runtime_target");
          expect(changeData).toHaveLength(1);
          expect(changeData[0]).toEqual({
            backendInstanceId: readBackendInstanceId(),
            mode: "managed",
            targetRevision: snapData.targetRevision + 1,
            targetId: nextId,
          });
        } finally {
          await reader2.cancel().catch(() => {});
        }
        await reader.cancel().catch(() => {});
      }
    } finally {
      (globalThis as any).ReadableStream = OriginalReadableStream;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it("abort and cancel cleanup are idempotent", async () => {
    const backendInstanceId = readBackendInstanceId();
    const controller = new AbortController();
    const response = await openCodeApp.request("http://localhost/runtime/events", {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    if (!response.body) throw new Error("missing SSE body");
    const reader = response.body.getReader();
    const state = { buffer: "" };
    const initial = await readSseEvents(reader, 1, state);
    expect(parseSseData(initial, "opencode.runtime_target")[0]).toEqual({
      backendInstanceId,
      mode: "unresolved",
      targetRevision: 0,
      targetId: null,
    });

    controller.abort();
    await reader.cancel().catch(() => {});
    await reader.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    const managedId = installManagedTarget({
      baseUrl: "http://127.0.0.1:4300",
      password: getOpenCodeAuthPassword(),
    });
    const followup = await openCodeApp.request("http://localhost/runtime/events");
    if (!followup.body) throw new Error("missing SSE body");
    const reader2 = followup.body.getReader();
    const state2 = { buffer: "" };
    try {
      const snap = await readSseEvents(reader2, 1, state2);
      expect(parseSseData(snap, "opencode.runtime_target")[0]).toEqual({
        backendInstanceId,
        mode: "managed",
        targetRevision: 1,
        targetId: managedId,
      });
    } finally {
      await reader2.cancel().catch(() => {});
    }
  });
});
