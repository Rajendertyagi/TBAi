/**
 * Which model a managed OpenCode session should run on.
 *
 * ## The invariant
 *
 *     session ──▶ resolved model ──▶ stored user choice, if there is one
 *                                    ──▶ otherwise the server's default, if there is one
 *                                    ──▶ otherwise nothing, honestly
 *
 * A session that ends with no model cannot select one, and a turn sent to it
 * does nothing at all — the "the coding chat does nothing" failure. So whenever
 * the server advertises a default, a session gets one. What it must never do is
 * override a choice the reader made.
 *
 * ## Why this is pure and separate
 *
 * It is the whole decision, with no I/O, so every branch is a unit test rather
 * than something only a live server can demonstrate. Both call sites — creating
 * a session and adopting an existing one — feed it the same three facts, which
 * is what makes the rule hold at both entry points instead of only the new one.
 *
 * ## What it deliberately does not do
 *
 * It never invents a model. `null` is a real answer meaning "leave it unbound",
 * and it is returned whenever the server has no default to offer.
 */

import type { OpenCodeDefaultModel } from "./capabilities";

/** A model reference in the shape OpenCode's session API accepts. */
export interface SessionModelRef {
  readonly id: string;
  readonly providerID: string;
}

/** A stored user choice, already resolved against the live model list. */
export type StoredModelRef = { readonly providerID: string; readonly modelID: string };

export interface PickSessionModelInput {
  /**
   * The model the session already carries, as the server reports it. Empty,
   * null and undefined all mean "no model". A session that already has one is
   * never re-assigned — that is the guard which makes this safe to run on every
   * adopt, not just on creation.
   */
  readonly boundModel?: string | null;
  /**
   * The reader's explicit stored choice, already resolved to a provider. Null
   * when there is no stored choice OR when the stored value no longer resolves
   * against the live catalogue — an unresolvable stored value is treated as no
   * choice at all, which is what lets the default apply rather than leaving the
   * session stranded on a model the server no longer has.
   */
  readonly storedModel?: StoredModelRef | null;
  /** The server's advertised default. Null when it advertises none. */
  readonly serverDefault?: OpenCodeDefaultModel | null;
}

/**
 * The model to assign, or `null` when nothing should be assigned.
 *
 * @param input - The three facts above.
 * @returns The model to set, or null to leave the session as it is.
 */
export function pickSessionModel(input: PickSessionModelInput): SessionModelRef | null {
  // Already bound. This is the whole reason the helper is safe to call on an
  // existing session: a model the reader picked, and a model already set by
  // OpenCode itself, are both left alone.
  if (input.boundModel) return null;
  // A stored choice always beats the default.
  if (input.storedModel) {
    return { id: input.storedModel.modelID, providerID: input.storedModel.providerID };
  }
  if (input.serverDefault) {
    return { id: input.serverDefault.modelID, providerID: input.serverDefault.providerID };
  }
  // No choice and no default: leave it unbound rather than inventing a model.
  return null;
}

/**
 * The reader's stored choice, resolved against the live model list.
 *
 * A stored value that no longer resolves is reported as **no choice**, not as a
 * choice that happens to be unresolvable — so the default can apply instead of
 * leaving the session pointed at a model the server no longer has.
 *
 * @param storedModelId - The conversation's persisted model value, if any.
 * @returns The resolved reference, or null when there is no usable choice.
 */
export async function resolveStoredModel(
  storedModelId: string | null | undefined,
): Promise<StoredModelRef | null> {
  if (!storedModelId) return null;
  const { resolveOpenCodeModelRef } = await import("./capabilities");
  return await resolveOpenCodeModelRef(storedModelId);
}

/**
 * The server's advertised default model, or null when it advertises none.
 *
 * Tolerant by construction: a server that cannot be asked yields `null`, which
 * is the honest "there is no default" answer and leaves the session unbound.
 *
 * @returns The default model descriptor, or null.
 */
export async function fetchServerDefaultModel(): Promise<OpenCodeDefaultModel | null> {
  const { getOpenCodeCapabilities } = await import("./capabilities");
  const capabilities = await getOpenCodeCapabilities();
  return capabilities.defaultModel ?? null;
}
