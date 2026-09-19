import { logger } from "@/lib/logger";

export interface RenameConversationOptions {
  title: string;
}

export interface SetConversationStatusOptions {
  status: "regular" | "archived";
}

/**
 * Domain operation for renaming a conversation.
 * Issues a PATCH request to /api/conversations/:id.
 */
export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<void> {
  const cleanTitle = title.trim();
  if (!cleanTitle) {
    throw new Error("Title cannot be empty");
  }

  const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
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
}

/**
 * Domain operation for updating conversation status (regular vs archived).
 * Issues a PATCH request to /api/conversations/:id.
 */
export async function setConversationStatus(
  conversationId: string,
  status: "regular" | "archived",
): Promise<void> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
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
}
