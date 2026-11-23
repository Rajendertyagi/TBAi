/**
 * The single URL ↔ focused-panel convergence controller for Phase E.
 *
 * `chatTabs.localActiveKey` is the window-level, URL-authoritative selection.
 * This hook is the only place that:
 *   - reads `localActiveKey` and drives Dockview focus/open through the
 *     imperative handle (origin `'api'` — ignored on the way back), and
 *   - writes `localActiveKey` from a user-driven Dockview active-panel change
 *     (origin `'user'`) and keeps the URL in sync.
 *
 * Per-group active tabs remain Dockview-owned and are never written to
 * `localActiveKey`. TabStrip / Chat Threads selection already writes
 * `localActiveKey` through the chatTabs store, so it converges here without a
 * second global tab strip. `TabUrlSync` is retired: URL sync lives here only.
 *
 * URL-writer contract (audit M3): this hook owns SELECTION-driven navigation
 * only. `useConversationTab` owns VALIDATION corrections (engine mismatch,
 * confirmed-gone, draft fallback) and marks the ref it is correcting via
 * `markValidationRedirect`. This hook no-ops when the pathname already matches
 * the target, and while a validation redirect still addresses the stale ref —
 * validation is authoritative there. See `routeFocus.ts` for the full contract.
 */
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { useLocation, useNavigate } from "react-router";
import { activeTab, parseTabKey, urlForTab, useChatTabsStore } from "../../chat/state/chatTabs";
import {
  isUserFocus,
  isValidationRedirecting,
  tabKeyForPath,
  type FocusOrigin,
} from "../routeFocus";
import type { DockviewWorkspaceHandle } from "../components/DockviewWorkspace";

/** Callbacks the focus controller exposes back to the Dockview adapter. */
export interface WorkspaceFocusSync {
  /** Forward a Dockview active-panel change to the controller. */
  onDockviewActivePanelChange: (tabKey: string | undefined, origin: FocusOrigin) => void;
}

/**
 * Create the focus controller. `handleRef` is owned by AppShell and shared with
 * the persistent `DockviewWorkspace` instance.
 */
export function useWorkspaceFocusSync(
  handleRef: MutableRefObject<DockviewWorkspaceHandle | null>,
): WorkspaceFocusSync {
  const localActiveKey = useChatTabsStore((s) => s.localActiveKey);
  const location = useLocation();
  const navigate = useNavigate();
  const prevKeyRef = useRef(localActiveKey);

  // localActiveKey -> Dockview focus/open + URL. Runs only on an actual change
  // so remote shared-membership updates and bare location changes are inert.
  useEffect(() => {
    if (prevKeyRef.current === localActiveKey) return;
    prevKeyRef.current = localActiveKey;
    if (!localActiveKey) return;

    handleRef.current?.focusOrOpen(localActiveKey);

    const tab = activeTab(useChatTabsStore.getState());
    if (!tab) return;
    const target = urlForTab(tab);
    if (location.pathname === target) return; // already converged — no writer needed

    // Validation owns the route while it is correcting a stale/mismatched ref.
    // Do not write a competing URL; the correction will land on `target` and
    // clear the mark, at which point this effect re-runs and finds them equal.
    const routeKey = tabKeyForPath(location.pathname);
    const routeRef = routeKey ? parseTabKey(routeKey)?.ref : undefined;
    if (routeRef && isValidationRedirecting(routeRef, location.pathname)) return;

    navigate(target, { replace: true });
  }, [localActiveKey, location.pathname, navigate, handleRef]);

  // Dockview user focus -> localActiveKey. Programmatic ('api') focus is the
  // echo of the effect above and must never re-enter the store or URL.
  const onDockviewActivePanelChange = useCallback(
    (tabKey: string | undefined, origin: FocusOrigin) => {
      if (!isUserFocus(origin) || !tabKey) return;
      const parsed = parseTabKey(tabKey);
      if (!parsed) return;
      const state = useChatTabsStore.getState();
      if (state.localActiveKey === tabKey) return;
      if (parsed.kind === "agent") state.presentAgent(parsed.ref);
      else state.presentChat(parsed.ref);
      // URL sync is performed by the localActiveKey effect above — one writer.
    },
    [],
  );

  return { onDockviewActivePanelChange };
}
