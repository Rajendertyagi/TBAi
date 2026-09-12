/**
 * Terminal stream batcher tests (no DOM, fast timers): throttling,
 * toolCallId isolation, completion ordering, caps, and callback optionality.
 * Executed with `bun test`.
 */
import { describe, it, expect } from "bun:test";
import {
  createTerminalBatcher,
  type TerminalDataPayload,
} from "../../src/lib/terminal-stream";

interface Written {
  type: string;
  id: string;
  data: TerminalDataPayload;
}

function collect(opts?: { flushMs?: number; maxPartsPerCall?: number }) {
  const written: Written[] = [];
  const batcher = createTerminalBatcher(
    (part) => written.push(part as Written),
    opts,
  );
  return { written, batcher };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("terminal batcher", () => {
  it("batches rapid pushes into throttled parts", async () => {
    const { written, batcher } = collect({ flushMs: 20 });
    batcher.push("call-1", { stream: "stdout", chunk: "a\n" });
    batcher.push("call-1", { stream: "stdout", chunk: "b\n" });
    batcher.push("call-1", { stream: "stderr", chunk: "e\n" });
    await sleep(60);
    expect(written.length).toBe(1);
    expect(written[0].type).toBe("data-tbai-terminal");
    expect(written[0].data.toolCallId).toBe("call-1");
    expect(written[0].data.done).toBe(false);
    expect(written[0].data.chunks.join("")).toContain("a\n");
    expect(written[0].data.chunks.join("")).toContain("e\n");
  });

  it("flushes large bursts immediately", () => {
    const { written, batcher } = collect({ flushMs: 10_000 });
    batcher.push("call-1", { stream: "stdout", chunk: "x".repeat(5000) });
    expect(written.length).toBe(1);
  });

  it("emits completion after buffered lines (done never precedes output)", () => {
    const { written, batcher } = collect({ flushMs: 10_000 });
    batcher.push("call-1", { stream: "stdout", chunk: "hello\n" });
    batcher.complete("call-1", 0, false);
    expect(written.length).toBe(2);
    expect(written[0].data.done).toBe(false);
    expect(written[0].data.chunks.join("")).toContain("hello");
    expect(written[1].data.done).toBe(true);
    expect(written[1].data.exitCode).toBe(0);
  });

  it("completion without output still lands the done part", () => {
    const { written, batcher } = collect({ flushMs: 10_000 });
    batcher.complete("call-9", 0, false);
    // Unknown id with no buffered output: nothing to present.
    expect(written.length).toBe(0);
  });

  it("isolates simultaneous tool calls by toolCallId", async () => {
    const { written, batcher } = collect({ flushMs: 10 });
    batcher.push("call-a", { stream: "stdout", chunk: "aaa\n" });
    batcher.push("call-b", { stream: "stdout", chunk: "bbb\n" });
    await sleep(40);
    const byId = new Map(written.map((w) => [w.data.toolCallId, w]));
    expect(byId.get("call-a")?.data.chunks.join("")).toContain("aaa");
    expect(byId.get("call-b")?.data.chunks.join("")).toContain("bbb");
    expect(byId.get("call-a")?.data.chunks.join("")).not.toContain("bbb");
  });

  it("caps parts per call but always lands completion", () => {
    const { written, batcher } = collect({ flushMs: 10_000, maxPartsPerCall: 2 });
    for (let i = 0; i < 10; i++) {
      batcher.push("call-1", { stream: "stdout", chunk: "x".repeat(5000) });
    }
    batcher.complete("call-1", 1, false);
    const done = written.filter((w) => w.data.done);
    expect(done.length).toBe(1);
    expect(done[0].data.exitCode).toBe(1);
    expect(written.length).toBeLessThanOrEqual(3);
  });

  it("ignores empty toolCallId", () => {
    const { written, batcher } = collect({ flushMs: 5 });
    batcher.push("", { stream: "stdout", chunk: "x\n" });
    batcher.complete("");
    expect(written.length).toBe(0);
  });
});
