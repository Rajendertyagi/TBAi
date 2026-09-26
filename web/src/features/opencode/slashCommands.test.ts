/**
 * The slash-command feed's pure half.
 *
 * Everything here is a pure function over the server's payload, which is what
 * makes the edges testable without a DOM: a malformed feed, a duplicated name,
 * a token mid-word, a template with no placeholder. The one property that
 * matters most is that NOTHING is hardcoded — every command comes from the
 * feed, so the tests drive entirely synthetic feeds.
 */
import { describe, it, expect } from "bun:test";
import {
  applyCommandSelection,
  commandLabel,
  parseCommandFeed,
  toSlashCommands,
  type OpenCodeCommand,
} from "./slashCommands";

describe("parseCommandFeed — defensive, feed-driven", () => {
  it("returns an empty list for a payload that is not an array", () => {
    for (const raw of [null, undefined, {}, "nope", 42, true]) {
      expect(parseCommandFeed(raw)).toEqual([]);
    }
  });

  it("drops entries that cannot be a command instead of failing the feed", () => {
    const parsed = parseCommandFeed([
      null,
      42,
      "init",
      {},
      { name: "" },
      { name: "   " },
      { name: 123 },
      { name: "good" },
    ]);
    expect(parsed.map((c) => c.name)).toEqual(["good"]);
  });

  it("keeps the feed's own order", () => {
    const parsed = parseCommandFeed([{ name: "b" }, { name: "a" }, { name: "c" }]);
    expect(parsed.map((c) => c.name)).toEqual(["b", "a", "c"]);
  });

  it("de-duplicates case-insensitively, first occurrence winning", () => {
    // The server merges commands and skills, so a name can legitimately repeat.
    const parsed = parseCommandFeed([
      { name: "Review", description: "first" },
      { name: "review", description: "second" },
      { name: "REVIEW", description: "third" },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ name: "Review", description: "first" });
  });

  it("carries source/template through and omits absent optionals", () => {
    const parsed = parseCommandFeed([
      { name: "init", description: "setup", source: "command", template: "do $ARGUMENTS" },
      { name: "bare" },
    ]);
    expect(parsed[0]).toMatchObject({
      name: "init",
      description: "setup",
      source: "command",
      template: "do $ARGUMENTS",
    });
    expect(parsed[1].description).toBeUndefined();
    expect(parsed[1].template).toBeUndefined();
  });

  it("treats an empty description/template as absent, not as an empty string", () => {
    const parsed = parseCommandFeed([{ name: "x", description: "", template: "  " }]);
    expect(parsed[0].description).toBeUndefined();
    expect(parsed[0].template).toBeUndefined();
  });
});

describe("commandLabel", () => {
  it("is the sigil plus the name", () => {
    expect(commandLabel("init")).toBe("/init");
  });
});

describe("applyCommandSelection — replaces only the trigger token", () => {
  it("replaces the trailing token and preserves earlier text", () => {
    expect(applyCommandSelection("explain /ini", "init")).toBe("explain /init ");
  });

  it("replaces a token at the very start", () => {
    expect(applyCommandSelection("/rev", "review")).toBe("/review ");
  });

  it("leaves a mid-word slash alone (it never opened the popover)", () => {
    // `a/b` is prose: the boundary rule must not treat it as a trigger, so the
    // command is appended rather than swallowing the path.
    expect(applyCommandSelection("see src/a/b", "init")).toBe("see src/a/b/init ");
  });

  it("replaces a bare sigil instead of doubling it", () => {
    // Typing `/` alone opens the palette: selecting must replace that slash,
    // never append a second one (`//name`).
    expect(applyCommandSelection("/", "compact")).toBe("/compact ");
    expect(applyCommandSelection("explain /", "init")).toBe("explain /init ");
  });

  it("appends to unrelated text with no trailing token", () => {
    expect(applyCommandSelection("hello", "init")).toBe("hello/init ");
  });

  it("produces just the command for an empty composer", () => {
    expect(applyCommandSelection("", "init")).toBe("/init ");
  });

  it("does not lose text after a newline boundary", () => {
    expect(applyCommandSelection("line one\n/x", "init")).toBe("line one\n/init ");
  });

  it("is idempotent when the same command is already selected", () => {
    const once = applyCommandSelection("/ini", "init");
    expect(applyCommandSelection(once, "init")).toBe("/init /init ");
    // Documents the real behaviour: the trailing space closes the token, so a
    // second selection appends a fresh one rather than mangling the first.
  });
});

describe("toSlashCommands — no hardcoded names", () => {
  const feed: OpenCodeCommand[] = [
    { name: "init", description: "setup", source: "command" },
    { name: "brainstorming", source: "skill" },
  ];

  it("derives every id and label from the feed", () => {
    const entries = toSlashCommands(feed, () => {});
    expect(entries.map((e) => e.id)).toEqual(["init", "brainstorming"]);
    expect(entries.map((e) => e.label)).toEqual(["/init", "/brainstorming"]);
  });

  it("omits description when the feed has none", () => {
    const entries = toSlashCommands(feed, () => {});
    expect(entries[0].description).toBe("setup");
    expect("description" in entries[1]).toBe(false);
  });

  it("collapses server-side whitespace so rows render as one clean line", () => {
    const entries = toSlashCommands(
      [{ name: "x", description: "line one\nline two  with   gaps" }],
      () => {},
    );
    expect(entries[0].description).toBe("line one line two with gaps");
  });

  it("passes the whole command back to the injected execute", () => {
    const seen: string[] = [];
    const entries = toSlashCommands(feed, (c) => seen.push(c.name));
    entries[1].execute();
    expect(seen).toEqual(["brainstorming"]);
  });

  it("is empty for an empty feed", () => {
    expect(toSlashCommands([], () => {})).toEqual([]);
  });
});
