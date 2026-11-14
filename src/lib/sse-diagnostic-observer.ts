/**
 * Passive SSE diagnostic observer for the OpenCode proxy.
 *
 * This module parses SSE framing ONLY to extract event type names and counts for
 * debug logging. It is a side channel: callers must forward original upstream
 * bytes unchanged and must never let observer errors affect the proxied stream.
 *
 * Correctness goals (diagnostics only):
 * - Recognize LF (\n\n), CRLF (\r\n\r\n), and CR (\r\r) frame delimiters,
 *   including CRLF sequences split across chunks.
 * - Dispatch/count only complete frames terminated by a blank line.
 * - Do not count comment-only frames as dispatched messages.
 * - Join multiple `data:` fields with "\n" per SSE behavior for type fallback.
 * - Prefer `event:` field; fall back to JSON `data.type`; default to "message".
 * - Discard incomplete trailing frames at EOF/error/cancel (no dispatch).
 * - Bound retained diagnostic buffer to avoid unbounded memory growth; on
 *   overflow drop the oversized partial frame, resync at next valid boundary,
 *   and resume without throwing or logging floods.
 */

export const SSE_DIAGNOSTIC_MAX_BUFFER_BYTES = 64 * 1024;

/** Result of consuming text into the observer. */
export interface SseObservedEvent {
  /** Event type name only (never payload). */
  readonly type: string;
}

interface FrameBoundary {
  readonly index: number;
  readonly length: number;
}

/**
 * Finds the next SSE frame boundary (blank line) in `buffer`.
 *
 * Supports \r\n\r\n, \n\n, and \r\r. When a boundary starts at the end of the
 * buffer and may be split (e.g. trailing \r or \r\n), returns null so the
 * caller can wait for more data.
 */
export function findSseFrameBoundary(buffer: string): FrameBoundary | null {
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (ch === "\n") {
      if (buffer[i + 1] === "\n") return { index: i, length: 2 };
      continue;
    }
    if (ch === "\r") {
      const next = buffer[i + 1];
      if (next === "\n") {
        const next2 = buffer[i + 2];
        if (next2 === "\r" && buffer[i + 3] === "\n") return { index: i, length: 4 };
        if (next2 === "\n") return { index: i, length: 3 }; // \r\n\n (tolerant)
        if (next2 === undefined) return null; // possible split \r\n\r\n
        continue;
      }
      if (next === "\r") return { index: i, length: 2 };
      if (next === undefined) return null; // possible split \r\r or \r\n
    }
  }
  // Trailing \r\n may be start of \r\n\r\n split across chunks.
  if (buffer.endsWith("\r\n")) return null;
  return null;
}

/**
 * Extracts the diagnostic event type from a complete raw SSE frame (without the
 * terminating blank line). Returns null for comment-only/non-dispatching frames.
 *
 * Never returns payload data. Parsing is defensive and must not throw.
 */
export function extractSseDiagnosticEventType(rawFrame: string): string | null {
  try {
    const lines = rawFrame.split(/\r\n|\r|\n/);
    let eventType: string | undefined;
    const dataLines: string[] = [];
    let dispatchable = false;

    for (const line of lines) {
      if (line === "") continue;
      if (line.startsWith(":")) {
        // Comment line: ignored, does not make frame dispatchable.
        continue;
      }

      let field = line;
      let value = "";
      const colon = line.indexOf(":");
      if (colon === -1) {
        field = line;
        value = "";
      } else {
        field = line.slice(0, colon);
        value = line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
      }

      switch (field) {
        case "event":
          dispatchable = true;
          if (value !== "") eventType = value;
          break;
        case "data":
          dispatchable = true;
          dataLines.push(value);
          break;
        case "id":
        case "retry":
          // Recognized fields; retry/id-only frames are not counted as messages.
          break;
        default:
          // Unknown field: ignored per SSE; does not make frame dispatchable.
          break;
      }
    }

    if (!dispatchable) return null;
    if (eventType) return eventType;

    if (dataLines.length > 0) {
      const data = dataLines.join("\n");
      try {
        const parsed = JSON.parse(data) as { type?: unknown } | null;
        if (parsed && typeof parsed.type === "string") return parsed.type;
      } catch {
        /* non-JSON or non-object data: fall through */
      }
    }

    return "message";
  } catch {
    return null;
  }
}

/**
 * Stateful, bounded SSE frame observer for diagnostics. Feed decoded text chunks
 * and receive dispatched event types for complete frames only.
 */
export class SseDiagnosticObserver {
  private buffer = "";
  private droppedOversized = false;

  constructor(private readonly maxBufferBytes: number = SSE_DIAGNOSTIC_MAX_BUFFER_BYTES) {}

  /** Feeds a decoded text chunk and returns dispatched event types in order. */
  feed(text: string): SseObservedEvent[] {
    if (!text) return [];
    this.buffer += text;
    return this.drain();
  }

  /** Discards incomplete trailing state (EOF/error/cancel). */
  reset(): void {
    this.buffer = "";
    this.droppedOversized = false;
  }

  private drain(): SseObservedEvent[] {
    const out: SseObservedEvent[] = [];
    for (;;) {
      if (this.droppedOversized) {
        if (!this.resyncAfterDrop()) break;
        continue;
      }

      if (Buffer.byteLength(this.buffer, "utf8") > this.maxBufferBytes) {
        // Oversized retained frame: drop it and resync at the next valid
        // boundary without reporting a false event type. If a boundary is
        // already present, discard only through that boundary and continue
        // parsing any subsequent frames in the same buffer.
        const boundary = findSseFrameBoundary(this.buffer);
        if (boundary) {
          this.buffer = this.buffer.slice(boundary.index + boundary.length);
          continue;
        }
        this.droppedOversized = true;
        // Keep only a small tail that could form a split boundary prefix.
        if (this.buffer.length > 4) {
          this.buffer = this.buffer.slice(-4);
        }
        break;
      }

      const boundary = findSseFrameBoundary(this.buffer);
      if (!boundary) break;

      const rawFrame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      const type = extractSseDiagnosticEventType(rawFrame);
      if (type !== null) out.push({ type });
    }
    return out;
  }

  /**
   * After an oversized frame is dropped, discard input until the next valid
   * frame boundary so parsing can resume on a clean frame. Returns true if a
   * boundary was consumed and parsing may continue.
   */
  private resyncAfterDrop(): boolean {
    const boundary = findSseFrameBoundary(this.buffer);
    if (!boundary) {
      // Keep only a small tail that could form a split boundary prefix.
      if (this.buffer.length > 4) {
        this.buffer = this.buffer.slice(-4);
      }
      return false;
    }
    this.buffer = this.buffer.slice(boundary.index + boundary.length);
    this.droppedOversized = false;
    return true;
  }
}
