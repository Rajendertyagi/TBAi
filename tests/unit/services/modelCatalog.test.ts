import { beforeEach, describe, expect, it } from "bun:test";
import {
  _resetModelCatalogCache,
  enrichModels,
  getModelCatalog,
  isEligibleForCatalogEnrichment,
  isValidCatalogPayload,
  normalizeCatalogLimits,
  CATALOG_TTL_MS,
} from "@/services/modelCatalog";
import type { ModelOption } from "@/types";

const createValidMockPayload = () => ({
  openai: {
    models: {
      "gpt-4o": { limit: { context: 128000, input: 128000 } },
    },
  },
  anthropic: {
    models: {
      "claude-3-5-sonnet-20241022": { limit: { context: 200000 } },
    },
  },
  google: {
    models: {
      "gemini-1.5-pro": { limit: { context: 2000000 } },
    },
  },
});

describe("modelCatalog service", () => {
  beforeEach(() => {
    _resetModelCatalogCache();
  });

  describe("exact provider/model identity and endpoint restrictions", () => {
    it("accepts official providers on default endpoints", () => {
      expect(isEligibleForCatalogEnrichment({ type: "openai" })).toBe("openai");
      expect(
        isEligibleForCatalogEnrichment({ type: "openai", endpoint: "https://api.openai.com/v1" }),
      ).toBe("openai");
      expect(
        isEligibleForCatalogEnrichment({ type: "openai", endpoint: "https://api.openai.com/v1/" }),
      ).toBe("openai");

      expect(isEligibleForCatalogEnrichment({ type: "anthropic" })).toBe("anthropic");
      expect(
        isEligibleForCatalogEnrichment({
          type: "anthropic",
          endpoint: "https://api.anthropic.com",
        }),
      ).toBe("anthropic");

      expect(isEligibleForCatalogEnrichment({ type: "google" })).toBe("google");
      expect(
        isEligibleForCatalogEnrichment({
          type: "google",
          endpoint: "https://generativelanguage.googleapis.com/",
        }),
      ).toBe("google");
    });

    it("rejects custom and ollama providers", () => {
      expect(isEligibleForCatalogEnrichment({ type: "custom" })).toBeNull();
      expect(
        isEligibleForCatalogEnrichment({ type: "custom", endpoint: "https://api.openai.com/v1" }),
      ).toBeNull();
      expect(isEligibleForCatalogEnrichment({ type: "ollama" })).toBeNull();
      expect(
        isEligibleForCatalogEnrichment({ type: "ollama", endpoint: "http://localhost:11434" }),
      ).toBeNull();
    });

    it("rejects official providers configured with non-default endpoints", () => {
      expect(
        isEligibleForCatalogEnrichment({
          type: "openai",
          endpoint: "https://my-proxy.internal/v1",
        }),
      ).toBeNull();
      expect(
        isEligibleForCatalogEnrichment({
          type: "anthropic",
          endpoint: "https://anthropic.internal",
        }),
      ).toBeNull();
      expect(
        isEligibleForCatalogEnrichment({
          type: "google",
          endpoint: "https://custom-google.internal",
        }),
      ).toBeNull();
    });

    it("enriches matching model id case-sensitively and leaves unmatched models unchanged (context window only)", async () => {
      const mockPayload = createValidMockPayload();
      const mockFetch = async () => new Response(JSON.stringify(mockPayload), { status: 200 });

      const models: ModelOption[] = [
        { id: "gpt-4o", provider: "openai" },
        { id: "GPT-4O", provider: "openai" }, // Case difference -> no match
        { id: "unmatched-model", provider: "openai" },
      ];

      const enriched = await enrichModels(
        models,
        { type: "openai" },
        { fetchFn: mockFetch as any },
      );

      expect(enriched[0].contextWindow).toBe(128000);
      expect(enriched[0].contextWindowSource).toBe("model_catalog");
      // Output limits must NOT be touched in P1
      expect(enriched[0].maxOutputTokens).toBeUndefined();
      expect(enriched[0].maxOutputTokensSource).toBeUndefined();

      expect(enriched[1].contextWindow).toBeUndefined();
      expect(enriched[2].contextWindow).toBeUndefined();
    });
  });

  describe("structural payload validation (isValidCatalogPayload)", () => {
    it("validates a structurally compliant payload", () => {
      expect(isValidCatalogPayload(createValidMockPayload())).toBe(true);
    });

    it("rejects null, non-objects, arrays, and empty root", () => {
      expect(isValidCatalogPayload(null)).toBe(false);
      expect(isValidCatalogPayload(undefined)).toBe(false);
      expect(isValidCatalogPayload("string")).toBe(false);
      expect(isValidCatalogPayload(123)).toBe(false);
      expect(isValidCatalogPayload([])).toBe(false);
      expect(isValidCatalogPayload({})).toBe(false);
    });

    it("rejects payload missing any recognized core provider (e.g. OpenAI-only payload)", () => {
      const openAiOnly = {
        openai: {
          models: { "gpt-4o": { limit: { context: 128000 } } },
        },
      };
      expect(isValidCatalogPayload(openAiOnly)).toBe(false);
    });

    it("rejects payload when a recognized provider has an empty models map", () => {
      const payload = createValidMockPayload();
      (payload as any).anthropic.models = {};
      expect(isValidCatalogPayload(payload)).toBe(false);
    });

    it("rejects payload when limit.context is negative, non-finite, or not a number", () => {
      const negPayload = createValidMockPayload();
      (negPayload.openai.models["gpt-4o"] as any).limit.context = -1;
      expect(isValidCatalogPayload(negPayload)).toBe(false);

      const nanPayload = createValidMockPayload();
      (nanPayload.openai.models["gpt-4o"] as any).limit.context = NaN;
      expect(isValidCatalogPayload(nanPayload)).toBe(false);

      const strPayload = createValidMockPayload();
      (strPayload.openai.models["gpt-4o"] as any).limit.context = "128000";
      expect(isValidCatalogPayload(strPayload)).toBe(false);
    });

    it("rejects payload when limit.input is present but negative, non-finite, or not a number", () => {
      const negInputPayload = createValidMockPayload();
      (negInputPayload.openai.models["gpt-4o"] as any).limit.input = -500;
      expect(isValidCatalogPayload(negInputPayload)).toBe(false);

      const strInputPayload = createValidMockPayload();
      (strInputPayload.openai.models["gpt-4o"] as any).limit.input = "128k";
      expect(isValidCatalogPayload(strInputPayload)).toBe(false);
    });

    it("accepts payload when limit.context is 0 (structurally non-negative, though unusable in TBAi)", () => {
      const zeroPayload = createValidMockPayload();
      (zeroPayload.openai.models["gpt-4o"] as any).limit.context = 0;
      expect(isValidCatalogPayload(zeroPayload)).toBe(true);
    });
  });

  describe("context and input normalization", () => {
    it("uses min(context, input) when input is smaller than context", () => {
      const res = normalizeCatalogLimits({
        limit: { context: 400000, input: 272000 },
      });
      expect(res.contextWindow).toBe(272000);
    });

    it("uses context when input is larger than context (anomalous row)", () => {
      const res = normalizeCatalogLimits({
        limit: { context: 64000, input: 256000 },
      });
      expect(res.contextWindow).toBe(64000);
    });

    it("falls back to context when input is 0 or non-integer float (structurally valid but unusable)", () => {
      const resZero = normalizeCatalogLimits({
        limit: { context: 128000, input: 0 },
      });
      expect(resZero.contextWindow).toBe(128000);

      const resFloat = normalizeCatalogLimits({
        limit: { context: 128000, input: 128000.5 },
      });
      expect(resFloat.contextWindow).toBe(128000);
    });

    it("uses input when context is missing", () => {
      const res = normalizeCatalogLimits({
        limit: { input: 128000 },
      });
      expect(res.contextWindow).toBe(128000);
    });

    it("uses context when input is missing", () => {
      const res = normalizeCatalogLimits({
        limit: { context: 128000 },
      });
      expect(res.contextWindow).toBe(128000);
    });

    it("rejects non-positive, non-integer, and non-numeric limits", () => {
      expect(normalizeCatalogLimits({ limit: { context: -100 } })).toEqual({});
      expect(normalizeCatalogLimits({ limit: { context: 0 } })).toEqual({});
      expect(normalizeCatalogLimits({ limit: { context: 128000.5 } })).toEqual({});
      expect(normalizeCatalogLimits({ limit: { context: "128000" } })).toEqual({});
      expect(normalizeCatalogLimits({ limit: { context: NaN } })).toEqual({});
      expect(normalizeCatalogLimits({ limit: { context: Infinity } })).toEqual({});
      expect(normalizeCatalogLimits(null)).toEqual({});
      expect(normalizeCatalogLimits({})).toEqual({});
    });
  });

  describe("cache TTL, deduplication, timeout, and last-known-good behavior", () => {
    it("caches results for the duration of the TTL", async () => {
      let fetchCount = 0;
      const mockPayload = createValidMockPayload();
      const mockFetch = async () => {
        fetchCount++;
        return new Response(JSON.stringify(mockPayload), { status: 200 });
      };

      let time = 1_000_000;
      const now = () => time;

      await getModelCatalog({ fetchFn: mockFetch as any, now });
      expect(fetchCount).toBe(1);

      // Subsequent call within TTL -> cached
      time += CATALOG_TTL_MS - 1000;
      await getModelCatalog({ fetchFn: mockFetch as any, now });
      expect(fetchCount).toBe(1);

      // Call past TTL -> re-fetches
      time += 2000;
      await getModelCatalog({ fetchFn: mockFetch as any, now });
      expect(fetchCount).toBe(2);
    });

    it("deduplicates in-flight concurrent requests", async () => {
      let fetchCount = 0;
      const mockPayload = createValidMockPayload();
      const mockFetch = async () => {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify(mockPayload), { status: 200 });
      };

      const [res1, res2, res3] = await Promise.all([
        getModelCatalog({ fetchFn: mockFetch as any }),
        getModelCatalog({ fetchFn: mockFetch as any }),
        getModelCatalog({ fetchFn: mockFetch as any }),
      ]);

      expect(fetchCount).toBe(1);
      expect(res1).toBe(res2);
      expect(res2).toBe(res3);
    });

    it("returns last-known-good when refresh fails with network error", async () => {
      let fail = false;
      const validPayload = createValidMockPayload();
      const mockFetch = async () => {
        if (fail) throw new Error("Network down");
        return new Response(JSON.stringify(validPayload), { status: 200 });
      };

      let time = 1_000_000;
      const now = () => time;

      const first = await getModelCatalog({ fetchFn: mockFetch as any, now });
      expect(first).not.toBeNull();
      expect(first?.providers.get("openai")?.get("gpt-4o")?.contextWindow).toBe(128000);
      expect(
        first?.providers.get("anthropic")?.get("claude-3-5-sonnet-20241022")?.contextWindow,
      ).toBe(200000);

      // Expire TTL and fail next fetch with network error
      time += CATALOG_TTL_MS + 1000;
      fail = true;

      const second = await getModelCatalog({ fetchFn: mockFetch as any, now });
      // Retains cached data
      expect(second).toBe(first);
      expect(second?.providers.get("openai")?.get("gpt-4o")?.contextWindow).toBe(128000);
      expect(
        second?.providers.get("anthropic")?.get("claude-3-5-sonnet-20241022")?.contextWindow,
      ).toBe(200000);
    });

    it("returns last-known-good when refresh encounters a malformed provider entry (e.g. anthropic: null)", async () => {
      let malformed = false;
      const validPayload = createValidMockPayload();
      const mockFetch = async () => {
        if (malformed) {
          // Valid openai and google, but malformed anthropic
          const corrupted = {
            openai: {
              models: {
                "gpt-4o": { limit: { context: 128000, input: 128000 } },
              },
            },
            anthropic: null,
            google: {
              models: {
                "gemini-1.5-pro": { limit: { context: 2000000 } },
              },
            },
          };
          return new Response(JSON.stringify(corrupted), { status: 200 });
        }
        return new Response(JSON.stringify(validPayload), { status: 200 });
      };

      let time = 1_000_000;
      const now = () => time;

      const first = await getModelCatalog({ fetchFn: mockFetch as any, now });
      expect(first).not.toBeNull();
      expect(first?.providers.get("openai")?.get("gpt-4o")?.contextWindow).toBe(128000);
      expect(
        first?.providers.get("anthropic")?.get("claude-3-5-sonnet-20241022")?.contextWindow,
      ).toBe(200000);
      expect(first?.providers.get("google")?.get("gemini-1.5-pro")?.contextWindow).toBe(2000000);

      // Expire TTL and attempt refresh with corrupted payload
      time += CATALOG_TTL_MS + 1000;
      malformed = true;

      const second = await getModelCatalog({ fetchFn: mockFetch as any, now });
      // Retains complete cached data from first run; no partial replacement
      expect(second).toBe(first);
      expect(second?.providers.get("openai")?.get("gpt-4o")?.contextWindow).toBe(128000);
      expect(
        second?.providers.get("anthropic")?.get("claude-3-5-sonnet-20241022")?.contextWindow,
      ).toBe(200000);
      expect(second?.providers.get("google")?.get("gemini-1.5-pro")?.contextWindow).toBe(2000000);
    });

    it("returns null gracefully if initial fetch fails without prior snapshot", async () => {
      const mockFetch = async () => {
        throw new Error("Initial failure");
      };
      const res = await getModelCatalog({ fetchFn: mockFetch as any });
      expect(res).toBeNull();
    });
  });

  describe("enrichment non-overwriting guarantees", () => {
    it("does not overwrite existing provider_reported or configured values", async () => {
      const mockPayload = createValidMockPayload();
      const mockFetch = async () => new Response(JSON.stringify(mockPayload), { status: 200 });

      const models: ModelOption[] = [
        {
          id: "gpt-4o",
          provider: "openai",
          contextWindow: 200000,
          contextWindowSource: "provider_reported",
          maxOutputTokens: 8192,
          maxOutputTokensSource: "provider_reported",
        },
      ];

      const enriched = await enrichModels(
        models,
        { type: "openai" },
        { fetchFn: mockFetch as any },
      );
      expect(enriched[0].contextWindow).toBe(200000);
      expect(enriched[0].contextWindowSource).toBe("provider_reported");
      expect(enriched[0].maxOutputTokens).toBe(8192);
      expect(enriched[0].maxOutputTokensSource).toBe("provider_reported");
    });
  });
});
