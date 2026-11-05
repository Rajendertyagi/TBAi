import { describe, expect, it, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  applyTypographyToDom,
  DEFAULT_TYPOGRAPHY,
  resetApplicationScale,
  resetCodeTypography,
  resetInterfaceTypography,
  resetReadingTypography,
  resetTerminalTypography,
  type TypographyConfig,
} from "../../../web/src/features/appearance/typography";
import { REPO_ROOT } from "../../helpers/repo-root";

/**
 * Typography ownership, verified at the DOM boundary.
 *
 * happy-dom does not load globals.css, so the stylesheet's ownership rules are
 * pinned with source-text guards (the repo's established pattern for CSS
 * contracts), while the runtime applicator is exercised against a real
 * document. The two together prove:
 *
 * - `applyTypographyToDom` writes the v2 variables and NEVER `--font-mono`;
 * - the generic monospace rule still maps `.font-mono` to `var(--font-mono)`;
 * - code surfaces and the terminal block carry their own variables;
 * - scoped resets leave every unrelated group's variables untouched.
 */

const globalsCss = readFileSync(
  path.join(REPO_ROOT, "web", "src", "styles", "globals.css"),
  "utf8",
);
const terminalBlockSource = readFileSync(
  path.join(
    REPO_ROOT,
    "web",
    "src",
    "components",
    "assistant-ui",
    "elements",
    "terminal-block.tsx",
  ),
  "utf8",
);
const codeDiffSource = readFileSync(
  path.join(REPO_ROOT, "web", "src", "components", "assistant-ui", "elements", "code-diff.tsx"),
  "utf8",
);

function customConfig(overrides: Partial<TypographyConfig> = {}): TypographyConfig {
  return {
    version: 2,
    interfaceFontFamily: "roboto",
    interfaceFontSize: 18,
    interfaceFontWeight: 700,
    codeFontFamily: "fira-code",
    codeFontSize: 16,
    codeFontWeight: 300,
    codeWordWrap: true,
    terminalFontFamily: "source-code-pro",
    terminalFontSize: 14,
    terminalFontWeight: 600,
    terminalWrap: false,
    readingLineHeight: 1.65,
    appScale: 1.125,
    ...overrides,
  };
}

function rootStyle(): CSSStyleDeclaration {
  return document.documentElement.style;
}

describe("applyTypographyToDom — variable ownership", () => {
  beforeEach(() => {
    const root = document.documentElement;
    root.removeAttribute("data-code-wrap");
    root.removeAttribute("data-terminal-wrap");
    root.style.cssText = "";
  });

  it("writes the v2 variables and never --font-mono", () => {
    const written: string[] = [];
    const style = rootStyle();
    const original = style.setProperty.bind(style);
    style.setProperty = ((name: string, value: string) => {
      written.push(name);
      return original(name, value);
    }) as typeof style.setProperty;

    try {
      applyTypographyToDom(customConfig());
    } finally {
      // Restore the prototype method (the assignment created an own property).
      delete (style as { setProperty?: unknown }).setProperty;
    }

    expect(written).toContain("--font-sans");
    expect(written).toContain("--interface-font-size");
    expect(written).toContain("--font-weight-base");
    expect(written).toContain("--code-font-family");
    expect(written).toContain("--code-font-size");
    expect(written).toContain("--code-font-weight");
    expect(written).toContain("--terminal-font-family");
    expect(written).toContain("--terminal-font-size");
    expect(written).toContain("--terminal-font-weight");
    expect(written).toContain("--reading-line-height");
    expect(written).not.toContain("--font-mono");
    expect(written).not.toContain("--font-weight-mono");
    expect(written).not.toContain("--font-line-height");
  });

  it("sets the wrap data attributes on the root", () => {
    applyTypographyToDom(customConfig({ codeWordWrap: true, terminalWrap: false }));
    expect(document.documentElement.getAttribute("data-code-wrap")).toBe("on");
    expect(document.documentElement.getAttribute("data-terminal-wrap")).toBe("off");

    applyTypographyToDom(customConfig({ codeWordWrap: false, terminalWrap: true }));
    expect(document.documentElement.getAttribute("data-code-wrap")).toBe("off");
    expect(document.documentElement.getAttribute("data-terminal-wrap")).toBe("on");
  });

  it("applies the interface font size as an actual font-size variable", () => {
    applyTypographyToDom(customConfig({ interfaceFontSize: 20 }));
    expect(rootStyle().getPropertyValue("--interface-font-size")).toBe("20px");
  });

  it("applies the reading line height variable", () => {
    applyTypographyToDom(customConfig({ readingLineHeight: 1.65 }));
    expect(rootStyle().getPropertyValue("--reading-line-height")).toBe("1.65");
  });

  it("scoped resets leave every unrelated group's variables untouched", () => {
    applyTypographyToDom(customConfig());
    const custom = {
      codeFamily: rootStyle().getPropertyValue("--code-font-family"),
      codeSize: rootStyle().getPropertyValue("--code-font-size"),
      codeWeight: rootStyle().getPropertyValue("--code-font-weight"),
      terminalFamily: rootStyle().getPropertyValue("--terminal-font-family"),
      terminalSize: rootStyle().getPropertyValue("--terminal-font-size"),
      terminalWeight: rootStyle().getPropertyValue("--terminal-font-weight"),
      reading: rootStyle().getPropertyValue("--reading-line-height"),
    };

    // Interface reset: code, terminal and reading stay custom.
    resetInterfaceTypography(customConfig());
    expect(rootStyle().getPropertyValue("--code-font-family")).toBe(custom.codeFamily);
    expect(rootStyle().getPropertyValue("--code-font-size")).toBe(custom.codeSize);
    expect(rootStyle().getPropertyValue("--code-font-weight")).toBe(custom.codeWeight);
    expect(rootStyle().getPropertyValue("--terminal-font-family")).toBe(custom.terminalFamily);
    expect(rootStyle().getPropertyValue("--terminal-font-size")).toBe(custom.terminalSize);
    expect(rootStyle().getPropertyValue("--terminal-font-weight")).toBe(custom.terminalWeight);
    expect(rootStyle().getPropertyValue("--reading-line-height")).toBe(custom.reading);

    // Code reset: code returns to default; terminal and reading stay custom.
    resetCodeTypography(customConfig());
    expect(rootStyle().getPropertyValue("--code-font-family")).not.toBe(custom.codeFamily);
    expect(rootStyle().getPropertyValue("--terminal-font-family")).toBe(custom.terminalFamily);
    expect(rootStyle().getPropertyValue("--terminal-font-size")).toBe(custom.terminalSize);
    expect(rootStyle().getPropertyValue("--terminal-font-weight")).toBe(custom.terminalWeight);
    expect(rootStyle().getPropertyValue("--reading-line-height")).toBe(custom.reading);

    // Terminal reset: terminal returns to default; reading stays custom.
    resetTerminalTypography(customConfig());
    expect(rootStyle().getPropertyValue("--terminal-font-family")).not.toBe(custom.terminalFamily);
    expect(rootStyle().getPropertyValue("--reading-line-height")).toBe(custom.reading);

    // Reading reset: reading returns to default.
    resetReadingTypography(customConfig());
    expect(rootStyle().getPropertyValue("--reading-line-height")).toBe(
      String(DEFAULT_TYPOGRAPHY.readingLineHeight),
    );

    // Application scale reset: font variables are untouched.
    applyTypographyToDom(customConfig());
    resetApplicationScale(customConfig());
    expect(rootStyle().getPropertyValue("--code-font-family")).toBe(custom.codeFamily);
    expect(rootStyle().getPropertyValue("--terminal-font-family")).toBe(custom.terminalFamily);
  });
});

describe("globals.css — ownership rules (source-text guards)", () => {
  it("keeps the generic monospace rule on the fixed default stack", () => {
    expect(globalsCss).toMatch(
      /code,\s*\n?kbd,\s*\n?samp,\s*\n?pre,\s*\n?\.font-mono\s*\{\s*\n?\s*font-family:\s*var\(--font-mono\)/,
    );
  });

  it("maps code surfaces to the code font variables", () => {
    expect(globalsCss).toContain('[data-slot="code-diff"]');
    expect(globalsCss).toContain(".aui-md-pre");
    expect(globalsCss).toContain(".aui-shiki-base pre");
    expect(globalsCss).toContain(".aui-md-inline-code");
    expect(globalsCss).toContain("var(--code-font-family)");
    expect(globalsCss).toContain("var(--code-font-size)");
    expect(globalsCss).toContain("var(--code-font-weight)");
  });

  it("maps the terminal block to the terminal font variables", () => {
    expect(globalsCss).toMatch(
      /\[data-slot="terminal-block"\]\s*\{[^}]*font-family:\s*var\(--terminal-font-family\)/,
    );
    expect(globalsCss).toMatch(
      /\[data-slot="terminal-block"\]\s*\{[^}]*font-size:\s*var\(--terminal-font-size\)/,
    );
    expect(globalsCss).toMatch(
      /\[data-slot="terminal-block"\]\s*\{[^}]*font-weight:\s*var\(--terminal-font-weight\)/,
    );
  });

  it("scopes code word wrap to code surfaces only (never diffs)", () => {
    expect(globalsCss).toContain('[data-code-wrap="on"] .aui-md-pre');
    expect(globalsCss).toContain('[data-code-wrap="on"] .aui-shiki-base pre');
    expect(globalsCss).toContain("white-space: pre-wrap");
    expect(globalsCss).toContain("overflow-wrap: anywhere");
    // Diffs must never be wrapped by the code-wrap rule.
    expect(globalsCss).not.toMatch(/\[data-code-wrap="on"\][^{]*code-diff/);
  });

  it("scopes terminal wrapping to the terminal block rows, preserving whitespace", () => {
    expect(globalsCss).toContain('[data-terminal-wrap="on"] [data-slot="terminal-block"]');
    expect(globalsCss).toContain("white-space: pre-wrap");
    expect(globalsCss).toContain('[data-terminal-wrap="off"] [data-slot="terminal-block"]');
    expect(globalsCss).toContain("white-space: pre");
  });

  it("applies the reading line height to prose only", () => {
    expect(globalsCss).toMatch(
      /\.aui-md-p,\s*\n?\.aui-md-li,\s*\n?\.aui-reasoning-text\s*\{\s*\n?\s*line-height:\s*var\(--reading-line-height/,
    );
  });

  it("overrides the rem type scale from the interface font size (plain @theme)", () => {
    expect(globalsCss).toContain("--text-sm: calc(var(--interface-font-size) * 0.875)");
    expect(globalsCss).toContain("--text-base: var(--interface-font-size)");
    // Line-height tokens are unitless ratios and must NOT be overridden.
    expect(globalsCss).not.toContain("--text-sm--line-height:");
  });

  it("keeps root font-size fixed at 16px", () => {
    expect(globalsCss).toMatch(/:root\s*\{[^}]*font-size:\s*16px/);
  });

  it("no longer contains the dead .aui-code-diff or .ai-message-content rules", () => {
    expect(globalsCss).not.toContain(".aui-code-diff");
    expect(globalsCss).not.toContain(".ai-message-content");
  });

  it("no longer references the renamed variables", () => {
    expect(globalsCss).not.toContain("--font-weight-mono");
    expect(globalsCss).not.toContain("--font-line-height");
  });
});

describe("vendored components — structural anchors for the CSS selectors", () => {
  it('TerminalBlock renders data-slot="terminal-block" with a body as its last child', () => {
    expect(terminalBlockSource).toContain('data-slot="terminal-block"');
    // The wrap rules target `> div:last-child > div` (the body, then the rows).
    expect(terminalBlockSource).toContain("flex flex-col gap-1 px-4 pt-1 pb-3.5");
  });

  it('CodeDiff renders data-slot="code-diff" and keeps whitespace-pre rows', () => {
    expect(codeDiffSource).toContain('data-slot="code-diff"');
    expect(codeDiffSource).toContain("whitespace-pre");
  });
});
