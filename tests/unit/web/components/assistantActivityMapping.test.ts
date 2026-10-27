import { describe, it, expect } from "bun:test";
import { toolsConfig } from "@web/config/tools";
import { getToolRunningLabel } from "@web/features/chat/hooks/useAssistantActivity";

describe("useAssistantActivity mappings", () => {
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

  it("maps command running tools including shell and bash to Running…", () => {
    expect(getToolRunningLabel("shell")).toBe("Running…");
    expect(getToolRunningLabel("bash")).toBe("Running…");
    expect(getToolRunningLabel("execute")).toBe("Running…");
  });

  it("maps file writing and editing tools to Writing… and Editing…", () => {
    expect(getToolRunningLabel("write")).toBe("Writing…");
    expect(getToolRunningLabel("write_file")).toBe("Writing…");
    expect(getToolRunningLabel("edit")).toBe("Editing…");
    expect(getToolRunningLabel("edit_file")).toBe("Editing…");
    expect(getToolRunningLabel("patch")).toBe("Editing…");
    expect(getToolRunningLabel("read")).toBe("Reading…");
    expect(getToolRunningLabel("read_file")).toBe("Reading…");
  });
});
