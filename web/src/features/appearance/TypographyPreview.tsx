import { memo } from "react";
import { SyntaxHighlighter } from "../../components/assistant-ui/elements/shiki-highlighter";
import { TerminalBlock } from "../../components/assistant-ui/elements/terminal-block";

const SAMPLE_CODE = `// TBAi code typography preview
function calculateMetrics(tokens: number, rate: number): number {
  return tokens * rate;
}`;

const SAMPLE_TERMINAL_LINES = [
  "$ bun run test",
  "bun test v1.4.4",
  " 22 pass",
  " 0 fail",
  "Ran 22 tests across 1 file.",
] as const;

export const TypographyPreview = memo(function TypographyPreview({
  interfaceFontName,
  codeFontName,
  terminalFontName,
  interfaceFontWeight,
  codeFontWeight,
  terminalFontWeight,
  interfaceFontSize,
  codeFontSize,
  terminalFontSize,
  readingLineHeight,
}: {
  interfaceFontName: string;
  codeFontName: string;
  terminalFontName: string;
  interfaceFontWeight: number;
  codeFontWeight: number;
  terminalFontWeight: number;
  interfaceFontSize: number;
  codeFontSize: number;
  terminalFontSize: number;
  readingLineHeight: number;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-4 space-y-3 transition-all shadow-xs">
      <div className="flex items-center justify-between border-b border-border/60 pb-2 flex-wrap gap-1">
        <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Live Typography Preview
        </span>
        <span className="text-3xs text-muted-foreground tabular-nums">
          UI: {interfaceFontName} • {interfaceFontSize}px • W{interfaceFontWeight} | Code:{" "}
          {codeFontName} • {codeFontSize}px • W{codeFontWeight} | Terminal: {terminalFontName} •{" "}
          {terminalFontSize}px • W{terminalFontWeight} | {readingLineHeight}x line height
        </span>
      </div>

      <div className="space-y-2">
        <h4 className="text-base font-semibold tracking-tight text-foreground">
          The quick brown fox jumps over the lazy dog
        </h4>
        <p className="text-xs text-muted-foreground">
          A provider-agnostic, local-first artificial intelligence assistant engineered for
          responsive conversation, autonomous tool orchestration, and technical workflows.
        </p>
      </div>

      <div className="pt-1">
        <div className="flex items-center justify-between text-3xs text-muted-foreground mb-1">
          <span>
            Code font: {codeFontName} ({codeFontSize}px • W{codeFontWeight})
          </span>
          <span className="font-mono">shiki: typescript</span>
        </div>
        <SyntaxHighlighter
          code={SAMPLE_CODE}
          language="typescript"
          className="rounded-lg overflow-hidden border border-border/40"
        />
      </div>

      <div className="pt-1">
        <div className="flex items-center justify-between text-3xs text-muted-foreground mb-1">
          <span>
            Terminal font: {terminalFontName} ({terminalFontSize}px • W{terminalFontWeight})
          </span>
          <span className="font-mono">run_command</span>
        </div>
        <TerminalBlock
          command="bun run test"
          lines={SAMPLE_TERMINAL_LINES}
          visibleCount={SAMPLE_TERMINAL_LINES.length}
          done={true}
          variant="ink"
        />
      </div>
    </div>
  );
});
