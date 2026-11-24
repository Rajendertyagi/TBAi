import { useMemo } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { threadListAdapter } from "../../../app/adapter";
import { useAppChatRuntime } from "../../../runtime";
import { ChatWindow } from "../../../components/ChatWindow";
import { ChatHeader } from "../../chat/components/ChatHeader";
import { createDirectAuiConfig, DirectDataUIs, DirectHostProvider } from "./directHost";

// Stable identity: a fresh closure each render can cause needless runtime
// reconfiguration. Panel hosts never rebind their thread from the runtime.
// Draft materialization is deliberately NOT done here — that belongs to the
// Phase 5a draft-aware host, which wires resolveDraftId into this callback.
const noopThreadIdChange = () => {};

/**
 * A single Direct Chat content host. Owns its own runtime for `threadId`, so
 * multiple hosts can be live simultaneously and independently. The runtime's
 * lifetime is this component's lifetime — unmounting disposes only this host.
 *
 * Composition parity with the routed `ChatView`: `ChatHeader` + `ChatWindow`
 * live inside the SAME per-host assistant-ui provider, and the shared Direct
 * config/data-UI contract supplies tools, suggestions, progress and compaction
 * (see `directHost.tsx`). `ChatHeader` receives the exact `threadId` this host
 * is bound to, so its rename/archive/delete/copy-id/open-in-code/new-chat
 * actions target the correct conversation. For a draft (`isDraft`) the header
 * shows draft-appropriate actions and the runtime never materializes it.
 */
export function DirectChatHost({
  threadId,
  isDraft = false,
}: {
  threadId: string;
  isDraft?: boolean;
}) {
  return (
    <DirectHostProvider>
      <DirectChatInner threadId={threadId} isDraft={isDraft} />
    </DirectHostProvider>
  );
}

function DirectChatInner({ threadId, isDraft }: { threadId: string; isDraft: boolean }) {
  const runtime = useAppChatRuntime(threadListAdapter, threadId, noopThreadIdChange);
  // The tools/suggestions config belongs to THIS provider — the one that
  // installs the client scope `part.toolUI` reads. Stable for the host's life.
  const config = useMemo(() => createDirectAuiConfig(), []);
  return (
    <AssistantRuntimeProvider runtime={runtime} config={config}>
      <DirectDataUIs />
      <div
        className="flex h-full min-h-0 flex-col"
        data-testid="direct-chat-host"
        data-thread-id={threadId}
        data-is-draft={isDraft}
      >
        <div data-testid="direct-conversation-header" data-conversation-id={threadId}>
          <ChatHeader threadId={threadId} />
        </div>
        <div className="min-h-0 flex-1">
          <ChatWindow isDraft={isDraft} />
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
