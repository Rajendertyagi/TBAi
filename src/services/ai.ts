import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
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

/**
 * `providerOptions` namespace of the OpenAI-compatible provider.
 *
 * A provider reads provider options under its OWN `name`, and the compatible
 * provider is not named `openai` — so the chat route cannot assume one
 * namespace for both factories. Exported (with {@link providerOptionsNamespace})
 * so the rule lives here, beside the model that implements it.
 */
export const OPENAI_COMPATIBLE_PROVIDER_NAME = "openaiCompatible";

/** `@ai-sdk/openai`'s own default base URL, reused when no endpoint is set. */
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** The wire protocol a provider speaks: explicit override, else the type default. */
export function resolveApiProtocol(
  config: Pick<ModelInput, "type" | "apiProtocol">,
): ApiProtocol | undefined {
  return config.apiProtocol ?? DEFAULT_PROTOCOL[config.type];
}

/**
 * True when this provider's model is built by the OpenAI-compatible factory.
 *
 * Chat-completions gateways — `custom`, `ollama`, or an `openai` provider
 * explicitly set to chat-completions — go through it instead of
 * `@ai-sdk/openai`. The reason is not stylistic. `@ai-sdk/openai`'s
 * chat-completions delta schema declares exactly `role`, `content`,
 * `tool_calls` and `annotations`, so a gateway's `reasoning_content` — how
 * DeepSeek/Qwen-style models stream their thinking — is silently discarded and
 * no reasoning part can ever reach the UI. The compatible provider declares
 * that field, so the thinking block has something to render.
 *
 * @param config - The provider being built.
 * @returns True when the compatible factory owns this model.
 */
export function usesOpenAICompatibleModel(
  config: Pick<ModelInput, "type" | "apiProtocol">,
): boolean {
  if (
    config.type !== "openai" &&
    config.type !== "custom" &&
    config.type !== "ollama"
  ) {
    return false;
  }
  return resolveApiProtocol(config) === "chat-completions";
}

/**
 * The `providerOptions` key this provider's model reads.
 *
 * @param config - The provider being built.
 * @returns The compatible provider's name for a gateway model, else `"openai"`.
 */
export function providerOptionsNamespace(
  config: Pick<ModelInput, "type" | "apiProtocol">,
): string {
  return usesOpenAICompatibleModel(config)
    ? OPENAI_COMPATIBLE_PROVIDER_NAME
    : "openai";
}

/** Resolve an OpenAI-compatible model for the given wire protocol. */
function buildOpenAIModel(
  config: ModelInput,
  protocol: ApiProtocol | undefined,
): LanguageModel {
  const settings: { apiKey?: string; baseURL?: string } = {};
  if (config.apiKey) settings.apiKey = config.apiKey;
  if (config.endpoint) settings.baseURL = config.endpoint;
  // Ollama has no real auth; the SDK still requires a non-empty key, so the
  // prior behavior hardcoded "ollama" for local gateways.
  if (config.type === "ollama" && !settings.apiKey) settings.apiKey = "ollama";

  if (protocol === "chat-completions") {
    // POST /chat/completions — the dialect every gateway documents, and the one
    // whose schema carries `reasoning_content` (see
    // {@link usesOpenAICompatibleModel}).
    return createOpenAICompatible({
      name: OPENAI_COMPATIBLE_PROVIDER_NAME,
      baseURL: config.endpoint ?? DEFAULT_OPENAI_BASE_URL,
      ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
    }).chatModel(config.model);
  }
  // The bare factory default is the Responses API (POST /responses), which
  // strict third-party gateways reject — native OpenAI is the only user here.
  return createOpenAI(settings)(config.model);
}

function buildModel(config: ModelInput): LanguageModel {
  switch (config.type) {
    case "openai":
    case "custom":
    case "ollama":
      return buildOpenAIModel(config, resolveApiProtocol(config));
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
