import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import type { ApiProtocol, ProviderConfig } from "../types";

// Minimal input the model builder needs. Kept separate from `ProviderConfig`
// because callers (chat route, test endpoint) only ever have a partial shape.
export interface ModelInput {
  id?: string;
  name?: string;
  type: ProviderConfig["type"];
  endpoint?: string;
  model: string;
  apiKey?: string;
  /** Explicit wire protocol override; falls back to the type default. */
  apiProtocol?: ApiProtocol;
}

/**
 * Protocol default per provider type. Native OpenAI speaks the Responses API;
 * OpenAI-compatible gateways (custom, Ollama) speak Chat Completions. google/
 * anthropic use their own factories and ignore this. This preserves the prior
 * behavior (custom/ollama → chat completions) while making it configurable.
 */
const DEFAULT_PROTOCOL: Record<ProviderConfig["type"], ApiProtocol | undefined> = {
  openai: "responses",
  custom: "chat-completions",
  ollama: "chat-completions",
  google: undefined,
  anthropic: undefined,
};

/** Resolve an OpenAI-compatible model for the given wire protocol. */
function buildOpenAIModel(
  config: ModelInput,
  protocol: ApiProtocol,
): LanguageModel {
  const settings: { apiKey?: string; baseURL?: string } = {};
  if (config.apiKey) settings.apiKey = config.apiKey;
  if (config.endpoint) settings.baseURL = config.endpoint;
  // Ollama has no real auth; the SDK still requires a non-empty key, so the
  // prior behavior hardcoded "ollama" for local gateways.
  if (config.type === "ollama" && !settings.apiKey) settings.apiKey = "ollama";
  const factory = createOpenAI(settings);
  // "chat-completions" is the OpenAI-compatible dialect every gateway documents
  // (POST /chat/completions). The bare factory() default is the Responses API
  // (POST /responses), which strict third-party gateways reject.
  return protocol === "chat-completions"
    ? factory.chat(config.model)
    : factory(config.model);
}

function buildModel(config: ModelInput): LanguageModel {
  switch (config.type) {
    case "openai":
    case "custom":
    case "ollama": {
      const protocol = config.apiProtocol ?? DEFAULT_PROTOCOL[config.type]!;
      return buildOpenAIModel(config, protocol);
    }
    case "anthropic":
      return createAnthropic({ apiKey: config.apiKey })(config.model);
    case "google":
      return createGoogle({ apiKey: config.apiKey })(config.model);
    default:
      throw new Error(`Unknown provider type: ${config.type}`);
  }
}

export function getModel(config: ModelInput): LanguageModel {
  return buildModel(config);
}
