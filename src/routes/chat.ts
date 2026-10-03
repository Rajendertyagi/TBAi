import { Hono } from "hono";
import { logger, newRequestId } from "../lib/logger";
import { generateId } from "../lib/utils";
import { getModel, resolveApiProtocol } from "../services/ai";
import { buildReasoningProviderOptions } from "./chat-provider-options";
import { credentialStore } from "../services/credentials";
import { sanitizeStreamError } from "../lib/redact";
import {
  classifyError,
  errorLogFields,
  providerErrorCodeFields,
} from "../lib/errors";
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
import {
  assembleContext,
  logAssembly,
  logContextOverflow,
  localMemoryProvider,
  memoryEnabled,
} from "../context";
import {
  buildCacheProviderOptions,
  computePrefixIdentity,
  describeCacheDecision,
  describeCacheObservation,
  describePrefixIdentity,
  observeSdkCacheUsage,
  resolveCacheCapability,
  type CacheCapability,
  type CacheControlDecision,
  type PrefixIdentity,
} from "../context/cache";
import { createTerminalBatcher } from "../lib/terminal-stream";
import { resumableContext, chatStreamStore } from "../lib/resumable";
import {
  chatHistoryFinalizerDeps,
  finalizeDetachedRunHistory,
  validateFinalMessage,
} from "../services/chat-streams/historyFinalizer";
import type { ChatStreamTerminalKind } from "../services/chat-streams/schema";
import { createProgressTracker } from "../lib/progress-tracker";
import type { ProgressData } from "../lib/progress-stages";
import { RESUMABLE_STREAM_ID_HEADER, ResumableStreamError } from "assistant-stream/resumable";
import { chatMessageMetadataSchema, chatRequestSchema } from "../lib/validation";
import { resolveChatModel, buildChatMessageMetadata, UnknownProviderError, type ChatContextState } from "./chat-model";
import {
  buildContextState,
  providerOccupancyFromStepUsage,
  resolveOccupancy,
  type OccupancyMeasurement,
} from "../context/occupancy";
import { decideOverflowRecovery } from "../context/recovery";
import { withOverflowRecovery, LIFECYCLE_PART_TYPES } from "./direct-overflow-gate";
import { disableIdleTimeout } from "./shared";
import { chatRuns } from "../services/chat-runs";
import { conversationService, messageService } from "../services/storage";
import { compactionStore } from "../services/compaction";
import {
  COMPACTION_SUMMARY_TIMEOUT_MS,
  DEFAULT_COMPACTION_POLICY,
  compactionEnabled,
} from "../context/compaction";
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
  //
  // Phase 2: this block is the SINGLE Direct context-assembly boundary. Layers
  // A/B/C, lifecycle repair, request-side reduction, measurement and the budget
  // all happen inside `assembleContext` (src/context/assemble.ts). Nothing here
  // assembles context, and nothing may bypass it - see docs/decisions.md
  // "ADR: Direct context assembly is a hybrid explicit seam (2026-10-01)".
  let tools: NativeToolSet & Record<string, any>;
  let toolsContext: NativeToolsContext;
  let modelMessages: Awaited<ReturnType<typeof prepareModelMessages>>;
  let assembled: Awaited<ReturnType<typeof assembleContext>>;

  /**
   * The provider's own count of the prompt for the MOST RECENT model call.
   *
   * `streamText`'s `totalUsage` is token TRAFFIC - it is built by summing every
   * step's usage - so it must never reach a context meter. A single step's
   * `inputTokens` is the opposite: the size of the prompt the provider was
   * actually asked to hold. The last step's value is therefore the measured
   * occupancy, and the direct equivalent of the `tokens.total` OpenCode reports
   * and OpenChamber's meter prefers.
   *
   * Written on every step, read once at `finish`. Proven against a real HTTP
   * round trip - see `src/context/occupancy.ts`.
   */
  let lastStepOccupancy: OccupancyMeasurement | undefined;

  /**
   * Flips the moment this request performs its ONE permitted overflow recovery.
   *
   * Never cleared within a request: that is the bound. An unbounded
   * compact-and-retry is a hang with extra steps, because a history that
   * compaction cannot shrink overflows again on every attempt.
   */
  let overflowRecoveryAttempted = false;

  /**
   * Per-attempt captured provider error. NOTHING is published from here.
   *
   * The gate decides which attempt survives, and only the surviving attempt's error is
   * published (see `publishFinalProviderError`). A discarded attempt's entry is simply
   * never read, which is why no "was this attempt discarded" flag is needed: the
   * publication decision belongs to the gate, not to the attempt.
   */
  const attemptErrors = new Map<number, unknown>();

/**
 * The CURRENT context state to hand the browser with this turn.
 *
 * This returns OCCUPANCY, never traffic. Two sources, in order of authority:
 *
 *  1. `lastStepOccupancy` - the provider's own count of the prompt for the last
 *     model call. A real measurement, and the equivalent of the `tokens.total`
 *     OpenCode reports.
 *  2. The local estimator - preventive only, used before any call has happened
 *     and for providers that report no usage.
 *
 * After a compaction the estimate is the post-compaction one and the next turn's
 * provider measurement follows it down, so the meter drops either way.
 *
 * Returns `undefined` when assembly has not happened (an early rejection) or when
 * neither source produced a usable number, so the meter keeps its previous
 * reading rather than inventing one.
 */
function contextStateForUi(): ChatContextState | undefined {
  if (assembled === undefined) return undefined;
  const provenance = assembled.context.provenance;
  const occupancy = resolveOccupancy({
    provider: lastStepOccupancy,
    estimatedTokens: provenance.estimate.estimatedTokens,
  });
  const state = buildContextState({
    occupancy,
    windowTokens: provenance.limit?.maxInputTokens,
    windowSource: provenance.limit?.source,
    usableInputTokens: provenance.budget.usableInputTokens,
  });
  if (state === undefined) return undefined;
  return {
    usedTokens: state.usedTokens,
    windowTokens: state.windowTokens,
    windowSource: state.windowSource,
    usableInputTokens: state.usableInputTokens,
    occupancyKind: state.measurement?.kind ?? "unknown",
    cachedInputTokens: state.measurement?.kind === "provider" ? state.measurement.cachedInputTokens : undefined,
  };
}
  // Phase 3 outputs. Declared here so the pre-flight rejection path can log the
  // cache capability of a request it refuses to send.
  let cacheCapability: CacheCapability | undefined;
  let cacheControl: CacheControlDecision | undefined;
  let cachePrefix: PrefixIdentity | undefined;
  /**
   * Assemble this request's context, and publish the derived per-request bindings.
   *
   * Extracted as a FUNCTION rather than left as an inline block because provider
   * overflow recovery must rebuild context through this same seam after compacting —
   * there is no second context path. Re-entering it is also what keeps the retry the
   * same logical request: same messages, same provider, same tools, same memory; only
   * the compaction outcome differs.
   *
   * `forceCompaction` distinguishes a recovery rebuild from an ordinary turn. A
   * provider rejected this request as oversized, so the local trigger — which is
   * derived from the estimate — has nothing to fire on; recovery has to state
   * explicitly that the size problem is real. It is the same flag the manual
   * `/compact` path uses, so recovery inherits the engine's structural rules (a safe,
   * worthwhile span must still exist) instead of bypassing them.
   */
  const assembleForRequest = async (options: { forceCompaction?: boolean } = {}): Promise<void> => {
  try {
    assembled = await assembleContext({
      forceCompaction: options.forceCompaction === true,
      conversationId: threadId,
      submittedMessages: messages,
      runId: run.streamId,
      provider: modelConfig,
      modelId: modelConfig.model,
      systemPrompt: conversation?.systemPrompt,
      terminalTap: (toolCallId, event) => terminalBatcher.push(toolCallId, event),
      // Tool calls share the run's lifetime (survive client disconnect like the
      // model call); explicit cancel aborts them via the run controller.
      toolSignal: run.controller.signal,
      // Phase 4. Present only when compaction is opted in AND the conversation is
      // persisted — an unwired seam cannot compact by accident, and a conversation
      // with no durable store has nowhere to record a compaction.
      compaction:
        compactionEnabled() && threadId
          ? {
              policy: DEFAULT_COMPACTION_POLICY,
              existingRecord: compactionStore.get(threadId),
              persist: (record) => compactionStore.record(record),
              releaseLatch: () => compactionStore.releaseLatch(threadId),
              // The SAME model the turn will use. Summarising with a different
              // model than the one that will read the summary would make the
              // summary a translation rather than a record of this conversation.
              summarizerModel: languageModel,
              summarizedBy: `${modelConfig.type}/${modelConfig.model}`,
              nextCompactionId: (generation) => `${generateId()}_${generation}`,
              now: () => Date.now(),
              signal: run.controller.signal,
              timeoutMs: COMPACTION_SUMMARY_TIMEOUT_MS,
            }
          : undefined,
      // ── Phase 5: memory ────────────────────────────────────────────────────
      // The seam, composed here and nowhere else. This is the ONLY place the
      // Direct path supplies memory, and it is deliberately the same call that
      // already owns context assembly, so the order the seam documents is the
      // order that runs: after Phase 4 compaction and before measurement.
      //
      // Everything memory decides — validation, ranking, the 50-candidate
      // consideration ceiling, the 8-memory selection ceiling, the 10%/16k
      // budget, the 4000-char delivery cap, safety screening, placement before
      // the current turn, and provenance — lives in the certified Part 4 seam.
      // This route decides only whether it participates. There is deliberately
      // no second selection algorithm here, and no memory text is assembled,
      // truncated, ordered or rendered in this file.
      //
      // `localMemoryProvider` is TBAi's own retrieval port over the authoritative
      // `memories` table. SQLite stays the single source of truth; nothing about
      // the selected set is accepted from the browser, and no selected-memory
      // state is cached across requests, so a create/edit/delete is reflected on
      // the very next turn.
      //
      // Off unless `TBAI_MEMORY_ENABLED` is exactly "1"/"true" — supplying this
      // seam makes stored memory model-visible, which is a deliberate act. See
      // `src/context/memory/enablement.ts`.
      memory: memoryEnabled()
        ? { provider: localMemoryProvider, enabled: true }
        : undefined,
    });
    tools = assembled.context.layerB.tools as NativeToolSet & Record<string, any>;
    toolsContext = buildToolsContext({
      workspaceDir,
      threadId,
      // Scheduler creates inherit the current provider/model when the model
      // omits them (it cannot guess provider cuid values).
      providerId: provider.id,
      modelId: modelConfig.model,
    });
    modelMessages = assembled.context.modelMessages as Awaited<
      ReturnType<typeof prepareModelMessages>
    >;

    // ── Phase 3: cache capability, resolved BEFORE the model call ─────────────
    // Two abstract questions, two typed answers. No provider name and no cache
    // conditional appears here: every provider-specific fact lives behind
    // `src/context/cache/` (asserted by cache-boundary.test.ts).
    //
    // 1. What does the vendor document for this EXACT provider + protocol + model?
    cacheCapability = resolveCacheCapability({
      providerType: modelConfig.type,
      protocol: resolveApiProtocol(modelConfig) ?? "responses",
      modelId: modelConfig.model,
    });

    // 2. What request options, if any, should go out?
    cacheControl = buildCacheProviderOptions({ capability: cacheCapability });

    // 3. Is the prefix that will be cached stable? A digest, never content.
    cachePrefix = computePrefixIdentity({
      layerAText: assembled.context.layerA.text,
      nativeToolNames: assembled.context.layerB.nativeToolNames,
      mcpToolNames: assembled.context.layerB.mcpToolNames,
      retainedMessageIds: assembled.context.layerC.retainedIds,
      currentTurnIds: assembled.context.layerC.currentTurnIds,
    });
  } catch (err) {
    chatRuns.markFailed(run.streamId);
    throw err;
  }
  };
  await assembleForRequest();
  // `chatLog` is constructed further down, so the assembly line and any
  // pre-flight rejection are emitted through a correlation-bound child logger
  // built here. Same bindings, constructed once.
  const assemblyLog = logger.child({
    requestId,
    conversationId: threadId,
    provider: provider.type,
    model: modelConfig.model,
  });

  // Preflight rejection: cheaper than a provider round trip, and - because
  // DIRECT_MAX_RETRIES = 0 (chat.ts:54-55) - the only chance to avoid spending a
  // request that is known to be oversized. The user gets the overflow message,
  // not the generic generation failure Phase 1 recorded as F7.
  if (assembled.decision.action === "reject") {
    chatRuns.markFailed(run.streamId);
    logContextOverflow({
      log: assemblyLog,
      requestId,
      conversationId: threadId,
      diagnostics: assembled.diagnostics,
      overByTokens: assembled.decision.overBy,
      reason: assembled.decision.reason,
    });
    return c.json(
      {
        error:
          "This conversation is too long for the selected model's context window. Start a new chat, or switch to a model with a larger context limit.",
        code: "CONTEXT_OVERFLOW",
        requestId,
      },
      400,
    );
  }

  logAssembly({
    log: assemblyLog,
    requestId,
    conversationId: threadId,
    diagnostics: assembled.diagnostics,
  });

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
    const effective = error ?? new Error("Direct stream failed");
    chatLog.error("ai", "ai.error", {
      streamId,
      ...errorLogFields(effective, { provider: provider.type }),
      elapsedMs: Date.now() - chatStartedAt,
      firstChunkArrived: firstChunkAt !== null,
      firstChunkElapsedMs: firstChunkAt !== null ? firstChunkAt - chatStartedAt : null,
      chunkCount,
    });
    logProviderErrorCode(effective, streamId);
    logOverflowRecovery(effective, streamId);
  };

  /**
   * The bounded overflow-recovery verdict for this request.
   *
   * Consulted for every provider failure so the decision is observable, and so
   * the executor that compacts-and-re-issues has ONE tested policy to call
   * rather than re-deriving the conditions. `overflowRecoveryAttempted` is the
   * bound: it flips on the first recovery and is never cleared within a request.
   */
  const logOverflowRecovery = (error: unknown, streamId: string): void => {
    const decision = decideOverflowRecovery({
      category: classifyError(error, { provider: provider.type }).category,
      alreadyAttempted: overflowRecoveryAttempted,
      compactionEnabled: compactionEnabled(),
      hasConversation: threadId !== undefined,
    });
    if (decision.outcome === "not_context_overflow") return;
    chatLog.warn("context", "context_overflow_recovery", {
      streamId,
      outcome: decision.outcome,
      shouldRecover: decision.shouldRecover,
      alreadyAttempted: overflowRecoveryAttempted,
      compactionEnabled: compactionEnabled(),
      hasConversation: threadId !== undefined,
    });
  };

  /**
   * Publish the provider error for the attempt that turned out to be FINAL.
   *
   * Reproduces exactly what the attempt-level `onError` used to do, and is called by
   * the gate at the moment it commits to forwarding an attempt's error — never before.
   * Keeping the behaviour identical is the point: an ordinary provider error must reach
   * the user through precisely the path it always has, or this feature would have
   * silently regressed every non-overflow failure.
   *
   * `logAiError` is guarded by `errorLogged`, so this cannot double-log or double-settle.
   */
  const publishFinalProviderError = (attempt: number, error: unknown): void => {
    if (!attemptErrors.has(attempt)) attemptErrors.set(attempt, error);
    const captured = attemptErrors.get(attempt);
    if (captured === undefined) return;
    originalStreamError = captured;
    streamErrorCaught = captured;
    const detachedClientAbort =
      clientDisconnected && classifyError(captured).category === "cancelled";
    if (!detachedClientAbort) logAiError(captured);
  };

  /**
   * The provider's own machine identifiers for a rejected request, on their own
   * event so `ai.error` stays exactly as narrow as it was.
   *
   * Emitted only for a status-bearing provider call (`4xx`/`5xx`), because that
   * is the only case where the provider named a cause. The fields are the
   * allowlisted scalars from `providerErrorCodeFields` — never the response
   * body, never the request body, never the error prose. `ai.error` continues to
   * omit the message by design and this does not weaken that: the diagnostic
   * exists so an engineer can see *which field* a provider rejected without any
   * user data crossing the boundary.
   */
  const logProviderErrorCode = (error: unknown, streamId: string): void => {
    const status = classifyError(error, { provider: provider.type }).statusCode;
    if (status === undefined || status < 400) return;
    const codes = providerErrorCodeFields(error);
    if (Object.keys(codes).length === 0) return;
    chatLog.warn("ai", "ai.provider_error_code", {
      streamId,
      provider: provider.type,
      model: modelConfig.model,
      statusCode: status,
      ...codes,
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
      const startAttempt = (attempt: number): ReadableStream<never> => {
        const result = streamText<NativeToolSet>({
        model: languageModel,
        messages: modelMessages,
        maxRetries: DIRECT_MAX_RETRIES,
        streamRetries: DIRECT_STREAM_RETRIES,
        // Layer A is owned by the assembly seam. The route spreads the seam's
        // options and never names the `instructions` key, so the Direct path has
        // exactly one system-prompt seam (asserted by
        // ChatWindow.tool-output-once.test.ts).
        ...assembled.context.layerA.toStreamTextOptions(),
        // Phase 3: request-level cache controls, or nothing. `undefined` when the
        // capability is unknown, implicit-only, or inexpressible without a Phase 2
        // change — spreading `undefined` sends no parameter at all, which is the
        // correct request in every one of those cases.
        // Phase 3: request-level cache controls, MERGED with the reasoning options
        // below rather than spread separately. `streamText` takes a single
        // `providerOptions` object, so a second spread would be silently
        // overwritten by whichever came last — and a dropped cache control is
        // indistinguishable from caching that simply did not happen.
        ...
        (Object.keys(providerOptions).length || cacheControl?.providerOptions
          ? {
              providerOptions: {
                ...providerOptions,
                ...(cacheControl?.providerOptions ?? {}),
              },
            }
          : {}),
        tools,
        toolsContext,
        stopWhen: stepCountIs(20),
        // Phase 2: the ceiling on the model's own output, computed in
        // `assembleContext`. Phase 1 established Direct reserved nothing (F5),
        // which let a request occupy the whole window and leave no room to answer.
        //
        // R1: this is `generationCap`, NOT the input budget's `outputReservation`.
        // The two are separate quantities that answer different questions — "how
        // much input must I hold back?" versus "how much may the model emit?" —
        // and the budget already subtracted the reservation, so the two must never
        // be added together. The cap is pre-clamped to the room left in the
        // window, which is what preserves `input + output <= ceiling`.
        maxOutputTokens: assembled.context.provenance.budget.generationCap.tokens,
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
        // ── Occupancy: the provider's own count of the last prompt ───────────
        // Written on EVERY step and read once at `finish`, so the value shipped
        // is the final round trip's prompt size — the same quantity OpenCode
        // reports as `tokens.total` and OpenChamber's meter prefers over a sum.
        //
        // Deliberately NOT `totalUsage`: that is traffic (summed across steps)
        // and is exactly the category error this replaces.
        onStepFinish: ({ usage }: { usage?: unknown }) => {
          lastStepOccupancy = providerOccupancyFromStepUsage(usage);
        },
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
          // CAPTURE ONLY. Publication is the gate's decision, made when it knows
          // whether this attempt survives. Publishing here is what made a discarded
          // attempt announce its own failure — and `streamText` fires this callback at
          // rejection time, before the gate has seen the error part, so nothing could
          // have suppressed it from in here.
          attemptErrors.set(attempt, error);
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

          // ── Phase 3: observe what the provider actually reported ─────────────
          // A measurement, never an inference. The provider's own numbers decide
          // the verdict. Latency and request success are deliberately NOT
          // consulted: a request below a documented minimum succeeds and simply
          // caches nothing, so success is not evidence either way.
          if (cacheCapability) {
            const observation = observeSdkCacheUsage({
              capability: cacheCapability,
              usage,
            });
            chatLog.info("context", "cache_observed", {
              requestId,
              conversationId: threadId,
              ...describeCacheObservation(observation),
              ...(cacheControl ? describeCacheDecision(cacheControl) : {}),
              ...(cachePrefix ? describePrefixIdentity(cachePrefix) : {}),
              capabilityStatus: cacheCapability.status,
              capabilityMode: cacheCapability.cacheMode,
              // DOCUMENTED values, carried alongside the observation and never
              // merged with it. `null` when nothing is documented — a stand-in
              // number here would be indistinguishable from a vendor fact.
              documentedMinimumPrefix:
                cacheCapability.status === "documented" ? cacheCapability.documentedMinimumPrefixTokens : null,
              documentedSource: cacheCapability.status === "documented" ? cacheCapability.source : null,
              documentedVerifiedOn:
                cacheCapability.status === "documented" ? cacheCapability.verifiedOn : null,
              // R1's binding rule, evaluated per request: a conservative or
              // configured context ceiling may bound safety but must never size a
              // cache experiment.
              contextLimitSource: assembled.context.provenance.limit.source,
              phase3ExperimentEligible:
                assembled.context.provenance.limit.source === "provider_reported",
            });
          }

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
      });
        return result.fullStream as unknown as ReadableStream<never>;
      };

      /**
       * THE RECOVERY GATE.
       *
       * Wraps the RAW provider stream, never the composed UI stream. That placement is
       * measured, not assumed: the composed `createUIMessageStream.onError` settles the
       * run, and a provider `error` part never reaches it anyway (proved by
       * `tests/integration/direct-error-ownership.test.ts`), so upstream of the
       * composition is the only place where the surviving attempt can be chosen.
       */
      const gatedStream = withOverflowRecovery<never>({
        startAttempt: (attempt) => startAttempt(attempt),
        isErrorPart: (part) => {
          const candidate = part as { type?: unknown; error?: unknown };
          return candidate?.type === "error" ? candidate.error : undefined;
        },
        // Real SDK lifecycle vocabulary. `start` / `start-step` / `finish-step` carry
        // nothing the user can read; anything else commits the attempt.
        isLifecyclePart: (part) =>
          LIFECYCLE_PART_TYPES.has((part as { type?: unknown })?.type as string),
        decide: (error) => {
          const decision = decideOverflowRecovery({
            category: classifyError(error, { provider: provider.type }).category,
            alreadyAttempted: overflowRecoveryAttempted,
            compactionEnabled: compactionEnabled(),
            hasConversation: threadId !== undefined,
          });
          if (decision.shouldRecover) overflowRecoveryAttempted = true;
          return decision;
        },
        /**
         * Compact, then rebuild through the SAME assembly seam — there is no second
         * context path. `forceCompaction` is required: the local trigger is derived
         * from an estimate that already passed pre-flight, so it has nothing to fire
         * on. The provider's rejection is the evidence that the size problem is real.
         *
         * A rejection here propagates, and the gate then forwards the ORIGINAL
         * overflow: recovery is a remedy, and a failed remedy must not replace the
         * real diagnosis with a vague one.
         */
        recover: async () => {
          chatLog.warn("context", "overflow_recovery_compaction_entered", {});
          await assembleForRequest({ forceCompaction: true });
          // SAFETY INVARIANT, kept even though the compaction path is now correct.
          //
          // Compaction is CONTAINED: a summariser failure, a lost race, or simply nothing
          // eligible is REPORTED, not thrown. So `assembleForRequest` resolving is NOT
          // evidence that anything was compacted - and treating it as such would re-send
          // the identical oversized history to the same provider, which can only overflow
          // again. The explicit boolean is the only acceptable proof.
          //
          // Throwing makes the gate forward the ORIGINAL provider overflow and skip the
          // retry, so a no-op compaction can never be mistaken for a recovery.
          if (assembled.diagnostics.compactionApplied !== true) {
            throw new Error(`compaction_not_applied:${assembled.diagnostics.compactionReason}`);
          }
          chatLog.warn("context", "overflow_recovery_context_rebuilt", {
            compactionApplied: true,
            compactionGeneration: assembled.diagnostics.compactionGeneration,
            compactionSpanMessages: assembled.diagnostics.compactionSpanMessages,
          });
        },
        /**
         * The gate has decided to KEEP this attempt and forward its error, so this is
         * the moment the logical request publishes its terminal failure — once, through
         * exactly the path an ordinary provider error always took.
         */
        onFinalError: (attempt, error) => {
          publishFinalProviderError(attempt, error);
        },
        onEvent: (event) => {
          if (event.type === "retry_started") {
            chatLog.warn("context", "overflow_recovery_retry_started", { attempt: event.attempt });
            return;
          }
          if (event.type === "recovery_failed") {
            chatLog.warn("context", "overflow_recovery_failed", { failure: event.failure });
            return;
          }
          chatLog.warn("context", "overflow_recovery_event", { event: event.type });
        },
      });

      writer.merge(toUIMessageStream({
        stream: gatedStream as unknown as Parameters<typeof toUIMessageStream>[0]["stream"],
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
          // The branch this run continued: the AI SDK hands us
          // `[...originalMessages (minus the last when continuing), responseMessage]`,
          // so the previous entry is the same parent the browser's adapter would
          // record. Not "the last user message", which is wrong on a continuation.
          const parentId = messages[messages.length - 2]?.id ?? null;
          // The single winning `completed` transition is the one place a run's
          // reply is provably whole, so it is the one place the reply is captured
          // durably — whether or not a client was attached. Persistability is
          // decided by the finalizer's own validator, not re-guessed here, and an
          // unusable message is simply not captured: the reconciler reports such a
          // row as unrecoverable rather than inventing a reply. This is what makes
          // a completed+pending row repairable instead of stranded.
          if (didSettle && settlement === "completed") {
            const captured = validateFinalMessage(responseMessage, isAborted).message;
            if (captured) {
              chatStreamStore.recordFinalMessage(streamId, {
                message: captured,
                parentId,
              });
            }
          }
          // Server-side history finalization: the connected client persists through
          // the assistant-ui history adapter, so this is only the fallback for a run
          // that completed with nobody there to write it. Gated on the single
          // winning `completed` transition, so it can run at most once per run.
          if (!wasDetached || !didSettle || settlement !== "completed") return;
          await finalizeDetachedRunHistory(chatHistoryFinalizerDeps, {
            streamId,
            responseMessage,
            isAborted,
            parentId,
            log: chatLog,
          });
        },
        messageMetadata: ({ part }) =>
          buildChatMessageMetadata(
            part,
            {
              providerId: provider.id,
              modelId: modelConfig.model,
              reasoningLevel: reasoning,
            },
            contextStateForUi(),
          ),
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
  /**
   * Whether the conversation currently ends with an assistant reply.
   *
   * The client's run-recovery notice is gated on this: a finished run whose reply
   * is present is a healthy conversation, not an incident. Absent (older server)
   * means "unknown", never "broken".
   */
  endsWithReply: boolean;
  /**
   * The shared classifier's category for a failed run (`src/lib/errors.ts`).
   *
   * Projected, never re-derived: the client branches on this so auth wording
   * stays scoped to evidence-backed authentication failures instead of a second
   * regex disagreeing with the server's. Null for a completed run.
   */
  errorCategory: string | null;
};

function projectStreamStatus(
  description: NonNullable<ReturnType<typeof chatStreamStore.describe>>,
  endsWithReply: boolean,
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
    endsWithReply,
    // Already stored on the row by `mirrorRunToDurableStream`, from the one
    // shared classifier. Never re-classified here.
    errorCategory: description.errorCategory ?? null,
  };
}

app.get("/api/chat/stream-status", async (c) => {
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
  // The conversation is the durable key, but this endpoint also accepts a bare
  // stream id, so fall back to the run's own bound conversation. A stream with
  // neither reports `endsWithReply: false` — "unknown" to the client, which must
  // never be read as "the reply is missing".
  const runConversationId =
    conversationId ?? chatStreamStore.getRunContext(description.streamId)?.conversationId ?? null;
  const run = projectStreamStatus(
    description,
    runConversationId ? await messageService.endsWithReply(runConversationId) : false,
  );
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
    endsWithReply: run.endsWithReply,
    errorCategory: run.errorCategory,
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
