/**
 * Direct model/reasoning selection routing (Fix 3).
 *
 * A selection made on an EXISTING conversation belongs to that conversation's
 * `custom` (SQLite source of truth) and must never touch the global one-shot
 * override — otherwise one chat's pick would change another chat's next send.
 * The global one-shot override is reserved for the single `chat:new` draft,
 * whose captured configuration is carried into the row at materialization.
 *
 * Pure and dependency-free so the routing can be tested without rendering the
 * Radix dropdowns in DirectChips.
 */

export interface DirectSelectionCustom {
  providerId?: string | null;
  modelId?: string | null;
  reasoningLevel?: string | null;
  engine?: "direct" | "opencode";
}

export interface ModelSelectionTargets {
  /** Set the global one-shot provider/model override (draft only). */
  setOneShotProviderModel(providerId: string, modelId: string): void;
  /** Persist to this conversation's custom (existing conversation only). */
  updateCustom(custom: Record<string, unknown>): void;
}

export interface ReasoningSelectionTargets<TLevel extends string> {
  /** Set the global one-shot reasoning override (draft only). */
  setOneShotReasoning(level: TLevel): void;
  /** Persist to this conversation's custom (existing conversation only). */
  updateCustom(custom: Record<string, unknown>): void;
}

/** Route a model pick to the draft one-shot or the conversation's custom. */
export function applyDirectModelSelection(args: {
  isDraft: boolean;
  custom: DirectSelectionCustom;
  providerId: string;
  modelId: string;
  targets: ModelSelectionTargets;
}): void {
  if (args.isDraft) {
    args.targets.setOneShotProviderModel(args.providerId, args.modelId);
    return;
  }
  args.targets.updateCustom({
    ...args.custom,
    providerId: args.providerId,
    modelId: args.modelId,
  });
}

/** Route a reasoning pick to the draft one-shot or the conversation's custom. */
export function applyDirectReasoningSelection<TLevel extends string>(args: {
  isDraft: boolean;
  custom: DirectSelectionCustom;
  level: TLevel;
  targets: ReasoningSelectionTargets<TLevel>;
}): void {
  if (args.isDraft) {
    args.targets.setOneShotReasoning(args.level);
    return;
  }
  args.targets.updateCustom({ ...args.custom, reasoningLevel: args.level });
}
