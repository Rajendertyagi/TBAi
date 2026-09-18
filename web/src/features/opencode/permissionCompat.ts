import type { OpenCodeRuntimeClient } from "./eventScope";
import { PERMISSION_GONE_MESSAGE, isPermissionGone } from "@/stores/stalePermissionsStore";
import {
  isRouteUnsupported,
  statusOf,
  withDirectory,
  type OpenCodeScope,
} from "./opencodeScope";

/**
 * OpenCode permission compatibility layer.
 *
 * `@assistant-ui/react-opencode@0.2.23` is V1-shaped and calls the permission
 * routes **without a location**:
 *
 *   client.permission.list()                        -> GET  /permission
 *   client.permission.reply({ requestID, reply })   -> POST /permission/{requestID}/reply
 *
 * OpenCode's pending-permission lookup is **directory-scoped** on this build, so
 * the unscoped calls resolve the wrong instance: the list answers `[]` and the
 * reply 404s, which is why a `write`/`edit`/`bash` tool sat at `running`
 * forever. Measured live against the managed 1.18.31 server while a tool's
 * request was genuinely pending:
 *
 *   GET  /permission                            -> []
 *   GET  /permission?directory=<sessionDir>     -> [ <the pending request> ]
 *   POST /permission/<id>/reply?directory=<dir> -> 200 true, tool running -> completed,
 *                                                  `permission.replied` SSE observed
 *
 * The fix is therefore to supply the authoritative session directory — the same
 * omission already fixed for the event stream in `eventScope.ts` — not to
 * re-point the calls at a different API. `permission.list`/`reply` remain the
 * canonical operations; this module only adds the scope.
 *
 * A single, explicitly named compatibility fallback
 * (`POST /session/{id}/permissions/{pid}`) is kept for server builds where the
 * canonical route is genuinely absent. It fires **only** on a route-unsupported
 * signal (`isRouteUnsupported`), never on a 404 or a transient error, so a real
 * "permission gone" or network failure is never masked by a retry.
 *
 * The layer is deletable the day upstream ships a V2-native adapter.
 */

/**
 * The permission reply values the adapter speaks and the server accepts.
 *
 * Verified against `PermissionV2Reply` in the installed `@opencode-ai/sdk@1.18.31`
 * V2 client: `"once" | "always" | "reject"` — identical to the adapter's
 * `OpenCodePermissionResponse` and to the `reply`/`response` bodies the routes
 * accept. The mapping is an explicit identity table, not an assumption that
 * "approve" happens to mean "accept".
 */
export const PERMISSION_REPLY_VALUES = ["once", "always", "reject"] as const;
export type PermissionReplyValue = (typeof PERMISSION_REPLY_VALUES)[number];

const V1_TO_SERVER_REPLY: Readonly<Record<PermissionReplyValue, PermissionReplyValue>> = {
  once: "once",
  always: "always",
  reject: "reject",
};

/**
 * Maps one adapter reply value to the value the server accepts.
 *
 * @param reply - The value the adapter passed through (`"once" | "always" | "reject"`).
 * @returns The value the permission routes accept.
 * @throws When the value is not one the server accepts — a value it cannot
 *   understand must fail loudly rather than become a silent no-op that leaves
 *   the tool running.
 */
export function toPermissionReplyValue(reply: unknown): PermissionReplyValue {
  if (
    typeof reply === "string" &&
    (PERMISSION_REPLY_VALUES as readonly string[]).includes(reply)
  ) {
    return V1_TO_SERVER_REPLY[reply as PermissionReplyValue];
  }
  throw new Error(`Unknown OpenCode permission reply "${String(reply)}"`);
}

/**
 * Normalises a failed permission reply so the **one** stale-permission rule
 * recognises it.
 *
 * A request the server no longer holds answers 404 (with an empty body on this
 * build), so the SDK's own message is a transport description rather than the
 * server's wording. A 404 is re-thrown as the canonical
 * {@link PERMISSION_GONE_MESSAGE} the shared guard matches — no second rule, no
 * retry, no swallowed error. Anything else is returned unchanged, so ordinary
 * transient failures stay retryable.
 *
 * @param error - The value thrown by the SDK.
 * @returns An error the stale-permission guard classifies correctly.
 */
export function normalizePermissionReplyError(error: unknown): unknown {
  if (isPermissionGone(error)) return error;
  if (statusOf(error) === 404) {
    return new Error(PERMISSION_GONE_MESSAGE, { cause: error });
  }
  return error;
}

type PermissionListParameters = Parameters<
  OpenCodeRuntimeClient["permission"]["list"]
>[0];
type PermissionListOptions = Parameters<
  OpenCodeRuntimeClient["permission"]["list"]
>[1];
type PermissionReplyParameters = Parameters<
  OpenCodeRuntimeClient["permission"]["reply"]
>[0];
type PermissionReplyOptions = Parameters<
  OpenCodeRuntimeClient["permission"]["reply"]
>[1];

/**
 * Applies the directory-scoped permission mapping to a client, in place.
 *
 * Patches the cached `client.permission` instance exactly the way
 * `eventScope.ts` patches `client.event` — the SDK caches the namespace
 * (`_permission ??=`), so every later `client.permission.*` call sees the
 * replacement.
 *
 * @param client - The client the assistant-ui OpenCode runtime is built around.
 * @param scope - The session id and authoritative directory. The patch is
 *   skipped entirely without a session id, reproducing the previous behaviour
 *   rather than guessing.
 */
export function applyPermissionCompat(
  client: OpenCodeRuntimeClient,
  scope: OpenCodeScope,
): void {
  const sessionId = scope.sessionId;
  if (!sessionId) return;

  const permission = client.permission;
  // Capture the SDK's own methods BEFORE overwriting them: the replacements
  // delegate to these, so reading them off the instance afterwards would recurse.
  const list = permission.list.bind(permission);
  const reply = permission.reply.bind(permission);
  const respond =
    typeof permission.respond === "function" ? permission.respond.bind(permission) : undefined;

  const listCompat = (
    parameters?: PermissionListParameters,
    options?: PermissionListOptions,
  ) => list(withDirectory(parameters ?? {}, scope.directory), options);

  const canonicalReply = (
    parameters: PermissionReplyParameters,
    options?: PermissionReplyOptions,
  ) =>
    reply(
      {
        ...withDirectory(
          {
            requestID: parameters.requestID,
            reply: toPermissionReplyValue(parameters.reply),
          },
          scope.directory,
        ),
        ...(parameters.message != null ? { message: parameters.message } : {}),
      },
      options,
    );

  // Named compatibility fallback for a build whose canonical route is absent.
  // Never invoked for a 404 or a transient failure — see `isRouteUnsupported`.
  const respondFallback = (
    parameters: PermissionReplyParameters,
    options?: PermissionReplyOptions,
  ) => {
    if (!respond) {
      throw new Error("OpenCode permission respond route is not available");
    }
    return respond(
      {
        sessionID: sessionId,
        permissionID: parameters.requestID,
        response: toPermissionReplyValue(parameters.reply),
      },
      options,
    );
  };

  const replyCompat = async (
    parameters: PermissionReplyParameters,
    options?: PermissionReplyOptions,
  ) => {
    try {
      return await canonicalReply(parameters, options);
    } catch (error) {
      if (!isRouteUnsupported(error) || !respond) {
        throw normalizePermissionReplyError(error);
      }
      try {
        return await respondFallback(parameters, options);
      } catch (fallbackError) {
        throw normalizePermissionReplyError(fallbackError);
      }
    }
  };

  // The SDK declares both methods generic in `ThrowOnError`; the replacements
  // are not generic (their return type does not depend on that parameter), so
  // the assignments are asserted to the SDK's own signatures — the same
  // narrow, documented assertion `eventScope.ts` uses for `event.subscribe`.
  permission.list = listCompat as unknown as OpenCodeRuntimeClient["permission"]["list"];
  permission.reply = replyCompat as unknown as OpenCodeRuntimeClient["permission"]["reply"];
}
