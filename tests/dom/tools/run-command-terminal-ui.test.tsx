/**
 * `run_command`'s exit and timeout lines, rendered by the REAL component.
 *
 * `tests/e2e/typography-standardization.spec.ts` proves the live browser path for
 * a non-zero exit. A real TIMEOUT cannot be produced there deterministically:
 * `runBash` allows two minutes, so a spec would have to wait that long and race
 * the kill. This file covers that state deterministically instead, through the
 * same renderer the browser mounts.
 *
 * What is asserted:
 *
 *  - both terminal states render exactly one `data-slot="terminal-line"` row,
 *    with the copy the user reads;
 *  - the exit/timeout row carries NO font-family or font-size utility class, so
 *    the stylesheet's terminal rule (`--terminal-font-family`,
 *    `--terminal-font-size`, `--terminal-font-weight`) is what styles it;
 *  - the header status pill is the opposite: it keeps the FIXED metadata
 *    classes (`font-mono text-2xs`), so a Terminal Font setting cannot change
 *    metadata.
 */
import { describe, expect, it, mock } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as realReactExports from "@assistant-ui/react";

const useAuiStateMock = mock((selector: (state: unknown) => unknown) =>
  selector({ message: { parts: [] } }),
);

mock.module("@assistant-ui/react", () => ({
  ...realReactExports,
  useAuiState: useAuiStateMock,
}));

import { RunCommandTerminalUI } from "@web/tools/computer/terminal-ui.tsx";

type RenderProps = {
  readonly command: string;
  readonly result?: unknown;
  readonly running?: boolean;
};

/** One completed or running `run_command` part, as the runtime hands it over. */
function render({ command, result, running = false }: RenderProps): string {
  const part = {
    type: "tool-call",
    toolCallId: "call_terminal",
    toolName: "run_command",
    args: { command },
    argsText: JSON.stringify({ command }),
    result,
    status: running ? { type: "running" } : { type: "complete" },
    approval: undefined,
    respondToApproval: async () => {},
    isError: false,
  };
  const UI = RunCommandTerminalUI as unknown as (p: Record<string, unknown>) => ReactElement;
  return renderToStaticMarkup(createElement(UI, part));
}

/** The opening tag of every `data-slot="terminal-line"` row, plus its text. */
function terminalLines(html: string): { openTag: string; text: string }[] {
  const pattern = /<div\b([^>]*data-slot="terminal-line"[^>]*)>([\s\S]*?)<\/div>/g;
  const rows: { openTag: string; text: string }[] = [];
  for (const match of html.matchAll(pattern)) {
    rows.push({
      openTag: `<div${match[1]}>`,
      text: (match[2] ?? "").replaceAll(/<[^>]+>/g, "").trim(),
    });
  }
  return rows;
}

describe("run_command — the timeout state", () => {
  it("renders one timeout line, and it is the killed-process copy", () => {
    const html = render({
      command: "sleep 999",
      result: { exitCode: 1, timedOut: true, stdout: "", stderr: "" },
    });
    const lines = terminalLines(html);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("timed out — process killed");
    // The header badge reports failure; it must not claim "exit 0".
    expect(html).toContain("failed");
    expect(html).not.toContain("exit 0");
  });

  it("does not also render an exit line for a timed-out process", () => {
    const html = render({
      command: "sleep 999",
      result: { exitCode: 1, timedOut: true, stdout: "", stderr: "" },
    });
    expect(terminalLines(html).map((line) => line.text)).toEqual(["timed out — process killed"]);
    expect(terminalLines(html)[0]!.text).not.toMatch(/^exit \d+/);
  });
});

describe("run_command — the exit state", () => {
  it("renders the real exit code, not a derived one", () => {
    const html = render({
      command: "powershell -Command exit 7",
      result: { exitCode: 7, timedOut: false, stdout: "", stderr: "" },
    });
    const lines = terminalLines(html);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("exit 7");
  });

  it("keeps a successful command free of any status line", () => {
    const html = render({
      command: "echo ok",
      result: { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" },
    });
    expect(terminalLines(html)).toEqual([]);
    expect(html).toContain("exit 0");
    expect(html).not.toContain("failed");
  });

  it("shows no status line while the command is still running", () => {
    const html = render({ command: "sleep 2", running: true });
    expect(terminalLines(html)).toEqual([]);
  });
});

describe("run_command — the exit/timeout line belongs to the terminal channel", () => {
  it("carries no font-family, font-size or fixed-mono utility class", () => {
    for (const result of [
      { exitCode: 7, timedOut: false, stdout: "", stderr: "" },
      { exitCode: 1, timedOut: true, stdout: "", stderr: "" },
    ]) {
      const line = terminalLines(render({ command: "powershell -Command exit 7", result }))[0];
      expect(line).toBeDefined();
      // `font-mono` would pin the FIXED metadata stack (--font-mono), and
      // `text-xs`/`text-2xs` would pin a size. Both would defeat the
      // `--terminal-*` rule that makes these lines follow Terminal Font.
      expect(line!.openTag).not.toContain("font-mono");
      expect(line!.openTag).not.toContain("text-xs");
      expect(line!.openTag).not.toContain("text-2xs");
      expect(line!.openTag).not.toContain("font-");
      // No inline font either: static presentation belongs to the stylesheet.
      expect(line!.openTag).not.toContain("style=");
    }
  });

  it("leaves the header status pill on the fixed metadata classes", () => {
    const html = render({
      command: "powershell -Command exit 7",
      result: { exitCode: 7, timedOut: false, stdout: "", stderr: "" },
    });
    const pill = /<span\b([^>]*)>\s*failed\s*<\/span>/.exec(html);
    expect(pill).not.toBeNull();
    expect(pill![1]).toContain("font-mono");
    expect(pill![1]).toContain("text-2xs");
  });
});
