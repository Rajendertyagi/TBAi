/**
 * Dockview workspace theme — source guard (audit: hardcoded themeAbyss).
 *
 * The workspace must use a TBAi-owned theme whose CSS variables map onto the
 * app's theme tokens, so it follows light/dark mode and every custom palette.
 * A hardcoded vendor theme (themeAbyss) would stay dark in light mode.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import path from "node:path";
import { REPO_ROOT } from "../../../helpers/repo-root";
import { tbaiTheme } from "@web/features/workspace/dockviewTheme";

let globals = "";
let workspaceSource = "";

beforeAll(async () => {
  globals = await Bun.file(path.join(REPO_ROOT, "web/src/styles/globals.css")).text();
  workspaceSource = await Bun.file(
    path.join(REPO_ROOT, "web/src/features/workspace/components/DockviewWorkspace.tsx"),
  ).text();
});

describe("Dockview TBAi theme", () => {
  it("is a named TBAi theme with no hardcoded colorScheme and a flat tab indicator", () => {
    expect(tbaiTheme.name).toBe("tbai");
    expect(tbaiTheme.className).toBe("dockview-theme-tbai");
    // colorScheme must be omitted: the app sets color-scheme on :root/.dark and
    // it is inherited. Hardcoding it would pin one mode and break the other.
    expect(tbaiTheme.colorScheme).toBeUndefined();
    // Preserve the flat tab-group indicator of the previously used themeAbyss.
    expect(tbaiTheme.tabGroupIndicator).toBe("none");
  });

  it("the workspace uses the TBAi theme, not a hardcoded vendor theme", () => {
    expect(workspaceSource).toContain("theme={tbaiTheme}");
    expect(workspaceSource).not.toContain("themeAbyss");
  });

  it("maps Dockview variables onto app theme tokens in globals.css", () => {
    expect(globals).toContain(".dockview-theme-tbai");
    const block = globals.slice(globals.indexOf(".dockview-theme-tbai"));
    // Representative variables for background, foreground, border and accent.
    expect(block).toContain("--dv-group-view-background-color: var(--background)");
    expect(block).toContain("--dv-activegroup-visiblepanel-tab-color: var(--foreground)");
    // Dockview consumes --dv-separator-border as a COLOR (border: 1px solid
    // var(--dv-separator-border) / background-color: var(--dv-separator-border)),
    // so the value must be a color, not a border shorthand.
    expect(block).toContain("--dv-separator-border: var(--border)");
    expect(block).not.toContain("--dv-background-color");
    expect(block).toContain("--dv-active-sash-color: var(--ring)");
    expect(block).toContain("--dv-drag-over-background-color: color-mix(in srgb, var(--primary)");
    expect(block).toContain("--dv-floating-box-shadow: var(--elevation-floating)");
  });

  it("uses no inline styles for the workspace theme", () => {
    expect(workspaceSource).not.toMatch(/style=\{\{/);
  });
});
