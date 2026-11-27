/**
 * Dockview theme — computed-style behavioral test.
 *
 * The existing `tests/unit/web/workspace/dockview-theme.test.ts` is a CSS
 * source-text guard: it proves the mapping is written, not that a browser
 * resolves it. This DOM test injects the REAL `.dockview-theme-tbai` block from
 * globals.css into happy-dom, renders an element with that class, and asserts
 * `getComputedStyle` resolves six representative Dockview variables (of the 31
 * defined in the block) from the app's theme tokens. It then changes the token
 * values and asserts the computed values follow — which would fail if a vendor
 * color were hardcoded.
 *
 * happy-dom cannot parse Tailwind's `@theme`/`@import`, so only the real theme
 * block is extracted and injected; the assertions are on computed style, not
 * on the source text.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { REPO_ROOT } from "../../helpers/repo-root";

let themeBlock = "";

beforeAll(async () => {
  const globals = await Bun.file(path.join(REPO_ROOT, "web/src/styles/globals.css")).text();
  const start = globals.indexOf(".dockview-theme-tbai {");
  if (start < 0) throw new Error(".dockview-theme-tbai block not found in globals.css");
  const end = globals.indexOf("\n}", start);
  if (end < 0) throw new Error(".dockview-theme-tbai block is unterminated");
  themeBlock = globals.slice(start, end + 2);
});

/** Distinct token values so a hardcoded color cannot accidentally match. */
const TOKENS_A =
  ":root{--background:#010203;--foreground:#fafafa;--border:#333333;--ring:#445566;--primary:#112233;--elevation-floating:0 0 0 #778899}";
const TOKENS_B =
  ":root{--background:#aabbcc;--foreground:#0f0f0f;--border:#ddeeff;--ring:#998877;--primary:#665544;--elevation-floating:2px 4px 6px #a1b2c3}";

interface Probe {
  el: HTMLElement;
  cleanup: () => void;
}

function mountThemeProbe(tokenCss: string): Probe {
  const style = document.createElement("style");
  style.textContent = `${tokenCss}\n${themeBlock}`;
  document.head.appendChild(style);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<div className="dockview-theme-tbai" data-testid="theme-probe" />);
  });
  const el = container.querySelector<HTMLElement>('[data-testid="theme-probe"]');
  if (!el) throw new Error("theme probe element not rendered");

  return {
    el,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
      style.remove();
    },
  };
}

function resolved(el: HTMLElement, property: string): string {
  return getComputedStyle(el).getPropertyValue(property).trim();
}

describe("Dockview theme — computed style follows app tokens", () => {
  it("uses the real theme block from globals.css as its fixture", () => {
    // Fixture sanity: the computed assertions below are only meaningful if the
    // injected CSS is the production block, not a stale inline copy.
    expect(themeBlock).toContain("--dv-group-view-background-color: var(--background)");
    expect(themeBlock).toContain("--dv-separator-border: var(--border)");
    expect(themeBlock).toContain("--dv-active-sash-color: var(--ring)");
  });

  it("resolves Dockview variables from the injected token values", () => {
    const probe = mountThemeProbe(TOKENS_A);
    try {
      expect(resolved(probe.el, "--dv-group-view-background-color")).toBe("#010203");
      expect(resolved(probe.el, "--dv-activegroup-visiblepanel-tab-color")).toBe("#fafafa");
      expect(resolved(probe.el, "--dv-separator-border")).toBe("#333333");
      expect(resolved(probe.el, "--dv-active-sash-color")).toBe("#445566");
      expect(resolved(probe.el, "--dv-floating-box-shadow")).toBe("0 0 0 #778899");
      // color-mix must receive the resolved --primary, not a literal color.
      expect(resolved(probe.el, "--dv-drag-over-background-color")).toContain("#112233");
    } finally {
      probe.cleanup();
    }
  });

  it("follows a changed token set instead of pinning one palette", () => {
    const probe = mountThemeProbe(TOKENS_B);
    try {
      expect(resolved(probe.el, "--dv-group-view-background-color")).toBe("#aabbcc");
      expect(resolved(probe.el, "--dv-activegroup-visiblepanel-tab-color")).toBe("#0f0f0f");
      expect(resolved(probe.el, "--dv-separator-border")).toBe("#ddeeff");
      expect(resolved(probe.el, "--dv-active-sash-color")).toBe("#998877");
      expect(resolved(probe.el, "--dv-floating-box-shadow")).toBe("2px 4px 6px #a1b2c3");
      expect(resolved(probe.el, "--dv-drag-over-background-color")).toContain("#665544");
    } finally {
      probe.cleanup();
    }
  });
});
