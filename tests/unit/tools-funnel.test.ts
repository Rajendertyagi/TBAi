import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { logger } from "../../src/lib/logger";
import { instrumentedExecute } from "../../src/lib/tool-funnel";

beforeEach(() => {
  logger.configure({ level: "debug", targets: [], file: null });
});

afterEach(() => {
  logger.configure({ level: "error", targets: [], file: null });
});

function ring(tool: string) {
  const since = 0;
  return logger
    .getRecentEntries(since)
    .filter((e) => (e as { tool?: string }).tool === tool);
}

describe("tool funnel", () => {
  it("emits start/finish and passes the return value through", async () => {
    const run = instrumentedExecute("funnel-probe-ok", async (args: { x: number }) => args.x * 2);
    await expect(run({ x: 21 }, { toolCallId: "call-1" })).resolves.toBe(42);
    const events = ring("funnel-probe-ok").map((e) => e.event);
    expect(events).toEqual(["tool.start", "tool.finish"]);
    const finish = ring("funnel-probe-ok")[1] as { durationMs?: unknown; toolCallId?: unknown };
    expect(typeof finish.durationMs).toBe("number");
    expect(finish.toolCallId).toBe("call-1");
  });

  it("emits a classified error and rethrows the original", async () => {
    const boom = new Error("fetch failed catastrophically");
    const run = instrumentedExecute("funnel-probe-err", async () => {
      throw boom;
    });
    await expect(run({}, {})).rejects.toBe(boom);
    const errors = ring("funnel-probe-err").filter((e) => e.event === "tool.error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as { category?: string }).category).toBe("network");
  });

  it("binds toolCallId into context so nested logs correlate", async () => {
    const run = instrumentedExecute("funnel-probe-ctx", async () => {
      logger.info("tool", "nested_probe", {});
      return "ok";
    });
    await run({}, { toolCallId: "call-9" });
    const nested = logger
      .getRecentEntries(0)
      .filter((e) => e.event === "nested_probe");
    expect(nested).toHaveLength(1);
    expect((nested[0] as { toolCallId?: string }).toolCallId).toBe("call-9");
  });

  it("carries extra funnel fields (e.g. mcpServer)", async () => {
    const run = instrumentedExecute(
      "funnel-probe-extra",
      async () => "done",
      { mcpServer: "fs" },
    );
    await run({}, {});
    const finish = ring("funnel-probe-extra").find((e) => e.event === "tool.finish");
    expect((finish as { mcpServer?: string })?.mcpServer).toBe("fs");
  });
});
