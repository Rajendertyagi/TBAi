import { describe, it, expect, beforeAll } from "bun:test";

describe("TabStrip architectural guard (Step 1A)", () => {
  let source = "";

  beforeAll(async () => {
    source = await Bun.file(
      new URL("./TabStrip.tsx", import.meta.url),
    ).text();
  });

  it("does not import or call assistant-ui hooks", () => {
    expect(source).not.toContain("@assistant-ui/react");
    expect(source).not.toContain("useAuiState");
    expect(source).not.toContain("useAui");
    expect(source).not.toContain("ThreadListPrimitive");
    expect(source).not.toContain("AssistantRuntimeProvider");
  });

  it("uses TBAi threadListAdapter for conversation metadata", () => {
    expect(source).toContain("threadListAdapter");
  });
});
