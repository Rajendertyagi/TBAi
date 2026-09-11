import { Hono } from "hono";
import { logger, newRequestId, normalizeError } from "../lib/logger";
import { generateId } from "../lib/utils";
import { getModel } from "../services/ai";
import { credentialStore } from "../services/credentials";
import { redact, sanitizeStreamError, logStreamDiagnostic } from "../lib/redact";
import { sanitizeAiRequest, aiDebugRequestsEnabled } from "../lib/ai-diagnostics";
import { prepareModelMessages } from "../lib/model-messages";
import { streamText, convertToModelMessages, stepCountIs, type UIMessage, UI_MESSAGE_STREAM_HEADERS, createUIMessageStream, createUIMessageStreamResponse, toUIMessageStream } from "ai";
import { mcpManager } from "../services/mcp/manager";
import { aiToolkit } from "../tools";
import { resumableContext } from "../lib/resumable";
import { createProgressTracker } from "../lib/progress-tracker";
import type { ProgressData } from "../lib/progress-stages";
import { RESUMABLE_STREAM_ID_HEADER, ResumableStreamError } from "assistant-stream/resumable";
import { chatRequestSchema } from "../lib/validation";
import { resolveChatModel } from "./chat-model";

const app = new Hono<{ Variables: { requestId: string } }>();

// Chat streaming endpoint (AI SDK v7 UI-message stream consumed by @assistant-ui/react)
app.post("/api/chat", async (c) => {
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
  // Resolve the effective model + reasoning level. The client sends the
  // conversation default (projected from SQLite) merged with any one-shot
  // override. When a field is absent, fall back to the conversation's
  // persisted defaults (source of truth) so a missing header never silently
  // drops the user's chosen config. (src/routes/chat-model.ts)
  const threadId = (parsed.data as { id?: string }).id;
  const resolved = await resolveChatModel({
    providerId,
    model,
    reasoningLevel: reasoningOverride,
    threadId,
  });
  if (!resolved) {
    return c.json({ error: "No provider configured", requestId }, 400);
  }
  const provider = resolved.provider;
  let effectiveModel = resolved.model;
  let effectiveReasoning = resolved.reasoning;

  // Ollama needs no API key; all other providers require an encrypted credential
  // that is decrypted here, in the backend only, and never returned to the client.
  const needsKey = provider.type !== "ollama";
  let modelConfig = provider;
  if (needsKey) {
    if (!credentialStore.has(provider.id)) {
      return c.json({ error: "No API key configured for this provider.", requestId }, 400);
    }
    const apiKey = credentialStore.get(provider.id);
    modelConfig = { ...provider, apiKey };
  }
  // A session-selected model (chat-header picker) overrides the saved default
  // for this request only; it never writes back to provider.model here.
  if (effectiveModel) {
    modelConfig = { ...modelConfig, model: effectiveModel };
  }

  const languageModel = getModel(modelConfig);
  const isLite = /lite|nano/i.test(modelConfig.model || "");
  // Per-request reasoning override (one-shot picker selection) wins; the
  // saved provider default or conversation default applies otherwise.
  // Never persisted back.
  const reasoning = effectiveReasoning ?? provider.thinking ?? "off";

  // Reasoning/thinking budget per provider. "off" (default) sends no thinking
  // options; other levels map to provider-specific controls. Lite/nano models
  // skip thinking entirely (unsupported).
  const providerOptions: Record<string, any> = {};
  if (!isLite && reasoning !== "off") {
    if (provider.type === "google") {
      const budget = { low: 1024, medium: 4096, high: 8192 }[reasoning] ?? 4096;
      providerOptions.google = { thinkingConfig: { thinkingBudget: budget } };
    } else if (provider.type === "anthropic") {
      const budget = { low: 1024, medium: 4096, high: 8192 }[reasoning] ?? 4096;
      providerOptions.anthropic = { thinking: { type: "enabled", budgetTokens: budget } };
    } else if (provider.type === "openai" || provider.type === "custom") {
      const effort = { low: "low", medium: "medium", high: "high" }[reasoning] ?? "medium";
      providerOptions.openai = { reasoningEffort: effort };
    }
  }

  // Native tools: the assistant-ui AISDKToolkit (toolkit architecture). The
  // model-facing contract (description + JSON-schema parameters) and execution
  // live together in src/tools/index.ts; the client toolkit holds matching
  // render-only entries. Dangerous tools pause at the server-side toolApproval
  // gate (below) that the toolkit UI answers via respondToApproval(). MCP tools
  // are merged in from the manager (they are not part of the static toolkit).
  const tools = {
    ...(await aiToolkit.tools()),
    ...mcpManager.getAiTools(c.req.raw.signal),
  };
  // Single production history path: lifecycle-aware pruning (approval
  // decisions preserved until the conversation moves past them; duplicates,
  // stale calls, and empty turns repaired) → convertToModelMessages. The
  // integration tests exercise this exact function (see model-messages.ts).
  const modelMessages = await prepareModelMessages(
    messages as unknown as UIMessage[],
    tools,
    { threadId },
  );
  const chatLog = logger.child({ requestId, provider: provider.type, model: modelConfig.model });
  const chatStartedAt = Date.now();
  chatLog.info("chat", "chat_started", {
    provider: provider.type,
    model: modelConfig.model,
    reasoningLevel: reasoning,
    threadId,
    message: `messages=${messages.length} tools=${Object.keys(tools).length}`,
  });
  // Optional sanitized diagnostics (AI_DEBUG_REQUESTS=true): structural shape
  // of the outbound model request — roles, part types, tool names/schemas,
  // signature presence — never raw text, credentials, or replay tokens.
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
  // Official resumable-stream wiring: the first caller produces; reconnects
  // replay persisted bytes via GET /api/chat/resume/:streamId.
  // NOTE: there is exactly ONE streamText call per chat request, inside
  // execute() below. Never add a second one here: streamText starts the
  // provider request on creation, so an unconsumed call would double-fire
  // (double cost, double tool execution) with its output discarded.
  const streamId = crypto.randomUUID();
  const progress = createProgressTracker();

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Emit initial empty progress snapshot so the UI has something to render.
      writer.write({
        type: "data-tbai-progress",
        id: "progress",
        data: { kind: "tbai-progress" as const, version: 1 as const, stages: [] },
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
        },
        abortSignal: c.req.raw.signal,
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
        },
        onFinish: ({ finishReason, usage }) => {
          chatLog.info("chat", "stream_finished", {
            message: `finishReason=${finishReason}`,
            durationMs: Date.now() - chatStartedAt,
            ...(usage ? { totalTokens: (usage as { totalTokens?: number }).totalTokens } : {}),
          });
          // Final persisted progress snapshot (non-transient).
          const finalProgress = progress.onFinish();
          writer.write({
            type: "data-tbai-progress",
            id: "progress",
            data: finalProgress,
          });
        },
        onAbort: () => {
          chatLog.info("chat", "stream_aborted", { durationMs: Date.now() - chatStartedAt });
          // Mark active stages as failed on abort.
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
        // Per-response provenance, persisted by the client alongside the
        // message and rendered in its footer: which provider/model/thinking
        // actually produced THIS response (one-shot picks vary per message).
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
    onError: (error) => {
      logStreamDiagnostic("chat", error);
      const norm = normalizeError(error);
      chatLog.error("ai.provider", "stream_error", {
        provider: provider.type,
        model: modelConfig.model,
        ...norm,
      });
      return `${sanitizeStreamError(error)} [ref:${requestId}]`;
    },
  });

  const response = createUIMessageStreamResponse({ stream });
  if (!response.body) {
    throw new Error("UI message stream response has no body");
  }
  const wrappedStream = await resumableContext.run(streamId, () => response.body!);

  return new Response(wrappedStream, {
    headers: {
      ...UI_MESSAGE_STREAM_HEADERS,
      [RESUMABLE_STREAM_ID_HEADER]: streamId,
    },
  });
});

// Resume endpoint: replays persisted bytes for reconnecting clients.
app.get("/api/chat/resume/:streamId", async (c) => {
  const streamId = c.req.param("streamId");
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
    logger.warn("chat", "resume_failed", {
      requestId: (c.get("requestId") as string | undefined),
      ...normalizeError(error),
    });
    return c.json({ error: "stream unavailable" }, 500);
  }
});

// Native tools are defined in src/tools/index.ts (assistant-ui AISDKToolkit)
// and consumed above via `aiToolkit.tools()`. Dangerous tools pause at the
// server-side toolApproval gate; the toolkit UI answers via respondToApproval().

export default app;
