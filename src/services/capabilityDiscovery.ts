/**
 * Dynamic model capability extraction from a provider's own listing.
 *
 * ## The gap this closes
 *
 * `modelDiscovery.ts` extracted a context window for ANTHROPIC ONLY, reading
 * `max_input_tokens`, and explicitly discarded every other field an OpenAI-compatible
 * listing returns. That is why the `agnes` provider persisted three models with no
 * `contextWindow` at all and Direct then budgeted them against the 128k fallback.
 *
 * The listing was not the problem. The parser was.
 *
 * ## What this module is allowed to do
 *
 * Read STRUCTURAL metadata: named fields a provider's API documents. Field names are
 * how an API is parsed, not a claim about any model.
 *
 * What it must never do is infer a size from a model NAME. There is no
 * `if (id.includes("3.0-flash")) return 200_000` here, and adding one would defeat
 * the entire purpose: tomorrow's catalogue would be wrong again.
 *
 * ## Why this is not `provider_reported` by default
 *
 * A value read here came from the provider's own API for this endpoint, so it is
 * `provider_reported`. A value from a third-party catalogue would be `model_catalog`
 * and is deliberately NOT produced here — no external service is contacted.
 */

/**
 * Field names an OpenAI-compatible listing may use for an INPUT limit.
 *
 * Read defensively in order. These are API field names, not model specifications:
 * OpenRouter reports `context_length`, Ollama's `/api/show` reports
 * `<arch>.context_length`, several gateways report `context_window`, and Anthropic
 * reports `max_input_tokens`.
 */
export const CONTEXT_LIMIT_FIELDS: readonly string[] = [
  "max_input_tokens",
  "context_window",
  "context_length",
  "max_context_length",
  "max_prompt_tokens",
  "inputTokenLimit",
  "n_ctx",
];

/** Field names an OpenAI-compatible listing may use for an OUTPUT ceiling. */
export const OUTPUT_LIMIT_FIELDS: readonly string[] = [
  "max_output_tokens",
  "max_completion_tokens",
  "max_tokens",
  "max_output_len",
  "outputTokenLimit",
];

/**
 * A usable, positive, finite token count — or undefined.
 *
 * Rejects NaN, Infinity, zero and negatives, because a malformed listing must
 * degrade a model to "unknown", never hand the budget a figure that inverts it.
 */
export function validTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** How one listing entry nests its capability payload. */
export type LimitLayout =
  /** Fields sit directly on the entry (`{ id, context_length }`). */
  | "flat"
  /** Fields sit under one wrapper (`{ id, top_provider: { context_length } }`). */
  | "wrapped";

/**
 * Per-provider knowledge about WHERE a listing keeps its limits.
 *
 * This is the entire provider-specific surface, and it is deliberately about SHAPE
 * rather than about values. Adding a provider means adding one entry here — never a
 * change to the context subsystem, the budget, or any per-model table.
 */
export interface LimitExtractionRule {
  /**
   * Wrapper keys to search, outermost first. Empty means the entry itself is
   * searched (a flat layout).
   */
  readonly wrappers?: readonly string[];
}

const DEFAULT_RULE: LimitExtractionRule = { wrappers: [] };

/**
 * Extraction rules by provider type.
 *
 * Most OpenAI-compatible gateways put limits on the entry itself. OpenRouter nests
 * the authoritative figures under `top_provider`, and a few nest under `limits`;
 * those are declared here as SHAPE, with no value attached.
 */
export const LIMIT_EXTRACTION_RULES: Readonly<Record<string, LimitExtractionRule>> = {
  openai: DEFAULT_RULE,
  anthropic: DEFAULT_RULE,
  google: DEFAULT_RULE,
  ollama: { wrappers: ["model_info", "parameters"] },
  custom: { wrappers: ["top_provider", "limits"] },
};

/** A limit read from a listing, with the field it came from. */
export interface ExtractedLimit {
  readonly value: number;
  /** The API field that supplied it. Recorded so a wrong read is diagnosable. */
  readonly field: string;
}

/** Limits recovered from one listing entry, with provenance for each. */
export interface ExtractedCapabilities {
  readonly contextWindow?: ExtractedLimit;
  readonly maxOutputTokens?: ExtractedLimit;
}

function readNumber(source: Record<string, unknown>, field: string): number | undefined {
  const raw = source[field];
  // Ollama reports some limits as strings ("32768").
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
    return validTokenCount(Number(raw));
  }
  return validTokenCount(raw);
}

/**
 * Read the input/output limits out of ONE raw listing entry.
 *
 * Searches the entry and then each declared wrapper, first match wins. A field that
 * is present but unusable (zero, negative, non-numeric) is skipped rather than
 * returned, so a malformed value degrades to "unknown" instead of poisoning the
 * budget.
 *
 * @returns Limits with the field each came from; absent fields are simply absent.
 */
export function extractCapabilities(
  entry: unknown,
  rule: LimitExtractionRule = DEFAULT_RULE,
): ExtractedCapabilities {
  if (typeof entry !== "object" || entry === null) return {};

  const scopes: Array<Record<string, unknown>> = [entry as Record<string, unknown>];
  for (const wrapper of rule.wrappers ?? []) {
    const nested = (entry as Record<string, unknown>)[wrapper];
    if (typeof nested === "object" && nested !== null) {
      scopes.push(nested as Record<string, unknown>);
    }
  }

  const find = (fields: readonly string[]): ExtractedLimit | undefined => {
    for (const scope of scopes) {
      for (const field of fields) {
        const value = readNumber(scope, field);
        if (value !== undefined) return { value, field };
      }
    }
    return undefined;
  };

  const contextWindow = find(CONTEXT_LIMIT_FIELDS);
  const maxOutputTokens = find(OUTPUT_LIMIT_FIELDS);
  return {
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  };
}

/** The extraction rule for a provider type, falling back to the flat layout. */
export function limitRuleFor(providerType: string): LimitExtractionRule {
  return LIMIT_EXTRACTION_RULES[providerType] ?? DEFAULT_RULE;
}

/**
 * Ollama's `/api/show` reports limits as architecture-suffixed keys inside
 * `model_info`, e.g. `{ "llama.context_length": 131072 }`.
 *
 * Suffix matching is a structural necessity, not model knowledge: the key names a
 * PARAMETER, and no value is attached to any particular model anywhere in this
 * module.
 */
export function extractOllamaModelInfoLimits(
  modelInfo: unknown,
): ExtractedCapabilities {
  if (typeof modelInfo !== "object" || modelInfo === null) return {};
  const source = modelInfo as Record<string, unknown>;

  const suffixed = (suffix: string): ExtractedLimit | undefined => {
    for (const [key, value] of Object.entries(source)) {
      if (!key.endsWith(suffix)) continue;
      const parsed = readNumber(source, key);
      if (parsed !== undefined) return { value: parsed, field: key };
      void value;
    }
    return undefined;
  };

  const contextWindow = suffixed(".context_length") ?? suffixed(".max_input_tokens");
  const maxOutputTokens = suffixed(".max_tokens");
  return {
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  };
}
