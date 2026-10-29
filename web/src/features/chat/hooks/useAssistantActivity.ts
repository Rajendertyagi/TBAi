import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { activityFromParts, type ActivityStatus } from "@/lib/assistantActivityParts";
import { toolActivityLabel } from "../toolActivityLabel";

export interface AssistantActivity extends ActivityStatus {
  elapsed?: string;
}

export function useAssistantActivity(): AssistantActivity | null {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const lastMessage = useAuiState((s) => s.thread.messages.at(-1));

  const [seconds, setSeconds] = useState(0);

  const rawStatus =
    isRunning && lastMessage?.role === "assistant"
      ? activityFromParts(lastMessage.content, toolActivityLabel)
      : null;

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
