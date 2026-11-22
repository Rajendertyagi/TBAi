import { AuiConfig, AuiProvider, AssistantRuntimeProvider } from "@assistant-ui/react";
import { threadListAdapter } from "../../../app/adapter";
import { useAppChatRuntime } from "../../../runtime";
import { ChatWindow } from "../../../components/ChatWindow";

// A fresh empty config so this runtime is a top-level one, not a child of the
// ambient provider. `extends={null}` is the official assistant-ui isolation
// contract (required because useRemoteThreadListRuntime throws when nested).
const isolatedConfig = AuiConfig({});
// Stable identity: a fresh closure each render can cause needless runtime
// reconfiguration. Panel hosts never rebind their thread from the runtime.
const noopThreadIdChange = () => {};

/**
 * A single Direct Chat content host. Owns its own runtime for `threadId`, so
 * multiple hosts can be live simultaneously and independently. The runtime's
 * lifetime is this component's lifetime — unmounting disposes only this host.
 *
 * The isolation boundary is inlined here via the official `AuiProvider` API
 * rather than importing the OpenCode feature's boundary — this is generic
 * assistant-ui isolation, not OpenCode-specific, and inlining avoids a
 * cross-feature dependency. The canonical shared `threadListAdapter` is used;
 * its cache/search/sort state is module-level, so a fresh instance adds nothing.
 */
export function DirectChatHost({
  threadId,
  isDraft = false,
}: {
  threadId: string;
  isDraft?: boolean;
}) {
  return (
    <AuiProvider extends={null} config={isolatedConfig}>
      <DirectChatInner threadId={threadId} isDraft={isDraft} />
    </AuiProvider>
  );
}

function DirectChatInner({ threadId, isDraft }: { threadId: string; isDraft: boolean }) {
  const runtime = useAppChatRuntime(threadListAdapter, threadId, noopThreadIdChange);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatWindow isDraft={isDraft} />
    </AssistantRuntimeProvider>
  );
}
