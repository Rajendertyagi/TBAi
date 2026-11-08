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

/** Recognized core providers required for a valid catalog payload. */
export const RECOGNIZED_PROVIDERS = ["openai", "anthropic", "google"] as const;

/** Normalized catalogue limit figures for one model (P1 context window only). */
export interface NormalizedCatalogModel {
  readonly contextWindow?: number;
}

/** In-memory cache snapshot. */
export interface CatalogCache {
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
 * contextWindow = min(context, input) when both are valid positive integers.
 * If input is unusable (e.g. 0), falls back to context.
 */
export function normalizeCatalogLimits(
  rawModel: Record<string, unknown> | null | undefined,
): NormalizedCatalogModel {
  if (!rawModel || typeof rawModel !== "object") return {};
  const limitObj = rawModel.limit as Record<string, unknown> | undefined;
  if (!limitObj || typeof limitObj !== "object") return {};

  const context = parseTokenLimit(limitObj.context);
  const input = parseTokenLimit(limitObj.input);

  let contextWindow: number | undefined;
  if (context !== undefined && input !== undefined) {
    contextWindow = Math.min(context, input);
  } else {
    contextWindow = input ?? context;
  }

  return contextWindow !== undefined ? { contextWindow } : {};
}

/**
 * TBAi Ingestion Subset Validator.
 *
 * Enforces structural integrity of the provider envelope subset consumed by TBAi:
 * 1. Root is a non-null, non-array object.
 * 2. All recognized core providers ('openai', 'anthropic', 'google') must be present.
 * 3. Each recognized provider must have a non-empty `models` object.
 * 4. Each model entry must have a valid `limit` object where `limit.context` is a non-negative finite number.
 * 5. If `limit.input` is present, it must also be a non-negative finite number (structural failure rejects payload).
 */
export function isValidCatalogPayload(
  data: unknown,
): data is Record<
  string,
  { models: Record<string, { limit: { context: number; input?: number } }> }
> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }

  const root = data as Record<string, unknown>;

  for (const providerKey of RECOGNIZED_PROVIDERS) {
    const providerEntry = root[providerKey];
    if (!providerEntry || typeof providerEntry !== "object" || Array.isArray(providerEntry)) {
      return false;
    }

    const models = (providerEntry as { models?: unknown }).models;
    if (!models || typeof models !== "object" || Array.isArray(models)) {
      return false;
    }

    const modelEntries = Object.entries(models as Record<string, unknown>);
    if (modelEntries.length === 0) {
      return false;
    }

    for (const [, rawModel] of modelEntries) {
      if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) {
        return false;
      }

      const limit = (rawModel as { limit?: unknown }).limit;
      if (!limit || typeof limit !== "object" || Array.isArray(limit)) {
        return false;
      }

      const limitObj = limit as Record<string, unknown>;
      // Upstream schema: limit.context is required and non-negative
      if (
        typeof limitObj.context !== "number" ||
        !Number.isFinite(limitObj.context) ||
        limitObj.context < 0
      ) {
        return false;
      }

      // Upstream schema: limit.input is optional; if present, must be non-negative number
      if (
        limitObj.input !== undefined &&
        (typeof limitObj.input !== "number" ||
          !Number.isFinite(limitObj.input) ||
          limitObj.input < 0)
      ) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Fetches and normalizes the Models.dev catalog with TTL, deduplication, atomic cache replacement,
 * and last-known-good fallback.
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
      const data: unknown = await res.json();

      if (!isValidCatalogPayload(data)) {
        throw new Error("Models.dev payload failed structural schema validation");
      }

      const providersMap = new Map<string, Map<string, NormalizedCatalogModel>>();
      let totalNormalizedModels = 0;

      for (const providerKey of RECOGNIZED_PROVIDERS) {
        const providerVal = data[providerKey];
        const modelMap = new Map<string, NormalizedCatalogModel>();

        for (const [modelId, rawModel] of Object.entries(providerVal.models)) {
          const normalized = normalizeCatalogLimits(rawModel as Record<string, unknown>);
          if (normalized.contextWindow !== undefined) {
            modelMap.set(modelId, normalized);
            totalNormalizedModels++;
          }
        }
        providersMap.set(providerKey, modelMap);
      }

      if (totalNormalizedModels === 0) {
        throw new Error(
          "Models.dev payload contained no models with usable positive-integer context limits",
        );
      }

      // Atomic cache replacement only after full validation and normalization
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

    if (nextContext === model.contextWindow && nextContextSource === model.contextWindowSource) {
      return model;
    }

    return {
      ...model,
      ...(nextContext !== undefined ? { contextWindow: nextContext } : {}),
      ...(nextContextSource !== undefined ? { contextWindowSource: nextContextSource } : {}),
    };
  });
}

/** For tests: clear in-memory cache and in-flight promise. */
export function _resetModelCatalogCache(): void {
  cachedCatalog = null;
  inFlightFetch = null;
}
