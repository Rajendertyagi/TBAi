import { afterEach, describe, expect, it } from "bun:test";
import {
  beginShutdown,
  clearTarget,
  installAdoptedTarget,
  installManagedTarget,
  resetConnectionStateForTests,
  subscribeRuntimeTargetChanges,
  type OpenCodeRuntimeTargetChange,
} from "@/services/opencode/connectionState.ts";
import type { OpenCodeServiceCapabilities } from "@/services/opencode/compatibility.ts";
import { getOpenCodeAuthPassword } from "@/services/opencode/runtime.ts";

const CAPABILITIES: OpenCodeServiceCapabilities = {
  version: "2.2.0",
  supported: {
    session: true,
    events: true,
    config: false,
    agent: true,
    model: true,
    command: true,
  },
};

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
  it("publishes target identity changes on install, replace, clear, managed/adopted transitions and shutdown", async () => {
    const seen: OpenCodeRuntimeTargetChange[] = [];
    const unsubscribe = subscribeRuntimeTargetChanges((change) => seen.push(change));
    try {
      const managedId = installManagedTarget({
        baseUrl: "http://127.0.0.1:4096",
        password: getOpenCodeAuthPassword(),
      });
      expect(seen.at(-1)).toEqual({ mode: "managed", targetRevision: 1, targetId: managedId });

      const adoptedId = installAdoptedTarget({
        origin: "http://127.0.0.1:5055",
        password: "synthetic-adopted-password",
        capabilities: CAPABILITIES,
      });
      expect(seen.at(-1)).toEqual({ mode: "adopted", targetRevision: 2, targetId: adoptedId });

      clearTarget();
      expect(seen.at(-1)).toEqual({ mode: "unresolved", targetRevision: 3, targetId: null });

      const restoredId = installAdoptedTarget({
        origin: "http://127.0.0.1:5055",
        password: "synthetic-adopted-password",
        capabilities: CAPABILITIES,
      });
      expect(seen.at(-1)).toEqual({ mode: "adopted", targetRevision: 4, targetId: restoredId });

      await beginShutdown();
      expect(seen.at(-1)).toEqual({ mode: "unresolved", targetRevision: 5, targetId: null });
    } finally {
      unsubscribe();
    }
  });

  it("streams current target and lifecycle changes over /runtime/events without remount or recovery epoch", async () => {
    const response = await openCodeApp.request("http://localhost/runtime/events");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    if (!response.body) throw new Error("missing SSE body");

    const reader = response.body.getReader();
    const state = { buffer: "" };
    try {
      const initial = await readSseEvents(reader, 1, state);
      expect(parseSseData(initial, "opencode.runtime_target")[0]).toEqual({
        mode: "unresolved",
        targetRevision: 0,
        targetId: null,
      });

      const managedId = installManagedTarget({
        baseUrl: "http://127.0.0.1:4096",
        password: getOpenCodeAuthPassword(),
      });
      const adoptedId = installAdoptedTarget({
        origin: "http://127.0.0.1:5055",
        password: "synthetic-adopted-password",
        capabilities: CAPABILITIES,
      });
      clearTarget();
      const restoredId = installManagedTarget({
        baseUrl: "http://127.0.0.1:4097",
        password: getOpenCodeAuthPassword(),
      });

      const changes = await readSseEvents(reader, 4, state);
      expect(parseSseData(changes, "opencode.runtime_target")).toEqual([
        { mode: "managed", targetRevision: 1, targetId: managedId },
        { mode: "adopted", targetRevision: 2, targetId: adoptedId },
        { mode: "unresolved", targetRevision: 3, targetId: null },
        { mode: "managed", targetRevision: 4, targetId: restoredId },
      ]);
    } finally {
      await reader.cancel().catch(() => {});
    }
  });
});
