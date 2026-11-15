/**
 * Resolves the service a history operation may use, and refuses when the
 * conversation's history lives on a different scope (local vs remote).
 *
 * TBAi owns exactly one managed OpenCode runtime. Conversations whose history is
 * owned by an external/remote OpenCode service remain externally owned and must
 * fail closed: TBAi never probes, adopts, or rebinds them to the managed runtime.
 */
import type { Conversation } from "../../types";
import {
  captureOpenCodeRequestContext,
  createManagedFallbackTransport,
  OpenCodeNotReadyError,
  readConnectionState,
  readShutdownState,
  type OpenCodeTransport,
} from "./connectionState";
import {
  LOCAL_OWNER,
  OpenCodeHistoryBoundaryError,
  readConversationHistoryOwner,
  type OpenCodeHistoryOwner,
} from "./historyBoundary";
import { openCodeServerManager } from "./serverManager";

/** The service one history operation is allowed to use. Immutable. */
export type OpenCodeServiceAccess = Readonly<{
  readonly owner: OpenCodeHistoryOwner;
  /** Canonical, slash-free origin of the installed target. */
  readonly baseUrl: string;
  /** The bounded transport captured with the target. */
  readonly transport: OpenCodeTransport;
}>;

const EXTERNAL_UNAVAILABLE_MESSAGE =
  "The original external OpenCode service for this conversation is unavailable. TBAi now supports its managed OpenCode runtime only.";

function captureInstalledAccess(owner: OpenCodeHistoryOwner): OpenCodeServiceAccess {
  const context = captureOpenCodeRequestContext();
  return Object.freeze({
    owner,
    baseUrl: context.baseUrl,
    transport: context.transport,
  });
}

/**
 * Resolves the managed service for a conversation's history operation.
 *
 * @throws {OpenCodeHistoryBoundaryError} when the conversation is bound to an
 *   external/remote service that TBAi no longer connects to.
 * @throws {OpenCodeNotReadyError} after shutdown.
 */
export async function resolveOpenCodeServiceAccess(
  conversation: Pick<Conversation, "id" | "opencodeSessionId" | "opencodeServiceOwner">,
): Promise<OpenCodeServiceAccess> {
  if (readShutdownState().shutdownStarted) throw new OpenCodeNotReadyError();

  const recorded = readConversationHistoryOwner(conversation);
  if (recorded?.kind === "remote") {
    throw new OpenCodeHistoryBoundaryError(
      "external_unavailable",
      conversation.id,
      EXTERNAL_UNAVAILABLE_MESSAGE,
    );
  }

  const installedTarget = readConnectionState().target;
  if (installedTarget.mode === "managed") {
    return captureInstalledAccess(LOCAL_OWNER);
  }

  const baseUrl = await openCodeServerManager.ensureBaseUrl();
  const publishedTarget = readConnectionState().target;
  if (publishedTarget.mode === "managed") {
    return captureInstalledAccess(LOCAL_OWNER);
  }

  return Object.freeze({
    owner: LOCAL_OWNER,
    baseUrl,
    transport: createManagedFallbackTransport(baseUrl),
  });
}
