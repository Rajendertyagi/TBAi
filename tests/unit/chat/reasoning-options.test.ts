import { describe, expect, it } from "bun:test";
import { buildReasoningProviderOptions } from "@/routes/chat/provider-options";

describe("buildReasoningProviderOptions", () => {
  describe("default ('off') handling", () => {
    it("returns empty providerOptions when reasoning is 'off'", () => {
      expect(buildReasoningProviderOptions({ type: "openai" }, "gpt-4o", "off")).toEqual({});
      expect(
        buildReasoningProviderOptions({ type: "anthropic" }, "claude-3-5-sonnet", "off"),
      ).toEqual({});
      expect(buildReasoningProviderOptions({ type: "google" }, "gemini-2.5-pro", "off")).toEqual(
        {},
      );
      expect(buildReasoningProviderOptions({ type: "google" }, "gemini-3-flash", "off")).toEqual(
        {},
      );
      expect(buildReasoningProviderOptions({ type: "custom" }, "qwen-2.5", "off")).toEqual({});
    });
  });

  describe("OpenAI native and compatible", () => {
    it("emits reasoningEffort for low, medium, and high under openai namespace", () => {
      expect(buildReasoningProviderOptions({ type: "openai" }, "o3-mini", "low")).toEqual({
        openai: { reasoningEffort: "low" },
      });
      expect(buildReasoningProviderOptions({ type: "openai" }, "o3-mini", "medium")).toEqual({
        openai: { reasoningEffort: "medium" },
      });
      expect(buildReasoningProviderOptions({ type: "openai" }, "o3-mini", "high")).toEqual({
        openai: { reasoningEffort: "high" },
      });
    });

    it("emits reasoningEffort under compatible namespace for custom providers", () => {
      const opts = buildReasoningProviderOptions({ type: "custom" }, "deepseek-r1", "high");
      expect(opts).toHaveProperty("openaiCompatible");
      expect(opts.openaiCompatible).toEqual({ reasoningEffort: "high" });
    });
  });

  describe("Google Gemini generation handling", () => {
    it("emits thinkingBudget and includeThoughts for Gemini 2.x models", () => {
      expect(buildReasoningProviderOptions({ type: "google" }, "gemini-2.5-pro", "low")).toEqual({
        google: {
          thinkingConfig: {
            thinkingBudget: 1024,
            includeThoughts: true,
          },
        },
      });
      expect(buildReasoningProviderOptions({ type: "google" }, "gemini-2.5-pro", "high")).toEqual({
        google: {
          thinkingConfig: {
            thinkingBudget: 8192,
            includeThoughts: true,
          },
        },
      });
    });

    it("emits thinkingLevel and includeThoughts for Gemini 3.x models", () => {
      expect(buildReasoningProviderOptions({ type: "google" }, "gemini-3-flash", "low")).toEqual({
        google: {
          thinkingConfig: {
            thinkingLevel: "low",
            includeThoughts: true,
          },
        },
      });
      expect(buildReasoningProviderOptions({ type: "google" }, "gemini-3.1-pro", "medium")).toEqual(
        {
          google: {
            thinkingConfig: {
              thinkingLevel: "medium",
              includeThoughts: true,
            },
          },
        },
      );
    });

    it("skips thinking for Gemini 2.5 lite/nano models", () => {
      expect(
        buildReasoningProviderOptions({ type: "google" }, "gemini-2.5-flash-lite", "high"),
      ).toEqual({});
      expect(buildReasoningProviderOptions({ type: "google" }, "gemini-nano", "high")).toEqual({});
    });
  });

  describe("Anthropic handling", () => {
    it("emits effort and adaptive thinking for Claude models", () => {
      expect(
        buildReasoningProviderOptions({ type: "anthropic" }, "claude-3-7-sonnet", "low"),
      ).toEqual({
        anthropic: {
          effort: "low",
          thinking: { type: "adaptive" },
        },
      });
      expect(
        buildReasoningProviderOptions({ type: "anthropic" }, "claude-3-7-sonnet", "high"),
      ).toEqual({
        anthropic: {
          effort: "high",
          thinking: { type: "adaptive" },
        },
      });
    });
  });
});
