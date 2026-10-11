/**
 * Shared REST boundary for the browser.
 *
 * `web/src/lib/platform.ts#apiFetch` resolves a path against the verified
 * backend origin (desktop vs. browser). This module is the layer above it: one
 * place that parses the body, decides what a failure means, and correlates the
 * server's `requestId`.
 *
 * Every store used to carry its own copy of this helper. The copies had already
 * drifted (two attached `requestId`, one did not; one logged the failure, two
 * did not), which is exactly how a correlation id silently stops being
 * correlatable. New call sites import from here instead of re-deriving it.
 */

import { logger } from "./logger";
import { apiFetch } from "./platform";

/** Fallback for a non-JSON body — never echo raw bytes into user-visible copy. */
const JSON_ERROR_MESSAGE = "Request failed";

/**
 * Error for a non-2xx response.
 *
 * Carries the status and the server's `requestId` so a UI surface can render
 * "Error reference req_…" and the operator can find the matching backend log
 * line — see `components/LogsPanel.tsx`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly requestId: string | undefined;

  constructor(message: string, status: number, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.requestId = requestId;
  }
}

/** One shape for a mutation result, so callers can all branch on `ok`. */
export interface ApiResult<T> {
  ok: boolean;
  data: T;
  error?: string;
}

/**
 * Parse a response body as JSON, tolerating an empty or non-JSON body.
 *
 * A proxy error page or an aborted stream becomes an empty object rather than
 * its raw text: this message is rendered to the user, and a fragment of an HTML
 * error page is neither accurate nor safe to show. The caller's fallback names
 * the failed operation instead.
 */
async function readPayload(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return {};
  }
}

/** Read the server's correlation id off a parsed error body. */
function readRequestId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const id = (payload as { requestId?: unknown }).requestId;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * Human-readable error for a parsed payload, or `fallback` when it carries none.
 *
 * The server's own message wins because it is the specific one (Zod field
 * errors, "folder already registered"); the fallback names the operation.
 */
export function errorFromPayload(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) return fallback;
  const message = (payload as { error?: unknown }).error;
  return typeof message === "string" && message ? message : fallback;
}

/** Flatten a thrown value into a message, defaulting to `fallback`. */
export function errorText(value: unknown, fallback: string): string {
  return value instanceof Error && value.message ? value.message : fallback;
}

/**
 * Perform a JSON request and return the parsed body.
 *
 * Throws `ApiError` for any non-2xx response, after logging a correlated `warn`
 * when `scope` is supplied. Pass `scope` for stores whose failures the operator
 * must be able to find in the backend log.
 */
export async function apiJson<T>(path: string, init?: RequestInit, scope?: string): Promise<T> {
  const response = await apiFetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    const requestId = readRequestId(payload);
    if (scope) {
      logger.warn(scope, "api_failed", {
        message: `${init?.method ?? "GET"} ${path} → ${response.status}`,
        requestId,
      });
    }
    throw new ApiError(
      errorFromPayload(payload, `${JSON_ERROR_MESSAGE} (${response.status})`),
      response.status,
      requestId,
    );
  }
  return payload as T;
}

/**
 * Same request, reported as a result instead of a throw.
 *
 * For the scheduler, whose UI branches on `{ ok, error }` per action so one
 * failed toggle never unmounts the list. The failed payload is still returned
 * as `data`, because a 4xx there can carry a usable entity.
 */
export async function apiResult<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const response = await apiFetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    return {
      ok: false,
      data: payload as T,
      error: errorFromPayload(payload, `HTTP ${response.status}`),
    };
  }
  return { ok: true, data: payload as T };
}
