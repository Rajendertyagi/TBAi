import { create } from "zustand";
import { useAvailabilityStore } from "../availability/availabilityStore";
import { apiFetch } from "../../lib/platform";

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
  /**
   * Host-reported context/output limits. Absent when the server omits them —
   * the context ring falls back to the configured default window.
   */
  limit?: { context: number; output: number };
}

/**
 * The model the server offers when the reader has not chosen one.
 *
 * Descriptor only. The server's own default response carries the provider's
 * credentials in `settings`; the backend projects those out before this point,
 * and nothing re-adds them.
 */
export interface OpenCodeDefaultModel {
  readonly providerID: string;
  readonly modelID: string;
  readonly name: string;
}

export interface OpenCodeCapabilities {
  agents: OpenCodeAgentOption[];
  models: OpenCodeModelOption[];
  /** Absent when the server advertises no default. */
  defaultModel?: OpenCodeDefaultModel;
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
  // `null` is accepted as well as `undefined`: the guard below already treats a
  // missing model identically, and the model chip's catalogue lookup returns
  // `null` for an id this install does not carry. The body has always handled
  // it; only the declared type was narrower than the behaviour.
  model: OpenCodeModelOption | null | undefined,
): OpenCodeThinkingOption[] {
  if (!model || model.variants.length === 0) return [];
  return [{ id: "", label: "Default" }, ...model.variants.map((v) => ({ id: v, label: v }))];
}

/**
 * Reads the capabilities payload, turning a non-2xx response into an error.
 *
 * A failed fetch must never be read as "this install has no models": the body of
 * a 5xx proxied response is an `{ error }` object, and parsing it as a catalogue
 * would populate the picker with an authoritative-looking empty list. The
 * caller's catch keeps the previous lists, which is the honest outcome.
 *
 * @param response - The capabilities response.
 * @returns The parsed capabilities.
 * @throws Error carrying the server's message, or `HTTP <status>` when the body
 *   is not JSON.
 */
export async function readOpenCodeCapabilities(response: Response): Promise<OpenCodeCapabilities> {
  if (!response.ok) {
    let detail: string | null = null;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "error" in body && typeof body.error === "string")
        detail = body.error;
    } catch {
      // Not a JSON error envelope; the status is all we have.
    }
    throw new Error(detail ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as OpenCodeCapabilities;
}

export interface NormalizedOpenCodeCapabilities {
  agents: OpenCodeAgentOption[];
  models: OpenCodeModelOption[];
  defaultModel?: OpenCodeDefaultModel;
}

/**
 * Normalizes and validates a capabilities payload. Preserves the existing hook
 * semantics: malformed defaults are dropped, variants default to [], and only
 * well-formed positive finite limits are kept.
 */
export function normalizeOpenCodeCapabilities(
  data: OpenCodeCapabilities,
): NormalizedOpenCodeCapabilities {
  const agents = data.agents ?? [];
  const defaultModel =
    data.defaultModel &&
    typeof data.defaultModel.providerID === "string" &&
    data.defaultModel.providerID.length > 0 &&
    typeof data.defaultModel.modelID === "string" &&
    data.defaultModel.modelID.length > 0
      ? {
          providerID: data.defaultModel.providerID,
          modelID: data.defaultModel.modelID,
          name:
            typeof data.defaultModel.name === "string" && data.defaultModel.name.length > 0
              ? data.defaultModel.name
              : data.defaultModel.modelID,
        }
      : undefined;
  const models = (data.models ?? []).map((m) => ({
    ...m,
    variants: m.variants ?? [],
    // Pass through only well-formed limits; anything else stays
    // absent so the ring uses the default window.
    limit:
      m.limit &&
      typeof m.limit.context === "number" &&
      Number.isFinite(m.limit.context) &&
      m.limit.context > 0 &&
      typeof m.limit.output === "number" &&
      Number.isFinite(m.limit.output) &&
      m.limit.output > 0
        ? {
            context: Math.floor(m.limit.context),
            output: Math.floor(m.limit.output),
          }
        : undefined,
  }));
  return { agents, models, defaultModel };
}

interface CapabilitiesStoreState {
  agents: OpenCodeAgentOption[];
  models: OpenCodeModelOption[];
  defaultModel?: OpenCodeDefaultModel;
  isLoading: boolean;
  error: string | null;
}

const initialState: CapabilitiesStoreState = {
  agents: [],
  models: [],
  defaultModel: undefined,
  isLoading: false,
  error: null,
};

export const useCapabilitiesStore = create<CapabilitiesStoreState>(() => initialState);

let activeSubscribers = 0;
let inFlight: Promise<void> | null = null;
let inFlightEpoch = -1;
let requestGeneration = 0;
let hasSuccessfulLoad = false;
let loadedRecoveryEpoch = -1;
let needsRefreshForEpoch = -1;

function currentRecoveryEpoch(): number {
  return useAvailabilityStore.getState().recoveryEpoch;
}

function startFetch(force: boolean): void {
  const epoch = currentRecoveryEpoch();
  if (!force && hasSuccessfulLoad && loadedRecoveryEpoch === epoch) {
    // Valid shared result for the current recovery epoch.
    if (useCapabilitiesStore.getState().isLoading && !inFlight) {
      useCapabilitiesStore.setState({ isLoading: false });
    }
    return;
  }

  if (inFlight) {
    // Join an existing in-flight request when it already targets the current
    // required epoch. Supersede only when a newer authoritative refresh is
    // required (e.g. recovery epoch advanced past the in-flight request).
    if (!force || inFlightEpoch === epoch) {
      if (useCapabilitiesStore.getState().isLoading === false) {
        useCapabilitiesStore.setState({ isLoading: true, error: null });
      }
      return;
    }
  }

  // Supersede any older in-flight request: its completion must not overwrite
  // this newer authoritative refresh.
  requestGeneration += 1;
  const generation = requestGeneration;
  const requestEpoch = epoch;
  inFlightEpoch = requestEpoch;
  useCapabilitiesStore.setState({ isLoading: true, error: null });

  const request = (async () => {
    try {
      const response = await apiFetch("/api/opencode/capabilities");
      const data = await readOpenCodeCapabilities(response);
      if (generation !== requestGeneration) return;
      const normalized = normalizeOpenCodeCapabilities(data);
      hasSuccessfulLoad = true;
      loadedRecoveryEpoch = requestEpoch;
      if (needsRefreshForEpoch === requestEpoch) {
        needsRefreshForEpoch = -1;
      }
      useCapabilitiesStore.setState({
        ...normalized,
        isLoading: false,
        error: null,
      });
    } catch (e: unknown) {
      if (generation !== requestGeneration) return;
      // A failed refresh retains the last successful capability data and exposes
      // a consistent error/loading state. No retry storm: callers must trigger a
      // new refresh explicitly (recovery epoch / re-enable after empty state).
      useCapabilitiesStore.setState({
        isLoading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (generation === requestGeneration) {
        inFlight = null;
        inFlightEpoch = -1;
      }
    }
  })();

  inFlight = request;
}

function ensureForActiveSubscribers(force: boolean): void {
  if (activeSubscribers <= 0) return;
  startFetch(force);
}

// Coordinated recovery: one authoritative refresh for all active consumers when
// the backend returns. If no consumer is active, mark stale so the next enabled
// consumer fetches fresh data instead of reusing a pre-recovery catalogue.
useAvailabilityStore.subscribe((state, prev) => {
  if (state.recoveryEpoch === prev.recoveryEpoch) return;
  needsRefreshForEpoch = state.recoveryEpoch;
  if (activeSubscribers > 0) {
    ensureForActiveSubscribers(true);
  }
});

/**
 * Registers an enabled capabilities consumer. Triggers a shared fetch when no
 * valid shared result exists for the current recovery epoch. Idempotent per
 * acquired handle: callers must pair each successful acquire with one release.
 */
export function acquireCapabilities(): void {
  activeSubscribers += 1;
  const epoch = currentRecoveryEpoch();
  const mustRefresh =
    needsRefreshForEpoch === epoch || !hasSuccessfulLoad || loadedRecoveryEpoch !== epoch;
  if (mustRefresh) {
    ensureForActiveSubscribers(true);
  } else {
    // Reuse valid shared state; ensure loading is not stuck from an unrelated
    // transition.
    if (useCapabilitiesStore.getState().isLoading && !inFlight) {
      useCapabilitiesStore.setState({ isLoading: false });
    }
  }
}

/** Releases an enabled capabilities consumer. Never clears shared data. */
export function releaseCapabilities(): void {
  activeSubscribers = Math.max(0, activeSubscribers - 1);
}

/** Test-only: reset shared capabilities state and subscriber/request tracking. */
export function resetCapabilitiesStoreForTests(): void {
  activeSubscribers = 0;
  inFlight = null;
  inFlightEpoch = -1;
  requestGeneration += 1;
  hasSuccessfulLoad = false;
  loadedRecoveryEpoch = -1;
  needsRefreshForEpoch = -1;
  useCapabilitiesStore.setState(initialState);
}
