import { create } from "zustand";
import { useAvailabilityStore } from "../availability/availabilityStore";
import { apiFetch } from "../../lib/platform";
import {
  sameOpenCodeRuntimeTarget,
  useRuntimeTargetStore,
  type OpenCodeRuntimeTargetIdentity,
} from "./runtimeStatus";
import { acquireRuntimeTargetEvents, releaseRuntimeTargetEvents } from "./runtimeTargetEvents";

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

export interface OpenCodeCapabilitiesTarget extends OpenCodeRuntimeTargetIdentity {
  readonly mode: "managed" | "unresolved";
}

export interface OpenCodeCapabilities {
  agents: OpenCodeAgentOption[];
  models: OpenCodeModelOption[];
  /** Absent when the server advertises no default. */
  defaultModel?: OpenCodeDefaultModel;
  /** The runtime target this catalogue was read from, when provided. */
  target?: OpenCodeCapabilitiesTarget;
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
  target: OpenCodeCapabilitiesTarget | null;
}

function normalizeTarget(target: unknown): OpenCodeCapabilitiesTarget | null {
  if (!target || typeof target !== "object") return null;
  const backendInstanceId = Reflect.get(target, "backendInstanceId");
  const targetRevision = Reflect.get(target, "targetRevision");
  const targetId = Reflect.get(target, "targetId");
  const mode = Reflect.get(target, "mode");
  if (typeof targetRevision !== "number" || !Number.isFinite(targetRevision)) return null;
  if (mode !== "managed" && mode !== "unresolved") return null;
  return {
    backendInstanceId: typeof backendInstanceId === "string" ? backendInstanceId : "",
    targetRevision: Math.max(0, Math.floor(targetRevision)),
    targetId:
      typeof targetId === "number" && Number.isFinite(targetId) ? Math.floor(targetId) : null,
    mode,
  };
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
  return { agents, models, defaultModel, target: normalizeTarget(data.target) };
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
let inFlightTarget: OpenCodeCapabilitiesTarget | null = null;
let requestGeneration = 0;
let hasSuccessfulLoad = false;
let loadedRecoveryEpoch = -1;
let loadedTarget: OpenCodeCapabilitiesTarget | null = null;
let needsRefreshForEpoch = -1;
let needsRefreshForTarget = false;
let lastKnownTarget: OpenCodeCapabilitiesTarget | null = null;
let targetRefreshScheduled = false;

function currentRecoveryEpoch(): number {
  return useAvailabilityStore.getState().recoveryEpoch;
}

function currentKnownTarget(): OpenCodeCapabilitiesTarget | null {
  const status = useRuntimeTargetStore.getState().status;
  if (!status) return lastKnownTarget;
  return {
    backendInstanceId: status.backendInstanceId,
    targetRevision: status.targetRevision,
    targetId: status.targetId,
    mode: status.mode,
  };
}

function sameTarget(
  a: OpenCodeCapabilitiesTarget | null | undefined,
  b: OpenCodeCapabilitiesTarget | null | undefined,
): boolean {
  if (!a || !b) return false;
  return sameOpenCodeRuntimeTarget(a, b) && a.mode === b.mode;
}

function isLoadedDataCurrent(): boolean {
  if (!hasSuccessfulLoad) return false;
  if (loadedRecoveryEpoch !== currentRecoveryEpoch()) return false;
  const known = currentKnownTarget();
  if (known && loadedTarget && !sameTarget(loadedTarget, known)) return false;
  if (known && !loadedTarget) return false;
  return true;
}

function clearCurrentDataForTargetChange(): void {
  hasSuccessfulLoad = false;
  loadedTarget = null;
  loadedRecoveryEpoch = -1;
  useCapabilitiesStore.setState({
    agents: [],
    models: [],
    defaultModel: undefined,
    error: null,
  });
}

function startFetch(force: boolean): void {
  const epoch = currentRecoveryEpoch();
  const knownTarget = currentKnownTarget();
  const targetChanged =
    needsRefreshForTarget ||
    (knownTarget && loadedTarget && !sameTarget(knownTarget, loadedTarget));

  if (!force && !needsRefreshForTarget && isLoadedDataCurrent()) {
    if (useCapabilitiesStore.getState().isLoading && !inFlight) {
      useCapabilitiesStore.setState({ isLoading: false });
    }
    return;
  }

  if (inFlight) {
    // Join an existing in-flight request when it already targets the current
    // required epoch and target context. Supersede when a newer authoritative
    // refresh is required (recovery epoch advanced or target changed).
    const inFlightMatchesTarget =
      !knownTarget || !inFlightTarget || sameTarget(inFlightTarget, knownTarget) || !targetChanged;
    if (!force || (inFlightEpoch === epoch && inFlightMatchesTarget && !needsRefreshForTarget)) {
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
  const requestKnownTarget = knownTarget;
  inFlightEpoch = requestEpoch;
  inFlightTarget = requestKnownTarget;
  useCapabilitiesStore.setState({ isLoading: true, error: null });

  const request = (async () => {
    try {
      const response = await apiFetch("/api/opencode/capabilities");
      const data = await readOpenCodeCapabilities(response);
      if (generation !== requestGeneration) return;
      const normalized = normalizeOpenCodeCapabilities(data);
      const responseTarget = normalized.target;
      const latestKnown = currentKnownTarget();

      // If the runtime target identity is known and changed since this request
      // context, or the response belongs to a different target than currently
      // known, do not treat this response as current.
      if (latestKnown && responseTarget && !sameTarget(responseTarget, latestKnown)) {
        return;
      }
      if (
        latestKnown &&
        !responseTarget &&
        requestKnownTarget &&
        !sameTarget(requestKnownTarget, latestKnown)
      ) {
        return;
      }
      if (requestKnownTarget && latestKnown && !sameTarget(requestKnownTarget, latestKnown)) {
        return;
      }

      hasSuccessfulLoad = true;
      loadedRecoveryEpoch = requestEpoch;
      loadedTarget = responseTarget ?? requestKnownTarget ?? latestKnown ?? loadedTarget;
      if (needsRefreshForEpoch === requestEpoch) {
        needsRefreshForEpoch = -1;
      }
      if (!latestKnown || !loadedTarget || sameTarget(loadedTarget, latestKnown)) {
        needsRefreshForTarget = false;
      }
      useCapabilitiesStore.setState({
        agents: normalized.agents,
        models: normalized.models,
        defaultModel: normalized.defaultModel,
        isLoading: false,
        error: null,
      });
    } catch (e: unknown) {
      if (generation !== requestGeneration) return;
      const latestKnown = currentKnownTarget();
      const targetChangedSinceRequest =
        !!requestKnownTarget && !!latestKnown && !sameTarget(requestKnownTarget, latestKnown);
      const loadedMatchesLatest =
        !!loadedTarget && !!latestKnown && sameTarget(loadedTarget, latestKnown);
      const canRetainPrevious =
        hasSuccessfulLoad &&
        !targetChangedSinceRequest &&
        !needsRefreshForTarget &&
        (loadedMatchesLatest ||
          (!latestKnown && !!loadedTarget) ||
          (!loadedTarget && !latestKnown));

      if (!canRetainPrevious) {
        // New-target/unknown-target failure must not present previous target data
        // as current.
        hasSuccessfulLoad = false;
        loadedTarget = null;
        loadedRecoveryEpoch = -1;
        useCapabilitiesStore.setState({
          agents: [],
          models: [],
          defaultModel: undefined,
          isLoading: false,
          error: e instanceof Error ? e.message : String(e),
        });
      } else {
        // Same-target refresh failure retains last successful data.
        useCapabilitiesStore.setState({
          isLoading: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    } finally {
      if (generation === requestGeneration) {
        inFlight = null;
        inFlightEpoch = -1;
        inFlightTarget = null;
      }
    }
  })();

  inFlight = request;
}

function ensureForActiveSubscribers(force: boolean): void {
  if (activeSubscribers <= 0) return;
  startFetch(force);
}

function scheduleTargetRefresh(): void {
  if (targetRefreshScheduled) return;
  targetRefreshScheduled = true;
  queueMicrotask(() => {
    targetRefreshScheduled = false;
    if (activeSubscribers <= 0) return;
    const known = currentKnownTarget();
    if (known?.mode === "unresolved") {
      useCapabilitiesStore.setState({
        isLoading: false,
        error: "OpenCode runtime target is unavailable",
      });
      needsRefreshForTarget = false;
      return;
    }
    if (needsRefreshForTarget) {
      ensureForActiveSubscribers(true);
    }
  });
}

function handleTargetIdentityChange(next: OpenCodeCapabilitiesTarget | null): void {
  if (sameTarget(lastKnownTarget, next)) return;
  lastKnownTarget = next;
  if (loadedTarget && next && sameTarget(loadedTarget, next)) {
    needsRefreshForTarget = false;
    return;
  }
  if (loadedTarget && !next) {
    // Target became unknown/unobserved; keep loaded data only until a concrete
    // different target is known. A concrete unresolved target is handled below.
    return;
  }

  // Target identity changed (or became concretely known as different/unresolved).
  needsRefreshForTarget = true;
  // Supersede in-flight work for the previous target.
  requestGeneration += 1;
  inFlight = null;
  inFlightEpoch = -1;
  inFlightTarget = null;
  clearCurrentDataForTargetChange();

  if (activeSubscribers > 0) {
    if (next?.mode === "unresolved") {
      // No valid replacement target is available; represent unavailable/stale
      // state without presenting previous target data.
      useCapabilitiesStore.setState({
        isLoading: false,
        error: "OpenCode runtime target is unavailable",
      });
      needsRefreshForTarget = false;
      targetRefreshScheduled = false;
    } else {
      useCapabilitiesStore.setState({ isLoading: true, error: null });
      scheduleTargetRefresh();
    }
  }
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

// Runtime target identity changes can occur without a recovery epoch bump.
useRuntimeTargetStore.subscribe((state, prev) => {
  const nextStatus = state.status;
  const prevStatus = prev.status;
  if (!nextStatus) return;
  if (
    prevStatus &&
    prevStatus.backendInstanceId === nextStatus.backendInstanceId &&
    prevStatus.targetRevision === nextStatus.targetRevision &&
    prevStatus.targetId === nextStatus.targetId &&
    prevStatus.mode === nextStatus.mode
  ) {
    return;
  }
  handleTargetIdentityChange({
    backendInstanceId: nextStatus.backendInstanceId,
    targetRevision: nextStatus.targetRevision,
    targetId: nextStatus.targetId,
    mode: nextStatus.mode,
  });
});

/**
 * Registers an enabled capabilities consumer. Triggers a shared fetch when no
 * valid shared result exists for the current recovery epoch and target. Idempotent
 * per acquired handle: callers must pair each successful acquire with one release.
 */
export function acquireCapabilities(): void {
  activeSubscribers += 1;
  if (activeSubscribers === 1) {
    acquireRuntimeTargetEvents();
  }
  const epoch = currentRecoveryEpoch();
  const known = currentKnownTarget();
  if (known) lastKnownTarget = known;
  const mustRefresh =
    needsRefreshForEpoch === epoch ||
    needsRefreshForTarget ||
    !hasSuccessfulLoad ||
    loadedRecoveryEpoch !== epoch ||
    (known && loadedTarget ? !sameTarget(known, loadedTarget) : false) ||
    !!(known && !loadedTarget);
  if (mustRefresh) {
    if (known && loadedTarget && !sameTarget(known, loadedTarget)) {
      clearCurrentDataForTargetChange();
    }
    ensureForActiveSubscribers(true);
  } else {
    if (useCapabilitiesStore.getState().isLoading && !inFlight) {
      useCapabilitiesStore.setState({ isLoading: false });
    }
  }
}

/** Releases an enabled capabilities consumer. Never clears shared data. */
export function releaseCapabilities(): void {
  if (activeSubscribers > 0) {
    activeSubscribers -= 1;
    if (activeSubscribers === 0) {
      releaseRuntimeTargetEvents();
    }
  }
}

/** Test-only: reset shared capabilities state and subscriber/request tracking. */
export function resetCapabilitiesStoreForTests(): void {
  activeSubscribers = 0;
  inFlight = null;
  inFlightEpoch = -1;
  inFlightTarget = null;
  requestGeneration += 1;
  hasSuccessfulLoad = false;
  loadedRecoveryEpoch = -1;
  loadedTarget = null;
  needsRefreshForEpoch = -1;
  needsRefreshForTarget = false;
  lastKnownTarget = null;
  targetRefreshScheduled = false;
  releaseRuntimeTargetEvents();
  useCapabilitiesStore.setState(initialState);
}
