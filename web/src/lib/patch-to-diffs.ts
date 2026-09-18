import parseDiff from "parse-diff";
import type { DiffLine } from "@/components/assistant-ui/elements/code-diff";

/**
 * Unified-diff text → the structured shape the official `CodeDiff` element
 * consumes, one entry per file.
 *
 * WHY THIS EXISTS. `CodeDiff` takes `{ filename, additions, deletions, lines }`
 * — already-parsed, single-file data — while every diff this app renders arrives
 * as a unified-diff **string**: an OpenCode `edit` patch, or a ```diff fence in a
 * model's reply. This is the one place that conversion happens, so both call
 * sites share it instead of each re-deriving counts and line kinds.
 *
 * The parsing rules were carried over verbatim from the legacy `DiffViewer`
 * (since deleted — this module is its replacement), because they encode real
 * observed behaviour:
 *
 *   1. `parse-diff` for a well-formed unified patch.
 *   2. **`parseLooseDiff` as a fallback** — models routinely emit bare `+`/`-`
 *      lines with no `---`/`+++`/`@@` headers, which `parse-diff` rejects. Without
 *      this the fence collapses to nothing. This is load-bearing, not a nicety.
 *   3. Otherwise no files, and the caller renders its empty state.
 *
 * Nothing is fabricated: a file with no name in the patch gets `filename: ""`
 * (an empty header, never an invented one), and no line is synthesised that the
 * patch does not contain.
 */

export interface CodeDiffFile {
  /** The patch's own file name, or `""` when it declares none. Never invented. */
  filename: string;
  additions: number;
  deletions: number;
  /** The file's lines, in patch order. */
  lines: DiffLine[];
}

/** Parses one unified patch via `parse-diff`, one entry per file. */
function parseStrict(patch: string): CodeDiffFile[] {
  return parseDiff(patch).map((file) => {
    const lines: DiffLine[] = [];
    let additions = 0;
    let deletions = 0;
    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        // `content` carries the patch's own marker character, which the
        // element draws itself — so it is stripped here, exactly as before.
        const text = change.content.slice(1);
        if (change.type === "add") {
          additions++;
          lines.push({ kind: "added", text });
        } else if (change.type === "del") {
          deletions++;
          lines.push({ kind: "removed", text });
        } else {
          lines.push({ kind: "context", text });
        }
      }
    }
    return {
      filename: file.to || file.from || "",
      additions,
      deletions,
      lines,
    };
  });
}

/**
 * Line-based fallback for text that is not a valid unified patch — bare
 * `+`/`-`/space lines with no headers. Classifies each line by its leading
 * marker so a model's informal diff still renders as a diff.
 */
function parseLoose(patch: string): CodeDiffFile | null {
  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      additions++;
      lines.push({ kind: "added", text: raw.slice(1) });
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      deletions++;
      lines.push({ kind: "removed", text: raw.slice(1) });
    } else if (raw.trim().length > 0) {
      lines.push({
        kind: "context",
        text: raw.startsWith(" ") ? raw.slice(1) : raw,
      });
    }
  }
  return lines.length > 0 ? { filename: "", additions, deletions, lines } : null;
}

/**
 * Converts a unified-diff string into one structured diff per file.
 *
 * @param patch - The raw patch text (an OpenCode `edit` patch, or a ```diff
 *   fence's contents).
 * @returns One entry per file, in patch order; `[]` when the text is empty or
 *   yields no diff at all, which the caller renders as its empty state.
 */
export function patchToCodeDiffs(patch: string): CodeDiffFile[] {
  if (!patch) return [];

  const strict = parseStrict(patch);
  if (strict.length > 0) return strict;

  const loose = parseLoose(patch);
  return loose ? [loose] : [];
}
