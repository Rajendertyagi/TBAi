import { describe, it, expect, beforeAll } from "bun:test";

/**
 * Source-level guard for the assistant message's block structure.
 *
 * Not behavioural, for the same reason as `markdown-text.test.ts` and
 * `tool-fallback.test.ts`: `web/` has no component-test runner, so the message
 * cannot be rendered here. The behaviour is confirmed in the browser; this file
 * only makes sure the structure that fixes the reported defects cannot quietly
 * regress.
 *
 * The defects being guarded:
 *  - "other block are also in one big block": every part lived inside ONE
 *    wrapper bubble, so no sub-block could read as its own block.
 *  - "tools permission in nested block": the `tool-call` group path carried a
 *    `group-chainOfThought` prefix, so `groupPartByType` nested every tool group
 *    inside the thinking block.
 *  - a permission card could hide inside a collapsed tool group.
 *  - the synthetic `indicator` part was dropped by the switch.
 *
 * Assertions are scoped to the `groupPartByType({...})` literal where possible,
 * so they land on the CODE and not on the prose around it — the explanatory
 * comment above the map names the removed prefix, and a whole-file
 * `not.toContain` would fail on that comment rather than on a real regression.
 */
const GROUP_MAP = /groupPartByType\(\{([\s\S]*?)\n\}\);/;

let source = "";
let groupMap = "";

beforeAll(async () => {
  source = await Bun.file(new URL("./ChatWindow.tsx", import.meta.url)).text();
  groupMap = source.match(GROUP_MAP)?.[1] ?? "";
});

describe("assistant message — block structure", () => {
  it("does not wrap every part in one shared bubble", () => {
    // The exact class string of the removed wrapper: if it comes back, the
    // message is one big block again.
    expect(source).not.toContain(
      "max-w-[85%] space-y-2 rounded-xl bg-muted px-3.5 py-2.5 text-sm text-foreground",
    );
  });

  it("renders a tool group as a sibling of reasoning, never its child", () => {
    expect(groupMap).toContain('"tool-call": ["group-tool"]');
    // The nesting prefix is the defect — it must not return to the map.
    expect(groupMap).not.toContain("group-chainOfThought");
  });

  it("keeps standalone tool calls ungrouped", () => {
    // An empty path means "render outside the grouping", which is how a tool
    // UI that opts into `display: "standalone"` keeps its approval card out of
    // a collapsed group.
    expect(groupMap).toContain('"standalone-tool-call": []');
  });

  it("derives group status from counts, not from one part", () => {
    expect(source).toContain("part.counts.running");
  });

  it("opens a tool group that is waiting on approval", () => {
    // A `requires-action` group is not running; without this it stays collapsed
    // and hides the permission card inside it.
    expect(source).toContain("part.counts.requiresAction");
    expect(source).toMatch(/pending=\{part\.counts\.requiresAction > 0\}/);
  });

  it("handles the synthetic indicator part", () => {
    expect(source).toContain('case "indicator"');
  });

  it("only shows the indicator while the thread is actually running", () => {
    // The library's own condition is per-MESSAGE, so a message left marked
    // `running` (an errored turn that produced no text) would pulse forever
    // beside a live composer. Gate on the thread signal the composer trusts.
    expect(source).toMatch(/case "indicator":\s*return threadIsRunning \?/);
  });
});
