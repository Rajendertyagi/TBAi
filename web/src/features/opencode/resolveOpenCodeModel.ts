import { useMemo } from "react";
import type { OpenCodeDefaultModel, OpenCodeModelOption } from "./useOpenCodeCapabilities";

/**
 * Resolves a persisted OpenCode model value into the runtime's
 * `{ providerID, modelID }` reference. Stored values may be `provider/model`
 * qualified or a bare model id; matching is done against the live model list so
 * the provider is always the canonical one the OpenCode server reports.
 *
 * ## Why there is a default at all
 *
 * When nothing is stored this used to return `undefined`, on the stated
 * assumption that "the server default applies". It does not: the session is
 * created with no model bound, the composer shows "Select a model", and every
 * turn does nothing. The server advertises a default precisely for this case, so
 * it is now resolved here and sent explicitly. Provider-neutral and
 * server-driven — nothing about which model is chosen is decided in this file.
 *
 * A reader who HAS chosen keeps their choice; the default is only a fallback.
 */
export function resolveOpenCodeModel(
  stored: string | null | undefined,
  models: OpenCodeModelOption[],
  defaultModel?: OpenCodeDefaultModel,
): { providerID: string; modelID: string } | undefined {
  if (!stored) {
    if (!defaultModel) return undefined;
    // Prefer the live list's canonical spelling of the same model, so the
    // reference we send matches exactly what the catalogue calls it. A default
    // the list does not carry is still usable — the server named it itself.
    const live = models.find(
      (m) => m.id === defaultModel.modelID || `${m.providerID}/${m.id}` === defaultModel.modelID,
    );
    return live
      ? { providerID: live.providerID, modelID: live.id }
      : { providerID: defaultModel.providerID, modelID: defaultModel.modelID };
  }
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
  defaultModel?: OpenCodeDefaultModel,
) {
  return useMemo(() => resolveOpenCodeModel(stored, models, defaultModel), [stored, models, defaultModel]);
}
