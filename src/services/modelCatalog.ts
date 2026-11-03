import { logger } from "../lib/logger";
import { catalogLimit, type ModelOption, type ProviderConfig } from "../types";

/**
 * Endpoint for Models.dev catalog payload.
 * Pinned to api.json (consumed by official clients / Cline).
 */
export const MODELS_DEV_CATALOG_URL = "https://models.dev/api.json";

/** 10-minute in-memory cache TTL. */
export const CATALOG_TTL_MS = 10 * 60 * 1000;

/** 5-second fetch timeout. */
export const CATALOG_FETCH_TIMEOUT_MS = 5000;

/** Official default base endpoints. Models.dev rows apply ONLY to default endpoints. */
const DEFAULT_ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
};

/** Normalized catalogue limit figures for one model. */
export interface NormalizedCatalogModel {
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

/** In-memory cache snapshot. */
interface CatalogCache {
  fetchedAt: number;
  // Key: providerKey -> modelId -> NormalizedCatalogModel
  providers: Map<string, Map<string, NormalizedCatalogModel>>;
}

let cachedCatalog: CatalogCache | null = null;
let inFlightFetch: Promise<CatalogCache | null> | null = null;

function normalizeEndpoint(url: string | undefined): string {
  if (!url) return "";
  return url.trim().replace(/\/+$/, "");
}

/**
 * Checks if a provider config matches the exact Models.dev provider key
 * and endpoint requirements.
 */
export function isEligibleForCatalogEnrichment(provider: {
  type: ProviderConfig["type"];
  endpoint?: string;
}): string | null {
  const { type, endpoint } = provider;
  if (type !== "openai" && type !== "anthropic" && type !== "google") {
    return null;
  }
  const defaultEp = DEFAULT_ENDPOINTS[type];
  if (!defaultEp) return null;

  const normalizedEp = normalizeEndpoint(endpoint);
  if (!normalizedEp || normalizedEp === normalizeEndpoint(defaultEp)) {
    return type;
  }
  return null;
}

/**
 * Validates a token limit candidate. Must be a finite positive integer.
 */
function parseTokenLimit(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isFinite(val) && Number.isInteger(val) && val > 0) {
    return val;
  }
  return undefined;
}

/**
 * Normalizes raw model limit object from Models.dev:
 * maxInputTokens = min(context, input) when both are present, or input ?? context.
 * output = output limit when positive integer.
 */
export function normalizeCatalogLimits(rawModel: Record<string, unknown> | null | undefined): NormalizedCatalogModel {
  if (!rawModel || typeof rawModel !== "object") return {};
  const limitObj = rawModel.limit as Record<string, unknown> | undefined;
  if (!limitObj || typeof limitObj !== "object") return {};

  const context = parseTokenLimit(limitObj.context);
  const input = parseTokenLimit(limitObj.input);
  const output = parseTokenLimit(limitObj.output);

  let contextWindow: number | undefined;
  if (context !== undefined && input !== undefined) {
    contextWindow = Math.min(context, input);
  } else {
    contextWindow = input ?? context;
  }

  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(output !== undefined ? { maxOutputTokens: output } : {}),
  };
}

/**
 * Fetches and normalizes the Models.dev catalog with TTL, deduplication, and last-known-good fallback.
 */
export async function getModelCatalog(options?: {
  fetchFn?: typeof fetch;
  url?: string;
  now?: () => number;
}): Promise<CatalogCache | null> {
  const now = options?.now?.() ?? Date.now();
  const fetchFn = options?.fetchFn ?? fetch;
  const url = options?.url ?? MODELS_DEV_CATALOG_URL;

  if (cachedCatalog && now - cachedCatalog.fetchedAt < CATALOG_TTL_MS) {
    return cachedCatalog;
  }

  if (inFlightFetch) {
    return inFlightFetch;
  }

  inFlightFetch = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CATALOG_FETCH_TIMEOUT_MS);
    try {
      const res = await fetchFn(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Models.dev returned status ${res.status}`);
      }
      const data = (await res.json()) as Record<string, unknown>;
      if (!data || typeof data !== "object") {
        throw new Error("Models.dev payload is not an object");
      }

      const providersMap = new Map<string, Map<string, NormalizedCatalogModel>>();

      for (const [providerKey, providerVal] of Object.entries(data)) {
        if (!providerVal || typeof providerVal !== "object") continue;
        const modelsObj = (providerVal as { models?: Record<string, unknown> }).models;
        if (!modelsObj || typeof modelsObj !== "object") continue;

        const modelMap = new Map<string, NormalizedCatalogModel>();
        for (const [modelId, rawModel] of Object.entries(modelsObj)) {
          if (!rawModel || typeof rawModel !== "object") continue;
          const normalized = normalizeCatalogLimits(rawModel as Record<string, unknown>);
          if (normalized.contextWindow !== undefined || normalized.maxOutputTokens !== undefined) {
            modelMap.set(modelId, normalized);
          }
        }
        providersMap.set(providerKey, modelMap);
      }

      cachedCatalog = {
        fetchedAt: now,
        providers: providersMap,
      };
      return cachedCatalog;
    } catch (err) {
      logger.warn("modelCatalog", "catalog_fetch_error", {
        hasCached: cachedCatalog !== null,
        message: err instanceof Error ? err.message : String(err),
      });
      // Fallback to last-known-good
      return cachedCatalog;
    } finally {
      clearTimeout(timer);
      inFlightFetch = null;
    }
  })();

  return inFlightFetch;
}

/**
 * Enriches discovered models with catalogue context limits when missing.
 *
 * Invariant: Never overwrites existing provider_reported or configured values.
 */
export async function enrichModels(
  models: ModelOption[],
  provider: { type: ProviderConfig["type"]; endpoint?: string },
  options?: {
    fetchFn?: typeof fetch;
    url?: string;
    now?: () => number;
  },
): Promise<ModelOption[]> {
  const catalogKey = isEligibleForCatalogEnrichment(provider);
  if (!catalogKey) {
    return models;
  }

  const catalog = await getModelCatalog(options);
  if (!catalog) {
    return models;
  }

  const providerModels = catalog.providers.get(catalogKey);
  if (!providerModels) {
    return models;
  }

  return models.map((model) => {
    const catalogData = providerModels.get(model.id);
    if (!catalogData) {
      return model;
    }

    let nextContext = model.contextWindow;
    let nextContextSource = model.contextWindowSource;
    let nextMaxOutput = model.maxOutputTokens;
    let nextMaxOutputSource = model.maxOutputTokensSource;

    // Only set contextWindow if not already reported by provider or configured by user
    if (
      nextContext === undefined &&
      nextContextSource === undefined &&
      catalogData.contextWindow !== undefined
    ) {
      const sourced = catalogLimit(catalogData.contextWindow);
      nextContext = sourced.value;
      nextContextSource = sourced.source;
    }

    // Only set maxOutputTokens if not already present
    if (
      nextMaxOutput === undefined &&
      nextMaxOutputSource === undefined &&
      catalogData.maxOutputTokens !== undefined
    ) {
      const sourced = catalogLimit(catalogData.maxOutputTokens);
      nextMaxOutput = sourced.value;
      nextMaxOutputSource = sourced.source;
    }

    if (
      nextContext === model.contextWindow &&
      nextContextSource === model.contextWindowSource &&
      nextMaxOutput === model.maxOutputTokens &&
      nextMaxOutputSource === model.maxOutputTokensSource
    ) {
      return model;
    }

    return {
      ...model,
      ...(nextContext !== undefined ? { contextWindow: nextContext } : {}),
      ...(nextContextSource !== undefined ? { contextWindowSource: nextContextSource } : {}),
      ...(nextMaxOutput !== undefined ? { maxOutputTokens: nextMaxOutput } : {}),
      ...(nextMaxOutputSource !== undefined ? { maxOutputTokensSource: nextMaxOutputSource } : {}),
    };
  });
}

/** For tests: clear in-memory cache and in-flight promise. */
export function _resetModelCatalogCache(): void {
  cachedCatalog = null;
  inFlightFetch = null;
}
