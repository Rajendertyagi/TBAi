import { createOpenCodeClient } from "./client";
import { toOpenCodeError } from "./errors";
import { openCodeServerManager } from "./serverManager";
import { logger } from "../../lib/logger";
import { classifyError } from "../../lib/errors";
import type { ModelInfo } from "@opencode/client";

/** Minimal agent descriptor discovered from the managed OpenCode server. */
export interface OpenCodeAgentInfo {
  id: string;
  name: string;
  description?: string;
}

/** Minimal model descriptor discovered from the managed OpenCode server. */
export interface OpenCodeModelInfo {
  id: string;
  name: string;
  providerID: string;
  family?: string;
  /**
   * Thinking levels the model supports (OpenCode "variants"). Empty when the
   * model has none — the composer hides the thinking control in that case.
   */
  variants: string[];
  /**
   * Host-reported context/output limits. Absent when the server omits them —
   * callers fall back to the configured default window rather than guessing.
   */
  limit?: { context: number; output: number };
}

/**
 * The model the server would use if the reader has not chosen one.
 *
 * WHY THIS EXISTS. OpenCode advertises a default, but nothing was reading it:
 * a brand-new Code conversation therefore sat at "Select a model" and every
 * turn did nothing, even though the server was offering a perfectly good
 * default. The picker is not the answer — a reader who has not expressed a
 * preference should not be asked to express one before the app works.
 *
 * WHY IT IS THIS SHAPE AND NOT `ModelInfo`. `ModelInfo.settings` carries the
 * provider's credentials, and `/api/model/default` returns them in the response
 * body. This is the descriptor only: an id, the provider that owns it, and a
 * display name. Nothing else crosses this boundary.
 */
export interface OpenCodeDefaultModel {
  readonly providerID: string;
  readonly modelID: string;
  readonly name: string;
}

export interface OpenCodeCapabilities {
  agents: OpenCodeAgentInfo[];
  models: OpenCodeModelInfo[];
  /**
   * Absent when the server advertises no default, or could not be asked. A
   * missing default is not an error: the reader simply picks a model, which is
   * what happened before this field existed.
   */
  defaultModel?: OpenCodeDefaultModel;
}

/**
 * Maps a model's host-reported limits to the public descriptor shape.
 * Returns undefined when the server omits or mangles them so the field stays
 * absent (rather than present-but-garbage) and callers use the default window.
 */
function toModelLimit(m: ModelInfo): { context: number; output: number } | undefined {
  const context = m.limit?.context;
  const output = m.limit?.output;
  if (
    typeof context !== "number" ||
    !Number.isFinite(context) ||
    context <= 0 ||
    typeof output !== "number" ||
    !Number.isFinite(output) ||
    output <= 0
  ) {
    return undefined;
  }
  return { context: Math.floor(context), output: Math.floor(output) };
}

/**
 * Maps a model's declared thinking levels to bare variant ids. Tolerates a
 * non-array payload (returns none) so an unexpected server shape degrades to
 * "no thinking control" instead of throwing inside the picker.
 */
function toVariantIds(entries: ModelInfo["variants"]): string[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Lists the models the managed server currently offers. Starts the server on
 * first call (via the server manager). No directory is passed because model
 * discovery is session-independent.
 *
 * @returns The live model list, or an empty list if the server reports none.
 * @throws {OpenCodeError} When the server is unreachable or answers badly.
 */
async function fetchModels(): Promise<ModelInfo[]> {
  const baseUrl = await openCodeServerManager.ensureBaseUrl();
  const client = createOpenCodeClient(baseUrl);
  try {
    const result = await client.model.list();
    return Array.isArray(result.data) ? result.data : [];
  } catch (err) {
    throw toOpenCodeError(err);
  }
}

/**
 * Reads the server's advertised default model, or `undefined`.
 *
 * Never throws. The three ways this can come back empty are all "no default",
 * not "broken": the server reports `data: null`, the request fails, or the
 * response is not a usable model. Each collapses to `undefined` and the reader
 * picks a model themselves, which is exactly the behaviour that existed before.
 *
 * The returned descriptor deliberately omits `settings` — see
 * {@link OpenCodeDefaultModel}.
 */
async function fetchDefaultModel(
  client: ReturnType<typeof createOpenCodeClient>,
): Promise<OpenCodeDefaultModel | undefined> {
  try {
    const result = await client.model.default();
    const model = result.data;
    if (
      model === null ||
      typeof model !== "object" ||
      typeof model.id !== "string" || model.id.length === 0 ||
      typeof model.providerID !== "string" || model.providerID.length === 0
    ) {
      return undefined;
    }
    return {
      providerID: model.providerID,
      modelID: model.id,
      name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
    };
  } catch (err) {
    // Logged, not thrown: a missing default must not take the picker with it.
    logger.warn("opencode", "opencode.default_model_unavailable", { ...classifyError(err) });
    return undefined;
  }
}

/**
 * Discovers the agents and models exposed by the managed OpenCode server.
 * Starts the server on first call (via the server manager) and queries its live
 * capability endpoints. Nothing is hardcoded — every agent/model string comes
 * from the server response.
 *
 * @returns The live agent and model lists (empty lists when the server reports none).
 * @throws {OpenCodeError} When the server is unreachable or answers badly.
 */
/**
 * How long after the server becomes reachable an empty catalogue is treated as
 * "still loading" rather than "this install has none".
 *
 * WHY A BOUNDED WINDOW RATHER THAN A RETRY LOOP. OpenCode answers `/api/info`
 * the moment it is listening, but loads its provider catalogue asynchronously, so
 * `agent.list()` and `model.list()` legitimately return empty for a moment after
 * the server is up. Returning that empty as final is the bug: the reader is told
 * this install has no models, nothing re-requests, and the Code chat then has no
 * model to select and no turn to run.
 *
 * The window reuses the manager's OWN readiness signal (how long the process has
 * been reachable) rather than a private timer, so "starting up" means exactly what
 * the repository already means by it. It is bounded, so a genuinely model-less
 * installation still returns an honest empty answer instead of hanging.
 */
const CATALOGUE_LOADING_WINDOW_MS = 10_000;

/** Re-probe interval inside that window; matches the manager's readiness poll. */
const CATALOGUE_LOADING_POLL_MS = 250;

interface RawCapabilities {
  readonly agents: Awaited<ReturnType<ReturnType<typeof createOpenCodeClient>["agent"]["list"]>>["data"];
  readonly models: ModelInfo[];
}

/**
 * One capabilities read, with no interpretation.
 *
 * @returns Whatever the server currently reports, empty included.
 */
async function readCapabilities(
  client: ReturnType<typeof createOpenCodeClient>,
): Promise<RawCapabilities> {
  const [agentsResult, modelsResult] = await Promise.all([
    client.agent.list(),
    client.model.list(),
  ]);
  return {
    agents: Array.isArray(agentsResult.data) ? agentsResult.data : [],
    models: Array.isArray(modelsResult.data) ? modelsResult.data : [],
  };
}

/**
 * Reads the catalogue, waiting out the startup window if it comes back empty.
 *
 * A genuinely empty catalogue is returned as empty the moment the window has
 * passed, so a model-less installation is not made to wait and is never told
 * something that is not true.
 */
async function readCatalogueSettled(
  client: ReturnType<typeof createOpenCodeClient>,
): Promise<RawCapabilities> {
  const first = await readCapabilities(client);
  if (first.models.length > 0) return first;
  const sinceReady = openCodeServerManager.msSinceReady();
  if (sinceReady === null || sinceReady > CATALOGUE_LOADING_WINDOW_MS) return first;

  logger.info("opencode", "opencode.catalogue_loading", {
    sinceReadyMs: sinceReady,
    windowMs: CATALOGUE_LOADING_WINDOW_MS,
  });
  const deadline = Date.now() + (CATALOGUE_LOADING_WINDOW_MS - sinceReady);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, CATALOGUE_LOADING_POLL_MS));
    const next = await readCapabilities(client);
    if (next.models.length > 0) {
      logger.info("opencode", "opencode.catalogue_loaded", {
        waitedMs: CATALOGUE_LOADING_WINDOW_MS - Math.max(0, deadline - Date.now()),
        models: next.models.length,
      });
      return next;
    }
  }
  // The window closed with nothing. Honest, not endless.
  return first;
}

export async function getOpenCodeCapabilities(): Promise<OpenCodeCapabilities> {
  const baseUrl = await openCodeServerManager.ensureBaseUrl();
  const client = createOpenCodeClient(baseUrl);

  let raw: RawCapabilities;
  try {
    raw = await readCatalogueSettled(client);
  } catch (err) {
    throw toOpenCodeError(err);
  }
  const rawAgents = raw.agents;
  const rawModels = raw.models;

  // Asked separately and tolerantly. A server with no default, or one that
  // cannot answer, must still deliver its agents and models — a default is a
  // convenience, and losing it must never cost the reader their picker.
  const defaultModel = await fetchDefaultModel(client);

  const agents = rawAgents.flatMap((agent) => {
    if (
      typeof agent.id !== "string" ||
      agent.id.length === 0 ||
      typeof agent.name !== "string" ||
      agent.name.length === 0
    ) {
      return [];
    }
    return [{
      id: agent.id,
      name: agent.name,
      description: agent.description,
    }];
  });

  const models = rawModels.map((m) => {
    const limit = toModelLimit(m);
    return {
      id: m.id,
      name: m.name,
      providerID: m.providerID,
      family: m.family,
      variants: toVariantIds(m.variants),
      // Keep the optional limit field absent when the server omits it.
      ...(limit ? { limit } : {}),
    };
  });

  logger.info("opencode", "opencode.capabilities", {
    agents: agents.length,
    models: models.length,
  });

  return { agents, models, defaultModel };
}

/**
 * Resolves a stored model id to an OpenCode `ModelRef` (id + providerID) by
 * querying the live server. OpenCode's session-create / runtime `defaultModel`
 * both require the provider id, which is not persisted with the conversation, so
 * it is re-derived here from the server's model list. Returns null when the model
 * is unknown so callers can fall back to server defaults.
 *
 * @throws {OpenCodeError} When the server is unreachable or answers badly.
 */
export async function resolveOpenCodeModelRef(
  modelId: string,
): Promise<{ providerID: string; modelID: string } | null> {
  const models = await fetchModels();
  // Stored ids may be `provider/model` qualified or bare. Prefer an exact
  // provider-qualified match, fall back to the bare model id so a stored
  // `hy3` still resolves against `bai/hy3`.
  const match =
    models.find((m) => `${m.providerID}/${m.id}` === modelId) ??
    models.find((m) => m.id === modelId);
  return match ? { providerID: match.providerID, modelID: match.id } : null;
}

/**
 * Returns the thinking-level ids a stored model supports. `modelId` may be
 * `provider/model` qualified or bare. Returns an empty list when the model is
 * unknown or declares no variants — callers use that to hide the thinking
 * control.
 *
 * @throws {OpenCodeError} When the server is unreachable or answers badly.
 */
export async function listOpenCodeModelVariants(
  modelId: string,
): Promise<string[]> {
  const models = await fetchModels();
  const match =
    models.find((m) => `${m.providerID}/${m.id}` === modelId) ??
    models.find((m) => m.id === modelId);
  if (!match) return [];
  return toVariantIds(match.variants);
}

/**
 * Validates a persisted thinking level against the live model. Returns the
 * variant id when it is still offered by the model, otherwise null (stale
 * variant → caller omits it rather than poison the session with an unknown
 * value).
 *
 * @throws {OpenCodeError} When the server is unreachable or answers badly.
 */
export async function resolveOpenCodeVariant(
  modelId: string,
  variantId: string,
): Promise<string | null> {
  const variants = await listOpenCodeModelVariants(modelId);
  if (variants.length === 0) return null;
  return variants.includes(variantId) ? variantId : null;
}
