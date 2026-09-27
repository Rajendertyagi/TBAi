import { describe, expect, it } from "bun:test";
import type { ToolCallMessagePart } from "@assistant-ui/react";
import { buildRestingLabel, toStats, toStep } from "./session-timeline";

/**
 * The tool timeline's app-owned half.
 *
 * The element itself is vendored upstream and is not re-tested. What can break
 * here is the MAPPING — it encodes TBAi's tool names, and upstream explicitly
 * leaves it to the app ("you write the mapping from `parts` to `steps` and
 * `stats` yourself"). So the mapping is tested directly, as a pure function.
 */

let seq = 0;
function part(
  toolName: string,
  args: Record<string, unknown> = {},
  result?: unknown,
): ToolCallMessagePart {
  seq += 1;
  return {
    type: "tool-call",
    toolCallId: `call-${seq}`,
    toolName,
    args,
    result,
  } as unknown as ToolCallMessagePart;
}

describe("tool timeline — steps", () => {
  it("names a known tool by its verb and chips the most useful argument", () => {
    expect(toStep(part("read_file", { path: "src/app.ts" })).verb).toBe("Read");
    expect(toStep(part("read_file", { path: "src/app.ts" })).chip).toBe("src/app.ts");
    expect(toStep(part("run_command", { command: "bun test" })).verb).toBe("Ran");
    expect(toStep(part("run_command", { command: "bun test" })).chip).toBe("bun test");
  });

  it("covers both engines' tool names", () => {
    // Direct chat and OpenCode share one timeline, so both registries must map.
    expect(toStep(part("edit_file", { filePath: "a.ts" })).verb).toBe("Edited");
    expect(toStep(part("edit", { filePath: "a.ts" })).verb).toBe("Edited");
    expect(toStep(part("bash", { command: "ls" })).verb).toBe("Ran");
    expect(toStep(part("grep", { pattern: "TODO" })).verb).toBe("Grepped");
    expect(toStep(part("webfetch", { url: "https://example.com" })).verb).toBe("Fetched");
  });

  it("falls back to the raw tool name rather than inventing a verb", () => {
    const step = toStep(part("some_future_tool", { a: 1 }));
    expect(step.verb).toBe("some_future_tool");
    // No recognised argument, so the chip is the tool name too.
    expect(step.chip).toBe("some_future_tool");
  });

  it("prefers a file path over a command when both are present", () => {
    const step = toStep(part("edit_file", { filePath: "a.ts", command: "ignored" }));
    expect(step.chip).toBe("a.ts");
  });

  it("tolerates missing args and results", () => {
    const step = toStep(part("system_info"));
    expect(step.verb).toBe("Read system");
    expect(step.chip).toBe("system_info");
  });
});

describe("tool timeline — file stats", () => {
  it("reports added and removed for an edit", () => {
    const stats = toStats([
      part("edit_file", { filePath: "a.ts" }, { file: "a.ts", added: 14, removed: 3 }),
    ]);
    expect(stats).toEqual([{ file: "a.ts", added: 14, removed: 3 }]);
  });

  it("accepts the line-prefixed result keys too", () => {
    const stats = toStats([
      part("edit", {}, { filePath: "b.ts", linesAdded: 2, linesRemoved: 1 }),
    ]);
    expect(stats).toEqual([{ file: "b.ts", added: 2, removed: 1 }]);
  });

  it("omits a side rather than reporting it as zero", () => {
    const stats = toStats([part("write_file", {}, { file: "c.ts", added: 5 })]);
    expect(stats[0].added).toBe(5);
    expect(stats[0].removed).toBeUndefined();
  });

  it("skips a stat with no counts at all, rather than an empty chip", () => {
    expect(toStats([part("write_file", {}, { file: "d.ts" })])).toEqual([]);
  });

  it("ignores non-editing tools", () => {
    expect(toStats([part("read_file", { path: "a.ts" }, { file: "a.ts", added: 1 })])).toEqual([]);
  });

  it("ignores a tool that has not returned yet", () => {
    expect(toStats([part("edit_file", { filePath: "a.ts" })])).toEqual([]);
  });
});

describe("tool timeline — resting label", () => {
  it("is pluralised correctly", () => {
    expect(buildRestingLabel(1, 1, 0)).toBe("1 step · 1 file changed");
    expect(buildRestingLabel(3, 2, 0)).toBe("3 steps · 2 files changed");
  });

  it("says so when older steps were capped off the top", () => {
    expect(buildRestingLabel(20, 0, 12)).toContain("last 8 shown");
  });
});
