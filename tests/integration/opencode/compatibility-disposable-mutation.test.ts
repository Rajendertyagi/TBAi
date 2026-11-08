import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { OPENCODE_CONFIG } from "@/config/opencode.ts";
import {
  createRuntimeIsolation,
  runtimeTestsRequested,
  runtimeUnavailableReason,
  startRuntimeOpenCodeServer,
  type RuntimeOpenCodeServer,
} from "../../harness/opencodeRuntimeHarness.ts";
import {
  LazyCapabilityRegistry,
  SseStreamParser,
  extractSessionId,
  parseOpenCodeWireEvent,
  validateMessagesResponse,
  validateSessionListResponse,
  validateSessionStructure,
  type OpenCodeWireEvent,
} from "@/services/opencode/compatibility.ts";

/**
 * B7 — Mutation capabilities and live contract verification against a DISPOSABLE OpenCode instance.
 *
 * Requirements:
 *  - Tests actual mutation capabilities (session create, list, delete) against an isolated,
 *    ephemeral OpenCode instance spawned in an isolated temporary directory.
 *  - Verifies session and message response structures with B7 validators.
 *  - Verifies live SSE framing on the disposable instance.
 *  - Exercises lazy capability detection.
 *  - NEVER tests mutations or prompts against any adopted or user-running OpenCode instance.
 *
 * Gated by TBAI_OPENCODE_RUNTIME_TESTS=1.
 */

const reason = runtimeUnavailableReason();
const describeRuntime = runtimeTestsRequested() ? describe : describe.skip;

if (runtimeTestsRequested() && reason) {
  console.warn(`[opencode compatibility-runtime] enabled but unavailable: ${reason}`);
}

describeRuntime("B7 — Mutation capabilities on disposable OpenCode instance", () => {
  let server: RuntimeOpenCodeServer;
  const isolation = createRuntimeIsolation("b7-disposable-mutation");
  const lazyRegistry = new LazyCapabilityRegistry();
  let createdSessionId: string | null = null;

  beforeAll(async () => {
    server = await startRuntimeOpenCodeServer(OPENCODE_CONFIG, {}, { isolation });
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("verifies disposable instance is ready and reports valid info", async () => {
    const info = await server.json<{ version: string; pid: number }>("/api/info");
    expect(typeof info.version).toBe("string");
    expect(info.pid).toBeGreaterThan(0);
  });

  it("tests session.create mutation on disposable instance and validates structure", async () => {
    const supported = await lazyRegistry.detectLazily("session.create", async () => {
      const res = await fetch(`${server.baseUrl}/api/session`, {
        method: "POST",
        headers: {
          ...server.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!validateSessionStructure(data)) return false;
      createdSessionId = extractSessionId(data);
      return createdSessionId !== null;
    });

    expect(supported).toBe(true);
    expect(createdSessionId).not.toBeNull();
    expect(lazyRegistry.getCached("session.create")).toBe(true);
  });

  it("validates session list structure contains the created session", async () => {
    const sessions = await server.json<unknown>("/api/session");
    expect(validateSessionListResponse(sessions)).toBe(true);
    const list = Array.isArray(sessions)
      ? sessions
      : ((sessions as { data?: unknown[] }).data ?? []);
    expect(list.some((s) => (s as { id: string }).id === createdSessionId)).toBe(true);
  });

  it("tests session.message.list on disposable instance and validates response structure", async () => {
    expect(createdSessionId).not.toBeNull();
    const supported = await lazyRegistry.detectLazily("session.message.list", async () => {
      const res = await fetch(`${server.baseUrl}/api/session/${createdSessionId}/message`, {
        method: "GET",
        headers: server.headers,
      });
      if (!res.ok) return false;
      const data = await res.json();
      return validateMessagesResponse(data);
    });

    expect(supported).toBe(true);
    expect(lazyRegistry.getCached("session.message.list")).toBe(true);
  });

  it("verifies live SSE framing from the disposable instance event stream", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const res = await fetch(`${server.baseUrl}/api/event`, {
        headers: server.headers,
        signal: controller.signal,
      });

      expect(res.status).toBe(200);
      const contentType = res.headers.get("content-type") ?? "";
      expect(contentType.toLowerCase()).toContain("text/event-stream");

      const stream = res.body;
      expect(stream).not.toBeNull();
      const reader = stream!.getReader();
      const decoder = new TextDecoder();
      const parser = new SseStreamParser();
      const wireEvents: OpenCodeWireEvent[] = [];

      // Read initial frames from the live stream
      for (let i = 0; i < 5; i++) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const rawEvents = parser.feed(chunk);
        for (const raw of rawEvents) {
          const wire = parseOpenCodeWireEvent(raw);
          if (wire) wireEvents.push(wire);
        }
        if (wireEvents.length > 0) break;
      }

      await reader.cancel();
      expect(wireEvents.length).toBeGreaterThan(0);
      expect(typeof wireEvents[0]!.type).toBe("string");
      expect(wireEvents[0]!.type.length).toBeGreaterThan(0);
    } finally {
      clearTimeout(timeout);
    }
  });

  it("tests session.delete mutation on disposable instance and cleans up", async () => {
    expect(createdSessionId).not.toBeNull();
    const supported = await lazyRegistry.detectLazily("session.delete", async () => {
      const res = await fetch(`${server.baseUrl}/api/session/${createdSessionId}`, {
        method: "DELETE",
        headers: server.headers,
      });
      return res.ok || res.status === 204;
    });

    expect(supported).toBe(true);
    expect(lazyRegistry.getCached("session.delete")).toBe(true);

    // Verify session is no longer in the list
    const sessions = await server.json<{ data?: { id: string }[] } | { id: string }[]>(
      "/api/session",
    );
    const list = Array.isArray(sessions) ? sessions : (sessions.data ?? []);
    expect(list.some((s) => s.id === createdSessionId)).toBe(false);
  });
});
