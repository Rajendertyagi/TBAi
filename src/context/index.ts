/**
 * Phase 2 context foundation - public surface.
 *
 * The seam itself (`assembleContext`) is the only entry point a caller needs.
 * Everything else is exported for tests and for the route's diagnostics, and is
 * deliberately NOT re-exported as a general-purpose "context manager" facade:
 * Phase 4 (compaction) and Phase 5 (memory) will consume this same seam, and a
 * wide surface now would invite a second assembler later.
 */

export { assembleContext, buildInstructionsLayer, buildToolLayer, logAssembly, logContextOverflow } from "./assemble";
export type { AssembleContextResult } from "./assemble";

export {
  computeBudget,
  decideBudget,
  budgetDiagnostics,
  shouldPreflightReject,
  SAFETY_MARGIN_FRACTION,
  REDUCIBLE_CATEGORIES,
  PROTECTED_CATEGORIES,
} from "./budget";

export {
  resolveContextLimit,
  resolveOutputReservation,
  describeLimitSource,
  UNKNOWN_LIMIT_CEILING,
  DEFAULT_OUTPUT_RESERVATION,
} from "./limits";

export {
  measureInstructions,
  measureToolDefinitions,
  measureMessages,
  combineEstimates,
  CHARS_PER_TOKEN_ESTIMATE,
} from "./measure";

export { reduceToolResults, REQUEST_TOOL_RESULT_MAX_CHARS, REQUEST_REDUCIBLE_CATEGORIES } from "./reduce";

export { classifyDivergence, identifyCurrentTurn, countModelVisibleParts, reconcileWithStoredHistory } from "./divergence";

export { CONTEXT_CATEGORIES } from "./types";
export type {
  AssembleContextInput,
  AssembledContext,
  AssemblyProvenance,
  BudgetDecision,
  ContextBudget,
  ContextCategory,
  ContextLimit,
  DivergenceOutcome,
  DivergenceReport,
  InputSizeEstimate,
  InstructionsLayer,
  LifecycleRepairReport,
  LimitSource,
  MessagesLayer,
  OutputReservation,
  ReductionReport,
  ToolDefinitionLayer,
} from "./types";
