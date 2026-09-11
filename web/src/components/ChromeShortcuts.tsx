import { useEffect } from "react";
import { useNavigate } from "react-router";
import { isTauri } from "../lib/platform";
import {
  urlForTab,
  useChatTabsStore,
} from "../features/chat/state/chatTabs";

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
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const store = useChatTabsStore.getState();

      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        store.openChat("new");
        navigate("/chat/new");
      } else if (e.key === "w" || e.key === "W") {
        e.preventDefault();
        if (store.activeKey) store.close(store.activeKey);
      } else if (e.key === "Tab") {
        e.preventDefault();
        if (store.tabs.length === 0) return;
        const idx = store.tabs.findIndex((t) => t.key === store.activeKey);
        const next = e.shiftKey
          ? (idx - 1 + store.tabs.length) % store.tabs.length
          : (idx + 1) % store.tabs.length;
        const tab = store.tabs[next];
        if (tab) {
          store.setActive(tab.key);
          navigate(urlForTab(tab));
        }
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const tab = store.tabs[Number(e.key) - 1];
        if (tab) {
          store.setActive(tab.key);
          navigate(urlForTab(tab));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  return null;
}
