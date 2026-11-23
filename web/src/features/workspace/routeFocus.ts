/**
 * Pure route ↔ canonical-panel-key mapping for the Phase E focus controller.
 *
 * This module owns no state and touches no React/Dockview API. It is the single
 * place that decides which canonical tab key a URL addresses and whether a
 * Dockview focus event is user-driven (and therefore URL-authoritative).
 * `WorkspaceFocusSync` composes it with `chatTabs.localActiveKey` and the
 * Dockview imperative handle.
 */
import { ROUTES } from "../../config/routes";
import { agentKey, chatKey, NEW_DRAFT_TAB_ID } from "../chat/state/chatTabs";

/** A Dockview focus event's origin (`'user'` vs `'api'`). */
export type FocusOrigin = "user" | "api";

/**
 * Map a pathname to the canonical tab key it addresses, or `undefined` when
 * the route is not a chat surface (settings, scheduler, labs, …).
 *
 * - `/chat/new` → `chat:new` (the single draft panel)
 * - `/chat/:id` → `chat:<id>`
 * - `/code/:id` → `agent:<id>`
 */
export function tabKeyForPath(pathname: string): string | undefined {
  if (pathname === ROUTES.CHAT_NEW) return chatKey(NEW_DRAFT_TAB_ID);
  if (pathname.startsWith(`${ROUTES.CHAT}/`)) {
    const raw = pathname.slice(ROUTES.CHAT.length + 1);
    if (!raw || raw.includes("/")) return undefined;
    try {
      const id = decodeURIComponent(raw);
      return id && id !== NEW_DRAFT_TAB_ID ? chatKey(id) : undefined;
    } catch {
      return undefined;
    }
  }
  if (pathname.startsWith(`${ROUTES.CODE}/`)) {
    const raw = pathname.slice(ROUTES.CODE.length + 1);
    if (!raw || raw.includes("/")) return undefined;
    try {
      const id = decodeURIComponent(raw);
      return id ? agentKey(id) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** True when the Dockview workspace is the active surface for this path. */
export function isChatSurfacePath(pathname: string): boolean {
  return tabKeyForPath(pathname) !== undefined;
}

/**
 * Only user-driven Dockview focus changes are URL-authoritative. Programmatic
 * focus (`origin: 'api'`) is the controller echoing `localActiveKey` back into
 * Dockview and must never write the URL or re-enter the store.
 */
export function isUserFocus(origin: FocusOrigin): boolean {
  return origin === "user";
}

/**
 * URL-writer contract (Phase E audit M3).
 *
 * There are exactly two URL writers, with disjoint authority:
 *   - `useWorkspaceFocusSync` owns SELECTION changes (TabStrip, Dockview user
 *     focus, `localActiveKey` changes). It no-ops when the pathname already
 *     matches the target, and while validation is correcting a stale/mismatched
 *     ref (see below).
 *   - `useConversationTab` owns VALIDATION corrections (engine mismatch,
 *     confirmed-gone conversations, draft fallback). These are authoritative
 *     route corrections and must not be overwritten by focus sync.
 *
 * A validation correction marks the ref it is correcting together with the
 * target pathname. Focus sync consults `isValidationRedirecting` and skips its
 * own navigation while the pathname still addresses the stale ref; the mark
 * clears automatically once the pathname reaches the target. This prevents a
 * transient wrong URL and any feedback loop between the two writers.
 */
const validationRedirects = new Map<string, string>();

/** Mark a validation-driven route correction for `ref` targeting `targetPath`. */
export function markValidationRedirect(ref: string, targetPath: string): void {
  validationRedirects.set(ref, targetPath);
}

/**
 * True while `pathname` still addresses a ref whose route validation is being
 * corrected. Clears the mark once the pathname reaches the target.
 */
export function isValidationRedirecting(ref: string, pathname: string): boolean {
  const target = validationRedirects.get(ref);
  if (!target) return false;
  if (pathname === target) {
    validationRedirects.delete(ref);
    return false;
  }
  return true;
}

/** Test-only: drop all validation marks. */
export function clearValidationRedirects(): void {
  validationRedirects.clear();
}

/**
 * Classes for the persistent workspace layer. NEVER use `hidden`
 * (`display:none`) here: that collapses Dockview to zero size and it cannot
 * recover on re-show. `absolute inset-0` keeps the layer laid out at the
 * parent's full size; `invisible` only hides it visually.
 */
export function workspaceSurfaceClass(isChatSurface: boolean): string {
  return `absolute inset-0 ${isChatSurface ? "visible" : "invisible pointer-events-none"}`;
}

/** Classes for the route-swapped surface layered above the workspace. */
export function routeSurfaceClass(isChatSurface: boolean): string {
  return `relative z-10 flex min-w-0 flex-1 flex-col${isChatSurface ? " pointer-events-none" : ""}`;
}
