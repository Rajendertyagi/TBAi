/**
 * The send operation's lifetime, now scoped by conversation/thread id.
 *
 * Two chats sending concurrently keep independent operation ids; a late settle
 * from chat A cannot end chat B's operation. Every terminal path (completion,
 * failure, cancellation) ends only the operation it belongs to.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { logger } from "@web/lib/logger.ts";
import { currentOperationId, resetOperationsForTests } from "@web/lib/operation.ts";
import {
  activeSendOperationId,
  attachSendOperation,
  beginSendOperation,
  createFinishPredicate,
  endSendOperation,
  observeBodySettled,
  resetSendOperationForTests,
} from "@web/lib/send-operation";

interface Recorded {
  level: string;
  scope: string;
  event: string;
}

let recorded: Recorded[] = [];
const realInfo = logger.info;
const realWarn = logger.warn;
const realError = logger.error;

function capture(level: string, scope: string, event: string): void {
  recorded.push({ level, scope, event });
}

beforeEach(() => {
  recorded = [];
  resetOperationsForTests();
  resetSendOperationForTests();
  logger.info = ((scope: string, event: string) =>
    capture("info", scope, event)) as typeof logger.info;
  logger.warn = ((scope: string, event: string) =>
    capture("warn", scope, event)) as typeof logger.warn;
  logger.error = ((scope: string, event: string) =>
    capture("error", scope, event)) as typeof logger.error;
});

afterEach(() => {
  logger.info = realInfo;
  logger.warn = realWarn;
  logger.error = realError;
  resetOperationsForTests();
  resetSendOperationForTests();
});

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

const THREAD = "conv-A";

describe("send operation lifetime (thread-scoped)", () => {
  it("starts an operation and makes it current for its thread", () => {
    const id = beginSendOperation(THREAD, { trigger: "submit-message" });
    expect(id).toMatch(/^op_/);
    expect(currentOperationId(THREAD)).toBe(id);
    expect(activeSendOperationId(THREAD)).toBe(id);
    expect(recorded.map((r) => r.event)).toContain("send.start");
  });

  it("clears the thread's operation when it ends", () => {
    beginSendOperation(THREAD, {});
    endSendOperation(THREAD, "finish");
    expect(currentOperationId(THREAD)).toBeUndefined();
    expect(activeSendOperationId(THREAD)).toBeUndefined();
    expect(recorded.filter((r) => r.event === "send.stream_end")).toHaveLength(1);
  });

  it("supersedes the previous operation in the SAME thread", () => {
    const first = beginSendOperation(THREAD, {});
    const second = beginSendOperation(THREAD, {});
    expect(second).not.toBe(first);
    expect(currentOperationId(THREAD)).toBe(second);
    expect(activeSendOperationId(THREAD)).toBe(second);
  });

  it("is idempotent when ended twice", () => {
    beginSendOperation(THREAD, {});
    endSendOperation(THREAD, "finish");
    endSendOperation(THREAD, "finish");
    expect(recorded.filter((r) => r.event === "send.stream_end")).toHaveLength(1);
  });

  it("does nothing when ended with no active operation", () => {
    endSendOperation(THREAD, "finish");
    expect(recorded.filter((r) => r.event === "send.stream_end")).toHaveLength(0);
  });
});

describe("continuations keep one operation", () => {
  it("re-opens the SAME id after the first response settled", () => {
    const id = beginSendOperation(THREAD, {});
    endSendOperation(THREAD, "stream-settled");
    expect(currentOperationId(THREAD)).toBeUndefined();

    attachSendOperation(THREAD, id);
    expect(currentOperationId(THREAD)).toBe(id);
    expect(recorded.filter((r) => r.event === "send.start")).toHaveLength(1);
  });

  it("is a no-op when the operation is already current", () => {
    const id = beginSendOperation(THREAD, {});
    attachSendOperation(THREAD, id);
    attachSendOperation(THREAD, id);
    expect(currentOperationId(THREAD)).toBe(id);
  });
});

describe("the superseded-response race", () => {
  it("does not let a late settle end the operation that replaced it", () => {
    const oldId = beginSendOperation(THREAD, {});
    const newId = beginSendOperation(THREAD, {});
    endSendOperation(THREAD, "stream-settled", oldId);
    expect(currentOperationId(THREAD)).toBe(newId);
    expect(activeSendOperationId(THREAD)).toBe(newId);
  });

  it("does end the operation when the id matches", () => {
    const id = beginSendOperation(THREAD, {});
    endSendOperation(THREAD, "stream-settled", id);
    expect(currentOperationId(THREAD)).toBeUndefined();
  });
});

describe("concurrent threads are isolated", () => {
  it("two threads keep distinct operation ids", () => {
    const a = beginSendOperation("conv-A", {});
    const b = beginSendOperation("conv-B", {});
    expect(a).not.toBe(b);
    expect(currentOperationId("conv-A")).toBe(a);
    expect(currentOperationId("conv-B")).toBe(b);
  });

  it("ending thread A does not end thread B", () => {
    const a = beginSendOperation("conv-A", {});
    const b = beginSendOperation("conv-B", {});
    endSendOperation("conv-A", "finish", a);
    expect(currentOperationId("conv-A")).toBeUndefined();
    expect(currentOperationId("conv-B")).toBe(b);
    expect(activeSendOperationId("conv-B")).toBe(b);
  });

  it("a late settle from A cannot end B's operation", () => {
    const a = beginSendOperation("conv-A", {});
    const b = beginSendOperation("conv-B", {});
    endSendOperation("conv-A", "stream-settled", b); // wrong id for A
    expect(currentOperationId("conv-A")).toBe(a);
    expect(currentOperationId("conv-B")).toBe(b);
  });

  it("a continuation in A does not supersede B", () => {
    const a = beginSendOperation("conv-A", {});
    const b = beginSendOperation("conv-B", {});
    endSendOperation("conv-A", "stream-settled", a);
    attachSendOperation("conv-A", a);
    expect(currentOperationId("conv-A")).toBe(a);
    expect(currentOperationId("conv-B")).toBe(b);
  });
});

describe("observeBodySettled", () => {
  it("passes bytes through unchanged and reports completion once", async () => {
    const chunks = [new TextEncoder().encode("a"), new TextEncoder().encode("b")];
    let settled = 0;
    const wrapped = observeBodySettled(streamOf(...chunks), () => {
      settled += 1;
    });
    const out = await drain(wrapped);
    expect(out.map((c) => new TextDecoder().decode(c))).toEqual(["a", "b"]);
    expect(settled).toBe(1);
  });

  it("reports a read error once", async () => {
    let settled = 0;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("stream broke"));
      },
    });
    const wrapped = observeBodySettled(failing, () => {
      settled += 1;
    });
    await expect(drain(wrapped)).rejects.toThrow("stream broke");
    expect(settled).toBe(1);
  });

  it("reports consumer cancellation once (the Stop / abandoned-stream path)", async () => {
    let settled = 0;
    const endless = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
    });
    const wrapped = observeBodySettled(endless, () => {
      settled += 1;
    });
    const reader = wrapped.getReader();
    await reader.read();
    await reader.cancel("user stopped");
    expect(settled).toBe(1);
  });

  it("settles exactly once when a cancel follows a completed read", async () => {
    let settled = 0;
    const wrapped = observeBodySettled(streamOf(new TextEncoder().encode("x")), () => {
      settled += 1;
    });
    await drain(wrapped);
    await wrapped.cancel().catch(() => {});
    expect(settled).toBe(1);
  });
});

describe("createFinishPredicate — pure, never ends an operation", () => {
  const chunk = new Uint8Array();

  it("detects finish, error, and abort markers in the accumulated SSE text", () => {
    const finish = createFinishPredicate();
    expect(finish(chunk, 'data: {"type":"finish"}')).toBe(true);
    expect(finish(chunk, 'data: {"type":"error"}')).toBe(true);
    expect(finish(chunk, 'data: {"type":"abort"}')).toBe(true);
  });

  it("does not fire on ordinary message text", () => {
    const finish = createFinishPredicate();
    expect(finish(chunk, 'data: {"type":"text-delta","delta":"hello"}')).toBe(false);
  });

  it("never ends an operation, even when a marker is seen", () => {
    beginSendOperation("conv-predicate", {});
    const id = currentOperationId("conv-predicate");
    const finish = createFinishPredicate();
    finish(chunk, 'data: {"type":"finish"}');
    finish(chunk, 'data: {"type":"abort"}');
    // The predicate is shared across streams and has no send identity; only
    // observeBodySettled may end the operation, with its captured id.
    expect(currentOperationId("conv-predicate")).toBe(id);
  });

  it("signals finish for every abort-only stream through one shared instance", () => {
    // One predicate instance lives for the whole transport. A per-stream
    // "already saw abort" flag would make the second stream never finish.
    const finish = createFinishPredicate();
    expect(finish(chunk, 'data: {"type":"abort"}')).toBe(true);
    expect(finish(chunk, 'data: {"type":"abort"}')).toBe(true);
  });
});
