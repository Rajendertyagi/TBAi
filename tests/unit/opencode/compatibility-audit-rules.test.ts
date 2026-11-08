import { describe, expect, it } from "bun:test";
import {
  LazyCapabilityRegistry,
  SseStreamParser,
  consumeEventStreamWithReconnection,
  extractSessionId,
  isPermissionEventType,
  isToolCallEventType,
  parseOpenCodeWireEvent,
  validateMessageStructure,
  validateMessagesResponse,
  validatePermissionEvent,
  validateSessionListResponse,
  validateSessionStructure,
  validateToolCallEvent,
  type OpenCodeWireEvent,
  type SseRawEvent,
} from "@/services/opencode/compatibility";

describe("B7 Audit — RULE 2: SSE parser compliance", () => {
  // 1. Multiple events in one chunk
  it("parses multiple events delivered in a single chunk", () => {
    const parser = new SseStreamParser();
    const chunk =
      'event: ev1\ndata: {"type":"event.one"}\n\nevent: ev2\ndata: {"type":"event.two"}\n\n';
    const events = parser.feed(chunk);
    expect(events.length).toBe(2);
    expect(events[0]!.event).toBe("ev1");
    expect(events[0]!.data).toBe('{"type":"event.one"}');
    expect(events[1]!.event).toBe("ev2");
    expect(events[1]!.data).toBe('{"type":"event.two"}');
  });

  // 2. Events split across arbitrary chunks
  it("parses events split across arbitrary byte/character chunks", () => {
    const parser = new SseStreamParser();
    expect(parser.feed('data: {"type":').length).toBe(0);
    expect(parser.feed('"streaming",').length).toBe(0);
    expect(parser.feed('"val":1}\n').length).toBe(0);
    const events = parser.feed("\n");
    expect(events.length).toBe(1);
    expect(events[0]!.data).toBe('{"type":"streaming","val":1}');
  });

  // 3. Split field names
  it("parses field names split across chunks", () => {
    const parser = new SseStreamParser();
    expect(parser.feed("d").length).toBe(0);
    expect(parser.feed("at").length).toBe(0);
    expect(parser.feed('a: {"type":"split.field"}\n\n').length).toBe(1);
  });

  // 4. CRLF, CR and LF delimiters
  it("handles CRLF, standalone CR, and LF line delimiters", () => {
    // CRLF
    const p1 = new SseStreamParser();
    const e1 = p1.feed('data: {"type":"crlf"}\r\n\r\n');
    expect(e1.length).toBe(1);
    expect(e1[0]!.data).toBe('{"type":"crlf"}');

    // Standalone LF
    const p2 = new SseStreamParser();
    const e2 = p2.feed('data: {"type":"lf"}\n\n');
    expect(e2.length).toBe(1);
    expect(e2[0]!.data).toBe('{"type":"lf"}');

    // Standalone CR
    const p3 = new SseStreamParser();
    // feed with trailing character after CR so it's not held as potential CRLF
    const e3 = p3.feed('data: {"type":"cr"}\r\r');
    const flushed3 = p3.flush();
    const all3 = [...e3, ...flushed3];
    expect(all3.length).toBe(1);
    expect(all3[0]!.data).toBe('{"type":"cr"}');
  });

  // 5. Multiple data fields
  it("concatenates multiple data fields with a newline per W3C SSE standard", () => {
    const parser = new SseStreamParser();
    const chunk = "data: line 1\ndata: line 2\ndata: line 3\n\n";
    const events = parser.feed(chunk);
    expect(events.length).toBe(1);
    expect(events[0]!.data).toBe("line 1\nline 2\nline 3");
  });

  // 6. Empty data fields
  it("handles empty data fields correctly", () => {
    const parser = new SseStreamParser();
    const chunk = "data:\n\n";
    const events = parser.feed(chunk);
    expect(events.length).toBe(1);
    expect(events[0]!.data).toBe("");

    // Multiple empty data fields produce newlines
    const parser2 = new SseStreamParser();
    const chunk2 = "data:\ndata:\n\n";
    const events2 = parser2.feed(chunk2);
    expect(events2.length).toBe(1);
    expect(events2[0]!.data).toBe("\n");
  });

  // 7. Comment and heartbeat events
  it("ignores comments and keep-alive lines beginning with colon", () => {
    const parser = new SseStreamParser();
    const chunk = ':keepalive\n: this is a comment\n\ndata: {"type":"real"}\n\n';
    const events = parser.feed(chunk);
    expect(events.length).toBe(1);
    expect(events[0]!.data).toBe('{"type":"real"}');
  });

  // 8. UTF-8 characters split across byte boundaries
  it("handles multi-byte UTF-8 characters when decoded with stream:true", () => {
    const decoder = new TextDecoder("utf-8");
    const parser = new SseStreamParser();

    // Multi-byte character: '🚀' is 4 bytes [0xF0, 0x9F, 0x99, 0x80]
    const fullJson = 'data: {"type":"emoji","symbol":"🚀"}\n\n';
    const fullBytes = new TextEncoder().encode(fullJson);

    // Split across the 4-byte emoji (e.g. 2 bytes in chunk 1, 2 bytes in chunk 2)
    const splitIndex = 33; // right in middle of emoji
    const chunk1Bytes = fullBytes.subarray(0, splitIndex);
    const chunk2Bytes = fullBytes.subarray(splitIndex);

    const str1 = decoder.decode(chunk1Bytes, { stream: true });
    const str2 = decoder.decode(chunk2Bytes, { stream: true });

    const ev1 = parser.feed(str1);
    expect(ev1.length).toBe(0);
    const ev2 = parser.feed(str2);
    expect(ev2.length).toBe(1);

    const wire = parseOpenCodeWireEvent(ev2[0]!);
    expect(wire?.type).toBe("emoji");
    expect((wire?.data as Record<string, unknown>)?.symbol ?? JSON.parse(ev2[0]!.data).symbol).toBe(
      "🚀",
    );
  });

  // 9. Malformed JSON
  it("gracefully returns null for malformed JSON data in parseOpenCodeWireEvent", () => {
    const parser = new SseStreamParser();
    const events = parser.feed("data: { bad json }\n\n");
    expect(events.length).toBe(1);
    expect(parseOpenCodeWireEvent(events[0]!)).toBeNull();
  });

  // 10. Unknown event types
  it("preserves unknown event types faithfully without crashing", () => {
    const raw: SseRawEvent = {
      data: JSON.stringify({ type: "custom.plugin.unknown", value: 42 }),
    };
    const wire = parseOpenCodeWireEvent(raw);
    expect(wire).not.toBeNull();
    expect(wire!.type).toBe("custom.plugin.unknown");
  });

  // 11. Incomplete final frames
  it("discards incomplete final frames when flush is called per W3C specification", () => {
    const parser = new SseStreamParser();
    // Incomplete: no terminating empty line
    const events = parser.feed('data: {"type":"incomplete"}');
    expect(events.length).toBe(0);
    const flushed = parser.flush();
    expect(flushed.length).toBe(0);
    expect(parser.pendingRemainder).toBe("");
  });

  // 12. Empty streams and stream termination
  it("handles empty stream cleanly without generating phantom events", () => {
    const parser = new SseStreamParser();
    expect(parser.feed("").length).toBe(0);
    expect(parser.flush().length).toBe(0);
  });
});

describe("B7 Audit — RULE 3: Reconnection behavior", () => {
  it("handles unexpected disconnect and reconnects successfully", async () => {
    let callCount = 0;
    const events: OpenCodeWireEvent[] = [];
    const controller = new AbortController();

    const fetchStream = async () => {
      callCount++;
      if (callCount === 1) {
        // First connection yields 1 event then abruptly terminates
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"type":"stream.event.1"}\n\n'));
            c.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      // Reconnected stream yields event 2
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"type":"stream.event.2"}\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    };

    const reconnectAttempts: number[] = [];
    const outcome = await consumeEventStreamWithReconnection(
      fetchStream,
      (ev) => {
        events.push(ev);
        if (events.length === 2) controller.abort();
      },
      {
        signal: controller.signal,
        reconnectOptions: { maxAttempts: 3, initialDelayMs: 2 },
        onReconnect: (attempt) => reconnectAttempts.push(attempt),
      },
    );

    expect(outcome.completedCleanly).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["stream.event.1", "stream.event.2"]);
    expect(reconnectAttempts).toEqual([1]);
  });

  it("terminates when retry budget is exhausted", async () => {
    let attempts = 0;
    const controller = new AbortController();
    const fetchStream = async () => {
      attempts++;
      throw new Error("Network offline");
    };

    const outcome = await consumeEventStreamWithReconnection(fetchStream, () => undefined, {
      signal: controller.signal,
      reconnectOptions: { maxAttempts: 3, initialDelayMs: 2 },
    });

    expect(outcome.completedCleanly).toBe(false);
    expect(outcome.disconnectCount).toBe(3);
    expect(attempts).toBe(3);
  });

  it("applies exponential backoff across retries", async () => {
    const controller = new AbortController();
    const retryTimestamps: number[] = [];
    const start = Date.now();

    const fetchStream = async () => {
      retryTimestamps.push(Date.now() - start);
      throw new Error("Fail");
    };

    await consumeEventStreamWithReconnection(fetchStream, () => undefined, {
      signal: controller.signal,
      reconnectOptions: { maxAttempts: 3, initialDelayMs: 20, maxDelayMs: 100 },
    });

    expect(retryTimestamps.length).toBe(3);
    // Delay 1 -> ~20ms, Delay 2 -> ~40ms
    const gap1 = retryTimestamps[1]! - retryTimestamps[0]!;
    const gap2 = retryTimestamps[2]! - retryTimestamps[1]!;
    expect(gap1).toBeGreaterThanOrEqual(15);
    expect(gap2).toBeGreaterThanOrEqual(30);
  });

  it("immediately aborts during active connection", async () => {
    const controller = new AbortController();
    let abortedAtFetch = false;

    const fetchStream = async (signal: AbortSignal) => {
      controller.abort();
      if (signal.aborted) {
        abortedAtFetch = true;
        const err = new DOMException("The user aborted a request.", "AbortError");
        throw err;
      }
      return new Response(new ReadableStream(), { status: 200 });
    };

    const outcome = await consumeEventStreamWithReconnection(fetchStream, () => undefined, {
      signal: controller.signal,
      reconnectOptions: { maxAttempts: 3 },
    });

    expect(outcome.completedCleanly).toBe(true);
    expect(abortedAtFetch).toBe(true);
  });

  it("immediately aborts during retry delay without hanging", async () => {
    const controller = new AbortController();
    let callCount = 0;

    const fetchStream = async () => {
      callCount++;
      throw new Error("First failure");
    };

    const startTime = Date.now();
    const promise = consumeEventStreamWithReconnection(fetchStream, () => undefined, {
      signal: controller.signal,
      reconnectOptions: { maxAttempts: 5, initialDelayMs: 1000 }, // long delay
      onReconnect: () => {
        // Abort during delay!
        setTimeout(() => controller.abort(), 20);
      },
    });

    const outcome = await promise;
    const elapsed = Date.now() - startTime;

    expect(outcome.completedCleanly).toBe(true);
    // Should complete in < 200ms, NOT wait 1000ms
    expect(elapsed).toBeLessThan(500);
    expect(callCount).toBe(1);
  });
});

describe("B7 Audit — RULE 4: Session and message response validation", () => {
  it("validates empty and populated session lists", () => {
    // Empty bare array
    expect(validateSessionListResponse([])).toBe(true);
    // Empty data envelope (OpenCode 2.2.0 style)
    expect(validateSessionListResponse({ data: [] })).toBe(true);
    // Populated bare array
    expect(validateSessionListResponse([{ id: "ses_1" }, { id: "ses_2" }])).toBe(true);
    // Populated data envelope
    expect(validateSessionListResponse({ data: [{ id: "ses_1" }] })).toBe(true);
    // Missing id in list
    expect(validateSessionListResponse([{ title: "No id" }])).toBe(false);
    expect(validateSessionListResponse({ data: [{ title: "No id" }] })).toBe(false);
  });

  it("validates session object shapes and extractSessionId", () => {
    expect(validateSessionStructure({ id: "ses_abc" })).toBe(true);
    expect(validateSessionStructure({ id: "" })).toBe(false);
    expect(extractSessionId({ id: "ses_abc" })).toBe("ses_abc");
    expect(extractSessionId({ data: { id: "ses_envelope" } })).toBe("ses_envelope");
    expect(extractSessionId({ id: "" })).toBeNull();
    expect(extractSessionId({ id: "   " })).toBeNull();
    expect(extractSessionId({ data: { id: "" } })).toBeNull();
    expect(extractSessionId(null)).toBeNull();
    expect(extractSessionId("primitive")).toBeNull();
  });

  it("validates message records and role handling", () => {
    expect(validateMessageStructure({ id: "msg_1", role: "user" })).toBe(true);
    expect(validateMessageStructure({ id: "msg_2", role: "assistant" })).toBe(true);
    expect(validateMessageStructure({ id: "msg_3", role: "system" })).toBe(true);
    expect(validateMessageStructure({ id: "msg_4" })).toBe(true); // role optional
    expect(validateMessageStructure({ id: "msg_5", role: 123 })).toBe(false); // invalid role type
    expect(validateMessageStructure({ role: "user" })).toBe(false); // missing id
  });

  it("validates empty and populated message list responses", () => {
    expect(validateMessagesResponse([])).toBe(true);
    expect(validateMessagesResponse({ data: [] })).toBe(true);
    expect(validateMessagesResponse({ data: [], cursor: { previous: null, next: null } })).toBe(
      true,
    );
    expect(validateMessagesResponse({ data: [{ id: "msg_1", role: "user" }] })).toBe(true);
    expect(validateMessagesResponse({ data: [{ id: "" }] })).toBe(false);
    expect(validateMessagesResponse({ invalid: true })).toBe(false);
  });
});

describe("B7 Audit — RULE 5: Lazy capability detection", () => {
  it("performs first-request detection and caches result", async () => {
    const registry = new LazyCapabilityRegistry();
    let probes = 0;
    const probe = async () => {
      probes++;
      return true;
    };

    const res1 = await registry.detectLazily("session.create", probe);
    expect(res1).toBe(true);
    expect(probes).toBe(1);

    // Second request is cached
    const res2 = await registry.detectLazily("session.create", probe);
    expect(res2).toBe(true);
    expect(probes).toBe(1);
  });

  it("caches failed detection as unsupported", async () => {
    const registry = new LazyCapabilityRegistry();
    let probes = 0;
    const failingProbe = async () => {
      probes++;
      throw new Error("404 Not Found");
    };

    const res1 = await registry.detectLazily("command.execute", failingProbe);
    expect(res1).toBe(false);
    expect(probes).toBe(1);

    const res2 = await registry.detectLazily("command.execute", failingProbe);
    expect(res2).toBe(false);
    expect(probes).toBe(1);
  });

  it("deduplicates concurrent requests in flight (single-flight)", async () => {
    const registry = new LazyCapabilityRegistry();
    let probeCalls = 0;

    const slowProbe = async () => {
      probeCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return true;
    };

    // 5 concurrent requests
    const results = await Promise.all([
      registry.detectLazily("session.create", slowProbe),
      registry.detectLazily("session.create", slowProbe),
      registry.detectLazily("session.create", slowProbe),
      registry.detectLazily("session.create", slowProbe),
      registry.detectLazily("session.create", slowProbe),
    ]);

    expect(results).toEqual([true, true, true, true, true]);
    expect(probeCalls).toBe(1); // exactly 1 probe call executed!
  });

  it("clears cache and prevents stale capabilities across service replacement", () => {
    const registry = new LazyCapabilityRegistry("server-A");
    registry.recordCapability("session.create", true);
    expect(registry.getCached("session.create")).toBe(true);

    // Bind to same server keeps cache
    registry.bindToService("server-A");
    expect(registry.getCached("session.create")).toBe(true);

    // Bind to new server (restart / replacement) clears cache
    registry.bindToService("server-B");
    expect(registry.getCached("session.create")).toBeUndefined();
    expect(registry.serviceIdentity).toBe("server-B");
  });
});

describe("B7 Audit — RULE 6: Tool and permission events", () => {
  it("classifies tool call event types across lifecycle and input streaming", () => {
    expect(isToolCallEventType("session.tool.called")).toBe(true);
    expect(isToolCallEventType("session.tool.progress")).toBe(true);
    expect(isToolCallEventType("session.tool.success")).toBe(true);
    expect(isToolCallEventType("session.tool.failed")).toBe(true);
    expect(isToolCallEventType("session.tool.input.started")).toBe(true);
    expect(isToolCallEventType("session.tool.input.delta")).toBe(true);
    expect(isToolCallEventType("session.tool.input.ended")).toBe(true);
    expect(isToolCallEventType("session.text.started")).toBe(false);
  });

  it("validates tool call event payloads (top-level and envelope data)", () => {
    expect(
      validateToolCallEvent({
        type: "session.tool.called",
        data: { callID: "call_1", tool: "read_file" },
      }),
    ).toBe(true);

    expect(
      validateToolCallEvent({
        type: "session.tool.called",
        data: { callId: "call_2", name: "write_file" },
      }),
    ).toBe(true);

    // Missing callId
    expect(
      validateToolCallEvent({
        type: "session.tool.called",
        data: { tool: "read_file" },
      }),
    ).toBe(false);

    // Missing tool in session.tool.called
    expect(
      validateToolCallEvent({
        type: "session.tool.called",
        data: { callID: "call_1" },
      }),
    ).toBe(false);

    // Valid progress / success / failed
    expect(
      validateToolCallEvent({
        type: "session.tool.success",
        data: { callID: "call_1" },
      }),
    ).toBe(true);
    expect(
      validateToolCallEvent({
        type: "session.tool.failed",
        data: { callID: "call_1", error: "fail" },
      }),
    ).toBe(true);
  });

  it("classifies and validates permission request and reply events", () => {
    expect(isPermissionEventType("permission.asked")).toBe(true);
    expect(isPermissionEventType("permission.replied")).toBe(true);
    expect(isPermissionEventType("session.idle")).toBe(false);

    expect(
      validatePermissionEvent({
        type: "permission.asked",
        data: { id: "p_1" },
      }),
    ).toBe(true);

    expect(
      validatePermissionEvent({
        type: "permission.replied",
        data: { id: "p_1", decision: "granted" },
      }),
    ).toBe(true);

    expect(
      validatePermissionEvent({
        type: "permission.replied",
        data: { id: "p_1", decision: "denied" },
      }),
    ).toBe(true);

    // Invalid decision
    expect(
      validatePermissionEvent({
        type: "permission.replied",
        data: { id: "p_1", decision: "unknown" as unknown as "granted" },
      }),
    ).toBe(false);

    // Missing id
    expect(
      validatePermissionEvent({
        type: "permission.asked",
        data: {},
      }),
    ).toBe(false);
  });
});
