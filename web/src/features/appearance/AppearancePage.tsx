import { Palette } from "lucide-react";
import { SettingRow, SettingsPage, SettingsSection } from "../../components/shared/settings";
import { ThemeToggle } from "../../components/theme-toggle";

/**
 * Appearance settings (`/appearance`): theme and display.
 * Theme state itself stays in ThemeProvider; this page is the UI surface.
 */
export function AppearancePage() {
  return (
    <SettingsPage
      title="Appearance"
      description="Theme and display preferences. Applied instantly and remembered on this device."
    >
      <SettingsSection
        title="Theme"
        icon={Palette}
        description="Light or dark interface. Defaults to dark."
      >
        <SettingRow
          label="Color theme"
          description="Switches the whole app between light and dark tokens."
          control={<ThemeToggle />}
        />
      </SettingsSection>
    </SettingsPage>
  );
}
