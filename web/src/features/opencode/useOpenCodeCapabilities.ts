import { useEffect, useState } from "react";

export interface OpenCodeAgentOption {
  id: string;
  name: string;
  description?: string;
}

export interface OpenCodeModelOption {
  id: string;
  name: string;
  providerID: string;
  family?: string;
  /** Thinking levels (OpenCode "variants") the model exposes. Empty = no thinking control. */
  variants: string[];
}

export interface OpenCodeCapabilities {
  agents: OpenCodeAgentOption[];
  models: OpenCodeModelOption[];
}

/**
 * A thinking-level option the OpenCode thinking chip renders. `id` is ""
 * (empty string = "Default" = omit the variant field) or a live variant id.
 */
export interface OpenCodeThinkingOption {
  id: string;
  label: string;
}

/**
 * Builds the thinking options list for a given model: always a "Default"
 * entry (= omit the variant), followed by the model's live variant ids.
 * Returns an empty list when the model has no variants — the chip hides.
 */
export function buildOpenCodeThinkingOptions(
  model: OpenCodeModelOption | undefined,
): OpenCodeThinkingOption[] {
  if (!model || model.variants.length === 0) return [];
  return [
    { id: "", label: "Default" },
    ...model.variants.map((v) => ({ id: v, label: v })),
  ];
}

/**
 * Live-queries the managed OpenCode server for its available agents and models.
 * Pass `enabled = false` (e.g. when the Direct engine is selected) to skip the
 * request entirely so the server is not started unnecessarily. Every value comes
 * from the server — nothing is hardcoded.
 */
export function useOpenCodeCapabilities(enabled = true) {
  const [agents, setAgents] = useState<OpenCodeAgentOption[]>([]);
  const [models, setModels] = useState<OpenCodeModelOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setAgents([]);
      setModels([]);
      setIsLoading(false);
      setError(null);
      return;
    }
    // Abortable: the request can outlive its owner (route change while the
    // managed server is still booting). Aborting frees the client; the
    // server singleton keeps whatever state it reached by design.
    const controller = new AbortController();
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    fetch("/api/opencode/capabilities", { signal: controller.signal })
      .then((r) => r.json())
      .then((data: OpenCodeCapabilities) => {
        if (cancelled) return;
        setAgents(data.agents ?? []);
        // Normalize: older server responses may omit `variants` on model rows.
        setModels((data.models ?? []).map((m) => ({ ...m, variants: m.variants ?? [] })));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // Deliberate aborts are owner teardown, not failures: stay silent so
        // no error flashes for a navigation the user already left.
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled]);

  return { agents, models, isLoading, error };
}
