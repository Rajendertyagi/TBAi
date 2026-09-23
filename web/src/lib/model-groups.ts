import type { ModelOption, ProviderConfig } from "../types";

export interface ModelGroup {
  providerId: string;
  providerName: string;
  isDefault: boolean;
  models: ModelOption[];
}

/** Group every provider's models under its name (single source for the picker). */
export function buildModelGroups(
  providers: ProviderConfig[],
  activeProviderId: string | null,
): ModelGroup[] {
  return providers.map((p) => ({
    providerId: p.id,
    providerName: p.name,
    isDefault: p.id === activeProviderId,
    models:
      p.models?.length
        ? p.models
        : p.model
          ? [{ id: p.model, provider: p.type, label: p.model }]
          : [],
  }));
}

/** Filter groups by provider name, model id, or model label (case-insensitive). */
export function filterModelGroups(
  groups: ModelGroup[],
  query: string,
): ModelGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const out: ModelGroup[] = [];
  for (const g of groups) {
    const models = g.models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        (m.label ?? "").toLowerCase().includes(q) ||
        g.providerName.toLowerCase().includes(q),
    );
    if (models.length > 0) out.push({ ...g, models });
  }
  return out;
}

/** Resolve which (provider, model) a one-shot model id belongs to. */
export function resolveModelOwner(
  groups: ModelGroup[],
  modelId: string,
): { providerId: string; modelId: string } | null {
  for (const g of groups) {
    if (g.models.some((m) => m.id === modelId)) {
      return { providerId: g.providerId, modelId };
    }
  }
  return null;
}

/** Find a model option by bare id across groups (first match wins). */
export function findModelOption(
  groups: readonly ModelGroup[],
  modelId: string,
): ModelOption | undefined {
  for (const g of groups) {
    const found = g.models.find((m) => m.id === modelId);
    if (found) return found;
  }
  return undefined;
}
