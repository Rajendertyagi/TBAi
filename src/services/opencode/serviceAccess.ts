/**
 * Resolves the service a history operation may use, and refuses when the
 * conversation's history lives on a different scope (local vs remote).
 *
 * This is the single place that answers "which service owns this conversation's
 * OpenCode session, and may it be touched?". Callers receive one access value;
 * they never branch on managed-versus-adopted themselves.
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
  assertSameHistoryOwner,
  describeHistoryOwner,
  historyOwnerFromTarget,
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
  /**
   * The bounded transport captured with the target. It carries the credential
   * for exactly this origin, so a caller cannot pair one service's credential
   * with another service's address.
   */
  readonly transport: OpenCodeTransport;
}>;

/** Captures one access value from an installed target. */
function captureInstalledAccess(owner: OpenCodeHistoryOwner): OpenCodeServiceAccess {
  const context = captureOpenCodeRequestContext();
  return Object.freeze({
    owner,
    baseUrl: context.baseUrl,
    transport: context.transport,
  });
}

/**
 * Resolves the service a conversation's history may be read or written
 * through, or refuses.
 *
 * Ordering is the contract: the installed target is consulted first.
 * A remote-bound conversation is refused before any local managed startup work runs.
 *
 * @throws {OpenCodeHistoryBoundaryError} when the binding names another service scope,
 *   or when it names a remote service that is not installed.
 * @throws {OpenCodeNotReadyError} after shutdown.
 */
export async function resolveOpenCodeServiceAccess(
  conversation: Pick<Conversation, "id" | "opencodeSessionId" | "opencodeServiceOwner">,
): Promise<OpenCodeServiceAccess> {
  // Shutdown clears the target, so this must be asked explicitly: otherwise an
  // unbound conversation would fall through to the managed start below.
  if (readShutdownState().shutdownStarted) throw new OpenCodeNotReadyError();

  const recorded = readConversationHistoryOwner(conversation);

  const installedTarget = readConnectionState().target;
  if (installedTarget.mode !== "unresolved") {
    const active = historyOwnerFromTarget(installedTarget) as OpenCodeHistoryOwner;
    assertSameHistoryOwner(conversation.id, recorded, active);
    return captureInstalledAccess(active);
  }

  // Nothing is installed. A remote-bound conversation is refused BEFORE the
  // managed manager is asked for anything, so a fallback or startup race can
  // never start a managed child for history that lives on a remote server.
  if (recorded?.kind === "remote") {
    throw new OpenCodeHistoryBoundaryError(
      "adopted_unavailable",
      conversation.id,
      `This conversation's OpenCode history belongs to ${describeHistoryOwner(recorded)}, ` +
        "which is not available.",
    );
  }

  const baseUrl = await openCodeServerManager.ensureBaseUrl();

  // The start publishes a managed target before it resolves. Re-read rather
  // than assume: an adopted target installed concurrently must still own the
  // check.
  const publishedTarget = readConnectionState().target;
  if (publishedTarget.mode !== "unresolved") {
    const active = historyOwnerFromTarget(publishedTarget) as OpenCodeHistoryOwner;
    assertSameHistoryOwner(conversation.id, recorded, active);
    return captureInstalledAccess(active);
  }

  // Fallback managed access: the URL came from the manager, which owns the one
  // managed credential.
  return Object.freeze({
    owner: LOCAL_OWNER,
    baseUrl,
    transport: createManagedFallbackTransport(baseUrl),
  });
}
