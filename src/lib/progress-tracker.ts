import { type ProgressStage, type ProgressData, resolveStage, type ProgressStatus } from "./progress-stages";

/**
 * Per-request progress tracker.
 *
 * Created inside the chat route handler for a single request. Never shared
 * across requests. Thread-safe because each instance is request-scoped via
 * AsyncLocalStorage or closure.
 *
 * Lifecycle:
 *   onToolExecutionStart → stage becomes "active"
 *   onToolExecutionEnd (success) → stage becomes "completed"
 *   onToolExecutionEnd (error) → stage becomes "failed"
 *   onFinish → complete any remaining "active" stages, emit final snapshot
 */
export interface ProgressTrackerCallbacks {
  onToolExecutionStart: (event: { toolCall: { toolName: string } }) => void;
  onToolExecutionEnd: (event: {
    toolCall: { toolName: string };
    toolOutput: { type: "tool-result" | "tool-error" };
  }) => void;
  onFinish: () => ProgressData;
}

export function createProgressTracker(): ProgressTrackerCallbacks {
  // Map of stageId → ProgressStage. Mutated in-place; snapshots are copies.
  const stages = new Map<string, ProgressStage>();

  function ensureStage(toolName: string, status: ProgressStatus): ProgressStage {
    const def = resolveStage(toolName);
    let stage = stages.get(def.id);
    if (!stage) {
      stage = { id: def.id, label: def.label, status: "pending" };
      stages.set(def.id, stage);
    }
    stage.status = status;
    return stage;
  }

  function snapshot(): ProgressData {
    return {
      kind: "tbai-progress",
      version: 1,
      stages: Array.from(stages.values()),
    };
  }

  return {
    onToolExecutionStart: ({ toolCall }) => {
      ensureStage(toolCall.toolName, "active");
    },

    onToolExecutionEnd: ({ toolCall, toolOutput }) => {
      if (toolOutput.type === "tool-error") {
        ensureStage(toolCall.toolName, "failed");
      } else {
        ensureStage(toolCall.toolName, "completed");
      }
    },

    onFinish: () => {
      // Complete any still-active stages when generation finishes naturally.
      for (const stage of stages.values()) {
        if (stage.status === "active") {
          stage.status = "completed";
        }
      }
      return snapshot();
    },
  };
}
