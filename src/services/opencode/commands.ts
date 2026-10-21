/**
 * OpenCode's command feed — the slash commands and skills the managed server
 * exposes, for the composer's `/` palette.
 *
 * ## Why the BACKEND reads it
 *
 * The browser used to fetch the feed through the `/api/opencode/*` **proxy**.
 * That put a **location-scoped catalogue route** on the proxy's reach, and the
 * proxy's allowlist deliberately carries only the routes the browser's
 * *session* client calls. The catalogue is read here, by the backend, and
 * served from TBAi's own route, so the proxy's forwarded surface stays exactly
 * that set.
 *
 * ## What is returned
 *
 * The server's own payload, **verbatim**. This is a transport, not a
 * projection: the browser parses the feed with the same parser it always used,
 * so nothing about the shape changes here. A malformed payload is still
 * handled by that parser, which yields an empty list rather than throwing.
 */

import { createOpenCodeClient } from "./client";
import { toOpenCodeError } from "./errors";
import { openCodeServerManager } from "./serverManager";

/** The raw command feed the managed server reports. */
export type OpenCodeCommandFeed = Awaited<
  ReturnType<ReturnType<typeof createOpenCodeClient>["command"]["list"]>
>;

/**
 * Reads the command feed from the managed server.
 *
 * No directory is passed, for the same reason the model and agent catalogues
 * are read without one: the command feed is the install's own set, and it has
 * to be available before any session exists.
 *
 * @returns The server's payload, unmodified.
 * @throws {OpenCodeError} When the server is unreachable or answers badly.
 */
export async function getOpenCodeCommandFeed(): Promise<OpenCodeCommandFeed> {
  const baseUrl = await openCodeServerManager.ensureBaseUrl();
  const client = createOpenCodeClient(baseUrl);
  try {
    return await client.command.list();
  } catch (err) {
    throw toOpenCodeError(err);
  }
}
