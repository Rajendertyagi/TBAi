import type { ToolApprovalOption } from "@assistant-ui/react";

/**
 * Shared approval-option vocabulary.
 *
 * A gate may describe its choices as `options`, each carrying a `kind`. TWO
 * surfaces render those choices — the generic `ToolFallbackApproval` and the
 * rich `ApprovalGate` — and they must name and classify a choice identically,
 * or the same request shows different words (or, worse, different decisions)
 * depending on which renderer drew it.
 *
 * So the kind vocabulary lives here once. Teaching the app a new kind means
 * editing this file only.
 *
 * `kind` is an open union in the runtime's types (`ToolApprovalOptionKind |
 * (string & {})`), so every lookup here is total: an undocumented kind is a
 * normal input, never an exception.
 */

/** Kinds that allow the request. */
const ALLOW_OPTION_KINDS: ReadonlySet<string> = new Set([
  "allow-once",
  "allow-always",
]);

/** Kinds that refuse the request. */
const REJECT_OPTION_KINDS: ReadonlySet<string> = new Set([
  "reject-once",
  "reject-always",
]);

/** Human labels for the kinds the runtime documents. */
const OPTION_LABELS: ReadonlyMap<string, string> = new Map([
  ["allow-once", "Allow"],
  ["allow-always", "Always allow"],
  ["reject-once", "Deny"],
  ["reject-always", "Always deny"],
]);

/**
 * True when `kind` is a documented allow or reject kind.
 *
 * Used to tell a host's custom options apart from the standard decisions.
 *
 * @param kind - The option's `kind`.
 * @returns True when the kind is documented.
 */
export function isKnownApprovalOptionKind(kind: string): boolean {
  return ALLOW_OPTION_KINDS.has(kind) || REJECT_OPTION_KINDS.has(kind);
}

/**
 * True when `kind` is a documented allow kind.
 *
 * @param kind - The option's `kind`.
 * @returns True when the kind allows the request.
 */
export function isAllowApprovalOptionKind(kind: string): boolean {
  return ALLOW_OPTION_KINDS.has(kind);
}

/**
 * Display name for an option: its own `label`, else the documented label for
 * its `kind`, else its `id`.
 *
 * @param option - The option to name.
 * @returns A non-empty string safe to render on a button.
 */
export function approvalOptionLabel(option: ToolApprovalOption): string {
  return option.label ?? OPTION_LABELS.get(option.kind) ?? option.id;
}

/**
 * Whether choosing this option approves the request.
 *
 * A `reject-*` kind refuses; every other kind — including an undocumented one —
 * approves, which is the runtime's own default for a custom option. A renderer
 * MUST send this alongside `optionId`: the runtime rejects a mismatch (choosing
 * the `reject` option while claiming approval throws).
 *
 * @param option - The option about to be chosen.
 * @returns True when the choice approves.
 */
export function approvalOptionApproves(option: ToolApprovalOption): boolean {
  return !REJECT_OPTION_KINDS.has(option.kind);
}
