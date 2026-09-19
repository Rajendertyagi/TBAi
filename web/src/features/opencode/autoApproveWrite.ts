import { setAutoPolicy } from "./sessionAutoPolicy";

/**
 * The Auto shield's single write path for a bound conversation.
 *
 * One application-level operation does all three things the toggle needs, in
 * order:
 *
 *   1. persist the setting through the EXISTING conversation PATCH (the
 *      authoritative value stays `conversation.opencodeAutoApprove` in SQLite);
 *   2. update the runtime policy cache synchronously, so
 *      `getAutoPolicy(sessionId)` reflects the new value immediately — no
 *      rerender, no remount, no reload;
 *   3. when Auto just came ON, reconcile any already-pending permission through
 *      the existing responder, so a request that was waiting is accepted
 *      without waiting for another `permission.asked` event.
 *
 * The cache is only updated after a successful PATCH, so it can never disagree
 * with the source of truth. A failed PATCH throws and leaves both unchanged.
 *
 * Draft/new conversations are NOT handled here: they keep the welcome-engine
 * draft behavior, and the session-keyed cache is only populated once the real
 * OpenCode sessionId exists (which is exactly the `sessionId` this function
 * requires).
 *
 * @param conversationId - The TBAi conversation owning the setting.
 * @param sessionId - The OpenCode session the runtime is keyed by.
 * @param enabled - The new shield position.
 * @param reconcile - The runtime's reconcile seam (from `useOpenCodeRuntime`),
 *   called only when enabling, to accept already-pending requests.
 * @throws When the conversation PATCH fails — the setting is not applied.
 */
export async function persistAutoApprove(
  conversationId: string,
  sessionId: string,
  enabled: boolean,
  reconcile?: () => Promise<number>,
): Promise<void> {
  const res = await fetch(`/api/conversations/${conversationId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ opencodeAutoApprove: enabled }),
  });
  if (!res.ok) {
    throw new Error(`Failed to update conversation (${res.status})`);
  }
  setAutoPolicy(sessionId, enabled);
  if (enabled && reconcile) {
    await reconcile();
  }
}