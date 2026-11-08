/**
 * Shared provider → model resolution.
 *
 * The chat route and MCP sampling both need the same three steps: look up the
 * provider, resolve its stored credential, and build the AI SDK model. This
 * module is the one place those steps are composed, so the wire-protocol
 * override (`apiProtocol`) and the keyless Ollama case behave identically
 * everywhere. It owns no state and stores nothing — the registry and the
 * credential store remain the sources of truth.
 *
 * Provider LOOKUP stays with the callers: the chat route resolves
 * request/conversation/active with its own precedence and error contract,
 * MCP sampling uses the active provider, and the scheduler resolves by id.
 * Unifying lookup would force one policy on all three.
 */
import type { LanguageModel } from "ai";
import { credentialStore } from "./credentials";
import { getModel } from "./ai";
import type { ProviderConfig } from "../types";

/**
 * Resolve the API key for a provider.
 *
 * Ollama needs no key and yields `undefined` without touching the store.
 * Returns `undefined` when no key is stored. A decryption failure THROWS —
 * callers decide whether that is fatal (chat: 500) or tolerable (MCP
 * sampling: proceed keyless and let the provider reject).
 */
export function resolveProviderApiKey(
  provider: Pick<ProviderConfig, "id" | "type">,
): string | undefined {
  if (provider.type === "ollama") return undefined;
  if (!credentialStore.has(provider.id)) return undefined;
  return credentialStore.get(provider.id);
}

/**
 * Build a LanguageModel for a provider with its credential resolved.
 *
 * Passes the FULL provider config (including `apiProtocol`) to the model
 * factory, so an OpenAI provider configured for Chat Completions is built the
 * same way in every caller — not silently rebuilt with the Responses default.
 *
 * @param provider The provider to build for.
 * @param options.model Override the provider's saved default model.
 * @param options.apiKey Use this key instead of resolving the stored one
 *   (pass `undefined` explicitly to build keyless, e.g. after a credential
 *   failure the caller chose to tolerate).
 */
export function buildProviderModel(
  provider: ProviderConfig,
  options: { model?: string; apiKey?: string } = {},
): LanguageModel {
  const apiKey = "apiKey" in options ? options.apiKey : resolveProviderApiKey(provider);
  return getModel({ ...provider, apiKey, model: options.model ?? provider.model });
}
