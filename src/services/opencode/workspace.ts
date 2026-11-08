import type { Conversation } from "../../types";
import { resolveConversationWorkspace } from "../workspace";
import { OpenCodeDirectoryUnavailableError } from "./errors";

/**
 * Resolves the directory scope for an OpenCode session.
 *
 * For imported conversations, `conversation.opencodeDirectory` is the persisted
 * mirror of OpenCode's confirmed `location.directory`. It is returned verbatim
 * (especially for adopted/remote runtimes where the path is opaque and cannot be
 * verified or canonicalized against the local filesystem).
 *
 * For native TBAi-created conversations without an explicit `opencodeDirectory`,
 * this safely falls back to `resolveConversationWorkspace(conversation.id).dir`.
 *
 * If an imported conversation lacks an `opencodeDirectory`, it must NOT
 * silently fall back to the hidden chat folder. It throws OpenCodeDirectoryUnavailableError.
 */
export async function resolveOpenCodeSessionDirectory(
  conversation: Pick<Conversation, "id" | "opencodeDirectory" | "opencodeImported">,
): Promise<string> {
  if (conversation.opencodeDirectory && conversation.opencodeDirectory.trim().length > 0) {
    return conversation.opencodeDirectory;
  }

  if (conversation.opencodeImported) {
    throw new OpenCodeDirectoryUnavailableError(
      conversation.id,
      "",
      "Imported OpenCode session has no recorded working directory and cannot fall back to a hidden chat workspace",
    );
  }

  const resolved = await resolveConversationWorkspace(conversation.id);
  return resolved.dir;
}
