import { createScopedOpenCodeClient, type OpenCodeRuntimeClient } from "./eventScope";
import { applyPermissionCompat } from "./permissionCompat";
import { applyQuestionCompat } from "./questionCompat";
import { applyInitialHydration } from "./initialHydration";
import { applyPermissionPayloadCompat } from "./permissionPayloadCompat";
import { applyTodoCompat } from "./todoState";

/**
 * The single construction point for the OpenCode client the assistant-ui
 * runtime talks through.
 *
 * It composes the compatibility patches the frozen V1-shaped adapter needs
 * against this OpenCode build, in one place, so the runtime is never handed a
 * client that has only some of them:
 *
 * - **event scope** (`eventScope.ts`) — supplies the session's directory to the
 *   event subscription, so streamed events arrive instead of the unscoped stub.
 * - **permission + question scope** (`permissionCompat.ts`, `questionCompat.ts`)
 *   — supply the same directory to the permission/question list and reply calls,
 *   whose stores are directory-scoped, so a pending request can actually be
 *   listed and answered.
 * - **initial hydration** (`initialHydration.ts`) — replays the authoritative
 *   pending set once per connection, so a request that predates the page mount
 *   (a refresh or a new tab) still surfaces instead of leaving the tool stuck.
 * - **V2 payload normalization** (`permissionPayloadCompat.ts`) — rewrites the
 *   V2 interaction events this build also emits onto the V1 names and field
 *   names the adapter's switch actually handles, which otherwise drop the
 *   request silently.
 * - **todo projection compat** (`todoState.ts`) — intercepts SSE stream to capture
 *   `todo.updated` events and keep an in-memory projection of the active todos.
 *
 * The first four are the same idea — the adapter omits the session's location,
 * and it only ever learns of a pending request from a live event — so they share
 * one scope value. The fifth is a pure shape mapping and needs no scope. Every patch is applied in place to a freshly created client, so
 * nothing is shared between runtimes. Deleting this file and using `baseUrl`
 * directly is all that is needed once upstream ships a V2-native adapter.
 *
 * @param baseUrl - TBAi's same-origin OpenCode proxy base (`/api/opencode`).
 * @param options.directory - The session's directory as the server records it,
 *   or `null` when unknown (every patch then leaves its call unscoped rather
 *   than guessing a path).
 * @param options.sessionId - The OpenCode session that owns this runtime's
 *   permissions and questions. Undefined only while the session is still being
 *   minted; the patches are skipped in that case rather than guessed.
 */
export function createOpenCodeRuntimeClient(
  baseUrl: string,
  options: { directory: string | null; sessionId: string | undefined },
): OpenCodeRuntimeClient {
  const client = createScopedOpenCodeClient(baseUrl, options.directory);
  const scope = { sessionId: options.sessionId, directory: options.directory };
  applyPermissionCompat(client, scope);
  applyQuestionCompat(client, scope);
  // Hydration reads through the scoped list calls patched above.
  applyInitialHydration(client, scope);
  // Captures todo.updated frames from the stream
  applyTodoCompat(client, scope);
  // LAST, so it is the outermost wrapper: hydration synthesizes its replayed
  // frames inside its own wrapper, so a normalizer applied earlier would never
  // see them. Outermost, it normalizes live SSE frames and replayed ones alike.
  applyPermissionPayloadCompat(client);
  return client;
}
