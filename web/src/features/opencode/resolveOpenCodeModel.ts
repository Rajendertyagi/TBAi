import { useMemo } from "react";
import type { OpenCodeModelOption } from "./useOpenCodeCapabilities";

/**
 * Resolves a persisted OpenCode model value into the runtime's
 * `{ providerID, modelID }` reference. Stored values may be `provider/model`
 * qualified or a bare model id; matching is done against the live model list so
 * the provider is always the canonical one the OpenCode server reports. Returns
 * undefined when the value is unset or unknown, letting the server default apply
 * only in that genuinely-unconfigured case.
 */
export function resolveOpenCodeModel(
  stored: string | null | undefined,
  models: OpenCodeModelOption[],
): { providerID: string; modelID: string } | undefined {
  if (!stored) return undefined;
  const match =
    models.find((m) => `${m.providerID}/${m.id}` === stored) ??
    models.find((m) => m.id === stored);
  if (!match) {
    // Unknown to the live list but explicitly configured: trust the stored
    // provider-qualified form when present so a valid pick still resolves.
    const [providerID, modelID] = stored.split("/");
    return providerID
      ? { providerID, modelID: modelID ?? providerID }
      : undefined;
  }
  return { providerID: match.providerID, modelID: match.id };
}

/** Memoized variant for use inside a component (stable on input changes). */
export function useResolvedOpenCodeModel(
  stored: string | null | undefined,
  models: OpenCodeModelOption[],
) {
  return useMemo(() => resolveOpenCodeModel(stored, models), [stored, models]);
}
