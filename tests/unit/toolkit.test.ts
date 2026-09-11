import { describe, it, expect } from "bun:test";
import { nativeToolkit, NATIVE_TOOL_NAMES } from "../../web/src/tools/toolkit";

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
  // Scheduler (AI-controlled)
  "create_scheduled_job",
  "list_scheduled_jobs",
  "get_scheduled_job",
  "update_scheduled_job",
  "delete_scheduled_job",
  "run_scheduled_job_now",
];

describe("native toolkit registration", () => {
  it("registers exactly the 17 native tools, once each", () => {
    expect([...NATIVE_TOOL_NAMES].sort()).toEqual([...EXPECTED].sort());
    expect(new Set(NATIVE_TOOL_NAMES).size).toBe(17);
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
