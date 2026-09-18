import {
  ClientError,
  isForbiddenError,
  isInvalidRequestError,
  isServiceUnavailableError,
  isSessionNotFoundError,
  isUnauthorizedError,
} from "@opencode/client";

/**
 * Why an OpenCode backend call failed, in TBAi's own vocabulary. Deliberately
 * the small set of distinctions TBAi actually acts on — retry policy,
 * user-facing copy, stale-pointer recovery — rather than a mirror of the
 * client's full error surface.
 */
export type OpenCodeFailureKind =
  | "session_not_found"
  | "connection"
  | "auth"
  | "http"
  | "malformed"
  | "unknown";

/**
 * A normalized OpenCode backend failure. Carries a stable `code` plus an HTTP
 * `statusCode` when one applies, so the shared logging funnel
 * (`classifyError` / `normalizeError`) reads the same fields it does for every
 * other error in the app — no OpenCode-specific logging path is needed.
 */
export class OpenCodeError extends Error {
  readonly code = "OPENCODE_ERROR";

  constructor(
    readonly kind: OpenCodeFailureKind,
    message: string,
    readonly statusCode?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OpenCodeError";
  }
}

/** Reads a string property from an unknown object without an unchecked cast. */
function readString(source: object, key: string): string | undefined {
  const value: unknown = Reflect.get(source, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads the human message off any object-shaped error body. */
function messageOf(value: unknown): string | undefined {
  return value !== null && typeof value === "object"
    ? readString(value, "message")
    : undefined;
}

/** Best-effort human detail from a declared-status error body (a plain object). */
function bodyDetail(value: unknown): string {
  return messageOf(value) ?? "no detail";
}

/**
 * Reads OpenCode's **V1** error envelope — `{ name, data: { message } }` — if
 * the thrown value is one. Requires both a `name` and a `data.message`, which
 * keeps it from matching `ClientError` (which has a `name` but no `data`).
 *
 * This shape reaches TBAi through exactly one path: the documented OpenCode
 * 1.18.29 delete fallback in `./client`, whose V1 route answers errors in the
 * older envelope instead of the V2 tagged shape.
 */
function readV1Envelope(value: unknown): { name: string; message: string } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const name = readString(value, "name");
  if (!name) return undefined;
  const data: unknown = Reflect.get(value, "data");
  const message = messageOf(data);
  return message ? { name, message } : undefined;
}

/** HTTP status the V1 error envelope implies for each error name. */
const V1_ENVELOPE_STATUS: Record<string, number> = {
  NotFoundError: 404,
  UnauthorizedError: 401,
  ForbiddenError: 403,
  BadRequestError: 400,
  ServiceUnavailableError: 503,
};

/** Extracts the HTTP status the client stashed on `ClientError.cause`. */
function statusFromCause(cause: unknown): number | undefined {
  if (cause === null || typeof cause !== "object") return undefined;
  const status: unknown = Reflect.get(cause, "status");
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

/** Describes the underlying transport error (e.g. a refused socket). */
function transportDetail(err: Error): string {
  const cause: unknown = err.cause;
  if (!(cause instanceof Error)) return "no transport detail";
  const code = readString(cause, "code");
  return code ? `${cause.message} (${code})` : cause.message;
}

/**
 * Translates anything the official OpenCode V2 client can throw into a single
 * `OpenCodeError`, preserving the five distinctions TBAi relies on: a missing
 * session, an unreachable server, an auth rejection, an HTTP failure, and a
 * malformed response. Idempotent — an existing `OpenCodeError` passes through.
 *
 * The client throws three shapes and all are handled here:
 *  - `ClientError` — transport faults, undeclared HTTP statuses, and non-JSON
 *    or unparseable bodies. Its `reason` field discriminates them.
 *  - **Tagged error bodies** (`{ _tag: "SessionNotFoundError", ... }`) — a
 *    plain object, **not** an `Error`, thrown for HTTP statuses the endpoint
 *    declares in its contract. The package's own type guards are the supported
 *    way to detect these.
 *  - **The V1 error envelope** (`{ name: "NotFoundError", data: { message } }`)
 *    — see `readV1Envelope`.
 *
 * Anything unrecognised still yields a readable message rather than a bare
 * `[object Object]`.
 */
export function toOpenCodeError(err: unknown): OpenCodeError {
  if (err instanceof OpenCodeError) return err;

  if (isSessionNotFoundError(err)) {
    return new OpenCodeError(
      "session_not_found",
      `OpenCode session not found: ${err.sessionID}`,
      404,
      { cause: err },
    );
  }
  if (isUnauthorizedError(err) || isForbiddenError(err)) {
    return new OpenCodeError(
      "auth",
      `OpenCode authentication failed: ${bodyDetail(err)}`,
      401,
      { cause: err },
    );
  }
  if (isInvalidRequestError(err)) {
    return new OpenCodeError(
      "http",
      `OpenCode rejected the request (HTTP 400): ${bodyDetail(err)}`,
      400,
      { cause: err },
    );
  }
  if (isServiceUnavailableError(err)) {
    return new OpenCodeError(
      "http",
      `OpenCode is temporarily unavailable (HTTP 503): ${bodyDetail(err)}`,
      503,
      { cause: err },
    );
  }

  if (err instanceof ClientError) {
    switch (err.reason) {
      case "Transport":
        return new OpenCodeError(
          "connection",
          `OpenCode server is unreachable (network transport failure): ${transportDetail(err)}`,
          undefined,
          { cause: err },
        );
      case "UnexpectedStatus": {
        const status = statusFromCause(err.cause);
        return new OpenCodeError(
          "http",
          `OpenCode request failed with HTTP ${status ?? "unknown"}`,
          status,
          { cause: err },
        );
      }
      default:
        return new OpenCodeError(
          "malformed",
          `OpenCode returned a malformed or unexpected response (${err.reason})`,
          undefined,
          { cause: err },
        );
    }
  }

  const envelope = readV1Envelope(err);
  if (envelope) {
    const status = V1_ENVELOPE_STATUS[envelope.name];
    // A session-scoped 404 must keep its own kind so callers can tell
    // "already gone" apart from a generic request failure.
    if (status === 404 && /session/i.test(envelope.message)) {
      return new OpenCodeError(
        "session_not_found",
        `OpenCode session not found: ${envelope.message}`,
        404,
        { cause: err },
      );
    }
    return new OpenCodeError(
      "http",
      `OpenCode request failed (${envelope.name}): ${envelope.message}`,
      status,
      { cause: err },
    );
  }

  return new OpenCodeError(
    "unknown",
    `OpenCode request failed: ${
      err instanceof Error ? err.message : (messageOf(err) ?? String(err))
    }`,
    undefined,
    { cause: err },
  );
}
