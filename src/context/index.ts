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
  resolveGenerationCap,
  describeLimitSource,
  isPhase3ExperimentEligible,
  selectModelOption,
  UNKNOWN_LIMIT_CEILING,
  DEFAULT_OUTPUT_RESERVATION,
  DEFAULT_GENERATION_CAP,
  LEGACY_SOURCE,
} from "./limits";

export {
  measureInstructions,
  measureToolDefinitions,
  measureMessages,
  combineEstimates,
  CHARS_PER_TOKEN_ESTIMATE,
} from "./measure";

export {
  reduceToolResults,
  describeToolResultReduction,
  reductionSavings,
  REQUEST_TOOL_RESULT_MAX_CHARS,
  REQUEST_REDUCIBLE_CATEGORIES,
  REASONING_RETAIN_LAST_MESSAGES,
  REQUEST_REASONING_MAX_CHARS,
} from "./reduce";

// Phase 5 — memory to model context. The provider boundary and every decision
// TBAi owns over it. See `src/context/memory/contract.ts` for the boundary.
export {
  boundMemoryContent,
  countExclusions,
  createLocalMemoryProvider,
  createMemoryQueryRunner,
  evaluateMemorySafety,
  isValidCandidate,
  localMemoryProvider,
  memoryBudgetTokens,
  memoryDiagnostics,
  memoryEnabled,
  MEMORY_ENV,
  rankCandidates,
  renderMemoryBlock,
  runMemoryPhase,
  selectMemories,
  LOCAL_MEMORY_PROVIDER_ID,
  MEMORY_BUDGET_CEILING_TOKENS,
  MEMORY_BUDGET_FRACTION,
  MEMORY_MAX_CANDIDATES,
  MEMORY_MAX_CHARS,
  MEMORY_MAX_SELECTED,
  MEMORY_MESSAGE_ID_PREFIX,
} from "./memory";
export type {
  ExcludedMemory,
  MemoryCandidate,
  MemoryCandidateProvider,
  MemoryCandidateQuery,
  MemoryExclusionReason,
  MemoryPhaseInput,
  MemoryPhaseResult,
  MemoryReport,
  MemorySafetyReason,
  MemorySafetyVerdict,
  MemorySeam,
  SelectedMemory,
} from "./memory";

export { classifyDivergence, identifyCurrentTurn, countModelVisibleParts, reconcileWithStoredHistory } from "./divergence";

// Tier 2 — the universal assembly ceiling. Exported so the route can render a
// breach as a distinct failure and so tests can assert the constant directly.
export { evaluateTier2, TIER_2_MAX_TOKENS, ASSEMBLY_LIMIT_CODE } from "./tier2";
export type { Tier2Breach, Tier2Verdict } from "./tier2";

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
  GenerationCap,
  InputSizeEstimate,
  InstructionsLayer,
  LifecycleRepairReport,
  LimitSource,
  MechanismOutcome,
  MessagesLayer,
  OutputReservation,
  ReductionRecord,
  ReductionReason,
  ReductionReport,
  ToolDefinitionLayer,
} from "./types";
