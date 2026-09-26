import { Hono } from "hono";
import { logger, newRequestId } from "../lib/logger";
import { generateId } from "../lib/utils";
import { getModel } from "../services/ai";
import { buildReasoningProviderOptions } from "./chat-provider-options";
import { credentialStore } from "../services/credentials";
import { sanitizeStreamError } from "../lib/redact";
import { classifyError, errorLogFields } from "../lib/errors";
import { sanitizeAiRequest, aiDebugRequestsEnabled } from "../lib/ai-diagnostics";
import { prepareModelMessages } from "../lib/model-messages";
import { streamStatusQuerySchema } from "../lib/validation";
import {
  safeValidateUIMessages,
  stepCountIs,
  streamText,
  type UIMessage,
  UI_MESSAGE_STREAM_HEADERS,
  createUIMessageStream,
  createUIMessageStreamResponse,
  toUIMessageStream,
} from "ai";
import { mcpManager } from "../services/mcp/manager";
import {
  nativeTools,
  withTerminalOutput,
  buildToolsContext,
  type NativeToolSet,
  type NativeToolsContext,
} from "../tools";
import { createTerminalBatcher } from "../lib/terminal-stream";
import { resumableContext, chatStreamStore } from "../lib/resumable";
import {
  chatHistoryFinalizerDeps,
  finalizeDetachedRunHistory,
} from "../services/chat-streams/historyFinalizer";
import type { ChatStreamTerminalKind } from "../services/chat-streams/schema";
import { createProgressTracker } from "../lib/progress-tracker";
import type { ProgressData } from "../lib/progress-stages";
import { RESUMABLE_STREAM_ID_HEADER, ResumableStreamError } from "assistant-stream/resumable";
import { chatMessageMetadataSchema, chatRequestSchema } from "../lib/validation";
import { resolveChatModel, buildChatMessageMetadata, UnknownProviderError } from "./chat-model";
import { disableIdleTimeout } from "./shared";
import { chatRuns } from "../services/chat-runs";
import { conversationService } from "../services/storage";
import { resolveConversationWorkspace, WorkspaceError } from "../services/workspace";

const app = new Hono<{ Variables: { requestId: string } }>();

type DirectRunSettlement = "completed" | "failed" | "cancelled";
// Direct output is not replay-safe after the first chunk: a provider retry can
// duplicate text and charge the same conversation again. The UI exposes an
// explicit user retry instead.
const DIRECT_MAX_RETRIES = 0;
const DIRECT_STREAM_RETRIES = 0;
const DIRECT_SUCCESS_FINISH_REASONS: ReadonlySet<string> = new Set([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
]);

function isSuccessfulDirectFinishReason(reason: string | undefined): boolean {
  return reason !== undefined && DIRECT_SUCCESS_FINISH_REASONS.has(reason);
}

type UiStreamOutcome = {
  status: "completed" | "failed" | "aborted" | "unknown";
  error?: unknown;
};

function hasNonEmptyDirective(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** The logging surface the durable mirror needs; `logger` and `logger.child()` both satisfy it. */
type StreamLog = Pick<ReturnType<typeof logger.child>, "warn" | "error">;

/**
 * Direct-run outcome -> durable stream verdict. The official `ResumableStreamStore`
 * only knows `streaming | done | error`; TBAi's finer run semantics ride on
 * `terminal_kind` (design §4). This map is the single place that translation
 * happens, so the route can never invent a fifth kind.
 */
const DURABLE_VERDICTS: Record<DirectRunSettlement, ChatStreamTerminalKind> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

interface DurableMirrorOptions {
  log: StreamLog;
  providerType?: string;
  finishReason?: string | null;
  /** Sanitized classification source; the message itself is never persisted. */
  failureError?: unknown;
  runStatus?: string;
}

/**
 * Record this run's authoritative in-process outcome on the durable stream row.
 *
 * `chatRuns` remains the process-local single-winner latch; this keeps
 * `chat_streams` in agreement with it rather than creating a second source of
 * truth. Only the VERDICT is written: the byte-stream `status` belongs to the
 * official `finalize`, and closing the row here would make the producer's next
 * `append` throw — costing the client the structured `error` part it needs.
 * A run can honestly be `status='done'` with `terminal_kind='failed'` (see
 * `docs/2026-09-25-phase2-durability-design.md` §4).
 *
 * Only classification fields are persisted — never the provider message.
 */
function mirrorRunToDurableStream(
  streamId: string,
  status: DirectRunSettlement,
  options: DurableMirrorOptions,
): void {
  const settlement = DURABLE_VERDICTS[status];
  const errorCategory =
    status === "failed"
      ? errorLogFields(options.failureError ?? new Error("Direct stream failed"), {
          provider: options.providerType,
        }).category
      : status === "cancelled"
        ? "cancelled"
        : null;
  try {
    chatStreamStore.recordRunVerdict(streamId, settlement, {
      errorCategory,
      finishReason: options.finishReason ?? null,
    });
  } catch (err) {
    // The in-process verdict is still authoritative and already logged by the AI
    // funnel; a failed bookkeeping write must not change the run's outcome.
    options.log.error("chat", "chat_stream_verdict_failed", {
      streamId,
      runStatus: options.runStatus ?? "unknown",
      ...errorLogFields(err, { provider: options.providerType }),
    });
  }
}

// Chat streaming endpoint (AI SDK v7 UI-message stream consumed by @assistant-ui/react)
app.post("/api/chat", async (c) => {
  // Model stalls (thinking, tools, approvals) must never kill the stream.
  disableIdleTimeout(c);
  const requestId = (c.get("requestId") as string | undefined) ?? newRequestId();
  const parsed = chatRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    logger.warn("chat", "chat_request_rejected", {
      requestId,
      reason: "invalid_envelope",
    });
    return c.json(
      {
        error: "Invalid request",
        issues: parsed.error.issues,
        requestId,
      },
      400,
    );
  }

  const {
    reasoningLevel: reasoningOverride,
    messages: rawMessages,
  } = parsed.data;
  const providerId = parsed.data.providerId?.trim() || undefined;
  const model = parsed.data.model?.trim() || undefined;
  const threadId = parsed.data.id?.trim() || undefined;
  // Row-authoritative engine guard: a persisted OpenCode row must never be
  // served as Direct (the Code surface owns it). This runs before provider
  // resolution so an engine mismatch remains the canonical response even when
  // the request also has an unknown provider or missing credential.
  const conversation = threadId ? await conversationService.get(threadId) : null;
  if (conversation?.engine === "opencode") {
    return c.json(
      {
        error: `Conversation ${threadId} uses the OpenCode engine; open it on the Code surface instead of /api/chat.`,
        code: "ENGINE_MISMATCH",
        requestId,
      },
      422,
    );
  }

  const directiveField = (["system", "tools", "callSettings", "config"] as const).find(
    (field) => hasNonEmptyDirective(parsed.data[field]),
  );
  if (directiveField) {
    logger.warn("chat", "chat_request_rejected", {
      requestId,
      conversationId: threadId,
      reason: `${directiveField}_directive_not_allowed`,
    });
    return c.json({ error: `${directiveField} is server-owned`, requestId }, 400);
  }

  let resolved: Awaited<ReturnType<typeof resolveChatModel>>;
  try {
    resolved = await resolveChatModel({
      providerId,
      model,
      reasoningLevel: reasoningOverride,
      threadId,
    });
  } catch (e) {
    // Explicit but unknown provider reference: diagnosable 400, never a
    // silent substitution of the active provider (Phase 2 contract).
    if (e instanceof UnknownProviderError) {
      return c.json({ error: e.message, code: e.code, requestId }, 400);
    }
    throw e;
  }
  if (!resolved) {
    return c.json({ error: "No provider configured", requestId }, 400);
  }
  const provider = resolved.provider;
  const effectiveModel = resolved.model;
  const effectiveReasoning = resolved.reasoning;

  const needsKey = provider.type !== "ollama";
  let modelConfig = provider;
  if (needsKey) {
    if (!credentialStore.has(provider.id)) {
      return c.json({ error: "No API key configured for this provider.", requestId }, 400);
    }
    const apiKey = credentialStore.get(provider.id);
    modelConfig = { ...provider, apiKey };
  }
  if (effectiveModel) {
    modelConfig = { ...modelConfig, model: effectiveModel };
  }

  const messageValidation = await safeValidateUIMessages({
    messages: rawMessages,
    metadataSchema: chatMessageMetadataSchema,
  });
  if ("error" in messageValidation) {
    logger.warn("chat", "chat_request_rejected", {
      requestId,
      conversationId: threadId,
      reason: "invalid_messages",
      ...errorLogFields(messageValidation.error, { provider: provider.type }),
    });
    return c.json({ error: "Invalid messages", requestId }, 400);
  }
  if (messageValidation.data.some((message) => message.role === "system")) {
    logger.warn("chat", "chat_request_rejected", {
      requestId,
      conversationId: threadId,
      reason: "system_message_not_allowed",
    });
    return c.json({ error: "System messages are server-owned", requestId }, 400);
  }
  const messages: UIMessage[] = messageValidation.data;

  let approvalSecret: string;
  try {
    approvalSecret = credentialStore.getToolApprovalSecret();
  } catch (error) {
    logger.error("credential", "credential.error", {
      requestId,
      conversationId: threadId,
      ...errorLogFields(error),
    });
    return c.json(
      { error: "Tool approval security is unavailable", requestId },
      500,
    );
  }

  const languageModel = getModel(modelConfig);
  const reasoning = effectiveReasoning ?? provider.thinking ?? "off";
  // Every provider quirk that decides whether reasoning is returned at all
  // lives in that module — see it for why each option is shaped the way it is.
  const providerOptions = buildReasoningProviderOptions(
    provider,
    modelConfig.model,
    reasoning,
  );

  // Server-owned run: the registry (not the HTTP connection) owns this run's
  // lifetime. Client disconnect detaches; only explicit cancel, wall timeout,
  // or terminal completion changes run state. See services/chat-runs.ts.
  const run = chatRuns.create({
    requestId,
    conversationId: threadId,
    providerId: provider.id,
    modelId: modelConfig.model,
  });
  const streamId = run.streamId;

  // Setup failures after run creation must settle the record explicitly —
  // otherwise a run that never executed lingers as "running" until the sweep.
  let workspaceDir: string | undefined;
  try {
    const resolved = await resolveConversationWorkspace(threadId);
    workspaceDir = resolved.dir;
  } catch (err) {
    chatRuns.markFailed(run.streamId);
    if (err instanceof WorkspaceError) {
      return c.json(
        { error: `Workspace error: ${err.message}`, code: err.code, requestId },
        400,
      );
    }
    throw err;
  }

  // Precise on the native side (keeps the `streamText<NativeToolSet>`
  // generic honest) while still admitting the dynamic MCP `mcp__*` tools.
  let tools: NativeToolSet & Record<string, any>;
  let toolsContext: NativeToolsContext;
  let modelMessages: Awaited<ReturnType<typeof prepareModelMessages>>;
  try {
    tools = {
      ...nativeTools,
      // Live terminal output rides a thin per-request closure: a function
      // cannot travel in validated Zod context, so `run_command` alone is
      // rebuilt with the tap wired in (single instrumentation, not stacked).
      run_command: withTerminalOutput((toolCallId, event) =>
        terminalBatcher.push(toolCallId, event),
      ),
      // Tool calls share the run's lifetime (survive client disconnect like
      // the model call); explicit cancel aborts them via the run controller.
      ...mcpManager.getAiTools(run.controller.signal),
    };
    toolsContext = buildToolsContext({
      workspaceDir,
      threadId,
      // Scheduler creates inherit the current provider/model when the model
      // omits them (it cannot guess provider cuid values).
      providerId: provider.id,
      modelId: modelConfig.model,
    });
    modelMessages = await prepareModelMessages(messages, tools, { threadId });
  } catch (err) {
    chatRuns.markFailed(run.streamId);
    throw err;
  }
  // Correlation bindings for every line this route emits: requestId (this
  // request) + conversationId (the thread) + provider/model. `operationId` is
  // inherited from the request context, so all of these lines join the user
  // action that caused them without being repeated per call site.
  const chatLog = logger.child({
    requestId,
    conversationId: threadId,
    provider: provider.type,
    model: modelConfig.model,
  });
  const chatStartedAt = Date.now();

  // ── Diagnostic: chat_request_received ─────────────────────────────────────
  chatLog.info("chat", "chat_request_received", {
    provider: provider.type,
    providerId: provider.id,
    model: modelConfig.model,
    reasoningLevel: reasoning,
    threadId,
    messageCount: messages.length,
    toolCount: Object.keys(tools).length,
    endpointConfigured: Boolean(provider.endpoint),
    abortSignalAborted: c.req.raw.signal.aborted,
  });

  if (aiDebugRequestsEnabled() && chatLog.isEnabled("debug")) {
    chatLog.debug("ai.provider", "ai_request_diagnostic", {
      ...sanitizeAiRequest({
        provider: provider.type,
        model: modelConfig.model,
        messages: modelMessages,
        tools,
      }),
      durationMs: Date.now() - chatStartedAt,
    } as Record<string, unknown>);
  }

  const progress = createProgressTracker();
  let streamWriter: { write: (part: any) => void } | null = null;
  const terminalBatcher = createTerminalBatcher((part) => streamWriter?.write(part));

  // ── Diagnostic tracking state ─────────────────────────────────────────────
  let firstChunkAt: number | null = null;
  let chunkCount = 0;
  let streamErrorCaught: unknown = null;
  let originalStreamError: unknown = null;
  let clientDisconnected = false;
  let responseLogged = false;
  let errorLogged = false;
  let modelFinishReason: string | undefined;
  let modelUsage: { totalTokens?: number } | undefined;

  /** Bind the hoisted durable mirror to this run's correlation context. */
  const mirrorSettlement = (status: DirectRunSettlement): void => {
    mirrorRunToDurableStream(streamId, status, {
      log: chatLog,
      providerType: provider.type,
      finishReason: modelFinishReason ?? null,
      failureError: originalStreamError,
      runStatus: chatRuns.get(streamId)?.status ?? "unknown",
    });
  };

  const settleRun = (status: DirectRunSettlement): boolean => {
    const effectiveStatus: DirectRunSettlement =
      status === "cancelled" && chatRuns.get(streamId)?.timedOut
        ? "failed"
        : status;
    let won: boolean;
    if (effectiveStatus === "completed") won = chatRuns.markCompleted(streamId);
    else if (effectiveStatus === "failed") won = chatRuns.markFailed(streamId);
    else won = chatRuns.markCancelled(streamId);
    // Mirror only when this call is the single winner, so a losing racer can
    // never settle the durable row.
    if (won) mirrorSettlement(effectiveStatus);
    return won;
  };

  const logAiError = (error: unknown): void => {
    if (errorLogged) return;
    errorLogged = true;
    chatLog.error("ai", "ai.error", {
      streamId,
      ...errorLogFields(error ?? new Error("Direct stream failed"), { provider: provider.type }),
      elapsedMs: Date.now() - chatStartedAt,
      firstChunkArrived: firstChunkAt !== null,
      firstChunkElapsedMs: firstChunkAt !== null ? firstChunkAt - chatStartedAt : null,
      chunkCount,
    });
  };

  const logAiResponse = (finishReason: string | undefined): void => {
    if (responseLogged) return;
    responseLogged = true;
    chatLog.info("ai", "ai.response", {
      streamId,
      outcome: "completed",
      runStatus: chatRuns.get(streamId)?.status ?? "completed",
      ...(finishReason ? { finishReason } : {}),
      durationMs: Date.now() - chatStartedAt,
      chunkCount,
      ...(modelUsage?.totalTokens !== undefined
        ? { totalTokens: modelUsage.totalTokens }
        : {}),
    });
  };

  const settleFromUiOutcome = (
    outcome: UiStreamOutcome,
    finishReason?: string,
  ): { settlement: DirectRunSettlement; didSettle: boolean } => {
    const effectiveFinishReason = finishReason ?? modelFinishReason;
    let settlement: DirectRunSettlement;
    if (effectiveFinishReason === "error" || !isSuccessfulDirectFinishReason(effectiveFinishReason)) {
      if (outcome.status === "aborted" && effectiveFinishReason !== "error") {
        settlement = "cancelled";
      } else {
        settlement = "failed";
      }
    } else if (outcome.status === "completed") {
      settlement = "completed";
    } else if (outcome.status === "aborted") {
      settlement = "cancelled";
    } else {
      settlement = "failed";
    }

    const didSettle = settleRun(settlement);
    if (settlement === "failed") {
      if (didSettle) logAiError(outcome.error ?? originalStreamError);
    } else if (settlement === "completed" && didSettle) {
      logAiResponse(effectiveFinishReason);
    }
    return { settlement, didSettle };
  };

  // Terminal diagnostic for `chat_response_closed`: a real provider/merge error
  // or a run that settled failed. Recoverable tool-error parts deliberately do
  // not set this — they are reported by the tool funnel instead.
  const runHadError = (): boolean =>
    streamErrorCaught !== null ||
    (chatRuns.get(streamId)?.status ?? "unknown") === "failed";

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      streamWriter = writer;
      writer.write({
        type: "data-tbai-progress",
        id: "progress",
        data: { kind: "tbai-progress" as const, version: 1 as const, stages: [] },
      });

      // ── AI funnel: request ────────────────────────────────────────────────
      chatLog.debug("ai", "ai.request", {
        streamId,
        provider: provider.type,
        model: modelConfig.model,
        endpointConfigured: Boolean(provider.endpoint),
        protocol: (modelConfig as { apiProtocol?: string }).apiProtocol || "default",
        streamRetries: DIRECT_STREAM_RETRIES,
        maxRetries: DIRECT_MAX_RETRIES,
        abortSignalAborted: c.req.raw.signal.aborted,
        elapsedMs: Date.now() - chatStartedAt,
      });

      // The explicit generic binds `toolsContext` to the native tools'
      // `contextSchema`s. Without it the MCP spread (`Record<string, any>`)
      // would erase the context types and `toolsContext` would collapse to
      // `never`; with it the map is checked per tool name at compile time.
      const result = streamText<NativeToolSet>({
        model: languageModel,
        messages: modelMessages,
        maxRetries: DIRECT_MAX_RETRIES,
        streamRetries: DIRECT_STREAM_RETRIES,
        ...(conversation?.systemPrompt ? { instructions: conversation.systemPrompt } : {}),
        tools,
        toolsContext,
        stopWhen: stepCountIs(20),
        experimental_toolApprovalSecret: approvalSecret,
        toolApproval: {
          write_file: "user-approval",
          edit_file: "user-approval",
          delete_file: "user-approval",
          run_command: "user-approval",
          process_kill: "user-approval",
          browser_action: "user-approval",
        },
        // Decoupled: the run's own controller (cancel endpoint / wall clock),
        // never the request signal (disconnect must detach, not kill).
        abortSignal: run.controller.signal,
        // ── Diagnostic: first chunk ────────────────────────────────────────
        onChunk: () => {
          chunkCount++;
          if (firstChunkAt === null) {
            firstChunkAt = Date.now();
            chatLog.info("chat", "stream_first_chunk", {
              elapsedMs: firstChunkAt - chatStartedAt,
              abortSignalAborted: c.req.raw.signal.aborted,
            });
          }
        },
        onError: ({ error }) => {
          originalStreamError = error;
          streamErrorCaught = error;
          const detachedClientAbort =
            clientDisconnected && classifyError(error).category === "cancelled";
          if (!detachedClientAbort) logAiError(error);
        },
        onToolExecutionStart: ({ toolCall }) => {
          progress.onToolExecutionStart({ toolCall });
          writer.write({
            type: "data-tbai-progress",
            id: "progress",
            data: progress.onFinish() as unknown as ProgressData,
          });
        },
        onToolExecutionEnd: ({ toolCall, toolOutput }) => {
          progress.onToolExecutionEnd({ toolCall, toolOutput });
          writer.write({
            type: "data-tbai-progress",
            id: "progress",
            data: progress.onFinish() as unknown as ProgressData,
          });
          const id = (toolCall as { toolCallId?: string } | undefined)?.toolCallId;
          const out = toolOutput as
            | { exitCode?: number; timedOut?: boolean }
            | undefined;
          if (id) {
            terminalBatcher.complete(
              id,
              typeof out?.exitCode === "number" ? out.exitCode : undefined,
              out?.timedOut === true ? true : undefined,
            );
          }
        },
        onEnd: ({ finishReason, usage }) => {
          modelFinishReason = finishReason;
          modelUsage = usage as { totalTokens?: number } | undefined;
          const finalProgress = progress.onFinish();
          writer.write({
            type: "data-tbai-progress",
            id: "progress",
            data: finalProgress,
          });
        },
        // ── Run abort (explicit cancel or wall timeout only — request
        // disconnect no longer reaches the run controller) ───────────────────
        onAbort: () => {
          const rec = chatRuns.get(streamId);
          // A terminal record means the cancel endpoint or wall clock already
          // settled this run; log nothing twice.
          if (!rec || rec.status !== "running") return;
          const elapsedMs = Date.now() - chatStartedAt;
          if (rec.timedOut) {
            if (chatRuns.markFailed(streamId)) mirrorSettlement("failed");
            chatLog.error("ai", "ai.error", {
              category: "timeout",
              streamId,
              elapsedMs,
              firstChunkArrived: firstChunkAt !== null,
              chunkCount,
            });
          } else {
            if (chatRuns.markCancelled(streamId)) mirrorSettlement("cancelled");
            chatLog.warn("ai", "ai.error", {
              category: "cancelled",
              streamId,
              elapsedMs,
              firstChunkArrived: firstChunkAt !== null,
              firstChunkElapsedMs: firstChunkAt !== null ? firstChunkAt - chatStartedAt : null,
              chunkCount,
            });
          }
          const abortedProgress = progress.onFinish();
          for (const stage of abortedProgress.stages) {
            if (stage.status === "active") stage.status = "failed";
          }
          writer.write({
            type: "data-tbai-progress",
            id: "progress",
            data: abortedProgress,
          });
        },
        ...(Object.keys(providerOptions).length ? { providerOptions } : {}),
      });

      writer.merge(toUIMessageStream({
        stream: result.stream,
        originalMessages: messages,
        generateMessageId: () => generateId(),
        onError: (error) => {
          // This callback also sees recoverable tool-error parts, so it must
          // not touch the provider-error slot (`streamText.onError` below owns
          // that) and must not raise the terminal `hadError` diagnostic. It
          // only produces sanitized user-facing error text.
          return sanitizeStreamError(error);
        },
        // The inner conversion owns producer settlement. It continues even when
        // the browser detaches, so a client disconnect cannot turn a healthy
        // run into a cancellation or a false success.
        onEnd: async ({ outcome, finishReason, responseMessage, isAborted, messages }) => {
          // Detachment is read BEFORE settling, in the same synchronous turn:
          // `chatRuns.attach` clears the mark regardless of run status, so a resume
          // landing later would flip the answer and suppress a finalization this
          // run genuinely needs.
          const wasDetached = (chatRuns.get(streamId)?.detachedAt ?? null) !== null;
          writer.setOutcome(outcome);
          const { settlement, didSettle } = settleFromUiOutcome(outcome, finishReason);
          // Server-side history finalization: the connected client persists through
          // the assistant-ui history adapter, so this is only the fallback for a run
          // that completed with nobody there to write it. Gated on the single
          // winning `completed` transition, so it can run at most once per run.
          if (!wasDetached || !didSettle || settlement !== "completed") return;
          await finalizeDetachedRunHistory(chatHistoryFinalizerDeps, {
            streamId,
            responseMessage,
            isAborted,
            // The branch the run continued: the AI SDK hands us
            // `[...originalMessages (minus the last when continuing), responseMessage]`,
            // so the previous entry is the same parent the browser's adapter would
            // record. Not "the last user message", which is wrong on a continuation.
            parentId: messages[messages.length - 2]?.id ?? null,
            log: chatLog,
          });
        },
        messageMetadata: ({ part }) =>
          buildChatMessageMetadata(part, {
            providerId: provider.id,
            modelId: modelConfig.model,
            reasoningLevel: reasoning,
          }),
      }));
    },
    generateId: () => generateId(),
    // ── Diagnostic: stream failed ─────────────────────────────────────────
    onError: (error) => {
      // The composed stream reports error chunks and merge failures here. The
      // inner conversion's onEnd remains authoritative for normal producer
      // completion, including detached clients.
      const effectiveError = originalStreamError ?? error;
      streamErrorCaught = effectiveError;
      const detachedClientAbort =
        clientDisconnected && classifyError(effectiveError).category === "cancelled";
      if (!detachedClientAbort) {
        const didSettle = settleRun("failed");
        if (didSettle) logAiError(effectiveError);
      }
      return `${sanitizeStreamError(effectiveError)} [ref:${requestId}]`;
    },
  });

  let wrappedStream: ReadableStream<Uint8Array>;
  try {
    const response = createUIMessageStreamResponse({ stream });
    if (!response.body) {
      throw new Error("UI message stream response has no body");
    }
    wrappedStream = await resumableContext.run(streamId, () => response.body!);
    // The row exists from here on: `run` awaits the store's acquire before it
    // returns. The official contract knows nothing about conversations, so bind
    // the run's own metadata now — server-side history finalization may be the
    // only writer, and it must not depend on a process-local registry that a
    // restart would empty. With no conversation in the request there is no
    // history target, so the row stays unbound and finalization skips explicitly.
    if (threadId) {
      chatStreamStore.bindRunContext(streamId, {
        conversationId: threadId,
        requestId,
        providerId: provider.id,
        modelId: modelConfig.model,
      });
    }
  } catch (error) {
    const didSettle = settleRun("failed");
    if (didSettle) logAiError(error);
    throw error;
  }

  // ── Diagnostic: true response-closed ───────────────────────────────────
  // Monitor the response body stream to detect when the client has consumed
  // all bytes (natural drain) or when the connection drops (error/cancel).
  // This replaces the previous premature log that fired before any bytes
  // were actually sent.
  let responseBytesSent = 0;
  let monitorCancelled = false;
  const sourceReader = wrappedStream.getReader();
  const monitorStream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await sourceReader.read();
        if (done) {
          sourceReader.releaseLock();
          controller.close();
          // The producer outcome is authoritative. A response drain is only a
          // transport observation; it must never turn an error/unknown stream
          // into a successful run.
          chatLog.info("chat", "chat_response_closed", {
            closedBy: "drain",
            elapsedMs: Date.now() - chatStartedAt,
            streamId,
            runStatus: chatRuns.get(streamId)?.status ?? "unknown",
            chunkCount,
            responseBytesSent,
            hadError: runHadError(),
          });
          return;
        }
        responseBytesSent += value.byteLength;
        controller.enqueue(value);
      } catch (err) {
        sourceReader.releaseLock();
        if (!monitorCancelled) {
          // Observation died, not necessarily the run: mark detached so the
          // run continues and remains resumable.
          if (chatRuns.markDetached(streamId)) {
            chatLog.warn("ai", "ai.run_detached", {
              streamId,
              threadId,
              reason: "read-error",
              elapsedMs: Date.now() - chatStartedAt,
              chunkCount,
              responseBytesSent,
            });
          }
          chatLog.warn("chat", "chat_response_closed", {
            closedBy: "error",
            elapsedMs: Date.now() - chatStartedAt,
            streamId,
            runStatus: chatRuns.get(streamId)?.status ?? "unknown",
            chunkCount,
            responseBytesSent,
            hadError: runHadError(),
            errorType: err instanceof Error ? err.name : typeof err,
          });
        }
        controller.error(err);
      }
    },
    cancel() {
      monitorCancelled = true;
      clientDisconnected = true;
      sourceReader.cancel().catch(() => {});
      sourceReader.releaseLock();
      // The connection is gone but the run may be alive: detach (don't kill).
      // An explicit cancel arriving via POST /api/chat/cancel/:streamId will
      // transition a still-running run to cancelled; both lines then appear,
      // truthfully, in causal order.
      if (chatRuns.markDetached(streamId)) {
        chatLog.warn("ai", "ai.run_detached", {
          streamId,
          threadId,
          reason: "connection-closed",
          elapsedMs: Date.now() - chatStartedAt,
          chunkCount,
          responseBytesSent,
        });
      }
      chatLog.warn("chat", "chat_response_closed", {
        closedBy: "cancel",
        elapsedMs: Date.now() - chatStartedAt,
        streamId,
        runStatus: chatRuns.get(streamId)?.status ?? "unknown",
        chunkCount,
        responseBytesSent,
        hadError: runHadError(),
      });
    },
  });

  return new Response(monitorStream, {
    headers: {
      ...UI_MESSAGE_STREAM_HEADERS,
      [RESUMABLE_STREAM_ID_HEADER]: streamId,
    },
  });
});

// Resume endpoint: replays persisted bytes for reconnecting clients.
// Protocol unchanged: unknown/expired streams 404, and the mount auto-resume
// flow works exactly as before. Attaching clears a detached mark so lifecycle
// queries stay truthful.
//
// What IS added is observability, not behaviour (design §11/§12): the durable row
// is read so the resume records WHY a client came back — a live producer, a
// finished run, a run the app restarted through — as scalars only. The response
// is byte-for-byte what it was before, and the client learns the reason from the
// replayed bytes exactly as it does today.
app.get("/api/chat/resume/:streamId", async (c) => {
  disableIdleTimeout(c);
  const streamId = c.req.param("streamId");
  const requestId = (c.get("requestId") as string | undefined) ?? newRequestId();
  chatRuns.attach(streamId);
  chatRuns.sweep();
  const logResume = (outcome: "replayed" | "missing" | "unavailable", startedAt: number): void => {
    const description = chatStreamStore.describe(streamId);
    logger.info("ai", "ai.resume", {
      streamId,
      requestId,
      outcome,
      // The run axis and the byte-stream axis are reported separately: a resumed
      // client must be able to tell a finished run from a dead one.
      status: description?.status ?? "missing",
      terminalKind: description?.terminalKind ?? null,
      chunkCount: description?.chunkCount ?? 0,
      byteLen: description?.byteLength ?? 0,
      // The signal that separates "the app restarted" from "the network blipped":
      // the row records the boot that created it, so a foreign boot means the
      // producer this client was watching cannot still be alive.
      restarted: description?.fromForeignBoot ?? false,
      ageMs: description ? Math.max(0, Date.now() - description.createdAt) : null,
      elapsedMs: Date.now() - startedAt,
    });
  };
  const startedAt = Date.now();
  try {
    const stream = await resumableContext.resume(streamId);
    if (!stream) {
      logResume("missing", startedAt);
      return c.json({ error: "stream not found", requestId }, 404);
    }
    logResume("replayed", startedAt);
    return new Response(stream, {
      headers: {
        ...UI_MESSAGE_STREAM_HEADERS,
        [RESUMABLE_STREAM_ID_HEADER]: streamId,
      },
    });
  } catch (error) {
    logResume("unavailable", startedAt);
    if (error instanceof ResumableStreamError) {
      return c.json({ error: "stream unavailable" }, 404);
    }
    return c.json({ error: "stream unavailable" }, 500);
  }
});

// Durable stream status: a read-only projection of the `chat_streams` row.
//
// WHY this exists, in the shape it takes. The design (§12) wanted the client to
// tell a restart apart from a network blip and to confirm a run is safe to retry,
// "without a new client protocol branch beyond reading the existing error path".
// That is not possible with the installed AI SDK: `makeRequest` never rejects
// (`ai/dist/index.js:19120-19320` swallows a failed reconnect at :19176 and an
// errored replayed stream at :19273), so `onResumeError` is unreachable and the
// error path cannot carry the durable reason.
//
// The first attempt then keyed recovery on the transport's resumable-stream
// pointer, and a live run against a real provider showed why that cannot work:
// the pointer is transport-owned, the transport clears it when a send fails
// (BEFORE the failure is reported), and it does not survive an app restart. A
// client that can only ask "what is stream X?" with an id it may have lost
// cannot recognise a dead run at all — observed live as a crash that produced no
// recovery state whatsoever.
//
// So the client asks about something it always has: the CONVERSATION. The server
// already binds `conversation_id` to every run, so "what became of the last thing
// I asked in this conversation?" is answerable durably, with no client-held state
// at all. `?streamId=` remains for callers that already hold one.
//
// This reads the same row the resume protocol replays and exposes safe scalars
// only — never chunk bytes, never provider text, never the prompt. It changes
// nothing the resume contract promises, and a client that cannot reach it must
// treat the terminal state as unconfirmed and offer no Retry.
type StreamStatusBody = {
  streamId: string;
  status: "streaming" | "done" | "error" | "missing";
  terminalKind: "completed" | "failed" | "cancelled" | "interrupted" | null;
  restarted: boolean;
  historyState: "pending" | "claimed" | "done" | "skipped" | null;
  chunkCount: number;
  byteLen: number;
  ageMs: number;
  finalizedAgeMs: number | null;
};

function projectStreamStatus(
  description: NonNullable<ReturnType<typeof chatStreamStore.describe>>,
): StreamStatusBody {
  const now = Date.now();
  return {
    streamId: description.streamId,
    status: description.status,
    terminalKind: description.terminalKind,
    // The boot that created the row is the signal that separates "the app
    // restarted" from "the network blipped" (design §12).
    restarted: description.fromForeignBoot,
    historyState: chatStreamStore.getRunContext(description.streamId)?.historyState ?? null,
    chunkCount: description.chunkCount,
    byteLen: description.byteLength,
    ageMs: Math.max(0, now - description.createdAt),
    finalizedAgeMs:
      description.finalizedAt === null ? null : Math.max(0, now - description.finalizedAt),
  };
}

app.get("/api/chat/stream-status", (c) => {
  disableIdleTimeout(c);
  const requestId = (c.get("requestId") as string | undefined) ?? newRequestId();
  const parsed = streamStatusQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "streamId or conversationId required", requestId }, 400);
  }
  const { streamId, conversationId } = parsed.data;

  let description: ReturnType<typeof chatStreamStore.describe>;
  try {
    description = streamId
      ? chatStreamStore.describe(streamId)
      : chatStreamStore.describeLatestForConversation(conversationId!);
  } catch (error) {
    if (error instanceof ResumableStreamError) {
      return c.json({ error: "invalid stream id", requestId }, 400);
    }
    logger.error("chat", "chat_stream_status_failed", {
      requestId,
      ...(streamId ? { streamId } : { conversationId }),
      ...errorLogFields(error),
    });
    return c.json({ error: "stream status unavailable", requestId }, 500);
  }

  // A conversation with no run is NOT an error: it is the normal state of a
  // thread that has never been answered, and a client must be able to tell that
  // apart from a run it failed to read.
  if (!description) {
    logger.debug("chat", "chat_stream_status", {
      requestId,
      ...(streamId ? { streamId } : { conversationId }),
      found: false,
    });
    return c.json({ run: null, requestId }, 200);
  }
  const run = projectStreamStatus(description);
  // Scalars only — never chunk bytes, provider text, or the prompt.
  logger.debug("chat", "chat_stream_status", {
    requestId,
    ...(streamId ? { streamId } : { conversationId }),
    found: true,
    resolvedStreamId: run.streamId,
    status: run.status,
    terminalKind: run.terminalKind,
    restarted: run.restarted,
    historyState: run.historyState,
    ageMs: run.ageMs,
  });
  return c.json({ run, requestId }, 200);
});

// Explicit user-cancel path: the ONLY way to stop a server-owned run.
// Browser aborts alone merely detach (see monitor cancel above); without this
// call a stopped run would burn tokens until the wall clock kills it.
// Settles synchronously (mark → log → abort) so a repeated cancel observes
// `cancelled` and reports a terminal no-op; onAbort then no-ops via its
// status guard instead of racing the API response.
app.post("/api/chat/cancel/:streamId", (c) => {
  const streamId = c.req.param("streamId");
  const requestId = (c.get("requestId") as string | undefined) ?? newRequestId();
  const rec = chatRuns.get(streamId);
  if (!rec) {
    return c.json({ error: "run not found", requestId }, 404);
  }
  chatRuns.sweep();
  if (rec.status !== "running") {
    return c.json({ ok: true, cancelled: false, status: rec.status });
  }
  // The wall-clock timer marks `timedOut` before aborting. If a cancel request
  // wins the synchronous transition race after that marker, preserve the
  // timeout outcome instead of reporting a user cancellation.
  const timedOut = rec.timedOut;
  const settled = timedOut
    ? chatRuns.markFailed(streamId)
    : chatRuns.markCancelled(streamId);
  if (!settled) {
    const cur = chatRuns.get(streamId);
    return c.json({ ok: true, cancelled: false, status: cur?.status ?? rec.status });
  }
  // Funnel-owned lifecycle line (the single terminal transition emission —
  // onAbort no-ops below once the record is terminal).
  if (timedOut) {
    logger.error("ai", "ai.error", {
      category: "timeout",
      streamId,
      requestId,
      ...(rec.conversationId ? { conversationId: rec.conversationId } : {}),
      ...(rec.providerId ? { providerId: rec.providerId } : {}),
      ...(rec.modelId ? { modelId: rec.modelId } : {}),
      elapsedMs: Date.now() - rec.createdAt,
    });
  } else {
    logger.warn("ai", "ai.error", {
      category: "cancelled",
      streamId,
      requestId,
      ...(rec.conversationId ? { conversationId: rec.conversationId } : {}),
      ...(rec.providerId ? { providerId: rec.providerId } : {}),
      ...(rec.modelId ? { modelId: rec.modelId } : {}),
      elapsedMs: Date.now() - rec.createdAt,
    });
  }
  try {
    rec.controller.abort();
  } catch {
    /* abort is best-effort; the record is already terminal */
  }
  // Mirror the terminal verdict durably. `onAbort` cannot do this: the cancel
  // endpoint settles the run first, so the abort handler sees a terminal record
  // and no-ops.
  mirrorRunToDurableStream(streamId, timedOut ? "failed" : "cancelled", {
    log: logger,
    providerType: rec.providerId,
    runStatus: rec.status,
  });
  return c.json({ ok: true, cancelled: !timedOut, status: rec.status });
});

export default app;
