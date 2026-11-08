import { describe, it, expect } from "bun:test";
import { buildChatMessageMetadata } from "@/routes/chat/model.ts";

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

  it("stamps the turn start on the start part and closes the turn on finish", () => {
    const turn = { startedAt: 1_000, now: () => 4_000 };
    expect(buildChatMessageMetadata({ type: "start" }, custom, undefined, turn)).toEqual({
      custom: { ...custom, turnStartedAt: 1_000 },
    });

    const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };
    expect(
      buildChatMessageMetadata({ type: "finish", totalUsage: usage }, custom, undefined, turn),
    ).toEqual({
      custom: {
        ...custom,
        turnStartedAt: 1_000,
        turnTiming: { startedAt: 1_000, endedAt: 4_000, durationMs: 3_000 },
      },
      usage,
    });
  });

  it("closes the turn even when the provider reports no usage", () => {
    const turn = { startedAt: 1_000, now: () => 2_500 };
    expect(buildChatMessageMetadata({ type: "finish" }, custom, undefined, turn)).toEqual({
      custom: {
        ...custom,
        turnStartedAt: 1_000,
        turnTiming: { startedAt: 1_000, endedAt: 2_500, durationMs: 1_500 },
      },
    });
  });

  it("never reports a negative duration when the clock steps backwards", () => {
    const turn = { startedAt: 5_000, now: () => 4_000 };
    expect(
      buildChatMessageMetadata({ type: "finish" }, custom, undefined, turn).custom,
    ).toMatchObject({
      turnTiming: { startedAt: 5_000, endedAt: 4_000, durationMs: 0 },
    });
  });
});
