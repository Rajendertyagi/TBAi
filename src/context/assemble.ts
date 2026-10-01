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
import { reduceToolResults } from "./reduce";
import type {
  AssembleContextInput,
  AssembledContext,
  BudgetDecision,
  ContextLimit,
  InstructionsLayer,
  MessagesLayer,
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
 */
export function buildToolLayer(input: {
  runId: string;
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
    runId: input.runId,
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
  const { currentIds, retainedIds } = identifyCurrentTurn(reduced);
  const layerC: MessagesLayer = {
    messages: reduced,
    currentTurnIds: currentIds,
    retainedIds,
  };

  // ── Reconciliation against stored history ─────────────────────────────────
  // A comparison, never a merge. See divergence.ts for why it does not reject.
  const divergence = await reconcileWithStoredHistory({ conversationId, submittedMessages: reduced });

  // ── Measure ───────────────────────────────────────────────────────────────
  // Three per-layer estimates combined, so an overspend is attributable to a
  // layer rather than only visible as a total.
  const estimate = combineEstimates([
    measureInstructions(layerA),
    measureToolDefinitions(layerB),
    measureMessages(layerC),
  ]);

  // ── Limit + budget ────────────────────────────────────────────────────────
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
  const decision = decideBudget({ estimate, budget, reducedAlready: reduction.reducedParts > 0 });

  // ── Convert to model messages ─────────────────────────────────────────────
  // Only when the request is going to be sent. A rejection must not pay for a
  // conversion it will discard.
  const modelMessages = decision.action === "reject" ? [] : await prepareModelMessages(reduced, layerB.tools, { threadId: conversationId });

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
      estimate,
      budget,
      limit,
      decision,
    },
  };

  const diagnostics = {
    ...budgetDiagnostics({ estimate, budget, limit, decision, messages: layerC }),
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
  };

  return { context, decision, diagnostics };
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
