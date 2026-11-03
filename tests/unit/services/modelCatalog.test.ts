import { beforeEach, describe, expect, it } from "bun:test";
import {
  _resetModelCatalogCache,
  enrichModels,
  getModelCatalog,
  isEligibleForCatalogEnrichment,
  normalizeCatalogLimits,
  CATALOG_TTL_MS,
  CATALOG_FETCH_TIMEOUT_MS,
} from "@/services/modelCatalog";
import type { ModelOption } from "@/types";

describe("modelCatalog service", () => {
  beforeEach(() => {
    _resetModelCatalogCache();
  });

  describe("exact provider/model identity and endpoint restrictions", () => {
    it("accepts official providers on default endpoints", () => {
      expect(isEligibleForCatalogEnrichment({ type: "openai" })).toBe("openai");
      expect(isEligibleForCatalogEnrichment({ type: "openai", endpoint: "https://api.openai.com/v1" })).toBe("openai");
      expect(isEligibleForCatalogEnrichment({ type: "openai", endpoint: "https://api.openai.com/v1/" })).toBe("openai");

      expect(isEligibleForCatalogEnrichment({ type: "anthropic" })).toBe("anthropic");
      expect(isEligibleForCatalogEnrichment({ type: "anthropic", endpoint: "https://api.anthropic.com" })).toBe("anthropic");

      expect(isEligibleForCatalogEnrichment({ type: "google" })).toBe("google");
      expect(isEligibleForCatalogEnrichment({ type: "google", endpoint: "https://generativelanguage.googleapis.com/" })).toBe("google");
    });

    it("rejects custom and ollama providers", () => {
      expect(isEligibleForCatalogEnrichment({ type: "custom" })).toBeNull();
      expect(isEligibleForCatalogEnrichment({ type: "custom", endpoint: "https://api.openai.com/v1" })).toBeNull();
      expect(isEligibleForCatalogEnrichment({ type: "ollama" })).toBeNull();
      expect(isEligibleForCatalogEnrichment({ type: "ollama", endpoint: "http://localhost:11434" })).toBeNull();
    });

    it("rejects official providers configured with non-default endpoints", () => {
      expect(isEligibleForCatalogEnrichment({ type: "openai", endpoint: "https://my-proxy.internal/v1" })).toBeNull();
      expect(isEligibleForCatalogEnrichment({ type: "anthropic", endpoint: "https://anthropic.internal" })).toBeNull();
      expect(isEligibleForCatalogEnrichment({ type: "google", endpoint: "https://custom-google.internal" })).toBeNull();
    });

    it("enriches matching model id case-sensitively and leaves unmatched models unchanged", async () => {
      const mockPayload = {
        openai: {
          models: {
            "gpt-4o": { limit: { context: 128000, input: 128000, output: 4096 } },
          },
        },
      };

      const mockFetch = async () => new Response(JSON.stringify(mockPayload), { status: 200 });

      const models: ModelOption[] = [
        { id: "gpt-4o", provider: "openai" },
        { id: "GPT-4O", provider: "openai" }, // Case difference -> no match
        { id: "unmatched-model", provider: "openai" },
      ];

      const enriched = await enrichModels(models, { type: "openai" }, { fetchFn: mockFetch as any });

      expect(enriched[0].contextWindow).toBe(128000);
      expect(enriched[0].contextWindowSource).toBe("model_catalog");
      expect(enriched[0].maxOutputTokens).toBe(4096);
      expect(enriched[0].maxOutputTokensSource).toBe("model_catalog");

      expect(enriched[1].contextWindow).toBeUndefined();
      expect(enriched[2].contextWindow).toBeUndefined();
    });
  });

  describe("context and input normalization", () => {
    it("uses min(context, input) when input is smaller than context", () => {
      const res = normalizeCatalogLimits({
        limit: { context: 400000, input: 272000, output: 128000 },
      });
      expect(res.contextWindow).toBe(272000);
      expect(res.maxOutputTokens).toBe(128000);
    });

    it("uses context when input is larger than context (anomalous row)", () => {
      const res = normalizeCatalogLimits({
        limit: { context: 64000, input: 256000, output: 4096 },
      });
      expect(res.contextWindow).toBe(64000);
      expect(res.maxOutputTokens).toBe(4096);
    });

    it("uses input when context is missing", () => {
      const res = normalizeCatalogLimits({
        limit: { input: 128000 },
      });
      expect(res.contextWindow).toBe(128000);
      expect(res.maxOutputTokens).toBeUndefined();
    });

    it("uses context when input is missing", () => {
      const res = normalizeCatalogLimits({
        limit: { context: 128000 },
      });
      expect(res.contextWindow).toBe(128000);
      expect(res.maxOutputTokens).toBeUndefined();
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
      const mockFetch = async () => {
        fetchCount++;
        return new Response(JSON.stringify({ openai: { models: { "gpt-4o": { limit: { context: 128000 } } } } }), {
          status: 200,
        });
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
      const mockFetch = async () => {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify({ openai: { models: { "gpt-4o": { limit: { context: 128000 } } } } }), {
          status: 200,
        });
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

    it("returns last-known-good when refresh fails", async () => {
      let fail = false;
      const mockFetch = async () => {
        if (fail) throw new Error("Network down");
        return new Response(JSON.stringify({ openai: { models: { "gpt-4o": { limit: { context: 128000 } } } } }), {
          status: 200,
        });
      };

      let time = 1_000_000;
      const now = () => time;

      const first = await getModelCatalog({ fetchFn: mockFetch as any, now });
      expect(first).not.toBeNull();
      expect(first?.providers.get("openai")?.get("gpt-4o")?.contextWindow).toBe(128000);

      // Expire TTL and fail next fetch
      time += CATALOG_TTL_MS + 1000;
      fail = true;

      const second = await getModelCatalog({ fetchFn: mockFetch as any, now });
      // Retains cached data
      expect(second).toBe(first);
      expect(second?.providers.get("openai")?.get("gpt-4o")?.contextWindow).toBe(128000);
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
      const mockPayload = {
        openai: {
          models: {
            "gpt-4o": { limit: { context: 128000, output: 4096 } },
          },
        },
      };
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

      const enriched = await enrichModels(models, { type: "openai" }, { fetchFn: mockFetch as any });
      expect(enriched[0].contextWindow).toBe(200000);
      expect(enriched[0].contextWindowSource).toBe("provider_reported");
      expect(enriched[0].maxOutputTokens).toBe(8192);
      expect(enriched[0].maxOutputTokensSource).toBe("provider_reported");
    });
  });
});
