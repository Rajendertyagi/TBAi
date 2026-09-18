import {
  useOpenCodeQuestions,
  useOpenCodeRuntimeExtras,
  type OpenCodeQuestionRequest,
} from "@assistant-ui/react-opencode";

/**
 * Tool-linked OpenCode question capability (Phase B).
 *
 * The frozen adapter stores questions but never projects them onto tool
 * parts, so a tool-linked question has no `approval` object and the generic
 * fallback would answer through `addResult` (wrong route — and it throws).
 * Answers must travel `replyToQuestion(answers)` / `rejectQuestion()`,
 * which live on the runtime extras. This module is the ONLY place that
 * knows the mapping between a rendered tool call and its pending question,
 * and the ONLY non-panel consumer of the question extras.
 *
 * Matching is strict: `request.tool.callID === toolCallId`. Anything else
 * (message id, request id, tool name, position, recency) is a mismatch and
 * yields no linked question.
 */

export function getQuestionToolCallId(
  request: OpenCodeQuestionRequest,
): string | undefined {
  const callID = request.tool?.callID;
  return typeof callID === "string" ? callID : undefined;
}

export function isLinkedQuestion(request: OpenCodeQuestionRequest): boolean {
  return getQuestionToolCallId(request) !== undefined;
}

export interface ToolLinkedQuestion {
  request: OpenCodeQuestionRequest;
  /** Answers every sub-question; forwards to `replyToQuestion(answers)`. */
  answer: (answers: string[][]) => Promise<void>;
  /** Skips the whole request; forwards to `rejectQuestion(requestId)`. */
  skip: () => Promise<void>;
}

/**
 * Finds the pending question linked to a rendered tool call.
 *
 * Reads the adapter-owned question state through the public extras hooks —
 * no new store, no mirrored maps. Returns `null` when nothing matches
 * (unlinked tool, answered/skipped already, or tool card without a
 * question); callers must fall back to the safest existing representation
 * and never fabricate UI state.
 *
 * Runtime safety: `useOpenCodeQuestions()` is null-safe (empty list when
 * unbound), but `useOpenCodeRuntimeExtras()` THROWS outside an OpenCode
 * runtime (installed adapter `hooks.js`: "Throws outside an OpenCode
 * runtime"). A historical question part can render while the runtime is
 * unavailable (loading history, first paint, conversation switching,
 * detach/reattach, session loss) — so the extras read is guarded and an
 * unbound render resolves to `null` (read-only fallback) instead of
 * crashing the message list. The try/catch wraps an unconditional call,
 * so hook order never varies between renders.
 */
export function useToolLinkedQuestion(
  toolCallId: string | undefined,
): ToolLinkedQuestion | null {
  const questions = useOpenCodeQuestions();
  let replyToQuestion:
    | ReturnType<typeof useOpenCodeRuntimeExtras>["replyToQuestion"]
    | undefined;
  let rejectQuestion:
    | ReturnType<typeof useOpenCodeRuntimeExtras>["rejectQuestion"]
    | undefined;
  try {
    ({ replyToQuestion, rejectQuestion } = useOpenCodeRuntimeExtras());
  } catch {
    replyToQuestion = undefined;
    rejectQuestion = undefined;
  }
  if (!toolCallId || !replyToQuestion || !rejectQuestion) return null;
  const request = questions.find(
    (candidate) => getQuestionToolCallId(candidate) === toolCallId,
  );
  if (!request) return null;
  const requestId = request.id;
  return {
    request,
    answer: (answers) => replyToQuestion(requestId, answers),
    skip: () => rejectQuestion(requestId),
  };
}
