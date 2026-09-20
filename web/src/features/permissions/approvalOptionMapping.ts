import type { ToolApprovalOption, ToolApprovalResponse } from "@assistant-ui/react";
import { approvalOptionApproves } from "@/components/shared/approval-options";

/**
 * The ID-mapping adapter between the host's approval options and the official
 * assistant-ui `ApprovalCard`'s presentation contract.
 *
 * WHY THIS EXISTS. The official element has exactly three buttons and names them
 * `once` / `always` / `deny`. A live TBAi gate carries **OpenCode's** option ids,
 * which are the host's, not the element's. So the two vocabularies must be
 * bridged — and bridged carefully, because the element's ids are a **presentation
 * contract only**. They are never authoritative, and they never reach the wire.
 *
 * THE RULES (locked):
 *
 *   allow-once   → "once"
 *   allow-always → "always"
 *   reject-*     → "deny"
 *
 * VISIBILITY IS DERIVED, NEVER ASSUMED. Which buttons appear comes from the
 * options the request actually carries — not from a fixed TBAi expectation:
 *
 *   allow-once + reject-once                 → once, deny
 *   allow-once + allow-always + reject-once  → once, always, deny
 *   reject-once only                         → deny
 *
 * "Always" is never invented. The element renders a button only when its
 * callback is supplied, so hiding an option the host did not offer is simply a
 * matter of not binding it.
 *
 * WHAT IS DELIBERATELY NOT HERE: no UI, no React, no response *sending*, and no
 * OpenCode wire format. This module maps ids and shapes a response value; the
 * guarded path in `BackendToolView` is still the only thing that sends one.
 */

/** The official `ApprovalCard`'s presentation ids. Never authoritative. */
export type ApprovalPresentationId = "once" | "always" | "deny";

/** The host option each presentation button should send. */
export interface ApprovalOptionBinding {
  /** Which buttons to render, in the element's own terms. */
  readonly presentation: readonly ApprovalPresentationId[];
  /** presentation id → the HOST's option, so the real id survives the round trip. */
  readonly host: Readonly<Partial<Record<ApprovalPresentationId, ToolApprovalOption>>>;
  /**
   * Options the element cannot express — a custom kind, or a second option
   * claiming a button already taken. Reported rather than dropped, so the caller
   * can fall back to the generic renderer instead of silently losing a choice.
   */
  readonly unmappable: readonly ToolApprovalOption[];
}

/**
 * Maps one host option onto a presentation button.
 *
 * Only the four documented kinds are mapped. A custom kind (`kind` is an open
 * union) returns `null` — the element has no button for it, and inventing one
 * would put a label on screen the host never offered.
 *
 * @param option - A host-declared approval option.
 * @returns The presentation id, or `null` when the element cannot express it.
 */
function presentationIdFor(option: ToolApprovalOption): ApprovalPresentationId | null {
  switch (option.kind) {
    case "allow-once":
      return "once";
    case "allow-always":
      return "always";
    case "reject-once":
    case "reject-always":
      return "deny";
    default:
      return null;
  }
}

/**
 * Binds a request's options to the element's three buttons.
 *
 * The first option to claim a button wins. A later option mapping to a button
 * already taken is reported in `unmappable` rather than overwriting it — the
 * element has one button per presentation id, so a second claimant is a real
 * ambiguity the caller must resolve, not something to hide.
 *
 * @param options - The request's options, or undefined for a plain allow/deny.
 * @returns The binding: which buttons to render and what each one sends.
 */
export function bindApprovalOptions(
  options: readonly ToolApprovalOption[] | undefined,
): ApprovalOptionBinding {
  const presentation: ApprovalPresentationId[] = [];
  const host: Partial<Record<ApprovalPresentationId, ToolApprovalOption>> = {};
  const unmappable: ToolApprovalOption[] = [];

  for (const option of options ?? []) {
    const id = presentationIdFor(option);
    if (id === null || host[id] !== undefined) {
      unmappable.push(option);
      continue;
    }
    host[id] = option;
    presentation.push(id);
  }

  return { presentation, host, unmappable };
}

/**
 * The response to send for a pressed button, carrying the **host's own option
 * id** — never the element's presentation id.
 *
 * `approved` travels alongside `optionId` because the runtime rejects a
 * mismatch: choosing a reject option while claiming approval throws. The value
 * comes from the shared `approvalOptionApproves`, so the classification stays in
 * one place.
 *
 * @param binding - The binding the button came from.
 * @param id - The presentation id whose button was pressed.
 * @returns The response value, or `null` when that button was not bound.
 */
export function hostResponseFor(
  binding: ApprovalOptionBinding,
  id: ApprovalPresentationId,
): ToolApprovalResponse | null {
  const option = binding.host[id];
  if (option === undefined) return null;
  return { optionId: option.id, approved: approvalOptionApproves(option) };
}
