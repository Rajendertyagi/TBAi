import { toast } from "sonner";
import { appConfig } from "../config/navigation";
import { chromeConfig } from "../config/chrome";
import { isTauri, openSettingsWindow } from "./platform";

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

/**
 * The ONE settings open-flow (single-gear rule): native settings window on
 * desktop (deep-linked to `section`, a route without leading slash —
 * omitted = default), named second tab on web, in-app route when the popup
 * is blocked, toast + in-app fallback when the invoke fails. Every settings
 * entry point funnels through here; `navigate` is react-router's.
 */
export function openSettingsSurface(
  navigate: (route: string) => void,
  section?: string,
): void {
  if (isTauri()) {
    openSettingsWindow(section).catch(() => {
      toast.error(chromeConfig.copy.settingsOpenFailed);
      navigate(appConfig.settingsIndexRoute);
    });
  } else if (!openSettingsTab(section)) {
    navigate(appConfig.settingsIndexRoute);
  }
}
