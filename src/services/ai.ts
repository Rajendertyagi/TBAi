import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import type { ProviderConfig } from "../types";

// Minimal input the model builder needs. Kept separate from `ProviderConfig`
// because callers (chat route, test endpoint) only ever have a partial shape.
export interface ModelInput {
  id?: string;
  name?: string;
  type: ProviderConfig["type"];
  endpoint?: string;
  model: string;
  apiKey?: string;
}

function buildModel(config: ModelInput): LanguageModel {
  const settings: { apiKey?: string; baseURL?: string } = {};
  if (config.apiKey) settings.apiKey = config.apiKey;
  if (config.endpoint) settings.baseURL = config.endpoint;

  switch (config.type) {
    case "openai":
      return createOpenAI(settings)(config.model);
    case "anthropic":
      return createAnthropic(settings)(config.model);
    case "google":
      return createGoogle(settings)(config.model);
    case "ollama":
      return createOpenAI({
        baseURL: config.endpoint || "http://localhost:11434/v1",
        apiKey: "ollama",
      })(config.model);
    case "custom":
      return createOpenAI({
        baseURL: config.endpoint,
        apiKey: config.apiKey,
      })(config.model);
    default:
      throw new Error(`Unknown provider type: ${config.type}`);
  }
}

export function getModel(config: ModelInput): LanguageModel {
  return buildModel(config);
}
