import type { OpenCodeRuntimeClient } from "./eventScope";
import type { OpenCodeScope } from "./opencodeScope";
import { hydrateSessionTodos } from "./todoState";
import { autoAcceptPendingPermissions, type PendingPermission } from "./permissionCompat";
import { getAutoPolicy } from "./sessionAutoPolicy";

/**
 * Initial pending-request hydration.
 *
 * Why this exists. `@assistant-ui/react-opencode@0.2.23` only ever learns about
 * a pending permission/question from a live SSE `permission.asked` /
 * `question.asked` event. Its own reconcile runs solely on a **real** reconnect
 * (`handleStreamReconnect`, triggered by `stream.reconnected`). So a request
 * that was already pending when the page mounted — a refresh, a new tab, or a
 * request raised while the client was closed — is never surfaced: the tool sits
 * at `running` with no card. Measured: a live pending `bash` permission was
 * absent from the adapter's state after a fresh page load.
 *
 * What it does. On the **first** SSE `server.connected` of each subscription it
 * lists the authoritative pending sets with the session's directory
 * (`permission.list({directory})`, `question.list({directory})`) and replays
 * each entry as the event the server itself would have emitted
 * (`permission.asked` / `question.asked`). The adapter hydrates through its
 * normal path, so there is exactly one approval lifecycle and one UI.
 *
 * This is deliberately **not** a synthesized reconnect: no lifecycle event is
 * fabricated. The frames carry the server's real, just-read state, and the
 * adapter's own reconnect path is left untouched for real reconnects.
 *
 * Replay is idempotent — the adapter's reducer assigns `pending[id]`, so a
 * request that also arrives over SSE is simply written twice with the same
 * value.
 *
 * Both lists are read with `throwOnError: false` and treated as empty on
 * failure, so hydration can never break the stream it rides on.
 */

/** A raw SSE frame in the envelope the adapter's event source normalizes. */
type RawEvent = { type: string; properties: Record<string, unknown> };

/** True when the raw frame is the stream's connection greeting. */
function isServerConnected(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object") return false;
  const outer = raw as { type?: unknown; payload?: unknown };
  if (outer.type === "server.connected") return true;
  const payload = outer.payload;
  return (
    payload !== null &&
    typeof payload === "object" &&
    (payload as { type?: unknown }).type === "server.connected"
  );
}

/** Reads a list call, returning only a real array body. */
async function safeList(call: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  try {
    const result = (await call()) as { data?: unknown } | undefined;
    return Array.isArray(result?.data) ? (result.data as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

/**
 * The pending permissions + questions for this session's directory, as the
 * events the adapter understands.
 *
 * @param client - The runtime client (its list calls already carry the scope).
 * @returns One `permission.asked` / `question.asked` frame per pending request.
 */
async function readPending(client: OpenCodeRuntimeClient): Promise<RawEvent[]> {
  const [permissions, questions] = await Promise.all([
    safeList(() => client.permission.list({}, { throwOnError: false })),
    safeList(() => client.question.list({}, { throwOnError: false })),
  ]);
  return [
    ...permissions.map((properties) => ({ type: "permission.asked", properties })),
    ...questions.map((properties) => ({ type: "question.asked", properties })),
  ];
}

/** Yields the source stream, then one replay of the pending set and todos per connection. */
async function* hydrateAfterConnect(
  stream: AsyncIterable<unknown>,
  client: OpenCodeRuntimeClient,
  scope: OpenCodeScope,
  answered: Set<string>,
): AsyncGenerator<unknown> {
  let hydrated = false;
  for await (const raw of stream) {
    yield raw;
    if (hydrated || !isServerConnected(raw)) continue;
    hydrated = true;
    // Hydrate authoritative todos asynchronously on connect
    void hydrateSessionTodos(client, scope);
    const events = await readPending(client);
    // Auto shield: answer the pending permissions BEFORE replaying them, so a
    // request that predates the mount is accepted without ever needing a card.
    // The shared `answered` set is what makes a later live `permission.asked`
    // for the same request a no-op rather than a duplicate reply.
    if (getAutoPolicy(scope.sessionId)) {
      await autoAcceptPendingPermissions(client, permissionsOf(events), "auto", answered);
    }
    for (const event of events) yield event;
  }
}

/** The pending permission ids among the replayed events, nothing derived. */
function permissionsOf(events: RawEvent[]): PendingPermission[] {
  const out: PendingPermission[] = [];
  for (const event of events) {
    if (event.type !== "permission.asked") continue;
    const id = event.properties.id;
    if (typeof id === "string") out.push({ id });
  }
  return out;
}

/**
 * Applies initial hydration to a client, in place, by wrapping the event
 * subscription it already uses.
 *
 * Must run **after** the scope patches so the list calls carry the directory.
 * Skipped entirely when the session id or directory is unknown — hydration then
 * has nothing authoritative to read, and the previous behaviour is reproduced
 * rather than guessed.
 *
 * @param client - The client the assistant-ui OpenCode runtime is built around.
 * @param scope - The session id and authoritative directory.
 * @param answered - The shared per-runtime answered set (also used by the live
 *   path), so hydration and live events never answer the same request twice.
 */
export function applyInitialHydration(
  client: OpenCodeRuntimeClient,
  scope: OpenCodeScope,
  answered: Set<string>,
): void {
  if (!scope.sessionId || !scope.directory) return;

  const event = client.event;
  const subscribe = event.subscribe.bind(event);

  const hydratingSubscribe = async (
    parameters?: Parameters<OpenCodeRuntimeClient["event"]["subscribe"]>[0],
    options?: Parameters<OpenCodeRuntimeClient["event"]["subscribe"]>[1],
  ) => {
    const subscription = (await subscribe(parameters, options)) as {
      stream: AsyncIterable<unknown>;
    };
    return {
      ...subscription,
      stream: hydrateAfterConnect(subscription.stream, client, scope, answered),
    };
  };

  event.subscribe = hydratingSubscribe as unknown as OpenCodeRuntimeClient["event"]["subscribe"];
}
