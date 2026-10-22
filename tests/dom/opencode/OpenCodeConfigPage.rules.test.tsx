import { describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import * as realConfig from "@web/features/opencode/openCodeConfig.ts";

/**
 * The OpenCode Configuration page's permission table, rendered for real.
 *
 * Two things are proven here, and both are about what the USER sees:
 *
 *   1. **Two identical rules are independently editable.** OpenCode resolves
 *      the array last-match-wins, so a configuration holding the same
 *      `(action, resource)` pair twice holds two DIFFERENT rules, and only
 *      their positions tell them apart. A page that keyed its rows by the pair
 *      would make the second one unselectable — or worse, silently edit the
 *      first.
 *   2. **The override notice is accurate.** A rule that a later rule shadows
 *      is marked, and a rule nothing shadows is not.
 *
 * The page is rendered through `createRoot` (not `renderToStaticMarkup`)
 * because the table only exists once the configuration has been read.
 */

const SNAPSHOT = {
  path: "C:/cfg/opencode.json",
  discoveredPaths: ["C:/cfg/opencode.json"],
  raw: "{}",
  malformed: false,
  editable: true,
  permissions: [
    { action: "shell", resource: "*", effect: "ask" },
    { action: "shell", resource: "*", effect: "deny" },
    { action: "question", resource: "*", effect: "ask" },
  ],
} as const;

/**
 * The permissions the mocked read returns. A test changes it to describe the
 * configuration it needs; the rules keep their FILE positions, so a rule the
 * page cannot read is simply one the page cannot show.
 */
let permissions: readonly unknown[] = SNAPSHOT.permissions;

mock.module("@web/features/opencode/openCodeConfig.ts", () => ({
  ...realConfig,
  fetchOpenCodeConfig: async () => ({ ...SNAPSHOT, permissions: [...permissions] }),
}));

const { OpenCodeConfigPage } = await import("@web/features/opencode/OpenCodeConfigPage.tsx");

async function mount(): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<OpenCodeConfigPage />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { root, container };
}

/** The effect selectors, by their accessible name. */
function selects(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll('[role="combobox"]')] as HTMLButtonElement[];
}

describe("the permission table", () => {
  it("renders two identical rules as two separately addressable rows", async () => {
    const { root, container } = await mount();
    try {
      const names = selects(container).map((element) => element.getAttribute("aria-label") ?? "");
      // Both duplicates are present, and their names differ — two controls
      // with the same name would be indistinguishable to a screen reader and
      // to a test.
      expect(names.filter((name) => name.includes("shell * effect"))).toHaveLength(2);
      expect(new Set(names).size).toBe(names.length);
      // The two rows show the two different effects that are on disk.
      const texts = selects(container).map((element) => element.textContent ?? "");
      expect(texts.some((text) => text.includes("Deny"))).toBe(true);
      expect(texts.some((text) => text.includes("Ask"))).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });

  it("stages an edit on the row that was clicked, not on both duplicates", async () => {
    const { root, container } = await mount();
    try {
      // Open the SECOND duplicate's effect selector and choose an effect it
      // does not have. The page must stage that change on that row alone: a
      // page that identified the row by its (action, resource) pair would mark
      // BOTH duplicates as changed, and the save would name a rule the user
      // never touched.
      const target = selects(container).find((element) =>
        (element.getAttribute("aria-label") ?? "").includes("shell * effect (rule 2)"),
      );
      expect(target).toBeDefined();
      await act(async () => {
        target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // The option list is a Radix popover; open it and pick "Allow".
      const allow = [...document.querySelectorAll('[role="option"]')].find((option) =>
        option.textContent?.trim().startsWith("Allow"),
      );
      expect(allow).toBeDefined();
      await act(async () => {
        allow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Exactly one row is staged as changed.
      const dirty = [...container.querySelectorAll("span")].filter(
        (span) => span.textContent === "Unsaved change",
      );
      expect(dirty).toHaveLength(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps WILDCARD-OVERLAPPING rules independently editable", async () => {
    // The companion to the duplicate case, and the plan's T15 companion.
    //
    // Wildcard-overlapping rules are a NORMAL, intended part of the upstream
    // precedence model: `shell *` and `shell git *` are two different rules
    // that both apply to different resources. The page must show the shadowed
    // one (the reader can see that a broad rule is not in force) AND still
    // let the reader edit it - a rule that is displayed but not editable is
    // a rule the reader cannot fix.
    permissions = [
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git *", effect: "deny" },
    ];
    try {
      const { root, container } = await mount();
      try {
        // Both rules are shown, and the broad one is marked as partly
        // overridden.
        const names = selects(container).map((element) => element.getAttribute("aria-label") ?? "");
        expect(names.some((name) => name.includes("shell * effect"))).toBe(true);
        expect(names.some((name) => name.includes("shell git * effect"))).toBe(true);
        expect(container.textContent ?? "").toContain("Partly overridden");

        // And the SHADOWED rule - the broad one - is still editable. It has
        // its own effect selector, and editing it stages a change on that row
        // alone.
        const target = selects(container).find((element) =>
          (element.getAttribute("aria-label") ?? "").includes("shell * effect (rule 1)"),
        );
        expect(target).toBeDefined();
        await act(async () => {
          target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const allow = [...document.querySelectorAll('[role="option"]')].find((option) =>
          option.textContent?.trim().startsWith("Allow"),
        );
        expect(allow).toBeDefined();
        await act(async () => {
          allow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        // Exactly ONE row is staged as changed: the broad one the reader
        // clicked, and not the narrower one that shadows it.
        const dirty = [...container.querySelectorAll("span")].filter(
          (span) => span.textContent === "Unsaved change",
        );
        expect(dirty).toHaveLength(1);
      } finally {
        act(() => root.unmount());
      }
    } finally {
      permissions = SNAPSHOT.permissions;
    }
  });

  it("marks the rule a later rule shadows, and leaves the others unmarked", async () => {
    const { root, container } = await mount();
    try {
      const text = container.textContent ?? "";
      // The first `shell *` is shadowed by the identical second one, so it
      // never applies.
      expect(text).toContain("Never applies");
      // The `question` rule has nothing after it that shadows it.
      expect(text).not.toContain("Partly overridden");
    } finally {
      act(() => root.unmount());
    }
  });

  it("numbers the rows by their place in the file, and names the overriding rule's file row", async () => {
    // A configuration whose second rule the page cannot read: the rule is
    // still in the file, and OpenCode still resolves the file's array.
    permissions = [
      { action: "shell", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "not-an-effect" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "allow" },
    ];
    const { root, container } = await mount();
    try {
      const text = container.textContent ?? "";
      // The rule in file row 1 is shadowed by the rule in file row 3 — the
      // unreadable rule in row 2 does not shift the relation.
      expect(text).toContain("row 3 wins for every request.");
      // The rule in file row 3 is shadowed by the rule in file row 4.
      expect(text).toContain("row 4 wins for every request.");
      // The last rule is shadowed by nothing.
      expect(text.match(/Never applies/g)).toHaveLength(2);

      // The rows are numbered by their place in the FILE, so the number the
      // notice names is a number the user can find on the table.
      const names = selects(container).map((element) => element.getAttribute("aria-label") ?? "");
      expect(names.filter((name) => name.includes("(rule 1)"))).toHaveLength(1);
      expect(names.filter((name) => name.includes("(rule 3)"))).toHaveLength(1);
      expect(names.filter((name) => name.includes("(rule 4)"))).toHaveLength(1);
      // Nothing is numbered by its place in the RENDERED list.
      expect(names.filter((name) => name.includes("(rule 2)"))).toHaveLength(0);
    } finally {
      act(() => root.unmount());
      permissions = SNAPSHOT.permissions;
    }
  });
});
