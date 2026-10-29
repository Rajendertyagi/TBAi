import type { ThreadAssistantMessagePart, ToolCallMessagePartStatus } from "@assistant-ui/react";
import type { AgentState } from "@/components/assistant-ui/elements/agent-status";

/**
 * A message part plus the status the runtime attaches at run time.
 *
 * The published `ToolCallMessagePart` omits `status` on assistant-ui 0.15.30,
 * but the runtime reads it (`normalizePartStatus` in `@assistant-ui/core`), so
 * the field is stated once here instead of cast at each read.
 */
export type ActivityPart = ThreadAssistantMessagePart & {
  readonly status?: ToolCallMessagePartStatus;
};

export type ToolActivityLabel = (toolName: string) => string;

export interface ActivityStatus {
  state: AgentState;
  label: string;
}

/** Shared by the analyzer's approval row and the Code-mode primary's own. */
export const WAITING_FOR_APPROVAL = "Waiting for approval…";
const THINKING = "Thinking…";

/**
 * The activity an assistant message describes, from its parts alone: the newest
 * tool call still awaiting a result, else a running reasoning part, else
 * nothing while visible text is streaming.
 *
 * Engine-neutral: the caller supplies `toolLabel`, so Direct and OpenCode can
 * each own their tool vocabulary. Returns `null` when there is nothing to show.
 */
export function activityFromParts(
  parts: readonly ActivityPart[],
  toolLabel: ToolActivityLabel,
): ActivityStatus | null {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part.type === "tool-call" && part.result === undefined) {
      if (part.status?.type === "requires-action") {
        return { state: "waiting", label: WAITING_FOR_APPROVAL };
      }
      return { state: "working", label: toolLabel(part.toolName) };
    }
  }

  const runningReasoning = parts.find(
    (part) => part.type === "reasoning" && part.status?.type === "running",
  );
  if (runningReasoning) {
    return { state: "working", label: THINKING };
  }

  if (parts.some((part) => part.type === "text" && part.text.length > 0)) {
    return null;
  }

  return { state: "working", label: THINKING };
}
