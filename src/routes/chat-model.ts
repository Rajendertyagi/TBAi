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
 *   1. the request's own `model` / `reasoningLevel` (one-shot overrides the
 *      client already merged in from its picker + conversation default),
 *   2. the conversation's persisted default (SQLite source of truth),
 *   3. the active provider's saved default.
 *
 * When a field is absent on the request, fall back to the conversation's
 * persisted default so a missing header never silently drops the user's
 * chosen config.
 */
export interface ResolvedChatModel {
  provider: ProviderConfig;
  model?: string;
  reasoning?: string;
}

export async function resolveChatModel(opts: {
  providerId?: string;
  model?: string;
  reasoningLevel?: string;
  threadId?: string;
}): Promise<ResolvedChatModel | null> {
  const { providerId, model, reasoningLevel, threadId } = opts;
  const provider = (providerId && registry.get(providerId)) || registry.getActive();
  if (!provider) return null;

  let effectiveModel = model;
  let effectiveReasoning: string | undefined = reasoningLevel;
  if (effectiveModel === undefined || effectiveReasoning === undefined) {
    // The conversation's persisted default (source of truth). If no thread is
    // given, or the row has no value, fall through to the provider's saved
    // default — mirroring the inline logic the route previously carried.
    const conv = threadId ? await conversationService.get(threadId) : null;
    if (conv) {
      if (effectiveModel === undefined) {
        effectiveModel = conv.modelId ?? provider.model ?? undefined;
      }
      if (effectiveReasoning === undefined) {
        effectiveReasoning = conv.reasoningLevel ?? provider.thinking ?? "off";
      }
    }
    if (effectiveModel === undefined) effectiveModel = provider.model ?? undefined;
    if (effectiveReasoning === undefined) effectiveReasoning = provider.thinking ?? "off";
  }

  return { provider, model: effectiveModel, reasoning: effectiveReasoning };
}
