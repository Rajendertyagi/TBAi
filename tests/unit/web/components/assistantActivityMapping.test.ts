import { describe, it, expect } from "bun:test";
import { toolsConfig } from "@web/config/tools";
import { toolActivityLabel } from "@web/features/chat/toolActivityLabel";

describe("Direct tool activity label mappings", () => {
  it("has valid running tool verbs in toolsConfig", () => {
    const c = toolsConfig.copy.running;
    expect(c.reading).toBe("Reading…");
    expect(c.writing).toBe("Writing…");
    expect(c.editing).toBe("Editing…");
    expect(c.running).toBe("Running…");
    expect(c.findingFiles).toBe("Finding files…");
    expect(c.searching).toBe("Searching…");
    expect(c.searchingWeb).toBe("Searching the web…");
    expect(c.fetching).toBe("Fetching…");
    expect(c.waitingForAnswer).toBe("Waiting for your answer…");
    expect(c.loadingSkill).toBe("Loading skill…");
    expect(c.runningSubagent).toBe("Running subagent…");
  });

  it("maps command running tools including run_command and bash to Running…", () => {
    expect(toolActivityLabel("run_command")).toBe("Running…");
    expect(toolActivityLabel("bash")).toBe("Running…");
  });

  it("maps file writing and editing tools to Writing… and Editing…", () => {
    expect(toolActivityLabel("write")).toBe("Writing…");
    expect(toolActivityLabel("write_file")).toBe("Writing…");
    expect(toolActivityLabel("edit")).toBe("Editing…");
    expect(toolActivityLabel("edit_file")).toBe("Editing…");
    expect(toolActivityLabel("read")).toBe("Reading…");
    expect(toolActivityLabel("read_file")).toBe("Reading…");
  });
});
