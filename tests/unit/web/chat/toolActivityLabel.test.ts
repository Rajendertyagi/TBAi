import { describe, expect, it } from "bun:test";
import { toolActivityLabel } from "@web/features/chat/toolActivityLabel";

describe("Direct tool activity labels", () => {
  it("maps Direct's file tools to their running verbs", () => {
    expect(toolActivityLabel("read_file")).toBe("Reading…");
    expect(toolActivityLabel("write_file")).toBe("Writing…");
    expect(toolActivityLabel("edit_file")).toBe("Editing…");
    expect(toolActivityLabel("search_files")).toBe("Searching…");
  });

  it("maps Direct's workspace command tool to the running verb", () => {
    expect(toolActivityLabel("run_command")).toBe("Running…");
  });

  it("falls back to the tool name", () => {
    expect(toolActivityLabel("brand_new_tool")).toBe("brand_new_tool…");
  });
});
