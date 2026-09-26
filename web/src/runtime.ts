import { useCallback, useEffect, useMemo } from "react";
import {
  useChatRuntime,
  AssistantChatTransport,
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
import {
  createDirectResumableStorage,
  forgetRememberedStreamId,
  lastRememberedStreamId,
  rememberStreamId,
} from "./features/chat/state/resumable-stream";
import { resolveStreamRecovery, useStreamRecoveryStore, type StreamRecoveryState } from "./features/chat/state/streamRecovery";
import { lastUserText } from "./lib/ui-messages";
import { useAvailabilityStore } from "./features/availability/availabilityStore";

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
        kind: classifyChatError(err),
        errorType: err instanceof Error ? err.name : typeof err,
      });
      throw err;
    }
  };
  return Object.assign(wrapped, { preconnect: baseFetch.preconnect });
}

function ResumableThreadRuntime(): ReturnType<typeof useChatRuntime> {
  const aui = useAui();
  // Offline is the only state that gates sending (degraded stays sendable — a
  // degraded backend may still answer). Read here because the gate belongs to
  // the runtime, not the button: see the `isSendDisabled` note below.
  const isOffline = useAvailabilityStore((s) => s.status === "offline");
  // Hoisted so onResumeError can clear the same per-thread key the transport
  // uses (key is derived from current aui thread state in both cases).
  const storage = useMemo(
    () =>
      createDirectResumableStorage(() => {
        const item = aui.threadListItem.getState();
        return item.remoteId ?? item.id;
      }),
    [aui],
  );

  // Mirror every id the transport records, so a failure that arrives AFTER the
  // transport cleared its pointer can still be attributed to a known run.
  useEffect(() => {
    // `subscribe` is optional on the contract; without it the pointer can only be
    // read at error time, which is the ordering that loses the run.
    if (!storage.subscribe) return;
    const currentThread = (): string | null => {
      const item = aui.threadListItem.getState();
      return item.remoteId ?? item.id ?? null;
    };
    return storage.subscribe(() => {
      const threadId = currentThread();
      if (!threadId) return;
      try {
        rememberStreamId(threadId, storage.getStreamId(threadId));
      } catch {
        /* sessionStorage unavailable — recovery is simply unavailable */
      }
    });
  }, [aui, storage]);

  /**
   * Ask the server what became of this conversation's last run, publish the
   * verdict, and drop the resume pointer once the run is terminal.
   *
   * Keyed on the CONVERSATION, never on a stream id. The resumable pointer is
   * transport-owned, is cleared by the transport when a send fails, and does not
   * survive an app restart — so a client that can only ask "what is stream X?"
   * with an id it may have lost cannot recognise a dead run at all. Observed live
   * as a crash that produced no recovery state whatsoever.
   *
   * The pointer still has to be dropped by us: the transport clears it only when
   * `resumeStream()` rejects, and with ai@7 it never rejects, so the library's own
   * clear never runs and the client re-resumes a dead stream on every state
   * change. A `streaming` row keeps its pointer — its producer is still alive.
   */
  const reconcileRecovery = useCallback(
    async (threadId: string, prompt: string, assumeRun = false) => {
      const { status } = await resolveStreamRecovery(threadId, prompt, { assumeRun });
      if (!status || status.status === "streaming") return;
      try {
        storage.clear(threadId);
        forgetRememberedStreamId(threadId);
        logger.info("chat", "stream_resume_pointer_cleared", {
          threadId,
          streamId: status.streamId,
          status: status.status,
          terminalKind: status.terminalKind,
        });
      } catch {
        /* sessionStorage unavailable — the cost is a server-side replay, nothing more */
      }
    },
    [storage],
  );

  // The prompt for a re-send, read from the live runtime. A crashed run's user
  // message was never written to history (the server was down when the browser
  // tried), so this is the only moment it exists anywhere.
  const promptFor = useCallback((): string => {
    try {
      return lastUserText(aui.thread.getState().messages) ?? "";
    } catch {
      return "";
    }
  }, [aui]);

  // Thread load: a run that died while the tab was closed is recognised here, with
  // no pointer and no dependency on when the transport happened to clear it.
  const loadedThreadId = (() => {
    const item = aui.threadListItem.getState();
    return item.remoteId ?? item.id ?? null;
  })();
  useEffect(() => {
    if (!loadedThreadId) return;
    void reconcileRecovery(loadedThreadId, promptFor());
  }, [reconcileRecovery, promptFor, loadedThreadId]);

  // Re-check pending notices when the backend comes back. This subscribes to the
  // availability STORE — the app's single readiness poller (Phase 3.1/3.2) — rather
  // than adding a timer or depending on the central recovery hook, so there is
  // still exactly one thing deciding when the backend is reachable.
  //
  // This is the step that upgrades "couldn't reconnect" to a real Retry: the
  // failure is always detected while the backend is DOWN, so the first verdict can
  // never be the durable one.
  const backendOnline = useAvailabilityStore((s) => s.status === "online");
  useEffect(() => {
    if (!backendOnline) return;
    // A second chance for a notice whose own re-read chain already gave up (it is
    // bounded on purpose). The chain is the primary mechanism; this is a cheap
    // catch-up on the app's own reachability signal, not a second poller.
    const pending = Object.values(useStreamRecoveryStore.getState().byThread).filter(
      (s): s is StreamRecoveryState => s !== undefined && !s.canRetry,
    );
    if (pending.length === 0) return;
    void Promise.all(pending.map((s) => reconcileRecovery(s.threadId, s.prompt)));
  }, [backendOnline, reconcileRecovery]);
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
          id,
          trigger,
          messageId,
          requestMetadata,
        }) => {
          const s = useSettingsStore.getState();
          const item = aui.threadListItem.getState();
          const threadKey = item.remoteId ?? item.id ?? "nothread";
          // Dead-run recovery (Phase 3): every new send supersedes a previous
          // recovery notice, exactly as the composer's other strips do. Cleared
          // here, at the single funnel every send passes through, so no send path
          // (Enter, button, touch, programmatic) can leave a stale Retry behind.
          useStreamRecoveryStore.getState().clear(threadKey);
          // A new send supersedes the previous run: its id must never be reused to
          // explain a later failure, or a dead old run would be blamed twice.
          forgetRememberedStreamId(threadKey);
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
          // Deliberately allowlist the Direct envelope. The transport may
          // provide system/tools/callSettings/config from its model context, but
          // those are server-owned policy and must never be forwarded.
          return {
            body: {
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
    // Offline send gate (runtime level). The composer ALSO swaps its Send
    // button for an inert one while offline, but a disabled button only stops
    // CLICKS: `ComposerPrimitive.Input` submits the form on Enter via
    // `form.requestSubmit()`, and `aui.composer.send()` can be called
    // programmatically. Both land on the composer runtime, where
    // `canSend = !isEmpty && !isSendDisabled && !isSending` gates `send()` —
    // so setting the flag here is what actually holds the gate shut, on every
    // path, while leaving the input usable so the user can keep typing.
    isSendDisabled: isOffline,
    // A failed run is the terminal event of the send operation, so it is the
    // one that ends it. `kind` distinguishes a transport kill from anything
    // else, which is what tells "the answer never arrived" apart from "the
    // model failed".
    onError: (error) => {
      const kind = classifyChatError(error);
      logger.warn("chat", "send.failed", {
        kind,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      endSendOperation("failed");
      // Dead-run recognition (Phase 3). This is the only live signal that a run
      // died: `makeRequest` never rejects, so `onResumeError` is unreachable,
      // while a failed reconnect (`ai/dist/index.js:19176`) and an errored replayed
      // stream (`:19273`) both arrive here.
      //
      // Recovery is resolved by CONVERSATION, so this needs no resumable pointer
      // and cannot be defeated by the transport clearing one first.
      const item = aui.threadListItem.getState();
      const threadKey = item.remoteId ?? item.id;
      if (!threadKey) return;
      logger.info("chat", "stream_error_recovery_check", {
        threadId: threadKey,
        streamId: lastRememberedStreamId(threadKey),
        errorType: error instanceof Error ? error.name : typeof error,
      });
      // `assumeRun`: a send or resume just failed, so a run demonstrably existed
      // even if the status cannot be read yet (the usual case — the backend is
      // what just died). The notice is kept unconfirmed so the recovery hook has
      // something to re-check when it returns.
      void reconcileRecovery(threadKey, promptFor(), true);
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
    //
    // NOTE: with the installed AI SDK this hook never fires — `makeRequest` does
    // not reject (`ai/dist/index.js:19120-19320`), so the `.catch` in
    // `useChatThread` that calls it is unreachable. It is kept because it is the
    // documented contract and costs nothing, but the live recovery signal is the
    // `onError` above.
    onResumeError: (error) => {
      try {
        storage.clear();
        const item = aui.threadListItem.getState();
        logger.debug("chat", "resume_failed_stale_cleared", {
          threadId: item.remoteId ?? item.id,
          errorType: error instanceof Error ? error.name : typeof error,
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
