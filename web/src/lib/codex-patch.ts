/**
 * OpenCode v2's `patch` tool input -> the unified diff this app already renders.
 *
 * ## Why this module exists
 *
 * `patch` is one of OpenCode v2's built-ins and TBAi had no renderer for it, so
 * every patch call fell through to the generic `ToolFallback`. Adding a card is
 * only half the job: the tool's input is NOT a unified diff, so the existing
 * `patchToCodeDiffs` cannot read it.
 *
 * ## The format, read from OpenCode itself
 *
 * Not inferred from a renderer or a screenshot. OpenCode 2.0.15's own bundled
 * patch parser (`Patch.*`, recovered from the shipped `opencode.exe` string
 * table) is the reference, and its own error strings state the grammar:
 *
 *     is not a valid hunk header. Valid hunk headers: '*** Add File: {path}',
 *     '*** Delete File: {path}', '*** Update File: {path}'
 *
 * The envelope is:
 *
 *     *** Begin Patch
 *     *** Add File: src/new.ts
 *     +export const a = 1
 *     *** Update File: src/old.ts
 *     @@
 *      const keep = true
 *     -const gone = 1
 *     +const here = 1
 *     *** End of File
 *     *** Delete File: src/gone.ts
 *     *** End Patch
 *
 * Facts taken from that parser, each of which this module implements:
 *
 *  - `*** Begin Patch` / `*** End Patch` frame the body. Both are checked, and a
 *    missing one is an error there — so a missing frame is a real error here too,
 *    not something to paper over.
 *  - An optional `*** Environment ID: <id>` line may sit first.
 *  - `*** Add File: ` / `*** Delete File: ` / `*** Update File: ` are the three
 *    headers, with those exact prefixes (14, 17 and 17 characters).
 *  - A delete has NO body lines. OpenCode errors on one, so a body is not
 *    silently absorbed.
 *  - Inside an update, hunks open with `@@` or `@@ <context>`, body lines are
 *    ` ` / `+` / `-`, and `*** End of File` marks a hunk reaching the file's end.
 *  - A `@@` hunk with no lines before the next header is an error there.
 *
 * ## Why it emits a unified diff instead of its own diff structure
 *
 * `patchToCodeDiffs` already owns every rule that matters: the `parse-diff`
 * path, the loose `+`/`-` fallback, the row/char budget, and the omission marker
 * that says rows are missing. Emitting its input format means this module has one
 * job — translate a header — and the diff rules stay in one place. A second diff
 * renderer would be the duplication this repo's rules exist to prevent.
 *
 * Hunk line numbers are COMPUTED from the lines actually present, because
 * `parse-diff` validates them. That is arithmetic on the input, not invention:
 * the counts are what the text says. Context that OpenCode elided is not
 * reconstructed — a hunk is reported at the position it appears, and the omission
 * is visible as a diff that starts mid-file.
 */

/** The three section headers OpenCode accepts, longest-prefix first. */
const SECTION_HEADERS = [
  { prefix: "*** Add File: ", kind: "add" },
  { prefix: "*** Update File: ", kind: "update" },
  { prefix: "*** Delete File: ", kind: "delete" },
] as const;

/**
 * The same three headers WITHOUT their trailing space.
 *
 * A header that names a kind but no path right-trims down to one of these, so
 * matching on them is how "the header is real but the path is missing" is told
 * apart from "this is not a header at all". The two deserve different messages:
 * the first is a patch the author can fix, the second is a grammar error.
 */
const SECTION_WORDS = SECTION_HEADERS.map((h) => ({
  word: h.prefix.trimEnd(),
  kind: h.kind,
}));

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const END_OF_FILE = "*** End of File";
const ENVIRONMENT_ID = "*** Environment ID:";

export type CodexPatchSectionKind = (typeof SECTION_HEADERS)[number]["kind"];

export interface CodexPatchSection {
  readonly kind: CodexPatchSectionKind;
  /** The path exactly as the header spelled it. Never invented. */
  readonly path: string;
  /**
   * The section's lines, with their diff marker (` `, `+`, `-`) kept.
   * Empty for a delete, which carries no body.
   */
  readonly lines: readonly string[];
  /** True when the section was closed by `*** End of File`. */
  readonly endOfFile: boolean;
}

export interface CodexPatchProblem {
  /** The 1-based line number in the input, for the message. */
  readonly lineNumber: number;
  readonly message: string;
}

/**
 * Parse an OpenCode `patchText` envelope.
 *
 * @param text - The tool's `patchText` argument.
 * @returns The sections, or a problem naming the first thing that did not parse.
 */
export function parseCodexPatch(
  text: unknown,
): { sections: CodexPatchSection[] } | { problem: CodexPatchProblem } {
  if (typeof text !== "string" || text.trim() === "") {
    return { problem: { lineNumber: 0, message: "The patch is empty." } };
  }
  // `split(/\r?\n/)` already consumes the CR of a CRLF pair, so a Windows-authored
  // patch needs no extra strip here. An earlier version had one and it could
  // never fire — dead code that read as if CRLF were being handled deliberately.
  const lines = text.split(/\r?\n/);

  const first = lines[0]?.trim() ?? "";
  const last = lines[lines.length - 1]?.trim() ?? "";
  if (first !== BEGIN) {
    return {
      problem: {
        lineNumber: 1,
        message: `The first line of the patch must be '${BEGIN}'.`,
      },
    };
  }
  if (last !== END) {
    return {
      problem: {
        lineNumber: lines.length,
        message: `The last line of the patch must be '${END}'.`,
      },
    };
  }

  const sections: CodexPatchSection[] = [];
  let current: { kind: CodexPatchSectionKind; path: string; lines: string[] } | null = null;
  let endOfFile = false;

  /**
   * Close whatever section is open, refusing an update that carried no lines.
   *
   * A delete is closed here too rather than by a branch of its own: it has no
   * body, so routing it through the same path is what keeps the three kinds in
   * one code path and one order.
   */
  const closeCurrent = (lineNumber: number) => {
    if (current === null) return null;
    if (current.kind !== "delete" && current.lines.length === 0) {
      return {
        problem: { lineNumber, message: "Update hunk does not contain any lines." },
      } satisfies { problem: CodexPatchProblem };
    }
    sections.push({
      kind: current.kind,
      path: current.path,
      lines: current.lines,
      endOfFile: current.kind === "delete" ? false : endOfFile,
    });
    current = null;
    endOfFile = false;
    return null;
  };

  for (let i = 1; i < lines.length - 1; i += 1) {
    const raw = lines[i] ?? "";
    const line = raw.trim();

    if (line === "") continue;

    // Headers are matched against a RIGHT-trimmed line, not a fully trimmed
    // one. `*** Add File: ` with no path right-trims to a bare header word, and
    // that is the only way a missing path can be told apart from an unknown
    // header — so `bareWord` is checked BEFORE the prefix match and is the one
    // place a missing path is reported. A separate `path === ""` test after the
    // match is unreachable: right-trimming has already emptied the remainder.
    const headerLine = raw.trimEnd();
    const header = SECTION_HEADERS.find((h) => headerLine.startsWith(h.prefix));
    // A header word with nothing after it: real header, missing path.
    const bareWord = header
      ? null
      : SECTION_WORDS.find((w) => line === w.word);
    if (bareWord) {
      return {
        problem: {
          lineNumber: i + 1,
          message: `A ${bareWord.kind} header carries no path.`,
        },
      };
    }

    if (current === null) {
      if (i === 1 && line.startsWith(ENVIRONMENT_ID)) continue;
      if (!header) {
        return {
          problem: {
            lineNumber: i + 1,
            message: `'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
          },
        };
      }
      const path = headerLine.slice(header.prefix.length).trim();
      if (header.kind === "delete") {
        // OpenCode rejects a body after a delete header, so record and move on.
        const next = (lines[i + 1] ?? "").trim();
        if (next !== "" && !next.startsWith("*** ")) {
          return {
            problem: {
              lineNumber: i + 2,
              message: `Unexpected line after Delete File '${path}': '${next}'. Delete hunks do not contain body lines`,
            },
          };
        }
        sections.push({ kind: "delete", path, lines: [], endOfFile: false });
        continue;
      }
      current = { kind: header.kind, path, lines: [] };
      endOfFile = false;
      continue;
    }

    if (line === END_OF_FILE) {
      // Set BEFORE closing: closeCurrent reads the flag to stamp the section it
      // pushes, so setting it afterwards silently records endOfFile: false.
      endOfFile = true;
      const closed = closeCurrent(i + 1);
      if (closed) return closed;
      continue;
    }

    // A new section header closes the one in progress. This includes a delete,
    // which is why closeCurrent handles the empty-body case.
    if (header) {
      const closed = closeCurrent(i + 1);
      if (closed) return closed;
      const path = headerLine.slice(header.prefix.length).trim();
      if (header.kind === "delete") {
        const next = (lines[i + 1] ?? "").trim();
        if (next !== "" && !next.startsWith("*** ")) {
          return {
            problem: {
              lineNumber: i + 2,
              message: `Unexpected line after Delete File '${path}': '${next}'. Delete hunks do not contain body lines`,
            },
          };
        }
        sections.push({ kind: "delete", path, lines: [], endOfFile: false });
        continue;
      }
      current = { kind: header.kind, path, lines: [] };
      continue;
    }

    // Inside a section: a hunk header, or a body line.
    if (line === "@@" || line.startsWith("@@ ")) continue;

    const marker = raw[0];
    if (marker === " " || marker === "+" || marker === "-") {
      current.lines.push(raw);
      continue;
    }
    return {
      problem: {
        lineNumber: i + 1,
        message: `Unexpected line found in update hunk: '${raw}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      },
    };
  }

  const trailing = closeCurrent(lines.length);
  if (trailing) return trailing;

  if (current !== null) {
    if (current.lines.length === 0) {
      return {
        problem: { lineNumber: lines.length, message: "Update hunk does not contain any lines." },
      };
    }
    sections.push({ kind: current.kind, path: current.path, lines: current.lines, endOfFile });
  }

  if (current !== null) {
    if (current.lines.length === 0) {
      return {
        problem: { lineNumber: lines.length, message: "Update hunk does not contain any lines." },
      };
    }
    sections.push({ kind: current.kind, path: current.path, lines: current.lines, endOfFile });
  }

  return { sections };
}

/**
 * Convert a parsed envelope into unified-diff text for `patchToCodeDiffs`.
 *
 * @param sections - Output of {@link parseCodexPatch}.
 * @returns A unified diff, or an empty string when there is nothing to show.
 */
export function codexPatchToUnifiedDiff(
  sections: readonly CodexPatchSection[],
): string {
  const chunks: string[] = [];
  for (const section of sections) {
    const path = section.path;
    if (section.kind === "add") {
      const added = section.lines.map((l) => `+${l.slice(1)}`);
      chunks.push(
        [
          `--- /dev/null`,
          `+++ ${path}`,
          `@@ -0,0 +1,${added.length} @@`,
          ...added,
        ].join("\n"),
      );
      continue;
    }
    if (section.kind === "delete") {
      // OpenCode sends no body for a delete, so there is no line count to
      // report. `@@ -1,0 +0,0 @@` is the honest header: it says the file is
      // going and does not claim to know how many lines it had.
      chunks.push([`--- ${path}`, `+++ /dev/null`, `@@ -1,0 +0,0 @@`].join("\n"));
      continue;
    }
    const oldCount = section.lines.filter((l) => l[0] !== "+").length;
    const newCount = section.lines.filter((l) => l[0] !== "-").length;
    chunks.push(
      [
        `--- ${path}`,
        `+++ ${path}`,
        `@@ -1,${oldCount} +1,${newCount} @@`,
        ...section.lines,
      ].join("\n"),
    );
  }
  return chunks.join("\n");
}

/**
 * The single entry point a renderer needs: envelope in, unified diff out.
 *
 * @param text - The `patchText` argument.
 * @returns The unified diff, or null when the envelope does not parse.
 */
export function codexPatchToDiffText(text: unknown): string | null {
  const parsed = parseCodexPatch(text);
  if ("problem" in parsed) return null;
  return codexPatchToUnifiedDiff(parsed.sections);
}

/** The files an envelope names, in order, deduplicated. */
export function codexPatchPaths(text: unknown): string[] {
  const parsed = parseCodexPatch(text);
  if ("problem" in parsed) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const section of parsed.sections) {
    if (seen.has(section.path)) continue;
    seen.add(section.path);
    out.push(section.path);
  }
  return out;
}
