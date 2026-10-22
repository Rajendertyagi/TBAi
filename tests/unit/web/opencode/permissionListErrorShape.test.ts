/**
 * What the client does with a 404 from `GET /api/permission/request`.
 *
 * The 2.1 client DECLARES a 404 for this route; the 2.0 client does not. A
 * declared status makes the client throw a TAGGED error; an undeclared one
 * makes it throw `ClientError("UnexpectedStatus")` with the status in
 * `cause.status`.
 *
 * This matters because the runtime's classification reads the TAG. Against a
 * 2.1 client the failure arrives tagged; against a 2.0 client it does not.
 * The classification has to handle BOTH, because the supported range still
 * admits a 2.0.x server.
 */

import { describe, expect, it } from "bun:test";
import { isFormAlreadySettledError, isPermissionNotFoundError, OpenCode } from "@opencode/client";
import { errorStatus, isDefinitiveFailure } from "@web/features/opencode/clientErrors.ts";

/** A server that answers the permission list with a bare 404. */
function serverAnswering(status: number, body: string, contentType: string) {
  return Bun.serve({
    port: 0,
    idleTimeout: 30,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.includes("/event")) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": ping\n\n"));
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.pathname.includes("/permission")) {
        return new Response(body, { status, headers: { "content-type": contentType } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
}

describe("a 404 from the permission list", () => {
  it("arrives as a tagged error, so the runtime can classify it", async () => {
    // The 2.1 client declares this status, so the body is parsed and the tag
    // is copied onto the error.
    const server = serverAnswering(
      404,
      JSON.stringify({ _tag: "PermissionNotFoundError", requestID: "per_1", message: "gone" }),
      "application/json",
    );
    try {
      const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${server.port}` });
      let thrown: unknown = null;
      try {
        await client.permission.request.list();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      // Either the upstream's own tag, or the client's own "this location does
      // not exist" answer. What matters is that the runtime can recognise it.
      const recognised =
        isPermissionNotFoundError(thrown) ||
        (thrown as { readonly name?: string }).name === "PermissionNotFoundError";
      expect(recognised).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("an UNPARSEABLE 404 loses its status entirely - the client cannot parse it", async () => {
    // This is the client's own behaviour, and the repository already knew it:
    // `codeViewSessionBoundary.test.ts` reproduces it exactly ("the real client
    // cannot parse it - it throws `UnsupportedContentType` and drops the
    // status").
    //
    // The client checks the DECLARED statuses first, so for a declared 404 it
    // goes to `declared(await json(response))` - and `json()` throws
    // `UnsupportedContentType` before the body can be read. What arrives is a
    // `ClientError` with a REASON and no status anywhere.
    //
    // So the runtime must NOT treat this as "not found": it cannot prove the
    // server refused anything. It is a network failure, which is the honest
    // reading and the conservative one.
    const server = serverAnswering(404, "", "text/plain");
    try {
      const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${server.port}` });
      let thrown: unknown = null;
      try {
        await client.permission.request.list();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const record = thrown as {
        readonly reason?: string;
        readonly cause?: { readonly status?: unknown };
      };
      // The status is genuinely unreachable - not on the error, not in the cause.
      expect(record.cause?.status).toBeUndefined();
      expect(errorStatus(thrown)).toBeNull();
      // And it is NOT a refusal: nothing says the server refused.
      expect(isDefinitiveFailure(thrown)).toBe(false);
      // The reason is the client's own, and it is a content-type failure.
      expect(record.reason).toBe("UnsupportedContentType");
    } finally {
      server.stop(true);
    }
  });

  it("an UNDECLARED status keeps its status in cause.status", async () => {
    // The other shape: a status the route does not declare. The client throws
    // `ClientError("UnexpectedStatus")` with the status in `cause.status` -
    // which is where `errorStatus` reads it from.
    const server = serverAnswering(418, "teapot", "text/plain");
    try {
      const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${server.port}` });
      let thrown: unknown = null;
      try {
        await client.permission.request.list();
      } catch (error) {
        thrown = error;
      }

      expect(errorStatus(thrown)).toBe(418);
    } finally {
      server.stop(true);
    }
  });

  it("the 2.1 client declares the 404, so it is never an undeclared status", async () => {
    // The distinction that matters: a DECLARED status is thrown as a tagged
    // error, and an undeclared one as `ClientError("UnexpectedStatus")`. The
    // 2.1 client declares this route's 404, so the tagged shape is what
    // arrives - which is why the runtime's classification reads tags.
    const server = serverAnswering(
      404,
      JSON.stringify({ _tag: "PermissionNotFoundError", requestID: "per_1", message: "gone" }),
      "application/json",
    );
    try {
      const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${server.port}` });
      let thrown: unknown = null;
      try {
        await client.permission.request.list();
      } catch (error) {
        thrown = error;
      }
      const record = thrown as { readonly reason?: string };
      // Not the "unexpected status" shape: the status was DECLARED, so the
      // body was parsed and the tag carried through.
      expect(record.reason).not.toBe("UnexpectedStatus");
    } finally {
      server.stop(true);
    }
  });

  it("the form guard is the same shape, for the same reason", () => {
    // A form the server has already settled arrives tagged, and the guard
    // recognises it by tag.
    expect(isFormAlreadySettledError({ _tag: "FormAlreadySettledError" })).toBe(true);
  });
});
