import { registry } from "../config/providers";
import { conversationService } from "../services/storage";
import type { ProviderConfig } from "../types";

/**
 * Effective model + reasoning resolution for a chat request.
 *
 * This is the single place the chat route computes which model and reasoning
 * level to run. It is a pure(ish) exported function so the integration tests
 * can verify the exact resolution the route performs without a live provider.
 *
 * Resolution order (most specific first):
 *   1. the request's own `providerId` / `model` / `reasoningLevel` (one-shot
 *      overrides the client already merged in from its picker + conversation
 *      default),
 *   2. the conversation's persisted default (SQLite source of truth),
 *   3. the active provider's saved default.
 *
 * Phase 2 contract: explicit references are honored verbatim and never
 * silently re-paired. An explicitly named provider that the registry does not
 * know throws UnknownProviderError (the route maps it to a diagnosable 400)
 * instead of falling back to the active provider. A request-level provider
 * wins outright — the conversation model is NOT carried across to a different
 * provider, since that would silently re-pair a model with another provider.
 * Global fallback applies only when neither the request nor the conversation
 * names a provider.
 */
export interface ResolvedChatModel {
  provider: ProviderConfig;
  model?: string;
  reasoning?: string;
}

/** Explicit reference to a provider the registry does not know. */
export class UnknownProviderError extends Error {
  readonly code = "UNKNOWN_PROVIDER" as const;
  readonly providerId: string;

  constructor(providerId: string) {
    super(`Unknown provider: ${providerId}`);
    this.name = "UnknownProviderError";
    this.providerId = providerId;
  }
}

function withProviderDefaults(
  provider: ProviderConfig,
  model?: string,
  reasoning?: string,
): ResolvedChatModel {
  return {
    provider,
    model: model ?? provider.model ?? undefined,
    reasoning: reasoning ?? provider.thinking ?? "off",
  };
}

function knownProviderOrThrow(providerId: string): ProviderConfig {
  const provider = registry.get(providerId);
  if (!provider) throw new UnknownProviderError(providerId);
  return provider;
}

export async function resolveChatModel(opts: {
  providerId?: string;
  model?: string;
  reasoningLevel?: string;
  threadId?: string;
}): Promise<ResolvedChatModel | null> {
  const { providerId, model, reasoningLevel, threadId } = opts;
  const requestedId = providerId?.trim() ? providerId : undefined;

  if (requestedId) {
    // One-shot override: honored verbatim against its own provider defaults.
    return withProviderDefaults(knownProviderOrThrow(requestedId), model, reasoningLevel);
  }

  const conv = threadId ? await conversationService.get(threadId) : null;
  const convProviderId = conv?.providerId?.trim() ? conv.providerId : undefined;
  if (convProviderId) {
    // Explicit conversation config: honored verbatim, never re-paired.
    const convProvider = knownProviderOrThrow(convProviderId);
    return withProviderDefaults(
      convProvider,
      model ?? conv?.modelId ?? undefined,
      reasoningLevel ?? conv?.reasoningLevel ?? undefined,
    );
  }

  // No explicit configuration anywhere: global fallback (or null when
  // nothing is configured at all — the route reports "No provider configured").
  const provider = registry.getActive();
  if (!provider) return null;
  return withProviderDefaults(provider, model, reasoningLevel);
}
