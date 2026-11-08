/**
 * The runtime's reading of the official client's errors.
 *
 * ## THE DEFECT THIS PINS
 *
 * The runtime classified the client's failures from `error.status`, and the
 * client never puts a status there: a declared error is thrown as a TAGGED
 * error, with the HTTP status dropped. The measurement is in
 * `clientErrorShape.test.ts`.
 *
 * The user-visible consequences were:
 *
 * - a permission that the server had GONE (404) was not retired, so its card
 *   stayed on screen with no way to answer it;
 * - a form the server had ALREADY SETTLED (409) surfaced as an error, so the
 *   reader saw a failure for a form they had already answered;
 * - a prompt the server REFUSED (a 4xx) was never reported as a refusal, so
 *   the reader was told the prompt might still be running when the server had
 *   rejected it.
 */

import { describe, expect, it } from "bun:test";
import {
  errorStatus,
  isAlreadySettled,
  isDefinitiveFailure,
} from "@web/features/opencode/clientErrors.ts";

/** The shape the official client throws for a declared error. */
function tagged(tag: string, message = "x"): Error {
  return Object.assign(new Error(message), { _tag: tag, name: tag });
}

describe("the runtime's reading of the client's errors", () => {
  it("a declared error carries no status, and the runtime still reads one", () => {
    // The premise, restated so a change to the client's shape is visible here
    // too: the status is not on the error.
    const error = tagged("FormAlreadySettledError");
    expect(errorStatus(error)).toBeNull();
  });

  it("a refusal the server named is definitive", () => {
    // These are the refusals the client declares for the routes TBAi uses.
    // Before the fix, every one of them read `status === undefined` and was
    // therefore NOT definitive.
    expect(isDefinitiveFailure(tagged("FormNotFoundError"))).toBe(true);
    expect(isDefinitiveFailure(tagged("PermissionNotFoundError"))).toBe(true);
    expect(isDefinitiveFailure(tagged("SessionNotFoundError"))).toBe(true);
    expect(isDefinitiveFailure(tagged("UnauthorizedError"))).toBe(true);
    expect(isDefinitiveFailure(tagged("InvalidRequestError"))).toBe(true);
    expect(isDefinitiveFailure(tagged("FormAlreadySettledError"))).toBe(true);
  });

  it("a 409 is the server saying 'not now', not a refusal", () => {
    // `ConflictError` and `SessionBusyError` are both 409 upstream, and both
    // mean the request may be tried again. A prompt that conflicts is a prompt
    // that may still be worth sending.
    expect(isDefinitiveFailure(tagged("ConflictError"))).toBe(false);
    expect(isDefinitiveFailure(tagged("SessionBusyError"))).toBe(false);
  });

  it("a transport failure is NOT definitive, because the server may have taken the request", () => {
    const transport = Object.assign(new Error("Transport: ECONNRESET"), {
      reason: "Transport",
      name: "ClientError",
    });
    expect(isDefinitiveFailure(transport)).toBe(false);
    // A plain network error, too.
    expect(isDefinitiveFailure(new TypeError("fetch failed"))).toBe(false);
  });

  it("a server-side failure is not definitive", () => {
    const server = Object.assign(new Error("UnexpectedStatus: 503"), {
      reason: "UnexpectedStatus",
      cause: { status: 503 },
    });
    expect(isDefinitiveFailure(server)).toBe(false);
  });

  it("a 4xx the client did not declare is definitive, and a retryable one is not", () => {
    const undeclared = (status: number) =>
      Object.assign(new Error(`UnexpectedStatus: ${status}`), {
        reason: "UnexpectedStatus",
        cause: { status },
      });
    expect(isDefinitiveFailure(undeclared(400))).toBe(true);
    expect(isDefinitiveFailure(undeclared(422))).toBe(true);
    // The server saying "not now" is not a refusal.
    expect(isDefinitiveFailure(undeclared(408))).toBe(false);
    expect(isDefinitiveFailure(undeclared(429))).toBe(false);
  });

  it("a request the server has settled is recognised as settled", () => {
    // The form: the server answers a second answer with
    // `FormAlreadySettledError`.
    expect(isAlreadySettled(tagged("FormAlreadySettledError"))).toBe(true);
    // The permission: once answered, the request is GONE, and the server
    // answers with `PermissionNotFoundError`.
    expect(isAlreadySettled(tagged("PermissionNotFoundError"))).toBe(true);
    // A form that was never there is not "settled", it is missing.
    expect(isAlreadySettled(tagged("FormNotFoundError"))).toBe(false);
  });

  it("the status is read from wherever the client put it", () => {
    expect(errorStatus({ status: 409 })).toBe(409);
    expect(errorStatus({ cause: { status: 503 } })).toBe(503);
    expect(errorStatus(new Error("plain"))).toBeNull();
  });
});
