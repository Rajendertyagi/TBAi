import { Palette, SpellCheck2 } from "lucide-react";
import { SettingRow, SettingsPage, SettingsSection } from "../../components/shared/settings";
import { Switch } from "../../components/ui/switch";
import { ThemeToggle } from "../../components/theme-toggle";
import { useDesktopLayout } from "../desktop/state/desktopLayout";

/**
 * Appearance settings (`/appearance`): theme and display.
 * Theme state itself stays in ThemeProvider; this page is the UI surface.
 *
 * Also hosts spell check: the red-squiggle-under-typing behaviour is a display
 * preference of the same kind, and there is no "chat" settings page to put it on.
 */
export function AppearancePage() {
  const spellCheck = useDesktopLayout((s) => s.spellCheck);
  const setSpellCheck = useDesktopLayout((s) => s.setSpellCheck);

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

      <SettingsSection
        title="Typing"
        icon={SpellCheck2}
        description="How the message box behaves while you write."
      >
        <SettingRow
          label="Spell check"
          icon={SpellCheck2}
          description="Underline words your device thinks are misspelled. Uses your operating system's own spell checker — no extra dictionary is downloaded. On by default."
          control={
            <Switch
              checked={spellCheck}
              onCheckedChange={setSpellCheck}
              aria-label="Toggle spell check"
            />
          }
        />
      </SettingsSection>
    </SettingsPage>
  );
}
