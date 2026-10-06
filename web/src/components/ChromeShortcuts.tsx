import { useEffect } from "react";
import { useNavigate } from "react-router";
import { isTauri } from "../lib/platform";
import { isComposing } from "../lib/ime";
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
 *
 * ## Why the composition guard is here and not obvious
 *
 * These are chords, not a bare Enter, so it is easy to assume they cannot fire
 * mid-composition. They can: an IME consumes keystrokes and the browser still
 * delivers the keydown to the page, so Ctrl+<digit> while a candidate is open
 * would switch tabs out from under the reader mid-sentence. The guard is the
 * same one the bare-Enter handlers use, and it is checked once at the top rather
 * than per branch.
 */
export function ChromeShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isTauri()) return;
    const onKey = (e: KeyboardEvent) => {
      // An open IME composition owns every key, chords included.
      if (isComposing(e)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const store = useChatTabsStore.getState();

      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
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
