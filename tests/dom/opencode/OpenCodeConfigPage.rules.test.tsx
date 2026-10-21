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

mock.module("@web/features/opencode/openCodeConfig.ts", () => ({
  ...realConfig,
  fetchOpenCodeConfig: async () => ({ ...SNAPSHOT, permissions: [...SNAPSHOT.permissions] }),
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
});
