/**
 * The single Direct-engine context-assembly boundary.
 *
 * ONE PATH. Every Direct model request is assembled here, and nowhere else. The
 * route previously inlined this work at `chat.ts:321-341`; that is now a call
 * into this module, and the layering is what makes guarantee 1 (a single Direct
 * assembly path) a property of the code rather than a claim about it.
 *
 * PIPELINE
 * --------
 * ```text
 *   submitted messages + server-owned inputs
 *        ↓
 *   validate                          (the route's Zod boundary, before this call)
 *        ↓
 *   resolve authoritative inputs       (instructions, tools, limit provenance)
 *        ↓
 *   assemble Layer A                  (instructions / developer context)
 *        ↓
 *   assemble Layer B                  (tool definitions — native + MCP)
 *        ↓
 *   lifecycle repair of Layer C       (pruneStaleMessages — NOT size management)
 *        ↓
 *   request-size reduction            (reduceToolResults — request side only)
 *        ↓
 *   compaction                         (Phase 4 — replaces a settled span with a
 *                                       bounded, provenance-carrying summary.
 *                                       Runs AFTER repair, so a size decision can
 *                                       never resurrect a stale tool part. Off
 *                                       unless the caller wires the seam.)
 *        ↓
 *   measure                           (estimate, never reported usage)
 *        ↓
 *   enforce budget                    (accept / reduce / reject)
 *        ↓
 *   convert to model messages         (convertToModelMessages)
 *        ↓
 *   streamText
 * ```
 *
 * Lifecycle repair and size management are two separate steps on purpose. The
 * pruner removes what is INVALID; reduction bounds what is LARGE. Merging them
 * would let a size decision drop an unexpired approval decision, which is the
 * one thing guarantee 6 exists to prevent.
 *
 * Scheduler does NOT come through here. It is unattended, has no submitted
 * history, and runs its own `streamText` with a synthetic prompt
 * (`schedulerExecution.ts:346`). That boundary is deliberate and recorded in the
 * ADR.
 */

import type { ToolSet, UIMessage } from "ai";
import { nativeTools } from "../tools";
import { withTerminalOutput } from "../tools";
import type { BashOutputEvent } from "../services/tools";
import { mcpManager } from "../services/mcp/manager";
import { prepareModelMessages } from "../lib/model-messages";
import { pruneStaleMessages } from "../lib/prune-messages";
import { logger } from "../lib/logger";
import { computeBudget, decideBudget, budgetDiagnostics } from "./budget";
import { identifyCurrentTurn, reconcileWithStoredHistory } from "./divergence";
import { describeLimitSource, resolveContextLimit, selectModelOption } from "./limits";
import { combineEstimates, measureInstructions, measureMessages, measureToolDefinitions } from "./measure";
import { reduceToolResults, describeToolResultReduction } from "./reduce";
import { applyExistingCompaction, isCompactionLatched, maybeCompact, summarizeSpan } from "./compaction";
import { describeCompactionOutcome } from "./compaction/outcome";
import { memoryDiagnostics, runMemoryPhase } from "./memory";
import type { CompactionPhaseInput, CompactionReport, CompactionSeam } from "./types";
import type {
  AssembleContextInput,
  AssembledContext,
  BudgetDecision,
  ContextLimit,
  InstructionsLayer,
  MessagesLayer,
  ReductionRecord,
  ToolDefinitionLayer,
} from "./types";

/** Stable prefix for MCP tool names. Matches the assembler's own naming. */
const MCP_TOOL_PREFIX = "mcp__";

/** Result of assembly, plus the decision so the route can act on a rejection. */
export interface AssembleContextResult {
  readonly context: AssembledContext;
  /** `reject` means the request must not be sent. */
  readonly decision: BudgetDecision;
  /** Flat, loggable diagnostics. Counts and categories only. */
  readonly diagnostics: Record<string, unknown>;
}

/**
 * Build Layer A.
 *
 * Server-owned by construction: the client cannot reach this value, because a
 * submitted `system` is rejected at the route boundary before assembly
 * (`chat.ts:252-258`). CONDITIONALLY PRESENT - a conversation with no system
 * prompt yields `source: "absent"`, which is a normal state, not a defect.
 */
export function buildInstructionsLayer(systemPrompt: string | undefined): InstructionsLayer {
  const text = systemPrompt;
  return {
    text,
    source: text ? "conversation_system_prompt" : "absent",
    // The single `instructions:` literal in the Direct path.
    toStreamTextOptions: () => (text ? { instructions: text } : {}),
  };
}

/**
 * Build Layer B, with deterministic ordering.
 *
 * The determinism is the point. `getAiTools` iterates `this.connections`
 * (`manager.ts:1027-1061`), whose population order depends on when MCP servers
 * connected - so the same logical tool set can produce two different serialized
 * requests. Since the provider's cacheable prefix is the concatenation
 * A -> B -> C, an unstable Layer B silently destroys Layer C's cacheability.
 *
 * The NAMES are sorted for determinism and for diagnostics. The tool MAP itself
 * is built in sorted key order so the object's own iteration is stable too -
 * object spread order is not a contract, and relying on it would make the
 * prefix depend on insertion sequence rather than on inputs.
 *
 * ## Why there is no `runId` parameter
 *
 * It used to be required and was never read. It was removed rather than wired up
 * because every honest use of it would break the guarantee above: the only place
 * it could go is the returned layer, and a per-run id in the serialized Layer B
 * makes the cacheable prefix differ on every single request - which would destroy
 * Layer C's cacheability in exactly the way the paragraph above exists to
 * prevent. Per-run attribution already happens at the call site, which logs the
 * assembly once with the real `requestId` (`logAssembly`). Do not re-add it.
 */
export function buildToolLayer(input: {
  toolSignal: AbortSignal;
  terminalTap?: (toolCallId: string, event: BashOutputEvent) => void;
  extraTools?: Record<string, unknown>;
}): ToolDefinitionLayer {
  const native: Record<string, unknown> = { ...nativeTools };

  // `run_command` is rebuilt per request with the terminal tap wired in: a
  // function cannot travel in validated Zod context, so it is closed over here
  // rather than passed through request data.
  if (input.terminalTap) {
    native.run_command = withTerminalOutput(input.terminalTap);
  }

  const mcpTools = mcpManager.getAiTools(input.toolSignal);

  // Sorted key order: the serialized Layer B depends on the SET, not on the
  // sequence in which MCP servers happened to connect.
  const mcpToolNames = Object.keys(mcpTools).sort();
  const sortedMcp: Record<string, unknown> = {};
  for (const name of mcpToolNames) sortedMcp[name] = mcpTools[name];

  const extra = input.extraTools ?? {};
  const extraNames = Object.keys(extra).sort();
  const sortedExtra: Record<string, unknown> = {};
  for (const name of extraNames) sortedExtra[name] = extra[name];

  const tools: Record<string, unknown> = { ...native, ...sortedExtra, ...sortedMcp };

  const nativeToolNames = Object.keys(native).sort();
  const mcpServerIds = [
    ...new Set(
      mcpToolNames
        .filter((name) => name.startsWith(MCP_TOOL_PREFIX))
        .map((name) => name.slice(MCP_TOOL_PREFIX.length).split("__")[0])
        .filter((id) => id.length > 0),
    ),
  ].sort();

  return {
    tools: tools as ToolSet,
    nativeToolNames,
    mcpToolNames,
    mcpServerIds,
  };
}

/**
 * Assemble one Direct model request.
 *
 * Async because SQLite reconciliation, memory retrieval (Phase 5) and model
 * metadata lookup all require it. `prepareModelMessages` is already async and is
 * already awaited at the call site, so this is non-breaking (Q10).
 */
export async function assembleContext(input: AssembleContextInput): Promise<AssembleContextResult> {
  const { conversationId, submittedMessages, provider, modelId, systemPrompt } = input;

  // ── Layer A ───────────────────────────────────────────────────────────────
  const layerA = buildInstructionsLayer(systemPrompt);

  // ── Layer B ───────────────────────────────────────────────────────────────
  const layerB = buildToolLayer({
    toolSignal: input.toolSignal,
    terminalTap: input.terminalTap,
    extraTools: input.extraTools,
  });

  // ── Layer C, step 1: lifecycle repair (NOT size management) ────────────────
  // The pruner's own stats are read from its return value; its logging is left
  // in place so existing diagnostics do not change shape.
  const { messages: repaired, stats } = pruneStaleMessages(submittedMessages);
  const lifecycleRepair = {
    removedToolParts: stats.removedToolParts.length,
    removedEmptyTurns: stats.removedEmptyTurns,
    preservedApprovals: stats.preservedApprovals.length,
  };

  // ── Layer C, step 2: request-side size reduction ───────────────────────────
  // Runs on the repaired messages so reduction never has to reason about a part
  // the pruner already removed. Applies to the REQUEST only; nothing is
  // rewritten in storage.
  const { messages: reduced, report: reduction } = reduceToolResults(repaired);

  // ── Layer C, step 3: identify the current turn ─────────────────────────────
  // Identified on the ORIGINAL reduced list, BEFORE compaction. The current turn
  // must be known first so the compaction planner can be structurally forbidden
  // from touching it, and so `currentTurnIds` always describes the real user
  // request rather than a summary block.
  const { currentIds, retainedIds } = identifyCurrentTurn(reduced);

  // ── Reconciliation against stored history ─────────────────────────────────
  // A comparison, never a merge. See divergence.ts for why it does not reject.
  const divergence = await reconcileWithStoredHistory({ conversationId, submittedMessages: reduced });

  // ── Limit + budget ────────────────────────────────────────────────────────
  // Computed BEFORE compaction because the compaction trigger must use the actual
  // Phase 2 budget rather than any caller-supplied number. Safe to move up:
  // `computeBudget` depends only on the resolved limit and the model's output
  // ceiling, never on message content.
  //
  // The selected model's stored metadata (its context window, the stance that
  // produced it, and any documented output ceiling) is already present on the
  // provider config the caller resolved — R1 verified the seam's input carried it
  // and the read was simply never made. No network call, no discovery service, no
  // cache: the registry is the only source, so `source` can only ever be a stance
  // someone actually recorded.
  const selectedModel = selectModelOption(provider.models, modelId);
  const limit: ContextLimit = resolveContextLimit({
    providerType: provider.type,
    modelId,
    model: selectedModel,
  });
  const budget = computeBudget({ limit, modelOutputTokens: selectedModel?.maxOutputTokens });

  // ── Phase 4: compaction ───────────────────────────────────────────────────
  // Inserted AFTER lifecycle repair and request-side reduction, and BEFORE
  // measurement. That ordering is the safety argument: the pruner has already
  // removed stale tool parts and expired approvals, so a size decision here can
  // only ever remove more — it can never resurrect one.
  //
  // Compaction is a no-op unless the measured request actually exceeds the policy
  // trigger, and it runs inside a failure boundary whose result on ANY error is
  // "assemble normally". See `runCompactionPhase`.
  const compaction = await runCompactionPhase({
    conversationId,
    messages: reduced,
    seam: input.compaction,
    usableInputTokens: budget.usableInputTokens,
    // CAPACITY, not budget: the summariser reserves far less output than a turn,
    // so it can read more than a turn may send.
    summarizerInputTokens: resolveSummarizerInputTokens(limit, input.compaction),
    // Layer A + Layer B, measured. Compaction cannot reclaim either, and the budget
    // governs the whole request, so the trigger must include them.
    fixedOverheadTokens: combineEstimates([
      measureInstructions(layerA),
      measureToolDefinitions(layerB),
    ]).estimatedTokens,
  });

  // ── Phase 5: memory ───────────────────────────────────────────────────────
  // Runs AFTER compaction and BEFORE measurement, and that order is the design.
  //
  // After compaction, so the memory block can never be inside a compactable span:
  // Phase 4 computed its span from the client's own messages, which never contain
  // an injected block. The invariant holds without touching Phase 4 at all.
  // Before measurement, so memory is inside the estimate the budget gate judges —
  // a context source that bypassed the budget would be the exact defect Phase 2
  // exists to prevent.
  //
  // `layerC.messages` becomes the array WITH the block; the id sets are deliberately
  // NOT recomputed. They were derived from conversation messages only, and the
  // memory id belongs to neither — which is truthful, and keeps it out of Phase 3's
  // `retainedMessageIds` so a changed selection only moves the dynamic suffix.
  const memory = await runMemoryPhase({
    conversationId,
    messages: compaction.layerC.messages,
    seam: input.memory,
    usableInputTokens: budget.usableInputTokens,
  });

  const layerC: MessagesLayer = {
    messages: memory.messages,
    currentTurnIds: compaction.layerC.currentTurnIds,
    retainedIds: compaction.layerC.retainedIds,
  };

  // ── Measure ───────────────────────────────────────────────────────────────
  // Three per-layer estimates combined, so an overspend is attributable to a
  // layer rather than only visible as a total. Measured on the possibly-compacted
  // Layer C, so the budget sees what the provider will actually receive.
  const estimate = combineEstimates([
    measureInstructions(layerA),
    measureToolDefinitions(layerB),
    measureMessages(layerC),
  ]);

  // ── Reduction record (F-A) ────────────────────────────────────────────────
  // Built from what the two mechanisms ACTUALLY did, before the verdict, so the
  // verdict can distinguish "nothing left to try" from "nothing was offered". The
  // previous signal was `reducedParts > 0`, a single boolean that could not express
  // either case for a request with no tool output at all — which is exactly how an
  // oversized tool-free conversation came to be sent.
  const reductionRecord: ReductionRecord = {
    toolResults: describeToolResultReduction(reduction),
    compaction: describeCompactionOutcome(compaction.report),
  };

  const decision = decideBudget({ estimate, budget, reduction: reductionRecord });

  // ── Convert to model messages ─────────────────────────────────────────────
  // Only when the request is going to be sent. A rejection must not pay for a
  // conversion it will discard.
  const modelMessages = decision.action === "reject" ? [] : await prepareModelMessages([...layerC.messages], layerB.tools, { threadId: conversationId });

  const context: AssembledContext = {
    layerA,
    layerB,
    layerC,
    modelMessages,
    provenance: {
      engine: "direct",
      historySource: divergence ? "submitted_with_stored_reference" : "submitted",
      divergence,
      lifecycleRepair,
      reduction: reduction.reducedParts > 0 ? reduction : null,
      compaction: compaction.report,
      memory: memory.report,
      estimate,
      budget,
      limit,
      decision,
    },
  };

  const diagnostics = {
    ...budgetDiagnostics({ estimate, budget, limit, decision, messages: layerC }),
    ...memoryDiagnostics(memory.report),
    nativeToolCount: layerB.nativeToolNames.length,
    mcpToolCount: layerB.mcpToolNames.length,
    mcpServerCount: layerB.mcpServerIds.length,
    instructionsPresent: layerA.source !== "absent",
    lifecycleRemovedToolParts: lifecycleRepair.removedToolParts,
    lifecycleRemovedEmptyTurns: lifecycleRepair.removedEmptyTurns,
    lifecyclePreservedApprovals: lifecycleRepair.preservedApprovals,
    reducedToolParts: reduction.reducedParts,
    reducedToolChars: reduction.removedChars,
    droppedOversizedErrorParts: reduction.droppedParts,
    divergenceOutcome: divergence?.outcome ?? "not_compared",
    historySource: context.provenance.historySource,
    // Phase 4. Counts, a fingerprint, and provenance — never summary content.
    compactionApplied: compaction.report.applied,
    compactionReason: compaction.report.reason,
    compactionGeneration: compaction.report.generation,
    compactionSpanMessages: compaction.report.spanLength,
    compactionSpanFingerprint: compaction.report.spanFingerprint,
    // Numeric keys deliberately avoid the substring "token": logger.ts redacts
    // keys matching that, which would destroy the diagnostic. `unit` says what is
    // counted, and the typed fields keep the honest names.
    compactionSummarySize: compaction.report.summaryTokens,
    compactionReclaimedSize: compaction.report.reclaimedTokens,
    compactionOrigin: compaction.report.origin,
    compactionSummarizedBy: compaction.report.summarizedBy,
  };

  return { context, decision, diagnostics };
}

/**
 * How many input tokens the summariser may read in one call.
 *
 * CAPACITY, not budget. `budget.usableInputTokens` is what a TURN may send after
 * the safety margin and the turn's output reservation; `limit.maxInputTokens` is
 * what the MODEL can accept. The summariser reserves far less output than a turn,
 * so it can legitimately read more than a turn may send.
 *
 * This distinction is load-bearing, not cosmetic. Deriving the summariser's
 * ceiling from the budget undershot real capacity by roughly the safety margin,
 * and testing showed the consequence: because a conversation large enough to need
 * compaction is by definition larger than the budget, every real compaction was
 * refused with `summary_exceeds_budget` and the phase could never fire.
 *
 * Undefined when the limit is unknown, which makes the summariser refuse rather
 * than guess.
 */
function resolveSummarizerInputTokens(
  limit: ContextLimit,
  seam: CompactionSeam | undefined,
): number | undefined {
  if (limit.maxInputTokens === undefined) return undefined;
  const reservation = seam?.policy.summaryOutputReservation ?? 0;
  return Math.max(0, limit.maxInputTokens - reservation);
}

/**
 * Run the Phase 4 compaction phase inside the seam.
 *
 * ## This is the failure boundary
 *
 * EVERY failure — summariser error, timeout, over-budget summary, storage error,
 * an unexpected throw — resolves to "no compaction", and assembly continues with
 * the uncompacted history. The caller's existing `CONTEXT_OVERFLOW` rejection then
 * handles an over-budget request exactly as it does today.
 *
 * That is deliberate: a failed compaction must never leave the conversation in a
 * worse state than before it was attempted, and must never corrupt stored state.
 *
 * ## Determinism
 *
 * The trigger depends only on measured size and the policy, so the same
 * conversation state always produces the same decision. Id and clock are injected
 * by the caller, not read here, so this function has no hidden entropy.
 */
async function runCompactionPhase(
  input: CompactionPhaseInput,
): Promise<{ layerC: MessagesLayer; report: CompactionReport }> {
  const base: CompactionReport = { applied: false, reason: "not_attempted", ...emptyCompactionFields() };

  const seam = input.seam;
  if (!seam || !input.conversationId) {
    const identified = identifyCurrentTurn(input.messages);
    return {
      layerC: {
        messages: input.messages,
        currentTurnIds: identified.currentIds,
        retainedIds: identified.retainedIds,
      },
      report: base,
    };
  }

  try {
    // 1. Re-apply any EXISTING durable record. This is what keeps a compacted
    //    conversation stable across reload, resume and detached completion
    //    without re-summarising on every turn.
    const reapply = applyExistingCompaction({ messages: input.messages, record: seam.existingRecord });

    // 2. Measure the (possibly re-applied) history so the trigger uses real
    //    numbers rather than a message count. Layer A and Layer B are added on
    //    top: the budget governs the WHOLE request, so the trigger must too.
    const layerCEstimated = measureMessages({
      messages: reapply.messages,
      currentTurnIds: [],
      retainedIds: reapply.messages.map((m) => (m as { id?: string }).id ?? ""),
    }).estimatedTokens;
    const measuredTotal = input.fixedOverheadTokens + layerCEstimated;

    // 3. Release the hysteresis latch once usage has demonstrably fallen back
    //    below the release fraction — i.e. once the previous compaction has taken
    //    effect. Observed here, at the one place that observes it.
    const latched = isCompactionLatched(seam.existingRecord);
    if (latched && input.usableInputTokens !== undefined) {
      const releaseAt = Math.floor(input.usableInputTokens * seam.policy.releaseFraction);
      if (measuredTotal < releaseAt) seam.releaseLatch?.();
    }

    const outcome = await maybeCompact({
      conversationId: input.conversationId,
      // Planned over the CLIENT's messages, NOT `reapply.messages`. This is
      // load-bearing, and getting it wrong was a real defect found by testing.
      //
      // `reapply` injects a server-side block whose id the client has never seen.
      // Planning over it produced a second record whose `coveredMessageIds` began
      // with that injected id — so on the next request `locateSpan` could not find
      // the record, the compaction silently stopped applying, and the conversation
      // reverted to full uncompacted history and grew without bound.
      //
      // Planning over the client's own list keeps every covered id something the
      // client will re-post, which is what makes the record durable.
      messages: input.messages,
      measuredTokens: perMessageTokens(input.messages),
      currentTurnIds: [],
      // Pressure measured on the COMPACTED view: what the provider would actually
      // receive is what the trigger must reason about.
      measuredTotalTokens: measuredTotal,
      fixedOverheadTokens: input.fixedOverheadTokens,
      usableInputTokens: input.usableInputTokens,
      existing: seam.existingRecord,
      compactionLatched: latched,
      summarizerInputTokens: input.summarizerInputTokens,
      priorSummaryText: seam.existingRecord?.summaryText,
      policy: seam.policy,
      summarize: (span) =>
        summarizeSpan({
          model: seam.summarizerModel,
          spanMessages: span,
          maxInputTokens: input.summarizerInputTokens ?? 0,
          maxSummaryTokens: seam.policy.maxSummaryTokens,
          outputReservation: seam.policy.summaryOutputReservation,
          summarizedBy: seam.summarizedBy,
          abortSignal: seam.signal,
          timeoutMs: seam.timeoutMs,
        }),
      persist: seam.persist,
      nextCompactionId: seam.nextCompactionId,
      now: seam.now,
    });

    const final = outcome.outcome.applied ? outcome.messages : reapply.messages;
    const identified = identifyCurrentTurn(final);

    if (outcome.outcome.applied === false) {
      const noCompactionReason = outcome.outcome.reason;
      return {
        layerC: { messages: final, currentTurnIds: identified.currentIds, retainedIds: identified.retainedIds },
        report: {
          applied: false,
          reason: reapply.applied
            ? `record_applied_no_new_compaction:${noCompactionReason}`
            : noCompactionReason,
          ...emptyCompactionFields(),
        },
      };
    }

    const { record, plan, reclaimedTokens } = outcome.outcome;
    return {
      layerC: {
        messages: final,
        currentTurnIds: identified.currentIds,
        retainedIds: identified.retainedIds,
      },
      report: {
        applied: true,
        reason: "compacted",
        generation: record.generation,
        spanLength: plan.spanLength,
        spanFingerprint: record.spanFingerprint,
        summaryTokens: record.summaryTokens,
        reclaimedTokens,
        origin: record.origin,
        summarizedBy: record.summarizedBy,
      },
    };
  } catch (error) {
    // Contained, and now RECORDED.
    //
    // The containment is correct and unchanged: a failed compaction must never
    // leave the conversation worse than before it was attempted, so the
    // uncompacted history is returned and assembly continues. The budget gate
    // then sees `withheld/failed` for compaction and can decide from that.
    //
    // What was wrong was not the containment but the silence: the bare `catch {}`
    // made every one of these indistinguishable from "compaction was never
    // offered", so a summariser that throws on every turn looked exactly like a
    // build with the feature switched off. Only `errorType` is logged — never the
    // message, the stack, or any request content, because a summariser error can
    // quote the span it was given.
    logger.warn("context", "compaction_error", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    const identified = identifyCurrentTurn(input.messages);
    return {
      layerC: {
        messages: input.messages,
        currentTurnIds: identified.currentIds,
        retainedIds: identified.retainedIds,
      },
      report: { ...base, reason: "compaction_error" },
    };
  }
}

/**
 * Per-message estimates, index-aligned with `messages`.
 *
 * A full measure per message rather than a chars/4 shortcut, so the span the
 * planner selects is sized by the same estimator the budget uses. A cheap
 * approximation here would make the trigger disagree with the verdict.
 */
function perMessageTokens(messages: readonly UIMessage[]): number[] {
  return messages.map((message) =>
    measureMessages({ messages: [message], currentTurnIds: [], retainedIds: [] }).estimatedTokens,
  );
}

function emptyCompactionFields(): Omit<CompactionReport, "applied" | "reason"> {
  return {
    generation: 0,
    spanLength: 0,
    spanFingerprint: null,
    summaryTokens: 0,
    reclaimedTokens: 0,
    origin: null,
    summarizedBy: null,
  };
}

/** Log one assembly. Counts, categories and provenance only - never content. */
export function logAssembly(input: {
  log: ReturnType<typeof logger.child>;
  requestId: string;
  conversationId: string | undefined;
  diagnostics: Record<string, unknown>;
}): void {
  input.log.info("context", "context_assembled", {
    requestId: input.requestId,
    conversationId: input.conversationId,
    ...input.diagnostics,
  });
}

/** Log a pre-flight rejection. Distinct from a provider failure, because it is one. */
export function logContextOverflow(input: {
  log: ReturnType<typeof logger.child>;
  requestId: string;
  conversationId: string | undefined;
  diagnostics: Record<string, unknown>;
  overByTokens: number;
  reason: string;
}): void {
  input.log.warn("context", "context_overflow_rejected", {
    requestId: input.requestId,
    conversationId: input.conversationId,
    reason: input.reason,
    overBy: input.overByTokens,
    ...input.diagnostics,
  });
}

/** Re-export the limit descriptor so the route can log provenance without importing limits.ts. */
export { describeLimitSource };
