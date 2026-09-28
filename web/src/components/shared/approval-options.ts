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

/**
 * The kind that is the PRIMARY decision: approve this one call, change nothing
 * afterwards. It is the only kind whose button may be rendered as the ink
 * (default-variant) action — "Always allow" edits future behaviour, so it stays
 * a secondary action no matter which order the host listed it in.
 */
const PRIMARY_OPTION_KIND = "allow-once";

/** Kinds that allow the request. */
const ALLOW_OPTION_KINDS: ReadonlySet<string> = new Set([
  PRIMARY_OPTION_KIND,
  "allow-always",
]);

/** Kinds that refuse the request. */
const REJECT_OPTION_KINDS: ReadonlySet<string> = new Set([
  "reject-once",
  "reject-always",
]);

/** Human labels for the kinds the runtime documents. */
const OPTION_LABELS: ReadonlyMap<string, string> = new Map([
  [PRIMARY_OPTION_KIND, "Allow"],
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

/**
 * The option a renderer should present as the PRIMARY (ink) button; every other
 * option is a secondary action beside it.
 *
 * Preference order: the documented one-time allow, then the first documented
 * allow kind, then the first option of all. The one-time approval wins because
 * it is the reversible choice — a persistent grant is never the action the eye
 * should land on first. Total by construction: any non-empty list yields a
 * primary, so a card can never come out with every button demoted.
 *
 * Selection is by `id` at the call site, not by object identity, because the
 * option array a renderer holds is a copy the host sent.
 *
 * @param options - The options the request declares, in the host's own order.
 * @returns The primary option, or `undefined` when the request declares none.
 */
export function primaryApprovalOption(
  options: readonly ToolApprovalOption[],
): ToolApprovalOption | undefined {
  return (
    options.find((option) => option.kind === PRIMARY_OPTION_KIND) ??
    options.find((option) => isAllowApprovalOptionKind(option.kind)) ??
    options[0]
  );
}
