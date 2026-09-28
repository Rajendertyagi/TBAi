import parseDiff from "parse-diff";
import type { DiffLine } from "@/components/assistant-ui/elements/code-diff";
import { toolsConfig } from "@/config/tools";

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
 * patch does not contain — with one deliberate exception, the omission marker
 * {@link trimOversizeFile} inserts, which says in as many words that rows are
 * missing.
 */

const { diffPreviewMaxChars: MAX_CHARS, diffPreviewMaxLines: MAX_LINES } =
  toolsConfig.limits;

/** Per-side share of the budget the head and the tail each get. */
const SIDE_LINES = Math.floor(MAX_LINES / 2);
const SIDE_CHARS = Math.floor(MAX_CHARS / 2);

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
 * Total characters one file's rows occupy, used only to decide whether the
 * budget is already exceeded.
 */
function countChars(lines: readonly DiffLine[]): number {
  return lines.reduce((total, line) => total + line.text.length, 0);
}

/**
 * Keeps the head and the tail of an oversized file's rows and drops the middle,
 * naming how many rows went missing in a single marker row.
 *
 * WHY THE MIDDLE, NOT A PLAIN-TEXT FALLBACK (the OpenChamber reference discards
 * the structured diff and shows a character-truncated preview instead): a diff is
 * read for its edges — the first hunk says where a change starts, the last one
 * where it ends — so trimming the middle keeps both readable, and the card's
 * `+N −N` header still reports the real change size because those counts come
 * from the full patch, not from the window. Only the omitted rows are gone, and
 * the marker says so.
 *
 * A single row is never cut: the budgets bound how much of the file is kept, not
 * the length of a row the patch really contains, because a half-row reads as
 * part of the file's content and a base64/minified line has no honest cut point.
 * The row count is therefore the hard guarantee; the character budget only
 * decides how much is kept once rows are individually enormous.
 *
 * @returns `file` untouched when it is within budget, otherwise the same file
 *   with a windowed `lines` array and the counts left as parsed.
 */
function trimOversizeFile(file: CodeDiffFile): CodeDiffFile {
  if (file.lines.length <= MAX_LINES && countChars(file.lines) <= MAX_CHARS) {
    return file;
  }

  const head: DiffLine[] = [];
  const tail: DiffLine[] = [];
  let headChars = 0;
  let tailChars = 0;
  // First row the tail may take, so head and tail can never claim the same row.
  let splitAt = 0;

  for (let i = 0; i < file.lines.length && head.length < SIDE_LINES; i += 1) {
    const line = file.lines[i];
    if (head.length > 0 && headChars + line.text.length > SIDE_CHARS) break;
    head.push(line);
    headChars += line.text.length;
    splitAt = i + 1;
  }
  for (
    let i = file.lines.length - 1;
    i >= splitAt && tail.length < SIDE_LINES;
    i -= 1
  ) {
    const line = file.lines[i];
    if (tail.length > 0 && tailChars + line.text.length > SIDE_CHARS) break;
    tail.push(line);
    tailChars += line.text.length;
  }

  const omitted = file.lines.length - head.length - tail.length;
  if (omitted <= 0) return file;

  return {
    ...file,
    lines: [
      ...head,
      { kind: "context", text: toolsConfig.copy.status.diffRowsOmitted(omitted) },
      ...tail.reverse(),
    ],
  };
}

/**
 * Converts a unified-diff string into one structured diff per file, each file
 * held to the diff render budget (`toolsConfig.limits`).
 *
 * @param patch - The raw patch text (an OpenCode `edit` patch, or a ```diff
 *   fence's contents).
 * @returns One entry per file, in patch order; `[]` when the text is empty or
 *   yields no diff at all, which the caller renders as its empty state.
 */
export function patchToCodeDiffs(patch: string): CodeDiffFile[] {
  if (!patch) return [];

  const strict = parseStrict(patch);
  if (strict.length > 0) return strict.map(trimOversizeFile);

  const loose = parseLoose(patch);
  return loose ? [trimOversizeFile(loose)] : [];
}
