import type { ReactNode } from "react";
import { toolsConfig } from "@/config/tools";
import { boundText, type BoundedText } from "@/lib/text-budget";

/**
 * The pre-render budget for a tool RESULT body.
 *
 * ## The gap this closes
 *
 * `Json` - the component behind every tool's result, and behind `read_file` -
 * rendered `JSON.stringify(value, null, 2)` into a `<pre>` with no size limit
 * at all. A `read_file` on a large file put the entire file into the DOM. The
 * `max-h-64 overflow-auto` on that `<pre>` is not a bound: it clips text that has
 * already been serialised, inserted and laid out.
 *
 * The browser tool was worse in a different way. It sliced its output at a
 * hardcoded 4000 characters and said nothing, so a reader saw a short block and
 * had no way to know it was one tenth of what the tool actually returned. A
 * silent truncation is worse than none: it looks like a complete answer.
 *
 * ## Why a component and not a helper
 *
 * The omission has to be visible, and a string return cannot carry it honestly.
 * OpenChamber's `capToolOutputText` bakes the notice into the returned text
 * (`… [output truncated: N more characters not shown…]`), which is simple but
 * makes the notice indistinguishable from content and - as they note in their
 * own code - leaves a truncated JSON body no longer parseable. Here the bound
 * and the notice are separate, so the note is its own element.
 *
 * ## What the bound does and does not cover
 *
 * For a STRING result - which is what `read_file` returns - nothing is
 * serialised, so the budget is fully effective: the oversized text is never
 * built, only the bounded prefix is.
 *
 * For an OBJECT result the value is already in memory and `JSON.stringify` runs
 * before anything can be measured. The budget then bounds what is rendered
 * (DOM and layout) but not the serialisation itself. That is stated rather than
 * hidden: bounding a serialisation would mean walking the object instead, which
 * is a different mechanism for a case that does not arise - the tool arguments
 * and small structured results that reach here are orders of magnitude below
 * the budget. The case that does arise is the string, and the string is covered.
 */

/** The card body chrome, shared so every bounded body looks like every other. */
const PRE_CLASS =
  "max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground";

/**
 * Apply the tool-body budget.
 *
 * @param text - The full body text.
 * @returns The bounded text and exactly what the bound removed.
 */
export function boundToolBody(text: string): BoundedText {
  const { toolBodyMaxLines, toolBodyMaxChars } = toolsConfig.limits;
  return boundText(text, {
    maxLines: toolBodyMaxLines,
    maxChars: toolBodyMaxChars,
  });
}

/**
 * A tool result body, bounded before it is rendered, with the omission shown.
 *
 * The note sits below the body rather than inside it, for the same reason the
 * code fence's does: a reader has to be able to tell what the tool said from
 * what the app did to it.
 *
 * ## There is deliberately no `children` escape hatch
 *
 * A `children` prop here would let a caller render unbounded text next to a
 * correctly computed bound - the budget computed, the marker shown, and the full
 * body painted anyway. That is not hypothetical: it is the mistake the code
 * fence's own `code={props.code}` regression was, and it is invisible to every
 * test that checks the arithmetic. So the only things a caller can supply are
 * the text and an `empty` state for when there is none, and the painted content
 * is always `bounded.text`.
 */
export function BoundedBody({ text, empty }: { text: string; empty?: ReactNode }) {
  const bounded = boundToolBody(text);
  return (
    <div className="aui-tool-body">
      <pre className={PRE_CLASS}>{text ? bounded.text : (empty ?? bounded.text)}</pre>
      {bounded.truncated && (
        <p
          role="status"
          className="aui-tool-body-truncated text-muted-foreground px-3.5 py-1.5 text-[11px]"
        >
          {toolsConfig.copy.status.toolBodyTruncated(bounded.omitted)}
        </p>
      )}
    </div>
  );
}
