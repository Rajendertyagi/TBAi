import type { ModelOption, ProviderConfig } from "../types";

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

function isChatModel(id: string, type: string): boolean {
  const lower = id.toLowerCase();
  if (/embed|text-embedding|dall-e|flux|stable-diffusion|whisper|tts|imagen|rerank|image-|video-/.test(lower)) return false;
  return /gpt|claude|gemini|llama|qwen|mistral|deepseek|codestral|sonnet|opus|haiku|flash|pro|yi|grok|phi|command|nighttales/.test(lower) || type === "ollama";
}

function normalizeOpenAI(raw: any, provider: string): ModelOption[] {
  const data = Array.isArray(raw?.data) ? raw.data : [];
  return data
    .map((m: any) => String(m?.id ?? "").trim())
    .filter((id): id is string => Boolean(id) && isChatModel(id, provider))
    .map((id: string) => ({ id, provider }));
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
      } as ModelOption;
    })
    .filter((m: ModelOption | null): m is ModelOption => m !== null);
}

function normalizeGoogle(raw: any, provider: string): ModelOption[] {
  const data = Array.isArray(raw?.models) ? raw.models : [];
  return data
    .map((m: any) => String(m?.name ?? "").replace(/^models\//, "").trim())
    .filter((id): id is string => Boolean(id) && isChatModel(id, provider))
    .map((id: string) => ({ id, provider }));
}

function normalizeOllama(raw: any, provider: string): ModelOption[] {
  const data = Array.isArray(raw?.models) ? raw.models : [];
  return data
    .map((m: any) => String(m?.name ?? "").trim())
    .filter(Boolean)
    .map((id: string) => ({ id, provider }));
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
      return normalizeOllama(raw, type);
    }
    default:
      throw new Error(`Model discovery is not supported for type: ${type}`);
  }
}
