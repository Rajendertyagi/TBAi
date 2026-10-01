/**
 * Phase 5 — memory to model context: public surface.
 *
 * TBAi owns the boundary. A provider supplies candidates; TBAi validates, ranks,
 * budgets, screens and injects. This module is the whole of that, and it contains
 * no database access, no model call and no Phase 4 change.
 */

export {
  memoryBudgetTokens,
  isValidCandidate,
  rankCandidates,
  MEMORY_BUDGET_CEILING_TOKENS,
  MEMORY_BUDGET_FRACTION,
  MEMORY_MAX_CANDIDATES,
  MEMORY_MAX_CHARS,
  MEMORY_MAX_SELECTED,
  MEMORY_MESSAGE_ID_PREFIX,
  type ExcludedMemory,
  type MemoryCandidate,
  type MemoryCandidateProvider,
  type MemoryCandidateQuery,
  type MemoryExclusionReason,
  type MemoryReport,
  type SelectedMemory,
} from "./contract";

export { evaluateMemorySafety, type MemorySafetyReason, type MemorySafetyVerdict } from "./safety";

export { memoryEnabled, MEMORY_ENV } from "./enablement";

export { boundMemoryContent, countExclusions, selectMemories, type SelectionOutcome } from "./select";

export {
  createLocalMemoryProvider,
  createMemoryQueryRunner,
  localMemoryProvider,
  LOCAL_MEMORY_PROVIDER_ID,
} from "./provider";

export {
  memoryDiagnostics,
  renderMemoryBlock,
  runMemoryPhase,
  type MemoryPhaseInput,
  type MemoryPhaseResult,
  type MemorySeam,
} from "./seam";