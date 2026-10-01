/**
 * Phase 2 context-assembly contract types.
 *
 * A model request is THREE things, not one flat "context" object. Layers A and B
 * are `streamText` arguments and are NOT `ModelMessage` entries; collapsing them
 * would misdescribe the request and would break Phase 3's cache-prefix reasoning
 * (the provider's cacheable prefix is the CONCATENATION A -> B -> C, so a change
 * in Layer B invalidates Layer C's cacheability exactly as reordering history
 * would).
 *
 * See `docs/decisions.md` -> "ADR: Direct context assembly is a hybrid explicit
 * seam (2026-10-01)" for the authority split this encodes.
 */

import type { LanguageModel, ModelMessage, ToolSet, UIMessage } from "ai";
import type { ProviderConfig } from "../types";
import type { BashOutputEvent } from "../services/tools";

/**
 * Layer A - instructions / developer context.
 *
 * Server-owned. Client-supplied `system` is rejected before assembly
 * (`chat.ts:252-258`), so this value can only come from the server. It is
 * CONDITIONALLY PRESENT: a conversation with no system prompt produces a request
 * with no Layer A at all, and every consumer must tolerate absence.
 */
export interface InstructionsLayer {
  /** The instruction text, or undefined when the conversation has none. */
  readonly text: string | undefined;
  /** Where the text came from. Never the client. */
  readonly source: "conversation_system_prompt" | "absent";
  /**
   * The `streamText` argument for this layer.
   *
   * A method rather than a field so the literal `instructions:` key exists in
   * exactly ONE place in the Direct path - here. The route spreads the result
   * and never names the key, which is what makes "one system-prompt seam" a
   * property of the code rather than a convention (and is asserted by
   * `ChatWindow.tool-output-once.test.ts`).
   *
   * Returns an empty object when absent, so a conversation with no system
   * prompt contributes no `instructions` argument at all.
   */
  toStreamTextOptions(): { instructions?: string };
}

/**
 * Layer B - tool definitions.
 *
 * Server-owned. Client-supplied `tools` is rejected before assembly
 * (`chat.ts:191-201`). Split into the two populations the contract treats
 * differently: B.1 native tools (stable definition set) and B.2 MCP tools
 * (membership changes with server connection state, which is the highest
 * cache-invalidation risk in the request).
 */
export interface ToolDefinitionLayer {
  /** The tool set handed to `streamText` as `tools`. */
  readonly tools: ToolSet;
  /** B.1 - native tool names, deterministically ordered. */
  readonly nativeToolNames: readonly string[];
  /** B.2 - MCP tool names, deterministically ordered by server then name. */
  readonly mcpToolNames: readonly string[];
  /** Server ids contributing B.2, deterministically ordered. */
  readonly mcpServerIds: readonly string[];
}

/**
 * Layer C - `messages[]`, the conversation the model will see.
 *
 * `retained` is everything except the current turn. `currentTurnIds` names the
 * messages that constitute the current user turn, so the current turn is
 * identifiable by id rather than inferred from array position (guarantee G11,
 * which had no mechanism before).
 */
export interface MessagesLayer {
  /** UI messages handed to conversion, in final assembly order. */
  readonly messages: readonly UIMessage[];
  /** Ids forming the current user turn. Never dropped by budgeting. */
  readonly currentTurnIds: readonly string[];
  /** Ids retained as history, in assembly order. */
  readonly retainedIds: readonly string[];
}

/**
 * How an effective context-window limit was determined. Never collapsed to a
 * number alone. (R1, 2026-10-01.)
 *
 * Four states, and the distinction between the first two and the last two is the
 * whole point: the first two are figures SOMEONE stated about this model, the
 * last two are figures TBAi stands in with.
 *
 * Stored provenance (`ContextWindowSource`, `src/types/index.ts`) has only the
 * first two, because only those have a writer. These two additional states are
 * produced by the resolver when no stored figure exists.
 */
export type LimitSource =
  /** A figure from a provider's own listing/API for this model. */
  | "provider_reported"
  /** A figure a human configured for this installation. */
  | "configured"
  /** TBAi's stand-in when nothing is known. NOT a claim about the model. */
  | "conservative_default"
  /** No ceiling at all. The budget must handle this explicitly. */
  | "unknown";

export interface ContextLimit {
  /** Maximum input tokens, when known. Undefined when `source` is `unknown`. */
  readonly maxInputTokens: number | undefined;
  /** Provenance. A stood-in-for limit is never reported as a known figure. */
  readonly source: LimitSource;
  /** Provider the limit was read for. */
  readonly providerType: ProviderConfig["type"] | "unknown";
  /** Model id the limit was read for. */
  readonly modelId: string;
  /**
   * A competing candidate existed with a DIFFERENT value and did not win.
   *
   * Recorded rather than resolved silently so a disagreement between what a
   * provider states and what an operator configured is observable in the logs
   * instead of being lost. Always `false` when fewer than two candidates existed.
   */
  readonly divergent: boolean;
  /**
   * The candidate that lost, when `divergent` is true. Diagnostics only — the
   * value that was NOT used. Absent otherwise.
   */
  readonly divergentValue?: { readonly value: number; readonly source: LimitSource };
}

/**
 * Output reservation - the input budget held back so a generation has room to
 * finish. Phase 1 established Direct reserved nothing (F5), which let a request
 * occupy the whole window and leave no room to answer.
 *
 * This is an INPUT-BUDGET quantity: it is subtracted from the ceiling before
 * usable input is computed. It is NOT the generation cap — see `GenerationCap`.
 */
export interface OutputReservation {
  /** Tokens reserved for completion. Always > 0. */
  readonly tokens: number;
  /** How the reservation was chosen. */
  readonly source: "provider_reported" | "conservative_default";
}

/**
 * MODEL GENERATION CAP - the ceiling placed on the model's own output, sent as
 * `maxOutputTokens`. (R1, 2026-10-01.)
 *
 * Distinct from `OutputReservation`, and the separation is deliberate:
 * - the reservation answers "how much input room must I hold back?", a BUDGET
 *   decision TBAi owns;
 * - the cap answers "how much may the model emit?", bounded by what the MODEL
 *   supports and by the room actually left in the window.
 *
 * Sharing one value between them (the pre-R1 behaviour) capped generation at the
 * 4,096-token reservation floor even for models documenting far larger output.
 * The invariant that made sharing coherent — `input + output <= ceiling` — is
 * now guaranteed explicitly by clamping the cap to `ceiling - usableInputTokens`
 * instead of by making both sides happen to equal the reservation.
 */
export interface GenerationCap {
  /** The value sent as `maxOutputTokens`. Always > 0. */
  readonly tokens: number;
  /** Where the bound came from. */
  readonly source: "provider_reported" | "conservative_default";
  /**
   * True when the model's own documented ceiling was reduced because the room
   * left in the window was smaller. Surfaced in diagnostics: it means the cap is
   * budget-driven, not a statement about the model.
   */
  readonly boundedByRemainingWindow: boolean;
}

/**
 * The computed input budget. Every field is inspectable: a budget that cannot be
 * explained cannot be trusted.
 */
export interface ContextBudget {
  /** Effective ceiling for input, after margin. Undefined when limit unknown. */
  readonly usableInputTokens: number | undefined;
  /** Fraction of the limit held back to absorb estimation error. */
  readonly safetyMarginTokens: number;
  /** Room left for the response. Held back from INPUT. */
  readonly outputReservation: OutputReservation;
  /** Ceiling on the model's own output. Sent as `maxOutputTokens`. */
  readonly generationCap: GenerationCap;
  /** Whether a ceiling could be computed at all. */
  readonly enforceable: boolean;
}

/**
 * Estimated input size. DELIBERATELY not called "tokens" in a way that invites
 * confusion with provider-reported usage: this is an ESTIMATE with a stated
 * error band, computed before the request exists.
 */
export interface InputSizeEstimate {
  /** Estimated input tokens. */
  readonly estimatedTokens: number;
  /** Estimated total characters across every model-visible surface. */
  readonly estimatedChars: number;
  /** Divisor used (characters per token) - the basis of the error model. */
  readonly charsPerToken: number;
  /**
   * Plausible range for the true token count. The low end is what a
   * character-sparse corpus would produce, the high end a dense one. Callers
   * must not treat `estimatedTokens` as a bound.
   */
  readonly range: { readonly low: number; readonly high: number };
  /** Per-category token estimates, for budget attribution and diagnostics. */
  readonly byCategory: Readonly<Record<ContextCategory, number>>;
  /** Per-category character counts. */
  readonly charsByCategory: Readonly<Record<ContextCategory, number>>;
}

/**
 * Model-visible content categories. Each is measured separately so a budget can
 * attribute overspend instead of only reporting a total.
 */
export type ContextCategory =
  | "instructions"
  | "tool_definitions"
  | "user_text"
  | "assistant_text"
  | "reasoning"
  | "tool_calls"
  | "tool_results"
  | "mcp_results"
  | "attachments"
  | "data_parts"
  | "other";

export const CONTEXT_CATEGORIES: readonly ContextCategory[] = [
  "instructions",
  "tool_definitions",
  "user_text",
  "assistant_text",
  "reasoning",
  "tool_calls",
  "tool_results",
  "mcp_results",
  "attachments",
  "data_parts",
  "other",
];

/** Outcome of comparing the submitted message claim against stored history. */
export type DivergenceOutcome =
  /** Submitted ids are a superset of stored: the normal in-flight case. */
  | "in_flight_extension"
  /** Submitted ids exactly match stored. */
  | "aligned"
  /** Stored holds ids the submission omits - e.g. a server-finalized detached reply. */
  | "missing_from_submission"
  /** Neither id set contains the other. */
  | "unrelated";

export interface DivergenceReport {
  readonly outcome: DivergenceOutcome;
  readonly submittedCount: number;
  readonly storedCount: number;
  /** Count only. Ids are never logged at info level. */
  readonly onlyInStored: number;
  readonly onlyInSubmitted: number;
}

/**
 * What the Phase 4 compaction phase did.
 *
 * Kept SEPARATE from `LifecycleRepairReport` and `ReductionReport` on purpose:
 * lifecycle repair removes what is INVALID, reduction bounds what is LARGE, and
 * compaction replaces a settled span with a bounded summary. Three different
 * operations with three different correctness arguments, and merging them would
 * make the diagnostics unable to say which one ran.
 */
export interface CompactionReport {
  /** Whether a compaction was applied on THIS assembly. */
  readonly applied: boolean;
  /** Why, enumerated. `not_attempted` when the seam was not wired. */
  readonly reason: string;
  /** Compaction generation for the conversation. 0 when none. */
  readonly generation: number;
  /** Messages the replaced span covered. */
  readonly spanLength: number;
  /** Deterministic fingerprint of the replaced span. Null when none. */
  readonly spanFingerprint: string | null;
  /** MEASURED size of the injected summary, so the budget can account for it. */
  readonly summaryTokens: number;
  /** Tokens the removed span was estimated to occupy. */
  readonly reclaimedTokens: number;
  /** Provenance of the injected block. Null when nothing was injected. */
  readonly origin: "model_generated_summary" | null;
  /** Provider+model that produced the summary. Recorded, never branched on. */
  readonly summarizedBy: string | null;
}

/** What the assembly did, for diagnostics and tests. */
export interface AssemblyProvenance {
  /** Always `direct`. Scheduler has its own path and never reaches this seam. */
  readonly engine: "direct";
  /** Where Layer C content came from. */
  readonly historySource: "submitted" | "submitted_with_stored_reference";
  /** Reconciliation against stored history. */
  readonly divergence: DivergenceReport | null;
  /** Structural repair performed by the lifecycle pruner. */
  readonly lifecycleRepair: LifecycleRepairReport | null;
  /** Request-side size reduction applied before conversion. */
  readonly reduction: ReductionReport | null;
  /**
   * Phase 4 compaction. Always present once the seam exists, so a consumer never
   * has to distinguish "not attempted" from "not implemented".
   */
  readonly compaction?: CompactionReport;
  /** Measurement taken on the assembled request. */
  readonly estimate: InputSizeEstimate;
  /** Budget applied. */
  readonly budget: ContextBudget;
  /** Limit and its provenance. */
  readonly limit: ContextLimit;
  /** Final verdict. */
  readonly decision: BudgetDecision;
}

/** What the lifecycle pruner did. Kept distinct from size management (G17). */
export interface LifecycleRepairReport {
  readonly removedToolParts: number;
  readonly removedEmptyTurns: number;
  readonly preservedApprovals: number;
}

/** Request-side size reduction applied to tool/MCP output. */
export interface ReductionReport {
  /** Tool/MCP result parts that were reduced. */
  readonly reducedParts: number;
  /** Characters removed by reduction. */
  readonly removedChars: number;
  /** Parts whose reduction left them too large to admit. */
  readonly droppedParts: number;
}

/**
 * Why a reduction mechanism did or did not shrink this request.
 *
 * Every value is a reason the system can actually observe. Nothing here is
 * speculative: each maps to a real outcome from `reduceToolResults` or a real
 * `CompactionReport.reason`.
 */
export type ReductionReason =
  /** It ran and shrank the request. */
  | "applied"
  /** It ran (or was applicable) and this request has nothing of that shape. */
  | "no_reducible_content"
  /** Compaction's trigger threshold was not reached, so it was never offered. */
  | "trigger_not_reached"
  /** Compaction was suppressed by the hysteresis latch and will run later. */
  | "hysteresis"
  /** Compaction was offered, ran, and would still not have made it fit. */
  | "would_still_exceed_budget"
  /** The span to compact exceeds the summariser's one-call input capacity. */
  | "span_exceeds_summarizer_capacity"
  /** There is no settled span that may be compacted. */
  | "no_compactable_span"
  /** The candidate span is smaller than the summary that would replace it. */
  | "span_too_small_to_compact"
  /** A summary was planned but would not have reclaimed enough to matter. */
  | "summary_would_not_reclaim_enough"
  /** Compaction is configured off for this request. */
  | "disabled"
  /** The mechanism does not apply to this request's shape. */
  | "not_eligible"
  /** The mechanism ran and failed, or lost a race it could not resolve. */
  | "failed"
  /** A mechanism exists whose outcome this build does not classify. */
  | "unknown";

/**
 * One reduction mechanism's disposition for one request.
 *
 * ## Why exactly two states
 *
 * The governing distinction for F-A is **"nothing left to try" vs "nothing was
 * offered"**, and that — not the mechanism's identity, and not a bag of booleans —
 * is the axis the budget gate needs. So the union has two members and the reason
 * carries the detail.
 *
 * - `exhausted` — this mechanism is done for this request. It applied and gave
 *   everything it can (`applied`), or it was applicable and has nothing left to
 *   take (`no_reducible_content`, `would_still_exceed_budget`,
 *   `span_exceeds_summarizer_capacity`, …). Nothing further is available HERE.
 * - `withheld` — a mechanism that could have helped was deliberately not used:
 *   the hysteresis latch, compaction being configured off, or a failure. The
 *   request is therefore sent rather than rejected, because the policy choice not
 *   to compact must not be converted into a hard failure by the budget gate.
 *
 * `exhausted` and `withheld` are mutually exclusive by construction, so
 * "exhausted AND withheld" cannot be represented and cannot be misread.
 */
export type MechanismOutcome =
  | { readonly kind: "exhausted"; readonly reason: ReductionReason }
  | { readonly kind: "withheld"; readonly reason: ReductionReason };

/**
 * Every size-reduction mechanism's disposition for one assembled request.
 *
 * A fixed record rather than a list, because the two mechanisms are known and each
 * is reported separately in diagnostics. An unknown mechanism cannot be silently
 * dropped the way an unclaimed category could.
 */
export interface ReductionRecord {
  /** `reduceToolResults`: tool/MCP output and reasoning. Always runs. */
  readonly toolResults: MechanismOutcome;
  /** Phase 4 compaction. Only offered when a caller wires the seam. */
  readonly compaction: MechanismOutcome;
}

/**
 * The budget verdict for one assembled request.
 *
 * ## Why `"reduce"` is gone
 *
 * It was returned in four of seven decision scenarios and **no consumer acted on
 * it** — every consumer branched on `"reject"` alone, so a `"reduce"` verdict
 * meant "send it anyway" while claiming a reduction that never happened. That is
 * the F-A defect.
 *
 * Reduction is an EARLIER STAGE, not a verdict: `reduceToolResults` and compaction
 * both run before this decision, and {@link ReductionRecord} says what they
 * achieved. So the verdict is only ever "send it" or "do not send it", and both
 * mean exactly what they say. An unhandled verdict is now unrepresentable.
 */
export type BudgetDecision =
  | {
      readonly action: "accept";
      readonly headroomTokens: number;
      /** What each reduction mechanism did, for diagnostics and audit. */
      readonly reduction: ReductionRecord;
    }
  | {
      readonly action: "reject";
      /**
       * `over_limit` — the estimate band proves it is over at its densest end.
       * `reduction_exhausted` — the band cannot rule it out, but the point estimate
       *   is over and nothing safe is left to try.
       */
      readonly reason: "over_limit" | "reduction_exhausted";
      readonly overBy: number;
      readonly reduction: ReductionRecord;
    };

/**
 * The assembled Direct model request, ready for `streamText`.
 *
 * The three layers are separate fields on purpose. A consumer that needs
 * "the context" must say which layer it means.
 */
export interface AssembledContext {
  readonly layerA: InstructionsLayer;
  readonly layerB: ToolDefinitionLayer;
  readonly layerC: MessagesLayer;
  /** Converted model messages, ready for `streamText({ messages })`. */
  readonly modelMessages: readonly ModelMessage[];
  readonly provenance: AssemblyProvenance;
}

/**
 * Phase 4 compaction seam, as supplied by the caller.
 *
 * Absent means "this assembly does not compact", which is the default for every
 * caller that has not opted in. Supplying it is the ONLY way compaction can run,
 * so an unwired seam cannot compact by accident.
 *
 * Every collaborator is injected — the summariser model, the persistence
 * function, the id source, the clock — so the seam has no hidden entropy and no
 * provider knowledge of its own.
 *
 * NOTE what is NOT here: `usableInputTokens` and `summarizerInputTokens`. The
 * trigger must use the actual Phase 2 budget and the capacity check must use the
 * model's actual capacity; letting the caller supply either would make those
 * requirements unenforceable. The seam resolves them. See `CompactionPhaseInput`.
 */
export interface CompactionSeam {
  /** Policy: trigger, hysteresis, tail floor, summary bounds. */
  readonly policy: import("./compaction/contract").CompactionPolicy;
  /** The durable record for this conversation, when one exists. */
  readonly existingRecord: import("./compaction/contract").CompactionRecord | undefined;
  /** Persists a record. Returns what is actually stored after any race. */
  readonly persist: (
    record: import("./compaction/contract").CompactionRecord,
  ) => import("./compaction/contract").CompactionRecord | undefined;
  /** Model used to produce summaries. Injected: this seam is provider-agnostic. */
  readonly summarizerModel: LanguageModel;
  /** Identifier recorded as the summariser. */
  readonly summarizedBy: string;
  /** Deterministic id source. */
  readonly nextCompactionId: (generation: number) => string;
  /** Clock source, injected for determinism. */
  readonly now: () => number;
  /** Abort signal for the summarisation attempt. */
  readonly signal?: AbortSignal | undefined;
  /** Wall-clock ceiling for one summarisation attempt. */
  readonly timeoutMs: number;
  /**
   * Releases the durable hysteresis latch.
   *
   * Called by the seam when measured usage has fallen back below the release
   * fraction. Optional: a caller with no latch store simply never clears it, and
   * compaction stays latched for the conversation's life.
   */
  readonly releaseLatch?: (() => void) | undefined;
}

/** Input to the internal compaction phase: the seam plus the resolved figures. */
export interface CompactionPhaseInput {
  readonly conversationId: string | undefined;
  readonly messages: UIMessage[];
  readonly seam: CompactionSeam | undefined;
  /** Resolved by the seam from the Phase 2 budget. Never caller-supplied. */
  readonly usableInputTokens: number | undefined;
  /**
   * Tokens compaction cannot reclaim: measured Layer A plus Layer B.
   *
   * `usableInputTokens` budgets the WHOLE request, so the trigger must compare the
   * whole request against it. Passing only Layer C understates pressure by the cost
   * of the tool definitions — ~10 745 tokens for the native set alone — which made
   * the trigger fire far too late.
   *
   * Also lets the planner confirm the request will FIT after compaction, rather
   * than summarising and leaving the caller to reject anyway.
   */
  readonly fixedOverheadTokens: number;
  /**
   * The summariser's own input ceiling, in tokens — the model's CAPACITY minus its
   * summarisation reservation.
   *
   * Deliberately distinct from `usableInputTokens`. The budget is what a TURN may
   * send after the safety margin and the turn's output reservation; capacity is
   * what the MODEL can accept. The summariser reserves far less output than a turn
   * does, so it can legitimately read more than a turn may send — and deriving its
   * ceiling from the budget undershot real capacity, which testing showed refuses
   * essentially every real compaction.
   *
   * Resolved by the seam from the limit. Never caller-supplied, for the same
   * reason the trigger budget is not.
   */
  readonly summarizerInputTokens: number | undefined;
}

/** Inputs to the single Direct assembly boundary. */
export interface AssembleContextInput {
  /** Conversation id, when the request carries one. Enables reconciliation. */
  readonly conversationId: string | undefined;
  /** The browser-submitted messages. Input, not authority. */
  readonly submittedMessages: UIMessage[];
  /** Run id, used for the run-scoped tool closures. */
  readonly runId: string;
  /** Server-resolved provider. */
  readonly provider: ProviderConfig;
  /** Server-resolved model id. */
  readonly modelId: string;
  /** Server-resolved system prompt (Layer A input). */
  readonly systemPrompt: string | undefined;
  /** Per-request extra tools already built by the route (run-scoped closures). */
  readonly extraTools?: Record<string, unknown>;
  /** The terminal-output tap keyed by tool call id, when present. */
  readonly terminalTap?: (toolCallId: string, event: BashOutputEvent) => void;
  /** Signal shared with MCP tool execution. */
  readonly toolSignal: AbortSignal;
  /**
   * Phase 4 compaction seam. Omitted ⇒ no compaction.
   *
   * Omitting it is the correct default for every caller that has not opted in, and
   * is what makes the feature inert rather than silently active.
   */
  readonly compaction?: CompactionSeam;
}
