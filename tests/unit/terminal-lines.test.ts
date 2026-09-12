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
