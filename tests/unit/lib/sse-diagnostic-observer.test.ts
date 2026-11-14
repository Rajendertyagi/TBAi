import { describe, expect, it } from "bun:test";
import {
  extractSseDiagnosticEventType,
  findSseFrameBoundary,
  SseDiagnosticObserver,
  SSE_DIAGNOSTIC_MAX_BUFFER_BYTES,
} from "@/lib/sse-diagnostic-observer.ts";

describe("sse-diagnostic-observer", () => {
  it("finds LF, CRLF and CR frame boundaries", () => {
    expect(findSseFrameBoundary("a\n\nb")).toEqual({ index: 1, length: 2 });
    expect(findSseFrameBoundary("a\r\n\r\nb")).toEqual({ index: 1, length: 4 });
    expect(findSseFrameBoundary("a\r\rb")).toEqual({ index: 1, length: 2 });
  });

  it("waits for split CRLF boundaries across chunks", () => {
    expect(findSseFrameBoundary("data: x\r")).toBeNull();
    expect(findSseFrameBoundary("data: x\r\n")).toBeNull();
    expect(findSseFrameBoundary("data: x\r\n\r")).toBeNull();
  });

  it("extracts event type with precedence and fallbacks", () => {
    expect(extractSseDiagnosticEventType("event: custom\ndata: x")).toBe("custom");
    expect(extractSseDiagnosticEventType('data: {"type":"from-json"}')).toBe("from-json");
    expect(extractSseDiagnosticEventType("data: hello")).toBe("message");
    expect(extractSseDiagnosticEventType("event: named")).toBe("named");
  });

  it("joins multiline data fields for JSON type fallback", () => {
    const frame = 'data: {"type":"multi",\ndata: "ok":true}';
    expect(extractSseDiagnosticEventType(frame)).toBe("multi");
  });

  it("does not count comment-only, retry-only, id-only or unknown-only frames", () => {
    expect(extractSseDiagnosticEventType(": keepalive")).toBeNull();
    expect(extractSseDiagnosticEventType(":a\n:b")).toBeNull();
    expect(extractSseDiagnosticEventType("retry: 1000")).toBeNull();
    expect(extractSseDiagnosticEventType("id: 1")).toBeNull();
    expect(extractSseDiagnosticEventType("foo: bar")).toBeNull();
  });

  it("handles mixed line endings and multiple events in one chunk", () => {
    const obs = new SseDiagnosticObserver();
    const events = obs.feed(
      'event: a\r\ndata: 1\r\n\r\nevent: b\ndata: 2\n\ndata: {"type":"c"}\r\r',
    );
    expect(events.map((e) => e.type)).toEqual(["a", "b", "c"]);
  });

  it("handles fragmented events across chunks including split CRLF delimiter", () => {
    const obs = new SseDiagnosticObserver();
    expect(obs.feed("event: split\r\n")).toEqual([]);
    expect(obs.feed("data: 1\r\n")).toEqual([]);
    expect(obs.feed("\r")).toEqual([]);
    expect(obs.feed("\n")).toEqual([{ type: "split" }]);

    const obs2 = new SseDiagnosticObserver();
    expect(obs2.feed('data: {"ty')).toEqual([]);
    expect(obs2.feed('pe":"x"}\n\n')).toEqual([{ type: "x" }]);
  });

  it("discards incomplete trailing event at EOF/reset", () => {
    const obs = new SseDiagnosticObserver();
    expect(obs.feed("event: done\ndata: 1\n\n")).toEqual([{ type: "done" }]);
    expect(obs.feed("event: trailing\ndata: nope")).toEqual([]);
    obs.reset();
    expect(obs.feed("event: next\ndata: ok\n\n")).toEqual([{ type: "next" }]);
  });

  it("drops oversized frame safely and resumes at next valid boundary", () => {
    const obs = new SseDiagnosticObserver(64);
    const huge = `event: huge\ndata: ${"x".repeat(200)}\n\n`;
    expect(obs.feed(huge)).toEqual([]);
    expect(obs.feed("event: after\ndata: ok\n\n")).toEqual([{ type: "after" }]);
  });

  it("does not report a false type when oversized frame is dropped mid-stream", () => {
    const obs = new SseDiagnosticObserver(80);
    const chunk1 = `event: realtype\ndata: ${"a".repeat(120)}`; // no boundary, over limit
    const chunk2 = `stillbig\n\nevent: ok\ndata: 1\n\n`;
    expect(obs.feed(chunk1)).toEqual([]);
    const events = obs.feed(chunk2);
    expect(events.map((e) => e.type)).toEqual(["ok"]);
  });

  it("resumes after oversized content when boundary arrives later", () => {
    const obs = new SseDiagnosticObserver(32);
    expect(obs.feed(`data: ${"z".repeat(100)}`)).toEqual([]);
    expect(obs.feed("\n\n")).toEqual([]);
    expect(obs.feed('data: {"type":"later"}\n\n')).toEqual([{ type: "later" }]);
  });

  it("is defensive on malformed input", () => {
    const obs = new SseDiagnosticObserver();
    expect(obs.feed("\n\n\n\n")).toEqual([]);
    expect(obs.feed("data: {not-json}\n\n")).toEqual([{ type: "message" }]);
    expect(obs.feed("event:\ndata: x\n\n")).toEqual([{ type: "message" }]);
  });

  it("exports a documented 64 KiB default limit", () => {
    expect(SSE_DIAGNOSTIC_MAX_BUFFER_BYTES).toBe(64 * 1024);
  });
});
