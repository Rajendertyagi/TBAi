import { Hono } from "hono";
import { z } from "zod";
import { logger, newRequestId, normalizeError } from "../lib/logger";
import { generateId } from "../lib/utils";
import { getModel } from "../services/ai";
import { registry } from "../config/providers";
import { credentialStore } from "../services/credentials";
import { redact, sanitizeStreamError, logStreamDiagnostic } from "../lib/redact";
import { sanitizeAiRequest, aiDebugRequestsEnabled } from "../lib/ai-diagnostics";
import { prepareModelMessages } from "../lib/model-messages";
import { streamText, convertToModelMessages, stepCountIs, tool, type UIMessage, UI_MESSAGE_STREAM_HEADERS, createUIMessageStream, createUIMessageStreamResponse, toUIMessageStream } from "ai";
import { runRead, runWrite, runEdit, runBash, runList, runSearch, runStat, runDelete, runProcesses, runKill, runSysinfo } from "../services/tools";
import { mcpManager } from "../services/mcp/manager";
import { resumableContext } from "../lib/resumable";
import { createProgressTracker } from "../lib/progress-tracker";
import type { ProgressData } from "../lib/progress-stages";
import { RESUMABLE_STREAM_ID_HEADER, ResumableStreamError } from "assistant-stream/resumable";
import { chatRequestSchema, toolReadSchema, toolWriteSchema, toolEditSchema, toolBashSchema, toolListSchema, toolSearchSchema, toolStatSchema, toolDeleteSchema, toolKillSchema } from "../lib/validation";

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

  const { providerId, model, messages } = parsed.data;
  const requestId = (c.get("requestId") as string | undefined) ?? newRequestId();
  const provider = (providerId && registry.get(providerId)) || registry.getActive();

  if (!provider) {
    return c.json({ error: "No provider configured", requestId }, 400);
  }

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
  if (model) {
    modelConfig = { ...modelConfig, model };
  }

  const languageModel = getModel(modelConfig);
  const isLite = /lite|nano/i.test(modelConfig.model || "");
  const thinking = provider.thinking ?? "off";

  // Reasoning/thinking budget per provider. "off" (default) sends no thinking
  // options; other levels map to provider-specific controls. Lite/nano models
  // skip thinking entirely (unsupported).
  const providerOptions: Record<string, any> = {};
  if (!isLite && thinking !== "off") {
    if (provider.type === "google") {
      const budget = { low: 1024, medium: 4096, high: 8192 }[thinking] ?? 4096;
      providerOptions.google = { thinkingConfig: { thinkingBudget: budget } };
    } else if (provider.type === "anthropic") {
      const budget = { low: 1024, medium: 4096, high: 8192 }[thinking] ?? 4096;
      providerOptions.anthropic = { thinking: { type: "enabled", budgetTokens: budget } };
    } else if (provider.type === "openai" || provider.type === "custom") {
      const effort = { low: "low", medium: "medium", high: "high" }[thinking] ?? "medium";
      providerOptions.openai = { reasoningEffort: effort };
    }
  }

  // Native tools: real server-executed tool() definitions (toolkit architecture).
  // Read-only tools run immediately; dangerous tools pause at a server-side
  // approval gate (toolApproval) that the toolkit UI answers via
  // respondToApproval(). Execution stays in services/tools.ts (sandboxed).
  const tools = { ...nativeTools, ...mcpManager.getAiTools(c.req.raw.signal) };
  // Single production history path: lifecycle-aware pruning (approval
  // decisions preserved until the conversation moves past them; duplicates,
  // stale calls, and empty turns repaired) → convertToModelMessages. The
  // integration tests exercise this exact function (see model-messages.ts).
  const threadId = (parsed.data as { id?: string }).id;
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
  const result = streamText({
    model: languageModel,
    messages: modelMessages,
    tools,
    // Official multi-step cap: after a tool executes, the result feeds back
    // into the model for a continued answer (bounded so loops can't run away).
    stopWhen: stepCountIs(20),
    // Server-side approval gates for privileged native tools. The client
    // toolkit renders the approval card and answers; the model continues
    // automatically after the decision (see web/src/runtime.ts).
    toolApproval: {
      write_file: "user-approval",
      edit_file: "user-approval",
      delete_file: "user-approval",
      run_command: "user-approval",
      process_kill: "user-approval",
    },
    // Abort propagation: client Stop → fetch abort → request signal →
    // streamText → provider + in-flight MCP tool calls all cancel.
    abortSignal: c.req.raw.signal,
    onFinish: ({ finishReason, usage }) => {
      chatLog.info("chat", "stream_finished", {
        message: `finishReason=${finishReason}`,
        durationMs: Date.now() - chatStartedAt,
        ...(usage ? { totalTokens: (usage as { totalTokens?: number }).totalTokens } : {}),
      });
    },
    onAbort: () => {
      chatLog.info("chat", "stream_aborted", { durationMs: Date.now() - chatStartedAt });
    },
    ...(Object.keys(providerOptions).length ? { providerOptions } : {}),
  });

  // Official resumable-stream wiring: the first caller produces; reconnects
  // replay persisted bytes via GET /api/chat/resume/:streamId.
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

      writer.merge(toUIMessageStream({ stream: result.stream }));
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

// Native tools: real server-executed tool() definitions (toolkit architecture).
// The model-facing contract (description + zod input schema) and execution
// live here together; the client toolkit (web/src/tools/toolkit.ts) holds the
// matching render-only entries. Dangerous tools pause at the toolApproval gate
// in the chat route below. Outputs are plain JSON (outputSchema unknown).
const nativeTools = {
  read_file: tool({
    description:
      "Read a text file from the workspace. Returns the file content. Runs without approval.",
    inputSchema: toolReadSchema,
    outputSchema: z.unknown(),
    execute: async (args) => timedNativeTool("read_file", () => runRead(args)),
  }),
  write_file: tool({
    description:
      "Write or create a text file in the workspace. Requires user approval before executing.",
    inputSchema: toolWriteSchema,
    outputSchema: z.unknown(),
    execute: async (args) => timedNativeTool("write_file", () => runWrite(args)),
  }),
  edit_file: tool({
    description:
      "Replace text in a workspace file. Requires user approval before executing.",
    inputSchema: toolEditSchema,
    outputSchema: z.unknown(),
    execute: async (args) => timedNativeTool("edit_file", () => runEdit(args)),
  }),
  run_command: tool({
    description:
      "Run a shell command inside the workspace. Requires user approval before executing.",
    inputSchema: toolBashSchema,
    outputSchema: z.unknown(),
    execute: async (args) => timedNativeTool("run_command", () => runBash(args)),
  }),
  list_dir: tool({
    description:
      "List files and folders inside the workspace. Runs without approval.",
    inputSchema: toolListSchema,
    outputSchema: z.unknown(),
    execute: async (args) => timedNativeTool("list_dir", () => runList(args)),
  }),
  search_files: tool({
    description:
      "Search file contents inside the workspace (case-insensitive). Runs without approval.",
    inputSchema: toolSearchSchema,
    outputSchema: z.unknown(),
    execute: async (args) => timedNativeTool("search_files", () => runSearch(args)),
  }),
  file_info: tool({
    description:
      "Show size, type and timestamps for a workspace path. Runs without approval.",
    inputSchema: toolStatSchema,
    outputSchema: z.unknown(),
    execute: async (args) => timedNativeTool("file_info", () => runStat(args)),
  }),
  delete_file: tool({
    description:
      "Delete a file or folder inside the workspace. Requires user approval before executing.",
    inputSchema: toolDeleteSchema,
    outputSchema: z.unknown(),
    execute: async (args) => timedNativeTool("delete_file", () => runDelete(args)),
  }),
  process_list: tool({
    description:
      "List running processes on this computer (pid, name, CPU, memory). Runs without approval.",
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    execute: async () => timedNativeTool("process_list", () => runProcesses()),
  }),
  process_kill: tool({
    description:
      "Stop a running process by pid. Requires user approval before executing. Cannot kill the app itself or system processes.",
    inputSchema: toolKillSchema,
    outputSchema: z.unknown(),
    execute: async (args) => timedNativeTool("process_kill", () => runKill(args)),
  }),
  system_info: tool({
    description:
      "Show computer info: OS, CPU, memory and uptime. Runs without approval.",
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    execute: async () => timedNativeTool("system_info", () => runSysinfo()),
  }),
};

/** Time native tool executions for diagnostics (failures surface via streamText). */
async function timedNativeTool<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const started = Date.now();
  logger.debug("tools", "tool_execution_started", { tool: name });
  try {
    const out = await fn();
    logger.debug("tools", "tool_execution_completed", {
      tool: name,
      durationMs: Date.now() - started,
    });
    return out;
  } catch (err) {
    logger.warn("tools", "execution_failed", {
      tool: name,
      durationMs: Date.now() - started,
      ...normalizeError(err),
    });
    throw err;
  }
}

export default app;
