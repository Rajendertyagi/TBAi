import type { FC } from "react";
import { toolsConfig } from "@/config/tools";
import { boundText, type OmittedContent } from "@/lib/text-budget";
import { SyntaxHighlighter as SyntaxHighlighterBase } from "./shiki-highlighter.aui";
import type { HighlighterProps } from "./shiki-highlighter.aui";

/** Re-exported so a fence-shaped caller need not know the shared module exists. */
export type { OmittedContent };

/**
 * A pre-render budget for settled Markdown code fences.
 *
 * ## The gap this closes
 *
 * The terminal block, the diff preview and the tool fallback all bound their
 * payload before rendering (`TERMINAL_MAX_LINES`, `diffPreviewMaxLines` /
 * `diffPreviewMaxChars`, `textPreview`). The code-fence path bound nothing: a
 * settled fence went straight into Shiki's Oniguruma WASM tokenization on the
 * main thread, and every line became a DOM row. A 5000-line file in a reply —
 * a pasted log, a generated file, a minified bundle — paid all of that with no
 * ceiling. A CSS `max-height` was not an answer: it clips what is already
 * painted and still costs the full tokenization and the full DOM.
 *
 * ## Where the bound goes, and why here
 *
 * `CodeBlockOverride` in the library resolves its highlighter as
 * `componentsByLanguage[language]?.SyntaxHighlighter ?? components.SyntaxHighlighter`
 * (`@assistant-ui/react-markdown/dist/overrides/CodeOverride.js:28`). Two
 * consequences shape this design:
 *
 * - `componentsByLanguage` is keyed by the EXACT parsed language and has **no
 *   catch-all**, so registering one entry would bound exactly one language and
 *   leave `rust`, `""` and every other fence untouched. The universal seam is
 *   `components.SyntaxHighlighter` — the fallback — so that is what this
 *   registers. Mermaid keeps its own renderer, because it arrives through
 *   `componentsByLanguage` and therefore still wins.
 * - `CodeBlock` renders `CodeHeader` with the ORIGINAL `code` and the
 *   highlighter separately (`CodeBlock.js:9-18`). Only the highlighter is
 *   bounded, so the copy button still copies the complete fence and the
 *   language label is untouched.
 *
 * This mirrors `mermaid-source.tsx`: an app-owned wrapper in this directory
 * that delegates to the vendored element, keeping the vendored file
 * byte-identical to upstream.
 *
 * ## Head-only, not head+tail
 *
 * The diff preview trims head AND tail, because a change can be anywhere in a
 * file. A truncated code fence is not that: a reader opening a cut-off file
 * wants the top of it. A tail of a code block is arbitrary, so there is none.
 *
 * ## The budget is PER FENCE, like every other budget here
 *
 * `diffPreviewMaxChars` is "characters of ONE file's diff preview" and
 * `TERMINAL_MAX_LINES` is a per-terminal cap. This matches both: each fence
 * gets the full budget. A message with N fences therefore costs up to N × the
 * budget, which is the same relationship N tool cards already have with N
 * terminal blocks. It is deterministic, and it keeps the guarantee simple —
 * "no single code block can exceed this" — rather than a per-message budget
 * that needs a shared counter threaded through a pure render.
 */

/** The bounded payload plus what was dropped, so the UI can say so honestly. */
export interface BoundedCodeFence {
  /** What the highlighter may receive. Never larger than the budget. */
  readonly code: string;
  /** True when `code` is not the whole fence. */
  readonly truncated: boolean;
  /** What the bound removed. Never both-zero while `truncated` is true. */
  readonly omitted: OmittedContent;
}

/**
 * Applies the code-fence budget to a fence's text.
 *
 * Two limits, because each catches what the other cannot: the line limit
 * bounds a long-but-narrow file, and the character limit bounds a single
 * enormous line — a minified bundle, a base64 blob, a one-line JSON payload —
 * which no line count would ever notice. The same pairing the diff budget
 * already uses, for the same reason.
 *
 * A fence at or under both limits is returned UNCHANGED, byte for byte, so
 * ordinary code renders exactly as it did before.
 *
 * The rule itself - including the trailing-newline and surrogate handling that
 * the browser forced into existence - lives in `lib/text-budget.ts`, shared with
 * tool result bodies. This function is the fence-shaped front door to it, and
 * exists only so the fence budget can name its own limits.
 *
 * @param code - The fence's full text.
 * @returns The bounded text and exactly what the bound removed.
 */
export function boundCodeFence(code: string): BoundedCodeFence {
  const { codeBlockMaxLines, codeBlockMaxChars } = toolsConfig.limits;
  const { text, truncated, omitted } = boundText(code, {
    maxLines: codeBlockMaxLines,
    maxChars: codeBlockMaxChars,
  });
  return { code: text, truncated, omitted };
}

/**
 * The `components.SyntaxHighlighter` this app registers: the vendored Shiki
 * element, fed a bounded payload.
 *
 * The truncated prefix still goes through the real highlighter, so colours and
 * the language label are unchanged - a bounded fence is a shorter fence, not a
 * different renderer. The note is rendered beside the block rather than inside
 * the `<pre>`, so it cannot be mistaken for code and is not part of what the
 * copy button hands over.
 *
 * The note is wrapped together with the code rather than left as a loose
 * sibling. The library renders the code header and the highlighter as siblings
 * with no shared container (`CodeBlock.js:9-18`), so the note would otherwise
 * be the only element in the fence that nothing relates to - not to the code,
 * and not to the header that owns the copy button. A wrapper gives it a parent
 * to be a child of, which is what makes it selectable and styleable as part of
 * the block rather than as a stray paragraph in the message.
 */
export const BoundedSyntaxHighlighter: FC<HighlighterProps> = (props) => {
  const bounded = boundCodeFence(props.code);
  return (
    <div className="aui-code-block">
      <SyntaxHighlighterBase {...props} code={bounded.code} />
      {bounded.truncated && (
        <p
          role="status"
          className="aui-code-truncated border-border/50 text-muted-foreground border-t px-3.5 py-1.5 text-[11px]"
        >
          {toolsConfig.copy.status.codeFenceTruncated(bounded.omitted)}
        </p>
      )}
    </div>
  );
};

BoundedSyntaxHighlighter.displayName = "BoundedSyntaxHighlighter";
