import { logger } from "@/lib/logger";
import { apiFetch } from "@/lib/platform";

export interface RenameConversationOptions {
  title: string;
}

export interface SetConversationStatusOptions {
  status: "regular" | "archived";
}

type MutationListener = () => void;
const mutationListeners = new Set<MutationListener>();

/**
 * Subscribe to conversation mutations (renames, status updates, new messages/titles).
 * Consumed by sidebar conversation lists and header tabs to refresh immediately without a reload.
 */
export function subscribeConversationMutations(listener: MutationListener): () => void {
  mutationListeners.add(listener);
  return () => {
    mutationListeners.delete(listener);
  };
}

/**
 * Emit an invalidation event across the application.
 */
export function notifyConversationMutations(): void {
  mutationListeners.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      logger.debug("chat", "conversation_mutation_listener_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Domain operation for renaming a conversation.
 * Issues a PATCH request to /api/conversations/:id.
 */
export async function renameConversation(conversationId: string, title: string): Promise<void> {
  const cleanTitle = title.trim();
  if (!cleanTitle) {
    throw new Error("Title cannot be empty");
  }

  const res = await apiFetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: cleanTitle }),
  });

  if (!res.ok) {
    logger.debug("chat", "rename_conversation_failed", {
      conversationId,
      status: res.status,
    });
    throw new Error(`Failed to rename conversation (${res.status})`);
  }

  notifyConversationMutations();
}

/**
 * Domain operation for updating conversation status (regular vs archived).
 * Issues a PATCH request to /api/conversations/:id.
 */
export async function setConversationStatus(
  conversationId: string,
  status: "regular" | "archived",
): Promise<void> {
  const res = await apiFetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });

  if (!res.ok) {
    logger.debug("chat", "set_conversation_status_failed", {
      conversationId,
      status: res.status,
    });
    throw new Error(`Failed to update conversation status (${res.status})`);
  }

  notifyConversationMutations();
}
