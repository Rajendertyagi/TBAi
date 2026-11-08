/**
 * The official client's error shape, and what TBAi may conclude from it.
 *
 * ## WHY THIS FILE EXISTS
 *
 * The Phase 5 M6 work decides "is this failure definitive?" from an error's
 * `status` property. That is only sound if the error HAS a status - and the
 * official client does not put one there.
 *
 * This is not a guess: it was measured against the installed
 * `@opencode/client@2.0.32`, driving the real client against a local server
 * that returns the upstream's own declared errors. The findings:
 *
 * - A DECLARED error (a status the route declares) is thrown as a **tagged**
 *   error: `Object.assign(new Error(body.message), body)` with `body._tag`
 *   copied onto it. `name` is the tag. There is **no `status` property** -
 *   the HTTP status is gone, and the tag is the only thing that says what
 *   happened.
 * - An UNDECLARED status (one the route does not declare) is thrown as
 *   `ClientError` with `reason: "UnexpectedStatus"` and the status in
 *   `cause.status` - again, not on the error itself.
 * - A transport failure is `ClientError` with `reason: "Transport"`.
 *
 * So `error.status` is **undefined for every error the client throws**. Any
 * code that reads it is reading a property that is never there.
 */

import { describe, expect, it } from "bun:test";
import {
  isConflictError,
  isFormAlreadySettledError,
  isFormNotFoundError,
  isPermissionNotFoundError,
  isSessionNotFoundError,
  isUnauthorizedError,
  OpenCode,
} from "@opencode/client";

/**
 * The upstream errors the official client declares, with the tag each one
 * carries. Read from the installed client's own type contract.
 */
const TAGS = {
  formAlreadySettled: "FormAlreadySettledError",
  formNotFound: "FormNotFoundError",
  permissionNotFound: "PermissionNotFoundError",
  sessionNotFound: "SessionNotFoundError",
  conflict: "ConflictError",
  unauthorized: "UnauthorizedError",
} as const;

/** What the client throws for a declared error: a tagged Error. */
function declaredError(tag: string, message: string): Error {
  return Object.assign(new Error(message), { _tag: tag, name: tag });
}

describe("the official client's error shape", () => {
  it("a declared error carries its tag, and NO status", () => {
    const error = declaredError(TAGS.formAlreadySettled, "already settled");

    // The tag is the only thing that says what happened.
    expect(error.name).toBe(TAGS.formAlreadySettled);
    expect((error as { readonly _tag?: string })._tag).toBe(TAGS.formAlreadySettled);
    // The HTTP status is NOT on the error.
    expect((error as { readonly status?: number }).status).toBeUndefined();
  });

  it("the client ships type guards that recognise each declared error", () => {
    // The guards are the client's own contract, and they are exact.
    expect(isFormAlreadySettledError(declaredError(TAGS.formAlreadySettled, "x"))).toBe(true);
    expect(isFormNotFoundError(declaredError(TAGS.formNotFound, "x"))).toBe(true);
    expect(isPermissionNotFoundError(declaredError(TAGS.permissionNotFound, "x"))).toBe(true);
    expect(isSessionNotFoundError(declaredError(TAGS.sessionNotFound, "x"))).toBe(true);
    expect(isConflictError(declaredError(TAGS.conflict, "x"))).toBe(true);
    expect(isUnauthorizedError(declaredError(TAGS.unauthorized, "x"))).toBe(true);
  });

  it("a guard is false for a different tag, and for an untagged error", () => {
    expect(isFormAlreadySettledError(declaredError(TAGS.formNotFound, "x"))).toBe(false);
    expect(isFormAlreadySettledError(new Error("plain"))).toBe(false);
  });

  it("the client's own `make` produces the same shape against a real server", async () => {
    // The decisive check: drive the REAL client against a local server that
    // returns the upstream's declared error, and read what is thrown.
    const server = Bun.serve({
      port: 0,
      idleTimeout: 30,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/form/x/reply")) {
          return new Response(
            JSON.stringify({ _tag: TAGS.formAlreadySettled, id: "x", message: "already settled" }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    try {
      const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${server.port}` });
      let thrown: unknown = null;
      try {
        await client.session.form.reply({
          sessionID: "ses_audit",
          formID: "x",
          answer: { a: "b" },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      // The tag survives...
      expect(isFormAlreadySettledError(thrown)).toBe(true);
      // ...and the status does not.
      expect((thrown as { readonly status?: number }).status).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});
