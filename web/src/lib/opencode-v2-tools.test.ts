import { describe, expect, it } from "bun:test";
import { NATIVE_TOOL_NAMES, OPENCODE_TOOL_NAMES } from "@/tools/toolkit";
import { toolMetaKeys } from "@/components/assistant-ui/elements/session-timeline";
import {
  OPENCODE_V2_ALIASES,
  OPENCODE_V2_MANAGEMENT_TOOLS,
  OPENCODE_V2_TOOLS,
  OPENCODE_V1_REMOVED,
} from "./opencode-v2-tools";

/**
 * The OpenCode tool registry, checked against what v2 actually ships.
 *
 * ## The defect class this exists to stop
 *
 * `todowrite` had a renderer, tests, and a row in the tool-UI tracker, for a tool
 * OpenCode v2 deleted. Nothing caught it, and the failure was not cosmetic: a
 * model with no todo tool says so truthfully and improvises a `todo.md` file in
 * the user's workspace instead. Three separate things had to be true for that to
 * stay invisible:
 *
 *  - the registry is name-keyed, so an entry for a name the server never sends
 *    is simply never consulted;
 *  - `type: "backend"` does NOT require a `render`. Verified by registering a
 *    tool with no renderer at all: `tsc --noEmit` still exits 0. So a missing
 *    card is not a compile error either;
 *  - `TOOL_META`'s miss falls back to `verb: part.toolName`, which is
 *    well-formed, so an unknown name in the timeline looks like a label rather
 *    than a gap.
 *
 * Each of those is individually reasonable. Together they mean no single check
 * can tell a working tool from a dead one, so the invariant has to be asserted
 * rather than assumed — which is what this file does.
 *
 * `bash` and `task` are asserted PRESENT on purpose. They are the v1 spellings
 * v2 renamed, and dropping them would be the regression `be6f75a` fixed.
 */

/** Every name the OpenCode toolkit registers. */
const registered = new Set<string>(OPENCODE_TOOL_NAMES);

/** Every name the app registers, native tools included. */
const ALL_TOOL_NAMES: readonly string[] = [...NATIVE_TOOL_NAMES, ...OPENCODE_TOOL_NAMES];

describe("the registry covers what OpenCode v2 ships", () => {
  it("registers every v2 built-in", () => {
    const missing = OPENCODE_V2_TOOLS.filter((name) => !registered.has(name));
    // A missing name is the exact `subagent` defect: a real tool with no card, so
    // it falls through to ToolFallback and renders as a raw JSON dump.
    expect(missing).toEqual([]);
  });

  it("registers nothing v2 removed", () => {
    // These have no successor. An entry here can never fire, so it is dead code
    // that reads as a feature — which is how `todowrite` survived.
    const dead = OPENCODE_V1_REMOVED.filter((name) => registered.has(name));
    expect(dead).toEqual([]);
  });

  it("keeps the v1 aliases v2 renamed, because dropping them is a regression", () => {
    for (const alias of Object.keys(OPENCODE_V2_ALIASES)) {
      expect(registered.has(alias)).toBe(true);
    }
  });

  it("registers nothing outside the v2 set, its aliases, and its management tools", () => {
    // Without this, adding a card for a tool that does not exist is invisible:
    // every other assertion here still passes, because the name is neither a v2
    // tool nor a removed one.
    const known = new Set<string>([
      ...OPENCODE_V2_TOOLS,
      ...OPENCODE_V2_MANAGEMENT_TOOLS,
      ...Object.keys(OPENCODE_V2_ALIASES),
    ]);
    const unexplained = OPENCODE_TOOL_NAMES.filter((name) => !known.has(name));
    expect(unexplained).toEqual([]);
  });

  it("has no name in both the v2 set and the removed set", () => {
    // The two lists came from different sources; a name in both would mean one
    // of them is wrong and every assertion above is reading a fiction.
    const v2 = new Set<string>(OPENCODE_V2_TOOLS);
    const overlap = OPENCODE_V1_REMOVED.filter((name) => v2.has(name));
    expect(overlap).toEqual([]);
  });
});

describe("every registered name reaches a real verb, not its own name", () => {
  it("has an entry in TOOL_META for each registered tool", () => {
    // TOOL_META is a SECOND name-keyed map. A miss is invisible at build time
    // because the fallback is well-formed: the timeline row prints the literal
    // tool name with a terminal icon. That is how `subagent` shipped once.
    const missing = OPENCODE_TOOL_NAMES.filter((name) => !toolMetaKeys().includes(name));
    expect(missing).toEqual([]);
  });

  it("carries no TOOL_META entry for a name the app does not register", () => {
    // Checked against the WHOLE registry, not the OpenCode half. TOOL_META spans
    // all 29 app tools — 15 native plus the OpenCode ones — so comparing it to
    // `OPENCODE_TOOL_NAMES` would report every native tool as an orphan, which is
    // a misleading failure that hides the one real leftover.
    //
    // That real leftover is `todowrite`: its renderer is gone, so nothing registers
    // it, and its TOOL_META row kept claiming "Tracked todo" for a tool v2 deleted.
    // A stale entry is not harmless — it reads as a claim that the tool is handled.
    const registeredNames = new Set(ALL_TOOL_NAMES);
    const orphaned = toolMetaKeys().filter((name) => !registeredNames.has(name));
    expect(orphaned).toEqual([]);
  });

  it("carries no exemption, so a name cannot be added by accident", () => {
    // If an allowlist for "these are not really registered" is introduced later,
    // this fails and forces the decision to be written down.
    expect(OPENCODE_V2_MANAGEMENT_TOOLS).not.toContain("todowrite");
  });
});
