/**
 * Terminal output normalization for live command display. Pure, framework-free
 * (NOT assistant-ui-specific): strips ANSI escapes, normalizes line endings,
 * folds carriage-return progress output, and keeps a bounded rolling buffer
 * so a noisy process cannot grow messages or React state without limit.
 *
 * Display-only: the durable tool result still carries the complete stdout /
 * stderr. This shapes what the Terminal Block paints incrementally.
 */

/** Conservative retained-line cap (tune only with measured need). */
export const TERMINAL_MAX_LINES = 2000;

// ANSI CSI (colors, cursor moves), OSC (hyperlinks, titles), and stray ESC
// sequences. Covers \x1b[...m/K/G/H/J, \x1b]...\x07 or \x1b\\, and \x1b(B etc.
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]|\x1b\([0-9A-B]|\x1b[ME78c]/g;

/** Strip ANSI escape sequences from one chunk of terminal text. */
export function stripAnsi(text: string): string {
  if (!text) return "";
  return text.replace(ANSI_PATTERN, "");
}

interface RawLine {
  /** Visible text (progress rewrites folded to their final segment). */
  text: string;
  /** True when the line continues in the next chunk (no terminating newline). */
  open: boolean;
}

/**
 * Split one newline-free raw line. A trailing `\r` is a progress rewrite in
 * flight: the visible text is the segment before it, and the line stays open.
 * Otherwise a `\r` join keeps only the final segment (what a terminal shows).
 */
function splitRawLine(raw: string): RawLine {
  if (raw.endsWith("\r")) {
    const segs = raw.slice(0, -1).split("\r");
    return { text: segs[segs.length - 1] ?? "", open: true };
  }
  const segs = raw.split("\r");
  return { text: segs[segs.length - 1] ?? "", open: false };
}

function normalizeChunk(chunk: string): string {
  return stripAnsi(chunk).replace(/\r\n/g, "\n");
}

/**
 * Split a complete terminal text into display lines (closed document):
 * - `\r\n` → break; lone `\r` folds progress rewrites to their final segment;
 * - a single trailing newline terminates the last line (no artifact blank);
 * - trailing whitespace-only lines are dropped (no dead space under output);
 * - interior blank lines are preserved.
 */
export function splitTerminalLines(text: string): string[] {
  if (!text) return [];
  const clean = normalizeChunk(text);
  const raws = clean.split("\n");
  if (raws.length > 1 && raws[raws.length - 1] === "" && clean.endsWith("\n")) {
    raws.pop();
  }
  const lines = raws.map((r) => splitRawLine(r).text);
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(0, end);
}

/**
 * Bounded rolling terminal buffer. `push` appends a raw chunk; `lines`
 * always holds at most `maxLines` (oldest dropped first). An unterminated
 * tail merges with the next chunk's first line, so progress rewrites and
 * split UTF-8-unrelated boundaries never duplicate or tear rows.
 * Deterministic stdout/stderr interleave is the caller's job — push chunks
 * in arrival order.
 */
export class TerminalBuffer {
  private readonly maxLines: number;
  private buffer: string[] = [];
  private openTail = false;
  /**
   * True when the open tail is a `\r`-progress line (the terminal overwrites
   * it) as opposed to a plain partial line (the next chunk continues it).
   */
  private tailProgress = false;

  constructor(maxLines = TERMINAL_MAX_LINES) {
    this.maxLines = Math.max(1, Math.floor(maxLines));
  }

  push(chunk: string): string[] {
    if (!chunk) return this.lines;
    const clean = normalizeChunk(chunk);
    if (!clean) return this.lines;
    const raws = clean.split("\n");
    if (raws.length > 1 && raws[raws.length - 1] === "" && clean.endsWith("\n")) {
      raws.pop();
    }
    const chunkClosed = clean.endsWith("\n");
    raws.forEach((raw, index) => {
      const folded = splitRawLine(raw);
      const isLast = index === raws.length - 1;
      // A line is still open when it ends mid-progress, or when it is the
      // chunk's final line without a terminating newline.
      const effectiveOpen = folded.open || (!chunkClosed && isLast);
      if (index === 0 && this.openTail && this.buffer.length > 0) {
        if (this.tailProgress) {
          // Progress rewrite over the open tail: replace it (a terminal
          // overwrites, never appends, a \r line).
          if (folded.text !== "") this.buffer[this.buffer.length - 1] = folded.text;
        } else {
          // Plain continuation of a partial line (or a lone newline closing
          // the tail, which appends nothing visible).
          this.buffer[this.buffer.length - 1] += folded.text;
        }
        if (isLast) {
          this.openTail = effectiveOpen;
          this.tailProgress = folded.open;
        } else {
          // A newline inside this chunk closed the tail; rest are fresh.
          this.openTail = false;
          this.tailProgress = false;
        }
        return;
      }
      if (folded.text === "" && effectiveOpen) {
        // Bare progress tick with no text: nothing to show, stay open.
        if (isLast) {
          this.openTail = true;
          this.tailProgress = folded.open || this.tailProgress;
        }
        return;
      }
      this.buffer.push(folded.text);
      if (isLast) {
        this.openTail = effectiveOpen;
        this.tailProgress = folded.open;
      }
    });
    if (this.buffer.length > this.maxLines) {
      this.buffer.splice(0, this.buffer.length - this.maxLines);
      // A trim severs any tail continuation.
      this.openTail = false;
      this.tailProgress = false;
    }
    return this.lines;
  }

  get lines(): string[] {
    return this.buffer.slice();
  }

  get length(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer = [];
    this.openTail = false;
    this.tailProgress = false;
  }
}
