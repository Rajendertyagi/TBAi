import type { ProviderConfig } from "../types";
import { providerOptionsNamespace } from "../services/ai";

/**
 * The AI SDK's provider-options contract, restated locally.
 *
 * The SDK types `providerOptions` as `Record<string, JSONObject>`, but that
 * alias lives in `@ai-sdk/provider` — a transitive package this repo does not
 * declare, and AGENTS.md forbids depending on undeclared transitives. Mirroring
 * the shape keeps the boundary explicit and still rejects non-JSON values.
 */
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

/** Options keyed by provider, as `streamText` accepts them. */
export type ReasoningProviderOptions = Record<string, JsonObject>;

/**
 * Reasoning-related `providerOptions` for a chat request.
 *
 * Extracted from the route because every branch here is a documented provider
 * quirk whose failure mode is *silence*: the request still succeeds, the model
 * still thinks, and the UI simply has no reasoning part to render. A wrong
 * branch therefore looks like "the thinking block is missing", not like an
 * error — so the rules belong in one readable, unit-testable place.
 *
 * Returns `{}` when reasoning is off, so the caller can omit the key entirely.
 */

/** Token budgets for Gemini 2.5's `thinkingBudget`. */
const GEMINI_BUDGET: Readonly<Record<string, number>> = {
  low: 1024,
  medium: 4096,
  high: 8192,
};

/**
 * `thinkingLevel` values for Gemini 3 and later, which REPLACED
 * `thinkingBudget`. Sending the wrong one for the generation is ignored, so the
 * model runs at its default depth and returns nothing the UI can show.
 */
const GEMINI_LEVEL: Readonly<Record<string, "minimal" | "low" | "medium" | "high">> = {
  low: "low",
  medium: "medium",
  high: "high",
};

/** Token budgets for Anthropic extended thinking. */
const ANTHROPIC_BUDGET: Readonly<Record<string, number>> = {
  low: 1024,
  medium: 4096,
  high: 8192,
};

/** Reasoning effort for OpenAI-family models. */
const OPENAI_EFFORT: Readonly<Record<string, string>> = {
  low: "low",
  medium: "medium",
  high: "high",
};

/** First Gemini generation that takes `thinkingLevel` instead of `thinkingBudget`. */
const GEMINI_LEVEL_GENERATION = 3;

/** `gemini-3`, `gemini-3.1`, … — the leading generation number of a Gemini id. */
const GEMINI_GENERATION = /^gemini-(\d+)/i;

/**
 * Model names marking a lite/nano variant.
 *
 * These reject a Gemini 2.5 `thinkingBudget`, which is why thinking is skipped
 * for them. Gemini 3 Flash is NOT in that group — it supports every
 * `thinkingLevel` — so the gate must not apply to a Gemini 3 model.
 */
const LITE_MODEL = /lite|nano/i;

/** The leading generation number of a Gemini model id, or 0 when unknown. */
function geminiGeneration(model: string): number {
  const match = GEMINI_GENERATION.exec(model);
  return match ? Number(match[1]) : 0;
}

/**
 * Build the reasoning provider options for one request.
 *
 * @param provider - The provider serving the request (type + protocol override).
 * @param model - The resolved model id, used to pick Gemini's option generation.
 * @param reasoning - The effective level: `"low"`, `"medium"`, `"high"` or `"off"`.
 * @returns The `providerOptions` object, empty when reasoning is off.
 */
export function buildReasoningProviderOptions(
  provider: Pick<ProviderConfig, "type" | "apiProtocol">,
  model: string,
  reasoning: string,
): ReasoningProviderOptions {
  if (reasoning === "off") return {};
  const isLite = LITE_MODEL.test(model);

  if (provider.type === "google") {
    // Google returns NO thought text unless it is asked to: the model still
    // thinks, but the summaries this UI renders are withheld. This is the one
    // flag that must be present on every generation.
    const includeThoughts = true;
    if (geminiGeneration(model) >= GEMINI_LEVEL_GENERATION) {
      return {
        google: {
          thinkingConfig: {
            thinkingLevel: GEMINI_LEVEL[reasoning] ?? "medium",
            includeThoughts,
          },
        },
      };
    }
    if (isLite) return {};
    return {
      google: {
        thinkingConfig: {
          thinkingBudget: GEMINI_BUDGET[reasoning] ?? 4096,
          includeThoughts,
        },
      },
    };
  }

  if (provider.type === "anthropic") {
    if (isLite) return {};
    return {
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: ANTHROPIC_BUDGET[reasoning] ?? 4096,
        },
      },
    };
  }

  if (provider.type === "openai" || provider.type === "custom") {
    if (isLite) return {};
    return {
      [providerOptionsNamespace(provider)]: {
        reasoningEffort: OPENAI_EFFORT[reasoning] ?? "medium",
      },
    };
  }

  return {};
}
