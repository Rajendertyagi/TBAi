/**
 * Dynamic capability extraction from provider listings.
 *
 * ## The two properties worth protecting
 *
 * 1. **A limit that IS published must be found.** The pre-R2 parser read
 *    `max_input_tokens` for Anthropic and discarded every other field, so an
 *    OpenAI-compatible gateway advertising `context_length` produced a model with no
 *    window at all and silently fell back to the ceiling.
 *
 * 2. **A limit that is NOT published must NOT be invented.** This is the stricter
 *    half, and the reason these tests carry more malformed-input cases than
 *    happy-path ones. A listing with no limits must yield `undefined` — not the
 *    fallback, and not a number guessed from the model's name. Verified against the
 *    live `agnes` endpoint, whose 12 entries expose only
 *    `created/id/object/owned_by/supported_endpoint_types`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  CONTEXT_LIMIT_FIELDS,
  OUTPUT_LIMIT_FIELDS,
  extractCapabilities,
  extractOllamaModelInfoLimits,
  limitRuleFor,
  validTokenCount,
} from "./capabilityDiscovery";
import { discoverModels } from "./modelDiscovery";

const origFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Serve one listing payload for any `.../models` request. */
function installListingMock(payload: unknown): void {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/models")) return jsonResponse(payload);
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = origFetch;
});

// ─── token sanity ──────────────────────────────────────────────────────────

describe("only a usable token count is ever accepted", () => {
  it("accepts positive finite numbers", () => {
    expect(validTokenCount(131_072)).toBe(131_072);
    expect(validTokenCount(1000.9)).toBe(1000);
  });

  it("rejects every shape a malformed listing can produce", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, "200000", {}]) {
      expect(validTokenCount(bad)).toBeUndefined();
    }
  });

  it("keeps the exported guard strict — a string is not a token count", () => {
    // `validTokenCount` is a type guard, not a parser. String coercion happens in the
    // reader, which is the only place a raw listing is interpreted, so a loose
    // conversion can never leak into a budget computed from an already-typed field.
    expect(validTokenCount("32768")).toBeUndefined();
  });

  it("still reads a numeric string off a listing, because Ollama sends one", () => {
    expect(extractCapabilities({ id: "m", context_length: "32768" }).contextWindow?.value).toBe(32_768);
    expect(extractCapabilities({ id: "m", context_length: "not-a-number" }).contextWindow).toBeUndefined();
    expect(extractCapabilities({ id: "m", context_length: "" }).contextWindow).toBeUndefined();
  });
});

// ─── discovery of published limits ─────────────────────────────────────────

describe("a published limit is found regardless of the field it uses", () => {
  it("reads every known context field name", () => {
    for (const field of CONTEXT_LIMIT_FIELDS) {
      const found = extractCapabilities({ id: "m", [field]: 200_000 });
      expect(found.contextWindow?.value).toBe(200_000);
      expect(found.contextWindow?.field).toBe(field);
    }
  });

  it("reads every known output field name", () => {
    for (const field of OUTPUT_LIMIT_FIELDS) {
      const found = extractCapabilities({ id: "m", [field]: 8_192 });
      expect(found.maxOutputTokens?.value).toBe(8_192);
      expect(found.maxOutputTokens?.field).toBe(field);
    }
  });

  it("reads context and output independently", () => {
    const found = extractCapabilities({ id: "m", context_length: 1_000_000, max_completion_tokens: 16_384 });
    expect(found.contextWindow?.value).toBe(1_000_000);
    expect(found.maxOutputTokens?.value).toBe(16_384);
  });

  it("finds limits nested under a declared wrapper", () => {
    // OpenRouter's shape. The wrapper is SHAPE knowledge; no value is attached.
    const found = extractCapabilities(
      { id: "m", top_provider: { context_length: 1_000_000, max_completion_tokens: 32_768 } },
      limitRuleFor("custom"),
    );
    expect(found.contextWindow?.value).toBe(1_000_000);
    expect(found.maxOutputTokens?.value).toBe(32_768);
  });

  it("prefers the entry itself over a wrapper", () => {
    const found = extractCapabilities(
      { id: "m", context_length: 111, top_provider: { context_length: 222 } },
      limitRuleFor("custom"),
    );
    expect(found.contextWindow?.value).toBe(111);
  });

  it("falls back to the flat layout for an unknown provider type", () => {
    expect(limitRuleFor("some-future-provider").wrappers).toEqual([]);
    expect(extractCapabilities({ id: "m", context_length: 8_000 }, limitRuleFor("x")).contextWindow?.value).toBe(
      8_000,
    );
  });
});

// ─── absence is reported, never filled in ──────────────────────────────────

describe("an unpublished limit stays unknown", () => {
  it("returns nothing for a pure identity listing", () => {
    // The live `agnes` shape, verbatim field-for-field.
    const found = extractCapabilities({
      id: "agnes-3.0-flash",
      object: "model",
      created: 1_700_000_000,
      owned_by: "agnes",
      supported_endpoint_types: ["chat"],
    });
    expect(found.contextWindow).toBeUndefined();
    expect(found.maxOutputTokens).toBeUndefined();
  });

  it("does not fabricate from the model's name", () => {
    // A name that LOOKS like it carries a size must still resolve to unknown.
    for (const id of ["model-1m", "gpt-512k", "flash-200000", "pro-1m-context"]) {
      expect(extractCapabilities({ id }).contextWindow).toBeUndefined();
    }
  });

  it("treats an unusable published value as unknown rather than as a number", () => {
    for (const bad of [0, -5, "many", null, Number.NaN]) {
      expect(extractCapabilities({ id: "m", context_length: bad }).contextWindow).toBeUndefined();
    }
  });

  it("skips a malformed field and keeps a usable sibling", () => {
    const found = extractCapabilities({ id: "m", max_input_tokens: 0, context_length: 64_000 });
    expect(found.contextWindow?.value).toBe(64_000);
    expect(found.contextWindow?.field).toBe("context_length");
  });

  it("survives a non-object entry", () => {
    expect(extractCapabilities(null)).toEqual({});
    expect(extractCapabilities("nope")).toEqual({});
    expect(extractCapabilities(undefined)).toEqual({});
  });
});

// ─── Ollama's suffixed keys ────────────────────────────────────────────────

describe("Ollama model_info limits are read by parameter name", () => {
  it("reads architecture-suffixed keys", () => {
    const found = extractOllamaModelInfoLimits({
      "llama.context_length": 131_072,
      "llama.max_tokens": 4_096,
    });
    expect(found.contextWindow?.value).toBe(131_072);
    expect(found.maxOutputTokens?.value).toBe(4_096);
  });

  it("returns unknown for a model_info without limits", () => {
    expect(extractOllamaModelInfoLimits({ "llama.rope.dimension": 4096 })).toEqual({});
    expect(extractOllamaModelInfoLimits(null)).toEqual({});
  });
});

// ─── through the real discovery path ───────────────────────────────────────

describe("discovery records limits with provider_reported provenance", () => {
  const NOW = 1_800_000_000_000;

  it("picks up context_length from an OpenAI-compatible listing", async () => {
    installListingMock({ data: [{ id: "agnes-3.0-flash", context_length: 1_000_000, max_completion_tokens: 32_768 }] });
    const [model] = await discoverModels({ type: "custom", endpoint: "http://a/v1", now: () => NOW });
    expect(model?.contextWindow).toBe(1_000_000);
    expect(model?.contextWindowSource).toBe("provider_reported");
    expect(model?.maxOutputTokens).toBe(32_768);
    expect(model?.maxOutputTokensSource).toBe("provider_reported");
    expect(model?.discoveredAt).toBe(NOW);
  });

  it("still reads Anthropic's max_input_tokens (no regression)", async () => {
    installListingMock({ data: [{ id: "claude-x", max_input_tokens: 200_000, max_output_tokens: 8_192 }] });
    const [model] = await discoverModels({ type: "anthropic", endpoint: "http://a", apiKey: "k", now: () => NOW });
    expect(model?.contextWindow).toBe(200_000);
    expect(model?.contextWindowSource).toBe("provider_reported");
    expect(model?.maxOutputTokens).toBe(8_192);
  });

  it("reads Google's camelCased limits", async () => {
    installListingMock({ models: [{ name: "models/gemini-x", inputTokenLimit: 1_048_576, outputTokenLimit: 8_192 }] });
    const [model] = await discoverModels({ type: "google", endpoint: "http://a", apiKey: "k", now: () => NOW });
    expect(model?.contextWindow).toBe(1_048_576);
    expect(model?.maxOutputTokens).toBe(8_192);
  });

  it("leaves an identity-only listing with NO value and NO stance", async () => {
    installListingMock({ data: [{ id: "agnes-3.0-flash", object: "model", owned_by: "agnes" }] });
    const [model] = await discoverModels({ type: "custom", endpoint: "http://a/v1", now: () => NOW });
    // The critical assertion: no window, and crucially NO source claiming one.
    expect(model?.contextWindow).toBeUndefined();
    expect(model?.contextWindowSource).toBeUndefined();
    // Freshness is still recorded, so "read and found nothing" is distinguishable
    // from "never read".
    expect(model?.discoveredAt).toBe(NOW);
  });

  it("shares one timestamp across a single listing pass", async () => {
    installListingMock({ data: [{ id: "flash-a", context_length: 1 }, { id: "flash-b" }] });
    const models = await discoverModels({ type: "custom", endpoint: "http://a/v1", now: () => NOW });
    expect(models.map((m) => m.discoveredAt)).toEqual([NOW, NOW]);
  });

  it("does not let one provider's endpoint inform another's", async () => {
    // Same model id, two endpoints, different advertised windows. Discovery is
    // per-call and carries no cross-provider state, so this is structural.
    installListingMock({ data: [{ id: "agnes-2.5-pro", context_length: 200_000 }] });
    const [first] = await discoverModels({ type: "custom", endpoint: "http://a/v1", now: () => NOW });
    installListingMock({ data: [{ id: "agnes-2.5-pro", context_length: 1_000_000 }] });
    const [second] = await discoverModels({ type: "custom", endpoint: "http://b/v1", now: () => NOW });
    expect(first?.contextWindow).toBe(200_000);
    expect(second?.contextWindow).toBe(1_000_000);
  });
});
