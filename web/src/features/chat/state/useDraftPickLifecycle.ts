import { useEffect } from "react";
import { useSettingsStore } from "../../providers/state/providersStore";
import { chatKey, NEW_DRAFT_TAB_ID, useChatTabsStore } from "./chatTabs";

/**
 * A one-shot model/reasoning pick belongs to the single unsent `chat:new`
 * draft and is consumed on that draft's first send. If the user leaves the
 * draft without sending, the pick must be discarded so it cannot leak into a
 * later conversation's send.
 *
 * This is a STORE subscription, not a per-component handler: every navigation
 * path (tab strip, keyboard shortcuts, sidebar, browser back/forward) changes
 * `localActiveKey`, so one subscription covers them all. Clicking the
 * already-active tab is a no-op (the key does not change) and preserves a
 * pending pick.
 */
export function subscribeDraftPickLifecycle(): () => void {
  const draftKey = chatKey(NEW_DRAFT_TAB_ID);
  return useChatTabsStore.subscribe((state, previous) => {
    if (previous.localActiveKey === draftKey && state.localActiveKey !== draftKey) {
      useSettingsStore.getState().revertChatTarget();
    }
  });
}

/** Mount once in the app shell to keep draft picks scoped to their draft. */
export function useDraftPickLifecycle(): void {
  useEffect(() => subscribeDraftPickLifecycle(), []);
}
