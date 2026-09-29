import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OpenCodeConfigPage } from "./OpenCodeConfigPage";
import {
  actionDescription,
  effectLabel,
  openCodeConfigCopy,
  openCodeConfigEffects,
} from "@/config/opencodeConfig";
import { toPermissionRules } from "./openCodeConfig";

/**
 * Render tests for the OpenCode Configuration page's own contracts.
 *
 * `react-dom/server` is enough for the parts that are decided BEFORE the first
 * fetch resolves: a page that has not loaded yet must not claim to be empty,
 * must not show a Save it cannot honour, and must render the real config
 * source note. The two contracts that a static render genuinely cannot prove —
 * that a save writes one rule, and that the protected rules survive — are
 * covered behaviourally in `configDocument.test.ts`, against the user's real
 * configuration text.
 */

describe("config copy and metadata", () => {
  it("describes every action the reference page must surface", () => {
    // The actions the product target names explicitly. A missing description
    // here would render the neutral fallback in the rule table.
    for (const action of [
      "question",
      "todowrite",
      "edit",
      "read",
      "write",
      "glob",
      "grep",
      "list",
      "ls",
      "webfetch",
      "websearch",
      "shell",
    ]) {
      expect(actionDescription(action)).not.toBe(
        "An action this app does not have a description for.",
      );
    }
  });

  it("falls back to a neutral line for an action it does not know", () => {
    // Asserting a meaning for an unverified action would be worse than saying
    // nothing, so the fallback is part of the contract.
    expect(actionDescription("some_future_tool")).toBe(
      "An action this app does not have a description for.",
    );
  });

  it("offers exactly the three effects OpenCode accepts", () => {
    expect([...openCodeConfigEffects]).toEqual(["allow", "ask", "deny"]);
    for (const effect of openCodeConfigEffects) {
      expect(effectLabel[effect]).toBeTruthy();
    }
  });

  it("names the three sections the product target requires", () => {
    // Asserted against the copy module because the sections themselves only
    // render once a snapshot resolves, which a static render cannot reach.
    expect(openCodeConfigCopy.sections.source).toBe("Configuration source");
    expect(openCodeConfigCopy.sections.permissions).toBe("Permissions");
    expect(openCodeConfigCopy.sections.json).toBe("Native OpenCode JSON");
  });

  it("states the ordering rule OpenCode actually applies", () => {
    // Last-match-wins is why the page shows an index and refuses to reorder.
    expect(openCodeConfigCopy.permissions.description).toMatch(/in order/);
    expect(openCodeConfigCopy.permissions.description).toMatch(/last matching rule wins/);
  });
});

describe("permission rule narrowing (what the table would render)", () => {
  it("keeps question and todowrite visible from a real config array", () => {
    const { rules } = toPermissionRules([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "question", resource: "*", effect: "ask" },
      { action: "todowrite", resource: "*", effect: "allow" },
    ]);
    expect(rules.map((r) => r.action)).toEqual(["shell", "question", "todowrite"]);
    expect(rules.find((r) => r.action === "todowrite")?.effect).toBe("allow");
  });

  it("preserves the exact order OpenCode resolves in", () => {
    // Order is part of each rule's meaning (last match wins), so a table that
    // reordered them would misrepresent the policy.
    const order = ["shell", "edit", "question", "subagent"];
    const { rules } = toPermissionRules(
      order.map((action) => ({ action, resource: "*", effect: "ask" })),
    );
    expect(rules.map((r) => r.action)).toEqual(order);
  });
});

describe("OpenCodeConfigPage (pre-load render)", () => {
  const html = renderToStaticMarkup(<OpenCodeConfigPage />);

  it("states that the configuration is the real one OpenCode reads", () => {
    // The page's central claim: this is not a TBAi-owned policy surface.
    expect(html).toContain("OpenCode Configuration");
    expect(html).toContain("stays the source of truth");
  });

  it("renders no section before the configuration has been read", () => {
    // The three sections are gated on a resolved snapshot. Asserting their
    // titles here would be asserting the opposite of the real contract: a
    // snapshot-driven page must not show a permissions table (or a source path)
    // that it has not read yet. Their titles are asserted against the copy
    // module below, which is the single source both the page and the tests read.
    expect(html).not.toContain("Configuration source");
    expect(html).not.toContain("Native OpenCode JSON");
  });

  it("does not claim an empty or default policy before the read resolves", () => {
    // The failure this guards: rendering "no rules configured" on first paint
    // would assert that OpenCode has no restrictions, which is the opposite of
    // what an unresolved read means.
    expect(html).not.toContain("This configuration has no permission rules");
    expect(html).not.toContain("no permissions key");
  });

  it("renders no Save control before there is something to save", () => {
    expect(html).not.toContain(">Save<");
  });

  it("shows the reading state rather than a bare page", () => {
    expect(html).toContain("Reading the OpenCode configuration");
  });
});
