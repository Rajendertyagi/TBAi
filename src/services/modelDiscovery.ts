import {
  extractCapabilities,
  extractOllamaModelInfoLimits,
  limitRuleFor,
  type ExtractedCapabilities,
} from "./capabilityDiscovery";
import { providerReportedLimit, type ModelCapabilities, type ModelOption, type ProviderConfig } from "../types";

export type DiscoverInput = {
  type: ProviderConfig["type"];
  endpoint?: string;
  apiKey?: string;
  /**
   * Clock source, injected so a listing's freshness is deterministic in tests.
   *
   * Defaults to the wall clock. It is read ONCE per pass, so every entry in one
   * listing shares a timestamp.
   */
  now?: () => number;
};

const DEFAULT_BASE: Record<ProviderConfig["type"], string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  ollama: "http://localhost:11434",
  custom: "",
};

function joinBase(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 15000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Provider returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Modalities that can never serve as chat models. This is the legitimate half
 * of discovery filtering ("is this usable as a model?").
 */
function isExcludedModality(lowerId: string): boolean {
  return /embed|text-embedding|dall-e|flux|stable-diffusion|whisper|tts|imagen|rerank|image-|video-/.test(lowerId);
}

/**
 * Legacy family allowlist. This is a discovery-noise filter only — it answers
 * "have we seen this family before", never "what can this model do". It must
 * NOT grow into a capability mechanism: capability metadata comes exclusively
 * from truthful per-model sources via ModelCapabilities. New families must be
 * handled by richer discovery, not by extending this expression.
 */
function isKnownChatFamily(lowerId: string, type: string): boolean {
  return /gpt|claude|gemini|llama|qwen|mistral|deepseek|codestral|sonnet|opus|haiku|flash|pro|yi|grok|phi|command|nighttales/.test(lowerId) || type === "ollama";
}

function isChatModel(id: string, type: string): boolean {
  const lower = id.toLowerCase();
  return !isExcludedModality(lower) && isKnownChatFamily(lower, type);
}

/** Single owner of the "no source has reported anything yet" capability state. */
function unknownReasoning(): ModelCapabilities {
  return { reasoning: { support: "unknown" } };
}

/**
 * Ollama `/api/show` capability lookup. Contract: POST {model} →
 * `{ capabilities?: unknown, model_info?: unknown }`.
 *
 * `capabilities` holds lowercase tokens such as "thinking"; only an explicitly
 * reported "thinking" entry yields reasoning supported, and a missing/unreachable/
 * malformed source stays unknown — never unsupported.
 *
 * `model_info` is Ollama's truthful per-model LIMIT source, keyed by architecture
 * (e.g. `{ "llama.context_length": 131072 }`). Reading it here means a local Ollama
 * model no longer falls back to the ceiling either.
 *
 * Shape-guarded throughout: an unexpected daemon response degrades one model to
 * unknown instead of breaking discovery.
 */
async function fetchOllamaModel(
  base: string,
  model: string,
): Promise<{ capabilities: ModelCapabilities; limits: ExtractedCapabilities }> {
  const unknown = { capabilities: unknownReasoning(), limits: {} as ExtractedCapabilities };
  try {
    const raw = (await fetchJson(joinBase(base, "api/show"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    })) as { capabilities?: unknown; model_info?: unknown };
    const caps = raw?.capabilities;
    const capabilities =
      Array.isArray(caps) && caps.some((c) => c === "thinking")
        ? { reasoning: { support: "supported" as const } }
        : unknownReasoning();
    return { capabilities, limits: extractOllamaModelInfoLimits(raw?.model_info) };
  } catch {
    return unknown;
  }
}

/** Bounded parallel fan-out (no dependency, no retries, no sleeps). */
const OLLAMA_SHOW_CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) continue;
      out[index] = await fn(item);
    }
  };
  const pool = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return out;
}

/**
 * Project extracted limits onto a `ModelOption`.
 *
 * A value read out of the provider's own listing is `provider_reported` and is
 * written through the shared writer, so "a human typed it" and "the provider said
 * it" can never be confused. An absent limit yields an absent value AND an absent
 * stance — never a fabricated one, and never the fallback, which is the budget's
 * decision and not discovery's.
 */
function withExtractedLimits(
  base: Omit<ModelOption, "contextWindow" | "contextWindowSource" | "maxOutputTokens" | "maxOutputTokensSource">,
  limits: ExtractedCapabilities,
  discoveredAt: number,
): ModelOption {
  const contextWindow = limits.contextWindow ? providerReportedLimit(limits.contextWindow.value) : undefined;
  const maxOutputTokens = limits.maxOutputTokens ? providerReportedLimit(limits.maxOutputTokens.value) : undefined;
  return {
    ...base,
    ...(contextWindow ? { contextWindow: contextWindow.value, contextWindowSource: contextWindow.source } : {}),
    ...(maxOutputTokens
      ? { maxOutputTokens: maxOutputTokens.value, maxOutputTokensSource: maxOutputTokens.source }
      : {}),
    discoveredAt,
  };
}

function normalizeOpenAI(raw: any, provider: string, discoveredAt: number): ModelOption[] {
  const data = Array.isArray(raw?.data) ? raw.data : [];
  return data
    // R2: the entry is read for its LIMITS, not just its id. A listing that omits
    // them yields no value and no stance — still unknown, never invented.
    .map((m: any) => ({ id: String(m?.id ?? "").trim(), raw: m }))
    .filter((m: { id: string }) => Boolean(m.id) && isChatModel(m.id, provider))
    .map(({ id, raw }) =>
      withExtractedLimits(
        // OpenAI-compatible listings expose no reasoning metadata, so that half
        // stays unknown.
        { id, provider, capabilities: unknownReasoning() },
        extractCapabilities(raw, limitRuleFor(provider)),
        discoveredAt,
      ),
    );
}

function normalizeAnthropic(raw: any, provider: string, discoveredAt: number): ModelOption[] {
  const data = Array.isArray(raw?.data) ? raw.data : [];
  return data
    .map((m: any) => {
      const id = String(m?.id ?? "").trim();
      if (!id || !isChatModel(id, provider)) return null;
      // `max_input_tokens` / `max_output_tokens` are read generically now, by the
      // same extractor every other provider uses — Anthropic is no longer a
      // special case, it is simply the first provider whose field names the
      // extractor already knew.
      return withExtractedLimits(
        {
          id,
          provider,
          label: m?.display_name ? String(m.display_name) : undefined,
          // Anthropic's listing exposes identity/label/limits only — reasoning
          // support is not reported, so it stays unknown.
          capabilities: unknownReasoning(),
        },
        extractCapabilities(m, limitRuleFor(provider)),
        discoveredAt,
      );
    })
    .filter((m: ModelOption | null): m is ModelOption => m !== null);
}

function normalizeGoogle(raw: any, provider: string, discoveredAt: number): ModelOption[] {
  const data = Array.isArray(raw?.models) ? raw.models : [];
  return data
    .map((m: any) => ({
      id: String(m?.name ?? "").replace(/^models\//, "").trim(),
      raw: m,
    }))
    .filter((m: { id: string }) => Boolean(m.id) && isChatModel(m.id, provider))
    .map(({ id, raw }) =>
      withExtractedLimits(
        // Google's listing reports no reasoning metadata either.
        { id, provider, capabilities: unknownReasoning() },
        // Google's limits arrive camelCased (`inputTokenLimit`), which the shared
        // field list already knows.
        extractCapabilities(raw, limitRuleFor(provider)),
        discoveredAt,
      ),
    );
}

/** Ollama tag listing: identity only. Capabilities resolve per model via /api/show. */
function normalizeOllama(raw: any): string[] {
  const data = Array.isArray(raw?.models) ? raw.models : [];
  return data
    .map((m: any) => String(m?.name ?? "").trim())
    .filter(Boolean);
}

export async function discoverModels(input: DiscoverInput): Promise<ModelOption[]> {
  const { type, endpoint, apiKey } = input;
  const base = endpoint?.trim() || DEFAULT_BASE[type];
  if (!base) {
    throw new Error("An endpoint is required to discover models for this provider type.");
  }

  // One clock read per pass, so every entry in a single listing shares a timestamp
  // and a listing cannot be half fresh and half stale.
  const discoveredAt = input.now?.() ?? Date.now();

  switch (type) {
    case "openai":
    case "custom": {
      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const raw = await fetchJson(joinBase(base, "models"), { headers });
      return normalizeOpenAI(raw, type, discoveredAt);
    }
    case "anthropic": {
      if (!apiKey) throw new Error("An API key is required to discover Anthropic models.");
      const headers: Record<string, string> = {
        "X-Api-Key": apiKey,
        "anthropic-version": "2023-06-01",
      };
      const raw = await fetchJson(joinBase(base, "v1/models"), { headers });
      return normalizeAnthropic(raw, type, discoveredAt);
    }
    case "google": {
      if (!apiKey) throw new Error("An API key is required to discover Google models.");
      const url = `${joinBase(base, "v1beta/models")}?key=${encodeURIComponent(apiKey)}`;
      const raw = await fetchJson(url, {});
      return normalizeGoogle(raw, type, discoveredAt);
    }
    case "ollama": {
      const raw = await fetchJson(joinBase(base, "api/tags"), {});
      const ids = normalizeOllama(raw);
      return mapWithConcurrency(ids, OLLAMA_SHOW_CONCURRENCY, async (id) => {
        const { capabilities, limits } = await fetchOllamaModel(base, id);
        return withExtractedLimits({ id, provider: type, capabilities }, limits, discoveredAt);
      });
    }
    default:
      throw new Error(`Model discovery is not supported for type: ${type}`);
  }
}
