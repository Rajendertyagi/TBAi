import { Palette, SpellCheck2 } from "lucide-react";
import { SettingRow, SettingsPage, SettingsSection } from "../../components/shared/settings";
import { Switch } from "../../components/ui/switch";
import { ThemeToggle } from "../../components/theme-toggle";
import { useTheme } from "../../components/theme-provider";
import { ThemePicker } from "./ThemePicker";
import { useDesktopLayout } from "../desktop/state/desktopLayout";

/**
 * Appearance settings (`/appearance`): theme and display.
 * Theme state itself stays in ThemeProvider; this page is the UI surface.
 *
 * Colour is two independent decisions — a light/dark mode, and one palette per
 * mode — so there are two pickers. Each previews its palette in the mode it
 * drives, which is the whole reason they are not a single list.
 *
 * Also hosts spell check: the red-squiggle-under-typing behaviour is a display
 * preference of the same kind, and there is no "chat" settings page to put it on.
 */
export function AppearancePage() {
  const spellCheck = useDesktopLayout((s) => s.spellCheck);
  const setSpellCheck = useDesktopLayout((s) => s.setSpellCheck);
  const { themeIds, setThemeId } = useTheme();

  return (
    <SettingsPage
      title="Appearance"
      description="Theme and display preferences. Applied instantly and remembered on this device."
    >
      <SettingsSection
        title="Theme"
        icon={Palette}
        description="Light or dark interface, and the colour theme used in each."
      >
        <SettingRow
          label="Color theme"
          description="Switches the whole app between light and dark tokens."
          control={<ThemeToggle />}
        />
        <SettingRow
          label="Light theme"
          description="The colour theme used while in light mode. Independent of the dark one."
        >
          <ThemePicker
            variant="light"
            value={themeIds.light}
            onChange={(id) => setThemeId("light", id)}
          />
        </SettingRow>
        <SettingRow
          label="Dark theme"
          description="The colour theme used while in dark mode. Independent of the light one."
        >
          <ThemePicker
            variant="dark"
            value={themeIds.dark}
            onChange={(id) => setThemeId("dark", id)}
          />
        </SettingRow>
        {/* Attribution for the borrowed palettes. OpenChamber is MIT licensed and
            requires the notice to be retained; several palettes credit their own
            upstream author too. */}
        <p className="text-3xs text-muted-foreground">
          Colour palettes from OpenChamber (MIT, Copyright (c) 2025 Bohdan Triapitsyn).
          Classic is TBAi's own.
        </p>
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