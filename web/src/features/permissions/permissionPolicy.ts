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
 * no permanent trust grant, no hard-deny rule engine and no per-tool matrix.
 * The only automatic response that exists is {@link AUTO_RESPONSE} — `"once"`.
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
 * True when the shield is on for this session.
 *
 * @param mode - The session's shield position.
 * @returns True when permission requests should be accepted automatically.
 */
export function isAutoActive(mode: PermissionMode): boolean {
  return mode === "auto";
}

/**
 * Whether an incoming permission request should be accepted without asking.
 *
 * The policy's single decision, and intentionally not per-tool: while the shield
 * is on, every permission request is eligible. A future eligibility rule belongs
 * here as one predicate — never as a rule engine.
 *
 * @param mode - The session's shield position.
 * @returns True when the request should be answered automatically.
 */
export function shouldAutoApprove(mode: PermissionMode): boolean {
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
