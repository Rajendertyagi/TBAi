import { describe, it, expect } from "bun:test";
import { nativeToolkit, NATIVE_TOOL_NAMES } from "../../web/src/tools/toolkit";

const EXPECTED = [
  "read_file",
  "list_dir",
  "search_files",
  "file_info",
  "write_file",
  "edit_file",
  "delete_file",
  "run_command",
  "process_list",
  "process_kill",
  "system_info",
];

describe("native toolkit registration", () => {
  it("registers exactly the 11 native tools, once each", () => {
    expect([...NATIVE_TOOL_NAMES].sort()).toEqual([...EXPECTED].sort());
    expect(new Set(NATIVE_TOOL_NAMES).size).toBe(11);
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
