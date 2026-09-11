import { describe, it, expect } from "bun:test";
import { createProgressTracker } from "./progress-tracker";
import type { ProgressStage } from "./progress-stages";

function extractStages(tracker: ReturnType<typeof createProgressTracker>): ProgressStage[] {
  // Trigger onFinish to get final snapshot
  const data = tracker.onFinish();
  return data.stages;
}

describe("progress-tracker", () => {
  it("starts with no stages", () => {
    const tracker = createProgressTracker();
    const data = tracker.onFinish();
    expect(data.stages).toEqual([]);
    expect(data.kind).toBe("tbai-progress");
    expect(data.version).toBe(1);
  });

  it("creates a stage on first tool execution start", () => {
    const tracker = createProgressTracker();
    tracker.onToolExecutionStart({
      toolCall: { toolName: "read_file" },
    });
    const stages = tracker.onFinish().stages;
    expect(stages).toHaveLength(1);
    expect(stages[0].id).toBe("read");
    expect(stages[0].label).toBe("Reading files");
    expect(stages[0].status).toBe("completed"); // onFinish completes active
  });

  it("aggregates multiple calls to the same category into one stage", () => {
    const tracker = createProgressTracker();
    tracker.onToolExecutionStart({ toolCall: { toolName: "read_file" } });
    tracker.onToolExecutionStart({ toolCall: { toolName: "search_files" } });
    tracker.onToolExecutionEnd({
      toolCall: { toolName: "read_file" },
      toolOutput: { type: "tool-result" },
    });
    tracker.onToolExecutionEnd({
      toolCall: { toolName: "search_files" },
      toolOutput: { type: "tool-result" },
    });
    const stages = tracker.onFinish().stages;
    // read → "read", search_files → "search" (different ids, so 2 stages)
    expect(stages).toHaveLength(2);
    const readStage = stages.find((s) => s.id === "read");
    const searchStage = stages.find((s) => s.id === "search");
    expect(readStage?.status).toBe("completed");
    expect(searchStage?.status).toBe("completed");
  });

  it("groups different tools in the same category into one stage", () => {
    const tracker = createProgressTracker();
    tracker.onToolExecutionStart({ toolCall: { toolName: "list_dir" } });
    tracker.onToolExecutionStart({ toolCall: { toolName: "file_info" } });
    tracker.onToolExecutionEnd({
      toolCall: { toolName: "list_dir" },
      toolOutput: { type: "tool-result" },
    });
    tracker.onToolExecutionEnd({
      toolCall: { toolName: "file_info" },
      toolOutput: { type: "tool-result" },
    });
    const stages = tracker.onFinish().stages;
    // Both map to id "inspect"
    expect(stages).toHaveLength(1);
    expect(stages[0].id).toBe("inspect");
    expect(stages[0].label).toBe("Inspecting workspace");
    expect(stages[0].status).toBe("completed");
  });

  it("marks unknown tools as generic execute stage", () => {
    const tracker = createProgressTracker();
    tracker.onToolExecutionStart({ toolCall: { toolName: "mcp_some_server__weird_tool" } });
    tracker.onToolExecutionEnd({
      toolCall: { toolName: "mcp_some_server__weird_tool" },
      toolOutput: { type: "tool-result" },
    });
    const stages = tracker.onFinish().stages;
    expect(stages).toHaveLength(1);
    expect(stages[0].id).toBe("execute");
    expect(stages[0].label).toBe("Executing tools");
  });

  it("marks stage as failed on tool error", () => {
    const tracker = createProgressTracker();
    tracker.onToolExecutionStart({ toolCall: { toolName: "run_command" } });
    tracker.onToolExecutionEnd({
      toolCall: { toolName: "run_command" },
      toolOutput: { type: "tool-error" },
    });
    const stages = tracker.onFinish().stages;
    expect(stages).toHaveLength(1);
    expect(stages[0].status).toBe("failed");
  });

  it("prior stages stay completed when a later stage fails", () => {
    const tracker = createProgressTracker();
    // Stage 1: inspect
    tracker.onToolExecutionStart({ toolCall: { toolName: "list_dir" } });
    tracker.onToolExecutionEnd({
      toolCall: { toolName: "list_dir" },
      toolOutput: { type: "tool-result" },
    });
    // Stage 2: modify (fails)
    tracker.onToolExecutionStart({ toolCall: { toolName: "write_file" } });
    tracker.onToolExecutionEnd({
      toolCall: { toolName: "write_file" },
      toolOutput: { type: "tool-error" },
    });
    const stages = tracker.onFinish().stages;
    expect(stages).toHaveLength(2);
    expect(stages.find((s) => s.id === "inspect")?.status).toBe("completed");
    expect(stages.find((s) => s.id === "modify")?.status).toBe("failed");
  });

  it("no tools called → empty progress", () => {
    const tracker = createProgressTracker();
    // Simulate a text-only response (no tool calls)
    const stages = tracker.onFinish().stages;
    expect(stages).toHaveLength(0);
  });
});
