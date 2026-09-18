import { createOpenCodeClient } from "./client";
import { toOpenCodeError } from "./errors";
import { openCodeServerManager } from "./serverManager";
import { logger } from "../../lib/logger";
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
}

export interface OpenCodeCapabilities {
  agents: OpenCodeAgentInfo[];
  models: OpenCodeModelInfo[];
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
 * first call (via the server manager). No directory is passed, matching the
 * server's own default location — the same scope the previous implementation
 * used.
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
 * Discovers the agents and models exposed by the managed OpenCode server.
 * Starts the server on first call (via the server manager) and queries its live
 * capability endpoints. Nothing is hardcoded — every agent/model string comes
 * from the server response.
 *
 * @returns The live agent and model lists (empty lists when the server reports none).
 * @throws {OpenCodeError} When the server is unreachable or answers badly.
 */
export async function getOpenCodeCapabilities(): Promise<OpenCodeCapabilities> {
  const baseUrl = await openCodeServerManager.ensureBaseUrl();
  const client = createOpenCodeClient(baseUrl);

  let rawAgents: Awaited<ReturnType<typeof client.agent.list>>["data"];
  let rawModels: ModelInfo[];
  try {
    const [agentsResult, modelsResult] = await Promise.all([
      client.agent.list(),
      client.model.list(),
    ]);
    rawAgents = Array.isArray(agentsResult.data) ? agentsResult.data : [];
    rawModels = Array.isArray(modelsResult.data) ? modelsResult.data : [];
  } catch (err) {
    throw toOpenCodeError(err);
  }

  const agents = rawAgents.map((a) => ({
    id: a.id,
    // The official `AgentInfo` type declares `name`, but the OpenCode 1.18.x
    // server returns only `id` (verified live against 1.18.29). Fall back to
    // the id so the picker always has a label; a server that does supply
    // `name` still wins.
    name: typeof a.name === "string" && a.name.length > 0 ? a.name : a.id,
    description: a.description,
  }));

  const models = rawModels.map((m) => ({
    id: m.id,
    name: m.name,
    providerID: m.providerID,
    family: m.family,
    variants: toVariantIds(m.variants),
  }));

  logger.info("opencode", "opencode.capabilities", {
    agents: agents.length,
    models: models.length,
  });

  return { agents, models };
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
