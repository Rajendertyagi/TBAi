"use client";

import {
  useOpenCodeQuestions,
  useOpenCodeRuntimeExtras,
  useOpenCodeSession,
} from "@assistant-ui/react-opencode";
import { QuestionFormCard } from "@/components/shared/QuestionFormCard";
import { isLinkedQuestion } from "./toolLinkedQuestion";

/**
 * OpenCode question surface for Code mode — the FALLBACK for unlinked
 * requests only. A tool-linked pending question renders its answer UI on
 * that tool's card (`OpenCodeQuestionToolUI` via `useToolLinkedQuestion`),
 * so listing it here too would offer one decision twice — the same
 * linked-here/unlinked-there split the permission panel uses. Answered or
 * skipped prompts leave no row behind either way.
 *
 * Mounted as a sibling of ChatWindow (never inside it) so the ChatWindow
 * stays assistant-ui-primitives-only — same shell family as
 * OpenCodePermissions.
 *
 * The extras hooks assert a bound thread, but the runtime thread is unbound
 * on first paint (and after detach) — calling them then would throw on every
 * fresh mount. Without a session no question can exist or be answered, so
 * the bound UI below only mounts once a session is attached. That is the
 * adapter's lifecycle contract, not error suppression: a genuine structural
 * problem still throws inside the boundary instead of being hidden.
 */
export function OpenCodeQuestions() {
  const session = useOpenCodeSession();
  if (!session) return null;
  return <QuestionsBound />;
}

function QuestionsBound() {
  const questions = useOpenCodeQuestions();
  const { replyToQuestion, rejectQuestion } = useOpenCodeRuntimeExtras();

  const unlinked = questions.filter((req) => !isLinkedQuestion(req));
  if (unlinked.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      {unlinked.map((req) => (
        <QuestionFormCard
          key={req.id}
          questions={req.questions}
          onSubmit={(answers) => replyToQuestion(req.id, answers)}
          onDismiss={() => rejectQuestion(req.id)}
        />
      ))}
    </div>
  );
}
