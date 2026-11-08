import { describe, expect, it } from "bun:test";
import { OPENCODE_CONFIG } from "@/config/opencode.ts";
import { OpenCodeAttemptSupersededError } from "@/services/opencode/connectionState.ts";
import {
  OPENCODE_CAPABILITY_PROBES,
  assessOpenCodeCompatibility,
  classifyAdoptionVersion,
  consumeEventStreamWithReconnection,
  essentialCapabilities,
  isCapabilitySupported,
  isEssentialCapability,
  isPermissionEventType,
  isToolCallEventType,
  LazyCapabilityRegistry,
  lazyCapabilityRegistry,
  opencodeCapabilityIds,
  parseOpenCodeWireEvent,
  probeOpenCodeCapabilities,
  SseStreamParser,
  validateMessageStructure,
  validateMessagesResponse,
  validatePermissionEvent,
  validateSessionListResponse,
  validateSessionStructure,
  validateToolCallEvent,
  type OpenCodeCapabilityId,
  type OpenCodeCapabilityProbeOutcome,
  type OpenCodeWireEvent,
} from "@/services/opencode/compatibility.ts";
import type { OpenCodeTransport } from "@/services/opencode/http.ts";

/**
 * B7 — the compatibility policy for an adopted service.
 *
 * These cases exercise the policy in isolation: a stubbed transport answers
 * each route, and nothing here starts a process, reads a registration file or
 * touches a real service. What this cannot prove is compatibility END TO END —
 * a prompt round trip on a given build — which stays E1/B5 evidence.
 */

const ORIGIN = "http://127.0.0.1:4310";
const VERSION = "2.2.0";

const EVENT_STREAM_HEADERS = { "content-type": "text/event-stream" } as const;

function transportFrom(respond: (url: string) => Response | Promise<Response>): {
  transport: OpenCodeTransport;
  calls: string[];
} {
  const calls: string[] = [];
  const fn = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return respond(url);
  };
  return {
    transport: Object.assign(fn, { preconnect: globalThis.fetch.preconnect }),
    calls,
  };
}

function allPresent(): Record<OpenCodeCapabilityId, OpenCodeCapabilityProbeOutcome> {
  return {
    session: "present",
    events: "present",
    config: "present",
    agent: "present",
    model: "present",
    command: "present",
  };
}

describe("B7 — classifyAdoptionVersion enforces 2.2.0+ stable releases only", () => {
  const atOrAboveFloor = ["2.2.0", "2.2.1", "2.4.0", "99.0.0"];

  for (const version of atOrAboveFloor) {
    it(`admits the stable build ${version}`, () => {
      expect(classifyAdoptionVersion(version)).toEqual({
        status: "adoptable",
        version,
      });
    });
  }

  it("refuses builds below the minimum version (2.2.0)", () => {
    for (const version of ["2.1.4", "2.0.15", "2.0.14", "1.9.9", "0.5.0"]) {
      expect(classifyAdoptionVersion(version)).toEqual({
        status: "below_minimum",
        version,
        minimumVersion: "2.2.0",
      });
    }
  });

  it("takes the minimum version from the supplied config", () => {
    const config = { ...OPENCODE_CONFIG, minimumVersion: "2.3.0" };
    expect(classifyAdoptionVersion("2.2.0", config)).toEqual({
      status: "below_minimum",
      version: "2.2.0",
      minimumVersion: "2.3.0",
    });
    expect(classifyAdoptionVersion("2.3.0", config)).toEqual({
      status: "adoptable",
      version: "2.3.0",
    });
  });

  it("refuses a prerelease build (D2 stable-only)", () => {
    for (const version of ["2.2.0-beta.1", "2.2.0-rc.2", "2.2.0-next"]) {
      expect(classifyAdoptionVersion(version).status).toBe("unstable");
    }
  });

  it("ignores build metadata, which is not a channel marker", () => {
    expect(classifyAdoptionVersion("2.2.0+sha.abc123").status).toBe("adoptable");
  });

  it("refuses a malformed version", () => {
    for (const version of ["latest", "2.2", "v", ""]) {
      expect(classifyAdoptionVersion(version).status).toBe("malformed");
    }
  });
});

describe("B7 — probeOpenCodeCapabilities reads each route once", () => {
  it("probes the documented routes in table order", async () => {
    const { transport, calls } = transportFrom(
      () => new Response("", { status: 200, headers: EVENT_STREAM_HEADERS }),
    );

    await probeOpenCodeCapabilities({ origin: ORIGIN, transport });

    expect(opencodeCapabilityIds()).toEqual([
      "session",
      "events",
      "config",
      "agent",
      "model",
      "command",
    ]);
    expect(calls).toEqual(OPENCODE_CAPABILITY_PROBES.map((probe) => `${ORIGIN}${probe.path}`));
  });

  it("maps status to presence: 2xx present, 404/405 missing, anything else unknown", async () => {
    const statuses: Record<string, number> = {
      "/api/session": 200,
      "/api/event": 200,
      "/api/config": 404,
      "/api/agent": 405,
      "/api/model": 500,
      "/api/command": 401,
    };
    const { transport } = transportFrom((url) => {
      const path = new URL(url).pathname;
      const headers = path === "/api/event" ? EVENT_STREAM_HEADERS : undefined;
      return new Response("", { status: statuses[path] ?? 500, headers });
    });

    const probes = await probeOpenCodeCapabilities({ origin: ORIGIN, transport });

    expect(probes).toEqual({
      session: "present",
      events: "present",
      config: "missing",
      agent: "missing",
      model: "unknown",
      command: "unknown",
    });
  });

  it("requires the event route to actually stream", async () => {
    const { transport } = transportFrom((url) =>
      url.endsWith("/api/event") ? Response.json({ ok: true }) : new Response("", { status: 200 }),
    );

    const probes = await probeOpenCodeCapabilities({ origin: ORIGIN, transport });
    expect(probes.events).toBe("unknown");
  });

  it("treats a transport failure as unknown, not missing", async () => {
    const { transport } = transportFrom(() => {
      throw new Error("ECONNRESET");
    });

    const probes = await probeOpenCodeCapabilities({ origin: ORIGIN, transport });
    for (const id of opencodeCapabilityIds()) expect(probes[id]).toBe("unknown");
  });

  it("rethrows an attempt refusal instead of recording it as probe data", async () => {
    const { transport } = transportFrom(() => {
      throw new OpenCodeAttemptSupersededError(7);
    });

    await expect(probeOpenCodeCapabilities({ origin: ORIGIN, transport })).rejects.toBeInstanceOf(
      OpenCodeAttemptSupersededError,
    );
  });

  it("cancels every response body", async () => {
    let cancelled = 0;
    const { transport } = transportFrom((url) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x"));
        },
        cancel() {
          cancelled += 1;
        },
      });
      const headers = url.endsWith("/api/event") ? EVENT_STREAM_HEADERS : undefined;
      return new Response(body, { status: 200, headers });
    });

    await probeOpenCodeCapabilities({ origin: ORIGIN, transport });
    expect(cancelled).toBe(OPENCODE_CAPABILITY_PROBES.length);
  });
});

describe("B7 — assessOpenCodeCompatibility decides adoption", () => {
  it("is compatible when every route answers", () => {
    const assessment = assessOpenCodeCompatibility({ version: VERSION, probes: allPresent() });
    expect(assessment.status).toBe("compatible");
    expect(assessment.capabilities.version).toBe(VERSION);
    expect(assessment.capabilities.supported.session).toBe(true);
  });

  it("degrades when an optional route is absent and still admits the service", () => {
    const assessment = assessOpenCodeCompatibility({
      version: VERSION,
      probes: { ...allPresent(), config: "missing", command: "missing" },
    });

    expect(assessment.status).toBe("degraded");
    if (assessment.status !== "degraded") return;
    expect(assessment.missingOptional).toEqual(["config", "command"]);
    expect(assessment.capabilities.supported.config).toBe(false);
    expect(assessment.capabilities.supported.session).toBe(true);
  });

  it("is incompatible when an essential route is absent", () => {
    const assessment = assessOpenCodeCompatibility({
      version: VERSION,
      probes: { ...allPresent(), session: "missing" },
    });

    expect(assessment.status).toBe("incompatible");
    if (assessment.status !== "incompatible") return;
    expect(assessment.missingEssential).toEqual(["session"]);
    expect(assessment.capabilities.supported.session).toBe(false);
  });

  it("is indeterminate when an essential route could not be read", () => {
    const assessment = assessOpenCodeCompatibility({
      version: VERSION,
      probes: { ...allPresent(), events: "unknown" },
    });

    expect(assessment.status).toBe("indeterminate");
    if (assessment.status !== "indeterminate") return;
    expect(assessment.unknownEssential).toEqual(["events"]);
  });

  it("lets an absent essential route outrank an unread one", () => {
    const assessment = assessOpenCodeCompatibility({
      version: VERSION,
      probes: { ...allPresent(), session: "missing", events: "unknown" },
    });

    expect(assessment.status).toBe("incompatible");
    if (assessment.status === "incompatible") {
      expect(assessment.missingEssential).toEqual(["session"]);
    }
  });

  it("records an unread optional route as supported rather than hiding the feature", () => {
    const assessment = assessOpenCodeCompatibility({
      version: VERSION,
      probes: { ...allPresent(), model: "unknown" },
    });

    expect(assessment.status).toBe("compatible");
    expect(assessment.capabilities.supported.model).toBe(true);
  });
});

describe("B7 — capability helpers", () => {
  it("names the essential capabilities", () => {
    expect(essentialCapabilities()).toEqual(["session", "events"]);
    expect(isEssentialCapability("session")).toBe(true);
    expect(isEssentialCapability("events")).toBe(true);
    for (const id of ["config", "agent", "model", "command"] as const) {
      expect(isEssentialCapability(id)).toBe(false);
    }
  });

  it("treats an unassessed service as fully capable", () => {
    for (const id of opencodeCapabilityIds()) expect(isCapabilitySupported(null, id)).toBe(true);
  });

  it("reports only a recorded absence as unsupported", () => {
    const supported: Record<OpenCodeCapabilityId, boolean> = {
      session: true,
      events: true,
      config: false,
      agent: true,
      model: true,
      command: true,
    };
    const capabilities = { version: VERSION, supported };

    expect(isCapabilitySupported(capabilities, "config")).toBe(false);
    expect(isCapabilitySupported(capabilities, "session")).toBe(true);
  });
});

// ============================================================================
// Priority 1 — Session and message response structure validation
// ============================================================================

describe("B7 — Priority 1: session & message response structure validation", () => {
  it("validates session object structure", () => {
    expect(validateSessionStructure({ id: "ses_123" })).toBe(true);
    expect(
      validateSessionStructure({ id: "ses_123", title: "My Session", projectID: "proj_1" }),
    ).toBe(true);
    expect(validateSessionStructure(null)).toBe(false);
    expect(validateSessionStructure({})).toBe(false);
    expect(validateSessionStructure({ id: "" })).toBe(false);
    expect(validateSessionStructure({ id: 123 })).toBe(false);
  });

  it("validates session list response", () => {
    expect(validateSessionListResponse([])).toBe(true);
    expect(validateSessionListResponse([{ id: "ses_1" }, { id: "ses_2" }])).toBe(true);
    expect(validateSessionListResponse([{ id: "ses_1" }, { invalid: true }])).toBe(false);
    expect(validateSessionListResponse(null)).toBe(false);
    expect(validateSessionListResponse("not an array")).toBe(false);
  });

  it("validates message object structure", () => {
    expect(validateMessageStructure({ id: "msg_1", role: "user" })).toBe(true);
    expect(validateMessageStructure({ id: "msg_2", role: "assistant", parts: [] })).toBe(true);
    expect(validateMessageStructure({ id: "msg_3" })).toBe(true); // role optional in wire
    expect(validateMessageStructure({ id: "", role: "user" })).toBe(false);
    expect(validateMessageStructure({ id: "msg_4", role: 123 })).toBe(false);
    expect(validateMessageStructure(null)).toBe(false);
  });

  it("validates messages response envelopes and arrays", () => {
    const validList = [{ id: "msg_1", role: "user" }];
    expect(validateMessagesResponse(validList)).toBe(true);
    expect(validateMessagesResponse([])).toBe(true);
    expect(validateMessagesResponse({ data: validList })).toBe(true);
    expect(validateMessagesResponse({ data: validList, cursor: { next: "cursor_1" } })).toBe(true);
    expect(validateMessagesResponse({ data: [{ id: "" }] })).toBe(false);
    expect(validateMessagesResponse({ other: "field" })).toBe(false);
    expect(validateMessagesResponse(null)).toBe(false);
  });
});

// ============================================================================
// Priority 2 — SSE framing and parsing (fragmented chunks & malformed events)
// ============================================================================

describe("B7 — Priority 2: SSE framing and parsing", () => {
  it("parses single complete SSE event", () => {
    const parser = new SseStreamParser();
    const raw = 'event: session.created\ndata: {"type":"session.created","id":"ev_1"}\n\n';
    const events = parser.feed(raw);
    expect(events.length).toBe(1);
    expect(events[0]!.event).toBe("session.created");
    expect(events[0]!.data).toBe('{"type":"session.created","id":"ev_1"}');

    const parsed = parseOpenCodeWireEvent(events[0]!);
    expect(parsed).toEqual({
      type: "session.created",
      id: "ev_1",
      created: undefined,
      data: undefined,
      durable: undefined,
    });
  });

  it("handles fragmented chunks split across field names and data", () => {
    const parser = new SseStreamParser();
    // Chunk 1: partial field name
    let events = parser.feed("da");
    expect(events.length).toBe(0);

    // Chunk 2: rest of data line
    events = parser.feed('ta: {"type":"server.connected"}\n');
    expect(events.length).toBe(0);

    // Chunk 3: delimiter newline
    events = parser.feed("\n");
    expect(events.length).toBe(1);
    expect(events[0]!.data).toBe('{"type":"server.connected"}');

    const parsed = parseOpenCodeWireEvent(events[0]!);
    expect(parsed?.type).toBe("server.connected");
  });

  it("handles multi-line data and CRLF line endings", () => {
    const parser = new SseStreamParser();
    const raw = 'data: {"type":"test",\r\ndata: "multi":true}\r\n\r\n';
    const events = parser.feed(raw);
    expect(events.length).toBe(1);
    expect(events[0]!.data).toBe('{"type":"test",\n"multi":true}');
  });

  it("ignores comment / keep-alive lines", () => {
    const parser = new SseStreamParser();
    const raw = ':keepalive\n\n:comment only\n\ndata: {"type":"real.event"}\n\n';
    const events = parser.feed(raw);
    expect(events.length).toBe(1);
    expect(events[0]!.data).toBe('{"type":"real.event"}');
  });

  it("handles malformed JSON events gracefully", () => {
    const parser = new SseStreamParser();
    const events = parser.feed("data: not-valid-json\n\n");
    expect(events.length).toBe(1);
    const parsed = parseOpenCodeWireEvent(events[0]!);
    expect(parsed).toBeNull();
  });

  it("rejects wire events missing discriminator type", () => {
    const parser = new SseStreamParser();
    const events = parser.feed('data: {"id":"ev_1"}\n\n');
    expect(events.length).toBe(1);
    const parsed = parseOpenCodeWireEvent(events[0]!);
    expect(parsed).toBeNull();
  });
});

// ============================================================================
// Priority 3 — Stream termination and reconnection behavior
// ============================================================================

describe("B7 — Priority 3: stream termination and reconnection", () => {
  it("consumes events cleanly from a successful stream", async () => {
    const events: OpenCodeWireEvent[] = [];
    const controller = new AbortController();

    const fetchStream = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"type":"server.connected"}\n\n'));
          c.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: EVENT_STREAM_HEADERS,
      });
    };

    const result = await consumeEventStreamWithReconnection(fetchStream, (ev) => events.push(ev), {
      signal: controller.signal,
      reconnectOptions: { maxAttempts: 1 },
    });

    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("server.connected");
    expect(result.disconnectCount).toBe(1); // 1 normal close
  });

  it("reconnects upon unexpected stream termination", async () => {
    const events: OpenCodeWireEvent[] = [];
    const controller = new AbortController();
    let streamCallCount = 0;

    const fetchStream = async () => {
      streamCallCount++;
      if (streamCallCount === 1) {
        // Stream 1 closes abruptly
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"type":"session.step.started"}\n\n'));
            c.close();
          },
        });
        return new Response(stream, { status: 200, headers: EVENT_STREAM_HEADERS });
      } else {
        // Stream 2 sends second event and completes
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"type":"session.step.ended"}\n\n'));
            c.close();
          },
        });
        return new Response(stream, { status: 200, headers: EVENT_STREAM_HEADERS });
      }
    };

    const reconnectAttempts: number[] = [];
    const result = await consumeEventStreamWithReconnection(
      fetchStream,
      (ev) => {
        events.push(ev);
        if (events.length === 2) {
          controller.abort();
        }
      },
      {
        signal: controller.signal,
        reconnectOptions: { maxAttempts: 3, initialDelayMs: 5 },
        onReconnect: (attempt) => reconnectAttempts.push(attempt),
      },
    );

    expect(events.map((e) => e.type)).toEqual(["session.step.started", "session.step.ended"]);
    expect(reconnectAttempts).toEqual([1]);
    expect(result.completedCleanly).toBe(true);
  });

  it("reports failure when reconnect budget is exhausted", async () => {
    const controller = new AbortController();
    const fetchStream = async () => {
      throw new Error("Connection failed");
    };

    const result = await consumeEventStreamWithReconnection(fetchStream, () => undefined, {
      signal: controller.signal,
      reconnectOptions: { maxAttempts: 2, initialDelayMs: 5 },
    });

    expect(result.completedCleanly).toBe(false);
    expect(result.disconnectCount).toBe(2);
  });
});

// ============================================================================
// Priority 4 — Tool-call and permission event validation
// ============================================================================

describe("B7 — Priority 4: tool-call and permission event handling", () => {
  it("identifies tool-call event types", () => {
    expect(isToolCallEventType("session.tool.called")).toBe(true);
    expect(isToolCallEventType("session.tool.progress")).toBe(true);
    expect(isToolCallEventType("session.tool.success")).toBe(true);
    expect(isToolCallEventType("session.tool.failed")).toBe(true);
    expect(isToolCallEventType("session.created")).toBe(false);
  });

  it("validates tool call event structure", () => {
    expect(
      validateToolCallEvent({
        type: "session.tool.called",
        data: { callID: "call_1", tool: "read_file", input: { path: "a.ts" } },
      }),
    ).toBe(true);

    expect(
      validateToolCallEvent({
        type: "session.tool.success",
        data: { callID: "call_1", result: "ok" },
      }),
    ).toBe(true);

    // Missing callID
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
  });

  it("identifies permission event types", () => {
    expect(isPermissionEventType("permission.asked")).toBe(true);
    expect(isPermissionEventType("permission.replied")).toBe(true);
    expect(isPermissionEventType("session.idle")).toBe(false);
  });

  it("validates permission event structure", () => {
    expect(
      validatePermissionEvent({
        type: "permission.asked",
        data: { id: "perm_1", permission: "execute" },
      }),
    ).toBe(true);

    expect(
      validatePermissionEvent({
        type: "permission.replied",
        data: { id: "perm_1", decision: "granted" },
      }),
    ).toBe(true);

    expect(
      validatePermissionEvent({
        type: "permission.replied",
        data: { id: "perm_1", decision: "denied" },
      }),
    ).toBe(true);

    // Invalid decision value
    expect(
      validatePermissionEvent({
        type: "permission.replied",
        data: { id: "perm_1", decision: "maybe" as unknown as "granted" },
      }),
    ).toBe(false);

    // Missing permission id
    expect(
      validatePermissionEvent({
        type: "permission.asked",
        data: { permission: "execute" },
      }),
    ).toBe(false);
  });
});

// ============================================================================
// Priority 7 — Lazy capability detection
// ============================================================================

describe("B7 — Priority 7: lazy capability detection", () => {
  it("evaluates capability on first request and caches outcome", async () => {
    const registry = new LazyCapabilityRegistry();
    expect(registry.isCached("session.create")).toBe(false);

    let probeCalls = 0;
    const probe = async () => {
      probeCalls++;
      return true;
    };

    const first = await registry.detectLazily("session.create", probe);
    expect(first).toBe(true);
    expect(probeCalls).toBe(1);
    expect(registry.isCached("session.create")).toBe(true);

    // Second call uses cache
    const second = await registry.detectLazily("session.create", probe);
    expect(second).toBe(true);
    expect(probeCalls).toBe(1); // not called again
  });

  it("caches failed capability probes as unsupported", async () => {
    const registry = new LazyCapabilityRegistry();
    let probeCalls = 0;
    const failingProbe = async () => {
      probeCalls++;
      throw new Error("501 Not Implemented");
    };

    const supported = await registry.detectLazily("command.execute", failingProbe);
    expect(supported).toBe(false);
    expect(probeCalls).toBe(1);

    // Cached as false
    expect(registry.getCached("command.execute")).toBe(false);
    const retry = await registry.detectLazily("command.execute", failingProbe);
    expect(retry).toBe(false);
    expect(probeCalls).toBe(1);
  });

  it("supports manual recording and clearing", () => {
    const registry = new LazyCapabilityRegistry();
    registry.recordCapability("session.prompt", true);
    expect(registry.getCached("session.prompt")).toBe(true);

    registry.clear();
    expect(registry.isCached("session.prompt")).toBe(false);
  });
  it("bindToService clears cache when service identity changes", () => {
    const registry = new LazyCapabilityRegistry();
    registry.bindToService("http://127.0.0.1:4096");
    registry.recordCapability("session.create", true);
    expect(registry.getCached("session.create")).toBe(true);

    // Same identity does not clear
    registry.bindToService("http://127.0.0.1:4096");
    expect(registry.getCached("session.create")).toBe(true);

    // Changed identity (e.g. server restart on new port or new adopted target) clears
    registry.bindToService("http://127.0.0.1:5123");
    expect(registry.isCached("session.create")).toBe(false);
  });

  it("deduplicates concurrent in-flight probes for the same capability", async () => {
    const registry = new LazyCapabilityRegistry();
    let probeCalls = 0;
    const slowProbe = async () => {
      probeCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return true;
    };

    const [res1, res2, res3] = await Promise.all([
      registry.detectLazily("session.create", slowProbe),
      registry.detectLazily("session.create", slowProbe),
      registry.detectLazily("session.create", slowProbe),
    ]);

    expect(res1).toBe(true);
    expect(res2).toBe(true);
    expect(res3).toBe(true);
    expect(probeCalls).toBe(1);
  });

  it("exports a canonical lazyCapabilityRegistry singleton", () => {
    expect(lazyCapabilityRegistry).toBeInstanceOf(LazyCapabilityRegistry);
    lazyCapabilityRegistry.bindToService("http://127.0.0.1:9999");
    lazyCapabilityRegistry.recordCapability("session.create", true);
    expect(lazyCapabilityRegistry.getCached("session.create")).toBe(true);
    lazyCapabilityRegistry.clear();
  });
});
