export interface OpenCodeSelectionState {
  readonly agent: string;
  readonly model: string;
  readonly variant: string;
}

export interface OpenCodeSelectionPatch {
  readonly opencodeAgent?: string | null;
  readonly opencodeModel?: string | null;
  readonly opencodeVariant?: string | null;
}

/** Merges a partial persisted chip update into the complete selection state. */
export function mergeOpenCodeSelectionState(
  current: OpenCodeSelectionState,
  patch: OpenCodeSelectionPatch,
): OpenCodeSelectionState {
  return {
    agent: patch.opencodeAgent === undefined ? current.agent : patch.opencodeAgent ?? "",
    model: patch.opencodeModel === undefined ? current.model : patch.opencodeModel ?? "",
    variant:
      patch.opencodeVariant === undefined
        ? current.variant
        : patch.opencodeVariant ?? "",
  };
}
