import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { activeTab, urlForTab, useChatTabsStore } from "../features/chat/state/chatTabs";

/**
 * One-way URL sync: the tab store owns the URL, route views own tab opening.
 *
 * Previous design navigated on every location change whenever the active tab
 * lagged behind the URL — so opening a thread from a Code/settings route
 * (sidebar → `/chat/<id>`) bounced to `/chat/new` before ChatView opened
 * the tab. That was an ordering race between this effect and ChatView's.
 *
 * New rule: act ONLY when the active tab changed (close, attach-after-send,
 * tab switch, first-send engine routing). Bare location changes are always
 * left to the route view (ChatView opens/validates the tab; OpenCodeView
 * opens the agent tab), which removes the race structurally instead of
 * winning it by effect order.
 */
export function TabUrlSync() {
  const activeKey = useChatTabsStore((s) => s.activeKey);
  const location = useLocation();
  const navigate = useNavigate();
  const prevKey = useRef(activeKey);

  useEffect(() => {
    const prev = prevKey.current;
    prevKey.current = activeKey;
    // Location changed but the tab didn't (e.g. sidebar navigated to a
    // thread): the route view owns this transition — stay out of its way.
    if (activeKey === prev) return;
    const tab = activeTab(useChatTabsStore.getState());
    if (!tab) return;
    const want = urlForTab(tab);
    if (location.pathname !== want) navigate(want, { replace: true });
  }, [activeKey, location.pathname, navigate]);

  return null;
}
