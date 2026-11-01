/**
 * The managed/adopted history boundary (H3/B3, §4.3 of the hybrid plan).
 *
 * A conversation's OpenCode session belongs to exactly one service: the managed
 * child TBAi starts, or one adopted service identified by its canonical origin.
 * Session ids have the same shape on every service, so the id alone cannot say
 * which history it addresses. This module owns the persisted key that can, and
 * the one refusal that keeps a conversation from being re-pointed at a
 * different service.
 *
 * Nothing here reads, copies, migrates or merges a service's database. The
 * adopted service's history stays in the adopted service; a conversation that
 * belongs to the other service is refused, not relocated.
 */
import type { Conversation } from "../../types";
import {
  canonicalizeOpenCodeOrigin,
  OpenCodeTargetOriginError,
  type OpenCodeTarget,
} from "./connectionState";

/** The service that owns a conversation's OpenCode history. */
export type OpenCodeHistoryOwner =
  | Readonly<{ kind: "managed" }>
  | Readonly<{ kind: "adopted"; origin: string }>;

/** Why a history operation was refused. */
export type OpenCodeHistoryRefusal =
  /** The binding belongs to a different service than the one now in use. */
  | "cross_service"
  /** The binding belongs to an adopted service that is not currently installed. */
  | "adopted_unavailable"
  /** The persisted owner key cannot be interpreted. */
  | "unreadable";

/**
 * Thrown when a history operation would cross the managed/adopted boundary.
 *
 * Carries no credential and no session id: the message names the conversation
 * and the two service kinds, which is what a reader needs and nothing more.
 */
export class OpenCodeHistoryBoundaryError extends Error {
  readonly code = "OPENCODE_HISTORY_BOUNDARY";

  constructor(
    readonly refusal: OpenCodeHistoryRefusal,
    readonly conversationId: string,
    message: string,
  ) {
    super(message);
    this.name = "OpenCodeHistoryBoundaryError";
  }
}

/** The key persisted on `conversations.opencode_service_owner`. */
const MANAGED_OWNER_KEY = "managed";
const ADOPTED_OWNER_PREFIX = "adopted:";

/** The one managed owner value; frozen so a caller cannot mutate it in place. */
export const MANAGED_HISTORY_OWNER: OpenCodeHistoryOwner = Object.freeze({ kind: "managed" });

/**
 * The adopted owner for one canonical origin.
 *
 * @throws {OpenCodeTargetOriginError} when the origin is not an absolute HTTP(S) URL.
 */
export function adoptedHistoryOwner(origin: string): OpenCodeHistoryOwner {
  return Object.freeze({ kind: "adopted", origin: canonicalizeOpenCodeOrigin(origin) });
}

/** The persisted key for one owner: `managed` or `adopted:<origin>`. */
export function serializeHistoryOwner(owner: OpenCodeHistoryOwner): string {
  return owner.kind === "managed" ? MANAGED_OWNER_KEY : `${ADOPTED_OWNER_PREFIX}${owner.origin}`;
}

/**
 * Parses a persisted owner key.
 *
 * @throws {OpenCodeHistoryBoundaryError} with refusal `unreadable` when the value
 *   cannot be interpreted, so a damaged row is refused rather than defaulted.
 */
function parseHistoryOwnerKey(value: string): OpenCodeHistoryOwner {
  if (value === MANAGED_OWNER_KEY) return MANAGED_HISTORY_OWNER;
  if (value.startsWith(ADOPTED_OWNER_PREFIX)) {
    const origin = value.slice(ADOPTED_OWNER_PREFIX.length);
    try {
      return adoptedHistoryOwner(origin);
    } catch (error) {
      // A prefix with an unusable origin is a damaged key, not an adopted
      // binding: refusing to interpret it is safer than guessing a service.
      if (!(error instanceof OpenCodeTargetOriginError)) throw error;
    }
  }
  throw new OpenCodeHistoryBoundaryError(
    "unreadable",
    "",
    "The stored OpenCode service owner cannot be interpreted",
  );
}

/** The owner an installed target represents, or `null` when nothing is installed. */
export function historyOwnerFromTarget(target: OpenCodeTarget): OpenCodeHistoryOwner | null {
  if (target.mode === "managed") return MANAGED_HISTORY_OWNER;
  if (target.mode === "adopted") return adoptedHistoryOwner(target.origin);
  return null;
}

/**
 * The service owner recorded for a conversation, or `null` when it has no
 * session binding.
 *
 * A session id with no owner key is a **legacy managed** binding: adoption did
 * not exist when those rows were written, and the managed service is the only
 * service they can name. Reading it as anything else would let an adopted
 * service claim a managed session.
 *
 * An owner key without a session id is not a binding: a cleared pointer is
 * authoritative even if the owner key survived.
 *
 * @throws {OpenCodeHistoryBoundaryError} with refusal `unreadable`.
 */
export function readConversationHistoryOwner(
  conversation: Pick<Conversation, "id" | "opencodeSessionId" | "opencodeServiceOwner">,
): OpenCodeHistoryOwner | null {
  if (!conversation.opencodeSessionId) return null;
  const stored = conversation.opencodeServiceOwner;
  if (stored === null || stored === undefined || stored === "") return MANAGED_HISTORY_OWNER;
  try {
    return parseHistoryOwnerKey(stored);
  } catch (error) {
    if (error instanceof OpenCodeHistoryBoundaryError) {
      throw new OpenCodeHistoryBoundaryError(
        "unreadable",
        conversation.id,
        "The stored OpenCode service owner cannot be interpreted",
      );
    }
    throw error;
  }
}

/** True when both owners name the same service. Origins are already canonical. */
export function sameHistoryOwner(a: OpenCodeHistoryOwner, b: OpenCodeHistoryOwner): boolean {
  if (a.kind === "managed") return b.kind === "managed";
  return b.kind === "adopted" && a.origin === b.origin;
}

/** Human-readable kind, safe for a message: never a credential or a session id. */
export function describeHistoryOwner(owner: OpenCodeHistoryOwner): string {
  return owner.kind === "managed"
    ? "the managed service"
    : `the adopted service at ${owner.origin}`;
}

/**
 * Refuses a history operation whose recorded owner is not the service in use.
 *
 * A `null` recorded owner (no binding yet) always passes: the operation will
 * create a binding on whatever service is in use.
 *
 * @throws {OpenCodeHistoryBoundaryError} with refusal `cross_service`.
 */
export function assertSameHistoryOwner(
  conversationId: string,
  recorded: OpenCodeHistoryOwner | null,
  active: OpenCodeHistoryOwner,
): void {
  if (recorded === null || sameHistoryOwner(recorded, active)) return;
  throw new OpenCodeHistoryBoundaryError(
    "cross_service",
    conversationId,
    `This conversation's OpenCode history belongs to ${describeHistoryOwner(recorded)}, ` +
      `but ${describeHistoryOwner(active)} is in use. TBAi does not move histories between services.`,
  );
}
