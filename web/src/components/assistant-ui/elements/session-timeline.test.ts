import { describe, expect, it } from "bun:test";
import type { ToolCallMessagePart } from "@assistant-ui/react";
import { appToolkit, NATIVE_TOOL_NAMES, OPENCODE_TOOL_NAMES } from "@/tools/toolkit";
import { buildRestingLabel, toStats, toStep, toolMetaKeys } from "./session-timeline";

/**
 * The tool timeline's app-owned half.
 *
 * The element itself is vendored upstream and is not re-tested. What can break
 * here is the MAPPING — it encodes TBAi's tool names, and upstream explicitly
 * leaves it to the app ("you write the mapping from `parts` to `steps` and
 * `stats` yourself"). So the mapping is tested directly, as a pure function.
 *
 * ## The defect the coverage block pins
 *
 * `TOOL_META` here is a SECOND name-keyed lookup, alongside `appToolkit` in
 * `web/src/tools/toolkit.ts`, and nothing made the two agree. The live server
 * sends `subagent`; `be6f75a` fixed the *renderer registry*, and this map still
 * carried only `task`. A real delegated call therefore took the fallback
 * `verb: part.toolName` and rendered the literal string "subagent" with a
 * terminal icon.
 *
 * That is the worst class of miss - the fallback is well-formed, so typecheck,
 * build and every other test stayed green - and it is why the guard below reads
 * BOTH maps rather than asserting one name.
 */

let seq = 0;
function part(
  toolName: string,
  args: Record<string, unknown> = {},
  result?: unknown,
): ToolCallMessagePart {
  seq += 1;
  return {
    type: "tool-call",
    toolCallId: `call-${seq}`,
    toolName,
    args,
    result,
  } as unknown as ToolCallMessagePart;
}

describe("tool timeline — steps", () => {
  it("names a known tool by its verb and chips the most useful argument", () => {
    expect(toStep(part("read_file", { path: "src/app.ts" })).verb).toBe("Read");
    expect(toStep(part("read_file", { path: "src/app.ts" })).chip).toBe("src/app.ts");
    expect(toStep(part("run_command", { command: "bun test" })).verb).toBe("Ran");
    expect(toStep(part("run_command", { command: "bun test" })).chip).toBe("bun test");
  });

  it("covers both engines' tool names", () => {
    // Direct chat and OpenCode share one timeline, so both registries must map.
    expect(toStep(part("edit_file", { filePath: "a.ts" })).verb).toBe("Edited");
    expect(toStep(part("edit", { filePath: "a.ts" })).verb).toBe("Edited");
    expect(toStep(part("bash", { command: "ls" })).verb).toBe("Ran");
    expect(toStep(part("grep", { pattern: "TODO" })).verb).toBe("Grepped");
    expect(toStep(part("webfetch", { url: "https://example.com" })).verb).toBe("Fetched");
  });

  it("falls back to the raw tool name rather than inventing a verb", () => {
    const step = toStep(part("some_future_tool", { a: 1 }));
    expect(step.verb).toBe("some_future_tool");
    // No recognised argument, so the chip is the tool name too.
    expect(step.chip).toBe("some_future_tool");
  });

  it("prefers a file path over a command when both are present", () => {
    const step = toStep(part("edit_file", { filePath: "a.ts", command: "ignored" }));
    expect(step.chip).toBe("a.ts");
  });

  it("tolerates missing args and results", () => {
    const step = toStep(part("system_info"));
    expect(step.verb).toBe("Read system");
    expect(step.chip).toBe("system_info");
  });
});

describe("tool timeline — file stats", () => {
  it("reports added and removed for an edit", () => {
    const stats = toStats([
      part("edit_file", { filePath: "a.ts" }, { file: "a.ts", added: 14, removed: 3 }),
    ]);
    expect(stats).toEqual([{ file: "a.ts", added: 14, removed: 3 }]);
  });

  it("accepts the line-prefixed result keys too", () => {
    const stats = toStats([
      part("edit", {}, { filePath: "b.ts", linesAdded: 2, linesRemoved: 1 }),
    ]);
    expect(stats).toEqual([{ file: "b.ts", added: 2, removed: 1 }]);
  });

  it("omits a side rather than reporting it as zero", () => {
    const stats = toStats([part("write_file", {}, { file: "c.ts", added: 5 })]);
    expect(stats[0].added).toBe(5);
    expect(stats[0].removed).toBeUndefined();
  });

  it("skips a stat with no counts at all, rather than an empty chip", () => {
    expect(toStats([part("write_file", {}, { file: "d.ts" })])).toEqual([]);
  });

  it("ignores non-editing tools", () => {
    expect(toStats([part("read_file", { path: "a.ts" }, { file: "a.ts", added: 1 })])).toEqual([]);
  });

  it("ignores a tool that has not returned yet", () => {
    expect(toStats([part("edit_file", { filePath: "a.ts" })])).toEqual([]);
  });
});

describe("tool timeline — resting label", () => {
  it("is pluralised correctly", () => {
    expect(buildRestingLabel(1, 1, 0)).toBe("1 step · 1 file changed");
    expect(buildRestingLabel(3, 2, 0)).toBe("3 steps · 2 files changed");
  });

  it("says so when older steps were capped off the top", () => {
    expect(buildRestingLabel(20, 0, 12)).toContain("last 8 shown");
  });
});

describe("tool timeline — TOOL_META covers the registry", () => {
  /**
   * Registry names that legitimately have no verb.
   *
   * Empty today: all 29 names resolve. It exists so that adding an exemption is
   * a deliberate, visible act with a written reason — an inline `||` skip would
   * make the next miss invisible, which is the defect this whole block is for.
   */
  const ALLOWLISTED: readonly { name: string; why: string }[] = [];

  it("has a verb for every tool the app registers", () => {
    // The guard. Deleting `subagent` from TOOL_META — the miss that shipped —
    // puts its name in this list and fails here. `appToolkit` is the registry
    // that is actually handed to the runtime, so it is the right thing to read;
    // the two exported name lists are asserted against it below so neither can
    // be quietly narrowed out of the comparison.
    const missing = Object.keys(appToolkit)
      .filter((name) => !toolMetaKeys().includes(name))
      .filter((name) => !ALLOWLISTED.some((entry) => entry.name === name));
    expect(missing).toEqual([]);
  });

  it("resolves every registered tool to a real verb, never its own name", () => {
    // Stronger than the membership check, and the assertion that would have
    // caught the original defect on its own: the fallback IS
    // `verb: part.toolName`, so a name echoed back as its own verb is the
    // reader seeing the string "subagent" where a sentence belongs.
    const echoed = Object.keys(appToolkit).filter(
      (name) => toStep(part(name, { path: "a.ts" })).verb === name,
    );
    expect(echoed).toEqual([]);
  });

  it("carries no entry for a tool the app does not register", () => {
    // The other direction. A stale key is a verb nothing can ever reach, and it
    // reads in the source as if it were covered.
    const stale = toolMetaKeys().filter((name) => !(name in appToolkit));
    expect(stale).toEqual([]);
  });

  it("reads the registry it is guarding, in full", () => {
    // Guards the guard. If `appToolkit` ever stopped spreading both toolkits,
    // every case above would pass on a partial registry and quietly stop
    // covering the other engine's tools. 15 native + 14 OpenCode, per the tool
    // inventory in `docs/tool-ui-tracker.md`.
    expect(Object.keys(appToolkit)).toHaveLength(29);
    expect(NATIVE_TOOL_NAMES).toHaveLength(15);
    expect(OPENCODE_TOOL_NAMES).toHaveLength(14);
    for (const name of [...NATIVE_TOOL_NAMES, ...OPENCODE_TOOL_NAMES]) {
      expect(name in appToolkit).toBe(true);
    }
  });

  it("names the delegated-agent tool under the name the server sends", () => {
    // The specific regression, asserted through the real projection rather than
    // through the map, so a fallback that starts looking "good enough" is caught
    // here too. `task` is the unverified older spelling and stays registered in
    // both maps, so both spellings are checked.
    expect(toStep(part("subagent", { agent: "explore" })).verb).toBe("Delegated");
    expect(toStep(part("task", { subagent_type: "explore" })).verb).toBe("Delegated");
  });

  it("carries no exemption, so one cannot be added by accident", () => {
    // A guard with a growing allowlist stops being a guard. This asserts the
    // list is empty as a fact, so the next addition has to update a test that
    // is explicitly about the allowlist rather than quietly widening coverage.
    expect(ALLOWLISTED).toEqual([]);
  });
});
