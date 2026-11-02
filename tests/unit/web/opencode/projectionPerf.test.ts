import { describe, expect, it } from "bun:test";
import { projectV2RepositoryItems } from "@web/features/opencode/v2MessageProjection.ts";
import { createInitialV2ThreadState } from "@web/features/opencode/v2Events.ts";
import type { V2MessageState, V2ThreadState } from "@web/features/opencode/v2Types.ts";

describe("Stage 5: Frontend UI Projection Performance", () => {
  it("Measures UI message projection latency and memory for 500 messages", () => {
    const testSessionId = `ses_perf_ui_${Date.now()}`;

    // Build 500 V2 messages in thread state
    const messagesRecord: Record<string, V2MessageState> = {};
    const messageOrder: string[] = [];
    for (let i = 0; i < 500; i++) {
      const id = `msg-${i}`;
      messageOrder.push(id);
      messagesRecord[id] = {
        id,
        parentId: i > 0 ? `msg-${i - 1}` : null,
        role: i % 2 === 0 ? "user" : "assistant",
        createdAt: 1000 + i * 10,
        parts: [
          {
            kind: "text",
            id: `part-${i}`,
            order: 0,
            value: `Message body content payload block for index ${i}`,
            status: "complete",
          },
        ],
        source: null,
      };
    }
    const testState: V2ThreadState = {
      ...createInitialV2ThreadState("D:/Projects/LargePerf", testSessionId),
      messages: messagesRecord,
      messageOrder,
    };

    // Measure memory before
    if (globalThis.gc) globalThis.gc();
    const memBefore = process.memoryUsage().heapUsed;

    // Measure UI message projection latency (projecting 500 messages)
    const startProject = performance.now();
    const projected = projectV2RepositoryItems(testState);
    const projectElapsed = performance.now() - startProject;

    const memAfter = process.memoryUsage().heapUsed;
    const memDeltaKb = (memAfter - memBefore) / 1024;

    expect(projected.length).toBe(500);
    console.log(
      `[PERF] Large history (500 messages) UI projection latency: ${projectElapsed.toFixed(2)}ms`,
    );
    console.log(`[PERF] Memory delta during 500 message processing: ${memDeltaKb.toFixed(2)} KB`);

    expect(projectElapsed).toBeLessThan(150);
  });
});
