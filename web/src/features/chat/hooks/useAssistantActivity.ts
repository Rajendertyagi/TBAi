import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import type { AgentState } from "@/components/assistant-ui/elements/agent-status";
import { toolsConfig } from "@/config/tools";

export interface AssistantActivity {
  state: AgentState;
  label: string;
  elapsed?: string;
}

function getToolRunningLabel(toolName: string): string {
  const c = toolsConfig.copy.running;
  switch (toolName) {
    case "read":
    case "read_file":
      return c.reading;
    case "write":
    case "write_file":
      return c.writing;
    case "edit":
    case "edit_file":
    case "patch":
      return c.editing;
    case "bash":
    case "execute":
      return c.running;
    case "glob":
    case "find_files":
      return c.findingFiles;
    case "grep":
    case "search_files":
      return c.searching;
    case "websearch":
      return c.searchingWeb;
    case "webfetch":
      return c.fetching;
    case "question":
      return c.waitingForAnswer;
    case "skill":
      return c.loadingSkill;
    case "subagent":
      return c.runningSubagent;
    default:
      return `${toolName}…`;
  }
}

export function useAssistantActivity(): AssistantActivity | null {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const lastMessage = useAuiState((s) => s.thread.messages.at(-1));

  const [seconds, setSeconds] = useState(0);

  const rawStatus = (() => {
    if (!isRunning || !lastMessage || lastMessage.role !== "assistant") {
      return null;
    }

    const parts = lastMessage.parts ?? [];

    // Scan for pending tool call (result === undefined)
    const pendingTool = parts.find(
      (p) => p.type === "tool-call" && (p as { result?: unknown }).result === undefined,
    ) as { toolName: string; status?: { type: string } } | undefined;

    if (pendingTool) {
      const isRequiresAction = pendingTool.status?.type === "requires-action";
      return {
        state: (isRequiresAction ? "waiting" : "working") as AgentState,
        label: isRequiresAction
          ? "Waiting for approval…"
          : getToolRunningLabel(pendingTool.toolName),
      };
    }

    // Scan for running reasoning
    const runningReasoning = parts.find(
      (p) =>
        p.type === "reasoning" && (p as { status?: { type: string } }).status?.type === "running",
    );
    if (runningReasoning) {
      return {
        state: "working" as AgentState,
        label: "Thinking…",
      };
    }

    // If text parts exist and no tool is pending: stop rendering
    const hasText = parts.some((p) => p.type === "text" && (p as { text?: string }).text?.length);
    if (hasText) {
      return null;
    }

    // Default while thread is running
    return {
      state: "working" as AgentState,
      label: "Thinking…",
    };
  })();

  const hasActivity = rawStatus !== null;

  // Timer: runs only while an active status exists, cleared when null
  useEffect(() => {
    if (!hasActivity) {
      setSeconds(0);
      return;
    }

    const interval = setInterval(() => {
      setSeconds((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [hasActivity]);

  if (!rawStatus) return null;

  return {
    state: rawStatus.state,
    label: rawStatus.label,
    elapsed: seconds > 0 ? `${seconds}s` : undefined,
  };
}
