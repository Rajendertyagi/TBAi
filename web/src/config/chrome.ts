/**
 * Single source of truth for window-chrome copy (caption buttons, settings
 * window open flow). Components reference this — no literals live in
 * `WindowControls.tsx` / `settings-window.ts` / entry points.
 */
export const chromeConfig = {
  copy: {
    minimize: "Minimize",
    maximize: "Maximize",
    restore: "Restore",
    close: "Close",
    settingsPopupBlocked:
      "Popup blocked — settings opened here instead. Allow popups for this site to use the settings tab.",
    settingsOpenFailed:
      "Could not open the settings window — opened here instead.",
  },
};
