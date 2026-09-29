import { toolsConfig } from "@/config/tools";
import { boundText } from "@/lib/text-budget";
/**
 * Cap a long argument or result preview so a big body cannot blow up the
 * transcript.
 *
 * The limit and the wording both come from the shared budget config, so this is
 * one more consumer of the app's single answer to "how much may one rendered
 * body paint" rather than a private rule. It returns a plain string because every
 * caller pastes it inline into an argument preview where there is no room for a
 * separate element; the note is therefore part of the text, which is acceptable
 * for an ARGUMENT (a scannable summary) and would not be for a result body -
 * that is what `BoundedBody` is for.
 *
 * Character-only, which is why the note can name the exact number dropped -
 * something `BoundedBody` cannot do, because its budget may cut whole rows
 * instead. The row cap is effectively disabled here for the same reason: a
 * caller-supplied character limit is a preview choice, and a preview that also
 * silently dropped rows would be reporting two different kinds of loss.
 */
export function textPreview(text: string, max = toolsConfig.limits.toolArgPreviewMaxChars) {
  const bounded = boundText(text, { maxLines: Number.MAX_SAFE_INTEGER, maxChars: max });
  if (!bounded.truncated) return text;
  return `${bounded.text}\n${toolsConfig.copy.status.argPreviewTruncated(
    text.length - bounded.text.length,
  )}`;
}
