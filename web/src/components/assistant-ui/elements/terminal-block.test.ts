import { describe, it, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalBlock } from "./terminal-block";

/**
 * Guards the vendored Terminal Block's `status` prop.
 *
 * Upstream declares `status?: "success" | "error"`, documents it as
 * "Pass 'error' to show a red failure badge", and branches on it in the body —
 * but omits it from the destructuring list, so the body read the global
 * `window.status` instead. The observable effect: a failed command rendered a
 * green "exit 0" badge, and `RunCommandTerminalUI`'s `status="error"` was
 * dropped on the floor.
 *
 * These tests assert the prop is honoured, not how it is spelled, so a
 * re-vendor that drops the destructuring fails here rather than silently in
 * the UI.
 */
const base = {
  command: "bun test",
  lines: ["1 pass", "0 fail"],
  visibleCount: 2,
  done: true,
} as const;

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(TerminalBlock, { ...base, ...props }));

describe("TerminalBlock status", () => {
  it("shows the success badge when status is omitted", () => {
    const html = render({});
    expect(html).toContain("exit 0");
    expect(html).not.toContain("failed");
  });

  it("shows the failure badge when status is 'error'", () => {
    const html = render({ status: "error" });
    expect(html).toContain("failed");
    expect(html).not.toContain("exit 0");
  });

  it("does not fall through to the global window.status", () => {
    // The bug's signature: `status` resolving to something outside props.
    // A success-labelled render must not be affected by an ambient global.
    const original = (globalThis as { status?: unknown }).status;
    (globalThis as { status?: unknown }).status = "error";
    try {
      const html = render({});
      expect(html).toContain("exit 0");
      expect(html).not.toContain("failed");
    } finally {
      (globalThis as { status?: unknown }).status = original;
    }
  });

  it("keeps the badge hidden while the command is still running", () => {
    const html = render({ done: false });
    expect(html).not.toContain("exit 0");
    expect(html).not.toContain("failed");
  });
});
