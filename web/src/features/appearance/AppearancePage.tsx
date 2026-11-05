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
  clampWeightForFont,
  CODE_FONT_SIZE_CONFIG,
  COMMON_WEIGHTS,
  getFont,
  LINE_HEIGHTS,
  MONO_FONTS,
  readTypography,
  resetCodeTypography,
  resetDisplayScale,
  resetInterfaceTypography,
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

  const handleResetAll = () => {
    const defaults = resetTypography();
    setTypography(defaults);
  };

  const handleResetInterface = () => {
    setTypography((prev) => resetInterfaceTypography(prev));
  };

  const handleResetCode = () => {
    setTypography((prev) => resetCodeTypography(prev));
  };

  const handleResetScale = () => {
    setTypography((prev) => resetDisplayScale(prev));
  };

  const currentUiFont = getFont(typography.fontFamily);
  const currentMonoFont = getFont(typography.monoFontFamily);

  const effectiveUiWeight = currentUiFont
    ? clampWeightForFont(typography.fontWeight, currentUiFont)
    : typography.fontWeight;

  const effectiveMonoWeight = currentMonoFont
    ? clampWeightForFont(typography.monoFontWeight, currentMonoFont)
    : typography.monoFontWeight;

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
        description="Independent controls for interface fonts, code fonts, weights, and application scaling."
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={handleResetAll}
            className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="size-3.5" />
            Reset all
          </Button>
        }
      >
        {/* Interface Typography Group */}
        <div className="rounded-xl border border-border/80 bg-card/30 p-4 space-y-4">
          <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
                Interface Typography
              </h3>
              <p className="text-3xs text-muted-foreground">
                Fonts and weights applied across navigation, messages, dialogs, and controls.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResetInterface}
              className="h-7 px-2.5 text-3xs text-muted-foreground hover:text-foreground"
            >
              Reset interface
            </Button>
          </div>

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
            label="Interface font weight"
            description={
              effectiveUiWeight !== typography.fontWeight
                ? `Requested ${typography.fontWeight}, clamped to ${effectiveUiWeight} by font capability.`
                : "Body text weight for interface elements."
            }
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
        </div>

        {/* Code Typography Group */}
        <div className="rounded-xl border border-border/80 bg-card/30 p-4 space-y-4">
          <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
                Code Typography
              </h3>
              <p className="text-3xs text-muted-foreground">
                Monospace fonts, weights, and dedicated sizing for code blocks, terminals, and
                diffs.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResetCode}
              className="h-7 px-2.5 text-3xs text-muted-foreground hover:text-foreground"
            >
              Reset code
            </Button>
          </div>

          <SettingRow
            label="Code font"
            description="Monospace font family used for syntax-highlighted code blocks, terminals, and diffs."
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
            label="Code font weight"
            description={
              effectiveMonoWeight !== typography.monoFontWeight
                ? `Requested ${typography.monoFontWeight}, clamped to ${effectiveMonoWeight} by font capability.`
                : "Weight applied to syntax highlighting and code blocks."
            }
          >
            <Select
              value={String(typography.monoFontWeight)}
              onValueChange={(val) => updateTypography({ monoFontWeight: Number(val) })}
            >
              <SelectTrigger className="w-56 font-mono text-xs">
                <SelectValue placeholder="Select code weight" />
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
            label="Code font size"
            description={`Independent size for code blocks and diffs (${typography.codeFontSize}px). Standard is 13px.`}
          >
            <div className="flex flex-col gap-2.5 w-full max-w-sm">
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={CODE_FONT_SIZE_CONFIG.min}
                  max={CODE_FONT_SIZE_CONFIG.max}
                  step={1}
                  value={typography.codeFontSize}
                  onChange={(e) => updateTypography({ codeFontSize: Number(e.target.value) })}
                  className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-input/40 accent-primary focus:outline-none"
                />
                <div className="flex items-center gap-1 shrink-0">
                  <Input
                    type="number"
                    min={CODE_FONT_SIZE_CONFIG.min}
                    max={CODE_FONT_SIZE_CONFIG.max}
                    value={typography.codeFontSize}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (val >= CODE_FONT_SIZE_CONFIG.min && val <= CODE_FONT_SIZE_CONFIG.max) {
                        updateTypography({ codeFontSize: val });
                      }
                    }}
                    className="h-8 w-16 text-center tabular-nums text-xs"
                  />
                  <span className="text-3xs text-muted-foreground">px</span>
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                {CODE_FONT_SIZE_CONFIG.presets.map((preset) => (
                  <Button
                    key={preset}
                    variant={typography.codeFontSize === preset ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => updateTypography({ codeFontSize: preset })}
                    className="h-6 px-2 text-3xs font-medium tabular-nums"
                  >
                    {preset}px
                  </Button>
                ))}
              </div>
            </div>
          </SettingRow>
        </div>

        {/* Application Scale & Reading Group */}
        <div className="rounded-xl border border-border/80 bg-card/30 p-4 space-y-4">
          <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
                Application Scale & Reading
              </h3>
              <p className="text-3xs text-muted-foreground">
                Global viewport scaling and paragraph line heights.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResetScale}
              className="h-7 px-2.5 text-3xs text-muted-foreground hover:text-foreground"
            >
              Reset scale
            </Button>
          </div>

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
        </div>

        <TypographyPreview
          fontFamilyName={currentUiFont?.label || typography.fontFamily}
          monoFontFamilyName={currentMonoFont?.label || typography.monoFontFamily}
          fontWeight={effectiveUiWeight}
          monoFontWeight={effectiveMonoWeight}
          codeFontSize={typography.codeFontSize}
          lineHeight={typography.lineHeight}
          baseSize={typography.baseSize}
        />
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
