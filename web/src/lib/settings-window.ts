import { toast } from "sonner";
import { appConfig } from "../config/navigation";
import { chromeConfig } from "../config/chrome";

/**
 * Web fallback for the dedicated settings surface (codeg `openAppWindow`
 * parity): opens the chromeless settings shell in a NAMED second tab.
 * Reusing one name means repeat opens focus the existing tab instead of
 * spawning duplicates.
 *
 * Must be called synchronously inside the click stack (no pre-await) so the
 * browser doesn't treat it as a popup. Returns false when blocked — callers
 * fall back to in-app navigation so the click never dies silently.
 */
export const SETTINGS_TAB_NAME = "tbai-settings";

const DEFAULT_SECTION = appConfig.settingsIndexRoute.replace(/^\//, "");

/** Hash path of the chromeless settings shell for a section id or route. */
export function settingsWindowPath(section?: string): string {
  const seg = (section ?? "").replace(/^\//, "") || DEFAULT_SECTION;
  return `/#/settings-window/${seg}`;
}

export function openSettingsTab(section?: string): boolean {
  const win = window.open(settingsWindowPath(section), SETTINGS_TAB_NAME);
  if (!win) {
    toast.error(chromeConfig.copy.settingsPopupBlocked);
    return false;
  }
  win.focus();
  return true;
}
