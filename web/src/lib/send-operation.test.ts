/**
 * The send operation's lifetime.
 *
 * This is the defect the live browser run exposed: a FINISHED send kept its
 * operationId as the current one, so unrelated later browser errors (a
 * ResizeObserver notice on the Logs page, 27s later) inherited it. The rule
 * these tests pin: an operation ends on every terminal path — completion,
 * failure, and cancellation — and a superseded response can never end the
 * operation that replaced it.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { logger } from "./logger";
import { currentOperationId, resetOperationsForTests } from "./operation";
import {
  activeSendOperationId,
  attachSendOperation,
  beginSendOperation,
  endSendOperation,
  observeBodySettled,
  resetSendOperationForTests,
} from "./send-operation";

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
  // Both modules hold state: `operation.ts` owns the context stack, this module
  // owns the send handle. Reset both so a test can never inherit the previous
  // one's operation (which would itself be a stale-id leak).
  resetOperationsForTests();
  resetSendOperationForTests();
  logger.info = ((scope: string, event: string) => capture("info", scope, event)) as typeof logger.info;
  logger.warn = ((scope: string, event: string) => capture("warn", scope, event)) as typeof logger.warn;
  logger.error = ((scope: string, event: string) => capture("error", scope, event)) as typeof logger.error;
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

describe("send operation lifetime", () => {
  it("starts an operation and makes it current", () => {
    const id = beginSendOperation({ trigger: "submit-message" });
    expect(id).toMatch(/^op_/);
    expect(currentOperationId()).toBe(id);
    expect(activeSendOperationId()).toBe(id);
    expect(recorded.map((r) => r.event)).toContain("send.start");
  });

  it("clears the context when the operation ends", () => {
    beginSendOperation({});
    endSendOperation("finish");
    // No current operation ⇒ a later unrelated browser event cannot inherit an
    // operationId (the logger attaches one only when an operation is active).
    expect(currentOperationId()).toBeUndefined();
    expect(activeSendOperationId()).toBeUndefined();
    expect(recorded.filter((r) => r.event === "send.stream_end")).toHaveLength(1);
  });

  it("supersedes the previous operation when a new send starts", () => {
    const first = beginSendOperation({});
    const second = beginSendOperation({});
    expect(second).not.toBe(first);
    expect(currentOperationId()).toBe(second);
    expect(activeSendOperationId()).toBe(second);
  });

  it("is idempotent when ended twice", () => {
    beginSendOperation({});
    endSendOperation("finish");
    endSendOperation("finish");
    expect(recorded.filter((r) => r.event === "send.stream_end")).toHaveLength(1);
  });

  it("does nothing when ended with no active operation", () => {
    endSendOperation("finish");
    expect(recorded.filter((r) => r.event === "send.stream_end")).toHaveLength(0);
  });
});

describe("continuations keep one operation", () => {
  it("re-opens the SAME id after the first response settled", () => {
    const id = beginSendOperation({});
    // First response settles (a tool-call turn continues afterwards).
    endSendOperation("stream-settled");
    expect(currentOperationId()).toBeUndefined();

    attachSendOperation(id);
    expect(currentOperationId()).toBe(id);
    // No second `send.start`: it is the same logical send continuing.
    expect(recorded.filter((r) => r.event === "send.start")).toHaveLength(1);
  });

  it("is a no-op when the operation is already current", () => {
    const id = beginSendOperation({});
    attachSendOperation(id);
    attachSendOperation(id);
    expect(currentOperationId()).toBe(id);
  });
});

describe("the superseded-response race", () => {
  it("does not let a late settle end the operation that replaced it", () => {
    const oldId = beginSendOperation({});
    const newId = beginSendOperation({});
    // The OLD response settles late, after a newer send took over.
    endSendOperation("stream-settled", oldId);
    expect(currentOperationId()).toBe(newId);
    expect(activeSendOperationId()).toBe(newId);
  });

  it("does end the operation when the id matches", () => {
    const id = beginSendOperation({});
    endSendOperation("stream-settled", id);
    expect(currentOperationId()).toBeUndefined();
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
    // A stream that never completes on its own: only cancellation ends it.
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
    const wrapped = observeBodySettled(
      streamOf(new TextEncoder().encode("x")),
      () => {
        settled += 1;
      },
    );
    await drain(wrapped);
    await wrapped.cancel().catch(() => {});
    expect(settled).toBe(1);
  });
});
