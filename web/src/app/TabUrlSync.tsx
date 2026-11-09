import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { activeTab, urlForTab, useChatTabsStore } from "../features/chat/state/chatTabs";

/**
 * One-way URL sync: the tab store owns the URL, route views own tab opening.
 *
 * Acts ONLY when the local active tab changed (close, attach-after-send,
 * tab switch, first-send engine routing). Bare location changes and remote
 * shared membership/order changes are always left to the route view, which
 * removes races and prevents cross-window navigation.
 */
export function TabUrlSync() {
  const localActiveKey = useChatTabsStore((s) => s.localActiveKey);
  const location = useLocation();
  const navigate = useNavigate();
  const prevActiveKey = useRef(localActiveKey);

  useEffect(() => {
    if (prevActiveKey.current === localActiveKey) return;
    prevActiveKey.current = localActiveKey;
    const tab = activeTab(useChatTabsStore.getState());
    if (!tab) return;
    const target = urlForTab(tab);
    if (location.pathname !== target) {
      navigate(target, { replace: true });
    }
  }, [localActiveKey, location.pathname, navigate]);

  return null;
}
