import { Hono } from "hono";
import { logger, newRequestId, normalizeError } from "../lib/logger";
import { generateId } from "../lib/utils";
import { getModel } from "../services/ai";
import { buildReasoningProviderOptions } from "./chat-provider-options";
import { credentialStore } from "../services/credentials";
import { redact, sanitizeStreamError } from "../lib/redact";
import { classifyError } from "../lib/errors";
import { sanitizeAiRequest, aiDebugRequestsEnabled } from "../lib/ai-diagnostics";
import { prepareModelMessages } from "../lib/model-messages";
import { streamText, convertToModelMessages, stepCountIs, type UIMessage, UI_MESSAGE_STREAM_HEADERS, createUIMessageStream, createUIMessageStreamResponse, toUIMessageStream } from "ai";
import { mcpManager } from "../services/mcp/manager";
import { aiToolkit, withThreadContext } from "../tools";
import { createTerminalBatcher } from "../lib/terminal-stream";
import { resumableContext } from "../lib/resumable";
import { createProgressTracker } from "../lib/progress-tracker";
import type { ProgressData } from "../lib/progress-stages";
import { RESUMABLE_STREAM_ID_HEADER, ResumableStreamError } from "assistant-stream/resumable";
import { chatRequestSchema } from "../lib/validation";
import { resolveChatModel, UnknownProviderError } from "./chat-model";
import { disableIdleTimeout } from "./shared";
import { chatRuns } from "../services/chat-runs";
import { conversationService } from "../services/storage";
import { resolveConversationWorkspace, WorkspaceError } from "../services/workspace";

const app = new Hono<{ Variables: { requestId: string } }>();

// Chat streaming endpoint (AI SDK v7 UI-message stream consumed by @assistant-ui/react)
app.post("/api/chat", async (c) => {
  // Model stalls (thinking, tools, approvals) must never kill the stream.
  disableIdleTimeout(c);
  const parsed = chatRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid request",
        issues: parsed.error.issues,
        requestId: (c.get("requestId") as string | undefined),
      },
      400,
    );
  }

  const { providerId, model, reasoningLevel: reasoningOverride, messages } = parsed.data;
  const requestId = (c.get("requestId") as string | undefined) ?? newRequestId();
  const threadId = (parsed.data as { id?: string }).id;
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
  let effectiveModel = resolved.model;
  let effectiveReasoning = resolved.reasoning;

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

  // Row-authoritative engine guard: a persisted OpenCode row must never be
  // served as Direct (the Code surface owns it). Rejected before run
  // creation so no run record is minted for a refused request. Missing rows
  // and ad-hoc (rowless) sends fall through to the existing workspace path
  // unchanged. Code "ENGINE_MISMATCH" is canonical in EngineMismatchError
  // (services/opencode/sessions.ts) — cited here, not redefined, to respect
  // the OpenCode isolation boundary.
  if (threadId) {
    const conversation = await conversationService.get(threadId);
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
  }

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

  const languageModel = getModel(modelConfig);
  const reasoning = effectiveReasoning ?? provider.thinking ?? "off";
  // Every provider quirk that decides whether reasoning is returned at all
  // lives in that module — see it for why each option is shaped the way it is.
  const providerOptions = buildReasoningProviderOptions(
    provider,
    modelConfig.model,
    reasoning,
  );

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

  let tools: Record<string, any>;
  let modelMessages: Awaited<ReturnType<typeof prepareModelMessages>>;
  try {
    tools = withThreadContext(
      {
        ...(await aiToolkit.tools()),
        // Tool calls share the run's lifetime (survive client disconnect like
        // the model call); explicit cancel aborts them via the run controller.
        ...mcpManager.getAiTools(run.controller.signal),
      },
      threadId,
      (toolCallId, event) => terminalBatcher.push(toolCallId, event),
      workspaceDir,
      // Scheduler creates inherit the current provider/model when the model
      // omits them (it cannot guess provider cuid values).
      { providerId: provider.id, modelId: modelConfig.model },
    );
    modelMessages = await prepareModelMessages(
      messages as unknown as UIMessage[],
      tools,
      { threadId },
    );
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
    endpoint: provider.endpoint || "default",
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
        endpoint: provider.endpoint || "default",
        protocol: (modelConfig as { apiProtocol?: string }).apiProtocol || "default",
        streamRetries: 0,
        abortSignalAborted: c.req.raw.signal.aborted,
        elapsedMs: Date.now() - chatStartedAt,
      });

      const result = streamText({
        model: languageModel,
        messages: modelMessages,
        tools,
        stopWhen: stepCountIs(20),
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
        onFinish: ({ finishReason, usage }) => {
          chatRuns.markCompleted(streamId);
          chatLog.info("ai", "ai.response", {
            streamId,
            message: `finishReason=${finishReason}`,
            durationMs: Date.now() - chatStartedAt,
            chunkCount,
            ...(usage ? { totalTokens: (usage as { totalTokens?: number }).totalTokens } : {}),
          });
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
            chatRuns.markFailed(streamId);
            chatLog.error("ai", "ai.error", {
              category: "timeout",
              streamId,
              elapsedMs,
              firstChunkArrived: firstChunkAt !== null,
              chunkCount,
            });
          } else {
            chatRuns.markCancelled(streamId);
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
        onError: (error) => {
          originalStreamError = error;
          // Logged once by the outer onError below (ai.error); no duplicate here.
          return sanitizeStreamError(error);
        },
        messageMetadata: () => ({
          custom: {
            providerId: provider.id,
            modelId: modelConfig.model,
            reasoningLevel: reasoning,
          },
        }),
      }));
    },
    generateId: () => generateId(),
    // ── Diagnostic: stream failed ─────────────────────────────────────────
    onError: (error) => {
      // Prefer the original provider error (preserves 429, auth, etc.) over
      // the wrapped generic error from the AI SDK stream pipeline.
      const effectiveError = originalStreamError ?? error;
      streamErrorCaught = effectiveError;
      chatRuns.markFailed(streamId);
      const elapsedMs = Date.now() - chatStartedAt;
      chatLog.error("ai", "ai.error", {
        streamId,
        provider: provider.type,
        model: modelConfig.model,
        elapsedMs,
        firstChunkArrived: firstChunkAt !== null,
        firstChunkElapsedMs: firstChunkAt !== null ? firstChunkAt - chatStartedAt : null,
        abortSignalAborted: c.req.raw.signal.aborted,
        chunkCount,
        ...classifyError(effectiveError),
      });
      return `${sanitizeStreamError(effectiveError)} [ref:${requestId}]`;
    },
  });

  const response = createUIMessageStreamResponse({ stream });
  if (!response.body) {
    throw new Error("UI message stream response has no body");
  }
  const wrappedStream = await resumableContext.run(streamId, () => response.body!);

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
          // Backstop: onFinish normally settles the record first; this covers
          // streams that drain without it. Idempotent by design.
          chatRuns.markCompleted(streamId);
          chatLog.info("chat", "chat_response_closed", {
            closedBy: "drain",
            elapsedMs: Date.now() - chatStartedAt,
            streamId,
            chunkCount,
            responseBytesSent,
            hadError: streamErrorCaught !== null,
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
            chunkCount,
            responseBytesSent,
            hadError: streamErrorCaught !== null,
            ...(normalizeError(err)),
          });
        }
        controller.error(err);
      }
    },
    cancel() {
      monitorCancelled = true;
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
        chunkCount,
        responseBytesSent,
        hadError: streamErrorCaught !== null,
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
app.get("/api/chat/resume/:streamId", async (c) => {
  disableIdleTimeout(c);
  const streamId = c.req.param("streamId");
  chatRuns.attach(streamId);
  chatRuns.sweep();
  try {
    const stream = await resumableContext.resume(streamId);
    if (!stream) {
      return c.json(
        { error: "stream not found", requestId: (c.get("requestId") as string | undefined) },
        404,
      );
    }
    return new Response(stream, {
      headers: {
        ...UI_MESSAGE_STREAM_HEADERS,
        [RESUMABLE_STREAM_ID_HEADER]: streamId,
      },
    });
  } catch (error) {
    if (error instanceof ResumableStreamError) {
      return c.json({ error: "stream unavailable" }, 404);
    }
    return c.json({ error: "stream unavailable" }, 500);
  }
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
  // Synchronous terminal transition first: only the first cancel wins.
  const settled = chatRuns.markCancelled(streamId);
  if (!settled) {
    const cur = chatRuns.get(streamId);
    return c.json({ ok: true, cancelled: false, status: cur?.status ?? rec.status });
  }
  // Funnel-owned lifecycle line (the single cancellation emission — onAbort
  // no-ops below once the record is terminal).
  logger.warn("ai", "ai.error", {
    category: "cancelled",
    streamId,
    requestId,
    ...(rec.conversationId ? { conversationId: rec.conversationId } : {}),
    ...(rec.providerId ? { providerId: rec.providerId } : {}),
    ...(rec.modelId ? { modelId: rec.modelId } : {}),
    elapsedMs: Date.now() - rec.createdAt,
  });
  try {
    rec.controller.abort();
  } catch {
    /* abort is best-effort; the record is already terminal */
  }
  return c.json({ ok: true, cancelled: true, status: rec.status });
});

export default app;
