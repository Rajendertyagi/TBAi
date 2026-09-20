/**
 * Operation-level correlation on the backend.
 *
 * The point of `operationId` is that ONE user action fans out into several
 * HTTP requests: each keeps its own requestId, and all of them share the
 * operation. These tests pin the header contract, the ALS propagation, and the
 * precedence rules (explicit field > ambient context).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  logger,
  resolveInboundCorrelation,
  runWithRequestContext,
  extendRequestContext,
  getRequestContext,
  newOperationId,
  newRequestId,
  OPERATION_ID_HEADER,
  REQUEST_ID_HEADER,
} from "../../src/lib/logger";

function incoming(map: Record<string, string>): { get(name: string): string | null } {
  const h = new Headers(map);
  return { get: (name) => h.get(name) };
}

function entriesSince(since: number) {
  return logger.getRecentEntries(since);
}

beforeEach(() => {
  logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });
});

afterEach(() => {
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
});

describe("resolveInboundCorrelation", () => {
  it("accepts a well-formed request and operation id", () => {
    const { requestId, operationId } = resolveInboundCorrelation(
      incoming({
        [REQUEST_ID_HEADER]: "req_inbound",
        [OPERATION_ID_HEADER]: "op_inbound",
      }),
    );
    expect(requestId).toBe("req_inbound");
    expect(operationId).toBe("op_inbound");
  });

  it("mints a request id and leaves the operation absent when no headers are sent", () => {
    const { requestId, operationId } = resolveInboundCorrelation(incoming({}));
    expect(requestId).toMatch(/^req_/);
    expect(operationId).toBeUndefined();
  });

  it("replaces a malformed request id and drops a malformed operation id", () => {
    const bad = resolveInboundCorrelation(
      incoming({
        [REQUEST_ID_HEADER]: "has spaces/and;semicolons",
        [OPERATION_ID_HEADER]: "op_with spaces",
      }),
    );
    expect(bad.requestId).toMatch(/^req_/);
    expect(bad.requestId).not.toContain(" ");
    expect(bad.operationId).toBeUndefined();
  });

  it("rejects an over-long operation id instead of truncating it", () => {
    const long = "op_" + "a".repeat(200);
    expect(resolveInboundCorrelation(incoming({ [OPERATION_ID_HEADER]: long })).operationId)
      .toBeUndefined();
  });
});

describe("request context propagation", () => {
  it("stamps requestId and operationId on every nested line", () => {
    const since = logger.lastSeq;
    const operationId = newOperationId();
    runWithRequestContext({ requestId: "req_1", operationId }, () => {
      logger.info("chat", "outer");
      extendRequestContext({ toolCallId: "call_1" }, () => {
        logger.info("tool", "nested");
      });
    });
    const entries = entriesSince(since);
    const outer = entries.find((e) => e.event === "outer")!;
    const nested = entries.find((e) => e.event === "nested")!;
    expect(outer.requestId).toBe("req_1");
    expect(outer.operationId).toBe(operationId);
    expect(nested.requestId).toBe("req_1");
    expect(nested.operationId).toBe(operationId);
    expect(nested.toolCallId).toBe("call_1");
  });

  it("keeps the operation id across multiple requests with distinct request ids", () => {
    const since = logger.lastSeq;
    const operationId = newOperationId();
    // Two separate HTTP requests caused by ONE user action.
    runWithRequestContext({ requestId: "req_a", operationId }, () => {
      logger.info("chat", "request_one");
    });
    runWithRequestContext({ requestId: "req_b", operationId }, () => {
      logger.info("chat", "request_two");
    });
    const entries = entriesSince(since);
    const one = entries.find((e) => e.event === "request_one")!;
    const two = entries.find((e) => e.event === "request_two")!;
    expect(one.requestId).toBe("req_a");
    expect(two.requestId).toBe("req_b");
    expect(one.operationId).toBe(operationId);
    expect(two.operationId).toBe(operationId);
    // The whole point: one query by operationId returns both requests.
    const forOperation = entries.filter((e) => e.operationId === operationId);
    expect(forOperation.map((e) => e.requestId).sort()).toEqual(["req_a", "req_b"]);
  });

  it("lets explicit fields win over the ambient context", () => {
    const since = logger.lastSeq;
    runWithRequestContext({ requestId: "req_ctx", operationId: "op_ctx" }, () => {
      logger.info("chat", "override", { operationId: "op_explicit" });
    });
    const entry = entriesSince(since).find((e) => e.event === "override")!;
    expect(entry.operationId).toBe("op_explicit");
    expect(entry.requestId).toBe("req_ctx");
  });

  it("omits correlation ids entirely outside a request context", () => {
    const since = logger.lastSeq;
    logger.info("chat", "no_context");
    const entry = entriesSince(since).find((e) => e.event === "no_context")!;
    expect(entry.requestId).toBeUndefined();
    expect(entry.operationId).toBeUndefined();
  });

  it("exposes the live context to code that needs it", () => {
    expect(getRequestContext()).toBeUndefined();
    runWithRequestContext({ requestId: "req_ctx", operationId: "op_ctx" }, () => {
      expect(getRequestContext()?.operationId).toBe("op_ctx");
    });
  });

  it("stamps an epoch timestamp alongside the human time string", () => {
    const since = logger.lastSeq;
    const before = Date.now();
    logger.info("chat", "stamped");
    const entry = entriesSince(since).find((e) => e.event === "stamped")!;
    expect(entry.ts).toBeGreaterThanOrEqual(before);
    expect(entry.ts).toBeLessThanOrEqual(Date.now());
    expect(typeof entry.time).toBe("string");
  });

  it("generates distinct request and operation ids", () => {
    expect(newRequestId()).not.toBe(newRequestId());
    expect(newOperationId()).toMatch(/^op_/);
    expect(newOperationId()).not.toBe(newOperationId());
  });
});
