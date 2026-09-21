import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { threadListAdapter } from "../../../app/adapter";
import { ConversationNotFoundError, threadEngine } from "../../../adapters/remoteThreadListAdapter";
import { logger } from "../../../lib/logger";
import {
  NEW_DRAFT_TAB_ID,
  activeTab,
  agentKey,
  chatKey,
  routeStillReferencesRef,
  threadUrl,
  useChatTabsStore,
} from "./chatTabs";
import { useWelcomeEngineStore } from "./welcomeEngine";

/**
 * Single home for route→tab binding with existence validation, consumed by
 * both conversation surfaces (`ChatView`, `OpenCodeView`) so the rule lives
 * in exactly one place. Opens the matching tab for the route id, then
 * verifies the conversation still exists server-side; a deleted/missing id
 * closes every tab pointing at it (both surfaces — closing by constructed
 * key alone once left poisoned agent tabs behind) and falls back to the
 * draft. Draft/undefined ids are never validated: nothing is persisted yet.
 *
 * Row-authoritative reconciliation: the route is a HINT, the conversation's
 * `engine` column decides the surface. When the fetched row disagrees with
 * the route (e.g. an `engine=opencode` row opened at `/chat/<id>`), the
 * wrong-kind tab is closed and navigation moves to the engine-correct route
 * — the other view's mount opens the matching tab. Temporary agreement is
 * never manufactured: nothing is written, only the surface follows the row.
 *
 * @param ref - thread/conversation id from the route, or undefined/draft.
 * @param kind - which surface owns the tab.
 */
export function useConversationTab(
  ref: string | undefined,
  kind: "chat" | "agent",
): void {
  const navigate = useNavigate();
  const location = useLocation();
  // Read at COMPLETION time, not dispatch time: an async validation result
  // must be judged against the route showing when it lands, never the route
  // that started it. (Not an effect dep — validation must not refetch on
  // every unrelated navigation.)
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;

  useEffect(() => {
    // Draft routes must still open + activate the draft tab (the pre-hook
    // ChatView effect always did): first-send routing keys off the ACTIVE
    // tab being the draft, so leaving a stale tab active would strand an
    // OpenCode-engine send on the Direct surface. Nothing to validate.
    if (ref === NEW_DRAFT_TAB_ID) {
      useChatTabsStore.getState().openChat(NEW_DRAFT_TAB_ID);
      return;
    }
    if (!ref) return;
    const state = useChatTabsStore.getState();
    if (kind === "chat") state.openChat(ref);
    else state.openAgent(ref);
    let cancelled = false;
    threadListAdapter
      .fetch(ref)
      .then((meta) => {
        if (cancelled) return;
        // Row engine decides the surface. Unknown/absent engine reads as
        // Direct (legacy conversations predate the engine column).
        const rowEngine = threadEngine(meta);
        const rowWantsAgent = rowEngine === "opencode";
        const onAgentSurface = kind === "agent";
        if (rowWantsAgent === onAgentSurface) return;
        // Stale guard (Phase 8): reconcile only while this validation still
        // owns the route. A validation for a conversation the user already
        // left must never rewrite tabs/navigation behind the newer location.
        if (!routeStillReferencesRef(pathnameRef.current, ref)) {
          logger.info("app", "navigation.rejected", {
            ref,
            pathname: pathnameRef.current,
            reason: "stale-engine-reconciliation",
          });
          return;
        }
        // Mismatch: the wrong-kind tab opened above must give way to the
        // row's surface. Order matters: open the correct-kind tab FIRST so
        // the active key already points at the destination when TabUrlSync
        // reacts — closing first would drop the active key to a fresh draft
        // and TabUrlSync would overwrite this redirect with /chat/new.
        // Navigation is replace (the wrong URL was never a real location);
        // the target view's mount re-opens the same tab idempotently.
        const current = useChatTabsStore.getState();
        if (rowWantsAgent) {
          current.openAgent(ref);
          current.close(chatKey(ref));
        } else {
          current.openChat(ref);
          current.close(agentKey(ref));
        }
        logger.info("app", "navigation.redirect", {
          ref,
          to: threadUrl(ref, rowEngine),
          reason: "engine-surface-mismatch",
        });
        navigate(threadUrl(ref, rowEngine), { replace: true });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Phase 3.4: only CONFIRMED server evidence (404) may destroy.
        // Network failure / 5xx / indeterminate means existence is UNKNOWN:
        // keep the tab, keep the route, keep known data (marked stale by the
        // global availability indicator). Never generic error-swallowing —
        // the distinction lives in the adapter's typed fetch errors.
        if (!(err instanceof ConversationNotFoundError)) {
          logger.debug("chat", "conversation validation unknown, retaining", {
            ref,
            errorType: err instanceof Error ? err.name : typeof err,
          });
          return;
        }
        const current = useChatTabsStore.getState();
        for (const tab of current.tabs) {
          if (tab.ref === ref) current.close(tab.key);
        }
        // The draft is engine-agnostic (one route hosts both engines), so
        // recovery preserves the dead tab's engine in the draft store: a
        // Code tab that pointed at a deleted conversation falls back to a
        // Code draft, not a Direct one. The row stays authoritative — nothing
        // is created or re-bound here.
        if (kind === "agent") {
          useWelcomeEngineStore.getState().setEngine("opencode");
        }
        // Stale guard (Phase 8): the tab store already moved the active key
        // (TabUrlSync corrects the URL from there). Drive navigation ONLY
        // when the dead route is still showing and no surviving conversation
        // took over — otherwise this late 404 would overwrite newer state
        // (e.g. delete-while-open racing TabUrlSync to the neighbor tab).
        const survivor = activeTab(useChatTabsStore.getState());
        const survivorIsDraft =
          !survivor || survivor.ref === NEW_DRAFT_TAB_ID;
        if (routeStillReferencesRef(pathnameRef.current, ref) && survivorIsDraft) {
          logger.info("app", "navigation.redirect", {
            ref,
            to: "/chat/new",
            reason: "conversation-not-found",
          });
          navigate("/chat/new", { replace: true });
        } else {
          logger.info("app", "navigation.rejected", {
            ref,
            pathname: pathnameRef.current,
            reason: "stale-not-found",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ref, kind, navigate]);
}
