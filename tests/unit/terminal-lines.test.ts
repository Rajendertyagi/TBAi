/**
 * Terminal output normalization tests (no DOM, no server): ANSI stripping,
 * line splitting, carriage-return progress, and the bounded rolling buffer.
 * Executed with `bun test`.
 */
import { describe, it, expect } from "bun:test";
import {
  TERMINAL_MAX_LINES,
  TerminalBuffer,
  splitTerminalLines,
  stripAnsi,
  mergeTerminalParts,
  resultToLines,
} from "../../web/src/lib/terminal-lines";

describe("stripAnsi", () => {
  it("strips color and cursor sequences", () => {
    expect(stripAnsi("\x1b[32mok\x1b[0m")).toBe("ok");
    expect(stripAnsi("\x1b[1;31mfail\x1b[K")).toBe("fail");
    expect(stripAnsi("\x1b(Bplain")).toBe("plain");
  });

  it("strips OSC hyperlinks", () => {
    expect(stripAnsi("\x1b]8;;https://x\x07link")).toBe("link");
  });

  it("leaves plain text and empty input alone", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
    expect(stripAnsi("")).toBe("");
  });
});

describe("splitTerminalLines", () => {
  it("splits normal multiline stdout", () => {
    expect(splitTerminalLines("a\nb\nc\n")).toEqual(["a", "b", "c"]);
  });

  it("handles CRLF", () => {
    expect(splitTerminalLines("a\r\nb\r\n")).toEqual(["a", "b"]);
  });

  it("folds carriage-return progress to the final segment", () => {
    expect(splitTerminalLines("12%\r13%\r14%")).toEqual(["14%"]);
  });

  it("drops trailing blanks but keeps interior blanks", () => {
    expect(splitTerminalLines("a\n\nb\n\n")).toEqual(["a", "", "b"]);
  });

  it("returns [] for empty output", () => {
    expect(splitTerminalLines("")).toEqual([]);
    expect(splitTerminalLines("\n\n")).toEqual([]);
  });

  it("strips ANSI before splitting", () => {
    expect(splitTerminalLines("\x1b[32ma\x1b[0m\nb\n")).toEqual(["a", "b"]);
  });
});

describe("TerminalBuffer", () => {
  it("accumulates chunks in arrival order", () => {
    const buf = new TerminalBuffer();
    buf.push("a\n");
    buf.push("b\n");
    expect(buf.lines).toEqual(["a", "b"]);
  });

  it("merges an unterminated tail with the next chunk", () => {
    const buf = new TerminalBuffer();
    buf.push("hel");
    buf.push("lo\nworld");
    expect(buf.lines).toEqual(["hello", "world"]);
  });

  it("replaces progress rewrites instead of appending", () => {
    const buf = new TerminalBuffer();
    buf.push("12%\r");
    buf.push("13%\r");
    expect(buf.lines).toEqual(["13%"]);
    buf.push("done\n");
    expect(buf.lines).toEqual(["done"]);
  });

  it("merges stderr pushed between stdout chunks deterministically", () => {
    const buf = new TerminalBuffer();
    buf.push("out1\n");
    buf.push("err1\n");
    buf.push("out2\n");
    expect(buf.lines).toEqual(["out1", "err1", "out2"]);
  });

  it("bounds retained lines (rolling tail)", () => {
    expect(TERMINAL_MAX_LINES).toBe(2000);
    const buf = new TerminalBuffer(3);
    buf.push("a\nb\nc\nd\ne\n");
    expect(buf.lines).toEqual(["c", "d", "e"]);
    expect(buf.length).toBe(3);
  });

  it("ignores empty chunks", () => {
    const buf = new TerminalBuffer();
    buf.push("");
    buf.push("a\n");
    buf.push("");
    expect(buf.lines).toEqual(["a"]);
  });

  it("clear resets state", () => {
    const buf = new TerminalBuffer();
    buf.push("a\n");
    buf.clear();
    expect(buf.lines).toEqual([]);
    expect(buf.length).toBe(0);
  });
});

describe("mergeTerminalParts (live terminal adapter logic)", () => {
  const part = (
    toolCallId: string,
    chunks: string[],
    extra: Record<string, unknown> = {},
  ) => ({ type: "data", name: "tbai-terminal", data: { toolCallId, chunks, ...extra } });

  it("merges matching parts and ignores other tool calls", () => {
    const parts = [
      part("call-A", ["one\n", "two\n"]),
      part("call-B", ["ignored\n"]),
      part("call-A", ["three\n"]),
    ];
    expect(mergeTerminalParts(parts, "call-A")).toEqual(["one", "two", "three"]);
  });

  it("runs in stream order and folds CR progress", () => {
    const parts = [
      part("call-A", ["12%\r", "13%\r"]),
      part("call-A", ["14%\r"]),
      part("call-A", ["done\n"]),
    ];
    expect(mergeTerminalParts(parts, "call-A")).toEqual(["done"]);
  });

  it("strips ANSI embedded in live chunks", () => {
    const parts = [part("call-A", ["\x1b[32mok\x1b[0m\n"])];
    expect(mergeTerminalParts(parts, "call-A")).toEqual(["ok"]);
  });

  it("bounds live lines by maxLines", () => {
    const parts = [part("call-A", ["a\n", "b\n", "c\n", "d\n", "e\n"])];
    expect(mergeTerminalParts(parts, "call-A", 3)).toEqual(["c", "d", "e"]);
  });

  it("ignores non-terminal and malformed parts", () => {
    const parts = [
      { type: "data", name: "tbai-progress", data: { toolCallId: "call-A" } },
      { type: "data", name: "tbai-terminal", data: { toolCallId: "call-A" } }, // no chunks
      null,
      42,
      part("call-A", []),
    ];
    expect(mergeTerminalParts(parts, "call-A")).toEqual([]);
  });

  it("returns [] for empty parts or missing id", () => {
    expect(mergeTerminalParts([], "call-A")).toEqual([]);
    expect(mergeTerminalParts([part("call-A", ["x\n"])], "")).toEqual([]);
  });
});

describe("resultToLines (completed-result adapter logic)", () => {
  it("returns stdout lines then stderr lines", () => {
    expect(
      resultToLines({ stdout: "a\nb\n", stderr: "e1\ne2\n" }),
    ).toEqual(["a", "b", "e1", "e2"]);
  });

  it("returns [] when output is absent", () => {
    expect(resultToLines({})).toEqual([]);
    expect(resultToLines({ stdout: "", stderr: undefined })).toEqual([]);
  });

  it("ignores non-string output", () => {
    expect(resultToLines({ stdout: 42, stderr: null })).toEqual([]);
  });
});
