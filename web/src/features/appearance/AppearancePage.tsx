import { Palette, SlidersHorizontal, SpellCheck2, Type, RotateCcw } from "lucide-react";
import { useState } from "react";
import { SettingRow, SettingsPage, SettingsSection } from "../../components/shared/settings";
import { Switch } from "../../components/ui/switch";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { ThemeToggle } from "./ThemeToggle";
import { useTheme } from "../../components/theme-provider";
import { ThemePicker } from "./ThemePicker";
import { useDesktopLayout } from "../desktop/state/desktopLayout";
import { CHAT_WIDTHS, CHAT_WIDTH_ORDER, DEFAULT_CHAT_WIDTH } from "../../config/chat";
import { cn } from "../../lib/utils";
import {
  applyTypographyToDom,
  COMMON_WEIGHTS,
  getFont,
  LINE_HEIGHTS,
  MONO_FONTS,
  readTypography,
  resetTypography,
  SCALE_CONFIG,
  UI_FONTS,
  writeTypography,
  type TypographyConfig,
} from "./typography";
import { TypographyPreview } from "./TypographyPreview";

/**
 * Appearance settings (`/appearance`): theme, typography, chat layout and typing.
 */
export function AppearancePage() {
  const spellCheck = useDesktopLayout((s) => s.spellCheck);
  const setSpellCheck = useDesktopLayout((s) => s.setSpellCheck);
  const chatWidth = useDesktopLayout((s) => s.chatWidth);
  const setChatWidth = useDesktopLayout((s) => s.setChatWidth);
  const { themeIds, setThemeId } = useTheme();

  // Local component state for typography — writes directly to :root via applyTypographyToDom
  const [typography, setTypography] = useState<TypographyConfig>(readTypography);

  const updateTypography = (patch: Partial<TypographyConfig>) => {
    setTypography((prev) => {
      const next = { ...prev, ...patch };
      writeTypography(next);
      applyTypographyToDom(next);
      return next;
    });
  };

  const handleResetTypography = () => {
    const defaults = resetTypography();
    setTypography(defaults);
  };

  const currentUiFont = getFont(typography.fontFamily);
  const currentMonoFont = getFont(typography.monoFontFamily);

  return (
    <SettingsPage
      title="Appearance"
      description="Theme, typography, and display preferences. Applied instantly and remembered on this device."
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
        <p className="text-3xs text-muted-foreground">
          Colour palettes from OpenChamber (MIT, Copyright (c) 2025 Bohdan Triapitsyn). Classic is
          TBAi's own.
        </p>
      </SettingsSection>

      <SettingsSection
        title="Typography"
        icon={Type}
        description="Font family, weight, and application-wide interface scaling."
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={handleResetTypography}
            className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="size-3.5" />
            Reset to defaults
          </Button>
        }
      >
        <SettingRow
          label="Interface font"
          description="Primary font family applied across chat messages, buttons, and navigation."
        >
          <Select
            value={typography.fontFamily}
            onValueChange={(val) => updateTypography({ fontFamily: val })}
          >
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Select interface font" />
            </SelectTrigger>
            <SelectContent>
              {UI_FONTS.map((font) => (
                <SelectItem key={font.id} value={font.id}>
                  {font.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          label="Code font"
          description="Monospace font family used for syntax-highlighted code blocks, terminals, and identifiers."
        >
          <Select
            value={typography.monoFontFamily}
            onValueChange={(val) => updateTypography({ monoFontFamily: val })}
          >
            <SelectTrigger className="w-56 font-mono text-xs">
              <SelectValue placeholder="Select code font" />
            </SelectTrigger>
            <SelectContent>
              {MONO_FONTS.map((font) => (
                <SelectItem key={font.id} value={font.id} className="font-mono text-xs">
                  {font.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          label="Base font weight"
          description="Body text weight. Automatically clamped if a font has limited native weight ranges."
        >
          <Select
            value={String(typography.fontWeight)}
            onValueChange={(val) => updateTypography({ fontWeight: Number(val) })}
          >
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Select font weight" />
            </SelectTrigger>
            <SelectContent>
              {COMMON_WEIGHTS.map((w) => (
                <SelectItem key={w.value} value={String(w.value)}>
                  {w.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          label="Application scale"
          description={`Scales the entire interface (${Math.round((typography.baseSize / 16) * 100)}%). 16px is default.`}
        >
          <div className="flex flex-col gap-2.5 w-full max-w-sm">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={SCALE_CONFIG.min}
                max={SCALE_CONFIG.max}
                step={1}
                value={typography.baseSize}
                onChange={(e) => updateTypography({ baseSize: Number(e.target.value) })}
                className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-input/40 accent-primary focus:outline-none"
              />
              <div className="flex items-center gap-1 shrink-0">
                <Input
                  type="number"
                  min={SCALE_CONFIG.min}
                  max={SCALE_CONFIG.max}
                  value={typography.baseSize}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    if (val >= SCALE_CONFIG.min && val <= SCALE_CONFIG.max) {
                      updateTypography({ baseSize: val });
                    }
                  }}
                  className="h-8 w-16 text-center tabular-nums text-xs"
                />
                <span className="text-3xs text-muted-foreground">px</span>
              </div>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              {SCALE_CONFIG.presets.map((preset) => (
                <Button
                  key={preset}
                  variant={typography.baseSize === preset ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => updateTypography({ baseSize: preset })}
                  className="h-6 px-2 text-3xs font-medium tabular-nums"
                >
                  {preset}px ({Math.round((preset / 16) * 100)}%)
                </Button>
              ))}
            </div>
          </div>
        </SettingRow>

        <SettingRow
          label="Reading line height"
          description="Vertical paragraph line spacing for chat transcripts and markdown content."
        >
          <div
            role="group"
            aria-label="Line height"
            className="inline-flex w-fit rounded-lg border border-border bg-card/40 p-0.5"
          >
            {LINE_HEIGHTS.map((lh) => {
              const selected = typography.lineHeight === lh.value;
              return (
                <button
                  key={lh.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => updateTypography({ lineHeight: lh.value })}
                  className={cn(
                    "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                    selected
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {lh.label}
                </button>
              );
            })}
          </div>
        </SettingRow>

        <TypographyPreview
          fontFamilyName={currentUiFont?.label || typography.fontFamily}
          monoFontFamilyName={currentMonoFont?.label || typography.monoFontFamily}
          fontWeight={typography.fontWeight}
          lineHeight={typography.lineHeight}
          baseSize={typography.baseSize}
        />
      </SettingsSection>

      <SettingsSection
        title="Chat layout"
        icon={SlidersHorizontal}
        description="How wide the conversation column is. Messages, the composer and the welcome screen share one column, so they always line up."
      >
        <SettingRow
          label="Chat width"
          description={`Narrow fits more lines on screen; wide gives code and tables more room. ${CHAT_WIDTHS[DEFAULT_CHAT_WIDTH].label} is the default.`}
          control={
            <div
              role="group"
              aria-label="Chat width"
              className="inline-flex w-fit rounded-lg border border-border bg-card/40 p-0.5"
            >
              {CHAT_WIDTH_ORDER.map((width) => {
                const selected = chatWidth === width;
                return (
                  <button
                    key={width}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setChatWidth(width)}
                    className={cn(
                      "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                      selected
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {CHAT_WIDTHS[width].label}
                    <span className="ml-1 text-3xs tabular-nums text-muted-foreground">
                      {CHAT_WIDTHS[width].px}px
                    </span>
                  </button>
                );
              })}
            </div>
          }
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
