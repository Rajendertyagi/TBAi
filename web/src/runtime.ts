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

/**
 * Per-send config snapshots, keyed by thread + last user message id.
 *
 * Why: automatic tool/approval continuations re-invoke
 * prepareSendMessagesRequest with trigger "submit-message" — the same
 * trigger as an explicit send. Clearing the picker's one-shot override
 * inside prepare would swap models mid-run. Instead each logical send
 * (user message + its continuations, which share the last user message id)
 * snapshots the effective config once; the NEXT new user message snapshots
 * fresh UI state. Previous messages are never touched (history immutable).
 */
interface SendConfig {
  providerId: string;
  model: string;
  reasoningLevel?: string;
}

const sendConfigs = new Map<string, SendConfig>();

function pruneSendConfigs(): void {
  if (sendConfigs.size <= 60) return;
  const oldest = sendConfigs.keys().next().value;
  if (oldest !== undefined) sendConfigs.delete(oldest);
}

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
          const s = useSettingsStore.getState();
          const item = aui.threadListItem.getState();
          const threadKey = item.remoteId ?? item.id ?? "nothread";
          // Conversation-owned default, projected from SQLite (source of truth).
          const custom = (item.custom ?? {}) as {
            providerId?: string | null;
            modelId?: string | null;
            reasoningLevel?: string | null;
          };
          const lastUser = [...(messages as Array<{ role?: string; id?: string }>) ]
            .reverse()
            .find((m) => m.role === "user");
          const sendKey = `${threadKey}:${lastUser?.id ?? "noid"}`;
          let sel = sendConfigs.get(sendKey);
          const hasPendingPick =
            s.selectedProviderId != null ||
            s.selectedModelId != null ||
            s.selectedReasoningLevel != null;
          if (!sel || (trigger === "regenerate-message" && hasPendingPick)) {
            // Fresh logical send (or explicit regenerate with a new pick):
            // resolve the effective config from three layers —
            //   1. one-shot picker override (Zustand, cleared after send)
            //   2. conversation default (threadListItem.custom, SQLite)
            //   3. global active provider default
            // then FULLY revert the one-shot UI pick so the NEXT message falls
            // back to the conversation default. Continuations reuse the
            // snapshot via sendKey (history is immutable).
            const providerId =
              s.selectedProviderId ?? custom.providerId ?? s.activeProviderId ?? s.providers[0]?.id ?? "";
            const provider = s.providers.find((p) => p.id === providerId) ?? s.providers[0];
            sel = {
              providerId: provider?.id ?? "",
              model: s.selectedModelId ?? custom.modelId ?? provider?.model ?? "",
              reasoningLevel:
                s.selectedReasoningLevel ?? (custom.reasoningLevel as string | undefined) ?? undefined,
            };
            sendConfigs.set(sendKey, sel);
            pruneSendConfigs();
            if (hasPendingPick) {
              s.revertChatTarget();
            }
          }
          return {
            body: {
              ...body,
              providerId: sel.providerId,
              model: sel.model,
              ...(sel.reasoningLevel ? { reasoningLevel: sel.reasoningLevel } : {}),
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
