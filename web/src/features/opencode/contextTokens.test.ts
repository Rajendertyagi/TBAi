import { describe, it, expect } from "bun:test";
import { toTokenUsage } from "./contextTokens";

describe("toTokenUsage (native V2 TokenUsageInfo)", () => {
  it("derives the display total from input and output", () => {
    expect(
      toTokenUsage({
        input: 200_000,
        output: 32_000,
        reasoning: 500,
        cache: { read: 3_000, write: 100 },
      }),
    ).toEqual({
      totalTokens: 232_000,
      inputTokens: 200_000,
      outputTokens: 32_000,
      reasoningTokens: 500,
      cachedInputTokens: 3_000,
    });
  });

  it("treats cache read and reasoning as display subdivisions, not extra total", () => {
    expect(
      toTokenUsage({
        input: 1_000,
        output: 500,
        reasoning: 400,
        cache: { read: 300, write: 200 },
      }),
    ).toMatchObject({
      totalTokens: 1_500,
      reasoningTokens: 400,
      cachedInputTokens: 300,
    });
  });

  it("validates cache write without exposing it as a display field", () => {
    const usage = toTokenUsage({
      input: 10,
      output: 20,
      reasoning: 30,
      cache: { read: 40, write: 50 },
    });
    expect(usage).toEqual({
      totalTokens: 30,
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 30,
      cachedInputTokens: 40,
    });
    expect(usage).not.toHaveProperty("cachedWriteTokens");
  });

  it("returns undefined when any required native field is missing or invalid", () => {
    const valid = {
      input: 10,
      output: 20,
      reasoning: 30,
      cache: { read: 40, write: 50 },
    };
    const invalidPayloads = [
      undefined,
      null,
      {},
      { ...valid, input: undefined },
      { ...valid, output: undefined },
      { ...valid, reasoning: undefined },
      { ...valid, cache: undefined },
      { ...valid, cache: { read: undefined, write: 50 } },
      { ...valid, cache: { read: 40, write: undefined } },
      { ...valid, input: Number.NaN },
      { ...valid, output: Number.POSITIVE_INFINITY },
      { ...valid, reasoning: -1 },
      { ...valid, cache: { read: -1, write: 50 } },
      { ...valid, cache: { read: 40, write: -1 } },
    ];
    for (const payload of invalidPayloads) {
      expect(toTokenUsage(payload)).toBeUndefined();
    }
  });
});
