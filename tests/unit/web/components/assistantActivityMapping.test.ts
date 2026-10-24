import { describe, it, expect } from "bun:test";
import { toolsConfig } from "@web/config/tools";

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
});
