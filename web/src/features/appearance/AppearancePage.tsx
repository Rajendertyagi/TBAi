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
  APP_SCALE_CONFIG,
  clampWeightForFont,
  CODE_FONT_SIZE_CONFIG,
  COMMON_WEIGHTS,
  formatAppScale,
  getFont,
  INTERFACE_FONT_SIZE_CONFIG,
  LINE_HEIGHTS,
  MONO_FONTS,
  readTypography,
  resetApplicationScale,
  resetCodeTypography,
  resetInterfaceTypography,
  resetReadingTypography,
  resetTerminalTypography,
  resetTypography,
  TERMINAL_FONT_SIZE_CONFIG,
  UI_FONTS,
  writeTypography,
  type TypographyConfig,
} from "./typography";
import { TypographyPreview } from "./TypographyPreview";

/**
 * Pixel size slider with a number input and preset buttons. Shared by the
 * Interface, Code and Terminal groups — the Application Scale group uses its
 * own factor-based slider (percent display).
 */
function PxSizeSlider({
  value,
  min,
  max,
  onChange,
  presets,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  presets: readonly number[];
  ariaLabel: string;
}) {
  return (
    <div className="flex flex-col gap-2.5 w-full max-w-sm">
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          aria-label={ariaLabel}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-input/40 accent-primary focus:outline-none"
        />
        <div className="flex items-center gap-1 shrink-0">
          <Input
            type="number"
            min={min}
            max={max}
            value={value}
            aria-label={`${ariaLabel} (px)`}
            onChange={(e) => {
              const val = Number(e.target.value);
              if (val >= min && val <= max) {
                onChange(val);
              }
            }}
            className="h-8 w-16 text-center tabular-nums text-xs"
          />
          <span className="text-3xs text-muted-foreground">px</span>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {presets.map((preset) => (
          <Button
            key={preset}
            variant={value === preset ? "secondary" : "ghost"}
            size="sm"
            onClick={() => onChange(preset)}
            className="h-6 px-2 text-3xs font-medium tabular-nums"
          >
            {preset}px
          </Button>
        ))}
      </div>
    </div>
  );
}

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

  const handleResetTerminal = () => {
    setTypography((prev) => resetTerminalTypography(prev));
  };

  const handleResetReading = () => {
    setTypography((prev) => resetReadingTypography(prev));
  };

  const handleResetScale = () => {
    setTypography((prev) => resetApplicationScale(prev));
  };

  const currentUiFont = getFont(typography.interfaceFontFamily);
  const currentCodeFont = getFont(typography.codeFontFamily);
  const currentTerminalFont = getFont(typography.terminalFontFamily);

  const effectiveUiWeight = currentUiFont
    ? clampWeightForFont(typography.interfaceFontWeight, currentUiFont)
    : typography.interfaceFontWeight;

  const effectiveCodeWeight = currentCodeFont
    ? clampWeightForFont(typography.codeFontWeight, currentCodeFont)
    : typography.codeFontWeight;

  const effectiveTerminalWeight = currentTerminalFont
    ? clampWeightForFont(typography.terminalFontWeight, currentTerminalFont)
    : typography.terminalFontWeight;

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
        description="Independent controls for interface, code, terminal and reading typography, plus application scaling."
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
                Compact metadata scales with the interface size and never drops below 9px.
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
              value={typography.interfaceFontFamily}
              onValueChange={(val) => updateTypography({ interfaceFontFamily: val })}
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
            label="Interface font size"
            description={`Actual font size for interface text (${typography.interfaceFontSize}px). Standard is 16px; the minimum is 14px. Does not scale layout or spacing.`}
          >
            <PxSizeSlider
              value={typography.interfaceFontSize}
              min={INTERFACE_FONT_SIZE_CONFIG.min}
              max={INTERFACE_FONT_SIZE_CONFIG.max}
              onChange={(val) => updateTypography({ interfaceFontSize: val })}
              presets={INTERFACE_FONT_SIZE_CONFIG.presets}
              ariaLabel="Interface font size"
            />
          </SettingRow>

          <SettingRow
            label="Interface font weight"
            description={
              effectiveUiWeight !== typography.interfaceFontWeight
                ? `Requested ${typography.interfaceFontWeight}, clamped to ${effectiveUiWeight} by font capability.`
                : "Body text weight for interface elements."
            }
          >
            <Select
              value={String(typography.interfaceFontWeight)}
              onValueChange={(val) => updateTypography({ interfaceFontWeight: Number(val) })}
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

        {/* Code Block Typography Group */}
        <div className="rounded-xl border border-border/80 bg-card/30 p-4 space-y-4">
          <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
                Code Block Typography
              </h3>
              <p className="text-3xs text-muted-foreground">
                Monospace fonts, weights, and sizing for code blocks, diffs, and code previews.
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
            description="Monospace font family used for syntax-highlighted code blocks, diffs, and code previews."
          >
            <Select
              value={typography.codeFontFamily}
              onValueChange={(val) => updateTypography({ codeFontFamily: val })}
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
            label="Code font size"
            description={`Independent size for code blocks and diffs (${typography.codeFontSize}px). Standard is 13px.`}
          >
            <PxSizeSlider
              value={typography.codeFontSize}
              min={CODE_FONT_SIZE_CONFIG.min}
              max={CODE_FONT_SIZE_CONFIG.max}
              onChange={(val) => updateTypography({ codeFontSize: val })}
              presets={CODE_FONT_SIZE_CONFIG.presets}
              ariaLabel="Code font size"
            />
          </SettingRow>

          <SettingRow
            label="Code font weight"
            description={
              effectiveCodeWeight !== typography.codeFontWeight
                ? `Requested ${typography.codeFontWeight}, clamped to ${effectiveCodeWeight} by font capability.`
                : "Weight applied to syntax highlighting and code blocks."
            }
          >
            <Select
              value={String(typography.codeFontWeight)}
              onValueChange={(val) => updateTypography({ codeFontWeight: Number(val) })}
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
            label="Code word wrap"
            description="Wrap long lines in code blocks instead of scrolling horizontally. Visual only — copied code is unchanged. Diffs never wrap."
            control={
              <Switch
                checked={typography.codeWordWrap}
                onCheckedChange={(checked) => updateTypography({ codeWordWrap: checked })}
                aria-label="Toggle code word wrap"
              />
            }
          />
        </div>

        {/* Terminal Typography Group */}
        <div className="rounded-xl border border-border/80 bg-card/30 p-4 space-y-4">
          <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
                Terminal Typography
              </h3>
              <p className="text-3xs text-muted-foreground">
                Fonts, weights, and sizing for captured command output (run_command, OpenCode
                bash/shell), including exit and timeout lines. Status pills and badges stay on the
                fixed monospace metadata channel.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResetTerminal}
              className="h-7 px-2.5 text-3xs text-muted-foreground hover:text-foreground"
            >
              Reset terminal
            </Button>
          </div>

          <SettingRow
            label="Terminal font"
            description="Monospace font family used for captured terminal output, including exit and timeout lines."
          >
            <Select
              value={typography.terminalFontFamily}
              onValueChange={(val) => updateTypography({ terminalFontFamily: val })}
            >
              <SelectTrigger className="w-56 font-mono text-xs">
                <SelectValue placeholder="Select terminal font" />
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
            label="Terminal font size"
            description={`Independent size for terminal output, including exit and timeout lines (${typography.terminalFontSize}px). Standard is 12px.`}
          >
            <PxSizeSlider
              value={typography.terminalFontSize}
              min={TERMINAL_FONT_SIZE_CONFIG.min}
              max={TERMINAL_FONT_SIZE_CONFIG.max}
              onChange={(val) => updateTypography({ terminalFontSize: val })}
              presets={TERMINAL_FONT_SIZE_CONFIG.presets}
              ariaLabel="Terminal font size"
            />
          </SettingRow>

          <SettingRow
            label="Terminal font weight"
            description={
              effectiveTerminalWeight !== typography.terminalFontWeight
                ? `Requested ${typography.terminalFontWeight}, clamped to ${effectiveTerminalWeight} by font capability.`
                : "Weight applied to terminal output, including exit and timeout lines."
            }
          >
            <Select
              value={String(typography.terminalFontWeight)}
              onValueChange={(val) => updateTypography({ terminalFontWeight: Number(val) })}
            >
              <SelectTrigger className="w-56 font-mono text-xs">
                <SelectValue placeholder="Select terminal weight" />
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
            label="Terminal output wrapping"
            description="Wrap long lines in terminal output, preserving whitespace and indentation. Visual only — output content is unchanged."
            control={
              <Switch
                checked={typography.terminalWrap}
                onCheckedChange={(checked) => updateTypography({ terminalWrap: checked })}
                aria-label="Toggle terminal output wrapping"
              />
            }
          />
        </div>

        {/* Reading Typography Group */}
        <div className="rounded-xl border border-border/80 bg-card/30 p-4 space-y-4">
          <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
                Reading Typography
              </h3>
              <p className="text-3xs text-muted-foreground">
                Line spacing for readable prose — markdown paragraphs, list items, and reasoning.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResetReading}
              className="h-7 px-2.5 text-3xs text-muted-foreground hover:text-foreground"
            >
              Reset reading
            </Button>
          </div>

          <SettingRow
            label="Reading line height"
            description="Vertical paragraph line spacing for chat transcripts, markdown content, and reasoning."
          >
            <div
              role="group"
              aria-label="Line height"
              className="inline-flex w-fit rounded-lg border border-border bg-card/40 p-0.5"
            >
              {LINE_HEIGHTS.map((lh) => {
                const selected = typography.readingLineHeight === lh.value;
                return (
                  <button
                    key={lh.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => updateTypography({ readingLineHeight: lh.value })}
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

        {/* Application Scale Group */}
        <div className="rounded-xl border border-border/80 bg-card/30 p-4 space-y-4">
          <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
                Application Scale
              </h3>
              <p className="text-3xs text-muted-foreground">
                Scales the whole interface — navigation, cards, buttons, icons, spacing, and panels.
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
            description={`Scales the entire interface (${formatAppScale(typography.appScale)}). 100% is default. Font preferences are unchanged.`}
          >
            <div className="flex flex-col gap-2.5 w-full max-w-sm">
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={APP_SCALE_CONFIG.min}
                  max={APP_SCALE_CONFIG.max}
                  step={APP_SCALE_CONFIG.step}
                  value={typography.appScale}
                  aria-label="Application scale"
                  onChange={(e) => updateTypography({ appScale: Number(e.target.value) })}
                  className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-input/40 accent-primary focus:outline-none"
                />
                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-foreground">
                  {formatAppScale(typography.appScale)}
                </span>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                {APP_SCALE_CONFIG.presets.map((preset) => (
                  <Button
                    key={preset}
                    variant={typography.appScale === preset ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => updateTypography({ appScale: preset })}
                    className="h-6 px-2 text-3xs font-medium tabular-nums"
                  >
                    {formatAppScale(preset)}
                  </Button>
                ))}
              </div>
            </div>
          </SettingRow>
        </div>

        <TypographyPreview
          interfaceFontName={currentUiFont?.label || typography.interfaceFontFamily}
          codeFontName={currentCodeFont?.label || typography.codeFontFamily}
          terminalFontName={currentTerminalFont?.label || typography.terminalFontFamily}
          interfaceFontWeight={effectiveUiWeight}
          codeFontWeight={effectiveCodeWeight}
          terminalFontWeight={effectiveTerminalWeight}
          interfaceFontSize={typography.interfaceFontSize}
          codeFontSize={typography.codeFontSize}
          terminalFontSize={typography.terminalFontSize}
          readingLineHeight={typography.readingLineHeight}
          appScale={typography.appScale}
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
