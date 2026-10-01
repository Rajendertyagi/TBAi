/**
 * Phase 5 — the TBAi-owned memory contract.
 *
 * ## What this file is
 *
 * The vocabulary and the pure decisions. A provider supplies candidates; TBAi
 * validates, ranks, budgets, screens for safety and decides. Nothing here reads a
 * database, calls a model, or mutates state, so every rule below is directly
 * testable and the whole selection is reproducible from its inputs.
 *
 * ## The three representations, kept separate
 *
 * 1. **Persisted application memory** — a row in TBAi SQLite. Owned by
 *    `memoryService`. Never referenced from here.
 * 2. **Provider candidate** ({@link MemoryCandidate}) — what a provider offers.
 *    A provider may be TBAi's own local store or, later, something external.
 * 3. **TBAi-selected memory** ({@link SelectedMemory}) — what actually reached
 *    the budget after every filter. Only this is ever rendered to the model.
 *
 * They are separate types on purpose. Collapsing them would let a provider's idea
 * of a memory leak into the decision TBAi owns, which is precisely the boundary
 * Phase 2 (L3–L7) established.
 */

/** Id prefix for the injected block. Distinguishes injected memory from conversation. */
export const MEMORY_MESSAGE_ID_PREFIX = "tbai-memory:";

/** Fraction of the usable input budget memory may occupy before the fixed ceiling. */
export const MEMORY_BUDGET_FRACTION = 0.1;

/** Absolute ceiling on memory, however large the model's window is. */
export const MEMORY_BUDGET_CEILING_TOKENS = 16_000;

/** Maximum characters of a single memory rendered to the model. Storage is untouched. */
export const MEMORY_MAX_CHARS = 4_000;

/** Maximum memories selected into one request. */
export const MEMORY_MAX_SELECTED = 8;

/** Maximum candidates a provider is asked for, and honoured, per request. */
export const MEMORY_MAX_CANDIDATES = 50;

// ─── Provider-owned ──────────────────────────────────────────────────────────

/** What TBAi asks a provider for. */
export interface MemoryCandidateQuery {
  /** Conversation the turn belongs to, when there is one. Providers scope on this. */
  readonly conversationId: string | undefined;
  /** The current user turn's text. Advisory context only — never an authority. */
  readonly userText: string;
  /** Hard cap on returned candidates. A provider may return fewer, never more. */
  readonly limit: number;
}

/** One memory a provider offers for consideration. */
export interface MemoryCandidate {
  /** Stable, durable identity within the provider. Also TBAi's final tie-breaker. */
  readonly id: string;
  readonly content: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** Epoch milliseconds. */
  readonly updatedAt: number;
  /** Which provider offered this, recorded in provenance. */
  readonly providerId: string;
  /**
   * Optional provider relevance.
   *
   * **Deliberately ignored.** See {@link rankCandidates}. A provider score is not
   * comparable across providers, so honouring it would make which memories reach
   * the model depend on which provider answered — and would put a
   * non-deterministic, provider-owned value in front of TBAi's ordering.
   */
  readonly advisoryScore?: number;
}

/**
 * The retrieval port. One read operation; CRUD is deliberately not here.
 *
 * Phase 5 locked: application-memory CRUD stays separate from this contract, and
 * the provider boundary admits future providers without touching selection.
 */
export interface MemoryCandidateProvider {
  readonly providerId: string;
  listCandidates(query: MemoryCandidateQuery): Promise<readonly MemoryCandidate[]>;
}

// ─── TBAi-owned ──────────────────────────────────────────────────────────────

/** Why a candidate did not reach the model. Reported, never guessed at. */
export type MemoryExclusionReason =
  /** Failed structural validation (no id, empty content, non-finite timestamps). */
  | "invalid"
  /** Withheld by the deterministic safety check. See `safety.ts`. */
  | "safety"
  /** Did not fit the remaining memory budget. */
  | "over_budget"
  /** Ranked below the selected set. */
  | "max_selected";

/** A memory that passed every filter and is budgeted into this request. */
export interface SelectedMemory {
  readonly id: string;
  /** Delivery text, already bounded to {@link MEMORY_MAX_CHARS}. */
  readonly content: string;
  /** True when delivery text was cut. Storage is never modified. */
  readonly truncated: boolean;
  readonly createdAt: number;
  readonly providerId: string;
  /** Measured with the shared estimator. Never a second chars/token constant. */
  readonly estimatedTokens: number;
}

/** A candidate that did not reach the model, with the reason it did not. */
export interface ExcludedMemory {
  readonly id: string;
  readonly reason: MemoryExclusionReason;
  /** Present only for `safety`. A stable token, never the pattern source. */
  readonly safetyReason?: string;
}

/** Everything a caller can know about what memory did to a request. */
export interface MemoryReport {
  /** A provider seam was supplied. False ⇒ the phase did not run at all. */
  readonly attempted: boolean;
  /** Candidates the provider returned, after the query cap. */
  readonly candidateCount: number;
  /** Candidates that failed structural validation. */
  readonly invalidCount: number;
  /** Withheld by the safety check. */
  readonly safetyExcludedCount: number;
  /** Passed safety but did not fit. */
  readonly overBudgetCount: number;
  /** Ranked out by {@link MEMORY_MAX_SELECTED}. */
  readonly overCountCount: number;
  /** What was actually injected. */
  readonly selected: readonly SelectedMemory[];
  /** Why the rest did not make it. Diagnostic only; never rendered. */
  readonly excluded: readonly ExcludedMemory[];
  /** Sum of `selected[].estimatedTokens`. */
  readonly estimatedTokens: number;
  /** The budget the selection was made against. */
  readonly budgetTokens: number;
  /** Message id of the injected block, when one was injected. */
  readonly blockId: string | null;
  /** Failure reason when the phase degraded. `null` on a clean run. */
  readonly failure: string | null;
}

/**
 * The memory budget for one request.
 *
 * `min(floor(usableInputTokens × 0.10), 16_000)`.
 *
 * ## What this number does and does not guarantee
 *
 * It bounds how much memory is *attempted*. It does **not** by itself reserve
 * context for the current turn: Layer A + Layer B can legitimately consume most
 * of a small window. What guarantees current-task priority is the separate
 * budget-yield ordering — memory is dropped before current-turn content, enforced
 * by Phase 2's decision over the combined estimate, not by this fraction.
 */
export function memoryBudgetTokens(usableInputTokens: number | undefined): number {
  if (usableInputTokens === undefined || !Number.isFinite(usableInputTokens) || usableInputTokens <= 0) {
    return 0;
  }
  return Math.min(Math.floor(usableInputTokens * MEMORY_BUDGET_FRACTION), MEMORY_BUDGET_CEILING_TOKENS);
}

/** Structural validation. A candidate that fails this never reaches ranking. */
export function isValidCandidate(candidate: MemoryCandidate): boolean {
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.content === "string" &&
    candidate.content.trim().length > 0 &&
    Number.isFinite(candidate.createdAt) &&
    Number.isFinite(candidate.updatedAt)
  );
}

/**
 * Deterministic ordering: newest first, then id ascending.
 *
 * Both keys are total — `createdAt` then `id` — so no two candidates can tie and
 * the order never depends on provider iteration, database row order, or object
 * key order. That totality is the property Phase 3's stable prefix depends on.
 *
 * A provider's `advisoryScore` is deliberately NOT a key. See
 * {@link MemoryCandidate.advisoryScore}.
 */
export function rankCandidates(candidates: readonly MemoryCandidate[]): MemoryCandidate[] {
  return [...candidates].sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}