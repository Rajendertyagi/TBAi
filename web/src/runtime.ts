import { useMemo } from "react";
import {
  useChatRuntime,
  AssistantChatTransport,
  createResumableSessionStorage,
} from "@assistant-ui/ai-sdk";
import {
  lastAssistantMessageIsCompleteWithToolCalls,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import { useAui, useRemoteThreadListRuntime, type RemoteThreadListAdapter } from "@assistant-ui/react";
import { useSettingsStore } from "./stores";
import { logger } from "./lib/logger";

/**
 * Wires the assistant-ui runtime to our backend using the native
 * RemoteThreadListRuntime + ThreadHistoryAdapter architecture.
 *
 * The transport is constructed PER THREAD inside the runtimeHook so the
 * resumable-stream storage key is scoped to that thread — one conversation's
 * stream can never resume inside another (official "Multiple threads" pattern).
 *
 * Only the selected provider's id is sent to the server; the API key stays
 * backend-only (resolved from the DB/registry on the server).
 */

/** Detects terminal stream markers so Stop / errors / natural finish clear the
 *  stored resume id (preventing a reload from resuming a dead stream, which
 *  would 404 against the server's store). Markers match raw SSE text only —
 *  message content is JSON-escaped, so user/model text can never trip them. */
const ABORT_MARKER = '"type":"abort"';
const FINISH_MARKER = '"type":"finish"';
const ERROR_MARKER = '"type":"error"';

function makeIsFinishEvent(): (chunk: Uint8Array, accumulator: string) => boolean {
  let sawAbort = false;
  return (_chunk, accumulator) => {
    if (!sawAbort && accumulator.includes(ABORT_MARKER)) {
      sawAbort = true;
      return true;
    }
    return accumulator.includes(FINISH_MARKER) || accumulator.includes(ERROR_MARKER);
  };
}

function ResumableThreadRuntime(): ReturnType<typeof useChatRuntime> {
  const aui = useAui();
  // Hoisted so onResumeError can clear the same per-thread key the transport
  // uses (key is derived from current aui thread state in both cases).
  const storage = useMemo(
    () =>
      createResumableSessionStorage({
        key: () => {
          const item = aui.threadListItem.getState();
          return `tbai-resume:${item.remoteId ?? item.id}`;
        },
      }),
    [aui],
  );
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/api/chat",
        resumable: {
          storage,
          resumeApi: (streamId) => `/api/chat/resume/${streamId}`,
          isFinishEvent: makeIsFinishEvent(),
        },
        prepareSendMessagesRequest: async ({
          messages,
          body,
          id,
          trigger,
          messageId,
          requestMetadata,
        }) => {
          const { activeProviderId, providers, selectedModelId } = useSettingsStore.getState();
          const provider =
            providers.find((p) => p.id === activeProviderId) ?? providers[0];
          return {
            body: {
              ...body,
              providerId: provider?.id ?? "",
              model: selectedModelId ?? provider?.model ?? "",
              id,
              messages,
              trigger,
              messageId,
              metadata: requestMetadata,
            },
          };
        },
      }),
    [aui, storage],
  );

  return useChatRuntime({
    transport,
    // Continuation contract (official ai helpers): after a tool result OR an
    // approval decision lands, the runtime automatically resends the thread so
    // the model continues. Without this the run stalls in `ready` state.
    // Human-tool completion and server-approval completion are distinct
    // predicates — a backend-approval tool must NOT use the human helper.
    sendAutomaticallyWhen: ({ messages }) =>
      lastAssistantMessageIsCompleteWithToolCalls({ messages }) ||
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages }),
    // Self-healing for dead resume pointers: if the server has no such stream
    // (restart wiped the in-memory store, or the stream already finalized),
    // drop the stale id so future reloads don't retry it forever. Persisted
    // messages are untouched — only the resume pointer clears.
    onResumeError: (error) => {
      try {
        storage.clear();
        const item = aui.threadListItem.getState();
        logger.debug("chat", "resume_failed_stale_cleared", {
          threadId: item.remoteId ?? item.id,
          message: error instanceof Error ? error.message : String(error),
        });
      } catch {
        /* sessionStorage may be unavailable — resume simply won't retry */
      }
    },
  });
}

export function useAppChatRuntime(
  adapter: RemoteThreadListAdapter,
  threadId: string | undefined,
  onThreadIdChange: (id: string | undefined) => void
) {
  return useRemoteThreadListRuntime({
    runtimeHook: ResumableThreadRuntime,
    adapter,
    threadId,
    onThreadIdChange,
  });
}
