import { describe, it, expect } from "bun:test";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  formatContextWindow,
  parseContextWindowInput,
  resolveContextWindow,
} from "./modelContext";
import type { ModelGroup } from "../lib/model-groups";

function groups(): ModelGroup[] {
  return [
    {
      providerId: "p1",
      providerName: "P1",
      isDefault: true,
      models: [
        { id: "m-small", provider: "google", contextWindow: 32_000 },
        { id: "m-big", provider: "google", contextWindow: 1_000_000 },
        { id: "m-bare", provider: "google" },
      ],
    },
  ];
}

describe("resolveContextWindow", () => {
  it("prefers the live host-reported limit over configuration", () => {
    expect(
      resolveContextWindow({ limitContext: 200_000, modelId: "m-small", groups: groups() }),
    ).toBe(200_000);
  });

  it("reads the configured per-model window from provider groups", () => {
    expect(resolveContextWindow({ modelId: "m-small", groups: groups() })).toBe(32_000);
    expect(resolveContextWindow({ modelId: "m-big", groups: groups() })).toBe(1_000_000);
  });

  it("falls back to the documented default when nothing is configured", () => {
    expect(resolveContextWindow({})).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
    expect(
      resolveContextWindow({ modelId: "m-bare", groups: groups() }),
    ).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
    expect(
      resolveContextWindow({ modelId: "unknown-model", groups: groups() }),
    ).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
    expect(resolveContextWindow({ modelId: "m-small" })).toBe(
      DEFAULT_MODEL_CONTEXT_WINDOW,
    );
  });

  it("ignores non-positive or non-finite inputs at every layer", () => {
    const badValues: unknown[] = [0, -1, NaN, Infinity, undefined];
    for (const bad of badValues) {
      expect(
        resolveContextWindow({ limitContext: bad as number | undefined }),
      ).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
      expect(
        resolveContextWindow({
          modelId: "m-small",
          groups: [
            {
              providerId: "p",
              providerName: "P",
              isDefault: false,
              models: [
                { id: "m-small", provider: "x", contextWindow: bad as number },
              ],
            },
          ],
        }),
      ).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
    }
  });
});

describe("formatContextWindow", () => {
  it("compacts thousands and millions", () => {
    expect(formatContextWindow(128_000)).toBe("128k");
    expect(formatContextWindow(1_000_000)).toBe("1M");
    expect(formatContextWindow(1_500_000)).toBe("1.5M");
    expect(formatContextWindow(500)).toBe("500");
  });
});

describe("parseContextWindowInput", () => {
  it("accepts plain and grouped integers", () => {
    expect(parseContextWindowInput("128000")).toBe(128_000);
    expect(parseContextWindowInput(" 128,000 ")).toBe(128_000);
    expect(parseContextWindowInput("128_000")).toBe(128_000);
  });

  it("rejects blank, fractional, negative, and non-numeric input", () => {
    for (const bad of ["", "   ", "12.5", "-4", "0", "128k", "abc", "1e6"]) {
      expect(parseContextWindowInput(bad)).toBeUndefined();
    }
  });
});
