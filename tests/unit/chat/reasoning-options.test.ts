import { describe, expect, it } from "bun:test";
import { buildReasoningProviderOptions } from "@/routes/chat/provider-options";
import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

describe("reasoning implementation (native AI SDK v7)", () => {
  describe("buildReasoningProviderOptions (provider-specific display options)", () => {
    it("returns empty providerOptions when reasoning is 'off'", () => {
      expect(buildReasoningProviderOptions({ type: "openai" }, "off")).toEqual({});
      expect(buildReasoningProviderOptions({ type: "anthropic" }, "off")).toEqual({});
      expect(buildReasoningProviderOptions({ type: "google" }, "off")).toEqual({});
      expect(buildReasoningProviderOptions({ type: "custom" }, "off")).toEqual({});
    });

    it("returns empty providerOptions for non-Google providers with active reasoning", () => {
      expect(buildReasoningProviderOptions({ type: "openai" }, "low")).toEqual({});
      expect(buildReasoningProviderOptions({ type: "openai" }, "medium")).toEqual({});
      expect(buildReasoningProviderOptions({ type: "openai" }, "high")).toEqual({});
      expect(buildReasoningProviderOptions({ type: "anthropic" }, "low")).toEqual({});
      expect(buildReasoningProviderOptions({ type: "anthropic" }, "high")).toEqual({});
      expect(buildReasoningProviderOptions({ type: "custom" }, "high")).toEqual({});
    });

    it("emits only thinkingConfig.includeThoughts: true for Google with active reasoning", () => {
      expect(buildReasoningProviderOptions({ type: "google" }, "low")).toEqual({
        google: {
          thinkingConfig: {
            includeThoughts: true,
          },
        },
      });
      expect(buildReasoningProviderOptions({ type: "google" }, "medium")).toEqual({
        google: {
          thinkingConfig: {
            includeThoughts: true,
          },
        },
      });
      expect(buildReasoningProviderOptions({ type: "google" }, "high")).toEqual({
        google: {
          thinkingConfig: {
            includeThoughts: true,
          },
        },
      });
    });
  });

  describe("streamText native reasoning option mapping", () => {
    it("maps native reasoning to OpenAI request without manual providerOptions", async () => {
      let interceptedBody: any;
      const mockFetch: any = async (_url: any, init: any) => {
        interceptedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ id: "1", choices: [] }), { status: 200 });
      };

      const openai = createOpenAI({
        apiKey: "mock",
        fetch: mockFetch,
      });

      const model = openai("o3-mini");
      try {
        const res = await streamText({
          model,
          messages: [{ role: "user", content: "hello" }],
          reasoning: "high",
        });
        for await (const _chunk of res.textStream) {}
      } catch {}

      expect(interceptedBody?.reasoning).toEqual({
        effort: "high",
        summary: "detailed",
      });
    });

    it("maps native reasoning to Anthropic request with extended thinking for Claude 3.7", async () => {
      let interceptedBody: any;
      const mockFetch: any = async (_url: any, init: any) => {
        interceptedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ id: "1", type: "message", content: [] }), {
          status: 200,
        });
      };

      const anthropic = createAnthropic({
        apiKey: "mock",
        fetch: mockFetch,
      });

      const model = anthropic("claude-3-7-sonnet-20250219");
      try {
        const res = await streamText({
          model,
          messages: [{ role: "user", content: "hello" }],
          reasoning: "medium",
        });
        for await (const _chunk of res.textStream) {}
      } catch {}

      // For Claude 3.7, AI SDK v7 resolves native reasoning to extended thinking:
      // { type: "enabled", budget_tokens: ... } (NOT adaptive thinking)
      expect(interceptedBody?.thinking?.type).toBe("enabled");
      expect(typeof interceptedBody?.thinking?.budget_tokens).toBe("number");
      expect(interceptedBody?.thinking?.budget_tokens).toBeGreaterThan(0);
      expect(interceptedBody?.effort).toBeUndefined();
    });

    it("maps native reasoning to Google request merging includeThoughts without overriding budget", async () => {
      let interceptedBody: any;
      const mockFetch: any = async (_url: any, init: any) => {
        interceptedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
      };

      const google = createGoogleGenerativeAI({
        apiKey: "mock",
        fetch: mockFetch,
      });

      const model = google("gemini-2.5-flash");
      const providerOptions = buildReasoningProviderOptions({ type: "google" }, "high");

      try {
        const res = await streamText({
          model,
          messages: [{ role: "user", content: "hello" }],
          reasoning: "high",
          providerOptions,
        });
        for await (const _chunk of res.textStream) {}
      } catch {}

      expect(interceptedBody?.generationConfig?.thinkingConfig?.includeThoughts).toBe(true);
      expect(typeof interceptedBody?.generationConfig?.thinkingConfig?.thinkingBudget).toBe(
        "number",
      );
      expect(
        interceptedBody?.generationConfig?.thinkingConfig?.thinkingBudget,
      ).toBeGreaterThan(0);
    });

    it("omits reasoning property entirely when reasoning is 'off'", async () => {
      let interceptedBody: any;
      const mockFetch: any = async (_url: any, init: any) => {
        interceptedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ id: "1", choices: [] }), { status: 200 });
      };

      const openai = createOpenAI({
        apiKey: "mock",
        fetch: mockFetch,
      });

      const model = openai("gpt-4o");
      try {
        const res = await streamText({
          model,
          messages: [{ role: "user", content: "hello" }],
        });
        for await (const _chunk of res.textStream) {}
      } catch {}

      expect(interceptedBody?.reasoning).toBeUndefined();
    });
  });
});
