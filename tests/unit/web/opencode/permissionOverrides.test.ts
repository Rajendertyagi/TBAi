import { describe, expect, it } from "bun:test";
import { findPermissionOverride } from "@web/features/opencode/permissionOverrides.ts";

/**
 * Which permission rule a later rule overrides.
 *
 * The upstream's behaviour these tests encode was **verified live**, not
 * inferred: against a managed `opencode serve` 2.0.32 with an isolated
 * configuration, driving a real `shell` tool call through the repository's own
 * stub provider.
 *
 *   - the LAST matching rule wins (`findLast` over the matching rules);
 *   - the action is matched against the TOOL's name, and the resource against
 *     the command string;
 *   - a `deny` rule also removes the tool from the list the model is offered.
 *
 * So a rule that a later rule matches more broadly is never the rule that
 * decides, and a rule that a later rule matches more narrowly still applies to
 * everything the later one does not.
 */
const SHELL = { action: "shell", resource: "*" } as const;

describe("findPermissionOverride", () => {
  it("reports nothing when no later rule shadows the rule", () => {
    const rules = [
      { action: "shell", resource: "*" },
      { action: "write", resource: "*" },
      { action: "read", resource: "*" },
    ];
    expect(findPermissionOverride(rules, 0)).toEqual({ kind: "none" });
    expect(findPermissionOverride(rules, 1)).toEqual({ kind: "none" });
    expect(findPermissionOverride(rules, 2)).toEqual({ kind: "none" });
  });

  it("reports the last rule as never applying when it is fully shadowed", () => {
    // OpenCode resolves the last matching rule, so an earlier identical rule
    // can never be the one that decides.
    const rules = [
      { action: "shell", resource: "*" },
      { action: "shell", resource: "*" },
    ];
    expect(findPermissionOverride(rules, 0)).toEqual({ kind: "full", byIndex: 1 });
  });

  it("reports a rule as never applying when a later rule matches everything it matches", () => {
    // The later `*` matches every resource the narrower rule matches, so the
    // narrower rule is dead: the later one is always selected in its place.
    const rules = [
      { action: "shell", resource: "git *" },
      { action: "shell", resource: "*" },
    ];
    expect(findPermissionOverride(rules, 0)).toEqual({ kind: "full", byIndex: 1 });
  });

  it("reports a broad rule as partly overridden by a later, narrower one", () => {
    // `git *` matches a subset of what `*` matches, so the broad rule still
    // applies to everything else.
    const rules = [
      { action: "shell", resource: "*" },
      { action: "shell", resource: "git *" },
    ];
    expect(findPermissionOverride(rules, 0)).toEqual({ kind: "partial", byIndex: 1 });
  });

  it("does not report an override between different actions", () => {
    // The action is matched against the tool's name, so a rule for another
    // tool cannot shadow this one.
    const rules = [
      { action: "shell", resource: "*" },
      { action: "write", resource: "*" },
    ];
    expect(findPermissionOverride(rules, 0)).toEqual({ kind: "none" });
  });

  it("does not report an override it cannot decide", () => {
    // Two overlapping patterns whose relation is not decidable from equality
    // and `*` alone are reported as NOT overridden: claiming an override
    // OpenCode would not act on would be worse than saying nothing.
    const rules = [
      { action: "shell", resource: "git *" },
      { action: "shell", resource: "git status" },
    ];
    expect(findPermissionOverride(rules, 0)).toEqual({ kind: "none" });
  });

  it("names the nearest later rule that overrides", () => {
    const rules = [
      { action: "shell", resource: "*" },
      { action: "shell", resource: "git *" },
      { action: "shell", resource: "*" },
    ];
    // The NARROWER middle rule does not cover the first, so it is not what
    // kills it; the last rule's `*` does, and that is the one named.
    expect(findPermissionOverride(rules, 0)).toEqual({ kind: "full", byIndex: 2 });
    expect(findPermissionOverride(rules, 1)).toEqual({ kind: "full", byIndex: 2 });
  });

  it("reports nothing for a rule that does not exist", () => {
    expect(findPermissionOverride([SHELL], 5)).toEqual({ kind: "none" });
  });

  it("indexes by the rule's position in the file, not in a filtered list", () => {
    // The array is the file's array: a rule the page could not read is a
    // HOLE at its file position, not a missing entry. The relation must not
    // be shifted by it, and the rule it names must be the file's rule.
    const rules: (typeof SHELL | undefined)[] = [];
    rules[0] = SHELL;
    rules[2] = SHELL;
    rules[3] = SHELL;
    // The rule at file position 2 is shadowed by the one at file position 3.
    expect(findPermissionOverride(rules, 2)).toEqual({ kind: "full", byIndex: 3 });
    // The rule at file position 0 is shadowed by the first later rule that
    // covers it — file position 2, not file position 1 (the hole).
    expect(findPermissionOverride(rules, 0)).toEqual({ kind: "full", byIndex: 2 });
    // The last rule is shadowed by nothing.
    expect(findPermissionOverride(rules, 3)).toEqual({ kind: "none" });
  });

  it("does not let an unreadable rule claim to override anything", () => {
    // An unreadable rule cannot be shown to override anything, so it is
    // skipped rather than guessed at.
    const rules: (typeof SHELL | undefined)[] = [];
    rules[0] = SHELL;
    rules[1] = undefined;
    expect(findPermissionOverride(rules, 0)).toEqual({ kind: "none" });
  });
});
