/**
 * Phase 5 — deterministic candidate selection.
 *
 * The approved order, and the reason it is that order:
 *
 * ```text
 * validate → rank → budget-select → safety-screen → selected set
 * ```
 *
 * Safety runs after budget selection because that is the locked order, and it is
 * still an absolute guarantee: nothing reaches the model that the screen rejects,
 * whatever the budget allowed in. The cost is that a rejected memory briefly
 * occupies budget, so an all-unsafe candidate set can select fewer memories than
 * the budget would have allowed. That is a deliberate trade of a little recall for
 * strict conformance to the approved flow, and it never produces an injection.
 *
 * Every step is pure. Same candidates + same budget ⇒ same selection, which is
 * what Phase 3's stable prefix depends on.
 */

import { CHARS_PER_TOKEN_ESTIMATE } from "../measure";
import { evaluateMemorySafety } from "./safety";
import {
  isValidCandidate,
  MEMORY_MAX_CANDIDATES,
  MEMORY_MAX_CHARS,
  MEMORY_MAX_SELECTED,
  rankCandidates,
  type ExcludedMemory,
  type MemoryCandidate,
  type MemoryExclusionReason,
  type SelectedMemory,
} from "./contract";

/** Truncation marker appended to a delivery-bounded memory. Never to storage. */
const TRUNCATION_NOTICE = "\n\n[memory truncated for context delivery]";

/** Estimated tokens for `chars`, using the shared estimator. Never a local divisor. */
function estimateTokens(chars: number): number {
  return chars <= 0 ? 0 : Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

/** Bound one memory's delivery text. Storage is never modified. */
export function boundMemoryContent(content: string): { text: string; truncated: boolean } {
  if (content.length <= MEMORY_MAX_CHARS) return { text: content, truncated: false };
  return { text: content.slice(0, MEMORY_MAX_CHARS) + TRUNCATION_NOTICE, truncated: true };
}

export interface SelectionOutcome {
  readonly selected: readonly SelectedMemory[];
  readonly excluded: readonly ExcludedMemory[];
  readonly estimatedTokens: number;
}

/**
 * Select memories for one request.
 *
 * The provider's `limit` is treated as a request, not a guarantee: this function
 * enforces {@link MEMORY_MAX_CANDIDATES} and {@link MEMORY_MAX_SELECTED} itself,
 * over the ranked order, so provider return order can never influence the result.
 *
 * @param candidates Candidates exactly as the provider returned them, in any order.
 * @param budgetTokens The memory budget from `memoryBudgetTokens`.
 */
export function selectMemories(
  candidates: readonly MemoryCandidate[],
  budgetTokens: number,
): SelectionOutcome {
  const excluded: ExcludedMemory[] = [];

  // 1. Validate. A malformed candidate is dropped before it can influence order.
  const valid: MemoryCandidate[] = [];
  for (const candidate of candidates) {
    if (isValidCandidate(candidate)) valid.push(candidate);
    else excluded.push({ id: String(candidate?.id ?? "unknown"), reason: "invalid" });
  }

  // 2. Rank. Total order, so nothing downstream depends on provider iteration.
  const ranked = rankCandidates(valid);

  // 3. Budget-select, then 4. safety-screen the survivors.
  //
  // Both ceilings are enforced HERE, over the ranked order, rather than being
  // trusted to the provider. The query carries `limit`, but a request is not a
  // guarantee: a provider that returns more must not be able to widen the work
  // TBAi does. Because the cap is applied to `ranked` — never to the provider's
  // own order — the subset that survives is still TBAi's decision, which is the
  // ownership property this file exists to hold.
  const selected: SelectedMemory[] = [];
  let used = 0;
  let considered = 0;
  const overBudget = new Set<string>();
  const overCount = new Set<string>();

  for (const candidate of ranked) {
    if (considered >= MEMORY_MAX_CANDIDATES || selected.length >= MEMORY_MAX_SELECTED) {
      overCount.add(candidate.id);
      continue;
    }
    considered += 1;
    const bounded = boundMemoryContent(candidate.content);
    const tokens = estimateTokens(bounded.text.length);
    if (used + tokens > budgetTokens) {
      // Lower-ranked memories are smaller-or-equal in practice only by chance, so
      // each is judged on its own cost rather than stopping at the first overflow.
      overBudget.add(candidate.id);
      continue;
    }
    used += tokens;
    selected.push({
      id: candidate.id,
      content: bounded.text,
      truncated: bounded.truncated,
      createdAt: candidate.createdAt,
      providerId: candidate.providerId,
      estimatedTokens: tokens,
    });
  }

  const screenPass: SelectedMemory[] = [];
  for (const memory of selected) {
    const verdict = evaluateMemorySafety(memory.content);
    if (verdict.unsafe) {
      excluded.push({ id: memory.id, reason: "safety", safetyReason: verdict.reason });
      continue;
    }
    screenPass.push(memory);
  }

  // Exclusion order follows rank order, so diagnostics read consistently.
  const byRank = new Map(ranked.map((candidate, index) => [candidate.id, index]));
  for (const candidate of ranked) {
    if (overBudget.has(candidate.id)) excluded.push({ id: candidate.id, reason: "over_budget" });
    else if (overCount.has(candidate.id)) excluded.push({ id: candidate.id, reason: "max_selected" });
  }
  excluded.sort((a, b) => (byRank.get(a.id) ?? 0) - (byRank.get(b.id) ?? 0));

  return {
    selected: screenPass,
    excluded,
    estimatedTokens: screenPass.reduce((total, memory) => total + memory.estimatedTokens, 0),
  };
}

/** Count exclusions by reason, for diagnostics. */
export function countExclusions(excluded: readonly ExcludedMemory[]): Record<MemoryExclusionReason, number> {
  const counts: Record<MemoryExclusionReason, number> = {
    invalid: 0,
    safety: 0,
    over_budget: 0,
    max_selected: 0,
  };
  for (const entry of excluded) counts[entry.reason] += 1;
  return counts;
}