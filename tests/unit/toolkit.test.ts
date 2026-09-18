import { describe, it, expect } from "bun:test";
import {
  appToolkit,
  nativeToolkit,
  NATIVE_TOOL_NAMES,
  openCodeToolkit,
  OPENCODE_TOOL_NAMES,
} from "../../web/src/tools/toolkit";

const EXPECTED = [
  // Filesystem
  "read_file",
  "list_dir",
  "search_files",
  "file_info",
  "write_file",
  "edit_file",
  "delete_file",
  "run_command",
  // Computer
  "process_list",
  "process_kill",
  "system_info",
  // Scheduler (AI-controlled, single action-dispatched tool)
  "scheduler",
  // Todo (per-conversation notepad)
  "todo",
  // Browser (native agent-browser CLI, no MCP)
  "browser",
  "browser_action",
];

describe("native toolkit registration", () => {
  it("registers exactly the 15 native tools, once each", () => {
    expect([...NATIVE_TOOL_NAMES].sort()).toEqual([...EXPECTED].sort());
    expect(new Set(NATIVE_TOOL_NAMES).size).toBe(15);
  });

  it("every entry is a backend render-only definition", () => {
    for (const name of EXPECTED) {
      const entry = (nativeToolkit as Record<string, any>)[name];
      expect(entry, name).toBeDefined();
      // Server owns contract + execution; client entry carries only the UI.
      expect(entry.type, name).toBe("backend");
      expect(typeof entry.render, name).toBe("function");
      expect(entry.execute, name).toBeUndefined();
    }
  });
});

/**
 * Code mode sends OpenCode's OWN tool names, which match none of the native
 * ones — so without a renderer for them every Code tool call fell through to
 * the generic fallback. These entries are renderers only: the model-facing
 * contract is assembled server-side (`src/tools/index.ts`), so registering a
 * foreign name here must not be mistaken for exposing a tool to the model.
 */
describe("OpenCode tool-name registration", () => {
  it("registers renderers for the OpenCode names", () => {
    // `question` was added for interactive prompts (and to fix the
    // "Runtime does not support tool results" crash when an unregistered
    // part fell through to ToolFallback).
    expect([...OPENCODE_TOOL_NAMES].sort()).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "question",
      "read",
      "skill",
      "task",
      "todowrite",
      "webfetch",
      "websearch",
      "write",
    ]);
  });

  it("keeps the OpenCode names out of the native registry", () => {
    // The native registry must keep meaning "the native tools" — the server's
    // list is the authority, and these are foreign names.
    for (const name of OPENCODE_TOOL_NAMES) {
      expect(NATIVE_TOOL_NAMES, name).not.toContain(name);
    }
  });

  it("has no name collision between the two registries", () => {
    // A shared key would silently shadow one renderer with the other.
    const overlap = NATIVE_TOOL_NAMES.filter((n) => OPENCODE_TOOL_NAMES.includes(n));
    expect(overlap).toEqual([]);
  });

  it("registers the union, with every OpenCode entry render-only", () => {
    expect(Object.keys(appToolkit).sort()).toEqual(
      [...NATIVE_TOOL_NAMES, ...OPENCODE_TOOL_NAMES].sort(),
    );
    for (const name of OPENCODE_TOOL_NAMES) {
      const entry = (appToolkit as Record<string, any>)[name];
      expect(entry.type, name).toBe("backend");
      expect(typeof entry.render, name).toBe("function");
      // No client execution: OpenCode runs the tool, we only draw it.
      expect(entry.execute, name).toBeUndefined();
    }
  });

  it("renders the permission-gated tools standalone, like the native ones", () => {
    // The native gated tools (write_file/edit_file/run_command) are standalone
    // so their approval cards stay out of a collapsed tool group; the OpenCode
    // equivalents must follow the same rule or a gate can be hidden.
    for (const gated of ["bash", "edit", "write"]) {
      const entry = (appToolkit as Record<string, any>)[gated];
      expect(entry.display, gated).toBe("standalone");
    }
  });

  it("leaves the ungated OpenCode reads inline, like the native ones", () => {
    // Native read_file / search_files are inline (a trace of what the model is
    // doing); the OpenCode equivalents match so the transcript does not fill
    // with one card per file read.
    for (const inline of ["read", "glob", "grep"]) {
      const entry = (appToolkit as Record<string, any>)[inline];
      expect(entry.display, inline).toBeUndefined();
    }
  });
});
