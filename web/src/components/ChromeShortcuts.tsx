import { useEffect } from "react";
import { useNavigate } from "react-router";
import { isTauri } from "../lib/platform";
import { isComposing } from "../lib/ime";
import { urlForTab, useChatTabsStore, visibleTabs } from "../features/chat/state/chatTabs";
import { ROUTES } from "../config/navigation";

/**
 * Desktop keyboard shortcut controller (mounted only in the Tauri shell):
 *   Ctrl/Cmd+T  new chat tab
 *   Ctrl/Cmd+W  close active tab
 *   Ctrl/Cmd+Tab / Shift+Tab  next / previous tab
 *   Ctrl/Cmd+1..9  jump to tab by index
 * These are desktop-only; the browser keeps its native shortcuts untouched.
 */
export function ChromeShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isTauri()) return;
    const onKey = (e: KeyboardEvent) => {
      if (isComposing(e)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const store = useChatTabsStore.getState();
      const tabs = visibleTabs(store);

      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        store.openNewDraft();
        navigate(ROUTES.CHAT_NEW);
      } else if (e.key === "w" || e.key === "W") {
        e.preventDefault();
        if (store.localActiveKey) store.close(store.localActiveKey);
      } else if (e.key === "Tab") {
        e.preventDefault();
        if (tabs.length === 0) return;
        const idx = tabs.findIndex((t) => t.key === store.localActiveKey);
        const next = e.shiftKey ? (idx - 1 + tabs.length) % tabs.length : (idx + 1) % tabs.length;
        const tab = tabs[next];
        if (tab) {
          store.selectLocal(tab.key);
          navigate(urlForTab(tab));
        }
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const tab = tabs[Number(e.key) - 1];
        if (tab) {
          store.selectLocal(tab.key);
          navigate(urlForTab(tab));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  return null;
}
