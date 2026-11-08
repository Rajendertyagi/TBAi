import { describe, expect, it, beforeEach } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyTypographyToDom,
  DEFAULT_TYPOGRAPHY,
  readTypography,
  resetCodeTypography,
  resetInterfaceTypography,
  resetReadingTypography,
  resetTerminalTypography,
  type TypographyConfig,
} from "../../../web/src/features/appearance/typography";
import { REPO_ROOT } from "../../helpers/repo-root";
import {
  ToolFallbackArgs,
  ToolFallbackResult,
} from "@web/components/assistant-ui/elements/tool-fallback";
import { BoundedBody } from "@web/tools/body-budget.tsx";
import { mono } from "@web/components/assistant-ui/elements/surfaces";

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
 * - the OpenCode JSON preview's nested `<code>` is covered by the same rule
 *   that sets the code font (and the component really nests one);
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
const openCodeConfigPageSource = readFileSync(
  path.join(REPO_ROOT, "web", "src", "features", "opencode", "OpenCodeConfigPage.tsx"),
  "utf8",
);
const toolFallbackSource = readFileSync(
  path.join(REPO_ROOT, "web", "src", "components", "assistant-ui", "elements", "tool-fallback.tsx"),
  "utf8",
);
const openCodeToolUiSource = readFileSync(
  path.join(REPO_ROOT, "web", "src", "tools", "opencode", "ui.tsx"),
  "utf8",
);
const terminalToolUiSource = readFileSync(
  path.join(REPO_ROOT, "web", "src", "tools", "computer", "terminal-ui.tsx"),
  "utf8",
);
const bodyBudgetSource = readFileSync(
  path.join(REPO_ROOT, "web", "src", "tools", "body-budget.tsx"),
  "utf8",
);
const codeBudgetSource = readFileSync(
  path.join(REPO_ROOT, "web", "src", "components", "assistant-ui", "elements", "code-budget.tsx"),
  "utf8",
);
const toolTimelineSource = readFileSync(
  path.join(REPO_ROOT, "web", "src", "components", "assistant-ui", "elements", "tool-timeline.tsx"),
  "utf8",
);
const webSearchElementSource = readFileSync(
  path.join(REPO_ROOT, "web", "src", "components", "assistant-ui", "elements", "web-search.tsx"),
  "utf8",
);
const approvalCardSource = readFileSync(
  path.join(REPO_ROOT, "web", "src", "components", "assistant-ui", "elements", "approval-card.tsx"),
  "utf8",
);
const sidebarSectionSource = readFileSync(
  path.join(REPO_ROOT, "web", "src", "features", "sidebar", "components", "SidebarSection.tsx"),
  "utf8",
);
const providerDialogSource = readFileSync(
  path.join(REPO_ROOT, "web", "src", "features", "providers", "ProviderDialog.tsx"),
  "utf8",
);
const badgeSource = readFileSync(
  path.join(REPO_ROOT, "web", "src", "components", "ui", "badge.tsx"),
  "utf8",
);
const indexHtml = readFileSync(path.join(REPO_ROOT, "web", "index.html"), "utf8").replace(
  /\r\n/g,
  "\n",
);

/**
 * Every selector list whose rule declares `font-family: var(--code-font-family)`.
 *
 * Returned as arrays so a guard can assert that two selectors belong to the
 * SAME rule — the invariant, independent of how the formatter wraps the list.
 */
function codeFontSelectorGroups(): string[][] {
  const groups: string[][] = [];
  // Comments are stripped first: they contain no declarations but WOULD be
  // glued to the first selector of the rule that follows them.
  const css = globalsCss.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorList = match[1];
    const body = match[2];
    if (selectorList === undefined || body === undefined) continue;
    if (!/font-family:\s*var\(--code-font-family\)/.test(body)) continue;
    groups.push(selectorList.split(",").map((selector) => selector.trim()));
  }
  return groups;
}

function customConfig(overrides: Partial<TypographyConfig> = {}): TypographyConfig {
  return {
    version: 3,
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
    expect(written).toContain("font-size");
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

  it("applies the interface font size as root rem font-size", () => {
    applyTypographyToDom(customConfig({ interfaceFontSize: 20 }));
    expect(rootStyle().fontSize).toBe("125%");
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

  it("applies the code font to the OpenCode preview and its nested code element", () => {
    // The preview is `<pre data-slot="code-preview"><code>…</code></pre>`. The
    // generic `code` rule gives the child `--font-mono`, so a selector for the
    // `<pre>` alone leaves the visible text on the fixed stack. Both must sit
    // in the same rule that sets the code font, or the child wins.
    const groups = codeFontSelectorGroups();
    const coversPreview = groups.some(
      (selectors) =>
        selectors.includes('[data-slot="code-preview"]') &&
        selectors.includes('[data-slot="code-preview"] code'),
    );
    expect(coversPreview).toBe(true);
  });

  it("maps the terminal block to the terminal font variables", () => {
    expect(globalsCss).toMatch(
      /\[data-slot="terminal-block"\][^{}]*\{[^}]*font-family:\s*var\(--terminal-font-family\)/,
    );
    expect(globalsCss).toMatch(
      /\[data-slot="terminal-block"\][^{}]*\{[^}]*font-size:\s*var\(--terminal-font-size\)/,
    );
    expect(globalsCss).toMatch(
      /\[data-slot="terminal-block"\][^{}]*\{[^}]*font-weight:\s*var\(--terminal-font-weight\)/,
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

  it("preserves native Tailwind rem type scale and drops manual @theme calc overrides", () => {
    expect(globalsCss).not.toContain("--text-sm: calc(");
    expect(globalsCss).not.toContain("--text-base: var(--interface-font-size)");
    expect(globalsCss).not.toContain("--interface-font-size");
  });

  it("keeps root font-size at 93.75% (15px) and base weight at 300 in stylesheet", () => {
    expect(globalsCss).toMatch(/:root\s*\{[^}]*font-size:\s*93\.75%/);
    expect(globalsCss).toMatch(/:root\s*\{[^}]*--font-weight-base:\s*300/);
    expect(globalsCss).toMatch(/:root\s*\{[^}]*font-weight:\s*var\(--font-weight-base,\s*300\)/);
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

  it('OpenCodeConfigPage renders its JSON preview as <pre data-slot="code-preview"><code>', () => {
    // The CSS above targets `[data-slot="code-preview"] code`; if the preview
    // stopped nesting a `<code>` element the selector would match nothing and
    // the code font would silently stop applying.
    expect(openCodeConfigPageSource).toMatch(
      /<pre\b[^>]*data-slot="code-preview"[^>]*>\s*<code>\{raw\}<\/code>\s*<\/pre>/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3d/3e — classification hooks and the Phase 4 floor
// ─────────────────────────────────────────────────────────────────────────────

describe("globals.css — payload and terminal-line classification", () => {
  it("puts the payload hook in the SAME rule as the code font, with its nested code", () => {
    // The payload is a `<pre>` (tool bodies) or a `<div>`/`<pre>` pair. A
    // selector for the hook alone leaves a nested `<code>` on the generic
    // monospace stack, exactly like the preview rule above.
    const groups = codeFontSelectorGroups();
    const codeGroup = groups.find((selectors) => selectors.includes(".aui-md-pre"));
    expect(codeGroup).toBeDefined();
    expect(codeGroup).toContain('[data-slot="code-payload"]');
    expect(codeGroup).toContain('[data-slot="code-payload"] code');
  });

  it("never widens the code rule to a bare pre or code selector", () => {
    const groups = codeFontSelectorGroups();
    const codeGroup = groups.find((selectors) => selectors.includes(".aui-md-pre"));
    expect(codeGroup).toBeDefined();
    expect(codeGroup).not.toContain("pre");
    expect(codeGroup).not.toContain("code");
  });

  it("joins terminal lines to the terminal channel, without a bare element selector", () => {
    const css = globalsCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = css.match(/([^{}]+)\{[^{}]*font-family:\s*var\(--terminal-font-family\)[^{}]*\}/);
    expect(rule).not.toBeNull();
    const selectors = (rule?.[1] ?? "").split(",").map((selector) => selector.trim());
    expect(selectors).toContain('[data-slot="terminal-block"]');
    expect(selectors).toContain('[data-slot="terminal-line"]');
    expect(selectors).not.toContain("pre");
    expect(selectors).not.toContain("code");
  });

  it("floors text-2xs and text-3xs at 9px while keeping them rem-based", () => {
    expect(globalsCss).toMatch(/@utility text-2xs\s*\{\s*font-size:\s*max\(9px,\s*0\.6875rem\)/);
    expect(globalsCss).toMatch(/@utility text-3xs\s*\{\s*font-size:\s*max\(9px,\s*0\.625rem\)/);
  });
});

describe("payload hook — rendered markup", () => {
  function pre(html: string): string {
    const open = /<pre\b[^>]*>/.exec(html);
    if (open === null) throw new Error("no <pre> was rendered");
    return open[0];
  }

  it("marks the tool-fallback args and result bodies as payloads", () => {
    for (const html of [
      renderToStaticMarkup(<ToolFallbackArgs argsText='{"path":"a.txt"}' />),
      renderToStaticMarkup(<ToolFallbackResult result={{ path: "a.txt" }} />),
    ]) {
      const openTag = pre(html);
      expect(openTag).toContain('data-slot="code-payload"');
      expect(openTag).not.toContain("text-xs");
    }
  });

  it("marks a bounded tool body as a payload and keeps its notice on the interface family", () => {
    const html = renderToStaticMarkup(<BoundedBody text={"line\n".repeat(5000)} />);
    expect(pre(html)).toContain('data-slot="code-payload"');
    expect(pre(html)).not.toContain("text-xs");
    // The omission note is a status sentence, not payload: no hook, no mono.
    const notice = /<p\b[^>]*role="status"[^>]*>/.exec(html)?.[0] ?? "";
    expect(notice).toContain("text-2xs");
    expect(notice).not.toContain('data-slot="code-payload"');
    expect(notice).not.toContain("font-mono");
  });

  it("leaves the two truncation notices and the grant token outside the hook", () => {
    // Bucket 5: interface-family status text, `text-2xs` from Phase 4d.
    expect(codeBudgetSource).toContain("text-2xs");
    expect(codeBudgetSource).not.toContain('data-slot="code-payload"');
    expect(bodyBudgetSource).toContain("text-2xs");
    // Bucket 3: the permission grant token is a machine identifier on the
    // fixed mono channel. It keeps `text-xs` and never gains the payload hook.
    const grant = toolFallbackSource.match(
      /<code\b[^>]*aui-tool-fallback-approval-confirm-grant[^>]*>/,
    );
    expect(grant?.[0]).toContain("text-xs");
    expect(grant?.[0]).not.toContain('data-slot="code-payload"');
  });

  it("marks every OpenCode structured payload body", () => {
    const payloadPres = openCodeToolUiSource.match(/<pre\b[^>]*>/g) ?? [];
    // Result body, plain-text body, write preview, edit preview (x2), patch
    // fallback. The grant-token `<code>` is deliberately not a `<pre>`.
    expect(payloadPres.length).toBe(6);
    for (const openTag of payloadPres) {
      expect(openTag).toContain('data-slot="code-payload"');
    }
  });
});

describe("terminal-line hook — markup", () => {
  it("marks both exit/timeout lines, and only those lines", () => {
    const lines = terminalToolUiSource.match(/data-slot="terminal-line"/g) ?? [];
    expect(lines.length).toBe(2);
    expect(terminalToolUiSource).toContain("timed out");
    expect(terminalToolUiSource).toContain("exit {exitCode}");
  });
});

describe("typography bootstrap — executable parity with readTypography", () => {
  const BOOTSTRAP_START = 'try {\n        var tyRaw = localStorage.getItem("tbai-typography");';
  const BOOTSTRAP_END = "} catch (e) { /* storage unavailable — stylesheet defaults stand */ }";

  function bootstrapSource(): string {
    const start = indexHtml.indexOf(BOOTSTRAP_START);
    if (start === -1) throw new Error("typography bootstrap start not found in web/index.html");
    const end = indexHtml.indexOf(BOOTSTRAP_END, start);
    if (end === -1) throw new Error("typography bootstrap end not found in web/index.html");
    return indexHtml.slice(start, end + BOOTSTRAP_END.length);
  }

  /** Run the shipped pre-paint script against a fake root and return its writes. */
  function runBootstrap(stored: unknown): { writes: Map<string, string>; rootFontSize: string } {
    const writes = new Map<string, string>();
    let rootFontSize = "";
    const documentStub = {
      documentElement: {
        style: {
          setProperty: (name: string, value: string) => writes.set(name, value),
          removeProperty: () => {},
          set fontSize(value: string) {
            rootFontSize = value;
          },
          get fontSize() {
            return rootFontSize;
          },
          zoom: "",
        },
        setAttribute: (name: string, value: string) => writes.set(`@${name}`, value),
        removeAttribute: () => {},
      },
    };
    const storageStub = {
      getItem: (key: string) => (key === "tbai-typography" ? JSON.stringify(stored) : null),
    };
    // The shipped script is a static, repository-authored IIFE-free block.
    new Function("localStorage", "document", bootstrapSource())(storageStub, documentStub);
    return { writes, rootFontSize };
  }

  it("agrees with readTypography for every boundary input", () => {
    const inputs = [12, 13, 14, 16, 24, 11, 25];
    for (const size of inputs) {
      const stored = { ...DEFAULT_TYPOGRAPHY, interfaceFontSize: size };
      window.localStorage.setItem("tbai-typography", JSON.stringify(stored));
      const hydrated = readTypography().interfaceFontSize;
      const prePaint = runBootstrap(stored).rootFontSize;
      expect(prePaint, `stored ${size}`).toBe(`${(hydrated / 16) * 100}%`);
    }
    window.localStorage.removeItem("tbai-typography");
  });

  it("paints a stored 12 at 12px, identical before and after hydration", () => {
    const stored = { ...DEFAULT_TYPOGRAPHY, interfaceFontSize: 12 };
    window.localStorage.setItem("tbai-typography", JSON.stringify(stored));
    const prePaint = runBootstrap(stored).rootFontSize;

    applyTypographyToDom(readTypography());
    const postHydration = document.documentElement.style.fontSize;

    expect(prePaint).toBe(`${(12 / 16) * 100}%`);
    expect(postHydration).toBe(prePaint);
    window.localStorage.removeItem("tbai-typography");
  });

  it("leaves clean-install (no storage) and invalid storage matching default 15px / 300 across bootstrap and runtime", () => {
    // 1. Clean installation: no localStorage item
    window.localStorage.removeItem("tbai-typography");
    const cleanBootstrap = runBootstrap(null);
    // When no storage exists, bootstrap does not override root style fontSize or --font-weight-base,
    // so globals.css defaults (93.75% = 15px, and weight 300) stand untouched.
    expect(cleanBootstrap.rootFontSize).toBe("");
    expect(cleanBootstrap.writes.has("--font-weight-base")).toBe(false);

    // Runtime readTypography yields 15px and 300 weight
    const cleanConfig = readTypography();
    expect(cleanConfig.interfaceFontSize).toBe(15);
    expect(cleanConfig.interfaceFontWeight).toBe(300);

    // Applying runtime config sets 93.75% and 300
    applyTypographyToDom(cleanConfig);
    expect(document.documentElement.style.fontSize).toBe(`${(15 / 16) * 100}%`);
    expect(rootStyle().getPropertyValue("--font-weight-base")).toBe("300");

    // 2. Corrupted/invalid storage
    window.localStorage.setItem("tbai-typography", "not-a-json");
    const invalidConfig = readTypography();
    expect(invalidConfig.interfaceFontSize).toBe(15);
    expect(invalidConfig.interfaceFontWeight).toBe(300);
    applyTypographyToDom(invalidConfig);
    expect(document.documentElement.style.fontSize).toBe(`${(15 / 16) * 100}%`);
    expect(rootStyle().getPropertyValue("--font-weight-base")).toBe("300");
    window.localStorage.removeItem("tbai-typography");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — inventory, helper, multipliers and the one investigated control
// ─────────────────────────────────────────────────────────────────────────────

function walkSource(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkSource(full));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe("Phase 4 inventory — literal pixels and ad-hoc multipliers", () => {
  const webSrc = path.join(REPO_ROOT, "web", "src");
  const files = walkSource(webSrc);

  it("leaves only the two documented 9px geometry badges", () => {
    const matches: string[] = [];
    for (const file of files) {
      let text = readFileSync(file, "utf8");
      if (file.endsWith(".css")) text = text.replace(/\/\*[\s\S]*?\*\//g, "");
      const relative = path.relative(REPO_ROOT, file).replaceAll("\\", "/");
      text.split("\n").forEach((line) => {
        for (const match of line.matchAll(/text-\[(\d+)px\]/g)) {
          matches.push(`${relative}:${match[1]}`);
        }
      });
    }
    expect(matches.sort()).toEqual([
      "web/src/components/ActivityBar.tsx:9",
      "web/src/components/assistant-ui/elements/web-search.tsx:9",
    ]);
  });

  it("removes the three active 0.84375 multipliers and leaves the unused vendored one", () => {
    expect(toolTimelineSource).not.toContain("0.84375");
    expect(webSearchElementSource).not.toContain("0.84375");
    // Unused vendored component: documented, deliberately not edited.
    expect(approvalCardSource).toContain("0.84375");
  });

  it("permits only the documented responsive calc multipliers of --interface-font-size", () => {
    const calcMatches: string[] = [];
    for (const file of files) {
      if (file.endsWith(".css")) continue; // Theme definitions in globals.css define the type scale
      const text = readFileSync(file, "utf8");
      const relative = path.relative(REPO_ROOT, file).replaceAll("\\", "/");
      const lines = text.split("\n");
      lines.forEach((line) => {
        const matches = line.matchAll(/calc\(var\(--interface-font-size\)\s*\*\s*([\d.]+)\)/g);
        for (const m of matches) {
          calcMatches.push(`${relative}:${m[1]}`);
        }
      });
    }
    // approval-card.tsx: 0.84375 is the single documented vendored unused exception.
    // SidebarSection.tsx migrated to native rem text-[0.8125rem].
    expect(calcMatches.sort()).toEqual([
      "web/src/components/assistant-ui/elements/approval-card.tsx:0.84375",
    ]);
  });

  it("migrates the mono helper to the compact scale", () => {
    expect(mono).toContain("text-2xs");
    expect(mono).not.toContain("text-[11px]");
  });

  it("lets the measured SidebarSection row grow instead of clipping", () => {
    expect(sidebarSectionSource).toContain("flex min-h-6 items-center");
    expect(sidebarSectionSource).not.toContain("flex h-6 items-center");
  });

  it("migrates the investigated ProviderDialog control and lets it grow", () => {
    // Phase 1 geometry: at a 24px interface `text-3xs` computes 15px while
    // `h-5` leaves a 10px content box after `py-1` + border, so the fixed
    // height clips. `min-h-5` preserves the 20px row at the default and lets
    // the control grow at the maximum.
    const row = providerDialogSource.match(/className="[^"]*w-20[^"]*"/)?.[0] ?? "";
    expect(row).toContain("min-h-5");
    expect(row).toContain("text-3xs");
    expect(row).not.toMatch(/(?<!min-)h-5 w-20/);
    expect(row).not.toContain("text-[10px]");
  });

  it("gives the badge a content-driven minimum instead of a fixed height", () => {
    expect(badgeSource).toContain("min-h-5");
    expect(badgeSource).not.toMatch(/(?<!min-)h-5/);
    expect(badgeSource).toContain("overflow-hidden");
  });
});
