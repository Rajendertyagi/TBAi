/**
 * The bounded overflow recovery gate.
 *
 * These are the failure cases the Direct route depends on, tested at the gate rather
 * than through HTTP: the boundary conditions (one attempt, two attempts, no third,
 * recovery refusal, visible-content-committed) are pure stream logic, and proving them
 * here means the route wiring only has to be proven once.
 *
 * The route-level proof that the gate is wired to the REAL lifecycle is
 * `tests/integration/direct-overflow-recovery.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import { withOverflowRecovery, MAX_PROVIDER_ATTEMPTS } from "./direct-overflow-gate";

/** Raw part shapes, mirroring what `streamText`'s `fullStream` yields. */
type Part =
  | { type: "start" }
  | { type: "start-step" }
  | { type: "text-delta"; text: string }
  | { type: "error"; error: Error }
  | { type: "finish" };

const LIFECYCLE = new Set(["start", "start-step"]);

const isErrorPart = (p: Part): unknown | undefined =>
  p.type === "error" ? (p as { error: Error }).error : undefined;
const isLifecyclePart = (p: Part): boolean => LIFECYCLE.has(p.type);

/** A stream that yields the given parts and closes. */
function streamOf(parts: Part[]): ReadableStream<Part> {
  return new ReadableStream<Part>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

/** Drain a stream to an array of parts. */
async function drain(s: ReadableStream<Part>): Promise<Part[]> {
  const out: Part[] = [];
  const reader = s.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

const overflow = () => new Error("maximum context length is 8192 tokens");

interface HarnessOptions {
  /** Parts per attempt, by attempt number. */
  attempts: Part[][];
  /** Whether the policy permits recovery. */
  shouldRecover?: boolean;
  /** Whether `recover()` throws. */
  recoverFails?: boolean;
}

function harness(opts: HarnessOptions) {
  const started: number[] = [];
  const recovered: { count: number } = { count: 0 };
  const discarded: number[] = [];
  const events: string[] = [];

  const stream = withOverflowRecovery<Part>({
    startAttempt: (attempt) => {
      started.push(attempt);
      return streamOf(opts.attempts[attempt - 1] ?? []);
    },
    isErrorPart,
    isLifecyclePart,
    decide: () => ({
      outcome: opts.shouldRecover === false ? "recovery_already_attempted" : "compact_and_retry",
      shouldRecover: opts.shouldRecover !== false,
    }),
    recover: async () => {
      recovered.count += 1;
      if (opts.recoverFails) throw new Error("compaction failed");
    },
    onAttemptDiscarded: (attempt) => discarded.push(attempt),
    onEvent: (e) => events.push(e.type),
  });

  return { stream, started, recovered, discarded, events };
}

const types = (parts: Part[]) => parts.map((p) => p.type);

describe("gate: the happy paths", () => {
  it("streams a first-attempt success through untouched, with no recovery", async () => {
    const h = harness({
      attempts: [[{ type: "start" }, { type: "text-delta", text: "hi" }, { type: "finish" }]],
    });
    const out = await drain(h.stream);
    expect(types(out)).toEqual(["start", "text-delta", "finish"]);
    expect(h.started).toEqual([1]);
    expect(h.recovered.count).toBe(0);
  });

  it("replays held lifecycle markers before streaming content", async () => {
    const h = harness({
      attempts: [[{ type: "start" }, { type: "start-step" }, { type: "text-delta", text: "x" }]],
    });
    const out = await drain(h.stream);
    // The markers were held, then replayed — the client sees one well-formed stream.
    expect(types(out)).toEqual(["start", "start-step", "text-delta"]);
  });
});

describe("gate: recovery", () => {
  it("overflow → recover → second attempt succeeds, emitting ONLY the retry", async () => {
    const h = harness({
      attempts: [
        [{ type: "start" }, { type: "error", error: overflow() }],
        [{ type: "start" }, { type: "text-delta", text: "recovered" }, { type: "finish" }],
      ],
    });
    const out = await drain(h.stream);

    expect(h.started).toEqual([1, 2]);
    expect(h.recovered.count).toBe(1);
    // Attempt 1's markers are dropped, not replayed: exactly one `stream-start` reaches
    // the client, from the attempt that actually produced the answer.
    expect(types(out)).toEqual(["start", "text-delta", "finish"]);
    expect(out.some((p) => p.type === "error")).toBe(false);
  });

  it("neutralises the discarded attempt BEFORE recovering", async () => {
    const order: string[] = [];
    const stream = withOverflowRecovery<Part>({
      startAttempt: (a) =>
        streamOf(a === 1 ? [{ type: "error", error: overflow() }] : [{ type: "finish" }]),
      isErrorPart,
      isLifecyclePart,
      decide: () => ({ outcome: "compact_and_retry", shouldRecover: true }),
      recover: async () => {
        order.push("recover");
      },
      onAttemptDiscarded: () => order.push("discard"),
    });
    await drain(stream);
    // Ordering is the correctness property: a discarded attempt must not be able to
    // settle the run while the recovery is still in flight.
    expect(order).toEqual(["discard", "recover"]);
  });
});

describe("gate: the bound holds", () => {
  it("a SECOND overflow is surfaced and there is no third attempt", async () => {
    const h = harness({
      attempts: [
        [{ type: "error", error: overflow() }],
        [{ type: "start" }, { type: "error", error: overflow() }],
      ],
    });
    const out = await drain(h.stream);

    expect(h.started).toEqual([1, 2]);
    expect(h.started).toHaveLength(MAX_PROVIDER_ATTEMPTS);
    expect(h.recovered.count).toBe(1);
    expect(out.filter((p) => p.type === "error")).toHaveLength(1);
    // The surviving error is attempt 2's, and its markers were replayed with it.
    expect(types(out)).toEqual(["start", "error"]);
  });

  it("never consults recovery when the policy denies it", async () => {
    const h = harness({
      attempts: [[{ type: "start" }, { type: "error", error: overflow() }]],
      shouldRecover: false,
    });
    const out = await drain(h.stream);
    expect(h.started).toEqual([1]);
    expect(h.recovered.count).toBe(0);
    expect(types(out)).toEqual(["start", "error"]);
  });

  it("surfaces the ORIGINAL overflow when recovery itself fails", async () => {
    const h = harness({
      attempts: [[{ type: "start" }, { type: "error", error: overflow() }]],
      recoverFails: true,
    });
    const out = await drain(h.stream);
    expect(h.started).toEqual([1]);
    // No retry is attempted against an uncompacted context...
    expect(h.started).toHaveLength(1);
    // ...and the user is told the real cause rather than a secondary failure.
    expect(out.filter((p) => p.type === "error")).toHaveLength(1);
    expect(h.events).toContain("recovery_failed");
  });
});

describe("gate: failing closed", () => {
  it("does NOT recover once assistant-visible content has been committed", async () => {
    // The guarantee that matters: if a provider ever emits content before rejecting,
    // retrying would produce two answers for one turn. The gate commits at the first
    // visible part and therefore refuses to recover.
    const h = harness({
      attempts: [
        [{ type: "start" }, { type: "text-delta", text: "partial" }, { type: "error", error: overflow() }],
        [{ type: "text-delta", text: "second answer" }],
      ],
    });
    const out = await drain(h.stream);

    expect(h.recovered.count).toBe(0);
    expect(h.started).toEqual([1]);
    // The visible content and the error both reach the client, in order: one normal
    // failed turn, never two competing answers.
    expect(types(out)).toEqual(["start", "text-delta", "error"]);
  });

  it("reports observability events for a successful recovery", async () => {
    const h = harness({
      attempts: [
        [{ type: "start" }, { type: "error", error: overflow() }],
        [{ type: "finish" }],
      ],
    });
    await drain(h.stream);
    expect(h.events).toEqual([
      "attempt_started",
      "overflow_detected",
      "recovery_decided",
      "retry_started",
      "attempt_started",
    ]);
  });
});
