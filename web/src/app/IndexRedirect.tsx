import { useEffect } from "react";
import { useNavigate } from "react-router";
import { activeTab, urlForTab, useChatTabsStore } from "../features/chat/state/chatTabs";

/**
 * Landing route (`/`): codeg-style, there is no dashboard — go straight to
 * work. Opens the active tab (or a fresh chat when nothing is open).
 */
export function IndexRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    const tab = activeTab(useChatTabsStore.getState());
    navigate(tab ? urlForTab(tab) : "/chat/new", { replace: true });
  }, [navigate]);
  return null;
}
