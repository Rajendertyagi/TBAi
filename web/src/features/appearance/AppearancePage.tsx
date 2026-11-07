import { Palette, SlidersHorizontal, SpellCheck2, Type, ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { SettingRow, SettingsPage, SettingsSection } from "../../components/shared/settings";
import { Switch } from "../../components/ui/switch";
import { Button } from "../../components/ui/button";
import { ThemeToggle } from "./ThemeToggle";
import { useTheme } from "../../components/theme-provider";
import { ThemePicker } from "./ThemePicker";
import { useDesktopLayout } from "../desktop/state/desktopLayout";
import { CHAT_WIDTHS, CHAT_WIDTH_ORDER, DEFAULT_CHAT_WIDTH } from "../../config/chat";
import { ROUTES } from "../../config/navigation";
import { cn } from "../../lib/utils";

export function AppearancePage() {
  const { themeIds, setThemeId } = useTheme();
  const chatWidth = useDesktopLayout((s) => s.chatWidth);
  const setChatWidth = useDesktopLayout((s) => s.setChatWidth);
  const spellCheck = useDesktopLayout((s) => s.spellCheck);
  const setSpellCheck = useDesktopLayout((s) => s.setSpellCheck);

  return (
    <SettingsPage
      title="Appearance"
      description="Theme, color palettes, and chat display preferences. Applied instantly and remembered on this device."
    >
      {/* Link to dedicated Typography & Zoom settings */}
      <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10 text-primary">
            <Type className="size-5" />
          </div>
          <div>
            <div className="text-sm font-medium text-foreground">Typography &amp; Window Zoom</div>
            <div className="text-xs text-muted-foreground">
              Configure independent font families, weights, sizes, wrapping, and 80%–300% interface
              zoom.
            </div>
          </div>
        </div>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="rounded-full shrink-0 gap-1.5 text-xs"
        >
          <Link to={ROUTES.SETTINGS.TYPOGRAPHY}>
            Open Typography
            <ArrowRight className="size-3.5" />
          </Link>
        </Button>
      </div>

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
        <p className="text-3xs text-muted-foreground">
          Colour palettes from OpenChamber (MIT, Copyright (c) 2025 Bohdan Triapitsyn). Classic is
          TBAi's own.
        </p>
      </SettingsSection>

      <SettingsSection
        title="Chat layout"
        icon={SlidersHorizontal}
        description="Transcript width and layout behavior."
      >
        <SettingRow
          label="Message width"
          description="Default width of chat messages on large screens."
        >
          <div
            role="group"
            aria-label="Message width"
            className="inline-flex rounded-lg border border-border bg-card/40 p-0.5"
          >
            {CHAT_WIDTH_ORDER.map((key) => {
              const opt = CHAT_WIDTHS[key];
              const selected = (chatWidth ?? DEFAULT_CHAT_WIDTH) === key;
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setChatWidth(key)}
                  className={cn(
                    "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                    selected
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title="Typing"
        icon={SpellCheck2}
        description="Composer input assistance and dictionary checks."
      >
        <SettingRow
          label="Spell check"
          description="Underline misspelled words in the message composer."
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
export default AppearancePage;
