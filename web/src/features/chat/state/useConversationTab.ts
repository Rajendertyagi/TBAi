import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { threadListAdapter } from "../../../app/adapter";
import { threadEngine } from "../../../adapters/remoteThreadListAdapter";
import { ConversationNotFoundError } from "./conversationExistence";
import { logger } from "../../../lib/logger";
import { ROUTES } from "../../../config/routes";
import { usePreferencesStore } from "../../preferences/state/preferencesStore";
import { evictIfGone } from "./tabReconciliation";
import {
  NEW_DRAFT_TAB_ID,
  activeTab,
  routeStillReferencesRef,
  threadUrl,
  urlForTab,
  useChatTabsStore,
} from "./chatTabs";
import { useWelcomeEngineStore } from "./welcomeEngine";

/**
 * Route?tab presentation binding with existence validation.
 *
 * Opens local presentation for the route id, then verifies the conversation
 * still exists server-side. A deleted/missing id closes every tab pointing at
 * it (confirmed-gone only). Presentation binding only: never mutates shared
 * membership, never resurrects a closed shared tab. A valid existing
 * conversation not in shared membership becomes a local detached presentation.
 */
export function useConversationTab(
  ref: string | undefined,
  kind: "chat" | "agent",
): { isDraft: boolean } {
  const navigate = useNavigate();
  const location = useLocation();
  const isDraft = kind === "chat" && (!ref || ref === NEW_DRAFT_TAB_ID);

  useEffect(() => {
    if (isDraft) {
      useChatTabsStore.getState().presentChat(NEW_DRAFT_TAB_ID);
      return;
    }
    if (!ref) return;
    const state = useChatTabsStore.getState();
    if (kind === "chat") state.presentChat(ref);
    else state.presentAgent(ref);

    // Mark detached if not in shared membership (local presentation only).
    const shared = usePreferencesStore.getState().snapshot?.sharedTabs ?? [];
    if (!shared.some((t) => t.ref === ref)) {
      useChatTabsStore.getState().markDetached(ref);
    } else {
      useChatTabsStore.getState().clearDetached(ref);
    }

    let cancelled = false;
    void (async () => {
      try {
        const meta = await threadListAdapter.fetch(ref);
        if (cancelled) return;
        const engine = threadEngine(meta);
        if (kind === "agent" && engine !== "opencode") {
          logger.info("chat", "tab_engine_mismatch", {
            threadId: ref,
            expected: "opencode",
            actual: engine,
          });
          useChatTabsStore.getState().presentChat(ref);
          navigate(threadUrl(ref, engine), { replace: true });
          return;
        }
        if (kind === "chat" && engine === "opencode") {
          logger.info("chat", "tab_engine_mismatch", {
            threadId: ref,
            expected: "direct",
            actual: engine,
          });
          useChatTabsStore.getState().presentAgent(ref);
          navigate(threadUrl(ref, engine), { replace: true });
          return;
        }
      } catch (err) {
        if (cancelled) return;
        if (!(err instanceof ConversationNotFoundError)) {
          logger.debug("chat", "tab_reconcile_probe_failed", {
            threadId: ref,
            kind,
            errorType: err instanceof Error ? err.name : typeof err,
            message: "conversation validation unknown, retaining",
          });
          return;
        }
        logger.info("chat", "tab_reconcile_gone", { threadId: ref, kind });
        evictIfGone(ref, "gone");
        if (routeStillReferencesRef(location.pathname, ref)) {
          const next = activeTab(useChatTabsStore.getState());
          if (next) navigate(urlForTab(next), { replace: true });
          else navigate(ROUTES.CHAT_NEW, { replace: true });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDraft, kind, ref, navigate, location.pathname]);

  useEffect(() => {
    if (kind === "chat" && isDraft) {
      // Reset welcome engine to defaults for a fresh draft (preserve autoApprove behavior as before).
      useWelcomeEngineStore.setState({ engine: "direct", agent: "", model: "", variant: "" });
    }
  }, [kind, isDraft]);

  return { isDraft };
}
