/**
 * Single source of truth for the tab-strip chrome copy. Components reference
 * this — no menu/tooltip literals live in `TabStrip.tsx`.
 */
export const tabStripConfig = {
  copy: {
    close: "Close",
    closeOthers: "Close Others",
    closeToRight: "Close to the Right",
    closeAll: "Close All",
    copyLink: "Copy Link",
    newChat: "New chat",
    closeTab: "Close tab",
    untitled: "Untitled",
    running: "Run in progress",
  },
};
