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
import { classifyChatError } from "./lib/transport-errors";
import { currentOperationId } from "./lib/operation";
import {
  attachSendOperation,
  beginSendOperation,
  endSendOperation,
  observeBodySettled,
} from "./lib/send-operation";
import { peekMaterializedEngine } from "./features/chat/state/materializeDraft";
import { setPendingFirstMessage } from "./features/chat/state/pendingFirstMessage";

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
  /**
   * The operation this logical send owns. Snapshotted with the rest of the
   * send config so every continuation (tool result, approval resend) re-opens
   * the SAME operation instead of starting a second one — that is what keeps a
   * tool-call turn joinable by a single operationId.
   */
  operationId: string;
}

const sendConfigs = new Map<string, SendConfig>();

function pruneSendConfigs(): void {
  if (sendConfigs.size <= 60) return;
  const oldest = sendConfigs.keys().next().value;
  if (oldest !== undefined) sendConfigs.delete(oldest);
}

/**
 * Thrown from prepareSendMessagesRequest to abort a library-driven send that
 * must never reach Direct /api/chat: a first send on a thread the single
 * owner materialized as opencode (Enter key or any non-custom trigger — the
 * Composer custom button bypasses the runtime entirely). The text is handed
 * to the pending-first-prompt stash (consumed once by the Code surface) and
 * tab binding drops the draft thread, so the failed run left behind is
 * invisible and the prompt executes exactly once through OpenCode.
 */
export class OpencodeDraftRedirectError extends Error {
  readonly threadId: string;

  constructor(threadId: string) {
    super(`Opencode draft send redirected (thread ${threadId})`);
    this.name = "OpencodeDraftRedirectError";
    this.threadId = threadId;
  }
}

type UIMessageLike = {
  role?: string;
  parts?: Array<{ type?: string; text?: string }>;
};

/** Plain text of the last user message (defensive: non-text parts ignored). */
function lastUserText(msgs: unknown): string | null {
  if (!Array.isArray(msgs)) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as UIMessageLike;
    if (m?.role !== "user" || !Array.isArray(m.parts)) continue;
    const text = m.parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n");
    if (text) return text;
  }
  return null;
}

/** Detects terminal stream markers so Stop / errors / natural finish clear the
 *  stored resume id (preventing a reload from resuming a dead stream, which
 *  would 404 against the server's store). Markers match raw SSE text only —
 *  message content is JSON-escaped, so user/model text can never trip them. */
const ABORT_MARKER = '"type":"abort"';
const FINISH_MARKER = '"type":"finish"';
const ERROR_MARKER = '"type":"error"';

// The send operation's lifetime, its lifecycle events, and the guaranteed
// release live in `lib/send-operation.ts` (extracted so the rules are testable
// without a DOM). This file only wires them: a fresh logical send opens the
// operation, a continuation re-opens the same one, and the response body
// settling ends it.

function makeIsFinishEvent(): (chunk: Uint8Array, accumulator: string) => boolean {
  let sawAbort = false;
  let reported = false;
  const report = (marker: string) => {
    if (reported) return;
    reported = true;
    endSendOperation(marker);
  };
  return (_chunk, accumulator) => {
    if (!sawAbort && accumulator.includes(ABORT_MARKER)) {
      sawAbort = true;
      report("abort");
      return true;
    }
    if (accumulator.includes(FINISH_MARKER)) {
      report("finish");
      return true;
    }
    if (accumulator.includes(ERROR_MARKER)) {
      report("error");
      return true;
    }
    return false;
  };
}

function diagnosticFetch(
  getThreadListItem: () => { remoteId?: string; id?: string } | undefined,
): typeof globalThis.fetch {
  const baseFetch = globalThis.fetch.bind(globalThis);
  const wrapped = async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    const startedAt = Date.now();
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const threadId = getThreadListItem()?.remoteId ?? getThreadListItem()?.id ?? "unknown";
    // Path only — never the query string, which can carry user data. This is
    // the browser half of the request pair the backend logs as
    // `http.request_start` / `http.request`.
    let path = url;
    try {
      path = new URL(url, window.location.origin).pathname;
    } catch {
      /* keep the raw value if it is not a URL */
    }
    // The operation this request belongs to, captured at issue time. A late
    // settle of a superseded response must not end the operation that replaced
    // it, so the id travels with the request instead of being re-read later.
    const operationId = currentOperationId();
    logger.info("chat", "request_sent", { path, threadId });

    try {
      const res = await baseFetch(input, init);
      logger.info("chat", "request_completed", {
        path,
        status: res.status,
        durationMs: Date.now() - startedAt,
        threadId,
      });
      if (!res.body) return res;
      return new Response(
        observeBodySettled(res.body, () =>
          endSendOperation("stream-settled", operationId),
        ),
        { status: res.status, statusText: res.statusText, headers: res.headers },
      );
    } catch (err) {
      // The request never produced a body, so nothing will settle: release the
      // operation here or this failure path leaks it.
      endSendOperation("request-failed", operationId);
      logger.error("chat", "request_failed", {
        path,
        durationMs: Date.now() - startedAt,
        threadId,
        errorType: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
  return Object.assign(wrapped, { preconnect: baseFetch.preconnect });
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
        fetch: diagnosticFetch(() => aui.threadListItem.getState()),
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
          // Phase 4 backstop: a library-driven send on a thread materialized
          // as opencode (Enter key et al. bypass the Composer custom send)
          // must never reach Direct /api/chat. Stash the text for the Code
          // surface's exactly-once handoff and abort this send; tab binding
          // (same owner record) drops the draft thread, so the failed run
          // left behind is never visible.
          if (peekMaterializedEngine(threadKey) === "opencode") {
            const text = lastUserText(messages);
            if (text) setPendingFirstMessage(threadKey, text);
            // The one-shot pick was consumed by this handoff (carried into
            // the row at initialize): revert so it cannot leak into a later
            // Direct draft. The Code surface never reads one-shot state.
            s.revertChatTarget();
            logger.info("chat", "send.redirected_to_opencode", { threadId: threadKey });
            endSendOperation("redirected");
            throw new OpencodeDraftRedirectError(threadKey);
          }
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
            const resolvedProviderId = provider?.id ?? "";
            const resolvedModel = s.selectedModelId ?? custom.modelId ?? provider?.model ?? "";
            // A fresh logical send (not a tool/approval continuation) opens the
            // operation; its id is snapshotted into the send config so every
            // continuation of THIS send re-opens the same one.
            const operationId = beginSendOperation({
              trigger,
              threadId: threadKey,
              providerId: resolvedProviderId,
              model: resolvedModel,
            });
            sel = {
              providerId: resolvedProviderId,
              model: resolvedModel,
              reasoningLevel:
                s.selectedReasoningLevel ?? (custom.reasoningLevel as string | undefined) ?? undefined,
              operationId,
            };
            sendConfigs.set(sendKey, sel);
            pruneSendConfigs();
            if (hasPendingPick) {
              s.revertChatTarget();
            }
          } else {
            // Continuation of one logical send (tool result, approval resend).
            // The previous response settling may already have ended the
            // operation, so re-open the SAME id: the whole turn stays joinable
            // by one operationId instead of splitting into several.
            attachSendOperation(sel.operationId);
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
    // A failed run is the terminal event of the send operation, so it is the
    // one that ends it. `kind` distinguishes a transport kill from anything
    // else, which is what tells "the answer never arrived" apart from "the
    // model failed".
    onError: (error) => {
      const kind = classifyChatError(error);
      logger.warn("chat", "send.failed", {
        kind,
        message: error instanceof Error ? error.message : String(error),
      });
      endSendOperation("failed");
    },
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
