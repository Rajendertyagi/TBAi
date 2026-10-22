/**
 * What the official client's errors mean, and which of them are definitive.
 *
 * ## WHY THIS EXISTS
 *
 * The runtime classified the official client's failures from an error's
 * `status` property - and the official client never puts one there.
 *
 * That is not a guess; it was measured against the installed
 * `@opencode/client@2.0.32` by driving the real client against a local server
 * that returns the upstream's own errors (see
 * `tests/unit/web/opencode/clientErrorShape.test.ts`):
 *
 * - A **declared** error - a status the route declares - is thrown as a TAGGED
 *   error: `Object.assign(new Error(body.message), body)`, with `body._tag`
 *   copied onto it and `name` set to the tag. There is no `status` property.
 * - An **undeclared** status is thrown as `ClientError` with
 *   `reason: "UnexpectedStatus"` and the status in `cause.status`.
 * - A transport failure is `ClientError` with `reason: "Transport"`.
 *
 * So the HTTP status is gone by the time the error reaches the runtime, and
 * every classification that read `error.status` was reading `undefined`. A
 * 404 was "unknown", a 409 was "unknown", and a 4xx was never definitive.
 *
 * ## WHAT THE TAGS MEAN
 *
 * The client ships a type guard per declared error, and they are exact
 * (`value._tag === "..."`). The upstream's own tags, from the pinned server
 * (`packages/core/src/form.ts`, `packages/core/src/permission.ts` at 2.0.22):
 *
 * - `FormAlreadySettledError` - the form was already answered. The request
 *   is over; answering again is not an error the reader can fix.
 * - `FormNotFoundError` - the form is gone.
 * - `PermissionNotFoundError` - the permission request is gone.
 * - `SessionNotFoundError` - the session is gone.
 * - `ConflictError` - the request conflicts with the server's state.
 * - `UnauthorizedError` - the server refused the credentials.
 *
 * ## WHAT IS DEFINITIVE
 *
 * "Definitive" means: the server REFUSED, so the thing did not happen, and the
 * reader may act again. A missing request, an already-settled form, a refused
 * credential and a conflict are all refusals. A transport failure and a
 * timeout are NOT - the server may have taken the request and only the answer
 * was lost.
 */

import {
  isFormAlreadySettledError,
  isFormNotFoundError,
  isInvalidRequestError,
  isPermissionNotFoundError,
  isSessionNotFoundError,
  isUnauthorizedError,
} from "@opencode/client";

/**
 * Reads the client's own error reason, if the error is one.
 *
 * `Transport` is a connection failure - the request may never have reached
 * the server. `UnexpectedStatus` is a status the route does not declare.
 *
 * @param error - The thrown error.
 * @returns The reason, or `null` when the error is not a client error.
 */
export function clientErrorReason(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const reason = (error as { readonly reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

/**
 * The HTTP status behind an error, if there is one.
 *
 * The client puts it in `cause.status` for an undeclared status, and nowhere
 * for a declared one. This reads both places so a caller never has to know
 * which shape it is looking at.
 *
 * @param error - The thrown error.
 * @returns The status, or `null` when the error carries none.
 */
export function errorStatus(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  const direct = (error as { readonly status?: unknown }).status;
  if (typeof direct === "number") return direct;
  const cause = (error as { readonly cause?: unknown }).cause;
  if (cause !== null && typeof cause === "object") {
    const nested = (cause as { readonly status?: unknown }).status;
    if (typeof nested === "number") return nested;
  }
  return null;
}

/**
 * Whether the server REFUSED the request, so the thing did not happen.
 *
 * This is the question the prompt path asks: a refusal may be reported to the
 * reader, while a network failure may not - the prompt may still be running
 * on the server.
 *
 * The refusals, from the upstream's own protocol errors
 * (`packages/protocol/src/errors.ts` at 2.0.22), with the status each one
 * carries:
 *
 * | error | status | a refusal? |
 * |---|---|---|
 * | `PermissionNotFoundError` | 404 | yes - the request is gone |
 * | `FormNotFoundError` | 404 | yes |
 * | `FormAlreadySettledError` | 409 | yes - it was already answered |
 * | `SessionNotFoundError` | 404 | yes |
 * | `UnauthorizedError` | 401 | yes |
 * | `InvalidRequestError` | 400 | yes |
 * | `ConflictError` | 409 | **no** - the server says "not now" |
 * | `SessionBusyError` | 409 | **no** - the server says "not now" |
 * | `ServiceUnavailableError` | 503 | no - the server is unwell |
 *
 * The 409s are deliberately NOT refusals: the server is asking for the
 * request again, and a prompt that conflicts or finds the session busy is a
 * prompt that may still be worth sending.
 *
 * @param error - The thrown error.
 * @returns True when the server refused.
 */
export function isDefinitiveFailure(error: unknown): boolean {
  if (isPermissionNotFoundError(error)) return true;
  if (isFormNotFoundError(error)) return true;
  if (isFormAlreadySettledError(error)) return true;
  if (isSessionNotFoundError(error)) return true;
  if (isUnauthorizedError(error)) return true;
  if (isInvalidRequestError(error)) return true;
  // An undeclared status is the server's own answer, and a 4xx it chose is a
  // refusal. The status lives in `cause.status`; the client's own `status`
  // property never exists.
  const status = errorStatus(error);
  if (status === null) return false;
  if (status < 400 || status >= 500) return false;
  return !RETRYABLE_STATUSES.has(status);
}

/**
 * Whether the request was already settled, so answering it again is a no-op
 * rather than a failure.
 *
 * The server answers a second answer to a settled form with
 * `FormAlreadySettledError`, and a second answer to a settled permission
 * with `PermissionNotFoundError` - the request is gone once it is answered.
 *
 * @param error - The thrown error.
 * @returns True when the request was already answered.
 */
export function isAlreadySettled(error: unknown): boolean {
  return isFormAlreadySettledError(error) || isPermissionNotFoundError(error);
}

/**
 * The statuses the server may answer with that are worth retrying.
 *
 * A 408, a 409, a 425 and a 429 are the server saying "not now": the request
 * may be tried again. A 409 in particular is what the server answers with for
 * `ConflictError` and `SessionBusyError` - both of which are "not now", not
 * refusals.
 */
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429]);
