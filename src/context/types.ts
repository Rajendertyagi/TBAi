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

import type { ModelMessage, ToolSet, UIMessage } from "ai";
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

/** How a context-window limit was determined. Never collapsed to a number alone. */
export type LimitSource =
  /** A real figure from a provider response or the provider registry. */
  | "model_reported"
  /** A figure the user configured. */
  | "configured"
  /** A conservative fallback. NOT a claim about the model. */
  | "default"
  /** No figure available. The budget must handle this explicitly. */
  | "unknown";

export interface ContextLimit {
  /** Maximum input tokens, when known. Undefined when `source` is `unknown`. */
  readonly maxInputTokens: number | undefined;
  /** Provenance. A defaulted or unknown limit is never reported as known. */
  readonly source: LimitSource;
  /** Provider the limit was read for. */
  readonly providerType: ProviderConfig["type"] | "unknown";
  /** Model id the limit was read for. */
  readonly modelId: string;
}

/**
 * Output reservation - the input budget held back so a generation has room to
 * finish. Phase 1 established Direct reserved nothing (F5), which let a request
 * occupy the whole window and leave no room to answer.
 */
export interface OutputReservation {
  /** Tokens reserved for completion. Always > 0. */
  readonly tokens: number;
  /** How the reservation was chosen. */
  readonly source: "model_reported" | "default";
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
  /** Room left for the response. */
  readonly outputReservation: OutputReservation;
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

/** The budget verdict for one assembled request. */
export type BudgetDecision =
  | { readonly action: "accept"; readonly headroomTokens: number }
  | {
      readonly action: "reduce";
      /** Categories reduced, in the order they were reduced. */
      readonly reduced: readonly ContextCategory[];
      readonly afterTokens: number;
    }
  | {
      readonly action: "reject";
      readonly reason: "over_limit" | "limit_unknown_and_over_ceiling";
      readonly overBy: number;
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
}
