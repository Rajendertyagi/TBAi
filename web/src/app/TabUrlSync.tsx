import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { activeTab, urlForTab, useChatTabsStore } from "../features/chat/state/chatTabs";

/**
 * Keeps the URL in sync with chat-tab actions that originate outside the
 * chat view (closing the active tab, first-send id attach). Scoped to chat
 * routes only: browsing settings or other areas never triggers a
 * navigation, and settings views never open tabs.
 */
export function TabUrlSync() {
  const activeKey = useChatTabsStore((s) => s.activeKey);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!location.pathname.startsWith("/chat")) return;
    const tab = activeTab(useChatTabsStore.getState());
    if (!tab || tab.kind !== "chat") {
      navigate("/chat/new", { replace: true });
      return;
    }
    const want = urlForTab(tab);
    if (location.pathname !== want) navigate(want, { replace: true });
  }, [activeKey, location.pathname, navigate]);

  return null;
}
