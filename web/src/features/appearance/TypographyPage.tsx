import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  applyTypographyToDom,
  clampWeightForFont,
  CODE_FONT_SIZE_CONFIG,
  COMMON_WEIGHTS,
  getFont,
  INTERFACE_FONT_SIZE_CONFIG,
  LINE_HEIGHTS,
  MONO_FONTS,
  readTypography,
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
import {
  applyWindowZoom,
  clampWindowZoom,
  DEFAULT_WINDOW_ZOOM,
  isTauri,
  onWindowZoomChange,
  readWindowZoom,
  WINDOW_ZOOM_MAX,
  WINDOW_ZOOM_MIN,
  WINDOW_ZOOM_PRESETS,
  WINDOW_ZOOM_STORAGE_KEY,
} from "@/lib/platform";
import { SyntaxHighlighter } from "@/components/assistant-ui/elements/shiki-highlighter";
import { TerminalBlock } from "@/components/assistant-ui/elements/terminal-block";
import { toast } from "sonner";

function SettingRow({
  label,
  description,
  badge,
  children,
}: {
  label: string;
  description?: React.ReactNode;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between border-b border-border/40 last:border-b-0">
      <div className="flex flex-col gap-0.5 min-w-0 flex-1 pr-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {badge}
        </div>
        {description ? (
          <div className="text-xs text-muted-foreground leading-relaxed">{description}</div>
        ) : null}
      </div>
      <div className="flex items-center justify-end shrink-0 sm:min-w-[200px]">{children}</div>
    </div>
  );
}

function Card({
  title,
  onReset,
  children,
}: {
  title: string;
  onReset?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-card border-none shadow-[0_4px_20px_-2px_rgba(0,0,0,0.45),0_2px_8px_-2px_rgba(0,0,0,0.3)] dark:shadow-[0_4px_20px_-2px_rgba(0,0,0,0.5),0_2px_8px_-2px_rgba(0,0,0,0.35)] overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-border/50">
        <h2 className="text-base font-semibold text-foreground tracking-tight">{title}</h2>
        {onReset ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground rounded-full"
          >
            <RotateCcw className="size-3 mr-1" />
            Reset
          </Button>
        ) : null}
      </div>
      <div className="p-6 flex flex-col gap-4">{children}</div>
    </section>
  );
}

export function TypographyPage() {
  const [typography, setTypography] = useState<TypographyConfig>(readTypography);
  const [zoom, setZoom] = useState<number>(readWindowZoom);
  const desktopZoom = isTauri();
  // Latest-request-safe: only the most recent zoom request may update displayed state.
  const zoomRequestId = useRef(0);

  // Sync confirmed window zoom from same-window changes (shortcuts/other controls) and other tabs.
  useEffect(() => {
    const off = onWindowZoomChange((value) => setZoom(clampWindowZoom(value)));
    const onStorage = (e: StorageEvent) => {
      if (e.key === WINDOW_ZOOM_STORAGE_KEY) {
        setZoom(readWindowZoom());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      off();
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const updateTypography = useCallback((patch: Partial<TypographyConfig>) => {
    setTypography((prev) => {
      const next = { ...prev, ...patch };
      writeTypography(next);
      applyTypographyToDom(next);
      return next;
    });
  }, []);

  const requestWindowZoom = useCallback(
    async (newZoom: number, opts?: { reportFailure?: boolean }): Promise<boolean> => {
      const clamped = clampWindowZoom(newZoom);
      if (!desktopZoom) return false;
      const requestId = ++zoomRequestId.current;
      const applied = await applyWindowZoom(clamped);
      if (requestId !== zoomRequestId.current) return applied;
      if (applied) {
        setZoom(clamped);
        return true;
      }
      if (opts?.reportFailure !== false) {
        toast.error("Could not apply window zoom.", { id: "window-zoom-toast" });
      }
      setZoom(readWindowZoom());
      return false;
    },
    [desktopZoom],
  );

  const handleResetAll = async () => {
    const next = resetTypography();
    setTypography(next);
    writeTypography(next);
    applyTypographyToDom(next);
    if (!desktopZoom) {
      toast.success(
        "Typography restored to default. Window zoom is available only in the desktop application.",
      );
      return;
    }
    const zoomApplied = await requestWindowZoom(DEFAULT_WINDOW_ZOOM, { reportFailure: false });
    if (zoomApplied) {
      toast.success("Typography and window zoom restored to default.");
    } else {
      toast.error("Typography restored to default. Window zoom could not be reset.");
    }
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

  const sampleCode = `export function calculateMetrics(tokens: number, rate: number): Result {
  // Production SyntaxHighlighter demonstration with live typography settings
  const elapsed = performance.now();
  return { tokens, latency: 110, rate, active: true };
}`;

  return (
    <div className="w-full h-full overflow-y-auto py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between pb-4 border-b border-border/50">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Typography</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Independent font families, weights, sizes, and native window zoom scaling.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleResetAll}
            className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground rounded-full w-fit"
          >
            <RotateCcw className="size-3.5" />
            Reset all
          </Button>
        </div>

        {/* 1. Interface Typography */}
        <Card
          title="Interface Typography"
          onReset={() => {
            const next = resetInterfaceTypography(typography);
            setTypography(next);
            writeTypography(next);
            applyTypographyToDom(next);
          }}
        >
          <SettingRow
            label="Font family"
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
            label="Font weight"
            description="Body text weight for interface elements. Clamped if font lacks requested weight."
            badge={
              effectiveUiWeight !== typography.interfaceFontWeight ? (
                <span className="text-[10.5px] font-mono px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/20">
                  Requested {typography.interfaceFontWeight} → Applied {effectiveUiWeight}
                </span>
              ) : null
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
                {COMMON_WEIGHTS.map((weight) => (
                  <SelectItem key={weight.value} value={String(weight.value)}>
                    {weight.label}
                    {weight.value === 300 ? " (Default)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            label="Font size"
            description={`Controls root rem scaling (${typography.interfaceFontSize}px). Standard is 15px; min 12px, max 24px.`}
          >
            <Select
              value={String(typography.interfaceFontSize)}
              onValueChange={(val) => updateTypography({ interfaceFontSize: Number(val) })}
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from(
                  { length: INTERFACE_FONT_SIZE_CONFIG.max - INTERFACE_FONT_SIZE_CONFIG.min + 1 },
                  (_, i) => INTERFACE_FONT_SIZE_CONFIG.min + i,
                ).map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}px{size === 15 ? " (Default)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <div className="rounded-xl bg-muted/20 p-4 border border-border/30">
            <div className="text-[10.5px] uppercase font-mono tracking-wider text-muted-foreground mb-2">
              Interface Preview
            </div>
            <div
              style={{
                fontFamily: currentUiFont?.stack,
                fontWeight: effectiveUiWeight,
                fontSize: `${typography.interfaceFontSize}px`,
                lineHeight: typography.readingLineHeight,
              }}
              className="text-foreground"
            >
              The quick brown fox jumps over the lazy dog. A provider-agnostic, local-first AI
              assistant for responsive conversation and technical workflows.
            </div>
          </div>
        </Card>

        {/* 2. Code Block Typography */}
        <Card
          title="Code Block Typography"
          onReset={() => {
            const next = resetCodeTypography(typography);
            setTypography(next);
            writeTypography(next);
            applyTypographyToDom(next);
          }}
        >
          <SettingRow
            label="Code font family"
            description="Dedicated monospace font applied across code blocks and syntaxes."
          >
            <Select
              value={typography.codeFontFamily}
              onValueChange={(val) => updateTypography({ codeFontFamily: val })}
            >
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Select code font" />
              </SelectTrigger>
              <SelectContent>
                {MONO_FONTS.map((font) => (
                  <SelectItem key={font.id} value={font.id}>
                    {font.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            label="Code font weight"
            description="Weight applied to code tokens and code block text."
            badge={
              effectiveCodeWeight !== typography.codeFontWeight ? (
                <span className="text-[10.5px] font-mono px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/20">
                  Requested {typography.codeFontWeight} → Applied {effectiveCodeWeight}
                </span>
              ) : null
            }
          >
            <Select
              value={String(typography.codeFontWeight)}
              onValueChange={(val) => updateTypography({ codeFontWeight: Number(val) })}
            >
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Select code weight" />
              </SelectTrigger>
              <SelectContent>
                {COMMON_WEIGHTS.map((weight) => (
                  <SelectItem key={weight.value} value={String(weight.value)}>
                    {weight.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            label="Code font size"
            description={`Independent font size for code blocks (${typography.codeFontSize}px). Range 11–20px.`}
          >
            <Select
              value={String(typography.codeFontSize)}
              onValueChange={(val) => updateTypography({ codeFontSize: Number(val) })}
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from(
                  { length: CODE_FONT_SIZE_CONFIG.max - CODE_FONT_SIZE_CONFIG.min + 1 },
                  (_, i) => CODE_FONT_SIZE_CONFIG.min + i,
                ).map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}px{size === 13 ? " (Default)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            label="Code word wrap"
            description="Wrap long lines in code blocks instead of scrolling horizontally. Visual only — copied code is unchanged. Diffs never wrap."
          >
            <Switch
              checked={typography.codeWordWrap}
              onCheckedChange={(val) => updateTypography({ codeWordWrap: val })}
              aria-label="Toggle code word wrap"
            />
          </SettingRow>

          <div className="rounded-xl bg-muted/20 p-4 border border-border/30 space-y-3">
            <div className="text-[10.5px] uppercase font-mono tracking-wider text-muted-foreground">
              Production SyntaxHighlighter Preview (respects Code word wrap)
            </div>
            <div className="overflow-hidden rounded-lg">
              <SyntaxHighlighter code={sampleCode} language="typescript" />
            </div>
          </div>
        </Card>

        {/* 3. Terminal Typography */}
        <Card
          title="Terminal Typography"
          onReset={() => {
            const next = resetTerminalTypography(typography);
            setTypography(next);
            writeTypography(next);
            applyTypographyToDom(next);
          }}
        >
          <SettingRow
            label="Terminal font family"
            description="Dedicated monospace font applied to command execution output and terminal logs."
          >
            <Select
              value={typography.terminalFontFamily}
              onValueChange={(val) => updateTypography({ terminalFontFamily: val })}
            >
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Select terminal font" />
              </SelectTrigger>
              <SelectContent>
                {MONO_FONTS.map((font) => (
                  <SelectItem key={font.id} value={font.id}>
                    {font.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            label="Terminal font weight"
            description="Weight applied to terminal and command output."
            badge={
              effectiveTerminalWeight !== typography.terminalFontWeight ? (
                <span className="text-[10.5px] font-mono px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/20">
                  Requested {typography.terminalFontWeight} → Applied {effectiveTerminalWeight}
                </span>
              ) : null
            }
          >
            <Select
              value={String(typography.terminalFontWeight)}
              onValueChange={(val) => updateTypography({ terminalFontWeight: Number(val) })}
            >
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Select terminal weight" />
              </SelectTrigger>
              <SelectContent>
                {COMMON_WEIGHTS.map((weight) => (
                  <SelectItem key={weight.value} value={String(weight.value)}>
                    {weight.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            label="Terminal font size"
            description={`Font size for terminal command logs (${typography.terminalFontSize}px). Range 10–20px.`}
          >
            <Select
              value={String(typography.terminalFontSize)}
              onValueChange={(val) => updateTypography({ terminalFontSize: Number(val) })}
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from(
                  { length: TERMINAL_FONT_SIZE_CONFIG.max - TERMINAL_FONT_SIZE_CONFIG.min + 1 },
                  (_, i) => TERMINAL_FONT_SIZE_CONFIG.min + i,
                ).map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}px{size === 12 ? " (Default)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            label="Terminal output wrapping"
            description="Wrap long lines in terminal output, preserving whitespace and indentation. Visual only."
          >
            <Switch
              checked={typography.terminalWrap}
              onCheckedChange={(val) => updateTypography({ terminalWrap: val })}
              aria-label="Toggle terminal output wrapping"
            />
          </SettingRow>

          <div className="rounded-xl bg-muted/20 p-4 border border-border/30 space-y-2">
            <div className="text-[10.5px] uppercase font-mono tracking-wider text-muted-foreground">
              Production TerminalBlock Preview
            </div>
            <TerminalBlock
              command="bun test tests/unit/appearance/typography.test.ts"
              lines={[
                "✓ typography config validates weights [0.4ms]",
                "✓ root rem scales accurately [1.1ms]",
                "Ran 29 tests across 1 file. [108.00ms]",
              ]}
              visibleCount={3}
              done={true}
              status="success"
            />
          </div>
        </Card>

        {/* 4. Window zoom & Reading */}
        <Card
          title="Window zoom & Reading"
          onReset={() => {
            const next = resetReadingTypography(typography);
            setTypography(next);
            writeTypography(next);
            applyTypographyToDom(next);
            if (desktopZoom) {
              void requestWindowZoom(DEFAULT_WINDOW_ZOOM);
            }
          }}
        >
          {/* Window Zoom Row */}
          <div className="flex flex-col gap-3 py-2 border-b border-border/40">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className="text-sm font-medium text-foreground">Window zoom</span>
                  <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-primary/10 text-primary font-semibold">
                    Current zoom: {Math.round(zoom * 100)}%
                  </span>
                  {desktopZoom && zoom !== 1.0 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void requestWindowZoom(1.0)}
                      className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground rounded-full"
                    >
                      100% (Default)
                    </Button>
                  ) : null}
                </div>
                <div className="text-xs text-muted-foreground mt-1 max-w-xl leading-relaxed">
                  {desktopZoom
                    ? "Scale the entire interface. Applies immediately and persists per device. ⌘/Ctrl + and - move through the same zoom levels as this menu (⌘/Ctrl 0 resets to 100%)."
                    : "Native window zoom is available only in the desktop application. Use your browser's zoom controls in browser mode."}
                </div>
              </div>

              <div className="shrink-0 sm:min-w-[180px] flex justify-end">
                <Select
                  value={String(zoom)}
                  onValueChange={(val) => void requestWindowZoom(Number(val))}
                  disabled={!desktopZoom}
                >
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WINDOW_ZOOM_PRESETS.map((preset) => (
                      <SelectItem key={preset} value={String(preset)}>
                        {Math.round(preset * 100)}%{preset === 1.0 ? " (Default)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Slider and preset pills */}
            <div className="flex flex-col gap-2 pt-1">
              <input
                type="range"
                min={WINDOW_ZOOM_MIN}
                max={WINDOW_ZOOM_MAX}
                step={0.05}
                value={zoom}
                onChange={(e) => void requestWindowZoom(Number(e.target.value))}
                disabled={!desktopZoom}
                className="w-full accent-primary h-2 bg-input/40 rounded-lg cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Window zoom range slider"
              />
              <div className="flex items-center gap-1.5 flex-wrap pt-1">
                {WINDOW_ZOOM_PRESETS.map((preset) => (
                  <Button
                    key={preset}
                    variant={zoom === preset ? "default" : "secondary"}
                    size="sm"
                    onClick={() => void requestWindowZoom(preset)}
                    disabled={!desktopZoom}
                    className="h-7 px-2.5 text-xs font-medium tabular-nums rounded-md"
                  >
                    {Math.round(preset * 100)}%
                  </Button>
                ))}
              </div>
            </div>
          </div>

          {/* Reading line spacing row */}
          <SettingRow
            label="Reading line spacing"
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
        </Card>
      </div>
    </div>
  );
}
export default TypographyPage;
