/**
 * TBAi's permission policy — the Manual/Auto shield, and nothing else.
 *
 * Deliberately **pure**: no React, no runtime, no OpenCode, no persistence, no
 * UI. It answers one question — *should this permission request be accepted
 * automatically?* — and it owns the per-session Auto flag.
 *
 * THE MODEL (Phase 6B):
 *
 *   OFF = ask me for permission
 *   ON  = automatically accept permission requests once, for this session
 *
 * **Auto is session-scoped.** There is no `AutoGrantScope`, no "always" grant,
 * no permanent trust grant and no hard-deny rule engine. The only automatic
 * response that exists is {@link AUTO_RESPONSE} — `"once"`.
 *
 * The policy is action-aware in exactly one place, and it is a named set rather
 * than a matrix or an engine: {@link ALWAYS_ELIGIBLE_PERMISSION_ACTIONS}. An
 * action on that list has no effect for an approval to protect, so it is
 * accepted in either shield position. Everything else follows the shield.
 *
 * The shield is a **convenience switch, not a trust grant.** It does not survive
 * as a standing capability and it is never expressed as one.
 *
 * WHAT IT DOES NOT DO, on purpose:
 *  - render UI (the composer shield is a control surface, Phase 6E)
 *  - send a response (the native controller is the only
 *    response path — Phase 6C)
 *  - persist (the conversation-config path identified in Q4 is authoritative —
 *    Phase 6J)
 *  - contain OpenCode's permission wire format (that stays in `features/opencode`)
 */

/** The two shield positions. There are no others. */
export type PermissionMode = "manual" | "auto";

/** The shield is off: every permission request is asked. */
export const MANUAL: PermissionMode = "manual";

/** The shield is on: permission requests are accepted once, automatically. */
export const AUTO: PermissionMode = "auto";

/**
 * The only response an automatic acceptance may send.
 *
 * Named as a constant so "never send `always`" is enforced in one place rather
 * than remembered at each call site. There is deliberately no other value.
 */
export const AUTO_RESPONSE = "once" as const;

/**
 * OpenCode's permission action for "ask the user a question".
 *
 * WHY IT IS NAMED. Asking a question reads nothing, writes nothing and runs
 * nothing, so an approval in front of it protects no effect — it is the only
 * `ask` action on the default list with nothing to protect. It used to cost two
 * clicks: Approve the card, then answer the question the card was hiding.
 *
 * The wire value is spelled ONCE, here. Every other module that needs the
 * action name imports this constant, so the string cannot drift between the
 * policy and the place that reads a permission's action.
 */
export const QUESTION_PERMISSION_ACTION = "question";

/**
 * Actions eligible for automatic acceptance in BOTH shield positions.
 *
 * Membership means "there is no effect to approve" — never "the user trusts
 * this". A request on this list is accepted once, with {@link AUTO_RESPONSE},
 * exactly as an armed shield would accept it: the shield is what the *user*
 * asked for, and these actions are not what the shield is for.
 *
 * An action that is NOT on this list is not thereby restricted; it falls back to
 * the shield. So an unknown, absent or malformed action can only ever ask, never
 * approve — the list can only ever make the answer *less* surprising.
 */
export const ALWAYS_ELIGIBLE_PERMISSION_ACTIONS: ReadonlySet<string> = new Set([
  QUESTION_PERMISSION_ACTION,
]);

/**
 * True when the shield is on for this session.
 *
 * Unchanged by action-awareness: this is the shield's own state, and the
 * eligibility rule above is layered on top of it by {@link shouldAutoApprove}.
 *
 * @param mode - The session's shield position.
 * @returns True when the shield itself is on.
 */
export function isAutoActive(mode: PermissionMode): boolean {
  return mode === "auto";
}

/**
 * Whether an incoming permission request should be accepted without asking.
 *
 * The policy's single decision, and action-aware in exactly one place: a request
 * whose action is in {@link ALWAYS_ELIGIBLE_PERMISSION_ACTIONS} needs no
 * approval, so it is accepted in either shield position; every other action —
 * including one that is unknown, absent or not a string — follows the shield.
 * Never a rule engine: one predicate over one named set.
 *
 * @param mode - The session's shield position.
 * @param action - The permission's OpenCode action name, when the caller has it.
 *   A value that is not a string is treated as absent, so it can never match.
 * @returns True when the request should be answered automatically.
 */
export function shouldAutoApprove(mode: PermissionMode, action?: string): boolean {
  if (typeof action === "string" && ALWAYS_ELIGIBLE_PERMISSION_ACTIONS.has(action)) return true;
  return isAutoActive(mode);
}

/**
 * Flips the shield.
 *
 * @param mode - The current position.
 * @returns The other position.
 */
export function toggleAuto(mode: PermissionMode): PermissionMode {
  return mode === "auto" ? "manual" : "auto";
}

/**
 * Rehydrates a persisted shield position, defaulting to Manual.
 *
 * **Malformed or missing state is Manual**, never Auto — a convenience switch
 * must fail closed, so a corrupted or absent value can never start auto-
 * accepting permission requests.
 *
 * @param value - The persisted value, of unknown shape.
 * @returns A valid mode; `"manual"` for anything unrecognised.
 */
export function restoreMode(value: unknown): PermissionMode {
  return value === "auto" ? AUTO : MANUAL;
}
