import type { OpenCodeRuntimeClient } from "./eventScope";
import { withDirectory, type OpenCodeScope } from "./opencodeScope";

/**
 * OpenCode question compatibility layer — the same directory-scoping fix as
 * `permissionCompat.ts`, applied to the question routes.
 *
 * Questions live in the same server interaction architecture as permissions and
 * are addressed the same way: the routes exist both unscoped (`/question`) and
 * session-scoped (`/api/session/{id}/question`), and the adapter calls the
 * unscoped pair without a location. Leaving them unscoped would recreate the
 * exact bug fixed for permissions — a pending question that can never be listed
 * or answered — so the scope is supplied here too.
 *
 * It shares {@link withDirectory} with the permission patch rather than
 * duplicating the scope rule.
 *
 *   client.question.list()                          -> GET  /question?directory=<dir>
 *   client.question.reply({ requestID, answers })   -> POST /question/{requestID}/reply?directory=<dir>
 *   client.question.reject({ requestID })           -> POST /question/{requestID}/reject?directory=<dir>
 */

type QuestionListParameters = Parameters<
  OpenCodeRuntimeClient["question"]["list"]
>[0];
type QuestionListOptions = Parameters<
  OpenCodeRuntimeClient["question"]["list"]
>[1];
type QuestionReplyParameters = Parameters<
  OpenCodeRuntimeClient["question"]["reply"]
>[0];
type QuestionReplyOptions = Parameters<
  OpenCodeRuntimeClient["question"]["reply"]
>[1];
type QuestionRejectParameters = Parameters<
  OpenCodeRuntimeClient["question"]["reject"]
>[0];
type QuestionRejectOptions = Parameters<
  OpenCodeRuntimeClient["question"]["reject"]
>[1];

/**
 * Applies the directory-scoped question mapping to a client, in place.
 *
 * @param client - The client the assistant-ui OpenCode runtime is built around.
 * @param scope - The session id and authoritative directory. The patch is
 *   skipped without a session id, matching the permission patch.
 */
export function applyQuestionCompat(
  client: OpenCodeRuntimeClient,
  scope: OpenCodeScope,
): void {
  if (!scope.sessionId) return;

  const question = client.question;
  // Capture the SDK's own methods BEFORE overwriting them: the replacements
  // delegate to these, so reading them off the instance afterwards would recurse.
  const list = question.list.bind(question);
  const reply = question.reply.bind(question);
  const reject = question.reject.bind(question);

  const listCompat = (
    parameters?: QuestionListParameters,
    options?: QuestionListOptions,
  ) => list(withDirectory(parameters ?? {}, scope.directory), options);

  const replyCompat = (
    parameters: QuestionReplyParameters,
    options?: QuestionReplyOptions,
  ) =>
    reply(
      withDirectory(
        { requestID: parameters.requestID, answers: parameters.answers },
        scope.directory,
      ),
      options,
    );

  const rejectCompat = (
    parameters: QuestionRejectParameters,
    options?: QuestionRejectOptions,
  ) =>
    reject(
      withDirectory({ requestID: parameters.requestID }, scope.directory),
      options,
    );

  // Same narrow, documented assertion the permission and event patches use: the
  // SDK declares these generic in `ThrowOnError`, the replacements are not.
  question.list = listCompat as unknown as OpenCodeRuntimeClient["question"]["list"];
  question.reply = replyCompat as unknown as OpenCodeRuntimeClient["question"]["reply"];
  question.reject = rejectCompat as unknown as OpenCodeRuntimeClient["question"]["reject"];
}
