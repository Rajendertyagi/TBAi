import { Monitor, PanelLeft, PanelBottom } from "lucide-react";
import { SettingsPage, SettingsSection, SettingRow } from "../../components/shared/settings";
import { Switch } from "../../components/ui/switch";
import { useDesktopLayout } from "./state/desktopLayout";
import { StartupSection } from "./StartupSection";
import { ServerSection } from "./ServerSection";

/**
 * Desktop settings page (mounted under the Settings area). Lets the user toggle
 * the VS Code–like chrome elements. Values are persisted via the desktopLayout
 * store, so they apply on next launch ("option in startup").
 */
export function DesktopSettings() {
  const sidebarVisible = useDesktopLayout((s) => s.sidebarVisible);
  const statusBarVisible = useDesktopLayout((s) => s.statusBarVisible);
  const setSidebar = useDesktopLayout((s) => s.setSidebar);
  const setStatusBar = useDesktopLayout((s) => s.setStatusBar);

  return (
    <SettingsPage
      title="Desktop"
      description="Window layout and chrome options for the TBAi desktop app."
    >
      <SettingsSection
        title="Layout"
        icon={Monitor}
        description="Control which desktop chrome elements are visible. Changes apply immediately and persist across restarts."
      >
        <SettingRow
          label="Sidebar"
          icon={PanelLeft}
          description="Show the left navigation and conversation sidebar."
          control={
            <Switch
              checked={sidebarVisible}
              onCheckedChange={setSidebar}
              aria-label="Toggle sidebar"
            />
          }
        />
        <SettingRow
          label="Status bar"
          icon={PanelBottom}
          description="Show the bottom status bar with the active provider and model."
          control={
            <Switch
              checked={statusBarVisible}
              onCheckedChange={setStatusBar}
              aria-label="Toggle status bar"
            />
          }
        />
      </SettingsSection>
      <StartupSection />
      <ServerSection />
    </SettingsPage>
  );
}
