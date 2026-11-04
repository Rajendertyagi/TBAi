import { memo } from "react";
import { SyntaxHighlighter } from "../../components/assistant-ui/elements/shiki-highlighter";

export const TypographyPreview = memo(function TypographyPreview({
  fontFamilyName,
  monoFontFamilyName,
  fontWeight,
  lineHeight,
  baseSize,
}: {
  fontFamilyName: string;
  monoFontFamilyName: string;
  fontWeight: number;
  lineHeight: number;
  baseSize: number;
}) {
  const sampleCode = `// TBAi typography preview
function calculateMetrics(tokens: number, rate: number): number {
  return tokens * rate;
}`;

  return (
    <div className="rounded-xl border border-border bg-card/60 p-4 space-y-3 transition-all shadow-xs">
      <div className="flex items-center justify-between border-b border-border/60 pb-2">
        <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Live Typography Preview
        </span>
        <span className="text-3xs text-muted-foreground tabular-nums">
          {fontFamilyName} • {baseSize}px ({Math.round((baseSize / 16) * 100)}%) • W{fontWeight} •{" "}
          {lineHeight}x
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
          <span>Code font: {monoFontFamilyName}</span>
          <span className="font-mono">shiki: typescript</span>
        </div>
        <SyntaxHighlighter
          code={sampleCode}
          language="typescript"
          className="rounded-lg overflow-hidden border border-border/40 text-xs"
        />
      </div>
    </div>
  );
});
