import { useCallback } from "react";
import { create } from "zustand";

/**
 * The canonical wording for "the server no longer holds this permission".
 *
 * Exported so the OpenCode permission compatibility layer can turn a V2
 * not-found response into the failure this module already recognises, instead
 * of inventing a second stale rule. It MUST match {@link PERMISSION_GONE_RE}.
 */
export const PERMISSION_GONE_MESSAGE = "Permission request not found";

/**
 * The OpenCode server's answer when asked to reply to a permission it no longer
 * holds. Kept beside the set because it is the other half of the same rule:
 * this decides an id *is* stale, `markStale` records it. The match is on the
 * server's own wording, so it can only ever fire for an OpenCode permission and
 * never for a normal-chat approval.
 */
const PERMISSION_GONE_RE = new RegExp(PERMISSION_GONE_MESSAGE, "i");

/**
 * True when a failed approval reply means the permission no longer exists.
 *
 * Reads a `.message` off any throwable, not just `Error`: missing the signal is
 * what leaves a card wedged, so this errs toward recognising it. `String(x)` on
 * a plain object would only ever yield "[object Object]".
 */
export function isPermissionGone(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : error != null && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error);
  return PERMISSION_GONE_RE.test(message);
}

/**
 * Permission ids the OpenCode server no longer holds.
 *
 * Why this exists: OpenCode keeps pending permissions in the server's memory
 * only — sessions persist to disk, permissions do not. When the managed server
 * restarts (or a different instance serves the same session), every pending
 * permission is discarded, but the browser keeps its own `pending` map, and the
 * adapter has no transition that removes an entry it already holds. The card
 * then stays on screen and every reply answers
 * "Permission request not found" — forever, because neither Approve nor Deny
 * can ever succeed against an id the server has forgotten.
 *
 * `@assistant-ui/react-opencode` is pinned at 0.2.23 and exposes no way to
 * force-resolve a permission, so the ids are tracked here and used to drive the
 * OFFICIAL exit condition instead: a tool part whose `approval.approved` is
 * defined renders no approval controls (tool-fallback.tsx), and the sibling
 * permission surface stops listing it.
 *
 * Only ever populated in Code mode — a normal-chat approval can never produce
 * the OpenCode not-found message that gates the write.
 */
interface StalePermissionsState {
  stale: ReadonlySet<string>;
  markStale: (ids: readonly string[]) => void;
}

export const useStalePermissionsStore = create<StalePermissionsState>((set) => ({
  stale: new Set<string>(),
  markStale: (ids) => {
    if (ids.length === 0) return;
    set((state) => {
      const next = new Set(state.stale);
      let changed = false;
      for (const id of ids) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? { stale: next } : state;
    });
  },
}));

/**
 * The pure decision, split out from the hook so it can be tested without React:
 * an approval whose request the server has forgotten can never be answered, so
 * it must not be offered.
 */
export function isStaleApproval(
  approvalId: string | undefined,
  stale: ReadonlySet<string>,
): boolean {
  return approvalId != null && stale.has(approvalId);
}

/**
 * The write half's decision, split out from the hook so it can be tested
 * without React — same reason as `isStaleApproval`.
 *
 * Returns true only when the failure WAS the "request not found" signal for a
 * request we can name. That `true` means "retire the card": the server has
 * forgotten this permission, so no retry can ever succeed. A `false` return
 * means an ordinary transient failure and the caller must leave it retryable —
 * conflating the two would hide a card that a retry could still answer.
 */
export function reportPermissionGone(
  approvalId: string | undefined,
  error: unknown,
  markStale: (ids: readonly string[]) => void,
): boolean {
  if (approvalId == null || !isPermissionGone(error)) return false;
  markStale([approvalId]);
  return true;
}

/**
 * The ONE stale-approval guard, for every surface that can offer a decision.
 *
 * There are two such surfaces and they must behave identically:
 * `ToolFallbackApproval` (the generic tool block, `tool-fallback.tsx`) and
 * `ApprovalGate` (the rich tool UIs, `tools/filesystem/ui.tsx`). Duplicating
 * this rule is how a second approval path ends up without it — and a path
 * without it is the original wedge: buttons that can only ever 404.
 *
 * This hook is only the React glue (subscription + memoisation); both halves of
 * the rule live in the pure functions above, which is what the tests exercise.
 *
 * - `stale` — render no controls for this request.
 * - `reportGone(error)` — the write half. Returns true when the failure WAS the
 *   "request not found" signal, so the caller retires the card instead of
 *   showing a retryable error for something that can never succeed. A `false`
 *   return means an ordinary transient failure: leave it retryable.
 */
export function useStaleApprovalGuard(approvalId: string | undefined): {
  stale: boolean;
  reportGone: (error: unknown) => boolean;
} {
  const stale = useStalePermissionsStore((s) => s.stale);
  const markStale = useStalePermissionsStore((s) => s.markStale);
  const reportGone = useCallback(
    (error: unknown) => reportPermissionGone(approvalId, error, markStale),
    [approvalId, markStale],
  );
  return { stale: isStaleApproval(approvalId, stale), reportGone };
}
