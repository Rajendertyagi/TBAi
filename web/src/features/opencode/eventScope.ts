import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

/** The OpenCode client type the assistant-ui runtime is built around. */
export type OpenCodeRuntimeClient = ReturnType<typeof createOpencodeClient>;

/** The SDK's event-subscription parameter/option shapes (its non-generic halves). */
type SubscribeParameters = Parameters<
  OpenCodeRuntimeClient["event"]["subscribe"]
>[0];
type SubscribeOptions = Parameters<
  OpenCodeRuntimeClient["event"]["subscribe"]
>[1];

/**
 * Builds the OpenCode client the assistant-ui runtime talks through, with the
 * session's **directory scope** attached to its event subscription.
 *
 * Why this exists. OpenCode keys its event stream on a directory. Measured
 * against the managed server, in the same time window:
 *
 *   GET /event                  -> a stub: `server.connected` + `server.heartbeat`
 *   GET /event?directory=<dir>  -> the real stream: `session.updated`,
 *                                  `message.updated`, `message.part.updated`,
 *                                  `text`, `session.diff`, `session.status`, …
 *
 * The runtime's event source subscribes unscoped
 * (`client.event.subscribe(undefined, …)`), so it receives nothing but
 * heartbeats. Nothing downstream then learns a reply is streaming: the
 * assistant bubble sits on a running timer, and the finished reply only becomes
 * visible after a history reload — the "refresh to see the answer" bug. Because
 * that stub stream never drops, the runtime's own reconnect-and-reload path
 * never fires either, so it cannot self-heal.
 *
 * Supplying the scope is not a workaround: `directory` is a documented
 * parameter of that route in the OpenCode V2 SDK, and passing it is the
 * supported way to address a single session's stream.
 *
 * The subscription itself is untouched — same single subscription, same
 * lifecycle, same reconnect behaviour; only its scope is supplied. Every other
 * request the client makes is left byte-identical, because scoping the whole
 * client would also rewrite history/permission requests, and that blast radius
 * is not needed to fix the event stream.
 *
 * @param baseUrl - TBAi's same-origin OpenCode proxy base (`/api/opencode`).
 * @param directory - The session's directory as the server records it, or
 *   `null` when unknown — in which case the client is returned unscoped, which
 *   reproduces the previous behaviour rather than guessing a path.
 */
export function createScopedOpenCodeClient(
  baseUrl: string,
  directory: string | null,
): OpenCodeRuntimeClient {
  const client = createOpencodeClient({ baseUrl });
  if (!directory) return client;

  // `client.event` is a cached instance (`_event ??= new Event(…)`), so
  // patching it here is what every later `client.event.subscribe(…)` sees.
  const event = client.event;
  const subscribe = event.subscribe.bind(event);
  const scopedSubscribe = (
    parameters?: SubscribeParameters,
    options?: SubscribeOptions,
  ) => subscribe({ ...(parameters ?? {}), directory }, options);
  // The SDK declares `subscribe` as generic in `ThrowOnError`; the replacement
  // is not generic (its return type does not depend on that parameter), so the
  // assignment is asserted to the SDK's own signature.
  event.subscribe = scopedSubscribe as OpenCodeRuntimeClient["event"]["subscribe"];

  return client;
}
