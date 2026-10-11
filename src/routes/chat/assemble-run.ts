/**
 * Phase 2 — create the run and assemble context.
 *
 * A MOVE out of the `POST /api/chat` handler. The guard bodies, the
 * `assembleContext` call, the cache decisions and the log sites are the
 * originals; what changed is that the mutable values now live on one explicit
 * `DirectRunAssembly` record instead of in the handler's closure.
 *
 * ## Why the state is an object and not a parameter list
 *
 * Assembly is re-entrant: provider overflow recovery rebuilds context through
 * `assembleForRequest` a second time with `forceCompaction`. Values written by
 * the first pass (`tools`, `assembled`, the cache decisions) must be visible to
 * the retry and to everything downstream. A parameter list cannot carry that:
 * the function would have to return seven values the caller must remember to
 * rebind, and a missed rebind is a silent divergence between the original
 * request and its retry.
 *
 * So the record IS the contract. `assembleForRequest` mutates it; the route
 * reads it. Both halves name the same fields, so the compiler catches a rename
 * that only one half made.
 *
 * ## Why this is not serializable, and does not claim to be
 *
 * `attemptErrors` is a `Map` and `assembled` is a live context object produced
 * by `assembleContext`. This record is a runtime container, not a wire format.
 * Nothing crosses the process boundary in it, and nothing should try to.
 *
 * ## The `terminalTap` parameter
 *
 * Required, explicit, and not optional. The handler previously closed over
 * `terminalBatcher`, which is declared in a LATER phase (the stream phase). The
 * arrow captured the binding and was only invoked during streaming, long after
 * that declaration ran — correct, but invisible at the call site and easy to
 * break by reordering. Passing the tap as a required parameter makes the
 * dependency legible: whoever assembles must say where terminal output goes.
 *
 * The handler still supplies the arrow over its own `terminalBatcher`; the
 * deferral is unchanged, only now it is stated rather than inferred.
 */
import { assembleContext, localMemoryProvider, memoryEnabled } from "../../context";
import {
  buildCacheProviderOptions,
  computePrefixIdentity,
  resolveCacheCapability,
  type CacheCapability,
  type CacheControlDecision,
  type PrefixIdentity,
} from "../../context/cache";
import {
  COMPACTION_SUMMARY_TIMEOUT_MS,
  DEFAULT_COMPACTION_POLICY,
  compactionEnabled,
} from "../../context/compaction";
import {
  buildContextState,
  resolveOccupancy,
  type OccupancyMeasurement,
} from "../../context/occupancy";
import type { prepareModelMessages } from "../../lib/model-messages";
import { generateId } from "../../lib/utils";
import { resolveApiProtocol } from "../../services/ai";
import { chatRuns } from "../../services/chat-runs";
import { compactionStore } from "../../services/compaction";
import type { BashOutputEvent } from "../../services/tools";
import { resolveConversationWorkspace, WorkspaceError } from "../../services/workspace";
import { buildToolsContext, type NativeToolSet, type NativeToolsContext } from "../../tools";
import type { ChatContextState } from "../chat-model";
import type { ChatContext, DirectRunSetup, PhaseResult } from "./types";

/**
 * Everything this request assembles, and everything assembly writes.
 *
 * Written by `assembleForRequest` (and by the stream phase, for
 * `lastStepOccupancy`); read by the gate, the stream and the finalizers.
 */
export type DirectRunAssembly = {
  readonly run: ReturnType<typeof chatRuns.create>;
  readonly streamId: string;
  workspaceDir: string | undefined;
  assembled: Awaited<ReturnType<typeof assembleContext>> | undefined;
  tools: (NativeToolSet & Record<string, any>) | undefined;
  toolsContext: NativeToolsContext | undefined;
  modelMessages: Awaited<ReturnType<typeof prepareModelMessages>> | undefined;
  lastStepOccupancy: OccupancyMeasurement | undefined;
  overflowRecoveryAttempted: boolean;
  readonly attemptErrors: Map<number, unknown>;
  cacheCapability: CacheCapability | undefined;
  cacheControl: CacheControlDecision | undefined;
  cachePrefix: PrefixIdentity | undefined;
};

/**
 * Create the run record and resolve the conversation workspace.
 *
 * Rejects with the finished 400 when the workspace cannot be resolved; any
 * other failure is re-thrown after the run is marked failed, so a run that
 * never executed never lingers as "running" until the sweep.
 */
export async function createRunAndAssemble(
  c: ChatContext,
  setup: DirectRunSetup,
): Promise<PhaseResult<DirectRunAssembly>> {
  const { requestId, threadId, provider, modelConfig } = setup;

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
      return {
        ok: false,
        response: c.json(
          { error: `Workspace error: ${err.message}`, code: err.code, requestId },
          400,
        ),
      };
    }
    throw err;
  }

  return {
    ok: true,
    value: {
      run,
      streamId,
      workspaceDir,
      // Phase 2: this block is the SINGLE Direct context-assembly boundary. Layers
      // A/B/C, lifecycle repair, request-side reduction, measurement and the budget
      // all happen inside `assembleContext` (src/context/assemble.ts). Nothing here
      // assembles context, and nothing may bypass it - see docs/decisions.md
      // "ADR: Direct context assembly is a hybrid explicit seam (2026-10-01)".
      assembled: undefined,
      tools: undefined,
      toolsContext: undefined,
      modelMessages: undefined,
      lastStepOccupancy: undefined,
      overflowRecoveryAttempted: false,
      attemptErrors: new Map<number, unknown>(),
      // Phase 3 outputs. Declared here so the pre-flight rejection path can log the
      // cache capability of a request it refuses to send.
      cacheCapability: undefined,
      cacheControl: undefined,
      cachePrefix: undefined,
    },
  };
}

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
export function contextStateForUi(state: DirectRunAssembly): ChatContextState | undefined {
  const { assembled, lastStepOccupancy } = state;
  if (assembled === undefined) return undefined;
  const provenance = assembled.context.provenance;
  const occupancy = resolveOccupancy({
    provider: lastStepOccupancy,
    estimatedTokens: provenance.estimate.estimatedTokens,
  });
  const contextState = buildContextState({
    occupancy,
    windowTokens: provenance.limit?.maxInputTokens,
    windowSource: provenance.limit?.source,
    usableInputTokens: provenance.budget.usableInputTokens,
  });
  if (contextState === undefined) return undefined;
  return {
    usedTokens: contextState.usedTokens,
    windowTokens: contextState.windowTokens,
    windowSource: contextState.windowSource,
    usableInputTokens: contextState.usableInputTokens,
    occupancyKind: contextState.measurement?.kind ?? "unknown",
    cachedInputTokens:
      contextState.measurement?.kind === "provider"
        ? contextState.measurement.cachedInputTokens
        : undefined,
    // The resolution identity travels WITH the number, so a reading whose window is
    // no longer the one this conversation would resolve can be recognised as stale
    // instead of being presented as current.
    ...(provenance.limit
      ? {
          resolvedFor: {
            providerId: provenance.limit.providerId,
            modelId: provenance.limit.modelId,
          },
        }
      : {}),
  };
}

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
 *
 * `terminalTap` is REQUIRED: assembly wires it into the native `run_command`
 * tool, and there is no correct default sink. The caller passes the writer that
 * owns the stream, so the direction of the dependency is explicit at the call.
 */
export async function assembleForRequest(
  setup: DirectRunSetup,
  state: DirectRunAssembly,
  terminalTap: (toolCallId: string, event: BashOutputEvent) => void,
  options: { forceCompaction?: boolean } = {},
): Promise<void> {
  const { threadId, conversation, provider, modelConfig, languageModel, messages } = setup;
  const { run, workspaceDir } = state;
  try {
    const assembled = await assembleContext({
      forceCompaction: options.forceCompaction === true,
      conversationId: threadId,
      submittedMessages: messages,
      runId: run.streamId,
      provider: modelConfig,
      modelId: modelConfig.model,
      // The row may hold NULL; every consumer of a system prompt wants
      // `string | undefined`, so "unset" is reconciled to that spelling here.
      systemPrompt: conversation?.systemPrompt ?? undefined,
      terminalTap,
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
      memory: memoryEnabled() ? { provider: localMemoryProvider, enabled: true } : undefined,
    });
    state.assembled = assembled;
    state.tools = assembled.context.layerB.tools as NativeToolSet & Record<string, any>;
    state.toolsContext = buildToolsContext({
      workspaceDir,
      threadId,
      // Scheduler creates inherit the current provider/model when the model
      // omits them (it cannot guess provider cuid values).
      providerId: provider.id,
      modelId: modelConfig.model,
    });
    state.modelMessages = assembled.context.modelMessages as Awaited<
      ReturnType<typeof prepareModelMessages>
    >;

    // ── Phase 3: cache capability, resolved BEFORE the model call ─────────────
    // Two abstract questions, two typed answers. No provider name and no cache
    // conditional appears here: every provider-specific fact lives behind
    // `src/context/cache/` (asserted by cache-boundary.test.ts).
    //
    // 1. What does the vendor document for this EXACT provider + protocol + model?
    state.cacheCapability = resolveCacheCapability({
      providerType: modelConfig.type,
      protocol: resolveApiProtocol(modelConfig) ?? "responses",
      modelId: modelConfig.model,
    });

    // 2. What request options, if any, should go out?
    state.cacheControl = buildCacheProviderOptions({ capability: state.cacheCapability });

    // 3. Is the prefix that will be cached stable? A digest, never content.
    state.cachePrefix = computePrefixIdentity({
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
}
