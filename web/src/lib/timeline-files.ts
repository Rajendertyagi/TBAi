import { patchToCodeDiffs, type CodeDiffFile } from "@/lib/patch-to-diffs";

/**
 * Which files a tool call changed, and by how much.
 *
 * ## Why this exists
 *
 * The session timeline says "N steps · M files changed". `M` comes from
 * {@link TimelineStat}s, and for a long time it was **structurally always zero** on
 * the Code surface, which is the one surface where the timeline is shown at all.
 *
 * The cause is not a missing count, it is a missing *shape*: `toStats` looked for
 * `added` / `removed` on the tool's own result object, and OpenCode's `edit` and
 * `write` outputs carry neither. Nothing in the OpenCode path ever produced those
 * numbers, so the arithmetic was correct and the input was always empty. A
 * `+0 -0` chip, or a `0 files changed` label, is the honest rendering of "no
 * data" — which is exactly why it looked like a lie.
 *
 * The data was never missing. Every one of those tool calls already carries a
 * unified diff — the same patch the approval gate shows before the edit runs and
 * the completed card shows after. It carries `+`/`-` rows, so additions and
 * deletions are countable, and the app already has the counter
 * ({@link patchToCodeDiffs}) because every diff on screen is rendered from it.
 * The number was simply never wired to the label.
 *
 * ## Why `artifact`
 *
 * assistant-ui's `ToolCallMessagePart` carries `artifact?: unknown`, documented as
 * "UI-only artifact associated with the tool result". That is precisely this
 * data: derived in the browser, never sent to the model, and read only by a
 * renderer. It is part of the official library type, so no cast and no
 * app-specific metadata channel is needed.
 *
 * The alternative — writing the counts into the tool's `result` — would have been
 * a lie of a different kind: inventing fields on a payload the tool did not
 * return, in an object the card may also render.
 *
 * ## Contract
 *
 * Producer: `features/opencode` projection, which is the only place that has both
 * the patch and the part. Consumer: `components/assistant-ui/elements/session-timeline`,
 * which must not import the OpenCode feature. Both directions go through this
 * module, so the shape has exactly one definition and one validator.
 */

/** One changed file. Counts are line additions and deletions. */
export interface TimelineFile {
  /** The file as the patch names it, or the tool's `path` argument as fallback. */
  readonly file: string;
  readonly added: number;
  readonly removed: number;
}

/** The value carried on `ToolCallMessagePart.artifact` for a file-changing call. */
export interface TimelineArtifact {
  readonly files: readonly TimelineFile[];
}

/**
 * The path a tool call names, read in the order both surfaces use.
 *
 * The order is the same one the timeline's own result-reading path uses, and it
 * is kept in one place because the two must not disagree: a patch that omits its
 * filename and an argument spelled `filePath` would otherwise produce a row with
 * no name at all, which is the exact failure this module exists to remove.
 *
 * @param input - A tool call's `input` object.
 * @returns The first non-empty string among `file`, `filePath`, `path`; else "".
 */
export function timelinePathFromInput(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const record = input as { file?: unknown; filePath?: unknown; path?: unknown };
  for (const candidate of [record.file, record.filePath, record.path]) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return "";
}

/**
 * Count the files a unified patch changes.
 *
 * A patch with no nameable file still counts — the file name falls back to the
 * tool's own path argument — because a count of "3 files changed" with one row
 * unnamed is more honest than silently counting two.
 *
 * @param patch - A unified diff, as OpenCode computes it for `edit` and `write`.
 * @param fallbackPath - The tool call's path, used when the patch is unnamed.
 * @returns One entry per changed file, with real addition and deletion counts.
 */
export function timelineFilesFromPatch(
  patch: string,
  fallbackPath: string,
): readonly TimelineFile[] {
  return parsedFiles(patch, fallbackPath);
}

/**
 * The file counts published on a tool part, or `[]` when it carries none.
 *
 * Validates rather than casts: `artifact` is typed `unknown` by the library, so
 * anything can be there — a stale build, another writer, a malformed patch from
 * an older session. An unrecognised value means "no data", which renders as it
 * did before rather than as a wrong number.
 *
 * @param artifact - The part's `artifact` value, if any.
 * @returns The published counts, or an empty list.
 */
export function readTimelineFiles(artifact: unknown): readonly TimelineFile[] {
  if (artifact === null || typeof artifact !== "object") return [];
  const files = (artifact as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];
  const rows: TimelineFile[] = [];
  for (const entry of files) {
    if (entry === null || typeof entry !== "object") continue;
    const { file, added, removed } = entry as {
      file?: unknown;
      added?: unknown;
      removed?: unknown;
    };
    if (typeof file !== "string" || file === "") continue;
    if (!isCount(added) || !isCount(removed)) continue;
    rows.push({ file, added, removed });
  }
  return rows;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** `CodeDiffFile` to `TimelineFile`, falling back to the caller's path. */
function parsedFiles(patch: string, fallbackPath: string): readonly TimelineFile[] {
  if (typeof patch !== "string" || patch.trim() === "") return [];
  return patchToCodeDiffs(patch).map((file: CodeDiffFile) => ({
    file: file.filename === "" ? fallbackPath : file.filename,
    added: file.additions,
    removed: file.deletions,
  }));
}
