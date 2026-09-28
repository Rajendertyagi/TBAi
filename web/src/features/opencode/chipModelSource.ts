/**
 * Which model the Code-surface model chip should DISPLAY.
 *
 * ## The bug this exists to fix
 *
 * The chip read exactly one source: the conversation's persisted
 * `opencodeModel`. A session can be bound to a real model through paths that
 * never write that column — most importantly the server-default path, where
 * `pickSessionModel` assigns the server's advertised default during session
 * creation. Such a session runs every turn on a real model while the chip read
 * `null` and rendered "Select a model": the UI denied a state that was true.
 *
 * ## The precedence, and why each level wins
 *
 *   1. DRAFT      — no bound conversation yet, so the welcome-engine store owns
 *                   the pick (it seeds native session creation).
 *   2. STORED     — the reader's explicit choice. Authoritative, always. A
 *                   stored pick is a decision the reader made and persisted; a
 *                   server-reported session value must never overwrite it, or
 *                   the chip would flicker away a choice on every reload.
 *   3. NATIVE     — no stored choice, but the session is actually bound to a
 *                   model. The server reported it, so showing it is showing
 *                   reality rather than guessing.
 *   4. NOTHING    — no stored choice and no bound model, so the honest
 *                   unbound state. This is also what a stale/unavailable
 *                   session yields: the native model is absent, so the chip
 *                   falls back to "Select a model" instead of fabricating a
 *                   model for display.
 *
 * Level 3 is display-only. It is never written back to the conversation, so
 * observing a session's model can never become a stored preference.
 *
 * ## Why the id is qualified here
 *
 * The chip matches against the live catalogue by `` `${providerID}/${id}` ``,
 * and the conversation column stores that same qualified form. A native model
 * arrives as two separate fields, so it is joined once, here, and the chip's
 * existing lookup resolves it through the same machinery the picker uses. No
 * provider or model id is hardcoded anywhere in this module.
 */

import type { V2ModelSelection } from "./v2Types";

/** A model reference as the native runtime reports it. */
export type ChipNativeModel = Pick<V2ModelSelection, "providerID" | "modelID">;

export interface ChipModelSourceInput {
  /** True when no conversation is bound yet (the welcome draft). */
  readonly draft: boolean;
  /** The conversation's persisted `opencodeModel`, or null/"" when unset. */
  readonly storedModel: string | null | undefined;
  /** The model the bound native session actually carries, if any. */
  readonly nativeModel: ChipNativeModel | null | undefined;
  /** The welcome-draft pick. Only consulted when `draft` is true. */
  readonly draftModel: string;
}

/**
 * Joins a native model reference into the chip's `providerID/modelID` form.
 *
 * @param model - The native reference, or null/undefined when the session
 *   carries no model.
 * @returns The qualified id, or `""` when there is no usable model. A partial
 *   reference (missing provider or missing id) also yields `""`: half a model
 *   cannot be matched against the catalogue, and inventing the other half
 *   would be a guess.
 */
export function qualifyChipModel(model: ChipNativeModel | null | undefined): string {
  if (!model) return "";
  const { providerID, modelID } = model;
  if (typeof providerID !== "string" || providerID.length === 0) return "";
  if (typeof modelID !== "string" || modelID.length === 0) return "";
  return `${providerID}/${modelID}`;
}

/**
 * Resolves the model id the chip displays, by the documented precedence.
 *
 * @param input - The four facts above.
 * @returns A qualified `providerID/modelID` string, or `""` when the chip
 *   should show its unbound state.
 */
export function resolveChipModelSource(input: ChipModelSourceInput): string {
  if (input.draft) return input.draftModel;
  const stored = input.storedModel;
  if (typeof stored === "string" && stored.length > 0) return stored;
  return qualifyChipModel(input.nativeModel);
}

/**
 * The catalogue entry behind a displayed model id, or `null`.
 *
 * This is the chip's own lookup, moved here from the component body so the
 * resolution is executable under test instead of only observable in a browser —
 * and so the hook and its tests cannot disagree about what the chip shows.
 * Matching is identical to what the picker uses: exact `providerID/id` first,
 * then a bare id, against the LIVE catalogue. Nothing is hardcoded.
 *
 * An id the catalogue does not carry — a model the server has since dropped, or
 * a session bound to something this install never listed — resolves to `null`.
 * The caller then shows the id itself, which is truthful, rather than inventing
 * a name or provider for it.
 *
 * @param models - The live model options from the capabilities API.
 * @param modelRef - The qualified id the chip is displaying.
 * @returns The matching catalogue option, or `null` when unknown.
 */
export function findChipModelInfo<T extends { readonly id: string; readonly providerID: string }>(
  models: readonly T[],
  modelRef: string,
): T | null {
  if (!modelRef) return null;
  const match =
    models.find((m) => `${m.providerID}/${m.id}` === modelRef) ?? models.find((m) => m.id === modelRef);
  return match ?? null;
}
