import { describe, it, expect } from "bun:test";
import { buildChatMessageMetadata } from "../../src/routes/chat-model";

const custom = { providerId: "p1", modelId: "m1", reasoningLevel: "off" };

describe("buildChatMessageMetadata", () => {
  it("attaches provider usage on finish and preserves custom IDs", () => {
    const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };
    expect(buildChatMessageMetadata({ type: "finish", totalUsage: usage }, custom)).toEqual({
      custom,
      usage,
    });
  });

  it("preserves custom IDs without usage on non-finish parts", () => {
    for (const type of ["start", "finish-step", "text-delta", "error"]) {
      expect(buildChatMessageMetadata({ type }, custom)).toEqual({ custom });
    }
  });

  it("omits usage when the finish part carries none", () => {
    expect(buildChatMessageMetadata({ type: "finish" }, custom)).toEqual({ custom });
  });
});
