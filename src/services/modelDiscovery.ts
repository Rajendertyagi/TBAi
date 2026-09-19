import type { ModelCapabilities, ModelOption, ProviderConfig } from "../types";

export type DiscoverInput = {
  type: ProviderConfig["type"];
  endpoint?: string;
  apiKey?: string;
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
 * Ollama `/api/show` capability lookup (Phase 1's only truthful per-model
 * capability source besides identity listing). Contract: POST {model} →
 * `{capabilities?: unknown}` where the array holds lowercase tokens such as
 * "thinking". Only an explicitly reported "thinking" entry yields supported;
 * a missing/unreachable/malformed source stays unknown — never unsupported.
 * Shape-guarded throughout: an unexpected daemon response degrades one model
 * to unknown instead of breaking discovery.
 */
async function fetchOllamaCapabilities(base: string, model: string): Promise<ModelCapabilities> {
  try {
    const raw = (await fetchJson(joinBase(base, "api/show"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    })) as { capabilities?: unknown };
    const caps = raw?.capabilities;
    if (Array.isArray(caps) && caps.some((c) => c === "thinking")) {
      return { reasoning: { support: "supported" } };
    }
    return unknownReasoning();
  } catch {
    return unknownReasoning();
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

function normalizeOpenAI(raw: any, provider: string): ModelOption[] {
  const data = Array.isArray(raw?.data) ? raw.data : [];
  return data
    .map((m: any) => String(m?.id ?? "").trim())
    .filter((id): id is string => Boolean(id) && isChatModel(id, provider))
    // OpenAI listing endpoints expose identity only — no truthful per-model
    // capability source exists here, so reasoning stays unknown.
    .map((id: string) => ({ id, provider, capabilities: unknownReasoning() }));
}

function normalizeAnthropic(raw: any, provider: string): ModelOption[] {
  const data = Array.isArray(raw?.data) ? raw.data : [];
  return data
    .map((m: any) => {
      const id = String(m?.id ?? "").trim();
      if (!id || !isChatModel(id, provider)) return null;
      return {
        id,
        provider,
        label: m?.display_name ? String(m.display_name) : undefined,
        contextWindow: typeof m?.max_input_tokens === "number" ? m.max_input_tokens : undefined,
        // Anthropic listing exposes identity/label/context only — reasoning
        // support is not reported, so it stays unknown.
        capabilities: unknownReasoning(),
      } as ModelOption;
    })
    .filter((m: ModelOption | null): m is ModelOption => m !== null);
}

function normalizeGoogle(raw: any, provider: string): ModelOption[] {
  const data = Array.isArray(raw?.models) ? raw.models : [];
  return data
    .map((m: any) => String(m?.name ?? "").replace(/^models\//, "").trim())
    .filter((id): id is string => Boolean(id) && isChatModel(id, provider))
    // Google listing exposes identity only — no truthful per-model
    // capability source exists here, so reasoning stays unknown.
    .map((id: string) => ({ id, provider, capabilities: unknownReasoning() }));
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

  switch (type) {
    case "openai":
    case "custom": {
      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const raw = await fetchJson(joinBase(base, "models"), { headers });
      return normalizeOpenAI(raw, type);
    }
    case "anthropic": {
      if (!apiKey) throw new Error("An API key is required to discover Anthropic models.");
      const headers: Record<string, string> = {
        "X-Api-Key": apiKey,
        "anthropic-version": "2023-06-01",
      };
      const raw = await fetchJson(joinBase(base, "v1/models"), { headers });
      return normalizeAnthropic(raw, type);
    }
    case "google": {
      if (!apiKey) throw new Error("An API key is required to discover Google models.");
      const url = `${joinBase(base, "v1beta/models")}?key=${encodeURIComponent(apiKey)}`;
      const raw = await fetchJson(url, {});
      return normalizeGoogle(raw, type);
    }
    case "ollama": {
      const raw = await fetchJson(joinBase(base, "api/tags"), {});
      const ids = normalizeOllama(raw);
      return mapWithConcurrency(ids, OLLAMA_SHOW_CONCURRENCY, async (id) => ({
        id,
        provider: type,
        capabilities: await fetchOllamaCapabilities(base, id),
      }));
    }
    default:
      throw new Error(`Model discovery is not supported for type: ${type}`);
  }
}
