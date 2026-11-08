import type { ExternalStoreThreadListAdapter } from "@assistant-ui/react";
import { renameConversation } from "@/features/chat/state/conversationMutations";
import type { V2ThreadState } from "./v2Types";

/** Creates the identity-only assistant-ui thread list for a native session. */
export function createV2ThreadListAdapter(
  state: V2ThreadState,
  conversationId: string | null,
): ExternalStoreThreadListAdapter {
  return {
    threadId: state.sessionId,
    isLoading: state.load.type !== "ready",
    threads: [
      {
        status: "regular",
        id: state.sessionId,
        remoteId: state.sessionId,
        externalId: state.sessionId,
        title: state.title ?? undefined,
        custom: { conversationId },
      },
    ],
    onRename: async (_threadId, newTitle) => {
      if (conversationId) {
        await renameConversation(conversationId, newTitle);
      }
    },
  };
}
