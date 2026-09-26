function normalizedIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Resolves the TBAi conversation id for assistant-ui thread-list state.
 * An explicit custom identity is authoritative; Direct threads fall back to
 * their remote/local thread ids when no custom identity is present.
 */
export function resolveThreadConversationId(state: unknown): string | null {
  if (state === null || typeof state !== "object") return null;
  const thread = state as {
    custom?: unknown;
    remoteId?: unknown;
    id?: unknown;
  };
  if (thread.custom !== null && typeof thread.custom === "object") {
    const custom = thread.custom as { conversationId?: unknown };
    if ("conversationId" in custom) {
      return normalizedIdentity(custom.conversationId);
    }
  }
  return normalizedIdentity(thread.remoteId) ?? normalizedIdentity(thread.id);
}
